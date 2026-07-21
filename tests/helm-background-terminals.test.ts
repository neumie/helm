import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf8')
const html = readFileSync(new URL('../app/src/renderer/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf8')

function functionSlice(name: string, nextName: string): string {
	const start = renderer.indexOf(`function ${name}`)
	const end = nextName ? renderer.indexOf(`function ${nextName}`, start) : renderer.length
	return renderer.slice(start, end)
}

test('opening a background terminal activates it without restoring ownership', () => {
	const open = functionSlice('openParked', 'restoreParked')
	assert.match(open, /parked\.includes\(tab\)/)
	assert.match(open, /activate\(tab\)/)
	assert.doesNotMatch(open, /parked\.splice|setParked|tab\.parked\s*=/)

	const restore = functionSlice('restoreParked', 'killParkedTab')
	assert.match(restore, /parked\.splice/)
	assert.match(restore, /tab\.parked = false/)
	assert.match(restore, /setParked\(tab\.sessionId, false\)/)
})

test('background rows form an editorial list with explicit icon actions', () => {
	const render = functionSlice('renderBackgroundRows', 'onBgOutside')
	assert.match(render, /open\.addEventListener\('click', \(\) => openParked\(tab\)\)/)
	assert.match(render, /restore\.textContent = '⇥'/)
	assert.match(render, /restore\.addEventListener\('click', \(\) => restoreParked\(tab\)\)/)
	assert.match(render, /kill\.addEventListener\('click', \(\) => killParkedTab\(tab\)\)/)
	assert.match(html, /aria-haspopup="dialog"/)
	assert.match(html, /<span id="bg-header-count" class="bg-header-count">0<\/span>/)
	assert.match(css, /#bg-popover\s*\{[^}]*width:\s*320px/s)
	assert.match(css, /#bg-popover\s*\{[^}]*max-height:\s*min\(480px, calc\(100vh - 48px\)\)/s)
	assert.match(css, /#bg-rows\s*\{[^}]*overflow-y:\s*auto/s)
	assert.match(css, /\.bg-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto/s)
	assert.match(css, /\.bg-row\s*\{[^}]*min-height:\s*52px/s)
	assert.match(css, /\.bg-row\s*\{[^}]*margin:\s*0 -4px/s)
	assert.match(css, /\.bg-row\s*\{[^}]*width:\s*calc\(100% \+ 8px\)/s)
	assert.match(css, /\.bg-row\s*\{[^}]*border-radius:\s*0/s)
	assert.match(css, /\.bg-open\s*\{[^}]*grid-template-columns:\s*10px minmax\(0, 1fr\)/s)
	assert.match(css, /\.bg-state\s*\{[^}]*grid-column:\s*2/s)
})

test('background popover catches a click on native titlebar whitespace', () => {
	assert.match(html, /<div id="topbar-drag-space" class="topbar-drag-space" aria-hidden="true"><\/div>/)
	assert.match(css, /\.topbar-drag-space\.popover-catcher\s*\{[^}]*-webkit-app-region:\s*no-drag/s)
	const outside = functionSlice('onBgOutside', 'onBgKeydown')
	const open = functionSlice('openBackgroundPopover', 'closeBackgroundPopover')
	const close = functionSlice('closeBackgroundPopover', '')
	assert.match(outside, /event\.target === topbarDragSpace/)
	assert.match(outside, /bgToggle\.focus\(\)/)
	assert.match(open, /topbarDragSpace\.classList\.add\('popover-catcher'\)/)
	assert.match(close, /topbarDragSpace\.classList\.remove\('popover-catcher'\)/)
})

test('background rows reuse protocol-owned ActivityIndicator state', () => {
	const render = functionSlice('renderBackgroundRows', 'onBgOutside')
	assert.match(render, /tab\.agentRunning \|\| tab\.agentAttention/)
	assert.match(render, /createActivityIndicator/)
	assert.match(render, /sessionState/)
	assert.match(render, /agentState/)
	assert.match(render, /Open \$\{displayName\(tab\)\} and keep in background — \$\{sessionState\}/)
	assert.doesNotMatch(renderer, /bg-dot|activityMuteUntil|Output after parking lights/)
	assert.match(renderer, /if \(tab\.parked\) updateBackgroundUi\(\)/)
	assert.match(renderer, /if \(activeTab\.parked\) killParkedTab\(activeTab\)/)
})

test('closing the final background row moves focus before hiding the control', () => {
	const update = functionSlice('updateBackgroundUi', 'renderBackgroundRows')
	assert.match(update, /const focusWasInPopover = empty && bgPopover\.contains\(document\.activeElement\)/)
	assert.match(update, /if \(focusWasInPopover\) newTabButton\.focus\(\)/)
})
