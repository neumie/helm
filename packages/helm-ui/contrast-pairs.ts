// Measured contrast of every foreground/background token pair Helm draws (docs/design-system.md §2.9).
//
// Each row stores the ratio printed in §2.9 (two decimals, truncated). `tests/design-contrast.test.ts`
// recomputes every row from the palettes below and fails when a stored ratio differs, when a pair misses
// its need without an `OPEN` or `EXEMPT` entry, or when such an entry starts passing (stale). An open entry
// names the decision in docs/plans/design-system/spec.md that owns it; an exempt entry names the
// docs/design-system.md §9 ruling that exempts it. Either leaves only by a token change or a ruling, never
// quietly. `packages/helm-ui/scripts/contrast-table.ts` writes the §2.9 table from `ROWS`.
//
// Values come from the current sources (until stage S2 generates them from one token module):
// the bundled presets (`app/src/theme-presets.ts`), and verbatim copies of the CSS declarations
// below, each pinned to its file by `SOURCES` (the test fails when a source changes). A palette is a
// list of CSS scopes, outermost first, so `var()` inside a declaration resolves where the browser
// resolves it (contrast.ts). Translucent fills are composited over the surface named under them.
import { type Scopes, contrast, paint, truncate2 } from './contrast.ts'
import {
	DERIVED_COLOR_TOKENS,
	GROUP_COLORS,
	POPUP_ROOT,
	REVIEW_LIGHT_TOKENS,
	SURFACE_TOKENS,
	THEME_PRESETS,
} from './tokens/index.ts'

function presetTokens(id: string): Record<string, string> {
	const preset = THEME_PRESETS[id as keyof typeof THEME_PRESETS]
	if (!preset) throw new Error(`Missing theme preset ${id}`)
	return preset.tokens
}

/** The terminal group colours (§3.18); app/src/tab-group-colors.ts lists the same (tests/design-tokens.test.ts). */
const TAB_GROUP_COLORS = GROUP_COLORS
type TabGroupColor = (typeof GROUP_COLORS)[number]
const tabGroupColorCssVar = (color: TabGroupColor) => `var(--group-${color})`

/**
 * `app/src/renderer/tokens.css` `:root` colours beside the preset: those derived from the tones (§2.8: soft fills,
 * the Run Context banner's border, the accent-text alias, §9 ruling 87) and the PDF paper white (§3.27).
 */
const ROOT_DERIVED = { ...DERIVED_COLOR_TOKENS, '--paper': SURFACE_TOKENS['--paper'] }

/** `agent-dock/agent-dock.css` `.agent-dock` and `signals/signals.css` `.signals` (each declares it): the dim text of the dock and Signals (§3.24). */
const DOCK = {
	'--dock-dim': 'color-mix(in srgb, var(--text-1) 60%, var(--text-2))',
}

/** `app/src/renderer/remote/remote.css`: Remote draws on the app ladder (§9 ruling 96) and adds only its bubble grey. */
const REMOTE = {
	'--remote-bubble': '#2f2f2f',
}

/** `app/src/renderer/document-review/document-review.css`: the scoped light reading palette (generated there). */
const REVIEW_LIGHT = REVIEW_LIGHT_TOKENS

/** `app/src/renderer/viewer/viewer.css` `.viewer-window`: syntax colours (dark uses the ANSI ladder). */
const VIEWER_SYNTAX = {
	'--syntax-keyword': 'var(--ansi-magenta)',
	'--syntax-string': 'var(--ansi-green)',
	'--syntax-number': 'var(--ansi-cyan)',
	'--syntax-comment': 'var(--text-2)',
	'--syntax-type': 'var(--ansi-yellow)',
	'--syntax-function': 'var(--ansi-blue)',
	'--syntax-property': 'var(--ansi-white)',
	'--syntax-invalid': 'var(--ansi-red)',
}

/** `viewer.css` `.viewer-window[data-review-theme="light"]`. */
const VIEWER_SYNTAX_LIGHT = {
	'--syntax-keyword': '#8a3ab0',
	'--syntax-string': '#1f7347',
	'--syntax-number': '#0a6878',
	'--syntax-type': '#855708',
	'--syntax-function': '#1764b8',
	'--syntax-property': '#24272c',
	'--syntax-invalid': '#b91c1c',
}

/** The Helm colour tokens `extension/src/popup.html` carries in its own `:root` (§3.28, §9 ruling 103). */
const POPUP_TOKENS = POPUP_ROOT.filter(name => name !== '--font-ui')

/**
 * `terminal-tabs.css` and `background-terminals.css` terminal groups (§3.18): the group's colour comes from `--group-color`, set inline to
 * `var(--group-<colour>)` on the section. Keys name the declaration (property and selector in `SOURCES`).
 */
const TAB_GROUP = {
	/** `.tab-group-section` background: the strip band behind the header and its tabs. */
	'group band': 'color-mix(in srgb, var(--group-color) 15%, transparent)',
	/** `.tab-group-section .tab:hover` background (also the collapsed header's hover). */
	'group hover': 'color-mix(in srgb, var(--group-color) 22%, transparent)',
	/** `.tab-group-section .tab.active` background. */
	'group active': 'color-mix(in srgb, var(--group-color) 30%, transparent)',
	/** `.bg-group-header-row:hover` background (Background terminals list). */
	'group row hover': 'color-mix(in srgb, var(--group-color) 12%, transparent)',
	/** `.tab-group-section .tab` colour: a tab's title and ⌘N number in the band (§9 ruling 113). */
	'group tab': 'var(--text-1)',
	/** `.tab-group-section .tab:hover` colour. */
	'group tab hover': 'var(--text-0)',
	/** `.tab-group-toggle` colour: the group's name. */
	'group label': 'color-mix(in srgb, var(--group-color) 55%, var(--text-0))',
	/** `.tab-group-toggle:hover` colour. */
	'group label hover': 'var(--text-0)',
	/** `.tab-group-toggle .group-icon` colour: the folder glyph. */
	'group icon': 'var(--group-color)',
	/** `.tab-group-count` colour: the member count. */
	'group count': 'color-mix(in srgb, var(--group-color) 40%, var(--text-1))',
	/** `.bg-group-restore` colour: the ⇥ restore-all glyph. */
	'group restore': 'color-mix(in srgb, var(--group-color) 55%, var(--text-2))',
}

