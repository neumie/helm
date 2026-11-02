// Okena + Helm terminals in one dock: the composite source, per-source reducer
// state (one source down never freezes the other), act routing by session
// source, the spool's per-source map, CLI routing and dispatcher registration.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import compositeModule from '../app/src/agent-dock/composite-source.ts'
import sourceModule from '../app/src/agent-dock/okena-claude-source.ts'
import watcherModule from '../app/src/agent-dock/watcher.ts'
import hubModule from '../app/src/claude-remote/hub.ts'
import tokenModule from '../app/src/claude-remote/token.ts'
import { readSpoolSnapshot } from '../src/agent-dock/spool.js'
import { registerDispatcher, runDockCli } from '../src/cli/dock.js'

type AgentDockObservation = import('../app/src/agent-dock/model.ts').AgentDockObservation
type DockItem = import('../app/src/agent-dock/model.ts').DockItem
type TerminalRef = import('../app/src/claude-remote/hub-core.ts').TerminalRef

const { CompositeDockSource } = compositeModule as typeof import('../app/src/agent-dock/composite-source.ts')
const { OkenaClaudeSource } = sourceModule as typeof import('../app/src/agent-dock/okena-claude-source.ts')
const { AgentDockWatcher } = watcherModule as typeof import('../app/src/agent-dock/watcher.ts')
const { HelmClaudeHub } = hubModule as typeof import('../app/src/claude-remote/hub.ts')
const { claudeHubTokens } = tokenModule as typeof import('../app/src/claude-remote/token.ts')

