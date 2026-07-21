import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sidebar = readFileSync(new URL('../app/src/renderer/sidebar/sidebar.css', import.meta.url), 'utf8')
const cockpit = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf8')
const runContext = readFileSync(
	new URL('../app/src/renderer/run-context/run-context-editor.css', import.meta.url),
	'utf8',
)

function rule(css: string, selector: string): string {
	const start = css.indexOf(`${selector} {`)
	assert.notEqual(start, -1, `missing ${selector}`)
	const end = css.indexOf('}', start)
	return css.slice(start, end + 1)
}

function hasStableGutter(css: string, selector: string): void {
	assert.match(rule(css, selector), /scrollbar-gutter:\s*stable;/, `${selector} must reserve scrollbar width`)
}

test('persistent reading and editing surfaces reserve scrollbar width before overflow', () => {
	for (const selector of ['.page-scroll', '.sheet-body', '.log-well', '.plan-well']) {
		hasStableGutter(sidebar, selector)
	}
	hasStableGutter(runContext, '.run-context-editor')
	hasStableGutter(runContext, '.run-context-source')
})

test('full-width state-band lists use overlay scrolling without a blank edge gutter', () => {
	assert.doesNotMatch(rule(sidebar, '.list-scroll'), /scrollbar-gutter/)
})

test('transient background menu uses overlay scrolling without horizontal overflow', () => {
	const rows = rule(cockpit, '#bg-rows')
	assert.doesNotMatch(rows, /scrollbar-gutter/)
	assert.match(rows, /overflow-x:\s*hidden/)
})
