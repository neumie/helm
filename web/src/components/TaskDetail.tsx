import { useEffect, useState } from 'react'
import { type ChatSessionInfo, type TaskRecord, api } from '../api'
import { ActivityTimeline } from './ActivityTimeline'
import { LiveOutput } from './LiveOutput'
import { StatusBadge } from './StatusBadge'

interface Props {
	task: TaskRecord
	taskBaseUrl?: string
	chatEnabled: boolean
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

export function TaskDetail({
	task,
	taskBaseUrl,
	chatEnabled,
	onStart,
	onRetry,
	onCancel,
	onSetStatus,
	onDelete,
}: Props) {
	const files = task.filesChanged ? (JSON.parse(task.filesChanged) as string[]) : []
	const isActive = task.status === 'processing'
	const [prStatus, setPrStatus] = useState<PrStatus | null>(null)
	const [chatSessions, setChatSessions] = useState<ChatSessionInfo[]>([])
	const [chatLoading, setChatLoading] = useState(false)

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

	useEffect(() => {
		if (chatEnabled) {
			api
				.chatSessions(task.id)
				.then(setChatSessions)
				.catch(() => setChatSessions([]))
		}
	}, [task.id, chatEnabled])

	const branchUrl = task.prUrl ?? (task.branchName ? buildBranchUrl(task.prUrl, task.branchName) : null)

	return (
		<div style={{ maxWidth: 760, margin: '0 auto' }}>
			{/* Title */}
			<h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-0)', lineHeight: 1.4, marginBottom: 12 }}>
				{task.title}
			</h2>

			{/* Badges + links row */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
				<StatusBadge value={task.status} type="status" />
				{task.tier && <StatusBadge value={task.tier} type="tier" />}
				{task.solverConfidence != null && (
					<span style={{ fontSize: 12, color: 'var(--text-3)' }}>
						{(task.solverConfidence * 100).toFixed(0)}% confidence
					</span>
				)}

				<span style={{ flex: 1 }} />

				{taskBaseUrl && (
					<a
						href={`${taskBaseUrl}${task.clientcareId}`}
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
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 32 }}>
				{task.status === 'queued' && <ActionBtn label="Start" color="var(--accent)" onClick={onStart} />}
				{(isActive || task.status === 'queued') && <ActionBtn label="Cancel" color="var(--red)" onClick={onCancel} />}
				{task.status === 'queued' && (
					<ActionBtn label="Skip" color="var(--text-3)" onClick={() => onSetStatus('skipped')} />
				)}
				{task.status === 'review' && (
					<>
						<ActionBtn label="Complete" color="var(--green)" onClick={() => onSetStatus('completed')} />
						<ActionBtn label="Re-queue" color="var(--accent)" onClick={onRetry} />
					</>
				)}
				{task.status !== 'processing' && task.status !== 'queued' && task.status !== 'review' && (
					<>
						<ActionBtn label="Re-queue" color="var(--accent)" onClick={onRetry} />
						{task.status !== 'completed' && (
							<ActionBtn label="Complete" color="var(--green)" onClick={() => onSetStatus('completed')} />
						)}
						{task.status !== 'review' && (
							<ActionBtn label="Review" color="var(--amber)" onClick={() => onSetStatus('review')} />
						)}
						{task.status !== 'skipped' && (
							<ActionBtn label="Skip" color="var(--text-3)" onClick={() => onSetStatus('skipped')} />
						)}
					</>
				)}
				<ActionBtn label="Delete" color="var(--red)" onClick={onDelete} />
			</div>

			{/* Chat */}
			{chatEnabled && (
				<ChatSection
					sessions={chatSessions}
					loading={chatLoading}
					onNewChat={async () => {
						setChatLoading(true)
						try {
							const result = await api.createChat(task.id)
							const sessions = await api.chatSessions(task.id)
							setChatSessions(sessions)
						} finally {
							setChatLoading(false)
						}
					}}
				/>
			)}

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
				fontSize: 11,
				fontWeight: 600,
				color,
				padding: '1px 8px',
				borderRadius: 4,
				background: `color-mix(in srgb, ${color} 15%, transparent)`,
				border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
			}}
		>
			{label}
		</span>
	)
}

function ActionBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				padding: '6px 16px',
				background: `color-mix(in srgb, ${color} 10%, transparent)`,
				border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
				borderRadius: 'var(--radius-sm)',
				color,
				cursor: 'pointer',
				fontSize: 13,
				fontFamily: 'var(--font-sans)',
				fontWeight: 500,
				transition: 'all 150ms',
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

function ChatSection({
	sessions,
	loading,
	onNewChat,
}: {
	sessions: ChatSessionInfo[]
	loading: boolean
	onNewChat: () => void
}) {
	const [copied, setCopied] = useState<string | null>(null)
	const [expanded, setExpanded] = useState<string | null>(null)

	const copyUrl = (url: string, id: string) => {
		navigator.clipboard.writeText(url)
		setCopied(id)
		setTimeout(() => setCopied(null), 2000)
	}

	return (
		<Section title="Chat">
			{sessions.length === 0 ? (
				<p style={{ fontSize: 13, color: 'var(--text-4)', marginBottom: 12 }}>No chat sessions yet.</p>
			) : (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
					{sessions.map(s => (
						<div
							key={s.id}
							style={{
								border: '1px solid var(--border)',
								borderRadius: 'var(--radius-sm)',
								overflow: 'hidden',
							}}
						>
							<div
								// biome-ignore lint/a11y/useSemanticElements: row header contains nested interactive controls (copy button, external link); role + keyboard handlers give it accessible button behavior
								role="button"
								tabIndex={0}
								onClick={() => setExpanded(expanded === s.id ? null : s.id)}
								onKeyDown={e => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault()
										setExpanded(expanded === s.id ? null : s.id)
									}
								}}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 8,
									padding: '8px 12px',
									cursor: 'pointer',
									background: 'var(--bg-1)',
								}}
							>
								<span
									style={{
										fontSize: 11,
										fontWeight: 600,
										color: s.status === 'active' ? 'var(--green)' : 'var(--text-4)',
									}}
								>
									{s.status === 'active' ? 'Active' : 'Completed'}
								</span>
								<span style={{ fontSize: 11, color: 'var(--text-4)' }}>
									{s.messages.length} message{s.messages.length !== 1 ? 's' : ''}
								</span>
								<span style={{ fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--font-mono)' }}>
									{new Date(s.createdAt).toLocaleString([], {
										month: 'short',
										day: 'numeric',
										hour: '2-digit',
										minute: '2-digit',
										hour12: false,
									})}
								</span>
								<span style={{ flex: 1 }} />
								{s.chatUrl && (
									<button
										type="button"
										onClick={e => {
											e.stopPropagation()
											if (s.chatUrl) copyUrl(s.chatUrl, s.id)
										}}
										style={{
											background: 'none',
											border: 'none',
											cursor: 'pointer',
											fontSize: 11,
											color: copied === s.id ? 'var(--green)' : 'var(--accent)',
											fontFamily: 'var(--font-sans)',
											fontWeight: 500,
										}}
									>
										{copied === s.id ? 'Copied' : 'Copy link'}
									</button>
								)}
								<a
									href={s.chatUrl ?? '#'}
									target="_blank"
									rel="noreferrer"
									onClick={e => e.stopPropagation()}
									style={{
										fontSize: 11,
										color: 'var(--blue)',
										textDecoration: 'none',
										fontWeight: 500,
									}}
								>
									Open
								</a>
							</div>
							{expanded === s.id && s.messages.length > 0 && (
								<div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', background: 'var(--bg-0)' }}>
									{s.messages.map(m => (
										<div key={m.id} style={{ marginBottom: 8 }}>
											<span
												style={{
													fontSize: 11,
													fontWeight: 600,
													color: m.role === 'assistant' ? 'var(--accent)' : 'var(--blue)',
												}}
											>
												{m.role === 'assistant' ? 'Vigil' : 'Requester'}:
											</span>
											<span style={{ fontSize: 12, color: 'var(--text-2)', marginLeft: 6, lineHeight: 1.5 }}>
												{m.content}
											</span>
										</div>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			)}
			<ActionBtn label={loading ? 'Creating...' : 'New chat'} color="var(--accent)" onClick={onNewChat} />
		</Section>
	)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div style={{ marginBottom: 28 }}>
			<div
				style={{
					fontSize: 12,
					fontWeight: 600,
					color: 'var(--text-3)',
					marginBottom: 12,
					paddingBottom: 8,
					borderBottom: '1px solid var(--border)',
				}}
			>
				{title}
			</div>
			{children}
		</div>
	)
}
