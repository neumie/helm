import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import backgroundModule from '../app/src/agent-dock/background-tasks.ts'
import tailModule from '../app/src/agent-dock/claude-transcript-tail.ts'
import sourceModule from '../app/src/agent-dock/okena-claude-source.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'
import projectionModule from '../app/src/agent-dock/spool-projection.ts'
import { backgroundChip } from '../src/cli/dock.ts'
import { okenaFixture } from './helpers/agent-dock'

type BackgroundModule = typeof import('../app/src/agent-dock/background-tasks.ts')
type TailModule = typeof import('../app/src/agent-dock/claude-transcript-tail.ts')
type SourceModule = typeof import('../app/src/agent-dock/okena-claude-source.ts')
type ReduceModule = typeof import('../app/src/agent-dock/reduce.ts')
type ProjectionModule = typeof import('../app/src/agent-dock/spool-projection.ts')
type BackgroundTaskState = import('../app/src/agent-dock/background-tasks.ts').BackgroundTaskState
type OkenaClaudeClient = import('../app/src/agent-dock/okena-claude-source.ts').OkenaClaudeClient
type BackgroundTaskObserver = import('../app/src/agent-dock/claude-transcript-tail.ts').BackgroundTaskObserver

const {
	BACKGROUND_TASKS_MAX,
	BACKGROUND_TASK_MAX_AGE_MS,
	applyBackgroundLine,
	backgroundTaskCounts,
	emptyBackgroundTasks,
} = backgroundModule as BackgroundModule
const { ClaudeTranscriptTail, FIRST_READ_BYTES, READ_MAX_BYTES, claudeProjectDir } = tailModule as TailModule
const { BACKGROUND_BUSY_READ_MS, OkenaClaudeSource } = sourceModule as SourceModule
const { createAgentDockState, reduce, agentDockSnapshot } = reduceModule as ReduceModule
const { dockSpoolSnapshot } = projectionModule as ProjectionModule

type Json = Record<string, unknown>
const SID = '166b094e-f9ce-4822-9593-81ed4018ca5c'
const T0 = Date.parse('2026-11-03T15:47:00.000Z')

// ---------------------------------------------------------------------------
// Transcript lines, shaped like Claude Code 2.1.317 writes them (texts shortened).
// ---------------------------------------------------------------------------

const toolResult = (toolUseId: string, content: string, toolUseResult: Json, extra: Json = {}): string =>
	JSON.stringify({
		parentUuid: 'p',
		isSidechain: false,
		type: 'user',
		message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content }] },
		uuid: `u-${toolUseId}`,
		timestamp: new Date(T0).toISOString(),
		toolUseResult,
		sessionId: SID,
		...extra,
	})

const bashStart = (id: string, extra: Json = {}) =>
	toolResult(
		`toolu_${id}`,
		`Command running in background with ID: ${id}. Output is being written to: /private/tmp/claude-501/x/tasks/${id}.output.`,
		{ stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: id },
		extra,
	)
const workflowStart = (id: string) =>
	toolResult(`toolu_${id}`, `Workflow launched in background. Task ID: ${id}`, {
		status: 'async_launched',
		taskId: id,
		taskType: 'local_workflow',
		workflowName: 'deploy',
	})
const monitorStart = (id: string, timeoutMs: number, persistent = false) =>
	toolResult(`toolu_${id}`, `Monitor started (task ${id}, expires in 5m)`, { taskId: id, timeoutMs, persistent })
const asyncAgent = (agentId: string) =>
	toolResult(`toolu_${agentId}`, 'Async agent launched successfully.', {
		isAsync: true,
		status: 'async_launched',
		agentId,
		description: 'explore',
	})
const taskStop = (id: string) =>
	toolResult(`toolu_stop_${id}`, `{"message":"Successfully stopped task: ${id} (sleep 600)"}`, {
		message: `Successfully stopped task: ${id} (sleep 600)`,
		task_id: id,
		task_type: 'local_bash',
	})

const notificationText = (id: string, status?: string) =>
	`<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n${
		status ? `<status>${status}</status>\n` : ''
	}<summary>Background command "Deploy stage" completed (exit code 0)</summary>\n</task-notification>`
