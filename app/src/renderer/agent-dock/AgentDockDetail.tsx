// Agent dock detail popover bodies (design §3.24). Read-only slice 1: answer
// controls render in place but stay disabled with the way out in words ("Answer
// in the terminal for now"); Ack on turns and orphaned items is the only live
// action. Agent text is untrusted and always plain React text.

import { type KeyboardEvent, type ReactNode, useState } from 'react'
import type { AgentDockSnapshot, DockItem, DockSession } from '../../agent-dock/model'
import { ActivityIndicator } from '../activity-indicator'
import { Btn } from '../button'
import { IconBtn } from '../icon-button'
import { GLYPH } from '../sidebar/ui'
import {
	type AskQuestion,
	agentRowMeta,
	alwaysAllowLabels,
	askQuestions,
	cardKindLabel,
	cardTone,
	commandOf,
	findSession,
	formatAge,
	itemAgeTone,
	itemHeadline,
	itemIndicator,
	itemTimeLine,
	orderedSessions,
	plainAgentLine,
	plainAgentText,
	planText,
	recentItems,
	resolutionLabel,
	sessionIndicator,
	sessionStatusText,
	sessionWhere,
	toolInputText,
} from './presentation'

const RECENT_IN_POPOVER = 5

/** The popover body is a tab stop so keyboard users can scroll clipped content (↑ ↓, Page keys). */
const SCROLL_REGION = { tabIndex: 0, role: 'region', 'aria-label': 'Details' } as const

function DetailHead({
	item,
	session,
	now,
	index,
	total,
	onStep,
	onClose,
}: {
	item: DockItem
	session: DockSession | undefined
	now: number
	index: number
	total: number
	onStep(delta: number): void
	onClose(): void
}) {
	const where = sessionWhere(session, item.session)
	const indicator = itemIndicator(item)
	const time = itemTimeLine(item, now)
	return (
		<header className="agent-dock-pop-head">
			<div className="agent-dock-pop-title">
				<ActivityIndicator variant={indicator.variant} label={indicator.label} />
				<span className="agent-dock-pop-kind" data-tone={cardTone(item, now)}>
					{cardKindLabel(item)}
				</span>
				{/* Name first, project muted after it — as on the cards. */}
				<span className="agent-dock-pop-where">
					<span className="agent-dock-pop-name">{where.name}</span>
					{where.project ? <span className="agent-dock-pop-project">{where.project}</span> : null}
				</span>
			</div>
			<div className="agent-dock-pop-meta">
				<span className="agent-dock-pop-id">#{item.id}</span>
				<span aria-hidden="true">·</span>
				<span>{time.stamp}</span>
				<span aria-hidden="true">·</span>
				<span className="agent-dock-card-age" data-tone={itemAgeTone(item, now)}>
					{time.waited}
				</span>
			</div>
			<div className="agent-dock-pop-actions">
				<div className="agent-dock-stepper">
					<IconBtn
						label="Previous item"
						className="agent-dock-step-prev"
						disabled={index <= 0}
						onClick={() => onStep(-1)}
					>
						{GLYPH.chevronRight}
					</IconBtn>
					<span className="agent-dock-step-count" aria-live="polite">
						{index + 1} of {total}
					</span>
					<IconBtn label="Next item" disabled={index >= total - 1} onClick={() => onStep(1)}>
						{GLYPH.chevronRight}
					</IconBtn>
				</div>
				<IconBtn label="Close details" onClick={onClose}>
					{GLYPH.close}
				</IconBtn>
			</div>
		</header>
	)
}

/** Sticky footer: the reason in words on the left, (disabled) decisions on the right. */
function Footer({ note, children }: { note: string; children?: ReactNode }) {
	return (
		<footer className="agent-dock-pop-foot">
			<span className="agent-dock-pop-note">{note}</span>
			{children ? <div className="agent-dock-pop-foot-actions">{children}</div> : null}
		</footer>
	)
}

