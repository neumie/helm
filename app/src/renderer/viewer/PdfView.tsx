// The PDF view of a plain `helm open` window (docs/plans/helm-open/spec.md, Formats: PDF; S4). pdf.js parses the file
// in its own worker; this thread answers its byte-range requests from the view's helm-viewer: token
// (`readTokenRange`), paints pages to canvases and lays pdf.js text layers over them for selection and find.
// Nothing in the file runs or loads: no XFA, no scripting sandbox, no annotation or form layer (appearance streams are
// painted onto the canvas only, so a link is just ink), and pdf.js's optional data (CMaps, standard fonts, wasm image
// decoders) comes only from Helm's own assets. pdf.js does compile a file's PostScript calculator functions to wasm in its
// worker ('wasm-unsafe-eval'; Math imports only, no I/O): computation, not script.
import {
	AnnotationMode,
	GlobalWorkerOptions,
	PDFDataRangeTransport,
	type PDFDocumentLoadingTask,
	type PDFDocumentProxy,
	type PDFPageProxy,
	PasswordResponses,
	type RenderTask,
	TextLayer,
	VerbosityLevel,
	getDocument,
} from 'pdfjs-dist'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type Ref,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { VIEWER_IMAGE_PIXELS, VIEWER_PDF_PAGES, countText, sizeText } from '../../../../src/document-review/formats'
import type { ReviewViewerPdf } from '../../document-review/types'
import { Btn } from '../button'
import { pdfAssetBase } from './pdf-assets'
import {
	PDF_FIND_LIMIT,
	type PdfMatch,
	type PdfPageText,
	findPattern,
	matchParts,
	pageMatches,
	pageText,
} from './pdf-find'
import { readTokenRange } from './pdf-range'

const assets = pdfAssetBase()
GlobalWorkerOptions.workerSrc = `${assets}build/pdf.worker.min.mjs`

/** Gutter around and between pages. */
const GAP = 24
/** Fit width never makes a page wider than this (very wide windows stay readable). */
const MAX_FIT_WIDTH = 1200
/** Canvas backing-store cap per page: half of pdf.js's own default keeps long documents calm. */
const MAX_CANVAS_PIXELS = 16_777_216
/** CSS px per PDF point at 100% (pdf.js's PDF_TO_CSS_UNITS: 96 dpi over 72 points per inch). */
const ACTUAL = 96 / 72
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8]
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8
/** Line step for J / K. */
const LINE = 40
/** Outline entries listed at most; the rest are summarised. */
const OUTLINE_LIMIT = 2_000
const HIGHLIGHT = 'helm-pdf-find'
const HIGHLIGHT_CURRENT = 'helm-pdf-find-current'

type Size = { width: number; height: number }
type Zoom = { mode: 'fit' } | { mode: 'scale'; value: number }

export interface PdfStatus {
	position: string
	facts: string[]
	/** A newer version could not be shown; the last readable one stays on screen. */
	problem?: string
	outline: 'none' | 'hidden' | 'shown'
}
export interface PdfViewHandle {
	fit(): void
	actualSize(): void
	openFind(): void
	goToPage(): void
	toggleOutline(): void
	/** Read the current version again (Retry read after a failed range read). */
	retry(): void
}
export interface PdfViewProps {
	name: string
	pdf: ReviewViewerPdf
	onStatus(status: PdfStatus): void
	/** ⌘= / ⌘- / ⌘0 from the window's shortcut dispatcher. */
	subscribeZoom?: (listener: (step: -1 | 0 | 1) => void) => () => void
	handle?: Ref<PdfViewHandle>
}

interface OutlineNode {
	title: string
	dest: string | unknown[] | null
	url: string | null
	items: OutlineNode[]
}
interface Shown {
	doc: PDFDocumentProxy
	task: PDFDocumentLoadingTask
	first: Size
	url: string
	outline: OutlineNode[]
	/** Stops answering pdf.js's range requests; called when this document is replaced or the view goes away. */
	close(): void
}
type Gate =
	| { kind: 'loading' }
	| { kind: 'ready' }
	| { kind: 'password'; wrong: boolean; submit(password: string): void }
	| { kind: 'failed'; message: string }

/** Named paper sizes in PDF points, portrait. */
const PAPER: [string, number, number][] = [
	['A3', 842, 1191],
	['A4', 595, 842],
	['A5', 420, 595],
	['Letter', 612, 792],
	['Legal', 612, 1008],
]
export function paperName({ width, height }: Size): string {
	const portrait = height >= width
	const [short, long] = portrait ? [width, height] : [height, width]
	for (const [name, w, h] of PAPER)
		if (Math.abs(short - w) <= 3 && Math.abs(long - h) <= 3) return portrait ? name : `${name} landscape`
	const mm = (pt: number) => Math.round((pt / 72) * 25.4)
	return `${mm(width)} × ${mm(height)} mm`
}
const pageSize = (page: PDFPageProxy): Size => {
	const viewport = page.getViewport({ scale: 1 })
	return { width: viewport.width, height: viewport.height }
}
/** First line of a parser error, never a stack. */
const firstLine = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() || 'unknown error'
const textOf = (content: TextContent): PdfPageText =>
	pageText(
		content.items
			.filter((item): item is TextItem => 'str' in item)
			.map(item => ({ str: item.str, hasEOL: item.hasEOL })),
	)
