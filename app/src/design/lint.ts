// Token-only design lint (docs/design-system.md §2, §10; plan stage S3 in docs/plans/design-system/spec.md).
//
// A pure scanner, no dependency beyond the TypeScript parser the repository already builds with. It reads
// every production stylesheet, the CSS embedded in TypeScript (`*_STYLES` constants such as the extension
// widget), `<style>` blocks and `style=""` attributes in HTML, and inline style objects/strings in
// production TS/TSX, and reports every value the spec says must come from a token or a scale:
// literal colours, z-index, durations, easings, off-scale radii/spacing/font sizes, unscaled sidebar type,
// uppercase, letter-spacing, weights outside 400/500/600 and inline SVG outside the icon module.
//
// A finding is keyed by {file, selector, property, value, rule}; line numbers are only for display because
// they move. `app/src/design/lint-allowlist.ts` is the ratchet baseline, `tests/design-lint.test.ts` holds it,
// and `node --import tsx app/scripts/design-lint.ts --write-baseline` regenerates it.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { THEME_PRESETS } from '../theme-presets'

export const RULES = [
	'raw-color',
	'token-definition',
	'raw-z-index',
	'raw-duration',
	'raw-easing',
	'radius-off-scale',
	'spacing-off-scale',
	'font-size-off-scale',
	'font-size-unscaled',
	'uppercase',
	'letter-spacing',
	'font-weight',
	'inline-svg',
] as const
export type Rule = (typeof RULES)[number]

export interface Finding {
	/** Repository-relative path with forward slashes. */
	file: string
	/** Normalized selector, prefixed by its enclosing at-rules (`@media (x) .a`); for TS, where the style sits. */
	selector: string
	property: string
	/** Normalized value (whitespace collapsed; very long values shortened with a stable hash). */
	value: string
	rule: Rule
	/** 1-based line, for display only: never part of the key. */
	line: number
}

export type FindingKey = Pick<Finding, 'file' | 'selector' | 'property' | 'value' | 'rule'>

export const findingKey = (f: FindingKey): string => [f.rule, f.file, f.selector, f.property, f.value].join('\u0000')

// ---------------------------------------------------------------------------------------------------------
// What is scanned (explicit, so a new file is picked up automatically and every exclusion has a reason).

/** Directories walked for production sources. */
export const SCAN_ROOTS = ['app/src/renderer', 'extension/src'] as const

/**
 * Directories never scanned. Unshipped prototypes and design proposals are excluded by the plan's
 * Non-goals ("excluded from lint and coverage by an explicit allowlist rule"); `storybook/` holds the
 * Storybook-only StateGrid harness, never mounted in production.
 */
export const EXCLUDED_DIRS = [
	'app/src/renderer/open-prototype/',
	'app/src/renderer/proposals/',
	'app/src/renderer/storybook/',
] as const

/**
 * Files never scanned: Storybook stories and fixtures (display data for the workbench, not production UI),
 * declaration files (no runtime), generated bundles (vendored React runtime for the document canvas), and
 * the extension's widget workbench (the Storybook harness that mounts the production widget).
 */
export const EXCLUDED_FILES: readonly RegExp[] = [
	/\.stories\.tsx?$/,
	/(^|\/)[^/]*fixture[^/]*$/i,
	/\.d\.ts$/,
	/\.generated\.ts$/,
	/^extension\/src\/widget-workbench\.tsx$/,
]

/**
 * Production bundle entries inside the scan roots (app/build.mjs, app/scripts/build-remote.mjs,
 * app/scripts/build-document-canvas.mjs, extension/build.mjs; tests/design-lint.test.ts checks the list against those scripts). A TS/TSX file is
 * production when an entry reaches it through relative imports; a story-only host that names neither
 * `stories` nor `fixture` (Views / Signals' `SignalsWorkspace.tsx`) is therefore not scanned.
 */
export const PRODUCTION_ENTRIES = [
	'app/src/renderer/renderer.ts',
	'app/src/renderer/run-context-editor.tsx',
	'app/src/renderer/document-review.tsx',
	'app/src/renderer/viewer/data-worker.ts',
	'app/src/renderer/viewer/image-worker.ts',
	'app/src/renderer/viewer/csv-worker.ts',
	'app/src/renderer/remote/entry.tsx',
	'app/src/renderer/document-review/canvas-worker.ts',
	'extension/src/content.tsx',
	'extension/src/popup.ts',
] as const

/** The icon module: the only production place a literal `<svg>` may live (§3.18, §9 ruling 54). */
export const ICON_MODULE_DIRS = ['app/src/renderer/icons/'] as const

/** A TS/JS string constant whose name matches this is CSS (the extension widget's `WIDGET_STYLES`). */
export const CSS_CONSTANT_NAME = /(^|_)(STYLES?|CSS)$/

/**
 * Stylesheets whose `font-size` must be written `calc(<px> * var(--ui-scale))` (§2.2, §9 ruling 13;
 * AGENTS.md "new sidebar font-size rules MUST be calc(<spec px> * var(--ui-scale))"): the sidebar family.
 */
export const SCALED_TYPE_DIRS = ['app/src/renderer/sidebar/'] as const

/**
 * Blocks that ARE a token source: their custom-property definitions may hold literals (§2.8). The app's
 * `:root` mirrors `HELM_TOKENS` for the pre-JS first paint; the extension's `:host` holds the `--vg-` copy.
 */
export const TOKEN_SOURCES: readonly { file: string; selector: string }[] = [
	// Both paths while S7 splits styles.css (its `:root` moves to tokens.css); a missing file is skipped.
	{ file: 'app/src/renderer/styles.css', selector: ':root' },
	{ file: 'app/src/renderer/tokens.css', selector: ':root' },
	{ file: 'extension/src/widget.styles.ts', selector: ':host' },
]

/**
 * Documented scoped palettes (the ones `app/src/design/contrast-pairs.ts` measures). A custom property they
 * define that is not a core token is a scoped token and may hold a literal; a core token they redefine is
 * reported as `token-definition` (allowlisted under the decision that keeps the palette).
 */
