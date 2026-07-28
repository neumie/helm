// IPC surface shared by preload (implements) and renderer (consumes as `window.helm`).

import type {
	DaemonApi,
	HelmResult,
	ProfilesApi,
	RunContextDraft,
	RunContextLoad,
	RunContextReset,
	RunContextSave,
} from './shared-helm'
import type { TabGroupColor } from './tab-group-colors'

/**
 * Main↔renderer terminal-transfer event shape. Prepare freezes and validates
 * the source; checkpoint captures the stable screen after client detach.
 */
export type TerminalTransferEventType = 'prepare' | 'checkpoint' | 'commit' | 'rollback'

/** Main→source-renderer command for one token-bound terminal hand-off. */
export interface TerminalTransferEvent {
	type: TerminalTransferEventType
	transactionId: string
	sessionId: string
	sourceProfileId: string
	destinationProfileId: string
	profileToken: string
}

export type TerminalTransferMoveResult =
	| { status: 'moved' }
	| { status: 'busy' | 'quarantined' }
	| { status: 'rejected'; reason: string }

export interface PtySpawnResult {
	id: number
	/** dtach session backing this pty; null when persistence is unavailable. */
	sessionId: string | null
}

/** Read-only eligibility for a controller-backed cross-profile terminal transfer. */
export type TerminalTransferPreflight =
	| { status: 'available'; targetProfileIds: string[] }
	| {
			status: 'unavailable'
			reason: 'busy' | 'stale-profile' | 'invalid-session' | 'missing-source' | 'run-owned' | 'no-targets'
	  }

/** Restricted controller-backed transfer bridge; paths and profile tokens stay preload/main-owned. */
export interface TerminalTransferApi {
	/** Captured at preload creation; used only to authenticate transfer events. */
	profileToken(): string
	/** The preload supplies the renderer's captured profile token automatically. */
	preflight(sessionId: string): Promise<TerminalTransferPreflight>
	/** Starts a controller-backed move of this renderer-owned ordinary terminal. */
	move(sessionId: string, destinationProfileId: string): Promise<TerminalTransferMoveResult>
	/** Main sends only token-bound transfer commands to the current renderer. */
	onEvent(listener: (event: TerminalTransferEvent) => void): () => void
	/** Acknowledge a controller prepare/checkpoint/commit/rollback command. */
	ack(event: TerminalTransferEvent, result: unknown): Promise<boolean>
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
	/** Opaque tab-group membership, or null when ungrouped. */
	groupId: string | null
	/** Last protocol-observed activity retained across inactive profile restore. */
	agentRunning: boolean
	agentAttention: boolean
}

export type TabGroupSurface = 'strip' | 'background'

/** Persisted tab-group definition; members remain on their individual session records. */
export interface TabGroup {
	id: string
	name: string
	color: TabGroupColor
	collapsedStrip: boolean
	collapsedBackground: boolean
}

/** Declarative group actions; their PTY/DOM effects belong to a later adapter. */
export type TabGroupActionIntent =
	| { type: 'rename'; groupId: string; name: string }
	| { type: 'move'; sessionId: string; groupId: string | null }
	| { type: 'open-all'; groupId: string }
	| { type: 'restore-all'; groupId: string }
	| { type: 'move-all-background'; groupId: string }
	| { type: 'close-all'; groupId: string }

/** Main-validated action plus the current profile registry's authoritative members. */
export interface TabGroupActionAuthorization {
	intent: TabGroupActionIntent
	memberIds: string[]
}

