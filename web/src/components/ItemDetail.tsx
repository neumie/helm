import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
	AiPass,
	DashboardActionId,
	DashboardActionTone,
	DashboardItem,
	DashboardLink,
	DashboardTone,
	DeployState,
	ItemStatus,
	PlanInfo,
	RunObservationState,
	SourceTask,
} from '../api'
import { ITEM_STATUSES, api } from '../api'
import type { Assessment } from '../api'
import { useRelativeTime } from '../hooks'
import { TONE_COLOR, TONE_DIM, VERDICT_META } from '../verdict'
import { Select } from './Select'
import { StatusBadge } from './StatusBadge'

interface ItemDetailProps {
	item: DashboardItem
	onAction: (id: string, action: DashboardActionId) => Promise<void>
	onSetStatus?: (id: string, status: ItemStatus) => Promise<void>
	onPlan?: (id: string) => Promise<PlanInfo>
	onAiPass?: (id: string, pass: AiPass) => Promise<void>
	onFork?: (item: DashboardItem) => void
	/** True while the full detail (with provider `sourceTask`) is still being
	 *  fetched and we're rendering from the cheap list row. Lets the description
	 *  slot show a skeleton so the real card fills reserved space instead of
	 *  popping in and shoving the rest of the pane down. */
	sourceLoading?: boolean
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

export function ItemDetail({ item, onAction, onSetStatus, onPlan, onAiPass, onFork, sourceLoading }: ItemDetailProps) {
	const [pendingAction, setPendingAction] = useState<DashboardActionId | null>(null)
	const [pendingPlan, setPendingPlan] = useState(false)
	const [pendingStatus, setPendingStatus] = useState(false)
	const [pendingAi, setPendingAi] = useState<AiPass | null>(null)
	const [planInfo, setPlanInfo] = useState<PlanInfo | null>(null)
	const [actionError, setActionError] = useState<string | null>(null)
	// Transient per-item UI state — reset when the selected item changes so a
	// pending pass on one item doesn't leave another item's controls locked
	// (this component instance is reused across item selections).
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on item switch only
	useEffect(() => {
		setPendingAction(null)
		setPendingPlan(false)
		setPendingAi(null)
		setPlanInfo(null)
		setActionError(null)
	}, [item.id])
	const canFork = Boolean(item.forkContext && onFork)
	const canPlan = Boolean(onPlan)
	const hasPlan = Boolean(planInfo || item.plan)
	// Actions (approve/reject/plan/fork) and the cheap AI passes (display name /
	// branch name / re-assess) are independent server ops — running a re-assess
	// must NOT lock the action bar. Gate them on separate pending flags.
	const actionPending = pendingAction !== null || pendingPlan
	// Branch renaming is only safe before a worktree exists (renaming after would
	// orphan it), and only for solve Items not yet running — mirrors the server gate.
	const canBranchName = item.kind === 'solve' && !item.plan && (item.status === 'triage' || item.status === 'ready')
	const aiPasses: Array<{ pass: AiPass; label: string }> = [
		{ pass: 'display-name', label: 'Display name' },
		...(canBranchName ? [{ pass: 'branch-name' as const, label: 'Branch name' }] : []),
		{ pass: 'assess', label: 'Re-assess intent' },
	]
	const hasCommands = item.allowedActions.length > 0 || canFork || canPlan || Boolean(onAiPass)
	const elapsed = useRelativeTime(
		item.status === 'running'
			? (item.startedAt ?? item.queuedAt ?? item.createdAt)
			: (item.completedAt ?? item.updatedAt),
	)
	const elapsedLabel = item.status === 'running' ? 'running' : item.status === 'review' ? 'in review' : item.status
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

	const runAi = async (pass: AiPass) => {
		if (!onAiPass) return
		setPendingAi(pass)
		setActionError(null)
		try {
			await onAiPass(item.id, pass)
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err))
		} finally {
			setPendingAi(null)
		}
	}

	return (
		<div
			style={{ display: 'flex', gap: 24, alignItems: 'flex-start', maxWidth: 1000, margin: '0 auto', flexWrap: 'wrap' }}
		>
			<div style={{ flex: '1 1 440px', minWidth: 0 }}>
				{/* Header = the short AI display name; the task's real provider title lives
				    in the task block below, with its description. */}
				<h2
					style={{
						fontSize: 20,
						fontWeight: 600,
						color: 'var(--text-0)',
						lineHeight: 1.4,
						marginBottom: 16,
						overflowWrap: 'break-word',
					}}
				>
					{item.displayName ?? item.title}
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

				{item.sourceTask ? (
					<SourceTaskView task={item.sourceTask} title={item.displayName ? item.title : null} />
				) : sourceLoading && item.source ? (
					// Source-backed item whose provider content is still loading: hold the
					// space so it doesn't pop in later and shove the pane down.
					<SourceTaskSkeleton hasTitle={Boolean(item.displayName)} />
				) : null}

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

				{planInfo && <PlanInfoBlock info={planInfo} />}
				{item.plannedAt && <PlanPreview item={item} />}

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
				{item.assessment && <AssessmentPanel assessment={item.assessment} />}
				{hasCommands && (
					<Section title="Actions">
						<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
							{item.allowedActions.map(action => (
								<ActionButton
									key={action.id}
									label={action.label}
									tone={action.tone}
									disabled={actionPending}
									loading={pendingAction === action.id}
									fullWidth
									onClick={() => runAction(action.id)}
								/>
							))}
							{canPlan && (
								<ActionButton
									label={hasPlan ? 'Re-plan' : 'Plan'}
									tone="muted"
									disabled={actionPending || item.status === 'running'}
									loading={pendingPlan}
									fullWidth
									onClick={runPlan}
								/>
							)}
							{canFork && onFork && (
								<ActionButton
									label="Fork"
									tone="muted"
									disabled={actionPending}
									fullWidth
									onClick={() => onFork(item)}
								/>
							)}
						</div>
						{onAiPass && (
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
									AI
								</div>
								<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
									{aiPasses.map(({ pass, label }) => (
										<ActionButton
											key={pass}
											label={pendingAi === pass ? label : `↻ ${label}`}
											tone="muted"
											disabled={pendingAi !== null}
											loading={pendingAi === pass}
											fullWidth
											onClick={() => runAi(pass)}
										/>
									))}
								</div>
							</div>
						)}
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
								<Select
									value={item.status}
									options={ITEM_STATUSES.map(s => ({ value: s, label: s, disabled: s === 'running' }))}
									disabled={item.status === 'running' || pendingStatus}
									fullWidth
									ariaLabel="Set item status"
									title={
										item.status === 'running'
											? 'Cancel the running Item before changing its status'
											: 'Manual status override'
									}
									onChange={async next => {
										if (next === item.status) return
										setPendingStatus(true)
										setActionError(null)
										try {
											await onSetStatus(item.id, next as ItemStatus)
										} catch (err) {
											setActionError(err instanceof Error ? err.message : String(err))
										} finally {
											setPendingStatus(false)
										}
									}}
								/>
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

/** Plan preview — "what we've decided to do": the plan files the user wrote
 *  while planning (prd.md / …), each expandable. The auto-written
 *  context.md / README.md are hidden (the task itself shows above). */
function PlanPreview({ item }: { item: DashboardItem }) {
	const planned = useRelativeTime(item.plannedAt)
	const docs = (item.planArtifacts ?? []).filter(a => {
		const n = a.name.toLowerCase()
		return n !== 'context.md' && n !== 'readme.md'
	})
	return (
		<Section title="Plan">
			<div
				style={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: '4px 16px',
					fontSize: 12,
					color: 'var(--text-3)',
					marginBottom: docs.length ? 12 : 0,
				}}
			>
				{planned && (
					<span>
						planned <strong style={{ color: 'var(--text-1)', fontWeight: 500 }}>{planned} ago</strong>
					</span>
				)}
				{item.plan?.branchName && (
					<span>
						branch{' '}
						<code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}>
							{item.plan.branchName}
						</code>
					</span>
				)}
			</div>
			{docs.length === 0 ? (
				<p style={{ fontSize: 13, color: 'var(--text-4)', lineHeight: 1.5, margin: 0 }}>
					No plan notes yet — only the task context. In the planning agent, run <code>/grill-me</code> to grill the
					decisions, then <code>/prd-create</code> to write the <code>prd.md</code>.
				</p>
			) : (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
					<div style={{ fontSize: 12, color: 'var(--text-3)' }}>
						{docs.length} plan file{docs.length > 1 ? 's' : ''}:
					</div>
					{docs.map(doc => (
						<details key={doc.name} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
							<summary
								style={{
									cursor: 'pointer',
									padding: '7px 10px',
									fontSize: 13,
									fontWeight: 500,
									color: 'var(--accent)',
									fontFamily: 'var(--font-mono)',
								}}
							>
								{doc.name}
							</summary>
							<pre
								style={{
									margin: 0,
									padding: '10px 12px',
									borderTop: '1px solid var(--border)',
									fontSize: 12,
									lineHeight: 1.6,
									color: 'var(--text-2)',
									fontFamily: 'var(--font-sans)',
									whiteSpace: 'pre-wrap',
									wordBreak: 'break-word',
									maxHeight: 360,
									overflow: 'auto',
								}}
							>
								{doc.content}
							</pre>
						</details>
					))}
				</div>
			)}
		</Section>
	)
}

/** Pre-solve intent triage — the "approve the intent, not the output" surface:
 *  restated intent, verdict, clarifying questions, security note. */
function AssessmentPanel({ assessment }: { assessment: Assessment }) {
	const m = VERDICT_META[assessment.verdict]
	const labelStyle = {
		fontSize: 10,
		fontWeight: 700,
		textTransform: 'uppercase' as const,
		letterSpacing: '0.05em',
		marginBottom: 6,
	}
	return (
		<div
			style={{
				marginBottom: 16,
				padding: '14px 16px',
				borderRadius: 'var(--radius)',
				background: 'var(--bg-2)',
				border:
					assessment.verdict === 'security'
						? '1px solid color-mix(in srgb, var(--red) 35%, transparent)'
						: '1px solid var(--border)',
				borderLeft: `3px solid ${TONE_COLOR[m.tone]}`,
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
				<span style={{ ...labelStyle, marginBottom: 0, color: 'var(--text-4)' }}>Intent check</span>
				<span
					style={{
						fontSize: 10,
						fontWeight: 700,
						color: TONE_COLOR[m.tone],
						background: TONE_DIM[m.tone],
						padding: '2px 8px',
						borderRadius: 999,
						display: 'inline-flex',
						alignItems: 'center',
						gap: 4,
					}}
				>
					{m.icon} {m.label}
				</span>
			</div>

			<p
				style={{
					fontSize: 14,
					color: 'var(--text-0)',
					lineHeight: 1.5,
					overflowWrap: 'break-word',
					marginBottom: assessment.clarifyingQuestions.length || assessment.securityNote ? 12 : 0,
				}}
			>
				{assessment.intent}
			</p>

			{assessment.clarifyingQuestions.length > 0 && (
				<div style={{ marginBottom: assessment.securityNote ? 12 : 0 }}>
					<div style={{ ...labelStyle, color: 'var(--amber)' }}>Needs answers</div>
					<ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
						{assessment.clarifyingQuestions.map(q => (
							<li key={q} style={{ display: 'flex', gap: 8, fontSize: 13, color: 'var(--text-1)', lineHeight: 1.45 }}>
								<span style={{ color: 'var(--amber)', flexShrink: 0 }}>?</span>
								<span style={{ overflowWrap: 'break-word', minWidth: 0 }}>{q}</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{assessment.securityNote && (
				<div
					style={{
						fontSize: 12,
						color: 'var(--red)',
						background: 'var(--red-dim)',
						padding: '8px 10px',
						borderRadius: 'var(--radius-sm)',
						lineHeight: 1.45,
						overflowWrap: 'break-word',
					}}
				>
					⚠ {assessment.securityNote}
				</div>
			)}
		</div>
	)
}

/** Placeholder for the description card while GET /items/:id fetches the provider
 *  content. Matches SourceTaskView's shell so the real card fills the reserved
 *  space instead of appearing from nothing and shoving the pane down. */
function SourceTaskSkeleton({ hasTitle }: { hasTitle: boolean }) {
	const bar = (width: string, height = 12) => (
		<div className="vg-pulse" style={{ width, height, background: 'var(--bg-3)', borderRadius: 4 }} />
	)
	return (
		<div
			aria-hidden="true"
			style={{
				background: 'var(--bg-1)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius)',
				padding: '16px 18px',
				marginBottom: 16,
				display: 'flex',
				flexDirection: 'column',
				gap: 10,
			}}
		>
			{hasTitle && bar('55%', 15)}
			{bar('92%')}
			{bar('84%')}
			{bar('68%')}
		</div>
	)
}

/** The source task's actual content — description (with inline images in
 *  document order), metadata, attachments, comments — so the operator can read
 *  the task without leaving Vigil. */
function SourceTaskView({ task, title }: { task: SourceTask; title: string | null }) {
	const metaEntries = task.metadata ? Object.entries(task.metadata) : []
	const comments = task.comments ?? []
	const blocks = task.descriptionBlocks ?? []
	// Images shown inline (in the blocks) shouldn't also appear in the trailing
	// attachments strip.
	const inlineUrls = new Set(blocks.flatMap(b => (b.type === 'image' ? [b.url] : [])))
	const attachments = (task.attachments ?? []).filter(a => !inlineUrls.has(a.url))
	const hasContent =
		task.description || blocks.length > 0 || metaEntries.length > 0 || comments.length > 0 || attachments.length > 0
	if (!title && !hasContent) return null
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
			{/* The task's real (provider) name lives with its description; passed only
			    when the header already shows a distinct short displayName, so it's not duplicated. */}
			{title && (
				<h3
					style={{
						fontSize: 15,
						fontWeight: 600,
						color: 'var(--text-0)',
						lineHeight: 1.4,
						marginBottom: 12,
						overflowWrap: 'break-word',
					}}
				>
					{title}
				</h3>
			)}
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
		</div>
	)
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i
const NON_IMAGE_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|mp[34]|mov|webm|wav|json|xml)(\?|#|$)/i

function safeHttpUrl(url: string): string | null {
	try {
		// Resolve against the dashboard origin so same-origin RELATIVE urls work —
		// ingested-attachment paths are stored relative ("/api/items/<id>/attachments/<name>").
		// Absolute provider urls (https://…) ignore the base. Returns the resolved
		// absolute href; still rejects javascript:/data: etc.
		const u = new URL(url, window.location.origin)
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
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

/** Full-screen image preview. Rendered through a portal on document.body so the
 *  detail pane's overflow can't clip it. Closes on the × button, a click on the
 *  dark backdrop, or Escape; a click on the image itself does NOT close (it sits
 *  above the backdrop button). The backdrop is a real <button> so no click
 *  handler lives on a non-interactive element (keeps a11y lint happy). */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		document.addEventListener('keydown', onKey)
		// Lock background scroll while the modal is open, restore on close.
		const prevOverflow = document.body.style.overflow
		document.body.style.overflow = 'hidden'
		return () => {
			document.removeEventListener('keydown', onKey)
			document.body.style.overflow = prevOverflow
		}
	}, [onClose])

	return createPortal(
		// biome-ignore lint/a11y/useSemanticElements: a React-controlled overlay; native <dialog>.showModal() would need ::backdrop CSS + top-layer/close-event handling that clashes with the inline-style, mount-driven pattern here. role/aria-modal/aria-label + Esc + focusable close buttons keep it accessible.
		<div
			role="dialog"
			aria-modal="true"
			aria-label={alt}
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 1000,
				background: 'rgba(0, 0, 0, 0.82)',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: 24,
			}}
		>
			{/* Full-bleed backdrop button: clicking anywhere outside the image closes. */}
			<button
				type="button"
				onClick={onClose}
				aria-label="Close preview"
				style={{
					position: 'absolute',
					inset: 0,
					background: 'transparent',
					border: 'none',
					cursor: 'zoom-out',
				}}
			/>
			<button
				type="button"
				onClick={onClose}
				aria-label="Close"
				style={{
					position: 'absolute',
					top: 12,
					right: 18,
					fontSize: 30,
					lineHeight: 1,
					color: '#fff',
					background: 'transparent',
					border: 'none',
					cursor: 'pointer',
				}}
			>
				×
			</button>
			<img
				src={src}
				alt={alt}
				style={{
					position: 'relative',
					maxWidth: '92vw',
					maxHeight: '92vh',
					objectFit: 'contain',
					borderRadius: 'var(--radius-sm)',
					boxShadow: '0 8px 40px rgba(0, 0, 0, 0.5)',
				}}
			/>
		</div>,
		document.body,
	)
}

/** An image renders as an inline thumbnail (click to open a full-screen preview
 *  modal — NOT a new tab). A non-image ingested (local) attachment opens in the
 *  host's NATIVE app (the daemon is local) — e.g. an .xlsx in Excel/Numbers —
 *  with a small download fallback; a remote (provider) one stays a plain link.
 *  URL is http(s)-guarded. */
function Attachment({ att }: { att: { name: string; url: string; contentType?: string } }) {
	const [notImage, setNotImage] = useState(false)
	const [openErr, setOpenErr] = useState<string | null>(null)
	const [preview, setPreview] = useState(false)
	const closePreview = useCallback(() => setPreview(false), [])
	const href = safeHttpUrl(att.url)
	if (!href) return null
	// Ingested attachments are served by this (local) daemon at a relative /api
	// path → it can open them in a native app. Remote provider urls cannot.
	const isLocal = att.url.startsWith('/')
	const openNative = () => {
		setOpenErr(null)
		api.openAttachment(att.url).catch(e => setOpenErr(e instanceof Error ? e.message : 'Could not open'))
	}

	if (maybeImage(att) && !notImage) {
		return (
			<>
				<button
					type="button"
					onClick={() => setPreview(true)}
					title={`${att.name} — click to enlarge`}
					style={{ padding: 0, border: 'none', background: 'transparent', cursor: 'zoom-in', display: 'block' }}
				>
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
				</button>
				{preview && <Lightbox src={href} alt={att.name} onClose={closePreview} />}
			</>
		)
	}

	const chipStyle = {
		fontSize: 12,
		color: 'var(--accent)',
		textDecoration: 'none',
		border: '1px solid var(--border)',
		borderRadius: 'var(--radius-sm)',
		padding: '6px 10px',
		background: 'transparent',
		cursor: 'pointer',
		fontFamily: 'inherit',
	} as const

	return (
		<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
			{isLocal ? (
				<button type="button" onClick={openNative} title="Open on this Mac" style={chipStyle}>
					📎 {att.name}
				</button>
			) : (
				<a href={href} target="_blank" rel="noreferrer" style={chipStyle}>
					📎 {att.name}
				</a>
			)}
			{isLocal && (
				<a
					href={href}
					download={att.name}
					title="Download"
					style={{ fontSize: 13, color: 'var(--text-3)', textDecoration: 'none' }}
				>
					↓
				</a>
			)}
			{openErr && <span style={{ fontSize: 11, color: 'var(--red)' }}>{openErr}</span>}
		</span>
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
	loading,
	fullWidth,
	onClick,
}: {
	label: string
	tone: DashboardActionTone
	disabled: boolean
	loading?: boolean
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
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				gap: 7,
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
			{loading && <span className="vg-spin" aria-hidden="true" />}
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
