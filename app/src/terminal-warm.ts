/** One prestarted ordinary shell, so New terminal does not wait out login startup. */

const PRELUDE_MAX_CHARS = 64_000

export interface WarmProcess {
	resize(cols: number, rows: number): void
	kill(): void
	onData(listener: (data: string) => void): () => void
	onExit(listener: (exitCode: number) => void): () => void
}

export interface WarmSpawn {
	sessionId: string
	proc: WarmProcess
}

export interface WarmClaim {
	sessionId: string
	proc: WarmProcess
	prelude: string
}

export interface Cancellable {
	cancel(): void
}

export interface TerminalWarmPoolOptions {
	enabled(): boolean
	cwd(): string
	profileToken(): string
	spawn(cwd: string, profileToken: string): WarmSpawn
	killSession(sessionId: string): void
	/** Fired after startup output has been quiet. The shell is claimable only then. */
	scheduleReady(callback: () => void): Cancellable
	/** Avoid respawn loops when a prestarted shell exits immediately. */
	scheduleRetry(callback: () => void): Cancellable
}

interface WarmEntry {
	sessionId: string
	proc: WarmProcess
	profileToken: string
	cwd: string
	buffer: string
	ready: boolean
	discarded: boolean
	stopData: () => void
	stopExit: () => void
	readyTimer: Cancellable | null
}

/**
 * Keeps at most one unclaimed login shell. It is not a user terminal: discard
 * kills it, and only a claim makes it eligible for the session registry.
 */
export class TerminalWarmPool {
	#current: WarmEntry | null = null
	#retry: Cancellable | null = null
	readonly #options: TerminalWarmPoolOptions

	constructor(options: TerminalWarmPoolOptions) {
		this.#options = options
	}

	ensure(): void {
		if (this.#current || this.#retry || !this.#options.enabled()) return
		let spawned: WarmSpawn
		try {
			spawned = this.#options.spawn(this.#options.cwd(), this.#options.profileToken())
		} catch {
			return
		}
		const entry: WarmEntry = {
			sessionId: spawned.sessionId,
			proc: spawned.proc,
			profileToken: this.#options.profileToken(),
			cwd: this.#options.cwd(),
			buffer: '',
			ready: false,
			discarded: false,
			stopData: () => {},
			stopExit: () => {},
			readyTimer: null,
		}
		entry.stopData = spawned.proc.onData(data => {
			if (entry.discarded) return
			entry.buffer = appendBounded(entry.buffer, data)
			entry.ready = false
			entry.readyTimer?.cancel()
			entry.readyTimer = this.#options.scheduleReady(() => {
				if (!entry.discarded && this.#current === entry) entry.ready = true
			})
		})
		entry.stopExit = spawned.proc.onExit(() => {
			if (this.#current === entry) this.#current = null
			if (!entry.discarded) this.#scheduleRetry()
		})
		this.#current = entry
	}

	claim(profileToken: string, cwd: string): WarmClaim | null {
		const entry = this.#current
		if (!entry) {
			this.ensure()
			return null
		}
		if (entry.profileToken !== profileToken || entry.cwd !== cwd) {
			this.discard()
			this.ensure()
			return null
		}
		if (!entry.ready) return null
		this.#current = null
		this.#stop(entry)
		this.ensure()
		return { sessionId: entry.sessionId, proc: entry.proc, prelude: entry.buffer }
	}

	/** Kill the unclaimed shell. A claimed process is the caller's. */
	discard(): void {
		this.#retry?.cancel()
		this.#retry = null
		const entry = this.#current
		this.#current = null
		if (!entry) return
		entry.discarded = true
		this.#stop(entry)
		try {
			entry.proc.kill()
		} catch {
			// already exited
		}
		try {
			this.#options.killSession(entry.sessionId)
		} catch {
			// best-effort; the client kill still detached or exited
		}
	}

	#scheduleRetry(): void {
		if (this.#retry || this.#current || !this.#options.enabled()) return
		this.#retry = this.#options.scheduleRetry(() => {
			this.#retry = null
			this.ensure()
		})
	}

	#stop(entry: WarmEntry): void {
		entry.readyTimer?.cancel()
		entry.stopData()
		entry.stopExit()
	}
}

function appendBounded(buffer: string, data: string): string {
	const next = buffer + data
	return next.length > PRELUDE_MAX_CHARS ? next.slice(-PRELUDE_MAX_CHARS) : next
}

export default { TerminalWarmPool }

