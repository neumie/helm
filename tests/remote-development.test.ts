import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startRemoteDevelopment } from '../src/remote/development.js'
import { readRemoteEnrollment } from '../src/remote/private-file.js'

test('development listener owns only fresh private state and loopback HTTP; real upgrades are denied', async t => {
	const assets = mkdtempSync(join(tmpdir(), 'hr-assets-'))
	writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Isolated Remote</title>')
	writeFileSync(join(assets, 'remote.js'), '')
	writeFileSync(join(assets, 'remote.css'), '')
	const running = await startRemoteDevelopment(assets)
	t.after(async () => {
		await running.stop()
		rmSync(assets, { recursive: true, force: true })
		rmSync(running.root, { recursive: true, force: true })
	})
	assert.equal(new URL(running.origin).hostname, '127.0.0.1')
	assert.equal(statSync(running.root).mode & 0o777, 0o700)
	assert.equal(statSync(join(running.root, 'browser-token')).mode & 0o777, 0o600)
	const enrollment = readRemoteEnrollment(join(running.root, 'enroll-1.json'))
	assert.equal(enrollment.scopeId, null)
	assert.equal(enrollment.socketPath, join(running.root, 'host.sock'))
	const page = await fetch(running.origin)
	assert.equal(page.status, 200)
	assert.match(page.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/)
	assert.equal(page.headers.get('Set-Cookie'), null)
	assert.equal((await fetch(`${running.origin}/v1/sessions`)).status, 401)
	const token = readFileSync(join(running.root, 'browser-token'), 'utf8')
	const headers = { Authorization: `Bearer ${token}` }
	assert.equal((await fetch(`${running.origin}/v1/sessions`, { headers })).status, 200)
	assert.equal((await fetch(`${running.origin}/api/config`, { headers })).status, 404)
	for (const auth of ['', `Authorization: Bearer ${token}\r\n`]) {
		const response = await new Promise<string>((resolve, reject) => {
			const url = new URL(running.origin)
			const socket = connect(Number(url.port), url.hostname)
			let result = ''
			socket.setTimeout(2000, () => socket.destroy(new Error('Upgrade timed out')))
			socket.on('connect', () =>
				socket.write(
					`GET /v1/sessions HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${running.origin}\r\n${auth}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
				),
			)
			socket.on('data', value => {
				result += value.toString()
			})
			socket.on('end', () => resolve(result))
			socket.on('error', reject)
		})
		assert.match(response, /^HTTP\/1\.1 403 Forbidden/)
	}
	await running.stop()
	await assert.rejects(fetch(`${running.origin}/v1/sessions`, { headers, signal: AbortSignal.timeout(2000) }))
})
