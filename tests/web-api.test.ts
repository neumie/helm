import assert from 'node:assert/strict'
import test from 'node:test'
import { api } from '../web/src/api.ts'
import type { CreateItemInput, DashboardItem, PlanInfo } from '../web/src/api.ts'
import { queueLaneSummaries } from '../web/src/components/Header.tsx'
import { buildCreateItemInput, createItemWithIntent } from '../web/src/components/ItemCreateForm.tsx'
import { runObservationDetails } from '../web/src/components/ItemDetail.tsx'
import { itemMetaLabels, partitionWorkEntries, workAttentionCounts } from '../web/src/components/TaskList.tsx'

const originalFetch = globalThis.fetch

test('web API creates dashboard Items with posted payload', async () => {
	const calls: Array<{ path: string; init: RequestInit | undefined }> = []
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ path: input.toString(), init })
		return new Response(JSON.stringify({ data: { id: 'item-1' } }), {
			status: 201,
			headers: { 'content-type': 'application/json' },
		})
	}

	try {
		const result = await api.createItem({
			kind: 'solve',
			title: 'Ship dashboard add form',
			projectSlug: 'vigil',
			prompt: 'Add a dashboard form for solve Items.',
			baseRef: 'release/afk',
			spawner: 'default',
			parallelism: 2,
		})

		assert.deepEqual(result, { id: 'item-1' })
		assert.equal(calls.length, 1)
		assert.equal(calls[0].path, '/api/items')
		assert.equal(calls[0].init?.method, 'POST')
		assert.deepEqual(calls[0].init?.headers, { 'Content-Type': 'application/json' })
		assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
			kind: 'solve',
			title: 'Ship dashboard add form',
			projectSlug: 'vigil',
			prompt: 'Add a dashboard form for solve Items.',
			baseRef: 'release/afk',
			spawner: 'default',
			parallelism: 2,
		})
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('web API plans dashboard Items through the Item planning route', async () => {
	const calls: Array<{ path: string; init: RequestInit | undefined }> = []
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ path: input.toString(), init })
		return new Response(
			JSON.stringify({
				data: {
					worktreePath: '/tmp/vigil-item',
					branchName: 'vigil/item/plan-me-abc123',
					planDirName: '2026-06-19-plan-me-abc123',
					readmePath: '/tmp/vigil-item/docs/plans/2026-06-19-plan-me-abc123/README.md',
					spawner: 'default',
					solverAgent: 'codex',
					hint: 'Planning agent started',
				},
			}),
			{
				status: 200,
				headers: { 'content-type': 'application/json' },
			},
		)
	}

	try {
		const result = await api.planItem('item-1')

		assert.equal(result.planDirName, '2026-06-19-plan-me-abc123')
		assert.equal(result.spawner, 'default')
		assert.equal(calls.length, 1)
		assert.equal(calls[0].path, '/api/items/item-1/plan')
		assert.equal(calls[0].init?.method, 'POST')
		assert.deepEqual(calls[0].init?.headers, { 'Content-Type': 'application/json' })
		assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {})
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('ItemCreateForm builds forked Item payloads with baseItemId instead of BaseRef', () => {
	const input = buildCreateItemInput({
		kind: 'solve',
		projectSlug: 'vigil',
		title: 'Try alternate fix',
		baseRef: 'main',
		baseItemId: 'item-parent',
		spawnerName: 'default',
		parallelism: 3,
		prompt: 'Try another approach from parent branch.',
		prdPath: '',
		ralphMode: 'once',
		ralphProvider: '',
		model: '',
		effort: '',
		iterations: 10,
		noOversee: false,
		target: '',
		rounds: 1,
	})

	assert.deepEqual(input, {
		kind: 'solve',
		title: 'Try alternate fix',
		projectSlug: 'vigil',
		prompt: 'Try another approach from parent branch.',
		baseItemId: 'item-parent',
		spawner: 'default',
		parallelism: 3,
	})
})

test('ItemCreateForm plan intent creates Items and prepares planning for each one', async () => {
	const input: CreateItemInput = {
		kind: 'solve',
		title: 'Plan fan-out',
		projectSlug: 'vigil',
		prompt: 'Create two planned attempts.',
		parallelism: 2,
	}
	const created = [{ id: 'item-a' } as DashboardItem, { id: 'item-b' } as DashboardItem]
	const calls: string[] = []
	const client = {
		createItem: async (posted: CreateItemInput) => {
			assert.deepEqual(posted, { ...input, intent: 'plan' })
			calls.push('create')
			return created
		},
		planItem: async (id: string) => {
			calls.push(`plan:${id}`)
			return {
				worktreePath: `/tmp/${id}`,
				branchName: `vigil/item/${id}`,
				planDirName: `plan-${id}`,
				readmePath: `/tmp/${id}/docs/plans/plan-${id}/README.md`,
				spawner: 'default',
				solverAgent: 'codex',
				hint: 'planned',
			} satisfies PlanInfo
		},
	}

	const result = await createItemWithIntent(input, 'plan', client)

	assert.equal(result, created)
	assert.deepEqual(calls, ['create', 'plan:item-a', 'plan:item-b'])
})

