// Agent dock detail popover bodies (design §3.24). Slice 2: Jakub answers from
// here — pick options (click, or 1–9 while the popover has focus), Other… text,
// allow / always allow / deny, approve / keep planning, or reply to a finished
// turn — then one explicit submit; nothing is ever sent implicitly. Main re-reads
// Okena (CAS) before the effect; the receipt (Sending… → ✓ answered / sent,
// unconfirmed / refused / verbatim error) comes back in the snapshot. Agent text
// is untrusted and always plain React text.

import {
	type KeyboardEvent,
	type MutableRefObject,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import type { AgentDockSnapshot, DockAction, DockItem, DockSession } from '../../agent-dock/model'
import { REVIEW_COMMAND_MAX, REVIEW_FIELDS_MAX } from '../../agent-dock/review'
import { ActivityIndicator } from '../activity-indicator'
import { Btn } from '../button'
import { IconBtn } from '../icon-button'
import { GLYPH } from '../sidebar/ui'
import {
	type AskQuestion,
	type ReceiptView,
	agentRowMeta,
	alwaysAllowLabels,
	askQuestions,
	cardKindLabel,
	cardTone,
	findSession,
	formatAge,
	itemAgeTone,
	itemHeadline,
	itemIndicator,
	itemTimeLine,
	orderedSessions,
	permissionReview,
	plainAgentLine,
	plainAgentText,
	planText,
	receiptView,
	recentItems,
	resolutionLabel,
	riskyWord,
	sessionIndicator,
	sessionStatusText,
	sessionWhere,
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

/** Sticky footer: the receipt or hint in words on the left, decisions on the right. */
function Footer({ note, children }: { note: ReactNode; children?: ReactNode }) {
	return (
		<footer className="agent-dock-pop-foot">
			<span className="agent-dock-pop-note">{note}</span>
			{children ? <div className="agent-dock-pop-foot-actions">{children}</div> : null}
		</footer>
	)
}

function Receipt({ view }: { view: ReceiptView }) {
	return (
		<output className="agent-dock-receipt" data-tone={view.tone}>
			{view.text}
		</output>
	)
}

/** Popover-level keys a body handles (digits, Enter). Returns true when it consumed the event. */
export type DetailKeys = (event: KeyboardEvent<HTMLElement>) => boolean

/** Typing in a field never picks options or submits through the popover keys. */
export const isTextField = (target: EventTarget | null): boolean =>
	target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null

/** Per-item text drafts that survive stepping and closing the popover (renderer memory only). */
export type DockDrafts = Map<string, string>

function useDraft(drafts: DockDrafts, key: string): [string, (value: string) => void] {
	const [value, setValue] = useState(() => drafts.get(key) ?? '')
	return [
		value,
		next => {
			setValue(next)
			if (next) drafts.set(key, next)
			else drafts.delete(key)
		},
	]
}

interface PanelProps {
	item: DockItem
	/** Controls are live: the item is open, Okena is reachable, nothing is being sent. */
	live: boolean
	/** Why controls are off, when they are and no receipt explains it. */
	blockedNote: string | null
	receipt: ReactNode
	ack: ReactNode
	warnings: ReactNode
	keys: MutableRefObject<DetailKeys | null>
	drafts: DockDrafts
	submitting: boolean
	onAct(action: DockAction): void
}

/** Binds a body's key handler for the popover while it is mounted. */
function useKeys(keys: MutableRefObject<DetailKeys | null>, handler: DetailKeys): void {
	const latest = useRef(handler)
	latest.current = handler
	useLayoutEffect(() => {
		const bound: DetailKeys = event => latest.current(event)
		keys.current = bound
		return () => {
			if (keys.current === bound) keys.current = null
		}
	}, [keys])
}

/** 1–9 from a key event, or null. */
const digitOf = (event: KeyboardEvent<HTMLElement>): number | null => {
	if (event.metaKey || event.ctrlKey || event.altKey || isTextField(event.target)) return null
	const digit = Number(event.key)
	return /^[1-9]$/.test(event.key) && Number.isInteger(digit) ? digit : null
}

/** Enter on the popover itself or its scroll body (buttons and fields keep their own Enter). */
const isBareEnter = (event: KeyboardEvent<HTMLElement>): boolean =>
	event.key === 'Enter' &&
	!event.shiftKey &&
	!event.metaKey &&
	!event.ctrlKey &&
	!event.altKey &&
	!isTextField(event.target) &&
	(event.target === event.currentTarget || (event.target as Element).classList?.contains('agent-dock-pop-scroll'))

export function ItemDetail({
	item,
	session,
	now,
	index,
	total,
	pending,
	refused,
	canAct,
	blockedNote,
	submitting,
	localError,
	keys,
	drafts,
	onStep,
	onClose,
	onAck,
	onAct,
}: {
	item: DockItem
	session: DockSession | undefined
	now: number
	index: number
	total: number
	pending: boolean
	refused: boolean
	/** Okena reachable and the item open: answering is possible. */
	canAct: boolean
	blockedNote: string | null
	submitting: boolean
	/** A refusal/failure main did not record on the item (bad request, IPC failure). */
	localError: string | null
	keys: MutableRefObject<DetailKeys | null>
	drafts: DockDrafts
	onStep(delta: number): void
	onClose(): void
	onAck(): void
	onAct(action: DockAction): void
}) {
	const head = (
		<DetailHead item={item} session={session} now={now} index={index} total={total} onStep={onStep} onClose={onClose} />
	)
	const orphaned = item.state === 'orphaned'
	const resolved = item.state === 'resolved'
	const ackable =
		!resolved && (item.kind === 'turn' || orphaned || item.state === 'unconfirmed') && item.state !== 'sending'
	const ack = ackable ? (
		<Btn tone="quiet" sm busy={pending} onClick={onAck} ariaLabel={`Ack item ${item.id}`}>
			Ack
		</Btn>
	) : null
	const view = receiptView(item)
	const receipt = view ? (
		<Receipt view={view} />
	) : localError ? (
		<Receipt view={{ text: localError, tone: 'danger', busy: false }} />
	) : null
	const warnings = (
		<>
			{refused ? <p className="agent-dock-pop-warning">Not acked: the item changed. Check it again.</p> : null}
			{orphaned ? (
				<p className="agent-dock-pop-warning">
					Okena restarted while this was open. The agent may still be waiting in its terminal.
				</p>
			) : null}
			{item.state === 'unconfirmed' ? (
				<p className="agent-dock-pop-warning">
					{item.kind === 'ask'
						? 'Helm has not seen this answer land. If the dialog is still open, it comes back here to answer again.'
						: "Okena took the answer, but Helm has not seen it land. Check the agent's terminal, then Ack."}
				</p>
			) : null}
		</>
	)
	const panel: PanelProps = {
		item,
		live: canAct && !submitting,
		blockedNote: orphaned ? 'Answer in the terminal (Okena lost this dialog)' : canAct ? null : blockedNote,
		receipt,
		ack,
		warnings,
		keys,
		drafts,
		submitting,
		onAct,
	}
	let body: ReactNode
	if (item.fact.kind === 'turn') body = <TurnPanel key={item.id} {...panel} session={session} />
	else if (item.fact.tool === 'AskUserQuestion' && askQuestions(item.fact.input))
		body = <AskPanel key={item.id} {...panel} />
	else if (item.fact.tool === 'ExitPlanMode') body = <PlanPanel key={item.id} {...panel} />
	else body = <PermissionPanel key={item.id} {...panel} />
	return (
		<>
			{head}
			{body}
		</>
	)
}

function AskPanel({ item, live, blockedNote, receipt, ack, warnings, keys, submitting, onAct }: PanelProps) {
	const questions = item.fact.kind === 'ask' ? (askQuestions(item.fact.input) ?? []) : []
	const [active, setActive] = useState(0)
	const [picks, setPicks] = useState<number[][]>(() => questions.map(() => []))
	const [others, setOthers] = useState<string[]>(() => questions.map(() => ''))
	/** "Other…" chosen for a question: its text field shows. */
	const [otherOn, setOtherOn] = useState<boolean[]>(() => questions.map(() => false))
	const otherInput = useRef<HTMLInputElement>(null)
	const focusOther = useRef(false)
	/** The risky word an Other answer mentions, while the second confirmation asks. */
	const [confirming, setConfirming] = useState<string | null>(null)
	// Until Jakub points at an option, preview the first option that has one.
	const firstPreview = (at: number) =>
		Math.max(
			0,
			(questions[at]?.options ?? []).findIndex(option => option.preview),
		)
	const [hovered, setHovered] = useState(() => firstPreview(0))
	useEffect(() => {
		if (!focusOther.current) return
		focusOther.current = false
		otherInput.current?.focus()
	})
	const question = questions[active] ?? questions[0] ?? { question: '', multiSelect: false, options: [] }
	const picked = picks[active] ?? []
	const answered = (at: number) =>
		(picks[at]?.length ?? 0) > 0 || ((otherOn[at] ?? false) && (others[at] ?? '').trim() !== '')
	const complete = questions.every((_, at) => answered(at))
	const previewIndex = picked.length > 0 ? (picked[picked.length - 1] ?? hovered) : hovered
	const hasPreviews = question.options.some(option => option.preview)
	const otherNumber = question.options.length + 1

	const showQuestion = (at: number) => {
		setActive(at)
		setHovered(firstPreview(at))
	}
	const setAt = <T,>(list: T[], at: number, value: T): T[] => list.map((entry, index) => (index === at ? value : entry))
	const pick = (option: number) => {
		if (!live) return
		setHovered(option)
		if (question.multiSelect) {
			const has = picked.includes(option)
			setPicks(prev => setAt(prev, active, has ? picked.filter(entry => entry !== option) : [...picked, option]))
			return
		}
		setPicks(prev => setAt(prev, active, [option]))
		setOtherOn(prev => setAt(prev, active, false))
		// One answer per question: move on to the next unanswered one.
		const next = questions.findIndex((_, at) => at !== active && !answered(at))
		if (next >= 0) showQuestion(next)
	}
	const chooseOther = () => {
		if (!live) return
		const on = !(otherOn[active] ?? false) || !question.multiSelect
		setOtherOn(prev => setAt(prev, active, on))
		if (!question.multiSelect) setPicks(prev => setAt(prev, active, []))
		if (on) focusOther.current = true
	}
	const otherText = (at: number) => ((otherOn[at] ?? false) ? (others[at] ?? '').trim() : '')
	const submit = (confirmed = false) => {
		if (!live || !complete) return
		const risky = questions.map((_, at) => riskyWord(otherText(at))).find(word => word !== null) ?? null
		if (risky && !confirmed) {
			setConfirming(risky)
			return
		}
		setConfirming(null)
		onAct({
			type: 'answer',
			// Main indexes Claude's raw options; the shown numbers skip malformed ones.
			picks: questions.map((entry, at) => ({
				options: (picks[at] ?? []).flatMap(shown => {
					const option = entry.options[shown]
					return option ? [option.index] : []
				}),
				...(otherText(at) ? { other: others[at] } : {}),
			})),
			...(risky ? { confirmed: true } : {}),
		})
	}
	useKeys(keys, event => {
		const digit = digitOf(event)
		if (digit !== null) {
			if (digit <= question.options.length) pick(digit - 1)
			else if (digit === otherNumber) chooseOther()
			else return false
			return true
		}
		if (isBareEnter(event)) {
			submit(confirming !== null)
			return true
		}
		return false
	})
	if (questions.length === 0) return null
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
		const at = Math.max(0, Math.min(last, next))
		showQuestion(at)
		event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[at]?.focus()
	}
	const otherActive = otherOn[active] ?? false
	const note =
		receipt ??
		blockedNote ??
		(complete ? 'Ready to submit' : questions.length > 1 ? 'Answer every question, then submit' : 'Pick an answer')
	return (
		<>
			<div className="agent-dock-pop-scroll" {...SCROLL_REGION}>
				{warnings}
				<div className="agent-dock-pop-body">
					{questions.length > 1 ? (
						<div
							className="segmented agent-dock-question-tabs"
							role="tablist"
							aria-label="Questions"
							style={{ gridTemplateColumns: `repeat(${questions.length}, minmax(0, 1fr))` }}
							onKeyDown={onTabsKey}
						>
							{questions.map((entry, at) => (
								<button
									// biome-ignore lint/suspicious/noArrayIndexKey: positional, immutable list
									key={at}
									type="button"
									role="tab"
									aria-selected={at === active}
									tabIndex={at === active ? 0 : -1}
									className={`segment${at === active ? ' segment-active' : ''}`}
									onClick={() => showQuestion(at)}
								>
									<span className="segment-body">
										<span className="agent-dock-question-n">{at + 1}</span>
										<span className="agent-dock-question-tab">{entry.header ?? `Question ${at + 1}`}</span>
										{answered(at) ? <span className="agent-dock-question-done">{GLYPH.check}</span> : null}
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
							{question.options.map((option, at) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: option numbers are positional, as in the terminal
								<li key={at}>
									<button
										type="button"
										className="agent-dock-choice"
										aria-pressed={picked.includes(at)}
										disabled={!live}
										data-focused={String(hasPreviews && previewIndex === at)}
										onMouseEnter={() => setHovered(at)}
										onFocus={() => setHovered(at)}
										onClick={() => pick(at)}
									>
										<span className="agent-dock-choice-n">{at + 1}</span>
										<span className="agent-dock-choice-copy">
											<span className="agent-dock-choice-label">{option.label}</span>
											{option.description ? (
												<span className="agent-dock-choice-description">{option.description}</span>
											) : null}
										</span>
									</button>
								</li>
							))}
							<li>
								<button
									type="button"
									className="agent-dock-choice"
									aria-pressed={otherActive}
									disabled={!live}
									onClick={chooseOther}
								>
									<span className="agent-dock-choice-n">{otherNumber}</span>
									<span className="agent-dock-choice-copy">
										<span className="agent-dock-choice-label">Other…</span>
										<span className="agent-dock-choice-description">Type your own answer</span>
									</span>
								</button>
							</li>
						</ol>
						{hasPreviews ? (
							<div className="agent-dock-preview">
								<span className="agent-dock-preview-label">
									Preview · {question.options[previewIndex]?.label ?? ''}
								</span>
								<pre className="agent-dock-well agent-dock-preview-text">
									{question.options[previewIndex]?.preview ?? 'No preview for this option.'}
								</pre>
							</div>
						) : null}
					</div>
					{otherActive ? (
						<input
							// Remount per question so the field follows the tab.
							key={`other-${active}`}
							ref={otherInput}
							className="input agent-dock-field"
							aria-label={`Your answer to question ${active + 1}`}
							placeholder="Your answer"
							maxLength={4096}
							value={others[active] ?? ''}
							disabled={!live}
							onChange={event => {
								const value = event.currentTarget.value
								setOthers(prev => setAt(prev, active, value))
								setConfirming(null)
							}}
							onKeyDown={event => {
								if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
								event.preventDefault()
								event.stopPropagation()
								if (complete) submit(confirming !== null)
								else {
									const next = questions.findIndex((_, at) => !answered(at))
									if (next >= 0) showQuestion(next)
								}
							}}
						/>
					) : null}
					{confirming ? <RiskyConfirm word={confirming} what="This answer" /> : null}
				</div>
			</div>
			<Footer note={note}>
				{ack}
				{confirming ? (
					<>
						<Btn tone="ghost" sm onClick={() => setConfirming(null)}>
							Cancel
						</Btn>
						<Btn tone="danger" sm disabled={!live || !complete} busy={submitting} onClick={() => submit(true)}>
							Send anyway
						</Btn>
					</>
				) : (
					<Btn
						tone={complete && live ? 'primary' : 'ghost'}
						sm
						disabled={!live || !complete}
						busy={submitting}
						onClick={() => submit()}
					>
						Submit answers
					</Btn>
				)}
			</Footer>
		</>
	)
}

/** Second confirmation for free text to the agent that mentions deploy/prod/secret/push/merge. */
function RiskyConfirm({ word, what }: { word: string; what: string }) {
	return (
		<p className="agent-dock-pop-warning agent-dock-confirm" role="alert">
			{what} mentions “{word}”. Send it to the agent anyway?
		</p>
	)
}

type Choice = { id: string; label: ReactNode; tone?: 'danger'; submit: string; action: DockAction | 'deny' }

function ChoiceList({
	choices,
	selected,
	live,
	label,
	onPick,
}: {
	choices: Choice[]
	selected: string | null
	live: boolean
	label: string
	onPick(id: string): void
}) {
	return (
		<ol className="agent-dock-choices" aria-label={label}>
			{choices.map((choice, at) => (
				<li key={choice.id}>
					<button
						type="button"
						className="agent-dock-choice"
						data-tone={choice.tone}
						aria-pressed={selected === choice.id}
						disabled={!live}
						onClick={() => onPick(choice.id)}
					>
						<span className="agent-dock-choice-n">{at + 1}</span>
						<span className="agent-dock-choice-label">{choice.label}</span>
					</button>
				</li>
			))}
		</ol>
	)
}

/**
 * Pick-then-submit body shared by permission and plan dialogs: a numbered choice,
 * an optional message field for "deny", one submit. No single click allows anything.
 */
function DecisionPanel({
	panel,
	choices,
	children,
	messageLabel,
	messagePlaceholder,
	hint,
}: {
	panel: PanelProps
	choices: Choice[]
	children: ReactNode
	messageLabel: string
	messagePlaceholder: string
	hint: string
}) {
	const { item, live, blockedNote, receipt, ack, warnings, keys, drafts, submitting, onAct } = panel
	const [selected, setSelected] = useState<string | null>(null)
	const [message, setMessage] = useDraft(drafts, `deny:${item.id}`)
	/** The risky word a deny message mentions, while the second confirmation asks. */
	const [confirming, setConfirming] = useState<string | null>(null)
	const messageRef = useRef<HTMLTextAreaElement>(null)
	const focusMessage = useRef(false)
	useEffect(() => {
		if (!focusMessage.current) return
		focusMessage.current = false
		messageRef.current?.focus()
	})
	const choice = choices.find(entry => entry.id === selected) ?? null
	const choose = (id: string) => {
		if (!live) return
		setSelected(id)
		setConfirming(null)
		if (choices.find(entry => entry.id === id)?.action === 'deny') focusMessage.current = true
	}
	const submit = (confirmed = false) => {
		if (!live || !choice) return
		if (choice.action !== 'deny') {
			onAct(choice.action)
			return
		}
		const text = message.trim()
		const risky = riskyWord(text)
		if (risky && !confirmed) {
			setConfirming(risky)
			return
		}
		setConfirming(null)
		onAct({ type: 'deny', ...(text ? { message: text } : {}), ...(risky ? { confirmed: true } : {}) })
	}
	useKeys(keys, event => {
		const digit = digitOf(event)
		if (digit !== null) {
			const entry = choices[digit - 1]
			if (!entry) return false
			choose(entry.id)
			return true
		}
		if (isBareEnter(event)) {
			submit(confirming !== null)
			return true
		}
		return false
	})
	return (
		<>
			<div className="agent-dock-pop-scroll" {...SCROLL_REGION}>
				{warnings}
				<div className="agent-dock-pop-body">
					{children}
					<ChoiceList choices={choices} selected={selected} live={live} label="Choices" onPick={choose} />
					{choice?.action === 'deny' ? (
						<label className="agent-dock-field-label">
							<span className="field-label">{messageLabel}</span>
							<textarea
								ref={messageRef}
								className="input textarea agent-dock-field"
								placeholder={messagePlaceholder}
								maxLength={4096}
								rows={2}
								value={message}
								disabled={!live}
								onChange={event => {
									setMessage(event.currentTarget.value)
									setConfirming(null)
								}}
								onKeyDown={event => {
									if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
										event.preventDefault()
										event.stopPropagation()
										submit(confirming !== null)
									}
								}}
							/>
						</label>
					) : null}
					{confirming ? <RiskyConfirm word={confirming} what="This message" /> : null}
				</div>
			</div>
			<Footer note={receipt ?? blockedNote ?? (choice ? 'Ready to send' : hint)}>
				{ack}
				{confirming ? (
					<>
						<Btn tone="ghost" sm onClick={() => setConfirming(null)}>
							Cancel
						</Btn>
						<Btn tone="danger" sm disabled={!live || !choice} busy={submitting} onClick={() => submit(true)}>
							Send anyway
						</Btn>
					</>
				) : (
					<Btn
						tone={choice ? (choice.tone === 'danger' ? 'danger' : 'primary') : 'ghost'}
						sm
						disabled={!live || !choice}
						busy={submitting}
						onClick={() => submit()}
					>
						{choice?.submit ?? choices[0]?.submit ?? 'Send'}
					</Btn>
				)}
			</Footer>
		</>
	)
}

function PermissionPanel(panel: PanelProps) {
	const { item } = panel
	if (item.fact.kind !== 'ask') return null
	const { tool, input } = item.fact
	// Okena allows with the full original tool_input and applies every suggestion:
	// offer Allow only when all of it shows here verbatim (main refuses otherwise too).
	const review = permissionReview(input)
	const always = review.complete
		? alwaysAllowLabels(item.fact.suggestions, item.fact.suggestionsTruncated === true)
		: null
	const description = review.description ? plainAgentLine(review.description, 240) : ''
	const allows: Choice[] = review.complete
		? [
				{ id: 'once', label: <>Allow once</>, submit: 'Allow once', action: { type: 'allow' } },
				...(always && always.length > 0
					? [
							{
								id: 'always',
								label: (
									<>
										Always allow <code className="agent-dock-mono">{always.join(', ')}</code>
										<span className="agent-dock-pop-quiet"> (this session)</span>
									</>
								),
								submit: 'Always allow',
								action: { type: 'allow', always: true } as DockAction,
							},
						]
					: []),
			]
		: []
	const choices: Choice[] = [
		...allows,
		{ id: 'deny', label: <>Deny and tell the agent what to do</>, tone: 'danger', submit: 'Deny', action: 'deny' },
	]
	return (
		<DecisionPanel
			panel={panel}
			choices={choices}
			messageLabel="Message to the agent (optional)"
			messagePlaceholder="What should it do instead?"
			hint={review.complete ? 'Pick allow or deny' : 'Allow in the terminal, or deny here'}
		>
			<p className="agent-dock-pop-label">
				{plainAgentLine(tool, 64)} wants to {review.command !== null ? 'run' : 'use'}
				{description ? <span className="agent-dock-pop-quiet"> · {description}</span> : null}
			</p>
			{review.flags.length > 0 ? (
				<p className="agent-dock-pop-warning" role="note">
					{review.flags
						.map(flag => (flag === 'dangerouslyDisableSandbox' ? 'Runs outside the sandbox' : `${flag}: true`))
						.join(' · ')}
				</p>
			) : null}
			{review.command !== null ? (
				<pre className="agent-dock-well agent-dock-command">{plainAgentText(review.command, REVIEW_COMMAND_MAX)}</pre>
			) : null}
			{review.fields !== null ? (
				<pre className="agent-dock-well agent-dock-command">{plainAgentText(review.fields, REVIEW_FIELDS_MAX)}</pre>
			) : null}
			{review.complete ? null : (
				<p className="agent-dock-pop-warning">
					Too long or unusual to show in full here. Review it in the agent's terminal to allow it.
				</p>
			)}
		</DecisionPanel>
	)
}

function PlanPanel(panel: PanelProps) {
	const { item } = panel
	const plan = item.fact.kind === 'ask' ? planText(item.fact.input) : null
	const choices: Choice[] = [
		{ id: 'approve', label: <>Approve the plan</>, submit: 'Approve', action: { type: 'allow' } },
		{ id: 'keep', label: <>Keep planning</>, submit: 'Keep planning', action: 'deny' },
	]
	return (
		<DecisionPanel
			panel={panel}
			choices={choices}
			messageLabel="What should change? (optional)"
			messagePlaceholder="Tell the agent what to plan differently"
			hint="Approve or keep planning"
		>
			{plan ? (
				<pre className="agent-dock-well agent-dock-plan">{plan}</pre>
			) : (
				<p className="agent-dock-pop-text">Plan ready for approval.</p>
			)}
		</DecisionPanel>
	)
}

function TurnPanel(panel: PanelProps & { session: DockSession | undefined }) {
	const { item, live, blockedNote, receipt, ack, warnings, keys, drafts, submitting, onAct, session } = panel
	const [text, setText] = useDraft(drafts, `reply:${item.id}`)
	/** The risky word the pending confirmation is about, while it asks. */
	const [confirming, setConfirming] = useState<string | null>(null)
	useKeys(keys, () => false)
	if (item.fact.kind !== 'turn') return null
	const fact = item.fact
	const notes = [
		fact.hadBackground ? 'Subagents were still running.' : '',
		fact.continuedAt ? 'Tools ran again afterwards.' : '',
	].filter(Boolean)
	const ready = live && text.trim() !== ''
	const send = (confirmed: boolean) => {
		if (!ready) return
		const risky = riskyWord(text)
		if (risky && !confirmed) {
			setConfirming(risky)
			return
		}
		setConfirming(null)
		onAct({ type: 'prompt', text, ...(risky ? { confirmed: true } : {}) })
	}
	return (
		<>
			<div className="agent-dock-pop-scroll" {...SCROLL_REGION}>
				{warnings}
				<div className="agent-dock-pop-body">
					<p className="agent-dock-pop-text">{plainAgentText(fact.text) || itemHeadline(item)}</p>
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
					<label className="agent-dock-field-label">
						<span className="field-label">Reply</span>
						<textarea
							className="input textarea agent-dock-field"
							placeholder="Reply to the agent…  (⌘↵ sends)"
							maxLength={16384}
							rows={2}
							value={text}
							disabled={!live}
							onChange={event => {
								setText(event.currentTarget.value)
								setConfirming(null)
							}}
							onKeyDown={event => {
								if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
									event.preventDefault()
									event.stopPropagation()
									send(confirming !== null)
								}
							}}
						/>
					</label>
					{confirming ? <RiskyConfirm word={confirming} what="This reply" /> : null}
				</div>
			</div>
			<Footer note={receipt ?? blockedNote ?? 'Typed into the agent’s terminal as your next prompt'}>
				{ack}
				{confirming ? (
					<>
						<Btn tone="ghost" sm onClick={() => setConfirming(null)}>
							Cancel
						</Btn>
						<Btn tone="danger" sm disabled={!ready} busy={submitting} onClick={() => send(true)}>
							Send anyway
						</Btn>
					</>
				) : (
					<Btn tone={ready ? 'primary' : 'ghost'} sm disabled={!ready} busy={submitting} onClick={() => send(false)}>
						Send
					</Btn>
				)}
			</Footer>
		</>
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