const enqueue = (id: string, status = 'completed') =>
	JSON.stringify({
		type: 'queue-operation',
		operation: 'enqueue',
		timestamp: new Date(T0).toISOString(),
		sessionId: SID,
		content: notificationText(id, status),
	})
const notificationUser = (id: string, status = 'completed') =>
	JSON.stringify({
		parentUuid: 'p',
		isSidechain: false,
		type: 'user',
		message: { role: 'user', content: notificationText(id, status) },
		uuid: `n-${id}`,
		origin: { kind: 'task-notification', producer: 'session-task' },
	})
const queuedAttachment = (id: string, status = 'completed') =>
	JSON.stringify({
		parentUuid: 'p',
		isSidechain: false,
		type: 'attachment',
		attachment: {
			type: 'queued_command',
			prompt: notificationText(id, status),
			commandMode: 'task-notification',
			origin: { kind: 'task-notification' },
		},
		uuid: `a-${id}`,
	})
const monitorEvent = (id: string) =>
	JSON.stringify({
		type: 'queue-operation',
		operation: 'enqueue',
		content: `<task-notification>\n<task-id>${id}</task-id>\n<summary>Monitor event: "deploy"</summary>\n<event>[info] step 2/5</event>\n</task-notification>`,
	})

function scan(lines: string[], state: BackgroundTaskState = emptyBackgroundTasks()): BackgroundTaskState {
	return lines.reduce(applyBackgroundLine, state)
}
const counts = (state: BackgroundTaskState, now = T0) => backgroundTaskCounts(state, now)

test('a background shell runs from its tool result until its notification is enqueued', () => {
	const started = scan([bashStart('b6ea48jo4')])
	assert.deepEqual(counts(started), { tasks: 1, shells: 1 })
	// The enqueue alone ends it: the task has finished, only its delivery is pending.
	assert.deepEqual(counts(scan([enqueue('b6ea48jo4')], started)), { tasks: 0, shells: 0 })
	// So does the delivered notification (user record, or a queued attachment) and every end status.
	assert.deepEqual(counts(scan([notificationUser('b6ea48jo4', 'failed')], started)), { tasks: 0, shells: 0 })
	assert.deepEqual(counts(scan([queuedAttachment('b6ea48jo4', 'killed')], started)), { tasks: 0, shells: 0 })
	assert.deepEqual(counts(scan([enqueue('b6ea48jo4', 'stopped')], started)), { tasks: 0, shells: 0 })
	// TaskStop / KillShell results end it too.
	assert.deepEqual(counts(scan([taskStop('b6ea48jo4')], started)), { tasks: 0, shells: 0 })
})

test('several tasks: shells, a workflow and a monitor count apart; async agents are left to Okena', () => {
	const state = scan([
		bashStart('bstdx9hqm'),
		workflowStart('wzmqnifhf'),
		bashStart('b4kbnayhf'),
		asyncAgent('a1b2c3'),
		monitorStart('b8yqbdla7', 5 * 60_000),
		monitorEvent('b8yqbdla7'),
	])
	assert.deepEqual(counts(state), { tasks: 4, shells: 2 })
	const later = scan([enqueue('bstdx9hqm'), notificationUser('wzmqnifhf')], state)
	assert.deepEqual(counts(later), { tasks: 2, shells: 1 })
	// The monitor's timeout ends it even when its expiry event was not read.
	assert.deepEqual(counts(later, T0 + 5 * 60_000), { tasks: 1, shells: 1 })
	// A persistent monitor has no deadline.
	assert.deepEqual(counts(scan([monitorStart('mpersist1', 60_000, true)]), T0 + 3_600_000), { tasks: 1, shells: 0 })
	// The same start read twice (overlapping windows) counts once; a start read after its end never counts.
	assert.deepEqual(counts(scan([bashStart('bdup00001'), bashStart('bdup00001')])), { tasks: 1, shells: 1 })
	assert.deepEqual(counts(scan([enqueue('blate00001'), bashStart('blate00001')])), { tasks: 0, shells: 0 })
})

