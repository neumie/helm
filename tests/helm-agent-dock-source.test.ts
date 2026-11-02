import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sourceModule from '../app/src/agent-dock/okena-claude-source.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'
import { OkenaClient } from '../src/extensions/okena/client.js'

type SourceModule = typeof import('../app/src/agent-dock/okena-claude-source.ts')
type ReduceModule = typeof import('../app/src/agent-dock/reduce.ts')
type OkenaClaudeClient = import('../app/src/agent-dock/okena-claude-source.ts').OkenaClaudeClient
type OkenaClaudeSession = import('../app/src/agent-dock/model.ts').OkenaClaudeSession

const { OkenaClaudeSource, REPLY_READ_MS, TRANSCRIPT_SWEEP_MS, transcriptWanted, OKENA_TRANSCRIPT_MAX_BYTES } =
	sourceModule as SourceModule
const { TURN_IDLE_MS, createAgentDockState, reduce } = reduceModule as ReduceModule

function fixture<T = Record<string, unknown>>(name: string): T {
	return JSON.parse(readFileSync(new URL(`./fixtures/okena-claude/${name}`, import.meta.url), 'utf8')) as T
}

type Json = Record<string, unknown>
const STATE_ASK = fixture('state-ask.json')
const SHOW_ASK = fixture('show-ask.json')
const SHOW_IDLE = fixture('show-idle.json')
const LOG_FULL = fixture('log-full.json')
const TID = SHOW_ASK.terminal_id as string
const SID = SHOW_ASK.session_id as string
const PROFILE = 'okena-profile'

/** Channel-off variant (Jakub's setup): channel detached, terminal-origin user entries. */
const channelOff = (detail: Json): Json => ({ ...detail, channel_attached: false })
const LOG_TERMINAL = {
	...LOG_FULL,
	entries: (LOG_FULL.entries as Json[]).map(entry =>
		entry.kind === 'user' ? { ...entry, origin: 'terminal' } : entry,
	),
}

interface Call {
	route: 'state' | 'session' | 'transcript'
	terminalId?: string
	query?: { cursor?: number; sessionId?: string }
	maxBytes?: number
	profile: string | null
}

class FakeOkena implements OkenaClaudeClient {
	calls: Call[] = []
	state: unknown = STATE_ASK
	detail: unknown = channelOff(SHOW_ASK)
	transcript: unknown = LOG_TERMINAL
	failState: string | null = null

	constructor(
		readonly profile: string | null = PROFILE,
		private readonly root?: FakeOkena,
	) {}

	private get log(): Call[] {
		return (this.root ?? this).calls
	}
	private get data(): FakeOkena {
		return this.root ?? this
	}
	activeProfileId(): string | null {
		return this.profile
	}
	forProfile(profileId: string): OkenaClaudeClient {
		return new FakeOkena(profileId, this.root ?? this)
	}
	async getStateJson(opts?: { maxBytes?: number }): Promise<unknown> {
		this.log.push({ route: 'state', maxBytes: opts?.maxBytes, profile: this.profile })
		if (this.data.failState) throw new Error(this.data.failState)
		return structuredClone(this.data.state)
	}
	async getClaudeSession(terminalId: string, opts?: { maxBytes?: number }): Promise<unknown> {
		this.log.push({ route: 'session', terminalId, maxBytes: opts?.maxBytes, profile: this.profile })
		return structuredClone(this.data.detail)
	}
	async getClaudeTranscript(
		terminalId: string,
		query?: { cursor?: number; sessionId?: string },
		opts?: { maxBytes?: number },
	): Promise<unknown> {
		this.log.push({ route: 'transcript', terminalId, query, maxBytes: opts?.maxBytes, profile: this.profile })
		return structuredClone(this.data.transcript)
	}
}

const detailOf = (body: Json): OkenaClaudeSession => body as unknown as OkenaClaudeSession

