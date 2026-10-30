import assert from 'node:assert/strict'
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import watcherModule from '../app/src/agent-dock/watcher.ts'
import {
	MAX_EVENT_LINE,
	SPOOL_STALE_MS,
	type SpoolSnapshot,
	defaultAgentDockDir,
	formatEventLine,
	localDay,
	readSpoolEvents,
	readSpoolSnapshot,
} from '../src/agent-dock/spool.js'
import { EXIT_HELM_DOWN, EXIT_SOURCE_DOWN, runDockCli } from '../src/cli/dock.js'

type WatcherModule = typeof import('../app/src/agent-dock/watcher.ts')
type AgentDockObservation = import('../app/src/agent-dock/model.ts').AgentDockObservation
type AgentDockSnapshot = import('../app/src/agent-dock/model.ts').AgentDockSnapshot

const {
	AgentDockWatcher,
	BACKGROUND_INTERVAL_MS,
	FOCUSED_INTERVAL_MS,
	SNAPSHOT_REFRESH_MS,
	UNFOCUSED_INTERVAL_MS,
	dockItemHead,
} = watcherModule as WatcherModule

function fixture<T = Record<string, unknown>>(name: string): T {
	return JSON.parse(readFileSync(new URL(`./fixtures/okena-claude/${name}`, import.meta.url), 'utf8')) as T
}

type Json = Record<string, unknown>
const STATE_ASK = fixture('state-ask.json')
const SHOW_ASK = { ...fixture('show-ask.json'), channel_attached: false }
const SHOW_IDLE = { ...fixture('show-idle.json'), channel_attached: false }
const LOG_FULL = fixture('log-full.json')
const LOG_TERMINAL = {
	...LOG_FULL,
	entries: (LOG_FULL.entries as Json[]).map(entry =>
		entry.kind === 'user' ? { ...entry, origin: 'terminal' } : entry,
	),
}
const TID = SHOW_ASK.terminal_id as string
const PROFILE = 'okena-profile'
const ASSISTANT_TEXT = (LOG_FULL.entries as Json[]).find(entry => entry.kind === 'assistant')?.text as string
const OPTION_DESCRIPTION = 'Červená' // inside the dialog's tool_input only
const QUESTION_TEXT = 'Barva?' // the first question in the dialog's tool_input

const pollAsk = (dialogId = '4b4eb160-4'): AgentDockObservation => ({
	type: 'poll',
	profile: PROFILE,
	state: { ok: true, body: STATE_ASK },
	terminals: [
		{
			terminalId: TID,
			detail: {
				ok: true,
				body: {
					...SHOW_ASK,
					dialogs: (SHOW_ASK.dialogs as Json[]).map(dialog => ({ ...dialog, id: dialogId })),
				},
			},
			transcript: { ok: true, body: LOG_TERMINAL },
		},
	],
})
const pollIdle = (): AgentDockObservation => ({
	type: 'poll',
	profile: PROFILE,
	state: { ok: true, body: { ...STATE_ASK, claude_dialogs: {} } },
	terminals: [{ terminalId: TID, detail: { ok: true, body: SHOW_IDLE } }],
})
const pollDown = (): AgentDockObservation => ({
	type: 'poll',
	profile: PROFILE,
	state: { ok: false, error: 'Okena not configured or not running' },
	terminals: [],
})

class ScriptedSource {
	queue: AgentDockObservation[] = []
	async observe(): Promise<AgentDockObservation> {
		const next = this.queue.shift()
		if (!next) throw new Error('no scripted observation')
		return next
	}
}

function harness(dir: string, start = 1_700_000_000_000) {
	const clock = { now: start }
	const source = new ScriptedSource()
	const published: AgentDockSnapshot[] = []
	let focused = true
	const watcher = new AgentDockWatcher({
		dir,
		source,
		publish: snapshot => published.push(snapshot),
		isFocused: () => focused,
		now: () => clock.now,
		log: () => {},
	})
	const step = async (observation: AgentDockObservation, advance = 1_500) => {
		clock.now += advance
		source.queue.push(observation)
		await watcher.tick()
		await watcher.drain()
	}
	const setFocused = (value: boolean) => {
		focused = value
	}
	return { clock, watcher, published, step, setFocused }
}

