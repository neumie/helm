import { useEffect, useState } from 'react'
import { type TaskRecord, api } from '../api'
import { ActivityTimeline } from './ActivityTimeline'
import { LiveOutput } from './LiveOutput'
import { StatusBadge } from './StatusBadge'

interface Props {
	task: TaskRecord
	taskBaseUrl?: string
	onStart: () => void
	onRetry: () => void
	onCancel: () => void
	onSetStatus: (status: string) => void
	onDelete: () => void
}

interface PrStatus {
	state: string | null
	merged?: boolean
	mergedAt?: string
}

export function TaskDetail({ task, taskBaseUrl, onStart, onRetry, onCancel, onSetStatus, onDelete }: Props) {
	const files = task.filesChanged ? (JSON.parse(task.filesChanged) as string[]) : []
	const isActive = task.status === 'processing'
	const [prStatus, setPrStatus] = useState<PrStatus | null>(null)

	useEffect(() => {
		if (task.prUrl) {
			api
				.prStatus(task.id)
				.then(setPrStatus)
				.catch(() => {})
		} else {
			setPrStatus(null)
		}
	}, [task.id, task.prUrl])

	const branchUrl = task.prUrl ?? (task.branchName ? buildBranchUrl(task.prUrl, task.branchName) : null)

	return (
		<div style={{ maxWidth: 760, margin: '0 auto' }}>
			{/* Title */}
			<h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-0)', lineHeight: 1.4, marginBottom: 12 }}>
				{task.title}
			</h2>

			{/* Badges + links row */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
				<StatusBadge value={task.status} />

				<span style={{ flex: 1 }} />

				{taskBaseUrl && (
					<a
						href={`${taskBaseUrl}${task.externalId}`}
						target="_blank"
						rel="noreferrer"
						style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}
					>
						Source
					</a>
				)}
			</div>

			{/* Info line */}
			<div
				style={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: '4px 20px',
					fontSize: 12,
					color: 'var(--text-3)',
					marginBottom: 16,
				}}
			>
				<span>
					Project: <strong style={{ color: 'var(--text-1)', fontWeight: 500 }}>{task.projectSlug}</strong>
				</span>
				{task.branchName && (
					<span>
						Branch:{' '}
						{branchUrl ? (
							<a
								href={branchUrl}
								target="_blank"
								rel="noreferrer"
								style={{ color: 'var(--blue)', fontFamily: 'var(--font-mono)', fontSize: 11, textDecoration: 'none' }}
							>
								{task.branchName}
							</a>
						) : (
							<code style={{ color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
								{task.branchName}
							</code>
						)}
					</span>
				)}
			</div>

			{/* PR status */}
			{task.prUrl && (
				<div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, marginBottom: 24 }}>
					<a
						href={task.prUrl}
						target="_blank"
						rel="noreferrer"
						style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 500 }}
					>
						{formatPrLabel(task.prUrl)}
					</a>
					{prStatus && <PrBadge status={prStatus} />}
				</div>
			)}

			{/* Error */}
			{task.errorMessage && (
				<div
					style={{
						padding: '12px 16px',
						marginBottom: 24,
						borderRadius: 'var(--radius-sm)',
						background: 'var(--red-dim)',
						border: '1px solid color-mix(in srgb, var(--red) 25%, transparent)',
					}}
				>
					<div
						style={{ fontSize: 11, color: 'var(--red)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}
					>
						Error{task.errorPhase ? ` (${task.errorPhase})` : ''}
					</div>
					<div style={{ fontSize: 13, color: 'color-mix(in srgb, var(--red) 80%, white)', lineHeight: 1.5 }}>
						{task.errorMessage}
					</div>
				</div>
			)}

			{/* Actions */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 32 }}>
				{task.status === 'queued' && <ActionBtn label="Start" variant="primary" onClick={onStart} />}
				{(isActive || task.status === 'queued') && <ActionBtn label="Cancel" variant="danger" onClick={onCancel} />}
				{task.status === 'queued' && <ActionBtn label="Skip" variant="muted" onClick={() => onSetStatus('skipped')} />}
				{task.status === 'review' && (
					<>
						<ActionBtn label="Complete" variant="primary" onClick={() => onSetStatus('completed')} />
						<ActionBtn label="Re-queue" variant="muted" onClick={onRetry} />
					</>
				)}
				{task.status !== 'processing' && task.status !== 'queued' && task.status !== 'review' && (
					<>
						<ActionBtn label="Re-queue" variant="primary" onClick={onRetry} />
						{task.status !== 'completed' && (
							<ActionBtn label="Complete" variant="muted" onClick={() => onSetStatus('completed')} />
						)}
						{task.status !== 'review' && (
							<ActionBtn label="Review" variant="muted" onClick={() => onSetStatus('review')} />
						)}
						{task.status !== 'skipped' && (
							<ActionBtn label="Skip" variant="muted" onClick={() => onSetStatus('skipped')} />
						)}
					</>
				)}
				<span style={{ flex: 1 }} />
				<ActionBtn label="Delete" variant="danger" onClick={onDelete} />
			</div>

			{/* Task description */}
			{task.taskContext && (
				<Section title="Task description">
					<pre
						style={{
							fontSize: 12,
							color: 'var(--text-2)',
							lineHeight: 1.6,
							whiteSpace: 'pre-wrap',
							wordBreak: 'break-word',
							fontFamily: 'var(--font-sans)',
							margin: 0,
						}}
					>
						{extractTaskDescription(task.taskContext)}
					</pre>
				</Section>
			)}

			{/* Summary */}
			{task.solverSummary && (
				<Section title="Summary">
					<p style={{ fontSize: 14, color: 'var(--text-1)', lineHeight: 1.7 }}>{task.solverSummary}</p>
				</Section>
			)}

			{/* Files changed */}
			{files.length > 0 && (
				<Section title={`Files changed (${files.length})`}>
					{files.map(f => (
						<div
							key={f}
							style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-2)', padding: '2px 0' }}
						>
							{f}
						</div>
					))}
				</Section>
			)}

			{/* Live Output */}
			{(isActive || task.status === 'failed' || task.status === 'cancelled' || task.status === 'review') && (
				<Section title="Output">
					<LiveOutput taskId={task.id} isActive={isActive} />
				</Section>
			)}

			{/* Activity */}
			<Section title="Activity">
				<ActivityTimeline taskId={task.id} />
			</Section>
		</div>
	)
}

