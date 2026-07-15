import type { Assessment, DashboardItem } from '../../shared-helm'
import { CHIP_CLASS, VERDICT_META, openExternalUrl, planStatusLabel, relativeTime } from './model'
import { ActionRow, Card, Chip, ClampText, InfoRow } from './ui'

export function IntentCard({
	assessment,
	hideSecurityNote = false,
}: { assessment: Assessment | null; hideSecurityNote?: boolean }) {
	if (!assessment) return null
	const meta = VERDICT_META[assessment.verdict]
	return (
		<Card
			label="Intent"
			trailing={
				<Chip tone={meta.tone}>
					{meta.icon} {meta.label}
				</Chip>
			}
		>
			<p className="intent-text">{assessment.intent}</p>
			{assessment.clarifyingQuestions.length > 0 && (
				<ul className="intent-questions">
					{assessment.clarifyingQuestions.map(question => (
						<li key={question}>
							<span className={`question-mark ${CHIP_CLASS.amber}`}>?</span>
							<span>{question}</span>
						</li>
					))}
				</ul>
			)}
			{assessment.securityNote && !hideSecurityNote && <div className="security-note">{assessment.securityNote}</div>}
		</Card>
	)
}

export function StateSummary({ headline, direction }: { headline: string; direction: string }) {
	return (
		<div className="detail-state">
			<h2>{headline}</h2>
			<p className="state-direction">{direction}</p>
		</div>
	)
}

export function OutcomeCard({ item }: { item: DashboardItem }) {
	if (!item.resultSummary && !item.links.pr?.url && !item.branchName) return null
	return (
		<Card label="Outcome">
			{item.resultSummary ? (
				<ClampText text={item.resultSummary} lines={2} />
			) : (
				<p className="section-description">No solver summary — check run details before marking done.</p>
			)}
			{item.links.pr?.url && (
				<ActionRow
					label="Pull request"
					value={prValue(item.links.pr.url)}
					glyphKind="external"
					onClick={() => openExternalUrl(item.links.pr?.url ?? '', window.helm.config.getDaemonUrl())}
				/>
			)}
			{item.branchName && (
				<ActionRow
					label="Branch"
					value={item.branchName}
					mono
					glyphKind="copy"
					onClick={() => void navigator.clipboard.writeText(item.branchName ?? '')}
				/>
			)}
		</Card>
	)
}

export function FailureCard({ item, hideError = false }: { item: DashboardItem; hideError?: boolean }) {
	const message = item.status === 'cancelled' ? cancellationText(item) : hideError ? null : item.errorMessage
	if (!message && item.status !== 'failed') return null
	return (
		<Card label={item.status === 'cancelled' ? 'Stopped' : 'Failure'}>
			<p className="section-description">
				{message ?? 'No solver result was recorded. Check run details and the branch before retrying.'}
			</p>
		</Card>
	)
}

export function ProgressCard({ item, now }: { item: DashboardItem; now: number }) {
	const observation = item.runObservation
	const latest = observation.events[observation.events.length - 1]
	const summary =
		observation.summary && observation.summary !== item.resultSummary && observation.summary !== item.errorMessage
			? observation.summary
			: null
	return (
		<Card label="Progress">
			<InfoRow label="Started" value={relativeTime(item.startedAt ?? item.queuedAt ?? item.createdAt, now)} />
			{summary && <ClampText text={summary} />}
			{latest && <p className="section-description">Latest: {latest.label}</p>}
			{observation.almanac.round && <InfoRow label="Round" value={observation.almanac.round} />}
		</Card>
	)
}

export function WorkCard({
	item,
	now,
	onTask,
	onPlan,
	onRun,
	onSetup,
	onOpenOkena,
	okenaWorkspaceValue,
	disabled,
	onlySetup = false,
}: {
	item: DashboardItem
	now: number
	onTask: () => void
	onPlan: () => void
	onRun: () => void
	onSetup: () => void
	onOpenOkena: () => void
	okenaWorkspaceValue: string
	disabled?: boolean
	onlySetup?: boolean
}) {
	if (onlySetup)
		return (
			<ActionRow nav label="Run setup" value="Agent, model, effort, workspace" onClick={onSetup} disabled={disabled} />
		)
	const hasTask = Boolean(item.source || item.captured || item.sourceTask)
	const hasRun =
		item.workMode === 'agent' &&
		(item.runObservation.source !== 'none' || item.resultSummary || item.errorMessage || item.solveInputSnapshot)
	const runFirst = !['inbox', 'ready', 'active'].includes(item.status)
	const run = hasRun && (
		<ActionRow nav label="Run details" value={item.runObservation.stateLabel} onClick={onRun} disabled={disabled} />
	)
	const task = hasTask && (
		<ActionRow
			nav
			label={item.captured ? 'Imported task' : 'Task'}
			value={sourceValue(item)}
			onClick={onTask}
			disabled={disabled}
		/>
	)
	const plan = item.plannedAt && (
		<ActionRow
			nav
			label="Plan"
			value={planStatusLabel(item) ?? `Prepared ${relativeTime(item.plannedAt, now)}`}
			onClick={onPlan}
			disabled={disabled}
		/>
	)
	return (
		<Card label="Work" flush>
			{runFirst && run}
			{task}
			{plan}
			{!runFirst && run}
			<ActionRow
				label="Workspace"
				value={okenaWorkspaceValue}
				glyphKind="external"
				onClick={onOpenOkena}
				disabled={disabled}
			/>
		</Card>
	)
}

export function DeliveryCard({ item }: { item: DashboardItem }) {
	const state = item.deployState
	if (!state || (!state.merged && state.deployments.length === 0)) return null
	return (
		<Card label="Delivery" flush>
			{state.merged && <InfoRow label="Merge" value="Merged" />}
			{state.deployments.map(deployment =>
				deployment.url ? (
					<ActionRow
						key={deployment.environment}
						label={deployment.environment}
						value={deployment.state}
						glyphKind="external"
						onClick={() => openExternalUrl(deployment.url ?? '', window.helm.config.getDaemonUrl())}
					/>
				) : (
					<InfoRow key={deployment.environment} label={deployment.environment} value={deployment.state} />
				),
			)}
		</Card>
	)
}

function sourceValue(item: DashboardItem) {
	if (!item.source) return item.captured ? 'Imported' : 'Prompt'
	const id = item.source.externalId.trim()
	return id ? `${item.source.provider} #${id.length > 8 ? id.slice(0, 8) : id}` : item.source.provider
}
function prValue(url: string) {
	const match = /\/pull\/(\d+)/.exec(url)
	return match ? `GitHub #${match[1]}` : 'Pull request'
}
function cancellationText(item: DashboardItem) {
	return item.runObservation.events.find(event => event.type === 'item_rejected')
		? 'Intent was rejected.'
		: (item.errorMessage ?? 'Cancelled by user.')
}
