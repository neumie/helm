import assert from 'node:assert/strict'
import test from 'node:test'
import externalUrlModule from '../extension/src/external-url.ts'
const { externalHttpUrl } = externalUrlModule

test('widget external links accept bounded credential-free absolute HTTP(S) only', () => {
	assert.equal(externalHttpUrl('https://example.test/task?id=1#part'), 'https://example.test/task?id=1#part')
	assert.equal(externalHttpUrl('http://example.test/'), 'http://example.test/')
	for (const value of [
		null,
		'',
		'/relative',
		'javascript:alert(1)',
		'data:text/html,hello',
		'file:///tmp/a',
		'https://user:pass@example.test/',
		'https://example.test/\n',
		`https://example.test/${'x'.repeat(4096)}`,
	])
		assert.equal(externalHttpUrl(value), null)
})
