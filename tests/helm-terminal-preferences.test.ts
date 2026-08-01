import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import terminalPreferencesModule from '../app/src/terminal-preferences.ts'

const { TerminalPreferencesStore } = terminalPreferencesModule

function fixture(): { root: string; home: string; store: InstanceType<typeof TerminalPreferencesStore> } {
	const root = mkdtempSync(join(tmpdir(), 'helm-terminal-preferences-'))
	const home = join(root, 'home')
	mkdirSync(home)
	return { root, home, store: new TerminalPreferencesStore(root, home) }
}

test('ordinary terminals default to HOME and Option-as-Meta when no folder is configured', () => {
	const { root, home, store } = fixture()
	try {
		const snapshot = store.snapshot()
		assert.equal(snapshot.defaultCwd, null)
		assert.equal(snapshot.effectiveCwd, home)
		assert.equal(snapshot.usingFallback, false)
		assert.equal(snapshot.optionAsMeta, true)
		assert.equal(snapshot.revision, 0)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('a selected folder is canonicalized and persisted atomically', () => {
	const { root, store } = fixture()
	try {
		const selected = join(root, 'projects')
		mkdirSync(selected)
		const canonical = realpathSync.native(selected)
		const snapshot = store.setDefaultCwd(selected)
		assert.equal(snapshot.defaultCwd, canonical)
		assert.equal(snapshot.effectiveCwd, canonical)
		assert.equal(snapshot.revision, 1)
		assert.match(readFileSync(store.filePath, 'utf8'), /"defaultCwd": ".*projects"/)
		assert.equal(new TerminalPreferencesStore(root, store.homeDirectory).snapshot().effectiveCwd, canonical)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('a selected folder that disappears falls back to HOME without losing the selection', () => {
	const { root, home, store } = fixture()
	try {
		const selected = join(root, 'projects')
		mkdirSync(selected)
		const canonical = realpathSync.native(selected)
		store.setDefaultCwd(selected)
		rmSync(selected, { recursive: true })
		const snapshot = store.snapshot()
		assert.equal(snapshot.defaultCwd, canonical)
		assert.equal(snapshot.effectiveCwd, home)
		assert.equal(snapshot.usingFallback, true)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('only an existing directory can become the terminal start folder', () => {
	const { root, store } = fixture()
	try {
		const file = join(root, 'not-a-directory')
		writeFileSync(file, 'no')
		assert.throws(() => store.setDefaultCwd(file), /existing, accessible folder/)
		assert.throws(() => store.setDefaultCwd(join(root, 'missing')), /existing, accessible folder/)
		assert.equal(store.snapshot().defaultCwd, null)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('v1 migrates in memory and revisioned keyboard/folder updates preserve each other', () => {
	const { root, home, store } = fixture()
	try {
		const selected = join(root, 'projects')
		mkdirSync(selected)
		writeFileSync(store.filePath, JSON.stringify({ version: 1, defaultCwd: selected }))
		const legacy = store.snapshot()
		assert.equal(legacy.defaultCwd, selected)
		assert.equal(legacy.optionAsMeta, true)
		const keyboard = store.update({
			...legacy,
			optionAsMeta: false,
			shortcuts: { ...legacy.shortcuts, sendInterrupt: [{ code: 'KeyK' }] },
		})
		assert.equal(keyboard.defaultCwd, realpathSync.native(selected))
		assert.equal(keyboard.optionAsMeta, false)
		assert.deepEqual(keyboard.shortcuts.sendInterrupt, [{ code: 'KeyK' }])
		const folder = store.update({ revision: keyboard.revision, defaultCwd: null })
		assert.equal(folder.defaultCwd, null)
		assert.equal(folder.optionAsMeta, false)
		assert.deepEqual(folder.shortcuts.sendInterrupt, [{ code: 'KeyK' }])
		assert.throws(() => store.update({ revision: keyboard.revision, optionAsMeta: true }), /changed in another window/)
		assert.throws(
			() =>
				store.update({
					revision: folder.revision,
					shortcuts: { ...folder.shortcuts, fontSmaller: [{ code: 'KeyQ' }] },
				}),
			/reserved/,
		)
		assert.equal(folder.effectiveCwd, home)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('disabled shortcuts persist as explicit empty deviations and reset restores defaults', () => {
	const { root, store } = fixture()
	try {
		const initial = store.snapshot()
		const disabled = store.update({
			...initial,
			shortcuts: { ...initial.shortcuts, newTerminal: [], runContextSave: [] },
		})
		assert.deepEqual(disabled.shortcuts.newTerminal, [])
		assert.deepEqual(new TerminalPreferencesStore(root, store.homeDirectory).snapshot().shortcuts.runContextSave, [])
		const reset = store.resetShortcuts(disabled.revision)
		assert.deepEqual(reset.shortcuts.newTerminal, [{ code: 'KeyT' }])
		assert.deepEqual(reset.shortcuts.runContextSave, [{ code: 'KeyS' }])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('platform-specific system reservations remain available on non-macOS stores', () => {
	const { root, home } = fixture()
	try {
		const store = new TerminalPreferencesStore(root, home, 'linux')
		const initial = store.snapshot()
		const updated = store.update({
			revision: initial.revision,
			shortcuts: { ...initial.shortcuts, fontSmaller: [{ code: 'Space' }] },
		})
		assert.deepEqual(updated.shortcuts.fontSmaller, [{ code: 'Space' }])
		assert.deepEqual(new TerminalPreferencesStore(root, home, 'linux').snapshot().shortcuts.fontSmaller, [
			{ code: 'Space' },
		])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('reset restores HOME and malformed preference files fail closed', () => {
	const { root, home, store } = fixture()
	try {
		const selected = join(root, 'projects')
		mkdirSync(selected)
		store.setDefaultCwd(selected)
		const reset = store.resetDefaultCwd()
		assert.equal(reset.defaultCwd, null)
		assert.equal(reset.effectiveCwd, home)
		assert.equal(reset.usingFallback, false)
		unlinkSync(store.filePath)
		writeFileSync(store.filePath, JSON.stringify({ version: 1, defaultCwd: '../escape' }))
		assert.equal(store.snapshot().defaultCwd, null)
		assert.equal(store.snapshot().effectiveCwd, home)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