export const SCOPED_TOKEN_BLOCKS: readonly { file: string; selector: string }[] = [
	// The dock/Signals dim text (§3.24); both paths while S7 moves them out of styles.css.
	{ file: 'app/src/renderer/styles.css', selector: '.agent-dock' },
	{ file: 'app/src/renderer/styles.css', selector: '.signals' },
	{ file: 'app/src/renderer/agent-dock/agent-dock.css', selector: '.agent-dock' },
	{ file: 'app/src/renderer/signals/signals.css', selector: '.signals' },
	{ file: 'app/src/renderer/remote/remote.css', selector: ':root.remote-page' },
	{ file: 'app/src/renderer/remote/remote.css', selector: '.remote-workspace, .remote-login, .remote-empty' },
	{
		file: 'app/src/renderer/document-review/document-review.css',
		selector: '.document-review[data-review-theme="light"]',
	},
	{ file: 'app/src/renderer/viewer/viewer.css', selector: '.viewer-window' },
	{ file: 'app/src/renderer/viewer/viewer.css', selector: '.viewer-window[data-review-theme="light"]' },
]

// ---------------------------------------------------------------------------------------------------------
// Scales from docs/design-system.md.

/**
 * §2.3: 4px base scale; 0 is no space and 1px a hairline compensation (a line, not a space). Checked on
 * margin, padding, scroll-margin/-padding, gap and inset; px only (em/% are relative to content), and
 * physical top/right/bottom/left are positions, not spaces.
 */
export const SPACING_PX = new Set([0, 1, 4, 8, 12, 16, 20, 24, 32])
/** §2.3: "2px only as inner padding of segmented tracks"; padding on these selectors may be 2px. */
export const SEGMENTED_SELECTOR = /segmented|-seg\b|__seg\b/
/** §2.4: 4 / 6 / 8 and full (999); 50% is the circle form of full. */
export const RADIUS_PX = new Set([0, 4, 6, 8, 999])
export const RADIUS_PERCENT = new Set([0, 50])
/** §2.2: the type ladder (17 hero, 13 body/emphasis, 12 secondary/section/label/button, 11 meta/chip/mono). */
export const FONT_SIZE_PX = new Set([11, 12, 13, 17])
/** §2.2 "Never bold below 600 or above 700" read with the plan's rule: weights 400/500/600 only. */
export const FONT_WEIGHTS = new Set([400, 500, 600])
/**
 * §2.2: "Base letter-spacing is -0.01em everywhere". Restating the base is not an override: buttons and
 * fields do not inherit it from the body, so their rules declare it again.
 */
export const BASE_LETTER_SPACING = '-0.01em'
/**
 * Type sizes a surface's own section of the spec sets beside the §2.2 ladder. Document Review's reading
 * scope: "15px/1.7 body, 28px/1.25 h1, 21px/1.35 h2" (docs/design-system.md, Native document review workspace).
 */
export const SURFACE_FONT_SIZE_PX: readonly { dir: string; px: readonly number[] }[] = [
	{ dir: 'app/src/renderer/document-review/', px: [15, 21, 28] },
]

const TIMING_KEYWORDS = new Set(['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end'])
const TIMING_FUNCTIONS = new Set(['cubic-bezier', 'steps', 'linear'])
const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'])
const MOTION_PROPERTIES = new Set([
	'transition',
	'transition-duration',
	'transition-delay',
	'transition-timing-function',
	'animation',
	'animation-duration',
	'animation-delay',
	'animation-timing-function',
])
/** Properties whose idents are names, never colours (keyframes, grid areas, fonts…). */
const NON_COLOR_PROPERTIES = new Set([
	'animation',
	'animation-name',
	'grid-area',
	'grid-template-areas',
	'grid-row',
	'grid-column',
	'font-family',
	'font',
	'content',
	'counter-reset',
	'counter-increment',
	'will-change',
	'transition',
	'transition-property',
	'view-transition-name',
	'container-name',
	'container',
	'anchor-name',
	'position-anchor',
	'list-style-type',
	'quotes',
])
/** CSS named colours (CSS Color 4). transparent/currentColor are not literal colours; system colours are forced-colors keywords. */
const NAMED_COLORS = new Set(
	(
		'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
		'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
		'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
		'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
		'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
		'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
		'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
		'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
		'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
		'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
		'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
		'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
		'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
		'whitesmoke yellow yellowgreen'
	).split(' '),
)

// ---------------------------------------------------------------------------------------------------------
// CSS tokenizer and block parser.

type CssToken =
	| { t: 'ws' | 'comment' | 'string' | 'url' | 'text'; v: string; line: number }
	| { t: '{' | '}' | ';' | '(' | ')'; v: string; line: number }

