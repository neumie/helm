// D15 Contrast — the values each variant proposes and every ratio its caption shows.
// Token values come from the generated preset module (packages/helm-ui/tokens/ via `npm run tokens:write`); proposed
// values were found by walking HSL lightness (same hue and saturation) in 0.1 % steps, or alpha in 0.01 steps, to the
// first value that reaches the need. Ratios are WCAG 2.x on exact (unrounded) composites, the way
// packages/helm-ui/contrast.ts computes the §2.9 table, and truncated to two decimals (never rounded across a need).
import { HELM_TOKENS, HIGH_CONTRAST_TOKENS } from '../../../design-tokens.generated'

type Rgb = readonly [number, number, number]
interface Colour {
	rgb: Rgb
	a: number
}

function parse(value: string): Colour {
	const text = value.trim()
	if (text.startsWith('#')) {
		const byte = (i: number) => Number.parseInt(text.slice(i, i + 2), 16)
		return { rgb: [byte(1), byte(3), byte(5)], a: 1 }
	}
	const match = /^rgba?\(([^)]*)\)$/.exec(text)
	if (!match) throw new Error(`D15: unsupported colour ${value}`)
	const [r = 0, g = 0, b = 0, a = 1] = (match[1] ?? '').split(',').map(part => Number(part.trim()))
	return { rgb: [r, g, b], a }
}

const opaque = (rgb: Rgb): Colour => ({ rgb, a: 1 })

/** `top` over the opaque `base` (source-over, gamma sRGB). */
function over(top: Colour, base: Rgb): Rgb {
	return [0, 1, 2].map(i => (top.rgb[i] ?? 0) * top.a + (base[i] ?? 0) * (1 - top.a)) as unknown as Rgb
}

/** `color-mix(in srgb, a p%, b)` with both opaque, unrounded (as packages/helm-ui/contrast.ts resolves it). */
export function mix(a: string, percent: number, b: string): Colour {
	return opaque(over({ ...parse(a), a: percent / 100 }, parse(b).rgb))
}

/** `color-mix(in srgb, x p%, transparent)`: x at alpha p. */
export const tint = (colour: string, percent: number): Colour => ({ ...parse(colour), a: percent / 100 })

