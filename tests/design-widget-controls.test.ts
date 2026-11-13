// The extension widget's buttons are the §3.1 md button; its segmented picker and model trigger stay 28 like the
// sidebar's segmented control (§3.2) and fields (§3.7). §9 ruling 88 (D12 C, Jakub 2026-11-13).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const styles = readFileSync(new URL('../extension/src/widget.styles.ts', import.meta.url), 'utf8')
const rule = (selector: string) => {
	const start = styles.indexOf(`\t${selector} {`)
	assert.notEqual(start, -1, `${selector} exists`)
	return styles.slice(start, styles.indexOf('}', start))
}

for (const selector of ['.vg-btn', '.vg-pr']) {
	test(`${selector} is the §3.1 md button: 32 · 0 14 · 13/600 · radius 8`, () => {
		const css = rule(selector)
		assert.match(css, /\bheight:\s*32px;/)
		assert.match(css, /padding:\s*0 14px;/)
		assert.match(css, /font-size:\s*13px;/)
		assert.match(css, /font-weight:\s*600;/)
		assert.match(css, /border-radius:\s*var\(--vg-radius-lg\);/)
	})
}

test('the widget radius ladder matches §2.4 (lg 8)', () => {
	assert.match(styles, /--vg-radius-lg:\s*8px;/)
})

for (const selector of ['.vg-agent__seg', '.vg-model__trigger']) {
	test(`${selector} stays 28 (§3.2 segmented, §3.7 field height)`, () => {
		assert.match(rule(selector), /\bheight:\s*28px;/)
	})
}
