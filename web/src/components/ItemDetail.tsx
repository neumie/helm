import { useState } from 'react'
import type {
	DashboardActionId,
	DashboardActionTone,
	DashboardItem,
	DashboardLink,
	DashboardPlan,
	DashboardTone,
	DeployState,
	ItemStatus,
	PlanInfo,
	RunObservationState,
	SourceTask,
} from '../api'
import { ITEM_STATUSES } from '../api'
import { useRelativeTime } from '../hooks'
import { StatusBadge } from './StatusBadge'

interface ItemDetailProps {
	item: DashboardItem
	onAction: (id: string, action: DashboardActionId) => Promise<void>
	onSetStatus?: (id: string, status: ItemStatus) => Promise<void>
	onPlan?: (id: string) => Promise<PlanInfo>
	onFork?: (item: DashboardItem) => void
}

export interface RunObservationDetail {
	label: string
	value: string
	link: DashboardLink | null
	tone: DashboardTone
}

export function runObservationDetails(observation: DashboardItem['runObservation']): RunObservationDetail[] {
	const details: RunObservationDetail[] = []
	if (observation.pr.url) {
		const value = observation.pr.merged ? 'merged' : (observation.pr.state ?? 'unknown')
		details.push({
			label: 'PR',
			value,
			link: { label: value, url: observation.pr.url },
			tone: observation.pr.merged ? 'green' : 'gray',
		})
	}
	if (observation.almanac.status) {
		details.push({ label: 'Status', value: observation.almanac.status, link: null, tone: 'gray' })
	}
	if (observation.almanac.round) {
		details.push({ label: 'Round', value: observation.almanac.round, link: null, tone: 'gray' })
	}
	if (observation.almanac.failureReason) {
		details.push({ label: 'Failure', value: observation.almanac.failureReason, link: null, tone: 'red' })
	}
	return details
}

