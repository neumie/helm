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

test('renderer integration contract exposes no filesystem path or extension content', () => {
	const snapshot = between(
		shared,
		'export interface PiAgentStatusIntegrationSnapshot',
		'export interface AgentIntegrationsApi',
	)
	assert.match(snapshot, /status: PiAgentStatusIntegrationStatus/)
	assert.match(snapshot, /message: string/)
	assert.doesNotMatch(snapshot, /path|content|source/)
})

test('Pi integration IPC is read-only, profile-tokened, and reauthenticates after filesystem awaits', () => {
	const bridge = between(preload, '\tagentIntegrations: {', '\texternal: {')
	assert.match(bridge, /piStatus: \(\) => ipcRenderer\.invoke\('agent-integrations:pi-status', sessionProfileToken\)/)
	assert.doesNotMatch(bridge, /install|remove|update/i)
	assert.doesNotMatch(main, /agent-integrations:pi-(?:install|remove|update)/)

	const handler = between(main, "ipcMain.handle('agent-integrations:pi-status'", "ipcMain.handle('pty:spawn'")
	const awaitAt = handler.indexOf('await piAgentStatusIntegration.status()')
	assert.ok(awaitAt > handler.indexOf('requireCurrentAgentIntegrationsSender'))
	assert.ok(handler.lastIndexOf('requireCurrentAgentIntegrationsSender') > awaitAt)
	assert.match(handler, /publicAgentIntegrationSnapshot\(result\)/)
})

test('precise Pi reporting is enabled only through the ordinary shell environment', () => {
	const shellEnvironment = between(main, 'function shellEnv()', 'const scheduledOpenAcks')
	assert.match(shellEnvironment, /HELM_TERMINAL_AGENT_STATUS = '1'/)
	const scheduledAttach = between(main, 'async function attachScheduledPty', 'function detachScheduledPty')
	assert.doesNotMatch(scheduledAttach, /HELM_TERMINAL_AGENT_STATUS/)
})
