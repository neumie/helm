// Signals column, Electron main side. The file:// renderer never talks to the daemon or
// Okena itself: this module polls `GET /api/signals` only while some window shows the
// Signals column, pushes the snapshot when it changed, forwards Jakub's thread actions,
// opens a thread's source (github.com or Mail) and starts a new agent in Okena (`n`).
//
// No Electron import: main injects the daemon request, the IPC gate, execFile, openExternal
// and the push, so this module stays testable under node (tests/helm-signals-main.test.ts).
// Okena is driven only through its CLI: `okena state` (read-only) for projects, then for `n`
// exactly `okena worktree add … --new-branch --wait` and `okena claude start … --trust`.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { oneLine } from '../../src/agent-dock/text'
import { parseDaemonEnvelope } from '../../src/util/daemon-response'
import {
	SIGNALS_IPC,
	type SignalNewAgentRequest,
	type SignalNewAgentResult,
	type SignalOkenaProject,
	type SignalOkenaProjects,
	type SignalsBridgeState,
} from './shared'
import type { HelmResult, SignalRouted, SignalThread, SignalUpdate, SignalsSnapshot } from './shared-helm'

/** While a window shows Signals: re-read every 3 s after the previous read settled. */
export const SIGNALS_POLL_MS = 3_000
/** Becoming visible asks the daemon to poll its sources, at most this often. */
export const SIGNALS_SOURCE_POLL_MIN_MS = 20_000
export const SIGNALS_REQUEST_TIMEOUT_MS = 10_000
export const SIGNALS_UNREACHABLE = 'Helm daemon is not reachable'
/** Prompt bound for `n` (UTF-16 units), the same as a dock reply. */
export const SIGNALS_PROMPT_MAX = 16_384
const REMOTE_CACHE_MS = 5 * 60_000
const REMOTE_CONCURRENCY = 4
const OKENA_STATE_TIMEOUT_MS = 10_000
const OKENA_WORKTREE_TIMEOUT_MS = 180_000
const OKENA_CLAUDE_TIMEOUT_MS = 90_000
const GIT_TIMEOUT_MS = 5_000
const STDERR_MAX = 300
const OPEN_URL_MAX = 2_048
const BRANCH_MAX = 255
const REPO_MAX = 200
const OKENA_STATE_MAX_BUFFER = 32 * 1024 * 1024
/** Okena terminal ids are UUIDs. */
const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** `encodeURIComponent('<message-id>')` behind `message://`: nothing else opens Mail. */
const MESSAGE_URL = /^message:\/\/%3C(?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-Fa-f]{2})+%3E$/i
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BIDI = /[‎‏‪-‮⁦-⁩]/g

export type SignalsRequest = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<HelmResult<T>>

export interface SignalsExecOptions {
	timeout: number
	maxBuffer?: number
	env?: NodeJS.ProcessEnv
}

/** Async execFile (never a shell); rejects like node's with `code`/`stderr`/`killed`. */
export type SignalsExec = (
	file: string,
	args: readonly string[],
	options: SignalsExecOptions,
) => Promise<{ stdout: string; stderr: string }>

