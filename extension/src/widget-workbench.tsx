import { createRoot, createSignal } from 'solid-js'
import type { DashboardItem, RunContextResponse } from './api'
import { mountWidget } from './mount-widget'

/** Workbench-only service boundary; every control is the production closed-shadow Widget. */
export function mountWidgetWorkbench(container: HTMLElement) {
	const host = document.createElement('div')
	host.id = 'extension-workbench'
	container.appendChild(host)
	let shadow!: ShadowRoot
	const attach = host.attachShadow.bind(host)
	host.attachShadow = options => {
		shadow = attach(options)
		return shadow
	}
	const originalFetch = window.fetch
	const originalChrome = Object.getOwnPropertyDescriptor(window, 'chrome')
	const calls: Array<{ method: string; path: string; body: unknown; origin: string }> = []
	const pending = new Map<string, () => void>()
	const state = {
		origin: 'https://helm-workbench.invalid',
		profile: 'work',
		generation: 1,
		protocol: 49,
		tracked: true,
		running: false,
		lifecycle: 'inbox' as 'inbox' | 'ready' | 'active' | 'cancelled',
		planned: false,
		rich: false,
		revision: 2,
		text: 'Source narrative',
		fail: '',
		hold: '',
		source: 'task-a',
		timeout: '',
	}
	let setSource!: (source: string) => void
	const images = [
		{ type: 'image' as const, url: 'https://example.test/source.png', name: 'Evidence.png', contentType: 'image/png' },
	]
	const row = (): DashboardItem => ({
		id: `item-${state.source}`,
		profileId: state.profile,
		kind: 'solve',
		executionMode: 'solve',
		status: state.running ? 'running' : state.lifecycle,
		workMode: state.running ? 'agent' : state.lifecycle === 'active' ? 'manual' : null,
		projectSlug: 'helm',
		title: 'Fix export ordering',
		source: { provider: 'fixture', externalId: state.source },
		canAssignProject: false,
		baseRef: 'main',
		spawner: null,
		groupId: null,
		group: null,
		branchName: null,
		forkContext: null,
		plan: state.planned
			? {
					worktreePath: '/fixture/worktree',
					branchName: 'fixture-plan',
					planDirName: 'fixture-plan',
					readmePath: '/fixture/worktree/README.md',
				}
			: null,
		planStatus: null,
		resultSummary: null,
		solveInputSnapshot: null,
		errorMessage: null,
		errorPhase: null,
		runOutcome: null,
		deployState: null,
		card: {
			state: state.running ? 'running' : state.lifecycle,
			statusLabel: state.running
				? 'Running'
				: { inbox: 'Inbox', ready: 'Ready', active: 'Active', cancelled: 'Cancelled' }[state.lifecycle],
			statusTone:
				state.running || state.lifecycle === 'active' ? 'blue' : state.lifecycle === 'cancelled' ? 'amber' : 'gray',
			pulse: false,
		},
		allowedActions: state.running
			? [{ id: 'cancel', label: 'Cancel', tone: 'danger' }]
			: state.lifecycle === 'inbox'
				? [
						{ id: 'approve', label: 'Approve', tone: 'primary' },
						{ id: 'reject', label: 'Reject', tone: 'danger' },
					]
				: state.lifecycle === 'ready'
					? [
							{ id: 'start', label: 'Start', tone: 'primary' },
							{ id: 'cancel', label: 'Cancel', tone: 'danger' },
						]
					: state.lifecycle === 'active'
						? [{ id: 'start', label: 'Start', tone: 'primary' }]
						: [{ id: 'retry', label: 'Retry', tone: 'primary' }],
		runObservation: {
			source: 'none',
			state: 'idle',
			stateLabel: 'Idle',
			summary: null,
			events: [],
			log: { path: null, available: false, content: '', truncated: false },
			pr: { url: null, state: null, merged: null },
			almanac: { runId: null, statusPath: null, status: null, round: null, summary: null, failureReason: null },
		},
		links: { source: null, branch: null, pr: null },
		createdAt: '',
		queuedAt: null,
		updatedAt: String(state.revision),
	})
	Object.defineProperty(window, 'chrome', {
		configurable: true,
		value: {
			storage: {
				sync: {
					get(defaults: Record<string, unknown>, done: (values: Record<string, unknown>) => void) {
						done({ ...defaults, serverUrl: state.origin, favoriteModels: ['claude-model'] })
					},
					set(_values: unknown, done?: () => void) {
						done?.()
					},
				},
			},
		},
	})
	window.fetch = async (input, options) => {
		const url = new URL(String(input))
		if (!url.hostname.endsWith('helm-workbench.invalid')) {
			if (url.pathname.startsWith('/api')) throw new Error('Workbench refuses non-fixture API traffic')
			return originalFetch(input, options)
		}
		const path = url.pathname.replace(/^\/api/, '')
		const method = options?.method ?? 'GET'
		const body = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined
		calls.push({ path, method, body, origin: url.origin })
		if (state.hold && path.endsWith(state.hold)) await new Promise<void>(resolve => pending.set(path, resolve))
		if (state.timeout && path.endsWith(state.timeout))
			throw new DOMException('Controlled timeout after dispatch', 'TimeoutError')
		if (state.fail && path.endsWith(state.fail))
			return Response.json({ error: 'Controlled conflict; check outcome' }, { status: 409 })
		if (path === '/status')
			return Response.json({
				data: { protocolVersion: state.protocol, profile: { id: state.profile }, profileGeneration: state.generation },
			})
		if (path === '/config')
			return Response.json({
				data: {
					projects: [{ slug: 'helm' }],
					solver: { agent: 'claude', workspace: 'worktree' },
					modelCatalog: {
						claude: [
							{ id: 'claude-model', label: 'Claude model' },
							{ id: 'claude-other', label: 'Other Claude model' },
						],
						codex: [{ id: 'codex-model', label: 'Codex model' }],
						pi: [{ id: 'provider/pi-model', label: 'Pi model' }],
					},
				},
			})
		if (path.startsWith('/items/by-source/')) return Response.json({ data: state.tracked ? row() : null })
		if (path === '/items/source') {
			state.tracked = true
			state.revision = 0
			state.text = ''
			return Response.json({ data: row() })
		}
		if (path.endsWith('/run-context/plain')) {
			if (body.revision !== state.revision) return Response.json({ error: 'Revision conflict' }, { status: 409 })
			if (path.includes(`/items/${row().id}/`)) {
				state.text = body.text
				state.revision++
			}
			return Response.json({
				data: {
					document: { version: 2, text: body.text, images, updatedAt: '2026-09-10T10:00:00.000Z' },
					revision: body.revision + 1,
				},
			})
		}
		if (path.endsWith('/run-context')) {
			const data: RunContextResponse = {
				item: { id: row().id, title: row().title, projectSlug: 'helm', status: row().status },
				revision: state.revision,
				source: {
					title: 'Source',
					description: 'provider-hash',
					descriptionBlocks: [{ type: 'text', text: 'Full source text' }, ...images],
					comments: [{ author: 'Reporter', createdAt: '2026-09-10', body: 'Important comment' }],
				},
				document:
					state.revision === 0
						? null
						: state.rich
							? { version: 1, blocks: [], markdown: 'Rich saved narrative', updatedAt: '2026-09-10T10:00:00.000Z' }
							: { version: 2, text: state.text, images, updatedAt: '2026-09-10T10:00:00.000Z' },
			}
			return Response.json({ data })
		}
		if (path.endsWith('/start')) {
			state.running = true
			return Response.json({ data: row() })
		}
		if (path.endsWith('/approve') || path.endsWith('/reject')) {
			if (state.lifecycle !== 'inbox') return Response.json({ error: 'Expected Inbox' }, { status: 409 })
			state.lifecycle = path.endsWith('/approve') ? 'ready' : 'cancelled'
			return Response.json({ data: row() })
		}
		if (path.endsWith('/plan')) {
			state.lifecycle = 'active'
			state.planned = true
			return Response.json({ data: { spawner: 'fixture', hint: 'Prepared' } })
		}
		return Response.json({ data: row() })
	}
	let dispose!: () => void
	createRoot(rootDispose => {
		const [source, update] = createSignal(state.source)
		setSource = update
		const unmount = mountWidget(host, source)
		dispose = () => {
			unmount()
			rootDispose()
		}
	})
	const harness = {
		unmountWidget: () => dispose(),
		state,
		calls,
		text: () => (shadow.querySelector('.vg-card') ?? shadow.querySelector('.vg-pill'))?.textContent ?? '',
		closed: () => host.shadowRoot === null && shadow.mode === 'closed',
		query: (selector: string) => shadow.querySelector<HTMLElement>(selector),
		require(selector: string) {
			const element = shadow.querySelector<HTMLElement>(selector)
			if (!element) throw new Error(`Missing widget element ${selector}`)
			return element
		},
		switchSource(source: string) {
			state.source = source
			state.text = 'Other owner narrative'
			setSource(source)
		},
		release() {
			state.hold = ''
			for (const resolve of pending.values()) resolve()
			pending.clear()
		},
	}
	Object.assign(window, { extensionWorkbench: harness })
	return () => {
		harness.release()
		dispose()
		host.remove()
		window.fetch = originalFetch
		if (originalChrome) Object.defineProperty(window, 'chrome', originalChrome)
		else Reflect.deleteProperty(window, 'chrome')
		Reflect.deleteProperty(window, 'extensionWorkbench')
	}
}
