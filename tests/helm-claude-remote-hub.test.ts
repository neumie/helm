// Helm's Claude hub: the pure core (fencing, busy table, dialog registry and
// pending lifetime, filters, out-of-order events, exclusion) and the socket hub
// as the dock's OkenaClaudeClient (OkenaClaudeSource + reducer + act unchanged).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import modelModule from '../app/src/agent-dock/model.ts'
import sourceModule from '../app/src/agent-dock/okena-claude-source.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'
import coreModule from '../app/src/claude-remote/hub-core.ts'
import hubModule from '../app/src/claude-remote/hub.ts'
import tokenModule from '../app/src/claude-remote/token.ts'

type CoreModule = typeof import('../app/src/claude-remote/hub-core.ts')
type HubModule = typeof import('../app/src/claude-remote/hub.ts')
type TokenModule = typeof import('../app/src/claude-remote/token.ts')
type SourceModule = typeof import('../app/src/agent-dock/okena-claude-source.ts')
type ReduceModule = typeof import('../app/src/agent-dock/reduce.ts')
type ModelModule = typeof import('../app/src/agent-dock/model.ts')
type TerminalRef = import('../app/src/claude-remote/hub-core.ts').TerminalRef

const { ClaudeHubCore, DIALOG_TRUNCATION_MARK, TYPING_GUARD_MS } = coreModule as CoreModule
const { HelmClaudeHub, interruptMarkerAt, promptChunks, sanitizePrompt } = hubModule as HubModule
const { claudeHubTokens, claudeRemoteTerminalEnvironment } = tokenModule as TokenModule
const { OkenaClaudeSource } = sourceModule as SourceModule
const { TURN_IDLE_MS, createAgentDockState, reduce } = reduceModule as ReduceModule
const { parseOkenaClaudeSession, parseOkenaClaudeTranscriptPage, parseOkenaState } = modelModule as ModelModule

const REF: TerminalRef = { profileId: 'work', terminalId: 'term1' }
const PID = 100
const SID = 'sess-a'
const T0 = 1_800_000_000_000

const hook = () => {
	const outputs: unknown[] = []
	return { outputs, respond: (output: unknown) => outputs.push(output) }
}
const ev = (name: string, extra: Record<string, unknown> = {}) => ({
	hook_event_name: name,
	session_id: SID,
	...extra,
})
const QUESTIONS = {
	questions: [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }],
}
const PLAN = { plan: '# Plan\n\nDo it.', planFilePath: '/p/plan.md' }

function started(core = new ClaudeHubCore({ prefix: 'aa11' })) {
	core.event(REF, PID, T0, ev('SessionStart', { source: 'startup', cwd: '/repo/helm', transcript_path: '/x/t.jsonl' }))
	return core
}
const session = (core: InstanceType<typeof ClaudeHubCore>, ref = REF) => {
	const parsed = parseOkenaClaudeSession(core.session(ref))
	assert.ok(parsed.ok, parsed.ok ? '' : parsed.error)
	return parsed.value
}

// ---------------------------------------------------------------------------
// Core: identity and fencing
// ---------------------------------------------------------------------------

test('views parse with the dock’s own Okena schemas', () => {
	const core = started()
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'hi' }))
	assert.ok(parseOkenaState(core.stateJson('work')).ok)
	assert.ok(parseOkenaClaudeSession(core.session(REF)).ok)
	assert.ok(parseOkenaClaudeTranscriptPage(core.transcript(REF, {})).ok)
	const state = core.stateJson('work') as { claude_sessions: string[]; projects: Array<{ name: string; path: string }> }
	assert.deepEqual(state.claude_sessions, ['term1'])
	assert.deepEqual(
		state.projects.map(project => [project.name, project.path]),
		[['helm', '/repo/helm']],
	)
	assert.deepEqual((core.stateJson('other') as { claude_sessions: string[] }).claude_sessions, [])
})

test('only the primary (pid, session) counts; another process in the terminal is fenced off', () => {
	const core = started()
	core.event(REF, 999, T0 + 1, ev('UserPromptSubmit', { session_id: 'other', prompt_id: 'x', prompt: 'nested' }))
	assert.equal(session(core).busy, false)
	assert.equal(session(core).session_id, SID)
	const stray = hook()
	assert.equal(
		core.permission(
			REF,
			999,
			T0 + 2,
			ev('PermissionRequest', { session_id: 'other', tool_name: 'Bash', tool_input: {} }),
			stray,
		),
		null,
	)
	assert.deepEqual(stray.outputs, [{}], 'answered at once: left to the terminal')
	assert.equal(session(core).dialogs.length, 0)
})

test('/clear: SessionEnd(clear) then SessionStart(clear) under the same pid takes over; old dialogs released', () => {
	const core = started()
	const pending = hook()
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'go' }))
	core.permission(
		REF,
		PID,
		T0 + 2,
		ev('PermissionRequest', { prompt_id: 'p1', tool_name: 'AskUserQuestion', tool_input: QUESTIONS }),
		pending,
	)
	core.event(REF, PID, T0 + 3, ev('SessionEnd', { reason: 'clear' }))
	assert.deepEqual(pending.outputs, [{}])
	assert.deepEqual((core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, [])
	// A late async event of the ended session never brings it back.
	core.event(REF, PID, T0 + 4, ev('Stop', { prompt_id: 'p1', last_assistant_message: 'late' }))
	assert.deepEqual((core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, [])
	core.event(REF, PID, T0 + 5, ev('SessionStart', { session_id: 'sess-b', source: 'clear' }))
	assert.equal(session(core).session_id, 'sess-b')
	assert.equal(session(core).busy, false)
})

