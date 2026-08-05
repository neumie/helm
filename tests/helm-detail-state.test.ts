import assert from 'node:assert/strict'
import test from 'node:test'
import actionModule from '../app/src/renderer/sidebar/detail-actions.ts'
import stateModule from '../app/src/renderer/sidebar/detail-state.ts'
import type { DashboardItem } from '../app/src/shared-helm.ts'

const { detailState } = stateModule as typeof import('../app/src/renderer/sidebar/detail-state.ts')
const { lifecycleActionPlan } = actionModule as typeof import('../app/src/renderer/sidebar/detail-actions.ts')
const base = {
	id: 'x',
	kind: 'solve',
	executionMode: 'solve',
	workMode: null,
	projectSlug: 'p',
	title: 'Task',
	displayName: null,
	assessment: null,
	source: null,
	captured: false,
	baseRef: 'main',
	spawner: null,
	groupId: null,
	group: null,
	branchName: null,
	forkContext: null,
	plan: null,
	planStatus: null,
	resultSummary: null,
	solveInputSnapshot: null,
	solverAgent: null,
	solverModel: null,
	solverWorkspace: null,
	errorMessage: null,
	errorPhase: null,
	runOutcome: null,
	deployState: null,
	card: { state: 'ready', statusLabel: 'Ready', statusTone: 'gray', pulse: false },
	allowedActions: [],
	runObservation: {
		source: 'solve',
		state: 'idle',
		stateLabel: 'Idle',
		summary: null,
		events: [],
		log: { path: null, available: false, content: '', truncated: false },
		pr: { url: null, state: null, merged: null },
		almanac: { runId: null, statusPath: null, status: null, round: null, summary: null, failureReason: null },
	},
	links: { source: null, branch: null, pr: null },
	createdAt: '2026-01-01T00:00:00Z',
	queuedAt: null,
	startedAt: null,
	completedAt: null,
	plannedAt: null,
	updatedAt: '2026-01-01T00:00:00Z',
} as unknown as DashboardItem

const kinds = (sections: Array<{ kind: string }>) => sections.map(section => section.kind)

test('detail state stays focused and does not call cancellation an error', () => {
	const cancelled = detailState({ ...base, status: 'cancelled', errorMessage: 'Cancelled by user' })
	assert.equal(cancelled.attention, null)
	assert.deepEqual(kinds(cancelled.sections), ['failure', 'outcome', 'knowledge', 'activity', 'log', 'input', 'source'])
	assert.deepEqual(kinds(detailState({ ...base, status: 'review', runOutcome: 'no_result' }).sections).slice(0, 3), [
		'outcome',
		'knowledge',
		'delivery',
	])
})

test('run evidence is inline: review orders decision content before the log', () => {
	const review = detailState({ ...base, status: 'review' })
	assert.deepEqual(kinds(review.sections), ['outcome', 'knowledge', 'delivery', 'activity', 'log', 'input', 'source'])
})

test('failed places the always-expanded log directly beneath the failure text', () => {
	const failed = detailState({ ...base, status: 'failed', errorMessage: 'boom' })
	assert.deepEqual(kinds(failed.sections).slice(0, 2), ['failure', 'log'])
})

test('human-owned Active Items keep the compact work sections', () => {
	const active = detailState({ ...base, status: 'active', workMode: 'manual' })
	assert.deepEqual(kinds(active.sections), ['activity', 'log', 'input', 'knowledge', 'source'])
})

test('planned Active Items expose the executor choice', () => {
	const active = detailState({
		...base,
		status: 'active',
		workMode: 'manual',
		plannedAt: '2026-01-02T00:00:00Z',
		planStatus: {
			stage: 'plan_ready',
			specName: 'spec.md',
			localTickets: { total: 0, open: 0, readyForAgent: 0, readyForHuman: 0 },
			githubTickets: { total: 0, open: 0, readyForAgent: 0, readyForHuman: 0 },
			githubAvailable: true,
			checkedAt: '2026-01-02T00:00:00Z',
		},
	})
	assert.deepEqual(kinds(active.sections), ['setup', 'activity', 'log', 'input', 'knowledge', 'source'])
})

test('automatic Inbox Items keep approval content first without a redundant hero sentence', () => {
	const inbox = detailState({
		...base,
		status: 'inbox',
		source: { provider: 'Contember', externalId: 'task-1' },
	})
	assert.deepEqual(kinds(inbox.sections), ['intent', 'setup', 'activity', 'log', 'input', 'knowledge', 'source'])
})

test('run evidence stays reachable after a return to pre-run states', () => {
	// An item moved back to inbox/ready/active after a run keeps its history —
	// the sections self-gate, so pristine items still render nothing for them.
	for (const status of ['inbox', 'ready', 'active'] as const) {
		const state = detailState({ ...base, status })
		for (const kind of ['activity', 'log', 'input']) {
			assert.ok(kinds(state.sections).includes(kind), `${status} keeps ${kind} reachable`)
		}
	}
})

test('danger actions are overflow-only while review owns Set as done', () => {
	const cancel = { id: 'cancel', label: 'Cancel', tone: 'danger' } as const
	assert.deepEqual(lifecycleActionPlan('running', [cancel]), {
		markDone: false,
		completeInOverflow: false,
		primary: null,
		rest: [cancel],
	})
	assert.equal(lifecycleActionPlan('review', []).markDone, true)
})
