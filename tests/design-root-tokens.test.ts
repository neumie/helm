// §2.4 radius tokens and the `--accent-text` alias are defined on `:root` (§9 ruling 17, §9 ruling 87; D4 A2 + A,
// Jakub 2026-11-13). Before, every `var(--radius-*)` without a fallback was invalid and its corner fell to 0, and
// `.shortcut-recording` inherited its parent's colour.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const root = (() => {
	const css = read('app/src/renderer/tokens.css')
	const start = css.indexOf(':root {')
	return css.slice(start, css.indexOf('\n}', start))
})()
const rule = (css: string, selector: string) => {
	const start = css.indexOf(`${selector} {`)
	assert.notEqual(start, -1, `${selector} exists`)
	return css.slice(start, css.indexOf('}', start))
}

test('the §2.4 radius tokens are defined on :root with the spec values', () => {
	assert.match(root, /--radius-lg:\s*8px;/)
	assert.match(root, /--radius-md:\s*6px;/)
	assert.match(root, /--radius-sm:\s*4px;/)
})

test('--accent-text is an alias of the accent, so it follows every preset and theme', () => {
	assert.match(root, /--accent-text:\s*var\(--accent\);/)
	assert.match(
		rule(read('app/src/renderer/sidebar/sidebar.css'), '.shortcut-recording'),
		/color:\s*var\(--accent-text\)/,
	)
})

test('the 28px group-name field uses the field radius (--radius-md, §3.7), not --radius-sm', () => {
	const input = rule(read('app/src/renderer/terminal-context-menu.css'), '.menu-name-input')
	assert.match(input, /height:\s*28px/)
	assert.match(input, /border-radius:\s*var\(--radius-md\)/)
})
