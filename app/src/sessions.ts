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
const DTACH_CANDIDATES = ['/opt/homebrew/bin/dtach', '/usr/local/bin/dtach', '/opt/local/bin/dtach', '/usr/bin/dtach']
const PROFILE_ID_RE = /^(?:work|profile-[a-f0-9]{12})$/
let activeProfileId = 'work'

/** Opaque profile ids are the only values permitted in terminal filesystem paths. */
export function isValidSessionProfileId(profileId: unknown): profileId is string {
	return typeof profileId === 'string' && PROFILE_ID_RE.test(profileId)
}

/** Configure the process-lifetime terminal namespace before any session operation. */
export function configureSessionProfile(profileId: string): void {
	if (!isValidSessionProfileId(profileId)) throw new Error(`invalid profile id: ${profileId}`)
	activeProfileId = profileId
}

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
export function socketNamespaceRoot(root = process.env.HELM_SOCKET_DIR): string {
	const uid = typeof process.getuid === 'function' ? process.getuid() : 0
	return root ?? `/tmp/helm-${uid}`
}

/**
 * Profile-explicit dtach namespace. Work intentionally keeps the legacy root;
 * named profiles are below `profiles/<opaque-id>`. Transfer/recovery code MUST
 * use this helper rather than the mutable active namespace.
 */
export function socketDirForProfile(profileId: string, root?: string): string {
	if (!isValidSessionProfileId(profileId)) throw new Error(`invalid profile id: ${profileId}`)
	const base = socketNamespaceRoot(root)
	return profileId === 'work' ? base : path.join(base, 'profiles', profileId)
}

export function socketDir(): string {
	return socketDirForProfile(activeProfileId)
}

export function ensureSocketDirForProfile(profileId: string, root?: string): string {
	const dir = socketDirForProfile(profileId, root)
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	try {
		fs.chmodSync(dir, 0o700) // pre-existing dir keeps 0700 even if umask interfered
	} catch {
		// best-effort; sockets themselves are srwx------
	}
	return dir
}

export function ensureSocketDir(): string {
	return ensureSocketDirForProfile(activeProfileId)
}

/** Session ids feed socket paths; reject anything that could traverse. */
export function isValidSessionId(id: unknown): id is string {
	return typeof id === 'string' && /^[a-z0-9-]{1,64}$/i.test(id)
}

/** Short random id — okena keys sessions as tm-<first 8 uuid chars> (session_backend.rs:175-183). */
export function newSessionId(): string {
	return crypto.randomUUID().slice(0, 8)
}