export function ItemDetail({ item, onAction, onSetStatus, onPlan, onFork }: ItemDetailProps) {
	const [pendingAction, setPendingAction] = useState<DashboardActionId | null>(null)
	const [pendingPlan, setPendingPlan] = useState(false)
	const [pendingStatus, setPendingStatus] = useState(false)
	const [planInfo, setPlanInfo] = useState<PlanInfo | null>(null)
	const [actionError, setActionError] = useState<string | null>(null)
	const canFork = Boolean(item.forkContext && onFork)
	const canPlan = Boolean(onPlan)
	const hasPlan = Boolean(planInfo || item.plan)
	const commandPending = pendingAction !== null || pendingPlan
	const hasCommands = item.allowedActions.length > 0 || canFork || canPlan
	const elapsed = useRelativeTime(
		item.status === 'processing'
			? (item.startedAt ?? item.queuedAt ?? item.createdAt)
			: (item.completedAt ?? item.updatedAt),
	)
	const elapsedLabel = item.status === 'processing' ? 'running' : item.status === 'review' ? 'in review' : item.status
	const created = useRelativeTime(item.createdAt)

	const runAction = async (action: DashboardActionId) => {
		setPendingAction(action)
		setActionError(null)
		try {
			await onAction(item.id, action)
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err))
		} finally {
			setPendingAction(null)
		}
	}

	const runPlan = async () => {
		if (!onPlan) return
		setPendingPlan(true)
		setActionError(null)
		try {
			setPlanInfo(await onPlan(item.id))
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err))
		} finally {
			setPendingPlan(false)
		}
	}

	return (
		<div
			style={{ display: 'flex', gap: 24, alignItems: 'flex-start', maxWidth: 1000, margin: '0 auto', flexWrap: 'wrap' }}
		>
			<div style={{ flex: '1 1 440px', minWidth: 0 }}>
				<h2
					style={{
						fontSize: 20,
						fontWeight: 600,
						color: 'var(--text-0)',
						lineHeight: 1.4,
						marginBottom: 12,
						overflowWrap: 'break-word',
					}}
				>
					{item.title}
				</h2>

				<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
					<StatusBadge value={item.card.statusLabel} tone={item.card.statusTone} />
					{item.runObservation.pr.merged && (
						<span
							style={{
								fontSize: 10,
								fontWeight: 700,
								color: 'var(--green)',
								background: 'var(--green-dim)',
								borderRadius: 6,
								padding: '2px 7px',
							}}
						>
							MERGED
						</span>
					)}
					<span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-4)', textTransform: 'uppercase' }}>
						{item.kind}
					</span>
					{item.runOutcome && item.runOutcome !== 'ok' && (
						<span
							title="The agent run errored or wrote no result file — the work may still be fine, verify the branch/PR."
							style={{
								fontSize: 10,
								fontWeight: 700,
								color: 'var(--amber)',
								background: 'var(--amber-dim)',
								borderRadius: 6,
								padding: '2px 7px',
							}}
						>
							run: {item.runOutcome === 'no_result' ? 'no result' : item.runOutcome}
						</span>
					)}
					{elapsed && (
						<span style={{ fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--font-mono)' }}>
							{elapsedLabel} {elapsed}
						</span>
					)}
				</div>

				{item.sourceTask && <SourceTaskView task={item.sourceTask} />}

				{item.errorMessage && (
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
							style={{
								fontSize: 11,
								color: 'var(--red)',
								fontWeight: 600,
								marginBottom: 4,
								textTransform: 'uppercase',
							}}
						>
							Error{item.errorPhase ? ` (${item.errorPhase})` : ''}
						</div>
						<div style={{ fontSize: 13, color: 'color-mix(in srgb, var(--red) 80%, white)', lineHeight: 1.5 }}>
							{item.errorMessage}
						</div>
					</div>
				)}

				{planInfo ? <PlanInfoBlock info={planInfo} /> : item.plan && <PersistedPlanBlock plan={item.plan} />}

				<RunObservationView item={item} />

				{item.resultSummary && (
					<Section title="Result">
						<p style={{ fontSize: 14, color: 'var(--text-1)', lineHeight: 1.7, overflowWrap: 'break-word' }}>
							{item.resultSummary}
						</p>
					</Section>
				)}

				{item.solveInputSnapshot && (
					<details style={{ marginTop: 28 }}>
						<summary
							style={{
								fontSize: 11,
								fontWeight: 600,
								textTransform: 'uppercase',
								letterSpacing: '0.04em',
								color: 'var(--text-4)',
								cursor: 'pointer',
							}}
						>
							Solve input
						</summary>
						<pre
							style={{
								fontSize: 12,
								color: 'var(--text-2)',
								lineHeight: 1.6,
								whiteSpace: 'pre-wrap',
								wordBreak: 'break-word',
								fontFamily: 'var(--font-sans)',
								margin: '12px 0 0',
							}}
						>
							{item.solveInputSnapshot}
						</pre>
					</details>
				)}
			</div>

			<aside style={{ flex: '0 0 250px', width: 250, position: 'sticky', top: 0 }}>
				{hasCommands && (
					<Section title="Actions">
						<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
							{item.allowedActions.map(action => (
								<ActionButton
									key={action.id}
									label={pendingAction === action.id ? `${action.label}…` : action.label}
									tone={action.tone}
									disabled={commandPending}
									fullWidth
									onClick={() => runAction(action.id)}
								/>
							))}
							{canPlan && (
								<ActionButton
									label={pendingPlan ? 'Planning...' : hasPlan ? 'Re-plan' : 'Plan'}
									tone="muted"
									disabled={commandPending || item.status === 'processing'}
									fullWidth
									onClick={runPlan}
								/>
							)}
							{canFork && onFork && (
								<ActionButton
									label="Fork"
									tone="muted"
									disabled={commandPending}
									fullWidth
									onClick={() => onFork(item)}
								/>
							)}
						</div>
						{onSetStatus && (
							<div style={{ marginTop: 14 }}>
								<div
									style={{
										fontSize: 11,
										color: 'var(--text-4)',
										textTransform: 'uppercase',
										letterSpacing: '0.04em',
										marginBottom: 6,
									}}
								>
									Status
								</div>
								<div style={{ position: 'relative' }}>
									<select
										value={item.status}
										disabled={item.status === 'processing' || pendingStatus}
										title={
											item.status === 'processing'
												? 'Cancel the running Item before changing its status'
												: 'Manual status override'
										}
										onChange={async e => {
											const next = e.target.value as ItemStatus
											if (next === item.status) return
											setPendingStatus(true)
											setActionError(null)
											try {
												await onSetStatus(item.id, next)
											} catch (err) {
												setActionError(err instanceof Error ? err.message : String(err))
											} finally {
												setPendingStatus(false)
											}
										}}
										style={{
											appearance: 'none',
											WebkitAppearance: 'none',
											width: '100%',
											padding: '8px 28px 8px 10px',
											background: 'var(--bg-2)',
											border: '1px solid var(--border)',
											borderRadius: 'var(--radius-sm)',
											color: 'var(--text-1)',
											fontSize: 12,
											fontFamily: 'var(--font-sans)',
											cursor: item.status === 'processing' ? 'not-allowed' : 'pointer',
											outline: 'none',
										}}
									>
										{ITEM_STATUSES.map(s => (
											<option key={s} value={s} disabled={s === 'processing'}>
												{s}
											</option>
										))}
									</select>
									<span
										style={{
											position: 'absolute',
											right: 10,
											top: '50%',
											transform: 'translateY(-50%)',
											pointerEvents: 'none',
											color: 'var(--text-4)',
											fontSize: 10,
										}}
									>
										▾
									</span>
								</div>
							</div>
						)}
						{actionError && (
							<div style={{ color: 'var(--red)', fontSize: 12, lineHeight: 1.5, marginTop: 10 }}>{actionError}</div>
						)}
					</Section>
				)}

				<Section title="Details">
					<div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--text-3)' }}>
						<span>
							Project <strong style={{ color: 'var(--text-1)', fontWeight: 500 }}>{item.projectSlug}</strong>
						</span>
						<span>
							BaseRef <strong style={{ color: 'var(--text-1)', fontWeight: 500 }}>{item.baseRef}</strong>
						</span>
						{item.branchName && (
							<span>
								Branch{' '}
								<code style={{ color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
									{item.branchName}
								</code>
							</span>
						)}
						{created && (
							<span>
								Created <strong style={{ color: 'var(--text-1)', fontWeight: 500 }}>{created} ago</strong>
							</span>
						)}
					</div>
				</Section>

				<Section title="Links">
					<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
						<LinkRow label="Task" url={item.links.source?.url ?? null} fallback="no source" />
						<LinkRow label="GitHub" url={item.links.pr?.url ?? null} fallback="no PR yet" />
					</div>
				</Section>

				<DeployLadder deployState={item.deployState} />
			</aside>
		</div>
	)
}

