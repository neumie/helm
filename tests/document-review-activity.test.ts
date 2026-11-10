// S12: display-only send activity from a bound caller's own session file (helm open spec D14).
// Fixtures are real recordings (Claude Code 2.1.322 `claude -p`, Codex 0.160.1 `codex exec`), redacted to their
// structure by a script: every text is "[redacted]" except the line carrying the test request id.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import activityModule from '../app/src/document-review/activity'
import type { ActivityTrack } from '../app/src/document-review/activity'
import watcherModule from '../app/src/document-review/activity-watcher'
import sessionsModule from '../app/src/document-review/sessions'
import { sessionHintFields } from '../src/cli/review.js'
import { REVIEW_V1 } from '../src/document-review/client.js'
import type { ReviewFeedback } from '../src/document-review/types.js'
import { JsonlReadError, readAppendedJsonl } from '../src/provider-files/bounded-jsonl.js'

const { applyLine, startTrack, trackView, toolVerb, TOOL_SILENCE_MS, PENDING_TOOLS_MAX } = activityModule
const { ReviewActivityWatcher, providerSources, locateRetryMs } = watcherModule
const { ReviewSessions } = sessionsModule

const REQUEST = '7c1f3a52-0b6e-4e8a-9d21-5a4b3c2d1e0f'
const FIXTURES = fileURLToPath(new URL('./fixtures/document-review-activity/', import.meta.url))
const fixture = async (name: string) => (await readFile(join(FIXTURES, name), 'utf8')).split('\n').filter(Boolean)
const claudeLines = () => fixture('claude-2.1.322.jsonl')
const codexLines = () => fixture('codex-0.160.1.jsonl')
const CLAUDE_SESSION = 'afd5f451-dd8d-4b6f-b525-94c6c7481258'
const CODEX_THREAD = '01a1c546-6339-7191-b30e-e79993398691'

/** The fixture's own binding record: the tool result written after the (simulated) ack. */
function bindingIndex(lines: string[], provider: 'claude' | 'codex'): number {
	return lines.findIndex(line => {
		const entry = JSON.parse(line)
		return provider === 'claude'
			? entry.type === 'user' && Array.isArray(entry.message?.content) && line.includes(REQUEST)
			: entry.payload?.type === 'custom_tool_call_output' && line.includes(REQUEST)
	})
}
const timeOf = (line: string) => Date.parse(JSON.parse(line).timestamp)
const run = (track: ActivityTrack, lines: string[]) => lines.reduce(applyLine, track)
/** The Claude fixture's Read tool call (an assistant record; a prompt snapshot names the tool too). */
const isReadCall = (line: string) => {
	const entry = JSON.parse(line)
	return entry.type === 'assistant' && entry.message.content.some((block: { name?: string }) => block.name === 'Read')
}

test('Claude Code: binds only at the tool result carrying the exact id after the ack; tokens over distinct message ids', async () => {
	const lines = await claudeLines()
	const bind = bindingIndex(lines, 'claude')
	assert.ok(bind > 0)
	const ack = timeOf(lines[bind] as string) - 200
	// The prompt and the Bash input carry the id too, before the tool result: neither binds.
	const before = run(startTrack('claude', CLAUDE_SESSION, REQUEST, ack), lines.slice(0, bind))
	assert.equal(before.bound, false)
	assert.equal(trackView(before, ack), null)
	const bound = applyLine(before, lines[bind] as string)
	assert.equal(bound.bound, true)
	assert.equal(bound.version, '2.1.322')
	assert.deepEqual(trackView(bound, ack), { working: true, verb: null, outputTokens: 0 })
	// Mid-run: the Read tool call is the last record of its message.
	const readCall = lines.findIndex((line, index) => index > bind && isReadCall(line))
	const mid = run(bound, lines.slice(bind + 1, readCall + 1))
	assert.deepEqual(trackView(mid, timeOf(lines[readCall] as string)), {
		working: true,
		verb: 'Reading',
		outputTokens: 147,
	})
	// The end: 147 + 50, each message once although it is written as several records; the Bash call before the
	// ack (216) never counts. end_turn without a reply drops the line to elapsed-only.
	const end = run(bound, lines.slice(bind + 1))
	assert.equal(end.failed, null)
	assert.deepEqual(trackView(end, Date.now()), { working: false, verb: null, outputTokens: 197 })
})

