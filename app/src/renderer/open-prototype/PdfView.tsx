// Story-only PDF renderer for the `helm open` prototype (docs/plans/helm-open/spec.md).
//
// pdf.js renders each page to a canvas in a dedicated worker; nothing in the file is executed:
// pdf.js 6 has no eval/Function font path at all (the old `isEvalSupported` knob is gone), XFA is
// off, no scripting sandbox is loaded, no annotation/form layer is mounted (appearance streams are
// painted onto the canvas only), and bytes are passed as `data` so pdf.js never fetches anything —
// no cMap/standard-font/wasm URLs are configured, so a file that needs them degrades instead of
// loading remote data.
import {
	AnnotationMode,
	GlobalWorkerOptions,
	type PDFDocumentLoadingTask,
	type PDFDocumentProxy,
	type PDFPageProxy,
	PasswordException,
	type RenderTask,
	TextLayer,
	getDocument,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import { loadBytes } from './fixtures'
import './pdf.css'
import type { FeedbackAnchor, NormalizedRect, RendererProps } from './types'

GlobalWorkerOptions.workerSrc = workerUrl

/** Gutter around and between pages (design-system spacing). */
const GAP = 24
/** Fit-width never makes a page wider than this at zoom 1 (very wide windows stay readable). */
const MAX_FIT_WIDTH = 1200
/** Canvas backing-store cap: pdf.js' own default is 2^25; half keeps memory calm on long docs. */
const MAX_CANVAS_PIXELS = 16_777_216

type Size = { width: number; height: number }

type Loaded =
	| { state: 'ready'; doc: PDFDocumentProxy; first: Size }
	| { state: 'loading' }
	| { state: 'error'; title: string; detail: string }

/** Named paper sizes in PDF points (1/72 in), portrait. */
const PAPER: [string, number, number][] = [
	['A3', 842, 1191],
	['A4', 595, 842],
	['A5', 420, 595],
	['Letter', 612, 792],
	['Legal', 612, 1008],
]

function paperName({ width, height }: Size): string {
	const portrait = height >= width
	const [short, long] = portrait ? [width, height] : [height, width]
	for (const [name, w, h] of PAPER) {
		if (Math.abs(short - w) <= 3 && Math.abs(long - h) <= 3) return portrait ? name : `${name} landscape`
	}
	const mm = (pt: number) => Math.round((pt / 72) * 25.4)
	return `${mm(width)} × ${mm(height)} mm`
}

function pageSize(page: PDFPageProxy): Size {
	const viewport = page.getViewport({ scale: 1 })
	return { width: viewport.width, height: viewport.height }
}

/** Rects of a range, relative to `box`, merged into one rect per text line. */
function lineRects(range: Range, box: DOMRect): NormalizedRect[] {
	const raw = [...range.getClientRects()].filter(rect => rect.width >= 1 && rect.height >= 1)
	raw.sort((a, b) => a.top - b.top || a.left - b.left)
	const lines: { top: number; bottom: number; left: number; right: number }[] = []
	for (const rect of raw) {
		const line = lines.find(l => {
			const overlap = Math.min(l.bottom, rect.bottom) - Math.max(l.top, rect.top)
			return overlap > Math.min(l.bottom - l.top, rect.height) * 0.5
		})
		if (line) {
			line.top = Math.min(line.top, rect.top)
			line.bottom = Math.max(line.bottom, rect.bottom)
			line.left = Math.min(line.left, rect.left)
			line.right = Math.max(line.right, rect.right)
		} else {
			lines.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right })
		}
	}
	return lines.map(line => ({
		x: (line.left - box.left) / box.width,
		y: (line.top - box.top) / box.height,
		width: (line.right - line.left) / box.width,
		height: (line.bottom - line.top) / box.height,
	}))
}

/**
 * Find `quote` in a text layer, ignoring whitespace (pdf.js splits runs into absolutely placed
 * spans, so the DOM text and Selection.toString() disagree on spaces and line breaks).
 */
function findQuote(layer: HTMLElement, quote: string): Range | null {
	const needle = quote.replace(/\s+/g, '')
	if (!needle) return null
	const map: { node: Text; offset: number }[] = []
	let haystack = ''
	const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const text = node.data
		for (let i = 0; i < text.length; i++) {
			if (/\s/.test(text[i] ?? '')) continue
			haystack += text[i]
			map.push({ node, offset: i })
		}
	}
	const at = haystack.indexOf(needle)
	if (at < 0) return null
	const start = map[at]
	const end = map[at + needle.length - 1]
	if (!start || !end) return null
	const range = document.createRange()
	range.setStart(start.node, start.offset)
	range.setEnd(end.node, end.offset + 1)
	return range
}

