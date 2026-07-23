#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'

const MANIFEST_VERSION = 1
const HASH_BUFFER_SIZE = 1024 * 1024

function usage() {
	console.error('Usage: node scripts/profile-data-manifest.mjs <dataset-root>')
}

function fail(message) {
	throw new Error(`Profile data manifest: ${message}`)
}

function readProfiles(root) {
	const statePath = resolve(root, 'profiles.json')
	let state
	try {
		state = JSON.parse(readFileSync(statePath, 'utf8'))
	} catch (error) {
		fail(`could not read profiles.json: ${error instanceof Error ? error.message : String(error)}`)
	}
	if (!state || typeof state !== 'object' || Array.isArray(state)) fail('profiles.json must be an object')
	if (!Number.isInteger(state.generation) || state.generation < 1) fail('profiles.json has an invalid generation')
	if (!Array.isArray(state.profiles)) fail('profiles.json has no profiles array')

	const profileIds = state.profiles.map(profile => {
		if (
			!profile ||
			typeof profile !== 'object' ||
			Array.isArray(profile) ||
			typeof profile.id !== 'string' ||
			!profile.id
		) {
			fail('profiles.json contains an invalid profile id')
		}
		return profile.id
	})
	if (new Set(profileIds).size !== profileIds.length) fail('profiles.json contains duplicate profile ids')
	if (typeof state.activeProfileId !== 'string' || !profileIds.includes(state.activeProfileId)) {
		fail('profiles.json has an active profile id that is not registered')
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

function profileFiles(root) {
	const profilesRoot = resolve(root, 'profiles')
	let profileStats
	try {
		profileStats = lstatSync(profilesRoot)
	} catch (error) {
		fail(`could not read profiles directory: ${error instanceof Error ? error.message : String(error)}`)
	}
	if (!profileStats.isDirectory()) fail('profiles is not a directory')

	const files = []
	const visit = directory => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = resolve(directory, entry.name)
			if (entry.isDirectory()) {
				visit(path)
				continue
			}
			if (!entry.isFile()) fail(`profiles contains a non-regular file: ${relative(root, path)}`)
			files.push({ path: relative(root, path).split(sep).join('/'), sha256: hashFile(path) })
		}
	}
	visit(profilesRoot)
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
	const databasePath = resolve(root, 'helm.db')
	let db
	try {
		db = new Database(databasePath, { readonly: true, fileMustExist: true })
		const integrity = db.pragma('integrity_check')
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
			fail('SQLite integrity_check did not return ok')
		const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
		if (foreignKeys.length > 0) fail(`SQLite foreign_key_check returned ${foreignKeys.length} row(s)`)

		const itemCounts = profileCounts(db, 'items', profiles.profileIds)
		const eventCounts = profileCounts(db, 'item_events', profiles.profileIds)
		const pollCounts = profileCounts(db, 'poll_state', profiles.profileIds)
		return profiles.profileIds.map((id, index) => ({
			id,
			itemCount: itemCounts[index],
			eventCount: eventCounts[index],
			pollCount: pollCounts[index],
		}))
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('Profile data manifest:')) throw error
		fail(`could not inspect helm.db: ${error instanceof Error ? error.message : String(error)}`)
	} finally {
		db?.close()
	}
}

function manifest(rootInput) {
	const root = resolve(rootInput)
	const rootStats = lstatSync(root)
	if (!rootStats.isDirectory()) fail('dataset root is not a directory')
	const profiles = readProfiles(root)
	const counts = databaseSummary(root, profiles)
	return {
		manifestVersion: MANIFEST_VERSION,
		logical: {
			generation: profiles.generation,
			activeProfileId: profiles.activeProfileId,
			profileIds: profiles.profileIds,
			profiles: counts,
		},
		files: [
			{ path: 'helm.db', sha256: hashFile(resolve(root, 'helm.db')) },
			{ path: 'profiles.json', sha256: hashFile(resolve(root, 'profiles.json')) },
			...profileFiles(root),
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