export function ItemDetail({
	item,
	session,
	now,
	index,
	total,
	pending,
	refused,
	onStep,
	onClose,
	onAck,
}: {
	item: DockItem
	session: DockSession | undefined
	now: number
	index: number
	total: number
	pending: boolean
	refused: boolean
	onStep(delta: number): void
	onClose(): void
	onAck(): void
}) {
	const head = (
		<DetailHead item={item} session={session} now={now} index={index} total={total} onStep={onStep} onClose={onClose} />
	)
	const orphaned = item.state === 'orphaned'
	const ackButton =
		item.kind === 'turn' || orphaned ? (
			<Btn tone="quiet" sm busy={pending} onClick={onAck} ariaLabel={`Ack item ${item.id}`}>
				Ack
			</Btn>
		) : null
	const refusedNote = refused ? (
		<p className="agent-dock-pop-warning">Not acked: the item changed. Check it again.</p>
	) : null
	const orphanNote = orphaned ? (
		<p className="agent-dock-pop-warning">
			Okena restarted while this was open. The agent may still be waiting in its terminal.
		</p>
	) : null

	if (item.fact.kind === 'turn') {
		const notes = [
			item.fact.hadBackground ? 'Subagents were still running.' : '',
			item.fact.continuedAt ? 'Tools ran again afterwards.' : '',
		].filter(Boolean)
		return (
			<>
				{head}
				<div className="agent-dock-pop-scroll" {...SCROLL_REGION}>
					{refusedNote}
					<div className="agent-dock-pop-body">
						<p className="agent-dock-pop-text">{plainAgentText(item.fact.text) || itemHeadline(item)}</p>
						{notes.length > 0 || session?.prLinks.length ? (
							<p className="agent-dock-pop-facts">
								{session?.prLinks.slice(0, 4).map(pr => (
									<span key={pr.number} className="agent-dock-pop-fact">
										PR #{pr.number}
									</span>
								))}
								{notes.map(note => (
									<span key={note}>{note}</span>
								))}
							</p>
						) : null}
					</div>
				</div>
				<Footer note="Reply in the agent's terminal for now. Ack clears the card.">{ackButton}</Footer>
			</>
		)
	}

	const { tool, input } = item.fact
	if (tool === 'AskUserQuestion') {
		const questions = askQuestions(input)
		if (questions)
			return (
				<>
					{head}
					<div className="agent-dock-pop-scroll" {...SCROLL_REGION}>
						{orphanNote}
						{refusedNote}
						<AskBody key={item.id} questions={questions} />
					</div>
					<Footer note="Answer in the terminal for now">
						{ackButton}
						<Btn tone="ghost" sm disabled>
							Submit answers
						</Btn>
					</Footer>
				</>
			)
	}
	if (tool === 'ExitPlanMode') {
		const plan = planText(input)
		return (
			<>
				{head}
				<div className="agent-dock-pop-scroll" {...SCROLL_REGION}>
					{orphanNote}
					{refusedNote}
					<div className="agent-dock-pop-body">
						{plan ? (
							<pre className="agent-dock-well agent-dock-plan">{plan}</pre>
						) : (
							<p className="agent-dock-pop-text">Plan ready for approval.</p>
						)}
					</div>
				</div>
				<Footer note="Approve or keep planning in the terminal for now">
					{ackButton}
					<Btn tone="ghost" sm disabled>
						Approve plan
					</Btn>
				</Footer>
			</>
		)
	}

	// Any other tool: a permission dialog. "Always allow" only when Claude itself suggested rules.
	const command = commandOf(input)
	const description =
		input && typeof input === 'object' && typeof (input as { description?: unknown }).description === 'string'
			? plainAgentLine((input as { description: string }).description, 240)
			: ''
	const always = alwaysAllowLabels(item.fact.suggestions)
	const choices = [
		{ label: <>Allow once</>, tone: undefined },
		...(always.length > 0
			? [
					{
						label: (
							<>
								Always allow <code className="agent-dock-mono">{always.join(', ')}</code>
							</>
						),
						tone: undefined,
					},
				]
			: []),
		{ label: <>Deny and tell the agent what to do</>, tone: 'danger' as const },
	]
	return (
		<>
			{head}
			<div className="agent-dock-pop-scroll" {...SCROLL_REGION}>
				{orphanNote}
				{refusedNote}
				<div className="agent-dock-pop-body">
					<p className="agent-dock-pop-label">
						{plainAgentLine(tool, 64)} wants to {command ? 'run' : 'use'}
						{description ? <span className="agent-dock-pop-quiet"> · {description}</span> : null}
					</p>
					<pre className="agent-dock-well agent-dock-command">{command ?? toolInputText(input)}</pre>
					<ol className="agent-dock-choices" aria-label="Choices (answer in the terminal for now)">
						{choices.map((choice, number) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: numbered as in the terminal dialog
							<li key={number}>
								<button type="button" className="agent-dock-choice" data-tone={choice.tone} disabled>
									<span className="agent-dock-choice-n">{number + 1}</span>
									<span className="agent-dock-choice-label">{choice.label}</span>
								</button>
							</li>
						))}
					</ol>
				</div>
			</div>
			<Footer note="Allow or deny in the terminal for now">{ackButton}</Footer>
		</>
	)
}

