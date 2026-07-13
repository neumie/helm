// Item detail — a pushed page (§3.10) with a pinned action bar (§3.11).
// Fetches the full item once per open and again only when the cheap snapshot
// shows the row's updatedAt changed; everything else renders from that fetch.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
	AppConfig,
	Assessment,
	DashboardAction,
	DashboardItem,
	HelmResult,
	HelmSnapshot,
	PlanInfo,
	SolverAgentBody,
} from '../../shared-helm'
import { showToast } from '../toast'
import { CHIP_CLASS, VERDICT_META, absoluteUrl, itemTitle, relativeTime, useNow } from './model'
import {
	ActionRow,
	Banner,
	Btn,
	Card,
	Chip,
	ClampText,
	EmptyState,
	FieldLabel,
	GLYPH,
	IconBtn,
	InfoRow,
	MenuButton,
	PushHeader,
	Segmented,
	SelectInput,
} from './ui'

type SolverAgent = 'claude' | 'codex'

export interface DetailPageProps {
	id: string
	snapshot: HelmSnapshot | null
	onBack: () => void
	onOpenPlan: (id: string) => void
	onOpenTask: (id: string) => void
}

// One request per item id + updatedAt, shared across the stacked pages.
// Detail, Plan and Task pages all call useItemDetail for the same id and stay
// mounted under the push stack, so without this a single updatedAt change (or
// stacking a page) fires up to three concurrent GET /items/:id calls — the
// expensive observed route (log read + a `gh pr view` subprocess per call,
// measured ~240ms each with a PR). Entries are one settled promise per item
// viewed this session; errored fetches are evicted so a remount retries.
const detailRequests = new Map<string, { key: string; promise: Promise<HelmResult<DashboardItem>> }>()

function fetchItemDetail(id: string, key: string, force: boolean): Promise<HelmResult<DashboardItem>> {
	const cached = detailRequests.get(id)
	if (!force && cached?.key === key) return cached.promise
	const promise = window.helm.daemon.item(id)
	detailRequests.set(id, { key, promise })
	void promise.then(result => {
		if (result.error !== undefined && detailRequests.get(id)?.promise === promise) detailRequests.delete(id)
	})
	return promise
}

/** Fetch the full item; re-fetch when the list row's updatedAt moves. */
export function useItemDetail(id: string, snapshot: HelmSnapshot | null) {
	const row = useMemo(() => snapshot?.items?.find(i => i.id === id) ?? null, [snapshot?.items, id])
	const [detail, setDetail] = useState<DashboardItem | null>(null)
	const [error, setError] = useState<string | null>(null)
	const rowUpdatedAt = row?.updatedAt ?? null

	const apply = useCallback((result: HelmResult<DashboardItem>) => {
		if (result.error !== undefined) setError(result.error)
		else {
			setError(null)
			setDetail(result.data)
		}
	}, [])

	/** Post-action refresh: always hits the daemon (bypasses the shared cache). */
	const refetch = useCallback(async () => {
		apply(await fetchItemDetail(id, rowUpdatedAt ?? '', true))
	}, [id, rowUpdatedAt, apply])

	// rowUpdatedAt is a deliberate trigger: the cheap poll noticed a change.
	useEffect(() => {
		let alive = true
		void fetchItemDetail(id, rowUpdatedAt ?? '', false).then(result => {
			if (alive) apply(result)
		})
		return () => {
			alive = false
		}
	}, [id, rowUpdatedAt, apply])

	return { item: detail ?? row, fresh: detail !== null, error, refetch }
}

