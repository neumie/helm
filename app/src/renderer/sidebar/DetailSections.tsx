// Detail page sections — the one flat editorial stack (§3.15). Run evidence
// (activity, log, solve input) and run setup live INLINE here (§3.20 inline
// disclosure); only the two long-form reading surfaces (Task, Plan documents)
// remain pushed pages.
import { useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppConfig, Assessment, DashboardItem } from '../../shared-helm'
import {
	CHIP_CLASS,
	VERDICT_META,
	logMessagesNewestFirst,
	openExternalUrl,
	planStatusLabel,
	planTicketCounts,
	relativeTime,
} from './model'
import {
	EFFORT_LABEL,
	type RunSelectionDraft,
	effectiveRunSelection,
	selectAgent,
	selectionSummary,
} from './run-selection'
import { ActionRow, Card, Chip, ClampText, Disclosure, FieldLabel, InfoRow, Segmented, SelectInput } from './ui'

export function IntentCard({
	assessment,
	hideSecurityNote = false,
}: { assessment: Assessment | null; hideSecurityNote?: boolean }) {
	if (!assessment) return null
	const meta = VERDICT_META[assessment.verdict]
	return (
		<Card label="Intent" trailing={<Chip tone={meta.tone}>{meta.label}</Chip>}>
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
				<ClampText text={item.resultSummary} />
			) : (
				<p className="section-description">No solver summary — check the activity and log before marking done.</p>
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
				{message ?? 'No solver result was recorded. Check the log and the branch before retrying.'}
			</p>
		</Card>
	)
}

/** The old Run-details gate: only agent-run items carry run evidence. */
function hasRunEvidence(item: DashboardItem): boolean {
	return (
		item.workMode === 'agent' &&
		(item.runObservation.source !== 'none' ||
			Boolean(item.resultSummary || item.errorMessage || item.solveInputSnapshot))
	)
}

/** Read-only mono scroll well — the one owner of the well's a11y contract. */
function EvidenceWell({ label, children }: { label: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: read-only scroll well needs keyboard focus.
		<section tabIndex={0} aria-label={label} className="log-well">
			{children}
		</section>
	)
}

/** Inline run history: started/loop facts + the latest-first event timeline.
 *  Running shows 5 events before "Show all"; settled states show 3. Running
 *  always renders (the observation may lag the row while the detail loads). */
export function ActivitySection({ item, now }: { item: DashboardItem; now: number }) {
	const [all, setAll] = useState(false)
	const listId = useId()
	const observation = item.runObservation
	const events = useMemo(() => [...observation.events].reverse(), [observation.events])
	if (!hasRunEvidence(item) && item.status !== 'running') return null
	const initial = item.status === 'running' ? 5 : 3
	const visible = all ? events : events.slice(0, initial)
	const summary =
		observation.summary && observation.summary !== item.resultSummary && observation.summary !== item.errorMessage
			? observation.summary
			: null
	return (
		<Card label="Activity">
			<InfoRow label="Started" value={relativeTime(item.startedAt ?? item.queuedAt ?? item.createdAt, now)} />
			{item.status === 'running' && observation.stateLabel && <InfoRow label="State" value={observation.stateLabel} />}
			{observation.almanac.status && <InfoRow label="Loop" value={observation.almanac.status} />}
			{observation.almanac.round && <InfoRow label="Round" value={observation.almanac.round} />}
			{summary && <ClampText text={summary} />}
			{events.length > 0 && (
				<ol id={listId} className="activity-list">
					{visible.map((event, index) => (
						<li key={`${event.type}-${event.createdAt}-${index}`} className="activity-item">
							<span>{event.label}</span>
							<time className="activity-time" dateTime={event.createdAt ?? undefined}>
								{relativeTime(event.createdAt, now)}
							</time>
						</li>
					))}
				</ol>
			)}
			{events.length > initial && (
				<button
					type="button"
					className="detail-disclosure"
					aria-controls={listId}
					aria-expanded={all}
					onClick={() => setAll(value => !value)}
				>
					{all ? 'Show less' : 'Show all'}
				</button>
			)}
		</Card>
	)
}