export interface SignalsTimers {
	setTimeout(callback: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

/** A renderer that can show the column (Electron's WebContents in main). */
export interface SignalsSender {
	once?(event: 'destroyed', listener: () => void): unknown
}

export interface SignalsMainOptions {
	/** Daemon `/api` request; refuses every non-GET in a side-by-side (read-only) run. */
	request: SignalsRequest
	/** The Signals channels' gate: current profile token AND the main window's renderer. */
	acceptsIpc(sender: unknown, profileToken: unknown): boolean
	/** The current session profile token: a read started under another profile is dropped. */
	profileToken(): string
	/** Pushes SIGNALS_IPC.snapshot to the renderer (main adds the profile token). */
	publish(state: SignalsBridgeState): void
	exec: SignalsExec
	openExternal(url: string): Promise<void>
	userDataDir: string
	/** Okena CLI; default resolveOkenaBinary(). */
	okenaBin?: string
	/** Side-by-side dev instance: no daemon writes, no source polls, no new agents. */
	readOnly: boolean
	readOnlyError?: string
	now?: () => number
	timers?: SignalsTimers
	/** Environment the git/okena children inherit (GIT_* stripped). Default process.env. */
	env?: NodeJS.ProcessEnv
}

/** The slice of Electron's ipcMain Signals registers on. */
export interface SignalsIpc {
	on(channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => void): unknown
	handle(channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => unknown): unknown
}

interface OkenaLayoutNode {
	type?: unknown
	terminal_id?: unknown
	children?: unknown
}

interface OkenaStateProject {
	id: string
	name: string
	path: string
	layout: OkenaLayoutNode | null
	branch: string | null
	parentId: string | null
}

/** `$HELM_OKENA_BIN`, else `~/.local/bin/okena` when it exists, else `okena` on PATH. */
export function resolveOkenaBinary(env: NodeJS.ProcessEnv, home: string, exists: (path: string) => boolean): string {
	const fromEnv = env.HELM_OKENA_BIN?.trim()
	if (fromEnv) return fromEnv
	const local = join(home, '.local', 'bin', 'okena')
	return exists(local) ? local : 'okena'
}

/**
 * Daemon `/api` requests for Signals, the same envelope handling as HelmBridge.request:
 * `{ data } | { error, status? }`, never a rejection; non-GET refused when `readOnlyError` is set.
 */
export function createSignalsDaemonRequest(
	daemonUrl: string,
	options: { readOnlyError?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): SignalsRequest {
	const baseUrl = daemonUrl.replace(/\/$/, '')
	const doFetch = options.fetch ?? fetch
	return async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HelmResult<T>> => {
		if (method !== 'GET' && options.readOnlyError !== undefined) return { error: options.readOnlyError, status: 403 }
		try {
			const res = await doFetch(`${baseUrl}/api${path}`, {
				method,
				headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(options.timeoutMs ?? SIGNALS_REQUEST_TIMEOUT_MS),
			})
			let json: Record<string, unknown>
			try {
				json = parseDaemonEnvelope(res.status, await res.text())
			} catch (error) {
				return { error: errorText(error), status: res.status }
			}
			if (!res.ok)
				return { error: typeof json.error === 'string' ? json.error : `API error: ${res.status}`, status: res.status }
			return { data: json.data as T }
		} catch (error) {
			return { error: errorText(error) }
		}
	}
}

/** A thread's source Jakub may open: https://github.com/… or a Mail `message://%3C…%3E` URL. */
export function signalOpenableUrl(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > OPEN_URL_MAX) return null
	if (MESSAGE_URL.test(value)) return value
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
	if (url.username !== '' || url.password !== '' || url.port !== '') return null
	return url.href
}

/** `origin` of a checkout → lowercase `owner/repo` for github.com remotes (ssh, scp-like or https); else null. */
export function githubRepoFromRemote(remote: string): string | null {
	const text = remote.trim()
	let host: string
	let path: string
	const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(?!\/)(.+)$/.exec(text)
	if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
		host = scp[1] ?? ''
		path = scp[2] ?? ''
	} else {
		try {
			const url = new URL(text)
			if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null
			host = url.hostname
			path = url.pathname
		} catch {
			return null
		}
	}
	host = host.toLowerCase()
	if (host !== 'github.com' && host !== 'ssh.github.com' && host !== 'www.github.com') return null
	const parts = path
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.split('/')
	if (parts.length !== 2) return null
	const repo = `${parts[0]}/${parts[1]}`.toLowerCase()
	return REPO_NAME.test(repo) ? repo : null
}

export class SignalsMain {
	private readonly options: SignalsMainOptions
	private readonly timers: SignalsTimers
	private readonly now: () => number
	private readonly okenaBin: string
	private readonly childEnv: NodeJS.ProcessEnv
	private readonly visible = new Set<unknown>()
	private readonly watched = new WeakSet<object>()
	private state: SignalsBridgeState = { snapshot: null, error: null, at: null }
	/** Profile token the cached state belongs to. */
	private stateToken: string | null = null
	private lastComparable = ''
	private timer: unknown = null
	private reading: Promise<void> | null = null
	private rereadRequested = false
	private lastSourcePollAt: number | null = null
	private newAgentBusy = false
	private readonly remotes = new Map<string, { repo: string | null; at: number }>()
	private stopped = false