test('Claude Code: a record before the ack, another request id, a sidechain, a subagent or another session never binds', async () => {
	const lines = await claudeLines()
	const bind = bindingIndex(lines, 'claude')
	const record = JSON.parse(lines[bind] as string)
	const at = timeOf(lines[bind] as string)
	const variants: Array<[string, string, number, string]> = [
		['before the ack', JSON.stringify(record), at + 5000, REQUEST],
		['another request', JSON.stringify(record), at - 200, randomUUID()],
		['sidechain', JSON.stringify({ ...record, isSidechain: true }), at - 200, REQUEST],
		['subagent', JSON.stringify({ ...record, agentId: 'a8c1' }), at - 200, REQUEST],
		['other session', JSON.stringify({ ...record, sessionId: randomUUID() }), at - 200, REQUEST],
	]
	for (const [name, line, ack, id] of variants) {
		const track = run(startTrack('claude', CLAUDE_SESSION, id, ack), [...lines.slice(0, bind), line])
		assert.equal(track.bound, false, name)
		assert.equal(trackView(track, ack), null, name)
	}
})

test('Claude Code: after binding, an unknown shape, a torn line, a version change or too many messages fail closed for good', async () => {
	const lines = await claudeLines()
	const bind = bindingIndex(lines, 'claude')
	const ack = timeOf(lines[bind] as string) - 200
	const bound = run(startTrack('claude', CLAUDE_SESSION, REQUEST, ack), lines.slice(0, bind + 1))
	const assistant = JSON.parse(
		lines.find((line, index) => index > bind && line.includes('"type":"assistant"')) as string,
	)
	const broken = [
		JSON.stringify({ ...assistant, message: 'not an object' }),
		'{"type":"assistant","sessionId"',
		JSON.stringify({ ...assistant, version: '2.2.0' }),
		JSON.stringify({ ...assistant, isSidechain: undefined }),
	]
	for (const line of broken) {
		const failed = applyLine(bound, line)
		assert.notEqual(failed.failed, null, line.slice(0, 60))
		assert.equal(trackView(failed, ack), null)
		// Later good records never bring it back.
		assert.equal(trackView(run(failed, lines.slice(bind + 1)), ack), null)
	}
	let many = bound
	for (let index = 0; index < 4097; index++)
		many = applyLine(many, JSON.stringify({ ...assistant, message: { ...assistant.message, id: `msg_${index}` } }))
	assert.equal(many.failed, 'too many messages')
})

test('a tool call with no newer record for 30 s drops the line to elapsed-only; a newer record brings it back', async () => {
	const lines = await claudeLines()
	const bind = bindingIndex(lines, 'claude')
	const readCall = lines.findIndex((line, index) => index > bind && isReadCall(line))
	const callAt = timeOf(lines[readCall] as string)
	const track = run(
		startTrack('claude', CLAUDE_SESSION, REQUEST, timeOf(lines[bind] as string) - 200),
		lines.slice(0, readCall + 1),
	)
	assert.equal(trackView(track, callAt + TOOL_SILENCE_MS - 1)?.working, true)
	assert.deepEqual(trackView(track, callAt + TOOL_SILENCE_MS), { working: false, verb: null, outputTokens: 147 })
	const resumed = applyLine(track, lines[readCall + 1] as string)
	assert.equal(trackView(resumed, callAt + TOOL_SILENCE_MS)?.working, true)
})

test("Codex: the thread's own rollout binds at the tool output after the ack; tokens are total minus the value at the ack", async () => {
	const lines = await codexLines()
	const bind = bindingIndex(lines, 'codex')
	assert.ok(bind > 0)
	const ack = timeOf(lines[bind] as string) - 200
	const before = run(startTrack('codex', CODEX_THREAD, REQUEST, ack), lines.slice(0, bind))
	assert.equal(before.bound, false)
	assert.equal(before.version, '0.160.1')
	const bound = applyLine(before, lines[bind] as string)
	assert.equal(bound.bound, true)
	// The token_count right after the output still belongs to the response that called helm edit: the baseline.
	const settled = applyLine(bound, lines[bind + 1] as string)
	assert.deepEqual(trackView(settled, ack), { working: true, verb: null, outputTokens: 0 })
	const call = run(settled, lines.slice(bind + 2, bind + 3))
	assert.deepEqual(trackView(call, ack), { working: true, verb: 'Running a command', outputTokens: 0 })
	// task_complete without a reply: elapsed only, the tokens stay (374 - 265).
	const end = run(settled, lines.slice(bind + 2))
	assert.equal(end.failed, null)
	assert.deepEqual(trackView(end, Date.now()), { working: false, verb: null, outputTokens: 109 })
})