export function DetailPage({ id, snapshot, onBack, onOpenPlan, onOpenTask }: DetailPageProps) {
	const { item, error, refetch } = useItemDetail(id, snapshot)
	const now = useNow()
	const [busyAction, setBusyAction] = useState<string | null>(null)

	// Agent/model picks ride along on the NEXT run-launching action; only
	// touched values are sent so untouched items keep the daemon defaults.
	const config = snapshot?.config ?? null
	const [agent, setAgent] = useState<SolverAgent>((config?.solver?.agent as SolverAgent) ?? 'claude')
	const [model, setModel] = useState('')
	const touched = useRef({ agent: false, model: false })

	if (!item) {
		return (
			<div className="page-frame">
				<PushHeader title="Item" onBack={onBack} />
				{error ? (
					<EmptyState title="Item unavailable" detail={error} />
				) : (
					<EmptyState title="Item not found" detail="It may have been removed. Go back to the list." />
				)}
			</div>
		)
	}

	const isSolve = item.kind === 'solve'
	const preRun = item.status === 'triage' || item.status === 'ready' || item.status === 'failed'
	const showRunSetup = isSolve && preRun && config?.modelCatalog !== undefined
	const catalog = config?.modelCatalog?.[agent] ?? []

	const runBody = (): SolverAgentBody | undefined => {
		if (!isSolve) return undefined
		const body: SolverAgentBody = {}
		if (touched.current.agent) body.solverAgent = agent
		if (touched.current.model) body.solverModel = model === '' ? null : model
		return Object.keys(body).length > 0 ? body : undefined
	}

	const run = async (label: string, key: string, call: () => Promise<{ error?: string }>) => {
		setBusyAction(key)
		try {
			const result = await call()
			if (result.error !== undefined) showToast({ message: `${label} failed`, detail: result.error })
			await refetch()
		} finally {
			setBusyAction(null)
		}
	}

	const runItemAction = (action: DashboardAction) =>
		run(action.label, action.id, () =>
			window.helm.daemon.itemAction(
				item.id,
				action.id,
				action.id === 'approve' || action.id === 'start' || action.id === 'retry' ? runBody() : undefined,
			),
		)

	const runPlan = () =>
		run('Plan', 'plan', async () => {
			const result = await window.helm.daemon.plan(item.id, runBody())
			if (result.error === undefined) {
				const info: PlanInfo = result.data
				showToast({ message: `${info.spawner} planning started`, detail: info.hint, ttlMs: 8000 })
			}
			return result
		})

	const runCreateSourceTask = () =>
		run('Create source task', 'source-task', () => window.helm.daemon.sourceTask(item.id))

	// Action bar: one visible primary (or the sole quiet/danger fallback), the
	// rest in the "…" overflow — §3.11.
	const actions = item.allowedActions
	const primary = actions.find(a => a.tone === 'primary') ?? actions.find(a => a.tone === 'muted') ?? actions[0]
	const rest = actions.filter(a => a !== primary)
	const canPlan = item.status !== 'running'
	const overflow = [
		...rest.map(a => ({ label: a.label, onSelect: () => void runItemAction(a), danger: a.tone === 'danger' })),
		...(canPlan
			? [{ label: item.plannedAt ? 'Re-plan' : 'Plan', onSelect: () => void runPlan(), group: rest.length > 0 }]
			: []),
		...(item.canCreateSourceTask ? [{ label: 'Create source task', onSelect: () => void runCreateSourceTask() }] : []),
	]

	const elapsedStamp =
		item.status === 'running'
			? (item.startedAt ?? item.queuedAt ?? item.createdAt)
			: (item.completedAt ?? item.updatedAt)
	// The status chip already names the state — only "running" earns a word.
	const elapsedLabel = item.status === 'running' ? 'running ' : ''
	const messyRun = item.runOutcome !== null && item.runOutcome !== 'ok'
	const observation = item.runObservation
	const hasTaskContent = Boolean(item.sourceTask) || Boolean(item.source) || item.captured

	const copyBranch = (branch: string) => {
		void navigator.clipboard.writeText(branch).then(() => showToast({ message: 'Branch name copied' }))
	}

	return (
		<div className="page-frame">
			{/* Header names the item (§3.10) — never the literal type word "Item". */}
			<PushHeader title={itemTitle(item)} onBack={onBack} />

			<div className="page-scroll">
				<h1 className="detail-title">{itemTitle(item)}</h1>
				{item.displayName && <div className="detail-subtitle">{item.title}</div>}

				<div className="detail-chips">
					<Chip tone={item.card.statusTone}>{item.card.statusLabel}</Chip>
					{item.kind !== 'solve' && <Chip tone="gray">{item.kind}</Chip>}
					{observation.pr.merged && <Chip tone="green">Merged</Chip>}
					{messyRun && (
						<Chip
							tone="amber"
							title="The run errored or wrote no result — the work may still be fine, verify the branch or PR."
						>
							run: {item.runOutcome === 'no_result' ? 'no result' : item.runOutcome}
						</Chip>
					)}
					<span className="detail-elapsed">
						{elapsedLabel}
						{relativeTime(elapsedStamp, now)}
					</span>
				</div>

				{item.errorMessage && (
					<Banner tone="error" label={`Error${item.errorPhase ? ` — ${item.errorPhase}` : ''}`}>
						{item.errorMessage}
					</Banner>
				)}

				{item.assessment && <AssessmentCard assessment={item.assessment} />}

				{/* Flush rows (§3.15): facts + copy/external at the 28px pitch,
				    push rows (Source/Plan) at the 36px nav pitch. */}
				<Card label="Details" flush>
					<InfoRow label="Project" value={item.projectSlug} />
					<InfoRow label="Kind" value={item.kind} />
					<InfoRow label="Base" value={item.baseRef} mono />
					{item.group && <InfoRow label="Group" value={item.group.label} />}
					<InfoRow label="Created" value={relativeTime(item.createdAt, now)} />
					{item.branchName && (
						<ActionRow
							label="Branch"
							value={item.branchName}
							mono
							glyphKind="copy"
							onClick={() => copyBranch(item.branchName ?? '')}
						/>
					)}
					{item.links.pr?.url && (
						<ActionRow
							label="PR"
							value={prValue(item.links.pr.url)}
							glyphKind="external"
							onClick={() => window.open(item.links.pr?.url ?? '', '_blank')}
						/>
					)}
					{hasTaskContent && (
						<ActionRow
							label={item.source ? 'Source' : 'Task'}
							value={sourceRowValue(item)}
							onClick={() => onOpenTask(item.id)}
						/>
					)}
					{item.plannedAt && (
						<ActionRow
							label="Plan"
							value={`prepared ${relativeTime(item.plannedAt, now)}`}
							onClick={() => onOpenPlan(item.id)}
						/>
					)}
				</Card>

				{observation.source !== 'none' && <RunCard item={item} />}

				{item.resultSummary && (
					<Card label="Result">
						<ClampText text={item.resultSummary} />
					</Card>
				)}

				{item.deployState && (item.deployState.merged || item.deployState.deployments.length > 0) && (
					<Card label="Deploy">
						<div className="chip-row">
							{item.deployState.merged && <Chip tone="green">merged</Chip>}
							{item.deployState.deployments.map(d => (
								<Chip key={d.environment} tone={deployTone(d.state)}>
									{d.environment}: {d.state}
								</Chip>
							))}
							{item.deployState.merged && item.deployState.deployments.length === 0 && (
								<span className="meta-text">no deployments yet</span>
							)}
						</div>
					</Card>
				)}

				{showRunSetup && (
					<Card label="Run with">
						<div className="run-setup">
							<div>
								<FieldLabel>Agent</FieldLabel>
								<Segmented<SolverAgent>
									label="Solver agent"
									commit
									value={agent}
									onChange={next => {
										touched.current.agent = true
										setAgent(next)
										// A model id belongs to one agent's CLI — drop a now-foreign pick.
										if (model && !(config?.modelCatalog?.[next] ?? []).some(m => m.id === model)) {
											touched.current.model = true
											setModel('')
										}
									}}
									options={[
										{ value: 'claude', label: 'Claude' },
										{ value: 'codex', label: 'Codex' },
									]}
								/>
							</div>
							<div>
								<FieldLabel htmlFor="detail-model">Model</FieldLabel>
								<SelectInput
									id="detail-model"
									value={model}
									onChange={next => {
										touched.current.model = true
										setModel(next)
									}}
									options={[
										{ value: '', label: 'Auto (daemon default)' },
										...catalog.map(m => ({ value: m.id, label: m.label })),
									]}
								/>
							</div>
						</div>
					</Card>
				)}
			</div>

			{(primary || overflow.length > 0) && (
				<div className="action-bar">
					{primary && (
						<Btn
							tone={primary.tone === 'primary' ? 'primary' : primary.tone === 'danger' ? 'danger' : 'quiet'}
							block
							busy={busyAction === primary.id}
							disabled={busyAction !== null}
							onClick={() => void runItemAction(primary)}
						>
							{primary.label}
						</Btn>
					)}
					{!primary && canPlan && (
						<Btn
							tone="quiet"
							block
							busy={busyAction === 'plan'}
							disabled={busyAction !== null}
							onClick={() => void runPlan()}
						>
							{item.plannedAt ? 'Re-plan' : 'Plan'}
						</Btn>
					)}
					{overflow.length > 0 && (primary || !canPlan) && (
						<MenuButton triggerLabel="More actions" trigger={GLYPH.ellipsis} entries={overflow} />
					)}
				</div>
			)}
		</div>
	)
}

