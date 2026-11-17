// Colour tokens (docs/design-system.md §2.1, §2.8): the only place a Helm colour value is written. The generator
// (`npm run tokens:write`, packages/helm-ui/scripts/tokens.ts) copies them into every surface that needs a literal:
// the app `:root`, the theme presets module, the extension's `--vg-*` block and popup `:root`, the Remote PWA,
// Storybook's canvas backgrounds and the native window backgrounds. Change a value here, run the generator, commit
// both. A changed preset value also appends the value it replaces to PRESET_EARLIER_VALUES (§9 ruling 97).

/** The Helm preset (§2.1). Key order is the order of the theme file main writes (`presetFileContent`). */
export const HELM_TOKENS = {
	// Background ladder (§2.1)
	'--chrome': '#1a1c1f',
	'--pane': '#141517',
	'--well': '#0f1113',
	// Lines & fills
	'--hairline': 'rgba(255, 255, 255, 0.07)',
	'--hairline-strong': 'rgba(255, 255, 255, 0.16)',
	'--fill-subtle': 'rgba(255, 255, 255, 0.05)',
	'--fill-raised': 'rgba(255, 255, 255, 0.09)',
	'--fill-strong': 'rgba(255, 255, 255, 0.13)',
	// Text ladder
	'--text-0': '#ececee',
	'--text-1': '#9a9ea6',
	'--text-2': '#7f848d',
	// Accent & semantic tones (soft fills derive via color-mix 15%, §2.8)
	'--accent': '#4c9aff',
	'--accent-fill': '#1e6ff5',
	'--accent-fill-hover': '#0b63f4',
	'--on-accent': '#ffffff',
	'--success': '#4ec98a',
	'--warn': '#e0b341',
	'--danger': '#f46e70',
	'--neutral': '#969ba3',
	// User-selectable terminal group palette (§3.18)
	'--group-blue': '#4c9aff',
	'--group-purple': '#c08ae0',
	'--group-pink': '#e477b5',
	'--group-red': '#f2585b',
	'--group-orange': '#e08a41',
	'--group-green': '#4ec98a',
	'--group-cyan': '#54c6d6',
	// Scroll thumbs + toast countdown share one alpha pair (§3.17)
	'--thumb': 'rgba(255, 255, 255, 0.14)',
	'--thumb-hover': 'rgba(255, 255, 255, 0.24)',
	// Terminal overlay scrollbar (§3.14): a brighter pair; it floats over --well with no track fill behind it
	'--term-scroll-thumb': 'rgba(255, 255, 255, 0.22)',
	'--term-scroll-thumb-hover': 'rgba(255, 255, 255, 0.35)',
	'--scrim': 'rgba(0, 0, 0, 0.4)',
	'--shadow-1': '0 8px 24px rgba(0, 0, 0, 0.35)',
	'--shadow-2': '0 10px 30px -8px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.35)',
	// Terminal surface (defaults mirror --well / --text-0 / --accent); appearance.ts builds the xterm theme from them
	'--term-bg': '#0f1113',
	'--term-fg': '#ececee',
	'--term-cursor': '#4c9aff',
	'--term-cursor-accent': '#0f1113',
	'--term-selection': 'rgba(76, 154, 255, 0.25)',
	// ANSI 16 (§3.14 canonical palette)
	'--ansi-black': '#2a2e33',
	'--ansi-red': '#f2585b',
	'--ansi-green': '#4ec98a',
	'--ansi-yellow': '#e0b341',
	'--ansi-blue': '#4c9aff',
	'--ansi-magenta': '#c08ae0',
	'--ansi-cyan': '#54c6d6',
	'--ansi-white': '#c9ccd1',
	'--ansi-bright-black': '#767c86',
	'--ansi-bright-red': '#ff7477',
	'--ansi-bright-green': '#6fe0a8',
	'--ansi-bright-yellow': '#f2cd6d',
	'--ansi-bright-blue': '#78b5ff',
	'--ansi-bright-magenta': '#d5a9f0',
	'--ansi-bright-cyan': '#74dcea',
	'--ansi-bright-white': '#f5f6f7',
} as const satisfies Record<string, string>