test('Codex: another thread, a subagent sharing the session, a version change or an unknown shape fail closed', async () => {
	const lines = await codexLines()
	const bind = bindingIndex(lines, 'codex')
	const ack = timeOf(lines[bind] as string) - 200
	const meta = JSON.parse(lines[0] as string)
	// A subagent rollout shares session_id but has its own payload.id.
	const subagent = JSON.stringify({ ...meta, payload: { ...meta.payload, id: randomUUID() } })
	assert.equal(
		run(startTrack('codex', CODEX_THREAD, REQUEST, ack), [subagent, ...lines.slice(1)]).failed,
		'not this thread',
	)
	// No session_meta at all: the tool output alone never binds.
	assert.equal(run(startTrack('codex', CODEX_THREAD, REQUEST, ack), lines.slice(1)).bound, false)
	const bound = run(startTrack('codex', CODEX_THREAD, REQUEST, ack), lines.slice(0, bind + 1))
	const newer = JSON.stringify({ ...meta, payload: { ...meta.payload, cli_version: '0.161.0' } })
	assert.equal(applyLine(bound, newer).failed, 'version changed')
	assert.notEqual(applyLine(bound, '{"type":"response_item","payload":7}').failed, null)
	assert.notEqual(applyLine(bound, 'not json').failed, null)
})

test('verbs are generic words; MCP and unknown tool names are never shown', () => {
	assert.equal(toolVerb('Bash'), 'Running a command')
	assert.equal(toolVerb('exec_command'), 'Running a command')
	assert.equal(toolVerb('Edit'), 'Editing')
	assert.equal(toolVerb('apply_patch'), 'Editing')
	assert.equal(toolVerb('Read'), 'Reading')
	assert.equal(toolVerb('Grep'), 'Searching')
	assert.equal(toolVerb('mcp__clientcare__update_task_status'), 'Working')
	assert.equal(toolVerb('resolve_library_id'), 'Working')
})

test('the CLI sends the hint only after hello lists session-hint, only for Claude Code and Codex, only a plausible id', () => {
	const hello = { protocol: 2, features: ['session-hint'] }
	assert.deepEqual(sessionHintFields('claude', hello, { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION }), {
		features: ['session-hint'],
		session: CLAUDE_SESSION,
	})
	assert.deepEqual(sessionHintFields('codex', hello, { CODEX_THREAD_ID: CODEX_THREAD }), {
		features: ['session-hint'],
		session: CODEX_THREAD,
	})
	// An old host (hello unknown) keeps the unchanged connect: the S11 elapsed-only line.
	assert.deepEqual(sessionHintFields('claude', REVIEW_V1, { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION }), {})
	assert.deepEqual(
		sessionHintFields('claude', { protocol: 2, features: [] }, { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION }),
		{},
	)
	assert.deepEqual(sessionHintFields('pi', hello, { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION }), {})
	assert.deepEqual(sessionHintFields('cli', hello, { CODEX_THREAD_ID: CODEX_THREAD }), {})
	assert.deepEqual(sessionHintFields('claude', hello, { CODEX_THREAD_ID: CODEX_THREAD }), {})
	assert.deepEqual(sessionHintFields('claude', hello, { CLAUDE_CODE_SESSION_ID: '../../etc/passwd' }), {})
})

/** A delivered, confirmed request of a hinted caller. */
function delivered(sessions: InstanceType<typeof ReviewSessions>, provider: 'claude' | 'codex', session: string) {
	const connected = sessions.connect(provider, '/w', 'Conversation', 'tool-return', { provider, session })
	const listening = sessions.next(connected.id, connected.owner, 60000, new AbortController().signal)
	const owner = sessions.reserve(connected.id, connected.owner, '/w')
	const feedback: ReviewFeedback = {
		request: {
			id: REQUEST,
			documentId: randomUUID(),
			revision: 'r1',
			sessionId: connected.id,
			owner: connected.owner,
			intent: 'discuss',
			instruction: 'Tighten the second section.',
			passage: null,
		},
		prompt: 'Tighten the second section.',
		relativePath: 'spec.md',
	}
	sessions.dispatch(owner, REQUEST, 'fingerprint', feedback)
	return { connected, listening, documentId: feedback.request.documentId }
}

