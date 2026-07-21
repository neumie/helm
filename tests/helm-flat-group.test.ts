import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sections = readFileSync(new URL('../app/src/renderer/sidebar/DetailSections.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../app/src/renderer/sidebar/sidebar.css', import.meta.url), 'utf8')
const story = readFileSync(new URL('../app/src/renderer/sidebar/FlatGroup.stories.tsx', import.meta.url), 'utf8')

function functionSlice(source: string, name: string, nextName: string): string {
	const start = source.indexOf(`function ${name}`)
	const end = source.indexOf(`function ${nextName}`, start)
	return source.slice(start, end)
}

test('Item destinations share one flat resource group', () => {
	const link = functionSlice(sections, 'ResourceLink', 'ResourceRows')
	const rows = functionSlice(sections, 'ResourceRows', 'DeliveryCard')
	assert.doesNotMatch(link, /<Card/)
	assert.match(link, /<ActionRow nav/)
	assert.match(rows, /<Card flush>/)
	assert.match(rows, /<ResourceLink/)
})

test('tappable rows use a square full-bleed hover band on the page grid', () => {
	assert.match(css, /\.action-row\s*\{[^}]*margin:\s*0 -16px/s)
	assert.match(css, /\.action-row\s*\{[^}]*width:\s*calc\(100% \+ 32px\)/s)
	assert.match(css, /\.action-row\s*\{[^}]*padding:\s*0 16px/s)
	assert.match(css, /\.action-row\s*\{[^}]*border-radius:\s*0/s)
})

test('row hover fill leaves breathing room around separators', () => {
	assert.match(css, /\.action-row::after\s*\{[^}]*inset:\s*4px 0/s)
	assert.match(css, /\.action-row:hover:not\(:disabled\)::after\s*\{[^}]*background:\s*var\(--fill-subtle\)/s)
	assert.doesNotMatch(css, /\.action-row:hover:not\(:disabled\)\s*\{[^}]*background:/s)
})

test('work-list Item rows use square full-width state stripes', () => {
	assert.match(css, /\.list-scroll\s*\{[^}]*padding:\s*6px 0 16px/s)
	assert.match(css, /\.item-row\s*\{[^}]*width:\s*100%/s)
	assert.match(css, /\.item-row\s*\{[^}]*padding:\s*0 16px/s)
	assert.match(css, /\.item-row\s*\{[^}]*border-radius:\s*0/s)
	assert.match(css, /\.item-row-actions\s*\{[^}]*right:\s*16px/s)
	assert.match(css, /\.item-project-group-head\s*\{[^}]*padding:\s*8px 16px 0/s)
})

test('Flat group stories do not mix navigation pitch into Action rows', () => {
	const actions = story.slice(story.indexOf('export const ActionRows'), story.indexOf('export const NavRows'))
	assert.doesNotMatch(actions, /label="Task"/)
})
