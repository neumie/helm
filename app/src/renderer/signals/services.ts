// What the Signals column reads and does, as injected services: production adapters wrap the
// preload bridges (window.helm.signals, window.helm.agentDock); stories and browser tests pass
// in-memory fakes (signals-fixtures.ts). The column never touches the daemon or Okena directly.

import type {
	AgentDockActRequest,
	AgentDockActResult,
	AgentDockPromptRequest,
	AgentDockSnapshot,
} from '../../agent-dock/model'
import type {
	AgentDockApi,
	SignalNewAgentRequest,
	SignalNewAgentResult,
	SignalOkenaProjects,
	SignalsApi,
	SignalsBridgeState,
} from '../../shared'
import type {
	HelmResult,
	SignalFilteredPage,
	SignalIncludeResult,
	SignalMuteResult,
	SignalReply,
	SignalRouted,
	SignalThread,
	SignalUpdate,
} from '../../shared-helm'

export interface SignalsService {
	getState(): SignalsBridgeState
	subscribe(listener: () => void): () => void
	update(id: number, patch: SignalUpdate): Promise<HelmResult<SignalThread>>
	routed(id: number, body: SignalRouted): Promise<HelmResult<SignalThread>>
	/** Opens a thread's source (github.com in the browser, message:// in Mail). */
	open(url: string): Promise<HelmResult<true>>
	okenaProjects(repo: string | null): Promise<HelmResult<SignalOkenaProjects>>
	newAgent(request: SignalNewAgentRequest): Promise<HelmResult<SignalNewAgentResult>>
	/** Mail the rules kept out of Needs you (heads only, last 7 days). */
	filtered(): Promise<HelmResult<SignalFilteredPage>>
	/** Always show that filtered mail's sender. */
	include(id: number): Promise<HelmResult<SignalIncludeResult>>
	/** Never show that mail thread's sender (`x`): exclude list, its open threads close. */
	mute(id: number): Promise<HelmResult<SignalMuteResult>>
	/** Saves Jakub's answer on an agent ask; typing it into the agent is the dock's `prompt`. */
	reply(id: number, body: SignalReply): Promise<HelmResult<SignalThread>>
	/**
	 * Opens link `index` of an agent ask (main re-reads the thread and opens only its stored link, and
	 * only while it is still `url`, the link shown at that position).
	 */
	openLink(id: number, index: number, url: string): Promise<HelmResult<true>>
}

export interface DockService {
	snapshot(): AgentDockSnapshot | null
	subscribe(listener: () => void): () => void
	/** A reply to an agent that owes Jakub nothing (no live dock item): `agent-dock:prompt`. */
	prompt(request: AgentDockPromptRequest): Promise<AgentDockActResult>
	/** A dock item's own answer (`agent-dock:act`): a reply to its open turn item, through the turn's CAS. */
	act(request: AgentDockActRequest): Promise<AgentDockActResult>
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
		// An older preload without the filtered log answers like an older daemon would.
		filtered: guarded(() =>
			api.filtered ? api.filtered() : Promise.resolve({ error: 'This Helm cannot list filtered mail.' }),
		),
		include: guarded((id: number) =>
			api.include ? api.include(id) : Promise.resolve({ error: 'This Helm cannot change the include list.' }),
		),
		mute: guarded((id: number) =>
			api.mute ? api.mute(id) : Promise.resolve({ error: 'This Helm cannot change the exclude list.' }),
		),
		reply: guarded((id: number, body: SignalReply) => api.reply(id, body)),
		openLink: guarded((id: number, index: number, url: string) => api.openLink(id, index, url)),
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
		async act(request) {
			if (!api) return { ok: false, outcome: { status: 'failed', detail: 'The agent dock is off in this run.' } }
			try {
				return await api.act(request)
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