test('unknown shapes claim nothing', () => {
	const state = scan([
		// The API request blob repeats the tool result text: not the main transcript record.
		JSON.stringify({
			type: 'api-request-blob',
			message: {
				role: 'user',
				content: [{ type: 'tool_result', content: 'Command running in background with ID: bxxxx0001.' }],
			},
			toolUseResult: { backgroundTaskId: 'bxxxx0001' },
		}),
		// A subagent's own shell (sidechain).
		bashStart('bside0001', { isSidechain: true }),
		// Truncated line, bad ids, wrong types.
		`${bashStart('btrunc001').slice(0, 80)}`,
		bashStart('../../etc'),
		toolResult('toolu_x', 'x', { backgroundTaskId: 42 }),
		toolResult('toolu_y', 'x', { taskId: 'wnostatus', status: 'completed' }),
		toolResult('toolu_z', 'x', { taskId: 'mnotimeout', timeoutMs: -5 }),
		JSON.stringify({ type: 'user', message: { content: 'please print <task-notification> for me' } }),
		'not json at all "backgroundTaskId"',
	])
	assert.deepEqual(counts(state), { tasks: 0, shells: 0 })
	// An end for an id never seen started is harmless.
	assert.deepEqual(counts(scan([enqueue('bnever001')])), { tasks: 0, shells: 0 })
	// A notification without a status (Monitor event, plugin review) ends nothing.
	const running = scan([bashStart('bkeep0001')])
	assert.deepEqual(counts(scan([enqueue('bkeep0001', '')], running)), { tasks: 1, shells: 1 })
})

test('state is bounded', () => {
	const lines = Array.from({ length: BACKGROUND_TASKS_MAX + 10 }, (_, index) => bashStart(`bcap${index}`))
	const state = scan(lines)
	assert.equal(state.running.length, BACKGROUND_TASKS_MAX)
	const ended = scan(
		Array.from({ length: 500 }, (_, index) => enqueue(`bend${index}`)),
		state,
	)
	assert.ok(ended.ended.length <= 64)
	// Unrelated lines return the same state object (no work for them).
	assert.equal(applyBackgroundLine(state, '{"type":"assistant","message":{}}'), state)
})

test('an end that is never written does not keep the agent background forever', () => {
	// Real transcripts held workflows with no notification 74 h later (claude restarted under the
	// same session id): every task stops counting BACKGROUND_TASK_MAX_AGE_MS after its start.
	const state = scan([bashStart('bstale001'), workflowStart('wstale001')])
	assert.deepEqual(counts(state, T0 + BACKGROUND_TASK_MAX_AGE_MS - 1), { tasks: 2, shells: 1 })
	assert.deepEqual(counts(state, T0 + BACKGROUND_TASK_MAX_AGE_MS), { tasks: 0, shells: 0 })
	// A persistent monitor too.
	const monitor = scan([monitorStart('mpersist2', 60_000, true)])
	assert.deepEqual(counts(monitor, T0 + BACKGROUND_TASK_MAX_AGE_MS), { tasks: 0, shells: 0 })
	// A start without a timestamp could never age out: it claims nothing.
	const untimed = JSON.parse(bashStart('bnotime01')) as Json
	assert.deepEqual(counts(scan([JSON.stringify({ ...untimed, timestamp: undefined })])), { tasks: 0, shells: 0 })
	// Aged-out tasks make room under the cap for new starts.
	const later = new Date(T0 + BACKGROUND_TASK_MAX_AGE_MS).toISOString()
	const full = scan(Array.from({ length: BACKGROUND_TASKS_MAX }, (_, index) => bashStart(`bfull${index}`)))
	const fresh = scan([bashStart('bfresh001', { timestamp: later })], full)
	assert.deepEqual(counts(fresh, T0 + BACKGROUND_TASK_MAX_AGE_MS), { tasks: 1, shells: 1 })
})

