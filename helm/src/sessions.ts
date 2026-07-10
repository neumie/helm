// dtach-backed terminal session persistence (main process only).
//
// Semantics ported from okena (contember/core/okena/crates/okena-terminal):
// each tab's pty runs `dtach -A <socket> -E -r winch $SHELL -l`, so the pty
// child is only the dtach attach CLIENT. The shell lives under a forked dtach
// master parented to launchd, which survives app quit/crash. Killing the
// client detaches (session lives on); killing the session SIGTERMs the
// socket's holders and removes the socket file.
//
// This module deliberately imports nothing from electron so the session layer
// can be exercised headlessly (see the integration test in the task notes) —
// main.ts passes in the userData path for the registry.

import { execFile } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

// okena resolves tools through get_extended_path (session_backend.rs:751-793)
// because app bundles inherit a minimal PATH missing /opt/homebrew/bin etc.
// Same problem under Electron: check well-known locations first, then PATH.
const DTACH_CANDIDATES = [
	'/opt/homebrew/bin/dtach',
	'/usr/local/bin/dtach',
	'/opt/local/bin/dtach',
	'/usr/bin/dtach',
]

export function resolveDtachBinary(): string | null {
	const executable = (p: string): boolean => {
		try {
			fs.accessSync(p, fs.constants.X_OK)
			return fs.statSync(p).isFile()
		} catch {
			return false
		}
	}
	for (const candidate of DTACH_CANDIDATES) if (executable(candidate)) return candidate
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir) continue
		const candidate = path.join(dir, 'dtach')
		if (executable(candidate)) return candidate
	}
	return null
}

/**
 * Socket directory: /tmp/helm-<uid>, mirroring okena's user-private fallback
 * `/tmp/okena-<uid>` (session_backend.rs:703-727 get_dtach_socket_dir; macOS
 * has no XDG_RUNTIME_DIR, so the fallback IS okena's production path here).
 * HELM_SOCKET_DIR overrides for tests so smoke runs can't pollute (or adopt)
 * the real session pool.
 */
export function socketDir(): string {
	const override = process.env.HELM_SOCKET_DIR
	if (override) return override
	const uid = typeof process.getuid === 'function' ? process.getuid() : 0
	return `/tmp/helm-${uid}`
}

export function ensureSocketDir(): string {
	const dir = socketDir()
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	try {
		fs.chmodSync(dir, 0o700) // pre-existing dir keeps 0700 even if umask interfered
	} catch {
		// best-effort; sockets themselves are srwx------
	}
	return dir
}

/** Session ids feed socket paths; reject anything that could traverse. */
export function isValidSessionId(id: unknown): id is string {
	return typeof id === 'string' && /^[a-z0-9-]{1,64}$/i.test(id)
}

/** Short random id — okena keys sessions as tm-<first 8 uuid chars> (session_backend.rs:175-183). */
export function newSessionId(): string {
	return crypto.randomUUID().slice(0, 8)
}

