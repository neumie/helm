import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { issueBody } from '../src/github/item-issue-text.js'
import { applyRunContextDocument } from '../src/items/run-context.js'
import { extractDescriptionBlocks, extractPlainText, slateToMarkdown } from '../src/providers/contember-slate.js'
import { ContemberProvider } from '../src/providers/contember.js'
import { taskContextSchema } from '../src/providers/provider.js'

/**
 * The shape of a real ClientCare task description (text, links and Slate keys
 * replaced): whitespace-only paragraphs between the text, bullet lists with
 * links, a bold first line and a mailto link. The old fallback leaked the `key`
 * of every whitespace-only paragraph into the GitHub issue and the prompt.
 */
const fixture = JSON.parse(
	readFileSync(new URL('./fixtures/contember/task-whitespace-paragraphs.json', import.meta.url), 'utf8'),
) as {
	description: { data: { children: Array<{ key?: string; children?: Array<{ text?: string }> }> }; references: [] }
}
const data = fixture.description.data

/** Slate `key`s of the paragraphs holding only whitespace (or nothing). */
const blankKeys = data.children
	.filter(
		node => node.key && (node.children ?? []).every(child => typeof child.text === 'string' && !child.text.trim()),
	)
	.map(node => node.key as string)

const leaked = (text: string) => blankKeys.filter(key => new RegExp(`(^|\\W)${key}(\\W|$)`).test(text))

const p = (...children: unknown[]) => ({ key: 'k', type: 'paragraph', children })
const t = (text: string, marks: Record<string, unknown> = {}) => ({ text, ...marks })
const a = (href: string, text: string) => ({ type: 'anchor', href, children: [t(text)] })
const li = (...children: unknown[]) => ({ type: 'listItem', children })
const ul = (...items: unknown[]) => ({ type: 'unorderedList', children: items })
const ol = (...items: unknown[]) => ({ type: 'orderedList', children: items })
const doc = (...children: unknown[]) => ({ children, formatVersion: 2 })

const sentences = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, index) => `Sentence ${from + index} of the task`)
const form = (id: string) => `[https://app.client.example/form/?id=${id}](https://app.client.example/form/?id=${id})`

/** The whole fixture as markdown, block by block. */
const FIXTURE_MARKDOWN = [
	'**Sentence 1 of the task, in bold**',
	...sentences(2, 9),
	'- Sentence 10 of the task',
	'Sentence 11 of the task',
	`- Sentence 12 of the task ${form('form-a')}`,
	'Sentence 13 of the task',
	`- Sentence 14 of the task ${form('form-b')}`,
	'Sentence 15 of the task',
	`- Sentence 16 of the task ${form('form-c')}`,
	'Sentence 17 of the task',
	`- Sentence 18 of the task ${form('form-d')}`,
	...sentences(19, 26),
	'Sentence 27 of the task [analyst@agency.example](mailto:analyst@agency.example) Sentence 28 of the task',
].join('\n\n')

function provider() {
	return new ContemberProvider({
		type: 'contember',
		apiBaseUrl: 'https://api.example',
		projectSlug: 'cc',
		apiToken: 'token',
		statuses: ['new'],
	})
}

test('fixture has the whitespace-only paragraphs the bug needs', () => {
	assert.ok(blankKeys.includes('blk3zq'), 'a " " paragraph')
	assert.ok(blankKeys.includes('blkdzq'), 'an empty "" paragraph')
	assert.ok(blankKeys.length >= 10)
})

test('plain text and description blocks never carry Slate node keys', () => {
	const plain = extractPlainText(data)
	const blocks = extractDescriptionBlocks(data, fixture.description.references)
	const blockText = blocks.map(block => (block.type === 'text' ? block.text : '')).join('\n')
	assert.deepEqual(leaked(plain), [])
	assert.deepEqual(leaked(blockText), [])
	assert.equal(blocks.length, 27, 'one block per non-blank paragraph or list')
	assert.ok(blocks.every(block => block.type === 'text' && block.text.trim().length > 0))
	assert.ok(plain.startsWith('Sentence 1 of the task, in bold Sentence 2 of the task Sentence 3 of the task'))
	assert.ok(plain.endsWith('Sentence 27 of the task analyst@agency.example Sentence 28 of the task'))
})