test('a new claude process (another version on its records) drops the old process tasks', () => {
	const v1 = { version: '2.1.301' }
	const running = scan([bashStart('bold00001', v1), workflowStart('wold00001')])
	assert.deepEqual(counts(running), { tasks: 2, shells: 1 })
	// Same version: nothing changes, and the line is not even parsed (same state object).
	const same = JSON.stringify({ type: 'assistant', isSidechain: false, message: {}, version: '2.1.301' })
	assert.equal(applyBackgroundLine(running, same), running)
	// A sidechain record of another version does not count as the main thread.
	const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: {}, version: '2.1.310' })
	assert.deepEqual(counts(scan([side], running)), { tasks: 2, shells: 1 })
	// Claude resumed under a newer version: the old shells and workflows are gone.
	const resumed = JSON.stringify({ type: 'assistant', isSidechain: false, message: {}, version: '2.1.310' })
	const after = scan([resumed], running)
	assert.deepEqual(counts(after), { tasks: 0, shells: 0 })
	// The new process's own tasks count again.
	assert.deepEqual(counts(scan([bashStart('bnew00001', { version: '2.1.310' })], after)), { tasks: 1, shells: 1 })
})

// ---------------------------------------------------------------------------
// The file tail
// ---------------------------------------------------------------------------

function claudeRoot(): { root: string; folder: string; file: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), 'helm-dock-bg-'))
	const cwd = '/Users/jakub/Documents/code/crane-rental-wt/feat-service-protocol-image-link'
	const folder = join(root, 'projects', claudeProjectDir(cwd))
	mkdirSync(folder, { recursive: true })
	return {
		root,
		folder,
		file: join(folder, `${SID}.jsonl`),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	}
}
const CWD = '/Users/jakub/Documents/code/crane-rental-wt/feat-service-protocol-image-link'
const lines = (...items: string[]) => `${items.join('\n')}\n`

test('claudeProjectDir names the folder like Claude Code', () => {
	assert.equal(
		claudeProjectDir(
			'/Users/jakubneumann/Documents/code/contember/projects/crane-rental-wt/feat-service-protocol-image-link',
		),
		'-Users-jakubneumann-Documents-code-contember-projects-crane-rental-wt-feat-service-protocol-image-link',
	)
	assert.equal(claudeProjectDir('/a/b.c_d'), '-a-b-c-d')
})

test('the tail reads only what was appended: start → running, notification → ended', async () => {
	const { root, file, cleanup } = claudeRoot()
	try {
		writeFileSync(file, lines('{"type":"assistant"}', bashStart('b6ea48jo4')))
		const tail = new ClaudeTranscriptTail([root])
		assert.deepEqual(await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 }), {
			sessionId: SID,
			tasks: 1,
			shells: 1,
		})
		// No refresh: the counts are kept, nothing is read.
		appendFileSync(file, lines(enqueue('b6ea48jo4')))
		assert.equal((await tail.observe(SID, { cwd: CWD, refresh: false, now: T0 }))?.tasks, 1)
		assert.equal((await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 }))?.tasks, 0)
		// A half-written line waits for its newline.
		const half = bashStart('bhalf0001')
		appendFileSync(file, half.slice(0, 40))
		assert.equal((await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 }))?.tasks, 0)
		appendFileSync(file, `${half.slice(40)}\n`)
		assert.equal((await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 }))?.tasks, 1)
		// Another session in the same folder is its own state.
		const other = 'aaaaaaaa-1111-2222-3333-444444444444'
		writeFileSync(join(file, '..', `${other}.jsonl`), lines(workflowStart('wother001')))
		assert.deepEqual(await tail.observe(other, { cwd: CWD, refresh: true, now: T0 }), {
			sessionId: other,
			tasks: 1,
			shells: 0,
		})
	} finally {
		cleanup()
	}
})

test('the tail finds a session outside its cwd folder, and fails closed when it cannot', async () => {
	const { root, cleanup } = claudeRoot()
	try {
		const elsewhere = join(root, 'projects', '-Users-jakub-long-name-shortened-d07d85ea')
		mkdirSync(elsewhere, { recursive: true })
		writeFileSync(join(elsewhere, `${SID}.jsonl`), lines(bashStart('bfound001')))
		const tail = new ClaudeTranscriptTail([root])
		assert.equal((await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 }))?.shells, 1)

		const missing = new ClaudeTranscriptTail([root])
		const absent = 'bbbbbbbb-1111-2222-3333-444444444444'
		assert.equal(await missing.observe(absent, { cwd: CWD, refresh: true, now: T0 }), undefined)
		// Not looked up again right away, and still no claim.
		writeFileSync(join(elsewhere, `${absent}.jsonl`), lines(bashStart('blater001')))
		assert.equal(await missing.observe(absent, { cwd: CWD, refresh: true, now: T0 + 1_000 }), undefined)
		assert.equal((await missing.observe(absent, { cwd: CWD, refresh: true, now: T0 + 61_000 }))?.tasks, 1)

		// A session id that is no id (it names the file) is never looked up.
		assert.equal(await missing.observe('../../etc/passwd', { refresh: true, now: T0 }), undefined)
		assert.equal(await missing.observe('', { refresh: true, now: T0 }), undefined)
	} finally {
		cleanup()
	}
})