function AskBody({ questions }: { questions: AskQuestion[] }) {
	const [active, setActive] = useState(0)
	// Draft picks are local only: they let Jakub look at previews; nothing is sent in slice 1.
	const [picks, setPicks] = useState<number[]>(() => questions.map(() => -1))
	// Until Jakub points at an option, preview the first option that has one.
	const firstPreview = (index: number) =>
		Math.max(
			0,
			(questions[index]?.options ?? []).findIndex(option => option.preview),
		)
	const [hovered, setHovered] = useState(() => firstPreview(0))
	const question = questions[active] ?? questions[0]
	if (!question) return null
	const picked = picks[active] ?? -1
	const previewIndex = picked >= 0 ? picked : hovered
	const hasPreviews = question.options.some(option => option.preview)
	const pick = (index: number) => {
		setHovered(index)
		setPicks(prev => prev.map((value, at) => (at === active ? index : value)))
	}
	const showQuestion = (index: number) => {
		setActive(index)
		setHovered(firstPreview(index))
	}
	// ARIA tabs: ← → / Home / End move between questions (one tab stop); they never step items.
	const onTabsKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const last = questions.length - 1
		const next =
			event.key === 'ArrowLeft'
				? active - 1
				: event.key === 'ArrowRight'
					? active + 1
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? last
							: null
		if (next === null) return
		event.preventDefault()
		event.stopPropagation()
		const index = Math.max(0, Math.min(last, next))
		showQuestion(index)
		event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
	}
	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const digit = Number(event.key)
		if (Number.isInteger(digit) && digit >= 1 && digit <= question.options.length) {
			event.preventDefault()
			pick(digit - 1)
		}
	}
	return (
		<div className="agent-dock-pop-body" onKeyDown={onKey}>
			{questions.length > 1 ? (
				<div
					className="segmented agent-dock-question-tabs"
					role="tablist"
					aria-label="Questions"
					style={{ gridTemplateColumns: `repeat(${questions.length}, minmax(0, 1fr))` }}
					onKeyDown={onTabsKey}
				>
					{questions.map((entry, index) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: positional, immutable list
							key={index}
							type="button"
							role="tab"
							aria-selected={index === active}
							tabIndex={index === active ? 0 : -1}
							className={`segment${index === active ? ' segment-active' : ''}`}
							onClick={() => showQuestion(index)}
						>
							<span className="segment-body">
								<span className="agent-dock-question-n">{index + 1}</span>
								<span className="agent-dock-question-tab">{entry.header ?? `Question ${index + 1}`}</span>
								{(picks[index] ?? -1) >= 0 ? <span className="agent-dock-question-done">{GLYPH.check}</span> : null}
							</span>
						</button>
					))}
				</div>
			) : question.header ? (
				<p className="agent-dock-pop-label">{question.header}</p>
			) : null}
			<p className="agent-dock-question">
				{question.question}
				{question.multiSelect ? <span className="agent-dock-pop-quiet"> (pick several)</span> : null}
			</p>
			<div className="agent-dock-ask-grid" data-previews={String(hasPreviews)}>
				<ol className="agent-dock-choices" aria-label="Options">
					{question.options.map((option, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: option numbers are positional, as in the terminal
						<li key={index}>
							<button
								type="button"
								className="agent-dock-choice"
								aria-pressed={picked === index}
								data-focused={String(hasPreviews && previewIndex === index)}
								onMouseEnter={() => setHovered(index)}
								onFocus={() => setHovered(index)}
								onClick={() => pick(index)}
							>
								<span className="agent-dock-choice-n">{index + 1}</span>
								<span className="agent-dock-choice-copy">
									<span className="agent-dock-choice-label">{option.label}</span>
									{option.description ? (
										<span className="agent-dock-choice-description">{option.description}</span>
									) : null}
								</span>
							</button>
						</li>
					))}
				</ol>
				{hasPreviews ? (
					<div className="agent-dock-preview">
						<span className="agent-dock-preview-label">Preview · {question.options[previewIndex]?.label ?? ''}</span>
						<pre className="agent-dock-well agent-dock-preview-text">
							{question.options[previewIndex]?.preview ?? 'No preview for this option.'}
						</pre>
					</div>
				) : null}
			</div>
		</div>
	)
}