const BASE_PALETTES = {
	helm: {
		label: 'Helm',
		scopes: [{ ...presetTokens('helm'), ...ROOT_DERIVED }, DOCK],
	},
	'high-contrast': {
		label: 'High contrast',
		scopes: [{ ...presetTokens('high-contrast'), ...ROOT_DERIVED }, DOCK],
	},
	remote: {
		label: 'Remote',
		scopes: [{ ...presetTokens('helm'), ...ROOT_DERIVED }, REMOTE],
	},
	'review-light': {
		label: 'Review light',
		scopes: [{ ...presetTokens('helm'), ...ROOT_DERIVED }, REVIEW_LIGHT, VIEWER_SYNTAX, VIEWER_SYNTAX_LIGHT],
	},
	'viewer-dark': {
		label: 'Viewer (dark)',
		scopes: [{ ...presetTokens('helm'), ...ROOT_DERIVED }, VIEWER_SYNTAX],
	},
	popup: {
		label: 'Extension popup',
		scopes: [Object.fromEntries(POPUP_TOKENS.map(name => [name, presetTokens('helm')[name] ?? '']))],
	},
} as const satisfies Record<string, { label: string; scopes: Scopes }>

type Palette = { label: string; scopes: Scopes }
type GroupPreset = 'helm' | 'high-contrast'
type GroupPaletteId = `${GroupPreset}-group-${TabGroupColor}`

/** One palette per terminal group colour in each preset, so every group band is measured. */
function groupPalettes(): Record<GroupPaletteId, Palette> {
	const out: Partial<Record<GroupPaletteId, Palette>> = {}
	for (const preset of ['helm', 'high-contrast'] as const) {
		for (const colour of TAB_GROUP_COLORS) {
			out[`${preset}-group-${colour}`] = {
				label: `${BASE_PALETTES[preset].label}, ${colour} group`,
				scopes: [
					{ ...presetTokens(preset), ...ROOT_DERIVED },
					{ '--group-color': tabGroupColorCssVar(colour) },
					TAB_GROUP,
				],
			}
		}
	}
	return out as Record<GroupPaletteId, Palette>
}

export type PaletteId = keyof typeof BASE_PALETTES | GroupPaletteId

export const PALETTES: Record<PaletteId, Palette> = { ...BASE_PALETTES, ...groupPalettes() }

export const GROUP_PALETTES: readonly GroupPaletteId[] = (['helm', 'high-contrast'] as const).flatMap(preset =>
	TAB_GROUP_COLORS.map(colour => `${preset}-group-${colour}` as const),
)

/** Where each copied value lives; the test reads the file and compares the declaration verbatim. */
export interface SourceCheck {
	palette: PaletteId | 'widget'
	file: string
	/** Text that opens the CSS block (whitespace-insensitive), e.g. `:root {`. */
	block: string
	property: string
	/** Palette key the declaration supplies (default: `property`). */
	key?: string
	/** Expected value when it is not the palette's own value (the widget mirrors Helm under `--vg-`). */
	expect?: string
}

function declarations(palette: PaletteId, file: string, block: string, values: Record<string, string>): SourceCheck[] {
	return Object.keys(values).map(property => ({ palette, file, block, property }))
}

const TOKENS_CSS = 'app/src/renderer/tokens.css'
const TABS_CSS = 'app/src/renderer/terminal-tabs.css'
const BACKGROUND_CSS = 'app/src/renderer/background-terminals.css'
const DOCK_CSS = 'app/src/renderer/agent-dock/agent-dock.css'
const SIGNALS_CSS = 'app/src/renderer/signals/signals.css'
const REMOTE_CSS = 'app/src/renderer/remote/remote.css'
const REVIEW_CSS = 'app/src/renderer/document-review/document-review.css'
const VIEWER_CSS = 'app/src/renderer/viewer/viewer.css'
const POPUP_HTML = 'extension/src/popup.html'
const WIDGET = 'extension/src/widget.styles.ts'

/** The widget's `--vg-*` copies of Helm tokens: identical values, so its pairs are Helm's rows. */
const WIDGET_COPIES: Record<string, string> = {
	'--vg-chrome': '--chrome',
	'--vg-pane': '--pane',
	'--vg-hairline': '--hairline',
	'--vg-hairline-strong': '--hairline-strong',
	'--vg-fill-subtle': '--fill-subtle',
	'--vg-fill-raised': '--fill-raised',
	'--vg-fill-strong': '--fill-strong',
	'--vg-text-0': '--text-0',
	'--vg-text-1': '--text-1',
	'--vg-text-2': '--text-2',
	'--vg-thumb': '--thumb',
	'--vg-accent': '--accent',
	'--vg-accent-fill': '--accent-fill',
	'--vg-accent-fill-hover': '--accent-fill-hover',
	'--vg-on-accent': '--on-accent',
	'--vg-green': '--success',
	'--vg-amber': '--warn',
	'--vg-red': '--danger',
	'--vg-blue': '--accent',
	'--vg-gray': '--neutral',
}

/** The widget's soft fills: Helm's `ROOT_DERIVED` formula over its own `--vg-*` tones. */
const WIDGET_SOFT: Record<string, string> = {
	'--vg-accent-soft': '--vg-accent',
	'--vg-green-soft': '--vg-green',
	'--vg-amber-soft': '--vg-amber',
	'--vg-red-soft': '--vg-red',
	'--vg-blue-soft': '--vg-blue',
	'--vg-gray-soft': '--vg-gray',
}

const groupSource = (
	block: string,
	property: string,
	key: keyof typeof TAB_GROUP,
	file: string = TABS_CSS,
): SourceCheck[] => GROUP_PALETTES.map(palette => ({ palette, file, block, property, key }))

