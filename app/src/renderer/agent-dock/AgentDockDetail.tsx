// Agent dock pane bodies (design §3.24): a plain header row on the dock's surface
// (kind glyph, kind, the question's context; ‹ 1/3 › and esc), choices as one line each
// (a drawn mark on the picked row, label, dim description; numbers as key hints while the
// pane holds the keys), key hints in the footer. Jakub answers from here — pick options
// (click, or 1–9 while the pane has focus), Other… text, allow / always allow /
// deny, approve / keep planning, or reply to a finished turn — then one explicit
// submit; nothing is ever sent implicitly. Main re-reads Okena (CAS) before the
// effect; the receipt (Sending… → ✓ answered / sent, unconfirmed / refused /
// verbatim error) comes back in the snapshot. Agent text is untrusted and always
// plain React text. One typeface, the UI's; mono only for literal commands, code,
// plans and previews.
import {
	type KeyboardEvent,
	type MutableRefObject,
	type ReactNode,
	type Ref,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import type { AgentDockSnapshot, DockAction, DockItem, DockSession } from '../../agent-dock/model'
import { REVIEW_COMMAND_MAX, REVIEW_FIELDS_MAX, REVIEW_PLAN_MAX, planReview } from '../../agent-dock/review'
import { Btn, type ButtonTone } from '../button'
import {
	type AgentWho,
	type AskQuestion,
	type ReceiptView,
	agentRowMeta,
	agentWho,
	agingTone,
	alwaysAllowLabels,
	askQuestions,
	cardKindLabel,
	cardTone,
	formatAge,
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
	sentSummary,
	sessionSince,
	sessionStatusText,
	statusGlyph,
} from './presentation'

const RECENT_IN_PANE = 5

/** The word for the submit modifier in key hints: `cmd` on macOS (Menlo draws ⌘ small), `ctrl` elsewhere. */
export type DockModKey = 'cmd' | 'ctrl'

/**
 * Marks a scroll box's clipped edges for the fades (`data-more` below, `data-more-above` above) and
 * reports whether it scrolls at all.
 */
function useScrollEdges(ref: RefObject<HTMLElement | null>): boolean {
	const [scrollable, setScrollable] = useState(false)
	useLayoutEffect(() => {
		const node = ref.current
		if (!node) return
		const update = () => {
			const below = String(node.scrollTop + node.clientHeight < node.scrollHeight - 1)
			const above = String(node.scrollTop > 1)
			if (node.dataset.more !== below) node.dataset.more = below
			if (node.dataset.moreAbove !== above) node.dataset.moreAbove = above
			setScrollable(node.scrollHeight > node.clientHeight + 1)
		}
		update()
		node.addEventListener('scroll', update, { passive: true })
		const observer = new ResizeObserver(update)
		observer.observe(node)
		for (const child of node.children) observer.observe(child)
		return () => {
			node.removeEventListener('scroll', update)
			observer.disconnect()
		}
	})
	return scrollable
}

/**
 * The pane body (`role=region`, named after what it holds). It is a tab stop only while it clips
 * content, so keyboard users can scroll it (↑ ↓, Page keys); a body that fits is no dead stop.
 */
function ScrollBody({ label, children }: { label: string; children: ReactNode }) {
	const ref = useRef<HTMLElement>(null)
	const scrollable = useScrollEdges(ref)
	return (
		<section ref={ref} className="agent-dock-pane-scroll" tabIndex={scrollable ? 0 : -1} aria-label={label}>
			{children}
		</section>
	)
}

/**
 * The pane's header: a plain row on the dock's surface (no rule): what and whose on the left, the
 * stepper and esc on the right. `title` is the full context (task title, exact time) for its tooltip.
 */
function Header({ children, end, title }: { children: ReactNode; end: ReactNode; title?: string }) {
	return (
		<header className="agent-dock-title">
			<span className="agent-dock-title-text" title={title}>
				{children}
			</span>
			<span className="agent-dock-title-end">{end}</span>
		</header>
	)
}

function CloseKey({ onClose }: { onClose(): void }) {
	return (
		<button
			type="button"
			className="agent-dock-title-btn agent-dock-title-close"
			aria-label="Close details"
			aria-keyshortcuts="Escape"
			onClick={onClose}
		>
			esc
		</button>
	)
}

/** Kind glyph: the header's one colored mark. */
function Glyph({ item, tone }: { item: DockItem; tone: string }) {
	return (
		<span className="agent-dock-glyph" data-tone={tone} aria-hidden="true">
			{kindGlyph(item)}
		</span>
	)
}

function ItemHeader({
	item,
	who,
	now,
	index,
	total,
	onStep,
	onClose,
}: {
	item: DockItem
	who: AgentWho
	now: number
	index: number
	total: number
	onStep(delta: number): void
	onClose(): void
}) {
	const time = itemTimeLine(item, now)
	const kind = cardKindLabel(item)
	const context = headerContext(item)
	// The queue's selected fill says whose; the header says only what (kind + question context).
	// Whose, the task title and when are its tooltip.
	return (
		<Header
			title={[who.title || who.name, who.project, `${kind} #${item.id} · ${time.stamp} · ${time.waited}`]
				.filter(Boolean)
				.join('\n')}
			end={
				<>
					<span className="agent-dock-stepper">
						<button
							type="button"
							className="agent-dock-title-btn"
							aria-label="Previous item"
							disabled={index <= 0}
							onClick={() => onStep(-1)}
						>
							‹
						</button>
						<span className="agent-dock-step-count" aria-live="polite">
							<span aria-hidden="true">
								{index + 1}/{total}
							</span>
							<span className="sr-only">
								Item {index + 1} of {total}
							</span>
						</span>
						<button
							type="button"
							className="agent-dock-title-btn"
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
			<span className="agent-dock-title-kind">
				<Glyph item={item} tone={cardTone(item)} />
				{kind}
			</span>
			{context ? <span className="agent-dock-title-context">{context}</span> : null}
		</Header>
	)
}

/** Header context after the kind: a single question's short header, or how many questions. */
function headerContext(item: DockItem): string | null {
	if (item.fact.kind !== 'ask' || item.fact.tool !== 'AskUserQuestion') return null
	const questions = askQuestions(item.fact.input) ?? []
	if (questions.length > 1) return `${questions.length} questions`
	return questions[0]?.header ? plainAgentLine(questions[0].header, 64) : null
}

function Hint({ keys, pick, children }: { keys: string; pick?: boolean; children: ReactNode }) {
	return (
		<span className="agent-dock-hint" data-pick={pick ? '' : undefined}>
			{/* Modifier symbols get the row's ⌘⇧J spacing. */}
			<kbd data-face={keys.startsWith('⌘') ? 'symbols' : undefined}>{keys}</kbd> {children}
		</span>
	)
}

/**
 * Footer: key hints left, then the receipt / hint in words, then the decisions. No rule of its own: the
 * pane's one hairline toward the queue closes it. The hints are for sighted keyboard use only (the controls carry aria-keyshortcuts)
 * and show only while the pane holds focus, since only then do the keys reach it.
 */
function Footer({ hints, note, children }: { hints: ReactNode; note: ReactNode; children?: ReactNode }) {
	return (
		<footer className="agent-dock-foot">
			<span className="agent-dock-foot-hints" aria-hidden="true">
				{hints}
			</span>
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
	keyShortcuts,
	onClick,
	children,
}: {
	tone: ButtonTone
	disabled?: boolean
	busy?: boolean
	ariaLabel?: string
	keyShortcuts?: string
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
			ariaKeyShortcuts={keyShortcuts}
			onClick={onClick}
		>
			{children}
		</Btn>
	)
}

/** A receipt, and what was sent when the pane knows it (`✓ answered · Blue, M`). */
function Receipt({ view, detail = null }: { view: ReceiptView; detail?: string | null }) {
	return (
		<output className="agent-dock-receipt" data-tone={view.tone}>
			{view.text}
			{detail ? <span className="agent-dock-receipt-detail"> · {detail}</span> : null}
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

/** Pane-level keys a body handles (digits, Enter, Esc while confirming). Returns true when it consumed the event. */
export type DetailKeys = (event: KeyboardEvent<HTMLElement>) => boolean

/** Typing in a field never picks options or submits through the pane keys. */
export const isTextField = (target: EventTarget | null): boolean =>
	target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null

/** Per-item drafts that survive stepping and closing the pane (renderer memory only): reply/deny text, question picks. */
export type DockDrafts = Map<string, string>

/** Draft keys of one item, cleared once an act for it succeeds. */
export const draftKeys = (itemId: number): string[] => [`ask:${itemId}`, `deny:${itemId}`, `reply:${itemId}`]

function useDraft(drafts: DockDrafts, key: string, fallback = ''): [string, (value: string) => void] {
	const [value, setValue] = useState(() => drafts.get(key) ?? fallback)
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
	/** The item can be answered here at all (open, Okena reachable); unlike `live`, steady while sending. */
	answerable: boolean
	/** The decision button belongs in the footer: answerable, or an answer is on its way (it shows busy). */
	decidable: boolean
	/** What was last sent from the dock for this item: shown while sending and after, restored after a failure. */
	sent: DockAction | null
	mod: DockModKey
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

const noModifiers = (event: KeyboardEvent<HTMLElement>): boolean => !event.metaKey && !event.ctrlKey && !event.altKey

/** 1–9 from a key event, or null. */
const digitOf = (event: KeyboardEvent<HTMLElement>): number | null => {
	if (!noModifiers(event) || isTextField(event.target)) return null
	const digit = Number(event.key)
	return /^[1-9]$/.test(event.key) && Number.isInteger(digit) ? digit : null
}

/** Enter on the pane itself or its scroll body (buttons and fields keep their own Enter). */
const isBareEnter = (event: KeyboardEvent<HTMLElement>): boolean =>
	event.key === 'Enter' &&
	!event.shiftKey &&
	noModifiers(event) &&
	!event.nativeEvent.isComposing &&
	!isTextField(event.target) &&
	(event.target === event.currentTarget || (event.target as Element).classList?.contains('agent-dock-pane-scroll'))

/** ⌘Enter (Ctrl+Enter off macOS): submit from anywhere in the pane, fields and choices included. */
const isModEnter = (event: KeyboardEvent<HTMLElement>): boolean =>
	event.key === 'Enter' &&
	(event.metaKey || event.ctrlKey) &&
	!event.altKey &&
	!event.shiftKey &&
	!event.nativeEvent.isComposing

/** A printable key (shift allowed) outside a text field; Space stays the pane's page key. */
const isPrintable = (event: KeyboardEvent<HTMLElement>): boolean =>
	event.key.length === 1 &&
	event.key !== ' ' &&
	noModifiers(event) &&
	!event.nativeEvent.isComposing &&
	!isTextField(event.target)

/** A printable key that is not a pick (1–9): Jakub is typing, but not into a field. */
const isStrayKey = (event: KeyboardEvent<HTMLElement>): boolean => isPrintable(event) && !/^[1-9]$/.test(event.key)

/**
 * Submit keys under the risky-word rule: ⌘Enter anywhere in the pane and, where `bareEnter`, Enter
 * on the pane or its body. While the confirmation asks, neither sends — only Send anyway does — a
 * held key never submits, and Esc cancels the confirmation instead of closing the pane.
 */
function submitKeys(
	event: KeyboardEvent<HTMLElement>,
	{
		confirming,
		bareEnter,
		cancel,
		submit,
	}: { confirming: boolean; bareEnter: boolean; cancel(): void; submit(): void },
): boolean {
	if (event.key === 'Escape' && confirming) {
		cancel()
		return true
	}
	if (isModEnter(event) || (bareEnter && isBareEnter(event))) {
		if (!confirming && !event.repeat) submit()
		return true
	}
	return false
}

const modShortcut = (mod: DockModKey): string => (mod === 'cmd' ? 'Meta+Enter' : 'Control+Enter')

/** The submit key as the hints show it: one notation with the row's `⌘⇧J` (`Ctrl+Enter` off macOS). */
const modHint = (mod: DockModKey): string => (mod === 'cmd' ? '⌘↵' : 'Ctrl+Enter')

const closeHints = <Hint keys="esc">close</Hint>
const cancelHints = <Hint keys="esc">cancel</Hint>

const pickHints = (count: number, mod: DockModKey) => (
	<>
		<Hint keys={count > 1 ? `1–${count}` : '1'} pick>
			pick
		</Hint>
		<Hint keys={modHint(mod)}>submit</Hint>
		<Hint keys="esc">close</Hint>
	</>
)

interface ChoiceRow {
	id: string
	label: ReactNode
	description?: ReactNode
	tone?: 'danger'
}

/**
 * Numbered rows like Claude Code's own list: cursor, number, label, aligned description. One tab
 * stop (roving): ↑ ↓ Home End move focus only — a pick auto-advances single-select questions, so
 * arrows never pick. Radio rows for one answer, checkboxes for several.
 */
function Choices({
	rows,
	picked,
	multi,
	live,
	labelledBy,
	label,
	keyPrefix = '',
	groupRef,
	onPick,
	onPoint,
}: {
	rows: ChoiceRow[]
	picked: ReadonlySet<string>
	multi?: boolean
	live: boolean
	labelledBy?: string
	label?: string
	/** Rows are keyed per question so a pick that moves on never leaves focus on an unseen option. */
	keyPrefix?: string
	groupRef?: Ref<HTMLDivElement>
	onPick(id: string): void
	onPoint?(id: string): void
}) {
	const [current, setCurrent] = useState<string | null>(null)
	const stop =
		(current !== null && rows.some(row => row.id === current) ? current : null) ??
		rows.find(row => picked.has(row.id))?.id ??
		rows[0]?.id
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !noModifiers(event)) return
		const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.agent-dock-choice')]
		const at = buttons.indexOf(event.target as HTMLButtonElement)
		if (at < 0) return
		event.preventDefault()
		event.stopPropagation()
		const last = buttons.length - 1
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? last
					: Math.max(0, Math.min(last, at + (event.key === 'ArrowDown' ? 1 : -1)))
		buttons[next]?.focus()
	}
	return (
		<div
			ref={groupRef}
			className="agent-dock-choices"
			role={multi ? 'group' : 'radiogroup'}
			aria-labelledby={labelledBy}
			aria-label={labelledBy ? undefined : label}
			aria-keyshortcuts={rows.map((_, at) => at + 1).join(' ')}
			data-multi={String(multi === true)}
			onKeyDown={onKeyDown}
		>
			{rows.map((row, at) => {
				const on = picked.has(row.id)
				return (
					<button
						type="button"
						key={`${keyPrefix}:${row.id}`}
						className="agent-dock-choice"
						role={multi ? 'checkbox' : 'radio'}
						data-tone={row.tone}
						aria-checked={on}
						// The description keeps to one line: the whole of it is the row's tooltip.
						title={typeof row.description === 'string' ? row.description : undefined}
						tabIndex={row.id === stop ? 0 : -1}
						disabled={!live}
						onClick={() => onPick(row.id)}
						onMouseEnter={() => onPoint?.(row.id)}
						onFocus={() => {
							setCurrent(row.id)
							onPoint?.(row.id)
						}}
					>
						{/* The mark is drawn (a dot, or a box for several); aria-checked says it. */}
						<span className="agent-dock-choice-cursor" data-on={String(on)} aria-hidden="true" />
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
	who,
	now,
	index,
	total,
	pending,
	refused,
	canAct,
	blockedNote,
	submitting,
	sent,
	localError,
	keys,
	drafts,
	mod,
	onStep,
	onClose,
	onAck,
	onAct,
}: {
	item: DockItem
	session: DockSession | undefined
	who: AgentWho
	now: number
	index: number
	total: number
	pending: boolean
	refused: boolean
	/** Okena reachable and the item open: answering is possible. */
	canAct: boolean
	blockedNote: string | null
	submitting: boolean
	sent: DockAction | null
	/** A refusal/failure main did not record on the item (bad request, IPC failure). */
	localError: string | null
	keys: MutableRefObject<DetailKeys | null>
	drafts: DockDrafts
	mod: DockModKey
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
	const sourceName = session?.source === 'helm' ? "Helm's Claude hub" : 'Okena'
	const view = receiptView(item)
	const receipt = view ? (
		<Receipt view={view} detail={sent && view.tone !== 'danger' ? sentSummary(item, sent) : null} />
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
				<Warn>{sourceName} restarted while this was open. The agent may still be waiting in its terminal.</Warn>
			) : null}
			{item.state === 'unconfirmed' ? (
				<Warn>
					{item.kind === 'ask'
						? 'Helm has not seen this answer land. If the dialog is still open, it comes back here to answer again.'
						: `${sourceName} took the answer, but Helm has not seen it land. Check the agent's terminal, then Ack.`}
				</Warn>
			) : null}
		</>
	)
	const panel: PanelProps = {
		item,
		live: canAct && !submitting,
		answerable: canAct,
		decidable: canAct || submitting || item.state === 'sending',
		sent,
		mod,
		blockedNote: orphaned ? `Answer in the terminal (${sourceName} lost this dialog)` : canAct ? null : blockedNote,
		receipt,
		ack,
		warnings,
		keys,
		drafts,
		// An answer on its way (sent from here, or already Sending… in the snapshot): the button shows busy.
		submitting: submitting || item.state === 'sending',
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
			<ItemHeader item={item} who={who} now={now} index={index} total={total} onStep={onStep} onClose={onClose} />
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

interface AskDraft {
	active: number
	picks: number[][]
	others: string[]
	otherOn: boolean[]
}

/** A question draft from `drafts`, only when it still fits this item's questions. */
function readAskDraft(raw: string | undefined, questions: number): AskDraft | null {
	if (!raw) return null
	try {
		const draft = JSON.parse(raw) as Partial<AskDraft>
		const fits = (list: unknown): list is unknown[] => Array.isArray(list) && list.length === questions
		if (
			typeof draft.active !== 'number' ||
			draft.active < 0 ||
			draft.active >= questions ||
			!fits(draft.picks) ||
			!draft.picks.every(entry => Array.isArray(entry) && entry.every(Number.isInteger)) ||
			!fits(draft.others) ||
			!draft.others.every(entry => typeof entry === 'string') ||
			!fits(draft.otherOn) ||
			!draft.otherOn.every(entry => typeof entry === 'boolean')
		)
			return null
		return draft as AskDraft
	} catch {
		return null
	}
}

/** The picks an answer carried, as a draft over the shown options (raw option indexes map back to rows). */
function sentAskDraft(sent: DockAction | null, questions: AskQuestion[]): AskDraft | null {
	if (sent?.type !== 'answer' || sent.picks.length !== questions.length) return null
	return {
		active: 0,
		picks: sent.picks.map((pick, at) =>
			pick.options
				.map(raw => (questions[at]?.options ?? []).findIndex(option => option.index === raw))
				.filter(shown => shown >= 0),
		),
		others: sent.picks.map(pick => pick.other ?? ''),
		otherOn: sent.picks.map(pick => (pick.other ?? '') !== ''),
	}
}

function AskPanel({
	item,
	live,
	answerable,
	decidable,
	sent,
	mod,
	blockedNote,
	receipt,
	ack,
	warnings,
	keys,
	drafts,
	submitting,
	onAct,
}: PanelProps) {
	const questions = item.fact.kind === 'ask' ? (askQuestions(item.fact.input) ?? []) : []
	const draftKey = `ask:${item.id}`
	// Picks and Other text survive ‹ ›, closing the pane and collapsing the queue, like reply/deny drafts.
	// Once sent, the sent picks show (dimmed while sending, under the receipt after); a failure keeps them armed.
	const [saved] = useState(() => readAskDraft(drafts.get(draftKey), questions.length) ?? sentAskDraft(sent, questions))
	const [active, setActive] = useState(saved?.active ?? 0)
	const [picks, setPicks] = useState<number[][]>(() => saved?.picks ?? questions.map(() => []))
	const [others, setOthers] = useState<string[]>(() => saved?.others ?? questions.map(() => ''))
	/** "Other…" chosen for a question: its text field shows. */
	const [otherOn, setOtherOn] = useState<boolean[]>(() => saved?.otherOn ?? questions.map(() => false))
	/** Off after a stray typed key: Enter submits nothing until the next pick. */
	const [armed, setArmed] = useState(true)
	const otherInput = useRef<HTMLInputElement>(null)
	const focusOther = useRef(false)
	const choicesRef = useRef<HTMLDivElement>(null)
	const fixedRef = useRef<HTMLDivElement>(null)
	useScrollEdges(fixedRef)
	const focusChoices = useRef(false)
	const questionId = useId()
	/** The risky word an Other answer mentions, while the second confirmation asks. */
	const [confirming, setConfirming] = useState<string | null>(null)
	// Until Jakub points at an option, preview the first option that has one (no row is highlighted for it).
	const firstPreview = (at: number) =>
		Math.max(
			0,
			(questions[at]?.options ?? []).findIndex(option => option.preview),
		)
	const [hovered, setHovered] = useState(() => firstPreview(saved?.active ?? 0))
	/** Jakub pointed at (hovered, focused or picked) an option: until then the preview is the first one that has one. */
	const [pointed, setPointed] = useState(false)
	useEffect(() => {
		// Only Jakub's own edits are a draft (not picks shown from a sent answer).
		if (!live) return
		const touched = picks.some(entry => entry.length > 0) || otherOn.some(Boolean) || others.some(Boolean)
		if (touched) drafts.set(draftKey, JSON.stringify({ active, picks, others, otherOn } satisfies AskDraft))
		else drafts.delete(draftKey)
	}, [drafts, draftKey, live, active, picks, others, otherOn])
	useLayoutEffect(() => {
		if (focusOther.current) {
			focusOther.current = false
			otherInput.current?.focus()
		}
		if (focusChoices.current) {
			focusChoices.current = false
			choicesRef.current?.querySelector<HTMLElement>('.agent-dock-choice[tabindex="0"]')?.focus()
		}
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
		setPointed(false)
	}
	const setAt = <T,>(list: T[], at: number, value: T): T[] => list.map((entry, index) => (index === at ? value : entry))
	const pick = (option: number) => {
		if (!live) return
		setArmed(true)
		setConfirming(null)
		setHovered(option)
		if (question.multiSelect) {
			const has = picked.includes(option)
			setPicks(prev => setAt(prev, active, has ? picked.filter(entry => entry !== option) : [...picked, option]))
			return
		}
		setPicks(prev => setAt(prev, active, [option]))
		setOtherOn(prev => setAt(prev, active, false))
		// One answer per question: move on to the next unanswered one. Focus on a choice follows to the new
		// question's list, so it never sits on an option Jakub has not seen.
		const next = questions.findIndex((_, at) => at !== active && !answered(at))
		if (next < 0) return
		const group = choicesRef.current
		if (group?.contains(group.ownerDocument.activeElement)) focusChoices.current = true
		showQuestion(next)
	}
	const chooseOther = () => {
		if (!live) return
		setArmed(true)
		setConfirming(null)
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
		const keyed = submitKeys(event, {
			confirming: confirming !== null,
			bareEnter: true,
			cancel: () => setConfirming(null),
			submit: () => {
				if (armed) submit()
			},
		})
		if (keyed) return true
		const digit = digitOf(event)
		if (digit !== null) {
			if (digit <= question.options.length) pick(digit - 1)
			else if (digit === otherNumber) chooseOther()
			else return false
			return true
		}
		// Letters typed at the pane are meant for somewhere else: drop the pick-to-submit so a stray Enter sends nothing.
		if (isStrayKey(event)) {
			setArmed(false)
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
		// Nothing to say before a pick: the disabled Submit and the `1–N pick` hint already say it.
		(complete && armed
			? 'Ready to submit'
			: questions.length > 1 && !complete
				? 'Answer every question, then submit'
				: null))
	)
	const preview = question.options[previewIndex]
	return (
		<>
			<ScrollBody label="Question">
				{warnings}
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
				) : null}
				<p className="agent-dock-question" id={questionId}>
					{question.question}
					{question.multiSelect ? <span className="agent-dock-quiet"> (pick several)</span> : null}
				</p>
			</ScrollBody>
			{/* Choices never scroll out of a pane sized for an earlier item: only the question above them scrolls. */}
			<div ref={fixedRef} className="agent-dock-pane-fixed">
				<div className="agent-dock-ask" data-previews={String(hasPreviews)}>
					<div className="agent-dock-ask-main">
						<Choices
							rows={rows}
							picked={pickedIds}
							multi={question.multiSelect}
							live={live}
							labelledBy={questionId}
							keyPrefix={String(active)}
							groupRef={choicesRef}
							onPick={id => (id === OTHER ? chooseOther() : pick(Number(id)))}
							onPoint={id => {
								if (id === OTHER) return
								setHovered(Number(id))
								setPointed(true)
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
										setArmed(true)
									}}
									onKeyDown={event => {
										// ⌘Enter goes on to the pane's submit keys; bare Enter submits or moves to the next question.
										if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return
										event.preventDefault()
										event.stopPropagation()
										if (confirming !== null || event.repeat) return
										if (complete) submit()
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
							{/* Numbered like its row; dim until Jakub points at an option (nothing is preselected). */}
							<span
								className="agent-dock-preview-label"
								data-pointed={String(pointed || picked.length > 0)}
								title={pointed || picked.length > 0 ? undefined : 'The first option with a preview'}
							>
								<span className="agent-dock-quiet">preview</span>{' '}
								<span className="agent-dock-preview-n">{previewIndex + 1}</span> {preview?.label ?? ''}
							</span>
							{preview?.preview ? (
								<pre className="agent-dock-preview-text">{preview.preview}</pre>
							) : (
								<p className="agent-dock-preview-empty">No preview for this option.</p>
							)}
						</aside>
					) : null}
				</div>
			</div>
			<Footer hints={!answerable ? closeHints : confirming ? cancelHints : pickHints(rows.length, mod)} note={note}>
				{ack}
				{!decidable ? null : confirming ? (
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
						tone="primary"
						disabled={!live || !complete}
						busy={submitting}
						keyShortcuts={modShortcut(mod)}
						onClick={() => submit()}
					>
						Submit answers
					</Key>
				)}
			</Footer>
		</>
	)
}

/** A decision row: what its button says, the note once it is picked ("Ready to deny"), and the act. */
type Choice = ChoiceRow & { submit: string; ready: string; action: DockAction | 'deny' }

/** The row a sent decision picked (deny / keep planning, allow once / always / approve). */
const sentChoice = (choices: Choice[], sent: DockAction | null): string | null =>
	choices.find(choice =>
		sent?.type === 'deny'
			? choice.action === 'deny'
			: sent?.type === 'allow' &&
				choice.action !== 'deny' &&
				choice.action.type === 'allow' &&
				(choice.action.always === true) === (sent.always === true),
	)?.id ?? null

/**
 * Pick-then-submit body shared by permission and plan dialogs: a numbered choice,
 * an optional message field for "deny", one submit. No single click allows anything.
 */
function DecisionPanel({
	panel,
	choices,
	children,
	bodyLabel,
	choicesLabel,
	messageLabel,
	messagePlaceholder,
	denyVerb,
	hint,
}: {
	panel: PanelProps
	choices: Choice[]
	children: ReactNode
	/** Accessible name of the scroll body ("Command", "Plan"). */
	bodyLabel: string
	/** Names the choice list: the lead's id, or words. */
	choicesLabel: { labelledBy: string } | { label: string }
	messageLabel: string
	messagePlaceholder: string
	/** Hint word for ⌘Enter while the deny/keep-planning field shows ("deny", "send back"). */
	denyVerb: string
	/** The note before a pick, only when it says more than the choices do. */
	hint: string | null
}) {
	const {
		item,
		live,
		answerable,
		decidable,
		sent,
		mod,
		blockedNote,
		receipt,
		ack,
		warnings,
		keys,
		drafts,
		submitting,
		onAct,
	} = panel
	// A sent decision stays shown (dimmed while sending, under the receipt after); a failure keeps it armed.
	const [selected, setSelected] = useState<string | null>(() => sentChoice(choices, sent))
	const [message, setMessage] = useDraft(drafts, `deny:${item.id}`, sent?.type === 'deny' ? (sent.message ?? '') : '')
	/** The risky word a deny message mentions, while the second confirmation asks. */
	const [confirming, setConfirming] = useState<string | null>(null)
	const messageRef = useRef<HTMLTextAreaElement>(null)
	const fixedRef = useRef<HTMLDivElement>(null)
	useScrollEdges(fixedRef)
	const focusMessage = useRef(false)
	useLayoutEffect(() => {
		if (!focusMessage.current) return
		focusMessage.current = false
		const field = messageRef.current
		const fixed = fixedRef.current
		if (!field || !fixed) return
		// Keep the lead and command in view: no scroll on focus, and the choices block only shows the field's first line.
		field.focus({ preventScroll: true })
		const prompt = field.closest('.agent-dock-prompt')?.getBoundingClientRect()
		const box = fixed.getBoundingClientRect()
		if (prompt && prompt.bottom > box.bottom) fixed.scrollTop += prompt.bottom - box.bottom
	})
	const choice = choices.find(entry => entry.id === selected) ?? null
	const denying = choice?.action === 'deny'
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
		const keyed = submitKeys(event, {
			confirming: confirming !== null,
			bareEnter: true,
			cancel: () => setConfirming(null),
			submit: () => submit(),
		})
		if (keyed) return true
		const digit = digitOf(event)
		if (digit !== null) {
			const entry = choices[digit - 1]
			if (!entry) return false
			choose(entry.id)
			return true
		}
		// Letters typed at the pane are meant for somewhere else: drop the pick so a stray Enter sends nothing.
		if (isStrayKey(event)) {
			setSelected(null)
			setConfirming(null)
			return true
		}
		return false
	})
	const note = confirming ? (
		<RiskyConfirm word={confirming} what="This message" />
	) : (
		(receipt ?? blockedNote ?? choice?.ready ?? hint)
	)
	const hints = !answerable ? (
		closeHints
	) : confirming ? (
		cancelHints
	) : denying ? (
		<>
			<Hint keys={modHint(mod)}>{denyVerb}</Hint>
			<Hint keys="esc">close</Hint>
		</>
	) : (
		pickHints(choices.length, mod)
	)
	return (
		<>
			<ScrollBody label={bodyLabel}>
				{warnings}
				<div className="agent-dock-pane-body">{children}</div>
			</ScrollBody>
			{/* Choices never scroll out of a pane sized for an earlier item: only the request above them scrolls. */}
			<div ref={fixedRef} className="agent-dock-pane-fixed">
				<Choices
					rows={choices}
					picked={new Set(selected ? [selected] : [])}
					live={live}
					{...choicesLabel}
					onPick={choose}
				/>
				{denying ? (
					<label className="agent-dock-prompt">
						<span className="agent-dock-prompt-mark" aria-hidden="true">
							&gt;
						</span>
						<textarea
							ref={messageRef}
							className="agent-dock-input agent-dock-input-fit agent-dock-input-grow"
							aria-label={messageLabel}
							aria-keyshortcuts={modShortcut(mod)}
							placeholder={messagePlaceholder}
							maxLength={4096}
							rows={1}
							value={message}
							disabled={!live}
							onChange={event => {
								setMessage(event.currentTarget.value)
								setConfirming(null)
							}}
						/>
					</label>
				) : null}
			</div>
			<Footer hints={hints} note={note}>
				{ack}
				{!decidable ? null : confirming ? (
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
						tone={choice?.tone === 'danger' ? 'danger' : 'primary'}
						disabled={!live || !choice}
						busy={submitting}
						keyShortcuts={modShortcut(mod)}
						onClick={() => submit()}
					>
						{choice?.submit ?? 'Send'}
					</Key>
				)}
			</Footer>
		</>
	)
}

function PermissionPanel(panel: PanelProps) {
	const { item } = panel
	const leadId = useId()
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
				{
					id: 'once',
					label: 'Allow once',
					submit: 'Allow once',
					ready: 'Ready to allow once',
					action: { type: 'allow' },
				},
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
								ready: 'Ready to always allow',
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
			ready: 'Ready to deny',
			action: 'deny',
		},
	]
	return (
		<DecisionPanel
			panel={panel}
			choices={choices}
			bodyLabel={review.command !== null ? 'Command' : 'Tool input'}
			choicesLabel={{ labelledBy: leadId }}
			messageLabel="Message to the agent (optional)"
			messagePlaceholder="What should it do instead?"
			denyVerb="deny"
			hint={review.complete ? null : 'Allow in the terminal, or deny here'}
		>
			<p className="agent-dock-pane-lead" id={leadId}>
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
			? [
					{
						id: 'approve',
						label: 'Approve the plan',
						submit: 'Approve',
						ready: 'Ready to approve',
						action: { type: 'allow' },
					} satisfies Choice,
				]
			: []),
		{
			id: 'keep',
			label: 'Keep planning',
			description: 'say what should change',
			submit: 'Keep planning',
			ready: 'Ready to send back',
			action: 'deny',
		},
	]
	return (
		<DecisionPanel
			panel={panel}
			choices={choices}
			bodyLabel="Plan"
			choicesLabel={{ label: 'Plan decision' }}
			messageLabel="What should change? (optional)"
			messagePlaceholder="Tell the agent what to plan differently"
			denyVerb="send back"
			hint={complete ? null : 'Approve in the terminal, or keep planning here'}
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
	const {
		item,
		live,
		answerable,
		decidable,
		sent,
		mod,
		blockedNote,
		receipt,
		ack,
		warnings,
		keys,
		drafts,
		submitting,
		onAct,
		session,
	} = panel
	// A sent reply stays in its field (dimmed) under the receipt; a failure keeps it for another try.
	const [text, setText] = useDraft(drafts, `reply:${item.id}`, sent?.type === 'prompt' ? sent.text : '')
	/** The risky word the pending confirmation is about, while it asks. */
	const [confirming, setConfirming] = useState<string | null>(null)
	const replyRef = useRef<HTMLTextAreaElement>(null)
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
	useKeys(keys, event => {
		const keyed = submitKeys(event, {
			confirming: confirming !== null,
			bareEnter: false,
			cancel: () => setConfirming(null),
			submit: () => send(false),
		})
		if (keyed) return true
		// A turn has no choices: a key typed at the pane starts the reply.
		const field = replyRef.current
		if (!live || !field || !isPrintable(event)) return false
		field.focus({ preventScroll: true })
		setText(text + event.key)
		setConfirming(null)
		return true
	})
	if (item.fact.kind !== 'turn') return null
	const fact = item.fact
	const notes = [fact.hadBackground ? 'Subagents were still running.' : ''].filter(Boolean)
	const note = confirming ? <RiskyConfirm word={confirming} what="This reply" /> : (receipt ?? blockedNote ?? null)
	return (
		<>
			<ScrollBody label="Last message">
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
							ref={replyRef}
							className="agent-dock-input agent-dock-input-fit"
							aria-label="Reply"
							aria-keyshortcuts={modShortcut(mod)}
							placeholder="Reply to the agent"
							title="Typed into the agent's terminal as your next prompt"
							maxLength={16384}
							rows={1}
							value={text}
							disabled={!live}
							onChange={event => {
								setText(event.currentTarget.value)
								setConfirming(null)
							}}
						/>
					</label>
				</div>
			</ScrollBody>
			<Footer
				hints={
					!answerable ? (
						closeHints
					) : confirming ? (
						cancelHints
					) : (
						<>
							<Hint keys={modHint(mod)}>send</Hint>
							<Hint keys="esc">close</Hint>
						</>
					)
				}
				note={note}
			>
				{ack}
				{!decidable ? null : confirming ? (
					<>
						<Key tone="ghost" onClick={() => setConfirming(null)}>
							Cancel
						</Key>
						<Key tone="danger" disabled={!ready} busy={submitting} onClick={() => send(true)}>
							Send anyway
						</Key>
					</>
				) : (
					<Key
						tone="primary"
						disabled={!ready}
						busy={submitting}
						keyShortcuts={modShortcut(mod)}
						onClick={() => send(false)}
					>
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
			<Header end={<CloseKey onClose={onClose} />}>
				<span className="agent-dock-title-kind">Agents</span>
				<span className="agent-dock-title-project">
					{sessions.length} connected · {busy} busy
				</span>
			</Header>
			<ScrollBody label="Agent list">
				<div className="agent-dock-pane-body">
					<ul className="agent-dock-table" aria-label="Agents">
						{snapshot
							? sessions.map(session => {
									const who = agentWho(snapshot, session.key)
									const meta = agentRowMeta(snapshot, session)
									const since = sessionSince(snapshot, session)
									return (
										<li key={session.key} className="agent-dock-tr" data-status={session.status}>
											<span className="agent-dock-status" data-status={session.status} aria-hidden="true">
												{statusGlyph(session.status)}
											</span>
											<span className="agent-dock-td-name" title={who.title || undefined}>
												{who.name}
											</span>
											<span className="agent-dock-td-project">{who.project}</span>
											{/* A waiting agent ages on its entry's clock, so it takes its entry's tone too. */}
											<span
												className="agent-dock-td-status"
												data-status={session.status}
												data-tone={session.status === 'waiting' ? agingTone(now - since) : undefined}
											>
												{sessionStatusText(session, now, since)}
											</span>
											<span className="agent-dock-td-meta">{meta.join('  ')}</span>
										</li>
									)
								})
							: null}
					</ul>
					{recent.length > 0 ? (
						<section className="agent-dock-recent">
							<h3 className="agent-dock-subhead">Recent</h3>
							<ul className="agent-dock-table">
								{recent.map(item => {
									const who = agentWho(snapshot, item.session)
									return (
										<li key={item.id} className="agent-dock-tr agent-dock-recent-row">
											<span className="agent-dock-status" aria-hidden="true">
												{kindGlyph({ ...item, state: 'open' })}
											</span>
											<span className="agent-dock-td-name" data-dim="true" title={who.title || undefined}>
												{who.name}
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
			</ScrollBody>
			<Footer hints={closeHints} note={null} />
		</>
	)
}
