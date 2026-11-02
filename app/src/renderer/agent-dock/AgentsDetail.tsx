// The Agents pane: every listed agent as a table of observed facts, then recently closed items.
import type { AgentDockSnapshot } from '../../agent-dock/model'
import { CloseKey, Footer, Header, ScrollBody, closeHints } from './pane-chrome'
import {
	agentRowMeta,
	agentWho,
	agingTone,
	busyCount,
	formatAge,
	itemKindLabel,
	kindGlyph,
	orderedSessions,
	recentItems,
	resolutionLabel,
	sessionSince,
	sessionStatusText,
	statusGlyph,
} from './presentation'

const RECENT_IN_PANE = 5

/** Every agent Okena lists, as a table of observed facts, then recently closed items. */
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
	const recent = recentItems(snapshot, RECENT_IN_PANE)
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
				{recent.length > 0 ? (
					<section>
						<h3 className="agent-dock-subhead">Recent</h3>
						<ul className="agent-dock-table">
							{recent.map(item => {
								const who = agentWho(snapshot, item.session)
								return (
									<li key={item.id} className="agent-dock-tr">
										<span className="agent-dock-status" aria-hidden="true">
											{kindGlyph({ ...item, state: 'open' })}
										</span>
										<span className="agent-dock-td-name" data-dim="true" title={who.title || undefined}>
											{who.name}
										</span>
										<span className="agent-dock-td-project">
											{itemKindLabel(item).toLowerCase()} #{item.id}
										</span>
										<span className="agent-dock-td-status">
											{item.resolution ? `${formatAge(now - item.resolution.at)} ago` : ''}
										</span>
										<span className="agent-dock-td-meta">{resolutionLabel(item)}</span>
									</li>
								)
							})}
						</ul>
					</section>
				) : null}
			</ScrollBody>
			<Footer hints={closeHints} note={null} />
		</>
	)
}
