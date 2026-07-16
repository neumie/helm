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

test('detail state stays focused and does not call cancellation an error', () => {
	const cancelled = detailState({ ...base, status: 'cancelled', errorMessage: 'Cancelled by user' })
	assert.equal(cancelled.headline, 'Work was stopped')
	assert.equal(cancelled.attention, null)
	assert.deepEqual(cancelled.sections, ['failure', 'work'])
	assert.deepEqual(detailState({ ...base, status: 'review', runOutcome: 'no_result' }).sections.slice(0, 2), [
		'outcome',
		'delivery',
	])
})

test('review state leads with the always-present next-step headline (2026-07 hero spec)', () => {
	const review = detailState({ ...base, status: 'review' })
	assert.equal(review.headline, 'Ready for your review')
	assert.equal(review.direction, 'Check the work, then set it as done.')
})

test('human-owned Active Items lead with the ownership headline (2026-07 hero spec)', () => {
	const active = detailState({ ...base, status: 'active', workMode: 'manual' })
	assert.equal(active.headline, "You're working on this")
	assert.equal(active.direction, 'Set it as done when you finish, or return it to the queue.')
	assert.deepEqual(active.sections, ['work'])
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
	assert.equal(active.headline, 'Plan ready')
	assert.equal(active.direction, 'spec.md is ready. No local or GitHub ticket queue was found.')
	assert.deepEqual(active.sections, ['work', 'run-setup'])
})

test('planned Active Items distinguish planning from a ticket queue', () => {
	const planningItem: DashboardItem = {
		...base,
		status: 'active',
		workMode: 'manual',
		plannedAt: '2026-01-02T00:00:00Z',
		planStatus: {
			stage: 'planning',
			specName: null,
			localTickets: { total: 0, open: 0, readyForAgent: 0, readyForHuman: 0 },
			githubTickets: { total: 0, open: 0, readyForAgent: 0, readyForHuman: 0 },
			githubAvailable: true,
			checkedAt: '2026-01-02T00:00:00Z',
		},
	}
	const planning = detailState(planningItem)
	assert.equal(planning.headline, 'Planning')

	const tickets = detailState({
		...planningItem,
		planStatus: {
			stage: 'tickets_ready',
			specName: 'spec.md',
			localTickets: { total: 3, open: 3, readyForAgent: 2, readyForHuman: 1 },
			githubTickets: { total: 0, open: 0, readyForAgent: 0, readyForHuman: 0 },
			githubAvailable: true,
			checkedAt: '2026-01-02T00:00:00Z',
		},
	})
	assert.equal(tickets.headline, '0 of 3 tickets complete')
	assert.equal(tickets.direction, '0 of 3 tickets complete in local. 3 open; 2 agent-ready, 1 human-ready.')
})

test('automatic Inbox Items lead with the approval decision', () => {
	const inbox = detailState({
		...base,
		status: 'inbox',
		source: { provider: 'Contember', externalId: 'task-1' },
	})
	assert.equal(inbox.headline, 'Review the intent')
	assert.equal(inbox.direction, 'Approve to queue this work, or reject it.')
	assert.deepEqual(inbox.sections, ['intent', 'work', 'run-setup'])
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
