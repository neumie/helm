// HelmClaudeHub: the Electron-main side of "Claude in Helm terminals". It
// listens on a private Unix socket for the Claude Code hooks the Helm preload
// registers (one JSON line per hook, see src/agent-dock/claude-hub-wire.ts),
// feeds them to ClaudeHubCore, and implements the agent dock's OkenaClaudeClient
// so a second OkenaClaudeSource runs over it unchanged (reads, CAS, act).
//
// Structured signals only (AGENTS.md): hook JSON, Helm's own terminal
// lifecycle, and `[Request interrupted by user…]` entries Claude writes to its
// transcript. Never PTY output, silence, titles or process liveness.
// Answers go back ONLY as the waiting hook's decision, never as keystrokes; the
// one PTY write is a reply prompt, typed only while the hub shows the primary
// session idle with no dialog (bracketed paste after Ctrl-U, then Enter).

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, open, readFile, realpath, unlink } from 'node:fs/promises'
import { type Server, type Socket, createConnection, createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, sep } from 'node:path'
import { z } from 'zod'
import { CLAUDE_HUB_MAX_LINE_BYTES, helmDockProfile, helmDockProfileId } from '../../../src/agent-dock/claude-hub-wire'
import { ensurePrivateDir, writePrivateFileAtomic } from '../../../src/agent-dock/spool'
import type { OkenaReadOptions } from '../../../src/extensions/okena/client'
import { type BranchReader, readGitBranch } from '../../../src/remote/terminal-metadata'
import type { OkenaClaudeDecision } from '../agent-dock/act'
import type { OkenaClaudeClient } from '../agent-dock/okena-claude-source'
import { CANCELLED_OUTPUT } from './decision'
import { ClaudeHubCore, EXCLUDED_SESSIONS_MAX, HubError, type TerminalRef } from './hub-core'
import type { ClaudeHubTokens } from './token'

/** Gap between the paste and Enter, so the TUI has taken the paste in (Okena ENTER_DELAY). */
export const PROMPT_ENTER_DELAY_MS = 150
/** Bound for one reply (act.ts bounds it lower; this guards the hub on its own). */
export const HUB_PROMPT_MAX = 64 * 1024
const TRANSCRIPT_FIRST_READ = 256 * 1024
const TRANSCRIPT_READ_MAX = 1024 * 1024
const TRANSCRIPT_SCANS_PER_TICK = 16
const INTERRUPT_MARKER = '[Request interrupted by user'
const CLOCK_SKEW_MS = 10 * 60 * 1000
/** A connection must send its request line this soon (long-polls and lifelines then wait without one). */
export const FIRST_LINE_TIMEOUT_MS = 5_000
/** How long a session cwd's git branch is reused before the hub reads it again. */
export const BRANCH_TTL_MS = 10_000
/** Branch reads one state view may start (more cwds keep their last value until a later view). */
const BRANCH_READS_PER_VIEW = 16
/** Hook long-polls + one lifeline per running claude + reads. */
const MAX_CONNECTIONS = 1024

/** How main types into a terminal: an attached Helm tab's pty, else `dtach -p` into the parked session. */
export type HubDeliver = (ref: TerminalRef, chunks: string[], gapMs: number) => Promise<'pty' | 'push'>

export interface HelmClaudeHubOptions {
	socketPath: string
	tokens: ClaudeHubTokens
	/** The active Helm session profile (the dock observes that one). */
	activeProfileId(): string | null
	deliver: HubDeliver
	/** `helm dock show` reads: `{socket, owner}` written here (0600) once listening. */
	ownerFile?: string
	/** Persisted dispatcher session ids (0600). */
	excludedFile?: string
	terminalName?(ref: TerminalRef): string | undefined
	/** Transcript files must resolve under one of these (default ~/.claude and $CLAUDE_CONFIG_DIR). */
	transcriptRoots?: string[]
	now?: () => number
	log?: (message: string) => void
	/** Default FIRST_LINE_TIMEOUT_MS (tests shorten it). */
	firstLineTimeoutMs?: number
	/** Reads a session cwd's git branch (default `git branch --show-current`, user-owned dirs only). */
	readBranch?: BranchReader
}