const mode = (path: string) => statSync(path).mode & 0o777
const tempDir = () => mkdtempSync(join(tmpdir(), 'hdk-'))
const lines = (dir: string) =>
	readFileSync(join(dir, 'events.ndjson'), 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(line => JSON.parse(line) as Json)

test('watcher spools private state, snapshot and bounded events without transcript text or dialog input', async () => {
	const root = tempDir()
	const dir = join(root, 'agent-dock')
	try {
		const { watcher, step, published, clock } = harness(dir)
		await watcher.load()
		await step(pollAsk()) // seed: ask item #1, silent
		assert.equal(existsSync(join(dir, 'events.ndjson')), false)
		await step(pollIdle()) // dialog gone → resolved outside
		await step(pollAsk('4b4eb160-5')) // new dialog → item.opened #2

		assert.equal(mode(dir), 0o700)
		for (const file of ['state.json', 'snapshot.json', 'events.ndjson']) assert.equal(mode(join(dir, file)), 0o600)

		const events = lines(dir)
		assert.deepEqual(
			events.map(event => [event.seq, event.t, event.id]),
			[
				[1, 'item.resolved', 1],
				[2, 'item.opened', 2],
			],
		)
		assert.equal(events[0]?.by, 'outside')
		assert.equal(events[1]?.head, 'AskUserQuestion · 2 questions · 2 opts')
		assert.equal(events[1]?.kind, 'ask')
		assert.ok(
			readFileSync(join(dir, 'events.ndjson'), 'utf8')
				.split('\n')
				.every(line => line.length <= MAX_EVENT_LINE),
		)

		for (const file of ['state.json', 'snapshot.json', 'events.ndjson']) {
			const text = readFileSync(join(dir, file), 'utf8')
			assert.equal(text.includes(ASSISTANT_TEXT.slice(0, 20)), false, `${file} holds transcript text`)
			assert.equal(text.includes(OPTION_DESCRIPTION), false, `${file} holds dialog input`)
			assert.equal(text.includes(QUESTION_TEXT), false, `${file} holds the dialog question`)
		}

		const persisted = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
		assert.equal(persisted.nextItemId, 3)
		assert.equal(persisted.nextSeq, 3)
		assert.deepEqual(
			persisted.ledger.map((item: Json) => [item.id, (item.resolution as Json).by]),
			[[1, 'outside']],
		)

		const read = await readSpoolSnapshot(dir, clock.now)
		assert.equal(read.ok, true)
		if (!read.ok) return
		assert.equal(read.running, true)
		assert.deepEqual(
			read.snapshot.items.map(item => [item.id, item.state]),
			[
				[2, 'open'],
				[1, 'resolved'],
			],
		)
		assert.equal(read.snapshot.sessions[0]?.terminalId, TID)
		// Nobody shows the dock: the spool is written, but nothing is pushed to the renderer.
		assert.equal(published.length, 0)
		// Shown: one push at once, then only on content change or the slow freshness refresh.
		watcher.setVisible(true)
		assert.equal(published.length, 1)
		await step(pollAsk('4b4eb160-5'))
		assert.equal(published.length, 1, 'an unchanged tick is not re-sent')
		await step(pollIdle())
		assert.equal(published.length, 2, 'a resolved item is sent')
		await step(pollIdle(), SNAPSHOT_REFRESH_MS)
		assert.equal(published.length, 3, 'freshness refresh')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('watcher restart keeps ids and seq monotonic and lists earlier resolved items from the ledger', async () => {
	const root = tempDir()
	const dir = join(root, 'agent-dock')
	try {
		const first = harness(dir)
		await first.watcher.load()
		await first.step(pollAsk())
		await first.step(pollIdle())
		first.watcher.stop()

		// state.json lost: seq still continues from the event spool.
		const second = harness(dir, first.clock.now + 60_000)
		await second.watcher.load()
		await second.step(pollAsk('77aa0000-1'))
		await second.step(pollAsk('77aa0000-1'))
		const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as SpoolSnapshot
		const earlier = snapshot.items.find(item => item.id === 1)
		assert.equal(earlier?.fromLedger, true)
		assert.equal(earlier?.resolution?.by, 'outside')
		// Seed tick after restart opens the still-open ask silently with a NEW id (never reused).
		assert.ok(snapshot.items.some(item => item.id === 2 && item.state === 'open'))

		rmSync(join(dir, 'state.json'))
		const third = harness(dir, first.clock.now + 120_000)
		await third.watcher.load()
		await third.step(pollAsk('99bb0000-1'))
		await third.step(pollIdle())
		const seqs = lines(dir).map(event => event.seq as number)
		assert.deepEqual(
			seqs,
			[...seqs].sort((a, b) => a - b),
		)
		assert.equal(new Set(seqs).size, seqs.length)
		// state.json lost: item ids continue above every id the spool ever showed (#1, #2).
		const afterLoss = lines(dir).at(-1)
		assert.deepEqual([afterLoss?.t, afterLoss?.id], ['item.resolved', 3])

		// Invalid state.json is moved aside, never silently overwritten, and ids still never repeat.
		writeFileSync(join(dir, 'state.json'), '{"version":1,"nextItemId":"x"}')
		const fourth = harness(dir, first.clock.now + 180_000)
		await fourth.watcher.load()
		assert.ok(readdirSync(dir).some(name => name.startsWith('state.json.corrupt-')))
		await fourth.step(pollAsk('aacc0000-1'))
		await fourth.step(pollIdle())
		const afterCorrupt = lines(dir).at(-1)
		assert.deepEqual([afterCorrupt?.t, afterCorrupt?.id], ['item.resolved', 4])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('spooled item heads carry tool names and counts, never dialog tool_input', () => {
	const ask = (tool: string, input: unknown) => ({
		id: 1,
		key: 'k',
		kind: 'ask' as const,
		session: 'p:t',
		openedAt: 1,
		state: 'open' as const,
		fact: { kind: 'ask' as const, dialogId: 'd-1', tool, input, createdAtMs: 1 },
	})
	const permission = dockItemHead(ask('Bash', { command: 'cat secret.env', description: 'Read prod creds' }))
	assert.equal(permission, 'Permission: Bash')
	const question = dockItemHead(
		ask('AskUserQuestion', { questions: [{ question: 'Deploy to acme.example?', options: [{ label: 'a' }] }] }),
	)
	assert.equal(question, 'AskUserQuestion · 1 question · 1 opts')
})

test('source down emits one health event; ack refuses open asks; cadence follows visibility and focus', async () => {
	const root = tempDir()
	const dir = join(root, 'agent-dock')
	try {
		const { watcher, step, setFocused, published } = harness(dir)
		await watcher.load()
		assert.equal(watcher.interval(), BACKGROUND_INTERVAL_MS)
		watcher.setVisible(true)
		assert.equal(published.length, 1, 'showing the dock pushes the current snapshot at once')
		assert.equal(watcher.interval(), FOCUSED_INTERVAL_MS)
		setFocused(false)
		assert.equal(watcher.interval(), UNFOCUSED_INTERVAL_MS)
		watcher.setVisible(false)
		assert.equal(watcher.interval(), BACKGROUND_INTERVAL_MS)

		await step(pollAsk())
		assert.equal(await watcher.ack(1), false)
		assert.equal(await watcher.ack(999), false)
		await step(pollDown())
		await step(pollDown())
		const health = lines(dir).filter(event => event.t === 'source.health')
		assert.equal(health.length, 1)
		assert.equal(health[0]?.state, 'down')
		const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as SpoolSnapshot
		assert.equal(snapshot.source.state, 'down')
		assert.equal(snapshot.sessions[0]?.status, 'unreachable')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('events rotate per local day and readers see rotated plus current files in seq order', async () => {
	const root = tempDir()
	const dir = join(root, 'agent-dock')
	try {
		const { watcher, step, clock } = harness(dir)
		await watcher.load()
		await step(pollAsk())
		await step(pollIdle())
		const yesterday = new Date(clock.now - 24 * 60 * 60 * 1000)
		utimesSync(join(dir, 'events.ndjson'), yesterday, yesterday)
		await step(pollAsk('5c5c0000-1'))
		assert.ok(existsSync(join(dir, `events-${localDay(yesterday.getTime())}.ndjson`)))
		const all = await readSpoolEvents(dir, 0)
		assert.deepEqual(
			all.map(entry => entry.seq),
			[1, 2],
		)
		assert.deepEqual(
			(await readSpoolEvents(dir, 1)).map(entry => entry.seq),
			[2],
		)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('event lines stay within 300 chars and spool dir defaults match Electron userData', () => {
	const line = formatEventLine({
		seq: 9,
		t: 'item.opened',
		at: 1,
		id: 4,
		kind: 'ask',
		where: 'p'.repeat(200),
		head: 'h'.repeat(400),
		session: 's'.repeat(120),
	})
	assert.ok(line.length <= MAX_EVENT_LINE)
	assert.equal(JSON.parse(line).seq, 9)
	assert.equal(defaultAgentDockDir({}, 'darwin', '/Users/x'), '/Users/x/Library/Application Support/Helm/agent-dock')
	assert.equal(defaultAgentDockDir({}, 'linux', '/home/x'), '/home/x/.config/Helm/agent-dock')
	assert.equal(defaultAgentDockDir({ HELM_AGENT_DOCK_DIR: '/tmp/d' }, 'darwin', '/Users/x'), '/tmp/d')
})

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function capture() {
	const out: string[] = []
	const err: string[] = []
	return { out, err, deps: { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) } }
}

async function spoolWithItems(dir: string, now: number): Promise<void> {
	const { watcher, step, clock } = harness(dir, now - 10_000)
	await watcher.load()
	await step(pollAsk())
	await step(pollIdle())
	await step(pollAsk('4b4eb160-9'))
	clock.now = now
	watcher.stop()
}

test('helm dock ls/show read the snapshot; exit 4 when Okena is down, 5 when Helm is not running', async () => {
	const root = tempDir()
	const dir = join(root, 'agent-dock')
	try {
		const missing = capture()
		assert.equal(await runDockCli(['ls', '--dir', dir], missing.deps), EXIT_HELM_DOWN)
		assert.match(missing.err.join('\n'), /no snapshot/)

		const now = Date.now()
		await spoolWithItems(dir, now)
		const ls = capture()
		assert.equal(await runDockCli(['ls', '--dir', dir], { ...ls.deps, now: () => now }), 0)
		assert.match(ls.out.join('\n'), /NEEDS YOU\n {2}#2 {2}ask {3}open/)
		assert.doesNotMatch(ls.out.join('\n'), /#1 /)

		const json = capture()
		assert.equal(await runDockCli(['ls', '--json', '--all', '--dir', dir], { ...json.deps, now: () => now }), 0)
		const listed = JSON.parse(json.out[0] ?? '{}')
		assert.equal(listed.running, true)
		assert.deepEqual(
			listed.items.map((item: Json) => item.id),
			[2, 1],
		)

		const show = capture()
		const reads: string[] = []
		const okena = (profile: string) => ({
			getClaudeSession: async (terminalId: string) => {
				reads.push(`${profile}:${terminalId}`)
				return { dialogs: [{ id: '4b4eb160-9', tool_name: 'AskUserQuestion', tool_input: { questions: ['q\u0007'] } }] }
			},
			getClaudeTranscript: async () => ({ entries: [] }),
		})
		assert.equal(await runDockCli(['show', '#2', '--dir', dir], { ...show.deps, now: () => now, okena }), 0)
		assert.deepEqual(reads, [`${PROFILE}:${TID}`])
		assert.match(show.out.join('\n'), /input \(untrusted agent data\):/)
		assert.equal(show.out.join('\n').includes('\u0007'), false)

		const offline = capture()
		const noLive = await runDockCli(['show', '2', '--json', '--no-live', '--dir', dir], {
			...offline.deps,
			now: () => now,
			okena: () => {
				throw new Error('must not read Okena')
			},
		})
		assert.equal(noLive, 0)
		assert.equal(JSON.parse(offline.out[0] ?? '{}').live, null)

		const unknown = capture()
		assert.equal(await runDockCli(['show', '77', '--dir', dir], { ...unknown.deps, now: () => now }), 1)

		const stale = capture()
		assert.equal(
			await runDockCli(['ls', '--dir', dir], { ...stale.deps, now: () => now + SPOOL_STALE_MS + 1 }),
			EXIT_HELM_DOWN,
		)
		assert.match(stale.err.join('\n'), /Helm is not running/)

		// Okena down while Helm runs.
		const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as SpoolSnapshot
		snapshot.source = { state: 'down', since: now, lastObservedAt: now - 5_000, detail: 'connect ENOENT' }
		writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snapshot))
		const down = capture()
		assert.equal(await runDockCli(['ls', '--dir', dir], { ...down.deps, now: () => now }), EXIT_SOURCE_DOWN)
		assert.match(down.out[0] ?? '', /^Okena unreachable since \d\d:\d\d: connect ENOENT/)

		const usage = capture()
		assert.equal(await runDockCli(['act', '--dir', dir], usage.deps), 1)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3_000
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

test('helm dock watch: catchup, missed events after the cursor, follow, rotation without loss or duplicates', async () => {
	const root = tempDir()
	const dir = join(root, 'agent-dock')
	try {
		const now = Date.now()
		await spoolWithItems(dir, now)
		assert.deepEqual(
			lines(dir).map(event => event.seq),
			[1, 2],
		)
		writeFileSync(join(dir, 'dispatcher.cursor'), '1\n')
		const controller = new AbortController()
		const out: string[] = []
		const running = runDockCli(['watch', '--dir', dir], {
			out: line => void out.push(line),
			err: () => {},
			now: () => Date.now(),
			signal: controller.signal,
			followPollMs: 5,
		})
		await until(() => out.length >= 2, 'catchup + missed event')
		const catchup = JSON.parse(out[0] ?? '{}')
		assert.equal(catchup.t, 'catchup')
		assert.deepEqual(catchup.open, [2])
		assert.equal(JSON.parse(out[1] ?? '{}').seq, 2)

		const event = (seq: number) => `${JSON.stringify({ seq, t: 'item.resolved', at: now, id: 2, by: 'outside' })}\n`
		await appendFile(join(dir, 'events.ndjson'), event(3))
		await until(() => out.length >= 3, 'followed append')
		// Rotation: the current file moves aside with an unread tail, a new file starts.
		await appendFile(join(dir, 'events.ndjson'), event(4))
		renameSync(join(dir, 'events.ndjson'), join(dir, 'events-2000-01-01.ndjson'))
		writeFileSync(join(dir, 'events.ndjson'), event(5), { mode: 0o600 })
		await until(() => out.length >= 5, 'events across rotation')
		await new Promise(resolve => setTimeout(resolve, 30))
		controller.abort()
		assert.equal(await running, 0)

		assert.deepEqual(
			out.slice(1).map(line => JSON.parse(line).seq),
			[2, 3, 4, 5],
		)
		assert.equal(readFileSync(join(dir, 'dispatcher.cursor'), 'utf8').trim(), '5')
		assert.equal(mode(join(dir, 'dispatcher.cursor')), 0o600)
		const heartbeat = JSON.parse(readFileSync(join(dir, 'dispatcher.heartbeat'), 'utf8'))
		assert.equal(heartbeat.pid, process.pid)

		// Re-arm: catchup only, nothing replayed.
		const again: string[] = []
		const rearm = new AbortController()
		const second = runDockCli(['watch', '--dir', dir], {
			out: line => void again.push(line),
			err: () => {},
			signal: rearm.signal,
			followPollMs: 5,
		})
		await until(() => again.length >= 1, 'second catchup')
		await new Promise(resolve => setTimeout(resolve, 30))
		rearm.abort()
		assert.equal(await second, 0)
		assert.equal(again.length, 1)
		assert.equal(JSON.parse(again[0] ?? '{}').t, 'catchup')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
