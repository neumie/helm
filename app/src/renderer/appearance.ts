// Appearance engine — single runtime owner of theme tokens (CSS custom
// properties, docs/design-system.md §2.8), terminal font size, and UI text
// scale. init() applies the persisted state to document.documentElement
// before first paint; every mutation re-applies, persists, and notifies
// subscribers (renderer.ts re-themes/re-sizes xterm; AppearancePage renders
// the controls via useSyncExternalStore).
//
// Persistence: localStorage 'helm.appearance' — same surface as the split
// width ('helm.leftWidth'). Theme FILES live in <userData>/themes/*.json,
// owned by main (themes:list IPC); the bundled THEME_PRESETS are the
// synchronous fallback so first paint never waits on IPC, and the active
// custom theme's tokens are cached in the persisted state for the same reason.

import type { ThemeListEntry } from '../shared'
import { DEFAULT_THEME_ID, THEME_PRESETS } from '../theme-presets'

// --- terminal font size (cmd+= / cmd+- / cmd+0) -------------------------------

export const TERM_FONT_MIN = 9
export const TERM_FONT_MAX = 24
export const TERM_FONT_DEFAULT = 13

export function clampTermFont(px: number): number {
	if (!Number.isFinite(px)) return TERM_FONT_DEFAULT
	return Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, Math.round(px)))
}

/** step +1 / -1 adjusts by 1px inside the bounds; step 0 resets to default. */
export function stepTermFont(current: number, step: number): number {
	if (step === 0) return TERM_FONT_DEFAULT
	return clampTermFont(current + Math.sign(step))
}

// --- UI text scale (Settings → Appearance) ------------------------------------

export const UI_SCALES = [
	{ value: 0.92, label: 'Small' },
	{ value: 1, label: 'Default' },
	{ value: 1.08, label: 'Large' },
] as const

export type UiScale = (typeof UI_SCALES)[number]['value']

function normalizeUiScale(raw: unknown): UiScale {
	return UI_SCALES.find(s => s.value === raw)?.value ?? 1
}

// --- state ---------------------------------------------------------------------

export interface AppearanceState {
	themeId: string
	/** Per-token edits layered over the theme (Appearance color wells). */
	overrides: Record<string, string>
	termFontSize: number
	uiScale: UiScale
	/** Tokens of the active NON-preset theme, cached so a custom theme paints
	 *  before the themes:list IPC answers. Null while a preset is active. */
	themeTokensCache: Record<string, string> | null
	/** Jakub picked the theme himself. Until he does, macOS Increase Contrast
	 *  (`prefers-contrast: more`) selects the High contrast preset. */
	themeChosen: boolean
}

/** The bundled preset that follows the OS "Increase contrast" setting while no theme was chosen. */
export const CONTRAST_THEME_ID = 'high-contrast'

/** The appearance in effect: the chosen theme, or High contrast while the OS asks for more contrast and none was chosen. */
export function effectiveAppearance(state: AppearanceState, prefersContrast: boolean): AppearanceState {
	if (state.themeChosen || !prefersContrast || !THEME_PRESETS[CONTRAST_THEME_ID]) return state
	return { ...state, themeId: CONTRAST_THEME_ID, themeTokensCache: null }
}

const STORAGE_KEY = 'helm.appearance'

function isTokenMap(raw: unknown): raw is Record<string, string> {
	return (
		typeof raw === 'object' &&
		raw !== null &&
		!Array.isArray(raw) &&
		Object.entries(raw).every(([key, value]) => key.startsWith('--') && typeof value === 'string')
	)
}

export function normalizeAppearance(raw: unknown): AppearanceState {
	const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
	return {
		themeId: typeof source.themeId === 'string' && source.themeId !== '' ? source.themeId : DEFAULT_THEME_ID,
		overrides: isTokenMap(source.overrides) ? source.overrides : {},
		termFontSize: clampTermFont(typeof source.termFontSize === 'number' ? source.termFontSize : TERM_FONT_DEFAULT),
		uiScale: normalizeUiScale(source.uiScale),
		themeTokensCache: isTokenMap(source.themeTokensCache) ? source.themeTokensCache : null,
		// Older stored state has no flag: any theme but the default was a choice.
		themeChosen:
			source.themeChosen === true ||
			(typeof source.themeId === 'string' && source.themeId !== '' && source.themeId !== DEFAULT_THEME_ID),
	}
}