type Json = Record<string, unknown>
const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./fixtures/okena-claude/${name}`, import.meta.url), 'utf8')) as Json
const STATE_ASK = fixture('state-ask.json')
const SHOW_ASK = { ...fixture('show-ask.json'), channel_attached: false }
const LOG_FULL = fixture('log-full.json')
const TID = SHOW_ASK.terminal_id as string
const OKENA_PROFILE = 'okena-profile'
const okenaAsk = (): AgentDockObservation => ({
	type: 'poll',
	profile: OKENA_PROFILE,
	state: { ok: true, body: STATE_ASK },
	terminals: [{ terminalId: TID, detail: { ok: true, body: SHOW_ASK }, transcript: { ok: true, body: LOG_FULL } }],
})
const okenaDown = (): AgentDockObservation => ({
	type: 'poll',
	profile: OKENA_PROFILE,
	state: { ok: false, error: 'connect ENOENT' },
	terminals: [],
})

const REF: TerminalRef = { profileId: 'work', terminalId: 'helm-t1' }
const PID = 500
const SID = 'helm-session'
const QUESTIONS = {
	questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }],
}
const ev = (name: string, extra: Json = {}) => ({ hook_event_name: name, session_id: SID, ...extra })

async function harness() {
	const root = mkdtempSync('/tmp/hcr-mix-')
	const dir = join(root, 'agent-dock')
	const clock = { now: 1_800_000_000_000 }
	const hub = new HelmClaudeHub({
		socketPath: join(root, 'hub.sock'),
		tokens: claudeHubTokens(Buffer.alloc(32, 3)),
		activeProfileId: () => 'work',
		deliver: async () => 'pty',
		ownerFile: join(dir, 'claude-remote.json'),
		excludedFile: join(root, 'excluded.json'),
		transcriptRoots: [root],
		now: () => clock.now,
		log: () => {},
	})
	assert.equal(await hub.start(), true)
	const okenaQueue: AgentDockObservation[] = []
	const okenaActs: string[] = []
	const okena = {
		observe: async () => okenaQueue.shift() ?? okenaDown(),
		act: async (target: { profile: string; terminalId: string }) => {
			okenaActs.push(`${target.profile}:${target.terminalId}`)
			return { status: 'sent' as const }
		},
	}
	const source = new CompositeDockSource([
		{ id: 'okena', source: okena },
		{
			id: 'helm',
			source: new OkenaClaudeSource(hub, { name: 'Helm terminals', notRunning: "Helm's Claude hub is not listening" }),
		},
	])
	const watcher = new AgentDockWatcher({
		dir,
		source,
		publish: () => {},
		isFocused: () => true,
		now: () => clock.now,
		log: () => {},
	})
	await watcher.load()
	const tick = async (okenaObservation: AgentDockObservation) => {
		clock.now += 1_500
		okenaQueue.push(okenaObservation)
		await watcher.tick()
		await watcher.drain()
	}
	const askOf = (prefix: string): DockItem => {
		const found = watcher.snapshot().items.find(item => item.kind === 'ask' && item.session.startsWith(prefix))
		assert.ok(found, `no ask for ${prefix}`)
		return found
	}
	return {
		root,
		dir,
		clock,
		hub,
		watcher,
		okenaActs,
		tick,
		askOf,
		done: async () => {
			watcher.stop()
			await watcher.drain()
			hub.stop()
			rmSync(root, { recursive: true, force: true })
		},
	}
}

test('Okena down freezes only Okena: Helm terminals keep updating and answering; Okena asks are refused', async () => {
	const h = await harness()
	try {
		const answers: unknown[] = []
		h.hub.core.event(REF, PID, h.clock.now, ev('SessionStart', { source: 'startup', cwd: '/repo/app' }))
		h.hub.core.event(REF, PID, h.clock.now, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'go' }))
		h.hub.core.permission(
			REF,
			PID,
			h.clock.now,
			ev('PermissionRequest', { prompt_id: 'p1', tool_name: 'AskUserQuestion', tool_input: QUESTIONS }),
			{ respond: output => answers.push(output) },
		)
		await h.tick(okenaAsk())
		let snapshot = h.watcher.snapshot()
		assert.equal(snapshot.sources?.okena?.state, 'ok')
		assert.equal(snapshot.sources?.helm?.state, 'ok')
		assert.deepEqual(
			snapshot.sessions.map(session => [session.key, session.source]).sort(),
			[
				[`${OKENA_PROFILE}:${TID}`, 'okena'],
				['helm:work:helm-t1', 'helm'],
			].sort(),
		)
		const okenaAskItem = h.askOf(OKENA_PROFILE)
		const helmAskItem = h.askOf('helm:')

		await h.tick(okenaDown())
		snapshot = h.watcher.snapshot()
		assert.equal(snapshot.source.state, 'down', 'the aggregate is down while any source is')
		assert.equal(snapshot.sources?.okena?.state, 'down')
		assert.equal(snapshot.sources?.helm?.state, 'ok')

		const refused = await h.watcher.act({
			itemId: okenaAskItem.id,
			rev: okenaAskItem.rev,
			action: { type: 'answer', picks: [{ options: [0] }] },
		})
		assert.deepEqual(refused.outcome, {
			status: 'refused',
			reason: 'source_down',
			detail: 'Okena is unreachable; answer in the terminal',
		})
		assert.deepEqual(h.okenaActs, [])

		const live = h.askOf('helm:')
		assert.equal(live.id, helmAskItem.id)
		const sent = await h.watcher.act({
			itemId: live.id,
			rev: live.rev,
			action: { type: 'answer', picks: [{ options: [0] }] },
		})
		assert.equal(sent.ok, true, JSON.stringify(sent))
		assert.deepEqual((answers[0] as { hookSpecificOutput: { decision: unknown } }).hookSpecificOutput.decision, {
			behavior: 'allow',
			updatedInput: { ...QUESTIONS, answers: { 'Ship it?': 'Yes' } },
		})

		// Helm's sessions still move while Okena is down.
		h.hub.core.event(REF, PID, h.clock.now, ev('Stop', { prompt_id: 'p1', last_assistant_message: 'Shipped.' }))
		await h.tick(okenaDown())
		const helmSession = h.watcher.snapshot().sessions.find(session => session.source === 'helm')
		assert.notEqual(helmSession?.status, 'working')
		const okenaSession = h.watcher.snapshot().sessions.find(session => session.source === 'okena')
		assert.ok(okenaSession, 'Okena’s sessions are kept, frozen, while it is down')

		// The spool carries the per-source map and session sources.
		const spooled = await readSpoolSnapshot(h.dir, h.clock.now)
		assert.ok(spooled.ok, spooled.ok ? '' : spooled.detail)
		assert.equal(spooled.snapshot.sources?.helm?.state, 'ok')
		assert.equal(spooled.snapshot.sources?.okena?.state, 'down')
		assert.equal(spooled.snapshot.sessions.find(session => session.key.startsWith('helm:'))?.source, 'helm')
	} finally {
		await h.done()
	}
})

test('composite: a throwing source becomes its own down poll; acts route by session source', async () => {
	const acts: string[] = []
	const composite = new CompositeDockSource([
		{
			id: 'okena',
			source: {
				observe: async () => {
					throw new Error('boom')
				},
				act: async () => {
					acts.push('okena')
					return { status: 'sent' as const }
				},
			},
		},
		{
			id: 'helm',
			source: {
				observe: async () => okenaDown(),
				act: async target => {
					acts.push(`helm:${target.terminalId}`)
					return { status: 'sent' as const }
				},
			},
		},
	])
	const polls = await composite.observe({} as never, 0)
	assert.deepEqual(
		polls.map(poll => (poll.type === 'poll' ? [poll.source, poll.state.ok] : [])),
		[
			['okena', false],
			['helm', false],
		],
	)
	const item = {} as DockItem
	await composite.act({ source: 'helm', profile: 'helm:work', terminalId: 't9' }, item, { type: 'deny' })
	await composite.act({ source: 'okena', profile: 'p', terminalId: 't1' }, item, { type: 'deny' })
	assert.deepEqual(acts, ['helm:t9', 'okena'])
})

test('helm dock ls shows both sources and marks Helm agents; show reads a Helm terminal through the hub', async () => {
	const h = await harness()
	try {
		h.hub.core.event(REF, PID, h.clock.now, ev('SessionStart', { source: 'startup', cwd: '/repo/app' }))
		h.hub.core.event(REF, PID, h.clock.now, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'go' }))
		h.hub.core.permission(
			REF,
			PID,
			h.clock.now,
			ev('PermissionRequest', { prompt_id: 'p1', tool_name: 'AskUserQuestion', tool_input: QUESTIONS }),
			{ respond: () => {} },
		)
		await h.tick(okenaAsk())
		await h.tick(okenaDown())
		const now = h.clock.now
		const out: string[] = []
		const deps = { out: (line: string) => void out.push(line), err: () => {}, now: () => now }
		assert.equal(await runDockCli(['ls', '--dir', h.dir], deps), 4, 'exit 4: a source is down')
		const text = out.join('\n')
		assert.match(text, /^Okena unreachable since \d\d:\d\d: connect ENOENT\nHelm terminals: ok/)
		assert.match(text, /\(Helm\)/)

		const helmAsk = h.askOf('helm:')
		const reads: string[] = []
		const shown: string[] = []
		const code = await runDockCli(['show', String(helmAsk.id), '--dir', h.dir], {
			out: (line: string) => void shown.push(line),
			err: () => {},
			now: () => now,
			okena: () => {
				throw new Error('a Helm terminal is never read from Okena')
			},
			helmHub: (dir, profile) => {
				reads.push(`${dir === h.dir}:${profile}`)
				return {
					getClaudeSession: async () => h.hub.core.session(REF),
					getClaudeTranscript: async () => h.hub.core.transcript(REF, {}),
				}
			},
		})
		assert.equal(code, 0)
		assert.deepEqual(reads, ['true:helm:work'])
		assert.match(shown.join('\n'), /Ship it\?/)

		// The real owner-token reader against the running hub.
		const { helmHubReader } = await import('../src/cli/dock.js')
		const session = (await helmHubReader(h.dir, 'helm:work').getClaudeSession('helm-t1')) as { session_id: string }
		assert.equal(session.session_id, SID)
	} finally {
		await h.done()
	}
})

test('helm dock watch registers its own session as the dispatcher only inside a Helm terminal', async () => {
	const sent: unknown[] = []
	const send = async (socket: string, request: unknown) => {
		sent.push({ socket, request })
		return {}
	}
	assert.equal(await registerDispatcher({}, send), false)
	assert.equal(
		await registerDispatcher({ HELM_CLAUDE_REMOTE_SOCKET: '/s', HELM_CLAUDE_REMOTE_TOKEN: 't' }, send),
		false,
	)
	const env = { HELM_CLAUDE_REMOTE_SOCKET: '/s', HELM_CLAUDE_REMOTE_TOKEN: 'tok', CLAUDE_CODE_SESSION_ID: 'disp' }
	assert.equal(await registerDispatcher(env, send), true)
	assert.deepEqual(sent, [{ socket: '/s', request: { v: 1, t: 'dispatcher', token: 'tok', session_id: 'disp' } }])
	assert.equal(
		await registerDispatcher(env, async () => {
			throw new Error('ECONNREFUSED')
		}),
		false,
	)
})