function RecentWhat({ item, session }: { item: DockItem; session: DockSession | undefined }) {
	const where = sessionWhere(session, item.session)
	return (
		<span className="agent-dock-recent-what">
			{cardKindLabel(item)} · <span className="agent-dock-pop-name">{where.name}</span>
			{where.project ? <span className="agent-dock-pop-project">{where.project}</span> : null}
		</span>
	)
}

/** Every agent Okena lists, as info rows (only observed facts), then recently closed items. */
export function AgentsDetail({
	snapshot,
	now,
	onClose,
}: {
	snapshot: AgentDockSnapshot | null
	now: number
	onClose(): void
}) {
	const sessions = orderedSessions(snapshot)
	const recent = recentItems(snapshot, RECENT_IN_POPOVER)
	const busy = sessions.filter(session => session.status === 'working' || session.status === 'background').length
	return (
		<>
			<header className="agent-dock-pop-head">
				<div className="agent-dock-pop-title">
					<span className="agent-dock-pop-kind">Agents</span>
					<span className="agent-dock-pop-where">
						{sessions.length} connected · {busy} busy
					</span>
				</div>
				<div className="agent-dock-pop-actions">
					<IconBtn label="Close details" onClick={onClose}>
						{GLYPH.close}
					</IconBtn>
				</div>
			</header>
			<div className="agent-dock-pop-scroll" {...SCROLL_REGION}>
				<ul className="agent-dock-agent-rows">
					{snapshot
						? sessions.map(session => {
								const indicator = sessionIndicator(session, snapshot.items)
								const where = sessionWhere(session, session.key)
								const meta = agentRowMeta(snapshot, session)
								return (
									<li key={session.key} className="agent-dock-agent-row" data-status={session.status}>
										<span className="agent-dock-agent-slot">
											{indicator ? <ActivityIndicator variant={indicator.variant} label={indicator.label} /> : null}
										</span>
										<span className="agent-dock-agent-where">
											<span className="agent-dock-pop-name">{where.name}</span>
											{where.project ? <span className="agent-dock-pop-project">{where.project}</span> : null}
										</span>
										{meta.length > 0 ? <span className="agent-dock-agent-meta">{meta.join(' · ')}</span> : null}
										<span className="agent-dock-agent-status">{sessionStatusText(session, now)}</span>
									</li>
								)
							})
						: null}
				</ul>
				{recent.length > 0 ? (
					<section className="agent-dock-recent" aria-label="Recent">
						<h3 className="agent-dock-recent-title">Recent</h3>
						<ol className="agent-dock-recent-rows">
							{recent.map(item => (
								<li key={item.id} className="agent-dock-recent-row">
									<span className="agent-dock-pop-id">#{item.id}</span>
									<RecentWhat item={item} session={findSession(snapshot, item.session)} />
									<span className="agent-dock-recent-how">{resolutionLabel(item)}</span>
									{item.resolution ? (
										<span className="agent-dock-card-age">{formatAge(now - item.resolution.at)} ago</span>
									) : null}
								</li>
							))}
						</ol>
					</section>
				) : null}
			</div>
		</>
	)
}
