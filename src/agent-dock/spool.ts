// Agent dock file spool (slice 1, read-only transport): Helm main writes it,
// `helm dock` reads it. Lives in root `src/` so both the Electron main bundle
// (`app/src/agent-dock/watcher.ts`) and the CLI (`src/cli/dock.ts`) share one
// contract. Pure Node, no Electron.
//
// <dir> = <Helm userData>/agent-dock (0700):
//   state.json            watcher persistence: id/seq counters, seen uuids, 24 h resolved ledger
//   snapshot.json         latest dock view for `helm dock ls/show` (no transcript text, no dialog input)
//   events.ndjson         today's events, one ≤300-char JSON line each, monotonic `seq`
//   events-YYYY-MM-DD.ndjson  rotated days (kept EVENT_RETENTION_DAYS)
//   dispatcher.cursor     last seq delivered by `helm dock watch`
//   dispatcher.heartbeat  touched by `helm dock watch` every 20 s
//
// Transcript excerpts, dialog `tool_input` and dock answer text never reach disk:
// item `head`s are tool name + counts, never question or turn text; a dock
// receipt keeps only the action kind and status. `helm dock show` reads the
// full content live from Okena instead.

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { z } from 'zod'

export const AGENT_DOCK_DIR_ENV = 'HELM_AGENT_DOCK_DIR'
export const SPOOL_STATE_FILE = 'state.json'
export const SPOOL_SNAPSHOT_FILE = 'snapshot.json'
export const SPOOL_EVENTS_FILE = 'events.ndjson'
export const SPOOL_CURSOR_FILE = 'dispatcher.cursor'
export const SPOOL_HEARTBEAT_FILE = 'dispatcher.heartbeat'
export const MAX_EVENT_LINE = 300
export const ITEM_HEAD_MAX = 120
export const EVENT_RETENTION_DAYS = 7
/** snapshot.json older than this (or a dead writer pid) means Helm is not running. */
export const SPOOL_STALE_MS = 60_000
const ROTATED_EVENTS = /^events-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.ndjson$/
const MAX_SPOOL_FILE_BYTES = 32 * 1024 * 1024

/**
 * `<Electron appData>/Helm/agent-dock`, matching the desktop app's userData for
 * the packaged app and for unpackaged `electron .` (main.ts pins both to
 * `<appData>/Helm`). `HELM_AGENT_DOCK_DIR` overrides it (tests, custom
 * `--user-data-dir` runs).
 */
export function defaultAgentDockDir(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): string {
	const override = env[AGENT_DOCK_DIR_ENV]
	if (override) return override
	const appData =
		platform === 'darwin'
			? join(home, 'Library', 'Application Support')
			: platform === 'win32'
				? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
				: (env.XDG_CONFIG_HOME ?? join(home, '.config'))
	return join(appData, 'Helm', 'agent-dock')
}

// ---------------------------------------------------------------------------
// Wire shapes (validated by the CLI; written by the watcher)
// ---------------------------------------------------------------------------

const ms = z.number().finite().nonnegative()

/** Okena Claude Remote or Helm's own Claude hub (Claude Code in Helm terminals). */
export const spoolSourceIdSchema = z.enum(['okena', 'helm'])
export type SpoolSourceId = z.infer<typeof spoolSourceIdSchema>

export const spoolSessionSchema = z.object({
	key: z.string(),
	/** Absent in spools written before Helm terminals were observed: okena. */
	source: spoolSourceIdSchema.optional(),
	profile: z.string(),
	terminalId: z.string(),
	projectId: z.string().optional(),
	project: z.string(),
	name: z.string(),
	branch: z.string().optional(),
	sessionId: z.string().optional(),
	status: z.enum(['working', 'background', 'idle', 'waiting', 'unknown', 'unreachable']),
	since: ms,
	observedAt: ms,
	subagents: z.number().int().nonnegative(),
	queuedPrompts: z.number().int().nonnegative(),
	prLinks: z.array(z.object({ number: z.number().int(), url: z.string(), repository: z.string() })),
	hasTranscript: z.boolean(),
	hooksAttached: z.boolean(),
	channelAttached: z.boolean(),
})
export type SpoolSession = z.infer<typeof spoolSessionSchema>