function PlanInfoBlock({ info }: { info: PlanInfo }) {
	return (
		<div
			style={{
				padding: '10px 12px',
				marginBottom: 16,
				borderRadius: 'var(--radius-sm)',
				border: '1px solid var(--border)',
				background: 'var(--bg-1)',
				fontSize: 12,
				lineHeight: 1.6,
				color: 'var(--text-2)',
			}}
		>
			<div style={{ color: 'var(--text-1)', fontWeight: 600 }}>{info.hint}</div>
			<div>
				{info.spawner} planning started for{' '}
				<code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-1)' }}>{info.planDirName}</code>
				.
			</div>
		</div>
	)
}

function PersistedPlanBlock({ plan }: { plan: DashboardPlan }) {
	return (
		<div
			style={{
				padding: '10px 12px',
				marginBottom: 16,
				borderRadius: 'var(--radius-sm)',
				border: '1px solid var(--border)',
				background: 'var(--bg-1)',
				fontSize: 12,
				lineHeight: 1.6,
				color: 'var(--text-2)',
			}}
		>
			<div style={{ color: 'var(--text-1)', fontWeight: 600 }}>Plan prepared</div>
			<div>
				Plan artifacts live in{' '}
				<code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-1)' }}>{plan.planDirName}</code>
				.
			</div>
		</div>
	)
}

/** The source task's actual content — description (with inline images in
 *  document order), metadata, attachments, comments — so the operator can read
 *  the task without leaving Vigil. */
