import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error -- app modules load as CommonJS objects under the root tsx test runner.
import helmBridgeModule from '../app/src/helm-bridge.ts'
import { parseDaemonEnvelope } from '../src/util/daemon-response.js'

type HelmBridgeModule = typeof import('../app/src/helm-bridge.ts')
const { HelmBridge } = helmBridgeModule as HelmBridgeModule
type HelmCliModule = typeof import('../src/cli/helm.js')

/** helm.ts dispatches on argv at import time; pin it to the harmless `help`. */
async function importHelmCli(): Promise<HelmCliModule> {
	const savedArgv = process.argv
	const savedLog = console.log
	process.argv = [savedArgv[0] ?? 'node', savedArgv[1] ?? 'helm', 'help']
	console.log = () => undefined
	try {
		return await import('../src/cli/helm.js')
	} finally {
		process.argv = savedArgv
		console.log = savedLog
	}
}

test('daemon clients parse JSON envelopes and turn other bodies into readable status errors', () => {
	assert.deepEqual(parseDaemonEnvelope(502, '{"error":"Contember (clientcare) could not be reached."}'), {
		error: 'Contember (clientcare) could not be reached.',
	})
	assert.throws(() => parseDaemonEnvelope(500, 'Internal Server Error'), {
		message: 'Helm daemon error 500: Internal Server Error',
	})
	assert.throws(() => parseDaemonEnvelope(502, ''), { message: 'Helm daemon error 502' })
	assert.throws(() => parseDaemonEnvelope(200, 'null'), { message: 'Helm daemon error 200: null' })
	assert.throws(
		() => parseDaemonEnvelope(504, `<html>\n  ${'x'.repeat(300)}\n</html>`),
		(error: unknown) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /^Helm daemon error 504: <html> x+…$/)
			assert.ok(error.message.length < 150)
			return true
		},
	)
})

test('Electron bridge reports a plain-text daemon 500 and a non-JSON 200 as readable errors', async t => {
	const fetchMock = t.mock.method(
		globalThis,
		'fetch',
		async () => new Response('Internal Server Error', { status: 500 }),
	)
	// The production fetch path (no injected `request` test seam).
	const bridge = new HelmBridge('http://127.0.0.1:7474') as unknown as {
		request(method: 'POST', path: string, body?: unknown): Promise<unknown>
	}
	assert.deepEqual(await bridge.request('POST', '/items', {}), {
		error: 'Helm daemon error 500: Internal Server Error',
		status: 500,
	})
	fetchMock.mock.mockImplementation(async () => new Response('OK', { status: 200 }))
	assert.deepEqual(await bridge.request('POST', '/items', {}), {
		error: 'Helm daemon error 200: OK',
		status: 200,
	})
})

test('CLI reports a plain-text daemon 500 as a readable error', async t => {
	const { postToDaemon } = await importHelmCli()
	t.mock.method(globalThis, 'fetch', async () => new Response('Internal Server Error', { status: 500 }))
	await assert.rejects(postToDaemon('http://127.0.0.1:7474', '/api/items', {}), {
		message: 'Helm daemon error 500: Internal Server Error',
	})
})
