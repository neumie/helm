// Agent dock source over several Okena-shaped sources: Okena Claude Remote and
// Helm's own Claude hub (Claude Code in Helm terminals). One tick polls every
// source concurrently; each poll carries its source's id, so the reducer keeps
// seed/epoch/health per source and one source going down never freezes the
// other. Acts and expedites route by the session's source.

import type { AgentDockObservation, DockActOutcome, DockAction, DockItem, DockSourceId } from './model'
import type { AgentDockState } from './reduce'
import type { AgentDockObservationSource, AgentDockTarget } from './watcher'

/** A pane within one source (the composite has already routed by `source`). */
export type DockPane = Omit<AgentDockTarget, 'source'>

/** One dock source: OkenaClaudeSource over Okena or over Helm's hub (structural, so tests inject doubles). */
export interface DockSource {
	readonly id: DockSourceId
	/** One poll, tagged `source: id`. */
	observe(state: AgentDockState, now: number): Promise<AgentDockObservation>
	act?(pane: DockPane, item: DockItem, action: DockAction): Promise<DockActOutcome>
	expedite?(pane: DockPane, until: number): void
}

export class CompositeDockSource implements AgentDockObservationSource {
	constructor(private readonly sources: readonly DockSource[]) {}

	async observe(state: AgentDockState, now: number): Promise<AgentDockObservation[]> {
		return Promise.all(
			this.sources.map(async (source): Promise<AgentDockObservation> => {
				try {
					return await source.observe(state, now)
				} catch (error) {
					// A source must never take the others down with it.
					const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300)
					return {
						type: 'poll',
						source: source.id,
						profile: 'unknown',
						state: { ok: false, error: detail },
						terminals: [],
					}
				}
			}),
		)
	}

	async act(target: AgentDockTarget, item: DockItem, action: DockAction): Promise<DockActOutcome> {
		const source = this.route(target)
		if (!source?.act) return { status: 'failed', detail: 'This source cannot answer from the dock.' }
		return source.act({ profile: target.profile, terminalId: target.terminalId }, item, action)
	}

	expedite(target: AgentDockTarget, until: number): void {
		this.route(target)?.expedite?.({ profile: target.profile, terminalId: target.terminalId }, until)
	}

	private route(target: AgentDockTarget): DockSource | undefined {
		return this.sources.find(source => source.id === target.source)
	}
}