function SourceTaskView({ task }: { task: SourceTask }) {
	const metaEntries = task.metadata ? Object.entries(task.metadata) : []
	const comments = task.comments ?? []
	const blocks = task.descriptionBlocks ?? []
	// Images shown inline (in the blocks) shouldn't also appear in the trailing
	// attachments strip.
	const inlineUrls = new Set(blocks.flatMap(b => (b.type === 'image' ? [b.url] : [])))
	const attachments = (task.attachments ?? []).filter(a => !inlineUrls.has(a.url))
	const hasContent =
		task.description || blocks.length > 0 || metaEntries.length > 0 || comments.length > 0 || attachments.length > 0
	if (!hasContent) return null
	return (
		<Section title="Task">
			{metaEntries.length > 0 && (
				<div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
					{metaEntries.map(([k, v]) => (
						<span key={k} style={{ fontSize: 11, color: 'var(--text-3)' }}>
							{k}: <strong style={{ color: 'var(--text-1)', fontWeight: 500 }}>{v}</strong>
						</span>
					))}
				</div>
			)}
			{blocks.length > 0 ? (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
					{blocks.map(b =>
						b.type === 'image' ? (
							<Attachment
								key={`i:${b.url}`}
								att={{ name: b.name ?? 'image', url: b.url, contentType: b.contentType }}
							/>
						) : b.heading ? (
							<div key={`h:${b.text}`} style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-0)' }}>
								{b.text}
							</div>
						) : (
							<p
								key={`t:${b.text}`}
								style={{
									fontSize: 14,
									color: 'var(--text-1)',
									lineHeight: 1.7,
									whiteSpace: 'pre-wrap',
									overflowWrap: 'break-word',
								}}
							>
								{b.text}
							</p>
						),
					)}
				</div>
			) : (
				task.description && (
					<p
						style={{
							fontSize: 14,
							color: 'var(--text-1)',
							lineHeight: 1.7,
							whiteSpace: 'pre-wrap',
							overflowWrap: 'break-word',
						}}
					>
						{task.description}
					</p>
				)
			)}
			{attachments.length > 0 && (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
					{attachments.map(a => (
						<Attachment key={a.url} att={a} />
					))}
				</div>
			)}
			{comments.length > 0 && (
				<div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
					{comments.map(c => (
						<div key={`${c.createdAt}-${c.author}`} style={{ borderLeft: '2px solid var(--border)', paddingLeft: 10 }}>
							<div style={{ fontSize: 11, color: 'var(--text-4)', marginBottom: 2 }}>{c.author}</div>
							<div
								style={{
									fontSize: 13,
									color: 'var(--text-2)',
									lineHeight: 1.5,
									whiteSpace: 'pre-wrap',
									overflowWrap: 'break-word',
								}}
							>
								{c.body}
							</div>
						</div>
					))}
				</div>
			)}
		</Section>
	)
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i
const NON_IMAGE_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|mp[34]|mov|webm|wav|json|xml)(\?|#|$)/i

function safeHttpUrl(url: string): string | null {
	try {
		const u = new URL(url)
		return u.protocol === 'https:' || u.protocol === 'http:' ? url : null
	} catch {
		return null
	}
}

// Should we attempt to render this as an image? Contember often gives no content
// type and a generic "file" name, so when type/extension are unknown we try the
// image optimistically and fall back to a file link if it fails to load.
function maybeImage(att: { name: string; url: string; contentType?: string }): boolean {
	if (att.contentType) return att.contentType.startsWith('image/')
	if (IMAGE_EXT.test(att.name) || IMAGE_EXT.test(att.url)) return true
	if (NON_IMAGE_EXT.test(att.name) || NON_IMAGE_EXT.test(att.url)) return false
	return true
}

/** An image renders as an inline thumbnail (click to open full); a non-image —
 *  or an image that fails to load — renders as a labeled link. URL is
 *  http(s)-guarded against javascript:/data:. */
function Attachment({ att }: { att: { name: string; url: string; contentType?: string } }) {
	const [notImage, setNotImage] = useState(false)
	const href = safeHttpUrl(att.url)
	if (!href) return null
	if (maybeImage(att) && !notImage) {
		return (
			<a href={href} target="_blank" rel="noreferrer" title={att.name}>
				<img
					src={href}
					alt={att.name}
					loading="lazy"
					onError={() => setNotImage(true)}
					style={{
						maxHeight: 180,
						maxWidth: 260,
						objectFit: 'cover',
						borderRadius: 'var(--radius-sm)',
						border: '1px solid var(--border)',
						display: 'block',
					}}
				/>
			</a>
		)
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			style={{
				fontSize: 12,
				color: 'var(--accent)',
				textDecoration: 'none',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-sm)',
				padding: '6px 10px',
			}}
		>
			📎 {att.name}
		</a>
	)
}

