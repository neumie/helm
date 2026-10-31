// Agent dock pane bodies (design §3.24), drawn the way Claude Code's own TUI
// draws a dialog: a titled rule on top, numbered choices with a > cursor on the
// picked row, key hints in the footer. Jakub answers from here — pick options
// (click, or 1–9 while the pane has focus), Other… text, allow / always allow /
// deny, approve / keep planning, or reply to a finished turn — then one explicit
// submit; nothing is ever sent implicitly. Main re-reads Okena (CAS) before the
// effect; the receipt (Sending… → ✓ answered / sent, unconfirmed / refused /
// verbatim error) comes back in the snapshot. Agent text is untrusted and always
// plain React text. Monospace where it carries meaning (rule, choices, commands,
// key hints); prose (questions, descriptions, turn messages) stays in the UI face.

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
import { REVIEW_COMMAND_MAX, REVIEW_FIELDS_MAX, REVIEW_PLAN_MAX, planReview } from '../../agent-dock/review'
import { Btn, type ButtonTone } from '../button'
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
	itemTimeLine,
	kindGlyph,
	orderedSessions,
	permissionReview,
	plainAgentLine,
	plainAgentText,
	receiptView,
	recentItems,
	resolutionLabel,
	riskyWord,
	sessionSince,
	sessionStatusText,
	sessionWhere,
	statusGlyph,
} from './presentation'

const RECENT_IN_PANE = 5

/** The pane body is a tab stop so keyboard users can scroll clipped content (↑ ↓, Page keys). */
const SCROLL_REGION = { tabIndex: 0, role: 'region', 'aria-label': 'Details' } as const

/** The pane's top border, tmux-style: `─ ? Question name project  #3 asked 13:44 waiting 2h ──── ‹ 1/5 › esc ─`. */
function Rule({ children, end }: { children: ReactNode; end: ReactNode }) {
	return (
		<header className="agent-dock-rule">
			<span className="agent-dock-rule-lead" aria-hidden="true" />
			<span className="agent-dock-rule-title">{children}</span>
			<span className="agent-dock-rule-fill" aria-hidden="true" />
			<span className="agent-dock-rule-end">{end}</span>
			<span className="agent-dock-rule-tail" aria-hidden="true" />
		</header>
	)
}

function CloseKey({ onClose }: { onClose(): void }) {
	return (
		<button
			type="button"
			className="agent-dock-rule-btn agent-dock-rule-close"
			aria-label="Close details"
			onClick={onClose}
		>
			esc
		</button>
	)
}