/** One object, one row (§3.15): the row names its destination — provider plus
 *  a short task id ("Contember #4821") — and pushes the in-app task view.
 *  Opening the provider externally lives on the pushed page's header (↗). */
function sourceRowValue(item: DashboardItem): string {
	if (!item.source) return 'prompt'
	const id = item.source.externalId.trim()
	const short = /^\d+$/.test(id) || id.length <= 8 ? id : id.slice(0, 8)
	return short ? `${item.source.provider} #${short}` : item.source.provider
}

/** PR row value names the destination + number ("GitHub #132", §3.15) —
 *  "GitHub" alone never appears as a value. State lives in the chips. */
function prValue(url: string): string {
	const match = /\/pull\/(\d+)/.exec(url)
	return match ? `GitHub #${match[1]}` : 'Pull request'
}

function deployTone(state: string): 'green' | 'red' | 'gray' | 'blue' {
	if (state === 'success') return 'green'
	if (state === 'failure' || state === 'error') return 'red'
	if (state === 'inactive') return 'gray'
	return 'blue' // pending / in_progress / queued / waiting
}

/** Pre-solve intent check (§3.4 verdict vocabulary): restated intent, verdict
 *  chip, clarifying questions, security note. Advisory only. */
function AssessmentCard({ assessment }: { assessment: Assessment }) {
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
			{assessment.securityNote && <div className="security-note">{assessment.securityNote}</div>}
		</Card>
	)
}