test('a node with no readable text yields nothing, not its keys or ids', () => {
	assert.equal(extractPlainText({ key: 'zq9x1', type: 'paragraph', children: [{ text: ' ' }] }), '')
	assert.equal(extractPlainText({ key: 'zq9x1', type: 'paragraph', children: [{ text: '' }] }), '')
	assert.equal(extractPlainText({ key: 'zq9x1', type: 'mystery', referenceId: 'ref-1', color: 'red' }), '')
	assert.equal(extractPlainText(p(t('​'))), '')
	const blanks = doc(p(t(' ')), p(t('   ')), p(t('')), p(t('​')), p(t('⁠ ')), p(t('   ')))
	assert.deepEqual(extractDescriptionBlocks(blanks, []), [])
	assert.equal(slateToMarkdown(blanks), '')
	assert.equal(slateToMarkdown(doc(p(t(' ')), p(t('ok')))), 'ok')
})

test('the fixture renders as markdown: bold, lists, links, mailto, no blank-paragraph tokens', () => {
	assert.equal(slateToMarkdown(data, fixture.description.references), FIXTURE_MARKDOWN)
})

test('markdown: headings, emphasis, inline code and strikethrough keep whitespace outside the delimiters', () => {
	const markdown = slateToMarkdown(
		doc(
			{ type: 'heading', level: 2, children: [t('Steps')] },
			{ type: 'heading', level: 9, children: [t('Deep')] },
			p(t('Make '), t('this ', { isBold: true }), t('bold', { bold: true }), t(' and '), t('this', { isItalic: true })),
			p(
				t('Run '),
				t('npm test', { isCode: true }),
				t(' not '),
				t('a `b`', { isCode: true }),
				t(' or '),
				t('old', { isStruckThrough: true }),
			),
			p(t('underlined', { isUnderlined: true }), t(' and '), t(' ', { isBold: true }), t('colored', { color: 'red' })),
		),
	)
	assert.equal(
		markdown,
		[
			'## Steps',
			'###### Deep',
			'Make **this bold** and *this*',
			'Run `npm test` not `` a `b` `` or ~~old~~',
			'underlined and  colored',
		].join('\n\n'),
	)
})

test('markdown: emphasis never spans a blank line and falls back to HTML where delimiters would not flank', () => {
	assert.equal(
		slateToMarkdown(doc(p(t('First line\n\nSecond line', { isBold: true })))),
		'**First line**\n\n**Second line**',
	)
	assert.equal(slateToMarkdown(doc(p(t('one\ntwo', { isItalic: true })))), '*one\ntwo*', 'a single newline is fine')
	assert.equal(slateToMarkdown(doc(p(t('Stav:', { isBold: true }), t('hotovo')))), '<strong>Stav:</strong>hotovo')
	assert.equal(
		slateToMarkdown(doc(p(t('viz'), t('(důležité)', { isBold: true }), t('dál')))),
		'viz<strong>(důležité)</strong>dál',
	)
	assert.equal(slateToMarkdown(doc(p(t('e-', { isStruckThrough: true }), t('mail')))), '<del>e-</del>mail')
	assert.equal(
		slateToMarkdown(doc(p(t('run'), t('a<b', { isCode: true, isBold: true }), t('now')))),
		'run<strong><code>a&lt;b</code></strong>now',
	)
	assert.equal(slateToMarkdown(doc(p(t('Stav:', { isBold: true }), t(' hotovo')))), '**Stav:** hotovo')
	assert.equal(slateToMarkdown(doc(p(t('slovo', { isItalic: true }), t('.')))), '*slovo*.')
})

