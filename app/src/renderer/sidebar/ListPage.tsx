// Work list page — header row (project scope, New item, overflow; infrequent
// organization choices live inside More), lifecycle text index with counts
// (§3.2), balanced 64px rows (§3.3). Selection
// is the action: a row push-navigates to detail. Undecided Queue rows expose
// two permanently visible ownership choices (agent/manual). Renders purely
// from the pushed snapshot — no per-row fetches.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardItem, HelmSnapshot, ProfilesDocument } from '../../shared-helm'
import { ActivityIndicator } from '../activity-indicator'
import { showToast } from '../toast'
import type { BucketKey } from './model'
import {
	VERDICT_META,
	colorForProject,
	groupItemsByProject,
	itemTitle,
	partitionWork,
	planStatusLabel,
	projectLabel,
	relativeTime,
	rowTimestamp,
	statusWord,
	useNow,
} from './model'
import { Chip, EmptyState, GLYPH, IconBtn, MenuButton, ProjectColorText, Segmented } from './ui'

const BUCKET_KEY = 'helm.sidebar.bucket'
const PROJECT_KEY = 'helm.sidebar.project'
const ORGANIZATION_KEY = 'helm.sidebar.organization'

type ListOrganization = 'flat' | 'project'
type ProjectFilter = { kind: 'all' } | { kind: 'unassigned' } | { kind: 'project'; slug: string }

function readProjectFilter(): ProjectFilter {
	const saved = localStorage.getItem(PROJECT_KEY)
	if (!saved) return { kind: 'all' }
	try {
		const parsed = JSON.parse(saved) as { kind?: unknown; slug?: unknown }
		if (parsed.kind === 'unassigned') return { kind: 'unassigned' }
		if (parsed.kind === 'project' && typeof parsed.slug === 'string' && parsed.slug) {
			return { kind: 'project', slug: parsed.slug }
		}
	} catch {
		// Legacy versions persisted the project slug directly.
		return { kind: 'project', slug: saved }
	}
	return { kind: 'all' }
}

function isBucket(value: string | null): value is BucketKey {
	return value === 'needs' || value === 'active' || value === 'queue' || value === 'inbox'
}

function isListOrganization(value: string | null): value is ListOrganization {
	return value === 'flat' || value === 'project'
}

const EMPTY_COPY: Record<BucketKey, { title: string; detail: string }> = {
	needs: { title: 'Nothing needs you', detail: 'Runs in review and failures land here.' },
	active: { title: 'Nothing active', detail: 'Agent runs and work you take manually appear here.' },
	queue: { title: 'Queue is empty', detail: 'Items waiting for an agent or manual owner appear here.' },
	inbox: { title: 'Inbox is empty', detail: 'New provider tasks land here automatically.' },
}

export interface ListPageProps {
	snapshot: HelmSnapshot | null
	onOpenItem: (id: string) => void
	onNewItem: () => void
	onOpenArchive: () => void
	onOpenProfiles: () => void
	onOpenScheduledRuns: () => void
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
	onOpenItem,
	onNewItem,
	onOpenArchive,
	onOpenProfiles,
	onOpenScheduledRuns,
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
	const [projectFilter, setProjectFilter] = useState<ProjectFilter>(readProjectFilter)
	const [organization, setOrganization] = useState<ListOrganization>(() => {
		if (window.helm.uiPreview === 'project-list') return 'project'
		const saved = localStorage.getItem(ORGANIZATION_KEY)
		return isListOrganization(saved) ? saved : 'flat'
	})
	const [quickBusy, setQuickBusy] = useState<string | null>(null)
	const [profileDocument, setProfileDocument] = useState<ProfilesDocument | null>(null)
	useEffect(() => localStorage.setItem(BUCKET_KEY, bucket), [bucket])
	useEffect(() => {
		if (projectFilter.kind === 'all') localStorage.removeItem(PROJECT_KEY)
		else localStorage.setItem(PROJECT_KEY, JSON.stringify(projectFilter))
	}, [projectFilter])
	useEffect(() => localStorage.setItem(ORGANIZATION_KEY, organization), [organization])
	useEffect(() => {
		let cancelled = false
		const load = () => {
			void window.helm.profiles.list().then(result => {
				if (!cancelled && result.data) setProfileDocument(result.data)
			})
		}
		load()
		const unsubscribe = window.helm.profiles.onChanged(load)
		return () => {
			cancelled = true
			unsubscribe()
		}
	}, [])