test('kill -9 sends nothing; the next SessionStart in the terminal takes over (new pid)', () => {
	const core = started()
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'go' }))
	core.event(REF, 222, T0 + 2, ev('SessionStart', { session_id: 'sess-new', source: 'startup' }))
	assert.equal(session(core).session_id, 'sess-new')
	assert.equal(session(core).busy, false)
	// The killed one is fenced off now.
	core.event(REF, PID, T0 + 3, ev('UserPromptSubmit', { prompt_id: 'p2', prompt: 'ghost' }))
	assert.equal(session(core).busy, false)
})

test('after a hub restart the first event of a live session adopts it (no SessionStart needed)', () => {
	const core = new ClaudeHubCore({ prefix: 'bb22' })
	core.event(REF, PID, T0, ev('PreToolUse', { prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'ls' } }))
	assert.equal(session(core).session_id, SID)
	assert.equal(session(core).busy, true)
	assert.equal(session(core).hooks_attached, true)
})

test('terminal lifecycle: Helm closing the terminal releases its hooks and drops it', () => {
	const core = started()
	const pending = hook()
	core.permission(
		REF,
		PID,
		T0 + 1,
		ev('PermissionRequest', { prompt_id: 'p1', tool_name: 'Bash', tool_input: {} }),
		pending,
	)
	core.terminalClosed(REF)
	assert.deepEqual(pending.outputs, [{}])
	assert.throws(() => core.session(REF), { status: 404 })
})

test('degraded (user --settings): listed, not connected, state unknown; a SessionStart clears it', () => {
	const core = new ClaudeHubCore({ prefix: 'cc33' })
	core.degraded(REF, 300, 'user_settings', '/repo/x', T0)
	assert.deepEqual((core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, ['term1'])
	const view = session(core)
	assert.equal(view.hooks_attached, false)
	assert.equal(view.busy, undefined)
	assert.equal(view.has_transcript, false)
	core.event(REF, 301, T0 + 1, ev('SessionStart', { source: 'startup' }))
	assert.equal(session(core).hooks_attached, true)
})

// ---------------------------------------------------------------------------
// Core: busy table, filters, out-of-order delivery
// ---------------------------------------------------------------------------

test('busy table: prompt/tools busy, Stop idle with the turn text, compact stays busy, SessionEnd unknown', () => {
	const core = started()
	assert.equal(session(core).busy, false, 'SessionStart: idle')
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'do it' }))
	assert.equal(session(core).busy, true)
	core.event(REF, PID, T0 + 2, ev('PostToolUse', { prompt_id: 'p1', tool_name: 'Bash', tool_input: {} }))
	core.event(REF, PID, T0 + 3, ev('Stop', { prompt_id: 'p1', last_assistant_message: 'Done.', background_tasks: [] }))
	assert.equal(session(core).busy, false)
	const page = core.transcript(REF, {}) as { entries: Array<{ kind: string; uuid: string; text: string }> }
	assert.deepEqual(
		page.entries.map(entry => [entry.kind, entry.uuid, entry.text]),
		[
			['user', 'user-p1', 'do it'],
			['assistant', 'assistant-p1', 'Done.'],
		],
	)
	core.event(REF, PID, T0 + 4, ev('UserPromptSubmit', { prompt_id: 'p2', prompt: '/compact' }))
	core.event(REF, PID, T0 + 5, ev('SessionStart', { source: 'compact' }))
	assert.equal(session(core).busy, true, 'compact keeps working')
	core.event(REF, PID, T0 + 6, ev('SessionEnd', { reason: 'prompt_input_exit' }))
	assert.throws(() => core.session(REF), { status: 404 })
})

test('StopFailure is an error turn', () => {
	const core = started()
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'x' }))
	core.event(
		REF,
		PID,
		T0 + 2,
		ev('StopFailure', { prompt_id: 'p1', error: 'rate_limit', last_assistant_message: 'API Error: 429' }),
	)
	assert.equal(session(core).busy, false)
	const page = core.transcript(REF, {}) as { entries: Array<{ text: string }> }
	assert.equal(page.entries.at(-1)?.text, 'API error: API Error: 429')
})

test('out of order: a stopped prompt never makes the terminal busy again; an old Stop never idles a newer prompt', () => {
	const core = started()
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'one' }))
	core.event(REF, PID, T0 + 2, ev('Stop', { prompt_id: 'p1', last_assistant_message: 'ok' }))
	core.event(REF, PID, T0 + 3, ev('PostToolUse', { prompt_id: 'p1', tool_name: 'Bash', tool_input: {} }))
	core.event(REF, PID, T0 + 4, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'one' }))
	assert.equal(session(core).busy, false)
	core.event(REF, PID, T0 + 5, ev('UserPromptSubmit', { prompt_id: 'p3', prompt: 'three' }))
	core.event(REF, PID, T0 + 6, ev('Stop', { prompt_id: 'p2', last_assistant_message: 'late two' }))
	assert.equal(session(core).busy, true)
	core.event(REF, PID, T0 + 7, ev('Stop', { prompt_id: 'p3', last_assistant_message: 'three done' }))
	assert.equal(session(core).busy, false)
})

test('filters: internal-fork SubagentStop and <task-notification> prompts; real subagents and background tasks show', () => {
	const core = started()
	core.event(REF, PID, T0 + 1, ev('SubagentStop', { prompt_id: 'p1', agent_id: 'f1', agent_type: '' }))
	core.event(REF, PID, T0 + 2, ev('SubagentStart', { prompt_id: 'p1', agent_id: 'g1', agent_type: 'general-purpose' }))
	assert.deepEqual(session(core).running_subagents, [{ agent_id: 'g1', agent_type: 'general-purpose' }])
	core.event(REF, PID, T0 + 3, ev('SubagentStop', { prompt_id: 'p1', agent_id: 'g1', agent_type: 'general-purpose' }))
	assert.deepEqual(session(core).running_subagents, [])
	core.event(
		REF,
		PID,
		T0 + 4,
		ev('Stop', { prompt_id: 'p1', last_assistant_message: 'waiting on bg', background_tasks: [{ id: 'b1' }] }),
	)
	assert.equal(session(core).running_subagents.length, 1, 'Stop while a background task runs')
	core.event(
		REF,
		PID,
		T0 + 5,
		ev('UserPromptSubmit', { prompt_id: 'p2', prompt: '<task-notification>\n<task-id>b1</task-id>' }),
	)
	assert.equal(session(core).busy, true, 'the wake makes it work')
	const page = core.transcript(REF, {}) as { entries: Array<{ kind: string }> }
	assert.deepEqual(
		page.entries.map(entry => entry.kind),
		['assistant'],
		'but it is no reply',
	)
})