const requestSchema = z.discriminatedUnion('t', [
	z.object({
		v: z.literal(1),
		t: z.enum(['event', 'permission']),
		token: z.string(),
		pid: z.number().int().positive(),
		at: z.number().finite().optional(),
		input: z.unknown(),
	}),
	z.object({
		v: z.literal(1),
		t: z.literal('degraded'),
		token: z.string(),
		pid: z.number().int().positive(),
		reason: z.string().max(200),
		cwd: z.string().max(4096).optional(),
	}),
	z.object({ v: z.literal(1), t: z.literal('dispatcher'), token: z.string(), session_id: z.string().min(1).max(200) }),
	z.object({ v: z.literal(1), t: z.literal('attach'), token: z.string(), pid: z.number().int().positive() }),
	z.object({
		v: z.literal(1),
		t: z.literal('read'),
		owner: z.string(),
		op: z.enum(['session', 'transcript']),
		profile: z.string().max(200),
		terminal: z.string().max(200),
	}),
])

const excludedFileSchema = z.object({
	version: z.literal(1),
	sessions: z.array(z.string().max(200)).max(EXCLUDED_SESSIONS_MAX),
})

const errorWithStatus = (status: number, message: string): Error & { status: number } =>
	Object.assign(new Error(`Helm Claude hub (${status}): ${message}`), { status })

/** Reply text for the terminal: no escape/control bytes (they could end the bracketed paste), CRs become newlines. */
export function sanitizePrompt(text: string): string {
	return (
		text
			.replace(/\r\n?/g, '\n')
			// biome-ignore lint/suspicious/noControlCharactersInRegex: removing controls is the point
			.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
			.replace(/\s+$/u, '')
	)
}

/** The bytes the hub types: clear the input line (Ctrl-U), bracketed paste, then Enter as its own write. */
export function promptChunks(text: string): string[] {
	return [`\u0015\u001b[200~${text}\u001b[201~`, '\r']
}

interface TailState {
	sessionId: string
	offset: number
}

export class HelmClaudeHub implements OkenaClaudeClient {
	readonly core: ClaudeHubCore
	private server: Server | null = null
	private listening = false
	private readonly owner = randomBytes(24).toString('base64url')
	private readonly tails = new Map<string, TailState>()
	private readonly sockets = new Set<Socket>()
	private readonly now: () => number
	private readonly roots: string[]
	/** Session cwd -> its branch as last read (null: none / not a work tree) and when. */
	private readonly branches = new Map<string, { branch: string | null; at: number }>()

	constructor(private readonly options: HelmClaudeHubOptions) {
		this.now = options.now ?? Date.now
		this.core = new ClaudeHubCore({
			prefix: randomBytes(4).toString('hex'),
			terminalName: options.terminalName,
			onExcludedChange: ids => void this.persistExcluded(ids),
		})
		const configDir = process.env.CLAUDE_CONFIG_DIR
		this.roots = options.transcriptRoots ?? [`${homedir()}/.claude`, ...(configDir ? [configDir] : [])]
	}

	get socketPath(): string {
		return this.options.socketPath
	}

	isListening(): boolean {
		return this.listening
	}