test('first tick reads state, every candidate detail and a first transcript page, pinned to one profile', async () => {
	const okena = new FakeOkena()
	const source = new OkenaClaudeSource(okena)
	const observation = await source.observe(createAgentDockState(null, 0), 1_000)
	assert.equal(observation.type, 'poll')
	if (observation.type !== 'poll') return
	assert.equal(observation.profile, PROFILE)
	assert.equal(observation.state.ok, true)
	assert.deepEqual(
		observation.terminals.map(terminal => terminal.terminalId),
		[TID],
	)
	assert.equal(observation.terminals[0]?.detail.ok, true)
	assert.equal(observation.terminals[0]?.transcript?.ok, true)
	assert.deepEqual(
		okena.calls.map(call => [call.route, call.profile]),
		[
			['state', PROFILE],
			['session', PROFILE],
			['transcript', PROFILE],
		],
	)
	// First page: no cursor; bodies are bounded.
	assert.deepEqual(okena.calls[2]?.query, {})
	assert.equal(okena.calls[2]?.maxBytes, OKENA_TRANSCRIPT_MAX_BYTES)
	assert.ok(okena.calls.every(call => typeof call.maxBytes === 'number' && call.maxBytes > 0))

	// The reducer accepts it: seed ask item, health ok.
	const { state } = reduce(createAgentDockState(null, 0), observation, 1_000)
	assert.equal(state.source.state, 'ok')
	assert.equal(state.items.length, 1)
	assert.equal(state.items[0]?.kind, 'ask')
})

test('state transport failure and invalid state both become a source-down observation with no detail reads', async () => {
	const okena = new FakeOkena()
	okena.failState = 'connect ENOENT /tmp/okena.sock'
	const source = new OkenaClaudeSource(okena)
	const down = await source.observe(createAgentDockState(null, 0), 1_000)
	assert.deepEqual(down.type === 'poll' && down.state, { ok: false, error: 'connect ENOENT /tmp/okena.sock' })
	assert.deepEqual(down.type === 'poll' && down.terminals, [])

	okena.failState = null
	okena.state = { claude_sessions: [TID] }
	const invalid = await source.observe(createAgentDockState(null, 0), 2_000)
	assert.equal(invalid.type === 'poll' && invalid.state.ok, false)
	assert.match(
		invalid.type === 'poll' && !invalid.state.ok ? invalid.state.error : '',
		/invalid \/v1\/state: state_version/,
	)
	assert.deepEqual(
		okena.calls.map(call => call.route),
		['state', 'state'],
	)
	const { state } = reduce(createAgentDockState(null, 0), invalid, 2_000)
	assert.equal(state.source.state, 'down')
})

test('no resolvable Okena profile is reported as source down without any request', async () => {
	const okena = new FakeOkena(null)
	const observation = await new OkenaClaudeSource(okena).observe(createAgentDockState(null, 0), 0)
	assert.equal(observation.type === 'poll' && observation.state.ok, false)
	assert.equal(okena.calls.length, 0)
})

test('invalid session detail is passed through for the reducer to fail closed, without a transcript read', async () => {
	const okena = new FakeOkena()
	okena.detail = { terminal_id: TID, busy: 'yes' }
	const observation = await new OkenaClaudeSource(okena).observe(createAgentDockState(null, 0), 0)
	assert.equal(observation.type === 'poll' && observation.terminals[0]?.transcript, undefined)
	assert.deepEqual(
		okena.calls.map(call => call.route),
		['state', 'session'],
	)
	const { state } = reduce(createAgentDockState(null, 0), observation, 0)
	assert.equal(Object.values(state.sessions)[0]?.session.status, 'unknown')
	assert.equal(state.items.length, 0)
})

