// The Agents pane: every listed agent, one line of observed facts each, grouped by project.
import { useId } from 'react'
import type { AgentDockSnapshot } from '../../agent-dock/model'
import { CloseKey, Footer, Header, ScrollBody, closeHints } from './pane-chrome'
import { agentRepoGroups, agentRows, busyCount, orderedSessions } from './presentation'

/**
 * Every listed agent (Okena and Helm terminals) under a dim project heading (`agentRepoGroups`:
 * groups in the order of their first agent, agents with no known project last), each row the
 * status glyph, short name, status word and age, meta joined by " · ". One grid serves every
 * group (subgrid), so the columns line up across headings.
 *
 * Each group is an `<h3>` heading and the list it names ("Psyon, list, 2 items"), so VoiceOver
 * reads the project before its agents and heading navigation steps project by project.
 */
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
	const groups = agentRepoGroups(agentRows(snapshot, now))
	const idBase = useId()
	return (
		<>
			<Header end={<CloseKey onClose={onClose} />}>
				<span className="agent-dock-title-kind">Agents</span>
				<span className="agent-dock-title-project">
					{sessions.length} connected · {busy} busy
				</span>
			</Header>
			<ScrollBody label="Agent list">
				<div className="agent-dock-agent-list">
					{groups.map((group, index) => {
						const headingId = `${idBase}-group-${index}`
						return (
							<div key={`repo:${group.repo}`} className="agent-dock-agent-group">
								<h3 id={headingId} className="agent-dock-agent-group-name">
									{group.repo || 'No project'}
								</h3>
								<ul className="agent-dock-agent-rows" aria-labelledby={headingId}>
									{group.rows.map(row => (
										<li key={row.key} className="agent-dock-agent">
											<span className="agent-dock-agent-glyph" data-status={row.status} aria-hidden="true">
												{row.glyph}
											</span>
											<span className="agent-dock-agent-name" title={row.title || undefined}>
												{row.name}
											</span>
											{/* A waiting agent ages on its entry's clock, so it takes its entry's tone too. */}
											<span className="agent-dock-agent-state" data-status={row.status} data-tone={row.tone}>
												<span className="agent-dock-agent-word">{row.word}</span>
												{row.age ? ' ' : ''}
												<span className="agent-dock-agent-age">{row.age}</span>
											</span>
											<span className="agent-dock-agent-meta">{row.meta.join(' · ')}</span>
										</li>
									))}
								</ul>
							</div>
						)
					})}
				</div>
			</ScrollBody>
			<Footer hints={closeHints} note={null} />
		</>
	)
}