const LIVE_TAIL_MS = 5000

/** The run log, inline. `defaultOpen` comes from detail-state (failed only).
 *  The two newest messages remain visible while collapsed; expanding reveals
 *  every available message in the same newest-first order. While a running
 *  Item's detail is the top nav layer, `onLiveTick` quietly refreshes this
 *  preview. Ticks self-reschedule only after the previous fetch resolves, so a
 *  slow detail request can never stack. */
export function LogSection({
	item,
	defaultOpen,
	live,
	onLiveTick,
}: {
	item: DashboardItem
	defaultOpen?: boolean
	/** True only while the item runs and this page is on top of the nav stack. */
	live?: boolean
	onLiveTick?: () => Promise<void>
}) {
	const [open, setOpen] = useState(defaultOpen ?? false)
	useEffect(() => {
		if (!live || !onLiveTick) return
		let alive = true
		let timer: number
		const tick = async () => {
			await onLiveTick().catch(() => {})
			if (alive) timer = window.setTimeout(() => void tick(), LIVE_TAIL_MS)
		}
		timer = window.setTimeout(() => void tick(), LIVE_TAIL_MS)
		return () => {
			alive = false
			clearTimeout(timer)
		}
	}, [live, onLiveTick])
	const log = item.runObservation.log
	const messages = useMemo(() => logMessagesNewestFirst(log.content), [log.content])
	const visible = open ? messages : messages.slice(0, 2)
	const listId = useId()
	if (!log.available || messages.length === 0) return null
	return (
		<Card label="Log">
			<EvidenceWell label="Run log">
				<span id={listId}>{visible.join('\n')}</span>
				{open && log.truncated ? '\n… older log output omitted' : ''}
			</EvidenceWell>
			{messages.length > 2 && (
				<button
					type="button"
					className="detail-disclosure"
					aria-controls={listId}
					aria-expanded={open}
					onClick={() => setOpen(value => !value)}
				>
					{open ? 'Show less' : 'Show all'}
				</button>
			)}
		</Card>
	)
}

export function InputSection({ item }: { item: DashboardItem }) {
	if (!item.solveInputSnapshot) return null
	return (
		<Card label="Solve input">
			<Disclosure label="Show input" hideLabel="Hide input">
				<EvidenceWell label="Solve input">{item.solveInputSnapshot}</EvidenceWell>
			</Disclosure>
		</Card>
	)
}

/** Run setup, inline: the effective selection reads at rest (zero clicks);
 *  the four pickers (relocated from the retired Run setup page) open in
 *  place. Draft edits are local until a run action sends them (buildRunBody),
 *  so the fields stay live while other commands run. */
