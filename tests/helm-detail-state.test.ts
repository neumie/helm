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

test('review state does not repeat the visible status with instructional copy', () => {
	const review = detailState({ ...base, status: 'review' })
	assert.equal(review.headline, null)
	assert.equal(review.direction, null)
})

test('human-owned Active Items rely on status and work details without filler copy', () => {
	const active = detailState({ ...base, status: 'active', workMode: 'manual' })
	assert.equal(active.headline, null)
	assert.equal(active.direction, null)
	assert.deepEqual(active.sections, ['work'])
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
	assert.deepEqual(lifecycleActionPlan('running', [cancel]), { markDone: false, primary: null, rest: [cancel] })
	assert.equal(lifecycleActionPlan('review', []).markDone, true)
})