const quoteKey = (page: number, quote: string) => `${page}\u0000${quote}`

export function PdfView({ file, zoom = 1, onStatus, feedback = null }: RendererProps) {
	const rootRef = useRef<HTMLDivElement>(null)
	const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
	const [fitWidth, setFitWidth] = useState(0)
	const [altHeld, setAltHeld] = useState(false)
	/** Line rects captured at selection time, so a painted quote matches what was selected. */
	const selectionRects = useRef(new Map<string, NormalizedRect[]>())
	const statusRef = useRef(onStatus)
	statusRef.current = onStatus

	// Load the document once per file.
	useEffect(() => {
		const abort = new AbortController()
		// pdf.js 6: the loading task owns the worker; PDFDocumentProxy has no destroy() any more.
		let task: PDFDocumentLoadingTask | null = null
		let destroyed = false
		setLoaded({ state: 'loading' })
		void (async () => {
			try {
				const bytes = await loadBytes(file, abort.signal)
				task = getDocument({
					data: new Uint8Array(bytes),
					enableXfa: false,
					stopAtErrors: false,
					disableAutoFetch: true,
					disableStream: true,
				})
				const doc = await task.promise
				if (destroyed) return
				const first = pageSize(await doc.getPage(1))
				if (destroyed) return
				setLoaded({ state: 'ready', doc, first })
			} catch (error) {
				if (destroyed) return
				if (error instanceof PasswordException) {
					setLoaded({
						state: 'error',
						title: 'This PDF is password protected',
						detail: 'Open it in Preview to enter the password.',
					})
				} else {
					setLoaded({
						state: 'error',
						title: 'Can’t show this PDF',
						detail: error instanceof Error ? error.message : String(error),
					})
				}
			}
		})()
		return () => {
			destroyed = true
			abort.abort()
			void task?.destroy()
		}
	}, [file])

	// Fit-width: follow the scroll owner's content width (debounced so a drag doesn't re-render).
	useEffect(() => {
		const root = rootRef.current
		if (!root) return
		let timer = 0
		const measure = () => setFitWidth(Math.max(0, root.clientWidth - GAP * 2))
		measure()
		const observer = new ResizeObserver(() => {
			window.clearTimeout(timer)
			timer = window.setTimeout(measure, 100)
		})
		observer.observe(root)
		return () => {
			observer.disconnect()
			window.clearTimeout(timer)
		}
	}, [])

	const doc = loaded.state === 'ready' ? loaded.doc : null
	const first = loaded.state === 'ready' ? loaded.first : null
	const pageCount = doc?.numPages ?? 0
	/** CSS px per PDF point. Pages share page 1's width scale (mixed sizes keep relative size). */
	const scale = first && fitWidth > 0 ? (Math.min(fitWidth, MAX_FIT_WIDTH) / first.width) * zoom : 0

	// A zoom that outgrows the view starts centred horizontally, like Preview.
	const ready = scale > 0
	// biome-ignore lint/correctness/useExhaustiveDependencies: zoom is the trigger, read via layout.
	useLayoutEffect(() => {
		const root = rootRef.current
		if (!root || !ready) return
		root.scrollLeft = Math.max(0, (root.scrollWidth - root.clientWidth) / 2)
	}, [zoom, ready])

	// An anchor set from outside (a saved comment, the story's initial anchor) is revealed when it
	// lies out of view; one the reader just pointed at is already visible, so nothing moves.
	const active = feedback?.active ?? null
	useEffect(() => {
		const root = rootRef.current
		if (!root || !ready || !active || (active.kind !== 'pdf-region' && active.kind !== 'pdf-text')) return
		const shell = root.querySelector<HTMLElement>(`[data-pdf-page="${active.page}"]`)
		const paper = shell?.querySelector<HTMLElement>('.open-pdf-paper')
		if (!shell || !paper) return
		const y = active.kind === 'pdf-region' ? active.rect.y : 0
		const h = active.kind === 'pdf-region' ? active.rect.height : 1
		const top = shell.offsetTop + y * paper.offsetHeight
		const bottom = top + h * paper.offsetHeight
		if (top >= root.scrollTop && bottom <= root.scrollTop + root.clientHeight) return
		root.scrollTop = Math.max(0, top - Math.max(GAP, (root.clientHeight - (bottom - top)) / 2))
	}, [active, ready])

	// Position: the page under the upper third of the view.
	const [current, setCurrent] = useState(1)
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new scale moves every page; re-measure.
	useEffect(() => {
		const root = rootRef.current
		if (!root || !pageCount) return
		let frame = 0
		const update = () => {
			frame = 0
			const probe = root.scrollTop + root.clientHeight / 3
			let page = 1
			for (const element of root.querySelectorAll<HTMLElement>('[data-pdf-page]')) {
				if (element.offsetTop - GAP / 2 <= probe) page = Number(element.dataset.pdfPage)
			}
			setCurrent(page)
		}
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(update)
		}
		update()
		root.addEventListener('scroll', onScroll, { passive: true })
		return () => {
			root.removeEventListener('scroll', onScroll)
			cancelAnimationFrame(frame)
		}
	}, [pageCount, scale])

	useEffect(() => {
		if (!first || !pageCount) return
		statusRef.current?.({
			position: `Page ${current} of ${pageCount}`,
			facts: [pageCount === 1 ? '1 page' : `${pageCount} pages`, paperName(first)],
		})
	}, [current, pageCount, first])

	// Alt/Option shows the region crosshair while feedback mode is on.
	useEffect(() => {
		if (!feedback) {
			setAltHeld(false)
			return
		}
		const onKey = (event: KeyboardEvent) => setAltHeld(event.altKey)
		const onBlur = () => setAltHeld(false)
		window.addEventListener('keydown', onKey)
		window.addEventListener('keyup', onKey)
		window.addEventListener('blur', onBlur)
		return () => {
			window.removeEventListener('keydown', onKey)
			window.removeEventListener('keyup', onKey)
			window.removeEventListener('blur', onBlur)
		}
	}, [feedback])

	// Feedback: a finished text selection inside one page's text layer becomes a pdf-text anchor.
	const feedbackRef = useRef(feedback)
	feedbackRef.current = feedback
	const onTextSelected = useCallback(() => {
		const host = feedbackRef.current
		const root = rootRef.current
		if (!host || !root) return
		const selection = window.getSelection()
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
		const range = selection.getRangeAt(0)
		const start = range.startContainer.parentElement?.closest<HTMLElement>('[data-pdf-page]')
		if (!start || !root.contains(start)) return
		const quote = selection.toString().replace(/\s+/g, ' ').trim()
		if (!quote) return
		const page = Number(start.dataset.pdfPage)
		const paper = start.querySelector<HTMLElement>('.open-pdf-paper')
		if (paper) {
			// Only the part of the range on its start page is kept (an anchor names one page).
			const pageRange = range.cloneRange()
			const layer = paper.querySelector('.open-pdf-text')
			if (layer && !layer.contains(range.endContainer)) pageRange.setEndAfter(layer.lastChild ?? layer)
			selectionRects.current.set(quoteKey(page, quote), lineRects(pageRange, paper.getBoundingClientRect()))
		}
		host.onAnchor({ kind: 'pdf-text', page, quote }, range.getBoundingClientRect())
	}, [])

	if (loaded.state === 'error') {
		return (
			<div className="open-view open-pdf" ref={rootRef}>
				<p className="open-note">
					<b>{loaded.title}</b>
					{loaded.detail}
				</p>
			</div>
		)
	}

	return (
		<div
			className={`open-view open-pdf${feedback ? ' open-pdf-feedback' : ''}${altHeld ? ' open-pdf-region-armed' : ''}`}
			ref={rootRef}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll owner takes keyboard scrolling.
			tabIndex={0}
			role="document"
			aria-label={pageCount ? `${file.name}, ${pageCount} pages` : file.name}
			onPointerUp={feedback ? event => (event.altKey ? undefined : window.setTimeout(onTextSelected, 0)) : undefined}
		>
			{doc && first && scale > 0 ? (
				<div className="open-pdf-pages">
					{Array.from({ length: pageCount }, (_, index) => (
						<PdfPage
							// biome-ignore lint/suspicious/noArrayIndexKey: pages are positional.
							key={index}
							doc={doc}
							number={index + 1}
							count={pageCount}
							estimate={first}
							scale={scale}
							root={rootRef}
							feedback={feedback}
							selectionRects={selectionRects}
						/>
					))}
				</div>
			) : (
				<p className="open-note">Opening {file.name}…</p>
			)}
		</div>
	)
}

