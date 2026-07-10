// IPC surface shared by preload (implements) and renderer (consumes as `window.helm`).

export interface PtyApi {
	spawn(cols: number, rows: number): Promise<number>
	write(id: number, data: string): void
	resize(id: number, cols: number, rows: number): void
	kill(id: number): void
	onData(listener: (id: number, data: string) => void): () => void
	onExit(listener: (id: number, exitCode: number) => void): () => void
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
	config: ConfigApi
	tabs: TabsApi
	/** Host OS, for platform-specific keybindings/layout ('darwin' on macOS). */
	platform: NodeJS.Platform
}