export function tokenizeCss(text: string, firstLine = 1): CssToken[] {
	const out: CssToken[] = []
	let i = 0
	let line = firstLine
	const push = (t: CssToken['t'], v: string, at: number) => out.push({ t, v, line: at } as CssToken)
	const countLines = (s: string) => {
		for (const c of s) if (c === '\n') line++
	}
	while (i < text.length) {
		const c = text[i] as string
		const start = i
		const startLine = line
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2)
			i = end === -1 ? text.length : end + 2
			const v = text.slice(start, i)
			countLines(v)
			push('comment', v, startLine)
		} else if (c === '"' || c === "'") {
			i++
			while (i < text.length && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
			i = Math.min(i + 1, text.length)
			const v = text.slice(start, i)
			countLines(v)
			push('string', v, startLine)
		} else if (/\s/.test(c)) {
			while (i < text.length && /\s/.test(text[i] as string)) i++
			const v = text.slice(start, i)
			countLines(v)
			push('ws', v, startLine)
		} else if (c === '{' || c === '}' || c === ';' || c === ')') {
			i++
			push(c, c, startLine)
		} else if (c === '(') {
			// `url(` with an unquoted argument is one token (it may hold braces, semicolons or quotes).
			const prev = out[out.length - 1]
			if (prev?.t === 'text' && /(^|[^\w-])url$/i.test(prev.v)) {
				let j = i + 1
				while (j < text.length && /\s/.test(text[j] as string)) j++
				if (text[j] !== '"' && text[j] !== "'") {
					const end = text.indexOf(')', j)
					i = end === -1 ? text.length : end + 1
					const v = text.slice(start, i)
					countLines(v)
					push('url', v, startLine)
					continue
				}
			}
			i++
			push('(', c, startLine)
		} else {
			while (i < text.length && !/[\s{};()"'/]/.test(text[i] as string)) i++
			if (i === start) i++ // a lone '/' that does not open a comment
			push('text', text.slice(start, i), startLine)
		}
	}
	return out
}

export interface Declaration {
	selector: string
	property: string
	value: string
	line: number
	/** The enclosing at-rule preludes, outermost first (normalized). */
	atRules: string[]
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
export const normalizeSelector = (s: string) =>
	collapse(s)
		.replace(/\s*,\s*/g, ', ')
		.replace(/\(\s+/g, '(')
		.replace(/\s+\)/g, ')')

const DECLARATION_AT_RULES = new Set([
	'font-face',
	'page',
	'property',
	'counter-style',
	'font-feature-values',
	'font-palette-values',
	'view-transition',
])

/** Parses a stylesheet (or a `style=""` declaration list with `inline`) into declarations. */
export function parseCss(text: string, opts: { inline?: string; firstLine?: number } = {}): Declaration[] {
	const tokens = tokenizeCss(text, opts.firstLine).filter(t => t.t !== 'comment')
	const out: Declaration[] = []
	let i = 0

	const joinSelector = (parent: string | null, own: string): string => {
		if (parent === null) return own
		const parents = splitTopLevel(parent)
		return splitTopLevel(own)
			.flatMap(o => parents.map(p => (o.includes('&') ? o.replaceAll('&', p) : `${p} ${o}`)))
			.join(', ')
	}

	// Parses block contents until the matching '}' (or EOF). `selector` is the enclosing style rule, if any.
	const parseBlock = (selector: string | null, atRules: string[], keyframes: boolean): void => {
		let prelude: CssToken[] = []
		let depth = 0
		while (i < tokens.length) {
			const tok = tokens[i] as CssToken
			if (tok.t === '(') depth++
			if (tok.t === ')') depth = Math.max(0, depth - 1)
			if (depth === 0 && (tok.t === ';' || tok.t === '}')) {
				i++
				emitDeclaration(prelude, selector, atRules)
				prelude = []
				if (tok.t === '}') return
				continue
			}
			if (depth === 0 && tok.t === '{') {
				i++
				openBlock(prelude, selector, atRules, keyframes)
				prelude = []
				continue
			}
			prelude.push(tok)
			i++
		}
		emitDeclaration(prelude, selector, atRules)
	}

	const openBlock = (prelude: CssToken[], selector: string | null, atRules: string[], inKeyframes: boolean) => {
		const head = normalizeSelector(prelude.map(t => t.v).join(''))
		if (head.startsWith('@')) {
			const name = (/^@([\w-]+)/.exec(head)?.[1] ?? '').toLowerCase()
			if (name === 'keyframes' || name.endsWith('-keyframes')) {
				parseBlock(null, [...atRules, head], true)
			} else if (DECLARATION_AT_RULES.has(name)) {
				parseBlock(head, atRules, false)
			} else {
				parseBlock(selector, [...atRules, head], false)
			}
			return
		}
		parseBlock(inKeyframes ? head : joinSelector(selector, head), atRules, false)
	}

	const emitDeclaration = (prelude: CssToken[], selector: string | null, atRules: string[]) => {
		const colon = prelude.findIndex(t => t.t === 'text' && t.v.includes(':'))
		if (colon === -1) return
		const first = prelude.find(t => t.t !== 'ws')
		if (!first || (first.t === 'text' && first.v.startsWith('@'))) return
		const raw = prelude.map(t => t.v).join('')
		const at = raw.indexOf(':')
		const property = raw.slice(0, at).trim()
		if (!/^-{0,2}[a-zA-Z][\w-]*$/.test(property)) return
		const value = collapse(raw.slice(at + 1))
		const prefix = atRules.length ? `${atRules.join(' ')} ` : ''
		out.push({
			selector: prefix + (selector ?? opts.inline ?? ''),
			property: property.startsWith('--') ? property : property.toLowerCase(),
			value,
			line: first.line,
			atRules,
		})
	}

	if (opts.inline !== undefined) parseBlock(opts.inline, [], false)
	else
		while (i < tokens.length) {
			parseBlock(null, [], false)
			if (i < tokens.length) i++ // a stray top-level '}'
		}
	return out
}

/** Splits on commas outside parentheses/brackets/strings. */
export function splitTopLevel(s: string): string[] {
	const parts: string[] = []
	let depth = 0
	let quote = ''
	let start = 0
	for (let i = 0; i < s.length; i++) {
		const c = s[i]
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = ''
		} else if (c === '"' || c === "'") quote = c
		else if (c === '(' || c === '[') depth++
		else if (c === ')' || c === ']') depth--
		else if (c === ',' && depth === 0) {
			parts.push(s.slice(start, i).trim())
			start = i + 1
		}
	}
	parts.push(s.slice(start).trim())
	return parts
}

// ---------------------------------------------------------------------------------------------------------
// Value parser.

export type ValueNode =
	| { t: 'word'; v: string }
	| { t: 'string'; v: string }
	| { t: 'url'; v: string }
	| { t: 'func'; name: string; args: ValueNode[] }
	| { t: ',' }
	| { t: '/' }

export function parseValue(text: string): ValueNode[] {
	let i = 0
	const parseList = (): ValueNode[] => {
		const nodes: ValueNode[] = []
		while (i < text.length) {
			const c = text[i] as string
			if (c === ')') {
				i++
				return nodes
			}
			if (/\s/.test(c)) i++
			else if (c === ',') {
				nodes.push({ t: ',' })
				i++
			} else if (c === '/' && text[i + 1] !== '*') {
				nodes.push({ t: '/' })
				i++
			} else if (c === '"' || c === "'") {
				const start = i++
				while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1
				i++
				nodes.push({ t: 'string', v: text.slice(start + 1, i - 1) })
			} else if (c === '/' && text[i + 1] === '*') {
				const end = text.indexOf('*/', i + 2)
				i = end === -1 ? text.length : end + 2
			} else {
				const start = i
				while (i < text.length && !/[\s,/()"']/.test(text[i] as string)) i++
				if (i === start) {
					i++
					// A bare parenthesized group inside calc(): `calc((100% - 800px) / 2)`.
					if (c === '(') nodes.push({ t: 'func', name: '', args: parseList() })
					continue
				}
				const word = text.slice(start, i)
				if (text[i] === '(') {
					i++
					const name = word.toLowerCase()
					if (name === 'url') {
						let j = i
						while (/\s/.test(text[j] ?? '')) j++
						if (text[j] !== '"' && text[j] !== "'") {
							const end = text.indexOf(')', j)
							const stop = end === -1 ? text.length : end
							nodes.push({ t: 'url', v: text.slice(j, stop).trim() })
							i = stop + 1
							continue
						}
						const args = parseList()
						const str = args.find(a => a.t === 'string')
						nodes.push({ t: 'url', v: str && str.t === 'string' ? str.v : '' })
						continue
					}
					nodes.push({ t: 'func', name, args: parseList() })
				} else nodes.push({ t: 'word', v: word })
			}
		}
		return nodes
	}
	return parseList()
}

interface VisitContext {
	/** Inside a `var()` fallback. */
	inFallback: boolean
	/** Enclosing function nodes, innermost last. */
	funcs: Extract<ValueNode, { t: 'func' }>[]
}

/** Visits every node; `var()` fallbacks are visited with `inFallback`, `env()` arguments are skipped. */
function visit(
	nodes: ValueNode[],
	fn: (node: ValueNode, ctx: VisitContext) => boolean | undefined,
	ctx?: VisitContext,
) {
	const here = ctx ?? { inFallback: false, funcs: [] }
	for (const node of nodes) {
		if (fn(node, here) === false) continue
		if (node.t !== 'func') continue
		if (node.name === 'env' || node.name === 'attr') continue
		const inner = { inFallback: here.inFallback, funcs: [...here.funcs, node] }
		if (node.name === 'var') {
			const comma = node.args.findIndex(a => a.t === ',')
			if (comma !== -1) visit(node.args.slice(comma + 1), fn, { ...inner, inFallback: true })
			continue
		}
		visit(node.args, fn, inner)
	}
}

const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i
export function parseNumber(word: string): { n: number; unit: string } | null {
	const m = NUMBER.exec(word)
	return m ? { n: Number(m[1]), unit: (m[2] ?? '').toLowerCase() } : null
}

const usesVar = (nodes: ValueNode[], name: string): boolean => {
	let found = false
	visit(nodes, node => {
		if (node.t === 'func' && node.name === 'var' && node.args[0]?.t === 'word' && node.args[0].v === name) found = true
		return undefined
	})
	return found
}

// ---------------------------------------------------------------------------------------------------------
// Rules over one declaration.

export interface DeclarationContext {
	file: string
	selector: string
	/** The file's `font-size` must be scaled by `--ui-scale` (§2.2). */
	scaledType: boolean
	/** Names of the core tokens (defined by a token source). */
	coreTokens: ReadonlySet<string>
	/** This declaration sits in a token source block. */
	tokenSource: boolean
	/** This declaration sits in a documented scoped palette. */
	scopedPalette: boolean
	/** Inside `@media (prefers-reduced-motion: reduce)` (the mandatory §2.5 clamp). */
	reducedMotion: boolean
}

export function lintDeclaration(property: string, value: string, ctx: DeclarationContext): Rule[] {
	const rules = new Set<Rule>()
	const nodes = parseValue(value)
	const prop = property.toLowerCase()

	// Colours and token definitions.
	if (property.startsWith('--')) {
		if (ctx.tokenSource) {
			// The token source itself.
		} else if (ctx.coreTokens.has(property)) rules.add('token-definition')
		else if (!ctx.scopedPalette && hasRawColor(nodes, property)) rules.add('raw-color')
	} else if (!prop.startsWith('mask') && !prop.startsWith('-webkit-mask') && hasRawColor(nodes, prop)) {
		// Mask images use only the alpha channel: their colour stops are not paint.
		rules.add('raw-color')
	}
	if (hasSvgDataUri(nodes)) rules.add('inline-svg')
	if (property.startsWith('--')) return [...rules]

	const literals = (check: (word: string, ctx: VisitContext) => boolean): boolean => {
		let hit = false
		visit(nodes, (node, vctx) => {
			if (!vctx.inFallback && node.t === 'word' && check(node.v, vctx)) hit = true
			return undefined
		})
		return hit
	}

	if (prop === 'z-index' && literals(w => parseNumber(w)?.unit === '')) rules.add('raw-z-index')

	if (MOTION_PROPERTIES.has(prop)) {
		const duration = literals(w => {
			const n = parseNumber(w)
			if (!n || (n.unit !== 's' && n.unit !== 'ms')) return false
			if (n.n === 0) return false
			if (ctx.reducedMotion && n.unit === 'ms' && n.n <= 0.01) return false
			return true
		})
		if (duration) rules.add('raw-duration')
		let easing = literals(w => TIMING_KEYWORDS.has(w.toLowerCase()))
		visit(nodes, (node, vctx) => {
			if (!vctx.inFallback && node.t === 'func' && TIMING_FUNCTIONS.has(node.name)) easing = true
			return undefined
		})
		if (easing) rules.add('raw-easing')
	}

	if (/^border(-[a-z]+)*-radius$/.test(prop)) {
		const off = literals(w => {
			const n = parseNumber(w)
			if (!n) return false
			if (n.unit === '') return n.n !== 0
			if (n.unit === 'px') return !RADIUS_PX.has(Math.abs(n.n))
			if (n.unit === '%') return !RADIUS_PERCENT.has(n.n)
			return true
		})
		if (off) rules.add('radius-off-scale')
	}

	if (
		/^(margin|padding|scroll-margin|scroll-padding|inset)(-[a-z-]+)?$/.test(prop) ||
		/^(grid-)?(row-|column-)?gap$/.test(prop)
	) {
		const twoAllowed = prop.startsWith('padding') && SEGMENTED_SELECTOR.test(ctx.selector)
		const off = literals((w, vctx) => {
			const n = parseNumber(w)
			if (!n || n.unit !== 'px') return false
			// `calc((100% - 800px) / 2)`: a px term beside a relative length is a width (a measure), not a space.
			if (vctx.funcs.some(f => f.args.some(a => a.t === 'word' && /^[\d.]+(%|vw|vh|dvh|svh|lvh|vi|vb)$/.test(a.v))))
				return false
			const px = Math.abs(n.n)
			return !SPACING_PX.has(px) && !(twoAllowed && px === 2)
		})
		if (off) rules.add('spacing-off-scale')
	}

	if (prop === 'font-size' || prop === 'font') {
		const surfaceSizes = SURFACE_FONT_SIZE_PX.filter(s => ctx.file.startsWith(s.dir)).flatMap(s => s.px)
		const sizeNodes = prop === 'font' ? fontShorthandSize(nodes) : nodes
		const sizeWords: { word: string; ctx: VisitContext }[] = []
		visit(sizeNodes, (node, vctx) => {
			if (!vctx.inFallback && node.t === 'word') sizeWords.push({ word: node.v, ctx: vctx })
			return undefined
		})
		let off = false
		let unscaled = false
		for (const { word, ctx: vctx } of sizeWords) {
			const n = parseNumber(word)
			if (!n) {
				if (
					prop === 'font-size' &&
					/^[a-z-]+$/i.test(word) &&
					!['inherit', 'initial', 'unset', 'revert'].includes(word)
				)
					off = true
				continue
			}
			if (n.n === 0) continue
			if (n.unit === 'px') {
				if (!FONT_SIZE_PX.has(n.n) && !surfaceSizes.includes(n.n)) off = true
				const scaled = vctx.funcs.some(f => f.name === 'calc' && usesVar(f.args, '--ui-scale'))
				if (!scaled) unscaled = true
			} else if (n.unit === '' && vctx.funcs.length) {
				// a multiplier inside calc()
			} else if (!((n.unit === '%' && n.n === 100) || (n.unit === 'em' && n.n === 1))) off = true
		}
		if (off) rules.add('font-size-off-scale')
		if (unscaled && ctx.scaledType) rules.add('font-size-unscaled')
	}

	if (prop === 'text-transform' && literals(w => w.toLowerCase() === 'uppercase')) rules.add('uppercase')

	if (prop === 'letter-spacing') {
		const off = literals(
			w => !['normal', 'inherit', 'initial', 'unset', 'revert', '0', BASE_LETTER_SPACING].includes(w.toLowerCase()),
		)
		if (off) rules.add('letter-spacing')
	}

	if (prop === 'font-weight' || prop === 'font') {
		const weightNodes = prop === 'font' ? fontShorthandWeight(nodes) : nodes
		const off = weightNodes.some(node => {
			if (node.t !== 'word') return false
			const lower = node.v.toLowerCase()
			if (lower === 'bold' || lower === 'bolder' || lower === 'lighter') return true
			const n = parseNumber(lower)
			return n !== null && n.unit === '' && !FONT_WEIGHTS.has(n.n)
		})
		if (off) rules.add('font-weight')
	}

	return [...rules]
}

/** `font` shorthand: the size is the first length before an optional `/line-height`. */
function fontShorthandSize(nodes: ValueNode[]): ValueNode[] {
	for (const node of nodes) {
		if (node.t === 'func' && node.name === 'calc') return [node]
		if (node.t !== 'word') continue
		const n = parseNumber(node.v)
		if (n && n.unit !== '') return [node]
	}
	return []
}

/** `font` shorthand: a weight is a bare number 1–1000 or a weight keyword before the size. */
function fontShorthandWeight(nodes: ValueNode[]): ValueNode[] {
	const out: ValueNode[] = []
	for (const node of nodes) {
		if (node.t !== 'word') break
		const n = parseNumber(node.v)
		if (n && n.unit !== '') break
		out.push(node)
	}
	return out
}

function hasRawColor(nodes: ValueNode[], property: string): boolean {
	let hit = false
	const namesAllowed = !NON_COLOR_PROPERTIES.has(property)
	visit(nodes, node => {
		if (node.t === 'func' && COLOR_FUNCTIONS.has(node.name)) {
			hit = true
			return false
		}
		if (node.t === 'word') {
			if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(node.v)) hit = true
			else if (namesAllowed && NAMED_COLORS.has(node.v.toLowerCase())) hit = true
		}
		return undefined
	})
	return hit
}

function hasSvgDataUri(nodes: ValueNode[]): boolean {
	let hit = false
	visit(nodes, node => {
		if (node.t === 'url' && /^data:image\/svg\+xml/i.test(node.v)) hit = true
		return undefined
	})
	return hit
}

// ---------------------------------------------------------------------------------------------------------
// Per-language scanners.

export interface LintOptions {
	/** Core token names (custom properties a token source defines). */
	coreTokens?: ReadonlySet<string>
}

const MAX_VALUE = 120
/** Shortens a very long value (an SVG data URI) to a stable key: a prefix plus an FNV-1a hash of the whole. */
export function keyValue(value: string): string {
	const v = collapse(value)
	if (v.length <= MAX_VALUE) return v
	let h = 0x811c9dc5
	for (let i = 0; i < v.length; i++) {
		h ^= v.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	return `${v.slice(0, 80)}… #${(h >>> 0).toString(16).padStart(8, '0')}`
}

const inDirs = (file: string, dirs: readonly string[]) => dirs.some(d => file.startsWith(d))
const blockMatch = (list: readonly { file: string; selector: string }[], file: string, selector: string) =>
	list.some(b => b.file === file && b.selector === selector)

export function lintDeclarations(file: string, declarations: Declaration[], opts: LintOptions = {}): Finding[] {
	const coreTokens = opts.coreTokens ?? new Set<string>()
	const scaledType = inDirs(file, SCALED_TYPE_DIRS)
	const out: Finding[] = []
	for (const d of declarations) {
		const ctx: DeclarationContext = {
			file,
			selector: d.selector,
			scaledType,
			coreTokens,
			tokenSource: blockMatch(TOKEN_SOURCES, file, d.selector),
			scopedPalette: blockMatch(SCOPED_TOKEN_BLOCKS, file, d.selector),
			reducedMotion: d.atRules.some(a => /prefers-reduced-motion\s*:\s*reduce/.test(a)),
		}
		for (const rule of lintDeclaration(d.property, d.value, ctx))
			out.push({ file, selector: d.selector, property: d.property, value: keyValue(d.value), rule, line: d.line })
	}
	return out
}

export function lintCss(file: string, text: string, opts: LintOptions = {}, firstLine = 1): Finding[] {
	return lintDeclarations(file, parseCss(text, { firstLine }), opts)
}

export function lintHtml(file: string, text: string, opts: LintOptions = {}): Finding[] {
	const out: Finding[] = []
	const lineAt = (index: number) => text.slice(0, index).split('\n').length
	for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
		const start = (m.index ?? 0) + m[0].indexOf('>') + 1
		out.push(...lintCss(file, m[1] ?? '', opts, lineAt(start)))
	}
	for (const m of text.matchAll(/<([a-z][\w-]*)\b[^>]*?\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
		const css = m[3] ?? m[4] ?? ''
		const decls = parseCss(css, { inline: `<${(m[1] ?? '').toLowerCase()} style>`, firstLine: lineAt(m.index ?? 0) })
		out.push(...lintDeclarations(file, decls, opts))
	}
	if (/<svg\b/i.test(text.replace(/<style\b[\s\S]*?<\/style>/gi, '')) && !inDirs(file, ICON_MODULE_DIRS)) {
		for (const m of text.matchAll(/<svg\b[^>]*>/gi))
			out.push({
				file,
				selector: 'html',
				property: 'markup',
				value: svgValue(m[0]),
				rule: 'inline-svg',
				line: lineAt(m.index ?? 0),
			})
	}
	return out
}

const svgValue = (tag: string) => {
	const viewBox = /viewBox\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
	return viewBox === undefined ? '<svg>' : `<svg viewBox="${collapse(viewBox)}">`
}

const kebab = (name: string) =>
	name.includes('-')
		? name
		: name
				.replace(/^(Webkit|Moz|Ms)(?=[A-Z])/, m => `-${m.toLowerCase()}`)
				.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)

/** React/Solid number values that mean pixels for the properties this lint checks. */
const PX_NUMBER_PROPERTY =
	/^(font-size|border(-[a-z]+)*-radius|(margin|padding|scroll-margin|scroll-padding|inset)(-[a-z-]+)?|(row-|column-)?gap)$/

export function lintTs(file: string, text: string, opts: LintOptions = {}): Finding[] {
	const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
	const out: Finding[] = []
	const iconModule = inDirs(file, ICON_MODULE_DIRS)
	const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

	const enclosing = (node: ts.Node): string => {
		for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
			if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.text
			if ((ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name)
				return p.name.getText(source)
			if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
		}
		return 'module'
	}

	const literal = (node: ts.Expression | undefined): string | null => {
		if (!node) return null
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
		if (ts.isNumericLiteral(node)) return node.text
		if (
			ts.isPrefixUnaryExpression(node) &&
			node.operator === ts.SyntaxKind.MinusToken &&
			ts.isNumericLiteral(node.operand)
		)
			return `-${node.operand.text}`
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
			return literal(node.expression)
		// `\`color-mix(in srgb, ${hex} 78%, white)\``: each substitution reads as an opaque token.
		if (ts.isTemplateExpression(node))
			return node.head.text + node.templateSpans.map(span => `var(--expr)${span.literal.text}`).join('')
		return null
	}

	/** The style values an expression may produce: `cond ? {…} : undefined`, `{…} as CSSProperties`, `a && {…}`. */
	const styleValues = (node: ts.Expression): ts.Expression[] => {
		if (
			ts.isParenthesizedExpression(node) ||
			ts.isAsExpression(node) ||
			ts.isSatisfiesExpression(node) ||
			ts.isNonNullExpression(node)
		)
			return styleValues(node.expression)
		if (ts.isConditionalExpression(node)) return [...styleValues(node.whenTrue), ...styleValues(node.whenFalse)]
		if (ts.isBinaryExpression(node)) {
			const op = node.operatorToken.kind
			if (op === ts.SyntaxKind.AmpersandAmpersandToken) return styleValues(node.right)
			if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
				return [...styleValues(node.left), ...styleValues(node.right)]
		}
		return [node]
	}

	const declare = (selector: string, rawProperty: string, valueNode: ts.Expression, at: ts.Node) => {
		const value = literal(valueNode)
		if (value === null) return
		const property = rawProperty.startsWith('--') ? rawProperty : kebab(rawProperty)
		const numeric = ts.isNumericLiteral(valueNode) || ts.isPrefixUnaryExpression(valueNode)
		const css = numeric && PX_NUMBER_PROPERTY.test(property) ? `${value}px` : value
		out.push(...lintDeclarations(file, [{ selector, property, value: css, line: lineOf(at), atRules: [] }], opts))
	}

	const declareObject = (selector: string, object: ts.ObjectLiteralExpression) => {
		for (const prop of object.properties) {
			if (!ts.isPropertyAssignment(prop)) continue
			const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
			if (name) declare(selector, name, prop.initializer, prop)
		}
	}

	const declareCssText = (selector: string, node: ts.Expression) => {
		const css = literal(node)
		if (css === null) return
		out.push(...lintDeclarations(file, parseCss(css, { inline: selector, firstLine: lineOf(node) }), opts))
	}

	const svg = (node: ts.Node, property: string, value: string) => {
		if (iconModule) return
		out.push({ file, selector: `in ${enclosing(node)}`, property, value, rule: 'inline-svg', line: lineOf(node) })
	}

	const walk = (node: ts.Node): void => {
		// CSS held in a string constant (`export const WIDGET_STYLES = \`…\``).
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			CSS_CONSTANT_NAME.test(node.name.text) &&
			node.initializer &&
			(ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isStringLiteral(node.initializer))
		) {
			const init = node.initializer
			out.push(...lintCss(file, init.text, opts, lineOf(init)))
			return
		}
		// JSX `style={{ … }}` and `<svg>`.
		if (ts.isJsxAttribute(node) && node.name.getText(source) === 'style' && node.initializer) {
			const owner = node.parent.parent
			const tag = ts.isJsxOpeningLikeElement(owner) ? owner.tagName.getText(source) : 'element'
			const selector = `<${tag} style> in ${enclosing(node)}`
			const init = node.initializer
			if (ts.isJsxExpression(init) && init.expression) {
				for (const value of styleValues(init.expression)) {
					if (ts.isObjectLiteralExpression(value)) declareObject(selector, value)
					else declareCssText(selector, value)
				}
			} else if (ts.isStringLiteral(init)) declareCssText(selector, init)
		}
		if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
			if (node.tagName.getText(source) === 'svg') {
				const viewBox = node.attributes.properties.find(
					a => ts.isJsxAttribute(a) && a.name.getText(source) === 'viewBox',
				) as ts.JsxAttribute | undefined
				const v = viewBox?.initializer && ts.isStringLiteral(viewBox.initializer) ? viewBox.initializer.text : undefined
				svg(node, 'jsx', v === undefined ? '<svg>' : `<svg viewBox="${collapse(v)}">`)
			}
		}
		// `el.style.prop = '…'`, `el.style.cssText = '…'`.
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isPropertyAccessExpression(node.left) &&
			ts.isPropertyAccessExpression(node.left.expression) &&
			node.left.expression.name.text === 'style'
		) {
			const selector = `${node.left.expression.getText(source)} in ${enclosing(node)}`
			const name = node.left.name.text
			if (name === 'cssText') declareCssText(selector, node.right)
			else declare(selector, name, node.right, node)
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const callee = node.expression
			const method = callee.name.text
			const [a0, a1] = node.arguments
			// `el.style.setProperty('prop', '…')`
			if (method === 'setProperty' && ts.isPropertyAccessExpression(callee.expression)) {
				const target = callee.expression
				const prop = literal(a0)
				if (target.name.text === 'style' && prop !== null && a1)
					declare(`${target.getText(source)} in ${enclosing(node)}`, prop, a1, node)
			}
			// `el.setAttribute('style', '…')`
			if (method === 'setAttribute' && literal(a0) === 'style' && a1)
				declareCssText(`${callee.expression.getText(source)}[style] in ${enclosing(node)}`, a1)
			// `Object.assign(el.style, { … })`
			if (
				method === 'assign' &&
				callee.expression.getText(source) === 'Object' &&
				a0 &&
				ts.isPropertyAccessExpression(a0) &&
				a0.name.text === 'style' &&
				a1 &&
				ts.isObjectLiteralExpression(a1)
			)
				declareObject(`${a0.getText(source)} in ${enclosing(node)}`, a1)
			// `document.createElementNS(ns, 'svg')`
			if (method === 'createElementNS' && literal(a1) === 'svg') svg(node, 'createElementNS', "'svg'")
		}
		// A string holding SVG markup (innerHTML, data URIs).
		if (
			(ts.isStringLiteral(node) ||
				ts.isNoSubstitutionTemplateLiteral(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node)) &&
			/<svg\b|%3csvg\b/i.test(node.text)
		) {
			const tag = /<svg\b[^>]*>?/i.exec(node.text)?.[0] ?? '<svg>'
			svg(node, 'string', svgValue(tag))
		}
		ts.forEachChild(node, walk)
	}
	walk(source)
	return out
}