test('transcript page: reset first, continuation by cursor, reset again for another session', () => {
	const core = started()
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'a' }))
	const first = core.transcript(REF, {}) as { cursor: number; reset: boolean; entries: unknown[] }
	assert.equal(first.reset, true)
	core.event(REF, PID, T0 + 2, ev('Stop', { prompt_id: 'p1', last_assistant_message: 'b' }))
	const next = core.transcript(REF, { cursor: first.cursor, sessionId: SID }) as {
		reset: boolean
		entries: Array<{ text: string }>
	}
	assert.equal(next.reset, false)
	assert.deepEqual(
		next.entries.map(entry => entry.text),
		['b'],
	)
	assert.equal((core.transcript(REF, { cursor: first.cursor, sessionId: 'other' }) as { reset: boolean }).reset, true)
})

test('interrupt markers idle a busy terminal only when written after its active prompt', () => {
	const core = started()
	core.event(REF, PID, T0 + 10_000, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'long task' }))
	core.interrupted(REF, SID, T0 + 5_000)
	assert.equal(session(core).busy, true, 'a marker of an earlier prompt')
	core.interrupted(REF, 'other-session', T0 + 20_000)
	assert.equal(session(core).busy, true)
	core.interrupted(REF, SID, T0 + 20_000)
	assert.equal(session(core).busy, false)
	// Late async events of the interrupted prompt do not bring busy back.
	core.event(REF, PID, T0 + 20_001, ev('PostToolUse', { prompt_id: 'p1', tool_name: 'Bash', tool_input: {} }))
	assert.equal(session(core).busy, false)
})

// ---------------------------------------------------------------------------
// Core: dialogs and the waiting hooks
// ---------------------------------------------------------------------------

function withDialog(toolName: string, toolInput: unknown, extra: Record<string, unknown> = {}) {
	const core = started()
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'go' }))
	const pending = hook()
	const id = core.permission(
		REF,
		PID,
		T0 + 2,
		ev('PermissionRequest', { prompt_id: 'p1', tool_name: toolName, tool_input: toolInput, ...extra }),
		pending,
	)
	assert.ok(id)
	return { core, pending, id: id as string }
}

test('a PermissionRequest is an Okena-shaped dialog with a prefixed id and its suggestions', () => {
	const rule = {
		type: 'addRules',
		rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
		behavior: 'allow',
		destination: 'localSettings',
	}
	const { core, id } = withDialog('Bash', { command: 'ls' }, { permission_suggestions: [rule] })
	assert.match(id, /^aa11-\d+$/)
	const view = session(core)
	assert.deepEqual(view.dialogs, [
		{ id, tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [rule], created_at_ms: T0 + 2 },
	])
	assert.deepEqual((core.stateJson('work') as { claude_dialogs: Record<string, number> }).claude_dialogs, { term1: 1 })
})

test('the terminal decided: the PostToolUse of the same call releases the hook with {} (PreToolUse does not)', () => {
	const bash = withDialog('Bash', { command: 'touch a' })
	bash.core.event(
		REF,
		PID,
		T0 + 3,
		ev('PreToolUse', { prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'touch a' } }),
	)
	assert.equal(session(bash.core).dialogs.length, 1, 'PreToolUse runs before the permission check')
	bash.core.event(
		REF,
		PID,
		T0 + 4,
		ev('PostToolUse', { prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'touch b' } }),
	)
	assert.equal(session(bash.core).dialogs.length, 1, 'another call')
	bash.core.event(
		REF,
		PID,
		T0 + 5,
		ev('PostToolUseFailure', { prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'touch a' } }),
	)
	assert.equal(session(bash.core).dialogs.length, 0)
	assert.deepEqual(bash.pending.outputs, [{}])

	// AskUserQuestion's PostToolUse carries the answers too; ExitPlanMode's an empty input.
	const ask = withDialog('AskUserQuestion', QUESTIONS)
	ask.core.event(
		REF,
		PID,
		T0 + 3,
		ev('PostToolUse', {
			prompt_id: 'p1',
			tool_name: 'AskUserQuestion',
			tool_input: { ...QUESTIONS, answers: { 'Which color?': 'Red' } },
		}),
	)
	assert.deepEqual(ask.pending.outputs, [{}])
	const plan = withDialog('ExitPlanMode', PLAN)
	plan.core.event(REF, PID, T0 + 3, ev('PostToolUse', { prompt_id: 'p1', tool_name: 'ExitPlanMode', tool_input: {} }))
	assert.deepEqual(plan.pending.outputs, [{}])
})