/** A popup.html rule that paints `token` (pinned so the measured pair is the one the popup draws). */
const popupRole = (block: string, property: string, token: string, prefix = ''): SourceCheck[] => [
	{ palette: 'popup', file: POPUP_HTML, block, property, key: token, expect: `${prefix}var(${token})` },
]

export const SOURCES: readonly SourceCheck[] = [
	...declarations('helm', TOKENS_CSS, ':root {', ROOT_DERIVED),
	...declarations('helm', DOCK_CSS, '.agent-dock {', DOCK),
	...declarations('helm', SIGNALS_CSS, '.signals {', DOCK),
	...declarations('remote', REMOTE_CSS, '.remote-workspace, .remote-login, .remote-empty {', REMOTE),
	...declarations('review-light', REVIEW_CSS, '.document-review[data-review-theme="light"] {', REVIEW_LIGHT),
	...declarations('viewer-dark', VIEWER_CSS, '.viewer-window {', VIEWER_SYNTAX),
	...declarations('review-light', VIEWER_CSS, '.viewer-window[data-review-theme="light"] {', VIEWER_SYNTAX_LIGHT),
	// The popup's :root copies the Helm values (palette 'popup' is those values), and each rule paints the token.
	...POPUP_TOKENS.map(property => ({ palette: 'popup' as const, file: POPUP_HTML, block: ':root {', property })),
	...popupRole('body {', 'background', '--pane'),
	...popupRole('body {', 'color', '--text-0'),
	...popupRole('h1 {', 'color', '--accent'),
	...popupRole('label {', 'color', '--text-1'),
	...popupRole('.models .group {', 'color', '--text-1'),
	...popupRole('.models .row {', 'color', '--text-0'),
	...popupRole('input[type="text"] {', 'background', '--fill-subtle'),
	...popupRole('input[type="text"] {', 'color', '--text-0'),
	...popupRole('input[type="text"] {', 'border', '--hairline', '1px solid '),
	...popupRole('input[type="text"]::placeholder {', 'color', '--text-1'),
	...popupRole(
		'input[type="text"]:hover, input[type="text"][data-force-state~="hover"] {',
		'border-color',
		'--hairline-strong',
	),
	...popupRole('input[type="text"]:focus {', 'border-color', '--accent'),
	...popupRole('.status--ok {', 'color', '--success'),
	...popupRole('.status--error {', 'color', '--danger'),
	...popupRole('.models .row input {', 'accent-color', '--accent-fill'),
	...groupSource('.tab-group-section {', 'background', 'group band'),
	...groupSource('.tab-group-section .tab:hover {', 'background', 'group hover'),
	...groupSource('.tab-group-section.collapsed > .tab-group-toggle:hover {', 'background', 'group hover'),
	...groupSource('.tab-group-section .tab.active {', 'background', 'group active'),
	...groupSource('.bg-group-header-row:hover {', 'background', 'group row hover'),
	...groupSource('.tab-group-toggle {', 'color', 'group label'),
	...groupSource('.tab-group-toggle:hover {', 'color', 'group label hover'),
	...groupSource('.tab-group-toggle .group-icon {', 'color', 'group icon'),
	...groupSource('.tab-group-section .tab {', 'color', 'group tab'),
	...groupSource('.tab-group-section .tab:hover {', 'color', 'group tab hover'),
	...groupSource('.tab-group-count {', 'color', 'group count'),
	...groupSource('.bg-group-restore {', 'color', 'group restore', BACKGROUND_CSS),
	...Object.entries(WIDGET_SOFT).map(([property, tone]) => ({
		palette: 'widget' as const,
		file: WIDGET,
		block: ':host {',
		property,
		expect: `color-mix(in srgb, var(${tone}) 15%, transparent)`,
	})),
	...Object.entries(WIDGET_COPIES).map(([property, key]) => ({
		palette: 'widget' as const,
		file: WIDGET,
		block: ':host {',
		property,
		key,
		expect: presetTokens('helm')[key],
	})),
]

/** `text` body/meta 4.5:1; `large-text` (≥ 24px, or ≥ 18.66px bold) and `ui` (control edges, focus, meaningful graphics) 3:1; `decorative` has no need. */
export type Use = 'text' | 'large-text' | 'ui' | 'decorative'

export const NEED: Record<Use, number | null> = { text: 4.5, 'large-text': 3, ui: 3, decorative: null }

export interface ContrastRow {
	palette: PaletteId
	fg: string
	/** Bottom-up layers: an opaque surface, then any translucent fills painted over it. */
	bg: readonly string[]
	use: Use
	/** The ratio printed in §2.9 (two decimals, truncated). */
	ratio: number
}

export interface OpenPair {
	palette: PaletteId
	fg: string
	bg: readonly string[]
	use: Use
	/** The decision in docs/plans/design-system/spec.md that owns the failure. */
	decision: `D${number}`
}

/** A failing pair a §9 ruling exempts from its need (decorative, or a pairing the ruling forbids drawing). */
export interface ExemptPair {
	palette: PaletteId
	fg: string
	bg: readonly string[]
	use: Use
	/** The §9 ruling in docs/design-system.md that exempts the pair. */
	ruling: number
}

// Background stacks shared by the dark palettes.
const CHROME = ['--chrome']
const PANE = ['--pane']
const WELL = ['--well']
const INPUT = ['--pane', '--fill-subtle']
const SELECTED = ['--pane', '--fill-raised']
const PRESSED = ['--pane', '--fill-strong']
const DOCK_SELECTED = ['--chrome', '--fill-raised']
const CHROME_HOVER = ['--chrome', '--fill-subtle']
const TERMINAL = ['--term-bg']
const BAND = ['--chrome', 'group band']
const BUBBLE = ['--remote-bubble']
const POPUP_INPUT = ['--pane', '--fill-subtle']

const row = (palette: PaletteId, fg: string, bg: readonly string[], use: Use, ratio: number): ContrastRow => ({
	palette,
	fg,
	bg,
	use,
	ratio,
})

