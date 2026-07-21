import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const bridge = readFileSync(new URL('../app/src/helm-bridge.ts', import.meta.url), 'utf8')

test('workspace-building commands outlive the generic daemon request budget', () => {
	assert.match(bridge, /const REQUEST_TIMEOUT_MS = 10_000/)
	assert.match(bridge, /const HELPER_REQUEST_TIMEOUT_MS = 60_000/)
	assert.match(bridge, /const WORKSPACE_REQUEST_TIMEOUT_MS = 120_000/)
	assert.match(bridge, /body\?: unknown,\s*timeoutMs = REQUEST_TIMEOUT_MS/)
	assert.match(bridge, /signal: AbortSignal\.timeout\(timeoutMs\)/)
	assert.match(bridge, /ipcMain\.handle\('daemon:plan'[\s\S]{0,400}WORKSPACE_REQUEST_TIMEOUT_MS/)
	assert.match(bridge, /ipcMain\.handle\('daemon:openOkena'[\s\S]{0,400}WORKSPACE_REQUEST_TIMEOUT_MS/)
	assert.match(bridge, /ipcMain\.handle\('daemon:aiPass'[\s\S]{0,700}HELPER_REQUEST_TIMEOUT_MS/)
})
