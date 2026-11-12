// D5 Contrast — the colours each variant proposes and the pairs they are measured on.
// Production values come from the bundled presets / production CSS; proposed values were found by walking HSL
// lightness (same hue and saturation) in 0.1 % steps until the target pair first reached its WCAG threshold.
// Every ratio shown in a caption is computed here with contrast.ts at module load, never typed by hand.
import { THEME_PRESETS } from '../../../theme-presets'
import { over, ratio } from '../contrast'

const helm = THEME_PRESETS.helm?.tokens ?? {}
const high = THEME_PRESETS['high-contrast']?.tokens ?? {}

function token(tokens: Record<string, string>, name: string): string {
	const value = tokens[name]
	if (value === undefined) throw new Error(`Missing preset token ${name}`)
	return value
}

/** White at `alpha` over `base` (the hairline/fill system is white alpha on the dark ladder). */
export const white = (alpha: number, base: string) => over('#ffffff', alpha, base)
/** `color-mix(in srgb, a p%, b)` (gamma-space mix, as Chromium computes it). */
export const mix = (a: string, p: number, b: string) => over(a, p, b)

export const HELM = {
	chrome: token(helm, '--chrome'),
	pane: token(helm, '--pane'),
	well: token(helm, '--well'),
	text1: token(helm, '--text-1'),
	text2: token(helm, '--text-2'),
	accent: token(helm, '--accent'),
	accentFill: token(helm, '--accent-fill'),
	accentFillHover: token(helm, '--accent-fill-hover'),
	onAccent: token(helm, '--on-accent'),
} as const

export const HIGH = {
	chrome: token(high, '--chrome'),
	pane: token(high, '--pane'),
	text1: token(high, '--text-1'),
	text2: token(high, '--text-2'),
	accentFill: token(high, '--accent-fill'),
	accentFillHover: token(high, '--accent-fill-hover'),
	hairline: token(high, '--hairline'),
	hairlineStrong: token(high, '--hairline-strong'),
} as const

/** The High contrast preset as shipped, applied as overrides (what the theme picker applies to :root). */
export const HIGH_CONTRAST_TOKENS = high as Readonly<Record<`--${string}`, string>>

/** Remote's own ladder (remote.css `.remote-workspace`); its text ladder is the app's. */
export const REMOTE = {
	page: '#0d0d0d',
	chrome: '#1c1c1e',
	bubble: '#2f2f2f',
	/** `.remote-compose-surface::before`: color-mix(--chrome 68%, transparent) over the page. */
	capsule: mix('#1c1c1e', 0.68, '#0d0d0d'),
	/** Selected session row: Remote's --fill-raised (white 11 %) on `.remote-session-entry` AND on its
	 *  `.remote-session-row[aria-current]`, so two layers over the page. */
	selectedRow: white(0.11, white(0.11, '#0d0d0d')),
} as const

/** Document Review light scope (document-review.css `[data-review-theme="light"]`). */
export const REVIEW_LIGHT = {
	chrome: '#f1f0ed',
	pane: '#faf9f6',
	well: '#ebeae6',
	accent: '#176ac2',
	/** Not overridden by the light scope: the dark-tuned app value leaks in. */
	neutral: token(helm, '--neutral'),
} as const

// Proposed values.
export const META = {
	/** Minimum same-hue lift reaching 4.5:1 on --chrome (also covers pane and well). */
	chrome: '#7f848d',
	/** Minimum same-hue lift reaching 4.5:1 on --pane only. */
	pane: '#7a7f88',
} as const

export const BUTTON = {
	/** Minimum same-hue darkening of #3b82f6 reaching 4.5:1 under white. */
	fill: '#1e6ff5',
	/** Hover 4 % darker again (hover darkens instead of lightening). */
	fillHover: '#0b63f4',
	/** Dark text on today's fill: --well. */
	darkText: HELM.well,
} as const

export const EDGE = {
	/** White alpha whose blend reaches 3:1 on --pane (and on --chrome). */
	control: 'rgba(255, 255, 255, 0.33)',
	controlAlpha: 0.33,
	/** Hover one step stronger. */
	controlHover: 'rgba(255, 255, 255, 0.45)',
	controlHoverAlpha: 0.45,
} as const

export const HIGH_FIX = {
	accentFill: '#3473de',
	accentFillHover: '#2367da',
	/** --hairline at the 3:1 edge (on the High contrast pane), --hairline-strong one step above. */
	hairline: 'rgba(255, 255, 255, 0.34)',
	hairlineAlpha: 0.34,
	hairlineStrong: 'rgba(255, 255, 255, 0.48)',
	hairlineStrongAlpha: 0.48,
	/** Minimum lift reaching 4.5:1 on --fill-strong over pane. */
	text2: '#a9aeb5',
} as const

