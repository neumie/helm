// Token-only design lint (docs/design-system.md §2, §10; plan stage S3 in docs/plans/design-system/spec.md).
//
// A pure scanner, no dependency beyond the TypeScript parser the repository already builds with. It reads
// every production stylesheet, the CSS embedded in TypeScript (`*_STYLES`/`css` constants such as the extension
// widget, substitutions included, and JSX `<style>`), `<style>` blocks and `style=""` attributes in HTML (also
// HTML held in a JS constant: `EMBEDDED_HTML`), inline style objects/strings and `Element.animate()` timing in
// every production TS/TSX module an entry reaches, and reports every value the spec says must come from a
// token or a scale: literal colours, z-index, durations, easings, off-scale radii/spacing/font sizes, unscaled
// sidebar type, uppercase, letter-spacing, weights outside 400/500/600 and inline SVG outside the icon module.
// Values are read through `!important`, through `var()` fallbacks behind a name that is not a core token and
// through custom properties the same stylesheet, style object or function defines. It also holds stage S7's ownership rule (a shared
// primitive's own base rules live only in the primitive's CSS file: `PRIMITIVES`, `primitiveOutsideOwner`) and
// §9 ruling 4 (no border on any button: `buttonBorders`).
//
// A finding is keyed by {file, selector, property, value, rule}; line numbers are only for display because
// they move. `packages/helm-ui/lint-allowlist.ts` is the ratchet baseline, `tests/design-lint.test.ts` holds it
// (with per-rule caps that only go down), and `node --import tsx packages/helm-ui/scripts/design-lint.ts --write-baseline`
// regenerates it (new entries only with `--allow-new`, marked `TODO:` until a person writes the reason).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { THEME_TOKEN_NAMES } from './tokens/index.ts'

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
	'primitive-outside-owner',
	'button-border',
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

/**
 * Directories walked for production sources (CSS, HTML, and TS/TSX that an entry reaches). A production
 * TS/TSX module outside them (app/src/agent-dock/, app/src/theme-presets.ts…) is scanned too.
 */
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

/**
 * A TS/JS string constant whose name matches this (any case: `WIDGET_STYLES`, `css`, `panel_styles`) is CSS, read
 * from a string, a template or a tagged template (`String.raw`). The scan throws rather than skip one it cannot
 * read: an upper-case one (`STRICT_CSS_CONSTANT_NAME`) whatever it holds, a lower-case one when it builds text
 * (concatenation, a conditional, `.join()`), since `const style = getComputedStyle(el)` is not a stylesheet.
 */
export const CSS_CONSTANT_NAME = /(^|_)(STYLES?|CSS)$/i
export const STRICT_CSS_CONSTANT_NAME = /(^|_)(STYLES?|CSS)$/

/**
 * HTML held in a JS/TS string constant of a production file outside the scan roots: the Remote PWA's offline
 * page (`app/assets/remote/remote-sw.js`, served by the service worker when the host is unreachable).
 */
export const EMBEDDED_HTML: readonly { file: string; constant: string }[] = [
	{ file: 'app/assets/remote/remote-sw.js', constant: 'OFFLINE' },
]

/**
 * Stylesheets whose `font-size` must be written `calc(<px> * var(--ui-scale))` (§2.2, §9 ruling 13;
 * AGENTS.md "new sidebar font-size rules MUST be calc(<spec px> * var(--ui-scale))"): the sidebar family.
 */
export const SCALED_TYPE_DIRS = ['app/src/renderer/sidebar/'] as const

/**
 * Blocks that ARE a token source: their custom-property definitions may hold literals (§2.8). Each is a copy
 * `npm run tokens:write` generates from packages/helm-ui/tokens (§9 ruling 106): the app `:root`, the extension's
 * `--vg-` `:host` copy and its popup's plain-name `:root` (§9 rulings 103, 104), and the Remote offline page's
 * `:root` (§9 ruling 96).
 */
export const TOKEN_SOURCES: readonly { file: string; selector: string }[] = [
	// `styles.css` is only the ordered @import manifest (S7); the app `:root` lives in tokens.css.
	{ file: 'app/src/renderer/tokens.css', selector: ':root' },
	{ file: 'extension/src/widget.styles.ts', selector: ':host' },
	{ file: 'extension/src/popup.html', selector: ':root' },
	{ file: 'app/assets/remote/remote-sw.js', selector: ':root' },
]

/**
 * Documented scoped palettes (the ones `packages/helm-ui/contrast-pairs.ts` measures). A custom property they
 * define that is not a core token is a scoped token and may hold a literal; a core token they redefine is
 * reported as `token-definition` (allowlisted under the decision that keeps the palette).
 */
export const SCOPED_TOKEN_BLOCKS: readonly { file: string; selector: string }[] = [
	// The dock/Signals dim text (§3.24).
	{ file: 'app/src/renderer/agent-dock/agent-dock.css', selector: '.agent-dock' },
	{ file: 'app/src/renderer/signals/signals.css', selector: '.signals' },
	{ file: 'app/src/renderer/remote/remote.css', selector: '.remote-workspace, .remote-login, .remote-empty' },
	{
		file: 'app/src/renderer/document-review/document-review.css',
		selector: '.document-review[data-review-theme="light"]',
	},
	{ file: 'app/src/renderer/viewer/viewer.css', selector: '.viewer-window' },
	{ file: 'app/src/renderer/viewer/viewer.css', selector: '.viewer-window[data-review-theme="light"]' },
]

// ---------------------------------------------------------------------------------------------------------
// Shared primitives and the one file that owns each one's CSS (§3; plan stage S7: "a primitive's CSS only in
// its own file").

export interface Primitive {
	/** Display name, used as the finding's property. */
	name: string
	/** The stylesheet that owns the primitive's base rules. */
	owner: string
	/**
	 * The primitive's class-name pattern. Every class matching it is the primitive's, wherever it is written
	 * (a brand-new `.btn-danger-outline` included), unless `SURFACE_MODIFIER_CLASSES` lists it.
	 */
	classes: RegExp
}

/**
 * §3.1 buttons (`button.tsx` + `button.css`; the icon button is `IconBtn` in `sidebar/ui.tsx`), §3.2 segmented,
 * §3.3 list row, §3.4 chips, §3.7 inputs, §3.8 menus, §3.15 action rows, §3.16 toggle, §3.20 disclosure.
 */
