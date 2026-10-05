import { useAnnotationState } from '@fabrika/annotations'
import type { Annotation } from '@fabrika/annotations'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import { locateReviewPassage } from '../../document-review/request'
import type {
	ReviewApi,
	ReviewDraft,
	ReviewIntent,
	ReviewPassage,
	ReviewReceipt,
	ReviewSession,
	ReviewState,
} from '../../document-review/types'
import { ActivityIndicator } from '../activity-indicator'
import { Btn, buttonClassName } from '../button'
import { ReviewMarkdown } from './ReviewMarkdown'
import { parseReviewMarkdown } from './markdown'
import type { ReviewBlock } from './markdown'
import './document-review.css'

const providerNames = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' }
interface Operation {
	id: string
	text: string
	sessionId: string
	owner: string
	revision: string
	phase: 'sending' | 'running' | 'uncertain'
}
interface Candidate {
	passage: ReviewPassage
	top: number
	left: number
}

function ChangeReview({ before, after }: { before: string; after: string }) {
	const a = before.split('\n')
	const b = after.split('\n')
	let start = 0
	while (start < a.length && start < b.length && a[start] === b[start]) start++
	let oldEnd = a.length
	let newEnd = b.length
	while (oldEnd > start && newEnd > start && a[oldEnd - 1] === b[newEnd - 1]) {
		oldEnd--
		newEnd--
	}
	const old = a.slice(Math.max(0, start - 2), Math.min(a.length, oldEnd + 2)).join('\n')
	const next = b.slice(Math.max(0, start - 2), Math.min(b.length, newEnd + 2)).join('\n')
	return (
		<section className="review-change-view" aria-label="Last observed document change">
			<h2>What changed</h2>
			<p>Compared with the last observed revision. This is not a complete edit history.</p>
			<h3>Before · source line {Math.max(1, start - 1)}</h3>
			<pre>{old.slice(0, 64000)}</pre>
			<h3>Now</h3>
			<pre>{next.slice(0, 64000)}</pre>
			{(old.length > 64000 || next.length > 64000) && (
				<output>
					This change exceeds the 64,000-character comparison limit. Read the complete current document in Source.
				</output>
			)}
		</section>
	)
}