const zoomWord = (zoom: Zoom, scale: number) =>
	zoom.mode === 'fit' ? `Fit · ${Math.round((scale / ACTUAL) * 100)}%` : `${Math.round(zoom.value * 100)}%`

function readOutline(items: readonly unknown[] | null, budget: { left: number }): OutlineNode[] {
	const nodes: OutlineNode[] = []
	for (const raw of items ?? []) {
		if (budget.left <= 0) break
		budget.left--
		const item = raw as { title?: unknown; dest?: unknown; url?: unknown; items?: unknown[] }
		nodes.push({
			title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 300) : 'Untitled',
			dest: typeof item.dest === 'string' || Array.isArray(item.dest) ? (item.dest as string | unknown[]) : null,
			url: typeof item.url === 'string' ? item.url : null,
			items: readOutline(item.items ?? null, budget),
		})
	}
	return nodes
}

/** The page scroller's pages: shared intersection observer, find highlights, text cache. */
class PageRegistry {
	private readonly near = new Map<Element, (near: boolean) => void>()
	private observer: IntersectionObserver | null = null
	private readonly marks = new Map<number, Range[]>()
	private current: Range | null = null
	private currentPage: number | null = null
	readonly text = new Map<number, PdfPageText>()
	attach(root: HTMLElement) {
		this.observer?.disconnect()
		this.observer = new IntersectionObserver(
			entries => {
				for (const entry of entries) this.near.get(entry.target)?.(entry.isIntersecting)
			},
			{ root, rootMargin: '150% 0px' },
		)
		for (const element of this.near.keys()) this.observer.observe(element)
	}
	observe(element: Element, listener: (near: boolean) => void) {
		this.near.set(element, listener)
		this.observer?.observe(element)
		return () => {
			this.near.delete(element)
			this.observer?.unobserve(element)
		}
	}
	setMarks(page: number, ranges: Range[], current: Range | null) {
		if (ranges.length) this.marks.set(page, ranges)
		else this.marks.delete(page)
		if (current) {
			this.current = current
			this.currentPage = page
		} else if (this.currentPage === page) {
			this.current = null
			this.currentPage = null
		}
		this.paint()
	}
	clear() {
		this.marks.clear()
		this.current = null
		this.currentPage = null
		this.paint()
	}
	paint() {
		const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
		if (!registry) return
		const all = [...this.marks.values()].flat()
		if (all.length) registry.set(HIGHLIGHT, new Highlight(...all))
		else registry.delete(HIGHLIGHT)
		if (this.current) registry.set(HIGHLIGHT_CURRENT, new Highlight(this.current))
		else registry.delete(HIGHLIGHT_CURRENT)
	}
	dispose() {
		this.observer?.disconnect()
		this.near.clear()
		this.clear()
	}
}

interface Found {
	query: string
	matches: PdfMatch[]
	index: number
	searched: number
	done: boolean
	truncated: boolean
}
const NO_FIND: Found = { query: '', matches: [], index: -1, searched: 0, done: true, truncated: false }