test('Stop or a new prompt releases main-agent dialogs; a background subagent’s dialog stays and keeps the agent idle', () => {
	const stop = withDialog('Bash', { command: 'x' })
	stop.core.event(REF, PID, T0 + 3, ev('Stop', { prompt_id: 'p1', last_assistant_message: 'ok' }))
	assert.deepEqual(stop.pending.outputs, [{}])
	const next = withDialog('Bash', { command: 'x' })
	next.core.event(REF, PID, T0 + 3, ev('UserPromptSubmit', { prompt_id: 'p2', prompt: 'never mind' }))
	assert.deepEqual(next.pending.outputs, [{}])

	const core = started()
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'go' }))
	core.event(REF, PID, T0 + 2, ev('Stop', { prompt_id: 'p1', last_assistant_message: 'bg running' }))
	const bg = hook()
	core.permission(
		REF,
		PID,
		T0 + 3,
		ev('PermissionRequest', { prompt_id: 'p1', agent_id: 'g1', tool_name: 'Bash', tool_input: {} }),
		bg,
	)
	const view = session(core)
	assert.equal(view.dialogs.length, 1)
	assert.equal(view.busy, false)
	assert.deepEqual(bg.outputs, [])
})

test('cancelled hook (terminal No/Esc) and dropped connection remove the dialog without answering', () => {
	const { core, pending, id } = withDialog('Bash', { command: 'x' })
	core.hookGone(REF, id)
	assert.equal(session(core).dialogs.length, 0)
	assert.deepEqual(pending.outputs, [])
})

test('decide encodes the dock decision for the waiting hook; unknown dialog is 404, wrong kind 400', () => {
	const { core, pending, id } = withDialog('AskUserQuestion', QUESTIONS)
	assert.throws(() => core.decide(REF, id, { decision: 'allow', always: false }), { status: 400 })
	core.decide(REF, id, { decision: 'answer', answers: { 'Which color?': 'Blue' } })
	assert.deepEqual(pending.outputs, [
		{
			hookSpecificOutput: {
				hookEventName: 'PermissionRequest',
				decision: { behavior: 'allow', updatedInput: { ...QUESTIONS, answers: { 'Which color?': 'Blue' } } },
			},
		},
	])
	assert.equal(session(core).dialogs.length, 0)
	assert.throws(() => core.decide(REF, id, { decision: 'deny' }), { status: 404 })
})

test('approving a plan from the dock also switches the session to acceptEdits; keep planning and other allows do not', () => {
	const plan = withDialog('ExitPlanMode', PLAN)
	plan.core.decide(REF, plan.id, { decision: 'allow', always: false })
	assert.deepEqual(plan.pending.outputs, [
		{
			hookSpecificOutput: {
				hookEventName: 'PermissionRequest',
				decision: {
					behavior: 'allow',
					updatedInput: PLAN,
					updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
				},
			},
		},
	])
	const keep = withDialog('ExitPlanMode', PLAN)
	keep.core.decide(REF, keep.id, { decision: 'deny', message: 'smaller steps' })
	assert.deepEqual(keep.pending.outputs, [
		{
			hookSpecificOutput: {
				hookEventName: 'PermissionRequest',
				decision: { behavior: 'deny', message: 'smaller steps' },
			},
		},
	])
	const bash = withDialog('Bash', { command: 'ls' })
	bash.core.decide(REF, bash.id, { decision: 'allow', always: false })
	assert.deepEqual(bash.pending.outputs, [
		{
			hookSpecificOutput: {
				hookEventName: 'PermissionRequest',
				decision: { behavior: 'allow', updatedInput: { command: 'ls' } },
			},
		},
	])
})

test('long strings are cut and marked in the dialog view; the decision still repeats the full input', () => {
	const content = `x${'é'.repeat(20_000)}`
	const { core, pending, id } = withDialog('Write', { file_path: '/a', content })
	const shown = (session(core).dialogs[0]?.tool_input as { content: string }).content
	assert.ok(shown.endsWith(DIALOG_TRUNCATION_MARK))
	assert.ok(content.startsWith(shown.slice(0, -DIALOG_TRUNCATION_MARK.length)))
	core.decide(REF, id, { decision: 'allow', always: false })
	const decision = (pending.outputs[0] as { hookSpecificOutput: { decision: { updatedInput: { content: string } } } })
		.hookSpecificOutput.decision
	assert.equal(decision.updatedInput.content, content)
})

test('prompt gate: idle with no dialog only; a typed reply blocks another until its UserPromptSubmit', () => {
	const core = started()
	// No lifeline from claude's preload: the pty may hold a bare shell.
	assert.throws(() => core.checkPrompt(REF, T0), /not connected to Helm/)
	core.attached(REF, PID)
	core.checkPrompt(REF, T0)
	core.typed(REF, T0)
	assert.throws(() => core.checkPrompt(REF, T0 + 1), { status: 409 })
	core.checkPrompt(REF, T0 + TYPING_GUARD_MS + 1)
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'reply' }))
	assert.throws(() => core.checkPrompt(REF, T0 + 2), /not idle/)
	const asked = withDialog('Bash', { command: 'x' })
	asked.core.attached(REF, PID)
	assert.throws(() => asked.core.checkPrompt(REF, T0 + 3), /open dialog/)
})

test('lifeline: claude killed (-9, crash, /exit) closes it; the session ends, dialogs go back, a reply is refused', () => {
	const core = started()
	core.attached(REF, PID)
	core.attached(REF, 999) // another claude's (e.g. a forged one from a tool child): not the primary
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'go' }))
	const pending = hook()
	core.permission(
		REF,
		PID,
		T0 + 2,
		ev('PermissionRequest', { prompt_id: 'p1', tool_name: 'Bash', tool_input: {} }),
		pending,
	)
	core.detached(REF, 999)
	assert.equal(session(core).dialogs.length, 1, 'only the primary pid’s lifeline counts')
	core.detached(REF, PID)
	assert.deepEqual(pending.outputs, [{}])
	assert.deepEqual((core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, [])
	assert.throws(() => core.checkPrompt(REF, T0 + 3), { status: 404 })
	// Late async hooks of the dead session never revive it.
	core.event(REF, PID, T0 + 4, ev('Stop', { prompt_id: 'p1', last_assistant_message: 'late' }))
	assert.deepEqual((core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, [])
	// A reconnect overlapping the old close (count 2 → 1) keeps the session.
	const again = started(new ClaudeHubCore({ prefix: 'ee55' }))
	again.attached(REF, PID)
	again.attached(REF, PID)
	again.detached(REF, PID)
	again.checkPrompt(REF, T0 + 5)
})