function PdfPage({
	doc,
	number,
	count,
	estimate,
	scale,
	root,
	feedback,
	selectionRects,
}: {
	doc: PDFDocumentProxy
	number: number
	count: number
	estimate: Size
	scale: number
	root: RefObject<HTMLDivElement | null>
	feedback: RendererProps['feedback']
	selectionRects: RefObject<Map<string, NormalizedRect[]>>
}) {
	const shellRef = useRef<HTMLElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const textRef = useRef<HTMLDivElement>(null)
	const [page, setPage] = useState<PDFPageProxy | null>(null)
	const [near, setNear] = useState(false)
	const [painted, setPainted] = useState(false)
	const [textReady, setTextReady] = useState(0)
	const [draft, setDraft] = useState<NormalizedRect | null>(null)

	// Lazy: only pages within a screen of the view load and paint.
	useEffect(() => {
		const shell = shellRef.current
		if (!shell) return
		const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), {
			root: root.current,
			rootMargin: '100% 0px',
		})
		observer.observe(shell)
		return () => observer.disconnect()
	}, [root])

	useEffect(() => {
		if (!near || page) return
		let live = true
		void doc.getPage(number).then(proxy => {
			if (live) setPage(proxy)
		})
		return () => {
			live = false
		}
	}, [near, page, doc, number])

	const size = page ? pageSize(page) : estimate
	const cssWidth = Math.floor(size.width * scale)
	const cssHeight = Math.floor(size.height * scale)

	// Canvas: device-pixel-ratio aware, capped, re-rendered when the scale changes.
	useEffect(() => {
		const canvas = canvasRef.current
		if (!near || !page || !canvas) return
		const viewport = page.getViewport({ scale })
		const dpr = window.devicePixelRatio || 1
		const ratio = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)))
		// Render off-screen, then swap, so a zoom never flashes a blank page.
		const scratch = document.createElement('canvas')
		scratch.width = Math.floor(viewport.width * ratio)
		scratch.height = Math.floor(viewport.height * ratio)
		let task: RenderTask | null = page.render({
			canvas: scratch,
			viewport,
			transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
			annotationMode: AnnotationMode.ENABLE,
		})
		task.promise.then(
			() => {
				task = null
				canvas.width = scratch.width
				canvas.height = scratch.height
				canvas.getContext('2d')?.drawImage(scratch, 0, 0)
				scratch.width = 0
				setPainted(true)
			},
			() => {
				scratch.width = 0
			},
		)
		return () => task?.cancel()
	}, [near, page, scale])

	// Text layer: selectable, copyable, transparent text over the canvas.
	const layerRef = useRef<{ layer: TextLayer; scale: number } | null>(null)
	useEffect(() => {
		const container = textRef.current
		if (!near || !page || !container) return
		const viewport = page.getViewport({ scale })
		const existing = layerRef.current
		if (existing) {
			if (existing.scale !== scale) {
				existing.layer.update({ viewport })
				existing.scale = scale
				setTextReady(n => n + 1)
			}
			return
		}
		const layer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport })
		layerRef.current = { layer, scale }
		const end = document.createElement('div')
		end.className = 'open-pdf-eoc'
		void layer.render().then(
			() => {
				container.append(end)
				setTextReady(n => n + 1)
			},
			() => {},
		)
	}, [near, page, scale])
	useEffect(
		() => () => {
			layerRef.current?.layer.cancel()
			layerRef.current = null
		},
		[],
	)

	// pdf.js' "selecting" trick: while dragging, the end-of-content block covers the whole layer
	// so the selection does not jump to the page's end when the pointer crosses a gap.
	const onTextPointerDown = (event: ReactPointerEvent) => {
		if (event.altKey) return
		const container = textRef.current
		if (!container) return
		container.classList.add('open-pdf-selecting')
		const done = () => {
			container.classList.remove('open-pdf-selecting')
			window.removeEventListener('pointerup', done)
			window.removeEventListener('pointercancel', done)
		}
		window.addEventListener('pointerup', done)
		window.addEventListener('pointercancel', done)
	}

	// Feedback: Alt/Option-drag draws a region.
	const onRegionPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!feedback || !event.altKey || event.button !== 0) return
		event.preventDefault()
		event.stopPropagation()
		window.getSelection()?.removeAllRanges()
		const paper = event.currentTarget
		paper.setPointerCapture(event.pointerId)
		const box = paper.getBoundingClientRect()
		const clamp = (v: number) => Math.min(1, Math.max(0, v))
		const x0 = clamp((event.clientX - box.left) / box.width)
		const y0 = clamp((event.clientY - box.top) / box.height)
		let rect: NormalizedRect = { x: x0, y: y0, width: 0, height: 0 }
		const move = (e: PointerEvent) => {
			const x1 = clamp((e.clientX - box.left) / box.width)
			const y1 = clamp((e.clientY - box.top) / box.height)
			rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }
			setDraft(rect)
		}
		const up = () => {
			paper.removeEventListener('pointermove', move)
			paper.removeEventListener('pointerup', up)
			paper.removeEventListener('pointercancel', cancel)
			setDraft(null)
			if (rect.width * box.width < 4 || rect.height * box.height < 4) return
			const now = paper.getBoundingClientRect()
			feedback.onAnchor(
				{ kind: 'pdf-region', page: number, rect },
				new DOMRect(
					now.left + rect.x * now.width,
					now.top + rect.y * now.height,
					rect.width * now.width,
					rect.height * now.height,
				),
			)
		}
		const cancel = () => {
			paper.removeEventListener('pointermove', move)
			paper.removeEventListener('pointerup', up)
			paper.removeEventListener('pointercancel', cancel)
			setDraft(null)
		}
		paper.addEventListener('pointermove', move)
		paper.addEventListener('pointerup', up)
		paper.addEventListener('pointercancel', cancel)
	}

	// Paint the active anchor when it is on this page.
	// textReady/scale are re-measure triggers: a quote can only be found once its text layer exists.
	const active = feedback?.active ?? null
	const [paint, setPaint] = useState<NormalizedRect[]>([])
	// biome-ignore lint/correctness/useExhaustiveDependencies: textReady and scale re-run the measure.
	useLayoutEffect(() => {
		setPaint(activeRects(active, number, textRef.current, selectionRects.current))
	}, [active, number, textReady, scale, selectionRects])

	// Text selection never starts under an Alt-drag (pointerdown alone does not stop it in Chromium).
	const onRegionMouseDown = (event: ReactMouseEvent) => {
		if (feedback && event.altKey) event.preventDefault()
	}

	return (
		<section className="open-pdf-page" data-pdf-page={number} ref={shellRef} aria-label={`Page ${number} of ${count}`}>
			<div
				className="open-pdf-paper"
				style={{ width: cssWidth, height: cssHeight, ['--total-scale-factor' as string]: scale }}
				onPointerDown={feedback ? onRegionPointerDown : undefined}
				onMouseDown={feedback ? onRegionMouseDown : undefined}
			>
				<canvas ref={canvasRef} className={`open-pdf-canvas${painted ? ' open-pdf-painted' : ''}`} />
				<div ref={textRef} className="open-pdf-text" onPointerDown={onTextPointerDown} />
				{paint.map((rect, index) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: display-only line boxes.
						key={index}
						className="open-anchor-box"
						style={percentBox(rect)}
					/>
				))}
				{draft ? <div className="open-anchor-box open-pdf-draft" style={percentBox(draft)} /> : null}
			</div>
		</section>
	)
}

function percentBox(rect: NormalizedRect): CSSProperties {
	return {
		left: `${rect.x * 100}%`,
		top: `${rect.y * 100}%`,
		width: `${rect.width * 100}%`,
		height: `${rect.height * 100}%`,
	}
}

function activeRects(
	active: FeedbackAnchor | null,
	page: number,
	layer: HTMLElement | null,
	captured: Map<string, NormalizedRect[]>,
): NormalizedRect[] {
	if (!active) return []
	if (active.kind === 'pdf-region') return active.page === page ? [active.rect] : []
	if (active.kind !== 'pdf-text' || active.page !== page) return []
	const kept = captured.get(quoteKey(page, active.quote))
	if (kept) return kept
	const paper = layer?.parentElement
	if (!layer || !paper) return []
	const range = findQuote(layer, active.quote)
	return range ? lineRects(range, paper.getBoundingClientRect()) : []
}