export const PRIMITIVES: readonly Primitive[] = [
	{ name: 'button', owner: 'app/src/renderer/button.css', classes: /^btn(-|$)/ },
	{ name: 'icon button', owner: 'app/src/renderer/sidebar/sidebar.css', classes: /^icon-btn(-|$)/ },
	{ name: 'segmented', owner: 'app/src/renderer/sidebar/sidebar.css', classes: /^(segmented|segment)(-|$)/ },
	{ name: 'list row', owner: 'app/src/renderer/sidebar/sidebar.css', classes: /^item-row(-|$)/ },
	{ name: 'chip', owner: 'app/src/renderer/sidebar/sidebar.css', classes: /^chip(-|$)/ },
	{ name: 'field', owner: 'app/src/renderer/sidebar/sidebar.css', classes: /^(input|select|textarea|field)(-|$)/ },
	{ name: 'menu', owner: 'app/src/renderer/sidebar/sidebar.css', classes: /^menu(-|$)/ },
	{ name: 'action row', owner: 'app/src/renderer/sidebar/sidebar.css', classes: /^action-row(-|$)/ },
	{ name: 'toggle', owner: 'app/src/renderer/sidebar/sidebar.css', classes: /^toggle(-|$)/ },
	{ name: 'disclosure', owner: 'app/src/renderer/sidebar/detail-redesign.css', classes: /^disclosure(-|$)/ },
]

/**
 * Classes that match a primitive's pattern but are surface modifiers or surface parts, not the primitive's
 * base: a compound holding one of them is the surface's context, so `primitiveOutsideOwner` never reports it.
 * Explicit on purpose: a primitive variant moved out of its owner file, or a new one written elsewhere, is
 * reported because it is not listed here. Each entry names where it lives.
 */
export const SURFACE_MODIFIER_CLASSES: ReadonlyMap<string, string> = new Map([
	['menu-fixed', 'surface placement of the menu panel (position: fixed escape from a clipping scroller)'],
	['field-reset', 'Settings field "Default" reset link beside a field'],
	// The tab/group context menu's "Move to new group…" name form (terminal-context-menu.css, built in
	// terminal-workspace.ts): parts of that surface whose names start with `menu-`, not menu variants.
	['menu-name-form', 'terminal context menu: the group-name form laid out inside the fixed menu panel'],
	['menu-name-input', 'terminal context menu: the group-name text field of that form'],
])

/** A primitive with the exact class names its owner file uses. */
export interface PrimitiveVocabulary {
	name: string
	owner: string
	classes: ReadonlySet<string>
}

// ---------------------------------------------------------------------------------------------------------
// Scales from docs/design-system.md.

/**
 * §2.3: 4px base scale; 0 is no space and 1px a hairline compensation (a line, not a space). 6 and 10 are the
 * in-component steps (§9 ruling 15: inside a component only, never between sections or from an edge; that
 * placement is a review rule, the scanner cannot see it). Checked on margin, padding, scroll-margin/-padding
 * and gap, in px and rem (16px; em/% are relative to content). Positions are not spaces: physical
 * top/right/bottom/left and their `inset` shorthands are not checked.
 */
export const SPACING_PX = new Set([0, 1, 4, 6, 8, 10, 12, 16, 20, 24, 32])
/** §2.3: "2px only as inner padding of segmented tracks"; padding on these selectors may be 2px. */
export const SEGMENTED_SELECTOR = /segmented|-seg\b|__seg\b/
/** §2.4: 4 / 6 / 8 and full (999); 50% is the circle form of full. */
export const RADIUS_PX = new Set([0, 4, 6, 8, 999])
export const RADIUS_PERCENT = new Set([0, 50])
/**
 * §2.4, §9 ruling 100: Helm Remote's phone radii (12 touch, 18 float, 28 capsule) exist only as these tokens and
 * only in Remote's stylesheets; a literal 12/18/28 is still off-scale everywhere, and a desktop rule that names
 * one of these tokens is reported too.
 */
export const REMOTE_RADIUS_TOKENS = ['--radius-touch', '--radius-float', '--radius-capsule'] as const
export const REMOTE_DIR = 'app/src/renderer/remote/'
/** §2.2: the type ladder (17 hero, 13 body/emphasis, 12 secondary/section/label/button, 11 meta/chip/mono). */
export const FONT_SIZE_PX = new Set([11, 12, 13, 17])
/** §2.2, §9 ruling 99: the written weights are 400/500/600 only (no 650, no 700). */
export const FONT_WEIGHTS = new Set([400, 500, 600])
/**
 * §2.2: "Base letter-spacing is -0.01em everywhere". Restating the base is not an override: buttons and
 * fields do not inherit it from the body, so their rules declare it again.
 */
export const BASE_LETTER_SPACING = '-0.01em'
/**
 * §2.2, §9 ruling 102: the one spaced step, +0.04em, only for key symbols and codes meant to be copied; the
 * scanner reads that from the selector (a `kbd` element or a `-kbd` / `-code` class). Monospace uses `normal`.
 */