test('degraded from a tool child cannot knock out a primary whose claude still runs', () => {
	const core = started()
	core.attached(REF, PID)
	core.degraded(REF, 555, 'user_settings', '/elsewhere', T0 + 1)
	assert.equal(session(core).session_id, SID)
	assert.equal(session(core).hooks_attached, true)
})

test('adopted after a hub restart: cwd and transcript_path come from the first hook payload', () => {
	const core = new ClaudeHubCore({ prefix: 'ff66' })
	core.event(
		REF,
		PID,
		T0,
		ev('PreToolUse', { prompt_id: 'p1', tool_name: 'Bash', cwd: '/repo/app', transcript_path: '/x/t.jsonl' }),
	)
	const state = core.stateJson('work') as { projects: Array<{ name: string; path: string }> }
	assert.deepEqual(
		state.projects.map(project => [project.name, project.path]),
		[['app', '/repo/app']],
	)
	assert.deepEqual(
		core.busyTranscripts().map(entry => entry.path),
		['/x/t.jsonl'],
	)
	// Adopted with neither: the next payload backfills them.
	const bare = new ClaudeHubCore({ prefix: 'ff67' })
	bare.event(REF, PID, T0, ev('PreToolUse', { prompt_id: 'p1' }))
	bare.event(REF, PID, T0 + 1, ev('PostToolUse', { prompt_id: 'p1', cwd: '/repo/b', transcript_path: '/x/b.jsonl' }))
	assert.deepEqual(
		bare.busyTranscripts().map(entry => entry.path),
		['/x/b.jsonl'],
	)
})

test('Stop before its UserPromptSubmit: the user entry still lands BEFORE the answer (reset page), typing guard cleared', () => {
	const core = started()
	core.attached(REF, PID)
	core.event(REF, PID, T0 + 1, ev('UserPromptSubmit', { prompt_id: 'p0', prompt: 'first' }))
	core.event(REF, PID, T0 + 2, ev('Stop', { prompt_id: 'p0', last_assistant_message: 'one' }))
	const before = core.transcript(REF, {}) as { cursor: number }
	core.typed(REF, T0 + 3)
	core.event(REF, PID, T0 + 5, ev('Stop', { prompt_id: 'p1', last_assistant_message: 'two' }))
	core.event(REF, PID, T0 + 4, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'reply' }))
	const page = core.transcript(REF, { cursor: before.cursor, sessionId: SID }) as {
		reset: boolean
		entries: Array<{ kind: string; text: string }>
	}
	assert.equal(page.reset, true, 'renumbered: readers re-read the page')
	assert.deepEqual(
		page.entries.map(entry => `${entry.kind}:${entry.text}`),
		['user:first', 'assistant:one', 'user:reply', 'assistant:two'],
	)
	assert.equal(session(core).busy, false, 'a stopped prompt is not busy again')
	core.checkPrompt(REF, T0 + 6) // the typing guard went with the UserPromptSubmit
	// A replayed UserPromptSubmit adds nothing.
	core.event(REF, PID, T0 + 7, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'reply' }))
	assert.equal((core.transcript(REF, {}) as { entries: unknown[] }).entries.length, 4)
})

test('a very late UserPromptSubmit does not release a newer prompt’s dialog', () => {
	const core = started()
	const newer = hook()
	core.permission(
		REF,
		PID,
		T0 + 10,
		ev('PermissionRequest', { prompt_id: 'p2', tool_name: 'Bash', tool_input: { command: 'x' } }),
		newer,
	)
	core.event(REF, PID, T0 + 5, ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'old' }))
	assert.deepEqual(newer.outputs, [])
	assert.equal(session(core).dialogs.length, 1)
})

test('subagents are capped (lost SubagentStops cannot grow the list without bound)', () => {
	const core = started()
	for (let index = 0; index < 100; index++)
		core.event(REF, PID, T0 + index, ev('SubagentStart', { agent_id: `a${index}`, agent_type: 'Explore' }))
	assert.equal(session(core).running_subagents.length, 64)
})

test('PostToolUse with clipped strings still releases the dialog of that call', () => {
	const content = 'y'.repeat(50_000)
	const { core, pending } = withDialog('Write', { file_path: '/a', content })
	core.event(
		REF,
		PID,
		T0 + 9,
		ev('PostToolUse', {
			prompt_id: 'p1',
			tool_name: 'Write',
			tool_input: { file_path: '/a', content: content.slice(0, 4096) },
		}),
	)
	assert.deepEqual(pending.outputs, [{}])
})

// ---------------------------------------------------------------------------
// Core: dispatcher exclusion
// ---------------------------------------------------------------------------