function ItemRule({
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
	const tone = cardTone(item, now)
	const time = itemTimeLine(item, now)
	return (
		<Rule
			end={
				<>
					<span className="agent-dock-stepper">
						<button
							type="button"
							className="agent-dock-rule-btn"
							aria-label="Previous item"
							disabled={index <= 0}
							onClick={() => onStep(-1)}
						>
							‹
						</button>
						<span className="agent-dock-step-count" aria-live="polite">
							{index + 1}/{total}
						</span>
						<button
							type="button"
							className="agent-dock-rule-btn"
							aria-label="Next item"
							disabled={index >= total - 1}
							onClick={() => onStep(1)}
						>
							›
						</button>
					</span>
					<CloseKey onClose={onClose} />
				</>
			}
		>
			<span className="agent-dock-glyph" data-tone={tone} aria-hidden="true">
				{kindGlyph(item)}
			</span>
			<span className="agent-dock-rule-kind" data-tone={tone}>
				{cardKindLabel(item)}
			</span>
			{/* Name first, project dim after it — as on the entries. */}
			<span className="agent-dock-rule-name">{where.name}</span>
			{where.project ? <span className="agent-dock-rule-project">{where.project}</span> : null}
			<span className="agent-dock-rule-meta">
				<span>#{item.id}</span>
				<span>{time.stamp}</span>
				<span className="agent-dock-rule-age" data-tone={itemAgeTone(item, now)}>
					{time.waited}
				</span>
			</span>
		</Rule>
	)
}

function Hint({ keys, children }: { keys: string; children: ReactNode }) {
	return (
		<span className="agent-dock-hint">
			<kbd>{keys}</kbd> {children}
		</span>
	)
}

/** Footer: key hints left, then the receipt / hint in words, then the decisions. No rule: the pane runs on into its entry. */
function Footer({ hints, note, children }: { hints: ReactNode; note: ReactNode; children?: ReactNode }) {
	return (
		<footer className="agent-dock-foot">
			<span className="agent-dock-foot-hints">{hints}</span>
			<span className="agent-dock-foot-note">{note}</span>
			{children ? <span className="agent-dock-foot-actions">{children}</span> : null}
		</footer>
	)
}

/** A footer decision: the shared button in the dock's monospace (its key is in the footer hints). */
function Key({
	tone,
	disabled,
	busy,
	ariaLabel,
	onClick,
	children,
}: {
	tone: ButtonTone
	disabled?: boolean
	busy?: boolean
	ariaLabel?: string
	onClick(): void
	children: string
}) {
	return (
		<Btn
			tone={tone}
			sm
			className="agent-dock-key"
			disabled={disabled}
			busy={busy}
			ariaLabel={ariaLabel}
			onClick={onClick}
		>
			{children}
		</Btn>
	)
}

function Receipt({ view }: { view: ReceiptView }) {
	return (
		<output className="agent-dock-receipt" data-tone={view.tone}>
			{view.text}
		</output>
	)
}

/** Second confirmation for free text to the agent that mentions deploy/prod/secret/push/merge. */
function RiskyConfirm({ word, what }: { word: string; what: string }) {
	return (
		<span className="agent-dock-confirm" role="alert">
			{what} mentions “{word}”. Send it to the agent anyway?
		</span>
	)
}

/** Pane-level keys a body handles (digits, Enter). Returns true when it consumed the event. */
export type DetailKeys = (event: KeyboardEvent<HTMLElement>) => boolean

/** Typing in a field never picks options or submits through the pane keys. */
export const isTextField = (target: EventTarget | null): boolean =>
	target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null

/** Per-item text drafts that survive stepping and closing the pane (renderer memory only). */
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

/** Binds a body's key handler for the pane while it is mounted. */
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

/** Enter on the pane itself or its scroll body (buttons and fields keep their own Enter). */
const isBareEnter = (event: KeyboardEvent<HTMLElement>): boolean =>
	event.key === 'Enter' &&
	!event.shiftKey &&
	!event.metaKey &&
	!event.ctrlKey &&
	!event.altKey &&
	!isTextField(event.target) &&
	(event.target === event.currentTarget || (event.target as Element).classList?.contains('agent-dock-pane-scroll'))

const pickHints = (count: number, verb: string, submit: string) => (
	<>
		<Hint keys={count > 1 ? `1–${count}` : '1'}>{verb}</Hint>
		<Hint keys="enter">{submit}</Hint>
		<Hint keys="esc">close</Hint>
	</>
)

interface ChoiceRow {
	id: string
	label: ReactNode
	description?: ReactNode
	tone?: 'danger'
}

/** Numbered rows like Claude Code's own list: cursor, number, label, aligned description. */
function Choices({
	rows,
	picked,
	multi,
	live,
	focused,
	label,
	onPick,
	onPoint,
}: {
	rows: ChoiceRow[]
	picked: ReadonlySet<string>
	multi?: boolean
	live: boolean
	/** The row whose preview shows (questions with previews). */
	focused?: string | null
	label: string
	onPick(id: string): void
	onPoint?(id: string): void
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset cannot be the subgrid parent the choice rows align to.
		<div className="agent-dock-choices" role="group" aria-label={label} data-multi={String(multi === true)}>
			{rows.map((row, at) => {
				const on = picked.has(row.id)
				return (
					<button
						type="button"
						key={row.id}
						className="agent-dock-choice"
						data-tone={row.tone}
						data-focused={focused === undefined ? undefined : String(focused === row.id)}
						aria-pressed={on}
						disabled={!live}
						onClick={() => onPick(row.id)}
						onMouseEnter={() => onPoint?.(row.id)}
						onFocus={() => onPoint?.(row.id)}
					>
						<span className="agent-dock-choice-cursor" aria-hidden="true">
							{multi ? (on ? '[x]' : '[ ]') : on ? '>' : ''}
						</span>
						<span className="agent-dock-choice-n">{at + 1}</span>{' '}
						<span className="agent-dock-choice-label">{row.label}</span>
						{row.description ? (
							<>
								{' '}
								<span className="agent-dock-choice-description">{row.description}</span>
							</>
						) : null}
					</button>
				)
			})}
		</div>
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
	const orphaned = item.state === 'orphaned'
	const resolved = item.state === 'resolved'
	const ackable =
		!resolved && (item.kind === 'turn' || orphaned || item.state === 'unconfirmed') && item.state !== 'sending'
	const ack = ackable ? (
		<Key tone="quiet" busy={pending} onClick={onAck} ariaLabel={`Ack item ${item.id}`}>
			Ack
		</Key>
	) : null
	const view = receiptView(item)
	const receipt = view ? (
		<Receipt view={view} />
	) : localError ? (
		<Receipt view={{ text: localError, tone: 'danger', busy: false }} />
	) : resolved ? (
		// Closed elsewhere while the pane showed it: it stays until Jakub closes the pane, saying how it went.
		<Receipt view={{ text: resolutionLabel(item), tone: 'neutral', busy: false }} />
	) : null
	const warnings = (
		<>
			{refused ? <Warn>Not acked: the item changed. Check it again.</Warn> : null}
			{orphaned ? (
				<Warn>Okena restarted while this was open. The agent may still be waiting in its terminal.</Warn>
			) : null}
			{item.state === 'unconfirmed' ? (
				<Warn>
					{item.kind === 'ask'
						? 'Helm has not seen this answer land. If the dialog is still open, it comes back here to answer again.'
						: "Okena took the answer, but Helm has not seen it land. Check the agent's terminal, then Ack."}
				</Warn>
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
			<ItemRule item={item} session={session} now={now} index={index} total={total} onStep={onStep} onClose={onClose} />
			{body}
		</>
	)
}

function Warn({ children }: { children: ReactNode }) {
	return (
		<p className="agent-dock-warn">
			<span className="agent-dock-warn-mark" aria-hidden="true">
				!
			</span>
			<span>{children}</span>
		</p>
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
	const OTHER = 'other'

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
	const rows: ChoiceRow[] = [
		...question.options.map((option, at) => ({
			id: String(at),
			label: option.label,
			...(option.description ? { description: option.description } : {}),
		})),
		{ id: OTHER, label: 'Other…', description: 'Type your own answer' },
	]
	const pickedIds = new Set([...picked.map(String), ...(otherActive ? [OTHER] : [])])
	const note = confirming ? (
		<RiskyConfirm word={confirming} what="This answer" />
	) : (
		(receipt ??
		blockedNote ??
		(complete ? 'Ready to submit' : questions.length > 1 ? 'Answer every question, then submit' : 'Pick an answer'))
	)
	const preview = question.options[previewIndex]
	return (
		<>
			<div className="agent-dock-pane-scroll" {...SCROLL_REGION}>
				{warnings}
				<div className="agent-dock-ask" data-previews={String(hasPreviews)}>
					<div className="agent-dock-ask-main">
						{questions.length > 1 ? (
							<div className="agent-dock-qtabs" role="tablist" aria-label="Questions" onKeyDown={onTabsKey}>
								{questions.map((entry, at) => (
									<button
										// biome-ignore lint/suspicious/noArrayIndexKey: positional, immutable list
										key={at}
										type="button"
										role="tab"
										aria-selected={at === active}
										tabIndex={at === active ? 0 : -1}
										className="agent-dock-qtab"
										aria-label={`${entry.header ?? `Question ${at + 1}`}${answered(at) ? ', answered' : ''}`}
										onClick={() => showQuestion(at)}
									>
										<span className="agent-dock-qtab-mark" data-done={String(answered(at))} aria-hidden="true">
											{answered(at) ? '✓' : at + 1}
										</span>
										<span>{entry.header ?? `Question ${at + 1}`}</span>
									</button>
								))}
							</div>
						) : question.header ? (
							<p className="agent-dock-pane-label">{question.header}</p>
						) : null}
						<p className="agent-dock-question">
							{question.question}
							{question.multiSelect ? <span className="agent-dock-quiet"> (pick several)</span> : null}
						</p>
						<Choices
							rows={rows}
							picked={pickedIds}
							multi={question.multiSelect}
							live={live}
							focused={hasPreviews ? String(previewIndex) : undefined}
							label="Options"
							onPick={id => (id === OTHER ? chooseOther() : pick(Number(id)))}
							onPoint={id => {
								if (id !== OTHER) setHovered(Number(id))
							}}
						/>
						{otherActive ? (
							<label className="agent-dock-prompt">
								<span className="agent-dock-prompt-mark" aria-hidden="true">
									&gt;
								</span>
								<input
									// Remount per question so the field follows the tab.
									key={`other-${active}`}
									ref={otherInput}
									className="agent-dock-input"
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
							</label>
						) : null}
					</div>
					{hasPreviews ? (
						<aside className="agent-dock-preview" aria-label="Preview">
							<span className="agent-dock-preview-label">
								<span className="agent-dock-quiet">preview</span> {preview?.label ?? ''}
							</span>
							<pre className="agent-dock-preview-text">{preview?.preview ?? 'No preview for this option.'}</pre>
						</aside>
					) : null}
				</div>
			</div>
			<Footer hints={pickHints(rows.length, 'pick', 'submit')} note={note}>
				{ack}
				{confirming ? (
					<>
						<Key tone="ghost" onClick={() => setConfirming(null)}>
							Cancel
						</Key>
						<Key tone="danger" disabled={!live || !complete} busy={submitting} onClick={() => submit(true)}>
							Send anyway
						</Key>
					</>
				) : (
					<Key
						tone={complete && live ? 'primary' : 'ghost'}
						disabled={!live || !complete}
						busy={submitting}
						onClick={() => submit()}
					>
						Submit answers
					</Key>
				)}
			</Footer>
		</>
	)
}

type Choice = ChoiceRow & { submit: string; action: DockAction | 'deny' }

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
	const note = confirming ? (
		<RiskyConfirm word={confirming} what="This message" />
	) : (
		(receipt ?? blockedNote ?? (choice ? 'Ready to send' : hint))
	)
	return (
		<>
			<div className="agent-dock-pane-scroll" {...SCROLL_REGION}>
				{warnings}
				<div className="agent-dock-pane-body">
					{children}
					<Choices
						rows={choices}
						picked={new Set(selected ? [selected] : [])}
						live={live}
						label="Choices"
						onPick={choose}
					/>
					{choice?.action === 'deny' ? (
						<label className="agent-dock-prompt">
							<span className="agent-dock-prompt-mark" aria-hidden="true">
								&gt;
							</span>
							<textarea
								ref={messageRef}
								className="agent-dock-input"
								aria-label={messageLabel}
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
				</div>
			</div>
			<Footer hints={pickHints(choices.length, 'choose', 'confirm')} note={note}>
				{ack}
				{confirming ? (
					<>
						<Key tone="ghost" onClick={() => setConfirming(null)}>
							Cancel
						</Key>
						<Key tone="danger" disabled={!live || !choice} busy={submitting} onClick={() => submit(true)}>
							Send anyway
						</Key>
					</>
				) : (
					<Key
						tone={choice ? (choice.tone === 'danger' ? 'danger' : 'primary') : 'ghost'}
						disabled={!live || !choice}
						busy={submitting}
						onClick={() => submit()}
					>
						{choice?.submit ?? choices[0]?.submit ?? 'Send'}
					</Key>
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
				{ id: 'once', label: 'Allow once', submit: 'Allow once', action: { type: 'allow' } },
				...(always && always.length > 0
					? [
							{
								id: 'always',
								label: 'Always allow',
								description: (
									<>
										<code className="agent-dock-mono">{always.join(', ')}</code> (this session)
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
		{
			id: 'deny',
			label: 'Deny',
			description: 'and tell the agent what to do',
			tone: 'danger',
			submit: 'Deny',
			action: 'deny',
		},
	]
	return (
		<DecisionPanel
			panel={panel}
			choices={choices}
			messageLabel="Message to the agent (optional)"
			messagePlaceholder="What should it do instead?"
			hint={review.complete ? 'Pick allow or deny' : 'Allow in the terminal, or deny here'}
		>
			<p className="agent-dock-pane-lead">
				<span className="agent-dock-mono agent-dock-bright">{plainAgentLine(tool, 64)}</span> wants to{' '}
				{review.command !== null ? 'run' : 'use'}
				{description ? <span className="agent-dock-quiet"> · {description}</span> : null}
			</p>
			{review.flags.length > 0 ? (
				<Warn>
					{review.flags
						.map(flag => (flag === 'dangerouslyDisableSandbox' ? 'Runs outside the sandbox' : `${flag}: true`))
						.join(' · ')}
				</Warn>
			) : null}
			{review.command !== null ? (
				<pre className="agent-dock-command">
					<span className="agent-dock-command-prompt" aria-hidden="true">
						${' '}
					</span>
					{plainAgentText(review.command, REVIEW_COMMAND_MAX)}
				</pre>
			) : null}
			{review.fields !== null ? (
				<pre className="agent-dock-command agent-dock-fields">{plainAgentText(review.fields, REVIEW_FIELDS_MAX)}</pre>
			) : null}
			{review.complete ? null : (
				<Warn>Too long or unusual to show in full here. Review it in the agent's terminal to allow it.</Warn>
			)}
		</DecisionPanel>
	)
}

function PlanPanel(panel: PanelProps) {
	const { item } = panel
	const review = item.fact.kind === 'ask' ? planReview(item.fact.input) : null
	const complete = review?.complete === true
	// Approve sends the whole tool_input back: offer it only when every part of it shows here.
	const choices: Choice[] = [
		...(complete
			? [{ id: 'approve', label: 'Approve the plan', submit: 'Approve', action: { type: 'allow' } } satisfies Choice]
			: []),
		{
			id: 'keep',
			label: 'Keep planning',
			description: 'say what should change',
			submit: 'Keep planning',
			action: 'deny',
		},
	]
	return (
		<DecisionPanel
			panel={panel}
			choices={choices}
			messageLabel="What should change? (optional)"
			messagePlaceholder="Tell the agent what to plan differently"
			hint={complete ? 'Approve or keep planning' : 'Approve in the terminal, or keep planning here'}
		>
			{review?.plan ? (
				<pre className="agent-dock-plan">{plainAgentText(review.plan, REVIEW_PLAN_MAX)}</pre>
			) : (
				<p className="agent-dock-pane-lead">Plan ready for approval.</p>
			)}
			{review?.fields ? (
				<pre className="agent-dock-command agent-dock-fields">{plainAgentText(review.fields, REVIEW_FIELDS_MAX)}</pre>
			) : null}
			{complete ? null : (
				<Warn>
					The plan is missing, too long or unusual to show in full here. Review it in the agent's terminal to approve
					it.
				</Warn>
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
	const note = confirming ? (
		<RiskyConfirm word={confirming} what="This reply" />
	) : (
		(receipt ?? blockedNote ?? 'Typed into the agent’s terminal as your next prompt')
	)
	return (
		<>
			<div className="agent-dock-pane-scroll" {...SCROLL_REGION}>
				{warnings}
				<div className="agent-dock-pane-body">
					<div className="agent-dock-message">
						<span className="agent-dock-message-mark" aria-hidden="true">
							●
						</span>
						<p className="agent-dock-message-text">{plainAgentText(fact.text) || itemHeadline(item)}</p>
					</div>
					{notes.length > 0 || session?.prLinks.length ? (
						<p className="agent-dock-facts">
							{session?.prLinks.slice(0, 4).map(pr => (
								<span key={pr.number} className="agent-dock-fact-pr">
									PR #{pr.number}
								</span>
							))}
							{notes.map(line => (
								<span key={line}>{line}</span>
							))}
						</p>
					) : null}
					<label className="agent-dock-prompt agent-dock-reply">
						<span className="agent-dock-prompt-mark" aria-hidden="true">
							&gt;
						</span>
						<textarea
							className="agent-dock-input"
							aria-label="Reply"
							placeholder="Reply to the agent"
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
				</div>
			</div>
			<Footer
				hints={
					<>
						<Hint keys="⌘ enter">send</Hint>
						<Hint keys="esc">close</Hint>
					</>
				}
				note={note}
			>
				{ack}
				{confirming ? (
					<>
						<Key tone="ghost" onClick={() => setConfirming(null)}>
							Cancel
						</Key>
						<Key tone="danger" disabled={!ready} busy={submitting} onClick={() => send(true)}>
							Send anyway
						</Key>
					</>
				) : (
					<Key tone={ready ? 'primary' : 'ghost'} disabled={!ready} busy={submitting} onClick={() => send(false)}>
						Send
					</Key>
				)}
			</Footer>
		</>
	)
}

/** Every agent Okena lists, as a table of observed facts, then recently closed items. */
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
	const recent = recentItems(snapshot, RECENT_IN_PANE)
	const busy = sessions.filter(session => session.status === 'working' || session.status === 'background').length
	return (
		<>
			<Rule end={<CloseKey onClose={onClose} />}>
				<span className="agent-dock-rule-kind">Agents</span>
				<span className="agent-dock-rule-meta">
					<span>
						{sessions.length} connected, {busy} busy
					</span>
				</span>
			</Rule>
			<div className="agent-dock-pane-scroll" {...SCROLL_REGION}>
				<div className="agent-dock-pane-body">
					<ul className="agent-dock-table" aria-label="Agents">
						{snapshot
							? sessions.map(session => {
									const where = sessionWhere(session, session.key)
									const meta = agentRowMeta(snapshot, session)
									return (
										<li key={session.key} className="agent-dock-tr" data-status={session.status}>
											<span className="agent-dock-status" data-status={session.status} aria-hidden="true">
												{statusGlyph(session.status)}
											</span>
											<span className="agent-dock-td-name">{where.name}</span>
											<span className="agent-dock-td-project">{where.project}</span>
											<span className="agent-dock-td-status" data-status={session.status}>
												{sessionStatusText(session, now, sessionSince(snapshot, session))}
											</span>
											<span className="agent-dock-td-meta">{meta.join('  ')}</span>
										</li>
									)
								})
							: null}
					</ul>
					{recent.length > 0 ? (
						<section className="agent-dock-recent" aria-label="Recent">
							<h3 className="agent-dock-subrule">
								<span>Recent</span>
								<span className="agent-dock-rule-fill" aria-hidden="true" />
							</h3>
							<ul className="agent-dock-table">
								{recent.map(item => {
									const where = sessionWhere(findSession(snapshot, item.session), item.session)
									return (
										<li key={item.id} className="agent-dock-tr agent-dock-recent-row">
											<span className="agent-dock-status" aria-hidden="true">
												{kindGlyph({ ...item, state: 'open' })}
											</span>
											<span className="agent-dock-td-name" data-dim="true">
												{where.name}
											</span>
											<span className="agent-dock-td-project">
												{cardKindLabel(item).toLowerCase()} #{item.id}
											</span>
											<span className="agent-dock-td-status">
												{item.resolution ? `${formatAge(now - item.resolution.at)} ago` : ''}
											</span>
											<span className="agent-dock-td-meta">{resolutionLabel(item)}</span>
										</li>
									)
								})}
							</ul>
						</section>
					) : null}
				</div>
			</div>
			<Footer hints={<Hint keys="esc">close</Hint>} note={null} />
		</>
	)
}