/** Run summary: observed state + summary (clamped) + almanac facts + log well. */
function RunCard({ item }: { item: DashboardItem }) {
	const [showLog, setShowLog] = useState(false)
	const observation = item.runObservation
	// Don't restate what the page already says: the state chip only appears when
	// it differs from the status chip, the summary only when it isn't the Result.
	const chipDiffers = observation.stateLabel.toLowerCase() !== item.card.statusLabel.toLowerCase()
	const summary = observation.summary && observation.summary !== item.resultSummary ? observation.summary : null
	const hasContent =
		chipDiffers ||
		summary !== null ||
		observation.almanac.status !== null ||
		observation.almanac.round !== null ||
		observation.almanac.failureReason !== null ||
		observation.log.available
	if (!hasContent) return null
	return (
		<Card
			label="Run"
			trailing={chipDiffers ? <Chip tone={runTone(observation.state)}>{observation.stateLabel}</Chip> : undefined}
		>
			{summary && <ClampText text={summary} />}
			{observation.almanac.status && <InfoRow label="Loop" value={observation.almanac.status} />}
			{observation.almanac.round && <InfoRow label="Round" value={observation.almanac.round} />}
			{observation.almanac.failureReason && (
				<Banner tone="warning" label="Loop failure">
					{observation.almanac.failureReason}
				</Banner>
			)}
			{observation.log.available && (
				<>
					<button type="button" className="log-toggle" onClick={() => setShowLog(prev => !prev)}>
						{showLog ? 'Hide log' : 'Show log'}
					</button>
					{showLog && (
						<pre className="log-well">
							{observation.log.truncated ? '…\n' : ''}
							{observation.log.content}
						</pre>
					)}
				</>
			)}
		</Card>
	)
}

function runTone(state: DashboardItem['runObservation']['state']): 'blue' | 'green' | 'amber' | 'red' | 'gray' {
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
		default:
			return 'gray'
	}
}

// ---------------------------------------------------------------------------
// Sub-pages pushed from the detail (§3.10 — max 3 levels deep)

/** Plan preview: the user's plan-dir markdown (prd.md / …); auto-written
 *  context.md / README.md stay hidden — the task itself shows elsewhere. */