/** Helm preset tokens ∪ active theme tokens ∪ per-token overrides. The Helm
 *  base guarantees every known token resolves even for a sparse theme file. */
export function resolveTokens(state: AppearanceState, themes: ThemeListEntry[]): Record<string, string> {
	const preset = THEME_PRESETS[state.themeId]?.tokens
	const listed = themes.find(theme => theme.id === state.themeId)?.tokens
	const base = listed ?? preset ?? state.themeTokensCache ?? THEME_PRESETS[DEFAULT_THEME_ID]?.tokens ?? {}
	const helmBase = THEME_PRESETS[DEFAULT_THEME_ID]?.tokens ?? {}
	return { ...helmBase, ...base, ...state.overrides }
}

/** xterm ITheme built from the resolved tokens (assumes resolveTokens output,
 *  which always carries every --term-* / --ansi-* key). */
export function termThemeFromTokens(tokens: Record<string, string>) {
	return {
		background: tokens['--term-bg'],
		foreground: tokens['--term-fg'],
		cursor: tokens['--term-cursor'],
		cursorAccent: tokens['--term-cursor-accent'],
		selectionBackground: tokens['--term-selection'],
		black: tokens['--ansi-black'],
		red: tokens['--ansi-red'],
		green: tokens['--ansi-green'],
		yellow: tokens['--ansi-yellow'],
		blue: tokens['--ansi-blue'],
		magenta: tokens['--ansi-magenta'],
		cyan: tokens['--ansi-cyan'],
		white: tokens['--ansi-white'],
		brightBlack: tokens['--ansi-bright-black'],
		brightRed: tokens['--ansi-bright-red'],
		brightGreen: tokens['--ansi-bright-green'],
		brightYellow: tokens['--ansi-bright-yellow'],
		brightBlue: tokens['--ansi-bright-blue'],
		brightMagenta: tokens['--ansi-bright-magenta'],
		brightCyan: tokens['--ansi-bright-cyan'],
		brightWhite: tokens['--ansi-bright-white'],
	}
}

// --- store -----------------------------------------------------------------------

export interface AppearanceSnapshot {
	state: AppearanceState
	/** Available themes: bundled presets, replaced/extended by <userData>/themes. */
	themes: ThemeListEntry[]
	/** Resolved token map (theme ∪ overrides) currently applied to :root. */
	tokens: Record<string, string>
}

function bundledThemes(): ThemeListEntry[] {
	return Object.entries(THEME_PRESETS).map(([id, preset]) => ({ id, name: preset.name, tokens: preset.tokens }))
}

class AppearanceStore {
	private state: AppearanceState
	private themes: ThemeListEntry[] = bundledThemes()
	private snapshot: AppearanceSnapshot
	private listeners = new Set<() => void>()
	/** Custom-property names applied last round, so a theme/override switch
	 *  removes tokens the new resolution no longer sets. */
	private appliedKeys = new Set<string>()
	/** macOS Increase Contrast, read through `prefers-contrast: more`. */
	private prefersContrast = false

	constructor() {
		let raw: unknown = null
		try {
			// Guarded so the module stays importable from Node tests.
			if (typeof localStorage !== 'undefined') raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
		} catch {
			// corrupt persisted state — fall back to defaults
		}
		this.state = normalizeAppearance(raw)
		this.snapshot = this.buildSnapshot()
	}

	/** Follow the OS contrast setting live (renderer only). */
	private watchContrast(): void {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
		const query = window.matchMedia('(prefers-contrast: more)')
		this.prefersContrast = query.matches
		query.addEventListener('change', event => {
			this.prefersContrast = event.matches
			this.snapshot = this.buildSnapshot()
			this.apply()
			for (const listener of this.listeners) listener()
		})
	}

