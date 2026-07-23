import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { daemonCorsMiddleware, daemonCorsOrigin } from '../src/server/app.js'

test('daemon CORS accepts only local app development and Chrome extension origins', () => {
	assert.equal(daemonCorsOrigin('chrome-extension://abcdefghijklmnop'), 'chrome-extension://abcdefghijklmnop')
	assert.equal(daemonCorsOrigin('https://clientcare.eu.contember.cloud'), 'https://clientcare.eu.contember.cloud')
	assert.equal(daemonCorsOrigin('http://localhost:6006'), 'http://localhost:6006')
	assert.equal(daemonCorsOrigin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173')
	assert.equal(daemonCorsOrigin('http://[::1]:7474'), 'http://[::1]:7474')
	assert.equal(daemonCorsOrigin('https://evil.example'), '')
	assert.equal(daemonCorsOrigin('null'), '')
	assert.equal(daemonCorsOrigin(''), '')
})

test('daemon CORS rejects hostile POSTs before a mutating route executes', async () => {
	const app = new Hono()
	let mutations = 0
	app.use('/api/*', daemonCorsMiddleware)
	app.post('/api/mutate', c => {
		mutations += 1
		return c.json({ data: true })
	})

	const rejected = await app.request('/api/mutate', {
		method: 'POST',
		headers: { Origin: 'https://evil.example' },
	})
	assert.equal(rejected.status, 403)
	assert.equal(mutations, 0)

	const extensionPage = await app.request('/api/mutate', {
		method: 'POST',
		headers: { Origin: 'https://clientcare.eu.contember.cloud' },
	})
	assert.equal(extensionPage.status, 200)
	assert.equal(extensionPage.headers.get('access-control-allow-origin'), 'https://clientcare.eu.contember.cloud')
	assert.equal(mutations, 1)
})
