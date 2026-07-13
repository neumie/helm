// Work list page — header row (project filter menu, New item, overflow),
// segmented bucket filter with counts (§3.2), 48px rows (§3.3). Selection is
// the action: a row push-navigates to the detail page; no hover-revealed
// controls. Renders purely from the pushed snapshot — no per-row fetches.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardItem, HelmSnapshot } from '../../shared-helm'
import type { BucketKey } from './model'
import { VERDICT_META, itemTitle, partitionWork, relativeTime, rowTimestamp, statusTone, useNow } from './model'
import { Chip, EmptyState, GLYPH, IconBtn, MenuButton, Segmented, StatusDot } from './ui'

const BUCKET_KEY = 'helm.sidebar.bucket'
const PROJECT_KEY = 'helm.sidebar.project'

function isBucket(value: string | null): value is BucketKey {
	return value === 'needs' || value === 'active' || value === 'queue' || value === 'triage'
}

const EMPTY_COPY: Record<BucketKey, { title: string; detail: string }> = {
	needs: { title: 'Nothing needs you', detail: 'Runs in review and failures land here.' },
	active: { title: 'Nothing running', detail: 'Approve or start an item to run it.' },
	queue: { title: 'Queue is empty', detail: 'Approved items wait here for the next free lane.' },
	triage: { title: 'No items to triage', detail: 'New provider tasks land here after a poll.' },
}

export interface ListPageProps {
	snapshot: HelmSnapshot | null
	selectedId: string | null
	onOpenItem: (id: string) => void
	onNewItem: () => void
	onOpenArchive: () => void
	onOpenSettings: () => void
	onPoll: () => void
	onPauseToggle: () => void
	/** Archive mode reuses the page frame minus header controls. */
	archive?: boolean
}