function formatPrLabel(url: string): string {
	const match = url.match(/\/pull\/(\d+)/)
	return match ? `PR #${match[1]}` : 'Pull Request'
}

function buildBranchUrl(prUrl: string | null, _branchName: string): string | null {
	if (!prUrl) return null
	// PR URL is the best link — it shows the branch context
	return prUrl
}

function PrBadge({ status }: { status: PrStatus }) {
	if (status.merged) {
		return <Badge color="var(--accent)" label="Merged" />
	}
	switch (status.state) {
		case 'OPEN':
			return <Badge color="var(--green)" label="Open" />
		case 'CLOSED':
			return <Badge color="var(--red)" label="Closed" />
		case 'MERGED':
			return <Badge color="var(--accent)" label="Merged" />
		default:
			return null
	}
}

function Badge({ color, label }: { color: string; label: string }) {
	return (
		<span
			style={{
				fontSize: 10,
				fontWeight: 600,
				color,
				padding: '2px 8px',
				borderRadius: 999,
				background: `color-mix(in srgb, ${color} 16%, transparent)`,
				textTransform: 'uppercase',
				letterSpacing: '0.04em',
			}}
		>
			{label}
		</span>
	)
}

type BtnVariant = 'primary' | 'muted' | 'danger'

function ActionBtn({ label, variant, onClick }: { label: string; variant: BtnVariant; onClick: () => void }) {
	const tone: Record<BtnVariant, React.CSSProperties> = {
		primary: { background: 'var(--accent-fill)', color: '#fff', border: '1px solid transparent' },
		muted: { background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-hover)' },
		danger: { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-dim)' },
	}
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				padding: '7px 16px',
				borderRadius: 'var(--radius-sm)',
				cursor: 'pointer',
				fontSize: 13,
				fontFamily: 'var(--font-sans)',
				fontWeight: 600,
				transition: 'all 150ms',
				...tone[variant],
			}}
		>
			{label}
		</button>
	)
}

function extractTaskDescription(taskContext: string): string {
	const marker = '## Task Context'
	const idx = taskContext.indexOf(marker)
	if (idx === -1) return taskContext
	return taskContext.slice(idx + marker.length).trim()
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div
			style={{
				background: 'var(--bg-1)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius)',
				padding: '16px 18px',
				marginBottom: 16,
			}}
		>
			<div
				style={{
					fontSize: 11,
					fontWeight: 600,
					color: 'var(--text-4)',
					marginBottom: 10,
					textTransform: 'uppercase',
					letterSpacing: '0.05em',
				}}
			>
				{title}
			</div>
			{children}
		</div>
	)
}
