import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const preload = readFileSync(new URL('../app/src/preload-run-context.ts', import.meta.url), 'utf8')
const windowManager = readFileSync(new URL('../app/src/run-context-window.ts', import.meta.url), 'utf8')
const editor = readFileSync(new URL('../app/src/renderer/run-context/RunContextEditor.tsx', import.meta.url), 'utf8')

test('run-context preload exposes only the narrow editor capability set', () => {
	assert.match(preload, /contextBridge\.exposeInMainWorld\('runContextEditor'/)
	for (const channel of [
		'run-context:load',
		'run-context:save',
		'run-context:reset',
		'run-context:dirty',
		'run-context:close',
		'run-context:cancel-close',
	]) {
		assert.match(preload, new RegExp(channel))
	}
	for (const forbidden of ['window.helm', 'pty:', 'session:', 'daemon:config', 'shell:']) {
		assert.doesNotMatch(preload, new RegExp(forbidden.replace(':', '\\:')))
	}
	assert.match(preload, /ipcRenderer\.sendSync\('config:get'\)/)
	assert.match(preload, /run-context:load', sessionProfileToken/)
	assert.match(preload, /run-context:save', revision, document, sessionProfileToken/)
	assert.match(preload, /run-context:reset', revision, sessionProfileToken/)
	assert.doesNotMatch(preload, /getDaemonUrl|daemonUrl/)
})

test('run-context switch drain synchronously refuses dirty editors and closes admission before awaiting requests', () => {
	assert.match(windowManager, /beginProfileSwitchDrain\(\): \{ ok: false \} \| \{ ok: true; drained: Promise<void> \}/)
	assert.match(windowManager, /if \(this\.hasDirtyWindows\(\)\) return \{ ok: false \}/)
	assert.match(windowManager, /this\.preparingProfileSwitch = true[\s\S]*const admitted = \[\.\.\.this\.inFlight\]/)
	assert.match(windowManager, /Promise\.allSettled\(admitted\)/)
	assert.match(windowManager, /this\.preparingProfileSwitch \|\| this\.callbacks\.canOpen\?\.\(\) === false/)
	assert.match(windowManager, /this\.track\(\(\) => this\.bridge\.loadRunContext\(/)
	assert.match(windowManager, /this\.track\(\(\) => this\.bridge\.saveRunContext\(/)
	assert.match(windowManager, /this\.track\(\(\) => this\.bridge\.resetRunContext\(/)
	assert.match(windowManager, /profileToken: unknown/)
})

test('run-context editor freezes one consistent document during writes', () => {
	assert.match(editor, /const blocks = editor\.document/)
	assert.match(editor, /blocksToMarkdownLossy\(blocks\)/)
	assert.match(editor, /editable=\{!locked && busy === null\}/)
})

test('run-context editor omits metadata rows and names source files clearly', () => {
	assert.doesNotMatch(editor, /loaded\.source\.metadata/)
	assert.match(editor, />Source attachments</)
})

test('a clean run-context editor refreshes lifecycle lock state when focus returns without replacing edits', () => {
	assert.match(editor, /window\.addEventListener\('focus', refreshOnFocus\)/)
	assert.match(editor, /dirtyRef\.current = true[\s\S]*setDirty\(true\)/)
	assert.match(editor, /if \(!active \|\| dirtyRef\.current \|\| result\.error !== undefined\) return/)
	assert.match(editor, /result\.data\.item\.status !== loaded\.item\.status/)
})

test('run-context BrowserWindow keeps renderer privileges disabled', () => {
	assert.match(windowManager, /contextIsolation:\s*true/)
	assert.match(windowManager, /nodeIntegration:\s*false/)
	assert.match(windowManager, /sandbox:\s*true/)
	assert.match(windowManager, /setWindowOpenHandler/)
	assert.match(windowManager, /will-navigate/)
	assert.match(windowManager, /this\.byItem\.get\(id\)/)
	assert.match(windowManager, /existing\.window\.focus\(\)/)
})
