// Bounded Markdown → explicit React elements (app/src/renderer/safe-markdown.ts), shared by Helm Remote
// and the agent dock's turn message (agent-dock/turn-markdown.ts; design §3.24 Turn). The element
// tree is walked directly: every node must be an allowlisted tag or plain text, never parser HTML.
import assert from 'node:assert/strict'
import test from 'node:test'
import fixturesModule from '../app/src/renderer/agent-dock/agent-dock-fixtures.ts'
import turnModule from '../app/src/renderer/agent-dock/turn-markdown.ts'
import safeModule from '../app/src/renderer/safe-markdown.ts'

type SafeModule = typeof import('../app/src/renderer/safe-markdown.ts')
type TurnModule = typeof import('../app/src/renderer/agent-dock/turn-markdown.ts')
type FixturesModule = typeof import('../app/src/renderer/agent-dock/agent-dock-fixtures.ts')
const { MARKDOWN_TEXT_MAX, renderSafeMarkdown } = safeModule as unknown as SafeModule
const { turnMessage } = turnModule as unknown as TurnModule
const { TURN_MARKDOWN_TEXT } = fixturesModule as unknown as FixturesModule

const ALLOWED = new Set([
	'div',
	'p',
	'h3',
	'h4',
	'h5',
	'h6',
	'strong',
	'em',
	'del',
	'br',
	'hr',
	'code',
	'pre',
	'blockquote',
	'ul',
	'ol',
	'li',
	'span',
	'a',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td',
])
const FRAGMENT = Symbol.for('react.fragment')

interface Element {
	type: unknown
	props: Record<string, unknown>
}

/** Serializes the element tree as tag soup, failing on anything that is not an allowlisted element or text. */
function html(node: unknown): string {
	if (node === null || node === undefined || typeof node === 'boolean') return ''
	if (typeof node === 'string' || typeof node === 'number')
		return String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	if (Array.isArray(node)) return node.map(html).join('')
	const element = node as Element
	assert.equal(typeof element, 'object')
	if (element.type === FRAGMENT) return html(element.props.children)
	assert.equal(typeof element.type, 'string', 'only host elements, no components')
	const tag = element.type as string
	assert.ok(ALLOWED.has(tag), `unexpected <${tag}>`)
	assert.ok(!('dangerouslySetInnerHTML' in element.props), 'no raw HTML')
	const attributes = Object.entries(element.props)
		.filter(([name]) => name !== 'children')
		.map(([name, value]) => ` ${name}="${String(value)}"`)
		.join('')
	return `<${tag}${attributes}>${html(element.props.children)}</${tag}>`
}

/** The text a reader sees (all tags dropped). */
const textOf = (node: unknown) =>
	html(node)
		.replace(/<[^>]*>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')

test('turn message: paragraphs, bold, inline code, nested lists map to explicit elements', () => {
	const out = html(
		turnMessage('**Lead:** one `x`\n\n**1. Step**\n- item a:\n  - sub `@`\n  - sub2\n- item b\n\n1. first'),
	)
	assert.equal(
		out,
		'<div className="agent-dock-md">' +
			'<p><strong>Lead:</strong> one <code>x</code></p>' +
			'<p><strong>1. Step</strong></p>' +
			'<ul><li>item a:<ul><li>sub <code>@</code></li><li>sub2</li></ul></li><li>item b</li></ul>' +
			'<ol start="1"><li>first</li></ol>' +
			'</div>',
	)
})

test('the real turn: bold leads, two-level lists, every code span in <code>, cut text kept', () => {
	const out = html(turnMessage(TURN_MARKDOWN_TEXT))
	assert.ok(out.startsWith('<div className="agent-dock-md"><p><strong>Původní problém:</strong> jeden klient'))
	assert.equal(out.match(/<ul>/g)?.length, 4, 'two top-level lists, two nested')
	assert.match(out, /<li>Nová fce <code>isValidEmailAddress<\/code> v <code>lib\/src\/utils\/email\.ts<\/code>/)
	assert.match(out, /<ul><li>adresa má jen jedno <code>@<\/code><\/li>/)
	assert.match(out, /<code>, ; : &lt; &gt; \( \) \[ \] \\ "<\/code>/)
	assert.ok(textOf(turnMessage(TURN_MARKDOWN_TEXT)).endsWith('Kampaň mohla odejít, admin'))
	assert.doesNotMatch(textOf(turnMessage(TURN_MARKDOWN_TEXT)), /\*\*|`/)
})

test('no HTML passes through: tags stay literal text, never elements', () => {
	const source =
		'<script>alert(1)</script>\n\nHi <b>there</b> <img src=x onerror=alert(1)>\n\n<div onclick="x">block</div>'
	for (const node of [turnMessage(source), renderSafeMarkdown(source, remoteProfile)]) {
		const out = html(node)
		assert.doesNotMatch(out, /<(script|b|img|div onclick)[\s>]/, 'literal tags are text, escaped here')
		const text = textOf(node)
		for (const literal of ['<script>alert(1)</script>', '<b>there</b>', '<img src=x onerror=alert(1)>']) {
			assert.ok(text.includes(literal), literal)
		}
	}
})

const remoteProfile = {
	className: 'remote-markdown',
	plainClassName: 'remote-markdown remote-plain',
	links: 'anchor',
	imageNoteClassName: 'remote-image-note',
	tableClassName: 'remote-table',
} as const

test('dock: links are their text, images their alt text, tables their source; Remote keeps anchors', () => {
	const source =
		'[docs](https://example.com) [bad](javascript:alert(1)) ![shot](https://x/y.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |'
	const dock = html(turnMessage(source))
	assert.doesNotMatch(dock, /<a |<img|<table/)
	assert.match(dock, /<p>docs bad shot<\/p><pre>\| a \| b \|\n\|---\|---\|\n\| 1 \| 2 \|<\/pre>/)
	const remote = html(renderSafeMarkdown(source, remoteProfile))
	assert.match(remote, /<a href="https:\/\/example\.com\/" target="_blank" rel="noopener noreferrer">docs<\/a> bad/)
	assert.match(remote, /<span className="remote-image-note">Image: shot<\/span>/)
	assert.match(remote, /<div className="remote-table"><table>/)
})

test('bounds: the dock keeps plainAgentText’s 2 KiB cut and control/bidi strip; the renderer its 8 KiB', () => {
	const long = `- ${'word '.repeat(1_000)}`
	const dock = textOf(turnMessage(long))
	assert.equal(dock.length, 2_048 - 2, 'the cut (2047 units + …) minus the list marker "- "')
	assert.ok(dock.endsWith('…'))
	assert.equal(textOf(turnMessage('safe\u202etext\u0007')), 'safetext')
	assert.equal(textOf(renderSafeMarkdown('a'.repeat(MARKDOWN_TEXT_MAX + 500), remoteProfile)).length, MARKDOWN_TEXT_MAX)
	assert.equal(turnMessage('   \n '), null)
	assert.equal(turnMessage(42), null)
})
