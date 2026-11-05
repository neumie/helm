// What the Signals column reads and does, as injected services: production adapters wrap the
// preload bridges (window.helm.signals, window.helm.agentDock); stories and browser tests pass
// in-memory fakes (signals-fixtures.ts). The column never touches the daemon or Okena directly.

import type { AgentDockActResult, AgentDockPromptRequest, AgentDockSnapshot } from '../../agent-dock/model'
import type {
	AgentDockApi,
	SignalNewAgentRequest,
	SignalNewAgentResult,
	SignalOkenaProjects,
	SignalsApi,
	SignalsBridgeState,
} from '../../shared'
import type { HelmResult, SignalRouted, SignalThread, SignalUpdate } from '../../shared-helm'

export interface SignalsService {
	getState(): SignalsBridgeState
	subscribe(listener: () => void): () => void
	update(id: number, patch: SignalUpdate): Promise<HelmResult<SignalThread>>
	routed(id: number, body: SignalRouted): Promise<HelmResult<SignalThread>>
	/** Opens a thread's source (github.com in the browser, message:// in Mail). */
	open(url: string): Promise<HelmResult<true>>
	okenaProjects(repo: string | null): Promise<HelmResult<SignalOkenaProjects>>
	newAgent(request: SignalNewAgentRequest): Promise<HelmResult<SignalNewAgentResult>>
}

export interface DockService {
	snapshot(): AgentDockSnapshot | null
	subscribe(listener: () => void): () => void
	prompt(request: AgentDockPromptRequest): Promise<AgentDockActResult>
}

const INITIAL: SignalsBridgeState = { snapshot: null, error: null, at: null }

const failure = (error: unknown): { error: string } => ({
	error: error instanceof Error ? error.message : String(error),
})

/** One store over main's pushes plus the current state `subscribe()` returns. */
export function createSignalsService(api: SignalsApi): SignalsService & { dispose(): void } {
	let state = INITIAL
	let pushed = false
	const listeners = new Set<() => void>()
	const set = (next: SignalsBridgeState): void => {
		state = next
		for (const listener of listeners) listener()
	}
	const unsubscribe = api.onSnapshot(next => {
		pushed = true
		set(next)
	})
	void api
		.subscribe()
		.then(initial => {
			// A push that already arrived is newer than this reply.
			if (!pushed) set(initial)
		})
		.catch(() => undefined)
	const guarded =
		<A extends unknown[], R>(call: (...args: A) => Promise<HelmResult<R>>) =>
		async (...args: A): Promise<HelmResult<R>> => {
			try {
				return await call(...args)
			} catch (error) {
				return failure(error)
			}
		}
	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		update: guarded((id: number, patch: SignalUpdate) => api.update(id, patch)),
		routed: guarded((id: number, body: SignalRouted) => api.routed(id, body)),
		open: guarded((url: string) => api.open(url)),
		okenaProjects: guarded((repo: string | null) => api.okenaProjects(repo)),
		newAgent: guarded((request: SignalNewAgentRequest) => api.newAgent(request)),
		dispose() {
			unsubscribe()
			listeners.clear()
		},
	}
}

/**
 * The agent dock's snapshot (pushed while a dock is shown) and its reply path (`agent-dock:prompt`,
 * main's fresh idle check before anything is typed). Without the dock bridge, no agent is listed.
 */
export function createDockService(api: AgentDockApi | undefined): DockService & { dispose(): void } {
	let snapshot: AgentDockSnapshot | null = null
	const listeners = new Set<() => void>()
	const unsubscribe =
		api?.onSnapshot(next => {
			snapshot = next
			for (const listener of listeners) listener()
		}) ?? (() => undefined)
	return {
		snapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		async prompt(request) {
			if (!api) return { ok: false, outcome: { status: 'failed', detail: 'The agent dock is off in this run.' } }
			try {
				return await api.prompt(request)
			} catch (error) {
				return { ok: false, outcome: { status: 'failed', detail: failure(error).error } }
			}
		},
		dispose() {
			unsubscribe()
			listeners.clear()
		},
	}
}