// ---------------------------------------------------------------------------------------------------------
// Repository scan.

export type SourceKind = 'css' | 'html' | 'ts'

export function isExcluded(file: string): boolean {
	return inDirs(file, EXCLUDED_DIRS) || EXCLUDED_FILES.some(re => re.test(file))
}

/** Walks the scan roots and returns every production source, repository-relative and sorted. */
const IMPORT_SPECIFIER =
	/(?:^|[^\w.])(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g

/** Every TS/TSX file the production entries reach through relative imports (repository-relative). */
export function productionFiles(root: string): Set<string> {
	const seen = new Set<string>()
	const resolveImport = (from: string, specifier: string): string | null => {
		if (!specifier.startsWith('.')) return null
		const base = join(root, from, '..', specifier)
		const stem = base.replace(/\.(js|jsx|mjs)$/, '')
		for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
			if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile())
				return relative(root, candidate).split(sep).join('/')
		}
		return null
	}
	const queue: string[] = PRODUCTION_ENTRIES.filter(entry => existsSync(join(root, entry)))
	while (queue.length) {
		const file = queue.pop() as string
		if (seen.has(file)) continue
		seen.add(file)
		const text = readFileSync(join(root, file), 'utf8')
		for (const m of text.matchAll(IMPORT_SPECIFIER)) {
			const target = resolveImport(file, (m[1] ?? m[2] ?? m[3] ?? m[4]) as string)
			if (target && !seen.has(target)) queue.push(target)
		}
	}
	return seen
}

