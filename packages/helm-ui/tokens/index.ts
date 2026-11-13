// Helm's design tokens: the single source (docs/design-system.md §2, §9 rulings 104 and 106). Every value is written
// once in this folder; `npm run tokens:write` (packages/helm-ui/scripts/tokens.ts) writes the copies each surface
// needs, and tests/design-tokens.test.ts fails when one is stale. App and extension production code never import
// this folder (their tsconfigs include only their own `src`); they read the generated files.
import {
	DEFAULT_THEME_ID,
	DERIVED_COLOR_TOKENS,
	GROUP_COLORS,
	HELM_TOKENS,
	HIGH_CONTRAST_TOKENS,
	PRESET_EARLIER_VALUES,
	REVIEW_LIGHT_TOKENS,
	THEME_PRESETS,
	type ThemePreset,
	type ThemeToken,
} from './color.ts'
import { MOTION_TOKENS, SCRIPT_EASINGS, SCRIPT_MOTION_MS } from './motion.ts'
import { RADIUS_TOKENS } from './radius.ts'
import { SURFACE_TOKENS } from './surface.ts'
import { TYPE_TOKENS } from './type.ts'
import { Z_TOKENS } from './z.ts'

export {
	DEFAULT_THEME_ID,
	DERIVED_COLOR_TOKENS,
	GROUP_COLORS,
	HELM_TOKENS,
	HIGH_CONTRAST_TOKENS,
	MOTION_TOKENS,
	PRESET_EARLIER_VALUES,
	RADIUS_TOKENS,
	REVIEW_LIGHT_TOKENS,
	SCRIPT_EASINGS,
	SCRIPT_MOTION_MS,
	SURFACE_TOKENS,
	THEME_PRESETS,
	TYPE_TOKENS,
	Z_TOKENS,
	type ThemePreset,
	type ThemeToken,
}

/** The names a theme (preset or user file) may set: the preset keys (§2.8). */
export const THEME_TOKEN_NAMES: readonly ThemeToken[] = Object.keys(HELM_TOKENS) as ThemeToken[]

/**
 * The app `:root` (`app/src/renderer/tokens.css`), in groups. The colour group is the Helm preset, for the pre-JS
 * first paint; appearance.ts re-applies the active theme over it.
 */
export const ROOT_GROUPS: readonly { comment: string; tokens: Readonly<Record<string, string>> }[] = [
	{ comment: 'Theme colours: the Helm preset (§2.1, §2.8)', tokens: HELM_TOKENS },
	{
		comment: 'Derived colours: soft fills at exactly 15%, the strong danger edge, the accent-text alias (§2.8)',
		tokens: DERIVED_COLOR_TOKENS,
	},
	{ comment: 'Type families and the UI text scale (§2.2)', tokens: TYPE_TOKENS },
	{ comment: 'Radii (§2.4)', tokens: RADIUS_TOKENS },
	{ comment: 'Motion (§2.5)', tokens: MOTION_TOKENS },
	{ comment: 'Z-layers (§2.7)', tokens: Z_TOKENS },
	{ comment: 'Surfaces and layout', tokens: SURFACE_TOKENS },
]

/** Every `:root` token, name → value. */
export const ROOT_TOKENS: Readonly<Record<string, string>> = Object.assign({}, ...ROOT_GROUPS.map(g => g.tokens))

/**
 * The extension widget's `:host` block (`extension/src/widget.styles.ts`): `--vg-` names for the closed shadow root,
 * each the value of a `:root` token, or a soft fill over the widget's own tone (§2, §3.28, §9 ruling 104).
 */
