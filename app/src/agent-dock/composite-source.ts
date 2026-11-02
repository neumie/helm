// Agent dock source over several Okena-shaped sources: Okena Claude Remote and
// Helm's own Claude hub (Claude Code in Helm terminals). One tick polls every
// source concurrently and tags each poll with its source id, so the reducer
// keeps seed/epoch/health per source and one source going down never freezes
// the other. Acts and expedites route by the session's source.

import type { AgentDockObservation, DockActOutcome, DockAction, DockItem, DockSourceId } from './model'
import type { AgentDockState } from './reduce'
import type { AgentDockObservationSource, AgentDockTarget } from './watcher'

/** One source as OkenaClaudeSource exposes it (structural, so tests inject doubles). */
export interface DockSubSource {
	observe(state: AgentDockState, now: number): Promise<AgentDockObservation>
	act?(target: { profile: string; terminalId: string }, item: DockItem, action: DockAction): Promise<DockActOutcome>
	expedite?(target: { profile: string; terminalId: string }, until: number): void
}

export class CompositeDockSource implements AgentDockObservationSource {
	constructor(private readonly sources: ReadonlyArray<{ id: DockSourceId; source: DockSubSource }>) {}

	async observe(state: AgentDockState, now: number): Promise<AgentDockObservation[]> {
		return Promise.all(
			this.sources.map(async ({ id, source }): Promise<AgentDockObservation> => {
				try {
					const observation = await source.observe(state, now)
					return observation.type === 'poll' ? { ...observation, source: id } : observation
				} catch (error) {
					// A source must never take the others down with it.
					const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300)
					return { type: 'poll', source: id, profile: 'unknown', state: { ok: false, error: detail }, terminals: [] }
				}
			}),
		)
	}

	async act(target: AgentDockTarget, item: DockItem, action: DockAction): Promise<DockActOutcome> {
		const source = this.sources.find(entry => entry.id === target.source)?.source
		if (!source?.act) return { status: 'failed', detail: 'This source cannot answer from the dock.' }
		return source.act({ profile: target.profile, terminalId: target.terminalId }, item, action)
	}

	expedite(target: AgentDockTarget, until: number): void {
		this.sources
			.find(entry => entry.id === target.source)
			?.source.expedite?.({ profile: target.profile, terminalId: target.terminalId }, until)
	}
}