export function collectSources(root: string): { file: string; kind: SourceKind }[] {
	const out: { file: string; kind: SourceKind }[] = []
	const production = productionFiles(root)
	const walkDir = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
			const full = join(dir, name)
			const file = relative(root, full).split(sep).join('/')
			if (statSync(full).isDirectory()) {
				if (!inDirs(`${file}/`, EXCLUDED_DIRS)) walkDir(full)
				continue
			}
			if (isExcluded(file)) continue
			const kind: SourceKind | null = /\.css$/.test(name)
				? 'css'
				: /\.html$/.test(name)
					? 'html'
					: /\.(ts|tsx|mts|cts)$/.test(name)
						? 'ts'
						: null
			if (kind === 'ts' && !production.has(file)) continue
			if (kind) out.push({ file, kind })
		}
	}
	for (const dir of SCAN_ROOTS) walkDir(join(root, dir))
	return out
}

/** Core token names: every custom property a token source block defines, plus the bundled preset keys. */
export function coreTokensFrom(root: string, extra: Iterable<string> = []): Set<string> {
	const names = new Set(extra)
	for (const source of TOKEN_SOURCES) {
		if (!source.file.endsWith('.css') || !existsSync(join(root, source.file))) continue
		for (const d of parseCss(readFileSync(join(root, source.file), 'utf8')))
			if (d.selector === source.selector && d.property.startsWith('--')) names.add(d.property)
	}
	return names
}