test('TaskList keeps triage Items in the triage bucket', () => {
	const triaged = {
		id: 'item-triage',
		status: 'triage',
	} as DashboardItem

	const buckets = partitionWorkEntries([triaged])

	assert.deepEqual(
		buckets.triage.map(item => item.id),
		['item-triage'],
	)
	assert.equal(buckets.archived.length, 0)
})

test('partitionWorkEntries routes review + failed to the "needs you" bucket', () => {
	const review = { id: 'r', status: 'review' } as DashboardItem
	const failed = { id: 'f', status: 'failed' } as DashboardItem
	const processing = { id: 'p', status: 'running' } as DashboardItem
	const done = { id: 'd', status: 'done' } as DashboardItem

	const buckets = partitionWorkEntries([review, failed, processing, done])
	assert.deepEqual(buckets.needs.map(i => i.id).sort(), ['f', 'r'])
	assert.deepEqual(
		buckets.running.map(i => i.id),
		['p'],
	)
	assert.deepEqual(
		buckets.archived.map(i => i.id),
		['d'],
	)
})

test('partitionWorkEntries keeps triage in its own bucket, not Ready', () => {
	const triagedA = { id: 'u', status: 'triage' } as DashboardItem
	const ready = { id: 'q', status: 'ready' } as DashboardItem
	const triagedB = { id: 'p', status: 'triage' } as DashboardItem

	const buckets = partitionWorkEntries([triagedA, ready, triagedB])
	assert.deepEqual(buckets.triage.map(i => i.id).sort(), ['p', 'u'])
	assert.deepEqual(
		buckets.ready.map(i => i.id),
		['q'],
	)
})

test('dashboard attention counts surface review + failed as "needs you", processing as running', () => {
	const review = { id: 'item-review', status: 'review' } as DashboardItem
	const failed = { id: 'item-failed', status: 'failed' } as DashboardItem
	const queued = { id: 'item-queued', status: 'ready' } as DashboardItem
	const processing = { id: 'item-processing', status: 'running' } as DashboardItem

	// review + failed are what need a human; queued/planned do NOT count as attention.
	assert.deepEqual(workAttentionCounts([review, failed, queued, processing]), {
		running: 1,
		needsYou: 2,
	})
})

test('TaskList uses server-owned Item group labels', () => {
	assert.deepEqual(
		itemMetaLabels({
			kind: 'solve',
			projectSlug: 'vigil',
			group: {
				id: 'group-1',
				label: 'Group 2/3',
				position: 2,
				size: 3,
				siblingIds: ['a', 'b', 'c'],
			},
		} as DashboardItem),
		['vigil', 'solve', 'Group 2/3'],
	)
})

test('Header summarizes solve and loop lane status separately', () => {
	assert.deepEqual(
		queueLaneSummaries({
			uptime: 120,
			projects: ['vigil'],
			pollInterval: 60,
			queue: {
				paused: false,
				pending: 5,
				active: 1,
				maxConcurrency: 3,
				activeTasks: [],
				lanes: {
					solve: { pending: 3, active: 1, maxConcurrency: 2 },
					loop: { pending: 2, active: 0, maxConcurrency: 1 },
				},
			},
		}),
		['Solve 1/2, 3 queued', 'Loop 0/1, 2 queued'],
	)
})

test('ItemDetail run details include almanac failure reasons separately', () => {
	assert.deepEqual(
		runObservationDetails({
			source: 'loop',
			state: 'failed',
			stateLabel: 'Failed',
			summary: 'Loop failed',
			events: [],
			log: { path: null, available: false, content: '', truncated: false },
			pr: { url: null, state: null, merged: null },
			almanac: {
				runId: 'ralph-123',
				statusPath: '/tmp/repo/.almanac/runs/ralph-123/status.tsv',
				status: 'failed',
				round: '2',
				summary: 'Loop failed',
				failureReason: 'missing solver-result.json',
			},
		}),
		[
			{ label: 'Status', value: 'failed', link: null, tone: 'gray' },
			{ label: 'Round', value: '2', link: null, tone: 'gray' },
			{ label: 'Failure', value: 'missing solver-result.json', link: null, tone: 'red' },
		],
	)
})
