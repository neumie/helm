// Measured contrast of every foreground/background token pair Helm draws (docs/design-system.md §2.9).
//
// Each row stores the ratio printed in §2.9 (two decimals, truncated). `tests/design-contrast.test.ts`
// recomputes every row from the palettes below and fails when a stored ratio differs, when a pair misses
// its need without an `OPEN` entry, or when an `OPEN` entry starts passing (stale). An open entry names
// the decision in docs/plans/design-system/spec.md that owns it; it leaves only by a token change or a
// ruling, never quietly. `app/scripts/contrast-table.ts` writes the §2.9 table from `ROWS`.
//
// Values come from the current sources (until stage S2 generates them from one token module):
// the bundled presets (`app/src/theme-presets.ts`), and verbatim copies of the CSS declarations
// below, each pinned to its file by `SOURCES` (the test fails when a source changes). A palette is a
// list of CSS scopes, outermost first, so `var()` inside a declaration resolves where the browser
// resolves it (contrast.ts). Translucent fills are composited over the surface named under them.
import { TAB_GROUP_COLORS, type TabGroupColor, tabGroupColorCssVar } from '../tab-group-colors'
import { THEME_PRESETS } from '../theme-presets'
import { type Scopes, contrast, paint, truncate2 } from './contrast'

function presetTokens(id: string): Record<string, string> {
	const preset = THEME_PRESETS[id]
	if (!preset) throw new Error(`Missing theme preset ${id}`)
	return preset.tokens
}

/** `app/src/renderer/styles.css` `:root`: colours derived from the tones (§2.8): soft fills, and the Run Context banner's border. */
const ROOT_DERIVED = {
	'--accent-soft': 'color-mix(in srgb, var(--accent) 15%, transparent)',
	'--success-soft': 'color-mix(in srgb, var(--success) 15%, transparent)',
	'--warn-soft': 'color-mix(in srgb, var(--warn) 15%, transparent)',
	'--danger-soft': 'color-mix(in srgb, var(--danger) 15%, transparent)',
	'--neutral-soft': 'color-mix(in srgb, var(--neutral) 15%, transparent)',
	'--danger-strong': 'color-mix(in srgb, var(--danger) 50%, transparent)',
}

/** `styles.css` `.agent-dock` and `.signals` (each declares it): the dim text of the dock and Signals (§3.24). */
const DOCK = {
	'--dock-dim': 'color-mix(in srgb, var(--text-1) 60%, var(--text-2))',
}

/** `app/src/renderer/remote/remote.css`: the Remote phone ladder. */
const REMOTE_PAGE = { '--remote-page': '#0d0d0d' }
const REMOTE = {
	'--pane': 'var(--remote-page, #0d0d0d)',
	'--chrome': '#1c1c1e',
	'--well': '#1a1a1a',
	'--hairline': 'rgb(255 255 255 / 8%)',
	'--hairline-strong': 'rgb(255 255 255 / 16%)',
	'--fill-subtle': 'rgb(255 255 255 / 5.5%)',
	'--fill-raised': 'rgb(255 255 255 / 11%)',
	'--remote-bubble': '#2f2f2f',
}

/** `app/src/renderer/document-review/document-review.css`: the scoped light reading palette. */
const REVIEW_LIGHT = {
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
	'--accent': '#176ac2',
	'--accent-fill': '#176ac2',
	'--accent-fill-hover': '#125ba8',
	'--danger': '#b91c1c',
	'--warn': '#8a5a0a',
	'--success': '#267347',
	'--danger-soft': 'color-mix(in srgb, var(--danger) 15%, transparent)',
	'--warn-soft': 'color-mix(in srgb, var(--warn) 15%, transparent)',
}

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