	const now = useNow()
	const items = snapshot?.items ?? null
	const reachable = snapshot?.reachable ?? false
	const paused = snapshot?.status?.queue.paused ?? false

	const selectedProjectSlug = projectFilter.kind === 'project' ? projectFilter.slug : null
	const selectedProjectColor = colorForProject(snapshot?.config, selectedProjectSlug)
	const projectSlugs = useMemo(() => {
		const fromConfig = (snapshot?.config?.projects ?? []).map(p => p.slug)
		const fromItems = (items ?? []).map(i => i.projectSlug).filter((slug): slug is string => slug !== null)
		return [...new Set([...fromConfig, ...fromItems])]
	}, [snapshot?.config?.projects, items])

	const filtered = useMemo(() => {
		if (projectFilter.kind === 'all') return items ?? []
		if (projectFilter.kind === 'unassigned') return (items ?? []).filter(item => item.projectSlug === null)
		return (items ?? []).filter(item => item.projectSlug === projectFilter.slug)
	}, [items, projectFilter])
	const buckets = useMemo(() => partitionWork(filtered), [filtered])
	const visible = archive ? buckets.archived : buckets[bucket]
	const groupedVisible = useMemo(() => groupItemsByProject(visible), [visible])

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
	const switchProfile = (profileId: string) =>
		runQuick(`profile:${profileId}`, async () => {
			const result = await window.helm.profiles.activate(profileId)
			if (result.error !== undefined) showToast({ message: result.error })
		})
	const availableProfiles = profileDocument?.profiles.filter(profile => profile.archivedAt === null) ?? []
	const activeProfileId = profileDocument?.activeProfileId ?? snapshot?.status?.profile?.id

