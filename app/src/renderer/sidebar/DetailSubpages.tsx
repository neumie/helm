// The two pushed reading surfaces under detail: Plan documents and the Task
// source (§3.19). Run evidence and run setup are inline on the detail page.
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { HelmSnapshot } from '../../shared-helm'
import { useItemDetail } from './detail-data'
import { absoluteUrl, openExternalUrl, relativeTime, useNow } from './model'
import { Card, EmptyState, GLYPH, IconBtn, InfoRow, PushHeader } from './ui'

interface DetailSubpageProps {
	id: string
	snapshot: HelmSnapshot | null
	onBack: () => void
}

/** Shared shell for the Task and Plan documents reading surfaces. Keeping the
 * push header and 16px document gutter here prevents the peer pages drifting. */
function ReadingPage({
	title,
	onBack,
	trailing,
	busy,
	children,
}: {
	title: string
	onBack: () => void
	trailing?: ReactNode
	busy: boolean
	children: ReactNode
}) {
	return (
		<div className="page-frame">
			<PushHeader title={title} onBack={onBack} trailing={trailing} />
			<div className="page-scroll reading-page-scroll" aria-busy={busy}>
				{children}
			</div>
		</div>
	)
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
		<ReadingPage title="Plan documents" onBack={onBack} busy={phase === 'loading'}>
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
						<Card label="Workspace" flush>
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
						<Card label="Notes">
							{docs.map((doc, index) => (
								<details key={doc.name} className="plan-doc" open={docs.length === 1 || index === 0}>
									<summary>{doc.name}</summary>
									{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Read-only scroll well needs keyboard focus. */}
									<section className="plan-well" tabIndex={0} aria-label={`${doc.name} contents`}>
										{doc.content}
									</section>
								</details>
							))}
						</Card>
					)}
				</>
			)}
		</ReadingPage>
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
		<ReadingPage
			title={item?.captured ? 'Imported task' : 'Task'}
			onBack={onBack}
			busy={phase === 'loading'}
			trailing={
				item?.links.source?.url ? (
					<IconBtn label="Open source" onClick={() => openExternalUrl(item.links.source?.url ?? '', daemonUrl)}>
						{GLYPH.external}
					</IconBtn>
				) : undefined
			}
		>
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
		</ReadingPage>
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