/** Stored ratios of the terminal-group rows, per palette, in `groupRows` order. */
const GROUP_RATIOS: Record<GroupPaletteId, readonly number[]> = {
	'helm-group-blue': [5.05, 8.09, 7.07, 7.14, 8.09, 4.76, 4.82, 8.98, 7.51, 6.07, 5.08, 5.19],
	'helm-group-purple': [4.96, 7.78, 6.76, 7.39, 7.78, 5.05, 4.95, 9.46, 7.81, 6.33, 5.23, 5.48],
	'helm-group-pink': [5.04, 8.03, 7, 7.22, 8.03, 4.91, 4.85, 9.09, 7.61, 6.11, 5.11, 5.25],
	'helm-group-red': [5.28, 8.88, 7.87, 6.65, 8.88, 4.27, 4.54, 7.99, 6.93, 5.46, 4.74, 4.53],
	'helm-group-orange': [5.01, 7.89, 6.86, 7.33, 7.89, 5.05, 4.9, 9.3, 7.73, 6.22, 5.17, 5.37],
	'helm-group-green': [4.77, 7.04, 5.99, 7.86, 7.04, 6.14, 5.18, 10.45, 8.38, 6.88, 5.52, 6.23],
	'helm-group-cyan': [4.73, 6.9, 5.85, 7.97, 6.9, 6.31, 5.23, 10.69, 8.51, 7.02, 5.59, 6.4],
	'high-contrast-group-blue': [7.99, 8.87, 7.55, 8.86, 8.87, 6.08, 7.11, 11.61, 9.43, 9.31, 7.56, 6.95],
	'high-contrast-group-purple': [7.78, 8.31, 6.99, 9.28, 8.31, 6.77, 7.32, 12.48, 9.93, 9.85, 7.83, 7.54],
	'high-contrast-group-pink': [7.95, 8.73, 7.4, 8.99, 8.73, 6.33, 7.16, 11.84, 9.58, 9.42, 7.62, 7.08],
	'high-contrast-group-red': [8.46, 10.03, 8.7, 8.14, 10.03, 5.18, 6.66, 10.07, 8.55, 8.25, 7, 5.87],
	'high-contrast-group-orange': [7.92, 8.63, 7.3, 9.07, 8.63, 6.46, 7.19, 11.99, 9.67, 9.5, 7.67, 7.18],
	'high-contrast-group-green': [7.53, 7.61, 6.29, 9.69, 7.61, 7.91, 7.52, 13.48, 10.46, 10.46, 8.11, 8.33],
	'high-contrast-group-cyan': [7.41, 7.35, 6.04, 9.9, 7.35, 8.27, 7.63, 13.99, 10.72, 10.78, 8.26, 8.69],
}

/**
 * A terminal group in the strip (a band over `--chrome`: the tabs' `--text-1`, a hovered tab's `--text-0`,
 * the active tab's `--text-0`, the name, its hover on a collapsed header, the folder glyph, the count)
 * and in the Background terminals list (`--chrome` menu: the name and count at rest and on a hovered
 * header row, the ⇥ restore-all glyph).
 */
function groupRows(palette: GroupPaletteId): ContrastRow[] {
	const pairs: [string, readonly string[], Use][] = [
		['group tab', BAND, 'text'],
		['group tab hover', [...BAND, 'group hover'], 'text'],
		['--text-0', [...BAND, 'group active'], 'text'],
		['group label', BAND, 'text'],
		['group label hover', [...BAND, 'group hover'], 'text'],
		['group icon', BAND, 'ui'],
		['group count', BAND, 'text'],
		['group label', CHROME, 'text'],
		['group label', [...CHROME, 'group row hover'], 'text'],
		['group count', CHROME, 'text'],
		['group count', [...CHROME, 'group row hover'], 'text'],
		['group restore', CHROME, 'ui'],
	]
	const ratios = GROUP_RATIOS[palette] ?? []
	return pairs.map(([fg, bg, use], i) => row(palette, fg, bg, use, ratios[i] ?? 0))
}

