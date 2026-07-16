// Built-in theme presets — the single source for shipped token values.
// Shared by main (seeds <userData>/themes/*.json on first run) and the
// renderer (Reset to preset + fallback values for missing tokens).
//
// A theme is a flat JSON object of design-token overrides (CSS custom
// properties, docs/design-system.md §2.8). "Helm" mirrors the :root defaults
// in renderer/styles.css exactly. There is deliberately NO light preset:
// §2.1 declares the background ladder dark-only — the white-alpha
// hairline/fill system and the terminal palette assume a dark surface — so
// the second preset is High Contrast (brighter text ladder, stronger lines,
// brighter ANSI) instead.

export interface ThemeDefinition {
	name: string
	tokens: Record<string, string>
}

const HELM_TOKENS: Record<string, string> = {
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
	'--text-2': '#62666e',
	// Accent & semantic tones (soft fills derive via color-mix 15%, §2.8)
	'--accent': '#4c9aff',
	'--accent-fill': '#3b82f6',
	'--accent-fill-hover': '#5a9dff',
	'--on-accent': '#ffffff',
	'--success': '#4ec98a',
	'--warn': '#e0b341',
	'--danger': '#f2585b',
	'--neutral': '#8a8f98',
	// Scroll thumbs + toast countdown share one alpha pair (§3.17)
	'--thumb': 'rgba(255, 255, 255, 0.14)',
	'--thumb-hover': 'rgba(255, 255, 255, 0.24)',
	// Terminal overlay scrollbar (§3.14) — brighter pair; floats over --well
	'--term-scroll-thumb': 'rgba(255, 255, 255, 0.22)',
	'--term-scroll-thumb-hover': 'rgba(255, 255, 255, 0.35)',
	'--scrim': 'rgba(0, 0, 0, 0.4)',
	'--shadow-1': '0 8px 24px rgba(0, 0, 0, 0.35)',
	'--shadow-2': '0 10px 30px -8px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.35)',
	// Terminal surface (defaults mirror --well / --text-0 / --accent)
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
	'--ansi-bright-black': '#5b6068',
	'--ansi-bright-red': '#ff7477',
	'--ansi-bright-green': '#6fe0a8',
	'--ansi-bright-yellow': '#f2cd6d',
	'--ansi-bright-blue': '#78b5ff',
	'--ansi-bright-magenta': '#d5a9f0',
	'--ansi-bright-cyan': '#74dcea',
	'--ansi-bright-white': '#f5f6f7',
}

const HIGH_CONTRAST_TOKENS: Record<string, string> = {
	...HELM_TOKENS,
	'--chrome': '#16181b',
	'--pane': '#0c0d0f',
	'--well': '#000000',
	'--hairline': 'rgba(255, 255, 255, 0.16)',
	'--hairline-strong': 'rgba(255, 255, 255, 0.32)',
	'--fill-subtle': 'rgba(255, 255, 255, 0.09)',
	'--fill-raised': 'rgba(255, 255, 255, 0.16)',
	'--fill-strong': 'rgba(255, 255, 255, 0.22)',
	'--text-0': '#ffffff',
	'--text-1': '#c2c7cf',
	'--text-2': '#9096a0',
	'--accent': '#6fb1ff',
	'--accent-fill': '#3574de',
	'--accent-fill-hover': '#5093f5',
	'--success': '#5fe3a1',
	'--warn': '#f0c65a',
	'--danger': '#ff6b6e',
	'--neutral': '#a6adb8',
	'--thumb': 'rgba(255, 255, 255, 0.28)',
	'--thumb-hover': 'rgba(255, 255, 255, 0.44)',
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

/** Preset ids double as theme filenames (<id>.json). Order = picker order. */
export const THEME_PRESETS: Record<string, ThemeDefinition> = {
	helm: { name: 'Helm', tokens: HELM_TOKENS },
	'high-contrast': { name: 'High contrast', tokens: HIGH_CONTRAST_TOKENS },
}

export const DEFAULT_THEME_ID = 'helm'
