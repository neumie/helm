// Work list page — header row (project filter menu, New item, overflow),
// segmented bucket filter with counts (§3.2), 48px rows (§3.3). Selection is
// the action: a row push-navigates to detail. Queue rows also expose two
// ownership choices (agent/manual) on hover or keyboard focus. Renders purely
// from the pushed snapshot — no per-row fetches.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardItem, HelmSnapshot } from '../../shared-helm'
import type { BucketKey } from './model'
import {
	VERDICT_META,
	itemTitle,
	partitionWork,
	planStatusLabel,
	relativeTime,
	rowTimestamp,
	statusTone,
	useNow,
} from './model'
import { Chip, EmptyState, GLYPH, IconBtn, MenuButton, Segmented, StatusDot } from './ui'

const BUCKET_KEY = 'helm.sidebar.bucket'
const PROJECT_KEY = 'helm.sidebar.project'

function isBucket(value: string | null): value is BucketKey {
	return value === 'needs' || value === 'active' || value === 'queue' || value === 'inbox'
}

const EMPTY_COPY: Record<BucketKey, { title: string; detail: string }> = {
	needs: { title: 'Nothing needs you', detail: 'Runs in review and failures land here.' },
	active: { title: 'Nothing active', detail: 'Agent runs and work you take manually appear here.' },
	queue: { title: 'Queue is empty', detail: 'Items waiting for an agent or manual owner appear here.' },
	inbox: { title: 'Inbox is empty', detail: 'New provider tasks land here automatically.' },
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
	onStartAgent: (id: string) => Promise<void>
	onWorkManually: (id: string) => Promise<void>
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
	onStartAgent,
	onWorkManually,
	archive,
}: ListPageProps) {
	const [bucket, setBucket] = useState<BucketKey>(() => {
		if (window.helm.uiPreview === 'queue-list') return 'queue'
		if (window.helm.uiPreview === 'planned-list') return 'active'
		const saved = localStorage.getItem(BUCKET_KEY)
		return isBucket(saved) ? saved : 'needs'
	})
	const [project, setProject] = useState<string | null>(() => localStorage.getItem(PROJECT_KEY) || null)
	const [quickBusy, setQuickBusy] = useState<string | null>(null)
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
	const runQuick = async (key: string, action: () => Promise<void>) => {
		if (quickBusy) return
		setQuickBusy(key)
		try {
			await action()
		} finally {
			setQuickBusy(null)
		}
	}

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
								{ label: 'Poll now', icon: GLYPH.retry, onSelect: onPoll, disabled: !reachable },
								{
									label: paused ? 'Resume queue' : 'Pause queue',
									icon: paused ? GLYPH.play : GLYPH.pause,
									onSelect: onPauseToggle,
									disabled: !reachable,
								},
								{
									label: buckets.archived.length > 0 ? `Archive (${buckets.archived.length})` : 'Archive',
									icon: GLYPH.archive,
									onSelect: onOpenArchive,
								},
								{ label: 'Settings', icon: GLYPH.settings, onSelect: onOpenSettings, group: true },
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
							{ value: 'inbox', label: 'Inbox', count: buckets.inbox.length },
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
							quickDisabled={quickBusy !== null || !reachable}
							onStartAgent={id => runQuick(`agent:${id}`, () => onStartAgent(id))}
							onWorkManually={id => runQuick(`manual:${id}`, () => onWorkManually(id))}
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
	quickDisabled,
	onStartAgent,
	onWorkManually,
}: {
	item: DashboardItem
	selected: boolean
	time: string
	onOpen: (id: string) => void
	quickDisabled: boolean
	onStartAgent: (id: string) => Promise<void>
	onWorkManually: (id: string) => Promise<void>
}) {
	const verdict = item.assessment ? VERDICT_META[item.assessment.verdict] : null
	const showQuickActions = item.status === 'ready' && item.workMode === null
	const planningStatus = ['inbox', 'ready', 'active'].includes(item.status) ? planStatusLabel(item) : null
	const mode = item.workMode
	return (
		<div className={`item-row-shell${showQuickActions ? ' item-row-shell-actions' : ''}`}>
			<button
				type="button"
				data-item-id={item.id}
				className={`item-row${selected ? ' item-row-selected' : ''}`}
				onClick={() => onOpen(item.id)}
			>
				<div className="item-row-line1">
					<StatusDot tone={statusTone(item.status)} pulse={item.card.pulse} />
					<span className="item-row-title">{itemTitle(item)}</span>
					<span className="item-row-time">{time}</span>
				</div>
				<div className="item-row-line2">
					<span className="item-row-project">{item.projectSlug}</span>
					{planningStatus ? (
						<span className="item-row-mode mode-manual" title="Planning readiness">
							{GLYPH.plan}
							{planningStatus}
						</span>
					) : mode ? (
						<span className={`item-row-mode mode-${mode}`}>
							{GLYPH[mode]}
							{mode === 'agent' ? 'Agent' : 'Manual'}
						</span>
					) : verdict ? (
						<Chip tone={verdict.tone} title={`Intent verdict: ${verdict.label}`}>
							{verdict.icon} {verdict.label}
						</Chip>
					) : null}
				</div>
			</button>
			{showQuickActions ? (
				<div className="item-row-actions" aria-label="Choose work owner">
					<IconBtn label="Work manually" disabled={quickDisabled} onClick={() => void onWorkManually(item.id)}>
						{GLYPH.manual}
					</IconBtn>
					<IconBtn
						label={item.kind === 'loop' ? 'Start loop' : 'Start agent'}
						disabled={quickDisabled}
						onClick={() => void onStartAgent(item.id)}
					>
						{GLYPH.agent}
					</IconBtn>
				</div>
			) : null}
		</div>
	)
})