export function lintSource(root: string, source: { file: string; kind: SourceKind }, opts: LintOptions): Finding[] {
	const text = readFileSync(join(root, source.file), 'utf8')
	if (source.kind === 'css') return lintCss(source.file, text, opts)
	if (source.kind === 'html') return lintHtml(source.file, text, opts)
	return lintTs(source.file, text, opts)
}

export function compareFindings(a: FindingKey, b: FindingKey): number {
	for (const k of ['rule', 'file', 'selector', 'property', 'value'] as const) {
		if (k === 'rule' && a.rule !== b.rule) return RULES.indexOf(a.rule) - RULES.indexOf(b.rule)
		if (a[k] < b[k]) return -1
		if (a[k] > b[k]) return 1
	}
	return 0
}

/** Every token name a bundled preset sets (`app/src/theme-presets.ts`): core even where no CSS source defines it. */
export const PRESET_TOKENS: readonly string[] = [
	...new Set(Object.values(THEME_PRESETS).flatMap(preset => Object.keys(preset.tokens))),
].sort()

/** Scans the whole repository. */
export function scanRepository(root: string): Finding[] {
	const coreTokens = coreTokensFrom(root, PRESET_TOKENS)
	return collectSources(root)
		.flatMap(source => lintSource(root, source, { coreTokens }))
		.sort((a, b) => compareFindings(a, b) || a.line - b.line)
}

