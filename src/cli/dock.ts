// `helm dock`: read-only view of the Helm agent dock (slice 1) for the
// dispatcher agent. Reads the file spool the desktop app writes under
// <Helm userData>/agent-dock (see src/agent-dock/spool.ts). Never answers,
// prompts or acts; `show` reads the full question/turn text live (never spooled
// to disk) from the session's source: Okena's Claude Remote API (GET only), or
// Helm's own Claude hub for Claude Code in Helm terminals (owner-token read).
// `watch` run inside a Helm terminal's Claude session registers that session as
// the dispatcher, so Helm hides it (and it never reports on itself).

import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
	CLAUDE_REMOTE_ENV,
	claudeHubReadReplySchema,
	claudeHubRequest,
	helmDockProfileId,
	readClaudeHubOwnerFile,
} from '../agent-dock/claude-hub-wire.js'
import {
	SPOOL_CURSOR_FILE,
	SPOOL_EVENTS_FILE,
	SPOOL_HEARTBEAT_FILE,
	type SpoolItem,
	type SpoolSession,
	type SpoolSnapshot,
	defaultAgentDockDir,
	ensurePrivateDir,
	latestSpoolSeq,
	parseEventLines,
	readSpoolEvents,
	readSpoolFile,
	readSpoolSnapshot,
	writePrivateFileAtomic,
} from '../agent-dock/spool.js'
import { OkenaClient } from '../extensions/okena/client.js'

export const DOCK_HELP = `Usage: helm dock <command> [options]

Read-only view of the Helm agent dock (Claude sessions in Okena panes and in
Helm terminals that need you). Helm desktop must be running; it writes the
spool these commands read.

Commands:
  watch          NDJSON event stream for a Monitor: first a {"t":"catchup"} line,
                 then every event after the stored cursor, then follows.
                 Touches dispatcher.heartbeat every 20 s. Inside a Helm
                 terminal's Claude session it also registers that session as
                 the dispatcher, so Helm never lists it.
  ls             Open items, then agent sessions
  show ID        One item; open items also fetch the full question/turn live
                 from its source, Okena or Helm (read-only)
  help           Show this help

Options:
  --json         Machine-readable output (ls, show)
  --all          ls: include resolved items from the last 24 h
  --no-live      show: spool data only, no Okena read
  --cursor FILE  watch: cursor file (default <dir>/dispatcher.cursor)
  --dir DIR      Spool directory (default $HELM_AGENT_DOCK_DIR or
                 <appData>/Helm/agent-dock)

Exit codes: 0 ok, 1 usage/unknown item, 4 a source unreachable (ls),
5 Helm not running or no snapshot.
`

export const EXIT_SOURCE_DOWN = 4
export const EXIT_HELM_DOWN = 5
export const HEARTBEAT_MS = 20_000
const FOLLOW_POLL_MS = 500
const HOST_CHECK_MS = 5_000
const CATCHUP_MAX_IDS = 40
const LIVE_INPUT_MAX = 64 * 1024
const LIVE_TURN_MAX = 2_048

/** Okena reads `show` needs (OkenaClient satisfies it; tests inject a double). */
export interface DockOkenaReader {
	getClaudeSession(terminalId: string): Promise<unknown>
	getClaudeTranscript(terminalId: string): Promise<unknown>
}

export interface DockCliDeps {
	out(line: string): void | Promise<void>
	err(line: string): void
	env?: NodeJS.ProcessEnv
	now?: () => number
	/** Stops `watch` (SIGINT/SIGTERM in production). */
	signal?: AbortSignal
	okena?: (profile: string) => DockOkenaReader
	/** Helm terminals' sessions: reads through Helm's Claude hub (tests inject a double). */
	helmHub?: (dir: string, profile: string) => DockOkenaReader
	followPollMs?: number
}