const linear = (c: number) => {
	const s = c / 255
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

/** A surface: an opaque colour, then translucent layers bottom-up. */
export function surface(base: string, ...layers: (string | Colour)[]): Rgb {
	let painted = parse(base).rgb
	for (const layer of layers) painted = over(typeof layer === 'string' ? parse(layer) : layer, painted)
	return painted
}

/** Contrast of `fg` (possibly translucent, then painted over the surface) on the surface, "4.30". */
export function ratio(fg: string | Colour, bg: Rgb): string {
	const top = typeof fg === 'string' ? parse(fg) : fg
	const a = luminance(top.a === 1 ? top.rgb : over(top, bg))
	const b = luminance(bg)
	const value = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
	return (Math.floor(value * 100 + 1e-9) / 100).toFixed(2)
}

function token(tokens: Readonly<Record<string, string>>, name: string): string {
	const value = tokens[name]
	if (value === undefined) throw new Error(`D15: missing token ${name}`)
	return value
}
export const helm = (name: string) => token(HELM_TOKENS, name)
export const high = (name: string) => token(HIGH_CONTRAST_TOKENS, name)

/** `--dock-dim` (agent-dock.css, signals.css): `color-mix(in srgb, var(--text-1) 60%, var(--text-2))`. */
export const dockDim = (text1: string, text2: string) => mix(text1, 60, text2)

/** The whole High contrast preset as frame CSS (what the theme picker applies to :root). */
export const HIGH_CONTRAST_CSS = `:root { ${Object.entries(HIGH_CONTRAST_TOKENS)
	.map(([name, value]) => `${name}: ${value} !important;`)
	.join(' ')} }`

/** Frame CSS for one or more root tokens. */
export const rootTokens = (values: Record<string, string>) =>
	`:root { ${Object.entries(values)
		.map(([name, value]) => `${name}: ${value} !important;`)
		.join(' ')} }`

// Surfaces (§2.9 stacks) in each preset.
export const S = {
	helm: {
		pane: surface(helm('--pane')),
		chrome: surface(helm('--chrome')),
		well: surface(helm('--well')),
		term: surface(helm('--term-bg')),
		input: surface(helm('--pane'), helm('--fill-subtle')),
		selected: surface(helm('--pane'), helm('--fill-raised')),
		dockSelected: surface(helm('--chrome'), helm('--fill-raised')),
		chromeHover: surface(helm('--chrome'), helm('--fill-subtle')),
	},
	high: {
		pane: surface(high('--pane')),
		chrome: surface(high('--chrome')),
		well: surface(high('--well')),
		term: surface(high('--term-bg')),
		input: surface(high('--pane'), high('--fill-subtle')),
		selected: surface(high('--pane'), high('--fill-raised')),
		dockSelected: surface(high('--chrome'), high('--fill-raised')),
		chromeHover: surface(high('--chrome'), high('--fill-subtle')),
	},
} as const

// ---- Q1 meta text on fills -------------------------------------------------------------------------------------

/** B: the smallest same-hue lift of `--text-2` reaching 4.5:1 on the dock's open entry (`--fill-raised` on chrome). */
export const META_LIFT = { helm: '#94989f', high: '#a2a7af' } as const

// ---- Q2 scroll thumbs ------------------------------------------------------------------------------------------

/** A: white alpha whose blend first reaches 3:1 on the pane (and on the well, the log/plan wells' surface). */
export const THUMB_3 = {
	helm: { thumb: 0.35, hover: 0.45, term: 0.35, termHover: 0.48 },
	high: { thumb: 0.36, hover: 0.5, term: 0.35, termHover: 0.5 },
	/** Review light: `--text-0` share of `color-mix(in srgb, var(--text-0) p%, transparent)`. */
	reviewLight: { thumb: 50, hover: 64 },
} as const
export const white = (alpha: number) => `rgba(255, 255, 255, ${alpha})`
export const REVIEW_LIGHT = { pane: '#faf9f6', text0: '#24272c' } as const

// ---- Q3 terminal bright black ----------------------------------------------------------------------------------

/** A: the smallest same-hue lift of `--ansi-bright-black` reaching 4.5:1 on `--term-bg`. */
export const BRIGHT_BLACK_LIFT = '#767c86'

// ---- Q4 tones on soft fills over rows --------------------------------------------------------------------------

export const TONES = ['--accent', '--danger', '--neutral'] as const
/** B: the smallest same-hue lifts reaching 4.5:1 on their soft fill over a hovered row (`--fill-subtle` on pane). */
export const TONE_LIFT = { '--danger': '#f46e70', '--neutral': '#969ba3' } as const

/** A tone on its 15 % soft fill over `row` (a hovered or pressed row surface). */
export function chipRatio(get: (name: string) => string, tone: string, row: Rgb, colour = get(tone)): string {
	return ratio(colour, over(tint(colour, 15), row))
}

// ---- Q5 terminal group band ------------------------------------------------------------------------------------

export const GROUPS = ['blue', 'purple', 'pink', 'red', 'orange', 'green', 'cyan'] as const

export interface BandRule {
	/** Band, hovered tab and active tab tints (%). */
	band: number
	hover: number
	active: number
	/** Tab text at rest and on hover. */
	tab: '--text-2' | '--text-1'
	tabHover: '--text-1' | '--text-0'
	/** Name at rest: group colour p % mixed into this text token. */
	label: { percent: number; into: '--text-1' | '--text-0' }
	/** Name on hover: the pure group colour, or a text token. */
	labelHover: 'group' | '--text-0'
	/** Count: group colour p % mixed into this text token. */
	count: { percent: number; into: '--text-2' | '--text-1' }
}

export const BAND_CURRENT: BandRule = {
	band: 15,
	hover: 22,
	active: 30,
	tab: '--text-2',
	tabHover: '--text-1',
	label: { percent: 55, into: '--text-1' },
	labelHover: 'group',
	count: { percent: 55, into: '--text-2' },
}
/** A: everything in the band one step up the text ladder; the band stays. */
export const BAND_LIFT: BandRule = {
	...BAND_CURRENT,
	tab: '--text-1',
	tabHover: '--text-0',
	label: { percent: 55, into: '--text-0' },
	labelHover: '--text-0',
	count: { percent: 40, into: '--text-1' },
}
/** B: a fainter band, and the text A needs anyway (the fainter band alone leaves `--text-2` at 3.9–4.1). */
export const BAND_FAINT: BandRule = { ...BAND_LIFT, band: 8, hover: 12, active: 20 }

/** Worst ratio of each band pair over the seven group colours, in one preset. */
export function bandFacts(get: (name: string) => string, rule: BandRule): string[] {
	const chrome = surface(get('--chrome'))
	const worst = (pick: (group: string) => string) =>
		GROUPS.map(name => {
			const value = Number(pick(get(`--group-${name}`)))
			return { name, value }
		}).reduce((low, next) => (next.value < low.value ? next : low))
	const show = (label: string, pick: (group: string) => string) => {
		const low = worst(pick)
		return `${label} min ${low.value.toFixed(2)} (${low.name})`
	}
	const band = (g: string) => surface(get('--chrome'), tint(g, rule.band))
	const hover = (g: string) => over(tint(g, rule.hover), band(g))
	return [
		show(`karta ${rule.tab}`, g => ratio(get(rule.tab), band(g))),
		show(`hover ${rule.tabHover}`, g => ratio(get(rule.tabHover), hover(g))),
		show('název', g => ratio(mix(g, rule.label.percent, get(rule.label.into)), band(g))),
		show('název hover', g => ratio(rule.labelHover === 'group' ? g : get(rule.labelHover), hover(g))),
		show('počet', g => ratio(mix(g, rule.count.percent, get(rule.count.into)), band(g))),
		show('počet v Background, hover', g =>
			ratio(mix(g, rule.count.percent, get(rule.count.into)), over(tint(g, 12), chrome)),
		),
	]
}

/** Frame CSS that applies a band rule (the production selectors from terminal-tabs.css / background-terminals.css). */
export function bandCss(rule: BandRule): string {
	const labelHover = rule.labelHover === 'group' ? 'var(--group-color)' : `var(${rule.labelHover})`
	return `
.tab-group-section { background: color-mix(in srgb, var(--group-color) ${rule.band}%, transparent); }
/* The tab's number (⌘N) is --text-2 too: inside the band it follows the tab text in every state. */
.tab-group-section .tab { color: var(${rule.tab});${rule.tab === '--text-2' ? '' : ` --text-2: var(${rule.tab});`} }
.tab-group-section .tab:is(:hover, [data-d15-hover]),
.tab-group-section.collapsed > .tab-group-toggle:is(:hover, [data-d15-hover]) {
	background: color-mix(in srgb, var(--group-color) ${rule.hover}%, transparent);
}
.tab-group-section .tab:is(:hover, [data-d15-hover]) { color: var(${rule.tabHover});${rule.tab === '--text-2' ? '' : ` --text-2: var(${rule.tabHover});`} }
.tab-group-section .tab.active { background: color-mix(in srgb, var(--group-color) ${rule.active}%, transparent); color: var(--text-0);${rule.tab === '--text-2' ? '' : ' --text-2: var(--text-0);'} }
.tab-group-toggle { color: color-mix(in srgb, var(--group-color) ${rule.label.percent}%, var(${rule.label.into})); }
.tab-group-toggle:is(:hover, [data-d15-hover]) { color: ${labelHover}; }
.tab-group-count { color: color-mix(in srgb, var(--group-color) ${rule.count.percent}%, var(${rule.count.into})); }
`
}

/**
 * Copies of the production :hover rules onto `[data-d15-hover]`, so a frame can hold a hover the way StateGrid's
 * `data-force-state` does for primitives (these surfaces have no forced-state selector). Same in every variant.
 */
export const STATE_CSS = `
.tab[data-d15-hover] { background: var(--fill-subtle); color: var(--text-1); }
.tab-group-section .tab[data-d15-hover] { background: color-mix(in srgb, var(--group-color) 22%, transparent); color: var(--text-1); }
.tab-group-toggle[data-d15-hover] { color: var(--group-color); }
.tab-group-section.collapsed > .tab-group-toggle[data-d15-hover] { background: color-mix(in srgb, var(--group-color) 22%, transparent); }
.agent-dock-entry[data-d15-hover] { background: var(--fill-subtle); }
.remote-session-entry[data-d15-hover] { background: var(--fill-subtle); }
`
