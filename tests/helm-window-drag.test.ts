import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync(new URL('../app/src/renderer/index.html', import.meta.url), 'utf-8')
const normalizedHtml = html.replace(/\s+/g, ' ')
const css = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf-8')
const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf-8')

function rule(selector: string): string {
	const start = css.indexOf(`${selector} {`)
	assert.notEqual(start, -1, `missing ${selector} rule`)
	const end = css.indexOf('}', start)
	assert.notEqual(end, -1, `unterminated ${selector} rule`)
	return css.slice(start, end + 1)
}

test('terminal header keeps controls interactive and trailing whitespace draggable', () => {
	assert.match(
		normalizedHtml,
		/<div class="tab-strip-controls">[\s\S]*?<div id="tabs"[\s\S]*?<button id="new-tab"[\s\S]*?<\/div>[\s\S]*?<div id="topbar-drag-space" class="topbar-drag-space" aria-hidden="true"\s*><\/div>[\s\S]*?<div id="bg-root">/,
	)
	assert.match(rule('.topbar-right'), /-webkit-app-region:\s*drag;/)
	assert.match(rule('.tab-strip-controls'), /-webkit-app-region:\s*no-drag;/)
	assert.match(rule('.topbar-drag-space'), /flex:\s*1;/)
	assert.match(rule('.topbar-drag-space'), /min-width:\s*12px;/)
})

test('double-click rename cannot reach native titlebar zoom handling', () => {
	assert.match(rule('.tab'), /-webkit-app-region:\s*no-drag;/)
	assert.match(
		renderer,
		/tabButton\.addEventListener\('dblclick', event => \{\s*event\.preventDefault\(\)\s*event\.stopPropagation\(\)[\s\S]*?startRename\(tab\)\s*\}\)/,
	)
})