/** Reads one Helm terminal's live session/transcript through the hub's owner-token route. */
export function helmHubReader(dir: string, profile: string): DockOkenaReader {
	const read = async (op: 'session' | 'transcript', terminal: string): Promise<unknown> => {
		const owner = await readClaudeHubOwnerFile(dir)
		if (!owner) throw new Error("Helm's Claude hub is not running (no claude-remote.json in the spool dir)")
		const reply = claudeHubReadReplySchema.safeParse(
			await claudeHubRequest(owner.socket, { v: 1, t: 'read', owner: owner.owner, op, profile, terminal }),
		)
		if (!reply.success) throw new Error("Helm's Claude hub sent no answer")
		if (!reply.data.ok) throw new Error(`Helm's Claude hub (${reply.data.status}): ${reply.data.error}`)
		return reply.data.body
	}
	return {
		getClaudeSession: terminal => read('session', terminal),
		getClaudeTranscript: terminal => read('transcript', terminal),
	}
}

const sourceOf = (session: SpoolSession | undefined, key: string): 'okena' | 'helm' =>
	session?.source ?? (key.startsWith('helm:') ? 'helm' : 'okena')

const valueOptions = new Set(['--cursor', '--dir'])
const flagOptions = new Set(['--json', '--all', '--no-live', '--help', '-h'])

function parseArgs(args: string[]) {
	const values = new Map<string, string>()
	const flags = new Set<string>()
	const positional: string[] = []
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string
		if (flagOptions.has(arg)) flags.add(arg)
		else if (valueOptions.has(arg)) {
			const value = args[++index]
			if (!value || value.startsWith('--')) throw new UsageError(`Expected a value for ${arg}`)
			values.set(arg, value)
		} else if (arg.startsWith('-')) throw new UsageError(`Unknown dock option: ${arg}`)
		else positional.push(arg)
	}
	return { values, flags, positional }
}

class UsageError extends Error {}

const ageText = (ms: number): string => {
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	return hours < 48 ? `${hours}h${String(minutes % 60).padStart(2, '0')}` : `${Math.floor(hours / 24)}d`
}

