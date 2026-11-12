// D11 Toggles — the colours each variant paints on an on switch and the pairs they are measured on.
// Production values come from the bundled presets; every ratio in a caption is computed here with contrast.ts.
import { THEME_PRESETS } from '../../../theme-presets'
import { over, ratio } from '../contrast'

function token(tokens: Record<string, string> | undefined, name: string): string {
	const value = tokens?.[name]
	if (value === undefined) throw new Error(`Missing preset token ${name}`)
	return value
}

/** The alpha of a `rgba(255, 255, 255, a)` token (the hairline/fill system is white alpha on the dark ladder). */
function whiteAlpha(value: string): number {
	const match = /^rgba\(255, 255, 255, ([0-9.]+)\)$/.exec(value)
	if (!match?.[1]) throw new Error(`Expected white alpha, got ${value}`)
	return Number(match[1])
}

interface Preset {
	pane: string
	text0: string
	text1: string
	accent: string
	accentFill: string
	onAccent: string
	/** Composited over the pane. */
	hairline: string
	fillSubtle: string
	fillStrong: string
}

function preset(id: string): Preset {
	const tokens = THEME_PRESETS[id]?.tokens
	const pane = token(tokens, '--pane')
	const white = (name: string) => over('#ffffff', whiteAlpha(token(tokens, name)), pane)
	return {
		pane,
		text0: token(tokens, '--text-0'),
		text1: token(tokens, '--text-1'),
		accent: token(tokens, '--accent'),
		accentFill: token(tokens, '--accent-fill'),
		onAccent: token(tokens, '--on-accent'),
		hairline: white('--hairline'),
		fillSubtle: white('--fill-subtle'),
		fillStrong: white('--fill-strong'),
	}
}

export const HELM = preset('helm')
export const HIGH = preset('high-contrast')

/** Off switch, the same in every variant: --fill-subtle track, --hairline edge, --text-0 knob. */
export function offFacts(): string[] {
	return [
		`vypnutý: okraj --hairline vůči pane ${ratio(HELM.hairline, HELM.pane)} (HC ${ratio(HIGH.hairline, HIGH.pane)})`,
		`vypnutý: knoflík --text-0 vůči dráze ${ratio(HELM.text0, HELM.fillSubtle)}`,
	]
}

/** On switch: track vs pane (WCAG 1.4.11 non-text 3:1) and knob vs track, in both presets. */
export function onFacts(track: (p: Preset) => string, knob: (p: Preset) => string, label: string): string[] {
	return [
		`zapnutý ${label}: dráha vůči pane ${ratio(track(HELM), HELM.pane)} (HC ${ratio(track(HIGH), HIGH.pane)}), práh 3:1`,
		`knoflík vůči dráze ${ratio(knob(HELM), track(HELM))} (HC ${ratio(knob(HIGH), track(HIGH))})`,
	]
}