export function socketPathForProfile(profileId: string, sessionId: string, root?: string): string {
	if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${String(sessionId)}`)
	return path.join(socketDirForProfile(profileId, root), `${sessionId}.sock`)
}

export function socketPath(sessionId: string): string {
	return socketPathForProfile(activeProfileId, sessionId)
}

/**
 * AF_UNIX paths are hard-capped by sun_path (104 bytes on macOS, 108 Linux);
 * node/libuv rejects longer paths with EINVAL on BOTH listen and connect.
 * dtach itself still manages to serve such paths, which is the nasty part:
 * sessions WORK during the run, but every liveness probe false-negatives
 * (EINVAL), so the next launch's GC sees live masters as dead. Persistence
 * must refuse to start in an over-long dir rather than mint sessions it can
 * never probe again. 103 = the tighter (macOS) limit minus NUL; 14 =
 * "/xxxxxxxx.sock" (newSessionId is 8 chars).
 */
const MAX_UNIX_SOCKET_PATH = 103

export function socketPathUsable(sockPath: string): boolean {
	return sockPath.length <= MAX_UNIX_SOCKET_PATH
}

/** Check the actual prospective name; callers moving a session must not rely on a generic dir check. */
export function socketDirUsable(dir: string = socketDir(), sessionId = 'xxxxxxxx'): boolean {
	return isValidSessionId(sessionId) && socketPathUsable(path.join(dir, `${sessionId}.sock`))
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
 *
 * Three-valued on purpose: only ECONNREFUSED/ENOENT prove "file exists,
 * nobody serves it" (a crash leftover, safe to GC). Every other failure —
 * EINVAL (path over the sun_path cap), timeout, transient errno — is
 * 'unknown', and callers MUST NOT destroy anything on 'unknown': treating it
 * as dead is exactly the vanishing-socket bug (live masters, sockets
 * unlinked, nothing restorable).
 */
export type SocketProbe = 'live' | 'dead' | 'unknown'

export function probeSocket(sockPath: string, timeoutMs = 700): Promise<SocketProbe> {
	return new Promise(resolve => {
		let settled = false
		const conn = net.createConnection(sockPath)
		const done = (result: SocketProbe) => {
			if (settled) return
			settled = true
			conn.destroy()
			resolve(result)
		}
		conn.once('connect', () => done('live'))
		conn.once('error', err => {
			// Definitive death only: ECONNREFUSED = socket file with no listener
			// (crash leftover), ENOENT = file gone, ENOTSOCK = not a socket at
			// all — none of these can be a servable session.
			const code = (err as NodeJS.ErrnoException).code
			done(code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ENOTSOCK' ? 'dead' : 'unknown')
		})
		conn.setTimeout(timeoutMs, () => done('unknown'))
	})
}

export async function isSocketLive(sockPath: string, timeoutMs = 700): Promise<boolean> {
	return (await probeSocket(sockPath, timeoutMs)) === 'live'
}

export interface LiveSession {
	sessionId: string
	/** Socket birthtime — ordering fallback when the registry has no entry. */
	createdAt: string
}

export interface SessionScan {
	/** Sessions whose sockets probed live — restorable this launch. */
	live: LiveSession[]
	/**
	 * Sockets that probed 'unknown' (EINVAL/timeout/transient): NOT restorable
	 * this launch, but possibly alive — registry metadata (title, customName,
	 * parked) and buffer snapshots MUST be retained for them. Pruning on
	 * 'unknown' was a real metadata-loss bug: a probe timeout at one startup
	 * silently dropped a live session's title, so it restored as "zsh" forever
	 * after (observed in production — a Jul 11 session alive with no registry
	 * entry two days later). Same asymmetry as reapSessionIfDead: destroying
	 * metadata on a guess costs more than keeping it for a dead session.
	 */
	unknownIds: string[]
}

/**
 * Scan the socket dir: live sessions to restore, unknown-probe ids to retain,
 * dead socket files unlinked. Port of okena's startup GC
 * `cleanup_stale_dtach_sockets` (session_backend.rs:456-490) fused with its
 * restore path (workspace persistence keeps terminal ids and reattaches via
 * `dtach -A`; persistence.rs:157-172).
 */
export async function scanSessions(): Promise<SessionScan> {
	let names: string[]
	try {
		names = fs.readdirSync(socketDir()).filter(n => n.endsWith('.sock'))
	} catch {
		return { live: [], unknownIds: [] } // dir doesn't exist yet — nothing persisted
	}
	const live: LiveSession[] = []
	const unknownIds: string[] = []
	await Promise.all(
		names.map(async name => {
			const sessionId = name.slice(0, -'.sock'.length)
			if (!isValidSessionId(sessionId)) return
			const sock = path.join(socketDir(), name)
			const probe = await probeSocket(sock)
			if (probe === 'live') {
				let createdAt = new Date(0).toISOString()
				try {
					createdAt = fs.statSync(sock).birthtime.toISOString()
				} catch {
					// stat raced a dying session; keep epoch ordering
				}
				live.push({ sessionId, createdAt })
			} else if (probe === 'dead') {
				// ECONNREFUSED: file exists, no listener → stale socket from a
				// crash; okena removes these (session_backend.rs:477-480).
				try {
					fs.unlinkSync(sock)
				} catch {
					// already gone
				}
			} else {
				// 'unknown': never unlink on a guess — a live master may be serving
				// it — and never let the caller prune its metadata either.
				unknownIds.push(sessionId)
			}
			return undefined
		}),
	)
	return {
		live: live.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		unknownIds,
	}
}

/** Live sessions only (restore list). See scanSessions for the full scan. */
export async function listLiveSessions(): Promise<LiveSession[]> {
	return (await scanSessions()).live
}

function runLines(cmd: string, args: string[]): Promise<number[]> {
	return new Promise(resolve => {
		execFile(cmd, args, { timeout: 5000 }, (_error, stdout) => {
			// lsof/pgrep exit non-zero on "no match"; treat output as the answer.
			resolve(
				stdout
					.split('\n')
					.map(line => Number.parseInt(line.trim(), 10))
					.filter(pid => Number.isFinite(pid) && pid > 0),
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
 * The master is the process holding the named listening socket. Attach clients
 * only have unnamed connected endpoints, so unlike pgrep this intentionally
 * does not match the socket path in argv. Terminal transfer uses this as one
 * half of its PID/start-time attestation; it never turns this lookup into a
 * kill list.
 */
export async function masterPidsHoldingSocket(sockPath: string): Promise<number[]> {
	return [...new Set(await runLines('lsof', ['-t', '--', sockPath]))]
}

/** A PID alone is reusable; pair it with ps's process start value before trusting it. */
export function processStartFingerprint(pid: number): Promise<string | null> {
	return new Promise(resolve => {
		if (!Number.isSafeInteger(pid) || pid <= 0) {
			resolve(null)
			return
		}
		execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000 }, (error, stdout) => {
			const value = stdout.trim()
			resolve(!error && value !== '' ? value : null)
		})
	})
}

export interface DtachMasterEvidence {
	pid: number
	processStartFingerprint: string
}

/**
 * Captures exactly one attested dtach master. Ambiguous/unavailable process
 * tables fail closed: callers must not guess from a destination listener.
 */
export async function captureDtachMaster(sockPath: string): Promise<DtachMasterEvidence | null> {
	if ((await probeSocket(sockPath)) !== 'live') return null
	const pids = await masterPidsHoldingSocket(sockPath)
	if (pids.length !== 1) return null
	const pid = pids[0]
	if (pid === undefined) return null
	const fingerprint = await processStartFingerprint(pid)
	return fingerprint ? { pid, processStartFingerprint: fingerprint } : null
}

/**
 * Re-check the journaled master at the current namespace entry. It only reads
 * process/socket state; terminal transfer must never signal the master.
 */
export async function attestDtachMaster(
	sockPath: string,
	expected: DtachMasterEvidence,
): Promise<'verified' | 'dead' | 'unknown'> {
	const fingerprint = await processStartFingerprint(expected.pid)
	if (!fingerprint) {
		try {
			process.kill(expected.pid, 0)
			return 'unknown'
		} catch {
			return 'dead'
		}
	}
	if (fingerprint !== expected.processStartFingerprint) return 'unknown'
	const pids = await masterPidsHoldingSocket(sockPath)
	return pids.includes(expected.pid) ? 'verified' : 'unknown'
}

/**
 * Rename only the dtach socket directory entry. This deliberately has no
 * process signalling fallback: a failed rename leaves recovery to the journal.
 */
export function renameSocketEntry(sourceSocket: string, destinationSocket: string): void {
	if (!socketPathUsable(sourceSocket) || !socketPathUsable(destinationSocket)) {
		throw new Error('terminal socket path exceeds the AF_UNIX limit')
	}
	if (fs.existsSync(destinationSocket)) throw new Error('destination terminal socket already exists')
	const source = fs.lstatSync(sourceSocket)
	if (!source.isSocket()) throw new Error('source terminal socket is not a socket')
	fs.mkdirSync(path.dirname(destinationSocket), {
		recursive: true,
		mode: 0o700,
	})
	fs.renameSync(sourceSocket, destinationSocket)
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
 * while the master lives (external kill), so only reap when the socket
 * provably refuses. Returns true when the session is gone (caller should
 * drop registry metadata).
 *
 * This NEVER unlinks the socket file, and treats only a definitive probe
 * ('dead' = ECONNREFUSED) as death. It used to unlink on ANY probe failure,
 * which destroyed live sessions when the probe false-negatived (observed:
 * EINVAL when the socket dir exceeds the AF_UNIX path cap — dtach serves the
 * path, node can't even connect to it) — the vanishing-socket bug: masters
 * alive, sockets unlinked, nothing restorable. A genuinely dead session's
 * file is either already unlinked by dtach's master atexit, or it's a crash
 * leftover that startup GC (`listLiveSessions`) collects. Losing registry
 * metadata to a bad guess degrades a restore (title/parked fall back to
 * defaults); losing the socket file loses the session — keep this asymmetric.
 */
export async function reapSessionIfDead(sessionId: string): Promise<boolean> {
	const sock = socketPath(sessionId)
	if (!fs.existsSync(sock)) return true
	return (await probeSocket(sock)) === 'dead'
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

export type SessionBacking = 'ordinary' | 'run-owned'

/**
 * Non-secret durable identity for an Electron-owned scheduled dtach client.
 * Socket paths, PIDs, process identity, and capabilities deliberately never
 * enter this registry or any renderer-facing restored-session shape.
 */
export interface ScheduledSessionOwnership {
	profileId: string
	runId: string
	revision: number
	adoptionId: string
	adopter: string
}

function isUuid(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	)
}

export function isScheduledSessionOwnership(value: unknown): value is ScheduledSessionOwnership {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const ownership = value as Record<string, unknown>
	return (
		isValidSessionProfileId(ownership.profileId) &&
		typeof ownership.runId === 'string' &&
		/^[a-z0-9-]{1,80}$/i.test(ownership.runId) &&
		typeof ownership.revision === 'number' &&
		Number.isInteger(ownership.revision) &&
		ownership.revision >= 0 &&
		isUuid(ownership.adoptionId) &&
		isUuid(ownership.adopter)
	)
}

/** A persisted group can be disclosed independently in either terminal surface. */
export type TabGroupSurface = 'strip' | 'background'

/** Stable, opaque group metadata stored under the reserved `_tabGroups` registry key. */
export interface TabGroupMeta {
	name: string
	collapsedStrip?: boolean
	collapsedBackground?: boolean
}

/** Public group shape with explicit false values for consumers. */
export interface TabGroup {
	id: string
	name: string
	collapsedStrip: boolean
	collapsedBackground: boolean
}

/**
 * Declarative group commands for UI/main adapters. They deliberately contain
 * no terminal/PTY operation; an adapter resolves and performs those effects.
 */
export type TabGroupActionIntent =
	| { type: 'rename'; groupId: string; name: string }
	| { type: 'move'; sessionId: string; groupId: string | null }
	| { type: 'open-all'; groupId: string }
	| { type: 'restore-all'; groupId: string }
	| { type: 'move-all-background'; groupId: string }
	| { type: 'close-all'; groupId: string }

export function isValidTabGroupId(id: unknown): id is string {
	return typeof id === 'string' && /^group-[a-f0-9]{8}$/.test(id)
}

function normalizedTabGroupName(name: unknown): string | null {
	if (typeof name !== 'string') return null
	const normalized = name.trim().slice(0, 200)
	return normalized === '' ? null : normalized
}

/** Validates and constructs a pure group command; it never changes registry or PTY state. */
export function tabGroupActionIntent(
	type: TabGroupActionIntent['type'],
	params: {
		groupId?: unknown
		name?: unknown
		sessionId?: unknown
		targetGroupId?: unknown
	},
): TabGroupActionIntent | null {
	if (type === 'move') {
		if (!isValidSessionId(params.sessionId)) return null
		if (params.targetGroupId !== null && !isValidTabGroupId(params.targetGroupId)) return null
		return {
			type,
			sessionId: params.sessionId,
			groupId: params.targetGroupId ?? null,
		}
	}
	if (!isValidTabGroupId(params.groupId)) return null
	if (type === 'rename') {
		const name = normalizedTabGroupName(params.name)
		return name ? { type, groupId: params.groupId, name } : null
	}
	return { type, groupId: params.groupId }
}

export interface SessionMeta {
	createdAt: string
	/** Explicit cross-relaunch order. Missing = legacy registry; createdAt remains fallback. */
	order?: number
	lastTitle?: string
	/**
	 * Manual tab name (double-click rename). PINS the tab: never overwritten by
	 * OSC titles, survives relaunch and park/restore. Separate field from
	 * lastTitle so live OSC tracking and the pin can't clobber each other.
	 * Absent = unpinned (backward compatible with pre-customName registries).
	 */
	customName?: string
	/** Parked in the background list (strip-right popover) instead of the tab strip. */
	parked?: boolean
	/** Omitted legacy entries are ordinary user terminals. Run-owned sessions are never transferable. */
	backing?: SessionBacking
	/** Required for run-owned scheduled sessions; intentionally non-secret. */
	scheduledOwnership?: ScheduledSessionOwnership
	/** Protocol-observed activity retained for an inactive destination profile. */
	agentRunning?: boolean
	agentAttention?: boolean
	/** Optional tab-group membership; transfer always clears this at its destination. */
	groupId?: string | null
}

type SessionRegistryFile = Record<string, SessionMeta | Record<string, TabGroupMeta>> & {
	_tabGroups?: Record<string, TabGroupMeta>
}

export interface SessionRegistryTransferResult {
	status: 'moved' | 'missing-source' | 'collision' | 'run-owned' | 'failed'
	meta?: SessionMeta
}

export function compareSessionOrder(
	a: Pick<SessionMeta, 'order' | 'createdAt'>,
	b: Pick<SessionMeta, 'order' | 'createdAt'>,
): number {
	return (
		(a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
		a.createdAt.localeCompare(b.createdAt)
	)
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
	#groups: Record<string, TabGroupMeta> = {}
	#saveTimer: NodeJS.Timeout | null = null
	readonly #persistDocument: (file: string, document: SessionRegistryFile) => void

	constructor(file: string, writeDocument = SessionRegistry.#writeDocument) {
		this.#file = file
		this.#persistDocument = writeDocument
		try {
			const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
			const rawGroups = raw._tabGroups
			if (typeof rawGroups === 'object' && rawGroups !== null && !Array.isArray(rawGroups)) {
				for (const [id, meta] of Object.entries(rawGroups)) {
					if (!isValidTabGroupId(id) || typeof meta !== 'object' || meta === null || Array.isArray(meta)) continue
					const candidate = meta as Record<string, unknown>
					const name = normalizedTabGroupName(candidate.name)
					if (!name) continue
					this.#groups[id] = {
						name,
						...(candidate.collapsedStrip === true ? { collapsedStrip: true } : {}),
						...(candidate.collapsedBackground === true ? { collapsedBackground: true } : {}),
					}
				}
			}
			for (const [id, meta] of Object.entries(raw)) {
				if (!isValidSessionId(id) || typeof meta !== 'object' || meta === null || Array.isArray(meta)) continue
				const {
					createdAt,
					order,
					lastTitle,
					customName,
					parked,
					backing,
					scheduledOwnership,
					agentRunning,
					agentAttention,
					groupId,
				} = meta as Record<string, unknown>
				// A run-owned record without its complete non-secret identity cannot
				// be restored safely, so fail closed by ignoring that malformed row.
				if (backing === 'run-owned' && !isScheduledSessionOwnership(scheduledOwnership)) continue
				this.#data[id] = {
					createdAt: typeof createdAt === 'string' ? createdAt : new Date(0).toISOString(),
					...(typeof order === 'number' && Number.isFinite(order) && order >= 0 ? { order } : {}),
					...(typeof lastTitle === 'string' ? { lastTitle } : {}),
					...(typeof customName === 'string' && customName !== '' ? { customName } : {}),
					...(parked === true ? { parked: true } : {}),
					...(backing === 'run-owned'
						? { backing, scheduledOwnership: { ...(scheduledOwnership as ScheduledSessionOwnership) } }
						: {}),
					...(agentRunning === true ? { agentRunning: true } : {}),
					...(agentAttention === true ? { agentAttention: true } : {}),
					...(typeof groupId === 'string' && this.#groups[groupId] ? { groupId } : {}),
				}
			}
			this.#removeEmptyGroups()
		} catch {
			// missing/corrupt file — start empty
		}
	}

	add(sessionId: string): void {
		this.#data[sessionId] = { createdAt: new Date().toISOString() }
		this.#scheduleSave()
	}

	/** Re-adopt a live dtach session when registry JSON was missing/corrupt. */
	ensure(sessionId: string, createdAt = new Date().toISOString()): void {
		if (this.#data[sessionId]) return
		this.#data[sessionId] = { createdAt }
		this.#scheduleSave()
	}

	get(sessionId: string): SessionMeta | undefined {
		return this.#data[sessionId]
	}

	/** All known session ids (startup orphan sweeps read this before prune()). */
	ids(): string[] {
		return Object.keys(this.#data)
	}

	/** Current profile-local group definitions in deterministic creation order. */
	getGroups(): TabGroup[] {
		return Object.entries(this.#groups).map(([id, meta]) => ({
			id,
			name: meta.name,
			collapsedStrip: meta.collapsedStrip === true,
			collapsedBackground: meta.collapsedBackground === true,
		}))
	}

	/** Current retained members, or null when the definition no longer exists. */
	groupMembers(groupId: string): string[] | null {
		if (!this.#groups[groupId]) return null
		return Object.entries(this.#data).flatMap(([sessionId, meta]) => (meta.groupId === groupId ? [sessionId] : []))
	}

	/** Creates a non-empty group and assigns all known unique members in one mutation. */
	createGroup(name: string, sessionIds: readonly string[]): TabGroup | null {
		const normalized = normalizedTabGroupName(name)
		if (!normalized) return null
		const members = [...new Set(sessionIds)].flatMap(sessionId => (this.#data[sessionId] ? [sessionId] : []))
		if (members.length === 0) return null
		let id: string
		do {
			id = `group-${crypto.randomUUID().slice(0, 8)}`
		} while (this.#groups[id])
		this.#groups[id] = { name: normalized }
		for (const sessionId of members) {
			const meta = this.#data[sessionId]
			if (meta) meta.groupId = id
		}
		this.#removeEmptyGroups()
		this.#scheduleSave()
		return {
			id,
			name: normalized,
			collapsedStrip: false,
			collapsedBackground: false,
		}
	}

	renameGroup(groupId: string, name: string): TabGroup | null {
		const group = this.#groups[groupId]
		const normalized = normalizedTabGroupName(name)
		if (!group || !normalized || group.name === normalized) return group ? this.#group(groupId) : null
		group.name = normalized
		this.#scheduleSave()
		return this.#group(groupId)
	}

	/** Deletes the definition but deliberately retains every member as Ungrouped. */
	deleteGroup(groupId: string): boolean {
		if (!this.#groups[groupId]) return false
		for (const meta of Object.values(this.#data)) {
			if (meta.groupId === groupId) meta.groupId = undefined
		}
		delete this.#groups[groupId]
		this.#scheduleSave()
		return true
	}

	/** Assigns one retained session or clears it to Ungrouped. */
	setSessionGroup(sessionId: string, groupId: string | null): boolean {
		const meta = this.#data[sessionId]
		if (!meta || (groupId !== null && !this.#groups[groupId])) return false
		const next = groupId ?? undefined
		if (meta.groupId === next) return false
		meta.groupId = next
		this.#removeEmptyGroups()
		this.#scheduleSave()
		return true
	}

	/** Disclosure is presentation metadata only; it never moves sessions. */
	setGroupCollapsed(groupId: string, surface: TabGroupSurface, collapsed: boolean): boolean {
		const group = this.#groups[groupId]
		if (!group) return false
		const key = surface === 'strip' ? 'collapsedStrip' : 'collapsedBackground'
		const next = collapsed ? true : undefined
		if (group[key] === next) return false
		group[key] = next
		this.#scheduleSave()
		return true
	}

	/**
	 * Atomically changes retained group members' placement metadata. Renderer or
	 * main adapters own the corresponding PTY/DOM movement.
	 */
	moveGroup(groupId: string, parked: boolean): string[] | null {
		if (!this.#groups[groupId]) return null
		const members: string[] = []
		let changed = false
		for (const [sessionId, meta] of Object.entries(this.#data)) {
			if (meta.groupId !== groupId) continue
			members.push(sessionId)
			if ((meta.parked === true) === parked) continue
			meta.parked = parked ? true : undefined
			changed = true
		}
		if (changed) this.#scheduleSave()
		return members
	}

	setTitle(sessionId: string, title: string): void {
		const meta = this.#data[sessionId]
		if (!meta || meta.lastTitle === title) return
		meta.lastTitle = title.slice(0, 200)
		this.#scheduleSave()
	}

	/**
	 * Pin/unpin a manual tab name. Empty/null clears the pin (OSC follow
	 * resumes); `undefined` (not '') so JSON.stringify drops the key when
	 * cleared — old registries stay readable, new ones stay additive.
	 */
	setCustomName(sessionId: string, name: string | null): void {
		const meta = this.#data[sessionId]
		if (!meta) return
		const trimmed = (name ?? '').trim().slice(0, 200)
		const next = trimmed === '' ? undefined : trimmed
		if (meta.customName === next) return
		meta.customName = next
		this.#scheduleSave()
	}

	/**
	 * Park/unpark a session (background terminals). Persisted so a parked
	 * session restores as parked — in the popover, never as a strip tab.
	 */
	setParked(sessionId: string, parked: boolean): void {
		const meta = this.#data[sessionId]
		if (!meta || (meta.parked === true) === parked) return
		// undefined (not false) so JSON.stringify drops the key when unparked.
		meta.parked = parked ? true : undefined
		this.#scheduleSave()
	}

	/** Explicitly marks an existing session as ordinary backing. Run-owned records use registerRunOwned(). */
	setBacking(sessionId: string, backing: SessionBacking): void {
		const meta = this.#data[sessionId]
		if (!meta || backing === 'run-owned' || (meta.backing ?? 'ordinary') === backing) return
		meta.backing = undefined
		meta.scheduledOwnership = undefined
		this.#scheduleSave()
	}

	/**
	 * Atomically records a newly attached scheduled client before daemon
	 * completion. A false return means no ownership evidence was retained.
	 */
	registerRunOwned(sessionId: string, ownership: ScheduledSessionOwnership): boolean {
		if (!isValidSessionId(sessionId) || !isScheduledSessionOwnership(ownership) || this.#data[sessionId]) return false
		this.#data[sessionId] = {
			createdAt: new Date().toISOString(),
			backing: 'run-owned',
			scheduledOwnership: { ...ownership },
		}
		if (this.flushSync()) return true
		// Atomic write failure leaves the previous on-disk document intact; restore
		// the same state in memory so a later cosmetic flush cannot persist a
		// reservation the coordinator already rejected.
		delete this.#data[sessionId]
		return false
	}

	removeRunOwned(sessionId: string): boolean {
		const existing = this.#data[sessionId]
		if (existing?.backing !== 'run-owned') return true
		const previousGroups = structuredClone(this.#groups)
		delete this.#data[sessionId]
		this.#removeEmptyGroups()
		if (this.flushSync()) return true
		this.#data[sessionId] = existing
		this.#groups = previousGroups
		return false
	}

	/** Main-only startup recovery source. Never expose ownership through sessions:list. */
	listRunOwned(): Array<{ sessionId: string; ownership: ScheduledSessionOwnership; meta: SessionMeta }> {
		return Object.entries(this.#data).flatMap(([sessionId, meta]) =>
			meta.backing === 'run-owned' && meta.scheduledOwnership
				? [{ sessionId, ownership: { ...meta.scheduledOwnership }, meta: structuredClone(meta) }]
				: [],
		)
	}

	/** Persist protocol-owned activity only; no output/title inference is permitted. */
	setActivity(sessionId: string, activity: { agentRunning: boolean; agentAttention: boolean }): void {
		const meta = this.#data[sessionId]
		if (!meta) return
		const nextRunning = activity.agentRunning ? true : undefined
		const nextAttention = activity.agentAttention ? true : undefined
		if (meta.agentRunning === nextRunning && meta.agentAttention === nextAttention) return
		meta.agentRunning = nextRunning
		meta.agentAttention = nextAttention
		this.#scheduleSave()
	}

	/** Persist renderer-owned strip/background ordering as compact positions. */
	setOrder(sessionIds: readonly string[]): void {
		let changed = false
		const seen = new Set<string>()
		let order = 0
		for (const sessionId of sessionIds) {
			if (seen.has(sessionId)) continue
			seen.add(sessionId)
			const meta = this.#data[sessionId]
			if (!meta) continue
			if (meta.order !== order) {
				meta.order = order
				changed = true
			}
			order += 1
		}
		if (changed) this.#scheduleSave()
	}

	/** Path is exposed only to main-process persistence coordinators. */
	get filePath(): string {
		return this.#file
	}

	/**
	 * Move one ordinary session's metadata between profile registries. Both JSON
	 * documents are fully prepared before either rename; destination is renamed
	 * first and a source-write failure is rolled back to its original document.
	 * It intentionally does not touch sockets or buffers (the journaled
	 * coordinator will order those operations).
	 */
	transferTo(destination: SessionRegistry, sessionId: string): SessionRegistryTransferResult {
		const sourceMeta = this.#data[sessionId]
		if (!sourceMeta) return { status: 'missing-source' }
		if ((sourceMeta.backing ?? 'ordinary') !== 'ordinary') return { status: 'run-owned' }
		if (destination.#data[sessionId]) return { status: 'collision' }
		this.#cancelSave()
		destination.#cancelSave()
		const sourceBefore = structuredClone(this.#data)
		const sourceGroupsBefore = structuredClone(this.#groups)
		const destinationBefore = structuredClone(destination.#data)
		const destinationGroupsBefore = structuredClone(destination.#groups)
		// Order is profile-local UI metadata. Never carry a source position into
		// the destination: append after every existing destination entry (and
		// therefore after its parked Background entries) with a collision-free
		// destination-owned value. Legacy unordered entries still consume a slot.
		const destinationNextOrder =
			Math.max(
				destinationBefore ? Object.keys(destinationBefore).length - 1 : -1,
				...Object.values(destinationBefore).map(meta => meta.order ?? -1),
			) + 1
		const moved: SessionMeta = {
			...structuredClone(sourceMeta),
			order: destinationNextOrder,
			parked: true,
			groupId: null,
		}
		const sourceAfter = structuredClone(sourceBefore)
		const sourceGroupsAfter = structuredClone(sourceGroupsBefore)
		const destinationAfter = { ...destinationBefore, [sessionId]: moved }
		delete sourceAfter[sessionId]
		SessionRegistry.#removeEmptyGroupsFrom(sourceAfter, sourceGroupsAfter)
		try {
			SessionRegistry.#writeDocument(
				destination.#file,
				SessionRegistry.#document(destinationAfter, destinationGroupsBefore),
			)
			try {
				SessionRegistry.#writeDocument(this.#file, SessionRegistry.#document(sourceAfter, sourceGroupsAfter))
			} catch (error) {
				// Destination first is required for crash repair. If source did not
				// commit, restore destination while source remains authoritative.
				SessionRegistry.#writeDocument(
					destination.#file,
					SessionRegistry.#document(destinationBefore, destinationGroupsBefore),
				)
				throw error
			}
			this.#data = sourceAfter
			this.#groups = sourceGroupsAfter
			destination.#data = destinationAfter
			destination.#groups = destinationGroupsBefore
			return { status: 'moved', meta: structuredClone(moved) }
		} catch {
			return { status: 'failed' }
		}
	}

	remove(sessionId: string): void {
		if (!(sessionId in this.#data)) return
		delete this.#data[sessionId]
		this.#removeEmptyGroups()
		this.#scheduleSave()
	}

	/** Drop ordinary metadata for sessions whose sockets are gone (post-scan sync).
	 * Run-owned scheduled sessions use a separate daemon namespace and are
	 * retained until their exact completed-owner re-attestation says otherwise. */
	prune(liveIds: ReadonlySet<string>): void {
		let changed = false
		for (const id of Object.keys(this.#data)) {
			if (!liveIds.has(id) && this.#data[id]?.backing !== 'run-owned') {
				delete this.#data[id]
				changed = true
			}
		}
		if (this.#removeEmptyGroups()) changed = true
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
		this.flushSync()
	}

	/** Synchronous atomic persistence result for ownership handoff ordering. */
	flushSync(): boolean {
		this.#cancelSave()
		try {
			this.#persistDocument(this.#file, SessionRegistry.#document(this.#data, this.#groups))
			return true
		} catch {
			// Cosmetic callers may degrade; handoff callers inspect the false result.
			return false
		}
	}

	#group(groupId: string): TabGroup | null {
		const meta = this.#groups[groupId]
		return meta
			? {
					id: groupId,
					name: meta.name,
					collapsedStrip: meta.collapsedStrip === true,
					collapsedBackground: meta.collapsedBackground === true,
				}
			: null
	}

	#removeEmptyGroups(): boolean {
		return SessionRegistry.#removeEmptyGroupsFrom(this.#data, this.#groups)
	}

	static #removeEmptyGroupsFrom(data: Record<string, SessionMeta>, groups: Record<string, TabGroupMeta>): boolean {
		const memberGroups = new Set(
			Object.values(data)
				.map(meta => meta.groupId)
				.filter((groupId): groupId is string => typeof groupId === 'string'),
		)
		let changed = false
		for (const groupId of Object.keys(groups)) {
			if (memberGroups.has(groupId)) continue
			delete groups[groupId]
			changed = true
		}
		return changed
	}

	static #document(data: Record<string, SessionMeta>, groups: Record<string, TabGroupMeta>): SessionRegistryFile {
		const document: SessionRegistryFile = {}
		for (const [sessionId, meta] of Object.entries(data)) {
			const { groupId: _groupId, ...sessionMeta } = meta
			document[sessionId] = {
				...sessionMeta,
				...(typeof _groupId === 'string' && groups[_groupId] ? { groupId: _groupId } : {}),
			}
		}
		const nonEmptyGroups = Object.fromEntries(
			Object.entries(groups).map(([groupId, meta]) => [
				groupId,
				{
					name: meta.name,
					...(meta.collapsedStrip === true ? { collapsedStrip: true } : {}),
					...(meta.collapsedBackground === true ? { collapsedBackground: true } : {}),
				},
			]),
		)
		if (Object.keys(nonEmptyGroups).length > 0) document._tabGroups = nonEmptyGroups
		return document
	}

	#cancelSave(): void {
		if (!this.#saveTimer) return
		clearTimeout(this.#saveTimer)
		this.#saveTimer = null
	}

	static #writeDocument(file: string, data: SessionRegistryFile): void {
		const tempFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(tempFile, JSON.stringify(data), { mode: 0o600 })
			fs.renameSync(tempFile, file)
		} finally {
			try {
				fs.unlinkSync(tempFile)
			} catch {
				// rename consumed it, or the failed write created nothing
			}
		}
	}
}