	constructor(options: SignalsMainOptions) {
		this.options = options
		this.timers = options.timers ?? {
			setTimeout: (callback, ms) => {
				const handle = setTimeout(callback, ms)
				handle.unref?.()
				return handle
			},
			clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
		}
		this.now = options.now ?? Date.now
		this.okenaBin = options.okenaBin ?? resolveOkenaBinary(options.env ?? process.env, homedir(), existsSync)
		this.childEnv = childEnvironment(options.env ?? process.env)
	}

	/** Current state for this profile (an empty one after a profile switch). */
	getState(): SignalsBridgeState {
		if (this.stateToken !== this.options.profileToken()) return { snapshot: null, error: null, at: null }
		return this.state
	}

	/** Whether any window shows the Signals column (main polls only then). */
	isPolling(): boolean {
		return this.visible.size > 0 && !this.stopped
	}

	setVisible(sender: unknown, visible: boolean): void {
		if (this.stopped) return
		const wasVisible = this.visible.size > 0
		if (visible) {
			this.visible.add(sender)
			this.watchDestroyed(sender)
		} else {
			this.visible.delete(sender)
		}
		const isVisible = this.visible.size > 0
		if (!wasVisible && isVisible) this.becameVisible()
		else if (wasVisible && !isVisible) this.clearTimer()
	}

	/** A renderer reloaded, crashed or closed: it no longer shows the column until it says so again. */
	forget(sender: unknown): void {
		this.setVisible(sender, false)
	}

	/** Reads `/signals` now (single flight: a read in progress is followed by exactly one more). */
	refresh(): Promise<void> {
		if (this.stopped) return Promise.resolve()
		if (this.reading) {
			this.rereadRequested = true
			return this.reading
		}
		this.clearTimer()
		this.reading = this.readLoop().finally(() => {
			this.reading = null
			this.schedule()
		})
		return this.reading
	}

	async update(id: unknown, patch: unknown): Promise<HelmResult<SignalThread>> {
		const threadId = signalId(id)
		if (threadId === null) return { error: 'That signal does not exist.', status: 400 }
		if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
			return { error: 'Nothing to change.', status: 400 }
		return this.write<SignalThread>(`/signals/${threadId}`, patch as SignalUpdate)
	}

	async routed(id: unknown, body: unknown): Promise<HelmResult<SignalThread>> {
		const threadId = signalId(id)
		if (threadId === null) return { error: 'That signal does not exist.', status: 400 }
		if (body === null || typeof body !== 'object' || Array.isArray(body))
			return { error: 'Say which agent it went to.', status: 400 }
		return this.write<SignalThread>(`/signals/${threadId}/routed`, body as SignalRouted)
	}

	async open(value: unknown): Promise<HelmResult<true>> {
		const url = signalOpenableUrl(value)
		if (!url) return { error: 'Only GitHub and Mail links can be opened.', status: 400 }
		try {
			await this.options.openExternal(url)
			return { data: true }
		} catch (error) {
			return { error: `Could not open the link: ${plain(errorText(error))}` }
		}
	}