export const spoolResolutionSchema = z.object({
	at: ms,
	by: z.enum(['outside', 'replied', 'superseded', 'session_ended', 'acked', 'dock']),
})

/** A dock answer's kind and status (slice 2). Never the answer or Okena's error words. */
export const spoolReceiptSchema = z.object({
	action: z.enum(['answer', 'allow', 'deny', 'prompt']),
	status: z.enum(['sending', 'sent', 'unconfirmed', 'confirmed', 'refused', 'failed']),
	at: ms,
	always: z.boolean().optional(),
	delivery: z.enum(['channel', 'pty', 'queued']).optional(),
	reason: z
		.enum(['gone', 'changed', 'busy', 'not_open', 'unknown_item', 'invalid', 'source_down', 'in_flight'])
		.optional(),
})

export const spoolItemSchema = z.object({
	id: z.number().int().positive(),
	key: z.string(),
	kind: z.enum(['ask', 'turn']),
	state: z.enum(['open', 'sending', 'unconfirmed', 'orphaned', 'resolved']),
	session: z.string(),
	/** Absent in slice-1 spools. */
	rev: z.number().int().positive().optional(),
	openedAt: ms,
	orphanedAt: ms.optional(),
	resolution: spoolResolutionSchema.optional(),
	/** ≤120 chars: ask question / tool label; turns never carry their text. */
	head: z.string().max(ITEM_HEAD_MAX),
	tool: z.string().optional(),
	dialogId: z.string().optional(),
	createdAtMs: ms.optional(),
	sessionId: z.string().optional(),
	assistantUuid: z.string().optional(),
	endedAt: ms.optional(),
	hadBackground: z.boolean().optional(),
	receipt: spoolReceiptSchema.optional(),
	/** Resolved during an earlier Helm run (from the persisted 24 h ledger). */
	fromLedger: z.boolean().optional(),
})
export type SpoolItem = z.infer<typeof spoolItemSchema>

const spoolHealthSchema = z.object({
	state: z.enum(['pending', 'ok', 'down']),
	since: ms,
	lastObservedAt: ms.nullable(),
	detail: z.string().optional(),
})

export const spoolSnapshotSchema = z.object({
	version: z.literal(1),
	/** Writer process; dead pid means Helm is not running. */
	pid: z.number().int().positive(),
	writtenAt: ms,
	generatedAt: ms,
	/** All sources together (down if any is down). */
	source: spoolHealthSchema,
	/** Per source; absent in older spools (then `source` is Okena's). */
	sources: z.object({ okena: spoolHealthSchema.optional(), helm: spoolHealthSchema.optional() }).optional(),
	sessions: z.array(spoolSessionSchema),
	items: z.array(spoolItemSchema),
})
export type SpoolSnapshot = z.infer<typeof spoolSnapshotSchema>

/** One events.ndjson line. Extra fields per `t` (id, kind, by, where, head, …) pass through. */
export const spoolEventSchema = z.object({ seq: z.number().int().positive(), t: z.string(), at: ms }).passthrough()
export type SpoolEvent = z.infer<typeof spoolEventSchema>

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** One line: controls/newlines collapsed to spaces, bounded with an ellipsis. */
export function oneLine(text: string, max: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing controls is the point
	const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
	const flat = text.replace(controls, ' ').replace(/\s+/g, ' ').trim()
	if (flat.length <= max) return flat
	let end = max - 1
	const code = flat.charCodeAt(end - 1)
	if (code >= 0xd800 && code <= 0xdbff) end -= 1
	return `${flat.slice(0, end)}…`
}