test('the dispatcher’s session is hidden entirely, its dialogs left to the terminal; /clear keeps it hidden', () => {
	const saved: string[][] = []
	const core = started(new ClaudeHubCore({ prefix: 'dd44', onExcludedChange: ids => saved.push(ids) }))
	const before = hook()
	core.permission(
		REF,
		PID,
		T0 + 1,
		ev('PermissionRequest', { prompt_id: 'p1', tool_name: 'AskUserQuestion', tool_input: QUESTIONS }),
		before,
	)
	// Another terminal's token cannot hide this session.
	core.registerDispatcher({ profileId: 'work', terminalId: 'term2' }, SID)
	assert.equal(core.isExcluded(SID), false)
	core.registerDispatcher(REF, 'not-the-primary')
	assert.equal(core.isExcluded('not-the-primary'), false)
	core.registerDispatcher(REF, SID)
	assert.deepEqual(before.outputs, [{}], 'its open dialog goes back to the terminal')
	assert.deepEqual((core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, [])
	assert.throws(() => core.session(REF), { status: 404 })
	const during = hook()
	assert.equal(
		core.permission(
			REF,
			PID,
			T0 + 2,
			ev('PermissionRequest', { prompt_id: 'p2', tool_name: 'Bash', tool_input: {} }),
			during,
		),
		null,
	)
	assert.deepEqual(during.outputs, [{}])
	core.event(REF, PID, T0 + 3, ev('SessionEnd', { reason: 'clear' }))
	core.event(REF, PID, T0 + 4, ev('SessionStart', { session_id: 'sess-cleared', source: 'clear' }))
	assert.deepEqual((core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, [])
	assert.ok(core.isExcluded('sess-cleared'))
	assert.deepEqual(saved.at(-1), [SID, 'sess-cleared'])
	// /resume in the dispatcher (same claude process, any source) keeps it hidden too.
	core.event(REF, PID, T0 + 5, ev('SessionStart', { session_id: 'sess-resumed', source: 'resume' }))
	assert.ok(core.isExcluded('sess-resumed'))
	// A different claude in that terminal is not the dispatcher.
	core.event(REF, PID + 1, T0 + 6, ev('SessionStart', { session_id: 'sess-other', source: 'startup' }))
	assert.deepEqual((core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, ['term1'])
})

test('dispatcher registered before the hub knows its session (hub restart): hidden once adopted', () => {
	const core = new ClaudeHubCore({ prefix: 'dd45' })
	core.registerDispatcher(REF, SID)
	assert.equal(core.isExcluded(SID), false)
	core.event(REF, PID, T0, ev('PreToolUse', { prompt_id: 'p1' }))
	assert.ok(core.isExcluded(SID))
	assert.deepEqual((core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, [])
})

// ---------------------------------------------------------------------------
// Tokens and terminal environment
// ---------------------------------------------------------------------------

test('terminal tokens: minted per (profile, terminal), verified by HMAC, tampering fails', () => {
	const tokens = claudeHubTokens(Buffer.alloc(32, 7))
	const token = tokens.mint(REF)
	assert.match(token, /^v1\.work\.term1\.[A-Za-z0-9_-]+$/)
	assert.deepEqual(tokens.verify(token), REF)
	assert.equal(tokens.verify(token.replace('term1', 'term2')), null)
	assert.equal(claudeHubTokens(Buffer.alloc(32, 8)).verify(token), null)
	assert.equal(tokens.verify('v1.work.term1'), null)
	assert.equal(tokens.verify(42), null)
})

test('terminal environment: Helm preload + socket + token; inherited values dropped; no injection for a spaced path', () => {
	const tokens = claudeHubTokens(Buffer.alloc(32, 7))
	const runtime = {
		socketPath: '/tmp/helm-501/claude-remote.sock',
		preloadPath: '/tmp/helm-501/claude-remote/preload.cjs',
		hookPath: '/tmp/helm-501/claude-remote/hook-client.cjs',
		nodePath: '/opt/homebrew/bin/node',
		tokens,
	}
	const inherited = { PATH: '/bin', HELM_CLAUDE_REMOTE_TOKEN: 'stale', HELM_CLAUDE_REMOTE_SOCKET: '/old' }
	const env = claudeRemoteTerminalEnvironment(inherited, REF, runtime)
	assert.equal(env.BUN_OPTIONS, '--preload=/tmp/helm-501/claude-remote/preload.cjs')
	assert.equal(env.HELM_CLAUDE_REMOTE_SOCKET, runtime.socketPath)
	assert.deepEqual(tokens.verify(env.HELM_CLAUDE_REMOTE_TOKEN), REF)
	assert.equal(env.HELM_CLAUDE_REMOTE_HOOK, runtime.hookPath)
	assert.equal(env.HELM_CLAUDE_REMOTE_NODE, runtime.nodePath)
	const none = claudeRemoteTerminalEnvironment(inherited, null, runtime)
	assert.deepEqual(none, { PATH: '/bin' })
	const spaced = claudeRemoteTerminalEnvironment(inherited, REF, {
		...runtime,
		preloadPath: '/Library/Application Support/p.cjs',
	})
	assert.deepEqual(spaced, { PATH: '/bin' })
})

test('reply bytes: controls stripped, Ctrl-U + bracketed paste, Enter separately; interrupt markers parsed', () => {
	assert.equal(sanitizePrompt('a\u001b[201~b\r\nc\u0007  \n'), 'a[201~b\nc')
	assert.deepEqual(promptChunks('hi'), ['\u0015\u001b[200~hi\u001b[201~', '\r'])
	const at = '2026-11-02T10:00:00.000Z'
	assert.equal(
		interruptMarkerAt(
			JSON.stringify({
				type: 'user',
				timestamp: at,
				message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
			}),
		),
		Date.parse(at),
	)
	assert.equal(
		interruptMarkerAt(
			JSON.stringify({ type: 'user', timestamp: at, message: { content: '[Request interrupted by user]' } }),
		),
		Date.parse(at),
	)
	assert.equal(
		interruptMarkerAt(
			JSON.stringify({ type: 'assistant', timestamp: at, message: { content: '[Request interrupted by user]' } }),
		),
		null,
	)
	assert.equal(
		interruptMarkerAt(
			JSON.stringify({ type: 'user', timestamp: at, message: { content: 'please say [Request interrupted by user]' } }),
		),
		null,
	)
})

// ---------------------------------------------------------------------------
// The socket hub as the dock's client
// ---------------------------------------------------------------------------

function send(socket: string, line: Record<string, unknown>, waitReply = false): Promise<string> {
	return new Promise((resolve, reject) => {
		const conn = createConnection(socket)
		let data = ''
		conn.setEncoding('utf8')
		conn.on('connect', () => conn.write(`${JSON.stringify(line)}\n`))
		conn.on('data', chunk => {
			data += chunk
		})
		conn.on('error', reject)
		conn.on('close', () => resolve(data))
		if (!waitReply) setTimeout(() => conn.end(), 20)
	})
}

async function hubFixture() {
	const dir = mkdtempSync('/tmp/hcr-hub-')
	const tokens = claudeHubTokens(Buffer.alloc(32, 9))
	const delivered: Array<{ ref: TerminalRef; chunks: string[] }> = []
	let now = T0
	const transcripts = join(dir, 'claude')
	mkdirSync(join(transcripts, 'projects'), { recursive: true })
	const hub = new HelmClaudeHub({
		socketPath: join(dir, 'hub.sock'),
		tokens,
		activeProfileId: () => 'work',
		deliver: async (ref, chunks) => {
			delivered.push({ ref, chunks })
			return 'pty'
		},
		ownerFile: join(dir, 'dock', 'claude-remote.json'),
		excludedFile: join(dir, 'excluded.json'),
		transcriptRoots: [transcripts],
		now: () => now,
		log: () => {},
	})
	assert.equal(await hub.start(), true)
	const token = tokens.mint(REF)
	const event = async (input: Record<string, unknown>) => {
		await send(hub.socketPath, { v: 1, t: 'event', token, pid: PID, at: now, input })
		await new Promise(resolve => setTimeout(resolve, 15))
	}
	/** The preload's lifeline for PID: held open until `close()`. */
	const attach = async (pid = PID) => {
		const conn = createConnection(hub.socketPath)
		await new Promise<void>(resolve => conn.on('connect', () => resolve()))
		conn.write(`${JSON.stringify({ v: 1, t: 'attach', token, pid })}\n`)
		await new Promise(resolve => setTimeout(resolve, 15))
		return {
			close: async () => {
				conn.destroy()
				await new Promise(resolve => setTimeout(resolve, 15))
			},
		}
	}
	return {
		dir,
		hub,
		token,
		attach,
		delivered,
		transcripts,
		event,
		setNow: (value: number) => {
			now = value
		},
		cleanup: () => {
			hub.stop()
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

test('socket: a bad token is answered {} (permission) or ignored (event); the owner file is private', async () => {
	const f = await hubFixture()
	try {
		const reply = await send(
			f.hub.socketPath,
			{
				v: 1,
				t: 'permission',
				token: 'v1.work.term1.forgedforgedforged',
				pid: PID,
				input: ev('PermissionRequest', { tool_name: 'Bash' }),
			},
			true,
		)
		assert.deepEqual(JSON.parse(reply), { output: {} })
		await send(f.hub.socketPath, { v: 1, t: 'event', token: 'nope', pid: PID, input: ev('SessionStart') })
		assert.deepEqual((f.hub.core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, [])
		const owner = JSON.parse(readFileSync(join(f.dir, 'dock', 'claude-remote.json'), 'utf8'))
		assert.equal(owner.socket, f.hub.socketPath)
		const denied = JSON.parse(
			await send(
				f.hub.socketPath,
				{ v: 1, t: 'read', owner: 'x'.repeat(32), op: 'session', profile: 'helm:work', terminal: 'term1' },
				true,
			),
		)
		assert.equal(denied.status, 403)
	} finally {
		f.cleanup()
	}
})

test('end to end: AskUserQuestion → dock ask item → act answer reaches the waiting hook; Stop → turn → reply typed', async () => {
	const f = await hubFixture()
	try {
		const source = new OkenaClaudeSource(f.hub, { name: 'Helm', notRunning: 'hub down' })
		let state = createAgentDockState(null, T0)
		const tick = async (at: number) => {
			f.setNow(at)
			const observation = await source.observe(state, at)
			const reduced = reduce(state, { ...observation, source: 'helm' }, at)
			state = reduced.state
			return reduced.events
		}
		await f.event(ev('SessionStart', { source: 'startup', cwd: '/repo/helm' }))
		const lifeline = await f.attach()
		await tick(T0 + 1000)
		assert.equal(state.sources.helm?.health.state, 'ok')
		assert.equal(Object.keys(state.sessions)[0], 'helm:work:term1')

		await f.event(ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'ask me' }))
		const waiting = send(
			f.hub.socketPath,
			{
				v: 1,
				t: 'permission',
				token: f.token,
				pid: PID,
				at: T0 + 1500,
				input: ev('PermissionRequest', { prompt_id: 'p1', tool_name: 'AskUserQuestion', tool_input: QUESTIONS }),
			},
			true,
		)
		await new Promise(resolve => setTimeout(resolve, 30))
		const events = await tick(T0 + 2000)
		const ask = state.items.find(item => item.kind === 'ask')
		assert.ok(ask, JSON.stringify(events))
		assert.deepEqual(ask.fact.kind === 'ask' && ask.fact.input, QUESTIONS)

		const outcome = await source.act({ profile: 'helm:work', terminalId: 'term1' }, ask, {
			type: 'answer',
			picks: [{ options: [1] }],
		})
		assert.deepEqual(outcome, { status: 'sent' })
		const reply = JSON.parse(await waiting)
		assert.deepEqual(reply.output.hookSpecificOutput.decision, {
			behavior: 'allow',
			updatedInput: { ...QUESTIONS, answers: { 'Which color?': 'Blue' } },
		})
		await tick(T0 + 3000)
		assert.equal(state.items.find(item => item.id === ask.id)?.state, 'resolved')

		await f.event(
			ev('PostToolUse', {
				prompt_id: 'p1',
				tool_name: 'AskUserQuestion',
				tool_input: { ...QUESTIONS, answers: { 'Which color?': 'Blue' } },
			}),
		)
		await f.event(ev('Stop', { prompt_id: 'p1', last_assistant_message: 'Blue it is.' }))
		await tick(T0 + 4000)
		await tick(T0 + 4000 + TURN_IDLE_MS)
		const turn = state.items.find(item => item.kind === 'turn' && item.state === 'open')
		assert.ok(turn, 'Stop opened a turn')
		assert.equal(turn.fact.kind === 'turn' && turn.fact.text, 'Blue it is.')

		const sent = await source.act({ profile: 'helm:work', terminalId: 'term1' }, turn, {
			type: 'prompt',
			text: 'thanks',
		})
		assert.deepEqual(sent, { status: 'sent', delivery: 'pty' })
		assert.deepEqual(f.delivered, [{ ref: REF, chunks: ['\u0015\u001b[200~thanks\u001b[201~', '\r'] }])
		// A second reply before the first one's prompt landed is refused (409), never queued.
		const again = await source.act({ profile: 'helm:work', terminalId: 'term1' }, turn, {
			type: 'prompt',
			text: 'again',
		})
		assert.equal(again.status, 'failed')
		assert.match(again.status === 'failed' ? again.detail : '', /^Helm refused the reply \(409\)/)

		// claude killed (-9) in the terminal: its lifeline closes, nothing is typed into the shell left behind.
		await f.event(ev('UserPromptSubmit', { prompt_id: 'p2', prompt: 'thanks' }))
		await f.event(ev('Stop', { prompt_id: 'p2', last_assistant_message: 'Welcome.' }))
		await lifeline.close()
		f.delivered.length = 0
		await assert.rejects(() => f.hub.forProfile('helm:work').postClaudePrompt?.('term1', 'ls') as Promise<unknown>, {
			status: 404,
		})
		assert.deepEqual(f.delivered, [])
	} finally {
		f.cleanup()
	}
})

test('socket: owner read route, dispatcher registration (persisted), degraded notice, interrupt marker from the transcript', async () => {
	const f = await hubFixture()
	try {
		const projects = join(f.transcripts, 'projects')
		const transcript = join(projects, 't.jsonl')
		writeFileSync(transcript, '')
		await f.event(ev('SessionStart', { source: 'startup', transcript_path: transcript }))
		f.setNow(T0 + 10_000)
		await f.event(ev('UserPromptSubmit', { prompt_id: 'p1', prompt: 'work' }))
		const owner = JSON.parse(readFileSync(join(f.dir, 'dock', 'claude-remote.json'), 'utf8')).owner
		const read = JSON.parse(
			await send(
				f.hub.socketPath,
				{ v: 1, t: 'read', owner, op: 'session', profile: 'helm:work', terminal: 'term1' },
				true,
			),
		)
		assert.equal(read.ok, true)
		assert.equal(read.body.busy, true)

		writeFileSync(
			transcript,
			`${JSON.stringify({ type: 'user', timestamp: new Date(T0 + 12_000).toISOString(), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })}\n`,
		)
		await f.hub.getStateJson()
		assert.equal((f.hub.core.session(REF) as { busy?: boolean }).busy, false)

		await send(f.hub.socketPath, { v: 1, t: 'dispatcher', token: f.token, session_id: SID })
		await new Promise(resolve => setTimeout(resolve, 30))
		assert.deepEqual((await f.hub.getStateJson()) as { claude_sessions: string[] }, {
			...(f.hub.core.stateJson('work') as object),
			claude_sessions: [],
		})
		assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'excluded.json'), 'utf8')).sessions, [SID])

		const other: TerminalRef = { profileId: 'work', terminalId: 'term2' }
		const token2 = claudeHubTokens(Buffer.alloc(32, 9)).mint(other)
		await send(f.hub.socketPath, {
			v: 1,
			t: 'degraded',
			token: token2,
			pid: 77,
			reason: 'user_settings',
			cwd: '/repo/y',
		})
		await new Promise(resolve => setTimeout(resolve, 30))
		assert.deepEqual((f.hub.core.stateJson('work') as { claude_sessions: string[] }).claude_sessions, ['term2'])
	} finally {
		f.cleanup()
	}
})

test('socket: a connection without a request line is dropped; Helm quitting leaves waiting hooks unanswered (they reconnect)', async () => {
	const dir = mkdtempSync('/tmp/hcr-hub-')
	const tokens = claudeHubTokens(Buffer.alloc(32, 9))
	const hub = new HelmClaudeHub({
		socketPath: join(dir, 'hub.sock'),
		tokens,
		activeProfileId: () => 'work',
		deliver: async () => 'pty',
		now: () => T0,
		log: () => {},
		firstLineTimeoutMs: 100,
	})
	try {
		assert.equal(await hub.start(), true)
		const stalled = createConnection(hub.socketPath)
		stalled.on('error', () => {})
		const closedAt = await new Promise<number>(resolve => {
			const start = Date.now()
			stalled.on('close', () => resolve(Date.now() - start))
		})
		assert.ok(closedAt < 2_000, `dropped after ${closedAt} ms`)

		const token = tokens.mint(REF)
		await send(hub.socketPath, { v: 1, t: 'event', token, pid: PID, at: T0, input: ev('SessionStart') })
		const waiting = send(
			hub.socketPath,
			{
				v: 1,
				t: 'permission',
				token,
				pid: PID,
				at: T0,
				input: ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x' } }),
			},
			true,
		)
		await new Promise(resolve => setTimeout(resolve, 150))
		assert.equal(session(hub.core).dialogs.length, 1, 'a long-poll outlives the first-line timeout')
		hub.stop()
		assert.equal(await waiting, '', 'closed without an answer: the hook client asks the next hub')
	} finally {
		hub.stop()
		rmSync(dir, { recursive: true, force: true })
	}
})
