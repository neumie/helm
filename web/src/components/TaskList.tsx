import { useState } from 'react'
import type { DaemonStatus, TaskRecord } from '../api'
import { useRelativeTime } from '../hooks'
import { StatusBadge } from './StatusBadge'

type Tab = 'active' | 'queued' | 'archived'

interface Props {
	tasks: TaskRecord[]
	status: DaemonStatus | null
	selectedId: string | null
	onSelect: (id: string | null) => void
	projects: string[]
	selectedProject: string | null
	onProjectChange: (slug: string | null) => void
	projectColors: Record<string, string>
}

export function TaskList({
	tasks,
	status,
	selectedId,
	onSelect,
	projects,
	selectedProject,
	onProjectChange,
	projectColors,
}: Props) {
	const [tab, setTab] = useState<Tab>('queued')

	const active = tasks.filter(t => t.status === 'processing' || t.status === 'failed' || t.status === 'review')
	const queued = tasks.filter(t => t.status === 'queued')
	const archived = tasks.filter(t => !['processing', 'failed', 'review', 'queued'].includes(t.status))

	const tabItems: { key: Tab; label: string; count: number }[] = [
		{ key: 'active', label: 'Active', count: active.length },
		{ key: 'queued', label: 'Queued', count: queued.length },
		{ key: 'archived', label: 'Archived', count: archived.length },
	]

	const visibleTasks = tab === 'active' ? active : tab === 'queued' ? queued : archived

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

			{/* Task list */}
			<div style={{ flex: 1, overflow: 'auto' }}>
				{visibleTasks.length === 0 ? (
					<p style={{ color: 'var(--text-4)', padding: '24px 16px', fontSize: 13, textAlign: 'center' }}>
						No {tab} tasks.
					</p>
				) : (
					visibleTasks.map(t => (
						<TaskRow
							key={t.id}
							task={t}
							selected={t.id === selectedId}
							onClick={() => onSelect(t.id)}
							projectColor={projectColors[t.projectSlug]}
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

function TaskRow({
	task,
	selected,
	onClick,
	projectColor,
}: {
	task: TaskRecord
	selected: boolean
	onClick: () => void
	projectColor?: string
}) {
	const elapsed = useRelativeTime(task.startedAt)

	return (
		<div
			onClick={onClick}
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: 4,
				padding: '10px 16px',
				borderBottom: '1px solid var(--border)',
				cursor: 'pointer',
				background: selected ? 'var(--bg-2)' : 'transparent',
				borderLeft: `3px solid ${projectColor ?? 'transparent'}`,
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
				<span style={{ fontSize: 10, color: projectColor ?? 'var(--text-4)', fontWeight: 500 }}>
					{task.projectSlug}
				</span>
				<span style={{ fontSize: 10, color: 'var(--text-4)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
					{elapsed ?? formatTime(task.queuedAt)}
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
				{task.title}
			</div>
			<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
				<StatusBadge value={task.status} type="status" />
				{task.tier && <StatusBadge value={task.tier} type="tier" />}
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