// Surfaces: `--chrome` (topbar, dock, menus, Signals bands), `--pane` (sidebar, sheets, the Signals list),
// `--well` (logs, code), `--term-bg` (the terminal). INPUT = `--fill-subtle` on `--pane`: a field, and a
// hovered list or Signals row. SELECTED = `--fill-raised` on `--pane`: a selected or pressed row.
// PRESSED = a quiet button's hover/press `--fill-strong`. DOCK_SELECTED = `--fill-raised` on `--chrome`:
// the dock's open entry and the active tab; CHROME_HOVER = a hovered tab or dock entry. Tones are read as
// text on the surfaces and on their own soft fill (chips, banners), also on a hovered or pressed row
// (the list's verdict chips). `ui` rows are control edges and glyphs that carry meaning (WCAG 1.4.11),
// the primary button's fill against its surface, scroll thumbs and the 2px `--accent` focus ring.
export const ROWS: readonly ContrastRow[] = [
	// helm: text ladder
	row('helm', '--text-0', CHROME, 'text', 14.47),
	row('helm', '--text-1', CHROME, 'text', 6.35),
	row('helm', '--text-2', CHROME, 'text', 4.54),
	row('helm', '--text-0', PANE, 'text', 15.48),
	row('helm', '--text-1', PANE, 'text', 6.79),
	row('helm', '--text-2', PANE, 'text', 4.86),
	row('helm', '--text-0', WELL, 'text', 16.03),
	row('helm', '--text-1', WELL, 'text', 7.04),
	row('helm', '--text-2', WELL, 'text', 5.03),
	row('helm', '--text-0', INPUT, 'text', 13.7),
	row('helm', '--text-1', INPUT, 'text', 6.01),
	row('helm', '--text-2', INPUT, 'text', 4.3),
	row('helm', '--text-0', SELECTED, 'text', 12.16),
	row('helm', '--text-1', SELECTED, 'text', 5.34),
	row('helm', '--text-2', SELECTED, 'text', 3.81),
	row('helm', '--text-0', PRESSED, 'text', 10.65),
	row('helm', '--text-1', PRESSED, 'text', 4.67),
	row('helm', '--text-2', PRESSED, 'text', 3.34),
	row('helm', '--text-0', DOCK_SELECTED, 'text', 11.14),
	row('helm', '--text-1', DOCK_SELECTED, 'text', 4.89),
	row('helm', '--text-2', DOCK_SELECTED, 'text', 3.49),
	// helm: dock dim
	row('helm', '--dock-dim', CHROME, 'text', 5.58),
	row('helm', '--dock-dim', DOCK_SELECTED, 'text', 4.29),
	// helm: tones
	row('helm', '--accent', CHROME, 'text', 5.99),
	row('helm', '--accent', PANE, 'text', 6.41),
	// helm: --accent-text (an alias of --accent) for the shortcut recording line on the Settings pane
	row('helm', '--accent-text', PANE, 'text', 6.41),
	row('helm', '--accent', ['--pane', '--accent-soft'], 'text', 5.16),
	row('helm', '--success', CHROME, 'text', 8.16),
	row('helm', '--success', PANE, 'text', 8.73),
	row('helm', '--success', ['--pane', '--success-soft'], 'text', 6.67),
	row('helm', '--warn', CHROME, 'text', 8.69),
	row('helm', '--warn', PANE, 'text', 9.3),
	row('helm', '--warn', ['--pane', '--warn-soft'], 'text', 7.0),
	row('helm', '--danger', CHROME, 'text', 5.94),
	row('helm', '--danger', PANE, 'text', 6.36),
	row('helm', '--danger', ['--pane', '--danger-soft'], 'text', 5.17),
	row('helm', '--neutral', CHROME, 'text', 6.11),
	row('helm', '--neutral', PANE, 'text', 6.53),
	row('helm', '--neutral', ['--pane', '--neutral-soft'], 'text', 5.2),
	// helm: primary button
	row('helm', '--on-accent', ['--accent-fill'], 'text', 4.51),
	row('helm', '--on-accent', ['--accent-fill-hover'], 'text', 5.11),
	row('helm', '--accent-fill', PANE, 'ui', 4.04),
	// helm: control edges and focus
	row('helm', '--hairline', PANE, 'ui', 1.19),
	row('helm', '--hairline', CHROME, 'ui', 1.21),
	row('helm', '--hairline-strong', PANE, 'ui', 1.61),
	row('helm', '--accent', PANE, 'ui', 6.41),
	row('helm', '--accent', CHROME, 'ui', 5.99),
	row('helm', '--accent', WELL, 'ui', 6.64),
	// helm: hovered tab and dock entry, Signals list rows, Run Context conflict banner, scrolling
	row('helm', '--text-1', CHROME_HOVER, 'text', 5.54),
	row('helm', '--text-2', CHROME_HOVER, 'text', 3.96),
	row('helm', '--dock-dim', CHROME_HOVER, 'text', 4.87),
	row('helm', '--dock-dim', PANE, 'text', 5.97),
	row('helm', '--dock-dim', INPUT, 'text', 5.28),
	row('helm', '--dock-dim', SELECTED, 'text', 4.69),
	row('helm', '--text-0', ['--pane', '--accent-soft'], 'text', 12.46),
	row('helm', '--ansi-bright-black', TERMINAL, 'text', 4.5),
	row('helm', '--thumb', PANE, 'ui', 1.5),
	row('helm', '--term-scroll-thumb', TERMINAL, 'ui', 1.97),
	// helm: tones on hovered and pressed rows (status words, verdict chips)
	row('helm', '--accent', INPUT, 'text', 5.67),
	row('helm', '--success', INPUT, 'text', 7.73),
	row('helm', '--warn', INPUT, 'text', 8.23),
	row('helm', '--danger', INPUT, 'text', 5.62),
	row('helm', '--neutral', INPUT, 'text', 5.78),
	row('helm', '--accent', [...INPUT, '--accent-soft'], 'text', 4.5),
	row('helm', '--accent', [...SELECTED, '--accent-soft'], 'text', 3.99),
	row('helm', '--success', [...INPUT, '--success-soft'], 'text', 5.78),
	row('helm', '--success', [...SELECTED, '--success-soft'], 'text', 5.13),
	row('helm', '--warn', [...INPUT, '--warn-soft'], 'text', 6.05),
	row('helm', '--warn', [...SELECTED, '--warn-soft'], 'text', 5.36),
	row('helm', '--danger', [...INPUT, '--danger-soft'], 'text', 4.51),
	row('helm', '--danger', [...SELECTED, '--danger-soft'], 'text', 4.01),
	row('helm', '--neutral', [...INPUT, '--neutral-soft'], 'text', 4.52),
	row('helm', '--neutral', [...SELECTED, '--neutral-soft'], 'text', 4.01),
	// high-contrast: text ladder
	row('high-contrast', '--text-0', CHROME, 'text', 17.78),
	row('high-contrast', '--text-1', CHROME, 'text', 10.47),
	row('high-contrast', '--text-2', CHROME, 'text', 5.97),
	row('high-contrast', '--text-0', PANE, 'text', 19.44),
	row('high-contrast', '--text-1', PANE, 'text', 11.44),
	row('high-contrast', '--text-2', PANE, 'text', 6.53),
	row('high-contrast', '--text-0', WELL, 'text', 21.0),
	row('high-contrast', '--text-1', WELL, 'text', 12.36),
	row('high-contrast', '--text-2', WELL, 'text', 7.05),
	row('high-contrast', '--text-0', INPUT, 'text', 15.77),
	row('high-contrast', '--text-1', INPUT, 'text', 9.28),
	row('high-contrast', '--text-2', INPUT, 'text', 5.29),
	row('high-contrast', '--text-0', SELECTED, 'text', 12.51),
	row('high-contrast', '--text-1', SELECTED, 'text', 7.36),
	row('high-contrast', '--text-2', SELECTED, 'text', 4.2),
	row('high-contrast', '--text-0', PRESSED, 'text', 10.02),
	row('high-contrast', '--text-1', PRESSED, 'text', 5.89),
	row('high-contrast', '--text-2', PRESSED, 'text', 3.36),
	row('high-contrast', '--text-0', DOCK_SELECTED, 'text', 10.89),
	row('high-contrast', '--text-1', DOCK_SELECTED, 'text', 6.41),
	row('high-contrast', '--text-2', DOCK_SELECTED, 'text', 3.66),
	// high-contrast: dock dim
	row('high-contrast', '--dock-dim', CHROME, 'text', 8.47),
	row('high-contrast', '--dock-dim', DOCK_SELECTED, 'text', 5.19),
	// high-contrast: tones
	row('high-contrast', '--accent', CHROME, 'text', 7.96),
	row('high-contrast', '--accent', PANE, 'text', 8.71),
	// high-contrast: --accent-text (an alias of --accent) for the shortcut recording line on the Settings pane
	row('high-contrast', '--accent-text', PANE, 'text', 8.71),
	row('high-contrast', '--accent', ['--pane', '--accent-soft'], 'text', 6.88),
	row('high-contrast', '--success', CHROME, 'text', 11.0),
	row('high-contrast', '--success', PANE, 'text', 12.02),
	row('high-contrast', '--success', ['--pane', '--success-soft'], 'text', 8.99),
	row('high-contrast', '--warn', CHROME, 'text', 10.95),
	row('high-contrast', '--warn', PANE, 'text', 11.97),
	row('high-contrast', '--warn', ['--pane', '--warn-soft'], 'text', 8.94),
	row('high-contrast', '--danger', CHROME, 'text', 6.42),
	row('high-contrast', '--danger', PANE, 'text', 7.01),
	row('high-contrast', '--danger', ['--pane', '--danger-soft'], 'text', 5.81),
	row('high-contrast', '--neutral', CHROME, 'text', 7.86),
	row('high-contrast', '--neutral', PANE, 'text', 8.6),
	row('high-contrast', '--neutral', ['--pane', '--neutral-soft'], 'text', 6.79),
	// high-contrast: primary button
	row('high-contrast', '--on-accent', ['--accent-fill'], 'text', 4.51),
	row('high-contrast', '--on-accent', ['--accent-fill-hover'], 'text', 5.21),
	row('high-contrast', '--accent-fill', PANE, 'ui', 4.3),
	// high-contrast: control edges and focus
	row('high-contrast', '--hairline', PANE, 'ui', 3.05),
	row('high-contrast', '--hairline', CHROME, 'ui', 3.11),
	row('high-contrast', '--hairline-strong', PANE, 'ui', 4.99),
	row('high-contrast', '--accent', PANE, 'ui', 8.71),
	row('high-contrast', '--accent', CHROME, 'ui', 7.96),
	row('high-contrast', '--accent', WELL, 'ui', 9.4),
	// high-contrast: hovered tab and dock entry, Signals list rows, Run Context conflict banner, scrolling
	row('high-contrast', '--text-1', CHROME_HOVER, 'text', 8.15),
	row('high-contrast', '--text-2', CHROME_HOVER, 'text', 4.65),
	row('high-contrast', '--dock-dim', CHROME_HOVER, 'text', 6.59),
	row('high-contrast', '--dock-dim', PANE, 'text', 9.26),
	row('high-contrast', '--dock-dim', INPUT, 'text', 7.51),
	row('high-contrast', '--dock-dim', SELECTED, 'text', 5.96),
	row('high-contrast', '--text-0', ['--pane', '--accent-soft'], 'text', 15.37),
	row('high-contrast', '--ansi-bright-black', TERMINAL, 'text', 5.05),
	row('high-contrast', '--thumb', PANE, 'ui', 3.28),
	row('high-contrast', '--term-scroll-thumb', TERMINAL, 'ui', 3.0),
	// high-contrast: tones on hovered and pressed rows (status words, verdict chips)
	row('high-contrast', '--accent', INPUT, 'text', 7.06),
	row('high-contrast', '--success', INPUT, 'text', 9.75),
	row('high-contrast', '--warn', INPUT, 'text', 9.71),
	row('high-contrast', '--danger', INPUT, 'text', 5.69),
	row('high-contrast', '--neutral', INPUT, 'text', 6.97),
	row('high-contrast', '--accent', [...INPUT, '--accent-soft'], 'text', 5.32),
	row('high-contrast', '--accent', [...SELECTED, '--accent-soft'], 'text', 4.26),
	row('high-contrast', '--success', [...INPUT, '--success-soft'], 'text', 6.89),
	row('high-contrast', '--success', [...SELECTED, '--success-soft'], 'text', 5.51),
	row('high-contrast', '--warn', [...INPUT, '--warn-soft'], 'text', 6.83),
	row('high-contrast', '--warn', [...SELECTED, '--warn-soft'], 'text', 5.46),
	row('high-contrast', '--danger', [...INPUT, '--danger-soft'], 'text', 4.55),
	row('high-contrast', '--danger', [...SELECTED, '--danger-soft'], 'text', 3.66),
	row('high-contrast', '--neutral', [...INPUT, '--neutral-soft'], 'text', 5.23),
	row('high-contrast', '--neutral', [...SELECTED, '--neutral-soft'], 'text', 4.19),
	// remote
	row('remote', '--text-0', PANE, 'text', 15.48),
	row('remote', '--text-1', PANE, 'text', 6.79),
	row('remote', '--text-2', PANE, 'text', 4.86),
	row('remote', '--text-0', CHROME, 'text', 14.47),
	row('remote', '--text-1', CHROME, 'text', 6.35),
	row('remote', '--text-2', CHROME, 'text', 4.54),
	row('remote', '--text-0', WELL, 'text', 16.03),
	row('remote', '--text-1', WELL, 'text', 7.04),
	row('remote', '--text-2', WELL, 'text', 5.03),
	row('remote', '--text-0', BUBBLE, 'text', 11.34),
	row('remote', '--text-1', BUBBLE, 'text', 4.98),
	row('remote', '--text-2', BUBBLE, 'text', 3.56),
	row('remote', '--accent', PANE, 'text', 6.41),
	row('remote', '--danger', PANE, 'text', 6.36),
	row('remote', '--hairline-strong', PANE, 'ui', 1.61),
	row('remote', '--accent', PANE, 'ui', 6.41),
	row('remote', '--text-2', CHROME_HOVER, 'text', 3.96),
	row('remote', '--warn', ['--pane', '--warn-soft'], 'text', 7),
	// review light
	row('review-light', '--text-0', PANE, 'text', 14.23),
	row('review-light', '--text-1', PANE, 'text', 5.63),
	row('review-light', '--text-2', PANE, 'text', 5.47),
	row('review-light', '--text-0', CHROME, 'text', 13.14),
	row('review-light', '--text-1', CHROME, 'text', 5.21),
	row('review-light', '--text-2', CHROME, 'text', 5.05),
	row('review-light', '--text-0', WELL, 'text', 12.44),
	row('review-light', '--text-1', WELL, 'text', 4.93),
	row('review-light', '--text-2', WELL, 'text', 4.78),
	row('review-light', '--accent', PANE, 'text', 5.15),
	row('review-light', '--accent', WELL, 'text', 4.5),
	row('review-light', '--neutral', PANE, 'text', 5.16),
	row('review-light', '--neutral', WELL, 'text', 4.51),
	row('review-light', '--danger', PANE, 'text', 6.14),
	row('review-light', '--warn', PANE, 'text', 5.62),
	row('review-light', '--success', PANE, 'text', 5.5),
	row('review-light', '--danger', ['--pane', '--danger-soft'], 'text', 4.77),
	row('review-light', '--warn', ['--pane', '--warn-soft'], 'text', 4.56),
	row('review-light', '--on-accent', ['--accent-fill'], 'text', 5.42),
	row('review-light', '--on-accent', ['--accent-fill-hover'], 'text', 6.8),
	row('review-light', '--hairline-strong', PANE, 'ui', 1.44),
	row('review-light', '--accent', PANE, 'ui', 5.15),
	row('review-light', '--thumb', PANE, 'ui', 1.3),
	row('review-light', '--syntax-keyword', WELL, 'text', 5.26),
	row('review-light', '--syntax-string', WELL, 'text', 4.84),
	row('review-light', '--syntax-number', WELL, 'text', 5.34),
	row('review-light', '--syntax-type', WELL, 'text', 5.18),
	row('review-light', '--syntax-function', WELL, 'text', 4.91),
	row('review-light', '--syntax-property', WELL, 'text', 12.44),
	row('review-light', '--syntax-invalid', WELL, 'text', 5.37),
	row('review-light', '--syntax-comment', WELL, 'text', 4.78),
	// viewer dark
	row('viewer-dark', '--syntax-keyword', WELL, 'text', 7.16),
	row('viewer-dark', '--syntax-string', WELL, 'text', 9.05),
	row('viewer-dark', '--syntax-number', WELL, 'text', 9.39),
	row('viewer-dark', '--syntax-type', WELL, 'text', 9.63),
	row('viewer-dark', '--syntax-function', WELL, 'text', 6.64),
	row('viewer-dark', '--syntax-property', WELL, 'text', 11.75),
	row('viewer-dark', '--syntax-invalid', WELL, 'text', 5.69),
	row('viewer-dark', '--syntax-comment', WELL, 'text', 5.03),
	// popup
	row('popup', '--text-0', PANE, 'text', 15.48),
	row('popup', '--accent', PANE, 'text', 6.41),
	row('popup', '--text-1', PANE, 'text', 6.79),
	row('popup', '--success', PANE, 'text', 8.73),
	row('popup', '--danger', PANE, 'text', 6.36),
	row('popup', '--text-0', POPUP_INPUT, 'text', 13.7),
	row('popup', '--text-1', POPUP_INPUT, 'text', 6.01),
	row('popup', '--hairline', POPUP_INPUT, 'ui', 1.22),
	row('popup', '--hairline-strong', POPUP_INPUT, 'ui', 1.66),
	row('popup', '--accent', POPUP_INPUT, 'ui', 5.67),
	row('popup', '--accent-fill', PANE, 'ui', 4.04),
	...GROUP_PALETTES.flatMap(groupRows),
]