/** A theme token: a name a preset sets, and the only names a theme file may set (§2.8). */
export type ThemeToken = keyof typeof HELM_TOKENS

/**
 * High contrast (§2.8, §9 ruling 92): brighter text ladder, stronger lines (control edges reach 3:1), deeper wells,
 * a primary fill white text reaches 4.5:1 on, brighter ANSI. Every token it does not list is Helm's.
 */
const HIGH_CONTRAST_OVERRIDES: Partial<Record<ThemeToken, string>> = {
	'--chrome': '#16181b',
	'--pane': '#0c0d0f',
	'--well': '#000000',
	'--hairline': 'rgba(255, 255, 255, 0.34)',
	'--hairline-strong': 'rgba(255, 255, 255, 0.48)',
	'--fill-subtle': 'rgba(255, 255, 255, 0.09)',
	'--fill-raised': 'rgba(255, 255, 255, 0.16)',
	'--fill-strong': 'rgba(255, 255, 255, 0.22)',
	'--text-0': '#ffffff',
	'--text-1': '#c2c7cf',
	'--text-2': '#9096a0',
	'--accent': '#6fb1ff',
	'--accent-fill': '#3473de',
	'--accent-fill-hover': '#2367da',
	'--success': '#5fe3a1',
	'--warn': '#f0c65a',
	'--danger': '#ff6b6e',
	'--neutral': '#a6adb8',
	'--group-blue': '#6fb1ff',
	'--group-purple': '#d9a7f2',
	'--group-pink': '#f294c8',
	'--group-red': '#ff6b6e',
	'--group-orange': '#f0a35a',
	'--group-green': '#5fe3a1',
	'--group-cyan': '#6ee2f0',
	'--thumb': 'rgba(255, 255, 255, 0.36)',
	'--thumb-hover': 'rgba(255, 255, 255, 0.5)',
	'--term-scroll-thumb': 'rgba(255, 255, 255, 0.35)',
	'--term-scroll-thumb-hover': 'rgba(255, 255, 255, 0.5)',
	'--scrim': 'rgba(0, 0, 0, 0.55)',
	'--term-bg': '#000000',
	'--term-fg': '#ffffff',
	'--term-cursor': '#6fb1ff',
	'--term-cursor-accent': '#000000',
	'--term-selection': 'rgba(111, 177, 255, 0.35)',
	'--ansi-black': '#33383f',
	'--ansi-red': '#ff6b6e',
	'--ansi-green': '#5fe3a1',
	'--ansi-yellow': '#f0c65a',
	'--ansi-blue': '#6fb1ff',
	'--ansi-magenta': '#d9a7f2',
	'--ansi-cyan': '#6ee2f0',
	'--ansi-white': '#e8eaee',
	'--ansi-bright-black': '#767d87',
	'--ansi-bright-red': '#ff8f91',
	'--ansi-bright-green': '#8af0be',
	'--ansi-bright-yellow': '#ffdf85',
	'--ansi-bright-blue': '#9cc8ff',
	'--ansi-bright-magenta': '#e7c2fa',
	'--ansi-bright-cyan': '#a1ecf6',
	'--ansi-bright-white': '#ffffff',
}

export const HIGH_CONTRAST_TOKENS: Record<ThemeToken, string> = { ...HELM_TOKENS, ...HIGH_CONTRAST_OVERRIDES }

export interface ThemePreset {
	name: string
	tokens: Readonly<Record<ThemeToken, string>>
}

/** Preset ids double as theme filenames (`<id>.json`). Order = picker order. */
export const THEME_PRESETS = {
	helm: { name: 'Helm', tokens: HELM_TOKENS },
	'high-contrast': { name: 'High contrast', tokens: HIGH_CONTRAST_TOKENS },
} as const satisfies Record<string, ThemePreset>

export const DEFAULT_THEME_ID = 'helm'

