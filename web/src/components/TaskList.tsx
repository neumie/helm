import { useState } from 'react'
import type { AssessmentVerdict, DaemonStatus, DashboardItem } from '../api'
import { useRelativeTime } from '../hooks'
import { TONE_COLOR, TONE_DIM, VERDICT_META } from '../verdict'
import { Select } from './Select'

type Tab = 'needs' | 'running' | 'ready' | 'triage' | 'archived'

interface Props {
	items: DashboardItem[]
	status: DaemonStatus | null
	selectedItemId: string | null
	onSelectItem: (id: string | null) => void
	projects: string[]
	selectedProject: string | null
	onProjectChange: (slug: string | null) => void
	projectColors: Record<string, string>
}

export interface WorkBuckets {
	needs: DashboardItem[]
	running: DashboardItem[]
	ready: DashboardItem[]
	triage: DashboardItem[]
	archived: DashboardItem[]
}

export interface WorkAttentionCounts {
	running: number
	needsYou: number
}

// `review` + `failed` are the "needs you" pile. `triage` is the noisy provider
// inbox awaiting your go/no-go; `ready` is the approved list the drainer will run.
const NEEDS_YOU = new Set(['review', 'failed'])

export function partitionWorkEntries(items: DashboardItem[]): WorkBuckets {
	return {
		needs: items.filter(i => NEEDS_YOU.has(i.status)),
		running: items.filter(i => i.status === 'running'),
		ready: items.filter(i => i.status === 'ready'),
		triage: items.filter(i => i.status === 'triage'),
		archived: items.filter(
			i => !NEEDS_YOU.has(i.status) && i.status !== 'running' && i.status !== 'ready' && i.status !== 'triage',
		),
	}
}

export function workAttentionCounts(items: DashboardItem[]): WorkAttentionCounts {
	return {
		running: items.filter(i => i.status === 'running').length,
		needsYou: items.filter(i => NEEDS_YOU.has(i.status)).length,
	}
}

export function itemMetaLabels(item: DashboardItem): string[] {
	return [item.projectSlug, item.kind, ...(item.group ? [item.group.label] : [])]
}

/** Most meaningful timestamp to age, by state. */
function rowTimestamp(item: DashboardItem): string {
	if (item.status === 'running') return item.startedAt ?? item.queuedAt ?? item.createdAt
	if (NEEDS_YOU.has(item.status)) return item.completedAt ?? item.updatedAt
	if (item.status === 'ready') return item.queuedAt ?? item.createdAt
	return item.completedAt ?? item.updatedAt
}

