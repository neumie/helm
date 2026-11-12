// D7 / D10 proposal helpers: token sets, Remote's own palette and the stacked-surface frame. The REAL Document Review
// and Helm Remote harnesses are imported by the story files themselves (stories stay out of the app tsc pass), and
// this module imports no story. Nothing here is imported by production code.
import type { ReactNode } from 'react'
import { THEME_PRESETS } from '../../../theme-presets'
import type { TokenOverrides } from '../proposal'

export const HELM = (THEME_PRESETS.helm?.tokens ?? {}) as TokenOverrides
export const HIGH_CONTRAST = (THEME_PRESETS['high-contrast']?.tokens ?? {}) as TokenOverrides

/** remote.css L26-37: the seven surface tokens Remote re-binds on its roots (plus its bubble grey). */
export const REMOTE_OWN = {
	'--pane': '#0d0d0d',
	'--chrome': '#1c1c1e',
	'--well': '#1a1a1a',
	'--hairline': 'rgb(255 255 255 / 8%)',
	'--hairline-strong': 'rgb(255 255 255 / 16%)',
	'--fill-subtle': 'rgb(255 255 255 / 5.5%)',
	'--fill-raised': 'rgb(255 255 255 / 11%)',
} as const

const REMOTE_KEYS = Object.keys(REMOTE_OWN) as (keyof typeof REMOTE_OWN)[]

/** Scoped CSS that replaces Remote's own seven surface tokens with `source` values (story-only). */
export function remoteSurfacesFrom(source: Readonly<Record<string, string>>): string {
	const declarations = REMOTE_KEYS.map(key => `${key}: ${source[key] ?? ''};`).join(' ')
	return `.proposal-stage .remote-workspace { ${declarations} }`
}

/** Window height for the stacked surfaces: both are 100dvh windows in production. */
const STAGE_CSS = `
.proposal-stage .d7-surface { border-bottom: 1px solid var(--hairline-strong); }
.proposal-stage .d7-surface-label {
	padding: 4px 16px;
	background: var(--chrome);
	color: var(--text-1);
	font: 11px / 16px var(--font-mono);
}
.proposal-stage .d7-surface .document-review,
.proposal-stage .d7-surface .remote-workspace { height: 640px; }
`

export function stageCss(extra = ''): string {
	return `${STAGE_CSS}\n${extra}`
}

export const REVIEW_LABEL = 'Document Review · spec.md'
export const REMOTE_LABEL = 'Helm Remote · desktop width'

/** One stacked window with a quiet label above it. */
export function Surface({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section className="d7-surface">
			<div className="d7-surface-label">{label}</div>
			{children}
		</section>
	)
}