export function SetupSection({
	item,
	config,
	draft,
	onDraftChange,
}: {
	item: DashboardItem
	config: AppConfig | null
	draft: RunSelectionDraft
	onDraftChange: (next: RunSelectionDraft) => void
}) {
	if (item.kind !== 'solve') return null
	const selection = effectiveRunSelection(item, config, draft)
	const catalog = config?.modelCatalog?.[selection.agent] ?? []
	const effortOptions = [
		{ value: '', label: 'Default (agent)' },
		...(['low', 'medium', 'high', 'xhigh'] as const).map(value => ({ value, label: EFFORT_LABEL[value] })),
		...(selection.agent === 'claude' ? [{ value: 'max', label: EFFORT_LABEL.max }] : []),
	]
	return (
		<Card label="Run setup">
			<p className="run-setup-summary">{selectionSummary(selection)}</p>
			<Disclosure label="Change setup" hideLabel="Hide setup">
				<div className="run-setup">
					<div>
						<FieldLabel>Agent</FieldLabel>
						<Segmented
							label="Solver agent"
							commit
							value={selection.agent}
							onChange={agent => onDraftChange(selectAgent(draft, agent, config))}
							options={[
								{ value: 'claude', label: 'Claude' },
								{ value: 'codex', label: 'Codex' },
							]}
						/>
					</div>
					<div>
						<div className="run-field-head">
							<FieldLabel htmlFor="run-model">Model</FieldLabel>
							{(draft.model !== undefined || item.solverModel !== null) && (
								<button className="field-reset" type="button" onClick={() => onDraftChange({ ...draft, model: null })}>
									Default
								</button>
							)}
						</div>
						<SelectInput
							id="run-model"
							value={selection.model ?? ''}
							onChange={model => onDraftChange({ ...draft, model: model || null })}
							options={[
								{ value: '', label: 'Default (daemon)' },
								...catalog.map(model => ({ value: model.id, label: model.label })),
							]}
						/>
					</div>
					<div>
						<div className="run-field-head">
							<FieldLabel htmlFor="run-effort">Effort</FieldLabel>
							{(draft.effort !== undefined || item.solverEffort !== null) && (
								<button className="field-reset" type="button" onClick={() => onDraftChange({ ...draft, effort: null })}>
									Default
								</button>
							)}
						</div>
						<SelectInput
							id="run-effort"
							value={selection.effort ?? ''}
							onChange={effort => onDraftChange({ ...draft, effort: (effort || null) as RunSelectionDraft['effort'] })}
							options={effortOptions}
						/>
						<p className="run-caption">Used by Start loop.</p>
					</div>
					<div>
						<div className="run-field-head">
							<FieldLabel>Workspace</FieldLabel>
							{(draft.workspace !== undefined || item.solverWorkspace !== null) && (
								<button
									className="field-reset"
									type="button"
									onClick={() => onDraftChange({ ...draft, workspace: null })}
								>
									Default
								</button>
							)}
						</div>
						<Segmented
							label="Execution workspace"
							value={selection.workspace}
							onChange={workspace => onDraftChange({ ...draft, workspace })}
							options={[
								{ value: 'worktree', label: 'Worktree' },
								{ value: 'main', label: 'Main' },
							]}
						/>
						{selection.workspace === 'main' && (
							<p className="run-caption">Runs in the project’s checkout — shares your working tree.</p>
						)}
					</div>
				</div>
			</Disclosure>
		</Card>
	)
}

/** Inline plan status facts; the documents themselves stay a pushed reading
 *  page. The planned-active hero already carries plan status — no repeat. */
export function PlanSection({
	item,
	now,
	onOpen,
	disabled,
}: { item: DashboardItem; now: number; onOpen: () => void; disabled?: boolean }) {
	if (!item.plannedAt) return null
	const status = item.planStatus
	const heroOwnsStatus = item.status === 'active' && status != null
	const docs = (item.planArtifacts ?? []).filter(doc => !['context.md', 'readme.md'].includes(doc.name.toLowerCase()))
	// '…' while the full detail (the only carrier of planArtifacts) is loading —
	// a nav row must never show a blank value (§3.15).
	const docsValue =
		item.planArtifacts === undefined
			? '…'
			: docs.length === 0
				? 'None yet'
				: `${docs.length} ${docs.length === 1 ? 'note' : 'notes'}`
	const tickets = status ? planTicketCounts(status) : null
	return (
		<Card label="Plan" flush>
			{!heroOwnsStatus && (
				<InfoRow label="Status" value={planStatusLabel(item) ?? `Prepared ${relativeTime(item.plannedAt, now)}`} />
			)}
			{status?.specName && <InfoRow label="Spec" value={status.specName} mono />}
			{tickets && tickets.open > 0 && (
				<InfoRow label="Tickets" value={`${tickets.open} open · ${tickets.agent} agent · ${tickets.human} human`} />
			)}
			<ActionRow nav label="Plan documents" value={docsValue} onClick={onOpen} disabled={disabled} />
		</Card>
	)
}

/** The one remaining push row to the source reading surface (§3.19). */
export function SourceRow({ item, onOpen, disabled }: { item: DashboardItem; onOpen: () => void; disabled?: boolean }) {
	if (!item.source && !item.captured && !item.sourceTask) return null
	return (
		<Card flush>
			<ActionRow
				nav
				label={item.captured ? 'Imported task' : 'Task'}
				value={sourceValue(item)}
				onClick={onOpen}
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