export function TaskList({
	items,
	selectedItemId,
	onSelectItem,
	projects,
	selectedProject,
	onProjectChange,
	projectColors,
}: Props) {
	const { needs, running, ready, triage, archived } = partitionWorkEntries(items)
	const [tab, setTab] = useState<Tab>('needs')

	// Four primary tabs share the width; Archived is demoted to a compact icon
	// toggle at the row's end so the bar isn't cramped (it's the rarely-used pile).
	const tabItems: { key: Tab; label: string; count: number; attention?: boolean }[] = [
		{ key: 'needs', label: 'Needs', count: needs.length, attention: true },
		{ key: 'running', label: 'Running', count: running.length },
		{ key: 'ready', label: 'Ready', count: ready.length },
		{ key: 'triage', label: 'Triage', count: triage.length },
	]

	const byTab: Record<Tab, DashboardItem[]> = { needs, running, ready, triage, archived }
	const visibleItems = byTab[tab]

	return (
		<aside
			style={{
				width: 380,
				borderRight: '1px solid var(--border)',
				background: 'var(--bg-1)',
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
				flexShrink: 0,
			}}
		>
			{projects.length > 1 && (
				<div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
					<Select
						value={selectedProject ?? ''}
						options={[{ value: '', label: 'All projects' }, ...projects.map(p => ({ value: p, label: p }))]}
						fullWidth
						ariaLabel="Filter by project"
						onChange={v => onProjectChange(v || null)}
					/>
				</div>
			)}

			<div style={{ display: 'flex', background: 'var(--bg-1)', borderBottom: '1px solid var(--border)' }}>
				{tabItems.map(t => (
					<TabButton
						key={t.key}
						active={tab === t.key}
						count={t.count}
						attention={t.attention && t.count > 0}
						onClick={() => setTab(t.key)}
					>
						{t.label}
					</TabButton>
				))}
				<ArchiveTab active={tab === 'archived'} count={archived.length} onClick={() => setTab('archived')} />
			</div>

			<div style={{ flex: 1, overflow: 'auto' }}>
				{visibleItems.length === 0 ? (
					<p style={{ color: 'var(--text-4)', padding: '24px 16px', fontSize: 13, textAlign: 'center' }}>
						{tab === 'needs' ? 'Nothing needs you. 🎉' : `No ${tab} work.`}
					</p>
				) : (
					visibleItems.map(item => (
						<ItemRow
							key={item.id}
							item={item}
							selected={item.id === selectedItemId}
							onClick={() => onSelectItem(item.id)}
							projectColor={projectColors[item.projectSlug]}
						/>
					))
				)}
			</div>

			<a
				href="/settings"
				style={{
					display: 'block',
					padding: '10px 16px',
					borderTop: '1px solid var(--border)',
					color: 'var(--text-4)',
					textDecoration: 'none',
					fontSize: 12,
					fontWeight: 500,
					flexShrink: 0,
				}}
			>
				Settings
			</a>
		</aside>
	)
}

function TabButton({
	active,
	count,
	attention,
	onClick,
	children,
}: {
	active: boolean
	count: number
	attention?: boolean
	onClick: () => void
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				flex: 1,
				minWidth: 0,
				padding: '13px 6px',
				background: 'none',
				border: 'none',
				borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
				color: active ? 'var(--text-0)' : 'var(--text-3)',
				cursor: 'pointer',
				fontSize: 12.5,
				fontFamily: 'var(--font-sans)',
				fontWeight: 500,
				transition: 'color 150ms',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				gap: 4,
				whiteSpace: 'nowrap',
			}}
		>
			{children}
			{count > 0 && (
				<span
					style={{
						fontSize: 10,
						fontWeight: 700,
						minWidth: 15,
						padding: '1px 4px',
						borderRadius: 8,
						color: attention ? '#fff' : active ? 'var(--accent)' : 'var(--text-4)',
						background: attention ? 'var(--red)' : 'transparent',
						fontVariantNumeric: 'tabular-nums',
					}}
				>
					{count}
				</span>
			)}
		</button>
	)
}

/** Compact icon-only toggle for the Archived pile — keeps the primary tab row uncramped. */
function ArchiveTab({ active, count, onClick }: { active: boolean; count: number; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={`Archived${count ? ` (${count})` : ''}`}
			aria-label={`Archived${count ? ` (${count})` : ''}`}
			aria-pressed={active}
			style={{
				position: 'relative',
				flexShrink: 0,
				width: 42,
				padding: '12px 0',
				background: 'none',
				border: 'none',
				borderLeft: '1px solid var(--border)',
				borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
				color: active ? 'var(--text-0)' : 'var(--text-4)',
				cursor: 'pointer',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				transition: 'color 150ms',
			}}
		>
			{/* archive box */}
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<rect width="20" height="5" x="2" y="3" rx="1" />
				<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
				<path d="M10 12h4" />
			</svg>
			{count > 0 && (
				<span
					style={{
						position: 'absolute',
						transform: 'translate(11px, -9px)',
						fontSize: 9,
						fontWeight: 700,
						color: active ? 'var(--accent)' : 'var(--text-4)',
						fontVariantNumeric: 'tabular-nums',
					}}
				>
					{count}
				</span>
			)}
		</button>
	)
}