// Today's failures, each owned by an open decision in docs/plans/design-system/spec.md (`{ palette, fg, bg, use,
// decision }`). None is open: the D15 picks (§9 rulings 92, 109, 110, 112, 113) settled or exempted every pair the
// D5 picks left.
export const OPEN: readonly OpenPair[] = []

const exempt = (palette: PaletteId, fg: string, bg: readonly string[], use: Use, ruling: number): ExemptPair => ({
	palette,
	fg,
	bg,
	use,
	ruling,
})

// Pairs a §9 ruling exempts from their need: control edges are decorative (a field is identified by its
// label, value and focus ring; §9 ruling 91; High contrast is not exempt and meets 3:1), no production rule
// paints --text-2 on --fill-strong in either preset (§9 ruling 92), Remote draws no --text-2 on its message
// bubble (§9 ruling 93), a row with a fill steps its --text-2 and --dock-dim up to --text-1 (§9 ruling 109),
// scroll thumbs are quiet outside High contrast (§9 ruling 110) and a chip on a pressed row is exempt for
// the length of the click (§9 ruling 112). An exempt pair that starts passing is stale.
export const EXEMPT: readonly ExemptPair[] = [
	exempt('helm', '--hairline', PANE, 'ui', 91),
	exempt('helm', '--hairline', CHROME, 'ui', 91),
	exempt('helm', '--hairline-strong', PANE, 'ui', 91),
	exempt('popup', '--hairline', POPUP_INPUT, 'ui', 91),
	exempt('popup', '--hairline-strong', POPUP_INPUT, 'ui', 91),
	exempt('helm', '--text-2', PRESSED, 'text', 92),
	exempt('high-contrast', '--text-2', PRESSED, 'text', 92),
	exempt('remote', '--text-2', BUBBLE, 'text', 93),
	exempt('remote', '--hairline-strong', PANE, 'ui', 91),
	exempt('review-light', '--hairline-strong', PANE, 'ui', 91),
	exempt('helm', '--text-2', INPUT, 'text', 109),
	exempt('helm', '--text-2', SELECTED, 'text', 109),
	exempt('helm', '--text-2', DOCK_SELECTED, 'text', 109),
	exempt('helm', '--text-2', CHROME_HOVER, 'text', 109),
	exempt('helm', '--dock-dim', DOCK_SELECTED, 'text', 109),
	exempt('high-contrast', '--text-2', SELECTED, 'text', 109),
	exempt('high-contrast', '--text-2', DOCK_SELECTED, 'text', 109),
	exempt('remote', '--text-2', CHROME_HOVER, 'text', 109),
	exempt('helm', '--thumb', PANE, 'ui', 110),
	exempt('helm', '--term-scroll-thumb', TERMINAL, 'ui', 110),
	exempt('review-light', '--thumb', PANE, 'ui', 110),
	exempt('helm', '--accent', [...SELECTED, '--accent-soft'], 'text', 112),
	exempt('helm', '--danger', [...SELECTED, '--danger-soft'], 'text', 112),
	exempt('helm', '--neutral', [...SELECTED, '--neutral-soft'], 'text', 112),
	exempt('high-contrast', '--accent', [...SELECTED, '--accent-soft'], 'text', 112),
	exempt('high-contrast', '--danger', [...SELECTED, '--danger-soft'], 'text', 112),
	exempt('high-contrast', '--neutral', [...SELECTED, '--neutral-soft'], 'text', 112),
]