test('renewal from observed activity: only the exact pending request, never shorter, never past delivery + cap', async t => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
	const sessions = new ReviewSessions(() => {}, 1000, 10000, 2500)
	const f = delivered(sessions, 'claude', CLAUDE_SESSION)
	assert.deepEqual(sessions.activityTargets(), [])
	sessions.confirm(f.connected.id, f.connected.owner, REQUEST)
	assert.equal(sessions.activityTargets().length, 1)
	assert.equal(sessions.renew(f.connected.id, f.connected.owner, randomUUID(), 0), false)
	assert.equal(sessions.renew(f.connected.id, randomUUID(), REQUEST, 0), false)
	t.mock.timers.tick(900)
	assert.equal(sessions.renew(f.connected.id, f.connected.owner, REQUEST, 900), true)
	// An older observation never shortens the deadline a newer one set.
	assert.equal(sessions.renew(f.connected.id, f.connected.owner, REQUEST, 500), false)
	t.mock.timers.tick(900) // 1800: past the first deadline (1000), inside the renewed one (1900)
	assert.equal(sessions.receipt(REQUEST)?.outcome, 'dispatched')
	// A forged record every 600 ms still ends at the cap: nothing settles, confirms or replays.
	for (let at = 1800; at < 2500; at += 300) {
		sessions.renew(f.connected.id, f.connected.owner, REQUEST, at)
		t.mock.timers.tick(300)
	}
	t.mock.timers.tick(100)
	assert.equal(sessions.receipt(REQUEST)?.outcome, 'unknown')
	assert.equal(sessions.renew(f.connected.id, f.connected.owner, REQUEST, Date.now()), false)
	assert.deepEqual(sessions.activityTargets(), [])
	await f.listening
})

test('a hint for another provider is dropped; an unhinted caller (old CLI) is never a target', async () => {
	const sessions = new ReviewSessions(() => {})
	const pi = sessions.connect('pi', '/w', 'Pi', 'in-process', { provider: 'claude', session: CLAUDE_SESSION })
	const old = sessions.connect('claude', '/w', 'Claude Code', 'tool-return')
	for (const connected of [pi, old]) {
		const listening = sessions.next(connected.id, connected.owner, 60000, new AbortController().signal)
		const owner = sessions.reserve(connected.id, connected.owner, '/w')
		const id = randomUUID()
		sessions.dispatch(owner, id, `fingerprint-${id}`, {
			request: {
				id,
				documentId: randomUUID(),
				revision: 'r1',
				sessionId: connected.id,
				owner: connected.owner,
				intent: 'discuss',
				instruction: 'x',
				passage: null,
			},
			prompt: 'x',
			relativePath: 'spec.md',
		})
		sessions.confirm(connected.id, connected.owner, id)
		await listening
	}
	assert.deepEqual(sessions.activityTargets(), [])
	// The hint never reaches the snapshot (or the wire).
	assert.ok(!JSON.stringify(sessions.list('/w')).includes(CLAUDE_SESSION))
})

async function claudeRoot() {
	const home = await realpath(await mkdtemp(join(tmpdir(), 'hr-act-')))
	const folder = join(home, 'config', 'projects', '-w')
	await mkdir(folder, { recursive: true })
	return { home, root: join(home, 'config'), file: join(folder, `${CLAUDE_SESSION}.jsonl`) }
}