test('an unreadable transcript claims nothing and is not looked up again every tick', async () => {
	const { root, file, cleanup } = claudeRoot()
	try {
		writeFileSync(file, lines(bashStart('bperm0001')))
		chmodSync(file, 0o000)
		const tail = new ClaudeTranscriptTail([root])
		assert.equal(await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 }), undefined)
		chmodSync(file, 0o600)
		assert.equal(await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 + 1_000 }), undefined)
		assert.equal((await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 + 61_000 }))?.shells, 1)
	} finally {
		chmodSync(file, 0o600)
		cleanup()
	}
})

test('the tail refuses a symlinked transcript', async () => {
	const { root, file, cleanup } = claudeRoot()
	try {
		const real = join(root, 'outside.jsonl')
		writeFileSync(real, lines(bashStart('blink0001')))
		symlinkSync(real, file)
		const tail = new ClaudeTranscriptTail([root])
		assert.equal(await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 }), undefined)
	} finally {
		cleanup()
	}
})

test('the tail never reads more than its window: a big file starts at its last FIRST_READ_BYTES', async () => {
	const { root, file, cleanup } = claudeRoot()
	try {
		const filler = `${JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) })}\n`
		const pad = filler.repeat(Math.ceil((FIRST_READ_BYTES + 4096) / filler.length))
		// A start before the window is not seen (no claim), one inside it is.
		writeFileSync(file, `${lines(bashStart('bbefore01'))}${pad}${lines(bashStart('binside01'))}`)
		const tail = new ClaudeTranscriptTail([root])
		assert.deepEqual(await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 }), {
			sessionId: SID,
			tasks: 1,
			shells: 1,
		})
		// An append larger than READ_MAX_BYTES starts over from a fresh window: binside01's end
		// is beyond it, so only what the new window shows counts.
		const huge = filler.repeat(Math.ceil((READ_MAX_BYTES + 1024) / filler.length))
		appendFileSync(file, `${lines(enqueue('binside01'))}${huge}${lines(workflowStart('wafter001'))}`)
		assert.deepEqual(await tail.observe(SID, { cwd: CWD, refresh: true, now: T0 }), {
			sessionId: SID,
			tasks: 1,
			shells: 0,
		})
	} finally {
		cleanup()
	}
})

// ---------------------------------------------------------------------------
// Source → reducer → spool / CLI
// ---------------------------------------------------------------------------

const SHOW_IDLE = okenaFixture('show-idle.json')
const STATE_ASK = okenaFixture('state-ask.json')
const TID = SHOW_IDLE.terminal_id as string
const PROFILE = 'okena-profile'

class FakeOkena implements OkenaClaudeClient {
	detail: Json = { ...SHOW_IDLE, session_id: SID, busy: false }
	activeProfileId(): string | null {
		return PROFILE
	}
	forProfile(): OkenaClaudeClient {
		return this
	}
	async getStateJson(): Promise<unknown> {
		return {
			...structuredClone(STATE_ASK),
			claude_sessions: [TID],
			claude_dialogs: {},
			projects: [
				{
					id: 'proj-image',
					name: 'feat/service-protocol-image-link',
					path: CWD,
					layout: { type: 'split', children: [{ type: 'terminal', terminal_id: TID }] },
				},
			],
		}
	}
	async getClaudeSession(): Promise<unknown> {
		return structuredClone(this.detail)
	}
	async getClaudeTranscript(): Promise<unknown> {
		return { session_id: SID, entries: [], cursor: 10, reset: true }
	}
}

