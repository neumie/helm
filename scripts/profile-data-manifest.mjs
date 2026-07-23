#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
	closeSync,
	copyFileSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'

const MANIFEST_VERSION = 1
const HASH_BUFFER_SIZE = 1024 * 1024
const MAX_PROFILE_NAME_LENGTH = 48
const PROFILE_ID_RE = /^(?:work|profile-[a-f0-9]{12})$/

function usage() {
	console.error('Usage: node scripts/profile-data-manifest.mjs <dataset-root>')
}

function fail(message) {
	throw new Error(`Profile data manifest: ${message}`)
}

function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0
}

function normalizedProfileName(value) {
	if (typeof value !== 'string') fail('profiles.json contains a profile name that is not text')
	const name = value.normalize('NFC').trim()
	const hasControlCharacter = [...name].some(character => {
		const codePoint = character.codePointAt(0) ?? 0
		return codePoint <= 0x1f || codePoint === 0x7f
	})
	if (name.length === 0 || name.length > MAX_PROFILE_NAME_LENGTH || hasControlCharacter) {
		fail(`profiles.json contains a profile name that is not 1-${MAX_PROFILE_NAME_LENGTH} visible characters`)
	}
	return name
}

function lstat(path, label) {
	try {
		return lstatSync(path)
	} catch (error) {
		fail(`could not read ${label}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function regularFile(root, name) {
	const path = resolve(root, name)
	const stats = lstat(path, name)
	if (!stats.isFile()) fail(`${name} must be a regular file (not a symlink or special file)`)
	return path
}

function directory(root, name) {
	const path = resolve(root, name)
	const stats = lstat(path, name)
	if (!stats.isDirectory()) fail(`${name} must be a directory (not a symlink or special file)`)
	return path
}

function readProfiles(root) {
	const statePath = regularFile(root, 'profiles.json')
	let state
	try {
		state = JSON.parse(readFileSync(statePath, 'utf8'))
	} catch (error) {
		fail(`could not read profiles.json: ${error instanceof Error ? error.message : String(error)}`)
	}
	if (!state || typeof state !== 'object' || Array.isArray(state)) fail('profiles.json must be an object')
	if (state.version !== 1) fail('profiles.json has an unsupported version')
	if (!Number.isInteger(state.generation) || state.generation < 1) fail('profiles.json has an invalid generation')
	if (!Array.isArray(state.profiles)) fail('profiles.json has no profiles array')

	const profiles = state.profiles.map(profile => {
		if (!profile || typeof profile !== 'object' || Array.isArray(profile))
			fail('profiles.json contains an invalid profile')
		if (
			typeof profile.id !== 'string' ||
			!PROFILE_ID_RE.test(profile.id) ||
			typeof profile.name !== 'string' ||
			typeof profile.createdAt !== 'string' ||
			!Array.isArray(profile.enabledProjects) ||
			!profile.enabledProjects.every(project => typeof project === 'string') ||
			(profile.archivedAt !== null && typeof profile.archivedAt !== 'string')
		) {
			fail('profiles.json contains an invalid profile document')
		}
		normalizedProfileName(profile.name)
		return profile
	})
	const profileIds = profiles.map(profile => profile.id)
	if (new Set(profileIds).size !== profileIds.length) fail('profiles.json contains duplicate profile ids')
	if (
		typeof state.activeProfileId !== 'string' ||
		!profiles.some(profile => profile.id === state.activeProfileId && profile.archivedAt === null)
	) {
		fail('profiles.json has an active profile id that is not registered and unarchived')
	}
	return { generation: state.generation, activeProfileId: state.activeProfileId, profileIds }
}

function hashFile(path) {
	const hash = createHash('sha256')
	const descriptor = openSync(path, 'r')
	const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE)
	try {
		for (;;) {
			const bytesRead = readSync(descriptor, buffer)
			if (bytesRead === 0) break
			hash.update(buffer.subarray(0, bytesRead))
		}
	} finally {
		closeSync(descriptor)
	}
	return hash.digest('hex')
}

function profileFiles(root, profileIds) {
	const profilesRoot = directory(root, 'profiles')
	const registeredIds = new Set(profileIds)
	const files = []
	const visit = current => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
			compareCodeUnits(a.name, b.name),
		)) {
			const path = resolve(current, entry.name)
			const stats = lstat(path, relative(root, path))
			if (stats.isDirectory()) {
				visit(path)
				continue
			}
			if (!stats.isFile()) fail(`profiles contains a non-regular file: ${relative(root, path)}`)
			files.push({ path: relative(root, path).split(sep).join('/'), sha256: hashFile(path) })
		}
	}

	for (const entry of readdirSync(profilesRoot, { withFileTypes: true }).sort((a, b) =>
		compareCodeUnits(a.name, b.name),
	)) {
		const path = resolve(profilesRoot, entry.name)
		const stats = lstat(path, `profiles/${entry.name}`)
		if (!PROFILE_ID_RE.test(entry.name) || !registeredIds.has(entry.name) || !stats.isDirectory()) {
			fail(`profiles contains an unregistered or non-directory profile entry: profiles/${entry.name}`)
		}
		visit(path)
	}
	for (const id of profileIds) {
		const profilePath = resolve(profilesRoot, id)
		const stats = lstat(profilePath, `profiles/${id}`)
		if (!stats.isDirectory()) fail(`profiles/${id} must be a directory (not a symlink or special file)`)
	}
	return files
}

function profileCounts(db, table, profileIds) {
	const rows = db.prepare(`SELECT profile_id AS profileId, COUNT(*) AS count FROM ${table} GROUP BY profile_id`).all()
	const counts = new Map(rows.map(row => [row.profileId, row.count]))
	for (const profileId of counts.keys()) {
		if (!profileIds.includes(profileId)) fail(`${table} contains data for unregistered profile ${profileId}`)
	}
	return profileIds.map(profileId => counts.get(profileId) ?? 0)
}

function databaseSummary(root, profiles) {
	const databasePath = regularFile(root, 'helm.db')
	for (const suffix of ['-wal', '-shm']) {
		try {
			lstatSync(`${databasePath}${suffix}`)
			fail(`refuses a dataset with live SQLite sidecar helm.db${suffix}`)
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Profile data manifest:')) throw error
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
			fail(`could not inspect helm.db${suffix}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	const snapshotDir = mkdtempSync(join(tmpdir(), 'helm-profile-manifest-db-'))
	const snapshotPath = join(snapshotDir, 'helm.db')
	const databaseHash = hashFile(databasePath)
	try {
		copyFileSync(databasePath, snapshotPath)
		if (hashFile(snapshotPath) !== databaseHash) fail('helm.db changed while the manifest snapshot was copied')
		const db = new Database(snapshotPath, { readonly: true, fileMustExist: true })
		try {
			db.exec('BEGIN')
			const integrity = db.pragma('integrity_check')
			if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
				fail('SQLite integrity_check did not return ok')
			const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
			if (foreignKeys.length > 0) fail(`SQLite foreign_key_check returned ${foreignKeys.length} row(s)`)
			const tenantMismatches = db
				.prepare(
					`SELECT COUNT(*) AS count
				 FROM item_events AS event
				 JOIN items AS item ON item.id = event.item_id
				 WHERE event.profile_id <> item.profile_id`,
				)
				.get()
			if (tenantMismatches.count > 0) fail(`item_events contains ${tenantMismatches.count} tenant mismatch(es)`)

			const itemCounts = profileCounts(db, 'items', profiles.profileIds)
			const eventCounts = profileCounts(db, 'item_events', profiles.profileIds)
			const pollCounts = profileCounts(db, 'poll_state', profiles.profileIds)
			return {
				databaseHash,
				counts: profiles.profileIds.map((id, index) => ({
					id,
					itemCount: itemCounts[index],
					eventCount: eventCounts[index],
					pollCount: pollCounts[index],
				})),
			}
		} finally {
			try {
				db.exec('ROLLBACK')
			} finally {
				db.close()
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('Profile data manifest:')) throw error
		fail(`could not inspect helm.db: ${error instanceof Error ? error.message : String(error)}`)
	} finally {
		rmSync(snapshotDir, { recursive: true, force: true })
	}
}

function manifest(rootInput) {
	const root = resolve(rootInput)
	if (!lstat(root, 'dataset root').isDirectory()) fail('dataset root is not a directory')
	const profiles = readProfiles(root)
	const database = databaseSummary(root, profiles)
	return {
		manifestVersion: MANIFEST_VERSION,
		logical: {
			generation: profiles.generation,
			activeProfileId: profiles.activeProfileId,
			profileIds: profiles.profileIds,
			profiles: database.counts,
		},
		files: [
			{ path: 'helm.db', sha256: database.databaseHash },
			{ path: 'profiles.json', sha256: hashFile(regularFile(root, 'profiles.json')) },
			...profileFiles(root, profiles.profileIds),
		],
	}
}

try {
	if (process.argv.length !== 3) {
		usage()
		process.exitCode = 64
	} else {
		console.log(JSON.stringify(manifest(process.argv[2]), null, 2))
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
}
