// Ported from the deleted tests/web-api.test.ts: the work-bucketing rules are a
// server-contract behavior (which ItemStatus counts as "needs you" / waiting
// work) and now live in helm's sidebar model. helm/package.json has no
// `type: module`, so tsx loads it as CJS — default-import + destructure, same
// pattern as the extension tests (see AGENTS.md directory rules).

import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error -- app modules load as CommonJS objects under the root tsx test runner.
import normalizeHelmModule from '../app/src/normalize-helm.ts'
// @ts-expect-error -- app modules load as CommonJS objects under the root tsx test runner.
import helmModelModule from '../app/src/renderer/sidebar/model.ts'
// @ts-expect-error -- app modules load as CommonJS objects under the root tsx test runner.
import sharedHelmModule from '../app/src/shared-helm.ts'

type HelmModelModule = typeof import('../app/src/renderer/sidebar/model.ts')
type NormalizeHelmModule = typeof import('../app/src/normalize-helm.ts')
type SharedHelmModule = typeof import('../app/src/shared-helm.ts')
const {
	colorForProject,
	groupItemsByProject,
	logMessagesNewestFirst,
	okenaActionLabel,
	partitionWork,
	planStatusLabel,
	statusTone,
} = helmModelModule as HelmModelModule
const { normalizeDashboardItem } = normalizeHelmModule as NormalizeHelmModule
const { ITEM_STATUSES } = sharedHelmModule as SharedHelmModule

type DashboardItem = import('../app/src/shared-helm.ts').DashboardItem

test('run log messages are newest-first and omit blank lines', () => {
	assert.deepEqual(logMessagesNewestFirst('first\n\nsecond\r\nthird\n'), ['third', 'second', 'first'])
	assert.deepEqual(logMessagesNewestFirst(''), [])
})

test('Okena workspace buttons state their effect without a separate caption', () => {
	assert.equal(okenaActionLabel(undefined, 'worktree'), 'Open workspace in Okena')
	assert.equal(okenaActionLabel(undefined, 'main'), 'Open main checkout in Okena')
	assert.equal(
		okenaActionLabel({ state: 'open', label: 'Focus open workspace', detail: '', branchName: 'feat/x' }, 'worktree'),
		'Focus in Okena',
	)
	assert.equal(
		okenaActionLabel({ state: 'remote', label: '', detail: '', branchName: 'feat/x' }, 'worktree'),
		'Fetch branch and create Okena workspace',
	)
})

test('project colors resolve from current and legacy dashboard config', () => {
	assert.equal(colorForProject({ projects: [{ slug: 'jvs', color: '#2a94e5' }] }, 'jvs'), '#2a94e5')
	assert.equal(colorForProject({ projectColors: { jvs: '#940fd2' } }, 'jvs'), '#940fd2')
	assert.equal(colorForProject({ projects: [{ slug: 'jvs' }] }, 'jvs'), null)
})

test('project grouping preserves first-seen project and Item order', () => {
	const grouped = groupItemsByProject([
		{ id: 'j1', projectSlug: 'jvs' } as DashboardItem,
		{ id: 'c1', projectSlug: 'crane' } as DashboardItem,
		{ id: 'j2', projectSlug: 'jvs' } as DashboardItem,
	])
	assert.deepEqual(
		grouped.map(([slug, items]) => [slug, items.map(item => item.id)]),
		[
			['jvs', ['j1', 'j2']],
			['crane', ['c1']],
		],
	)
})

test('planned Item labels show completed ticket progress', () => {
	const item = {
		planStatus: {
			stage: 'tickets_ready',
			specName: 'spec.md',
			localTickets: { total: 3, open: 1, readyForAgent: 1, readyForHuman: 0 },
			githubTickets: { total: 2, open: 1, readyForAgent: 0, readyForHuman: 1 },
			githubAvailable: true,
			checkedAt: '2026-01-01T00:00:00Z',
		},
	} as DashboardItem
	assert.equal(planStatusLabel(item), '3 of 5 tickets complete')
})

test('mixed-version legacy triage Items normalize into Inbox before rendering', () => {
	const legacy = {
		id: 'legacy',
		status: 'triage',
		card: { state: 'triage', statusLabel: 'Triage', statusTone: 'amber', pulse: false },
	} as unknown as DashboardItem
	const normalized = normalizeDashboardItem(legacy)
	assert.equal(normalized.status, 'inbox')
	assert.deepEqual(normalized.card, { state: 'inbox', statusLabel: 'Inbox', statusTone: 'gray', pulse: false })
	assert.deepEqual(
		partitionWork([normalized]).inbox.map(item => item.id),
		['legacy'],
	)
	assert.equal(partitionWork([normalized]).archived.length, 0)
})

test('helm keeps automatic Items in Inbox, not Queue', () => {
	const inboxA = { id: 'u', status: 'inbox' } as DashboardItem
	const ready = { id: 'q', status: 'ready' } as DashboardItem
	const inboxB = { id: 'p', status: 'inbox' } as DashboardItem

	const buckets = partitionWork([inboxA, ready, inboxB])
	assert.deepEqual(buckets.inbox.map(i => i.id).sort(), ['p', 'u'])
	assert.deepEqual(
		buckets.queue.map(i => i.id),
		['q'],
	)
	assert.equal(buckets.archived.length, 0)
})

test('helm routes review + failed to the "needs you" bucket', () => {
	const review = { id: 'r', status: 'review' } as DashboardItem
	const failed = { id: 'f', status: 'failed' } as DashboardItem
	const processing = { id: 'p', status: 'running', workMode: 'agent' } as DashboardItem
	const manual = { id: 'm', status: 'active', workMode: 'manual' } as DashboardItem
	const done = { id: 'd', status: 'done' } as DashboardItem

	const buckets = partitionWork([review, failed, processing, manual, done])
	assert.deepEqual(buckets.needs.map(i => i.id).sort(), ['f', 'r'])
	assert.deepEqual(
		buckets.active.map(i => i.id),
		['p', 'm'],
	)
	assert.deepEqual(
		buckets.archived.map(i => i.id),
		['d'],
	)
})

test('every ItemStatus lands in exactly one work bucket', () => {
	for (const status of ITEM_STATUSES) {
		const buckets = partitionWork([{ id: 'x', status } as DashboardItem])
		const hits = [buckets.needs, buckets.active, buckets.queue, buckets.inbox, buckets.archived].filter(
			bucket => bucket.length === 1,
		)
		assert.equal(hits.length, 1, `status ${status} must land in exactly one bucket`)
	}
})

test('status→tone mapping is the fixed design-system contract', () => {
	assert.equal(statusTone('active'), 'accent')
	assert.equal(statusTone('running'), 'accent')
	assert.equal(statusTone('review'), 'warn')
	assert.equal(statusTone('done'), 'success')
	assert.equal(statusTone('failed'), 'danger')
	assert.equal(statusTone('inbox'), 'neutral')
	assert.equal(statusTone('ready'), 'neutral')
	assert.equal(statusTone('cancelled'), 'neutral')
})
