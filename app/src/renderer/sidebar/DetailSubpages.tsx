import { useId, useState } from 'react'
import type { HelmSnapshot } from '../../shared-helm'
import { useItemDetail } from './detail-data'
import { absoluteUrl, openExternalUrl, relativeTime, useNow } from './model'
import { type RunSelectionDraft, effectiveRunSelection, selectAgent } from './run-selection'
import {
	Card,
	ClampText,
	EmptyState,
	FieldLabel,
	GLYPH,
	IconBtn,
	InfoRow,
	PushHeader,
	Segmented,
	SelectInput,
} from './ui'

interface DetailSubpageProps {
	id: string
	snapshot: HelmSnapshot | null
	onBack: () => void
}

function Unavailable({ title, error, retry }: { title: string; error: string | null; retry: () => Promise<void> }) {
	return (
		<>
			<div className="detail-fetch-alert" role="alert">
				Latest detail is unavailable: {error ?? 'Unknown error'}
				<button type="button" className="detail-disclosure" onClick={() => void retry()}>
					Retry
				</button>
			</div>
			<EmptyState title={title} detail="Try again when the daemon is available." />
		</>
	)
}

function TaskImage({
	url,
	name,
	index,
	daemonUrl,
	onOpen,
}: {
	url: string
	name?: string
	index: number
	daemonUrl: string
	onOpen: (url: string) => void
}) {
	const [failed, setFailed] = useState(false)
	const src = absoluteUrl(url, daemonUrl)
	const label = name ?? `Image ${index + 1}`
	if (!src || failed)
		return (
			<button type="button" className="attachment-row" onClick={() => onOpen(url)}>
				<span className="attachment-name">{label}</span>
				{GLYPH.external}
			</button>
		)
	return (
		<button type="button" className="task-image" aria-label={`Open ${label}`} onClick={() => onOpen(url)}>
			<img src={src} alt={name ?? ''} loading="lazy" onError={() => setFailed(true)} />
			<span className="task-image-caption">
				{label} {GLYPH.external}
			</span>
		</button>
	)
}

export function PlanPage({ id, snapshot, onBack }: DetailSubpageProps) {
	const { item, phase, error, refetch, hasDetail } = useItemDetail(id, snapshot)
	const docs = (item?.planArtifacts ?? []).filter(doc => !['context.md', 'readme.md'].includes(doc.name.toLowerCase()))
	return (
		<div className="page-frame">
			<PushHeader title="Plan" onBack={onBack} />
			<div className="page-scroll" aria-busy={phase === 'loading'}>
				{!hasDetail && phase !== 'loading' ? (
					<Unavailable
						title={phase === 'not-found' ? 'Item not found' : 'Plan unavailable'}
						error={error}
						retry={refetch}
					/>
				) : !hasDetail && phase === 'loading' ? (
					<EmptyState title="Loading plan" detail="Fetching the latest plan details." />
				) : (
					<>
						{phase === 'stale-error' && <FetchAlert error={error} retry={refetch} />}
						{item?.plan && (
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
									{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Read-only scroll well needs keyboard focus. */}
									<section className="plan-well" tabIndex={0} aria-label={`${doc.name} contents`}>
										{doc.content}
									</section>
								</details>
							))
						)}
					</>
				)}
			</div>
		</div>
	)
}

