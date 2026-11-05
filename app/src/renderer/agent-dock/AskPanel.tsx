// The AskUserQuestion pane body: question tabs, numbered choices with Other… text and an
// optional preview, one explicit submit. Picks and Other text persist as a draft per item.
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { DockAction } from '../../agent-dock/model'
import {
	type ChoiceRow,
	Choices,
	Footer,
	PromptField,
	ScrollBody,
	SubmitActions,
	closeHints,
	pickHints,
	useScrollEdges,
} from './pane-chrome'
import { digitOf, isStrayKey, submitKeys, useKeys } from './pane-keys'
import type { PanelProps } from './panel'
import { type AskQuestion, askQuestions } from './presentation'

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

export function AskPanel({
	item,
	live,
	answerable,
	decidable,
	sent,
	mod,
	blockedNote,
	receipt,
	ack,
	ackHint,
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
		const on = !(otherOn[active] ?? false) || !question.multiSelect
		setOtherOn(prev => setAt(prev, active, on))
		if (!question.multiSelect) setPicks(prev => setAt(prev, active, []))
		if (on) focusOther.current = true
	}
	const otherText = (at: number) => ((otherOn[at] ?? false) ? (others[at] ?? '').trim() : '')
	const submit = () => {
		if (!live || !complete) return
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
		})
	}
	useKeys(keys, event => {
		const keyed = submitKeys(event, {
			bareEnter: true,
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
	const note =
		receipt ??
		blockedNote ??
		// Nothing to say before a pick: the disabled Submit and the `1–N pick` hint already say it.
		(complete && armed
			? 'Ready to submit'
			: questions.length > 1 && !complete
				? 'Answer every question, then submit'
				: null)
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
							<PromptField>
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
										setArmed(true)
									}}
									onKeyDown={event => {
										// ⌘Enter goes on to the pane's submit keys; bare Enter submits or moves to the next question.
										if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return
										event.preventDefault()
										event.stopPropagation()
										if (event.repeat) return
										if (complete) submit()
										else {
											const next = questions.findIndex((_, at) => !answered(at))
											if (next >= 0) showQuestion(next)
										}
									}}
								/>
							</PromptField>
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
			<Footer
				hints={
					!answerable ? (
						<>
							{ackHint}
							{closeHints}
						</>
					) : (
						pickHints(rows.length, mod, ackHint)
					)
				}
				note={note}
			>
				{ack}
				<SubmitActions
					decidable={decidable}
					disabled={!live || !complete}
					busy={submitting}
					mod={mod}
					label="Submit answers"
					onSubmit={() => submit()}
				/>
			</Footer>
		</>
	)
}
