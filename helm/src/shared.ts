// IPC surface shared by preload (implements) and renderer (consumes as `window.helm`).

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
	/** Reachability probe runs in the main process so browser CORS/private-network rules can't get in the way. */
	pingDaemon(): Promise<boolean>
}

/** Menu accelerators (cmd+t / cmd+w) fire in main; renderer subscribes here. */
export interface TabsApi {
	onNew(listener: () => void): () => void
	onClose(listener: () => void): () => void
}

export interface HelmApi {
	pty: PtyApi
	sessions: SessionsApi
	config: ConfigApi
	tabs: TabsApi
	/** Host OS, for platform-specific keybindings/layout ('darwin' on macOS). */
	platform: NodeJS.Platform
}