export const REMOTE_META = {
	/** Same value as D5/1 A: Remote inherits the app's --text-2. */
	follow: META.chrome,
	/** Remote-only minimum reaching 4.5:1 on the page. */
	page: '#757a83',
} as const

export const REVIEW_FIX = {
	/** Minimum darkening of #176ac2 reaching 4.5:1 on the light well. */
	accent: '#176ac1',
	/** Minimum darkening of #8a8f98 reaching 4.5:1 on the light well. */
	neutral: '#656a73',
} as const

// Measured pairs (fill-raised / fill-strong / fill-subtle blended over their surface).
export const helmFillRaisedOverPane = white(0.09, HELM.pane)
export const helmFillRaisedOverChrome = white(0.09, HELM.chrome)
export const helmFillSubtleOverPane = white(0.05, HELM.pane)
export const highFillStrongOverPane = white(0.22, HIGH.pane)

/** Facts for one --text-2 candidate on the cockpit ladder. */
export function metaFacts(text2: string): string[] {
	const dockDim = mix(HELM.text1, 0.6, text2)
	return [
		`--text-2 ${text2}`,
		`na chrome ${ratio(text2, HELM.chrome)} · pane ${ratio(text2, HELM.pane)} · well ${ratio(text2, HELM.well)}`,
		`vybraný řádek (fill-raised) na pane ${ratio(text2, helmFillRaisedOverPane)} · na chrome ${ratio(text2, helmFillRaisedOverChrome)}`,
		`placeholder na fill-subtle ${ratio(text2, helmFillSubtleOverPane)}`,
		`--dock-dim ${dockDim} na chrome ${ratio(dockDim, HELM.chrome)}`,
		`odstup od --text-1 ${ratio(HELM.text1, text2)}`,
	]
}

export function buttonFacts(fill: string, hover: string, text: string): string[] {
	return [
		`--accent-fill ${fill} · hover ${hover} · text ${text}`,
		`klid ${ratio(text, fill)} · hover ${ratio(text, hover)}`,
		`výplň vůči pane ${ratio(fill, HELM.pane)}`,
	]
}

export function edgeFacts(restAlpha: number, hoverAlpha: number): string[] {
	return [
		`hrana v klidu α ${restAlpha}: na pane ${ratio(white(restAlpha, HELM.pane), HELM.pane)} · na chrome ${ratio(white(restAlpha, HELM.chrome), HELM.chrome)}`,
		`hover α ${hoverAlpha}: na pane ${ratio(white(hoverAlpha, HELM.pane), HELM.pane)}`,
		`hrana vůči vlastní výplni pole ${ratio(white(restAlpha, HELM.pane), helmFillSubtleOverPane)} · výplň pole (fill-subtle) vůči pane ${ratio(helmFillSubtleOverPane, HELM.pane)}`,
	]
}

export function highFacts(fix: {
	accentFill: string
	accentFillHover: string
	hairlineAlpha: number
	hairlineStrongAlpha: number
	text2: string
}): string[] {
	return [
		`tlačítko klid ${ratio('#ffffff', fix.accentFill)} (${fix.accentFill}) · hover ${ratio('#ffffff', fix.accentFillHover)} (${fix.accentFillHover})`,
		`--hairline α ${fix.hairlineAlpha} na pane ${ratio(white(fix.hairlineAlpha, HIGH.pane), HIGH.pane)} · na chrome ${ratio(white(fix.hairlineAlpha, HIGH.chrome), HIGH.chrome)}`,
		`--hairline-strong α ${fix.hairlineStrongAlpha} na pane ${ratio(white(fix.hairlineStrongAlpha, HIGH.pane), HIGH.pane)}`,
		`--text-2 ${fix.text2} na fill-strong ${ratio(fix.text2, highFillStrongOverPane)} · na chrome ${ratio(fix.text2, HIGH.chrome)} · odstup od --text-1 ${ratio(HIGH.text1, fix.text2)}`,
	]
}

export function remoteFacts(text2: string): string[] {
	return [
		`--text-2 ${text2}`,
		`na page ${ratio(text2, REMOTE.page)} · chrome ${ratio(text2, REMOTE.chrome)} · composer ${ratio(text2, REMOTE.capsule)} · bublina ${ratio(text2, REMOTE.bubble)}`,
		`„Workspace:“ ve vybraném řádku (2× fill-raised) ${ratio(text2, REMOTE.selectedRow)}`,
	]
}

export function reviewFacts(accent: string, neutral: string): string[] {
	return [
		`--accent ${accent}: na well ${ratio(accent, REVIEW_LIGHT.well)} · pane ${ratio(accent, REVIEW_LIGHT.pane)} · bílá na něm ${ratio('#ffffff', accent)}`,
		`--neutral ${neutral}: na pane ${ratio(neutral, REVIEW_LIGHT.pane)} · well ${ratio(neutral, REVIEW_LIGHT.well)}`,
	]
}