/** `extension/src/popup.html` / `popup.ts` literals (no tokens yet; D9). */
const POPUP = {
	'body background': '#252526',
	'body text': '#cccccc',
	title: '#007acc',
	label: '#808080',
	'input background': '#1e1e1e',
	'input border': '#3c3c3c',
	'input focus border': '#007acc',
	'status ok': '#6a9955',
	'status error': '#f14c4c',
}

/**
 * `styles.css` terminal groups (§3.18): the group's colour comes from `--group-color`, set inline to
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
	/** `.tab-group-toggle` colour: the group's name. */
	'group label': 'color-mix(in srgb, var(--group-color) 55%, var(--text-1))',
	/** `.tab-group-toggle:hover` colour, and `.tab-group-toggle .group-icon` (the folder glyph). */
	'group label hover': 'var(--group-color)',
	/** `.tab-group-count` colour: the member count. */
	'group count': 'color-mix(in srgb, var(--group-color) 55%, var(--text-2))',
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
		scopes: [{ ...presetTokens('helm'), ...ROOT_DERIVED }, REMOTE_PAGE, REMOTE],
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
		scopes: [POPUP],
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

const STYLES = 'app/src/renderer/styles.css'
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

const groupSource = (block: string, property: string, key: keyof typeof TAB_GROUP): SourceCheck[] =>
	GROUP_PALETTES.map(palette => ({ palette, file: STYLES, block, property, key }))

