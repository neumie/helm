// Golden hook outputs for Helm's PermissionRequest decisions. The expected JSON
// is what the Claude Code 2.1.316 spikes printed and saw take effect (s0-dialogs
// a1 answer, c3 ExitPlanMode allow + setMode, b-runs Bash allow/deny).
import assert from 'node:assert/strict'
import test from 'node:test'
import decisionModule from '../app/src/claude-remote/decision.ts'

type DecisionModule = typeof import('../app/src/claude-remote/decision.ts')
const { hookDecisionOutput, sessionRules, DEFAULT_DENY_MESSAGE, CANCELLED_OUTPUT } = decisionModule as DecisionModule

const QUESTIONS = {
	questions: [
		{
			question: 'Which color?',
			header: 'Color',
			options: [
				{ label: 'Red', description: 'Choose red' },
				{ label: 'Blue', description: 'Choose blue' },
			],
			multiSelect: false,
		},
	],
}
const PLAN = {
	plan: '# Plan: create hello3.txt\n\nCreate `hello3.txt` in the project root (`proj-c`) containing the word `hi`.\n',
	planFilePath: '/Users/x/.claude/plans/task-create-file-hello3-txt-velvet-glacier.md',
}

test('AskUserQuestion answer: original questions plus answers keyed by question text (spike a1)', () => {
	const result = hookDecisionOutput(
		{ toolName: 'AskUserQuestion', toolInput: QUESTIONS, suggestions: [] },
		{ decision: 'answer', answers: { 'Which color?': 'Blue' } },
	)
	assert.deepEqual(result, {
		ok: true,
		output: {
			hookSpecificOutput: {
				hookEventName: 'PermissionRequest',
				decision: {
					behavior: 'allow',
					updatedInput: { ...QUESTIONS, answers: { 'Which color?': 'Blue' } },
				},
			},
		},
	})
})

test('ExitPlanMode approve repeats the plan verbatim; a mode switch rides along as setMode (spike c3)', () => {
	const plain = hookDecisionOutput(
		{ toolName: 'ExitPlanMode', toolInput: PLAN, suggestions: [] },
		{ decision: 'allow', always: false },
	)
	assert.deepEqual(plain, {
		ok: true,
		output: {
			hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: PLAN } },
		},
	})
	const withMode = hookDecisionOutput(
		{ toolName: 'ExitPlanMode', toolInput: PLAN, suggestions: [] },
		{ decision: 'allow', always: false },
		'acceptEdits',
	)
	assert.deepEqual(withMode, {
		ok: true,
		output: {
			hookSpecificOutput: {
				hookEventName: 'PermissionRequest',
				decision: {
					behavior: 'allow',
					updatedInput: PLAN,
					updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
				},
			},
		},
	})
	const always = hookDecisionOutput(
		{ toolName: 'ExitPlanMode', toolInput: PLAN, suggestions: [] },
		{ decision: 'allow', always: true },
	)
	assert.equal(always.ok, false)
})

test('deny carries the message (or a default); the model sees it and the turn continues (spike c3/b)', () => {
	const denied = hookDecisionOutput(
		{ toolName: 'ExitPlanMode', toolInput: PLAN, suggestions: [] },
		{ decision: 'deny', message: 'Rejected remotely: also add a second file bye.txt' },
	)
	assert.deepEqual(denied, {
		ok: true,
		output: {
			hookSpecificOutput: {
				hookEventName: 'PermissionRequest',
				decision: { behavior: 'deny', message: 'Rejected remotely: also add a second file bye.txt' },
			},
		},
	})
	const bare = hookDecisionOutput(
		{ toolName: 'Bash', toolInput: { command: 'ls' }, suggestions: [] },
		{ decision: 'deny' },
	)
	assert.equal(
		bare.ok && (bare.output.hookSpecificOutput as { decision: { message: string } }).decision.message,
		DEFAULT_DENY_MESSAGE,
	)
})

test('Bash allow repeats tool_input; always applies only addRules, every one scoped to the session', () => {
	const input = { command: 'echo three > z.txt', description: 'Write "three" to z.txt' }
	const rule = {
		type: 'addRules',
		rules: [{ toolName: 'Bash', ruleContent: 'echo three:*' }],
		behavior: 'allow',
		destination: 'localSettings',
	}
	const once = hookDecisionOutput(
		{ toolName: 'Bash', toolInput: input, suggestions: [rule] },
		{ decision: 'allow', always: false },
	)
	assert.deepEqual(once, {
		ok: true,
		output: {
			hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: input } },
		},
	})
	const always = hookDecisionOutput(
		{ toolName: 'Bash', toolInput: input, suggestions: [rule] },
		{ decision: 'allow', always: true },
	)
	assert.deepEqual(always, {
		ok: true,
		output: {
			hookSpecificOutput: {
				hookEventName: 'PermissionRequest',
				decision: { behavior: 'allow', updatedInput: input, updatedPermissions: [{ ...rule, destination: 'session' }] },
			},
		},
	})
	// addDirectories did not stop the next prompt in the spike: a list with one is refused, not partly applied.
	const directories = { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' }
	const mixed = hookDecisionOutput(
		{ toolName: 'Bash', toolInput: input, suggestions: [rule, directories] },
		{ decision: 'allow', always: true },
	)
	assert.equal(mixed.ok, false)
	assert.equal(mixed.ok === false && mixed.status, 400)
	const none = hookDecisionOutput(
		{ toolName: 'Bash', toolInput: input, suggestions: [] },
		{ decision: 'allow', always: true },
	)
	assert.equal(none.ok, false)
	assert.deepEqual(sessionRules([rule, directories, 'junk']), [{ ...rule, destination: 'session' }])
})

test('a question never takes allow, a permission never takes answers; cancelled is {}', () => {
	assert.equal(
		hookDecisionOutput(
			{ toolName: 'AskUserQuestion', toolInput: QUESTIONS, suggestions: [] },
			{ decision: 'allow', always: false },
		).ok,
		false,
	)
	assert.equal(
		hookDecisionOutput(
			{ toolName: 'Bash', toolInput: { command: 'ls' }, suggestions: [] },
			{ decision: 'answer', answers: {} },
		).ok,
		false,
	)
	assert.deepEqual(CANCELLED_OUTPUT, {})
})

test('allow on a request without an object tool_input is refused (never rewritten to {})', () => {
	for (const toolInput of [undefined, null, 'rm -rf /', ['x']]) {
		const result = hookDecisionOutput(
			{ toolName: 'Bash', toolInput, suggestions: [] },
			{ decision: 'allow', always: false },
		)
		assert.equal(result.ok, false)
		assert.equal(result.ok ? 0 : result.status, 400)
	}
	// Deny still works: it repeats nothing.
	assert.equal(hookDecisionOutput({ toolName: 'Bash', toolInput: 'x', suggestions: [] }, { decision: 'deny' }).ok, true)
})
