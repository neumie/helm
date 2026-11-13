// Built-in theme presets. Shared by main (seeds and upgrades <userData>/themes/*.json, theme-files.ts) and the
// renderer (Reset to preset + fallback values for missing tokens).
//
// A theme is a flat JSON object of design-token overrides (CSS custom properties, docs/design-system.md §2.8).
// The values are written once in packages/helm-ui/tokens and reach the app through the generated
// design-tokens.generated.ts (`npm run tokens:write`); change them there, never here. There is deliberately NO
// light preset: §2.1 declares the background ladder dark-only (the white-alpha hairline/fill system and the
// terminal palette assume a dark surface), so the second preset is High contrast instead.
import {
	DEFAULT_THEME_ID,
	HELM_TOKENS,
	HIGH_CONTRAST_TOKENS,
	PRESET_EARLIER_VALUES,
	THEME_PRESET_NAMES,
	THEME_TOKEN_NAMES,
} from './design-tokens.generated'

export interface ThemeDefinition {
	name: string
	tokens: Record<string, string>
}

const PRESET_TOKENS: Record<string, Readonly<Record<string, string>>> = {
	helm: HELM_TOKENS,
	'high-contrast': HIGH_CONTRAST_TOKENS,
}

/** Preset ids double as theme filenames (<id>.json). Order = picker order. */
export const THEME_PRESETS: Record<string, ThemeDefinition> = Object.fromEntries(
	Object.entries(THEME_PRESET_NAMES).map(([id, name]) => [id, { name, tokens: { ...PRESET_TOKENS[id] } }]),
)

export { DEFAULT_THEME_ID, PRESET_EARLIER_VALUES, THEME_TOKEN_NAMES }