// ---------------------------------------------------------------------------------------------------------
// The baseline (app/src/design/lint-allowlist.ts): a ratchet, one line per allowlisted finding.
//
// Format, under `## <rule>` and `### <file>` headers:  `<selector> | <property> | <value> | <reason>`.
// A finding that occurs twice (same key) has two lines.

export interface AllowlistEntry extends FindingKey {
	reason: string
}

const FIELD_SEPARATOR = ' | '

export function parseBaseline(text: string): AllowlistEntry[] {
	const out: AllowlistEntry[] = []
	let rule: Rule | null = null
	let file: string | null = null
	for (const [index, raw] of text.split('\n').entries()) {
		const line = raw.replace(/\r$/, '')
		if (line.trim() === '') continue
		const header = /^(#{2,3}) (.+)$/.exec(line)
		if (header) {
			const name = (header[2] as string).trim()
			if (header[1] === '##') {
				if (!(RULES as readonly string[]).includes(name))
					throw new Error(`baseline line ${index}: unknown rule ${name}`)
				rule = name as Rule
				file = null
			} else file = name
			continue
		}
		const parts = line.split(FIELD_SEPARATOR)
		if (!rule || !file || parts.length !== 4)
			throw new Error(`baseline line ${index}: expected "<selector> | <property> | <value> | <reason>": ${line}`)
		const [selector, property, value, reason] = parts as [string, string, string, string]
		out.push({ rule, file, selector, property, value, reason: reason.trim() })
	}
	return out
}

export function formatBaseline(entries: readonly AllowlistEntry[]): string {
	const lines: string[] = []
	let rule: Rule | null = null
	let file: string | null = null
	for (const e of [...entries].sort(compareFindings)) {
		for (const field of [e.selector, e.property, e.value, e.reason]) {
			if (field.includes(FIELD_SEPARATOR) || field.includes('\n') || field.includes('`') || field.includes('${'))
				throw new Error(`baseline field cannot hold " | ", a newline, a backtick or "\${": ${field}`)
		}
		if (e.rule !== rule) {
			if (lines.length) lines.push('')
			lines.push(`## ${e.rule}`)
			rule = e.rule
			file = null
		}
		if (e.file !== file) {
			lines.push(`### ${e.file}`)
			file = e.file
		}
		lines.push([e.selector, e.property, e.value, e.reason].join(FIELD_SEPARATOR))
	}
	return lines.join('\n')
}

/** Findings not in the baseline (new violations) and baseline entries with no finding left (stale). */
export function compareBaseline(
	findings: readonly Finding[],
	entries: readonly AllowlistEntry[],
): { unlisted: Finding[]; stale: AllowlistEntry[] } {
	const pool = new Map<string, AllowlistEntry[]>()
	for (const e of entries) {
		const key = findingKey(e)
		pool.set(key, [...(pool.get(key) ?? []), e])
	}
	const unlisted: Finding[] = []
	for (const f of findings) {
		const left = pool.get(findingKey(f))
		if (left?.length) left.shift()
		else unlisted.push(f)
	}
	return { unlisted, stale: [...pool.values()].flat() }
}

/** Regenerates the baseline: every finding listed, keeping the reason of entries that still match. */
export function nextBaseline(findings: readonly Finding[], entries: readonly AllowlistEntry[]): AllowlistEntry[] {
	const reasons = new Map<string, string[]>()
	for (const e of entries) reasons.set(findingKey(e), [...(reasons.get(findingKey(e)) ?? []), e.reason])
	return findings.map(f => {
		const kept = reasons.get(findingKey(f))?.shift()
		return {
			rule: f.rule,
			file: f.file,
			selector: f.selector,
			property: f.property,
			value: f.value,
			reason: kept ?? defaultReason(f),
		}
	})
}

const isPopup = (file: string) => file.startsWith('extension/src/popup.')
const isRemote = (file: string) => file.startsWith('app/src/renderer/remote/')
const isReview = (file: string) =>
	file.startsWith('app/src/renderer/document-review/') || file.startsWith('app/src/renderer/viewer/')

/** The reason a new baseline entry gets: the decision or ruling that keeps a value of its kind today. */
export function defaultReason(f: FindingKey): string {
	if (isPopup(f.file)) return 'D9 extension popup (moves onto Helm tokens)'
	switch (f.rule) {
		case 'raw-color':
			return isRemote(f.file) ? 'D7 Remote palette' : 'S2 gives the literal a token (§9 ruling 9)'
		case 'token-definition':
			if (f.property === '--ui-scale') return 'D7 surface reach (Review keeps its own text scale)'
			if (isReview(f.file)) return '§2.8 Review light scope (§9 ruling 10)'
			if (isRemote(f.file)) return 'D7 Remote palette'
			return 'S2 token pipeline (core tokens are defined in their source only)'
		case 'raw-z-index':
		case 'raw-duration':
		case 'raw-easing':
			return 'S2 adds z/motion tokens (pending D2)'
		case 'spacing-off-scale':
			if (/(^|[\s.,])\.?(chip|vg-chip|menu-trigger-badge)\b/.test(f.selector) && /\b2px 8px\b/.test(f.value))
				return '§9 ruling 26 chip padding 2×8'
			return 'D8 off-scale values'
		case 'font-size-off-scale':
			if (isRemote(f.file) && f.value === '16px' && /\binput\b/.test(f.selector))
				return '§9 ruling 58 Remote web 16px form text'
			return 'D8 off-scale values'
		case 'font-size-unscaled':
			return 'D13 unscaled sidebar type'
		case 'letter-spacing':
			return 'D8 off-scale values (letter-spacing overrides)'
		case 'font-weight':
			return 'D8 off-scale values (weights 650/700)'
		case 'inline-svg':
			return 'D6 hand-drawn icons (S7 moves them to the icon module)'
		default:
			return 'D8 off-scale values'
	}
}

/** The decisions, rulings and stages a reason names. */
export function reasonReferences(reason: string): { decisions: number[]; rulings: number[]; stages: number[] } {
	return {
		decisions: [...reason.matchAll(/\bD(\d+)\b/g)].map(m => Number(m[1])),
		rulings: [...reason.matchAll(/§9 ruling (\d+)/g)].map(m => Number(m[1])),
		stages: [...reason.matchAll(/\bS(\d+)\b/g)].map(m => Number(m[1])),
	}
}