function deployTone(state: string): string {
	if (state === 'success') return 'var(--green)'
	if (state === 'failure' || state === 'error') return 'var(--red)'
	if (state === 'inactive') return 'var(--text-4)'
	return 'var(--blue)' // pending / in_progress / queued / waiting
}

/** The post-ship deploy ladder: merge → each GitHub environment + its state. */
function DeployLadder({ deployState }: { deployState: DeployState | null }) {
	if (!deployState || (!deployState.merged && deployState.deployments.length === 0)) return null
	return (
		<Section title="Deploy">
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
				<DeployChip label="merged" active={deployState.merged} tone="var(--green)" />
				{deployState.deployments.length === 0 && deployState.merged && (
					<span style={{ fontSize: 12, color: 'var(--text-4)' }}>no deployments yet</span>
				)}
				{deployState.deployments.map(d => (
					<DeployChip
						key={d.environment}
						label={`${d.environment}: ${d.state}`}
						active
						tone={deployTone(d.state)}
						href={d.url}
					/>
				))}
			</div>
		</Section>
	)
}

function DeployChip({
	label,
	active,
	tone,
	href,
}: { label: string; active: boolean; tone: string; href?: string | null }) {
	const chip = (
		<span
			style={{
				fontSize: 11,
				fontWeight: 600,
				padding: '3px 9px',
				borderRadius: 'var(--radius-sm)',
				color: active ? tone : 'var(--text-4)',
				background: active ? 'color-mix(in srgb, currentColor 14%, transparent)' : 'transparent',
				border: `1px solid ${active ? 'color-mix(in srgb, currentColor 35%, transparent)' : 'var(--border)'}`,
				whiteSpace: 'nowrap',
			}}
		>
			{label}
		</span>
	)
	// Only link http(s) — the deploy URL comes from external GitHub data, so a
	// javascript:/data: URI must never reach the href (defense-in-depth; the
	// server already drops non-http(s) deploy URLs before persisting).
	const safeHref = (() => {
		if (!href) return null
		try {
			const u = new URL(href)
			return u.protocol === 'https:' || u.protocol === 'http:' ? href : null
		} catch {
			return null
		}
	})()
	return safeHref ? (
		<a href={safeHref} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
			{chip}
		</a>
	) : (
		chip
	)
}

function RunObservationView({ item }: { item: DashboardItem }) {
	const observation = item.runObservation
	const details = runObservationDetails(observation)
	if (observation.source === 'none') return null

	return (
		<Section title="Run">
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
				<StatusBadge value={observation.stateLabel} tone={toneForRunState(observation.state)} />
				<span
					style={{
						fontSize: 10,
						fontWeight: 600,
						color: 'var(--text-4)',
						textTransform: 'uppercase',
					}}
				>
					{observation.source === 'solve' ? 'Solve' : 'Loop'}
				</span>
				{observation.almanac.runId && (
					<code style={{ color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
						{observation.almanac.runId}
					</code>
				)}
			</div>

			{observation.summary && (
				<p style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.6, margin: '0 0 12px' }}>
					{observation.summary}
				</p>
			)}

			<div
				style={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: '4px 18px',
					fontSize: 12,
					color: 'var(--text-3)',
					marginBottom: observation.events.length > 0 || observation.log.available ? 12 : 0,
				}}
			>
				{details.map(detail => (
					<span key={detail.label}>
						{detail.label}:{' '}
						{detail.link ? (
							<InlineLink link={detail.link} fallback={<span>{detail.value}</span>} />
						) : (
							<strong style={{ color: detailColor(detail.tone), fontWeight: 500 }}>{detail.value}</strong>
						)}
					</span>
				))}
			</div>

			{observation.events.length > 0 && (
				<div
					style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: observation.log.available ? 12 : 0 }}
				>
					{observation.events.slice(-6).map((event, index) => (
						<div key={`${event.type}-${event.createdAt ?? index}`} style={{ display: 'flex', gap: 8, fontSize: 12 }}>
							<span style={{ width: 62, flexShrink: 0, color: 'var(--text-4)', fontFamily: 'var(--font-mono)' }}>
								{event.createdAt ? formatTime(event.createdAt) : '--:--:--'}
							</span>
							<span style={{ color: toneColor(event.tone), lineHeight: 1.4 }}>{event.label}</span>
						</div>
					))}
				</div>
			)}

			{observation.log.available && (
				<pre
					style={{
						background: 'var(--bg-0)',
						borderRadius: 'var(--radius-sm)',
						padding: 12,
						fontSize: 11,
						fontFamily: 'var(--font-mono)',
						color: 'var(--text-2)',
						maxHeight: 260,
						overflow: 'auto',
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						margin: 0,
						lineHeight: 1.6,
					}}
				>
					{observation.log.truncated ? '...\n' : ''}
					{observation.log.content}
				</pre>
			)}
		</Section>
	)
}