function ItemRow({
	item,
	selected,
	onClick,
	projectColor,
}: {
	item: DashboardItem
	selected: boolean
	onClick: () => void
	projectColor?: string
}) {
	const age = useRelativeTime(rowTimestamp(item))
	const messyRun = item.runOutcome === 'errored' || item.runOutcome === 'no_result'
	// Red error line on a hard failure; amber "verify" hint on a reconciled
	// review item (run was messy but shippable work was found).
	const failure =
		item.status === 'failed'
			? { text: item.errorMessage, tone: 'var(--red)' }
			: item.status === 'review' && messyRun
				? { text: '⚠ run errored — verify the branch/PR', tone: 'var(--amber)' }
				: null
	return (
		<div
			// biome-ignore lint/a11y/useSemanticElements: rich block row with nested action buttons; role+keyboard give it accessible button behavior without nesting buttons in a button
			role="button"
			tabIndex={0}
			onClick={onClick}
			onKeyDown={e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault()
					onClick()
				}
			}}
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: 6,
				padding: '11px 14px',
				borderBottom: '1px solid var(--border)',
				cursor: 'pointer',
				background: selected ? 'var(--bg-2)' : 'transparent',
				borderLeft: `3px solid ${selected ? 'var(--accent)' : 'transparent'}`,
				transition: 'background 150ms',
			}}
			onMouseEnter={e => {
				if (!selected) e.currentTarget.style.background = 'var(--bg-2)'
			}}
			onMouseLeave={e => {
				if (!selected) e.currentTarget.style.background = 'transparent'
			}}
		>
			{/* Meta: project dot (project color) + project + kind chip + group, age right */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
				<span
					className={item.card.pulse ? 'vg-pulse' : undefined}
					title={item.projectSlug}
					style={{
						width: 8,
						height: 8,
						borderRadius: '50%',
						flexShrink: 0,
						background: projectColor ?? 'var(--text-4)',
					}}
				/>
				<span
					style={{
						fontSize: 10,
						fontWeight: 600,
						color: 'var(--text-4)',
						textTransform: 'uppercase',
						letterSpacing: '0.04em',
					}}
				>
					{item.projectSlug}
				</span>
				<span
					style={{
						fontSize: 10,
						fontWeight: 600,
						color: TONE_COLOR[item.card.statusTone],
						textTransform: 'uppercase',
						letterSpacing: '0.04em',
					}}
				>
					{item.card.statusLabel}
				</span>
				{item.card.pulse && <span className="vg-spin" aria-hidden="true" />}
				{item.assessment && <VerdictChip verdict={item.assessment.verdict} />}
				{item.group && (
					<span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-4)' }}>{item.group.label}</span>
				)}
				<span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--font-mono)' }}>
					{age ?? ''}
				</span>
			</div>

			{/* Title */}
			<div
				style={{
					fontSize: 13,
					fontWeight: 500,
					color: selected ? 'var(--text-0)' : 'var(--text-1)',
					lineHeight: 1.4,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
				}}
			>
				{item.displayName ?? item.title}
			</div>

			{failure?.text && (
				<div
					style={{
						fontSize: 10,
						color: failure.tone,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
				>
					{failure.text}
				</div>
			)}

			{/* No footer links — the sidebar row is pure navigation; source/PR/deploy
			    live in the detail pane. */}
			{/* Indeterminate "AI working" bar while the agent is running. */}
			{item.card.pulse && <div className="vg-progress" style={{ marginTop: 4 }} aria-hidden="true" />}
		</div>
	)
}

/** Compact pre-solve intent verdict pill — surfaces clarity/security at a glance in the inbox. */
function VerdictChip({ verdict }: { verdict: AssessmentVerdict }) {
	const m = VERDICT_META[verdict]
	return (
		<span
			title={`Intent verdict: ${m.label}`}
			style={{
				fontSize: 9.5,
				fontWeight: 700,
				color: TONE_COLOR[m.tone],
				background: TONE_DIM[m.tone],
				padding: '1px 6px',
				borderRadius: 999,
				letterSpacing: '0.03em',
				whiteSpace: 'nowrap',
				display: 'inline-flex',
				alignItems: 'center',
				gap: 3,
			}}
		>
			{m.icon} {m.label}
		</span>
	)
}