export function PdfView({ name, pdf, onStatus, subscribeZoom, handle }: PdfViewProps) {
	const rootRef = useRef<HTMLDivElement>(null)
	const registry = useMemo(() => new PageRegistry(), [])
	const [shown, setShown] = useState<Shown | null>(null)
	const shownRef = useRef<Shown | null>(null)
	const [gate, setGate] = useState<Gate>({ kind: 'loading' })
	const [problem, setProblem] = useState<string | null>(null)
	const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' })
	const [fitWidth, setFitWidth] = useState(0)
	const [current, setCurrent] = useState(1)
	const [outlineOpen, setOutlineOpen] = useState(false)
	const password = useRef<string | null>(null)
	/** Bumped by Retry read: loads the same token again. */
	const [attempt, setAttempt] = useState(0)
	/** Where to put the reader after the next layout: a page and a fraction of it (reload and zoom keep the place). */
	const restore = useRef<Place | null>(null)
	const statusRef = useRef(onStatus)
	statusRef.current = onStatus

	useEffect(() => () => registry.dispose(), [registry])
	useEffect(() => {
		const root = rootRef.current
		if (root) registry.attach(root)
	}, [registry])
	// The shown document is destroyed (its worker too) when replaced and when the view goes away.
	useEffect(
		() => () => {
			shownRef.current?.close()
			void shownRef.current?.task.destroy()
			shownRef.current = null
		},
		[],
	)

	// Load each revision (a new token); the last readable one stays on screen until the new one is ready, and keeps
	// reading its pages through its own token (main keeps the previous token until the version after) until then.
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the Retry read trigger.
	useEffect(() => {
		const url = pdf.url
		const size = pdf.size
		const abort = new AbortController()
		/** This effect is the current load: it may change the view's state. */
		let live = true
		/** The transport still answers pdf.js (until this document is replaced or never shown). */
		let open = true
		/** The token answered "changed": the stream ends; main publishes the next version's token. */
		let ended = false
		let adopted = false
		const close = () => {
			open = false
			abort.abort()
		}
		const fail = (message: string) => {
			if (!live) return
			// A read failing after this version is on screen leaves it there: pages it has read stay, Retry reads again.
			if (adopted) {
				setProblem(message)
				return
			}
			live = false
			close()
			void task.destroy()
			if (shownRef.current) setProblem(message)
			else setGate({ kind: 'failed', message })
		}
		const transport = new PDFDataRangeTransport(size, null)
		transport.requestDataRange = (begin: number, end: number) => {
			if (!open || ended) return
			void readTokenRange(url, size, begin, end, abort.signal).then(
				read => {
					if (!open || ended) return
					// The file changed or the token was revoked: this stream ends, main admits the new version.
					if (read.kind === 'stale') {
						ended = true
						return
					}
					transport.onDataRange(begin, read.bytes)
				},
				error => {
					if (!open || ended || abort.signal.aborted) return
					fail(`${name} could not be read: ${firstLine(error)}`)
				},
			)
		}
		const task = getDocument({
			range: transport,
			disableAutoFetch: true,
			disableStream: true,
			enableXfa: false,
			stopAtErrors: false,
			useWorkerFetch: false,
			cMapUrl: `${assets}cmaps/`,
			cMapPacked: true,
			standardFontDataUrl: `${assets}standard_fonts/`,
			wasmUrl: `${assets}wasm/`,
			iccUrl: `${assets}iccs/`,
			maxImageSize: VIEWER_IMAGE_PIXELS,
			verbosity: VerbosityLevel.ERRORS,
		})
		let tried = false
		task.onPassword = (update: (password: string) => void, reason: number) => {
			if (!live) return
			// A password typed for an earlier version of this file is tried once, then asked for again.
			if (reason === PasswordResponses.NEED_PASSWORD && password.current !== null && !tried) {
				tried = true
				update(password.current)
				return
			}
			setGate({
				kind: 'password',
				wrong: reason === PasswordResponses.INCORRECT_PASSWORD || tried,
				submit: value => {
					password.current = value
					tried = true
					setGate({ kind: 'loading' })
					update(value)
				},
			})
		}
		task.promise.then(
			async doc => {
				if (!live) return
				try {
					if (doc.numPages > VIEWER_PDF_PAGES) {
						fail(
							`${name} has ${countText(doc.numPages)} pages; Helm shows PDFs up to ${countText(VIEWER_PDF_PAGES)} pages.`,
						)
						return
					}
					const [first, outline] = await Promise.all([
						doc.getPage(1).then(pageSize),
						doc.getOutline().then(
							items => readOutline(items, { left: OUTLINE_LIMIT }),
							() => [],
						),
					])
					if (!live) return
					// Keep the reader's place across the reload: page and offset within it.
					const root = rootRef.current
					if (shownRef.current && root) restore.current = placeOf(root)
					const previous = shownRef.current
					const next = { doc, task, first, url, outline, close }
					adopted = true
					shownRef.current = next
					registry.clear()
					registry.text.clear()
					setShown(next)
					setGate({ kind: 'ready' })
					setProblem(null)
					if (previous) {
						previous.close()
						void previous.task.destroy()
					}
				} catch (error) {
					if (!ended) fail(`${name} could not be read as a PDF: ${firstLine(error)}`)
				}
			},
			error => {
				if (!live) return
				// A stream ended by a newer version is not this file's fault; the newer token takes over.
				if (ended) return
				fail(`${name} could not be read as a PDF: ${firstLine(error)}`)
			},
		)
		return () => {
			live = false
			// The shown document keeps its transport until a newer one replaces it; anything else stops now.
			if (!adopted) {
				close()
				void task.destroy()
			}
		}
	}, [pdf.url, pdf.size, name, registry, attempt])

	// Fit width follows the scroller's content width.
	useEffect(() => {
		const root = rootRef.current
		if (!root) return
		let timer = 0
		const measure = () => setFitWidth(Math.max(0, root.clientWidth - GAP * 2))
		measure()
		const observer = new ResizeObserver(() => {
			window.clearTimeout(timer)
			timer = window.setTimeout(measure, 80)
		})
		observer.observe(root)
		return () => {
			observer.disconnect()
			window.clearTimeout(timer)
		}
	}, [])

	const doc = shown?.doc ?? null
	const first = shown?.first ?? null
	const pages = doc?.numPages ?? 0
	/** CSS px per PDF point. Pages share page 1's width scale, so mixed sizes keep their relative size. */
	const fitScale = first && fitWidth > 0 ? Math.min(fitWidth, MAX_FIT_WIDTH) / first.width : 0
	const scale = !first ? 0 : zoom.mode === 'fit' ? fitScale : zoom.value * ACTUAL

	// Restore a captured place once the pages are laid out at the new scale.
	useLayoutEffect(() => {
		const root = rootRef.current
		const place = restore.current
		if (!root || !place || scale <= 0 || !shown) return
		restore.current = null
		const element = root.querySelector<HTMLElement>(`[data-pdf-page="${Math.min(place.page, pages)}"]`)
		if (!element) return
		root.scrollTop = element.offsetTop + place.fraction * element.offsetHeight - place.viewY
		root.scrollLeft = Math.max(0, place.x * root.scrollWidth - place.viewX)
	}, [scale, shown, pages])

	// Current page: the page under the upper third of the view (binary search; pages are in order).
	// biome-ignore lint/correctness/useExhaustiveDependencies: a zoom moves other pages under the view.
	useEffect(() => {
		const root = rootRef.current
		if (!root || !pages) return
		let frame = 0
		const update = () => {
			frame = 0
			setCurrent(pageAt(root, root.scrollTop + root.clientHeight / 3))
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
	}, [pages, scale])

	const scrollToPage = useCallback((page: number, offset = 0) => {
		const root = rootRef.current
		const element = root?.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`)
		if (!root || !element) return
		root.scrollTop = element.offsetTop - GAP / 2 + offset
	}, [])

	// Zoom keeps the point at the view's centre (or under the cursor) where it was.
	const zoomTo = useCallback(
		(next: Zoom, at?: { x: number; y: number }) => {
			const root = rootRef.current
			const nextScale = next.mode === 'fit' ? fitScale : next.value * ACTUAL
			// Only a zoom that changes the scale moves pages; a place kept for nothing would jump back later.
			if (root && scale > 0 && Math.abs(nextScale - scale) > 1e-6) restore.current = placeOf(root, at)
			setZoom(next)
		},
		[scale, fitScale],
	)
	const percent = scale / ACTUAL
	const zoomStep = useRef<(step: -1 | 0 | 1) => void>(() => {})
	zoomStep.current = step => {
		if (!scale) return
		if (step === 0) return zoomTo({ mode: 'fit' })
		// Past the last step the zoom stays where it is: never a step in the wrong direction.
		const value =
			step > 0
				? (STEPS.find(candidate => candidate > percent + 0.001) ?? (percent < MAX_ZOOM ? MAX_ZOOM : null))
				: ([...STEPS].reverse().find(candidate => candidate < percent - 0.001) ??
					(percent > MIN_ZOOM ? MIN_ZOOM : null))
		if (value !== null) zoomTo({ mode: 'scale', value })
	}
	useEffect(() => subscribeZoom?.(step => zoomStep.current(step)), [subscribeZoom])

	// Pinch (Chromium reports it as ctrl + wheel) and ⌘ + wheel zoom at the cursor.
	const pinch = useRef({ percent, zoomTo })
	pinch.current = { percent, zoomTo }
	useEffect(() => {
		const root = rootRef.current
		if (!root) return
		const onWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return
			event.preventDefault()
			const { percent: now, zoomTo: to } = pinch.current
			if (!now) return
			const value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, now * Math.exp(-event.deltaY * 0.01)))
			const box = root.getBoundingClientRect()
			to({ mode: 'scale', value }, { x: event.clientX - box.left, y: event.clientY - box.top })
		}
		root.addEventListener('wheel', onWheel, { passive: false })
		return () => root.removeEventListener('wheel', onWheel)
	}, [])

	// ---- find ----
	const [findOpen, setFindOpen] = useState(false)
	const [found, setFound] = useState<Found>(NO_FIND)
	const field = useRef<HTMLInputElement>(null)
	const [reveal, setReveal] = useState(0)
	const openFind = useCallback(() => {
		setFindOpen(true)
		requestAnimationFrame(() => {
			field.current?.focus()
			field.current?.select()
		})
	}, [])
	const closeFind = useCallback(() => {
		setFindOpen(false)
		setFound(NO_FIND)
		registry.clear()
		rootRef.current?.focus({ preventScroll: true })
	}, [registry])
	// Search page by page (fetching each page's text as it goes); the first match at or after the current page is
	// the current one as soon as it is found.
	const currentRef = useRef(current)
	currentRef.current = current
	const pattern = useMemo(() => (findOpen ? findPattern(found.query) : null), [findOpen, found.query])
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new query or document restarts the search, not new matches.
	useEffect(() => {
		if (!doc || !pattern) {
			if (found.matches.length) setFound(value => ({ ...value, matches: [], index: -1, done: true, searched: 0 }))
			registry.clear()
			return
		}
		let live = true
		const start = currentRef.current
		const timer = window.setTimeout(async () => {
			const matches: PdfMatch[] = []
			let index = -1
			let truncated = false
			for (let page = 1; page <= doc.numPages && live; page++) {
				let text = registry.text.get(page)
				if (!text) {
					try {
						text = textOf(await (await doc.getPage(page)).getTextContent())
					} catch {
						text = pageText([])
					}
					if (!live) return
					registry.text.set(page, text)
				}
				const room = PDF_FIND_LIMIT - matches.length
				const onPage = pageMatches(page, text, pattern, room + 1)
				if (onPage.length > room) {
					truncated = true
					onPage.length = room
				}
				matches.push(...onPage)
				let first = false
				if (index < 0 && page >= start && onPage.length) {
					index = matches.length - onPage.length
					first = true
				}
				// Publish every ten pages, at the end, and with the first match (its reveal needs the index set).
				if (first || page % 10 === 0 || page === doc.numPages || truncated)
					setFound(value =>
						value.query === found.query
							? {
									...value,
									matches: [...matches],
									// A Next / Previous the reader already made stays; matches only ever grow at the end.
									index:
										value.index >= 0 && value.matches.length
											? value.index
											: index >= 0
												? index
												: matches.length
													? 0
													: -1,
									searched: page,
									done: page === doc.numPages || truncated,
									truncated,
								}
							: value,
					)
				if (first) setReveal(value => value + 1)
				if (truncated) break
			}
			if (live && index < 0 && matches.length) setReveal(value => value + 1)
		}, 120)
		return () => {
			live = false
			window.clearTimeout(timer)
		}
	}, [doc, pattern, registry])
	const step = useCallback((direction: 1 | -1) => {
		setFound(value =>
			value.matches.length
				? { ...value, index: (value.index + direction + value.matches.length) % value.matches.length }
				: value,
		)
		setReveal(value => value + 1)
	}, [])
	const active = found.index >= 0 ? (found.matches[found.index] ?? null) : null
	// Bring the current match's page into view; the page scrolls the match itself into view once its text is laid.
	const activeRef = useRef(active)
	activeRef.current = active
	useEffect(() => {
		if (!reveal) return
		const match = activeRef.current
		const root = rootRef.current
		if (!match || !root) return
		const element = root.querySelector<HTMLElement>(`[data-pdf-page="${match.page}"]`)
		if (!element) return
		const top = element.offsetTop
		if (top + element.offsetHeight < root.scrollTop || top > root.scrollTop + root.clientHeight)
			root.scrollTop = top - GAP / 2
	}, [reveal])

	// ⌘F / ⌘G / ⇧⌘G from anywhere in the window.
	const keys = useRef({ openFind, step })
	keys.current = { openFind, step }
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return
			const key = event.key.toLowerCase()
			if (key === 'f' && !event.shiftKey) {
				event.preventDefault()
				keys.current.openFind()
			} else if (key === 'g') {
				event.preventDefault()
				keys.current.step(event.shiftKey ? -1 : 1)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	// ---- go to page ----
	const [goOpen, setGoOpen] = useState(false)
	const goField = useRef<HTMLInputElement>(null)
	const [goValue, setGoValue] = useState('')
	const openGo = useCallback(() => {
		setGoOpen(true)
		setGoValue('')
		requestAnimationFrame(() => goField.current?.focus())
	}, [])
	const submitGo = (event: { preventDefault(): void }) => {
		event.preventDefault()
		const page = Number.parseInt(goValue, 10)
		if (!Number.isFinite(page) || page < 1 || page > pages) return
		setGoOpen(false)
		scrollToPage(page)
		rootRef.current?.focus({ preventScroll: true })
	}

	useImperativeHandle(
		handle,
		() => ({
			fit: () => zoomStep.current(0),
			actualSize: () => zoomTo({ mode: 'scale', value: 1 }),
			openFind,
			goToPage: openGo,
			toggleOutline: () => setOutlineOpen(value => !value),
			retry: () => setAttempt(value => value + 1),
		}),
		[openFind, openGo, zoomTo],
	)

	// Status: page, zoom, pages, paper, file size.
	const hasOutline = Boolean(shown?.outline.length)
	useEffect(() => {
		statusRef.current({
			position: pages ? `Page ${countText(current)} of ${countText(pages)}` : '',
			facts:
				first && scale > 0
					? [
							zoomWord(zoom, scale),
							pages === 1 ? '1 page' : `${countText(pages)} pages`,
							paperName(first),
							sizeText(pdf.size),
						]
					: [],
			...(problem ? { problem: `${problem}` } : {}),
			outline: !hasOutline ? 'none' : outlineOpen ? 'shown' : 'hidden',
		})
	}, [current, pages, first, scale, zoom, pdf.size, problem, hasOutline, outlineOpen])

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const root = rootRef.current
		// Keys typed into a field inside the pages (the password) are text, not commands.
		if (!root || event.altKey || event.target !== root) return
		if (event.metaKey || event.ctrlKey) {
			if (event.key === 'ArrowUp') root.scrollTop = 0
			else if (event.key === 'ArrowDown') root.scrollTop = root.scrollHeight
			else return
			event.preventDefault()
			return
		}
		switch (event.key) {
			case '[':
				scrollToPage(Math.max(1, current - 1))
				break
			case ']':
				scrollToPage(Math.min(pages, current + 1))
				break
			case 'j':
			case 'J':
				root.scrollTop += LINE
				break
			case 'k':
			case 'K':
				root.scrollTop -= LINE
				break
			case '0':
				zoomStep.current(0)
				break
			case '1':
				zoomTo({ mode: 'scale', value: 1 })
				break
			case '+':
			case '=':
				zoomStep.current(1)
				break
			case '-':
			case '_':
				zoomStep.current(-1)
				break
			default:
				return
		}
		event.preventDefault()
	}

	const goToOutline = async (node: OutlineNode) => {
		if (!doc || !node.dest) return
		try {
			const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest
			if (!dest) return
			const target = dest[0]
			const index =
				typeof target === 'number' ? target : await doc.getPageIndex(target as Parameters<typeof doc.getPageIndex>[0])
			const page = index + 1
			if (page < 1 || page > pages) return
			// XYZ / FitH / FitBH name a top; anything else lands on the page's top.
			const kind = (dest[1] as { name?: string } | undefined)?.name
			const top = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null
			let offset = 0
			if (typeof top === 'number') {
				const proxy = await doc.getPage(page)
				const [, y] = proxy.getViewport({ scale }).convertToViewportPoint(0, top)
				offset = Math.max(0, (y ?? 0) - GAP)
			}
			scrollToPage(page, offset)
		} catch {
			// A broken destination goes nowhere.
		}
	}

	const body =
		gate.kind === 'password' ? (
			<PasswordForm name={name} wrong={gate.wrong} onSubmit={gate.submit} />
		) : gate.kind === 'failed' ? (
			<p className="viewer-note" role="alert">
				{gate.message}
			</p>
		) : doc && first && scale > 0 ? (
			<div className="viewer-pdf-pages">
				{Array.from({ length: pages }, (_, index) => (
					<PdfPage
						key={`${shown?.url}:${index}`}
						doc={doc}
						number={index + 1}
						count={pages}
						estimate={first}
						scale={scale}
						registry={registry}
						pattern={pattern}
						active={active?.page === index + 1 ? active : null}
						reveal={active?.page === index + 1 ? reveal : 0}
					/>
				))}
			</div>
		) : (
			<p className="viewer-note">Reading {name}…</p>
		)

	return (
		<div className="viewer-pdf" data-outline={outlineOpen && hasOutline ? '' : undefined}>
			{findOpen && (
				// biome-ignore lint/a11y/useSemanticElements: React's DOM types have no <search> element yet.
				<div role="search" className="viewer-search" aria-label="Find in PDF">
					<input
						ref={field}
						type="search"
						className="viewer-search-field"
						placeholder="Find in PDF"
						aria-label="Find in PDF"
						value={found.query}
						spellCheck={false}
						onChange={event => {
							const query = event.target.value
							setFound({ ...NO_FIND, query, done: !findPattern(query) })
						}}
						onKeyDown={event => {
							if (event.key === 'Escape') {
								event.preventDefault()
								closeFind()
							} else if (event.key === 'Enter') {
								event.preventDefault()
								step(event.shiftKey ? -1 : 1)
							}
						}}
					/>
					<output className="viewer-search-count" aria-live="polite">
						{findCount(found, pages)}
					</output>
					<Btn sm tone="ghost" disabled={!found.matches.length} onClick={() => step(-1)}>
						Previous
					</Btn>
					<Btn sm tone="ghost" disabled={!found.matches.length} onClick={() => step(1)}>
						Next
					</Btn>
					<Btn sm tone="ghost" ariaLabel="Close find" onClick={closeFind}>
						×
					</Btn>
				</div>
			)}
			{goOpen && (
				<form className="viewer-search" aria-label="Go to page" onSubmit={submitGo}>
					<label className="viewer-pdf-go">
						Page
						<input
							ref={goField}
							className="viewer-search-field viewer-pdf-go-field"
							inputMode="numeric"
							value={goValue}
							onChange={event => setGoValue(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
							onKeyDown={event => {
								if (event.key === 'Escape') {
									event.preventDefault()
									setGoOpen(false)
									rootRef.current?.focus({ preventScroll: true })
								}
							}}
						/>
						of {countText(pages)}
					</label>
					<Btn sm tone="ghost" type="submit">
						Go
					</Btn>
					<Btn
						sm
						tone="ghost"
						ariaLabel="Close go to page"
						onClick={() => {
							setGoOpen(false)
							rootRef.current?.focus({ preventScroll: true })
						}}
					>
						×
					</Btn>
				</form>
			)}
			<div className="viewer-pdf-body">
				{outlineOpen && hasOutline && shown && (
					<nav className="viewer-pdf-outline" aria-label="Outline">
						<OutlineList nodes={shown.outline} onGo={node => void goToOutline(node)} />
						{shown.outline.length >= OUTLINE_LIMIT && (
							<p className="viewer-note viewer-note-inline">Showing the first {countText(OUTLINE_LIMIT)} entries.</p>
						)}
					</nav>
				)}
				<div
					className="viewer-pdf-scroll"
					ref={rootRef}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll owner takes keyboard scrolling.
					tabIndex={0}
					role="document"
					aria-label={pages ? `${name}, ${pages === 1 ? '1 page' : `${countText(pages)} pages`}` : name}
					onKeyDown={onKeyDown}
				>
					{body}
				</div>
			</div>
		</div>
	)
}

function findCount(found: Found, pages: number): string {
	if (!found.query.trim()) return ''
	const total = found.matches.length
	if (!found.done && !total) return `Searching… page ${countText(found.searched)} of ${countText(pages)}`
	if (!total) return 'No matches'
	const of = `${countText(found.index + 1)} of ${countText(total)}${found.truncated ? '+' : ''}`
	return found.done ? of : `${of} · searching…`
}

interface Place {
	page: number
	/** Fraction of the page above the anchor point. */
	fraction: number
	/** The anchor point's distance from the view's top and left edge. */
	viewY: number
	viewX: number
	/** Fraction of the scroll width left of the anchor point. */
	x: number
}
/** Reader's place: the page under `at` (the view's centre by default) and where on it that point is. */
function placeOf(root: HTMLElement, at?: { x: number; y: number }): Place {
	const viewY = at?.y ?? root.clientHeight / 2
	const viewX = at?.x ?? root.clientWidth / 2
	const y = root.scrollTop + viewY
	const page = pageAt(root, y)
	const element = root.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`)
	const fraction = element ? (y - element.offsetTop) / Math.max(1, element.offsetHeight) : 0
	return { page, fraction, viewY, viewX, x: (root.scrollLeft + viewX) / Math.max(1, root.scrollWidth) }
}
/** Page whose box contains scroll offset `y`, by binary search over the laid-out pages. */
function pageAt(root: HTMLElement, y: number): number {
	const elements = root.querySelectorAll<HTMLElement>('[data-pdf-page]')
	let low = 0
	let high = elements.length - 1
	let found = 0
	while (low <= high) {
		const middle = (low + high) >> 1
		const element = elements[middle] as HTMLElement
		if (element.offsetTop - GAP / 2 <= y) {
			found = middle
			low = middle + 1
		} else high = middle - 1
	}
	return found + 1
}

function OutlineList({ nodes, onGo }: { nodes: OutlineNode[]; onGo(node: OutlineNode): void }) {
	return (
		<ul className="viewer-pdf-outline-list">
			{nodes.map((node, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: outline entries are positional.
				<li key={index}>
					{node.dest ? (
						<button type="button" className="viewer-pdf-outline-item" title={node.title} onClick={() => onGo(node)}>
							{node.title}
						</button>
					) : (
						// External links stay text: nothing in a document navigates or opens.
						<span className="viewer-pdf-outline-item" data-inert="" title={node.url ?? node.title}>
							{node.title}
						</span>
					)}
					{node.items.length > 0 && <OutlineList nodes={node.items} onGo={onGo} />}
				</li>
			))}
		</ul>
	)
}

function PasswordForm({ name, wrong, onSubmit }: { name: string; wrong: boolean; onSubmit(password: string): void }) {
	const [value, setValue] = useState('')
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => {
		input.current?.focus()
		if (wrong) input.current?.select()
	}, [wrong])
	return (
		<form
			className="viewer-pdf-password"
			onSubmit={event => {
				event.preventDefault()
				if (value) onSubmit(value)
			}}
		>
			<p className="viewer-pdf-password-title">{name} is protected with a password.</p>
			<label className="viewer-pdf-password-field">
				<span>Password</span>
				<input
					ref={input}
					className="viewer-search-field viewer-pdf-password-input"
					type="password"
					autoComplete="off"
					value={value}
					aria-invalid={wrong || undefined}
					aria-describedby={wrong ? 'viewer-pdf-password-wrong' : undefined}
					onChange={event => setValue(event.target.value)}
				/>
			</label>
			{wrong && (
				<p id="viewer-pdf-password-wrong" className="viewer-pdf-password-wrong" role="alert">
					That password is not right.
				</p>
			)}
			<p className="viewer-pdf-password-note">Helm keeps it only while this window is open.</p>
			<div>
				<Btn type="submit" tone="primary" sm disabled={!value}>
					Open
				</Btn>
			</div>
		</form>
	)
}

const PdfPage = memo(PdfPageView)
function PdfPageView({
	doc,
	number,
	count,
	estimate,
	scale,
	registry,
	pattern,
	active,
	reveal,
}: {
	doc: PDFDocumentProxy
	number: number
	count: number
	estimate: Size
	scale: number
	registry: PageRegistry
	pattern: RegExp | null
	active: PdfMatch | null
	reveal: number
}) {
	const shellRef = useRef<HTMLElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const textRef = useRef<HTMLDivElement>(null)
	const [near, setNear] = useState(false)
	const [page, setPage] = useState<PDFPageProxy | null>(null)
	const [painted, setPainted] = useState(false)
	const [laid, setLaid] = useState<{ layer: TextLayer; text: PdfPageText } | null>(null)

	useEffect(() => {
		const shell = shellRef.current
		return shell ? registry.observe(shell, setNear) : undefined
	}, [registry])
	useEffect(() => {
		if (!near || page) return
		let live = true
		void doc.getPage(number).then(
			proxy => {
				if (live) setPage(proxy)
			},
			() => {},
		)
		return () => {
			live = false
		}
	}, [near, page, doc, number])

	const size = page ? pageSize(page) : estimate
	const cssWidth = Math.floor(size.width * scale)
	const cssHeight = Math.floor(size.height * scale)

	// Canvas: device-pixel aware and capped, rendered off screen and swapped in, so a zoom never flashes white.
	// A page that leaves the neighbourhood drops its pixels.
	useEffect(() => {
		const canvas = canvasRef.current
		if (!page || !canvas) return
		if (!near) {
			canvas.width = 0
			canvas.height = 0
			setPainted(false)
			page.cleanup()
			return
		}
		const viewport = page.getViewport({ scale })
		const dpr = window.devicePixelRatio || 1
		const ratio = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height)))
		const scratch = document.createElement('canvas')
		scratch.width = Math.max(1, Math.floor(viewport.width * ratio))
		scratch.height = Math.max(1, Math.floor(viewport.height * ratio))
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

	// Text layer: transparent, selectable text over the canvas, built from the same text content find searches.
	useEffect(() => {
		const container = textRef.current
		if (!near || !page || !container) return
		let live = true
		let layer: TextLayer | null = null
		void page.getTextContent().then(
			content => {
				if (!live) return
				const text = textOf(content)
				registry.text.set(number, text)
				layer = new TextLayer({ textContentSource: content, container, viewport: page.getViewport({ scale }) })
				const built = layer
				void built.render().then(
					() => {
						if (!live) return
						const end = document.createElement('div')
						end.className = 'viewer-pdf-eoc'
						container.append(end)
						setLaid({ layer: built, text })
					},
					() => {},
				)
			},
			() => {},
		)
		return () => {
			live = false
			layer?.cancel()
			container.replaceChildren()
			setLaid(null)
		}
	}, [near, page, scale, number, registry])

	// Find highlights on this page: one Range per match part, over the spans pdf.js laid.
	const activeStart = active?.start ?? -1
	const activeEnd = active?.end ?? -1
	useLayoutEffect(() => {
		if (!laid || !pattern) {
			registry.setMarks(number, [], null)
			return
		}
		const divs = laid.layer.textDivs
		const ranges: Range[] = []
		let current: Range | null = null
		for (const match of pageMatches(number, laid.text, pattern)) {
			const parts = matchParts(laid.text, match)
			const whole = document.createRange()
			let started = false
			for (const part of parts) {
				const node = divs[part.item]?.firstChild
				if (!(node instanceof Text) || part.to > node.length) continue
				const range = document.createRange()
				range.setStart(node, part.from)
				range.setEnd(node, part.to)
				ranges.push(range)
				if (!started) whole.setStart(node, part.from)
				whole.setEnd(node, part.to)
				started = true
			}
			if (started && match.start === activeStart && match.end === activeEnd) current = whole
		}
		registry.setMarks(number, ranges, current)
		return () => registry.setMarks(number, [], null)
	}, [laid, pattern, activeStart, activeEnd, number, registry])

	// The current match scrolls into the middle of the view when it is not fully visible.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reveal is the trigger; laid re-runs once text exists.
	useEffect(() => {
		if (!laid || !pattern || activeStart < 0) return
		const parts = matchParts(laid.text, { start: activeStart, end: activeEnd })
		const node = laid.layer.textDivs[parts[0]?.item ?? -1]
		const root = shellRef.current?.closest('.viewer-pdf-scroll')
		if (!node || !root) return
		const box = node.getBoundingClientRect()
		const view = root.getBoundingClientRect()
		if (box.top >= view.top + 8 && box.bottom <= view.bottom - 8) return
		root.scrollTop += box.top - view.top - view.height / 2
	}, [reveal, laid])

	// pdf.js's "selecting" trick: while dragging, the end-of-content block covers the layer, so the selection does
	// not jump to the end of the page when the pointer crosses a gap.
	const onTextPointerDown = () => {
		const container = textRef.current
		if (!container) return
		container.classList.add('viewer-pdf-selecting')
		const done = () => {
			container.classList.remove('viewer-pdf-selecting')
			window.removeEventListener('pointerup', done)
			window.removeEventListener('pointercancel', done)
		}
		window.addEventListener('pointerup', done)
		window.addEventListener('pointercancel', done)
	}

	return (
		<section
			className="viewer-pdf-page"
			data-pdf-page={number}
			ref={shellRef}
			aria-label={`Page ${number} of ${count}`}
		>
			<div
				className="viewer-pdf-paper"
				style={{ width: cssWidth, height: cssHeight, ['--total-scale-factor' as string]: scale }}
			>
				<canvas ref={canvasRef} className="viewer-pdf-canvas" data-painted={painted ? '' : undefined} />
				<div ref={textRef} className="viewer-pdf-text" onPointerDown={onTextPointerDown} />
			</div>
		</section>
	)
}