test('transcript policy: never while working; busy→idle edge, settle read and sweep while idle', () => {
	const working = detailOf({ ...SHOW_ASK, busy: true, dialogs: [] })
	const idle = detailOf({ ...SHOW_IDLE })
	const cursor = { cursor: 10, sessionId: SID }
	const read = (prev: Parameters<typeof transcriptWanted>[0], detail: OkenaClaudeSession, now: number) =>
		transcriptWanted(prev, detail, cursor, now)

	assert.equal(read({ busy: true, dialogs: 0, sessionId: SID, readAt: 0 }, working, 20_000).read, false)
	const edge = read({ busy: true, dialogs: 0, sessionId: SID, readAt: 0 }, idle, 1_000)
	assert.deepEqual(edge, { read: true, edgeAt: 1_000 })
	const quiet = read({ busy: false, dialogs: 0, sessionId: SID, readAt: 1_000, edgeAt: 1_000 }, idle, 2_500)
	assert.deepEqual(quiet, { read: false, edgeAt: 1_000 })
	const settle = read(
		{ busy: false, dialogs: 0, sessionId: SID, readAt: 1_000, edgeAt: 1_000 },
		idle,
		1_000 + TURN_IDLE_MS,
	)
	assert.deepEqual(settle, { read: true, edgeAt: undefined })
	const sweep = read({ busy: false, dialogs: 0, sessionId: SID, readAt: 9_000 }, idle, 9_000 + TRANSCRIPT_SWEEP_MS)
	assert.equal(sweep.read, true)
	// A dialog closing (answered in the terminal) is also an edge.
	assert.equal(read({ busy: false, dialogs: 1, sessionId: SID, readAt: 0 }, idle, 500).read, true)
	// A new Claude session in the pane always re-reads.
	assert.equal(read({ busy: true, dialogs: 0, sessionId: 'old', readAt: 0 }, working, 500).read, true)
	// No transcript in Okena: never read.
	assert.equal(read(undefined, detailOf({ ...SHOW_IDLE, has_transcript: false }), 0).read, false)
	// Missing cursor (first read) is throttled to the sweep so a 404ing transcript is not hammered.
	assert.equal(transcriptWanted(undefined, idle, {}, 0).read, true)
	assert.equal(transcriptWanted({ busy: false, dialogs: 0, sessionId: SID, readAt: 0 }, idle, {}, 1_500).read, false)
})

test('transcript policy: a busy pane with a live turn is re-read every REPLY_READ_MS', () => {
	const working = detailOf({ ...SHOW_ASK, busy: true, dialogs: [] })
	const cursor = { cursor: 10, sessionId: SID }
	const prev = { busy: true, dialogs: 0, sessionId: SID, readAt: 1_000 }
	assert.equal(transcriptWanted(prev, working, cursor, 1_000 + REPLY_READ_MS, false).read, false)
	assert.equal(transcriptWanted(prev, working, cursor, 1_000 + REPLY_READ_MS - 1, true).read, false)
	assert.equal(transcriptWanted(prev, working, cursor, 1_000 + REPLY_READ_MS, true).read, true)
	// The idle→busy edge itself (Jakub just submitted a reply in the terminal) reads at once.
	assert.equal(transcriptWanted({ ...prev, busy: false }, working, cursor, 1_001, true).read, true)
	assert.equal(transcriptWanted({ ...prev, busy: false }, working, cursor, 1_001, false).read, false)
	// Without a cursor the first-read throttle still applies.
	assert.equal(transcriptWanted(prev, working, {}, 1_000 + REPLY_READ_MS, true).read, false)
})

