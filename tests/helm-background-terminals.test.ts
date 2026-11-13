import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readRendererCss } from './helpers/renderer-css'

const html = readFileSync(new URL('../app/src/renderer/index.html', import.meta.url), 'utf8').replace(/\s+/g, ' ')
const css = readRendererCss()
const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')

// User interactions (open/restore, drag projection/cancel, group restore, exit/focus)
// are exercised against the real mounted workspace in app/browser-tests/terminal-workspace.spec.ts.

test('background strip uses the licensed Heroicons outline stack glyph at 16px, stroke 2', () => {
	assert.match(
		html,
		/<svg class="background-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"/,
	)
	assert.match(html, /M7\.5 7\.5H6\.75C5\.50736 7\.5 4\.5 8\.50736 4\.5 9\.75V17\.25/)
	assert.match(html, /M16\.5 10\.5H17\.25C18\.4926 10\.5 19\.5 11\.5074 19\.5 12\.75V20\.25/)
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
