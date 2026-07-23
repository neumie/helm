import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	rmdirSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DB } from '../src/db/client.js'
import { ProfileStore } from '../src/profiles/store.js'

const manifestScript = join(process.cwd(), 'scripts', 'profile-data-manifest.mjs')
const runbookHelper = join(process.cwd(), 'scripts', 'profile-data-runbook-helper.mjs')

function sha256(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function createItem(db: DB, title: string) {
	return db.items.create({
		kind: 'solve',
		status: 'ready',
		projectSlug: 'helm',
		title,
		baseRef: 'main',
		payload: { kind: 'solve', prompt: title },
	})
}

function createDataset(prefix = 'helm-profile-manifest-') {
	const root = mkdtempSync(prefix.startsWith('/') ? prefix : join(tmpdir(), prefix))
	const profiles = new ProfileStore(root)
	const personal = profiles.create('Personal')
	const archived = profiles.create('Archive')
	profiles.archive(archived.id)
	profiles.activate(personal.id)

	const db = new DB(join(root, 'helm.db'), 'work')
	try {
		const workItem = createItem(db, 'Work item')
		db.items.insertEvent(workItem.id, 'work_event')
		db.updatePollState('helm', '2026-01-01T00:00:00.000Z', 'work-poll')

		const personalDb = db.forProfile(personal.id)
		const personalItem = createItem(personalDb, 'Personal item')
		personalDb.items.insertEvent(personalItem.id, 'personal_event')
		personalDb.items.insertEvent(personalItem.id, 'personal_follow_up')
		personalDb.updatePollState('helm', '2026-01-02T00:00:00.000Z', 'personal-poll')
	} finally {
		db.close()
	}
	mkdirSync(join(root, 'profiles', personal.id, 'attachments'), { recursive: true })
	writeFileSync(join(root, 'profiles', personal.id, 'attachments', 'note.txt'), 'captured note')
	return { root, personal, archived }
}

function manifestResult(root: string) {
	return spawnSync(process.execPath, [manifestScript, root], { encoding: 'utf8' })
}

function readManifest(root: string) {
	return JSON.parse(execFileSync(process.execPath, [manifestScript, root], { encoding: 'utf8' })) as {
		logical: {
			generation: number
			activeProfileId: string
			profileIds: string[]
			profiles: { id: string; itemCount: number; eventCount: number; pollCount: number }[]
		}
		files: { path: string; sha256: string }[]
	}
}

function compareManifests(expected: string, actual: string) {
	return spawnSync(process.execPath, [runbookHelper, 'compare-manifests', expected, actual], { encoding: 'utf8' })
}

function removeDatabaseSidecars(root: string) {
	for (const suffix of ['-wal', '-shm']) rmSync(join(root, `helm.db${suffix}`), { force: true })
}

function writeFakeLsof(bin: string) {
	const script = join(bin, 'lsof')
	writeFileSync(
		script,
		`#!/usr/bin/env node
const fs = require('node:fs')
if (process.env.FAKE_LSOF_ARGS) fs.writeFileSync(process.env.FAKE_LSOF_ARGS, JSON.stringify(process.argv.slice(2)))
if (process.env.FAKE_LSOF_MODE === 'holder') { process.stdout.write('12345\\n'); process.exit(0) }
if (process.env.FAKE_LSOF_MODE === 'diagnostic') { process.stderr.write('cannot inspect\\n'); process.exit(1) }
process.exit(1)
`,
	)
	chmodSync(script, 0o755)
}

test('profile data manifest reports stable shared-DB counts and every managed file without writes', () => {
	const { root, personal, archived } = createDataset()
	try {
		const databaseHashBefore = sha256(join(root, 'helm.db'))
		const manifest = readManifest(root)

		assert.equal(manifest.logical.generation, 2)
		assert.equal(manifest.logical.activeProfileId, personal.id)
		assert.deepEqual(manifest.logical.profileIds, ['work', personal.id, archived.id])
		assert.deepEqual(manifest.logical.profiles, [
			{ id: 'work', itemCount: 1, eventCount: 1, pollCount: 1 },
			{ id: personal.id, itemCount: 1, eventCount: 2, pollCount: 1 },
			{ id: archived.id, itemCount: 0, eventCount: 0, pollCount: 0 },
		])
		assert.deepEqual(
			manifest.files.map(file => file.path),
			['helm.db', 'profiles.json', `profiles/${personal.id}/attachments/note.txt`],
		)
		assert.equal(manifest.files[0]?.sha256, databaseHashBefore)
		assert.equal(manifest.files[1]?.sha256, sha256(join(root, 'profiles.json')))
		assert.equal(manifest.files[2]?.sha256, sha256(join(root, 'profiles', personal.id, 'attachments', 'note.txt')))
		assert.equal(sha256(join(root, 'helm.db')), databaseHashBefore)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('profile data manifest rejects foreign keys, event tenant mismatches, and SQLite sidecars', () => {
	const { root, personal } = createDataset()
	try {
		const database = new Database(join(root, 'helm.db'))
		try {
			database.pragma('foreign_keys = OFF')
			database
				.prepare(
					`INSERT INTO item_events (profile_id, item_id, event_type, payload, created_at)
					 VALUES ('work', 'missing-item', 'invalid_event', NULL, '2026-01-03T00:00:00.000Z')`,
				)
				.run()
		} finally {
			database.close()
		}
		let result = manifestResult(root)
		assert.equal(result.status, 1)
		assert.match(result.stderr, /foreign_key_check returned 1 row/)

		const repaired = new Database(join(root, 'helm.db'))
		try {
			repaired.prepare("DELETE FROM item_events WHERE item_id = 'missing-item'").run()
			const item = repaired.prepare("SELECT id FROM items WHERE profile_id = 'work'").get() as { id: string }
			repaired
				.prepare(
					`INSERT INTO item_events (profile_id, item_id, event_type, payload, created_at)
					 VALUES (?, ?, 'mismatched_event', NULL, '2026-01-03T00:00:00.000Z')`,
				)
				.run(personal.id, item.id)
		} finally {
			repaired.close()
		}
		removeDatabaseSidecars(root)
		result = manifestResult(root)
		assert.equal(result.status, 1)
		assert.match(result.stderr, /tenant mismatch/)

		const repairMismatch = new Database(join(root, 'helm.db'))
		try {
			repairMismatch.prepare("DELETE FROM item_events WHERE event_type = 'mismatched_event'").run()
		} finally {
			repairMismatch.close()
		}
		removeDatabaseSidecars(root)
		writeFileSync(join(root, 'helm.db-wal'), 'not a live snapshot')
		result = manifestResult(root)
		assert.equal(result.status, 1)
		assert.match(result.stderr, /live SQLite sidecar helm\.db-wal/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('profile data manifest rejects invalid registry IDs and symlink or special managed entries', async t => {
	const invalid = createDataset()
	try {
		const registry = JSON.parse(readFileSync(join(invalid.root, 'profiles.json'), 'utf8'))
		registry.profiles[0].id = '../escape'
		writeFileSync(join(invalid.root, 'profiles.json'), JSON.stringify(registry))
		assert.match(manifestResult(invalid.root).stderr, /invalid profile document/)
	} finally {
		rmSync(invalid.root, { recursive: true, force: true })
	}

	for (const entry of ['profiles.json', 'helm.db']) {
		await t.test(`rejects top-level ${entry} symlink`, () => {
			const { root } = createDataset()
			try {
				const path = join(root, entry)
				const target = join(root, `${entry}.target`)
				unlinkSync(path)
				writeFileSync(target, 'not followed')
				symlinkSync(target, path)
				assert.match(manifestResult(root).stderr, /regular file/)
			} finally {
				rmSync(root, { recursive: true, force: true })
			}
		})
	}

	await t.test('rejects profile-tree symlink and FIFO', () => {
		const { root, personal } = createDataset()
		try {
			const attachments = join(root, 'profiles', personal.id, 'attachments')
			symlinkSync(join(attachments, 'note.txt'), join(attachments, 'linked.txt'))
			assert.match(manifestResult(root).stderr, /non-regular file/)
			unlinkSync(join(attachments, 'linked.txt'))
			removeDatabaseSidecars(root)
			const fifo = join(attachments, 'queue.fifo')
			execFileSync('mkfifo', [fifo])
			assert.match(manifestResult(root).stderr, /non-regular file/)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	await t.test('rejects a profile-tree Unix socket', async () => {
		const { root, personal } = createDataset('/tmp/hpm-')
		const socket = join(root, 'profiles', personal.id, 'socket')
		const server = net.createServer()
		try {
			await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, resolve))
			assert.match(manifestResult(root).stderr, /non-regular file/)
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()))
			rmSync(root, { recursive: true, force: true })
		}
	})
})

test('runbook helper fails closed for open or ambiguous lsof checks and accepts a sidecar-free stopped fixture', () => {
	const { root } = createDataset("helm profile 'quoted'-")
	const bin = mkdtempSync(join(tmpdir(), 'helm-fake-lsof-'))
	const emptyBin = mkdtempSync(join(tmpdir(), 'helm-no-lsof-'))
	const argsPath = join(bin, 'args.json')
	writeFakeLsof(bin)
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		FAKE_LSOF_ARGS: argsPath,
		FAKE_LSOF_MODE: 'stopped',
	}
	try {
		let result = spawnSync(process.execPath, [runbookHelper, 'assert-stopped-database', root], {
			encoding: 'utf8',
			env,
		})
		assert.equal(result.status, 0, result.stderr)
		assert.deepEqual(JSON.parse(readFileSync(argsPath, 'utf8')), ['-t', join(root, 'helm.db')])

		const openDb = new Database(join(root, 'helm.db'))
		try {
			result = spawnSync(process.execPath, [runbookHelper, 'assert-stopped-database', root], {
				encoding: 'utf8',
				env: { ...env, FAKE_LSOF_MODE: 'holder' },
			})
			assert.equal(result.status, 1)
			assert.match(result.stderr, /still open/)
		} finally {
			openDb.close()
		}

		result = spawnSync(process.execPath, [runbookHelper, 'assert-stopped-database', root], {
			encoding: 'utf8',
			env: { ...env, FAKE_LSOF_MODE: 'diagnostic' },
		})
		assert.equal(result.status, 1)
		assert.match(result.stderr, /wrote diagnostics/)

		result = spawnSync(process.execPath, [runbookHelper, 'assert-stopped-database', root], {
			encoding: 'utf8',
			env: { ...env, PATH: emptyBin },
		})
		assert.equal(result.status, 1)
		assert.match(result.stderr, /could not execute lsof/)
	} finally {
		rmSync(root, { recursive: true, force: true })
		rmSync(bin, { recursive: true, force: true })
		rmSync(emptyBin, { recursive: true, force: true })
	}
})

test('rehearsal comparison detects corrupt copies and restore staging can be removed before a disposable start', () => {
	const backup = createDataset("helm backup 'quoted'-")
	const target = createDataset("helm target 'quoted'-")
	try {
		const backupManifest = join(backup.root, 'manifest.json')
		writeFileSync(backupManifest, JSON.stringify(readManifest(backup.root)))
		const rehearsal = mkdtempSync(join(tmpdir(), "helm rehearsal 'quoted'-"))
		try {
			cpSync(join(backup.root, 'helm.db'), join(rehearsal, 'helm.db'))
			cpSync(join(backup.root, 'profiles.json'), join(rehearsal, 'profiles.json'))
			cpSync(join(backup.root, 'profiles'), join(rehearsal, 'profiles'), { recursive: true })
			const rehearsalManifest = join(rehearsal, 'manifest.json')
			writeFileSync(rehearsalManifest, JSON.stringify(readManifest(rehearsal)))
			assert.equal(compareManifests(backupManifest, rehearsalManifest).status, 0)
			writeFileSync(join(rehearsal, 'profiles', backup.personal.id, 'attachments', 'note.txt'), 'corrupt')
			writeFileSync(rehearsalManifest, JSON.stringify(readManifest(rehearsal)))
			const corrupt = compareManifests(backupManifest, rehearsalManifest)
			assert.equal(corrupt.status, 1)
			assert.match(corrupt.stderr, /file hash manifest sections differ/)
		} finally {
			rmSync(rehearsal, { recursive: true, force: true })
		}

		const failed = join(target.root, 'failed')
		mkdirSync(failed)
		for (const name of ['helm.db', 'profiles.json', 'profiles']) {
			cpSync(join(target.root, name), join(failed, name), { recursive: name === 'profiles' })
			rmSync(join(target.root, name), { recursive: name === 'profiles', force: true })
		}
		const restore = mkdtempSync(join(target.root, '.restore.'))
		const checks = mkdtempSync(join(target.root, '.restore-check.'))
		for (const name of ['helm.db', 'profiles.json', 'profiles']) {
			cpSync(join(backup.root, name), join(restore, name), { recursive: name === 'profiles' })
		}
		const restoredManifest = join(checks, 'restored-manifest.json')
		writeFileSync(restoredManifest, JSON.stringify(readManifest(restore)))
		assert.equal(compareManifests(backupManifest, restoredManifest).status, 0)
		for (const name of ['helm.db', 'profiles.json', 'profiles']) {
			cpSync(join(restore, name), join(target.root, name), { recursive: name === 'profiles' })
			rmSync(join(restore, name), { recursive: name === 'profiles', force: true })
		}
		rmSync(checks, { recursive: true, force: true })
		rmdirSync(restore)
		assert.equal(manifestResult(target.root).status, 0)
	} finally {
		rmSync(backup.root, { recursive: true, force: true })
		rmSync(target.root, { recursive: true, force: true })
	}
})