test('a reply typed in the terminal while a turn is open is read while busy and closes the turn as replied', async () => {
	const turnUuid = 'b1000000-0000-4000-8000-000000000001'
	const okena = new FakeOkena()
	const source = new OkenaClaudeSource(okena)
	let state = createAgentDockState(null, 0)
	const step = async (now: number) => {
		const observation = await source.observe(state, now)
		const next = reduce(state, observation, now)
		state = next.state
		return next.events
	}
	okena.detail = channelOff({ ...SHOW_ASK, dialogs: [], busy: true })
	await step(0) // seed while working: first (reset) page
	okena.detail = channelOff(SHOW_IDLE)
	okena.transcript = {
		session_id: SID,
		entries: [{ kind: 'assistant', uuid: turnUuid, text: 'Shall I test it on the emulator?' }],
		cursor: LOG_FULL.cursor + 100,
		reset: false,
	}
	await step(1_500) // busy→idle edge read
	okena.transcript = { session_id: SID, entries: [], cursor: LOG_FULL.cursor + 100, reset: false }
	const opened = await step(1_500 + TURN_IDLE_MS) // settle read: the turn opens
	assert.deepEqual(
		opened.map(event => event.t),
		['item.opened'],
	)

	// Jakub answers in the terminal: busy from now on, the reply only in the transcript.
	okena.calls = []
	okena.detail = channelOff({ ...SHOW_ASK, dialogs: [], busy: true })
	okena.transcript = {
		session_id: SID,
		entries: [
			{ kind: 'user', uuid: 'u-terminal', text: 'test it on the emulator', origin: 'terminal' },
			{ kind: 'tool_use', uuid: 'tu-1', tool_use_id: 'x1', name: 'Bash', summary: 'ls' },
		],
		cursor: LOG_FULL.cursor + 400,
		reset: false,
	}
	const replied = await step(1_500 + TURN_IDLE_MS + 1_500)
	assert.deepEqual(okena.calls.find(call => call.route === 'transcript')?.query, {
		cursor: LOG_FULL.cursor + 100,
		sessionId: SID,
	})
	assert.deepEqual(
		replied.map(event => (event.t === 'item.resolved' ? event.by : event.t)),
		['replied'],
	)

	// Nothing live any more: the busy pane is not read again.
	okena.calls = []
	await step(1_500 + TURN_IDLE_MS + 1_500 + 60_000)
	assert.equal(okena.calls.filter(call => call.route === 'transcript').length, 0)
})

test('continuation reads send the reducer cursor with its session id; a new session drops the cursor', async () => {
	const okena = new FakeOkena()
	okena.detail = channelOff({ ...SHOW_ASK, dialogs: [], busy: true })
	const source = new OkenaClaudeSource(okena)
	let state = createAgentDockState(null, 0)
	const step = async (now: number) => {
		const observation = await source.observe(state, now)
		state = reduce(state, observation, now).state
	}
	await step(0) // first page (reset) while busy
	okena.calls = []
	okena.detail = channelOff(SHOW_IDLE)
	okena.transcript = { session_id: SID, entries: [], cursor: LOG_FULL.cursor, reset: false }
	await step(1_500) // busy→idle edge
	const edgeRead = okena.calls.find(call => call.route === 'transcript')
	assert.deepEqual(edgeRead?.query, { cursor: LOG_FULL.cursor, sessionId: SID })

	okena.calls = []
	okena.detail = channelOff({ ...SHOW_IDLE, session_id: 'b6d0b0a2-0000-4000-8000-000000000000', busy: true })
	await step(3_000)
	assert.deepEqual(okena.calls.find(call => call.route === 'transcript')?.query, {})
})

// ---------------------------------------------------------------------------
// OkenaClient read helpers against a real local server (no live Okena)
// ---------------------------------------------------------------------------

const TOKEN = 'dock-test-token'

function writeProfile(root: string, remote: Json, profile = 'p1'): string {
	const baseDir = join(root, 'config')
	const profileDir = join(baseDir, 'profiles', profile)
	mkdirSync(profileDir, { recursive: true })
	writeFileSync(join(baseDir, 'profiles.json'), JSON.stringify({ last_used: profile }))
	writeFileSync(join(profileDir, 'cli.json'), JSON.stringify({ token: TOKEN, token_id: 't' }))
	writeFileSync(join(profileDir, 'remote.json'), JSON.stringify({ pid: process.pid, ...remote }))
	return baseDir
}

const listen = (server: Server, target: string | number) =>
	new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		if (typeof target === 'string') server.listen(target, resolve)
		else server.listen(target, '127.0.0.1', resolve)
	})
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()))

