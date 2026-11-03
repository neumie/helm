// Agent dock pane chrome (design §3.24): the pieces every pane body is built from — the scroll
// body with its fades, the plain header row (kind glyph, kind, context; ‹ 1/3 › and esc), key
// hints and the footer, key-style decisions, receipts, warnings and the numbered choice rows.
import { type KeyboardEvent, type ReactNode, type Ref, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { DockItem } from '../../agent-dock/model'
import { Btn, type ButtonTone } from '../button'
import { type DockModKey, modHint, modShortcut, noModifiers } from './pane-keys'
import {
	type AgentWho,
	type ReceiptView,
	askQuestions,
	entryTone,
	itemKindLabel,
	itemTimeLine,
	kindGlyph,
	plainAgentLine,
} from './presentation'

/**
 * Marks a scroll box's clipped edges for the fades (`data-more` below, `data-more-above` above) and
 * reports whether it scrolls at all.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): boolean {
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
export function ScrollBody({ label, children }: { label: string; children: ReactNode }) {
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
export function Header({ children, end, title }: { children: ReactNode; end: ReactNode; title?: string }) {
	return (
		<header className="agent-dock-title">
			<span className="agent-dock-title-text" title={title}>
				{children}
			</span>
			<span className="agent-dock-title-end">{end}</span>
		</header>
	)
}

export function CloseKey({ onClose }: { onClose(): void }) {
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

/**
 * Kind glyph: the one colored mark of a queue entry and the pane header (its kind's tone, never its
 * age), in a fixed box so names line up.
 */
export function KindGlyph({ item }: { item: DockItem }) {
	return (
		<span className="agent-dock-glyph" data-tone={entryTone(item)} aria-hidden="true">
			{kindGlyph(item)}
		</span>
	)
}

export function ItemHeader({
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
	const kind = itemKindLabel(item)
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
				<KindGlyph item={item} />
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

export function Hint({ keys, pick, children }: { keys: string; pick?: boolean; children: ReactNode }) {
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
export function Footer({ hints, note, children }: { hints: ReactNode; note: ReactNode; children?: ReactNode }) {
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

/** A footer decision: the shared button in the dock's typeface (its key is in the footer hints). */
export function Key({
	tone,
	disabled,
	busy,
	ariaLabel,
	keyShortcuts,
	title,
	onClick,
	children,
}: {
	tone: ButtonTone
	disabled?: boolean
	busy?: boolean
	ariaLabel?: string
	keyShortcuts?: string
	/** Tooltip, e.g. the key that does the same (`Ack (⌘⌫)`). */
	title?: string
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
			title={title}
			onClick={onClick}
		>
			{children}
		</Btn>
	)
}

/** The footer's submit: nothing while the item cannot be decided here; otherwise the primary key (⌘Enter). */
export function SubmitActions({
	decidable,
	disabled,
	busy,
	mod,
	tone = 'primary',
	label,
	onSubmit,
}: {
	decidable: boolean
	disabled: boolean
	busy: boolean
	mod: DockModKey
	tone?: ButtonTone
	label: string
	onSubmit(): void
}) {
	if (!decidable) return null
	return (
		<Key tone={tone} disabled={disabled} busy={busy} keyShortcuts={modShortcut(mod)} onClick={onSubmit}>
			{label}
		</Key>
	)
}

/** The `>` prompt a free-text field sits in (an Other… answer, a deny message, a reply). */
export function PromptField({ children }: { children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the field (input or textarea) is the children
		<label className="agent-dock-prompt">
			<span className="agent-dock-prompt-mark" aria-hidden="true">
				&gt;
			</span>
			{children}
		</label>
	)
}

/** A receipt, and what was sent when the pane knows it (`✓ answered · Blue, M`). */
export function Receipt({ view, detail = null }: { view: ReceiptView; detail?: string | null }) {
	return (
		<output className="agent-dock-receipt" data-tone={view.tone}>
			{view.text}
			{detail ? <span className="agent-dock-receipt-detail"> · {detail}</span> : null}
		</output>
	)
}

export function Warn({ children }: { children: ReactNode }) {
	return (
		<p className="agent-dock-warn">
			<span className="agent-dock-warn-mark" aria-hidden="true">
				!
			</span>
			<span>{children}</span>
		</p>
	)
}

export const closeHints = <Hint keys="esc">close</Hint>

/** Hints read in the order the keys act: pick, submit (send), ack, close. */
export const pickHints = (count: number, mod: DockModKey, ackHint: ReactNode = null) => (
	<>
		<Hint keys={count > 1 ? `1–${count}` : '1'} pick>
			pick
		</Hint>
		<Hint keys={modHint(mod)}>submit</Hint>
		{ackHint}
		<Hint keys="esc">close</Hint>
	</>
)

export interface ChoiceRow {
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
export function Choices({
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
	// The last focused row, per list (`keyPrefix`): another question's list starts at its own pick or first row.
	const [current, setCurrent] = useState<string | null>(null)
	const rowKey = (id: string) => `${keyPrefix}:${id}`
	const stop =
		rows.find(row => rowKey(row.id) === current)?.id ?? rows.find(row => picked.has(row.id))?.id ?? rows[0]?.id
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
						key={rowKey(row.id)}
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
							setCurrent(rowKey(row.id))
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
