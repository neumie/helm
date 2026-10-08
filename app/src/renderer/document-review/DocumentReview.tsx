import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
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
import { GLYPH, MenuButton, Sheet } from '../sidebar/ui'
import { DocumentCanvas } from './DocumentCanvas'
import type { DocumentCanvasHandle } from './DocumentCanvas'
import { ReviewMarkdown } from './ReviewMarkdown'
import { SavedAnnotationHighlights } from './SavedAnnotationHighlights'
import { annotationSaveDraft, captureAnnotationSave, removeReviewAnnotation } from './annotations'
import { captureArchiveRecovery, currentArchiveRecovery } from './archive-recovery'
import type { ArchiveRecoveryTarget, ArchiveReviewApi, ArchiveReviewState } from './archive-recovery'
import { parseReviewMarkdown } from './markdown'
import { archiveThreadStatus, projectPassageThreads } from './passage-threads'
import { validateDocumentPassage } from './passage-validation'
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
interface AnnotationWrite {
	value: string | null
	payload: ReviewDraft | null
	token: number
	documentId: string
	revision: string
	binding: string
	api: ReviewApi
	generation: number
	failed: boolean
}
interface Candidate {
	passage: ReviewPassage
	range: Range | null
	top: number
	left: number
	binding: string
	returnTo: HTMLElement | null
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

export function DocumentReview({ api }: { api: ArchiveReviewApi }) {
	const [state, setState] = useState<ArchiveReviewState | null>(null)
	const archiveFlight = useRef<object | null>(null)
	const [archiveSaving, setArchiveSaving] = useState(false)
	const [discardReply, setDiscardReply] = useState<ArchiveRecoveryTarget | null>(null)
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
	const annotationWrite = useRef<AnnotationWrite | null>(null)
	const canvasHandle = useRef<DocumentCanvasHandle | null>(null)
	const [canvasReady, setCanvasReady] = useState(false)
	const commentSave = useRef<object | null>(null)
	const [commentSaving, setCommentSaving] = useState(false)
	const lifecycle = useRef(0)
	const [commentNotice, setCommentNotice] = useState<{
		api: ReviewApi
		generation: number
		binding: string
		passage: ReviewPassage
		intent: ReviewIntent
		id: string
		token: number
		status: 'saving' | 'saved' | 'failed'
	} | null>(null)
	const reanchoring = useRef<string | null>(null)
	const blockedOwner = useRef(false)
	const [ownerBlocked, setOwnerBlocked] = useState(false)
	const [view, setView] = useState<'document' | 'source' | 'changes' | 'comments'>('document')
	const [pane, setPane] = useState<'document' | 'conversation'>('document')
	const [outline, setOutline] = useState(false)
	const [contentsStacked, setContentsStacked] = useState(true)
	const [currentHeading, setCurrentHeading] = useState<string | null>(null)
	const currentHeadingRef = useRef<string | null>(null)
	const contentsTrigger = useRef<HTMLButtonElement>(null)
	const contentsClose = useRef<HTMLButtonElement>(null)
	const contentsNav = useRef<HTMLElement>(null)
	const contentsRequest = useRef<{
		id: string | null
		focus: 'reading' | 'trigger' | 'close' | null
		expected: Element | null
		binding: string
		api: ReviewApi
		generation: number
	} | null>(null)
	const [documentDetails, setDocumentDetails] = useState(false)
	const companion = useRef<HTMLElement>(null)
	const intentTrigger = useRef<HTMLButtonElement>(null)
	const documentOptions = useRef<HTMLButtonElement>(null)
	const backToReading = useRef<HTMLButtonElement>(null)
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
	const textSelectionScope = useRef<ReviewPassage | null>(null)
	const selectionPaint = useRef<{
		passage: ReviewPassage
		range: Range
		text: string
		binding: string
		api: ReviewApi
		generation: number
		start: Node
		startOffset: number
		end: Node
		endOffset: number
	} | null>(null)
	const paintedHighlight = useRef<Highlight | null>(null)
	const source = useRef<HTMLPreElement>(null)
	const documentPane = useRef<HTMLElement>(null)
	const input = useRef<HTMLTextAreaElement>(null)
	const focusRequest = useRef<{
		target: 'editor' | 'reading'
		expected: Element | null
		binding: string
		api: ReviewApi
	} | null>(null)
	const pointerSelection = useRef<{
		id: number
		binding: string
		api: ReviewApi
		anchor: Node | null
		anchorOffset: number
		focus: Node | null
		focusOffset: number
	} | null>(null)
	const opener = useRef<HTMLElement | null>(null)
	const anchor = useRef<{ source: string; offset: number } | null>(null)
	const canvasMode = state?.document.format === 'jsx'
	const model = useMemo(
		() => (canvasMode ? { blocks: [], limited: false, error: null } : parseReviewMarkdown(state?.document.text ?? '')),
		[canvasMode, state?.document.text],
	)
	const displayBlocks = useMemo(
		() => (canvasMode ? (state?.document.canvas?.blocks ?? []) : model.blocks),
		[canvasMode, state?.document.canvas, model.blocks],
	)
	const headings = useMemo(
		() => model.blocks.filter(block => block.heading !== null && block.heading.trim() !== ''),
		[model],
	)
	const activeHeading = headings.some(block => block.id === currentHeading) ? currentHeading : (headings[0]?.id ?? null)
	const selected = state?.sessions.find(session => session.id === draft?.sessionId) ?? null
	const activeSession = selected?.busy === true
	const stale = !!passage && passage.revision !== state?.document.revision
	const selectionBinding = JSON.stringify([
		state?.document.id,
		state?.document.revision,
		draft?.sessionId,
		selected?.owner,
		ownerBlocked,
	])
	const passageThreads = useMemo(
		() =>
			state?.document.error || (narrow && pane !== 'document')
				? new Map()
				: projectPassageThreads(
						state?.document ?? null,
						ownerBlocked || state?.document.error || (narrow && pane !== 'document') ? null : selected,
						displayBlocks,
						draft?.annotations ?? [],
					),
		[state?.document, ownerBlocked, selected, displayBlocks, draft?.annotations, narrow, pane],
	)
	const currentBinding = useRef(selectionBinding)
	currentBinding.current = selectionBinding

	const refresh = useCallback(async () => {
		const sequence = ++readSequence.current
		const generation = lifecycle.current
		const result = await api.load()
		if (!mounted.current || generation !== lifecycle.current || sequence !== readSequence.current) return
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
			hydrated.current &&
			latest.current.draft &&
			!annotationWrite.current &&
			!commentSave.current &&
			!saveActive.current &&
			editToken.current === savedToken.current
		) {
			// Native owns journal-vs-private legacy projection; an empty parser archive is not migration.
			const next = { ...latest.current.draft, annotations: result.data.draft.annotations }
			latest.current = { state: result.data, draft: next }
			setDraft(next)
			if (savedDraft.current) savedDraft.current = { ...savedDraft.current, annotations: next.annotations }
		}
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

	const persist = useCallback(
		async (retryAnnotation = false): Promise<boolean> => {
			if (saveActive.current) {
				await saveActive.current
				if (savedToken.current === editToken.current && !annotationWrite.current) return true
			}
			const currentDraft = latest.current.draft
			const write = annotationWrite.current
			if (!currentDraft || (savedToken.current === editToken.current && !write)) return true
			if (write) {
				if (write.failed && !retryAnnotation) return false
				if (
					write.api !== api ||
					write.generation !== lifecycle.current ||
					write.binding !== currentBinding.current ||
					write.documentId !== latest.current.state?.document.id ||
					write.revision !== latest.current.state.document.revision
				) {
					setSaveError(
						'This unsaved comment belongs to an earlier document or conversation. Discard it deliberately; nothing was moved.',
					)
					return false
				}
				if (!write.payload) {
					write.payload = captureAnnotationSave(currentDraft, write.value)
					write.token = editToken.current
				}
			}
			const value = write?.payload ?? annotationSaveDraft(currentDraft)
			const token = write?.token ?? editToken.current
			const generation = lifecycle.current
			const promise = api
				.save(value)
				.then(result => {
					if (!mounted.current || generation !== lifecycle.current) return false
					if (result.error !== undefined) {
						if (write) write.failed = true
						setSaveError(result.error)
						return false
					}
					savedToken.current = token
					if (annotationWrite.current === write) annotationWrite.current = null
					if (write) setSaveError(null)
					savedDraft.current = structuredClone(value)
					if (token === editToken.current) {
						api.dirty(false)
						setSaveError(null)
					}
					if (write) void refresh()
					return true
				})
				.catch(() => {
					if (write) write.failed = true
					if (mounted.current && generation === lifecycle.current)
						setSaveError('Drafts could not be saved. Keep this window open and retry.')
					return false
				})
			saveActive.current = promise
			const ok = await promise
			if (saveActive.current === promise) saveActive.current = null
			return ok
		},
		[api, refresh],
	)

	const changeDraft = useCallback(
		(update: (value: ReviewDraft) => ReviewDraft) => {
			const value = latest.current.draft
			if (!value) return
			const next = annotationSaveDraft(update(value))
			latest.current = { ...latest.current, draft: next }
			editToken.current++
			api.dirty(true)
			setDraft(next)
		},
		[api],
	)

	useEffect(() => {
		lifecycle.current++
		mounted.current = true
		archiveFlight.current = null
		setArchiveSaving(false)
		setDiscardReply(null)
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
		const clearPointer = () => {
			pointerSelection.current = null
		}
		document.addEventListener('pointerdown', clearPointer, true)
		document.addEventListener('pointerup', clearPointer)
		document.addEventListener('pointercancel', clearPointer)
		window.addEventListener('blur', clearPointer)
		return () => {
			lifecycle.current++
			mounted.current = false
			focusRequest.current = null
			contentsRequest.current = null
			pointerSelection.current = null
			readSequence.current++
			unsubscribe()
			close()
			media.removeEventListener('change', update)
			document.removeEventListener('pointerdown', clearPointer, true)
			document.removeEventListener('pointerup', clearPointer)
			document.removeEventListener('pointercancel', clearPointer)
			window.removeEventListener('blur', clearPointer)
		}
	}, [api, refresh, persist])
	useLayoutEffect(() => {
		if (!state?.document.id) return
		const element = documentPane.current
		if (!element) return
		const measure = () => {
			const width = element.getBoundingClientRect().width
			// A 240px rail leaves at least 480px prose plus the existing reading gutters.
			if (width > 0) setContentsStacked(width < 792)
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	}, [state?.document.id])
	useEffect(() => {
		if (!outline) return
		const onContentsEscape = (event: KeyboardEvent) => {
			if (
				event.key !== 'Escape' ||
				!(contentsNav.current?.contains(document.activeElement) || document.activeElement === contentsTrigger.current)
			)
				return
			event.preventDefault()
			event.stopPropagation()
			contentsRequest.current = {
				id: null,
				focus: 'trigger',
				expected: document.activeElement,
				binding: selectionBinding,
				api,
				generation: lifecycle.current,
			}
			setOutline(false)
		}
		document.addEventListener('keydown', onContentsEscape, true)
		return () => {
			document.removeEventListener('keydown', onContentsEscape, true)
		}
	}, [outline, selectionBinding, api])
	useEffect(() => {
		if (!draft || savedToken.current === editToken.current) return
		const timer = setTimeout(() => {
			void persist()
		}, 300)
		return () => clearTimeout(timer)
	}, [draft, persist])

	// biome-ignore lint/correctness/useExhaustiveDependencies: Identity changes intentionally invalidate candidate and pointer ownership before the next gesture.
	useLayoutEffect(() => {
		setCandidate(null)
		pointerSelection.current = null
		contentsRequest.current = null
	}, [selectionBinding, api])
	useLayoutEffect(() => {
		if (discardReply && !currentArchiveRecovery(discardReply, state, api, lifecycle.current)) setDiscardReply(null)
	}, [discardReply, state, api])
	// Focus belongs to the triggering commit, never a delayed animation-frame callback.
	useLayoutEffect(() => {
		const request = focusRequest.current
		focusRequest.current = null
		if (!request || !mounted.current || request.api !== api || request.binding !== currentBinding.current) return
		const focused = document.activeElement
		if (focused !== request.expected && !(focused === document.body && !request.expected?.getClientRects().length))
			return
		const target =
			request.target === 'editor'
				? input.current
				: opener.current?.isConnected && opener.current.getClientRects().length
					? opener.current
					: reading.current
		if (target?.isConnected && target.getClientRects().length) target.focus()
	})
	// Display-only DOM selection. Never derive source offsets or search repeated prose for its location.
	useLayoutEffect(() => {
		const previous = paintedHighlight.current
		if (previous && CSS.highlights?.get('helm-review-selection') === previous)
			CSS.highlights.delete('helm-review-selection')
		paintedHighlight.current = null
		const paint = selectionPaint.current
		if (
			!paint ||
			!CSS.highlights ||
			typeof Highlight === 'undefined' ||
			paint.passage !== passage ||
			paint.api !== api ||
			paint.generation !== lifecycle.current ||
			paint.binding !== selectionBinding ||
			!paint.start.isConnected ||
			!paint.end.isConnected ||
			!reading.current?.contains(paint.start) ||
			!reading.current.contains(paint.end) ||
			paint.range.startContainer !== paint.start ||
			paint.range.endContainer !== paint.end ||
			paint.range.startOffset !== paint.startOffset ||
			paint.range.endOffset !== paint.endOffset ||
			paint.range.collapsed ||
			paint.range.toString() !== paint.text
		) {
			selectionPaint.current = null
			return
		}
		const highlight = new Highlight(paint.range)
		CSS.highlights.set('helm-review-selection', highlight)
		paintedHighlight.current = highlight
	})
	// biome-ignore lint/correctness/useExhaustiveDependencies: API replacement retires this instance's DOM-range ownership before the next commit.
	useLayoutEffect(() => {
		return () => {
			const highlight = paintedHighlight.current
			if (highlight && CSS.highlights?.get('helm-review-selection') === highlight)
				CSS.highlights.delete('helm-review-selection')
			paintedHighlight.current = null
			selectionPaint.current = null
		}
	}, [api])

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
	// biome-ignore lint/correctness/useExhaustiveDependencies: Re-observe canonical reading position only when rendered source/view/destination changes, not each draft edit.
	useLayoutEffect(() => {
		scrollReading()
	}, [model, view, pane])
	// Commit-owned navigation: no unfenced RAF, source guessing or late focus.
	useLayoutEffect(() => {
		const request = contentsRequest.current
		contentsRequest.current = null
		if (
			!request ||
			!mounted.current ||
			request.api !== api ||
			request.binding !== currentBinding.current ||
			request.generation !== lifecycle.current
		)
			return
		const focused = document.activeElement
		if (focused !== request.expected && !(focused === document.body && !request.expected?.getClientRects().length))
			return
		if (request.id) {
			const owner = reading.current
			if (!owner?.getClientRects().length || view !== 'document' || !headings.some(block => block.id === request.id))
				return
			owner
				.querySelector<HTMLElement>(`#${CSS.escape(request.id)}`)
				?.scrollIntoView({ block: 'start', behavior: 'instant' })
			currentHeadingRef.current = request.id
			setCurrentHeading(request.id)
		}
		const target =
			request.focus === 'reading'
				? reading.current
				: request.focus === 'trigger'
					? contentsTrigger.current
					: request.focus === 'close'
						? contentsClose.current
						: null
		if (target?.isConnected && target.getClientRects().length) target.focus()
	})

	function captureAnnotationWrite(): boolean {
		if (!state || annotationWrite.current?.failed) return false
		annotationWrite.current = annotationWrite.current ?? {
			value: state.document.archive?.revision ?? null,
			payload: null,
			token: 0,
			documentId: state.document.id,
			revision: state.document.revision,
			binding: selectionBinding,
			api,
			generation: lifecycle.current,
			failed: false,
		}
		return true
	}
	function changeAnnotations(update: (value: ReviewDraft) => ReviewDraft): void {
		if (selectionLocked() || commentSave.current || !captureAnnotationWrite()) return
		changeDraft(update)
	}

	function validateCurrentPassage(value: ReviewPassage): void {
		if (!state) throw new Error('Document unavailable')
		validateDocumentPassage(state.document, value)
	}
	function captureSelection(pointer = false): void {
		const selection = window.getSelection()
		setCandidate(null)
		if (
			!selection ||
			selection.isCollapsed ||
			!selection.rangeCount ||
			!reading.current ||
			!state ||
			(view !== 'document' && view !== 'source')
		)
			return
		const range = selection.getRangeAt(0)
		if (!reading.current.contains(range.startContainer) || !reading.current.contains(range.endContainer)) return
		const endpointElement = (node: Node) =>
			node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
		if (
			endpointElement(range.startContainer)?.closest('.review-passage-comments') ||
			endpointElement(range.endContainer)?.closest('.review-passage-comments')
		)
			return
		const quote = selection.toString()
		if (!quote.trim()) return
		let next: ReviewPassage | null = null
		if (source.current?.contains(range.commonAncestorContainer)) {
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
			if (first && last && (!canvasMode || (first === last && first.dataset.canvasId)))
				next = locateReviewPassage(
					state.document.text,
					state.document.revision,
					Number(first.dataset.sourceStart),
					Number(last.dataset.sourceEnd),
					quote,
				)
		}
		if (next && canvasMode && view === 'document') {
			const element = endpointElement(range.startContainer)?.closest<HTMLElement>('[data-canvas-id]')
			const block = state.document.canvas?.blocks.find(
				block => block.id === element?.dataset.canvasId && block.start === next?.start && block.end === next?.end,
			)
			next = block ? { ...next, canvasId: block.id } : null
		}
		try {
			if (next) validateCurrentPassage(next)
		} catch {
			next = null
		}
		if (!next) {
			setError('Select one source block, up to 8,000 characters. Source offers exact selection.')
			return
		}
		const rect = range.getBoundingClientRect()
		const parent = documentPane.current?.getBoundingClientRect()
		if (pointer && !annotationId && !reanchoring.current && !selectionLocked()) {
			openPassage(next, intent, null, reading.current, false, range.cloneRange())
			return
		}
		if (parent)
			setCandidate({
				passage: next,
				range: range.cloneRange(),
				top: Math.max(12, Math.min(parent.height - 56, rect.bottom - parent.top + 8)),
				left: Math.max(16, Math.min(parent.width - 190, rect.left - parent.left)),
				binding: selectionBinding,
				returnTo: reading.current,
			})
	}
	function selectionLocked(): boolean {
		return !!(
			operation.current ||
			control.current ||
			commentSave.current ||
			(annotationWrite.current && saveActive.current) ||
			annotationWrite.current?.failed ||
			busy ||
			selected?.busy ||
			blockedOwner.current ||
			state?.document.error
		)
	}
	function openPassage(
		next: ReviewPassage,
		nextIntent: ReviewIntent,
		id: string | null = null,
		returnTo?: HTMLElement | null,
		editSaved = false,
		visualRange: Range | null = null,
	): boolean {
		if (!state || selectionLocked()) return false
		const saved = editSaved ? latest.current.draft?.annotations.find(annotation => annotation.id === id) : null
		// Only explicit editing of this exact saved annotation may display its old locator.
		// Stale scope stays visible; Send and Save remain fenced until explicit re-anchor.
		const savedStale =
			saved?.passage === next && saved.intent === nextIntent && next.revision !== state.document.revision
		if (!savedStale) {
			try {
				validateCurrentPassage(next)
			} catch {
				return false
			}
		}
		const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
		opener.current = returnTo ?? (focused?.closest('.review-selection-actions') ? reading.current : focused)
		focusRequest.current = { target: 'editor', expected: focused, binding: selectionBinding, api }
		textSelectionScope.current = visualRange ? next : null
		selectionPaint.current = visualRange
			? {
					passage: next,
					range: visualRange,
					text: visualRange.toString(),
					binding: selectionBinding,
					api,
					generation: lifecycle.current,
					start: visualRange.startContainer,
					startOffset: visualRange.startOffset,
					end: visualRange.endContainer,
					endOffset: visualRange.endOffset,
				}
			: null
		setPassage(next)
		setIntent(nextIntent)
		setAnnotationId(id ?? reanchoring.current)
		reanchoring.current = null
		setCandidate(null)
		setPane('conversation')
		return true
	}
	function useSelection(): void {
		if (!candidate || candidate.binding !== selectionBinding || selectionLocked()) return
		const reanchor = reanchoring.current ? draft?.annotations.find(a => a.id === reanchoring.current) : null
		openPassage(candidate.passage, reanchor?.intent ?? intent, annotationId, candidate.returnTo, false, candidate.range)
	}
	function finishPassage(): void {
		focusRequest.current = { target: 'reading', expected: document.activeElement, binding: selectionBinding, api }
		reanchoring.current = null
		setPassage(null)
		setAnnotationId(null)
		setCandidate(null)
		if (narrow) setPane('document')
	}
	function returnToDocument(): void {
		if (view === 'comments') {
			setView('document')
			opener.current = reading.current
		}
		focusRequest.current = { target: 'reading', expected: document.activeElement, binding: selectionBinding, api }
		setCandidate(null)
		setPane('document')
	}
	async function recoverArchive(target: ArchiveRecoveryTarget, discard = false): Promise<void> {
		if (
			archiveFlight.current ||
			!mounted.current ||
			!currentArchiveRecovery(target, latest.current.state, api, lifecycle.current) ||
			(discard && (!target.id || !api.discardArchive))
		)
			return
		const flight = {}
		archiveFlight.current = flight
		setArchiveSaving(true)
		try {
			const result =
				discard && target.id && api.discardArchive ? await api.discardArchive(target.id) : await api.retryDocument()
			if (
				!mounted.current ||
				archiveFlight.current !== flight ||
				target.api !== api ||
				target.generation !== lifecycle.current
			)
				return
			if (
				currentArchiveRecovery(target, latest.current.state, api, lifecycle.current) &&
				(result.error || result.data !== true)
			)
				setError(result.error ?? 'Review save recovery was not confirmed. Keep the reply and retry.')
			if (
				result.data === true &&
				latest.current.state?.document.id === target.documentId &&
				latest.current.state.document.revision === target.revision
			) {
				setDiscardReply(null)
				void refresh()
			}
		} catch {
			if (mounted.current && currentArchiveRecovery(target, latest.current.state, api, lifecycle.current))
				setError('Review save recovery was not confirmed. Keep the reply and check this window before trying again.')
		} finally {
			if (archiveFlight.current === flight) {
				archiveFlight.current = null
				if (mounted.current && target.generation === lifecycle.current) setArchiveSaving(false)
			}
		}
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
		if (
			annotationWrite.current &&
			!window.confirm('Discard unsaved local comment changes? This does not change the document or send feedback.')
		)
			return
		annotationWrite.current = null
		const restored = structuredClone(previous)
		if (state?.document.archive) restored.annotations = structuredClone(state.document.archive.annotations)
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
			commentSave.current ||
			annotationWrite.current ||
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
		const fields = canvasMode ? canvasHandle.current?.read(state.document.id, state.document.revision, api) : undefined
		if (canvasMode && !fields) return
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
				...(canvasMode ? { canvasFields: fields ?? [] } : {}),
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
	async function saveComment(): Promise<void> {
		const current = latest.current.draft
		if (
			commentSave.current ||
			selectionLocked() ||
			stale ||
			!passage ||
			!current?.instruction.trim() ||
			(annotationId && !current.annotations.some(annotation => annotation.id === annotationId)) ||
			(!annotationId && current.annotations.length >= 256)
		)
			return
		if (!captureAnnotationWrite()) return
		const flight = {}
		commentSave.current = flight
		setCommentSaving(true)
		const id = annotationId ?? crypto.randomUUID()
		const generation = lifecycle.current
		changeDraft(value => ({
			...value,
			annotations: annotationId
				? value.annotations.map(annotation =>
						annotation.id === id ? { ...annotation, passage, intent, note: value.instruction } : annotation,
					)
				: [...value.annotations, { id, passage, note: value.instruction, intent, resolved: false }],
		}))
		setAnnotationId(id)
		const notice = {
			api,
			generation,
			binding: selectionBinding,
			passage,
			intent,
			id,
			token: editToken.current,
			status: 'saving' as const,
		}
		setCommentNotice(notice)
		try {
			const ok = await persist()
			if (
				mounted.current &&
				generation === lifecycle.current &&
				notice.binding === currentBinding.current &&
				notice.token === editToken.current
			)
				setCommentNotice({ ...notice, status: ok && savedToken.current >= notice.token ? 'saved' : 'failed' })
		} finally {
			if (commentSave.current === flight) {
				commentSave.current = null
				if (mounted.current) setCommentSaving(false)
			}
		}
	}
	function clearPassage(): void {
		if (selectionLocked() || commentSave.current) return
		reanchoring.current = null
		setPassage(null)
		setAnnotationId(null)
		setCandidate(null)
		setCommentNotice(null)
	}
	function scrollReading(): void {
		if (!reading.current?.getClientRects().length || !state || view !== 'document') return
		setCandidate(null)
		const top = reading.current.getBoundingClientRect().top
		const visible = [...reading.current.querySelectorAll<HTMLElement>('[data-source-start]')].find(
			node => node.getBoundingClientRect().bottom > top + 8,
		)
		if (visible) {
			anchor.current = {
				source: state.document.text.slice(Number(visible.dataset.sourceStart), Number(visible.dataset.sourceEnd)),
				offset: visible.getBoundingClientRect().top - top,
			}
			let headingIndex = 0
			for (const [index, heading] of headings.entries()) {
				if (heading.start > Number(visible.dataset.sourceStart)) break
				headingIndex = index
			}
			let next = headings[headingIndex]?.id ?? null
			const following = headings[headingIndex + 1]
			const followingNode = following
				? reading.current.querySelector<HTMLElement>(`#${CSS.escape(following.id)}`)
				: null
			// A section jump leaves the previous paragraph's sliver above the heading.
			// Keep the canonical anchor intact; inspect only the next heading at its scroll inset.
			if (followingNode) {
				const inset =
					Number.parseFloat(getComputedStyle(reading.current).scrollPaddingTop) +
					Number.parseFloat(getComputedStyle(followingNode).scrollMarginTop)
				if (followingNode.getBoundingClientRect().top <= top + inset + 1) next = following?.id ?? next
			}
			if (currentHeadingRef.current !== next || currentHeading !== next) {
				currentHeadingRef.current = next
				setCurrentHeading(next)
			}
		}
	}
	function closeContents(): void {
		const focused = document.activeElement
		contentsRequest.current = {
			id: null,
			focus: contentsNav.current?.contains(focused) || focused === contentsTrigger.current ? 'trigger' : null,
			expected: focused,
			binding: selectionBinding,
			api,
			generation: lifecycle.current,
		}
		setOutline(false)
	}
	function navigateHeading(id: string): void {
		if (!mounted.current || selectionBinding !== currentBinding.current || !headings.some(block => block.id === id))
			return
		const expected = document.activeElement
		const request = {
			id,
			focus: contentsStacked ? ('reading' as const) : null,
			expected,
			binding: selectionBinding,
			api,
			generation: lifecycle.current,
		}
		const owner = reading.current
		if (view === 'document' && owner?.getClientRects().length) {
			// Already-rendered navigation settles now, including an already-current section.
			owner.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start', behavior: 'instant' })
			currentHeadingRef.current = id
			setCurrentHeading(id)
			contentsRequest.current = contentsStacked ? { ...request, id: null } : null
		} else contentsRequest.current = request
		setView('document')
		setPane('document')
		setCandidate(null)
		if (contentsStacked) setOutline(false)
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
	const showConversationChooser = state.sessions.length > 1 || ownerBlocked || (!selected && state.sessions.length > 0)
	const localNotice =
		commentNotice &&
		commentNotice.api === api &&
		commentNotice.generation === lifecycle.current &&
		commentNotice.binding === selectionBinding &&
		commentNotice.passage === passage &&
		commentNotice.intent === intent &&
		commentNotice.id === annotationId &&
		commentNotice.token === editToken.current
			? {
					...commentNotice,
					status: savedToken.current >= commentNotice.token ? ('saved' as const) : commentNotice.status,
				}
			: null
	const blockedReason = !draft.instruction.trim()
		? null
		: stale
			? 'This selection is stale. Select the passage again; it will not be guessed.'
			: canvasMode && !canvasReady
				? 'Wait for the document canvas to settle, or read Source.'
				: state.document.error
					? 'Document unavailable. Retry opening it before sending.'
					: ownerBlocked
						? 'Choose a conversation again before sending.'
						: operation.current?.phase === 'uncertain'
							? 'Check the outcome in your conversation before sending again. Nothing is replayed.'
							: operation.current || busy || activeSession
								? 'Wait for the current request to settle before sending.'
								: !selected
									? 'Connect an existing conversation before sending.'
									: selected.error
										? 'Check the conversation outcome before sending.'
										: !selected.listening
											? 'Feedback paused. Keep this draft until the conversation is listening.'
											: null
	const composer = (
		<div className="review-writing-surface">
			<textarea
				ref={input}
				rows={3}
				maxLength={8000}
				aria-label={passage ? 'Passage instruction' : 'Whole-document message'}
				placeholder={passage ? 'Write about this passage…' : 'Ask about this document…'}
				value={draft.instruction}
				onChange={event => {
					const instruction = event.currentTarget.value
					changeDraft(value => ({ ...value, instruction }))
				}}
				onKeyDown={event => {
					if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
						event.preventDefault()
						void send()
					}
				}}
			/>
			{(stale || blockedReason || localNotice) && (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: Compact composer guidance keeps its own bounded keyboard scroll region.
				<div className="review-compose-status" tabIndex={0} aria-label="Writing status">
					{(stale || blockedReason) && (
						<p role={stale ? 'alert' : undefined}>
							{blockedReason ?? 'This selection is stale. Select the passage again; it will not be guessed.'}
						</p>
					)}
					{localNotice && (
						<output>
							{localNotice.status === 'saved'
								? 'Saved locally · not sent'
								: localNotice.status === 'saving'
									? 'Saving local comment…'
									: 'Comment not saved. Retry save.'}
						</output>
					)}
				</div>
			)}
			<div className="review-compose-actions">
				<div className="review-compose-more">
					<MenuButton
						trigger={GLYPH.ellipsis}
						triggerLabel="Writing options"
						triggerClass={buttonClassName({ tone: 'ghost', sm: true })}
						align="start"
						entries={[
							...(passage
								? [
										{
											label: annotationId ? 'Save comment changes' : 'Save local comment',
											section: 'Local only · not sent',
											disabled:
												selectionLocked() ||
												commentSaving ||
												stale ||
												!draft.instruction.trim() ||
												(annotationId
													? !draft.annotations.some(annotation => annotation.id === annotationId)
													: draft.annotations.length >= 256),
											onSelect: () => {
												void saveComment()
											},
										},
										{ label: 'Return to document', onSelect: returnToDocument },
										{
											label: 'Clear passage',
											group: true,
											meta: 'Whole document',
											disabled: selectionLocked() || commentSaving,
											onSelect: clearPassage,
										},
									]
								: [{ label: 'Return to document', onSelect: returnToDocument }]),
						]}
					/>
				</div>
				<fieldset className="review-intents" aria-label="Feedback intent">
					<MenuButton
						trigger={
							<>
								{intent === 'discuss' ? 'Ask' : 'Request change'}
								{GLYPH.chevronDown}
							</>
						}
						triggerLabel={`Feedback intent: ${intent === 'discuss' ? 'Ask' : 'Request change'}`}
						triggerRef={intentTrigger}
						triggerClass={buttonClassName({ tone: 'ghost', sm: true })}
						disabled={busy || !!operation.current || !!control.current}
						align="start"
						entries={(['discuss', 'change'] as const).map(mode => ({
							label: mode === 'discuss' ? 'Ask' : 'Request change',
							meta: mode === 'discuss' ? 'No edits requested' : 'Edits requested',
							checked: intent === mode,
							onSelect: () => setIntent(mode),
						}))}
					/>
				</fieldset>
				<Btn
					tone={draft.instruction.trim() ? 'primary' : 'quiet'}
					sm
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
						(canvasMode && !canvasReady) ||
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
				if (event.key === 'Escape' && event.currentTarget.querySelector('.review-passage-bubble:popover-open')) return
				if (event.key === 'Escape' && passage) {
					event.preventDefault()
					returnToDocument()
				}
			}}
			data-review-theme={draft.theme}
			data-text-selection={passage !== null && textSelectionScope.current === passage}
			style={{ '--review-companion-width': `${draft.paneWidth}px` } as CSSProperties}
		>
			<header className="review-header">
				<div className="review-identity">
					<h1>{state.document.name}</h1>
				</div>
				<div className="review-header-controls">
					<Btn
						ref={contentsTrigger}
						tone="ghost"
						sm
						ariaLabel="Contents"
						ariaExpanded={outline}
						ariaControls="review-contents"
						onClick={() => {
							if (outline) closeContents()
							else {
								contentsRequest.current = {
									id: null,
									focus: 'close',
									expected: document.activeElement,
									binding: selectionBinding,
									api,
									generation: lifecycle.current,
								}
								setOutline(true)
								setPane('document')
							}
						}}
					>
						{GLYPH.menu}
						<span>Contents</span>
					</Btn>
					<MenuButton
						trigger={GLYPH.ellipsis}
						triggerLabel="Document options"
						triggerRef={documentOptions}
						triggerClass={buttonClassName({ tone: 'ghost', sm: true })}
						align="end"
						entries={[
							...(['document', 'source', 'changes', 'comments'] as const).map((mode, index) => ({
								label:
									mode === 'document'
										? 'Read'
										: mode === 'source'
											? 'Source'
											: mode === 'changes'
												? 'Changes'
												: 'Comments',
								section: index === 0 ? 'Document' : undefined,
								checked: view === mode,
								meta: mode === 'comments' && draft.annotations.length ? draft.annotations.length : undefined,
								onSelect: () => {
									setView(mode)
									setPane('document')
									setCandidate(null)
								},
							})),
							{
								label: 'Document details',
								section: 'Details and appearance',
								checked: documentDetails,
								checkedRole: 'checkbox',
								onSelect: () => setDocumentDetails(!documentDetails),
							},
							{
								label: draft.theme === 'dark' ? 'Light reading surface' : 'Dark reading surface',
								onSelect: () => changeDraft(value => ({ ...value, theme: value.theme === 'dark' ? 'light' : 'dark' })),
							},
						]}
					/>
				</div>
			</header>
			{(narrow || view !== 'document') && (
				<div className="review-toolbar">
					<div className="review-document-tools">
						{view !== 'document' && (
							<>
								<span className="review-active-view">
									{view === 'source' ? 'Source' : view === 'changes' ? 'Changes' : 'Comments'}
								</span>
								<Btn
									ref={backToReading}
									tone="ghost"
									sm
									onClick={() => {
										if (document.activeElement === backToReading.current) documentOptions.current?.focus()
										setView('document')
										setPane('document')
										setCandidate(null)
									}}
								>
									Back to reading
								</Btn>
							</>
						)}
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
			)}
			{documentDetails && (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded document metadata must support keyboard scrolling.
				<section className="review-document-details" aria-label="Document details" tabIndex={0}>
					<div>
						<h2>Document details</h2>
						<Btn
							tone="ghost"
							sm
							onClick={() => {
								setDocumentDetails(false)
								documentOptions.current?.focus()
							}}
						>
							Hide details
						</Btn>
					</div>
					<p>{state.document.relativePath}</p>
					<p>
						Revision <code>{state.document.revision}</code>
					</p>
					<p className="review-permission-note">
						Discuss requests no edits, but is not a new sandbox. Your agent keeps its permissions; handle approvals and
						Stop in its terminal. Feedback is delivered only while it is listening.
					</p>
				</section>
			)}
			{state.archiveError && (
				<div className="review-banner" role="alert">
					<span>{state.archiveError} Nothing will be resent.</span>
					<Btn
						sm
						disabled={archiveSaving}
						onClick={() => {
							const target = captureArchiveRecovery(latest.current.state, api, lifecycle.current)
							if (target) void recoverArchive(target)
						}}
					>
						Retry review save
					</Btn>
					{state.archiveFailureId && api.discardArchive && (
						<Btn
							sm
							tone="ghost"
							disabled={archiveSaving}
							onClick={() => {
								const target = captureArchiveRecovery(latest.current.state, api, lifecycle.current)
								if (target?.id && !archiveFlight.current) setDiscardReply(target)
							}}
						>
							Discard unsaved reply
						</Btn>
					)}
				</div>
			)}
			{(error || saveError) && (
				<div className="review-banner" role="alert">
					<span>{saveError ?? error}</span>
					{saveError ? (
						<>
							<Btn
								sm
								onClick={() => {
									void persist(annotationWrite.current?.failed === true)
								}}
							>
								{annotationWrite.current ? 'Retry comment save' : 'Retry save'}
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
			{discardReply && currentArchiveRecovery(discardReply, state, api, lifecycle.current) && (
				<DiscardReplyConfirmation
					busy={archiveSaving}
					onKeep={() => {
						if (!archiveFlight.current) setDiscardReply(null)
					}}
					onDiscard={() => {
						void recoverArchive(discardReply, true)
					}}
				/>
			)}
			<div className="review-split">
				<section
					ref={documentPane}
					className="review-document-pane"
					data-contents-stacked={contentsStacked}
					aria-label="Repository document"
					hidden={narrow && pane !== 'document'}
				>
					{outline && (
						<nav ref={contentsNav} id="review-contents" className="review-contents" aria-label="Contents">
							<div className="review-contents-header">
								<h2>Contents</h2>
								<Btn ref={contentsClose} tone="ghost" sm ariaLabel="Close contents" onClick={closeContents}>
									{GLYPH.close}
								</Btn>
							</div>
							<div className="review-contents-list">
								{headings.length ? (
									headings.map(block => (
										<button
											key={block.id}
											type="button"
											className={buttonClassName({ tone: 'ghost', sm: true, className: 'review-contents-link' })}
											title={block.heading ?? ''}
											aria-label={block.heading ?? ''}
											data-level={block.depth}
											aria-current={view === 'document' && activeHeading === block.id ? 'location' : undefined}
											style={{ paddingInlineStart: `${12 + Math.min(4, block.depth - 1) * 8}px` }}
											onClick={() => navigateHeading(block.id)}
										>
											<span>{block.heading}</span>
										</button>
									))
								) : (
									<p className="review-contents-empty">No headings in this document.</p>
								)}
							</div>
						</nav>
					)}
					<div className="review-reading-stage">
						{[...passageThreads.values()].some(threads => threads.length > 80) && (
							<p className="review-meta">
								Some saved passage markers exceed this view’s display limit. Read Comments or saved review history; no
								saved content was removed.
							</p>
						)}
						{state.document.error && (
							<div className="review-banner" role="alert">
								<span>
									{state.document.error}{' '}
									{state.document.text
										? 'The last readable revision remains visible.'
										: 'Document source is unavailable.'}
								</span>
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
							onPointerDown={event => {
								pointerSelection.current = null
								if (
									!event.isTrusted ||
									!event.isPrimary ||
									event.button !== 0 ||
									(event.target as Element).closest('button, .review-passage-comments')
								)
									return
								const selection = window.getSelection()
								pointerSelection.current = {
									id: event.pointerId,
									binding: selectionBinding,
									api,
									anchor: selection?.anchorNode ?? null,
									anchorOffset: selection?.anchorOffset ?? 0,
									focus: selection?.focusNode ?? null,
									focusOffset: selection?.focusOffset ?? 0,
								}
							}}
							onPointerCancel={() => {
								pointerSelection.current = null
							}}
							onPointerUp={event => {
								const started = pointerSelection.current
								pointerSelection.current = null
								const selection = window.getSelection()
								if (
									!event.isTrusted ||
									!started ||
									started.id !== event.pointerId ||
									started.binding !== selectionBinding ||
									started.api !== api
								)
									return
								if (
									selection?.anchorNode === started.anchor &&
									selection.anchorOffset === started.anchorOffset &&
									selection.focusNode === started.focus &&
									selection.focusOffset === started.focusOffset
								)
									return
								captureSelection(true)
							}}
							onKeyUp={() => captureSelection()}
							onKeyDown={event => {
								if (event.altKey && event.key === 'Enter' && candidate) {
									event.preventDefault()
									useSelection()
								}
							}}
						>
							{view === 'comments' ? (
								<section className="review-comments">
									<h2>Your comments</h2>
									<p>Saved review comments. Explicit saves travel with the document; resolution is always explicit.</p>
									{!draft.annotations.length && (
										<div className="review-empty">
											<h3>Leave a thought in the margin</h3>
											<p>Select a passage, write your thought, then choose Save local comment under Writing options.</p>
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
														disabled={selectionLocked()}
														onClick={() => {
															if (selectionLocked()) return
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
													disabled={selectionLocked()}
													onClick={() => {
														if (openPassage(annotation.passage, annotation.intent, annotation.id, undefined, true))
															changeDraft(value => ({ ...value, instruction: annotation.note }))
													}}
												>
													Edit / send feedback
												</Btn>
												<Btn
													sm
													tone="ghost"
													disabled={busy}
													onClick={() =>
														changeAnnotations(value => ({
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
													onClick={() =>
														changeAnnotations(value => ({
															...value,
															annotations: removeReviewAnnotation(value.annotations, annotation.id),
														}))
													}
												>
													Delete
												</Btn>
												{candidate && annotation.passage.revision !== state.document.revision && (
													<Btn
														sm
														onClick={() =>
															changeAnnotations(value => ({
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
							) : view === 'source' || (!canvasMode && model.error) ? (
								<>
									<p className="review-meta">{model.error ?? 'Exact source, never rewritten by Helm.'}</p>
									<pre ref={source} className="review-full-source">
										{state.document.text}
									</pre>
								</>
							) : canvasMode ? null : (
								<article className="review-prose">
									<ReviewMarkdown
										blocks={model.blocks}
										selectedStart={passage?.revision === state.document.revision ? passage.start : null}
										passageThreads={passageThreads.size ? passageThreads : undefined}
										commentBinding={selectionBinding}
										api={api}
										providerName={selected ? providerNames[selected.provider] : ''}
									/>
								</article>
							)}
							{canvasMode && (
								<div hidden={view !== 'document'}>
									<DocumentCanvas
										document={state.document}
										api={api}
										handle={canvasHandle}
										onReady={setCanvasReady}
										threads={
											view === 'document' && !(narrow && pane !== 'document') && passageThreads.size
												? passageThreads
												: undefined
										}
										binding={selectionBinding}
									/>
								</div>
							)}
							<SavedAnnotationHighlights
								document={state.document}
								annotations={draft.annotations}
								reading={reading}
								visible={view === 'document' && !(narrow && pane !== 'document')}
							/>
						</div>
					</div>
					{candidate && candidate.binding === selectionBinding && (
						<fieldset
							className="review-selection-actions"
							aria-label="Pending selection"
							style={{ top: candidate.top, left: candidate.left }}
							onPointerDown={event => event.preventDefault()}
						>
							<Btn sm tone="ghost" disabled={selectionLocked()} onClick={useSelection}>
								Use selection
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
					ref={companion}
					className="review-companion"
					aria-label="Review conversation"
					hidden={narrow && pane !== 'conversation'}
				>
					<header className="review-conversation-header">
						<div className="review-conversation-title">
							<h2 title={selected?.name}>
								{showConversationChooser ? 'Conversation' : (selected?.name ?? 'Conversation')}
							</h2>
							<output className="review-meta">
								{selected ? `${providerNames[selected.provider]} · ` : ''}
								{!selected
									? 'Not connected'
									: selected.state === 'disconnected'
										? 'Disconnected'
										: selected.state === 'error' || selected.error || ownerBlocked
											? 'Needs attention'
											: selected.state === 'working'
												? 'Working'
												: selected.state === 'waiting'
													? 'Waiting'
													: selected.state === 'starting'
														? 'Starting'
														: selected.busy
															? 'Busy'
															: selected.listening
																? 'Ready'
																: 'Feedback paused'}
							</output>
						</div>
						{showConversationChooser && (
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
										{session.name}
									</option>
								))}
							</select>
						)}
					</header>
					{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Conversation scroll owner needs keyboard access without focusing message text. */}
					<div className="review-chat" tabIndex={0} aria-label="Conversation messages">
						<ArchivedConversation document={state.document} session={selected} />
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
						{((receipt && ['unknown', 'rejected'].includes(receipt.outcome)) || recovery !== null) && (
							// biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded receipt scroll owner must support keyboard reading.
							<section className="review-feedback-status" tabIndex={0} aria-label="Delivery and recovery">
								{receipt && ['unknown', 'rejected'].includes(receipt.outcome) && (
									// biome-ignore lint/a11y/useSemanticElements: A live receipt has structured block content; it is not a scalar form output.
									<div className="review-receipt" role="status">
										<strong>{receipt.outcome === 'unknown' ? 'Outcome not confirmed' : 'Not sent'}</strong>
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

function DiscardReplyConfirmation({
	busy,
	onKeep,
	onDiscard,
}: { busy: boolean; onKeep: () => void; onDiscard: () => void }) {
	const keep = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		const dialog = keep.current?.closest('dialog')
		if (dialog?.contains(document.activeElement) && document.activeElement?.closest('.sheet-head'))
			keep.current?.focus()
	}, [])
	return (
		<Sheet
			title="Discard unsaved reply?"
			onClose={onKeep}
			footer={
				<>
					<Btn ref={keep} disabled={busy} onClick={onKeep}>
						Keep unsaved reply
					</Btn>
					<Btn tone="danger" disabled={busy} onClick={onDiscard}>
						Discard unsaved reply
					</Btn>
				</>
			}
		>
			<p>
				The document will not retain this unsaved reply. Your original conversation is unchanged, and your local draft
				is kept. Nothing is resent or acknowledged.
			</p>
			<p>Keep the reply to retry saving it instead.</p>
		</Sheet>
	)
}

function ArchivedConversation({
	document,
	session,
}: { document: ReviewState['document']; session: ReviewSession | null }) {
	const live = new Set(session?.messages.map(message => message.archiveThreadId).filter(Boolean) ?? [])
	const threads = document.archive?.threads.filter(thread => !live.has(thread.id)) ?? []
	if (!threads.length) return null
	return (
		<section className="review-archive" aria-label="Saved review history">
			<h2>Saved review history</h2>
			<p className="review-meta">Read-only history · never replayed</p>
			{threads.map(thread => (
				<section key={thread.id} aria-label="Saved review thread">
					<p className="review-meta">
						{thread.name} · {providerNames[thread.provider]} · {archiveThreadStatus(thread.state)}
						{thread.passage && thread.passage.revision !== document.revision ? ' · Passage changed; not relocated' : ''}
					</p>
					<article className="review-message review-message-user">
						<h3>You</h3>
						<div>{thread.instruction}</div>
					</article>
					{thread.fields.length > 0 && (
						<details>
							<summary>Public document fields</summary>
							{thread.fields.map(field => (
								<p key={field.id}>
									{field.id}: {String(field.value)}
								</p>
							))}
						</details>
					)}
					{thread.reply && (
						<article className="review-message review-message-assistant">
							<h3>{thread.name}</h3>
							<div>{thread.reply}</div>
						</article>
					)}
					{thread.detail && <p className="review-meta">{thread.detail}</p>}
				</section>
			))}
		</section>
	)
}

function Conversation({ session }: { session: ReviewSession | null }) {
	if (!session) return null
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
		</>
	)
}
