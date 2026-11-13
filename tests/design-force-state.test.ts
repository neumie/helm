// Storybook StateGrid contract (docs/design-system.md §7): every interactive
// state selector on a primitive has a `[data-force-state]` alternative in the
// SAME rule, so a StateGrid cell renders the state from the real CSS. Rules are
// read with the design lint's CSS parser (packages/helm-ui/lint.ts parseCss:
// nesting, strings and at-rules), over every production stylesheet the lint scans.
// CJS default-import pattern per the other app tests (app sources load as CommonJS under tsx).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import * as lint from '../packages/helm-ui/lint.ts'

const ROOT = join(import.meta.dirname, '..')
const RENDERER = join(ROOT, 'app', 'src', 'renderer')

/** Every production stylesheet (the design lint's CSS sources: app renderer,
 *  Remote, Document Review, viewer, Scheduled runs, Run Context, extension).
 *  Every file is checked against every primitive class, so a primitive state
 *  rule written anywhere is caught. Repository-relative paths. */
const PRIMITIVE_CSS_FILES = lint
	.collectSources(ROOT)
	.filter(source => source.kind === 'css')
	.map(source => source.file)

/** Primitive classes with state rules of their own. A class matches itself and
 *  its `-modifier` variants (`.btn` covers `.btn-primary`). Toggle is not
 *  listed: it has no state rules and takes the global button focus ring. */
const PRIMITIVE_CLASSES = [
	'btn',
	'icon-btn',
	'project-trigger',
	'segment',
	'menu-item',
	'item-row',
	'action-row',
	'input',
	'field-reset',
	'status-menu-trigger',
] as const

const PRIMITIVE_STORIES = [
	'sidebar/Button.stories.tsx',
	'sidebar/Segmented.stories.tsx',
	'sidebar/Field.stories.tsx',
	'sidebar/ChipAndDot.stories.tsx',
	'sidebar/Menus.stories.tsx',
	'sidebar/ListRow.stories.tsx',
	'sidebar/FlatGroup.stories.tsx',
	'sidebar/Disclosure.stories.tsx',
]

interface Rule {
	selectors: string[]
}

/** Style rules at any nesting depth (nested `&:hover` resolved against its
 *  parent, at-rule blocks entered, strings and comments skipped), one per
 *  distinct selector list in its at-rule context. Keyframe steps are not rules.
 *  A rule with no declaration has nothing to force and is not listed. */
function styleRules(css: string): Rule[] {
	const rules = new Map<string, Rule>()
	for (const d of lint.parseCss(css)) {
		if (d.atRules.some(at => /^@(-[a-z]+-)?keyframes\b/i.test(at))) continue
		const prefix = d.atRules.length ? `${d.atRules.join(' ')} ` : ''
		const list = d.selector.startsWith(prefix) ? d.selector.slice(prefix.length) : d.selector
		if (list.startsWith('@')) continue
		if (!rules.has(d.selector)) rules.set(d.selector, { selectors: lint.splitTopLevel(list).filter(Boolean) })
	}
	return [...rules.values()]
}

const STATE_PSEUDO = /:(hover|active|focus-visible|focus)(?![\w-])/y

function forcedName(pseudo: string): string {
	return pseudo === 'focus' ? 'focus-visible' : pseudo
}

interface StateHit {
	index: number
	length: number
	pseudo: string
	/** Inside `:not(…)` at any depth: a forced twin there would match every
	 *  production element, so such states need no twin and may never get one. */
	negated: boolean
}

/** State pseudo-classes in a selector, each marked whether it sits inside
 *  `:not(…)`. Brackets (attribute values) are skipped. */