export function TaskPage({ id, snapshot, onBack }: DetailSubpageProps) {
	const { item, phase, error, refetch, hasDetail } = useItemDetail(id, snapshot)
	const now = useNow()
	const task = item?.sourceTask ?? null
	const daemonUrl = window.helm.config.getDaemonUrl()
	const open = (url: string) => openExternalUrl(url, daemonUrl)
	const blocks = task?.descriptionBlocks ?? []
	const imageUrls = new Set(blocks.flatMap(block => (block.type === 'image' ? [block.url] : [])))
	const attachments = task?.attachments?.filter(attachment => !imageUrls.has(attachment.url)) ?? []
	const sourceIdentity = item?.source?.provider ?? 'Imported task'
	return (
		<div className="page-frame">
			<PushHeader
				title={item?.captured ? 'Imported task' : 'Task'}
				onBack={onBack}
				trailing={
					item?.links.source?.url ? (
						<IconBtn label="Open source" onClick={() => openExternalUrl(item.links.source?.url ?? '', daemonUrl)}>
							{GLYPH.external}
						</IconBtn>
					) : undefined
				}
			/>
			<div className="page-scroll task-page-scroll" aria-busy={phase === 'loading'}>
				{!hasDetail && phase !== 'loading' ? (
					<Unavailable
						title={phase === 'not-found' ? 'Item not found' : 'Task unavailable'}
						error={error}
						retry={refetch}
					/>
				) : !hasDetail && phase === 'loading' ? (
					<EmptyState title="Loading task" detail="Fetching content from the source." />
				) : !task ? (
					<>
						{phase === 'stale-error' && <FetchAlert error={error} retry={refetch} />}
						<EmptyState title="No task content" detail="The source has no readable content right now." />
					</>
				) : (
					<>
						{phase === 'stale-error' && <FetchAlert error={error} retry={refetch} />}
						<article className="task-detail">
							<header className="task-hero">
								<div className="task-source-line">{sourceIdentity}</div>
								<h2 className="task-title">{task.title}</h2>
							</header>
							{(blocks.length > 0 || task.description) && (
								<section className="task-section" aria-labelledby="task-description-heading">
									<h3 id="task-description-heading" className="section-label">
										Description
									</h3>
									<div className="task-body">
										{blocks.length
											? blocks.map((block, index) =>
													block.type === 'image' ? (
														<TaskImage
															key={`${index}-${block.url}`}
															url={block.url}
															name={block.name}
															index={index}
															daemonUrl={daemonUrl}
															onOpen={open}
														/>
													) : block.heading ? (
														<h4 key={`${index}-${block.text}`} className="task-heading">
															{block.text}
														</h4>
													) : (
														<p key={`${index}-${block.text}`} className="task-text">
															{block.text}
														</p>
													),
												)
											: task.description && <p className="task-text">{task.description}</p>}
									</div>
								</section>
							)}
							{attachments.length > 0 && (
								<section className="task-section" aria-labelledby="task-attachments-heading">
									<h3 id="task-attachments-heading" className="section-label">
										Attachments
									</h3>
									<div className="task-attachment-list">
										{attachments.map(attachment => (
											<button
												key={attachment.url}
												type="button"
												className="attachment-row"
												onClick={() => open(attachment.url)}
											>
												<span className="attachment-name">{attachment.name}</span>
												{GLYPH.external}
											</button>
										))}
									</div>
								</section>
							)}
							{(task.comments ?? []).length > 0 && (
								<section className="task-section" aria-labelledby="task-comments-heading">
									<h3 id="task-comments-heading" className="section-label">
										Comments
									</h3>
									<div className="task-comments">
										{task.comments?.map(comment => (
											<div key={`${comment.author}-${comment.createdAt}`} className="comment">
												<div className="comment-meta">
													{comment.author} · {relativeTime(comment.createdAt, now)}
												</div>
												<div className="comment-body">{comment.body}</div>
											</div>
										))}
									</div>
								</section>
							)}
							{task.metadata && Object.keys(task.metadata).length > 0 && (
								<details className="task-metadata">
									<summary>Metadata</summary>
									<div className="task-metadata-rows">
										{Object.entries(task.metadata).map(([key, value]) => (
											<InfoRow key={key} label={key} value={value} />
										))}
									</div>
								</details>
							)}
						</article>
					</>
				)}
			</div>
		</div>
	)
}

