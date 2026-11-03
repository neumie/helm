import assert from 'node:assert/strict'
import test from 'node:test'
import agentsEntryModule from '../app/src/renderer/agent-dock/agents-entry.ts'

type AgentsEntryModule = typeof import('../app/src/renderer/agent-dock/agents-entry.ts')
type DockSession = import('../app/src/agent-dock/model.ts').DockSession

const { AGENTS_MARKS_MAX, agentsEntryVariant, agentsTally, shownMarks } = agentsEntryModule as AgentsEntryModule

const session = (key: string, status: DockSession['status']): DockSession => ({
	key,
	source: 'okena',
	profile: 'p1',
	terminalId: key,
	project: 'helm',
	name: key,
	status,
	since: 0,
	observedAt: 0,
	subagents: 0,
	queuedPrompts: 0,
	prLinks: [],
	hasTranscript: true,
	hooksAttached: true,
	channelAttached: false,
})

test('agents entry variants are opt-in by name; anything else keeps the current entry', () => {
	assert.equal(agentsEntryVariant('E3'), 'E3')
	assert.equal(agentsEntryVariant(undefined), null)
	assert.equal(agentsEntryVariant('E7'), null)
})

test('agents tally counts states present in the pane order and names them in words', () => {
	const tally = agentsTally(
		[session('a', 'idle'), session('b', 'working'), session('c', 'background'), session('d', 'unknown')],
		'No Claude session',
	)
	assert.equal(tally.total, 4)
	assert.equal(tally.busy, 2)
	assert.deepEqual(
		tally.states.map(state => [state.status, state.count, state.glyph]),
		[
			['working', 1, '✻'],
			['background', 1, '◐'],
			['idle', 1, '·'],
			['unknown', 1, '¿'],
		],
	)
	assert.equal(tally.label, '4 agents: 1 working, 1 in background, 1 idle, 1 unknown. Show agents')
	assert.equal(agentsTally([], 'No Claude session').label, 'No Claude session. Show agents')
	assert.equal(agentsTally([session('a', 'waiting')], '').label, '1 agent: 1 waiting on you. Show agents')
})

test('the glyph tally folds agents past the cap into +N, never hiding one behind a lone +1', () => {
	const marks = Array.from({ length: 9 }, () => 'idle' as const)
	const { shown, rest } = shownMarks(marks)
	assert.equal(shown.length, AGENTS_MARKS_MAX - 1)
	assert.equal(rest.length, 2)
	assert.equal(shownMarks(marks.slice(0, AGENTS_MARKS_MAX)).rest.length, 0)
})