export const KEY_LETTER_SPACING = '0.04em'
export const KEY_OR_CODE_SELECTOR = /(^|[\s>+~(,])kbd\b|-kbd\b|-code\b/
/**
 * Type sizes a surface's own section of the spec sets beside the §2.2 ladder. Document Review's reading
 * scope: "15px/1.7 body, 28px/1.25 h1, 21px/1.35 h2" (docs/design-system.md, Native document review workspace).
 */
export const SURFACE_FONT_SIZE_PX: readonly { dir: string; px: readonly number[] }[] = [
	{ dir: 'app/src/renderer/document-review/', px: [15, 21, 28] },
	// Helm Remote (§9 ruling 101): 16 is the phone reading step (messages, titles, navigation, sheet, and the
	// iOS no-zoom form text of §9 ruling 58); Markdown h3 takes the Document Review heading step 21.
	{ dir: REMOTE_DIR, px: [16, 21] },
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
/** Collapses whitespace and normalizes `,` and `( )` spacing outside quoted attribute values. */
export const normalizeSelector = (s: string) =>
	collapse(s)
		.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
		.map((part, index) =>
			index % 2
				? part
				: part
						.replace(/\s*,\s*/g, ', ')
						.replace(/\(\s+/g, '(')
						.replace(/\s+\)/g, ')'),
		)
		.join('')

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
	/** The custom properties whose `var()` fallbacks enclose the node, outermost first. */
	fallbackOf: string[]
	/** Enclosing function nodes, innermost last. */
	funcs: Extract<ValueNode, { t: 'func' }>[]
}

/** Visits every node; `var()` fallbacks are visited with `inFallback`, `env()` arguments are skipped. */
function visit(
	nodes: ValueNode[],
	fn: (node: ValueNode, ctx: VisitContext) => boolean | undefined,
	ctx?: VisitContext,
) {
	const here = ctx ?? { inFallback: false, fallbackOf: [], funcs: [] }
	for (const node of nodes) {
		if (fn(node, here) === false) continue
		if (node.t !== 'func') continue
		if (node.name === 'env' || node.name === 'attr') continue
		const inner = { inFallback: here.inFallback, fallbackOf: here.fallbackOf, funcs: [...here.funcs, node] }
		if (node.name === 'var') {
			const comma = node.args.findIndex(a => a.t === ',')
			const name = node.args[0]?.t === 'word' ? node.args[0].v : ''
			if (comma !== -1)
				visit(node.args.slice(comma + 1), fn, { ...inner, inFallback: true, fallbackOf: [...here.fallbackOf, name] })
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

/** CSS `rem` read as pixels for the spacing scale (the root font size the renderer never changes). */
const REM_PX = 16

export function lintDeclaration(property: string, value: string, ctx: DeclarationContext): Rule[] {
	const rules = new Set<Rule>()
	const nodes = parseValue(stripImportant(value))
	const prop = property.toLowerCase()
	/**
	 * A `var()` fallback is dead only behind a core token (always defined); behind any other name it is the value
	 * that renders when the name is undefined, so it is checked like a top-level value.
	 */
	const checked = (vctx: VisitContext) => !vctx.inFallback || !vctx.fallbackOf.some(n => ctx.coreTokens.has(n))

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
			if (checked(vctx) && node.t === 'word' && check(node.v, vctx)) hit = true
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
			if (checked(vctx) && node.t === 'func' && TIMING_FUNCTIONS.has(node.name)) easing = true
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
		const remoteToken = !ctx.file.startsWith(REMOTE_DIR) && REMOTE_RADIUS_TOKENS.some(name => usesVar(nodes, name))
		if (off || remoteToken) rules.add('radius-off-scale')
	}

	if (
		/^(margin|padding|scroll-margin|scroll-padding)(-[a-z-]+)?$/.test(prop) ||
		/^(grid-)?(row-|column-)?gap$/.test(prop)
	) {
		const twoAllowed = prop.startsWith('padding') && SEGMENTED_SELECTOR.test(ctx.selector)
		const off = literals((w, vctx) => {
			const n = parseNumber(w)
			if (!n || (n.unit !== 'px' && n.unit !== 'rem')) return false
			// `calc((100% - 800px) / 2)`: a px term beside a relative length inside calc() (or one of its bare
			// groups) is a width (a measure), not a space. `max(7px, 0%)` is not: each argument is a value.
			if (
				vctx.funcs.some(
					f =>
						(f.name === 'calc' || f.name === '') &&
						f.args.some(a => a.t === 'word' && /^[\d.]+(%|vw|vh|dvh|svh|lvh|vi|vb)$/.test(a.v)),
				)
			)
				return false
			const px = Math.abs(n.unit === 'rem' ? n.n * REM_PX : n.n)
			return !SPACING_PX.has(px) && !(twoAllowed && px === 2)
		})
		if (off) rules.add('spacing-off-scale')
	}

	if (prop === 'font-size' || prop === 'font') {
		const surfaceSizes = SURFACE_FONT_SIZE_PX.filter(s => ctx.file.startsWith(s.dir)).flatMap(s => s.px)
		const sizeNodes = prop === 'font' ? fontShorthandSize(nodes) : nodes
		const sizeWords: { word: string; ctx: VisitContext }[] = []
		visit(sizeNodes, (node, vctx) => {
			if (checked(vctx) && node.t === 'word') sizeWords.push({ word: node.v, ctx: vctx })
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
		const keyOrCode = KEY_OR_CODE_SELECTOR.test(ctx.selector)
		const off = literals(w => {
			const lower = w.toLowerCase()
			if (['normal', 'inherit', 'initial', 'unset', 'revert', '0', BASE_LETTER_SPACING].includes(lower)) return false
			return !(keyOrCode && lower === KEY_LETTER_SPACING)
		})
		if (off) rules.add('letter-spacing')
	}

	if (prop === 'font-weight' || prop === 'font') {
		const weightNodes: ValueNode[] = []
		if (prop === 'font') weightNodes.push(...fontShorthandWeight(nodes))
		else
			visit(nodes, (node, vctx) => {
				// `calc(700)` and fallbacks are weights too.
				if (checked(vctx) && node.t === 'word') weightNodes.push(node)
				return undefined
			})
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
	/** Shared primitives and their owner files (`PRIMITIVES`): enables `primitive-outside-owner`. */
	primitives?: readonly Primitive[]
	/** Classes matching a primitive pattern that are surface modifiers (default `SURFACE_MODIFIER_CLASSES`). */
	surfaceModifiers?: ReadonlyMap<string, string> | ReadonlySet<string>
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

/** Rules a custom-property indirection is checked for: colours and SVG are already held at the definition. */
const INDIRECT_RULES: ReadonlySet<Rule> = new Set(RULES.filter(r => r !== 'raw-color' && r !== 'inline-svg'))

/**
 * `value` with every `var(--x[, fallback])` whose name `defs` holds replaced by each of its definitions (one
 * string per combination, at most 16; nested definitions resolved up to four levels). `[]` when none applies.
 */
export function resolveLocalVars(value: string, defs: ReadonlyMap<string, readonly string[]>, depth = 0): string[] {
	if (depth > 4) return []
	const at = /\bvar\(\s*(--[\w-]+)/g
	for (let m = at.exec(value); m; m = at.exec(value)) {
		const options = defs.get(m[1] as string)
		if (!options?.length) continue
		let level = 1
		let end = m.index + 4
		for (; end < value.length && level > 0; end++) {
			if (value[end] === '(') level++
			else if (value[end] === ')') level--
		}
		const out: string[] = []
		for (const option of options) {
			const replaced = value.slice(0, m.index) + option + value.slice(end)
			const deeper = resolveLocalVars(replaced, defs, depth + 1)
			out.push(...(deeper.length ? deeper : [replaced]))
		}
		return [...new Set(out)].slice(0, 16)
	}
	return []
}

export function lintDeclarations(file: string, declarations: Declaration[], opts: LintOptions = {}): Finding[] {
	const coreTokens = opts.coreTokens ?? new Set<string>()
	const scaledType = inDirs(file, SCALED_TYPE_DIRS)
	const out: Finding[] = []
	// Custom properties this stylesheet defines outside token sources: a `z-index: var(--my-z)` is checked
	// against `--my-z`'s own value(s), so an indirection cannot carry a raw value past the rules.
	const localDefs = new Map<string, string[]>()
	for (const d of declarations)
		if (d.property.startsWith('--') && !coreTokens.has(d.property) && !blockMatch(TOKEN_SOURCES, file, d.selector))
			localDefs.set(d.property, [...new Set([...(localDefs.get(d.property) ?? []), stripImportant(d.value)])])
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
		const direct = lintDeclaration(d.property, d.value, ctx)
		for (const rule of direct)
			out.push({ file, selector: d.selector, property: d.property, value: keyValue(d.value), rule, line: d.line })
		if (d.property.startsWith('--') || !d.value.includes('var(')) continue
		const seen = new Set<string>(direct)
		for (const resolved of resolveLocalVars(stripImportant(d.value), localDefs)) {
			for (const rule of lintDeclaration(d.property, resolved, ctx)) {
				if (!INDIRECT_RULES.has(rule) || seen.has(rule)) continue
				seen.add(rule)
				out.push({
					file,
					selector: d.selector,
					property: d.property,
					value: keyValue(`${d.value} => ${resolved}`),
					rule,
					line: d.line,
				})
			}
		}
	}
	return out
}

export function lintCss(file: string, text: string, opts: LintOptions = {}, firstLine = 1): Finding[] {
	const declarations = parseCss(text, { firstLine })
	const out = lintDeclarations(file, declarations, opts)
	if (opts.primitives?.length)
		out.push(...primitiveOutsideOwner(file, declarations, opts.primitives, opts.surfaceModifiers))
	out.push(...buttonBorders(file, declarations))
	return out
}

/** Class names in a selector, outside pseudo-class arguments and attribute values. */
const SELECTOR_CLASS = /\.(-?[_a-zA-Z][\w-]*)/g

/** Removes `(…)` arguments, `[…]` attribute selectors and strings, so only the top-level compounds remain. */
function stripSelectorArguments(selector: string): string {
	let out = ''
	let depth = 0
	let quote = ''
	for (let i = 0; i < selector.length; i++) {
		const c = selector[i] as string
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = ''
			continue
		}
		if (c === '"' || c === "'") quote = c
		else if (c === '(' || c === '[') depth++
		else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
		else if (depth === 0) out += c
	}
	return out
}

/**
 * `:is(…)` / `:where(…)` at the top level of a complex selector, expanded into one complex selector per argument
 * (`:is(.btn, .chip):hover` → `.btn:hover`, `.chip:hover`), so a wrapper cannot hide a primitive's base rule.
 * Arguments with context (`:is(.a .btn)`) stay contextual after the expansion. Bounded to 64 alternatives.
 */
export function expandIsWhere(complex: string): string[] {
	let depth = 0
	let quote = ''
	for (let i = 0; i < complex.length; i++) {
		const c = complex[i] as string
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = ''
			continue
		}
		if (c === '"' || c === "'") quote = c
		else if (c === '(' || c === '[') depth++
		else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
		else if (depth === 0 && c === ':') {
			const m = /^:(is|where)\(/i.exec(complex.slice(i))
			if (!m) continue
			const open = i + m[0].length
			let inner = 1
			let j = open
			for (; j < complex.length && inner > 0; j++) {
				if (complex[j] === '(') inner++
				else if (complex[j] === ')') inner--
			}
			const args = splitTopLevel(complex.slice(open, j - 1))
			const before = complex.slice(0, i)
			const after = complex.slice(j)
			const out: string[] = []
			for (const arg of args) {
				const joined = joinCompound(before, arg)
				if (joined === null) continue
				for (const rest of expandIsWhere(after)) out.push(`${joined}${rest}`)
			}
			return out.slice(0, 64)
		}
	}
	return [complex]
}

/** A leading type selector (`button`, `svg|rect`, `*`) of a compound. */
const LEADING_TYPE = /^(?:(?:[\w-]+|\*)?\|)?(?:[a-zA-Z][\w-]*|\*)/

/**
 * `before` + an `:is()`/`:where()` argument as one selector. A type selector in the argument moves to the front of
 * the compound it joins (`.toolbar-item` + `button` → `button.toolbar-item`; plain concatenation would read
 * `.toolbar-itembutton`). A compound that already names another element type can never match: null.
 */
function joinCompound(before: string, arg: string): string | null {
	const type = LEADING_TYPE.exec(arg)?.[0]
	if (!type || before === '' || /[\s>+~]$/.test(before)) return `${before}${arg}`
	let start = 0
	let depth = 0
	let quote = ''
	for (let i = 0; i < before.length; i++) {
		const c = before[i] as string
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = ''
			continue
		}
		if (c === '"' || c === "'") quote = c
		else if (c === '(' || c === '[') depth++
		else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
		else if (depth === 0 && /[\s>+~]/.test(c)) start = i + 1
	}
	const compound = before.slice(start)
	const own = LEADING_TYPE.exec(compound)?.[0]
	const rest = arg.slice(type.length)
	if (own && own !== '*' && type !== '*' && own.toLowerCase() !== type.toLowerCase()) return null
	const lead = own && type === '*' ? own : type
	return `${before.slice(0, start)}${lead}${own ? compound.slice(own.length) : compound}${rest}`
}

/**
 * Stage S7's ownership rule. A rule styles a primitive's own base when one complex selector of its list is a
 * single compound (no ancestor, child or sibling context) whose classes all match a primitive's pattern
 * (`PRIMITIVES`), e.g. `.btn`, `.btn-primary:hover:not(:disabled)`, `button.btn.btn-sm`,
 * `.menu-item[data-force-state="hover"]`, `.icon-btn.menu-trigger-counted`, `:is(.btn)`. Such a rule may live
 * only in the owner file of one of the primitives it names. Context selectors stay with their surface: a
 * descendant (`.review-intents .btn`) or a surface class in the same compound (`.agent-dock-key.btn`, or a
 * listed surface modifier: `.menu-panel.menu-fixed`) is not the primitive's base and is never reported.
 */
export function primitiveOutsideOwner(
	file: string,
	declarations: readonly Declaration[],
	primitives: readonly Primitive[],
	surfaceModifiers: ReadonlyMap<string, string> | ReadonlySet<string> = SURFACE_MODIFIER_CLASSES,
): Finding[] {
	const out: Finding[] = []
	const seen = new Set<string>()
	for (const d of declarations) {
		const prefix = d.atRules.length ? `${d.atRules.join(' ')} ` : ''
		const selectorList = d.selector.startsWith(prefix) ? d.selector.slice(prefix.length) : d.selector
		for (const complex of splitTopLevel(selectorList)) {
			for (const alternative of expandIsWhere(complex)) {
				const top = stripSelectorArguments(alternative).trim()
				if (top === '' || /[\s>+~]/.test(top)) continue
				const classes = [...top.matchAll(SELECTOR_CLASS)].map(m => m[1] as string)
				if (!classes.length) continue
				const owners = classes.map(c => (surfaceModifiers.has(c) ? [] : primitives.filter(p => p.classes.test(c))))
				if (owners.some(list => list.length === 0)) continue
				const involved = [...new Set(owners.flat())]
				if (involved.some(p => p.owner === file)) continue
				const value = normalizeSelector(complex)
				const key = `${d.selector}\u0000${value}`
				if (seen.has(key)) continue
				seen.add(key)
				out.push({
					file,
					selector: d.selector,
					property: involved.map(p => p.name).join(' + '),
					value: keyValue(value),
					rule: 'primitive-outside-owner',
					line: d.line,
				})
			}
		}
	}
	return out
}

/** A border property (`border`, `border-left`, `border-inline-start-color`, …), never `border-radius`. */
const BORDER_PROPERTY = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-(width|style|color))?$/
const BUTTON_CLASS = /\.(icon-btn|btn|vg-btn)(-[\w-]+)?(?![\w-])/
const BUTTON_ELEMENT = /^button(?![\w-])/i
const BUTTON_ROLE = /\[\s*role\s*=\s*["']?button["']?\s*(\s[is])?\]/i
const BUTTON_INPUT = /^input(?![\w-]).*\[\s*type\s*=\s*["']?(button|submit|reset)["']?\s*(\s[is])?\]/i

/** The last compound of a complex selector (its subject), with `(…)` arguments removed and attributes kept. */
function selectorSubject(complex: string): string {
	let depth = 0
	let bracket = 0
	let quote = ''
	let last = 0
	let out = ''
	for (let i = 0; i < complex.length; i++) {
		const c = complex[i] as string
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = ''
			if (depth === 0) out += c
			continue
		}
		if (c === '"' || c === "'") {
			quote = c
			if (depth === 0) out += c
		} else if (c === '(') depth++
		else if (c === ')') depth = Math.max(0, depth - 1)
		else if (depth > 0) continue
		else {
			if (c === '[') bracket++
			if (c === ']') bracket = Math.max(0, bracket - 1)
			if (bracket === 0 && /[\s>+~]/.test(c)) last = out.length + 1
			out += c
		}
	}
	return out.slice(last).trim()
}

/**
 * The subject of a complex selector is a button: a button class (`.btn*`, `.icon-btn*`, the widget's `.vg-btn*`),
 * a `button` element, `[role=button]` or `input[type=button|submit|reset]`.
 */
export function isButtonSubject(complex: string): boolean {
	return expandIsWhere(complex).some(alternative => {
		const subject = selectorSubject(alternative)
		return (
			BUTTON_CLASS.test(subject) ||
			BUTTON_ELEMENT.test(subject) ||
			BUTTON_ROLE.test(subject) ||
			BUTTON_INPUT.test(subject)
		)
	})
}

/** §9 ruling 4: no border in any button tone; a button's weight comes from its fill. */
export function buttonBorders(file: string, declarations: readonly Declaration[]): Finding[] {
	const out: Finding[] = []
	for (const d of declarations) {
		if (!BORDER_PROPERTY.test(d.property)) continue
		if (/^(none|0(px)?|hidden)$/i.test(stripImportant(d.value))) continue
		const prefix = d.atRules.length ? `${d.atRules.join(' ')} ` : ''
		const selectorList = d.selector.startsWith(prefix) ? d.selector.slice(prefix.length) : d.selector
		if (!splitTopLevel(selectorList).some(isButtonSubject)) continue
		out.push({
			file,
			selector: d.selector,
			property: d.property,
			value: keyValue(d.value),
			rule: 'button-border',
			line: d.line,
		})
	}
	return out
}

/** Removes a trailing `!important` (with or without whitespace before it). */
export const stripImportant = (value: string): string => value.replace(/\s*!\s*important\s*$/i, '').trim()

/** Every primitive with the class names (matching its pattern) that its owner file uses in any selector. */
export function primitiveVocabulary(
	root: string,
	primitives: readonly Primitive[] = PRIMITIVES,
): PrimitiveVocabulary[] {
	return primitives.map(p => {
		const classes = new Set<string>()
		const path = join(root, p.owner)
		if (existsSync(path))
			for (const d of parseCss(readFileSync(path, 'utf8')))
				for (const m of stripSelectorArguments(d.selector).matchAll(SELECTOR_CLASS))
					if (p.classes.test(m[1] as string)) classes.add(m[1] as string)
		return { name: p.name, owner: p.owner, classes }
	})
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

/** `Element.animate()` timing options, read as the CSS animation property each one is. */
const ANIMATE_TIMING: Readonly<Record<string, string>> = {
	duration: 'animation-duration',
	delay: 'animation-delay',
	endDelay: 'animation-delay',
	easing: 'animation-timing-function',
}

/** React/Solid number values that mean pixels for the properties this lint checks. */
const PX_NUMBER_PROPERTY =
	/^(font-size|border(-[a-z]+)*-radius|(margin|padding|scroll-margin|scroll-padding)(-[a-z-]+)?|(row-|column-)?gap)$/

export function lintTs(file: string, text: string, opts: LintOptions = {}): Finding[] {
	const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
	const out: Finding[] = []
	const iconModule = inDirs(file, ICON_MODULE_DIRS)
	const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
	/** Nodes already read as style values: the generic motion-string check below skips them. */
	const consumed = new Set<ts.Node>()
	const isConsumed = (node: ts.Node) => {
		for (let p: ts.Node | undefined = node; p; p = p.parent) if (consumed.has(p)) return true
		return false
	}
	/**
	 * The initializer of the `const` an identifier names, found lexically (a parameter of that name shadows it):
	 * a same-file `const MS = 160` reads as its value in a template substitution, a style value or an option.
	 */
	const resolveConst = (id: ts.Identifier): ts.Expression | undefined => {
		for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
			if (ts.isFunctionLike(p) && p.parameters.some(param => param.name.getText(source) === id.text)) return undefined
			if (!(ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p))) continue
			for (const statement of p.statements) {
				if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
				for (const d of statement.declarationList.declarations)
					if (ts.isIdentifier(d.name) && d.name.text === id.text && d.initializer && d !== id.parent)
						return d.initializer
			}
		}
		return undefined
	}
	/** An expression with its type assertions and parentheses removed. */
	const bare = (node: ts.Expression): ts.Expression =>
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isNonNullExpression(node)
			? bare(node.expression)
			: node
	/** An expression, or the same-file `const` initializer it names (one step, then through assertions). */
	const dereference = (node: ts.Expression): ts.Expression => {
		const b = bare(node)
		if (!ts.isIdentifier(b)) return b
		const init = resolveConst(b)
		return init ? bare(init) : b
	}
	/** A template's text, `${}` substitutions as a same-file constant's value or an opaque `var(--expr)`. */
	const templateText = (node: ts.TemplateLiteral, raw: boolean): string => {
		const text = (part: ts.TemplateLiteralLikeNode) => (raw ? (part.rawText ?? part.text) : part.text)
		if (ts.isNoSubstitutionTemplateLiteral(node)) return text(node)
		return (
			text(node.head) +
			node.templateSpans
				.map(span => {
					const known = ts.isIdentifier(span.expression) ? literal(span.expression) : null
					return `${known ?? 'var(--expr)'}${text(span.literal)}`
				})
				.join('')
		)
	}
	/** CSS text an expression holds: a string, a template, a tagged template (`String.raw` reads raw), a const. */
	const cssText = (node: ts.Expression, depth = 0): string | null => {
		const b = bare(node)
		if (ts.isStringLiteral(b)) return b.text
		if (ts.isNoSubstitutionTemplateLiteral(b) || ts.isTemplateExpression(b)) return templateText(b, false)
		if (ts.isTaggedTemplateExpression(b)) return templateText(b.template, b.tag.getText(source) === 'String.raw')
		if (ts.isIdentifier(b) && depth < 4) {
			const init = resolveConst(b)
			return init ? cssText(init, depth + 1) : null
		}
		return null
	}
	/**
	 * An initializer that builds text the lint cannot read: string concatenation, a conditional or `||`/`??`
	 * between texts, an array `.join()`, a text method (`.concat()`, `.replace()`, `.trim()`). A lower-case
	 * CSS-named constant holding anything else is not a stylesheet (`const style = getComputedStyle(el)`).
	 */
	const looksLikeText = (node: ts.Expression, depth = 0): boolean => {
		const b = bare(node)
		if (depth > 6) return false
		if (
			ts.isStringLiteral(b) ||
			ts.isNoSubstitutionTemplateLiteral(b) ||
			ts.isTemplateExpression(b) ||
			ts.isTaggedTemplateExpression(b)
		)
			return true
		if (ts.isBinaryExpression(b)) {
			const op = b.operatorToken.kind
			if (
				op === ts.SyntaxKind.PlusToken ||
				op === ts.SyntaxKind.BarBarToken ||
				op === ts.SyntaxKind.QuestionQuestionToken
			)
				return looksLikeText(b.left, depth + 1) || looksLikeText(b.right, depth + 1)
		}
		if (ts.isConditionalExpression(b))
			return looksLikeText(b.whenTrue, depth + 1) || looksLikeText(b.whenFalse, depth + 1)
		if (ts.isCallExpression(b) && ts.isPropertyAccessExpression(b.expression)) {
			const method = b.expression.name.text
			const receiver = bare(b.expression.expression)
			if (method === 'join') return ts.isArrayLiteralExpression(receiver)
			if (/^(concat|replace|replaceAll|trim|trimStart|trimEnd)$/.test(method)) return looksLikeText(receiver, depth + 1)
		}
		return false
	}
	/** A JSX `<style>` child naming a CSS constant: its declaration is already linted, so the child is not. */
	const namesCssConstant = (node: ts.Expression): boolean => {
		const b = bare(node)
		if (!ts.isIdentifier(b) || !CSS_CONSTANT_NAME.test(b.text)) return false
		return resolveConst(b) !== undefined
	}

	const enclosing = (node: ts.Node): string => {
		for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
			if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.text
			if ((ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name)
				return p.name.getText(source)
			if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
		}
		return 'module'
	}

	/** The named function or method around `node` (skipping the variable that holds a call's result). */
	const enclosingFunction = (node: ts.Node): string => {
		for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
			if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.text
			if (ts.isMethodDeclaration(p) && p.name) return p.name.getText(source)
			if (
				(ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
				(ts.isVariableDeclaration(p.parent) || ts.isPropertyAssignment(p.parent)) &&
				p.parent.name
			)
				return p.parent.name.getText(source)
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
		// `\`color-mix(in srgb, ${hex} 78%, white)\``: a same-file constant reads as its value, any other
		// substitution as an opaque token.
		if (ts.isTemplateExpression(node)) return templateText(node, false)
		if (ts.isIdentifier(node)) {
			const init = resolveConst(node)
			const b = init && bare(init)
			if (
				b &&
				(ts.isStringLiteral(b) ||
					ts.isNoSubstitutionTemplateLiteral(b) ||
					ts.isNumericLiteral(b) ||
					ts.isPrefixUnaryExpression(b))
			)
				return literal(b)
			return null
		}
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

	const toDeclaration = (
		selector: string,
		rawProperty: string,
		valueNode: ts.Expression,
		at: ts.Node,
	): Declaration | null => {
		consumed.add(valueNode)
		const value = literal(valueNode)
		if (value === null) return null
		const property = rawProperty.startsWith('--') ? rawProperty : kebab(rawProperty)
		const numeric = ts.isNumericLiteral(bare(valueNode)) || ts.isPrefixUnaryExpression(bare(valueNode))
		const css = numeric && PX_NUMBER_PROPERTY.test(property) ? `${value}px` : value
		return { selector, property, value: css, line: lineOf(at), atRules: [] }
	}

	/** The function (or file) a style write sits in: custom properties set there are its local definitions. */
	const scopeOf = (node: ts.Node): ts.Node => {
		for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p
		return source
	}
	/** The selector of a scope definition passed along as context: never a real selector. */
	const SCOPE_DEFINITION = '\u0000scope'
	/** `el.style.setProperty('--x', '…')` definitions per scope, so a later `z-index: var(--x)` there resolves. */
	const scopeDefs = new Map<ts.Node, Declaration[]>()
	const collectScopeDefs = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'setProperty' &&
			ts.isPropertyAccessExpression(node.expression.expression) &&
			node.expression.expression.name.text === 'style'
		) {
			const [a0, a1] = node.arguments
			const prop = literal(a0)
			const value = a1 ? literal(a1) : null
			if (prop?.startsWith('--') && value !== null) {
				const scope = scopeOf(node)
				const list = scopeDefs.get(scope) ?? []
				list.push({ selector: SCOPE_DEFINITION, property: prop, value, line: lineOf(node), atRules: [] })
				scopeDefs.set(scope, list)
			}
		}
		ts.forEachChild(node, collectScopeDefs)
	}
	collectScopeDefs(source)

	/**
	 * Lints declarations written together (one style object, or one write) with the custom properties defined in
	 * the same scope, so `{ '--z': 9999, zIndex: 'var(--z)' }` resolves `--z`. Findings on scope definitions are
	 * dropped here: each definition is linted at its own write.
	 */
	const lintTogether = (declarations: Declaration[], at: ts.Node) => {
		if (!declarations.length) return
		const context = (scopeDefs.get(scopeOf(at)) ?? []).filter(
			d => !declarations.some(own => own.property === d.property),
		)
		const findings = lintDeclarations(file, [...context, ...declarations], opts)
		out.push(...findings.filter(f => f.selector !== SCOPE_DEFINITION))
	}

	const declare = (selector: string, rawProperty: string, valueNode: ts.Expression, at: ts.Node) => {
		const d = toDeclaration(selector, rawProperty, valueNode, at)
		if (d) lintTogether([d], at)
	}

	const declareObject = (selector: string, object: ts.ObjectLiteralExpression) => {
		const declarations: Declaration[] = []
		for (const prop of object.properties) {
			let d: Declaration | null = null
			if (ts.isPropertyAssignment(prop)) {
				const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
				if (name) d = toDeclaration(selector, name, prop.initializer, prop)
			} else if (ts.isShorthandPropertyAssignment(prop)) d = toDeclaration(selector, prop.name.text, prop.name, prop)
			if (d) declarations.push(d)
		}
		lintTogether(declarations, object)
	}

	const declareCssText = (selector: string, node: ts.Expression) => {
		consumed.add(node)
		const css = literal(node)
		if (css === null) return
		out.push(...lintDeclarations(file, parseCss(css, { inline: selector, firstLine: lineOf(node) }), opts))
	}

	const svg = (node: ts.Node, property: string, value: string) => {
		if (iconModule) return
		out.push({ file, selector: `in ${enclosing(node)}`, property, value, rule: 'inline-svg', line: lineOf(node) })
	}

	const walk = (node: ts.Node): void => {
		// CSS held in a string constant (`export const WIDGET_STYLES = \`…\``); substitutions read as opaque
		// tokens (or a same-file constant's value), so one `${}` cannot hide the whole stylesheet.
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			CSS_CONSTANT_NAME.test(node.name.text) &&
			node.initializer
		) {
			const init = bare(node.initializer)
			const textLike =
				ts.isNoSubstitutionTemplateLiteral(init) ||
				ts.isStringLiteral(init) ||
				ts.isTemplateExpression(init) ||
				ts.isTaggedTemplateExpression(init)
			const text = textLike ? cssText(init) : null
			if (text !== null) {
				consumed.add(node.initializer)
				out.push(...lintCss(file, text, opts, lineOf(init)))
				return
			}
			if (STRICT_CSS_CONSTANT_NAME.test(node.name.text) || looksLikeText(init))
				throw new Error(
					`${file}:${lineOf(node)}: CSS constant ${node.name.text} is not a string or template the design lint can read`,
				)
		}
		// JSX `<style>{\`…\`}</style>`.
		if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'style') {
			for (const child of node.children) {
				if (ts.isJsxText(child)) {
					if (child.text.trim()) out.push(...lintCss(file, child.text, opts, lineOf(child)))
					continue
				}
				if (!ts.isJsxExpression(child) || !child.expression) continue
				consumed.add(child.expression)
				if (namesCssConstant(child.expression)) continue
				const text = cssText(child.expression)
				if (text === null)
					throw new Error(`${file}:${lineOf(child)}: a <style> child the design lint cannot read as CSS text`)
				out.push(...lintCss(file, text, opts, lineOf(child)))
			}
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
			// `el.animate(keyframes, { duration, easing, delay })`: Web Animations timing is motion like CSS.
			if (method === 'animate' && (a0 || a1)) {
				const selector = `${callee.expression.getText(source)}.animate() in ${enclosingFunction(node)}`
				const timing = (name: string, valueNode: ts.Expression, at: ts.Node) => {
					const css = ANIMATE_TIMING[name]
					if (!css) return
					for (const option of styleValues(valueNode)) {
						const items = ts.isArrayLiteralExpression(bare(option))
							? (bare(option) as ts.ArrayLiteralExpression).elements
							: [option]
						for (const item of items) {
							consumed.add(item)
							const raw = literal(item)
							if (raw === null) continue
							const value = name === 'easing' || !/^-?[\d.]+$/.test(raw) ? raw : `${raw}ms`
							out.push(
								...lintDeclarations(file, [{ selector, property: css, value, line: lineOf(at), atRules: [] }], opts),
							)
						}
					}
				}
				const timings = (object: ts.ObjectLiteralExpression, only?: string) => {
					for (const prop of object.properties) {
						if (ts.isPropertyAssignment(prop)) {
							const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : ''
							if (!only || name === only) timing(name, prop.initializer, prop)
						} else if (ts.isShorthandPropertyAssignment(prop) && (!only || prop.name.text === only))
							timing(prop.name.text, prop.name, prop)
					}
				}
				// Options: `{ duration, easing, delay }`, a const holding them, or a bare duration (`600`).
				if (a1) {
					const options = dereference(a1)
					if (ts.isObjectLiteralExpression(options)) timings(options)
					else timing('duration', a1, a1)
				}
				// Keyframes: an `easing` per keyframe (`[{ opacity: 0, easing: 'ease-in' }, …]`) or property-indexed.
				if (a0) {
					const keyframes = dereference(a0)
					const frames = ts.isArrayLiteralExpression(keyframes) ? keyframes.elements : [keyframes]
					for (const frame of frames) {
						const f = dereference(frame)
						if (ts.isObjectLiteralExpression(f)) timings(f, 'easing')
					}
				}
			}
		}
		// A string holding an easing function outside any style value (`const EASING = 'cubic-bezier(…)'`,
		// later written into a transition through a parameter): a timing curve is motion wherever it is kept.
		if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isConsumed(node)) {
			for (const m of node.text.matchAll(/\b(cubic-bezier|steps)\([^)]*\)/gi))
				out.push({
					file,
					selector: `in ${enclosing(node)}`,
					property: 'string',
					value: collapse(m[0]),
					rule: 'raw-easing',
					line: lineOf(node),
				})
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

export type SourceKind = 'css' | 'html' | 'ts' | 'embedded-html'

export function isExcluded(file: string): boolean {
	return inDirs(file, EXCLUDED_DIRS) || EXCLUDED_FILES.some(re => re.test(file))
}

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

/**
 * Every production source, repository-relative: the scan roots walked in order, then the production TS/TSX
 * modules outside them, then `EMBEDDED_HTML`.
 */
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
	// Production modules outside the scan roots that an entry imports (app/src/agent-dock/, theme-presets.ts…).
	const listed = new Set(out.map(source => source.file))
	for (const file of [...production].sort()) if (!listed.has(file) && !isExcluded(file)) out.push({ file, kind: 'ts' })
	for (const { file } of EMBEDDED_HTML)
		if (!out.some(source => source.file === file)) out.push({ file, kind: 'embedded-html' })
	return out
}

/** The text of a top-level string/template constant `name` in a JS/TS file (substitutions read as `var(--expr)`). */
export function embeddedConstant(file: string, text: string, name: string): { text: string; line: number } {
	const kind = /\.(m|c)?js$/.test(file) ? ts.ScriptKind.JS : file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
	let found: { text: string; line: number } | null = null
	const walk = (node: ts.Node): void => {
		if (found) return
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
			const init = node.initializer
			const value =
				ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)
					? init.text
					: ts.isTemplateExpression(init)
						? init.head.text + init.templateSpans.map(span => `var(--expr)${span.literal.text}`).join('')
						: null
			if (value !== null)
				found = { text: value, line: source.getLineAndCharacterOfPosition(init.getStart(source)).line + 1 }
			return
		}
		ts.forEachChild(node, walk)
	}
	walk(source)
	if (!found) throw new Error(`${file}: embedded HTML constant ${name} not found (update EMBEDDED_HTML)`)
	return found
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
	if (source.kind === 'embedded-html') {
		return EMBEDDED_HTML.filter(e => e.file === source.file).flatMap(e => {
			const embedded = embeddedConstant(source.file, text, e.constant)
			return lintHtml(source.file, embedded.text, opts).map(f => ({ ...f, line: f.line + embedded.line - 1 }))
		})
	}
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

/** Every token name a bundled preset sets (packages/helm-ui/tokens): core even where no CSS source defines it. */
export const PRESET_TOKENS: readonly string[] = [...THEME_TOKEN_NAMES].sort()

/** Scans the whole repository. */
export function scanRepository(root: string): Finding[] {
	const coreTokens = coreTokensFrom(root, PRESET_TOKENS)
	return collectSources(root)
		.flatMap(source => lintSource(root, source, { coreTokens, primitives: PRIMITIVES }))
		.sort((a, b) => compareFindings(a, b) || a.line - b.line)
}

// ---------------------------------------------------------------------------------------------------------
// The baseline (packages/helm-ui/lint-allowlist.ts): a ratchet, one line per allowlisted finding.
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

/** Marks a reason the script wrote rather than a person; tests/design-lint.test.ts rejects it. */
export const AUTO_REASON_PREFIX = 'TODO: '

/**
 * Regenerates the baseline: every finding listed, keeping the reason of entries that still match. A finding
 * with no entry gets `TODO: ` plus its rule's default reason (the script refuses those without `--allow-new`).
 */
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
			reason: kept ?? `${AUTO_REASON_PREFIX}${defaultReason(f)}`,
		}
	})
}

