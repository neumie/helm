import { useState } from 'react'
import type { DaemonStatus, DashboardActionId, DashboardItem } from '../api'
import { useRelativeTime } from '../hooks'
import { StatusBadge } from './StatusBadge'

type Tab = 'needs' | 'running' | 'queued' | 'archived'

interface Props {
	items: DashboardItem[]
	status: DaemonStatus | null
	selectedItemId: string | null
	onSelectItem: (id: string | null) => void
	onItemAction: (id: string, action: DashboardActionId) => void
	projects: string[]
	selectedProject: string | null
	onProjectChange: (slug: string | null) => void
	projectColors: Record<string, string>
}

export interface WorkBuckets {
	needs: DashboardItem[]
	running: DashboardItem[]
	queued: DashboardItem[]
	archived: DashboardItem[]
}

export interface WorkAttentionCounts {
	running: number
	needsYou: number
}

const NEEDS_YOU = new Set(['review', 'failed'])
const QUEUED = new Set(['planned', 'queued', 'unverified'])

export function partitionWorkEntries(items: DashboardItem[]): WorkBuckets {
	return {
		needs: items.filter(i => NEEDS_YOU.has(i.status)),
		running: items.filter(i => i.status === 'processing'),
		queued: items.filter(i => QUEUED.has(i.status)),
		archived: items.filter(i => !NEEDS_YOU.has(i.status) && i.status !== 'processing' && !QUEUED.has(i.status)),
	}
}

export function workAttentionCounts(items: DashboardItem[]): WorkAttentionCounts {
	return {
		running: items.filter(i => i.status === 'processing').length,
		needsYou: items.filter(i => NEEDS_YOU.has(i.status)).length,
	}
}

export function itemMetaLabels(item: DashboardItem): string[] {
	return [item.projectSlug, item.kind, ...(item.group ? [item.group.label] : [])]
}

/** Most meaningful timestamp to age, by state. */
function rowTimestamp(item: DashboardItem): string {
	if (item.status === 'processing') return item.startedAt ?? item.queuedAt ?? item.createdAt
	if (NEEDS_YOU.has(item.status)) return item.completedAt ?? item.updatedAt
	if (QUEUED.has(item.status)) return item.queuedAt ?? item.createdAt
	return item.completedAt ?? item.updatedAt
}

export function TaskList({
	items,
	selectedItemId,
	onSelectItem,
	onItemAction,
	projects,
	selectedProject,
	onProjectChange,
	projectColors,
}: Props) {
	const { needs, running, queued, archived } = partitionWorkEntries(items)
	const [tab, setTab] = useState<Tab>('needs')

	const tabItems: { key: Tab; label: string; count: number; attention?: boolean }[] = [
		{ key: 'needs', label: 'Needs you', count: needs.length, attention: true },
		{ key: 'running', label: 'Running', count: running.length },
		{ key: 'queued', label: 'Queued', count: queued.length },
		{ key: 'archived', label: 'Archived', count: archived.length },
	]

	const visibleItems = tab === 'needs' ? needs : tab === 'running' ? running : tab === 'queued' ? queued : archived

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
					<select
						value={selectedProject ?? ''}
						onChange={e => onProjectChange(e.target.value || null)}
						style={{
							width: '100%',
							padding: '5px 8px',
							background: 'var(--bg-0)',
							border: '1px solid var(--border)',
							borderRadius: 'var(--radius-sm)',
							color: 'var(--text-1)',
							fontSize: 12,
							fontFamily: 'var(--font-sans)',
							outline: 'none',
							cursor: 'pointer',
						}}
					>
						<option value="">All projects</option>
						{projects.map(p => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
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
							onAction={onItemAction}
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
				padding: '12px 0',
				background: 'none',
				border: 'none',
				borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
				color: active ? 'var(--text-0)' : 'var(--text-3)',
				cursor: 'pointer',
				fontSize: 12,
				fontFamily: 'var(--font-sans)',
				fontWeight: 500,
				transition: 'color 150ms',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				gap: 5,
			}}
		>
			{children}
			{count > 0 && (
				<span
					style={{
						fontSize: 10,
						fontWeight: 700,
						minWidth: 16,
						padding: '1px 5px',
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

function ItemRow({
	item,
	selected,
	onClick,
	onAction,
	projectColor,
}: {
	item: DashboardItem
	selected: boolean
	onClick: () => void
	onAction: (id: string, action: DashboardActionId) => void
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
				gap: 5,
				padding: '10px 16px',
				borderBottom: '1px solid var(--border)',
				cursor: 'pointer',
				background: selected ? 'var(--bg-2)' : 'transparent',
				borderLeft: `3px solid ${selected ? 'var(--accent)' : (projectColor ?? 'transparent')}`,
				transition: 'background 150ms',
			}}
			onMouseEnter={e => {
				if (!selected) e.currentTarget.style.background = 'var(--bg-2)'
			}}
			onMouseLeave={e => {
				if (!selected) e.currentTarget.style.background = 'transparent'
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
				{item.card.pulse && (
					<span
						className="vg-pulse"
						style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--blue)', flexShrink: 0 }}
					/>
				)}
				{itemMetaLabels(item).map((label, index) => (
					<span
						key={`${item.id}-meta-${index}`}
						style={{
							fontSize: 10,
							color: 'var(--text-4)',
							textTransform: index === 1 ? 'uppercase' : undefined,
							fontWeight: index === 1 ? 600 : 500,
						}}
					>
						{label}
					</span>
				))}
				<span style={{ fontSize: 10, color: 'var(--text-4)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
					{age ?? ''}
				</span>
			</div>

			<div
				style={{
					fontSize: 13,
					color: selected ? 'var(--text-0)' : 'var(--text-1)',
					lineHeight: 1.4,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
				}}
			>
				{item.title}
			</div>

			{failure?.text && (
				<div
					style={{
						fontSize: 11,
						color: failure.tone,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
				>
					{failure.text}
				</div>
			)}

			<div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
				<StatusBadge value={item.card.statusLabel} tone={item.card.statusTone} />
				{item.links.pr?.url && <RowLink href={item.links.pr.url} label="PR ↗" tone="var(--green)" />}
				{item.links.source?.url && <RowLink href={item.links.source.url} label="source ↗" tone="var(--text-3)" />}
				<span style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
					{item.allowedActions.map(action => (
						<button
							key={action.id}
							type="button"
							onClick={e => {
								e.stopPropagation()
								onAction(item.id, action.id)
							}}
							style={{
								fontSize: 10,
								fontWeight: 600,
								padding: '2px 7px',
								borderRadius: 'var(--radius-sm)',
								border: '1px solid var(--border)',
								cursor: 'pointer',
								background: action.tone === 'primary' ? 'var(--accent-dim)' : 'transparent',
								color:
									action.tone === 'danger'
										? 'var(--red)'
										: action.tone === 'primary'
											? 'var(--accent)'
											: 'var(--text-3)',
							}}
						>
							{action.label}
						</button>
					))}
				</span>
			</div>
		</div>
	)
}

function RowLink({ href, label, tone }: { href: string; label: string; tone: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			onClick={e => e.stopPropagation()}
			style={{ fontSize: 10, fontWeight: 600, color: tone, textDecoration: 'none' }}
		>
			{label}
		</a>
	)
}