test('markdown: bullet, numbered and nested lists; empty items dropped; same-kind lists stay apart', () => {
	assert.equal(
		slateToMarkdown(
			doc(
				ul(li(t('one')), li(t(' ')), li(t('two'), ul(li(t('two-a'))))),
				ol(li(p(t('first'))), li(p(t('second')), p(t('more\nlines')))),
			),
		),
		['- one\n- two\n  - two-a', '1. first\n2. second\n   more\n   lines'].join('\n\n'),
	)
	assert.equal(
		slateToMarkdown(doc(ol(li(t('a')), li(t('b'))), p(t(' ')), ol(li(t('c'))))),
		'1. a\n2. b\n\n<!-- -->\n\n1. c',
	)
	assert.equal(slateToMarkdown(doc(ul(li(p(t('foo')), { type: 'horizontalRule', children: [t('')] })))), '- foo\n  ***')
})

test('markdown: links (http, mailto, unsafe), link text escaping and images', () => {
	const markdown = slateToMarkdown(
		doc(
			p(t('See '), a('https://example.com/a b(c)', 'the [docs]'), t('.')),
			p(t('Mail '), a('mailto:someone@example.com', 'someone@example.com')),
			p(a('javascript:alert(1)', 'click me'), t(' '), a('https://example.com', '')),
			p(a('https://x.example/a\\', 'odkaz'), t(' tail) more')),
			{ type: 'image', referenceId: 'img', children: [t('')] },
			{ type: 'image', referenceId: 'local', children: [t('')] },
			{ type: 'file', referenceId: 'doc', children: [t('')] },
		),
		[
			{ id: 'img', file: { url: 'https://cdn.example/shot.png', fileName: 'shot [1].png' } },
			{ id: 'local', file: { url: '/api/items/x/attachments/a.png', fileName: 'a.png' } },
			{ id: 'doc', file: { url: 'https://cdn.example/spec.pdf', fileName: 'spec.pdf' } },
		],
	)
	assert.equal(
		markdown,
		[
			'See [the \\[docs\\]](https://example.com/a%20b%28c%29).',
			'Mail [someone@example.com](mailto:someone@example.com)',
			'click me [https://example.com](https://example.com)',
			'[odkaz](https://x.example/a%5C) tail) more',
			'![shot \\[1\\].png](https://cdn.example/shot.png)',
		].join('\n\n'),
	)
})

test('markdown: tables, rules and bare-array documents', () => {
	const cell = (text: string) => ({ type: 'tableCell', children: [t(text)] })
	const row = (...cells: unknown[]) => ({ type: 'tableRow', children: cells })
	assert.equal(
		slateToMarkdown([
			p(t('Top')),
			{ type: 'horizontalRule', children: [t('')] },
			{ type: 'table', children: [row(cell('Web'), cell('Now')), row(cell('a|b'), cell('x\ny')), row(cell('c\\|d'))] },
		]),
		'Top\n\n***\n\n| Web | Now |\n| --- | --- |\n| a\\|b | x<br>y |\n| c\\\\\\|d |  |',
	)
	assert.deepEqual(extractDescriptionBlocks([p(t('array doc'))], []), [{ type: 'text', text: 'array doc' }])
	assert.equal(slateToMarkdown(null), '')
	assert.equal(slateToMarkdown({ formatVersion: 2 }), '')
})

test('markdown stays bounded for hostile documents', () => {
	const cell = { type: 'tableCell', children: [t('')] }
	const wide = { type: 'tableRow', children: Array.from({ length: 3000 }, () => cell) }
	const tall = Array.from({ length: 3000 }, () => ({ type: 'tableRow', children: [cell] }))
	const started = performance.now()
	const table = slateToMarkdown(doc({ type: 'table', children: [wide, ...tall] }))
	assert.ok(performance.now() - started < 1000)
	assert.ok(table.length < 60_100)
	assert.ok(table.endsWith('(truncated)'))

	let nested: unknown = t('deep')
	for (let index = 0; index < 5000; index++) nested = li(nested)
	assert.doesNotThrow(() => slateToMarkdown(doc(ul(nested))))
	let lists: unknown = li(t('deep'))
	for (let index = 0; index < 5000; index++) lists = li(ul(lists))
	assert.doesNotThrow(() => slateToMarkdown(doc(ul(lists))))
	assert.ok(slateToMarkdown(doc(p(t('`'.repeat(200_000), { isCode: true })))).length > 0)
})

