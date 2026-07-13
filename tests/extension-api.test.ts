import assert from 'node:assert/strict'
import test from 'node:test'
import extensionWidgetModule from '../extension/src/Widget.tsx'
import extensionApiModule from '../extension/src/api.ts'

const originalFetch = globalThis.fetch
const { api } = extensionApiModule as typeof import('../extension/src/api.ts')
type ExtensionWidgetModule = typeof import('../extension/src/Widget.tsx')
const { itemRunNotices, extensionItemActions } = extensionWidgetModule as ExtensionWidgetModule

type ChromeStorageStub = {
	storage: {
		sync: {
			get: (defaults: unknown, callback: (items: { serverUrl: string }) => void) => void
		}
	}
}

test('extension Item notices show almanac failure reasons as failures', () => {
	assert.deepEqual(
		itemRunNotices({
			resultSummary: null,
			runObservation: {
				source: 'loop',
				summary: 'Loop failed',
				almanac: {
					summary: 'Loop failed',
					failureReason: 'Tests failed after round 2',
				},
			},
		} as Parameters<typeof itemRunNotices>[0]),
		[
			{ kind: 'summary', text: 'Loop failed' },
			{ kind: 'failure', text: 'Tests failed after round 2' },
		],
	)
	assert.deepEqual(
		itemRunNotices({
			resultSummary: null,
			runObservation: {
				source: 'loop',
				summary: 'Tests failed after round 2',
				almanac: {
					summary: 'Tests failed after round 2',
					failureReason: 'Tests failed after round 2',
				},
			},
		} as Parameters<typeof itemRunNotices>[0]),
		[{ kind: 'failure', text: 'Tests failed after round 2' }],
	)
})

test('extension remaps approve to start (run immediately), leaving other actions', () => {
	assert.deepEqual(
		extensionItemActions([
			{ id: 'approve', label: 'Approve', tone: 'primary' },
			{ id: 'reject', label: 'Reject', tone: 'danger' },
		]),
		[
			{ id: 'start', label: 'Start', tone: 'primary' },
			{ id: 'reject', label: 'Reject', tone: 'danger' },
		],
	)
	// Non-approve action lists pass through untouched.
	assert.deepEqual(extensionItemActions([{ id: 'retry', label: 'Retry', tone: 'primary' }]), [
		{ id: 'retry', label: 'Retry', tone: 'primary' },
	])
})

test('extension API posts dashboard Item actions to Item routes', async () => {
	const calls: Array<{ path: string; init: RequestInit | undefined }> = []
	const globalWithChrome = globalThis as typeof globalThis & { chrome?: ChromeStorageStub }
	const originalChrome = globalWithChrome.chrome
	globalWithChrome.chrome = {
		storage: {
			sync: {
				get: (_defaults, callback) => callback({ serverUrl: 'http://localhost:7474' }),
			},
		},
	}
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ path: input.toString(), init })
		return new Response(JSON.stringify({ data: { ok: true } }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}

	try {
		await api.itemAction('item-1', 'start')

		assert.equal(calls.length, 1)
		assert.equal(calls[0].path, 'http://localhost:7474/api/items/item-1/start')
		assert.equal(calls[0].init?.method, 'POST')
	} finally {
		globalThis.fetch = originalFetch
		if (originalChrome) {
			globalWithChrome.chrome = originalChrome
		} else {
			globalWithChrome.chrome = undefined
		}
	}
})

test('extension API passes selected solver agent to Item actions that can start work', async () => {
	const calls: Array<{ path: string; init: RequestInit | undefined }> = []
	const globalWithChrome = globalThis as typeof globalThis & { chrome?: ChromeStorageStub }
	const originalChrome = globalWithChrome.chrome
	globalWithChrome.chrome = {
		storage: {
			sync: {
				get: (_defaults, callback) => callback({ serverUrl: 'http://localhost:7474' }),
			},
		},
	}
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ path: input.toString(), init })
		return new Response(JSON.stringify({ data: { ok: true } }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}

	try {
		await api.itemAction('item-1', 'approve', { solverAgent: 'codex', solverWorkspace: 'main' })
		await api.itemAction('item-1', 'start', { solverAgent: 'codex', solverModel: 'gpt-5.5', solverWorkspace: null })
		await api.itemAction('item-1', 'retry', { solverAgent: 'codex' })

		// solverWorkspace mirrors solverModel: a value rides along, explicit null
		// clears the override, and an absent field stays absent.
		assert.deepEqual(
			calls.map(call => JSON.parse(String(call.init?.body))),
			[
				{ solverAgent: 'codex', solverWorkspace: 'main' },
				{ solverAgent: 'codex', solverModel: 'gpt-5.5', solverWorkspace: null },
				{ solverAgent: 'codex' },
			],
		)
	} finally {
		globalThis.fetch = originalFetch
		if (originalChrome) {
			globalWithChrome.chrome = originalChrome
		} else {
			globalWithChrome.chrome = undefined
		}
	}
})

