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
	/** Manual rename pin — wins over `title`, never overwritten by OSC. */
	customName: string | null
	/** Parked when the previous run ended — restores headless into the background popover. */
	parked: boolean
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
	/** Persist (or clear, with null) the manual rename pin. */
	setCustomName(sessionId: string, name: string | null): void
	/** Persist the parked flag so background terminals relaunch as background. */
	setParked(sessionId: string, parked: boolean): void
	/** Persist current strip order followed by background-list order. */
	setOrder(sessionIds: string[]): void
	/**
	 * Soft-close a tab: detaches the pty client now, kills the session only
	 * after the grace period. Null when the pty had no session (already dead).
	 */
	closeWithGrace(ptyId: number): Promise<GraceClose | null>
	/** Cancel a pending grace kill. True = session alive, reattach it. */
	undoClose(sessionId: string): Promise<boolean>
}

/**
 * Terminal buffer snapshots (app/src/buffers.ts): dtach preserves the process,
 * not the screen, so restored tabs replay a serialized xterm buffer before the
 * live pty stream attaches. Renderer serializes; main owns the file IO.
 */
export interface BuffersApi {
	/** Stored snapshot for a session being reattached, or null. */
	read(sessionId: string): Promise<string | null>
	/** Persist a serialized snapshot (fire-and-forget; main validates + caps). */
	save(sessionId: string, data: string): void
	/** Main asks the renderer to serialize + save every session-backed tab NOW
	 *  (quit/window-close path, before the pty clients detach). */
	onFlush(listener: () => void): () => void
	/** Renderer signals the requested flush is complete. */
	flushed(): void
}

export interface ConfigApi {
	getDaemonUrl(): string
}

/**
 * Screenshot-harness hook: `--ui-preview=<page>` auto-navigates the sidebar.
 * `background` parks one running + one exited session and opens the popover;
 * `background-strip` parks them but keeps the popover closed (strip + badge shot).
 * `background-park` parks the ACTIVE tab (after any --term-cmd output landed) so
 * a relaunch can verify parked snapshot restore; `background-restore` restores
 * the first startup-parked session back to a tab (popover row click analog).
 * `rename-edit` opens the inline tab-rename editor on the active tab (input
 * styling + select-all shot); `rename` commits the fixed pin "deploy watch" on
 * the active tab through the same commit path (relaunch verifies pin restore).
 * `tab-drag` holds a three-tab pointer drag over slot 0 for visual QA;
 * `running-tab` shows active progress and `attention-tab` an unseen completion.
 */
export type UiPreview =
	| 'list'
	| 'project-list'
	| 'queue-list'
	| 'planned-list'
	| 'detail'
	| 'queue-detail'
	| 'planned-detail'
	| 'archive-detail'
	| 'task'
	| 'settings'
	| 'appearance'
	| 'background'
	| 'background-strip'
	| 'background-park'
	| 'background-restore'
	| 'rename'
	| 'rename-edit'
	| 'tab-drag'
	| 'running-tab'
	| 'attention-tab'

/** Menu accelerators (cmd+t / cmd+w / cmd+shift+b) fire in main; renderer subscribes here. */
export interface TabsApi {
	onNew(listener: () => void): () => void
	onClose(listener: () => void): () => void
	/** Move the active tab to the background (⌘⇧B). */
	onBackground(listener: () => void): () => void
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
	/** Buffer snapshot IO (restore-before-attach; main owns the files). */
	buffers: BuffersApi
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
	/** Screenshot-harness only: `--term-cmd=<base64>` — decoded command typed
	 *  into the first tab's shell after startup (verifies output/restore paths). */
	termCmd: string | null
	/** Screenshot-harness only: `--term-scroll=<top|middle>` — scroll the active
	 *  terminal before capture (verifies scrollbar extremes/mid-travel). */
	termScroll: 'top' | 'middle' | null
	/** Test override (`HELM_TITLE_STICKY_MS`, like `HELM_CLOSE_GRACE_MS`) for the
	 *  restored-title stickiness window; null = TITLE_STICKY_WINDOW_MS default. */
	titleStickyMs: number | null
}
