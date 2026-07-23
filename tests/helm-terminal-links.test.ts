import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import externalUrlModule from '../app/src/external-url.ts'

const { parseExternalHttpUrl } = externalUrlModule
const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')

const githubUrl = 'https://github.com/neumie/scoped-secrets'

test('terminal web links use the restricted external-open bridge instead of window.open', () => {
	assert.match(renderer, /new WebLinksAddon\(\s*\(_event, uri\) => \{\s*void helm\.external\.open\(uri\)\s*\}/)
	assert.doesNotMatch(renderer, /term\.loadAddon\(new WebLinksAddon\(\)\)/)
	assert.match(preload, /open: url =>[\s\S]*?ipcRenderer\.invoke\('external:open', url, sessionProfileToken\)/)
	assert.match(main, /ipcMain\.handle\('external:open'/)
	assert.match(main, /shell\.openExternal\(href\)/)
})

test('external-open bridge accepts only bounded HTTP links', () => {
	assert.equal(parseExternalHttpUrl(githubUrl), githubUrl)
	assert.equal(parseExternalHttpUrl('http://localhost:7474/api/status'), 'http://localhost:7474/api/status')
	assert.equal(parseExternalHttpUrl('file:///etc/passwd'), null)
	assert.equal(parseExternalHttpUrl('javascript:alert(1)'), null)
	assert.equal(parseExternalHttpUrl('https://example.com/\u0000bad'), null)
	assert.equal(parseExternalHttpUrl(`https://example.com/${'a'.repeat(4096)}`), null)
	assert.equal(parseExternalHttpUrl({ href: githubUrl }), null)
})