test('the watcher reads the hinted transcript, renews, shows working with tokens, freezes at the reply', async () => {
	const lines = await claudeLines()
	const bind = bindingIndex(lines, 'claude')
	const readCall = lines.findIndex((line, index) => index > bind && isReadCall(line))
	const dir = await claudeRoot()
	try {
		await writeFile(dir.file, `${lines.slice(0, bind).join('\n')}\n`)
		let now = timeOf(lines[bind] as string) - 200
		const sessions = new ReviewSessions(() => {})
		let published = 0
		const watcher = new ReviewActivityWatcher(
			() => [['p', sessions]],
			() => {
				published++
			},
			providerSources({ claudeRoots: [dir.root] }),
			() => now,
			60_000,
		)
		const f = delivered(sessions, 'claude', CLAUDE_SESSION)
		sessions.confirm(f.connected.id, f.connected.owner, REQUEST)
		// The ack time the track compares against is the mailbox's own clock; pin the window to the fixture.
		const [target] = sessions.activityTargets()
		assert.ok(target)
		const renewed: string[] = []
		const renew = sessions.renew.bind(sessions)
		sessions.renew = (id, owner, requestId, at) => {
			renewed.push(requestId)
			return renew(id, owner, requestId, at)
		}
		;(sessions as unknown as { activityTargets(): unknown[] }).activityTargets = () => [{ ...target, confirmedAt: now }]
		await watcher.tick()
		assert.equal(watcher.activity('p', f.connected.id, f.documentId), null)
		await appendFile(dir.file, `${lines.slice(bind, readCall + 1).join('\n')}\n`)
		now = timeOf(lines[readCall] as string)
		await watcher.tick()
		assert.deepEqual(watcher.activity('p', f.connected.id, f.documentId), {
			sessionId: f.connected.id,
			requestId: REQUEST,
			working: true,
			verb: 'Reading',
			outputTokens: 147,
		})
		assert.ok(renewed.length > 0)
		assert.ok(published > 0)
		// Another window of the same caller never sees it.
		assert.equal(watcher.activity('p', f.connected.id, randomUUID()), null)
		// The caller replies: the request leaves the targets and the line freezes (tokens kept, not working).
		sessions.report(f.connected.id, f.connected.owner, REQUEST, 0, 'complete', 'Done.')
		;(sessions as unknown as { activityTargets(): unknown[] }).activityTargets = () => []
		await watcher.tick()
		assert.deepEqual(watcher.activity('p', f.connected.id, f.documentId), {
			sessionId: f.connected.id,
			requestId: REQUEST,
			working: false,
			verb: null,
			outputTokens: 147,
		})
		watcher.stop()
		await f.listening
	} finally {
		await rm(dir.home, { recursive: true, force: true })
	}
})

test('file guards: a symlink, a hard link, a path outside the root, a replaced file or growth past the bound fail', async () => {
	const dir = await claudeRoot()
	try {
		const base = join(dir.root, 'projects')
		const options = { firstReadBytes: 1024, maxReadBytes: 64, strict: { root: base } }
		await writeFile(dir.file, '{"type":"x"}\n')
		const first = await readAppendedJsonl(dir.file, null, options)
		assert.deepEqual(first.lines, ['{"type":"x"}'])
		// Growth past the bound between reads.
		await appendFile(dir.file, `${'{"type":"y"}\n'.repeat(10)}`)
		await assert.rejects(readAppendedJsonl(dir.file, first.cursor, options), JsonlReadError)
		// Replaced under the same name.
		await writeFile(`${dir.file}.new`, '{"type":"x"}\n')
		await rename(`${dir.file}.new`, dir.file)
		await assert.rejects(readAppendedJsonl(dir.file, first.cursor, options), JsonlReadError)
		// A second name for the same file.
		await link(dir.file, join(base, '-w', 'other.jsonl'))
		await assert.rejects(readAppendedJsonl(dir.file, null, options), JsonlReadError)
		await rm(join(base, '-w', 'other.jsonl'))
		// A symlink to it, and a real file outside the root.
		const outside = join(dir.home, 'outside.jsonl')
		await writeFile(outside, '{"type":"x"}\n')
		await symlink(outside, join(base, '-w', 'linked.jsonl'))
		await assert.rejects(readAppendedJsonl(join(base, '-w', 'linked.jsonl'), null, options))
		await assert.rejects(readAppendedJsonl(outside, null, options), JsonlReadError)
		assert.deepEqual((await readAppendedJsonl(dir.file, null, options)).lines, ['{"type":"x"}'])
	} finally {
		await rm(dir.home, { recursive: true, force: true })
	}
})

