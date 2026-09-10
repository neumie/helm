import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { RemoteAccess } from '../../src/remote/access.js'
import { controlRequest, startRemoteRuntime } from '../../src/remote/runtime.js'

// Child isolation is intentional: the RED transport destroys an IncomingMessage
// with an unhandled error. A crash must fail this case, not the whole test runner.
const root = mkdtempSync('/tmp/hr-control-')
chmodSync(root, 0o700)
const mode = process.argv[2]
const grant = {
	personalCurrentAndFuture: true,
	scopeIds: [] as string[],
	operations: { read: true, prompt: true, interrupt: true, answer: true },
}
try {
	if (mode === 'count' || mode === 'bytes') {
		const access = new RemoteAccess(join(root, 'devices.json'))
		if (mode === 'bytes') grant.scopeIds = Array.from({ length: 64 }, () => randomUUID())
		let count = 0
		while (access.redeem({ code: access.createPairing(`Device ${count}`, grant).code })) count++
		assert.ok(mode === 'count' ? count === 128 : count > 0 && count < 128)
		const assets = join(root, 'assets')
		mkdirSync(assets)
		for (const name of ['index.html', 'remote.js', 'remote.css']) writeFileSync(join(assets, name), '')
		const runtime = await startRemoteRuntime({
			root,
			origin: 'https://remote.example',
			assetsDirectory: assets,
			port: 0,
			piSessionRoots: [],
		})
		try {
			const result = (await controlRequest(
				join(root, 'control.sock'),
				readFileSync(join(root, 'operator-token'), 'utf8').trim(),
				'/devices',
			)) as { devices: unknown[] }
			assert.deepEqual(result.devices, access.list())
			assert.equal(result.devices.length, count)
			assert.ok(Buffer.byteLength(JSON.stringify(result)) > 32 * 1024)
			assert.ok(!JSON.stringify(result).includes('credentialHash'))
		} finally {
			await runtime.stop()
		}
	} else {
		const socket = join(root, 'fake.sock')
		const server = createServer((_request, response) => {
			if (mode === 'oversize') response.end(JSON.stringify({ value: 'x'.repeat(256 * 1024) }))
			else {
				response.writeHead(200, { 'Content-Length': 1000 })
				response.write('{"partial":')
				setImmediate(() => response.destroy())
			}
		})
		await new Promise<void>(resolve => server.listen(socket, resolve))
		try {
			await assert.rejects(controlRequest(socket, 'test-only', '/devices'), /too large|aborted|reset|socket hang up/i)
		} finally {
			server.closeAllConnections()
			await new Promise<void>(resolve => server.close(() => resolve()))
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true })
}
console.log('handled control proof completed')
