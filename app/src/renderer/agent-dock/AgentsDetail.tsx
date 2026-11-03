// The Agents pane: every listed agent, one line of observed facts each.
import type { CSSProperties } from 'react'
import type { AgentDockSnapshot } from '../../agent-dock/model'
import { CloseKey, Footer, Header, ScrollBody, closeHints } from './pane-chrome'
import { agentRepoGroups, agentRows, busyCount, orderedSessions } from './presentation'

/**
 * Every listed agent (Okena and Helm terminals): glyph, short name, repository (only where the name
 * does not already say it), status word and age, meta joined by " · ".
 *
 * One markup serves the layouts under review, chosen by CSS alone from the story-only
 * `#agent-dock[data-agents-variant]` (absent in production: the calm table). The rows stay in
 * `orderedSessions` order; the repository headings are hidden except in `by-project`, which
 * groups rows under them with `order: var(--agent-group)` (headings come first in the DOM, so each
 * leads its group).
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
	const rows = agentRows(snapshot, now)
	const groups = agentRepoGroups(rows)
	const groupOf = new Map(groups.flatMap((group, index) => group.keys.map(key => [key, index] as const)))
	return (
		<>
			<Header end={<CloseKey onClose={onClose} />}>
				<span className="agent-dock-title-kind">Agents</span>
				<span className="agent-dock-title-project">
					{sessions.length} connected · {busy} busy
				</span>
			</Header>
			<ScrollBody label="Agent list">
				<ul className="agent-dock-agent-list" aria-label="Agents">
					{groups.map((group, index) => (
						<li
							key={`repo:${group.repo}`}
							className="agent-dock-agent-group"
							style={{ '--agent-group': index } as CSSProperties}
						>
							{group.repo || 'No project'}
						</li>
					))}
					{rows.map(row => (
						<li
							key={row.key}
							className="agent-dock-agent"
							style={{ '--agent-group': groupOf.get(row.key) ?? 0 } as CSSProperties}
						>
							<span className="agent-dock-agent-glyph" data-status={row.status} aria-hidden="true">
								{row.glyph}
							</span>
							<span className="agent-dock-agent-name" title={row.title || undefined}>
								{row.name}
							</span>
							<span className="agent-dock-agent-repo">{row.repoNote}</span>
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
			</ScrollBody>
			<Footer hints={closeHints} note={null} />
		</>
	)
}