test('ContemberProvider returns descriptionMarkdown and the issue body uses it', async ctx => {
	ctx.mock.method(
		globalThis,
		'fetch',
		async () =>
			new Response(
				JSON.stringify({
					data: {
						getTask: {
							id: 'task-1',
							title: 'Form tracking',
							status: 'new',
							description: fixture.description,
							comments: [],
						},
					},
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
	)
	const task = await provider().getTaskContext('task-1')
	assert.ok(task)
	assert.equal(task.descriptionMarkdown, FIXTURE_MARKDOWN)
	assert.equal(taskContextSchema.parse(task).descriptionMarkdown, FIXTURE_MARKDOWN, 'survives captured-context parse')
	assert.deepEqual(leaked(task.description ?? ''), [], 'the prompt description has no keys either')

	const body = issueBody({
		itemId: 'item-1',
		projectSlug: 'demo',
		source: { provider: 'Contember', externalId: 'task-1', url: null },
		task,
	})
	assert.deepEqual(leaked(body), [])
	assert.equal(body.split('**Sentence 1 of the task, in bold**').length, 2, 'the description appears once')
	assert.ok(body.includes(`### Form tracking\n\n${FIXTURE_MARKDOWN}`))

	for (const document of [
		{ version: 2 as const, text: 'Operator text', images: [], updatedAt: '2026-11-26T10:00:00.000Z' },
		{ version: 1 as const, blocks: [], markdown: 'Operator text', updatedAt: '2026-11-26T10:00:00.000Z' },
	]) {
		const edited = applyRunContextDocument(task, document)
		assert.equal(edited.descriptionMarkdown, undefined, `run context v${document.version} replaces the markdown too`)
		const editedBody = issueBody({ itemId: 'item-1', projectSlug: 'demo', source: null, task: edited })
		assert.ok(editedBody.includes('Operator text'))
		assert.ok(!editedBody.includes('Sentence 1 of the task'))
	}
})

test('a description markdown cannot render never fails the task read', async ctx => {
	let nested: unknown = t('deep')
	for (let index = 0; index < 20_000; index++) nested = { type: 'mystery', children: [nested] }
	ctx.mock.method(
		globalThis,
		'fetch',
		async () =>
			new Response(
				JSON.stringify({
					data: { getTask: { id: 'x', title: 'X', description: { data: doc(nested), references: [] } } },
				}),
				{ status: 200 },
			),
	)
	const task = await provider().getTaskContext('x')
	assert.equal(task?.title, 'X')
})

test('issue body defuses mentions and markers inside markdown descriptions but keeps link destinations', () => {
	const body = issueBody({
		itemId: 'item-1',
		projectSlug: 'demo',
		source: null,
		task: {
			title: 'T',
			descriptionMarkdown: [
				'Ping @team <!-- helm:item other --> and mail [a@b.cz](mailto:a@b.cz)',
				'Profile [Instagram](https://www.instagram.com/@brand) and `x`@octocat',
				'Fake ](@crew) destination',
			].join('\n\n'),
		},
	})
	assert.ok(body.includes('Ping @​team'))
	assert.ok(!body.includes('<!-- helm:item other'))
	assert.ok(body.includes('[a@b.cz](mailto:a@b.cz)'))
	assert.ok(body.includes('(https://www.instagram.com/@brand)'), 'a URL keeps its @')
	assert.ok(body.includes('`x`@​octocat'), 'a code span cannot shield a mention')
	assert.ok(body.includes('](@​crew)'), 'only real URL destinations are left alone')
})