const clock = (at: number): string => {
	const date = new Date(at)
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Plain text for untrusted agent content: controls stripped except newline/tab, bounded. */
function plainText(text: string, max: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
	const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

const sessionLabel = (session: SpoolSession | undefined, key: string): string =>
	session ? `${session.project}/${session.name}` : key

function sessionRef(
	snapshot: SpoolSnapshot,
	item: SpoolItem,
): { source: 'okena' | 'helm'; profile: string; terminalId: string } | null {
	const session = snapshot.sessions.find(candidate => candidate.key === item.session)
	const source = sourceOf(session, item.session)
	if (session) return { source, profile: session.profile, terminalId: session.terminalId }
	// Keys are `<profile>:<terminal>`; a Helm profile is itself `helm:<profileId>`.
	const split = item.session.lastIndexOf(':')
	if (split <= 0) return null
	const profile = item.session.slice(0, split)
	if (source === 'helm' && !helmDockProfileId(profile)) return null
	return { source, profile, terminalId: item.session.slice(split + 1) }
}

async function loadSnapshot(
	dir: string,
	deps: DockCliDeps,
): Promise<{ snapshot: SpoolSnapshot; running: boolean } | null> {
	const read = await readSpoolSnapshot(dir, (deps.now ?? Date.now)())
	if (read.ok) return { snapshot: read.snapshot, running: read.running }
	deps.err(
		read.reason === 'missing'
			? `Helm agent dock has no snapshot in ${dir}. Start the Helm desktop app (with Okena Claude Remote on).`
			: `Helm agent dock snapshot unreadable: ${read.detail}`,
	)
	return null
}

function notRunningNote(snapshot: SpoolSnapshot): string {
	return `Helm is not running; showing its last snapshot from ${clock(snapshot.writtenAt)}.`
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

async function runLs(dir: string, flags: Set<string>, deps: DockCliDeps): Promise<number> {
	const loaded = await loadSnapshot(dir, deps)
	if (!loaded) return EXIT_HELM_DOWN
	const { snapshot, running } = loaded
	const now = (deps.now ?? Date.now)()
	const items = flags.has('--all') ? snapshot.items : snapshot.items.filter(item => item.state !== 'resolved')
	const code = !running ? EXIT_HELM_DOWN : snapshot.source.state === 'down' ? EXIT_SOURCE_DOWN : 0
	if (flags.has('--json')) {
		await deps.out(JSON.stringify({ running, source: snapshot.source, items, sessions: snapshot.sessions }))
		return code
	}
	if (!running) deps.err(notRunningNote(snapshot))
	const source = snapshot.source
	const healthLine = (name: string, health: SpoolSnapshot['source']) =>
		health.state === 'ok'
			? `${name}: ok (observed ${ageText(now - (health.lastObservedAt ?? now))} ago)`
			: health.state === 'down'
				? `${name} unreachable since ${clock(health.since)}${health.detail ? `: ${health.detail}` : ''}`
				: `${name}: not polled yet`
	const perSource = snapshot.sources ?? {}
	// Okena alone (or a spool from before Helm terminals were observed): the aggregate is Okena's.
	const lines = perSource.helm
		? [...(perSource.okena ? [healthLine('Okena', perSource.okena)] : []), healthLine('Helm terminals', perSource.helm)]
		: [healthLine('Okena', source)]
	const sessionOf = (key: string) => snapshot.sessions.find(session => session.key === key)
	const itemLine = (item: SpoolItem) => {
		const state = item.state === 'resolved' ? `resolved:${item.resolution?.by ?? '?'}` : item.state
		const age = ageText(now - (item.resolution?.at ?? item.openedAt))
		return `  #${item.id}  ${item.kind.padEnd(4)}  ${state.padEnd(9)}  ${sessionLabel(sessionOf(item.session), item.session)}  ${item.head}  ${age}`
	}
	const needs = items.filter(item => item.state !== 'resolved')
	// Never all-clear from missing data: listed agents with unreadable state may hide open dialogs.
	const unknown = source.state === 'ok' ? snapshot.sessions.filter(session => session.status === 'unknown').length : 0
	const blind = unknown > 0 ? `state unknown for ${unknown} agent${unknown === 1 ? '' : 's'}` : ''
	lines.push(
		needs.length > 0
			? `NEEDS YOU${blind ? ` (${blind})` : ''}`
			: blind
				? `NEEDS YOU: ${blind}`
				: source.state === 'ok'
					? 'NEEDS YOU: nothing open'
					: `NEEDS YOU: unknown (${perSource.helm ? 'a source' : 'Okena'} not observed)`,
	)
	for (const item of needs) lines.push(itemLine(item))
	const resolved = items.filter(item => item.state === 'resolved')
	if (resolved.length > 0) {
		lines.push('RECENT')
		for (const item of resolved) lines.push(itemLine(item))
	}
	lines.push(snapshot.sessions.length > 0 ? 'AGENTS' : 'AGENTS: no Claude sessions')
	for (const session of snapshot.sessions) {
		const chips = [
			`${session.status} ${ageText(now - session.since)}`,
			session.subagents > 0 ? `bg·${session.subagents}` : '',
			session.queuedPrompts > 0 ? `queued ${session.queuedPrompts}` : '',
			...session.prLinks.slice(0, 3).map(link => `PR #${link.number}`),
			now - session.observedAt > 10_000 ? `stale ${ageText(now - session.observedAt)}` : '',
		].filter(Boolean)
		const where = `${sessionLabel(session, session.key)}${sourceOf(session, session.key) === 'helm' ? ' (Helm)' : ''}`
		lines.push(`  ${where}  ${chips.join('  ')}`)
	}
	await deps.out(lines.join('\n'))
	return code
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

const liveSessionSchema = z.object({
	dialogs: z.array(z.object({ id: z.string(), tool_name: z.string(), tool_input: z.unknown() }).passthrough()),
})
const liveTranscriptSchema = z.object({
	session_id: z.string().optional(),
	entries: z.array(z.object({ kind: z.string(), uuid: z.string(), text: z.string().optional() }).passthrough()),
})

type LiveDetail =
	| { kind: 'ask'; open: true; tool: string; input: unknown }
	| { kind: 'ask'; open: false }
	| { kind: 'turn'; found: true; text: string }
	| { kind: 'turn'; found: false; reason: string }

async function readLive(dir: string, snapshot: SpoolSnapshot, item: SpoolItem, deps: DockCliDeps): Promise<LiveDetail> {
	const ref = sessionRef(snapshot, item)
	if (!ref) throw new Error('item has no terminal')
	const okena =
		ref.source === 'helm'
			? (deps.helmHub ?? helmHubReader)(dir, ref.profile)
			: (deps.okena ?? (profile => new OkenaClient(undefined, profile)))(ref.profile)
	if (item.kind === 'ask') {
		const session = liveSessionSchema.parse(await okena.getClaudeSession(ref.terminalId))
		const dialog = session.dialogs.find(candidate => candidate.id === item.dialogId)
		return dialog
			? { kind: 'ask', open: true, tool: dialog.tool_name, input: dialog.tool_input }
			: { kind: 'ask', open: false }
	}
	const page = liveTranscriptSchema.parse(await okena.getClaudeTranscript(ref.terminalId))
	if (item.sessionId && page.session_id && page.session_id !== item.sessionId)
		return { kind: 'turn', found: false, reason: 'the pane now runs a different Claude session' }
	const entry = page.entries.find(candidate => candidate.kind === 'assistant' && candidate.uuid === item.assistantUuid)
	return entry && typeof entry.text === 'string'
		? { kind: 'turn', found: true, text: plainText(entry.text, LIVE_TURN_MAX) }
		: { kind: 'turn', found: false, reason: 'message is not in the latest transcript page' }
}

async function runShow(dir: string, idArg: string | undefined, flags: Set<string>, deps: DockCliDeps): Promise<number> {
	const id = Number((idArg ?? '').replace(/^#/, ''))
	if (!Number.isSafeInteger(id) || id <= 0) throw new UsageError('show requires an item id, e.g. helm dock show 7')
	const loaded = await loadSnapshot(dir, deps)
	if (!loaded) return EXIT_HELM_DOWN
	const { snapshot, running } = loaded
	const item = snapshot.items.find(candidate => candidate.id === id)
	if (!item) {
		deps.err(`No dock item #${id} (open items and the last 24 h only).`)
		return 1
	}
	const session = snapshot.sessions.find(candidate => candidate.key === item.session)
	let live: LiveDetail | null = null
	let liveError: string | undefined
	if (!flags.has('--no-live') && item.state !== 'resolved') {
		try {
			live = await readLive(dir, snapshot, item, deps)
		} catch (error) {
			liveError = (error instanceof Error ? error.message : String(error)).slice(0, 300)
		}
	}
	const code = running ? 0 : EXIT_HELM_DOWN
	if (flags.has('--json')) {
		await deps.out(
			JSON.stringify({ running, item, session: session ?? null, live, ...(liveError ? { liveError } : {}) }),
		)
		return code
	}
	if (!running) deps.err(notRunningNote(snapshot))
	const now = (deps.now ?? Date.now)()
	const lines = [
		`#${item.id} ${item.kind} · ${item.state}${item.resolution ? ` (${item.resolution.by} ${clock(item.resolution.at)})` : ''}`,
		`where: ${sessionLabel(session, item.session)}${session ? ` · ${session.status}` : ''}`,
		`opened: ${clock(item.openedAt)} (${ageText(now - item.openedAt)} ago)`,
		`head: ${item.head}`,
	]
	if (live?.kind === 'ask') {
		if (live.open) {
			lines.push(`tool: ${live.tool}`, 'input (untrusted agent data):')
			lines.push(plainText(JSON.stringify(live.input, null, 2) ?? 'null', LIVE_INPUT_MAX))
		} else
			lines.push(
				`${sourceOf(session, item.session) === 'helm' ? 'Helm' : 'Okena'} no longer shows this dialog open (answered elsewhere or pending refresh).`,
			)
	} else if (live?.kind === 'turn') {
		if (live.found) lines.push('last assistant message (untrusted agent data):', live.text)
		else lines.push(`turn text unavailable: ${live.reason}`)
	} else if (liveError) lines.push(`live detail unavailable: ${liveError}`)
	await deps.out(lines.join('\n'))
	return code
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

async function readCursor(path: string): Promise<number | null> {
	const text = await readSpoolFile(path, 64)
	if (text === null) return null
	const value = Number(text.trim())
	return Number.isSafeInteger(value) && value >= 0 ? value : null
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>(resolve => {
		if (signal?.aborted) return resolve()
		const timer = setTimeout(done, ms)
		function done() {
			clearTimeout(timer)
			signal?.removeEventListener('abort', done)
			resolve()
		}
		signal?.addEventListener('abort', done, { once: true })
	})

/** Incremental reader of events.ndjson that falls back to a full spool rescan on rotation/truncation. */
class EventFollower {
	private ino: number | null = null
	private offset = 0
	private partial = ''

	constructor(
		private readonly dir: string,
		public lastSeq: number,
	) {}

	async poll(): Promise<string[]> {
		const path = join(this.dir, SPOOL_EVENTS_FILE)
		let info: Awaited<ReturnType<typeof stat>> | null = null
		try {
			info = await stat(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		if (!info || info.ino !== this.ino || info.size < this.offset) {
			// First poll, rotation, or replacement: rescan everything after lastSeq (rotated files included).
			const events = await readSpoolEvents(this.dir, this.lastSeq)
			this.ino = info?.ino ?? null
			this.offset = info?.size ?? 0
			this.partial = ''
			return this.take(events.map(entry => ({ seq: entry.seq, line: entry.line })))
		}
		if (info.size === this.offset) return []
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
		let chunk: string
		try {
			const length = Math.min(info.size - this.offset, 8 * 1024 * 1024)
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await file.read(buffer, 0, length, this.offset)
			this.offset += bytesRead
			chunk = buffer.subarray(0, bytesRead).toString('utf8')
		} finally {
			await file.close()
		}
		const text = this.partial + chunk
		const cut = text.lastIndexOf('\n')
		this.partial = cut === -1 ? text : text.slice(cut + 1)
		if (cut === -1) return []
		return this.take(parseEventLines(text.slice(0, cut)).map(entry => ({ seq: entry.seq, line: entry.line })))
	}

	private take(entries: Array<{ seq: number; line: string }>): string[] {
		const lines: string[] = []
		for (const entry of entries.sort((a, b) => a.seq - b.seq)) {
			if (entry.seq <= this.lastSeq) continue
			this.lastSeq = entry.seq
			lines.push(entry.line)
		}
		return lines
	}
}

/**
 * Inside a Helm terminal's top-level Claude session (its Bash tool inherits the hub
 * socket + terminal token, and CLAUDE_CODE_SESSION_ID), tell Helm's hub this session
 * is the dispatcher so it is never listed. Repeated with the heartbeat, so a Helm
 * restart re-learns it. Silent when not in a Helm terminal or Helm is down.
 */
export async function registerDispatcher(
	env: NodeJS.ProcessEnv,
	send: typeof claudeHubRequest = claudeHubRequest,
): Promise<boolean> {
	const socket = env[CLAUDE_REMOTE_ENV.socket]
	const token = env[CLAUDE_REMOTE_ENV.token]
	const sessionId = env.CLAUDE_CODE_SESSION_ID
	if (!socket || !token || !sessionId) return false
	try {
		await send(socket, { v: 1, t: 'dispatcher', token, session_id: sessionId }, 1_000)
		return true
	} catch {
		return false
	}
}

async function runWatch(dir: string, values: Map<string, string>, deps: DockCliDeps): Promise<number> {
	const loaded = await loadSnapshot(dir, deps)
	if (!loaded) return EXIT_HELM_DOWN
	const now = deps.now ?? Date.now
	const cursorPath = values.get('--cursor') ?? join(dir, SPOOL_CURSOR_FILE)
	const heartbeatPath = join(dir, SPOOL_HEARTBEAT_FILE)
	await ensurePrivateDir(dir)

	const latest = await latestSpoolSeq(dir)
	let cursor = await readCursor(cursorPath)
	if (cursor === null) cursor = latest
	else if (cursor > latest) {
		deps.err(`dock cursor ${cursor} is ahead of the spool (${latest}); the spool was reset, resuming from its end.`)
		cursor = latest
	}
	const follower = new EventFollower(dir, cursor)
	const saveCursor = async () => {
		if (follower.lastSeq !== cursor) {
			cursor = follower.lastSeq
			await writePrivateFileAtomic(cursorPath, `${cursor}\n`)
		}
	}
	const heartbeat = async () => {
		await registerDispatcher(deps.env ?? process.env)
		await writePrivateFileAtomic(heartbeatPath, `${JSON.stringify({ pid: process.pid, at: now() })}\n`).catch(error =>
			deps.err(`dock heartbeat failed: ${error instanceof Error ? error.message : error}`),
		)
	}

	const pending = loaded.snapshot.items.filter(item => item.state !== 'resolved').map(item => item.id)
	await deps.out(
		JSON.stringify({
			t: 'catchup',
			at: now(),
			open: pending.slice(0, CATCHUP_MAX_IDS),
			...(pending.length > CATCHUP_MAX_IDS ? { more: pending.length - CATCHUP_MAX_IDS } : {}),
			source: loaded.snapshot.source.state,
			...(loaded.running ? {} : { host: 'offline' }),
		}),
	)
	await heartbeat()
	let lastHeartbeat = now()
	let lastHostCheck = now()
	let running = loaded.running
	const pollMs = deps.followPollMs ?? FOLLOW_POLL_MS
	while (!deps.signal?.aborted) {
		for (const line of await follower.poll()) await deps.out(line)
		await saveCursor()
		const at = now()
		if (at - lastHeartbeat >= HEARTBEAT_MS) {
			await heartbeat()
			lastHeartbeat = at
		}
		if (at - lastHostCheck >= HOST_CHECK_MS) {
			lastHostCheck = at
			const read = await readSpoolSnapshot(dir, at)
			const alive = read.ok && read.running
			if (alive !== running) {
				running = alive
				await deps.out(JSON.stringify({ t: alive ? 'host-online' : 'host-offline', at }))
			}
		}
		await sleep(pollMs, deps.signal)
	}
	return 0
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Returns the process exit code. */
export async function runDockCli(args: string[], deps: DockCliDeps): Promise<number> {
	try {
		const { values, flags, positional } = parseArgs(args)
		const action = positional[0] ?? 'help'
		if (flags.has('--help') || flags.has('-h') || action === 'help') {
			await deps.out(DOCK_HELP.trimEnd())
			return 0
		}
		const dir = values.get('--dir') ?? defaultAgentDockDir(deps.env ?? process.env)
		if (action === 'ls') {
			if (positional.length > 1) throw new UsageError('ls takes no arguments')
			return await runLs(dir, flags, deps)
		}
		if (action === 'show') {
			if (positional.length > 2) throw new UsageError('show takes one item id')
			return await runShow(dir, positional[1], flags, deps)
		}
		if (action === 'watch') {
			if (positional.length > 1) throw new UsageError('watch takes no arguments')
			return await runWatch(dir, values, deps)
		}
		throw new UsageError(`Unknown dock command: ${action}. Run helm dock help.`)
	} catch (error) {
		deps.err(error instanceof Error ? error.message.slice(0, 400) : String(error))
		return 1
	}
}

/** Process wiring for src/cli/helm.ts. */
export async function runDockProcess(args: string[]): Promise<number> {
	const controller = new AbortController()
	const stop = () => controller.abort()
	process.once('SIGINT', stop)
	process.once('SIGTERM', stop)
	process.stdout.once('error', stop)
	try {
		return await runDockCli(args, {
			out: line =>
				new Promise<void>(resolve => {
					if (controller.signal.aborted) return resolve()
					process.stdout.write(`${line}\n`, () => resolve())
				}),
			err: line => process.stderr.write(`${line}\n`),
			signal: controller.signal,
		})
	} finally {
		process.removeListener('SIGINT', stop)
		process.removeListener('SIGTERM', stop)
	}
}