export function rowKey(row: { palette: PaletteId; fg: string; bg: readonly string[]; use: Use }): string {
	return `${row.palette}: ${row.fg} on ${row.bg.join(' + ')} (${row.use})`
}

export function measure(row: { palette: PaletteId; fg: string; bg: readonly string[] }): number {
	const scopes: Scopes = PALETTES[row.palette].scopes
	const bg = paint(scopes, row.bg)
	const fg = paint(scopes, [...row.bg, row.fg])
	return contrast(fg, bg)
}

export function passes(row: ContrastRow): boolean {
	const need = NEED[row.use]
	return need === null || measure(row) >= need
}

const BASE_PALETTE_LABELS = Object.values(BASE_PALETTES)
	.map(palette => palette.label)
	.join(', ')

export const TABLE_BEGIN = '<!-- contrast-table:begin -->'
export const TABLE_END = '<!-- contrast-table:end -->'

function colourCell(palette: PaletteId, key: string): string {
	if (key.startsWith('--')) return `\`${key}\``
	const value = (PALETTES[palette].scopes as Scopes).find(scope => scope[key] !== undefined)?.[key]
	return `${key} \`${value}\``
}

function openFor(row: ContrastRow): OpenPair | undefined {
	const key = rowKey(row)
	return OPEN.find(entry => rowKey(entry) === key)
}

