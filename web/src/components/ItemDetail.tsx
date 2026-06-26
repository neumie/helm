import { useState } from 'react'
import type {
	DashboardActionId,
	DashboardActionTone,
	DashboardItem,
	DashboardLink,
	DashboardPlan,
	DashboardTone,
	PlanInfo,
	RunObservationState,
} from '../api'
import { useRelativeTime } from '../hooks'
import { StatusBadge } from './StatusBadge'

interface ItemDetailProps {
	item: DashboardItem
	onAction: (id: string, action: DashboardActionId) => Promise<void>
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

export function ItemDetail({ item, onAction, onPlan, onFork }: ItemDetailProps) {
	const [pendingAction, setPendingAction] = useState<DashboardActionId | null>(null)
	const [pendingPlan, setPendingPlan] = useState(false)
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
		<div style={{ maxWidth: 760, margin: '0 auto' }}>
			<h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-0)', lineHeight: 1.4, marginBottom: 12 }}>
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
				<span style={{ flex: 1 }} />
				<HeaderLink link={item.links.source} fallbackLabel="Source" />
				<HeaderLink link={item.links.branch} fallbackLabel="Branch" />
				<HeaderLink link={item.links.pr} fallbackLabel="PR" />
			</div>

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
					Project: <strong style={{ color: 'var(--text-1)', fontWeight: 500 }}>{item.projectSlug}</strong>
				</span>
				<span>
					BaseRef: <strong style={{ color: 'var(--text-1)', fontWeight: 500 }}>{item.baseRef}</strong>
				</span>
			</div>

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
						style={{ fontSize: 11, color: 'var(--red)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}
					>
						Error{item.errorPhase ? ` (${item.errorPhase})` : ''}
					</div>
					<div style={{ fontSize: 13, color: 'color-mix(in srgb, var(--red) 80%, white)', lineHeight: 1.5 }}>
						{item.errorMessage}
					</div>
				</div>
			)}

			{hasCommands && (
				<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
					{item.allowedActions.map(action => (
						<ActionButton
							key={action.id}
							label={pendingAction === action.id ? `${action.label}…` : action.label}
							tone={action.tone}
							disabled={commandPending}
							onClick={() => runAction(action.id)}
						/>
					))}
					{canPlan && (
						<ActionButton
							label={pendingPlan ? 'Planning...' : hasPlan ? 'Re-plan' : 'Plan'}
							tone="muted"
							disabled={commandPending || item.status === 'processing'}
							onClick={runPlan}
						/>
					)}
					{canFork && onFork && (
						<ActionButton label="Fork" tone="muted" disabled={commandPending} onClick={() => onFork(item)} />
					)}
				</div>
			)}
			{actionError && (
				<div style={{ color: 'var(--red)', fontSize: 12, lineHeight: 1.5, marginBottom: 24 }}>{actionError}</div>
			)}
			{planInfo ? <PlanInfoBlock info={planInfo} /> : item.plan && <PersistedPlanBlock plan={item.plan} />}

			<RunObservationView item={item} />

			{item.resultSummary && (
				<Section title="Summary">
					<p style={{ fontSize: 14, color: 'var(--text-1)', lineHeight: 1.7 }}>{item.resultSummary}</p>
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

function HeaderLink({ link, fallbackLabel }: { link: DashboardLink | null; fallbackLabel: string }) {
	if (!link) return null
	return (
		<InlineLink
			link={link}
			fallback={<span style={{ fontSize: 12, color: 'var(--text-4)', fontWeight: 500 }}>{fallbackLabel}</span>}
		/>
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
	onClick,
}: {
	label: string
	tone: DashboardActionTone
	disabled: boolean
	onClick: () => void
}) {
	const styles: Record<DashboardActionTone, React.CSSProperties> = {
		primary: { color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)' },
		muted: { color: 'var(--text-3)', border: '1px solid var(--border-hover)' },
		danger: { color: 'var(--red)', border: '1px solid var(--red-dim)' },
	}
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			style={{
				padding: '7px 16px',
				borderRadius: 'var(--radius-sm)',
				fontSize: 13,
				fontWeight: 600,
				background: 'transparent',
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.6 : 1,
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