	const renderItemRow = (item: DashboardItem) => (
		<ItemRow
			key={item.id}
			item={item}
			projectColor={colorForProject(snapshot?.config, item.projectSlug)}
			time={relativeTime(rowTimestamp(item), now)}
			onOpen={onOpenItem}
			quickDisabled={quickBusy !== null || !reachable}
			onStartAgent={id => runQuick(`agent:${id}`, () => onStartAgent(id))}
			onWorkManually={id => runQuick(`manual:${id}`, () => onWorkManually(id))}
		/>
	)

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
								<ProjectColorText color={selectedProjectColor} className="project-trigger-label">
									{projectFilter.kind === 'all'
										? 'All projects'
										: projectFilter.kind === 'unassigned'
											? 'Unassigned'
											: projectFilter.slug}
								</ProjectColorText>
								{GLYPH.chevronDown}
							</>
						}
						entries={[
							{
								label: 'All projects',
								checked: projectFilter.kind === 'all',
								onSelect: () => setProjectFilter({ kind: 'all' }),
							},
							{
								label: 'Unassigned',
								checked: projectFilter.kind === 'unassigned',
								onSelect: () => setProjectFilter({ kind: 'unassigned' }),
							},
							...projectSlugs.map(slug => ({
								label: slug,
								checked: projectFilter.kind === 'project' && projectFilter.slug === slug,
								onSelect: () => setProjectFilter({ kind: 'project', slug }),
							})),
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
								{
									label: 'Scheduled runs',
									icon: GLYPH.calendar,
									section: 'Work',
									onSelect: onOpenScheduledRuns,
								},
								{
									label: 'Archive',
									icon: GLYPH.archive,
									meta: buckets.archived.length || undefined,
									onSelect: onOpenArchive,
								},
								{
									label: 'Poll now',
									icon: GLYPH.retry,
									onSelect: onPoll,
									disabled: !reachable,
								},
								{
									label: paused ? 'Resume queue' : 'Pause queue',
									icon: paused ? GLYPH.play : GLYPH.pause,
									onSelect: onPauseToggle,
									disabled: !reachable,
								},
								{
									label: 'Group by project',
									checked: organization === 'project',
									checkedRole: 'checkbox',
									section: 'View',
									onSelect: () => setOrganization(organization === 'project' ? 'flat' : 'project'),
								},
								...availableProfiles.map((profile, index) => ({
									label: profile.name,
									checked: profile.id === activeProfileId,
									section: index === 0 ? 'Profiles' : undefined,
									onSelect: () => {
										if (profile.id !== activeProfileId) void switchProfile(profile.id)
									},
									disabled: quickBusy !== null,
								})),
								{
									label: 'Manage profiles…',
									section: availableProfiles.length === 0 ? 'Profiles' : undefined,
									onSelect: onOpenProfiles,
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
						variant="index"
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
				) : organization === 'project' && !archive ? (
					groupedVisible.map(({ projectSlug, items: group }, index) => (
						<section
							className="item-project-group"
							aria-labelledby={`item-project-group-${index}`}
							key={projectSlug === null ? 'drafts:unassigned' : `project:${projectSlug}`}
						>
							<div className="item-project-group-head" id={`item-project-group-${index}`}>
								<ProjectColorText color={colorForProject(snapshot?.config, projectSlug)}>
									{projectLabel(projectSlug)}
								</ProjectColorText>
								<span>{group.length === 1 ? '1 item' : `${group.length} items`}</span>
							</div>
							{group.map(renderItemRow)}
						</section>
					))
				) : (
					visible.map(renderItemRow)
				)}
			</div>
		</div>
	)
}

// 64px row (§3.3): title + trailing time; a running Item places the shared
// ActivityIndicator before its title. The meta line carries mixed lifecycle
// words for Needs/Archive, the colored project slug, and ONE marker (planning
// progress, ownership, or a text-only verdict chip). No persistent selected
// state — push navigation means the list is never visible beside a detail.
// Memoized — re-renders only when the row's item or time changes.
const ItemRow = memo(function ItemRow({
	item,
	projectColor,
	time,
	onOpen,
	quickDisabled,
	onStartAgent,
	onWorkManually,
}: {
	item: DashboardItem
	projectColor: string | null
	time: string
	onOpen: (id: string) => void
	quickDisabled: boolean
	onStartAgent: (id: string) => Promise<void>
	onWorkManually: (id: string) => Promise<void>
}) {
	const verdict = item.assessment ? VERDICT_META[item.assessment.verdict] : null
	const showQuickActions = item.status === 'ready' && item.workMode === null && item.projectSlug !== null
	const planningStatus = planStatusLabel(item)
	const word = statusWord(item.status)
	// "Running" already implies the agent owns it — a second "Agent" marker is noise.
	const mode = item.status === 'running' ? null : item.workMode
	return (
		<div className={`item-row-shell${showQuickActions ? ' item-row-shell-actions' : ''}`}>
			<button type="button" data-item-id={item.id} className="item-row" onClick={() => onOpen(item.id)}>
				<div className="item-row-line1">
					{item.status === 'running' && <ActivityIndicator label="Running" />}
					<span className="item-row-title">{itemTitle(item)}</span>
					<span className="item-row-time">{time}</span>
				</div>
				<div className="item-row-line2">
					{word ? <span className={`item-row-status tone-${word.tone}`}>{word.label}</span> : null}
					<ProjectColorText color={projectColor} className="item-row-project">
						{projectLabel(item.projectSlug)}
					</ProjectColorText>
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
							{verdict.label}
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