function stateHits(selector: string): StateHit[] {
	const hits: StateHit[] = []
	const parens: boolean[] = [] // per open paren: does it belong to :not(
	let bracket = 0
	for (let index = 0; index < selector.length; index++) {
		const char = selector[index]
		if (char === '[') bracket++
		else if (char === ']') bracket--
		if (bracket > 0) continue
		if (char === '(') parens.push(selector.slice(0, index).endsWith(':not'))
		else if (char === ')') parens.pop()
		else if (char === ':') {
			STATE_PSEUDO.lastIndex = index
			const match = STATE_PSEUDO.exec(selector)
			if (match)
				hits.push({ index, length: match[0].length, pseudo: match[1] as string, negated: parens.includes(true) })
		}
	}
	return hits
}

/** The selector with every non-negated state pseudo-class replaced by its
 *  forced attribute. */
function forcedAlternative(selector: string): string {
	let out = selector
	for (const hit of stateHits(selector)
		.filter(hit => !hit.negated)
		.reverse()) {
		out = `${out.slice(0, hit.index)}[data-force-state="${forcedName(hit.pseudo)}"]${out.slice(hit.index + hit.length)}`
	}
	return out
}

/** Has a state pseudo-class that needs a forced twin (not inside `:not`). */
function hasStatePseudo(selector: string): boolean {
	return stateHits(selector).some(hit => !hit.negated)
}

/** `data-force-state` inside `:not(…)` matches every production element. */
function forcedInsideNot(selector: string): boolean {
	const parens: boolean[] = []
	for (let index = 0; index < selector.length; index++) {
		const char = selector[index]
		if (char === '(') parens.push(selector.slice(0, index).endsWith(':not'))
		else if (char === ')') parens.pop()
		else if (parens.includes(true) && selector.startsWith('data-force-state', index)) return true
	}
	return false
}

function primitiveClassesIn(selector: string): string[] {
	const tokens = selector.match(/\.[A-Za-z_][\w-]*/g) ?? []
	return PRIMITIVE_CLASSES.filter(name => tokens.some(token => token === `.${name}` || token.startsWith(`.${name}-`)))
}

/** A file under app/src/renderer. */
function read(file: string): string {
	return readFileSync(join(RENDERER, file), 'utf8')
}

/** A repository-relative file. */
function readRepo(file: string): string {
	return readFileSync(join(ROOT, file), 'utf8')
}

test('the rule reader handles @media lists, nesting and braces inside strings', () => {
	const rules = styleRules(
		'@media (hover: hover) { .a:hover, .b[x="1,2"] { color: red; } } /* c { } */ .d { color: red }',
	)
	assert.deepEqual(
		rules.map(rule => rule.selectors),
		[['.a:hover', '.b[x="1,2"]'], ['.d']],
	)
	assert.deepEqual(
		styleRules('.btn { color: red; &:hover { color: blue } } .x { content: "{"; } .btn-ghost:hover { color: red }').map(
			rule => rule.selectors,
		),
		[['.btn'], ['.btn:hover'], ['.x'], ['.btn-ghost:hover']],
	)
	assert.ok(PRIMITIVE_CSS_FILES.includes('app/src/renderer/remote/remote.css'), 'Remote CSS is checked')
	assert.ok(PRIMITIVE_CSS_FILES.includes('app/src/renderer/button.css'), 'the button owner is checked')
	assert.equal(
		forcedAlternative('.btn-primary:hover:not(:disabled)'),
		'.btn-primary[data-force-state="hover"]:not(:disabled)',
	)
	assert.equal(forcedAlternative('.input:focus'), '.input[data-force-state="focus-visible"]')
	assert.equal(forcedAlternative('.a:has(.btn:hover)'), '.a:has(.btn[data-force-state="hover"])')
})

test('a state inside :not() needs no twin, and a forced twin inside :not() is caught', () => {
	assert.equal(hasStatePseudo('.btn-quiet:not(:hover)'), false)
	assert.equal(hasStatePseudo('.a:is(.b, :not(.c:focus))'), false)
	assert.equal(hasStatePseudo('.a:is(:hover)'), true)
	assert.equal(forcedAlternative('.btn:hover:not(:focus)'), '.btn[data-force-state="hover"]:not(:focus)')
	assert.equal(forcedInsideNot('.btn-quiet:not([data-force-state="hover"])'), true)
	assert.equal(forcedInsideNot('.segment[data-force-state="hover"]:not(.segment-active)'), false)
	assert.equal(hasStatePseudo('.a[title=":hover"]'), false)
})