export const SOURCES: readonly SourceCheck[] = [
	...declarations('helm', STYLES, ':root {', ROOT_DERIVED),
	...declarations('helm', STYLES, '.agent-dock {', DOCK),
	...declarations('helm', STYLES, '.signals {', DOCK),
	...declarations('remote', REMOTE_CSS, ':root.remote-page {', REMOTE_PAGE),
	...declarations('remote', REMOTE_CSS, '.remote-workspace, .remote-login, .remote-empty {', REMOTE),
	...declarations('review-light', REVIEW_CSS, '.document-review[data-review-theme="light"] {', REVIEW_LIGHT),
	...declarations('viewer-dark', VIEWER_CSS, '.viewer-window {', VIEWER_SYNTAX),
	...declarations('review-light', VIEWER_CSS, '.viewer-window[data-review-theme="light"] {', VIEWER_SYNTAX_LIGHT),
	{ palette: 'popup', file: POPUP_HTML, block: 'body {', property: 'background', key: 'body background' },
	{ palette: 'popup', file: POPUP_HTML, block: 'body {', property: 'color', key: 'body text' },
	{ palette: 'popup', file: POPUP_HTML, block: 'h1 {', property: 'color', key: 'title' },
	{ palette: 'popup', file: POPUP_HTML, block: 'label {', property: 'color', key: 'label' },
	{ palette: 'popup', file: POPUP_HTML, block: '.models .group {', property: 'color', key: 'label' },
	{ palette: 'popup', file: POPUP_HTML, block: 'input {', property: 'background', key: 'input background' },
	{ palette: 'popup', file: POPUP_HTML, block: 'input {', property: 'color', key: 'body text' },
	{
		palette: 'popup',
		file: POPUP_HTML,
		block: 'input {',
		property: 'border',
		key: 'input border',
		expect: '1px solid #3c3c3c',
	},
	{ palette: 'popup', file: POPUP_HTML, block: 'input:focus {', property: 'border-color', key: 'input focus border' },
	{ palette: 'popup', file: POPUP_HTML, block: '.status {', property: 'color', key: 'status ok' },
	...groupSource('.tab-group-section {', 'background', 'group band'),
	...groupSource('.tab-group-section .tab:hover {', 'background', 'group hover'),
	...groupSource('.tab-group-section.collapsed > .tab-group-toggle:hover {', 'background', 'group hover'),
	...groupSource('.tab-group-section .tab.active {', 'background', 'group active'),
	...groupSource('.bg-group-header-row:hover {', 'background', 'group row hover'),
	...groupSource('.tab-group-toggle {', 'color', 'group label'),
	...groupSource('.tab-group-toggle:hover {', 'color', 'group label hover'),
	...groupSource('.tab-group-toggle .group-icon {', 'color', 'group label hover'),
	...groupSource('.tab-group-count {', 'color', 'group count'),
	...groupSource('.bg-group-restore {', 'color', 'group restore'),
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

/** popup.ts sets the status colour inline; these literals must still appear there. */
export const LITERAL_SOURCES: readonly { file: string; text: string; palette: PaletteId; key: string }[] = [
	{ file: 'extension/src/popup.ts', text: "statusEl.style.color = '#6a9955'", palette: 'popup', key: 'status ok' },
	{ file: 'extension/src/popup.ts', text: "statusEl.style.color = '#f14c4c'", palette: 'popup', key: 'status error' },
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
	decision: 'D5' | 'D9'
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
const POPUP_BG = ['body background']
const POPUP_INPUT = ['input background']

const row = (palette: PaletteId, fg: string, bg: readonly string[], use: Use, ratio: number): ContrastRow => ({
	palette,
	fg,
	bg,
	use,
	ratio,
})

/** Stored ratios of the terminal-group rows, per palette, in `groupRows` order. */
const GROUP_RATIOS: Record<GroupPaletteId, readonly number[]> = {
	'helm-group-blue': [2.35, 3.55, 7.07, 4.78, 3.35, 4.76, 3.46, 6.01, 5.03, 4.35, 3.64, 4.35],
	'helm-group-purple': [2.31, 3.42, 6.76, 4.96, 3.48, 5.05, 3.6, 6.34, 5.24, 4.6, 3.8, 4.6],
	'helm-group-pink': [2.35, 3.52, 7, 4.82, 3.43, 4.91, 3.5, 6.08, 5.08, 4.4, 3.68, 4.4],
	'helm-group-red': [2.46, 3.9, 7.87, 4.38, 3.15, 4.27, 3.15, 5.26, 4.57, 3.79, 3.29, 3.79],
	'helm-group-orange': [2.33, 3.46, 6.86, 4.9, 3.49, 5.05, 3.56, 6.22, 5.17, 4.51, 3.75, 4.51],
	'helm-group-green': [2.22, 3.09, 5.99, 5.38, 3.97, 6.14, 3.96, 7.15, 5.73, 5.27, 4.23, 5.27],
	'helm-group-cyan': [2.2, 3.02, 5.85, 5.46, 4.04, 6.31, 4.04, 7.34, 5.84, 5.42, 4.31, 5.42],
	'high-contrast-group-blue': [4.56, 5.22, 7.55, 6.82, 3.97, 6.08, 5.3, 8.93, 7.25, 6.95, 5.64, 6.95],
	'high-contrast-group-purple': [4.44, 4.89, 6.99, 7.17, 4.25, 6.77, 5.6, 9.64, 7.67, 7.54, 6, 7.54],
	'high-contrast-group-pink': [4.54, 5.14, 7.4, 6.91, 4.09, 6.33, 5.38, 9.09, 7.36, 7.08, 5.73, 7.08],
	'high-contrast-group-red': [4.82, 5.9, 8.7, 6.16, 3.62, 5.18, 4.74, 7.63, 6.47, 5.87, 4.98, 5.87],
	'high-contrast-group-orange': [4.52, 5.08, 7.3, 6.97, 4.14, 6.46, 5.43, 9.21, 7.43, 7.18, 5.79, 7.18],
	'high-contrast-group-green': [4.29, 4.48, 6.29, 7.57, 4.7, 7.91, 5.99, 10.53, 8.17, 8.33, 6.46, 8.33],
	'high-contrast-group-cyan': [4.22, 4.32, 6.04, 7.76, 4.83, 8.27, 6.15, 10.96, 8.4, 8.69, 6.66, 8.69],
}

/**
 * A terminal group in the strip (a band over `--chrome`: the tabs' `--text-2`, a hovered tab's `--text-1`,
 * the active tab's `--text-0`, the name, its hover on a collapsed header, the folder glyph, the count)
 * and in the Background terminals list (`--chrome` menu: the name and count at rest and on a hovered
 * header row, the ⇥ restore-all glyph).
 */
function groupRows(palette: GroupPaletteId): ContrastRow[] {
	const pairs: [string, readonly string[], Use][] = [
		['--text-2', BAND, 'text'],
		['--text-1', [...BAND, 'group hover'], 'text'],
		['--text-0', [...BAND, 'group active'], 'text'],
		['group label', BAND, 'text'],
		['group label hover', [...BAND, 'group hover'], 'text'],
		['group label hover', BAND, 'ui'],
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
	row('helm', '--text-2', CHROME, 'text', 2.96),
	row('helm', '--text-0', PANE, 'text', 15.48),
	row('helm', '--text-1', PANE, 'text', 6.79),
	row('helm', '--text-2', PANE, 'text', 3.17),
	row('helm', '--text-0', WELL, 'text', 16.03),
	row('helm', '--text-1', WELL, 'text', 7.04),
	row('helm', '--text-2', WELL, 'text', 3.28),
	row('helm', '--text-0', INPUT, 'text', 13.7),
	row('helm', '--text-1', INPUT, 'text', 6.01),
	row('helm', '--text-2', INPUT, 'text', 2.8),
	row('helm', '--text-0', SELECTED, 'text', 12.16),
	row('helm', '--text-1', SELECTED, 'text', 5.34),
	row('helm', '--text-2', SELECTED, 'text', 2.49),
	row('helm', '--text-0', PRESSED, 'text', 10.65),
	row('helm', '--text-1', PRESSED, 'text', 4.67),
	row('helm', '--text-2', PRESSED, 'text', 2.18),
	row('helm', '--text-0', DOCK_SELECTED, 'text', 11.14),
	row('helm', '--text-1', DOCK_SELECTED, 'text', 4.89),
	row('helm', '--text-2', DOCK_SELECTED, 'text', 2.28),
	// helm: dock dim
	row('helm', '--dock-dim', CHROME, 'text', 4.77),
	row('helm', '--dock-dim', DOCK_SELECTED, 'text', 3.67),
	// helm: tones
	row('helm', '--accent', CHROME, 'text', 5.99),
	row('helm', '--accent', PANE, 'text', 6.41),
	row('helm', '--accent', ['--pane', '--accent-soft'], 'text', 5.16),
	row('helm', '--success', CHROME, 'text', 8.16),
	row('helm', '--success', PANE, 'text', 8.73),
	row('helm', '--success', ['--pane', '--success-soft'], 'text', 6.67),
	row('helm', '--warn', CHROME, 'text', 8.69),
	row('helm', '--warn', PANE, 'text', 9.3),
	row('helm', '--warn', ['--pane', '--warn-soft'], 'text', 7.0),
	row('helm', '--danger', CHROME, 'text', 5.14),
	row('helm', '--danger', PANE, 'text', 5.5),
	row('helm', '--danger', ['--pane', '--danger-soft'], 'text', 4.6),
	row('helm', '--neutral', CHROME, 'text', 5.25),
	row('helm', '--neutral', PANE, 'text', 5.62),
	row('helm', '--neutral', ['--pane', '--neutral-soft'], 'text', 4.58),
	// helm: primary button
	row('helm', '--on-accent', ['--accent-fill'], 'text', 3.67),
	row('helm', '--on-accent', ['--accent-fill-hover'], 'text', 2.72),
	row('helm', '--accent-fill', PANE, 'ui', 4.96),
	// helm: control edges and focus
	row('helm', '--hairline', PANE, 'ui', 1.19),
	row('helm', '--hairline', CHROME, 'ui', 1.21),
	row('helm', '--hairline-strong', PANE, 'ui', 1.61),
	row('helm', '--accent', PANE, 'ui', 6.41),
	row('helm', '--accent', CHROME, 'ui', 5.99),
	row('helm', '--accent', WELL, 'ui', 6.64),
	// helm: hovered tab and dock entry, Signals list rows, Run Context conflict banner, scrolling
	row('helm', '--text-1', CHROME_HOVER, 'text', 5.54),
	row('helm', '--text-2', CHROME_HOVER, 'text', 2.58),
	row('helm', '--dock-dim', CHROME_HOVER, 'text', 4.16),
	row('helm', '--dock-dim', PANE, 'text', 5.11),
	row('helm', '--dock-dim', INPUT, 'text', 4.52),
	row('helm', '--dock-dim', SELECTED, 'text', 4.01),
	row('helm', '--text-0', ['--pane', '--accent-soft'], 'text', 12.46),
	row('helm', '--ansi-bright-black', TERMINAL, 'text', 2.98),
	row('helm', '--thumb', PANE, 'ui', 1.5),
	row('helm', '--term-scroll-thumb', TERMINAL, 'ui', 1.97),
	// helm: tones on hovered and pressed rows (status words, verdict chips)
	row('helm', '--accent', INPUT, 'text', 5.67),
	row('helm', '--success', INPUT, 'text', 7.73),
	row('helm', '--warn', INPUT, 'text', 8.23),
	row('helm', '--danger', INPUT, 'text', 4.86),
	row('helm', '--neutral', INPUT, 'text', 4.97),
	row('helm', '--accent', [...INPUT, '--accent-soft'], 'text', 4.5),
	row('helm', '--accent', [...SELECTED, '--accent-soft'], 'text', 3.99),
	row('helm', '--success', [...INPUT, '--success-soft'], 'text', 5.78),
	row('helm', '--success', [...SELECTED, '--success-soft'], 'text', 5.13),
	row('helm', '--warn', [...INPUT, '--warn-soft'], 'text', 6.05),
	row('helm', '--warn', [...SELECTED, '--warn-soft'], 'text', 5.36),
	row('helm', '--danger', [...INPUT, '--danger-soft'], 'text', 4.03),
	row('helm', '--danger', [...SELECTED, '--danger-soft'], 'text', 3.59),
	row('helm', '--neutral', [...INPUT, '--neutral-soft'], 'text', 3.99),
	row('helm', '--neutral', [...SELECTED, '--neutral-soft'], 'text', 3.54),
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
	row('high-contrast', '--on-accent', ['--accent-fill'], 'text', 4.46),
	row('high-contrast', '--on-accent', ['--accent-fill-hover'], 'text', 3.07),
	row('high-contrast', '--accent-fill', PANE, 'ui', 4.35),
	// high-contrast: control edges and focus
	row('high-contrast', '--hairline', PANE, 'ui', 1.55),
	row('high-contrast', '--hairline', CHROME, 'ui', 1.63),
	row('high-contrast', '--hairline-strong', PANE, 'ui', 2.83),
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
	row('high-contrast', '--thumb', PANE, 'ui', 2.43),
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
	row('remote', '--text-0', PANE, 'text', 16.47),
	row('remote', '--text-1', PANE, 'text', 7.23),
	row('remote', '--text-2', PANE, 'text', 3.37),
	row('remote', '--text-0', CHROME, 'text', 14.42),
	row('remote', '--text-1', CHROME, 'text', 6.33),
	row('remote', '--text-2', CHROME, 'text', 2.95),
	row('remote', '--text-0', WELL, 'text', 14.75),
	row('remote', '--text-1', WELL, 'text', 6.47),
	row('remote', '--text-2', WELL, 'text', 3.02),
	row('remote', '--text-0', BUBBLE, 'text', 11.34),
	row('remote', '--text-1', BUBBLE, 'text', 4.98),
	row('remote', '--text-2', BUBBLE, 'text', 2.32),
	row('remote', '--accent', PANE, 'text', 6.82),
	row('remote', '--danger', PANE, 'text', 5.85),
	row('remote', '--hairline-strong', PANE, 'ui', 1.55),
	row('remote', '--accent', PANE, 'ui', 6.82),
	row('remote', '--text-2', CHROME_HOVER, 'text', 2.53),
	row('remote', '--warn', ['--pane', '--warn-soft'], 'text', 7.65),
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
	row('review-light', '--accent', PANE, 'text', 5.14),
	row('review-light', '--accent', WELL, 'text', 4.49),
	row('review-light', '--neutral', PANE, 'text', 3.08),
	row('review-light', '--neutral', WELL, 'text', 2.69),
	row('review-light', '--danger', PANE, 'text', 6.14),
	row('review-light', '--warn', PANE, 'text', 5.62),
	row('review-light', '--success', PANE, 'text', 5.5),
	row('review-light', '--danger', ['--pane', '--danger-soft'], 'text', 4.77),
	row('review-light', '--warn', ['--pane', '--warn-soft'], 'text', 4.56),
	row('review-light', '--on-accent', ['--accent-fill'], 'text', 5.41),
	row('review-light', '--on-accent', ['--accent-fill-hover'], 'text', 6.8),
	row('review-light', '--hairline-strong', PANE, 'ui', 1.44),
	row('review-light', '--accent', PANE, 'ui', 5.14),
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
	row('viewer-dark', '--syntax-comment', WELL, 'text', 3.28),
	// popup
	row('popup', 'body text', POPUP_BG, 'text', 9.53),
	row('popup', 'title', POPUP_BG, 'text', 3.39),
	row('popup', 'label', POPUP_BG, 'text', 3.87),
	row('popup', 'status ok', POPUP_BG, 'text', 4.59),
	row('popup', 'status error', POPUP_BG, 'text', 4.28),
	row('popup', 'body text', POPUP_INPUT, 'text', 10.38),
	row('popup', 'input border', POPUP_BG, 'ui', 1.38),
	row('popup', 'input focus border', POPUP_BG, 'ui', 3.39),
	...GROUP_PALETTES.flatMap(groupRows),
]

const open = (
	palette: PaletteId,
	fg: string,
	bg: readonly string[],
	use: Use,
	decision: OpenPair['decision'],
): OpenPair => ({ palette, fg, bg, use, decision })

// Today's failures, each owned by a decision in docs/plans/design-system/spec.md: D5 (contrast) for the
// app palettes, D9 (popup onto Helm tokens) for the extension popup. The dock's own target for
// `--dock-dim` on its selected entry is 3:1 (§3.24); WCAG asks 4.5 for its 12px meta, so it stays open.
// Scroll thumbs and the terminal's dim ANSI colour are listed too: D5 rules whether they are exempt.
export const OPEN: readonly OpenPair[] = [
	open('helm', '--text-2', CHROME, 'text', 'D5'),
	open('helm', '--text-2', PANE, 'text', 'D5'),
	open('helm', '--text-2', WELL, 'text', 'D5'),
	open('helm', '--text-2', INPUT, 'text', 'D5'),
	open('helm', '--text-2', SELECTED, 'text', 'D5'),
	open('helm', '--text-2', PRESSED, 'text', 'D5'),
	open('helm', '--text-2', DOCK_SELECTED, 'text', 'D5'),
	open('helm', '--dock-dim', DOCK_SELECTED, 'text', 'D5'),
	open('helm', '--on-accent', ['--accent-fill'], 'text', 'D5'),
	open('helm', '--on-accent', ['--accent-fill-hover'], 'text', 'D5'),
	open('helm', '--hairline', PANE, 'ui', 'D5'),
	open('helm', '--hairline', CHROME, 'ui', 'D5'),
	open('helm', '--hairline-strong', PANE, 'ui', 'D5'),
	open('high-contrast', '--text-2', SELECTED, 'text', 'D5'),
	open('high-contrast', '--text-2', PRESSED, 'text', 'D5'),
	open('high-contrast', '--text-2', DOCK_SELECTED, 'text', 'D5'),
	open('high-contrast', '--on-accent', ['--accent-fill'], 'text', 'D5'),
	open('high-contrast', '--on-accent', ['--accent-fill-hover'], 'text', 'D5'),
	open('high-contrast', '--hairline', PANE, 'ui', 'D5'),
	open('high-contrast', '--hairline', CHROME, 'ui', 'D5'),
	open('high-contrast', '--hairline-strong', PANE, 'ui', 'D5'),
	open('remote', '--text-2', PANE, 'text', 'D5'),
	open('remote', '--text-2', CHROME, 'text', 'D5'),
	open('remote', '--text-2', WELL, 'text', 'D5'),
	open('remote', '--text-2', BUBBLE, 'text', 'D5'),
	open('remote', '--hairline-strong', PANE, 'ui', 'D5'),
	open('review-light', '--accent', WELL, 'text', 'D5'),
	open('review-light', '--neutral', PANE, 'text', 'D5'),
	open('review-light', '--neutral', WELL, 'text', 'D5'),
	open('review-light', '--hairline-strong', PANE, 'ui', 'D5'),
	open('viewer-dark', '--syntax-comment', WELL, 'text', 'D5'),
	open('helm', '--text-2', CHROME_HOVER, 'text', 'D5'),
	open('helm', '--dock-dim', CHROME_HOVER, 'text', 'D5'),
	open('helm', '--dock-dim', SELECTED, 'text', 'D5'),
	open('helm', '--ansi-bright-black', TERMINAL, 'text', 'D5'),
	open('helm', '--thumb', PANE, 'ui', 'D5'),
	open('helm', '--term-scroll-thumb', TERMINAL, 'ui', 'D5'),
	open('helm', '--accent', [...SELECTED, '--accent-soft'], 'text', 'D5'),
	open('helm', '--danger', [...INPUT, '--danger-soft'], 'text', 'D5'),
	open('helm', '--danger', [...SELECTED, '--danger-soft'], 'text', 'D5'),
	open('helm', '--neutral', [...INPUT, '--neutral-soft'], 'text', 'D5'),
	open('helm', '--neutral', [...SELECTED, '--neutral-soft'], 'text', 'D5'),
	open('high-contrast', '--thumb', PANE, 'ui', 'D5'),
	open('high-contrast', '--accent', [...SELECTED, '--accent-soft'], 'text', 'D5'),
	open('high-contrast', '--danger', [...SELECTED, '--danger-soft'], 'text', 'D5'),
	open('high-contrast', '--neutral', [...SELECTED, '--neutral-soft'], 'text', 'D5'),
	open('remote', '--text-2', CHROME_HOVER, 'text', 'D5'),
	open('review-light', '--thumb', PANE, 'ui', 'D5'),
	open('helm-group-blue', '--text-2', BAND, 'text', 'D5'),
	open('helm-group-blue', '--text-1', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-blue', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-blue', 'group count', BAND, 'text', 'D5'),
	open('helm-group-blue', 'group count', CHROME, 'text', 'D5'),
	open('helm-group-blue', 'group count', [...CHROME, 'group row hover'], 'text', 'D5'),
	open('helm-group-purple', '--text-2', BAND, 'text', 'D5'),
	open('helm-group-purple', '--text-1', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-purple', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-purple', 'group count', BAND, 'text', 'D5'),
	open('helm-group-purple', 'group count', [...CHROME, 'group row hover'], 'text', 'D5'),
	open('helm-group-pink', '--text-2', BAND, 'text', 'D5'),
	open('helm-group-pink', '--text-1', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-pink', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-pink', 'group count', BAND, 'text', 'D5'),
	open('helm-group-pink', 'group count', CHROME, 'text', 'D5'),
	open('helm-group-pink', 'group count', [...CHROME, 'group row hover'], 'text', 'D5'),
	open('helm-group-red', '--text-2', BAND, 'text', 'D5'),
	open('helm-group-red', '--text-1', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-red', 'group label', BAND, 'text', 'D5'),
	open('helm-group-red', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-red', 'group count', BAND, 'text', 'D5'),
	open('helm-group-red', 'group count', CHROME, 'text', 'D5'),
	open('helm-group-red', 'group count', [...CHROME, 'group row hover'], 'text', 'D5'),
	open('helm-group-orange', '--text-2', BAND, 'text', 'D5'),
	open('helm-group-orange', '--text-1', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-orange', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-orange', 'group count', BAND, 'text', 'D5'),
	open('helm-group-orange', 'group count', [...CHROME, 'group row hover'], 'text', 'D5'),
	open('helm-group-green', '--text-2', BAND, 'text', 'D5'),
	open('helm-group-green', '--text-1', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-green', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-green', 'group count', BAND, 'text', 'D5'),
	open('helm-group-green', 'group count', [...CHROME, 'group row hover'], 'text', 'D5'),
	open('helm-group-cyan', '--text-2', BAND, 'text', 'D5'),
	open('helm-group-cyan', '--text-1', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-cyan', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('helm-group-cyan', 'group count', BAND, 'text', 'D5'),
	open('helm-group-cyan', 'group count', [...CHROME, 'group row hover'], 'text', 'D5'),
	open('high-contrast-group-blue', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('high-contrast-group-purple', '--text-2', BAND, 'text', 'D5'),
	open('high-contrast-group-purple', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('high-contrast-group-pink', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('high-contrast-group-red', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('high-contrast-group-orange', 'group label hover', [...BAND, 'group hover'], 'text', 'D5'),
	open('high-contrast-group-green', '--text-2', BAND, 'text', 'D5'),
	open('high-contrast-group-green', '--text-1', [...BAND, 'group hover'], 'text', 'D5'),
	open('high-contrast-group-cyan', '--text-2', BAND, 'text', 'D5'),
	open('high-contrast-group-cyan', '--text-1', [...BAND, 'group hover'], 'text', 'D5'),
	open('popup', 'title', POPUP_BG, 'text', 'D9'),
	open('popup', 'label', POPUP_BG, 'text', 'D9'),
	open('popup', 'status error', POPUP_BG, 'text', 'D9'),
	open('popup', 'input border', POPUP_BG, 'ui', 'D9'),
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

/** The §2.9 table, as written between the markers in docs/design-system.md. */
export function contrastTable(): string {
	const open = ROWS.filter(row => openFor(row) !== undefined)
	const decisions = [...new Set(OPEN.map(entry => entry.decision))].sort()
	const counts = decisions.map(d => `${d} ${OPEN.filter(entry => entry.decision === d).length}`).join(', ')
	const lines = [
		`${ROWS.length} pairs, ${open.length} open (${counts}). Palettes: ${BASE_PALETTE_LABELS}, and one per terminal group colour in each preset. High contrast is the bundled preset; a theme file seeded before newer tokens existed fills them from Helm (D10), so its contrast can differ. Need: text 4.5, large text and \`ui\` (control edges, focus ring, a filled control against its surface) 3, decorative n/a. Ratios are WCAG 2.x, two decimals, truncated; translucent fills are composited over the surface named under them. The extension widget's \`--vg-*\` values are checked equal to Helm's, so its pairs are the Helm rows. Generated by \`node --import tsx app/scripts/contrast-table.ts\`.`,
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
		const entry = openFor(row)
		lines.push(
			`| ${PALETTES[row.palette].label} | ${colourCell(row.palette, row.fg)} | ${background} | ${row.use} | ${need ?? 'n/a'} | ${row.ratio.toFixed(2)} | ${entry ? `open ${entry.decision}` : 'pass'} |`,
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