export function PlanPage({ id, snapshot, onBack }: { id: string; snapshot: HelmSnapshot | null; onBack: () => void }) {
	const { item } = useItemDetail(id, snapshot)
	const docs = (item?.planArtifacts ?? []).filter(a => {
		const name = a.name.toLowerCase()
		return name !== 'context.md' && name !== 'readme.md'
	})
	return (
		<div className="page-frame">
			<PushHeader title="Plan" onBack={onBack} />
			<div className="page-scroll">
				{item?.plan?.branchName && (
					<Card>
						<InfoRow label="Branch" value={item.plan.branchName} mono />
						<InfoRow label="Plan dir" value={item.plan.planDirName} mono />
					</Card>
				)}
				{docs.length === 0 ? (
					<EmptyState
						title="No plan notes yet"
						detail="In the planning agent, run /almanac:prd-create to write the prd.md."
					/>
				) : (
					docs.map((doc, index) => (
						<details key={doc.name} className="plan-doc" open={docs.length === 1 || index === 0}>
							<summary>{doc.name}</summary>
							<pre>{doc.content}</pre>
						</details>
					))
				)}
			</div>
		</div>
	)
}

/** The source task's full content: description blocks, metadata, attachments,
 *  comments. Remote images can't render inline (renderer CSP allows only
 *  self/data:), so image blocks and attachments open externally. */
export function TaskPage({ id, snapshot, onBack }: { id: string; snapshot: HelmSnapshot | null; onBack: () => void }) {
	const { item, fresh } = useItemDetail(id, snapshot)
	const now = useNow()
	const task = item?.sourceTask ?? null
	const daemonUrl = window.helm.config.getDaemonUrl()

	const openExternal = (url: string) => {
		const href = absoluteUrl(url, daemonUrl)
		if (href) window.open(href, '_blank')
	}

	const blocks = task?.descriptionBlocks ?? []
	const inlineUrls = new Set(blocks.flatMap(b => (b.type === 'image' ? [b.url] : [])))
	const attachments = (task?.attachments ?? []).filter(a => !inlineUrls.has(a.url))
	const metadata = task?.metadata ? Object.entries(task.metadata) : []

	// External open lives here, not on the detail's source row (§3.15 — the
	// detail row pushes this page; the pushed page owns the ↗).
	const sourceUrl = item?.links.source?.url ?? null

	return (
		<div className="page-frame">
			<PushHeader
				title="Task"
				onBack={onBack}
				trailing={
					sourceUrl ? (
						<IconBtn
							label={`Open in ${item?.source?.provider ?? 'source'}`}
							onClick={() => window.open(sourceUrl, '_blank')}
						>
							{GLYPH.external}
						</IconBtn>
					) : undefined
				}
			/>
			<div className="page-scroll">
				{!task ? (
					fresh ? (
						<EmptyState title="No task content" detail="The source has no readable content right now." />
					) : (
						<EmptyState title="Loading task" detail="Fetching content from the source." />
					)
				) : (
					<>
						<h1 className="detail-title">{task.title}</h1>
						{metadata.length > 0 && (
							<Card label="Metadata">
								{metadata.map(([key, value]) => (
									<InfoRow key={key} label={key} value={value} />
								))}
							</Card>
						)}
						<div className="task-body">
							{blocks.length > 0
								? blocks.map((block, index) =>
										block.type === 'image' ? (
											<button
												key={`img-${block.url}`}
												type="button"
												className="attachment-row"
												onClick={() => openExternal(block.url)}
											>
												<span className="attachment-name">{block.name ?? `image ${index + 1}`}</span>
												{GLYPH.external}
											</button>
										) : block.heading ? (
											<div key={`h-${block.text.slice(0, 40)}-${index}`} className="task-heading">
												{block.text}
											</div>
										) : (
											<p key={`t-${block.text.slice(0, 40)}-${index}`} className="task-text">
												{block.text}
											</p>
										),
									)
								: task.description && <p className="task-text">{task.description}</p>}
						</div>
						{attachments.length > 0 && (
							<Card label="Attachments">
								{attachments.map(attachment => (
									<button
										key={attachment.url}
										type="button"
										className="attachment-row"
										onClick={() => openExternal(attachment.url)}
									>
										<span className="attachment-name">{attachment.name}</span>
										{GLYPH.external}
									</button>
								))}
							</Card>
						)}
						{(task.comments ?? []).length > 0 && (
							<Card label="Comments">
								{(task.comments ?? []).map(comment => (
									<div key={`${comment.createdAt}-${comment.author}`} className="comment">
										<div className="comment-meta">
											{comment.author} · {relativeTime(comment.createdAt, now)}
										</div>
										<div className="comment-body">{comment.body}</div>
									</div>
								))}
							</Card>
						)}
					</>
				)}
			</div>
		</div>
	)
}