/** Local calendar day `YYYY-MM-DD` (rotation boundary). */
export function localDay(at: number): string {
	const date = new Date(at)
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Serializes an event within MAX_EVENT_LINE: shrinks `head`, then `where`, then
 * drops `detail`/`session`/`key` until it fits. Never splits JSON.
 */
export function formatEventLine(event: Record<string, unknown>): string {
	const line = { ...event }
	let text = JSON.stringify(line)
	for (const field of ['head', 'where', 'detail'] as const) {
		while (text.length > MAX_EVENT_LINE && typeof line[field] === 'string' && (line[field] as string).length > 8) {
			const value = line[field] as string
			line[field] = oneLine(value, Math.max(8, value.length - (text.length - MAX_EVENT_LINE) - 1))
			text = JSON.stringify(line)
		}
	}
	for (const field of ['detail', 'key', 'session', 'where', 'head']) {
		if (text.length <= MAX_EVENT_LINE) break
		delete line[field]
		text = JSON.stringify(line)
	}
	return text
}

// ---------------------------------------------------------------------------
// Owner-private files
// ---------------------------------------------------------------------------

/** Creates (or tightens to) a 0700 directory; refuses symlinks and foreign owners. */
export async function ensurePrivateDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 })
	const stat = await lstat(dir)
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Agent dock directory is not a directory: ${dir}`)
	if (process.getuid !== undefined && stat.uid !== process.getuid())
		throw new Error(`Agent dock directory is not owned by this user: ${dir}`)
	if ((stat.mode & 0o077) !== 0) await chmod(dir, 0o700)
}

/** Atomic 0600 replace: temp file in the same directory, fsync, rename. */
export async function writePrivateFileAtomic(path: string, data: string): Promise<void> {
	const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
	const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
	try {
		await file.writeFile(data)
		await file.sync()
	} finally {
		await file.close()
	}
	try {
		await rename(temp, path)
	} catch (error) {
		await rm(temp, { force: true })
		throw error
	}
}

/** Appends to a 0600 file (created if missing), never following a symlink. */
export async function appendPrivateText(path: string, text: string): Promise<void> {
	const file = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
		0o600,
	)
	try {
		await file.writeFile(text)
	} finally {
		await file.close()
	}
}

/** Reads a regular file up to `maxBytes` (null when missing); never follows a symlink. */
export async function readSpoolFile(path: string, maxBytes = MAX_SPOOL_FILE_BYTES): Promise<string | null> {
	let file: Awaited<ReturnType<typeof open>>
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
	try {
		const stat = await file.stat()
		if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`)
		if (stat.size > maxBytes) throw new Error(`Spool file exceeds ${maxBytes} bytes: ${path}`)
		return (await file.readFile()).toString('utf8')
	} finally {
		await file.close()
	}
}

// ---------------------------------------------------------------------------
// Snapshot + events reading (CLI side)
// ---------------------------------------------------------------------------

export type SnapshotRead =
	| { ok: true; snapshot: SpoolSnapshot; running: boolean }
	| { ok: false; reason: 'missing' | 'invalid'; detail: string }

const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** snapshot.json plus whether its writer still looks alive (pid alive and written within SPOOL_STALE_MS). */
export async function readSpoolSnapshot(
	dir: string,
	now = Date.now(),
	isAlive: (pid: number) => boolean = pidAlive,
): Promise<SnapshotRead> {
	const text = await readSpoolFile(join(dir, SPOOL_SNAPSHOT_FILE), 8 * 1024 * 1024)
	if (text === null) return { ok: false, reason: 'missing', detail: `No agent dock snapshot in ${dir}` }
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		return { ok: false, reason: 'invalid', detail: 'snapshot.json is not valid JSON' }
	}
	const parsed = spoolSnapshotSchema.safeParse(body)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		return { ok: false, reason: 'invalid', detail: `snapshot.json: ${issue?.path.join('.')}: ${issue?.message}` }
	}
	const snapshot = parsed.data
	return { ok: true, snapshot, running: isAlive(snapshot.pid) && now - snapshot.writtenAt <= SPOOL_STALE_MS }
}