	async okenaProjects(repo: unknown): Promise<HelmResult<SignalOkenaProjects>> {
		if (repo !== null && (typeof repo !== 'string' || repo.length > REPO_MAX || !REPO_NAME.test(repo)))
			return { error: 'That is not a GitHub repository name.', status: 400 }
		const state = await this.okenaState()
		if (state.data === undefined) return failure(state)
		const parents = state.data.filter(project => project.parentId === null && project.path !== '')
		const repos = await mapLimited(parents, REMOTE_CONCURRENCY, project => this.originRepo(project.path))
		const projects: SignalOkenaProject[] = parents.map((project, index) => ({
			id: project.id,
			name: project.name,
			repo: repos[index] ?? null,
		}))
		const wanted = typeof repo === 'string' ? repo.toLowerCase() : null
		const matches = wanted === null ? [] : projects.filter(project => project.repo === wanted)
		return { data: { projects, suggested: matches.length === 1 ? (matches[0]?.id ?? null) : null } }
	}

	async newAgent(request: unknown): Promise<HelmResult<SignalNewAgentResult>> {
		if (this.options.readOnly)
			return { error: this.options.readOnlyError ?? 'This Helm cannot start agents.', status: 403 }
		if (this.newAgentBusy) return { error: 'A new agent is already starting.', status: 409 }
		const parsed = parseNewAgentRequest(request)
		if (parsed.data === undefined) return failure(parsed)
		this.newAgentBusy = true
		try {
			return await this.startAgent(parsed.data)
		} finally {
			this.newAgentBusy = false
		}
	}

	registerIpc(ipc: SignalsIpc): void {
		const refused = (what: string) => ({ error: `This window cannot ${what} for the current profile.`, status: 409 })
		// Main renderer only, current profile token last (like the other session channels).
		ipc.on(SIGNALS_IPC.setVisible, (event, visible, profileToken) => {
			if (!this.options.acceptsIpc(event.sender, profileToken)) return
			this.setVisible(event.sender, visible === true)
		})
		ipc.handle(SIGNALS_IPC.subscribe, (event, profileToken) => {
			if (!this.options.acceptsIpc(event.sender, profileToken))
				return { snapshot: null, error: 'This window cannot read Signals for the current profile.', at: null }
			return this.getState()
		})
		ipc.handle(SIGNALS_IPC.update, (event, id, patch, profileToken) =>
			this.options.acceptsIpc(event.sender, profileToken) ? this.update(id, patch) : refused('change signals'),
		)
		ipc.handle(SIGNALS_IPC.routed, (event, id, body, profileToken) =>
			this.options.acceptsIpc(event.sender, profileToken) ? this.routed(id, body) : refused('change signals'),
		)
		ipc.handle(SIGNALS_IPC.open, (event, url, profileToken) =>
			this.options.acceptsIpc(event.sender, profileToken) ? this.open(url) : refused('open links'),
		)
		ipc.handle(SIGNALS_IPC.okenaProjects, (event, repo, profileToken) =>
			this.options.acceptsIpc(event.sender, profileToken) ? this.okenaProjects(repo) : refused('read Okena projects'),
		)
		ipc.handle(SIGNALS_IPC.newAgent, (event, request, profileToken) =>
			this.options.acceptsIpc(event.sender, profileToken) ? this.newAgent(request) : refused('start agents'),
		)
	}

	stop(): void {
		this.stopped = true
		this.clearTimer()
		this.visible.clear()
	}

	// --- polling ---------------------------------------------------------------

	private becameVisible(): void {
		const now = this.now()
		const askSources =
			!this.options.readOnly &&
			(this.lastSourcePollAt === null || now - this.lastSourcePollAt >= SIGNALS_SOURCE_POLL_MIN_MS)
		if (!askSources) {
			void this.refresh()
			return
		}
		this.lastSourcePollAt = now
		// The daemon answers at once ({requested:true}); its pollers land on a later read.
		void this.options
			.request<{ requested: boolean }>('POST', '/signals/poll')
			.catch(() => undefined)
			.finally(() => void this.refresh())
	}

	private async readLoop(): Promise<void> {
		do {
			this.rereadRequested = false
			await this.readOnce()
		} while (this.rereadRequested && !this.stopped)
	}

