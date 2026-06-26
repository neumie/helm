import { useState } from 'react'
import type { DaemonStatus, DashboardItem } from '../api'
import { StatusBadge } from './StatusBadge'

type Tab = 'active' | 'queued' | 'archived'

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
	active: DashboardItem[]
	queued: DashboardItem[]
	archived: DashboardItem[]
}

export interface WorkAttentionCounts {
	running: number
	waiting: number
}

export function partitionWorkEntries(items: DashboardItem[]): WorkBuckets {
	return {
		active: items.filter(i => i.status === 'processing' || i.status === 'failed' || i.status === 'review'),
		queued: items.filter(i => i.status === 'planned' || i.status === 'queued' || i.status === 'unverified'),
		archived: items.filter(
			i => !['processing', 'failed', 'review', 'planned', 'queued', 'unverified'].includes(i.status),
		),
	}
}

export function workAttentionCounts(items: DashboardItem[]): WorkAttentionCounts {
	const buckets = partitionWorkEntries(items)
	return {
		running: items.filter(i => i.status === 'processing').length,
		waiting: buckets.queued.length,
	}
}

export function itemMetaLabels(item: DashboardItem): string[] {
	return [item.projectSlug, item.kind, ...(item.group ? [item.group.label] : [])]
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
	const [tab, setTab] = useState<Tab>('queued')
	const { active, queued, archived } = partitionWorkEntries(items)

	const tabItems: { key: Tab; label: string; count: number }[] = [
		{ key: 'active', label: 'Active', count: active.length },
		{ key: 'queued', label: 'Queued', count: queued.length },
		{ key: 'archived', label: 'Archived', count: archived.length },
	]

	const visibleItems = tab === 'active' ? active : tab === 'queued' ? queued : archived

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
			{/* Project filter */}
			{projects.length > 1 && (
				<div
					style={{
						padding: '8px 12px',
						borderBottom: '1px solid var(--border)',
					}}
				>
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

			{/* Tabs */}
			<div
				style={{
					display: 'flex',
					background: 'var(--bg-1)',
					borderBottom: '1px solid var(--border)',
				}}
			>
				{tabItems.map(t => (
					<TabButton key={t.key} active={tab === t.key} count={t.count} onClick={() => setTab(t.key)}>
						{t.label}
					</TabButton>
				))}
			</div>

			{/* Item list */}
			<div style={{ flex: 1, overflow: 'auto' }}>
				{visibleItems.length === 0 ? (
					<p style={{ color: 'var(--text-4)', padding: '24px 16px', fontSize: 13, textAlign: 'center' }}>
						No {tab} work.
					</p>
				) : (
					visibleItems.map(item => (
						<ItemRow
							key={`item-${item.id}`}
							item={item}
							selected={item.id === selectedItemId}
							onClick={() => onSelectItem(item.id)}
							projectColor={projectColors[item.projectSlug]}
						/>
					))
				)}
			</div>

			{/* Settings link */}
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
	onClick,
	children,
}: {
	active: boolean
	count: number
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
						fontWeight: 600,
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
	const timestamp = item.queuedAt ?? item.createdAt

	return (
		<div
			// biome-ignore lint/a11y/useSemanticElements: item row mirrors task row rich block content with nested status/link fragments
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
				gap: 4,
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
				{itemMetaLabels(item).map((label, index) => (
					<span
						key={`${item.id}-meta-${index}`}
						style={{
							fontSize: 10,
							color: index === 0 ? (projectColor ?? 'var(--text-4)') : 'var(--text-4)',
							textTransform: index === 1 ? 'uppercase' : undefined,
							fontWeight: index === 0 ? 500 : 600,
						}}
					>
						{label}
					</span>
				))}
				<span style={{ fontSize: 10, color: 'var(--text-4)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
					{formatTime(timestamp)}
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
			<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
				<StatusBadge value={item.card.statusLabel} tone={item.card.statusTone} />
			</div>
		</div>
	)
}

function formatTime(iso: string): string {
	const d = new Date(iso)
	const now = new Date()
	const diffMs = now.getTime() - d.getTime()
	const diffMin = Math.floor(diffMs / 60000)
	const diffHr = Math.floor(diffMin / 60)
	const diffDays = Math.floor(diffHr / 24)

	if (diffMin < 1) return 'just now'
	if (diffMin < 60) return `${diffMin}m ago`
	if (diffHr < 24) return `${diffHr}h ago`
	if (diffDays === 1) return 'yesterday'
	if (diffDays < 7) return `${diffDays}d ago`
	return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