test("Codex rollouts are found by thread id; a compressed or another thread's rollout is never read", async () => {
	const home = await realpath(await mkdtemp(join(tmpdir(), 'hr-act-')))
	try {
		const day = join(home, 'sessions', '2026', '11', '10')
		await mkdir(day, { recursive: true })
		const lines = await codexLines()
		const sources = providerSources({ codexRoot: join(home, 'sessions') })
		await writeFile(join(day, `rollout-2026-11-10T12-44-47-${CODEX_THREAD}.jsonl.zst`), 'compressed')
		await writeFile(join(day, `rollout-2026-11-10T12-40-00-${randomUUID()}.jsonl`), `${lines.join('\n')}\n`)
		assert.equal(await sources.locate({ provider: 'codex', session: CODEX_THREAD }, '/w'), undefined)
		const file = join(day, `rollout-2026-11-10T12-44-47-${CODEX_THREAD}.jsonl`)
		await writeFile(file, `${lines.join('\n')}\n`)
		const found = await sources.locate({ provider: 'codex', session: CODEX_THREAD }, '/w')
		assert.equal(found?.path, file)
		assert.equal(JSON.parse((await sources.firstLine(file, found?.root as string)) as string).type, 'session_meta')
		assert.equal(await sources.locate({ provider: 'codex', session: 'not-a-thread-id' }, '/w'), undefined)
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test("Claude transcripts: a symlinked <session>.jsonl (to another session's file) is never found or read", async () => {
	const home = await realpath(await mkdtemp(join(tmpdir(), 'hr-act-')))
	try {
		const projects = join(home, 'projects')
		await mkdir(join(projects, '-w'), { recursive: true })
		await mkdir(join(projects, '-other'), { recursive: true })
		const other = join(projects, '-other', `${randomUUID()}.jsonl`)
		await writeFile(other, '{"type":"x"}\n')
		await symlink(other, join(projects, '-w', `${CLAUDE_SESSION}.jsonl`))
		const sources = providerSources({ claudeRoots: [home] })
		assert.equal(await sources.locate({ provider: 'claude', session: CLAUDE_SESSION }, '/w'), undefined)
		await rm(join(projects, '-w', `${CLAUDE_SESSION}.jsonl`))
		await writeFile(join(projects, '-w', `${CLAUDE_SESSION}.jsonl`), '{"type":"x"}\n')
		const found = await sources.locate({ provider: 'claude', session: CLAUDE_SESSION }, '/w')
		assert.equal(found?.path, join(projects, '-w', `${CLAUDE_SESSION}.jsonl`))
	} finally {
		await rm(home, { recursive: true, force: true })
	}
})

test('an unfound session file is looked up again at 5, 10, 20, 40 s, then once a minute', () => {
	assert.deepEqual([1, 2, 3, 4, 5, 9].map(locateRetryMs), [5000, 10000, 20000, 40000, 60000, 60000])
})

/** A bound Claude track plus records shaped like Claude Code 2.1.3xx writes them. */
async function boundClaude() {
	const lines = await claudeLines()
	const bind = bindingIndex(lines, 'claude')
	const at = timeOf(lines[bind] as string)
	const track = run(startTrack('claude', CLAUDE_SESSION, REQUEST, at - 200), lines.slice(0, bind + 1))
	const base = { sessionId: CLAUDE_SESSION, isSidechain: false, version: '2.1.322' }
	const stamp = (offset: number) => new Date(at + offset).toISOString()
	return {
		track,
		at,
		call: (offset: number, id: string, name: string, messageId = 'msg_parallel') =>
			JSON.stringify({
				...base,
				type: 'assistant',
				timestamp: stamp(offset),
				message: { id: messageId, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: {} }] },
			}),
		result: (offset: number, id: string) =>
			JSON.stringify({
				...base,
				type: 'user',
				timestamp: stamp(offset),
				message: { content: [{ type: 'tool_result', tool_use_id: id, content: '[redacted]' }] },
			}),
		user: (offset: number, extra: Record<string, unknown>, text: string) =>
			JSON.stringify({
				...base,
				...extra,
				type: 'user',
				timestamp: stamp(offset),
				message: { content: [{ type: 'text', text }] },
			}),
		raw: (offset: number, value: Record<string, unknown>) =>
			JSON.stringify({ ...base, timestamp: stamp(offset), ...value }),
	}
}

test('parallel tool calls: one result keeps the 30 s rule for the call still waiting (Claude Code and Codex)', async () => {
	const c = await boundClaude()
	const one = run(c.track, [c.call(10, 'toolu_a', 'Read'), c.call(11, 'toolu_b', 'Bash'), c.result(12, 'toolu_a')])
	assert.deepEqual(one.pending, ['toolu_b'])
	assert.deepEqual(trackView(one, c.at + 11 + TOOL_SILENCE_MS - 1), {
		working: true,
		verb: 'Running a command',
		outputTokens: 0,
	})
	assert.equal(trackView(one, c.at + 11 + TOOL_SILENCE_MS)?.working, false)
	const both = applyLine(one, c.result(13, 'toolu_b'))
	assert.deepEqual(both.pending, [])
	assert.deepEqual(trackView(both, c.at + 10 * 60_000), { working: true, verb: null, outputTokens: 0 })

	const lines = await codexLines()
	const bind = bindingIndex(lines, 'codex')
	const at = timeOf(lines[bind] as string)
	const codex = run(startTrack('codex', CODEX_THREAD, REQUEST, at - 200), lines.slice(0, bind + 2))
	const item = (offset: number, payload: Record<string, unknown>) =>
		JSON.stringify({ type: 'response_item', timestamp: new Date(at + offset).toISOString(), payload })
	const waiting = run(codex, [
		item(10, { type: 'function_call', name: 'exec_command', call_id: 'call_a' }),
		item(11, { type: 'function_call', name: 'read_file', call_id: 'call_b' }),
		item(12, { type: 'function_call_output', call_id: 'call_a', output: '[redacted]' }),
	])
	assert.deepEqual(waiting.pending, ['call_b'])
	assert.equal(trackView(waiting, at + 11 + TOOL_SILENCE_MS)?.working, false)
	const answered = applyLine(waiting, item(13, { type: 'reasoning' }))
	assert.deepEqual(answered.pending, [])
	assert.equal(trackView(answered, at + 11 + TOOL_SILENCE_MS)?.working, true)
	// More than PENDING_TOOLS_MAX calls waiting at once fails closed.
	const many = Array.from({ length: PENDING_TOOLS_MAX + 1 }, (_, n) => c.call(20 + n, `toolu_${n}`, 'Read'))
	assert.equal(run(c.track, many).failed, 'too many tool calls')
})

test('Claude Code turns that end without end_turn (API error, interrupt, stop hook) stop claiming work', async () => {
	const c = await boundClaude()
	const views = (track: ActivityTrack) => trackView(track, c.at + 10 * 60_000)
	const ended = { working: false, verb: null, outputTokens: 0 }
	// The synthetic assistant message Claude Code writes after an API failure.
	const synthetic = c.raw(10, {
		type: 'assistant',
		isApiErrorMessage: true,
		message: {
			id: 'msg_err',
			model: '<synthetic>',
			stop_reason: 'stop_sequence',
			content: [{ type: 'text', text: '[redacted]' }],
		},
	})
	assert.deepEqual(views(applyLine(c.track, synthetic)), ended)
	// Esc, with or without a tool in flight.
	assert.deepEqual(views(applyLine(c.track, c.user(10, {}, '[Request interrupted by user]'))), ended)
	const tool = run(c.track, [
		c.call(10, 'toolu_a', 'Bash'),
		c.user(11, {}, '[Request interrupted by user for tool use]'),
	])
	assert.deepEqual(views(tool), ended)
	// The main thread's turn-closing system records.
	for (const subtype of ['stop_hook_summary', 'turn_duration'])
		assert.deepEqual(views(applyLine(c.track, c.raw(10, { type: 'system', subtype }))), ended)
	// A subagent's system record, a local command and a compact summary change nothing.
	assert.deepEqual(
		views(applyLine(c.track, c.raw(10, { type: 'system', subtype: 'turn_duration', isSidechain: true }))),
		views(c.track),
	)
	const stopped = applyLine(c.track, c.raw(10, { type: 'system', subtype: 'turn_duration' }))
	assert.deepEqual(views(applyLine(stopped, c.user(11, { isMeta: true }, '[redacted]'))), ended)
	assert.deepEqual(views(applyLine(stopped, c.user(11, { isCompactSummary: true }, '[redacted]'))), ended)
	// A prompt typed afterwards is work again.
	assert.equal(views(applyLine(stopped, c.user(11, {}, '[redacted]')))?.working, true)
})