/** Rotated event files oldest first, then the current file. */
export async function spoolEventFiles(dir: string): Promise<string[]> {
	let names: string[]
	try {
		names = await readdir(dir)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	const rotated = names
		.map(name => ({ name, match: ROTATED_EVENTS.exec(name) }))
		.filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
		.sort((a, b) => a.match[1]?.localeCompare(b.match[1] ?? '') || Number(a.match[2] ?? 0) - Number(b.match[2] ?? 0))
		.map(entry => join(dir, entry.name))
	return names.includes(SPOOL_EVENTS_FILE) ? [...rotated, join(dir, SPOOL_EVENTS_FILE)] : rotated
}

/** Parses NDJSON text into valid events (invalid or oversized lines are skipped). */
export function parseEventLines(text: string): Array<{ seq: number; line: string; event: SpoolEvent }> {
	const out: Array<{ seq: number; line: string; event: SpoolEvent }> = []
	for (const raw of text.split('\n')) {
		const line = raw.trim()
		if (!line || line.length > 4 * MAX_EVENT_LINE) continue
		try {
			const parsed = spoolEventSchema.safeParse(JSON.parse(line))
			if (parsed.success) out.push({ seq: parsed.data.seq, line, event: parsed.data })
		} catch {
			// A torn or foreign line never stops the stream.
		}
	}
	return out
}

/** Every spooled event with seq > afterSeq across rotated + current files, seq ascending, deduplicated. */
export async function readSpoolEvents(
	dir: string,
	afterSeq: number,
): Promise<Array<{ seq: number; line: string; event: SpoolEvent }>> {
	const bySeq = new Map<number, { seq: number; line: string; event: SpoolEvent }>()
	for (const file of await spoolEventFiles(dir)) {
		const text = await readSpoolFile(file)
		if (text === null) continue
		for (const entry of parseEventLines(text)) if (entry.seq > afterSeq) bySeq.set(entry.seq, entry)
	}
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** Highest seq present in the spool (0 when empty). */
export async function latestSpoolSeq(dir: string): Promise<number> {
	return (await spoolHighWater(dir)).seq
}

/**
 * Highest event `seq` and item `#id` the spool has ever shown (rotated + current
 * events, plus snapshot.json items). The watcher resumes both counters above
 * these when state.json is missing or invalid, so ids are never reused.
 */
export async function spoolHighWater(dir: string): Promise<{ seq: number; itemId: number }> {
	let seq = 0
	let itemId = 0
	const noteId = (id: unknown) => {
		if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) itemId = Math.max(itemId, id)
	}
	for (const file of await spoolEventFiles(dir)) {
		const text = await readSpoolFile(file)
		if (text === null) continue
		for (const entry of parseEventLines(text)) {
			seq = Math.max(seq, entry.seq)
			if (entry.event.t.startsWith('item.')) noteId(entry.event.id)
		}
	}
	try {
		const text = await readSpoolFile(join(dir, SPOOL_SNAPSHOT_FILE), 8 * 1024 * 1024)
		const items = text === null ? [] : (JSON.parse(text) as { items?: unknown }).items
		if (Array.isArray(items)) for (const item of items) noteId((item as { id?: unknown } | null)?.id)
	} catch {
		// An unreadable snapshot only means one fewer id source; events still count.
	}
	return { seq, itemId }
}

/**
 * Rotates events.ndjson to `events-<day>.ndjson` when it was last written on an
 * earlier local day, then prunes rotated days beyond EVENT_RETENTION_DAYS.
 */
export async function rotateSpoolEvents(dir: string, now: number): Promise<boolean> {
	const current = join(dir, SPOOL_EVENTS_FILE)
	let fileDay: string
	try {
		const stat = await lstat(current)
		if (!stat.isFile()) return false
		fileDay = localDay(stat.mtimeMs)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw error
	}
	if (fileDay >= localDay(now)) return false
	const names = new Set(await readdir(dir))
	let target = `events-${fileDay}.ndjson`
	for (let n = 1; names.has(target); n++) target = `events-${fileDay}-${n}.ndjson`
	await rename(current, join(dir, target))
	const rotated = (await spoolEventFiles(dir)).filter(file => basename(file) !== SPOOL_EVENTS_FILE)
	const dayOf = (file: string) => ROTATED_EVENTS.exec(basename(file))?.[1]
	const days = [...new Set(rotated.map(file => dayOf(file) ?? ''))].sort()
	const drop = new Set(days.slice(0, Math.max(0, days.length - EVENT_RETENTION_DAYS)))
	for (const file of rotated) {
		const day = dayOf(file)
		if (day && drop.has(day)) await rm(file, { force: true })
	}
	return true
}