test('the Okena source tails every tick while idle, every BACKGROUND_BUSY_READ_MS while busy', async () => {
	const reads: Array<{ sessionId: string; cwd?: string; refresh: boolean }> = []
	const observer: BackgroundTaskObserver = {
		async observe(sessionId, options) {
			reads.push({ sessionId, cwd: options.cwd, refresh: options.refresh })
			return { sessionId, tasks: 1, shells: 1 }
		},
	}
	const okena = new FakeOkena()
	const source = new OkenaClaudeSource(okena, 'okena', observer)
	let state = createAgentDockState(null, T0)
	const tick = async (now: number) => {
		const observation = await source.observe(state, now)
		state = reduce(state, observation, now).state
		return observation
	}
	const first = await tick(T0)
	assert.deepEqual(first.type === 'poll' && first.terminals[0]?.background, { sessionId: SID, tasks: 1, shells: 1 })
	assert.deepEqual(reads.at(-1), { sessionId: SID, cwd: CWD, refresh: true })
	await tick(T0 + 1_500)
	assert.equal(reads.at(-1)?.refresh, true, 'idle: every tick')
	okena.detail = { ...okena.detail, busy: true }
	await tick(T0 + 3_000)
	await tick(T0 + 4_500)
	assert.equal(reads.at(-1)?.refresh, false, 'busy: counts kept, no read')
	await tick(T0 + 3_000 + BACKGROUND_BUSY_READ_MS)
	assert.equal(reads.at(-1)?.refresh, true, 'busy: read again after BACKGROUND_BUSY_READ_MS')
	okena.detail = { ...okena.detail, busy: false }
	await tick(T0 + 20_000)
	const session = agentDockSnapshot(state, T0 + 20_000).sessions[0]
	assert.equal(session?.status, 'background')
	assert.equal(session?.backgroundShells, 1)

	// An observer that throws claims nothing; a source without one (Helm's hub) never tails.
	const broken = new OkenaClaudeSource(new FakeOkena(), 'okena', {
		observe: async () => {
			throw new Error('EACCES')
		},
	})
	const quiet = await broken.observe(createAgentDockState(null, T0), T0)
	assert.equal(quiet.type === 'poll' && quiet.terminals[0]?.background, undefined)
	const plain = await new OkenaClaudeSource(new FakeOkena(), 'helm').observe(createAgentDockState(null, T0), T0)
	assert.equal(plain.type === 'poll' && 'background' in (plain.terminals[0] ?? {}), false)
})

test('the spool keeps background counts only while some run; the CLI words them like the pane', () => {
	const okena = new FakeOkena()
	const at = T0
	const poll = (background?: Json) => ({
		type: 'poll' as const,
		source: 'okena' as const,
		profile: PROFILE,
		state: {
			ok: true as const,
			body: {
				...structuredClone(STATE_ASK),
				claude_sessions: [TID],
				claude_dialogs: {},
				projects: [
					{ id: 'p', name: 'p', layout: { type: 'split', children: [{ type: 'terminal', terminal_id: TID }] } },
				],
			},
		},
		terminals: [
			{
				terminalId: TID,
				detail: { ok: true as const, body: okena.detail },
				...(background ? { background: background as { sessionId: string; tasks: number; shells: number } } : {}),
			},
		],
	})
	const running = reduce(createAgentDockState(null, at), poll({ sessionId: SID, tasks: 2, shells: 2 }), at).state
	const spool = dockSpoolSnapshot(agentDockSnapshot(running, at), [], at, 1)
	assert.equal(spool.sessions[0]?.status, 'background')
	assert.equal(spool.sessions[0]?.backgroundTasks, 2)
	assert.equal(spool.sessions[0]?.backgroundShells, 2)
	const none = reduce(createAgentDockState(null, at), poll(), at).state
	const quiet = dockSpoolSnapshot(agentDockSnapshot(none, at), [], at, 1)
	assert.equal('backgroundTasks' in (quiet.sessions[0] ?? {}), false)

	assert.equal(backgroundChip(0, 0), '')
	assert.equal(backgroundChip(1, 1), '1 shell')
	assert.equal(backgroundChip(2, 2), '2 shells')
	assert.equal(backgroundChip(3, 1), '3 bg tasks')
	assert.equal(backgroundChip(1, 0), '1 bg task')
})
