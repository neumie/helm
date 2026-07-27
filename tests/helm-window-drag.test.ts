import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync(new URL('../app/src/renderer/index.html', import.meta.url), 'utf-8')
const normalizedHtml = html.replace(/\s+/g, ' ')
const css = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf-8')
const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf-8')
const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf-8')

function rule(selector: string): string {
	const start = css.indexOf(`${selector} {`)
	assert.notEqual(start, -1, `missing ${selector} rule`)
	const end = css.indexOf('}', start)
	assert.notEqual(end, -1, `unterminated ${selector} rule`)
	return css.slice(start, end + 1)
}

test('macOS window avoids hiddenInset native double-click hit-testing', () => {
	assert.match(main, /titleBarStyle:\s*'hidden'/)
	assert.doesNotMatch(main, /titleBarStyle:\s*'hiddenInset'/)
	assert.match(main, /process\.platform === 'darwin'\s*\? \{ maximizable: false, fullscreenable: false \}\s*:\s*\{\}/)
})

test('terminal header isolates native dragging to trailing whitespace only', () => {
	assert.match(
		normalizedHtml,
		/<div class="tab-strip-controls">[\s\S]*?<div id="tabs"[\s\S]*?<button id="new-tab"[\s\S]*?<\/div>[\s\S]*?<div id="topbar-drag-space" class="topbar-drag-space" aria-hidden="true"\s*><\/div>[\s\S]*?<div id="bg-root">/,
	)
	assert.match(rule('#topbar'), /-webkit-app-region:\s*no-drag;/)
	assert.match(rule('.topbar-left'), /-webkit-app-region:\s*drag;/)
	assert.match(rule('.topbar-right'), /-webkit-app-region:\s*no-drag;/)
	assert.match(rule('.tab-strip-controls'), /-webkit-app-region:\s*no-drag;/)
	assert.match(rule('.topbar-drag-space'), /-webkit-app-region:\s*drag;/)
	assert.match(rule('.topbar-drag-space'), /flex:\s*1;/)
	assert.match(rule('.topbar-drag-space'), /min-width:\s*12px;/)
})

test('the complete grouped-tab band cannot reach native titlebar zoom handling', () => {
	assert.match(rule('.tab-group-section'), /-webkit-app-region:\s*no-drag;/)
	assert.match(rule('.tab-group-members'), /-webkit-app-region:\s*no-drag;/)
})

test('double-click rename consumes the second press before mounting its input', () => {
	assert.match(rule('.tab'), /-webkit-app-region:\s*no-drag;/)
	assert.match(rule('.tab-rename'), /-webkit-app-region:\s*no-drag;/)
	assert.match(
		renderer,
		/tabButton\.addEventListener\(\s*'mousedown',[\s\S]*?if \(event\.detail < 2\) return\s*helm\.tabs\.guardNativeDoubleClick\(\)\s*event\.preventDefault\(\)\s*event\.stopImmediatePropagation\(\)/,
	)
	assert.match(
		renderer,
		/tabButton\.addEventListener\('dblclick', event => \{\s*event\.preventDefault\(\)\s*event\.stopImmediatePropagation\(\)[\s\S]*?requestAnimationFrame\(\(\) => startRename\(tab\)\)\s*\}\)/,
	)
})
