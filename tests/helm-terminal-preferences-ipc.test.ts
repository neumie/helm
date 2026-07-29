import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const shared = read('app/src/shared.ts')
const preload = read('app/src/preload.ts')
const main = read('app/src/main.ts')

function between(source: string, start: string, end: string): string {
	const from = source.indexOf(start)
	const to = source.indexOf(end, from + start.length)
	assert.notEqual(from, -1, start)
	assert.notEqual(to, -1, end)
	return source.slice(from, to)
}

test('renderer cannot provide a cwd to the ordinary PTY spawn contract', () => {
	const ptyApi = between(shared, 'export interface PtyApi', 'export interface GraceClose')
	assert.match(ptyApi, /spawn\(cols: number, rows: number, sessionId\?: string\)/)
	assert.doesNotMatch(ptyApi, /cwd/)

	const preloadPty = between(preload, '\tpty: {', '\tsessions: {')
	assert.match(preloadPty, /spawn: \(cols, rows, sessionId\) =>/)
	assert.doesNotMatch(preloadPty, /cwd/)
})

test('folder selection is main-owned and reauthenticates after the native dialog', () => {
	const preferenceBridge = between(preload, '\tterminalPreferences: {', '\texternal: {')
	assert.match(preferenceBridge, /chooseDefaultCwd: \(\) =>[\s\S]*sessionProfileToken/)
	assert.doesNotMatch(preferenceBridge, /defaultCwd:|filePath|cwd/)

	const chooseHandler = between(
		main,
		"ipcMain.handle('terminal-preferences:choose'",
		"ipcMain.handle('terminal-preferences:reset'",
	)
	const dialogAt = chooseHandler.indexOf('await dialog.showOpenDialog')
	const reauthAt = chooseHandler.lastIndexOf('requireCurrentTerminalPreferencesSender')
	const persistAt = chooseHandler.indexOf('terminalPreferences.setDefaultCwd(result.filePaths[0])')
	assert.ok(dialogAt >= 0 && reauthAt > dialogAt && persistAt > reauthAt)
})

test('main resolves the persisted preference for ordinary spawns while scheduled adoption stays on HOME', () => {
	const ordinarySpawn = between(main, "ipcMain.handle('pty:spawn'", "ipcMain.on('pty:write'")
	assert.match(ordinarySpawn, /cwd: terminalPreferences\.snapshot\(\)\.effectiveCwd/)

	const scheduledSpawn = between(main, 'async function attachScheduledPty', 'function detachScheduledPty')
	assert.match(scheduledSpawn, /cwd: os\.homedir\(\)/)
})
