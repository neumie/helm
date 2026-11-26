import assert from 'node:assert/strict'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import {
	parseRunResultComment,
	runResultComment,
	runSessionLines,
	runStartComment,
} from '../src/github/item-issue-text.js'
import { agentSessionSupport, createAgentAdapter } from '../src/solver/agent-adapter.js'
import { solverResultSchema } from '../src/solver/result-schema.js'

const id = '0b6f1c2e-6a1d-4c3e-9f7a-2b8d9e0f1a2b'
const home = '/Users/jakub'

function solver(agent: 'claude' | 'codex' | 'pi'): HelmConfig['solver'] {
	return { agent, timeoutMinutes: 30 } as HelmConfig['solver']
}

test('Claude Code and Pi runs take a Helm-assigned session ID; Codex cannot', () => {
	assert.deepEqual(createAgentAdapter(solver('claude')).buildHeadlessInvocation(undefined, id).args.slice(0, 6), [
		'-p',
		'--output-format',
		'json',
		'--dangerously-skip-permissions',
		'--session-id',
		id,
	])
	assert.deepEqual(createAgentAdapter(solver('pi')).buildHeadlessInvocation('high', id).args, [
		'--mode',
		'json',
		'--session-id',
		id,
		'--approve',
		'--thinking',
		'high',
	])
	assert.ok(!createAgentAdapter(solver('codex')).buildHeadlessInvocation(undefined, id).args.includes(id))
	assert.ok(!createAgentAdapter(solver('claude')).buildHeadlessInvocation().args.includes('--session-id'))

	assert.match(
		createAgentAdapter(solver('claude')).buildInteractiveCommand('.helm-prompt.txt', '/wt', undefined, id),
		new RegExp(`^cd '/wt' && 'claude' '--dangerously-skip-permissions' '--session-id' '${id}' `),
	)
	assert.match(
		createAgentAdapter(solver('pi')).buildInteractiveCommand('.helm-prompt.txt', '/wt', undefined, id),
		new RegExp(`'pi' '--session-id' '${id}' '--approve'`),
	)
	assert.ok(
		!createAgentAdapter(solver('codex')).buildInteractiveCommand('.helm-prompt.txt', '/wt', undefined, id).includes(id),
	)
	assert.throws(() => createAgentAdapter(solver('claude')).buildHeadlessInvocation(undefined, 'x y'))

	assert.equal(agentSessionSupport('claude').assignable, true)
	assert.equal(agentSessionSupport('pi').assignable, true)
	assert.equal(agentSessionSupport('codex').assignable, false)
})

test('a bad sessionId in the result JSON is dropped, never fails the result', () => {
	assert.equal(solverResultSchema.parse({ summary: 's', sessionId: ` ${id} ` }).sessionId, id)
	assert.equal(solverResultSchema.parse({ summary: 's', sessionId: 'not an id`' }).sessionId, undefined)
	assert.equal(solverResultSchema.parse({ summary: 's', sessionId: null }).sessionId, undefined)
	assert.equal(solverResultSchema.parse({ summary: 's', sessionId: '' }).sessionId, undefined)
	assert.equal(solverResultSchema.parse({ summary: 's' }).sessionId, undefined)
})

test('session lines name the agent, the session and how to resume it from the run directory', () => {
	assert.deepEqual(runSessionLines({ agent: 'claude', id, directory: `${home}/code/app-wt/fix-x` }, home), [
		`**Session:** Claude Code \`${id}\`  `,
		`**Resume:** \`cd ~/code/app-wt/fix-x && claude --resume ${id}\``,
	])
	assert.equal(
		runSessionLines({ agent: 'pi', id, directory: `${home}/code/my app/` }, home)[1],
		`**Resume:** \`cd ~/'code/my app' && pi --session ${id}\``,
	)
	assert.equal(
		runSessionLines({ agent: 'codex', id, directory: '/srv/app' }, home)[1],
		`**Resume:** \`cd /srv/app && codex resume ${id}\``,
	)
	assert.equal(
		runSessionLines({ agent: 'claude', id, directory: home }, home)[1],
		`**Resume:** \`cd ~ && claude --resume ${id}\``,
	)
	// A home prefix that is only a name prefix is not home.
	assert.equal(
		runSessionLines({ agent: 'claude', id, directory: `${home}2/app` }, home)[1],
		`**Resume:** \`cd /Users/jakub2/app && claude --resume ${id}\``,
	)
	// A directory that cannot sit in a code span (or is not absolute) is left out, not mangled.
	assert.equal(
		runSessionLines({ agent: 'claude', id, directory: '/tmp/a`b' }, home)[1],
		`**Resume:** \`claude --resume ${id}\``,
	)
	assert.equal(
		runSessionLines({ agent: 'claude', id, directory: 'rel/dir' }, home)[1],
		`**Resume:** \`claude --resume ${id}\``,
	)
	// Unknown agents, malformed IDs and missing sessions give no lines at all.
	assert.deepEqual(runSessionLines({ agent: 'gemini', id }, home), [])
	assert.deepEqual(runSessionLines({ agent: 'claude', id: 'x`y' }, home), [])
	assert.deepEqual(runSessionLines(null, home), [])
})

test('start and result comments carry the session; without one the lines are left out', () => {
	const session = { agent: 'claude', id, directory: `${home}/wt` }
	const start = runStartComment(
		{ attempt: 1, agent: 'claude', model: null, workspace: 'worktree', branchName: 'fix/x', session },
		home,
	)
	assert.equal(
		start,
		[
			'**Helm** started run 1 (agent claude, worktree, branch `fix/x`).',
			'',
			`**Session:** Claude Code \`${id}\`  `,
			`**Resume:** \`cd ~/wt && claude --resume ${id}\``,
		].join('\n'),
	)
	assert.equal(
		runStartComment({ attempt: 1, agent: 'codex', workspace: 'main', session: null }, home),
		'**Helm** started run 1 (agent codex, main checkout).',
	)

	const result = { v: 1 as const, itemId: 'i', attempt: 1, summary: 'Done', filesChanged: [], finishedAt: 'now' }
	const withSession = runResultComment(result, session, home)
	assert.ok(withSession.includes(`**Resume:** \`cd ~/wt && claude --resume ${id}\``))
	assert.deepEqual(parseRunResultComment(withSession)?.session, { agent: 'claude', id })
	assert.ok(!withSession.includes(home), 'the home directory never reaches GitHub')
	const without = runResultComment(result, null, home)
	assert.ok(!without.includes('**Session:**'))
	assert.equal(parseRunResultComment(without)?.session, undefined)
})