function detailColor(tone: DashboardTone): string {
	return tone === 'red' ? 'var(--red)' : 'var(--text-1)'
}

function toneForRunState(state: RunObservationState): DashboardTone {
	switch (state) {
		case 'running':
			return 'blue'
		case 'completed':
			return 'green'
		case 'review':
		case 'cancelled':
		case 'unknown':
			return 'amber'
		case 'failed':
			return 'red'
		case 'idle':
			return 'gray'
	}
}

function toneColor(tone: DashboardTone): string {
	switch (tone) {
		case 'blue':
			return 'var(--blue)'
		case 'green':
			return 'var(--green)'
		case 'amber':
			return 'var(--amber)'
		case 'red':
			return 'var(--red)'
		case 'gray':
			return 'var(--text-3)'
	}
}

function formatTime(value: string): string {
	// Legacy event rows were stored as "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker),
	// which Date parses as LOCAL → wrong by the offset. Normalize a zone-less value
	// to explicit UTC so it converts to local correctly.
	const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value)
	const normalized = hasZone ? value : `${value.replace(' ', 'T')}Z`
	return new Date(normalized).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	})
}

// A header link reads as the system name ("Task", "GitHub") — not the raw
// external id or branch name. The underlying value is kept as a hover tooltip.
// A labeled link row for the sidebar Links card — always renders its label,
// showing a muted placeholder (e.g. "no PR yet") when the link is absent so a
// missing link reads as "not available" rather than vanishing.
function LinkRow({ label, url, fallback }: { label: string; url: string | null; fallback: string }) {
	return (
		<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
			<span style={{ color: 'var(--text-4)' }}>{label}</span>
			{url ? (
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}
				>
					open ↗
				</a>
			) : (
				<span style={{ color: 'var(--text-4)' }}>{fallback}</span>
			)}
		</div>
	)
}

function InlineLink({ link, fallback }: { link: DashboardLink | null; fallback: React.ReactNode }) {
	if (!link) return fallback
	if (!link.url) return <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{link.label}</span>
	return (
		<a
			href={link.url}
			target="_blank"
			rel="noreferrer"
			style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}
		>
			{link.label}
		</a>
	)
}

function ActionButton({
	label,
	tone,
	disabled,
	fullWidth,
	onClick,
}: {
	label: string
	tone: DashboardActionTone
	disabled: boolean
	fullWidth?: boolean
	onClick: () => void
}) {
	const styles: Record<DashboardActionTone, React.CSSProperties> = {
		primary: { color: '#fff', background: 'var(--accent-fill)', border: '1px solid transparent' },
		muted: { color: 'var(--text-2)', background: 'var(--bg-2)', border: '1px solid var(--border)' },
		danger: {
			color: 'var(--red)',
			background: 'color-mix(in srgb, var(--red) 12%, transparent)',
			border: '1px solid color-mix(in srgb, var(--red) 30%, transparent)',
		},
	}
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			style={{
				width: fullWidth ? '100%' : undefined,
				padding: '8px 14px',
				borderRadius: 'var(--radius-sm)',
				fontSize: 13,
				fontWeight: 600,
				fontFamily: 'var(--font-sans)',
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.5 : 1,
				transition: 'opacity 120ms',
				...styles[tone],
			}}
		>
			{label}
		</button>
	)
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