function exemptFor(row: ContrastRow): ExemptPair | undefined {
	const key = rowKey(row)
	return EXEMPT.find(entry => rowKey(entry) === key)
}

function statusCell(row: ContrastRow): string {
	const open = openFor(row)
	if (open) return `open ${open.decision}`
	const exempt = exemptFor(row)
	if (exempt) return `exempt §9 ruling ${exempt.ruling}`
	return 'pass'
}

/** The §2.9 table, as written between the markers in docs/design-system.md. */
export function contrastTable(): string {
	const open = ROWS.filter(row => openFor(row) !== undefined)
	const exempt = ROWS.filter(row => exemptFor(row) !== undefined)
	const decisions = [...new Set(OPEN.map(entry => entry.decision))].sort(
		(a, b) => Number(a.slice(1)) - Number(b.slice(1)),
	)
	const counts = decisions.map(d => `${d} ${OPEN.filter(entry => entry.decision === d).length}`).join(', ')
	const rulings = [...new Set(EXEMPT.map(entry => entry.ruling))].sort((a, b) => a - b)
	const exemptCounts = rulings
		.map(n => `§9 ruling ${n}: ${EXEMPT.filter(entry => entry.ruling === n).length}`)
		.join(', ')
	const lines = [
		`${ROWS.length} pairs, ${open.length} open${counts ? ` (${counts})` : ''}, ${exempt.length} exempt${exemptCounts ? ` (${exemptCounts})` : ''}. Palettes: ${BASE_PALETTE_LABELS}, and one per terminal group colour in each preset. High contrast is the bundled preset; an installed preset file nobody edited is rewritten with it at startup, and an edited one keeps its own values and fills the rest from the same preset (§9 ruling 97), so only the values a user changed can measure differently. Remote is the Helm preset plus its bubble grey (§9 ruling 96). Need: text 4.5, large text and \`ui\` (control edges, focus ring, a filled control against its surface) 3, decorative n/a. Ratios are WCAG 2.x, two decimals, truncated; translucent fills are composited over the surface named under them. The extension widget's \`--vg-*\` values are checked equal to Helm's, so its pairs are the Helm rows. Generated by \`node --import tsx packages/helm-ui/scripts/contrast-table.ts\`.`,
		'',
		'| Palette | Foreground | Background | Use | Need | Ratio | Status |',
		'| --- | --- | --- | --- | --- | --- | --- |',
	]
	for (const row of ROWS) {
		const background = [...row.bg]
			.reverse()
			.map(key => colourCell(row.palette, key))
			.join(' over ')
		const need = NEED[row.use]
		lines.push(
			`| ${PALETTES[row.palette].label} | ${colourCell(row.palette, row.fg)} | ${background} | ${row.use} | ${need ?? 'n/a'} | ${row.ratio.toFixed(2)} | ${statusCell(row)} |`,
		)
	}
	return lines.join('\n')
}

/** `doc` with the table between the markers replaced by `contrastTable()`. */
export function spliceContrastTable(doc: string): string {
	const begin = doc.indexOf(TABLE_BEGIN)
	const end = doc.indexOf(TABLE_END)
	if (begin < 0 || end < begin) throw new Error(`Missing ${TABLE_BEGIN} … ${TABLE_END} markers`)
	return `${doc.slice(0, begin + TABLE_BEGIN.length)}\n${contrastTable()}\n${doc.slice(end)}`
}

export { truncate2 }