	/** Listens on the socket (refusing to steal one another live hub answers on). Never throws. */
	async start(): Promise<boolean> {
		try {
			await this.loadExcluded()
			const path = this.options.socketPath
			if (await this.socketAnswers(path)) {
				this.warn(`another process answers on ${path}; Claude in Helm terminals stays off`)
				return false
			}
			await unlink(path).catch(() => {})
			const server = createServer(socket => this.accept(socket))
			server.maxConnections = MAX_CONNECTIONS
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject)
				server.listen(path, () => {
					server.off('error', reject)
					resolve()
				})
			})
			await chmod(path, 0o600)
			server.on('error', error => this.warn(`socket error: ${error.message}`))
			this.server = server
			this.listening = true
			if (this.options.ownerFile) {
				await ensurePrivateDir(dirname(this.options.ownerFile))
				await writePrivateFileAtomic(
					this.options.ownerFile,
					JSON.stringify({ version: 1, socket: path, owner: this.owner }),
				)
			}
			return true
		} catch (error) {
			this.warn(`could not listen: ${error instanceof Error ? error.message : String(error)}`)
			return false
		}
	}

	/**
	 * Helm quits. Waiting permission hooks are NOT answered: their connections drop, so they
	 * reconnect to the next hub (hook-client.cjs reconnect window) and the asks survive a restart;
	 * lifelines reconnect the same way.
	 */
	stop(): void {
		this.listening = false
		this.core.shutdown()
		this.tails.clear()
		this.server?.close()
		this.server = null
		for (const socket of this.sockets) socket.destroy()
		this.sockets.clear()
		void unlink(this.options.socketPath).catch(() => {})
	}

	/** Helm's terminal lifecycle: the dtach session ended (reaped, killed, closed). */
	terminalClosed(ref: TerminalRef): void {
		this.core.terminalClosed(ref)
		this.tails.delete(`${ref.profileId}:${ref.terminalId}`)
	}

	// -------------------------------------------------------------------------
	// OkenaClaudeClient (the dock reads and acts through this)
	// -------------------------------------------------------------------------

	activeProfileId(): string | null {
		const id = this.listening ? this.options.activeProfileId() : null
		return id ? helmDockProfile(id) : null
	}

	forProfile(profile: string): OkenaClaudeClient {
		const profileId = helmDockProfileId(profile)
		const ref = (terminalId: string): TerminalRef => {
			if (!profileId) throw errorWithStatus(404, 'not a Helm profile')
			return { profileId, terminalId }
		}
		return {
			activeProfileId: () => this.activeProfileId(),
			forProfile: next => this.forProfile(next),
			getStateJson: async () => {
				if (!profileId) throw errorWithStatus(404, 'not a Helm profile')
				return this.stateJson(profileId)
			},
			getClaudeSession: async terminalId => this.call(() => this.core.session(ref(terminalId))),
			getClaudeTranscript: async (terminalId, query = {}) =>
				this.call(() => this.core.transcript(ref(terminalId), query)),
			postClaudeDialogDecision: async (terminalId, dialogId, decision) =>
				this.call(() => this.core.decide(ref(terminalId), dialogId, decision as OkenaClaudeDecision)),
			postClaudePrompt: async (terminalId, text) => this.prompt(ref(terminalId), text),
		}
	}

	async getStateJson(_opts?: OkenaReadOptions): Promise<unknown> {
		return this.forProfile(this.activeProfileId() ?? '').getStateJson()
	}

	async getClaudeSession(terminalId: string): Promise<unknown> {
		return this.forProfile(this.activeProfileId() ?? '').getClaudeSession(terminalId)
	}

	async getClaudeTranscript(terminalId: string, query?: { cursor?: number; sessionId?: string }): Promise<unknown> {
		return this.forProfile(this.activeProfileId() ?? '').getClaudeTranscript(terminalId, query)
	}

	private async stateJson(profileId: string): Promise<unknown> {
		if (!this.listening) throw errorWithStatus(503, 'not listening')
		await this.scanTranscripts()
		await this.refreshBranches(this.core.projectCwds(profileId))
		return this.core.stateJson(profileId, cwd => this.branches.get(cwd)?.branch ?? undefined)
	}

	/** Re-reads stale cwd branches (bounded per view) and forgets cwds no session uses any more. */
	private async refreshBranches(cwds: string[]): Promise<void> {
		const live = new Set(cwds)
		for (const cwd of this.branches.keys()) if (!live.has(cwd)) this.branches.delete(cwd)
		const now = this.now()
		const stale = cwds
			.filter(cwd => {
				const known = this.branches.get(cwd)
				return !known || now - known.at >= BRANCH_TTL_MS
			})
			.slice(0, BRANCH_READS_PER_VIEW)
		const read = this.options.readBranch ?? readGitBranch
		await Promise.all(
			stale.map(async cwd => {
				const branch = await read(cwd).catch(() => null)
				this.branches.set(cwd, { branch, at: now })
			}),
		)
	}

	private call<T>(run: () => T): T {
		try {
			return run()
		} catch (error) {
			if (error instanceof HubError) throw errorWithStatus(error.status, error.message)
			throw error
		}
	}

	private async prompt(ref: TerminalRef, raw: string): Promise<unknown> {
		const text = sanitizePrompt(raw)
		if (!text) throw errorWithStatus(400, 'empty prompt')
		if (text.length > HUB_PROMPT_MAX) throw errorWithStatus(400, 'prompt too long')
		this.call(() => this.core.checkPrompt(ref, this.now()))
		this.core.typed(ref, this.now())
		const via = await this.options.deliver(ref, promptChunks(text), PROMPT_ENTER_DELAY_MS)
		// Okena's delivery vocabulary: typed into the terminal either way (attached pty or dtach push).
		return { delivery: 'pty', via }
	}

	// -------------------------------------------------------------------------
	// Socket
	// -------------------------------------------------------------------------

	private async socketAnswers(path: string): Promise<boolean> {
		try {
			const info = await lstat(path)
			if (!info.isSocket()) return false
		} catch {
			return false
		}
		return new Promise(resolve => {
			const probe = createConnection(path)
			const done = (alive: boolean) => {
				probe.destroy()
				resolve(alive)
			}
			probe.once('connect', () => done(true))
			probe.once('error', () => done(false))
			setTimeout(() => done(false), 500).unref()
		})
	}

	private accept(socket: Socket): void {
		const chunks: string[] = []
		let size = 0
		let handled = false
		this.sockets.add(socket)
		socket.on('close', () => this.sockets.delete(socket))
		socket.setEncoding('utf8')
		socket.on('error', () => {})
		// No request line in time: drop it (a stalled client must not hold a slot or a buffer).
		socket.setTimeout(this.options.firstLineTimeoutMs ?? FIRST_LINE_TIMEOUT_MS, () => {
			if (!handled) socket.destroy()
		})
		socket.on('data', (chunk: string) => {
			if (handled) return
			// Only the new chunk is searched: a large line stays linear.
			const cut = chunk.indexOf('\n')
			size += cut === -1 ? chunk.length : cut
			if (size > CLAUDE_HUB_MAX_LINE_BYTES) {
				handled = true
				socket.destroy()
				return
			}
			if (cut === -1) {
				chunks.push(chunk)
				return
			}
			handled = true
			socket.setTimeout(0)
			chunks.push(chunk.slice(0, cut))
			const line = chunks.join('')
			const rest = chunk.slice(cut + 1)
			chunks.length = 0
			let body: unknown
			try {
				body = JSON.parse(line)
			} catch {
				socket.destroy()
				return
			}
			this.handle(socket, body, rest)
		})
	}

	private handle(socket: Socket, body: unknown, rest: string): void {
		const parsed = requestSchema.safeParse(body)
		if (!parsed.success) {
			const kind = (body as { t?: unknown } | null)?.t
			if (kind === 'permission') this.reply(socket, { output: CANCELLED_OUTPUT })
			else socket.destroy()
			return
		}
		const request = parsed.data
		if (request.t === 'read') {
			this.read(socket, request)
			return
		}
		const ref = this.options.tokens.verify(request.token)
		if (!ref) {
			// A terminal Helm did not mint (or minted with another secret): leave it to the terminal.
			if (request.t === 'permission') this.reply(socket, { output: CANCELLED_OUTPUT })
			else socket.destroy()
			return
		}
		if (request.t === 'event') {
			socket.end()
			this.core.event(ref, request.pid, this.stamp(request.at), request.input)
			return
		}
		if (request.t === 'degraded') {
			socket.end()
			this.core.degraded(ref, request.pid, request.reason, request.cwd, this.now())
			return
		}
		if (request.t === 'dispatcher') {
			socket.end()
			this.core.registerDispatcher(ref, request.session_id)
			return
		}
		if (request.t === 'attach') {
			this.lifeline(socket, ref, request.pid)
			return
		}
		this.waitPermission(socket, ref, request.pid, this.stamp(request.at), request.input, rest)
	}

	private waitPermission(
		socket: Socket,
		ref: TerminalRef,
		pid: number,
		at: number,
		input: unknown,
		rest: string,
	): void {
		let answered = false
		let dialogId: string | null = null
		const gone = () => {
			if (answered || dialogId === null) return
			answered = true
			this.core.hookGone(ref, dialogId)
		}
		dialogId = this.core.permission(ref, pid, at, input, {
			respond: output => {
				if (answered) return
				answered = true
				this.reply(socket, { output })
			},
		})
		if (dialogId === null) return
		let tail = rest
		const onLine = (chunk: string) => {
			tail += chunk
			// Claude SIGTERMed the hook: the terminal answered No / Esc.
			if (tail.includes('"cancelled"')) gone()
			if (tail.length > 4096) tail = tail.slice(-64)
		}
		if (rest) onLine('')
		socket.on('data', onLine)
		socket.on('close', gone)
	}

	/** The preload's lifeline: open while claude `pid` runs; the kernel closes it on any exit. */
	private lifeline(socket: Socket, ref: TerminalRef, pid: number): void {
		if (socket.destroyed) return
		this.core.attached(ref, pid)
		socket.on('data', () => {})
		socket.once('close', () => this.core.detached(ref, pid))
	}

	private reply(socket: Socket, body: unknown): void {
		if (socket.destroyed) return
		socket.end(`${JSON.stringify(body)}\n`)
	}

	private stamp(at: number | undefined): number {
		const now = this.now()
		return at !== undefined && Math.abs(at - now) <= CLOCK_SKEW_MS ? at : now
	}

	private read(
		socket: Socket,
		request: { owner: string; op: 'session' | 'transcript'; profile: string; terminal: string },
	): void {
		const given = Buffer.from(request.owner)
		const expected = Buffer.from(this.owner)
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
			this.reply(socket, { ok: false, status: 403, error: 'not the Helm owner' })
			return
		}
		const view = this.forProfile(request.profile)
		const run =
			request.op === 'session' ? view.getClaudeSession(request.terminal) : view.getClaudeTranscript(request.terminal)
		run.then(
			body => this.reply(socket, { ok: true, body }),
			error =>
				this.reply(socket, {
					ok: false,
					status: typeof error?.status === 'number' ? error.status : 500,
					error: String(error?.message ?? error).slice(0, 300),
				}),
		)
	}

	// -------------------------------------------------------------------------
	// Transcript interrupt markers
	// -------------------------------------------------------------------------

	/** Reads what busy primaries' transcripts appended since the last tick, for interrupt markers. */
	async scanTranscripts(): Promise<void> {
		const busy = this.core.busyTranscripts().slice(0, TRANSCRIPT_SCANS_PER_TICK)
		const keys = new Set(busy.map(entry => `${entry.ref.profileId}:${entry.ref.terminalId}`))
		for (const key of this.tails.keys()) if (!keys.has(key)) this.tails.delete(key)
		for (const entry of busy) {
			try {
				await this.scanOne(entry.ref, entry.sessionId, entry.path)
			} catch {
				// Unreadable transcript: no marker, nothing inferred.
			}
		}
	}

	private async transcriptAllowed(path: string): Promise<string | null> {
		if (!isAbsolute(path) || !path.endsWith('.jsonl')) return null
		const real = await realpath(path)
		for (const root of this.roots) {
			const base = await realpath(root).catch(() => null)
			if (base && real.startsWith(`${base}${sep}`)) return real
		}
		return null
	}

	private async scanOne(ref: TerminalRef, sessionId: string, path: string): Promise<void> {
		const real = await this.transcriptAllowed(path)
		if (!real) return
		const key = `${ref.profileId}:${ref.terminalId}`
		const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
		try {
			const info = await handle.stat()
			if (!info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return
			const prev = this.tails.get(key)
			let start =
				prev && prev.sessionId === sessionId && prev.offset <= info.size
					? prev.offset
					: Math.max(0, info.size - TRANSCRIPT_FIRST_READ)
			if (info.size - start > TRANSCRIPT_READ_MAX) start = info.size - TRANSCRIPT_FIRST_READ
			const length = info.size - start
			if (length <= 0) {
				this.tails.set(key, { sessionId, offset: info.size })
				return
			}
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await handle.read(buffer, 0, length, start)
			const text = buffer.subarray(0, bytesRead).toString('utf8')
			const cut = text.lastIndexOf('\n')
			if (cut === -1) return
			this.tails.set(key, { sessionId, offset: start + Buffer.byteLength(text.slice(0, cut + 1)) })
			for (const line of text.slice(0, cut).split('\n')) {
				const at = interruptMarkerAt(line)
				if (at !== null) this.core.interrupted(ref, sessionId, at)
			}
		} finally {
			await handle.close()
		}
	}

	// -------------------------------------------------------------------------
	// Persistence
	// -------------------------------------------------------------------------

	private async loadExcluded(): Promise<void> {
		const file = this.options.excludedFile
		if (!file) return
		try {
			const parsed = excludedFileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
			if (parsed.success) for (const id of parsed.data.sessions) this.core.exclude(id)
		} catch {
			// none yet
		}
	}

	private async persistExcluded(ids: string[]): Promise<void> {
		const file = this.options.excludedFile
		if (!file) return
		try {
			await writePrivateFileAtomic(file, JSON.stringify({ version: 1, sessions: ids }))
		} catch (error) {
			this.warn(`could not save dispatcher sessions in ${dirname(file)}: ${(error as Error).message}`)
		}
	}

	private warn(message: string): void {
		;(this.options.log ?? (text => console.warn(`[helm] claude hub: ${text}`)))(message)
	}
}

/** Timestamp of a transcript line that is Claude's own interrupt marker, else null. */
export function interruptMarkerAt(line: string): number | null {
	if (!line.includes(INTERRUPT_MARKER)) return null
	let entry: unknown
	try {
		entry = JSON.parse(line)
	} catch {
		return null
	}
	if (!entry || typeof entry !== 'object') return null
	const record = entry as { type?: unknown; timestamp?: unknown; message?: { content?: unknown } }
	if (record.type !== 'user') return null
	const content = record.message?.content
	const texts =
		typeof content === 'string'
			? [content]
			: Array.isArray(content)
				? content.flatMap(part =>
						part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
							? [(part as { text: string }).text]
							: [],
					)
				: []
	if (!texts.some(text => text.startsWith(INTERRUPT_MARKER))) return null
	const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
	return Number.isFinite(at) ? at : null
}