export interface TabGroupsApi {
	list(): Promise<TabGroup[]>
	create(name: string, sessionIds: string[]): Promise<TabGroup | null>
	rename(groupId: string, name: string): Promise<TabGroup | null>
	setColor(groupId: string, color: TabGroupColor): Promise<TabGroup | null>
	delete(groupId: string): Promise<boolean>
	setMembership(sessionId: string, groupId: string | null): Promise<boolean>
	setCollapsed(groupId: string, surface: TabGroupSurface, collapsed: boolean): Promise<boolean>
	/** Persists one group's strip/background placement; it never moves a PTY. */
	move(groupId: string, parked: boolean): Promise<string[] | null>
	/** Validates a declarative action and snapshots current members without controlling PTYs. */
	intent(intent: TabGroupActionIntent): Promise<TabGroupActionAuthorization | null>
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

/** Main-to-current-renderer scheduled handoff. It deliberately contains no daemon descriptor or identity. */
export interface ScheduledTerminalOpen extends RestoredSession {
	ptyId: number
}

export interface SessionsApi {
	/** Live sessions from the previous run, oldest first. Empty when none/persistence off. */
	list(): Promise<RestoredSession[]>
	/** Main-only scheduled adoption asks the current token-bound renderer to mount an opaque PTY. */
	onScheduledOpen(listener: (terminal: ScheduledTerminalOpen) => boolean | Promise<boolean>): () => void
	/** Profile-token-scoped tab-group metadata and membership mutations. */
	groups: TabGroupsApi
	/** Persist the tab title so a restored tab gets its label back. */
	setTitle(sessionId: string, title: string): void
	/** Persist (or clear, with null) the manual rename pin. */
	setCustomName(sessionId: string, name: string | null): void
	/** Persist the parked flag so background terminals relaunch as background. */
	setParked(sessionId: string, parked: boolean): void
	/** Persist only protocol-owned OSC activity for restore/transfer continuity. */
	setActivity(sessionId: string, activity: { agentRunning: boolean; agentAttention: boolean }): void
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
	/** Transfer-only acknowledged snapshot write. */
	saveAndAck(sessionId: string, data: string): Promise<boolean>
	/** Main asks the renderer to serialize + save every session-backed tab NOW
	 *  (quit/window-close path, before the pty clients detach). */
	onFlush(listener: () => void): () => void
	/** Renderer signals the requested flush is complete. */
	flushed(): void
}

export interface ConfigApi {
	getDaemonUrl(): string
}

/** Narrow OS-browser handoff; main accepts only bounded HTTP(S) URLs. */
export interface ExternalApi {
	open(url: string): Promise<boolean>
}

/**
 * Screenshot-harness hook: `--ui-preview=<page>` auto-navigates the sidebar.
 * `background` parks one running + one exited session and opens the popover;
 * `background-strip` parks them but keeps the popover closed (strip + badge shot).
 * `background-park` parks the ACTIVE tab (after any --term-cmd output landed) so
 * a relaunch can verify parked snapshot restore; `background-open` opens the
 * first parked holder while keeping it backgrounded; `background-restore` moves
 * the first startup-parked session back to a tab; `background-drag` holds a real
 * Background-origin terminal drag over trailing header whitespace with its exact
 * slot ghost; `background-grouped-tab-drag` projects one parked group member into
 * an existing strip group; `background-group-drag` drags the whole named group.
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
	| 'background-open'
	| 'background-restore'
	| 'background-drag'
	| 'background-grouped-tab-drag'
	| 'background-group-drag'
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
	/** Arm the native frame guard for this tab's second click. */
	guardNativeDoubleClick(): boolean
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

export interface RunContextWindowApi {
	open(itemId: string): Promise<void>
}

/** Restricted preload surface for the dedicated editor window. */
export interface RunContextEditorApi {
	load(): Promise<HelmResult<RunContextLoad>>
	save(revision: number, document: RunContextDraft): Promise<HelmResult<RunContextSave>>
	reset(revision: number): Promise<HelmResult<RunContextReset>>
	setDirty(dirty: boolean): void
	close(discard: boolean): void
	cancelClose(): void
	onCloseRequested(listener: () => void): () => void
}

export interface HelmApi {
	pty: PtyApi
	sessions: SessionsApi
	/** Cross-profile terminal-transfer discovery and controller-backed move. */
	terminalTransfer: TerminalTransferApi
	/** Buffer snapshot IO (restore-before-attach; main owns the files). */
	buffers: BuffersApi
	config: ConfigApi
	/** Open a safe web URL in the host's default browser. */
	external: ExternalApi
	/** Theme files + font-size accelerators (docs/design-system.md §2.8). */
	appearance: AppearanceApi
	tabs: TabsApi
	/** Deep-link navigation pushed from main (helm:// protocol). */
	nav: NavApi
	/** Daemon data bridge: main-process poller + HTTP command proxy (src/helm-bridge.ts). */
	daemon: DaemonApi
	/** Profile management and coordinated app/daemon switching. */
	profiles: ProfilesApi
	/** Opens/focuses the full-size external editor for one Item. */
	runContext: RunContextWindowApi
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