export function ListPage({
	snapshot,
	selectedId,
	onOpenItem,
	onNewItem,
	onOpenArchive,
	onOpenSettings,
	onPoll,
	onPauseToggle,
	archive,
}: ListPageProps) {
	const [bucket, setBucket] = useState<BucketKey>(() => {
		const saved = localStorage.getItem(BUCKET_KEY)
		return isBucket(saved) ? saved : 'needs'
	})
	const [project, setProject] = useState<string | null>(() => localStorage.getItem(PROJECT_KEY) || null)
	useEffect(() => localStorage.setItem(BUCKET_KEY, bucket), [bucket])
	useEffect(() => {
		if (project) localStorage.setItem(PROJECT_KEY, project)
		else localStorage.removeItem(PROJECT_KEY)
	}, [project])

	const now = useNow()
	const items = snapshot?.items ?? null
	const reachable = snapshot?.reachable ?? false
	const paused = snapshot?.status?.queue.paused ?? false

	const projectSlugs = useMemo(() => {
		const fromConfig = (snapshot?.config?.projects ?? []).map(p => p.slug)
		const fromItems = (items ?? []).map(i => i.projectSlug)
		return [...new Set([...fromConfig, ...fromItems])]
	}, [snapshot?.config?.projects, items])

	const filtered = useMemo(
		() => (project ? (items ?? []).filter(i => i.projectSlug === project) : (items ?? [])),
		[items, project],
	)
	const buckets = useMemo(() => partitionWork(filtered), [filtered])
	const visible = archive ? buckets.archived : buckets[bucket]

	// Roving Up/Down focus between rows; Enter opens (native button behavior).
	const listRef = useRef<HTMLDivElement>(null)
	const onListKeyDown = (event: React.KeyboardEvent) => {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
		const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.item-row') ?? [])
		if (rows.length === 0) return
		const current = rows.indexOf(document.activeElement as HTMLButtonElement)
		const next = rows[Math.min(Math.max(current + (event.key === 'ArrowDown' ? 1 : -1), 0), rows.length - 1)]
		if (next) {
			event.preventDefault()
			next.focus()
		}
	}

	const waiting = items === null

	return (
		<div className="page-frame">
			{!archive && (
				<div className="list-toolbar">
					<MenuButton
						triggerClass="project-trigger"
						triggerLabel="Filter by project"
						align="start"
						trigger={
							<>
								<span className="project-trigger-label">{project ?? 'All projects'}</span>
								{GLYPH.chevronDown}
							</>
						}
						entries={[
							{ label: 'All projects', onSelect: () => setProject(null) },
							...projectSlugs.map(slug => ({ label: slug, onSelect: () => setProject(slug) })),
						]}
					/>
					<div className="list-toolbar-actions">
						<IconBtn label="New item" onClick={onNewItem}>
							{GLYPH.plus}
						</IconBtn>
						<MenuButton
							triggerLabel="More"
							trigger={GLYPH.ellipsis}
							entries={[
								{ label: 'Poll now', onSelect: onPoll, disabled: !reachable },
								{ label: paused ? 'Resume queue' : 'Pause queue', onSelect: onPauseToggle, disabled: !reachable },
								{
									label: buckets.archived.length > 0 ? `Archive (${buckets.archived.length})` : 'Archive',
									onSelect: onOpenArchive,
								},
								{ label: 'Settings', onSelect: onOpenSettings, group: true },
							]}
						/>
					</div>
				</div>
			)}

			{!archive && (
				<div className="list-filter">
					<Segmented<BucketKey>
						label="Work filter"
						value={bucket}
						onChange={setBucket}
						options={[
							{ value: 'needs', label: 'Needs', count: buckets.needs.length },
							{ value: 'active', label: 'Active', count: buckets.active.length },
							{ value: 'queue', label: 'Queue', count: buckets.queue.length },
							{ value: 'triage', label: 'Triage', count: buckets.triage.length },
						]}
					/>
				</div>
			)}

			{/* Plain container: rows are self-labeled buttons; Up/Down is roving focus. */}
			<div className="list-scroll" ref={listRef} onKeyDown={onListKeyDown}>
				{waiting ? (
					<EmptyState
						title="Waiting for the daemon"
						detail={reachable ? 'Loading work items.' : 'Start it with helm start.'}
					/>
				) : visible.length === 0 ? (
					archive ? (
						<EmptyState title="Archive is empty" detail="Done and cancelled items land here." />
					) : (
						<EmptyState title={EMPTY_COPY[bucket].title} detail={EMPTY_COPY[bucket].detail} />
					)
				) : (
					visible.map(item => (
						<ItemRow
							key={item.id}
							item={item}
							selected={item.id === selectedId}
							time={relativeTime(rowTimestamp(item), now)}
							onOpen={onOpenItem}
						/>
					))
				)}
			</div>
		</div>
	)
}

// 48px row (§3.3): dot + title + trailing time; meta line = project tag + one
// verdict chip. Memoized — re-renders only when the row's item or time changes.
const ItemRow = memo(function ItemRow({
	item,
	selected,
	time,
	onOpen,
}: {
	item: DashboardItem
	selected: boolean
	time: string
	onOpen: (id: string) => void
}) {
	const verdict = item.assessment ? VERDICT_META[item.assessment.verdict] : null
	return (
		<button type="button" className={`item-row${selected ? ' item-row-selected' : ''}`} onClick={() => onOpen(item.id)}>
			<div className="item-row-line1">
				<StatusDot tone={statusTone(item.status)} pulse={item.card.pulse} />
				<span className="item-row-title">{itemTitle(item)}</span>
				<span className="item-row-time">{time}</span>
			</div>
			<div className="item-row-line2">
				<span className="item-row-project">{item.projectSlug}</span>
				{verdict && (
					<Chip tone={verdict.tone} title={`Intent verdict: ${verdict.label}`}>
						{verdict.icon} {verdict.label}
					</Chip>
				)}
			</div>
		</button>
	)
})