export const EXTENSION_HOST: readonly (
	| { name: string; token: string }
	| { name: string; soft: string }
	| { comment: string }
)[] = [
	{ comment: 'Background ladder (§2.1)' },
	{ name: '--vg-chrome', token: '--chrome' },
	{ name: '--vg-pane', token: '--pane' },
	{ comment: 'Lines & fills' },
	{ name: '--vg-hairline', token: '--hairline' },
	{ name: '--vg-hairline-strong', token: '--hairline-strong' },
	{ name: '--vg-fill-subtle', token: '--fill-subtle' },
	{ name: '--vg-fill-raised', token: '--fill-raised' },
	{ name: '--vg-fill-strong', token: '--fill-strong' },
	{ name: '--vg-thumb', token: '--thumb' },
	{ comment: 'Text ladder' },
	{ name: '--vg-text-0', token: '--text-0' },
	{ name: '--vg-text-1', token: '--text-1' },
	{ name: '--vg-text-2', token: '--text-2' },
	{ comment: 'Accent & semantic tones; soft fills derived at exactly 15% (§2.1)' },
	{ name: '--vg-accent', token: '--accent' },
	{ name: '--vg-accent-fill', token: '--accent-fill' },
	{ name: '--vg-accent-fill-hover', token: '--accent-fill-hover' },
	{ name: '--vg-on-accent', token: '--on-accent' },
	{ name: '--vg-green', token: '--success' },
	{ name: '--vg-amber', token: '--warn' },
	{ name: '--vg-red', token: '--danger' },
	{ name: '--vg-blue', token: '--accent' },
	{ name: '--vg-gray', token: '--neutral' },
	{ name: '--vg-accent-soft', soft: '--vg-accent' },
	{ name: '--vg-green-soft', soft: '--vg-green' },
	{ name: '--vg-amber-soft', soft: '--vg-amber' },
	{ name: '--vg-red-soft', soft: '--vg-red' },
	{ name: '--vg-blue-soft', soft: '--vg-blue' },
	{ name: '--vg-gray-soft', soft: '--vg-gray' },
	{ comment: 'Radii ladder 8/6/4 (§2.4); elevation (§2.6)' },
	{ name: '--vg-radius-lg', token: '--radius-lg' },
	{ name: '--vg-radius-md', token: '--radius-md' },
	{ name: '--vg-radius-sm', token: '--radius-sm' },
	{ name: '--vg-shadow-1', token: '--shadow-1' },
	{ name: '--vg-shadow-2', token: '--shadow-2' },
	{ comment: 'Motion (§2.5) and z-layers (§2.7)' },
	{ name: '--vg-motion-exit', token: '--motion-exit' },
	{ name: '--vg-motion-state', token: '--motion-state' },
	{ name: '--vg-motion-enter', token: '--motion-enter' },
	{ name: '--vg-motion-pulse', token: '--motion-pulse' },
	{ name: '--vg-ease-out', token: '--ease-out' },
	{ name: '--vg-ease-ambient', token: '--ease-ambient' },
	{ name: '--vg-z-menu', token: '--z-menu' },
	{ name: '--vg-z-widget-host', token: '--z-widget-host' },
	{ comment: 'Type families (§2.2)' },
	{ name: '--vg-font', token: '--font-ui' },
	{ name: '--vg-mono', token: '--font-mono' },
]

/** The extension popup's `:root` (`extension/src/popup.html`, §9 ruling 103): the Helm tokens it paints, plain names. */
export const POPUP_ROOT: readonly string[] = [
	'--pane',
	'--hairline',
	'--hairline-strong',
	'--fill-subtle',
	'--text-0',
	'--text-1',
	'--text-2',
	'--accent',
	'--accent-fill',
	'--success',
	'--danger',
	'--font-ui',
]

/** The Remote PWA's offline page `:root` (`app/assets/remote/remote-sw.js`; it cannot load tokens.css, §9 ruling 96). */
export const REMOTE_OFFLINE_ROOT: readonly string[] = ['--pane', '--text-0', '--text-1', '--accent']

/** Storybook's canvas backgrounds (`app/.storybook/backgrounds.generated.ts`): the §2.1 ladder; Pane is the default. */
export const STORYBOOK_BACKGROUNDS: readonly { id: string; name: string; token: ThemeToken }[] = [
	{ id: 'pane', name: 'Pane', token: '--pane' },
	{ id: 'chrome', name: 'Chrome', token: '--chrome' },
	{ id: 'well', name: 'Well', token: '--well' },
]

/** One `:root` token's value; throws on an unknown name so a mapping typo fails the generator. */
export function rootToken(name: string): string {
	const value = ROOT_TOKENS[name]
	if (value === undefined) throw new Error(`Unknown token ${name}`)
	return value
}