test('extension API ignores invalidated Chrome storage context', async () => {
	const calls: Array<{ path: string; init: RequestInit | undefined }> = []
	const globalWithChrome = globalThis as typeof globalThis & { chrome?: ChromeStorageStub }
	const originalChrome = globalWithChrome.chrome
	globalWithChrome.chrome = {
		storage: {
			sync: {
				get: () => {
					throw new Error('Extension context invalidated.')
				},
			},
		},
	}
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ path: input.toString(), init })
		return new Response(JSON.stringify({ data: null }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}

	try {
		const item = await api.findItemBySource('task-1')

		assert.equal(item, null)
		assert.equal(calls.length, 1)
		assert.equal(calls[0].path, 'http://localhost:7474/api/items/by-source/task-1')
	} finally {
		globalThis.fetch = originalFetch
		if (originalChrome) {
			globalWithChrome.chrome = originalChrome
		} else {
			globalWithChrome.chrome = undefined
		}
	}
})

test('extension API prepares planning for dashboard Items through Item routes', async () => {
	const calls: Array<{ path: string; init: RequestInit | undefined }> = []
	const globalWithChrome = globalThis as typeof globalThis & { chrome?: ChromeStorageStub }
	const originalChrome = globalWithChrome.chrome
	globalWithChrome.chrome = {
		storage: {
			sync: {
				get: (_defaults, callback) => callback({ serverUrl: 'http://localhost:7474' }),
			},
		},
	}
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ path: input.toString(), init })
		return new Response(
			JSON.stringify({
				data: {
					worktreePath: '/tmp/worktree',
					branchName: 'helm/item/demo',
					planDirName: 'demo-plan',
					readmePath: '/tmp/worktree/docs/plans/demo-plan/README.md',
					spawner: 'default',
					solverAgent: 'claude',
					hint: 'planned',
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

		assert.equal(result.planDirName, 'demo-plan')
		assert.equal(calls.length, 1)
		assert.equal(calls[0].path, 'http://localhost:7474/api/items/item-1/plan')
		assert.equal(calls[0].init?.method, 'POST')
	} finally {
		globalThis.fetch = originalFetch
		if (originalChrome) {
			globalWithChrome.chrome = originalChrome
		} else {
			globalWithChrome.chrome = undefined
		}
	}
})

test('extension API creates source-backed Items without a per-run solverAgent', async () => {
	const calls: Array<{ path: string; init: RequestInit | undefined }> = []
	const globalWithChrome = globalThis as typeof globalThis & { chrome?: ChromeStorageStub }
	const originalChrome = globalWithChrome.chrome
	globalWithChrome.chrome = {
		storage: {
			sync: {
				get: (_defaults, callback) => callback({ serverUrl: 'http://localhost:7474' }),
			},
		},
	}
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ path: input.toString(), init })
		return new Response(JSON.stringify({ data: { id: 'item-1', status: 'triage' } }), {
			status: 201,
			headers: { 'content-type': 'application/json' },
		})
	}

	try {
		await api.createItemFromSource('task-1')

		assert.equal(calls.length, 1)
		assert.equal(calls[0].path, 'http://localhost:7474/api/items/source')
		assert.equal(calls[0].init?.method, 'POST')
		assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
			externalId: 'task-1',
		})
	} finally {
		globalThis.fetch = originalFetch
		if (originalChrome) {
			globalWithChrome.chrome = originalChrome
		} else {
			globalWithChrome.chrome = undefined
		}
	}
})
