// The Agents pane: every listed agent as a table of observed facts.
import type { AgentDockSnapshot } from '../../agent-dock/model'
import { CloseKey, Footer, Header, ScrollBody, closeHints } from './pane-chrome'
import {
	agentRowMeta,
	agentWho,
	agingTone,
	busyCount,
	orderedSessions,
	sessionSince,
	sessionStatusText,
	statusGlyph,
} from './presentation'

/** Every listed agent (Okena and Helm terminals), as a table of observed facts. */
export function AgentsDetail({
	snapshot,
	now,
	onClose,
}: {
	snapshot: AgentDockSnapshot | null
	now: number
	onClose(): void
}) {
	const sessions = orderedSessions(snapshot)
	const busy = busyCount(sessions)
	return (
		<>
			<Header end={<CloseKey onClose={onClose} />}>
				<span className="agent-dock-title-kind">Agents</span>
				<span className="agent-dock-title-project">
					{sessions.length} connected · {busy} busy
				</span>
			</Header>
			<ScrollBody label="Agent list">
				<ul className="agent-dock-table" aria-label="Agents">
					{snapshot
						? sessions.map(session => {
								const who = agentWho(snapshot, session.key)
								const meta = agentRowMeta(snapshot, session)
								const since = sessionSince(snapshot, session)
								return (
									<li key={session.key} className="agent-dock-tr">
										<span className="agent-dock-status" data-status={session.status} aria-hidden="true">
											{statusGlyph(session.status)}
										</span>
										<span className="agent-dock-td-name" title={who.title || undefined}>
											{who.name}
										</span>
										<span className="agent-dock-td-project">{who.project}</span>
										{/* A waiting agent ages on its entry's clock, so it takes its entry's tone too. */}
										<span
											className="agent-dock-td-status"
											data-status={session.status}
											data-tone={session.status === 'waiting' ? agingTone(now - since) : undefined}
										>
											{sessionStatusText(session, now, since)}
										</span>
										<span className="agent-dock-td-meta">{meta.join('  ')}</span>
									</li>
								)
							})
						: null}
				</ul>
			</ScrollBody>
			<Footer hints={closeHints} note={null} />
		</>
	)
}
