import assert from 'node:assert/strict'
import test from 'node:test'
import thinkingTextModule from '../app/src/renderer/remote/thinking-text.js'

const { normalizeThinkingText } = thinkingTextModule as typeof import('../app/src/renderer/remote/thinking-text.js')

test('normalizes SGR and preserves ordinary thinking text', () => {
	assert.equal(normalizeThinkingText('\u001b[38;2;150;160;170mInspect\u001b[39m carefully'), 'Inspect carefully')
	assert.equal(normalizeThinkingText('\u001b[31mred\u001b[0m\u001b[38;5;12m blue'), 'red blue')
})

test('normalizes OSC, C1 controls, and incomplete suffixes', () => {
	assert.equal(normalizeThinkingText('open\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'), 'openlink')
	assert.equal(normalizeThinkingText('a\u009d8;;https://example.com\u001b\\link\u009d8;;\u009clater'), 'alinklater')
	assert.equal(normalizeThinkingText('a\u009b31mb\u009bc'), 'ab')
	assert.equal(normalizeThinkingText('visible\u001b[38;2;1;2;'), 'visible')
})

test('recovers malformed CSI and bounds Unicode safely', () => {
	assert.equal(normalizeThinkingText('a\u001b[31😀\nHello'), 'a😀\nHello')
	assert.equal(normalizeThinkingText('ok\u001b(B after'), 'ok after')
	assert.equal(normalizeThinkingText('123456789', 4), '1234')
	assert.equal(normalizeThinkingText('😀', 1), '')
})

test('handles every OSC introducer and terminator without losing subsequent text', () => {
	for (const start of ['\u001b]', '\u009d'])
		for (const end of ['\u0007', '\u001b\\', '\u009c'])
			assert.equal(normalizeThinkingText(`A${start}8;;https://example.invalid${end}link${start}8;;${end}B`), 'AlinkB')
})

test('drops only control prefixes on malformed input and formatting-only values', () => {
	assert.equal(normalizeThinkingText('A\u001b[31\n🌿B'), 'A\n🌿B')
	assert.equal(normalizeThinkingText('A\u001b[1 2mB'), 'A2mB')
	assert.equal(normalizeThinkingText('A\u001b(🌿B'), 'A🌿B')
	assert.equal(normalizeThinkingText('\u001b[31m\u001b[39m\u0000'), '')
	assert.equal(normalizeThinkingText('\u001b[31\n'.repeat(2000)).length, 1638)
})

test('preserves whitespace, unicode, and literal examples', () => {
	assert.equal(normalizeThinkingText('  café 😀\n\tline\r[39m \\x1b[39m'), '  café 😀\n\tline\r[39m \\x1b[39m')
})

test('removes only lexer-recognized emphasis and exact Thinking labels', () => {
	assert.equal(normalizeThinkingText('Thinking: **ship** *now*'), 'ship now')
	assert.equal(normalizeThinkingText('**Thinking**:\n**ship**'), 'ship')
	assert.equal(normalizeThinkingText('Thinking\r\n**ship**'), 'ship')
	assert.equal(normalizeThinkingText('a*b*c src/*/tests/* \\**literal**'), 'a*b*c src/*/tests/* \\**literal**')
	assert.equal(normalizeThinkingText('𝒜*×*𝒜 and **𝒜**'), '𝒜*×*𝒜 and 𝒜')
})

test('protects code, indentation, escapes, and line endings', () => {
	assert.equal(normalizeThinkingText('```\r**code**\r```\r\n**ok**'), '```\r**code**\r```\r\nok')
	assert.equal(
		normalizeThinkingText('    **indented**\n\t**tabbed**\n**plain**'),
		'    **indented**\n\t**tabbed**\nplain',
	)
	assert.equal(normalizeThinkingText('`**code**` and **ok**'), '`**code**` and ok')
	assert.equal(normalizeThinkingText('\\*literal* and **ok**'), '\\*literal* and ok')
})

test('keeps ANSI cleanup and falls back transactionally within the runtime bound', () => {
	assert.equal(normalizeThinkingText('\u001b[31m**ok**\u001b[0m'), 'ok')
	const long = `Thinking: ${' **x** `c`'.repeat(600)}`
	assert.ok(long.length < 8192)
	assert.equal(normalizeThinkingText(long), long)
})

test('approved source mapping: fenced escape stays protected', () => {
	assert.equal(normalizeThinkingText('~~~\n\\! **literal**\n~~~'), '~~~\n\\! **literal**\n~~~')
})

