// IPC surface shared by preload (implements) and renderer (consumes as `window.helm`).

import type { DaemonApi } from './shared-helm'

export interface PtySpawnResult {
	id: number
	/** dtach session backing this pty; null when persistence is unavailable. */
	sessionId: string | null
}

/** A dtach session that survived the previous app run and can be reattached. */
export interface RestoredSession {
	sessionId: string
	/** Last OSC title seen for the tab, or null (renderer falls back to "zsh"). */
	title: string | null
}

export interface PtyApi {
	/** Pass a restored sessionId to reattach instead of creating a fresh session. */
	spawn(cols: number, rows: number, sessionId?: string): Promise<PtySpawnResult>
	write(id: number, data: string): void
	resize(id: number, cols: number, rows: number): void
	/** Kills the pty AND its dtach session for real (explicit tab close). */
	kill(id: number): void
	onData(listener: (id: number, data: string) => void): () => void
	onExit(listener: (id: number, exitCode: number) => void): () => void
}

/** Result of a soft close: the session lives for graceMs more, undoable. */
export interface GraceClose {
	sessionId: string
	graceMs: number
}

export interface SessionsApi {
	/** Live sessions from the previous run, oldest first. Empty when none/persistence off. */
	list(): Promise<RestoredSession[]>
	/** Persist the tab title so a restored tab gets its label back. */
	setTitle(sessionId: string, title: string): void
	/**
	 * Soft-close a tab: detaches the pty client now, kills the session only
	 * after the grace period. Null when the pty had no session (already dead).
	 */
	closeWithGrace(ptyId: number): Promise<GraceClose | null>
	/** Cancel a pending grace kill. True = session alive, reattach it. */
	undoClose(sessionId: string): Promise<boolean>
}

export interface ConfigApi {
	getDaemonUrl(): string
}

/** Screenshot-harness hook: `--ui-preview=<page>` auto-navigates the sidebar. */
export type UiPreview = 'list' | 'detail' | 'settings' | 'appearance'

/** Menu accelerators (cmd+t / cmd+w) fire in main; renderer subscribes here. */
export interface TabsApi {
	onNew(listener: () => void): () => void
	onClose(listener: () => void): () => void
}

/** A theme file from <userData>/themes/<id>.json (docs/design-system.md §2.8). */
export interface ThemeListEntry {
	id: string
	name: string
	/** CSS custom-property overrides ('--token': value). */
	tokens: Record<string, string>
}

/** Appearance: theme files (main owns the dir) + font-size menu accelerators. */
export interface AppearanceApi {
	/** Presets first (seeded on first call), then custom files alphabetically. */
	listThemes(): Promise<ThemeListEntry[]>
	/** View menu Bigger/Smaller/Reset text (cmd+= / cmd+- / cmd+0): +1 / -1 / 0. */
	onFontStep(listener: (step: number) => void): () => void
}

/** helm://item/<id> deep links (main's open-url handler) land here. */
export interface NavApi {
	onOpenItem(listener: (itemId: string) => void): () => void
	/** Back/forward from main: native three-finger swipe, Go menu (cmd+[ / cmd+]),
	 *  and app-command mouse buttons all normalize to one channel. */
	onGo(listener: (direction: 'back' | 'forward') => void): () => void
}

export interface HelmApi {
	pty: PtyApi
	sessions: SessionsApi
	config: ConfigApi
	/** Theme files + font-size accelerators (docs/design-system.md §2.8). */
	appearance: AppearanceApi
	tabs: TabsApi
	/** Deep-link navigation pushed from main (helm:// protocol). */
	nav: NavApi
	/** Daemon data bridge: main-process poller + HTTP command proxy (src/helm-bridge.ts). */
	daemon: DaemonApi
	/** Host OS, for platform-specific keybindings/layout ('darwin' on macOS). */
	platform: NodeJS.Platform
	/** Set only on `--ui-preview=…` screenshot runs; null in normal use. */
	uiPreview: UiPreview | null
	/** Set only on `--ui-theme=<presetId>` screenshot runs; null in normal use. */
	uiTheme: string | null
}
