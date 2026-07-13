// Legacy DB rename (vigil.db -> helm.db) — the one-way identity migration the
// daemon runs BEFORE opening its DB (src/db/client.ts migrateLegacyDbFile).
// Pure file-level: the helper is exported so no real SQLite DB is opened.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateLegacyDbFile } from '../src/db/client.js'

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'helm-db-migrate-'))
	try {
		fn(dir)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

function captureWarns(fn: () => void): string[] {
	const warns: string[] = []
	const original = console.warn
	console.warn = (...args: unknown[]) => {
		warns.push(args.map(String).join(' '))
	}
	try {
		fn()
	} finally {
		console.warn = original
	}
	return warns
}

test('renames vigil.db plus -wal/-shm siblings to helm.db*', () => {
	withTempDir(dir => {
		writeFileSync(join(dir, 'vigil.db'), 'main')
		writeFileSync(join(dir, 'vigil.db-wal'), 'wal')
		writeFileSync(join(dir, 'vigil.db-shm'), 'shm')
		const helmPath = join(dir, 'helm.db')

		captureWarns(() => migrateLegacyDbFile(helmPath))

		assert.equal(readFileSync(helmPath, 'utf-8'), 'main')
		assert.equal(readFileSync(`${helmPath}-wal`, 'utf-8'), 'wal')
		assert.equal(readFileSync(`${helmPath}-shm`, 'utf-8'), 'shm')
		for (const name of ['vigil.db', 'vigil.db-wal', 'vigil.db-shm']) {
			assert.equal(existsSync(join(dir, name)), false, `${name} should be gone after migration`)
		}
	})
})

test('renames a bare vigil.db when no -wal/-shm siblings exist', () => {
	withTempDir(dir => {
		writeFileSync(join(dir, 'vigil.db'), 'main')
		const helmPath = join(dir, 'helm.db')

		captureWarns(() => migrateLegacyDbFile(helmPath))

		assert.equal(readFileSync(helmPath, 'utf-8'), 'main')
		assert.equal(existsSync(`${helmPath}-wal`), false)
		assert.equal(existsSync(`${helmPath}-shm`), false)
		assert.equal(existsSync(join(dir, 'vigil.db')), false)
	})
})

test('both helm.db and vigil.db present -> no rename, loud warning', () => {
	withTempDir(dir => {
		const helmPath = join(dir, 'helm.db')
		writeFileSync(helmPath, 'current')
		writeFileSync(join(dir, 'vigil.db'), 'stale')
		writeFileSync(join(dir, 'vigil.db-wal'), 'stale-wal')

		const warns = captureWarns(() => migrateLegacyDbFile(helmPath))

		// Nothing moved: both files keep their contents, no -wal was migrated.
		assert.equal(readFileSync(helmPath, 'utf-8'), 'current')
		assert.equal(readFileSync(join(dir, 'vigil.db'), 'utf-8'), 'stale')
		assert.equal(readFileSync(join(dir, 'vigil.db-wal'), 'utf-8'), 'stale-wal')
		assert.equal(existsSync(`${helmPath}-wal`), false)
		assert.equal(warns.length, 1)
		assert.match(warns[0] ?? '', /not migrating/)
		assert.match(warns[0] ?? '', /delete or merge/)
	})
})

test('helm.db only -> untouched, no warning', () => {
	withTempDir(dir => {
		const helmPath = join(dir, 'helm.db')
		writeFileSync(helmPath, 'current')

		const warns = captureWarns(() => migrateLegacyDbFile(helmPath))

		assert.equal(readFileSync(helmPath, 'utf-8'), 'current')
		assert.deepEqual(warns, [])
	})
})

test('neither file present -> no-op, no warning', () => {
	withTempDir(dir => {
		const warns = captureWarns(() => migrateLegacyDbFile(join(dir, 'helm.db')))
		assert.equal(existsSync(join(dir, 'helm.db')), false)
		assert.deepEqual(warns, [])
	})
})
