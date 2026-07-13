// Ported from the deleted tests/web-api.test.ts: the work-bucketing rules are a
// server-contract behavior (which ItemStatus counts as "needs you" / waiting
// work) and now live in helm's sidebar model. helm/package.json has no
// `type: module`, so tsx loads it as CJS — default-import + destructure, same
// pattern as the extension tests (see AGENTS.md directory rules).

import assert from 'node:assert/strict'
import test from 'node:test'
import helmModelModule from '../app/src/renderer/sidebar/model.ts'
import sharedHelmModule from '../app/src/shared-helm.ts'

type HelmModelModule = typeof import('../app/src/renderer/sidebar/model.ts')
type SharedHelmModule = typeof import('../app/src/shared-helm.ts')
const { partitionWork, statusTone } = helmModelModule as HelmModelModule
const { ITEM_STATUSES } = sharedHelmModule as SharedHelmModule

type DashboardItem = import('../app/src/shared-helm.ts').DashboardItem

test('helm keeps triage Items in the triage bucket, not queue', () => {
	const triagedA = { id: 'u', status: 'triage' } as DashboardItem
	const ready = { id: 'q', status: 'ready' } as DashboardItem
	const triagedB = { id: 'p', status: 'triage' } as DashboardItem

	const buckets = partitionWork([triagedA, ready, triagedB])
	assert.deepEqual(buckets.triage.map(i => i.id).sort(), ['p', 'u'])
	assert.deepEqual(
		buckets.queue.map(i => i.id),
		['q'],
	)
	assert.equal(buckets.archived.length, 0)
})

test('helm routes review + failed to the "needs you" bucket', () => {
	const review = { id: 'r', status: 'review' } as DashboardItem
	const failed = { id: 'f', status: 'failed' } as DashboardItem
	const processing = { id: 'p', status: 'running' } as DashboardItem
	const done = { id: 'd', status: 'done' } as DashboardItem

	const buckets = partitionWork([review, failed, processing, done])
	assert.deepEqual(buckets.needs.map(i => i.id).sort(), ['f', 'r'])
	assert.deepEqual(
		buckets.active.map(i => i.id),
		['p'],
	)
	assert.deepEqual(
		buckets.archived.map(i => i.id),
		['d'],
	)
})

test('every ItemStatus lands in exactly one work bucket', () => {
	for (const status of ITEM_STATUSES) {
		const buckets = partitionWork([{ id: 'x', status } as DashboardItem])
		const hits = [buckets.needs, buckets.active, buckets.queue, buckets.triage, buckets.archived].filter(
			bucket => bucket.length === 1,
		)
		assert.equal(hits.length, 1, `status ${status} must land in exactly one bucket`)
	}
})

test('status→tone mapping is the fixed design-system contract', () => {
	assert.equal(statusTone('running'), 'accent')
	assert.equal(statusTone('review'), 'warn')
	assert.equal(statusTone('done'), 'success')
	assert.equal(statusTone('failed'), 'danger')
	assert.equal(statusTone('triage'), 'neutral')
	assert.equal(statusTone('ready'), 'neutral')
	assert.equal(statusTone('cancelled'), 'neutral')
})