	private async readOnce(): Promise<void> {
		const token = this.options.profileToken()
		let result: HelmResult<SignalsSnapshot>
		try {
			result = await this.options.request<SignalsSnapshot>('GET', '/signals')
		} catch (error) {
			result = { error: errorText(error) }
		}
		// A profile switch landed while reading: this answer belongs to the old profile.
		if (this.stopped || token !== this.options.profileToken()) return
		const previous = this.stateToken === token ? this.state : { snapshot: null, error: null, at: null }
		if (result.data !== undefined && isSnapshot(result.data)) {
			this.setState(token, { snapshot: result.data, error: null, at: this.now() })
		} else {
			const error =
				result.data !== undefined
					? 'Helm daemon sent unreadable Signals.'
					: result.status === undefined
						? SIGNALS_UNREACHABLE
						: plain(result.error)
			this.setState(token, { snapshot: previous.snapshot, error, at: previous.at })
		}
	}

	private setState(token: string, state: SignalsBridgeState): void {
		this.state = state
		this.stateToken = token
		// generatedAt and `at` advance every read; pushing on them would push every 3 s.
		const comparable = JSON.stringify({
			token,
			error: state.error,
			snapshot: state.snapshot ? { ...state.snapshot, generatedAt: '' } : null,
		})
		if (comparable === this.lastComparable) return
		this.lastComparable = comparable
		this.options.publish(state)
	}

	private schedule(): void {
		if (this.stopped || this.visible.size === 0 || this.timer !== null) return
		this.timer = this.timers.setTimeout(() => {
			this.timer = null
			void this.refresh()
		}, SIGNALS_POLL_MS)
	}

	private clearTimer(): void {
		if (this.timer === null) return
		this.timers.clearTimeout(this.timer)
		this.timer = null
	}

	private watchDestroyed(sender: unknown): void {
		if (sender === null || typeof sender !== 'object' || this.watched.has(sender)) return
		const once = (sender as SignalsSender).once
		if (typeof once !== 'function') return
		this.watched.add(sender)
		once.call(sender, 'destroyed', () => this.forget(sender))
	}

	private async write<T>(path: string, body: unknown): Promise<HelmResult<T>> {
		if (this.options.readOnly)
			return { error: this.options.readOnlyError ?? 'This Helm cannot change signals.', status: 403 }
		let result: HelmResult<T>
		try {
			result = await this.options.request<T>('POST', path, body)
		} catch (error) {
			result = { error: errorText(error) }
		}
		// The column catches up right away instead of on the next 3 s tick.
		void this.refresh()
		return result
	}

	// --- Okena ------------------------------------------------------------------

	private async okenaState(): Promise<HelmResult<OkenaStateProject[]>> {
		let stdout: string
		try {
			;({ stdout } = await this.options.exec(this.okenaBin, ['state'], {
				timeout: OKENA_STATE_TIMEOUT_MS,
				maxBuffer: OKENA_STATE_MAX_BUFFER,
				env: this.childEnv,
			}))
		} catch (error) {
			return { error: execFailure('Could not read Okena projects', error, 'Okena is not installed.') }
		}
		const projects = parseOkenaState(stdout)
		return projects ? { data: projects } : { error: 'Okena returned an unreadable state.' }
	}

	private async originRepo(path: string): Promise<string | null> {
		const cached = this.remotes.get(path)
		if (cached && this.now() - cached.at < REMOTE_CACHE_MS) return cached.repo
		let repo: string | null = null
		try {
			const { stdout } = await this.options.exec('git', ['-C', path, 'remote', 'get-url', 'origin'], {
				timeout: GIT_TIMEOUT_MS,
				env: this.childEnv,
			})
			repo = githubRepoFromRemote(stdout)
		} catch {
			repo = null
		}
		this.remotes.set(path, { repo, at: this.now() })
		return repo
	}