export function DocumentReview({ api }: { api: ReviewApi }) {
	const [state, setState] = useState<ReviewState | null>(null)
	const [draft, setDraft] = useState<ReviewDraft | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [saveError, setSaveError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [receipt, setReceipt] = useState<ReviewReceipt | null>(null)
	const [recovery, setRecovery] = useState<string | null>(null)
	const [candidate, setCandidate] = useState<Candidate | null>(null)
	const [passage, setPassage] = useState<ReviewPassage | null>(null)
	const [intent, setIntent] = useState<ReviewIntent>('discuss')
	const [annotationId, setAnnotationId] = useState<string | null>(null)
	const reanchoring = useRef<string | null>(null)
	const blockedOwner = useRef(false)
	const [ownerBlocked, setOwnerBlocked] = useState(false)
	const [view, setView] = useState<'document' | 'source' | 'changes' | 'comments'>('document')
	const [pane, setPane] = useState<'document' | 'conversation'>('document')
	const [outline, setOutline] = useState(false)
	const [narrow, setNarrow] = useState(false)
	const mounted = useRef(false)
	const hydrated = useRef(false)
	const latest = useRef({ state, draft })
	latest.current = { state, draft }
	const operation = useRef<Operation | null>(null)
	const control = useRef(false)
	const editToken = useRef(0)
	const savedToken = useRef(0)
	const savedDraft = useRef<ReviewDraft | null>(null)
	const saveActive = useRef<Promise<boolean> | null>(null)
	const readSequence = useRef(0)
	const reading = useRef<HTMLDivElement>(null)
	const source = useRef<HTMLPreElement>(null)
	const documentPane = useRef<HTMLElement>(null)
	const input = useRef<HTMLTextAreaElement>(null)
	const opener = useRef<HTMLElement | null>(null)
	const anchor = useRef<{ source: string; offset: number } | null>(null)
	const model = useMemo(() => parseReviewMarkdown(state?.document.text ?? ''), [state?.document.text])
	const selected = state?.sessions.find(session => session.id === draft?.sessionId) ?? null
	const activeSession = selected?.busy === true
	const stale = !!passage && passage.revision !== state?.document.revision

	const refresh = useCallback(async () => {
		const sequence = ++readSequence.current
		const result = await api.load()
		if (!mounted.current || sequence !== readSequence.current) return
		if (result.error !== undefined) {
			setError(result.error)
			return
		}
		const before = latest.current.state?.sessions.find(session => session.id === latest.current.draft?.sessionId)
		const after = result.data.sessions.find(session => session.id === latest.current.draft?.sessionId)
		if (before && (!after || before.owner !== after.owner)) {
			blockedOwner.current = true
			setOwnerBlocked(true)
			operation.current = null
			setBusy(false)
			setRecovery(null)
			setReceipt({
				id: crypto.randomUUID(),
				outcome: 'unknown',
				detail:
					'The previous owner is unavailable. Check that conversation; no request will be routed to its replacement.',
			})
		}
		setError(
			blockedOwner.current
				? 'The conversation owner changed. Choose a conversation explicitly before continuing.'
				: null,
		)
		setState(result.data)
		if (
			!hydrated.current ||
			(!latest.current.draft?.sessionId &&
				result.data.draft.sessionId &&
				editToken.current === savedToken.current &&
				!operation.current &&
				!control.current)
		) {
			hydrated.current = true
			savedDraft.current = structuredClone(result.data.draft)
			setDraft(result.data.draft)
		}
		const pending = operation.current
		if (pending) {
			const receiptResult = await api.receipt(pending.id)
			if (!mounted.current || operation.current !== pending || sequence !== readSequence.current) return
			if (receiptResult.data) setReceipt(receiptResult.data)
			const current = result.data.sessions.find(
				session => session.id === pending.sessionId && session.owner === pending.owner,
			)
			if (pending.phase !== 'sending' && current && !current.busy) {
				if (current.error || receiptResult.data?.outcome === 'unknown') {
					pending.phase = 'uncertain'
					setRecovery(pending.text)
				} else {
					operation.current = null
					setRecovery(null)
				}
				setBusy(false)
			}
		}
	}, [api])

	const persist = useCallback(async (): Promise<boolean> => {
		if (saveActive.current) {
			await saveActive.current
			if (savedToken.current === editToken.current) return true
		}
		const value = latest.current.draft
		if (!value || savedToken.current === editToken.current) return true
		const token = editToken.current
		const promise = api
			.save(value)
			.then(result => {
				if (!mounted.current) return result.error === undefined
				if (result.error !== undefined) {
					setSaveError(result.error)
					return false
				}
				savedToken.current = token
				savedDraft.current = structuredClone(value)
				if (token === editToken.current) {
					api.dirty(false)
					setSaveError(null)
				}
				return true
			})
			.catch(() => {
				if (mounted.current) setSaveError('Drafts could not be saved. Keep this window open and retry.')
				return false
			})
		saveActive.current = promise
		const ok = await promise
		if (saveActive.current === promise) saveActive.current = null
		return ok
	}, [api])

	const changeDraft = useCallback(
		(update: (value: ReviewDraft) => ReviewDraft) => {
			const value = latest.current.draft
			if (!value) return
			const next = update(value)
			latest.current = { ...latest.current, draft: next }
			editToken.current++
			api.dirty(true)
			setDraft(next)
		},
		[api],
	)

	useEffect(() => {
		mounted.current = true
		void refresh()
		const unsubscribe = api.onChanged(() => {
			void refresh()
		})
		const close = api.onCloseRequested(() => {
			void persist().then(ok => {
				if (ok && savedToken.current === editToken.current) api.close()
			})
		})
		const media = window.matchMedia('(max-width: 900px)')
		const update = () => {
			if (media.matches && document.activeElement?.closest('.review-companion')) setPane('conversation')
			else if (media.matches && document.activeElement?.closest('.review-document-pane')) setPane('document')
			setNarrow(media.matches)
		}
		update()
		media.addEventListener('change', update)
		return () => {
			mounted.current = false
			readSequence.current++
			unsubscribe()
			close()
			media.removeEventListener('change', update)
		}
	}, [api, refresh, persist])
	useEffect(() => {
		if (!draft || savedToken.current === editToken.current) return
		const timer = setTimeout(() => {
			void persist()
		}, 300)
		return () => clearTimeout(timer)
	}, [draft, persist])

	// Stable canonical source-block anchor; never guess from repeated text or restore an unrelated offset.
	useLayoutEffect(() => {
		const owner = reading.current
		const previous = anchor.current
		if (!owner || !previous || view !== 'document') return
		const matches = model.blocks.filter(block => state?.document.text.slice(block.start, block.end) === previous.source)
		if (matches.length !== 1) return
		const target = owner.querySelector<HTMLElement>(`#${matches[0]?.id}`)
		if (target)
			owner.scrollTop += target.getBoundingClientRect().top - owner.getBoundingClientRect().top - previous.offset
	}, [state?.document.text, model, view])

	const setAnnotations: Dispatch<SetStateAction<Annotation[]>> = update =>
		changeDraft(value => {
			const current = value.annotations.map(a => ({ id: a.id, snippet: a.passage.quote, note: a.note, createdAt: '' }))
			const next = typeof update === 'function' ? update(current) : update
			return {
				...value,
				annotations: next.flatMap(a => {
					const old = value.annotations.find(old => old.id === a.id)
					return old ? [{ ...old, note: a.note }] : []
				}),
			}
		})
	const annotationState = useAnnotationState({
		annotations:
			draft?.annotations.map(a => ({ id: a.id, snippet: a.passage.quote, note: a.note, createdAt: '' })) ?? [],
		setAnnotations,
		generalNote: draft?.instruction ?? '',
		setGeneralNote: instruction => changeDraft(value => ({ ...value, instruction })),
		isReadOnly: busy,
	})

	function captureSelection(): void {
		const selection = window.getSelection()
		if (!selection || selection.isCollapsed || !selection.rangeCount || !reading.current || !state) return
		const range = selection.getRangeAt(0)
		if (!reading.current.contains(range.startContainer) || !reading.current.contains(range.endContainer)) return
		const quote = selection.toString()
		if (!quote.trim()) return
		let next: ReviewPassage | null = null
		if (view === 'source' && source.current?.contains(range.commonAncestorContainer)) {
			const prefix = range.cloneRange()
			prefix.selectNodeContents(source.current)
			prefix.setEnd(range.startContainer, range.startOffset)
			const start = prefix.toString().length
			if (quote.length <= 8000 && state.document.text.slice(start, start + quote.length) === quote)
				next = {
					revision: state.document.revision,
					start,
					end: start + quote.length,
					source: quote,
					quote,
					kind: 'exact',
				}
		} else {
			const element = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)
			const first = element(range.startContainer)?.closest<HTMLElement>('[data-source-start]')
			const last = element(range.endContainer)?.closest<HTMLElement>('[data-source-end]')
			if (first && last)
				next = locateReviewPassage(
					state.document.text,
					state.document.revision,
					Number(first.dataset.sourceStart),
					Number(last.dataset.sourceEnd),
					quote,
				)
		}
		if (!next) {
			setError('Select a smaller passage, up to 8,000 source characters. Source offers exact Markdown selection.')
			return
		}
		const rect = range.getBoundingClientRect()
		const parent = documentPane.current?.getBoundingClientRect()
		if (parent)
			setCandidate({
				passage: next,
				top: Math.max(12, Math.min(parent.height - 56, rect.bottom - parent.top + 8)),
				left: Math.max(16, Math.min(parent.width - 190, rect.left - parent.left)),
			})
	}
	function openPassage(next: ReviewPassage, nextIntent: ReviewIntent, id: string | null = null): void {
		const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
		opener.current = focused?.closest('.review-selection-actions') ? reading.current : focused
		setPassage(next)
		setIntent(nextIntent)
		setAnnotationId(id ?? reanchoring.current)
		reanchoring.current = null
		setCandidate(null)
		setPane('conversation')
		requestAnimationFrame(() => {
			if (mounted.current) input.current?.focus()
		})
	}
	function openBlock(block: ReviewBlock): void {
		if (!state) return
		const raw = state.document.text.slice(block.start, block.end)
		if (raw.length > 8000) {
			setError('This block is larger than the passage limit. Select a smaller portion in Source.')
			return
		}
		openPassage(
			{
				revision: state.document.revision,
				start: block.start,
				end: block.end,
				source: raw,
				quote: block.heading ?? raw.trim().slice(0, 400),
				kind: 'block',
			},
			'discuss',
		)
	}
	function finishPassage(): void {
		reanchoring.current = null
		setPassage(null)
		setAnnotationId(null)
		setCandidate(null)
		if (narrow) setPane('document')
		requestAnimationFrame(() => {
			if (opener.current?.isConnected && opener.current.getClientRects().length) opener.current.focus()
		})
	}
	async function switchSession(id: string | null): Promise<void> {
		if (control.current || operation.current) return
		control.current = true
		setBusy(true)
		try {
			if (!(await persist())) return
			const result = await api.selectSession(id)
			if (!mounted.current) return
			if (result.error !== undefined) {
				setError(result.error)
				return
			}
			editToken.current++
			savedToken.current = editToken.current
			savedDraft.current = structuredClone(result.data)
			setDraft(result.data)
			latest.current = { ...latest.current, draft: result.data }
			api.dirty(false)
			setReceipt(null)
			setRecovery(null)
			blockedOwner.current = false
			setOwnerBlocked(false)
			reanchoring.current = null
			setPassage(null)
			setAnnotationId(null)
		} finally {
			control.current = false
			if (mounted.current) setBusy(false)
		}
	}
	function discardUnsaved(): void {
		if (saveActive.current || control.current || busy || !savedDraft.current) return
		const previous = savedDraft.current
		if (previous.sessionId !== latest.current.draft?.sessionId) return
		const restored = structuredClone(previous)
		latest.current = { ...latest.current, draft: restored }
		editToken.current++
		savedToken.current = editToken.current
		api.dirty(false)
		setDraft(restored)
		setSaveError(null)
		finishPassage()
	}
	async function send(): Promise<void> {
		// Mutable admission, not a render-captured busy boolean: two same-task shortcuts cannot send twice.
		if (
			blockedOwner.current ||
			operation.current ||
			control.current ||
			!state ||
			!draft ||
			!selected ||
			!selected.listening ||
			selected.busy ||
			selected.error ||
			stale ||
			state.document.error ||
			!draft.instruction.trim()
		)
			return
		const pending: Operation = {
			id: crypto.randomUUID(),
			text: draft.instruction,
			sessionId: selected.id,
			owner: selected.owner,
			revision: state.document.revision,
			phase: 'sending',
		}
		operation.current = pending
		setBusy(true)
		setError(null)
		setReceipt(null)
		setRecovery(null)
		const scope = passage
		changeDraft(value => ({ ...value, instruction: '' }))
		const cleared = editToken.current
		try {
			const result = await api.send({
				id: pending.id,
				documentId: state.document.id,
				revision: pending.revision,
				sessionId: pending.sessionId,
				owner: pending.owner,
				intent,
				instruction: pending.text,
				passage: scope,
			})
			if (!mounted.current || operation.current !== pending) return
			if (result.error !== undefined) {
				operation.current = null
				setBusy(false)
				setError(result.error)
				if (editToken.current === cleared) changeDraft(value => ({ ...value, instruction: pending.text }))
				else setRecovery(pending.text)
			} else {
				pending.phase = 'running'
				setReceipt(result.data)
				await refresh()
			}
		} catch {
			if (!mounted.current || operation.current !== pending) return
			pending.phase = 'uncertain'
			setBusy(false)
			setRecovery(pending.text)
			setReceipt({
				id: pending.id,
				outcome: 'unknown',
				detail:
					'Delivery could not be confirmed. Check the provider and document before sending again; nothing is replayed.',
			})
		}
	}
	async function acknowledge(): Promise<void> {
		const pending = operation.current
		if (!selected || selected.busy || control.current || blockedOwner.current) return
		control.current = true
		setBusy(true)
		try {
			const result = await api.acknowledge(selected.id, selected.owner)
			if (!mounted.current) return
			if (result.error !== undefined) setError(result.error)
			else {
				if (!pending || operation.current === pending) operation.current = null
				setReceipt(null)
				await refresh()
			}
		} finally {
			control.current = false
			if (mounted.current) setBusy(false)
		}
	}
	function saveComment(): void {
		if (!passage || !draft?.instruction.trim() || (!annotationId && draft.annotations.length >= 64)) return
		if (annotationId) {
			annotationState.updateAnnotation(annotationId, draft.instruction)
			changeDraft(value => ({
				...value,
				annotations: value.annotations.map(annotation =>
					annotation.id === annotationId ? { ...annotation, passage, intent } : annotation,
				),
			}))
		} else
			changeDraft(value => ({
				...value,
				annotations: [
					...value.annotations,
					{ id: crypto.randomUUID(), passage, note: value.instruction, intent, resolved: false },
				],
			}))
		finishPassage()
		setView('comments')
	}
	function scrollReading(): void {
		if (!reading.current || !state || view !== 'document') return
		setCandidate(null)
		const top = reading.current.getBoundingClientRect().top
		const visible = [...reading.current.querySelectorAll<HTMLElement>('[data-source-start]')].find(
			node => node.getBoundingClientRect().bottom > top + 8,
		)
		if (visible)
			anchor.current = {
				source: state.document.text.slice(Number(visible.dataset.sourceStart), Number(visible.dataset.sourceEnd)),
				offset: visible.getBoundingClientRect().top - top,
			}
	}
	function resize(event: React.PointerEvent<HTMLDivElement>): void {
		if (!draft) return
		event.currentTarget.setPointerCapture(event.pointerId)
		const startX = event.clientX
		const startWidth = draft.paneWidth
		const target = event.currentTarget
		const move = (next: PointerEvent) =>
			changeDraft(value => ({ ...value, paneWidth: Math.max(280, Math.min(640, startWidth + startX - next.clientX)) }))
		const stop = () => {
			target.removeEventListener('pointermove', move)
			target.removeEventListener('pointerup', stop)
			target.removeEventListener('pointercancel', stop)
		}
		target.addEventListener('pointermove', move)
		target.addEventListener('pointerup', stop)
		target.addEventListener('pointercancel', stop)
	}

	if (!state || !draft)
		return (
			<main className="review-start" aria-busy={!error}>
				<h1>{error ? 'Document review unavailable' : 'Opening your document'}</h1>
				<p>{error ?? 'Reading the actual Markdown, without changing its formatting.'}</p>
				{error && (
					<Btn
						onClick={() => {
							void refresh()
						}}
					>
						Try again
					</Btn>
				)}
			</main>
		)
	const composer = (
		<div className="review-writing-surface">
			{passage && (
				<>
					<div className="review-scope-heading">
						<h3>Passage feedback</h3>
						<Btn tone="ghost" sm onClick={finishPassage}>
							Back
						</Btn>
					</div>
					{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Variable passage context must remain keyboard-scrollable without moving actions. */}
					<section className="review-passage-context" tabIndex={0} aria-label="Passage context">
						<blockquote>{passage.quote}</blockquote>
						<details className="review-scope-details">
							<summary>Selection details</summary>
							<p className="review-meta">
								{passage.kind === 'block'
									? 'Containing source block · not exact rendered offsets'
									: 'Exact Markdown source selection'}
							</p>
						</details>
						{stale && (
							<p role="alert" className="review-warning">
								This selection is stale. Select the passage again; it will not be guessed.
							</p>
						)}
					</section>
				</>
			)}
			<textarea
				ref={input}
				rows={3}
				maxLength={8000}
				aria-label={passage ? 'Passage instruction' : 'Whole-document message'}
				placeholder={passage ? 'What would you like to refine?' : 'Discuss the document or ask for a change…'}
				value={draft.instruction}
				onChange={event => annotationState.setGeneralNote(event.currentTarget.value)}
				onKeyDown={event => {
					if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
						event.preventDefault()
						void send()
					}
				}}
			/>
			<fieldset className="review-intents" aria-label="Feedback intent">
				{(['discuss', 'change'] as const).map(mode => (
					<button
						key={mode}
						type="button"
						className={buttonClassName({ tone: intent === mode ? 'quiet' : 'ghost', sm: true })}
						aria-pressed={intent === mode}
						onClick={() => setIntent(mode)}
					>
						{mode === 'discuss' ? 'Discuss' : 'Change'}
					</button>
				))}
				{!passage && <span className="review-meta">Whole document</span>}
			</fieldset>
			<div className="review-compose-actions">
				{passage && (
					<Btn
						sm
						disabled={busy || stale || !draft.instruction.trim() || (!annotationId && draft.annotations.length >= 64)}
						onClick={saveComment}
					>
						{annotationId ? 'Save comment' : 'Keep comment'}
					</Btn>
				)}
				<span />
				<Btn
					tone="primary"
					ariaLabel={intent === 'change' ? 'Send change request' : passage ? 'Send passage discussion' : 'Send message'}
					disabled={
						busy ||
						activeSession ||
						ownerBlocked ||
						!!operation.current ||
						!selected ||
						!selected.listening ||
						!!selected.error ||
						stale ||
						!!state.document.error ||
						!draft.instruction.trim()
					}
					busy={busy && operation.current?.phase === 'sending'}
					onClick={() => {
						void send()
					}}
				>
					Send
				</Btn>
			</div>
		</div>
	)
	return (
		<main
			className="document-review"
			onKeyDown={event => {
				if (event.key === 'Escape' && passage) {
					event.preventDefault()
					finishPassage()
				}
			}}
			data-review-theme={draft.theme}
			style={{ '--review-companion-width': `${draft.paneWidth}px` } as CSSProperties}
		>
			<header className="review-header">
				<div className="review-identity">
					<h1>{state.document.name}</h1>
					<span title={`${state.document.relativePath} · Revision ${state.document.revision}`}>
						{state.document.relativePath}
					</span>
				</div>
				<Btn
					tone="ghost"
					sm
					onClick={() => changeDraft(value => ({ ...value, theme: value.theme === 'dark' ? 'light' : 'dark' }))}
				>
					{draft.theme === 'dark' ? 'Light' : 'Dark'}
				</Btn>
				<Btn
					tone="ghost"
					sm
					onClick={() => {
						void persist().then(ok => {
							if (ok) api.close()
						})
					}}
				>
					Close
				</Btn>
			</header>
			<div className="review-toolbar">
				<div className="review-document-tools">
					<Btn
						tone="ghost"
						sm
						ariaExpanded={outline}
						onClick={() => {
							setOutline(!outline)
							setPane('document')
						}}
					>
						Outline
					</Btn>
					{(['document', 'source', 'changes', 'comments'] as const).map(mode => (
						<Btn
							key={mode}
							ariaCurrent={view === mode ? 'page' : undefined}
							tone={view === mode ? 'quiet' : 'ghost'}
							sm
							onClick={() => {
								setView(mode)
								setPane('document')
								setCandidate(null)
							}}
						>
							{mode === 'document'
								? 'Read'
								: mode === 'source'
									? 'Source'
									: mode === 'changes'
										? 'Changes'
										: `Comments${draft.annotations.length ? ` · ${draft.annotations.length}` : ''}`}
						</Btn>
					))}
				</div>
				{narrow && (
					<div className="review-pane-switch">
						<Btn
							ariaCurrent={pane === 'document' ? 'page' : undefined}
							tone={pane === 'document' ? 'quiet' : 'ghost'}
							sm
							onClick={() => setPane('document')}
						>
							Document
						</Btn>
						<Btn
							ariaCurrent={pane === 'conversation' ? 'page' : undefined}
							tone={pane === 'conversation' ? 'quiet' : 'ghost'}
							sm
							onClick={() => setPane('conversation')}
						>
							Conversation
						</Btn>
					</div>
				)}
			</div>
			{(error || saveError) && (
				<div className="review-banner" role="alert">
					<span>{saveError ?? error}</span>
					{saveError ? (
						<>
							<Btn
								sm
								onClick={() => {
									void persist()
								}}
							>
								Retry save
							</Btn>
							<Btn sm tone="ghost" disabled={busy} onClick={discardUnsaved}>
								Discard unsaved changes
							</Btn>
						</>
					) : (
						<Btn sm tone="ghost" onClick={() => setError(null)}>
							Dismiss
						</Btn>
					)}
				</div>
			)}
			<div className="review-split">
				<section
					ref={documentPane}
					className="review-document-pane"
					aria-label="Repository document"
					hidden={narrow && pane !== 'document'}
				>
					{outline && (
						<nav className="review-outline" aria-label="Section outline">
							{model.blocks
								.filter(block => block.heading)
								.map(block => (
									<button
										key={block.id}
										type="button"
										style={{ paddingInlineStart: `${12 + (block.depth - 1) * 12}px` }}
										onClick={() => {
											setView('document')
											requestAnimationFrame(() =>
												reading.current
													?.querySelector(`#${block.id}`)
													?.scrollIntoView({ block: 'start', behavior: 'instant' }),
											)
											if (narrow) setOutline(false)
										}}
									>
										{block.heading}
									</button>
								))}
						</nav>
					)}
					<div className="review-reading-stage">
						{state.document.error && (
							<div className="review-banner" role="alert">
								<span>{state.document.error} The last readable revision remains visible.</span>
								<Btn
									sm
									onClick={() => {
										void api.retryDocument().then(() => refresh())
									}}
								>
									Retry read
								</Btn>
							</div>
						)}
						{annotationId && !passage && (
							<output className="review-meta">
								Choose a current passage to re-anchor your comment.{' '}
								<Btn sm tone="ghost" onClick={finishPassage}>
									Cancel re-anchor
								</Btn>
							</output>
						)}
						<div
							ref={reading}
							className="review-reading"
							// biome-ignore lint/a11y/noNoninteractiveTabindex: Named scroll owner must support keyboard reading and selection.
							tabIndex={0}
							aria-label="Document reading area"
							onScroll={scrollReading}
							onPointerUp={event => {
								if (!(event.target as Element).closest('button')) captureSelection()
							}}
							onKeyUp={captureSelection}
							onKeyDown={event => {
								if (event.altKey && event.key === 'Enter' && candidate) {
									event.preventDefault()
									openPassage(candidate.passage, 'discuss')
								}
							}}
						>
							{view === 'comments' ? (
								<section className="review-comments">
									<h2>Your comments</h2>
									<p>Saved in this profile for this document and chosen conversation. Resolution is always explicit.</p>
									{!draft.annotations.length && (
										<div className="review-empty">
											<h3>Leave a thought in the margin</h3>
											<p>
												Select a passage, choose Discuss or Change, then Keep comment. Nothing is sent until you request
												it.
											</p>
										</div>
									)}
									{draft.annotations.map(annotation => (
										<article className="review-comment" key={annotation.id}>
											<div className="review-comment-meta">
												{annotation.resolved ? 'Resolved' : 'Open'} ·{' '}
												{annotation.passage.revision !== state.document.revision ? 'Anchor changed' : 'Current source'}
											</div>
											<blockquote>{annotation.passage.quote.slice(0, 600)}</blockquote>
											<p>{annotation.note}</p>
											<div className="review-comment-actions">
												{annotation.passage.revision !== state.document.revision && (
													<Btn
														sm
														tone="ghost"
														disabled={busy}
														onClick={() => {
															reanchoring.current = annotation.id
															setAnnotationId(annotation.id)
															setPassage(null)
															setCandidate(null)
															changeDraft(value => ({ ...value, instruction: annotation.note }))
															setView('document')
															setPane('document')
														}}
													>
														Re-anchor
													</Btn>
												)}
												<Btn
													sm
													tone="ghost"
													disabled={busy}
													onClick={() => {
														changeDraft(value => ({ ...value, instruction: annotation.note }))
														openPassage(annotation.passage, annotation.intent, annotation.id)
													}}
												>
													Edit / send feedback
												</Btn>
												<Btn
													sm
													tone="ghost"
													disabled={busy}
													onClick={() =>
														changeDraft(value => ({
															...value,
															annotations: value.annotations.map(a =>
																a.id === annotation.id ? { ...a, resolved: !a.resolved } : a,
															),
														}))
													}
												>
													{annotation.resolved ? 'Reopen' : 'Resolve'}
												</Btn>
												<Btn
													sm
													tone="ghost"
													disabled={busy}
													onClick={() => annotationState.removeAnnotation(annotation.id)}
												>
													Delete
												</Btn>
												{candidate && annotation.passage.revision !== state.document.revision && (
													<Btn
														sm
														onClick={() =>
															changeDraft(value => ({
																...value,
																annotations: value.annotations.map(a =>
																	a.id === annotation.id ? { ...a, passage: candidate.passage } : a,
																),
															}))
														}
													>
														Reanchor to selection
													</Btn>
												)}
											</div>
										</article>
									))}
								</section>
							) : view === 'changes' ? (
								state.document.previous !== null ? (
									<ChangeReview before={state.document.previous} after={state.document.text} />
								) : (
									<div className="review-empty">
										<h2>No observed changes yet</h2>
										<p>Edits from your agent or editor will appear here after the file changes.</p>
									</div>
								)
							) : view === 'source' || model.error ? (
								<>
									<p className="review-meta">{model.error ?? 'Exact source, never rewritten by Helm.'}</p>
									<pre ref={source} className="review-full-source">
										{state.document.text}
									</pre>
								</>
							) : (
								<article className="review-prose">
									<ReviewMarkdown
										blocks={model.blocks}
										onBlock={openBlock}
										selectedStart={passage?.revision === state.document.revision ? passage.start : null}
									/>
								</article>
							)}
						</div>
					</div>
					{candidate && !passage && (
						<fieldset
							className="review-selection-actions"
							aria-label="Selected passage actions"
							style={{ top: candidate.top, left: candidate.left }}
							onPointerDown={event => event.preventDefault()}
						>
							<Btn sm onClick={() => openPassage(candidate.passage, 'discuss')}>
								Discuss
							</Btn>
							<Btn sm onClick={() => openPassage(candidate.passage, 'change')}>
								Change
							</Btn>
						</fieldset>
					)}
				</section>
				{!narrow && (
					<div
						className="review-divider"
						role="separator"
						aria-label="Resize conversation pane"
						aria-orientation="vertical"
						aria-valuemin={280}
						aria-valuemax={640}
						aria-valuenow={draft.paneWidth}
						tabIndex={0}
						onPointerDown={resize}
						onKeyDown={event => {
							if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
								event.preventDefault()
								const width =
									event.key === 'Home'
										? 280
										: event.key === 'End'
											? 640
											: draft.paneWidth + (event.key === 'ArrowLeft' ? 20 : -20)
								changeDraft(value => ({ ...value, paneWidth: Math.max(280, Math.min(640, width)) }))
							}
						}}
					/>
				)}
				<section
					className="review-companion"
					aria-label="Review conversation"
					hidden={narrow && pane !== 'conversation'}
				>
					<header className="review-conversation-header">
						<h2 className="review-visually-hidden">Conversation</h2>
						<label>
							<span className="review-meta">Connected agent</span>
							<select
								aria-label="Choose review conversation"
								value={draft.sessionId ?? ''}
								disabled={busy || !!operation.current}
								onChange={event => {
									void switchSession(event.currentTarget.value || null)
								}}
							>
								<option value="">Choose a conversation</option>
								{state.sessions.map(session => (
									<option key={session.id} value={session.id}>
										{session.name} · {session.id.slice(-6)}
									</option>
								))}
							</select>
						</label>
						<p className="review-meta">
							{selected?.state === 'disconnected'
								? 'Disconnected'
								: selected?.listening
									? 'Listening in the original session'
									: selected?.busy
										? 'Feedback is with the original session'
										: 'No active listener'}
							{selected ? ` · ${providerNames[selected.provider]}` : ''}
						</p>
						{selected && !selected.listening && !selected.busy && (
							<p className="review-meta">
								Ask your running agent to open this document with <code>helm review open</code> and listen with{' '}
								<code>helm review wait</code>. Helm never starts another agent.
							</p>
						)}
						<details className="review-provider-details">
							<summary>Capabilities and permissions</summary>
							<p className="review-meta review-permission-note">
								Your agent keeps its original context, tools, permissions, and terminal UI. Discuss requests no edits;
								it is not a new sandbox. Interrupt the agent in its original terminal. Only feedback and explicitly
								reported replies appear here.
								{selected?.capabilities.transport === 'in-process'
									? ' The native connector dispatches into the running session.'
									: ' The CLI returns feedback to a waiting tool call in the existing conversation; it cannot inject into an idle session.'}
							</p>
						</details>
					</header>
					{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Conversation scroll owner needs keyboard access without focusing message text. */}
					<div className="review-chat" tabIndex={0} aria-label="Conversation messages">
						<Conversation session={selected} />
						{selected?.state === 'working' && (
							<output className="review-working">
								<ActivityIndicator variant="progress" label={`${providerNames[selected.provider]} is working`} />
								Working…
							</output>
						)}
						{selected?.state === 'waiting' && <output>Waiting for the connected agent’s reply…</output>}
						{selected?.error && (
							<div className="review-warning" role="alert">
								<p>{selected.error}</p>
								{!selected.busy && !ownerBlocked && selected.needsAcknowledgement && (
									<Btn
										sm
										onClick={() => {
											void acknowledge()
										}}
									>
										I checked the outcome
									</Btn>
								)}
							</div>
						)}
					</div>
					<div className="review-companion-bottom">
						{(receipt || recovery !== null) && (
							// biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded receipt scroll owner must support keyboard reading.
							<section className="review-feedback-status" tabIndex={0} aria-label="Delivery and recovery">
								{receipt && (
									// biome-ignore lint/a11y/useSemanticElements: A live receipt has structured block content; it is not a scalar form output.
									<div className="review-receipt" role="status">
										<strong>
											{receipt.outcome === 'unknown'
												? 'Outcome not confirmed'
												: receipt.outcome === 'rejected'
													? 'Not sent'
													: receipt.outcome === 'pending'
														? 'Sending feedback'
														: 'Dispatched'}
										</strong>
										<p>{receipt.detail}</p>
										{operation.current?.phase === 'uncertain' && !selected?.busy && !selected?.error && (
											<Btn
												sm
												onClick={() => {
													void acknowledge()
												}}
											>
												I checked the outcome
											</Btn>
										)}
									</div>
								)}
								{recovery !== null && (
									<div className="review-recovery">
										<p>Your request text is retained locally. Restoring it does not resend it.</p>
										<Btn
											sm
											onClick={() => {
												changeDraft(value => ({ ...value, instruction: recovery }))
												setRecovery(null)
											}}
										>
											Restore request text
										</Btn>
										<Btn sm tone="ghost" onClick={() => setRecovery(null)}>
											Discard text
										</Btn>
									</div>
								)}
							</section>
						)}
						{composer}
					</div>
				</section>
			</div>
		</main>
	)
}

function Conversation({ session }: { session: ReviewSession | null }) {
	if (!session)
		return (
			<div className="review-empty">
				<h3>A conversation beside your document</h3>
				<p>
					Ask your running Claude Code, Codex, or Pi session to connect with helm review open and listen with helm
					review wait. Passage feedback stays in that original conversation, with its existing context. Helm does not
					create a new agent session.
				</p>
			</div>
		)
	return (
		<>
			{session.historyTruncated && (
				<p className="review-meta">
					Earlier messages remain in the provider’s conversation but are outside this bounded view.
				</p>
			)}
			{session.messages.map(message => (
				<article className={`review-message review-message-${message.role}`} key={message.id}>
					<h3>
						{message.role === 'user'
							? 'You'
							: message.role === 'assistant'
								? providerNames[session.provider]
								: 'Activity'}
					</h3>
					<div>{message.text}</div>
				</article>
			))}
			{!session.messages.length && (
				<div className="review-empty">
					<h3>Ready to refine</h3>
					<p>Read, select a passage, and ask a focused question—or begin with the document as a whole.</p>
				</div>
			)}
		</>
	)
}