const isRemote = (file: string) => file.startsWith('app/src/renderer/remote/')
const isReview = (file: string) =>
	file.startsWith('app/src/renderer/document-review/') || file.startsWith('app/src/renderer/viewer/')

/** The reason suggested for a new baseline entry: the decision or ruling that keeps a value of its kind today. */
export function defaultReason(f: FindingKey): string {
	switch (f.rule) {
		case 'raw-color':
			return isRemote(f.file)
				? 'D16 Remote values outside the palette (D7 A settled only the seven surface tokens)'
				: 'S2 gives the literal a token (§9 ruling 9)'
		case 'token-definition':
			if (f.property === '--ui-scale') return 'D7 surface reach (Review keeps its own text scale)'
			if (isReview(f.file)) return '§2.8 Review light scope (§9 ruling 10)'
			if (isRemote(f.file)) return '§9 ruling 96 (Remote re-binds no app token): needs a fix'
			return 'S2 token pipeline (core tokens are defined in their source only)'
		case 'raw-z-index':
		case 'raw-duration':
		case 'raw-easing':
			return 'S2 adds z/motion tokens'
		case 'spacing-off-scale':
			if (/(^|[\s.,])\.?(chip|vg-chip|menu-trigger-badge)\b/.test(f.selector) && /\b2px 8px\b/.test(f.value))
				return '§9 ruling 26 chip padding 2×8'
			return 'D17 off-scale values the scale picks did not settle (2px steps and component dimensions)'
		case 'font-size-off-scale':
			return 'D17 off-scale values the scale picks did not settle (type outside Remote and the count badges)'
		case 'font-size-unscaled':
			return '§9 ruling 13 (no fixed sidebar sizes: write calc(<px> * var(--ui-scale))): needs a fix'
		case 'letter-spacing':
			return '§9 ruling 102 (one spaced step, +0.04em, only for key symbols and codes): needs a fix'
		case 'font-weight':
			return '§9 ruling 99 (written weights 400/500/600 only): needs a fix'
		case 'radius-off-scale':
			return 'D17 off-scale values the scale picks did not settle (radii under 4px)'
		case 'inline-svg':
			return '§9 ruling 95 icon set (draw it in the icon module, or list a real exception in ICONS_OUTSIDE_MODULE)'
		case 'primitive-outside-owner':
			if (isRemote(f.file) || isReview(f.file)) return 'D7 surface reach (the surface restyles the shared primitive)'
			return 'S7 primitive CSS outside its owner file (move it there when the surface is next touched)'
		case 'button-border':
			return '§9 ruling 4 (no border on any button): needs a pick or a fix'
		default:
			return 'D17 off-scale values the scale picks did not settle'
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