	private async startAgent(request: SignalNewAgentRequest): Promise<HelmResult<SignalNewAgentResult>> {
		const before = await this.okenaState()
		if (before.data === undefined) return failure(before)
		const parent = before.data.find(project => project.id === request.projectId && project.parentId === null)
		if (!parent) return { error: 'That Okena project is no longer open.', status: 404 }
		try {
			await this.options.exec('git', ['-C', parent.path, 'check-ref-format', '--branch', request.branch], {
				timeout: GIT_TIMEOUT_MS,
				env: this.childEnv,
			})
		} catch {
			return { error: 'That is not a valid branch name.', status: 400 }
		}

		const dir = join(this.options.userDataDir, 'signals')
		const file = join(dir, `prompt-${randomUUID()}.md`)
		try {
			await mkdir(dir, { recursive: true, mode: 0o700 })
			await chmod(dir, 0o700)
			await writeFile(file, request.prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
		} catch (error) {
			await unlink(file).catch(() => undefined)
			return { error: `Could not write the prompt: ${plain(errorText(error))}` }
		}
		try {
			let created: string
			try {
				;({ stdout: created } = await this.options.exec(
					this.okenaBin,
					['worktree', 'add', request.projectId, request.branch, '--new-branch', '--wait'],
					{ timeout: OKENA_WORKTREE_TIMEOUT_MS, env: this.childEnv },
				))
			} catch (error) {
				return { error: execFailure('Okena could not create the worktree', error, 'Okena is not installed.') }
			}
			const printed = created
				.split(/\s+/)
				.filter(token => TERMINAL_ID.test(token))
				.at(-1)
			const after = await this.okenaState()
			if (after.data === undefined) return failure(after)
			const children = after.data.filter(project => project.parentId === request.projectId)
			const worktree =
				children.find(project => project.branch === request.branch) ??
				(printed ? children.find(project => layoutTerminals(project.layout).includes(printed)) : undefined)
			if (!worktree) return { error: 'Okena created the worktree, but it is not in its project list.' }
			const terminals = layoutTerminals(worktree.layout)
			const terminalId = printed && terminals.includes(printed) ? printed : terminals[0]
			if (!terminalId) return { error: 'Okena created the worktree, but it has no terminal.' }

			let started: string
			try {
				;({ stdout: started } = await this.options.exec(
					this.okenaBin,
					['claude', 'start', terminalId, '--trust', '--prompt-file', file, '--json'],
					{ timeout: OKENA_CLAUDE_TIMEOUT_MS, env: this.childEnv },
				))
			} catch (error) {
				return { error: execFailure('Okena could not start Claude', error, 'Okena is not installed.') }
			}
			return { data: { terminalId, sessionId: sessionIdFrom(started), agentName: request.branch } }
		} finally {
			await unlink(file).catch(() => undefined)
		}
	}
}

// --- pure helpers ------------------------------------------------------------

/** A failed result re-typed for the caller (the error variant carries no data). */
function failure<T>(result: { error?: string; status?: number }): HelmResult<T> {
	return {
		error: result.error ?? 'Something went wrong.',
		...(result.status === undefined ? {} : { status: result.status }),
	}
}

function signalId(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function parseNewAgentRequest(value: unknown): HelmResult<SignalNewAgentRequest> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		return { error: 'The new agent request is incomplete.', status: 400 }
	const raw = value as Record<string, unknown>
	const signalIdValue = signalId(raw.signalId)
	if (signalIdValue === null) return { error: 'That signal does not exist.', status: 400 }
	if (typeof raw.projectId !== 'string' || raw.projectId === '' || raw.projectId.length > 200)
		return { error: 'Pick an Okena project.', status: 400 }
	if (raw.agent !== 'claude') return { error: 'Only Claude can be started from Signals.', status: 400 }
	const branch = typeof raw.branch === 'string' ? raw.branch.trim() : ''
	// git check-ref-format decides the rest; these keep the value a plain positional argument.
	if (
		branch === '' ||
		branch.length > BRANCH_MAX ||
		branch.startsWith('-') ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: a branch never carries controls
		/[\s\u0000-\u001f\u007f]/.test(branch)
	)
		return { error: 'That is not a valid branch name.', status: 400 }
	if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') return { error: 'The prompt is empty.', status: 400 }
	if (raw.prompt.length > SIGNALS_PROMPT_MAX) return { error: 'The prompt is too long.', status: 400 }
	return {
		data: { signalId: signalIdValue, projectId: raw.projectId, branch, agent: 'claude', prompt: raw.prompt },
	}
}

function isSnapshot(value: unknown): value is SignalsSnapshot {
	if (value === null || typeof value !== 'object') return false
	const snapshot = value as Partial<SignalsSnapshot>
	return Array.isArray(snapshot.threads) && Array.isArray(snapshot.sources) && typeof snapshot.seq === 'number'
}

function parseOkenaState(stdout: string): OkenaStateProject[] | null {
	let value: unknown
	try {
		value = JSON.parse(stdout)
	} catch {
		return null
	}
	if (value === null || typeof value !== 'object') return null
	const projects = (value as { projects?: unknown }).projects
	if (!Array.isArray(projects)) return null
	const out: OkenaStateProject[] = []
	for (const entry of projects) {
		if (entry === null || typeof entry !== 'object') continue
		const project = entry as Record<string, unknown>
		if (typeof project.id !== 'string' || project.id === '') continue
		if (project.is_closing === true) continue
		const worktree = project.worktree_info as { parent_project_id?: unknown } | null | undefined
		const git = project.git_status as { branch?: unknown } | null | undefined
		out.push({
			id: project.id,
			name: typeof project.name === 'string' ? oneLine(project.name.replace(BIDI, ''), 200) : project.id,
			path: typeof project.path === 'string' ? project.path : '',
			layout:
				project.layout !== null && typeof project.layout === 'object' ? (project.layout as OkenaLayoutNode) : null,
			branch: typeof git?.branch === 'string' ? git.branch : null,
			parentId:
				worktree && typeof worktree === 'object' && typeof worktree.parent_project_id === 'string'
					? worktree.parent_project_id
					: null,
		})
	}
	return out
}

/** Terminal ids in layout order (depth first), bounded. */
function layoutTerminals(node: OkenaLayoutNode | null, out: string[] = [], depth = 0): string[] {
	if (!node || depth > 32 || out.length >= 64) return out
	if (node.type === 'terminal') {
		if (typeof node.terminal_id === 'string' && node.terminal_id !== '') out.push(node.terminal_id)
		return out
	}
	if (Array.isArray(node.children))
		for (const child of node.children)
			if (child !== null && typeof child === 'object') layoutTerminals(child as OkenaLayoutNode, out, depth + 1)
	return out
}

function sessionIdFrom(stdout: string): string | null {
	try {
		const value: unknown = JSON.parse(stdout)
		if (value !== null && typeof value === 'object') {
			const id = (value as { session_id?: unknown }).session_id
			if (typeof id === 'string' && id !== '' && id.length <= 200) return id
		}
	} catch {
		// Older Okena without JSON here: the agent still started; no session id to show.
	}
	return null
}

/** git and okena children: no inherited GIT_* repository/config redirection, no optional locks. */
function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(env)) if (!key.startsWith('GIT_')) out[key] = value
	out.GIT_OPTIONAL_LOCKS = '0'
	out.GIT_TERMINAL_PROMPT = '0'
	return out
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length)
	let next = 0
	const worker = async () => {
		while (next < items.length) {
			const index = next++
			results[index] = await fn(items[index] as T)
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
	return results
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Untrusted CLI/daemon text as one bounded plain line. */
function plain(text: string): string {
	return oneLine(text.replace(BIDI, ''), STDERR_MAX)
}

function execFailure(what: string, error: unknown, missing: string): string {
	const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown }
	if (failure?.code === 'ENOENT') return missing
	if (failure?.killed === true || failure?.signal === 'SIGTERM') return `${what}: it took too long.`
	const stderr = typeof failure?.stderr === 'string' ? plain(failure.stderr) : ''
	return stderr ? `${what}: ${stderr}` : `${what}.`
}
