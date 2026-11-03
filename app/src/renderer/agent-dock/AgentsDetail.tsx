// The Agents pane (design §3.24 Agents): every listed agent (Okena panes and Helm terminals) and
// where it stands with Jakub — needs you, reply waiting, sending, working, background, read, idle,
// unknown — with where it runs and the first line of what it last said. Rows are one roving list:
// ↑ ↓ Home End move, Enter / Space (or a click) opens the agent (its open item, else its detail).
import { type KeyboardEvent, type MutableRefObject, useId } from 'react'
import type { AgentDockSnapshot } from '../../agent-dock/model'
import { CloseKey, Footer, Header, Hint, ScrollBody, closeHints } from './pane-chrome'
import { type DetailKeys, noModifiers, useKeys } from './pane-keys'
import { type AgentRow, type AgentsLayout, agentOverview, agentRowLabel, agentsSummary } from './presentation'

const ROW = '.agent-dock-agent'

/** Moves focus within the list: ↑ ↓ one row, Home End the ends. Returns whether it moved. */
function roveRows(list: HTMLElement, from: Element | null, key: string): boolean {
	const rows = [...list.querySelectorAll<HTMLButtonElement>(ROW)]
	if (rows.length === 0) return false
	const at = from ? rows.indexOf(from as HTMLButtonElement) : -1
	const last = rows.length - 1
	const next =
		key === 'Home'
			? 0
			: key === 'End'
				? last
				: at < 0
					? key === 'ArrowUp'
						? last
						: 0
					: Math.max(0, Math.min(last, at + (key === 'ArrowDown' ? 1 : -1)))
	rows[next]?.focus()
	return true
}

/**
 * The overview in one of three layouts (story-only `#agent-dock[data-agents-variant]`, production
 * `two-lines` until Jakub picks): `two-lines` and `excerpt-column` group by project (dim `<h3>` per
 * repository, groups led by their most urgent agent), `by-state` groups by standing. One grid for the
 * whole list (groups, lists, rows are subgrids), so columns line up across headings.
 *
 * Each row is a button in a list item (one tab stop: roving tabindex) named by who, the state in
 * words and where (`crm-sync, needs you: question 12m, Okena, worktree`), described by its excerpt.
 */
export function AgentsDetail({
	snapshot,
	now,
	layout,
	current,
	keys,
	onCurrent,
	onOpen,
	onClose,
}: {
	snapshot: AgentDockSnapshot | null
	now: number
	layout: AgentsLayout
	/** The row that holds the list's tab stop (the last one focused or opened); null = the first. */
	current: string | null
	keys: MutableRefObject<DetailKeys | null>
	onCurrent(key: string): void
	onOpen(row: AgentRow, viaKeyboard: boolean): void
	onClose(): void
}) {
	const groups = agentOverview(snapshot, now, layout)
	const rows = groups.flatMap(group => group.rows)
	const stop = rows.some(row => row.key === current) ? current : (rows[0]?.key ?? null)
	const idBase = useId()

	// From the pane itself (⌘⇧J lands there): ↑ ↓ Home End go into the list.
	useKeys(keys, event => {
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !noModifiers(event)) return false
		if (event.target !== event.currentTarget) return false
		const list = event.currentTarget.querySelector<HTMLElement>('.agent-dock-agent-list')
		if (!list) return false
		const held = stop ? list.querySelector(`${ROW}[tabindex="0"]`) : null
		if (held && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
			;(held as HTMLElement).focus()
			return true
		}
		return roveRows(list, null, event.key)
	})

	const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !noModifiers(event)) return
		const from = (event.target as Element).closest(ROW)
		if (!from) return
		event.preventDefault()
		event.stopPropagation()
		roveRows(event.currentTarget, from, event.key)
	}

	return (
		<>
			<Header end={<CloseKey onClose={onClose} />}>
				<span className="agent-dock-title-kind">Agents</span>
				<span className="agent-dock-title-project">{agentsSummary(rows)}</span>
			</Header>
			<ScrollBody label="Agent list">
				<div className="agent-dock-agent-list" data-layout={layout} onKeyDown={onListKey}>
					{groups.map((group, index) => {
						const headingId = `${idBase}-group-${index}`
						return (
							<div key={group.id} className="agent-dock-agent-group" data-group={group.id}>
								<h3 id={headingId} className="agent-dock-agent-group-name">
									{group.heading}
								</h3>
								<ul className="agent-dock-agent-rows" aria-labelledby={headingId}>
									{group.rows.map(row => (
										<li key={row.key} className="agent-dock-agent-item">
											<AgentRowButton
												row={row}
												tabStop={row.key === stop}
												excerptId={`${idBase}-excerpt-${row.key}`}
												onFocus={() => onCurrent(row.key)}
												onOpen={viaKeyboard => onOpen(row, viaKeyboard)}
											/>
										</li>
									))}
								</ul>
							</div>
						)
					})}
				</div>
			</ScrollBody>
			<Footer
				hints={
					<>
						<Hint keys="↑↓">move</Hint>
						<Hint keys="↵">open</Hint>
						{closeHints}
					</>
				}
				note={null}
			/>
		</>
	)
}

/**
 * One agent: glyph (its kind or status tone), short name, the state in words and its age (waiting on
 * Jakub ages like its queue entry), where it runs (source, worktree or branch, PR #, subagents), and
 * the excerpt. All cells are always there; the layout places (or hides) them.
 */
function AgentRowButton({
	row,
	tabStop,
	excerptId,
	onFocus,
	onOpen,
}: {
	row: AgentRow
	tabStop: boolean
	excerptId: string
	onFocus(): void
	onOpen(viaKeyboard: boolean): void
}) {
	return (
		<button
			type="button"
			className="agent-dock-agent"
			data-agent-key={row.key}
			data-standing={row.standing}
			data-word={row.word}
			data-status={row.status}
			data-tone={row.tone}
			tabIndex={tabStop ? 0 : -1}
			aria-label={agentRowLabel(row)}
			aria-describedby={row.excerpt ? excerptId : undefined}
			title={[row.name, row.title, row.repo].filter(Boolean).join('\n')}
			onFocus={onFocus}
			onClick={event => onOpen(event.detail === 0)}
		>
			<span className="agent-dock-agent-glyph" data-tone={row.glyphTone} data-status={row.status} aria-hidden="true">
				{row.glyph}
			</span>
			<span className="agent-dock-agent-name">{row.name}</span>
			<span className="agent-dock-agent-project">{row.repo || 'No project'}</span>
			<span className="agent-dock-agent-word">{row.word}</span>
			<span className="agent-dock-agent-age">{row.age}</span>
			<span className="agent-dock-agent-where">{row.where.join(' · ')}</span>
			<span className="agent-dock-agent-excerpt" id={excerptId}>
				{row.excerpt}
			</span>
		</button>
	)
}
