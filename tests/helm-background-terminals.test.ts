import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync(new URL('../app/src/renderer/index.html', import.meta.url), 'utf8').replace(/\s+/g, ' ')
const css = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf8')
const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')

// User interactions (open/restore, drag projection/cancel, group restore, exit/focus)
// are exercised against the real mounted workspace in app/browser-tests/terminal-workspace.spec.ts.

test('background strip uses the licensed native 16px Heroicons stack glyph', () => {
	assert.match(html, /<svg class="background-icon" width="16" height="16" viewBox="0 0 16 16"/)
	assert.match(html, /fill="currentColor"/)
	assert.match(html, /M7 1a\.75\.75 0 0 1 \.75\.75V6/)
	assert.match(html, /M4\.268 14A2 2 0 0 0 6 15h6/)
	assert.match(notices, /Heroicons[\s\S]*Arrow Down on Square Stack[\s\S]*MIT License/)
})

test('background presentation retains its documented flat editorial static CSS geometry', () => {
	assert.match(css, /#bg-popover\s*\{[^}]*width:\s*320px/s)
	assert.match(css, /#bg-rows\s*\{[^}]*overflow-y:\s*auto/s)
	assert.match(css, /\.bg-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto/s)
	assert.match(css, /\.bg-row\s*\{[^}]*min-height:\s*44px/s)
	assert.match(css, /\.bg-group-section\s*\{[^}]*box-shadow:\s*inset 2px 0/s)
	assert.match(css, /\.bg-group-header-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 28px 28px/s)
	assert.match(css, /\.topbar-drag-space\.popover-catcher[^}]*-webkit-app-region:\s*no-drag/s)
})