const ALL_RULES = PRIMITIVE_CSS_FILES.map(file => ({ file, rules: styleRules(readRepo(file)) }))

for (const { file, rules } of ALL_RULES) {
	test(`${file}: every primitive state selector has a [data-force-state] alternative in the same rule`, () => {
		const missing: string[] = []
		for (const rule of rules) {
			for (const selector of rule.selectors) {
				if (!hasStatePseudo(selector) || primitiveClassesIn(selector).length === 0) continue
				const wanted = forcedAlternative(selector)
				if (!rule.selectors.includes(wanted)) missing.push(`${selector}  →  add ${wanted}`)
			}
		}
		assert.deepEqual(missing, [])
	})

	test(`${file}: no forced selector without its real twin, none inside :not()`, () => {
		const stray: string[] = []
		for (const rule of rules) {
			for (const selector of rule.selectors) {
				if (!selector.includes('data-force-state')) continue
				if (forcedInsideNot(selector)) {
					stray.push(`${selector}  (inside :not() it matches every production element)`)
					continue
				}
				const hasReal = rule.selectors.some(
					other =>
						!other.includes('data-force-state') && hasStatePseudo(other) && forcedAlternative(other) === selector,
				)
				const isGlobalRing =
					file === 'app/src/renderer/base.css' && selector === 'button[data-force-state="focus-visible"]'
				if (!hasReal && !isGlobalRing) stray.push(`${selector}  (no matching real-state selector in its rule)`)
			}
		}
		assert.deepEqual(stray, [])
	})
}

test('every listed primitive class has state selectors (the class list is not stale)', () => {
	const seen = new Set<string>()
	for (const { rules } of ALL_RULES)
		for (const rule of rules)
			for (const selector of rule.selectors)
				if (hasStatePseudo(selector)) for (const name of primitiveClassesIn(selector)) seen.add(name)
	assert.deepEqual(
		PRIMITIVE_CLASSES.filter(name => !seen.has(name)),
		[],
	)
})

test('base.css: the global button focus ring answers forced focus-visible', () => {
	const ring = styleRules(read('base.css')).find(rule => rule.selectors.includes('button:focus-visible'))
	assert.ok(ring, 'global button:focus-visible rule not found')
	assert.ok(ring.selectors.includes('button[data-force-state="focus-visible"]'))
})

test('StateGrid forced states match the states the CSS answers', () => {
	const source = read('storybook/StateGrid.tsx')
	const forced = source.match(/export const FORCED_STATES = \[([^\]]*)\]/)?.[1]
	assert.ok(forced, 'FORCED_STATES not found in StateGrid.tsx')
	const states = [...forced.matchAll(/'([^']+)'/g)].map(match => match[1])
	assert.deepEqual(states, ['hover', 'active', 'focus-visible'])
	// Every forced name the CSS uses is one StateGrid can set.
	for (const file of PRIMITIVE_CSS_FILES) {
		for (const match of readRepo(file).matchAll(/data-force-state="([^"]+)"/g)) {
			assert.ok(states.includes(match[1] as string), `${file}: unknown forced state "${match[1]}"`)
		}
	}
})

/** The source of `export const States`, up to the next top-level statement. */
function statesStory(source: string): string | null {
	const start = source.search(/^export const States\b/m)
	if (start < 0) return null
	const rest = source.slice(start + 1)
	const next = rest.search(/^(?:export |const |function |\/\*\*|\/\/)/m)
	return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next)
}

for (const story of PRIMITIVE_STORIES) {
	test(`${story} exports a States story built on StateGrid`, () => {
		const body = statesStory(read(story))
		assert.ok(body, `${story}: no \`export const States\``)
		assert.ok(/<StateGrid\b/.test(body), `${story}: States does not render <StateGrid>`)
	})
}
