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

test('ordinary terminals default to HOME when no folder is configured', () => {
	const { root, home, store } = fixture()
	try {
		assert.deepEqual(store.snapshot(), {
			defaultCwd: null,
			effectiveCwd: home,
			usingFallback: false,
		})
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
		assert.deepEqual(store.setDefaultCwd(selected), {
			defaultCwd: canonical,
			effectiveCwd: canonical,
			usingFallback: false,
		})
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
		assert.deepEqual(store.snapshot(), {
			defaultCwd: canonical,
			effectiveCwd: home,
			usingFallback: true,
		})
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

test('reset restores HOME and malformed preference files fail closed', () => {
	const { root, home, store } = fixture()
	try {
		const selected = join(root, 'projects')
		mkdirSync(selected)
		store.setDefaultCwd(selected)
		assert.deepEqual(store.resetDefaultCwd(), {
			defaultCwd: null,
			effectiveCwd: home,
			usingFallback: false,
		})
		unlinkSync(store.filePath)
		writeFileSync(store.filePath, JSON.stringify({ version: 1, defaultCwd: '../escape' }))
		assert.deepEqual(store.snapshot(), {
			defaultCwd: null,
			effectiveCwd: home,
			usingFallback: false,
		})
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