test('approved source mapping: exact inline delimiter runs', () => {
	assert.equal(
		normalizeThinkingText('before ``alpha``` **literal**`` after **Plan**'),
		'before ``alpha``` **literal**`` after Plan',
	)
})

test('approved source mapping: mid-prose Thinking survives', () => {
	assert.equal(normalizeThinkingText('Prose\nThinking: keep this'), 'Prose\nThinking: keep this')
})

test('approved source mapping: blank-leading label survives', () => {
	assert.equal(normalizeThinkingText('\nThinking: keep this'), '\nThinking: keep this')
})

test('approved source mapping: eight prefixes is global', () => {
	assert.equal(
		normalizeThinkingText(
			'Thinking: Thinking: Thinking: Thinking: Thinking: Thinking: Thinking: Thinking: Thinking: Keep',
		),
		'Thinking: Keep',
	)
})

test('approved source mapping: decorated leading label', () => {
	assert.equal(normalizeThinkingText('**Thinking:** *Check*'), 'Check')
})

test('approved source mapping: standalone heading', () => {
	assert.equal(normalizeThinkingText('# Thinking\n\n**Check**'), '\nCheck')
})

test('approved source mapping: label-only becomes empty', () => {
	assert.equal(normalizeThinkingText('**Thinking:**'), '')
})

test('approved source mapping: one-letter emphasis', () => {
	assert.equal(normalizeThinkingText('*x*'), 'x')
})

test('approved source mapping: triple emphasis', () => {
	assert.equal(normalizeThinkingText('***Important***'), 'Important')
})

test('approved source mapping: nested emphasis', () => {
	assert.equal(normalizeThinkingText('**outer *inner* text**'), 'outer inner text')
})

test('approved source mapping: local math guard', () => {
	assert.equal(normalizeThinkingText('a*b*c and **Plan**'), 'a*b*c and Plan')
})

test('approved source mapping: local paired-glob guard', () => {
	assert.equal(normalizeThinkingText('src/*/tests/* and **Plan**'), 'src/*/tests/* and Plan')
})

test('approved source mapping: astral operands', () => {
	assert.equal(
		normalizeThinkingText('\ud835\udc99*\ud835\udc9a*\ud835\udc9b and **Plan**'),
		'\ud835\udc99*\ud835\udc9a*\ud835\udc9b and Plan',
	)
})

test('approved source mapping: escaped-adjacent markers', () => {
	assert.equal(normalizeThinkingText('\\**literal** and **Plan**'), '\\**literal** and Plan')
})

test('approved source mapping: next-line indentation survives', () => {
	assert.equal(normalizeThinkingText('Thinking:\n    **literal**'), '    **literal**')
})

test('leading label grammar preserves ambiguous labels, blank lines, and source spelling', () => {
	for (const input of [
		'thinking: keep',
		'Thinking prose',
		'\tThinking: keep',
		'    Thinking: keep',
		'Thinking\tprose',
		'\\Thinking: keep',
		'`Thinking:`',
		'Thinking:: keep',
	]) {
		const expected = input === 'Thinking:: keep' ? ': keep' : input
		assert.equal(normalizeThinkingText(input), expected)
	}
	for (const label of [
		'Thinking:',
		'*Thinking:*',
		'**Thinking:**',
		'_Thinking_:',
		'__Thinking__:',
		'# Thinking',
		'###### Thinking',
		'   Thinking',
	])
		assert.equal(normalizeThinkingText(`${label}\r\n\n  next`), '\n  next')
	assert.equal(normalizeThinkingText('~~~\r\\! **literal**\r~~~\r**Plan**'), '~~~\r\\! **literal**\r~~~\rPlan')
	assert.equal(normalizeThinkingText('`unmatched **literal**'), '`unmatched **literal**')
	assert.equal(normalizeThinkingText('~~~\n**literal**'), '~~~\n**literal**')
	assert.equal(normalizeThinkingText('    \\! **literal**\n**Plan**'), '    \\! **literal**\nPlan')
})

test('nested underscore delimiter ownership is not mistaken for identifier operands', () => {
	assert.equal(normalizeThinkingText('___Important___'), 'Important')
	assert.equal(normalizeThinkingText('__outer _inner_ text__'), 'outer inner text')
	assert.equal(normalizeThinkingText('identifier_part_name and __Plan__'), 'identifier_part_name and Plan')
})