/**
 * Values a bundled preset carried in an earlier release, per token (§9 ruling 97). A seeded preset file whose
 * every token equals the current preset or one of these values was written by Helm and never edited, so main
 * rewrites it at startup; files seeded before main recorded fingerprints (`themes/.seeded.json`) are recognised
 * only this way. When a preset value changes, append the value it replaces here.
 */
export const PRESET_EARLIER_VALUES: Record<
	keyof typeof THEME_PRESETS,
	Partial<Record<ThemeToken, readonly string[]>>
> = {
	// Before D5 (§9 rulings 89, 90, 92; 0b4934b 2026-11-13) and before D15 (§9 rulings 110–112; edd33f9 2026-11-17).
	helm: {
		'--text-2': ['#62666e'],
		'--accent-fill': ['#3b82f6'],
		'--accent-fill-hover': ['#5a9dff'],
		'--danger': ['#f2585b'],
		'--neutral': ['#8a8f98'],
		'--ansi-bright-black': ['#5b6068'],
	},
	'high-contrast': {
		'--hairline': ['rgba(255, 255, 255, 0.16)'],
		'--hairline-strong': ['rgba(255, 255, 255, 0.32)'],
		'--accent-fill': ['#3574de'],
		'--accent-fill-hover': ['#5093f5'],
		'--thumb': ['rgba(255, 255, 255, 0.28)'],
		'--thumb-hover': ['rgba(255, 255, 255, 0.44)'],
	},
}

/** The user-selectable terminal group colours (§3.18); `--group-<colour>` is a theme token for each. */
export const GROUP_COLORS = ['blue', 'purple', 'pink', 'red', 'orange', 'green', 'cyan'] as const

/**
 * Colours derived from the tones on `:root` (§2.8): soft fills at exactly 15%, the strong danger edge, and the
 * accent-text alias (§9 ruling 87). Themes override the tone; these follow. Never hand-mix per component.
 */
export const DERIVED_COLOR_TOKENS = {
	'--accent-soft': 'color-mix(in srgb, var(--accent) 15%, transparent)',
	'--success-soft': 'color-mix(in srgb, var(--success) 15%, transparent)',
	'--warn-soft': 'color-mix(in srgb, var(--warn) 15%, transparent)',
	'--danger-soft': 'color-mix(in srgb, var(--danger) 15%, transparent)',
	'--neutral-soft': 'color-mix(in srgb, var(--neutral) 15%, transparent)',
	'--danger-strong': 'color-mix(in srgb, var(--danger) 50%, transparent)',
	'--accent-text': 'var(--accent)',
} as const satisfies Record<string, string>

/**
 * Document Review's scoped light reading palette (§3.26, §9 rulings 10 and 94): the one operator-approved light
 * exception, written into `.document-review[data-review-theme="light"]` and the light window background.
 */
export const REVIEW_LIGHT_TOKENS = {
	'--chrome': '#f1f0ed',
	'--pane': '#faf9f6',
	'--well': '#ebeae6',
	'--text-0': '#24272c',
	'--text-1': '#60646c',
	'--text-2': '#62666e',
	'--hairline': 'rgba(0, 0, 0, 0.07)',
	'--hairline-strong': 'rgba(0, 0, 0, 0.16)',
	'--thumb': 'color-mix(in srgb, var(--text-0) 14%, transparent)',
	'--thumb-hover': 'color-mix(in srgb, var(--text-0) 24%, transparent)',
	'--fill-subtle': 'rgba(0, 0, 0, 0.05)',
	'--fill-raised': 'rgba(0, 0, 0, 0.09)',
	'--fill-strong': 'rgba(0, 0, 0, 0.13)',
	'--accent': '#176ac1',
	'--accent-fill': '#176ac1',
	'--accent-fill-hover': '#125ba8',
	'--danger': '#b91c1c',
	'--warn': '#8a5a0a',
	'--success': '#267347',
	'--neutral': '#656a73',
	'--danger-soft': 'color-mix(in srgb, var(--danger) 15%, transparent)',
	'--warn-soft': 'color-mix(in srgb, var(--warn) 15%, transparent)',
	'--neutral-soft': 'color-mix(in srgb, var(--neutral) 15%, transparent)',
} as const satisfies Record<string, string>