test('OkenaClient Claude GETs: bearer auth, encoded ids, cursor only with session, bounded bodies, verbatim errors', async () => {
	const root = mkdtempSync(join(tmpdir(), 'hds-'))
	const socketPath = join(root, 'o.sock')
	const seen: Array<{ method?: string; url?: string; auth?: string }> = []
	const server = createServer((request, response) => {
		seen.push({ method: request.method, url: request.url, auth: request.headers.authorization })
		if (request.url?.startsWith('/v1/claude/terminals/missing')) {
			response.writeHead(404, { 'Content-Type': 'text/plain' })
			response.end('terminal not found')
			return
		}
		if (request.url?.startsWith('/v1/claude/terminals/huge')) {
			response.writeHead(200, { 'Content-Type': 'application/json' })
			response.end(JSON.stringify({ pad: 'x'.repeat(4096) }))
			return
		}
		response.writeHead(200, { 'Content-Type': 'application/json' })
		response.end(request.url === '/v1/state' ? JSON.stringify(STATE_ASK) : JSON.stringify({ ok: request.url }))
	})
	const baseDir = writeProfile(root, { port: 1, local_endpoint: { kind: 'unix_socket', path: socketPath } })
	await listen(server, socketPath)
	try {
		const client = new OkenaClient(baseDir)
		assert.equal(client.activeProfileId(), 'p1')
		const pinned = client.forProfile('p1')
		assert.deepEqual(await pinned.getStateJson(), STATE_ASK)
		await pinned.getClaudeSession('a b/c')
		await pinned.getClaudeTranscript('t1', { cursor: 42, sessionId: 's-1' })
		await pinned.getClaudeTranscript('t1', { cursor: 42 })
		assert.deepEqual(
			seen.map(entry => [entry.method, entry.url, entry.auth]),
			[
				['GET', '/v1/state', `Bearer ${TOKEN}`],
				['GET', '/v1/claude/terminals/a%20b%2Fc', `Bearer ${TOKEN}`],
				['GET', '/v1/claude/terminals/t1/transcript?cursor=42&session_id=s-1', `Bearer ${TOKEN}`],
				['GET', '/v1/claude/terminals/t1/transcript', `Bearer ${TOKEN}`],
			],
		)
		await assert.rejects(
			pinned.getClaudeSession('missing'),
			/Okena GET \/v1\/claude\/terminals\/missing failed \(404\): terminal not found/,
		)
		await assert.rejects(pinned.getClaudeSession('huge', { maxBytes: 1024 }), /exceeds 1024 bytes/)
		assert.ok(await pinned.getClaudeSession('huge', { maxBytes: 8192 }))
	} finally {
		await close(server)
		rmSync(root, { recursive: true, force: true })
	}
})

test('OkenaClient bounded GET over HTTP rejects oversized bodies (declared and streamed)', async () => {
	const root = mkdtempSync(join(tmpdir(), 'hds-'))
	const server = createServer((request, response) => {
		if (request.url === '/v1/state') {
			response.writeHead(200, { 'Content-Type': 'application/json' })
			response.end(JSON.stringify({ pad: 'y'.repeat(5000) }))
			return
		}
		response.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' })
		response.write('{"pad":"')
		response.write('z'.repeat(5000))
		response.end('"}')
	})
	await listen(server, 0)
	const address = server.address()
	const port = typeof address === 'object' && address ? address.port : 0
	const baseDir = writeProfile(root, { port })
	try {
		const client = new OkenaClient(baseDir)
		await assert.rejects(client.getStateJson({ maxBytes: 1000 }), /exceeds 1000 bytes/)
		await assert.rejects(client.getClaudeSession('t', { maxBytes: 1000 }), /exceeds 1000 bytes/)
		assert.deepEqual(Object.keys((await client.getClaudeSession('t', { maxBytes: 10_000 })) as Json), ['pad'])
	} finally {
		await close(server)
		rmSync(root, { recursive: true, force: true })
	}
})
