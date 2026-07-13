// Terminal buffer snapshots (app/src/buffers.ts): dtach preserves the process,
// not the screen, so restored tabs replay a serialized xterm buffer saved as
// <userData>/buffers/<sessionId>.bin. Invariants under test: save/read
// round-trip, atomic writes (tmp + rename, no sheared snapshot), the
// main-process size backstop, session-id validation (ids feed file paths),
// snapshot deletion, and the startup orphan sweep (snapshot without a live
// session and without a parked registry entry → removed; crashed-write .tmp
// leftovers → removed). CJS default-import pattern per the helm test convention.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import buffersModule from '../app/src/buffers.ts'

type BuffersModule = typeof import('../app/src/buffers.ts')
const { BufferStore, MAX_SNAPSHOT_BYTES } = buffersModule as BuffersModule

function withStore<T>(fn: (store: InstanceType<typeof BufferStore>, dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-buffers-'))
	return fn(new BufferStore(dir), dir)
}

test('save + read round-trips a snapshot with escape sequences intact', () =>
	withStore(store => {
		const snapshot = '\x1b[31mruler\x1b[0m\r\nline two\x1b[5;1H'
		assert.equal(store.save('sess1', snapshot), true)
		assert.equal(store.read('sess1'), snapshot)
	}))

test('save overwrites the previous snapshot for the same session', () =>
	withStore(store => {
		store.save('sess1', 'old screen')
		store.save('sess1', 'new screen')
		assert.equal(store.read('sess1'), 'new screen')
	}))

test('save writes atomically — no .tmp leftover after a successful save', () =>
	withStore((store, dir) => {
		store.save('sess1', 'content')
		assert.deepEqual(fs.readdirSync(dir).sort(), ['sess1.bin'])
	}))

test('read of a missing snapshot is null', () =>
	withStore(store => {
		assert.equal(store.read('nosuch'), null)
	}))

test('save rejects oversized data and keeps the previous snapshot', () =>
	withStore(store => {
		store.save('sess1', 'good')
		const oversized = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1)
		assert.equal(store.save('sess1', oversized), false)
		assert.equal(store.read('sess1'), 'good')
	}))

test('read refuses (and deletes) a file over the cap — never replayed into a terminal', () =>
	withStore((store, dir) => {
		// Planted directly: a sanctioned save can never produce this.
		fs.writeFileSync(path.join(dir, 'sess1.bin'), 'x'.repeat(MAX_SNAPSHOT_BYTES + 1))
		assert.equal(store.read('sess1'), null)
		assert.equal(fs.existsSync(path.join(dir, 'sess1.bin')), false)
	}))

test('save throws on a traversal-shaped session id; read/remove refuse quietly', () =>
	withStore((store, dir) => {
		assert.throws(() => store.save('../evil', 'data'))
		assert.equal(store.read('../evil'), null)
		store.remove('../evil') // must not throw
		assert.equal(fs.existsSync(path.join(path.dirname(dir), 'evil.bin')), false)
	}))

test('remove deletes the snapshot and any crashed-write leftover; idempotent', () =>
	withStore((store, dir) => {
		store.save('sess1', 'content')
		fs.writeFileSync(path.join(dir, 'sess1.bin.tmp'), 'partial')
		store.remove('sess1')
		assert.equal(store.read('sess1'), null)
		assert.deepEqual(fs.readdirSync(dir), [])
		store.remove('sess1') // second remove is a no-op
	}))

test('orphan sweep removes snapshots outside the keep set and reports them', () =>
	withStore(store => {
		store.save('live1', 'a')
		store.save('parked1', 'b')
		store.save('gone1', 'c')
		const removed = store.removeOrphans(new Set(['live1', 'parked1']))
		assert.deepEqual(removed.sort(), ['gone1'])
		assert.equal(store.read('live1'), 'a')
		assert.equal(store.read('parked1'), 'b')
		assert.equal(store.read('gone1'), null)
	}))

test('orphan sweep collects crashed-write .tmp leftovers and ignores foreign files', () =>
	withStore((store, dir) => {
		store.save('live1', 'a')
		fs.writeFileSync(path.join(dir, 'crashed.bin.tmp'), 'partial')
		fs.writeFileSync(path.join(dir, 'notes.txt'), 'unrelated')
		const removed = store.removeOrphans(new Set(['live1']))
		assert.deepEqual(removed, [])
		assert.deepEqual(fs.readdirSync(dir).sort(), ['live1.bin', 'notes.txt'])
	}))

test('orphan sweep on a store that never saved (missing dir) is a no-op', () => {
	const store = new BufferStore(path.join(os.tmpdir(), 'helm-buffers-never-created'))
	assert.deepEqual(store.removeOrphans(new Set()), [])
})