export function socketPath(sessionId: string): string {
	if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${String(sessionId)}`)
	return path.join(socketDir(), `${sessionId}.sock`)
}

/**
 * argv for the pty child. Okena builds
 *   `sh -c 'mkdir -p <dir> && cd <cwd> && exec dtach -A <socket> -E -r winch <shell>'`
 * (session_backend.rs:279-309). The sh wrapper exists only for mkdir/cd, which
 * we do natively (ensureSocketDir + node-pty's cwd option), so dtach is spawned
 * directly. Flag choices, per okena's comments (session_backend.rs:280-283):
 *   -A        attach if the socket exists, create the session if not — one
 *             invocation covers both fresh spawn and reattach-on-restart
 *   -E        disable the detach character so ^\ can't silently detach a tab
 *   -r winch  redraw method: on attach dtach sends SIGWINCH to the program,
 *             "needed for apps like less, vim" — this is the post-reattach
 *             repaint mechanism (no ctrl-L injection needed)
 * Extra args after the shell pass through to it: `-l` keeps the login-shell
 * behavior of helm's non-persistent spawn.
 */
export function buildSessionArgs(sessionId: string, shell: string): string[] {
	return ['-A', socketPath(sessionId), '-E', '-r', 'winch', shell, '-l']
}

/**
 * Liveness = something serves the socket. Okena asks "does any process hold
 * this socket open" via a process-table scan (cleanup_stale_dtach_sockets,
 * session_backend.rs:456-490; macOS impl via libproc in pty_manager.rs
 * find_pids_for_unix_sockets:1189-1210). Node has net built in, so we use the
 * same predicate in a stronger form: connect() succeeds only when a dtach
 * master is accepting. We write nothing, so the master just sees a client
 * connect + EOF and drops it.
 */
export function isSocketLive(sockPath: string, timeoutMs = 700): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false
		const conn = net.createConnection(sockPath)
		const done = (alive: boolean) => {
			if (settled) return
			settled = true
			conn.destroy()
			resolve(alive)
		}
		conn.once('connect', () => done(true))
		conn.once('error', () => done(false))
		conn.setTimeout(timeoutMs, () => done(false))
	})
}

export interface LiveSession {
	sessionId: string
	/** Socket birthtime — ordering fallback when the registry has no entry. */
	createdAt: string
}

/**
 * Scan the socket dir for live sessions; unlink dead socket files. Port of
 * okena's startup GC `cleanup_stale_dtach_sockets` (session_backend.rs:456-490)
 * fused with its restore path (workspace persistence keeps terminal ids and
 * reattaches via `dtach -A`; persistence.rs:157-172).
 */
export async function listLiveSessions(): Promise<LiveSession[]> {
	let names: string[]
	try {
		names = fs.readdirSync(socketDir()).filter((n) => n.endsWith('.sock'))
	} catch {
		return [] // dir doesn't exist yet — nothing persisted
	}
	const live: LiveSession[] = []
	await Promise.all(
		names.map(async (name) => {
			const sessionId = name.slice(0, -'.sock'.length)
			if (!isValidSessionId(sessionId)) return
			const sock = path.join(socketDir(), name)
			if (await isSocketLive(sock)) {
				let createdAt = new Date(0).toISOString()
				try {
					createdAt = fs.statSync(sock).birthtime.toISOString()
				} catch {
					// stat raced a dying session; keep epoch ordering
				}
				live.push({ sessionId, createdAt })
			} else {
				// No listener → stale socket from a crash; okena removes these
				// (session_backend.rs:477-480).
				try {
					fs.unlinkSync(sock)
				} catch {
					// already gone
				}
			}
		}),
	)
	return live.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function runLines(cmd: string, args: string[]): Promise<number[]> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 5000 }, (_error, stdout) => {
			// lsof/pgrep exit non-zero on "no match"; treat output as the answer.
			resolve(
				stdout
					.split('\n')
					.map((line) => Number.parseInt(line.trim(), 10))
					.filter((pid) => Number.isFinite(pid) && pid > 0),
			)
		})
	})
}

/**
 * PIDs holding a session socket. Okena kills a dtach session by discovering
 * every holder from the process table and SIGTERMing each
 * (session_backend.rs:398-442; discovery via find_pids_for_unix_sockets —
 * /proc on Linux, libproc on macOS, `lsof -t` fallback pty_manager.rs:1308-1360;
 * the WSL variant is literally `lsof -t <sock> | xargs -r kill; rm -f <sock>`,
 * session_backend.rs:677-684). Without libproc we combine:
 *   - `lsof -t <sock>` → the master (holder of the bound socket file), verified
 *     on macOS 25.5; attach clients hold only unnamed connected endpoints
 *   - `pgrep -f <sock>` → master + attach clients (socket path is in argv of
 *     both, since the master is a fork of the invoking dtach)
 */
export async function pidsHoldingSocket(sockPath: string): Promise<number[]> {
	// Sequential on purpose: pgrep -f matches argv, so a concurrently running
	// `lsof -t -- <sock>` (our own) would list itself as a holder.
	const lsofPids = await runLines('lsof', ['-t', '--', sockPath])
	const pgrepPids = await runLines('pgrep', ['-f', sockPath])
	return [...new Set([...lsofPids, ...pgrepPids])]
}

/**
 * Kill a session for real (explicit tab close). Port of okena's
 * ResolvedBackend::kill_session for Dtach (session_backend.rs:398-442):
 * SIGTERM every socket holder except ourselves, then remove the socket file.
 * dtach's master handles SIGTERM by exiting, which closes the pty master and
 * SIGHUPs the shell; okena still unlinks explicitly because a holder killed
 * before dtach's atexit runs would leave the file behind (:440).
 */
export async function killSession(sessionId: string): Promise<void> {
	const sock = socketPath(sessionId)
	if (fs.existsSync(sock)) {
		const holders = await pidsHoldingSocket(sock)
		for (const pid of holders) {
			if (pid === process.pid) continue // okena skips its own pid (session_backend.rs:418-422)
			try {
				process.kill(pid, 'SIGTERM')
			} catch {
				// already exited — okena tolerates the same TOCTOU (session_backend.rs:405-413)
			}
		}
		try {
			fs.unlinkSync(sock)
		} catch {
			// master's atexit may have unlinked it first
		}
	}
}

/**
 * After a pty CLIENT exits on its own (shell `exit` → master gone → client
 * EOF), the session is dead and can be forgotten. But a client can also die
 * while the master lives (our own detach on quit, external kill), so only
 * reap when the socket no longer answers. Returns true when the session is
 * gone (caller should drop registry metadata).
 */
export async function reapSessionIfDead(sessionId: string): Promise<boolean> {
	const sock = socketPath(sessionId)
	if (!fs.existsSync(sock)) return true
	if (await isSocketLive(sock)) return false
	try {
		fs.unlinkSync(sock)
	} catch {
		// already gone
	}
	return true
}

// ---------- grace-period soft close ----------

/**
 * Grace window before a closed tab's session is killed for real. Mirrors
 * okena's soft close default: 5s (okena-workspace/src/settings.rs:494
 * `default_terminal_close_grace_secs() -> 5`; "Grace period ... before a
 * terminal is actually killed when closed. During this window the pane is
 * removed but the PTY keeps running and a toast offers Undo", settings.rs:265-270).
 * Helm deviates upward (15s): okena grace-closes only BUSY terminals, helm
 * grace-closes every tab — and the whole point is time to notice + undo.
 * HELM_CLOSE_GRACE_MS overrides for tests.
 */
export function closeGraceMs(): number {
	const env = Number(process.env.HELM_CLOSE_GRACE_MS)
	return Number.isFinite(env) && env > 0 ? env : 15_000
}

/**
 * Okena-style soft close: on tab close the client is only DETACHED and the
 * real session kill is scheduled after the grace period, so a toast can offer
 * Undo (okena's soft_close.rs — `begin` arms the timer :157-170, the timer
 * fires `finalize_soft_close` which does the actual teardown :162-168, and
 * `undo_soft_close` cancels it). Quit during grace cancels the timers WITHOUT
 * killing — the sessions stay detached and restore on next launch.
 */
export class GraceCloser {
	readonly graceMs: number
	readonly #onKilled: ((sessionId: string) => void) | undefined
	readonly #pending = new Map<string, NodeJS.Timeout>()

	constructor(graceMs: number, onKilled?: (sessionId: string) => void) {
		this.graceMs = graceMs
		this.#onKilled = onKilled
	}

	/** Arm (or re-arm) the delayed kill for a detached session. */
	schedule(sessionId: string): void {
		this.undo(sessionId)
		const timer = setTimeout(() => {
			this.#pending.delete(sessionId)
			void killSession(sessionId).then(() => this.#onKilled?.(sessionId))
		}, this.graceMs)
		this.#pending.set(sessionId, timer)
	}

	/** Cancel a pending kill. True = session untouched and reattachable. */
	undo(sessionId: string): boolean {
		const timer = this.#pending.get(sessionId)
		if (!timer) return false
		clearTimeout(timer)
		this.#pending.delete(sessionId)
		return true
	}

	has(sessionId: string): boolean {
		return this.#pending.has(sessionId)
	}

	/**
	 * Quit path: drop every pending kill without firing it. A session in grace
	 * becomes a normal detached session and restores on next launch.
	 */
	cancelAll(): void {
		for (const timer of this.#pending.values()) clearTimeout(timer)
		this.#pending.clear()
	}
}

// ---------- session registry (tab metadata that can't live in the socket) ----------

export interface SessionMeta {
	createdAt: string
	lastTitle?: string
}

/**
 * Tiny JSON registry (sessionId → createdAt/lastTitle) so restored tabs get
 * their labels back. Okena keeps the analogous mapping in its workspace
 * persistence (terminal ids survive restart when the backend supports
 * persistence; okena-workspace/src/persistence.rs:157-172).
 */
export class SessionRegistry {
	readonly #file: string
	#data: Record<string, SessionMeta> = {}
	#saveTimer: NodeJS.Timeout | null = null

	constructor(file: string) {
		this.#file = file
		try {
			const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
			for (const [id, meta] of Object.entries(raw)) {
				if (!isValidSessionId(id) || typeof meta !== 'object' || meta === null) continue
				const { createdAt, lastTitle } = meta as Record<string, unknown>
				this.#data[id] = {
					createdAt: typeof createdAt === 'string' ? createdAt : new Date(0).toISOString(),
					...(typeof lastTitle === 'string' ? { lastTitle } : {}),
				}
			}
		} catch {
			// missing/corrupt file — start empty
		}
	}

	add(sessionId: string): void {
		this.#data[sessionId] = { createdAt: new Date().toISOString() }
		this.#scheduleSave()
	}

	get(sessionId: string): SessionMeta | undefined {
		return this.#data[sessionId]
	}

	setTitle(sessionId: string, title: string): void {
		const meta = this.#data[sessionId]
		if (!meta || meta.lastTitle === title) return
		meta.lastTitle = title.slice(0, 200)
		this.#scheduleSave()
	}

	remove(sessionId: string): void {
		if (!(sessionId in this.#data)) return
		delete this.#data[sessionId]
		this.#scheduleSave()
	}

	/** Drop metadata for sessions whose sockets are gone (post-scan sync). */
	prune(liveIds: ReadonlySet<string>): void {
		let changed = false
		for (const id of Object.keys(this.#data)) {
			if (!liveIds.has(id)) {
				delete this.#data[id]
				changed = true
			}
		}
		if (changed) this.#scheduleSave()
	}

	/** Debounced: zsh emits OSC titles on every prompt; don't write JSON per keystroke. */
	#scheduleSave(): void {
		if (this.#saveTimer) return
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = null
			this.flush()
		}, 300)
	}

	flush(): void {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer)
			this.#saveTimer = null
		}
		try {
			fs.mkdirSync(path.dirname(this.#file), { recursive: true })
			fs.writeFileSync(this.#file, JSON.stringify(this.#data))
		} catch {
			// best-effort; titles degrade to "zsh" on next restore
		}
	}
}