	/** Apply persisted appearance before first paint, then refresh the theme
	 *  list from <userData>/themes in the background. Renderer-only. */
	init(): void {
		// --ui-theme=<presetId> (screenshot harness): force a bundled preset for
		// this run so themes are visually verifiable without stored state.
		const forced = typeof window !== 'undefined' ? window.helm?.uiTheme : null
		this.watchContrast()
		if (forced && THEME_PRESETS[forced]) {
			this.state = { ...this.state, themeId: forced, overrides: {}, themeTokensCache: null, themeChosen: true }
		}
		this.snapshot = this.buildSnapshot()
		this.apply()
		void this.refreshThemes()
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getSnapshot = (): AppearanceSnapshot => this.snapshot

	getTermTheme() {
		return termThemeFromTokens(this.snapshot.tokens)
	}

	getTermFontSize(): number {
		return this.state.termFontSize
	}

	setTheme(themeId: string): void {
		if (themeId === this.snapshot.state.themeId) {
			// Picking the theme the OS contrast setting chose makes it Jakub's choice.
			if (!this.state.themeChosen) this.mutate({ themeId, themeChosen: true })
			return
		}
		const theme = this.themes.find(entry => entry.id === themeId)
		if (!theme) return
		// Overrides are per-theme edits; switching themes starts clean.
		this.mutate({
			themeId,
			overrides: {},
			themeTokensCache: THEME_PRESETS[themeId] ? null : theme.tokens,
			themeChosen: true,
		})
	}

	setOverride(token: string, value: string): void {
		this.mutate({ overrides: { ...this.state.overrides, [token]: value } })
	}

	/** One color well can drive several related tokens (the accent well sets
	 *  --accent, --accent-fill, and a derived hover). */
	setOverrides(overrides: Record<string, string>): void {
		this.mutate({ overrides: { ...this.state.overrides, ...overrides } })
	}

	/** Reset to preset: drop every per-token edit, keep the theme. */
	clearOverrides(): void {
		if (Object.keys(this.state.overrides).length === 0) return
		this.mutate({ overrides: {} })
	}

	setTermFontSize(px: number): void {
		const next = clampTermFont(px)
		if (next !== this.state.termFontSize) this.mutate({ termFontSize: next })
	}

	stepTermFontSize(step: number): void {
		this.setTermFontSize(stepTermFont(this.state.termFontSize, step))
	}

	setUiScale(scale: number): void {
		const next = normalizeUiScale(scale)
		if (next !== this.state.uiScale) this.mutate({ uiScale: next })
	}

	async refreshThemes(): Promise<void> {
		try {
			const listed = await window.helm.appearance.listThemes()
			const valid = listed.filter(entry => typeof entry.id === 'string' && isTokenMap(entry.tokens))
			if (valid.length > 0) this.themes = valid
		} catch {
			return // main unavailable (tests) — bundled presets stay
		}
		// Re-cache + re-apply: the active theme's file may have changed on disk.
		const active = this.themes.find(entry => entry.id === this.state.themeId)
		this.mutate(active && !THEME_PRESETS[this.state.themeId] ? { themeTokensCache: active.tokens } : {})
	}

	private mutate(patch: Partial<AppearanceState>): void {
		this.state = { ...this.state, ...patch }
		this.snapshot = this.buildSnapshot()
		this.persist()
		this.apply()
		for (const listener of this.listeners) listener()
	}

	private buildSnapshot(): AppearanceSnapshot {
		const state = effectiveAppearance(this.state, this.prefersContrast)
		return { state, themes: this.themes, tokens: resolveTokens(state, this.themes) }
	}

	private persist(): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
		} catch {
			// storage full/unavailable — appearance still applies for this session
		}
	}

	private apply(): void {
		if (typeof document === 'undefined') return
		const root = document.documentElement
		const tokens = this.snapshot.tokens
		for (const key of this.appliedKeys) {
			if (!(key in tokens)) root.style.removeProperty(key)
		}
		for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value)
		this.appliedKeys = new Set(Object.keys(tokens))
		root.style.setProperty('--ui-scale', String(this.state.uiScale))
	}
}

export const appearance = new AppearanceStore()
