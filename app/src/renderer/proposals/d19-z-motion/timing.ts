// D19 Remote entrance timings (docs/plans/design-system/proposals/D19.md). One Timing per variant: every Remote
// entrance with the duration and easing that variant gives it. `remoteTimingCss` turns it into the CSS appended
// inside a story frame, after every app stylesheet. Nothing here is imported by production code.

/** The Remote entrances D19 names, grouped by the keyframes they share. */
export type Surface = 'view' | 'rail' | 'scrim' | 'drawer' | 'sheet' | 'popover'

export interface Motion {
	/** CSS duration, e.g. `160ms` or `var(--motion-enter)`. */
	duration: string
	/** CSS timing function, e.g. `ease-out` or `var(--ease-out)`. */
	easing: string
	/** The same in plain words for the caption, e.g. "150ms (--motion-enter) · ease-out". */
	label: string
}

export type Timing = Readonly<Record<Surface, Motion>>

/** Which production elements each surface is (`remote.css`). */
export const SELECTORS: Readonly<Record<Surface, readonly string[]>> = {
	view: ['.remote-information-view', '.remote-usage'],
	rail: ['.remote-information-rail'],
	scrim: ['.remote-navigation-dismiss', '.remote-sheet-dismiss'],
	drawer: ['.remote-navigation-menu'],
	sheet: ['.remote-sheet'],
	popover: ['.remote-composer-actions .menu-panel', '.remote-row-menu'],
}

export const SURFACE_LABEL: Readonly<Record<Surface, string>> = {
	view: 'Info a Usage (pohled přes chat)',
	rail: 'Info vpravo (≥1200px)',
	scrim: 'Ztmavení pod šuplíkem a listem',
	drawer: 'Šuplík navigace',
	sheet: 'List voleb (More, Model)',
	popover: 'Malé menu u tlačítka',
}

export const SURFACES = Object.keys(SELECTORS) as Surface[]

const CURVE = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** Reads a :root token from the real tokens.css the Storybook preview loads (packages/helm-ui/tokens/motion.ts). */
function token(name: string, fallback: string): string {
	if (typeof document === 'undefined') return fallback
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}
const ENTER = token('--motion-enter', '150ms')
const STATE = token('--motion-state', '140ms')

const raw = (duration: string, easing: string): Motion => ({ duration, easing, label: `${duration} · ${easing}` })

/** Today (remote.css). */
export const CURRENT: Timing = {
	view: raw('160ms', 'ease-out'),
	rail: raw('160ms', 'ease-out'),
	scrim: raw('160ms', 'ease-out'),
	drawer: raw('180ms', CURVE),
	sheet: raw('180ms', CURVE),
	popover: {
		duration: 'var(--motion-state)',
		easing: 'var(--ease-out)',
		label: `${STATE} (--motion-state) · ease-out`,
	},
}

const enter: Motion = {
	duration: 'var(--motion-enter)',
	easing: 'var(--ease-out)',
	label: `${ENTER} (--motion-enter) · ease-out`,
}

/** A: every entrance on --motion-enter + --ease-out. */
export const SNAP: Timing = { view: enter, rail: enter, scrim: enter, drawer: enter, sheet: enter, popover: enter }

const large: Motion = {
	duration: 'var(--motion-enter-large)',
	easing: 'var(--ease-enter-large)',
	label: '180ms (nový --motion-enter-large) · nová --ease-enter-large',
}

/** B: drawer and sheet on two new tokens with today's values, the rest on --motion-enter. */
export const LARGE: Timing = { view: enter, rail: enter, scrim: enter, drawer: large, sheet: large, popover: enter }

/** C: today's values, written as Remote §3 metrics (the CSS is the same as today). */
export const METRIC: Timing = CURRENT

/** The tokens B would add to §2.5 (story-only here, on the frame's :root). */
export const NEW_TOKENS_CSS = `:root { --motion-enter-large: 180ms; --ease-enter-large: ${CURVE}; }`

/**
 * CSS for one frame. `!important` because the global reduced-motion clamp is `!important` too: with macOS
 * "Reduce motion" on, the replay would otherwise show nothing. Current's values are production's.
 */
export function remoteTimingCss(timing: Timing): string {
	const rules = SURFACES.map(surface => {
		const { duration, easing } = timing[surface]
		return `${SELECTORS[surface].join(', ')} { animation-duration: ${duration} !important; animation-timing-function: ${easing} !important; animation-iteration-count: 1 !important; }`
	})
	return [NEW_TOKENS_CSS, ...rules].join('\n')
}

/** Duration in ms for the curve chart (resolves the tokens this file uses). */
export function durationMs(motion: Motion): number {
	const values: Record<string, string> = {
		'var(--motion-enter)': ENTER,
		'var(--motion-state)': STATE,
		'var(--motion-enter-large)': '180ms',
	}
	return Number.parseFloat(values[motion.duration] ?? motion.duration)
}

const EASINGS: Record<string, readonly [number, number, number, number]> = {
	'ease-out': [0, 0, 0.58, 1],
	'var(--ease-out)': [0, 0, 0.58, 1],
	[CURVE]: [0.22, 1, 0.36, 1],
	'var(--ease-enter-large)': [0.22, 1, 0.36, 1],
}

/** Progress (0–1) of a CSS cubic-bezier easing at time fraction `t`. */
export function ease(easing: string, t: number): number {
	const points = EASINGS[easing]
	if (points === undefined) return t
	const [x1, y1, x2, y2] = points
	const bezier = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 * s + 3 * b * (1 - s) * s ** 2 + s ** 3
	// Bisection on x(s) = t, then y(s).
	let low = 0
	let high = 1
	for (let step = 0; step < 40; step++) {
		const mid = (low + high) / 2
		if (bezier(x1, x2, mid) < t) low = mid
		else high = mid
	}
	return bezier(y1, y2, (low + high) / 2)
}

/** Ms until the surface has covered `share` of its way (e.g. 0.9 → "90 % cesty"). */
export function msToShare(motion: Motion, share: number): number {
	const total = durationMs(motion)
	for (let ms = 0; ms <= total; ms++) if (ease(motion.easing, ms / total) >= share) return ms
	return total
}