export function RunDetailsPage({ id, snapshot, onBack }: DetailSubpageProps) {
	const { item, phase, error, refetch, hasDetail } = useItemDetail(id, snapshot)
	const [all, setAll] = useState(false)
	const [showLog, setShowLog] = useState(false)
	const [showInput, setShowInput] = useState(false)
	const listId = useId()
	const wellTabIndex = 0
	if (!hasDetail)
		return (
			<div className="page-frame">
				<PushHeader title="Run details" onBack={onBack} />
				<div className="page-scroll" aria-busy={phase === 'loading'}>
					{phase === 'loading' ? (
						<EmptyState title="Loading run" detail="Fetching the latest run details." />
					) : (
						<Unavailable title="Run unavailable" error={error} retry={refetch} />
					)}
				</div>
			</div>
		)
	if (!item) return null
	const observation = item.runObservation
	const events = [...observation.events].reverse()
	const visible = all ? events : events.slice(0, 5)
	return (
		<div className="page-frame">
			<PushHeader title="Run details" onBack={onBack} />
			<div className="page-scroll" aria-busy={phase === 'loading'}>
				{phase === 'stale-error' && <FetchAlert error={error} retry={refetch} />}
				<Card label="Run">
					<InfoRow label="State" value={observation.stateLabel} />
					{observation.summary &&
						observation.summary !== item.resultSummary &&
						observation.summary !== item.errorMessage && <ClampText text={observation.summary} />}
					{observation.almanac.status && <InfoRow label="Loop" value={observation.almanac.status} />}
					{observation.almanac.round && <InfoRow label="Round" value={observation.almanac.round} />}
				</Card>
				{events.length > 0 && (
					<Card label="Activity">
						<ol id={listId} className="activity-list">
							{visible.map(event => (
								<li key={`${event.type}-${event.createdAt}`} className="activity-item">
									<span>{event.label}</span>
									<time className="activity-time" dateTime={event.createdAt ?? undefined}>
										{relativeTime(event.createdAt, Date.now())}
									</time>
								</li>
							))}
						</ol>
						{events.length > 5 && (
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
				)}
				{item.resultSummary && (
					<Card label="Result">
						<ClampText text={item.resultSummary} />
					</Card>
				)}
				{item.solveInputSnapshot && (
					<Card label="Solve input">
						<button
							type="button"
							className="detail-disclosure"
							aria-expanded={showInput}
							aria-controls={`${listId}-input`}
							onClick={() => setShowInput(value => !value)}
						>
							{showInput ? 'Hide input' : 'Show input'}
						</button>
						{showInput && (
							<section id={`${listId}-input`} tabIndex={wellTabIndex} aria-label="Solve input" className="log-well">
								{item.solveInputSnapshot}
							</section>
						)}
					</Card>
				)}
				{observation.log.available && (
					<Card label="Log">
						<button
							type="button"
							className="detail-disclosure"
							aria-expanded={showLog}
							aria-controls={`${listId}-log`}
							onClick={() => setShowLog(value => !value)}
						>
							{showLog ? 'Hide log' : 'Show log'}
						</button>
						{showLog && (
							<section id={`${listId}-log`} tabIndex={wellTabIndex} aria-label="Run log" className="log-well">
								{observation.log.truncated ? '…\n' : ''}
								{observation.log.content}
							</section>
						)}
					</Card>
				)}
			</div>
		</div>
	)
}

export function RunSetupPage({
	id,
	snapshot,
	onBack,
	draft,
	onDraftChange,
}: DetailSubpageProps & { draft: RunSelectionDraft; onDraftChange: (next: RunSelectionDraft) => void }) {
	const { item, phase, error, refetch, hasDetail } = useItemDetail(id, snapshot)
	const config = snapshot?.config ?? null
	if (!hasDetail)
		return (
			<div className="page-frame">
				<PushHeader title="Run setup" onBack={onBack} />
				<div className="page-scroll" aria-busy={phase === 'loading'}>
					{phase === 'loading' ? (
						<EmptyState title="Loading run setup" detail="Fetching item details." />
					) : (
						<Unavailable title="Run setup unavailable" error={error} retry={refetch} />
					)}
				</div>
			</div>
		)
	if (!item) return null
	const selection = effectiveRunSelection(item, config, draft)
	const catalog = config?.modelCatalog?.[selection.agent] ?? []
	return (
		<div className="page-frame">
			<PushHeader title="Run setup" onBack={onBack} />
			<div className="page-scroll" aria-busy={phase === 'loading'}>
				{phase === 'stale-error' && <FetchAlert error={error} retry={refetch} />}
				<Card label="Run with">
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
									<button
										className="field-reset"
										type="button"
										onClick={() => onDraftChange({ ...draft, model: null })}
									>
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
				</Card>
			</div>
		</div>
	)
}

function FetchAlert({ error, retry }: { error: string | null; retry: () => Promise<void> }) {
	return (
		<div className="detail-fetch-alert" role="alert">
			<span>Latest detail is unavailable: {error ?? 'Unknown error'}</span>
			<button type="button" className="detail-disclosure" onClick={() => void retry()}>
				Retry
			</button>
		</div>
	)
}
