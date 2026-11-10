// Story-only `helm open` spreadsheet + CSV renderer (docs/plans/helm-open/spec.md). One component
// for format 'sheet' (SheetJS) and 'csv' (Papa Parse): a read-only grid virtualized in both axes,
// range selection, a formula/value bar and flat sheet tabs. Nothing executes: SheetJS only parses,
// formulas are shown as text next to their cached value and never evaluated.
import { useVirtualizer } from '@tanstack/react-virtual'
import Papa from 'papaparse'
import {
	type ClipboardEvent as ReactClipboardEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import * as XLSX from 'xlsx'
import './sheet.css'
import { loadBytes } from './fixtures'
import type { FeedbackAnchor, RendererProps } from './types'

const ROW_H = 24
const HEADER_H = 24
const DEFAULT_COL_W = 96
const MIN_COL_W = 56
const MAX_COL_W = 320
const AUTOFIT_SAMPLE_ROWS = 300
const COPY_CELL_LIMIT = 200_000
const CELL_FONT = '12px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif'

interface Cell {
	text: string
	/** Numbers and dates sit right, like every spreadsheet. */
	align: 'left' | 'right' | 'center'
	/** Numeric value for Sum, when the cell is a number. */
	value?: number
	formula?: string
}

interface Sheet {
	name: string
	rows: number
	cols: number
	cells: (Cell | undefined)[][]
	widths: number[]
}

interface Book {
	sheets: Sheet[]
	workbook: boolean
}

interface Pos {
	r: number
	c: number
}

interface Selection {
	anchor: Pos
	focus: Pos
}

interface Range {
	r0: number
	c0: number
	r1: number
	c1: number
}

// ---------------------------------------------------------------------------------------------
// Parsing

let measureContext: CanvasRenderingContext2D | null | undefined
function textWidth(text: string): number {
	if (measureContext === undefined) {
		measureContext = document.createElement('canvas').getContext('2d')
		if (measureContext) measureContext.font = CELL_FONT
	}
	return measureContext ? measureContext.measureText(text).width : text.length * 7
}

function autofitWidths(cells: (Cell | undefined)[][], cols: number, declared: (number | undefined)[]): number[] {
	const widths: number[] = []
	for (let c = 0; c < cols; c++) {
		const fixed = declared[c]
		if (fixed !== undefined) {
			widths.push(fixed)
			continue
		}
		let widest = 0
		const sample = Math.min(cells.length, AUTOFIT_SAMPLE_ROWS)
		for (let r = 0; r < sample; r++) {
			const text = cells[r]?.[c]?.text
			if (text) widest = Math.max(widest, textWidth(text))
		}
		widths.push(widest === 0 ? DEFAULT_COL_W : Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, widest + 20))))
	}
	return widths
}

function sheetFromWorksheet(name: string, ws: XLSX.WorkSheet): Sheet {
	const ref = ws['!ref']
	if (!ref) return { name, rows: 0, cols: 0, cells: [], widths: [] }
	const range = XLSX.utils.decode_range(ref)
	const rows = range.e.r + 1
	const cols = range.e.c + 1
	const dense = (ws['!data'] ?? []) as (XLSX.CellObject[] | undefined)[]
	const cells: (Cell | undefined)[][] = []
	for (let r = 0; r < Math.min(rows, dense.length); r++) {
		const source = dense[r]
		if (!source) {
			cells.push([])
			continue
		}
		const row: (Cell | undefined)[] = []
		for (let c = 0; c < source.length; c++) {
			const cell = source[c]
			if (!cell || cell.t === 'z') {
				row.push(undefined)
				continue
			}
			const text = cell.w ?? (cell.v === undefined ? '' : String(cell.v))
			row.push({
				text,
				align: cell.t === 'n' || cell.t === 'd' ? 'right' : cell.t === 'b' || cell.t === 'e' ? 'center' : 'left',
				value: cell.t === 'n' && typeof cell.v === 'number' ? cell.v : undefined,
				formula: cell.f ? `=${cell.f}` : undefined,
			})
		}
		cells.push(row)
	}
	// Excel column width: characters of the default font's widest digit, ≈7px each plus padding.
	const declared = (ws['!cols'] ?? []).map(col =>
		col?.wpx ? Math.round(col.wpx) : col?.wch ? Math.round(col.wch * 7 + 10) : undefined,
	)
	return { name, rows, cols, cells, widths: autofitWidths(cells, cols, declared) }
}

const NUMERIC = /^[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/

function sheetFromCsv(name: string, text: string): Sheet {
	const parsed = Papa.parse<string[]>(text, { delimiter: '', skipEmptyLines: 'greedy', header: false })
	const cells: (Cell | undefined)[][] = []
	let cols = 0
	for (const record of parsed.data) {
		cols = Math.max(cols, record.length)
		cells.push(
			record.map(raw => {
				if (raw === '') return undefined
				const trimmed = raw.trim()
				const numeric = NUMERIC.test(trimmed)
				return { text: raw, align: numeric ? 'right' : 'left', value: numeric ? Number(trimmed) : undefined }
			}),
		)
	}
	return { name, rows: cells.length, cols, cells, widths: autofitWidths(cells, cols, []) }
}

async function loadBook(props: RendererProps, signal: AbortSignal): Promise<Book> {
	const bytes = await loadBytes(props.file, signal)
	if (props.file.format === 'csv') {
		const text = new TextDecoder('utf-8').decode(bytes)
		return { workbook: false, sheets: [sheetFromCsv(props.file.name, text)] }
	}
	const wb = XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellDates: true, dense: true })
	return {
		workbook: true,
		sheets: wb.SheetNames.map(sheetName => sheetFromWorksheet(sheetName, wb.Sheets[sheetName] as XLSX.WorkSheet)),
	}
}

// ---------------------------------------------------------------------------------------------
// Ranges

function normalize(selection: Selection): Range {
	return {
		r0: Math.min(selection.anchor.r, selection.focus.r),
		r1: Math.max(selection.anchor.r, selection.focus.r),
		c0: Math.min(selection.anchor.c, selection.focus.c),
		c1: Math.max(selection.anchor.c, selection.focus.c),
	}
}

function rangeRef(range: Range): string {
	const start = XLSX.utils.encode_cell({ r: range.r0, c: range.c0 })
	if (range.r0 === range.r1 && range.c0 === range.c1) return start
	return `${start}:${XLSX.utils.encode_cell({ r: range.r1, c: range.c1 })}`
}

function parseRef(ref: string, sheet: Sheet): Selection | null {
	try {
		const range = XLSX.utils.decode_range(ref)
		const clampR = (r: number) => Math.max(0, Math.min(sheet.rows - 1, r))
		const clampC = (c: number) => Math.max(0, Math.min(sheet.cols - 1, c))
		return {
			anchor: { r: clampR(range.s.r), c: clampC(range.s.c) },
			focus: { r: clampR(range.e.r), c: clampC(range.e.c) },
		}
	} catch {
		return null
	}
}

function grouped(value: number): string {
	const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100
	const [whole, fraction] = String(Math.abs(rounded)).split('.')
	const digits = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
	return `${rounded < 0 ? '−' : ''}${digits}${fraction ? `.${fraction}` : ''}`
}

function rangeStats(sheet: Sheet, range: Range): { count: number; sum: number; numeric: number } {
	let count = 0
	let sum = 0
	let numeric = 0
	const r1 = Math.min(range.r1, sheet.cells.length - 1)
	for (let r = range.r0; r <= r1; r++) {
		const row = sheet.cells[r]
		if (!row) continue
		const c1 = Math.min(range.c1, row.length - 1)
		for (let c = range.c0; c <= c1; c++) {
			const cell = row[c]
			if (!cell || cell.text === '') continue
			count++
			if (cell.value !== undefined) {
				numeric++
				sum += cell.value
			}
		}
	}
	return { count, sum, numeric }
}

function rangePreview(sheet: Sheet, range: Range): string[][] {
	const preview: string[][] = []
	for (let r = range.r0; r <= Math.min(range.r1, range.r0 + 3); r++) {
		const line: string[] = []
		for (let c = range.c0; c <= Math.min(range.c1, range.c0 + 3); c++) line.push(sheet.cells[r]?.[c]?.text ?? '')
		preview.push(line)
	}
	return preview
}

function rangeTsv(sheet: Sheet, range: Range): string {
	const lines: string[] = []
	for (let r = range.r0; r <= range.r1; r++) {
		const line: string[] = []
		for (let c = range.c0; c <= range.c1; c++) line.push((sheet.cells[r]?.[c]?.text ?? '').replace(/[\t\n\r]/g, ' '))
		lines.push(line.join('\t'))
	}
	return lines.join('\n')
}

function sameRange(a: Range, b: Range): boolean {
	return a.r0 === b.r0 && a.r1 === b.r1 && a.c0 === b.c0 && a.c1 === b.c1
}

// ---------------------------------------------------------------------------------------------
// View

const ORIGIN: Selection = { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } }

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; book: Book }

export function SheetView(
	props: RendererProps & {
		/** Story knob: sheet to open on (defaults to the active feedback anchor's sheet, then the first). */
		initialSheet?: string
		/** Story knob: range to select on open, e.g. "B2:D11". */
		initialRange?: string
	},
) {
	const { file, onStatus, feedback = null, initialSheet, initialRange } = props
	const [state, setState] = useState<LoadState>({ kind: 'loading' })
	const [sheetIndex, setSheetIndex] = useState(0)
	const [selections, setSelections] = useState<Record<string, Selection>>({})
	const startRef = useRef({ initialSheet, initialRange, active: feedback?.active ?? null })

	useEffect(() => {
		const controller = new AbortController()
		setState({ kind: 'loading' })
		loadBook({ file }, controller.signal).then(
			book => {
				if (controller.signal.aborted) return
				const start = startRef.current
				const activeCells = start.active?.kind === 'cells' ? start.active : null
				const wanted = start.initialSheet ?? activeCells?.sheet
				const index = Math.max(
					0,
					book.sheets.findIndex(sheet => sheet.name === wanted),
				)
				const initial: Record<string, Selection> = {}
				const sheet = book.sheets[index]
				const ref = start.initialRange ?? (activeCells && activeCells.sheet === sheet?.name ? activeCells.range : null)
				if (sheet && ref) {
					const parsed = parseRef(ref, sheet)
					if (parsed) initial[sheet.name] = parsed
				}
				setSelections(initial)
				setSheetIndex(index)
				setState({ kind: 'ready', book })
			},
			(error: unknown) => {
				if (controller.signal.aborted) return
				setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
			},
		)
		return () => controller.abort()
	}, [file])

	const book = state.kind === 'ready' ? state.book : null
	const sheet = book?.sheets[sheetIndex] ?? null
	const selection = sheet ? (selections[sheet.name] ?? ORIGIN) : null

	const setSelection = useCallback(
		(next: Selection) => {
			if (!sheet) return
			setSelections(current => ({ ...current, [sheet.name]: next }))
		},
		[sheet],
	)

	useEffect(() => {
		if (!book || !sheet || !selection || !onStatus) return
		const range = normalize(selection)
		const facts: string[] = []
		if (book.workbook) facts.push(`${book.sheets.length} ${book.sheets.length === 1 ? 'sheet' : 'sheets'}`)
		facts.push(`${grouped(sheet.rows)} ${sheet.rows === 1 ? 'row' : 'rows'}`)
		if (!book.workbook) facts.push(`${sheet.cols} ${sheet.cols === 1 ? 'column' : 'columns'}`)
		if (!sameRange(range, { r0: range.r0, c0: range.c0, r1: range.r0, c1: range.c0 })) {
			const stats = rangeStats(sheet, range)
			if (stats.numeric > 0) facts.push(`Sum ${grouped(stats.sum)}`)
			facts.push(`Count ${grouped(stats.count)}`)
		}
		onStatus({ position: sheet.rows > 0 ? rangeRef(range) : undefined, facts })
	}, [book, sheet, selection, onStatus])

	if (state.kind === 'loading')
		return (
			<div className="open-view open-sheet">
				<p className="open-note">Reading {file.name}…</p>
			</div>
		)
	if (state.kind === 'error' || !book || !sheet || !selection)
		return (
			<div className="open-view open-sheet">
				<p className="open-note">
					<b>Can’t show this spreadsheet</b>
					{state.kind === 'error' ? state.message : 'The file has no sheets.'}
				</p>
			</div>
		)

	const range = normalize(selection)
	const active = sheet.cells[selection.anchor.r]?.[selection.anchor.c]
	const activeAnchor =
		feedback?.active?.kind === 'cells' && feedback.active.sheet === sheet.name ? feedback.active : null

	return (
		<div className="open-view open-sheet">
			<div className="open-sheet-bar">
				<span className="open-sheet-ref open-mono" aria-label="Selected range">
					{sheet.rows > 0 ? rangeRef(range) : ''}
				</span>
				<span className="open-sheet-content" aria-label={active?.formula ? 'Formula' : 'Value'}>
					{active?.formula ? (
						<>
							<span className="open-mono open-sheet-formula" title={active.formula}>
								{active.formula}
							</span>
							<span className="open-sheet-result">{active.text}</span>
						</>
					) : (
						<span className="open-sheet-value" title={active?.text}>
							{active?.text ?? ''}
						</span>
					)}
				</span>
			</div>
			{sheet.rows === 0 ? (
				<p className="open-note">This sheet is empty.</p>
			) : (
				<Grid
					key={`${file.url}#${sheet.name}`}
					sheet={sheet}
					selection={selection}
					onSelection={setSelection}
					feedback={feedback}
					activeAnchor={activeAnchor}
					label={book.workbook ? `${file.name}, sheet ${sheet.name}` : file.name}
				/>
			)}
			{book.workbook ? <SheetTabs sheets={book.sheets} index={sheetIndex} onSelect={setSheetIndex} /> : null}
		</div>
	)
}

function SheetTabs({ sheets, index, onSelect }: { sheets: Sheet[]; index: number; onSelect(index: number): void }) {
	const refs = useRef<(HTMLButtonElement | null)[]>([])
	const onKeyDown = (event: ReactKeyboardEvent) => {
		let next = index
		if (event.key === 'ArrowRight') next = (index + 1) % sheets.length
		else if (event.key === 'ArrowLeft') next = (index - 1 + sheets.length) % sheets.length
		else if (event.key === 'Home') next = 0
		else if (event.key === 'End') next = sheets.length - 1
		else return
		event.preventDefault()
		onSelect(next)
		refs.current[next]?.focus()
	}
	return (
		<div className="open-sheet-tabs" role="tablist" aria-label="Sheets" onKeyDown={onKeyDown}>
			{sheets.map((sheet, i) => (
				<button
					key={sheet.name}
					ref={node => {
						refs.current[i] = node
					}}
					type="button"
					role="tab"
					aria-selected={i === index}
					tabIndex={i === index ? 0 : -1}
					className="open-sheet-tab"
					onClick={() => onSelect(i)}
				>
					{sheet.name}
				</button>
			))}
		</div>
	)
}

// ---------------------------------------------------------------------------------------------
// Grid

function Grid({
	sheet,
	selection,
	onSelection,
	feedback,
	activeAnchor,
	label,
}: {
	sheet: Sheet
	selection: Selection
	onSelection(selection: Selection): void
	feedback: RendererProps['feedback']
	activeAnchor: Extract<FeedbackAnchor, { kind: 'cells' }> | null
	label: string
}) {
	const scrollRef = useRef<HTMLDivElement>(null)
	const contentRef = useRef<HTMLDivElement>(null)
	const rowHeadW = Math.max(40, String(sheet.rows).length * 8 + 16)

	const colStarts = useMemo(() => {
		const starts = [rowHeadW]
		for (const width of sheet.widths) starts.push((starts[starts.length - 1] ?? 0) + width)
		return starts
	}, [sheet.widths, rowHeadW])
	const totalW = colStarts[colStarts.length - 1] ?? rowHeadW
	const totalH = HEADER_H + sheet.rows * ROW_H

	const rowVirtualizer = useVirtualizer({
		count: sheet.rows,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_H,
		paddingStart: HEADER_H,
		overscan: 10,
		useFlushSync: false,
	})
	const estimateColumn = useCallback((index: number) => sheet.widths[index] ?? DEFAULT_COL_W, [sheet.widths])
	const colVirtualizer = useVirtualizer({
		horizontal: true,
		count: sheet.cols,
		getScrollElement: () => scrollRef.current,
		estimateSize: estimateColumn,
		paddingStart: rowHeadW,
		overscan: 4,
		useFlushSync: false,
	})
	const rows = rowVirtualizer.getVirtualItems()
	const cols = colVirtualizer.getVirtualItems()

	// Live refs so window listeners see the current selection without re-binding.
	const selectionRef = useRef(selection)
	selectionRef.current = selection
	const feedbackRef = useRef(feedback)
	feedbackRef.current = feedback

	const boxFor = useCallback(
		(range: Range): DOMRect => {
			const scroller = scrollRef.current
			const content = contentRef.current
			if (!scroller || !content) return new DOMRect()
			const origin = content.getBoundingClientRect()
			const view = scroller.getBoundingClientRect()
			const left = origin.left + (colStarts[range.c0] ?? 0)
			const right = origin.left + (colStarts[range.c1 + 1] ?? totalW)
			const top = origin.top + HEADER_H + range.r0 * ROW_H
			const bottom = origin.top + HEADER_H + (range.r1 + 1) * ROW_H
			// Clip to the visible cell area (under the sticky headers).
			const clipLeft = Math.max(left, view.left + rowHeadW)
			const clipTop = Math.max(top, view.top + HEADER_H)
			const clipRight = Math.min(right, view.left + scroller.clientWidth)
			const clipBottom = Math.min(bottom, view.top + scroller.clientHeight)
			return new DOMRect(clipLeft, clipTop, Math.max(0, clipRight - clipLeft), Math.max(0, clipBottom - clipTop))
		},
		[colStarts, totalW, rowHeadW],
	)

	const reportAnchor = useCallback(
		(current: Selection) => {
			const host = feedbackRef.current
			if (!host) return
			const range = normalize(current)
			host.onAnchor(
				{ kind: 'cells', sheet: sheet.name, range: rangeRef(range), preview: rangePreview(sheet, range) },
				boxFor(range),
			)
		},
		[sheet, boxFor],
	)

	const ensureVisible = useCallback(
		(pos: Pos) => {
			const scroller = scrollRef.current
			if (!scroller) return
			const top = HEADER_H + pos.r * ROW_H
			const viewTop = scroller.scrollTop + HEADER_H
			const viewBottom = scroller.scrollTop + scroller.clientHeight
			if (top < viewTop) scroller.scrollTop = top - HEADER_H
			else if (top + ROW_H > viewBottom) scroller.scrollTop = top + ROW_H - scroller.clientHeight
			const left = colStarts[pos.c] ?? 0
			const right = colStarts[pos.c + 1] ?? totalW
			const viewLeft = scroller.scrollLeft + rowHeadW
			const viewRight = scroller.scrollLeft + scroller.clientWidth
			if (left < viewLeft) scroller.scrollLeft = left - rowHeadW
			else if (right > viewRight) scroller.scrollLeft = Math.min(left - rowHeadW, right - scroller.clientWidth)
		},
		[colStarts, totalW, rowHeadW],
	)

	// Open with a preset range (story knob / feedback anchor) in view.
	const initialSelection = useRef(selection)
	useLayoutEffect(() => {
		ensureVisible(initialSelection.current.anchor)
	}, [ensureVisible])

	const cellAt = useCallback(
		(clientX: number, clientY: number): Pos => {
			const content = contentRef.current
			if (!content) return { r: 0, c: 0 }
			const origin = content.getBoundingClientRect()
			const x = clientX - origin.left
			const y = clientY - origin.top - HEADER_H
			const r = Math.max(0, Math.min(sheet.rows - 1, Math.floor(y / ROW_H)))
			// Binary search the column whose span holds x.
			let lo = 0
			let hi = sheet.cols - 1
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1
				if ((colStarts[mid] ?? 0) <= x) lo = mid
				else hi = mid - 1
			}
			return { r, c: Math.max(0, lo) }
		},
		[sheet.rows, sheet.cols, colStarts],
	)

	// Pointer selection: press, drag (auto-scrolling past the edges), release.
	const drag = useRef<{ x: number; y: number; frame: number } | null>(null)
	const startDrag = (event: ReactMouseEvent, mode: 'cell' | 'row' | 'col' | 'all') => {
		if (event.button !== 0) return
		event.preventDefault()
		scrollRef.current?.focus({ preventScroll: true })
		const pos = cellAt(event.clientX, event.clientY)
		const lastR = sheet.rows - 1
		const lastC = sheet.cols - 1
		const shaped = (anchor: Pos, focus: Pos): Selection => {
			if (mode === 'row') return { anchor: { r: anchor.r, c: 0 }, focus: { r: focus.r, c: lastC } }
			if (mode === 'col') return { anchor: { r: 0, c: anchor.c }, focus: { r: lastR, c: focus.c } }
			if (mode === 'all') return { anchor: { r: 0, c: 0 }, focus: { r: lastR, c: lastC } }
			return { anchor, focus }
		}
		const anchor = event.shiftKey ? selectionRef.current.anchor : pos
		onSelection(shaped(anchor, pos))
		if (mode === 'all') {
			reportAnchor(shaped(anchor, pos))
			return
		}
		const tick = () => {
			const state = drag.current
			const scroller = scrollRef.current
			if (!state || !scroller) return
			const view = scroller.getBoundingClientRect()
			const edge = 24
			let dx = 0
			let dy = 0
			if (state.x < view.left + rowHeadW) dx = -edge
			else if (state.x > view.left + scroller.clientWidth) dx = edge
			if (state.y < view.top + HEADER_H) dy = -edge
			else if (state.y > view.top + scroller.clientHeight) dy = edge
			if (dx || dy) {
				scroller.scrollLeft += dx
				scroller.scrollTop += dy
				const focus = cellAt(state.x, state.y)
				onSelection(shaped(anchor, focus))
			}
			state.frame = requestAnimationFrame(tick)
		}
		drag.current = { x: event.clientX, y: event.clientY, frame: requestAnimationFrame(tick) }
		const move = (moveEvent: MouseEvent) => {
			const state = drag.current
			if (!state) return
			state.x = moveEvent.clientX
			state.y = moveEvent.clientY
			const focus = cellAt(moveEvent.clientX, moveEvent.clientY)
			const current = selectionRef.current
			if (current.focus.r !== focus.r || current.focus.c !== focus.c || mode !== 'cell')
				onSelection(shaped(anchor, focus))
		}
		const up = () => {
			window.removeEventListener('mousemove', move)
			window.removeEventListener('mouseup', up)
			if (drag.current) cancelAnimationFrame(drag.current.frame)
			drag.current = null
			// Wait one frame so the last move's selection has committed.
			requestAnimationFrame(() => reportAnchor(selectionRef.current))
		}
		window.addEventListener('mousemove', move)
		window.addEventListener('mouseup', up)
	}
	useEffect(
		() => () => {
			if (drag.current) cancelAnimationFrame(drag.current.frame)
		},
		[],
	)

	// Keyboard: arrows, shift-arrows, Home/End, ⌘ jumps, Page keys, ⌘A.
	const pendingKeyAnchor = useRef(false)
	const onKeyDown = (event: ReactKeyboardEvent) => {
		const { anchor, focus } = selection
		const lastR = sheet.rows - 1
		const lastC = sheet.cols - 1
		const meta = event.metaKey || event.ctrlKey
		const page = Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 0) - HEADER_H) / ROW_H) - 1)
		const from = event.shiftKey ? focus : anchor
		let to: Pos | null = null
		if (meta && event.key.toLowerCase() === 'a') {
			event.preventDefault()
			const all = { anchor: { r: 0, c: 0 }, focus: { r: lastR, c: lastC } }
			onSelection(all)
			reportAnchor(all)
			return
		}
		switch (event.key) {
			case 'ArrowUp':
				to = { r: meta ? 0 : Math.max(0, from.r - 1), c: from.c }
				break
			case 'ArrowDown':
				to = { r: meta ? lastR : Math.min(lastR, from.r + 1), c: from.c }
				break
			case 'ArrowLeft':
				to = { r: from.r, c: meta ? 0 : Math.max(0, from.c - 1) }
				break
			case 'ArrowRight':
				to = { r: from.r, c: meta ? lastC : Math.min(lastC, from.c + 1) }
				break
			case 'Home':
				to = meta ? { r: 0, c: 0 } : { r: from.r, c: 0 }
				break
			case 'End':
				to = meta ? { r: lastR, c: lastC } : { r: from.r, c: lastC }
				break
			case 'PageUp':
				to = { r: Math.max(0, from.r - page), c: from.c }
				break
			case 'PageDown':
				to = { r: Math.min(lastR, from.r + page), c: from.c }
				break
			case 'Escape':
				if (anchor.r !== focus.r || anchor.c !== focus.c) {
					event.preventDefault()
					onSelection({ anchor, focus: anchor })
				}
				return
			default:
				return
		}
		event.preventDefault()
		if (event.shiftKey) {
			onSelection({ anchor, focus: to })
			pendingKeyAnchor.current = true
		} else onSelection({ anchor: to, focus: to })
		ensureVisible(to)
	}
	const onKeyUp = (event: ReactKeyboardEvent) => {
		if (event.key === 'Shift' && pendingKeyAnchor.current) {
			pendingKeyAnchor.current = false
			reportAnchor(selectionRef.current)
		}
	}

	const range = normalize(selection)
	const onCopy = (event: ReactClipboardEvent) => {
		if ((range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1) > COPY_CELL_LIMIT) return
		event.preventDefault()
		event.clipboardData.setData('text/plain', rangeTsv(sheet, range))
	}

	const boxStyle = (box: Range) => ({
		left: colStarts[box.c0] ?? 0,
		top: HEADER_H + box.r0 * ROW_H,
		width: (colStarts[box.c1 + 1] ?? totalW) - (colStarts[box.c0] ?? 0),
		height: (box.r1 - box.r0 + 1) * ROW_H,
	})
	const activeBox = activeAnchor ? parseRef(activeAnchor.range, sheet) : null
	const activeRange = activeBox ? normalize(activeBox) : null
	const showSelection = !activeRange || !sameRange(activeRange, range)

	return (
		<div
			ref={scrollRef}
			className={`open-sheet-scroll${feedback ? ' is-feedback' : ''}`}
			// biome-ignore lint/a11y/useSemanticElements: a virtualized read-only grid has no native element.
			role="grid"
			aria-label={label}
			aria-rowcount={sheet.rows}
			aria-colcount={sheet.cols}
			aria-readonly="true"
			aria-multiselectable="true"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the grid takes the keys (arrows, shift-arrows, ⌘A, copy).
			tabIndex={0}
			onKeyDown={onKeyDown}
			onKeyUp={onKeyUp}
			onCopy={onCopy}
		>
			<div ref={contentRef} className="open-sheet-content-box" style={{ width: totalW, height: totalH }}>
				<div className="open-sheet-colheads" style={{ width: totalW }}>
					<div
						className="open-sheet-corner"
						style={{ width: rowHeadW }}
						onMouseDown={event => startDrag(event, 'all')}
					/>
					{cols.map(col => (
						<div
							key={col.key}
							className={`open-sheet-colhead${col.index >= range.c0 && col.index <= range.c1 ? ' is-selected' : ''}`}
							style={{ left: col.start, width: col.size }}
							onMouseDown={event => startDrag(event, 'col')}
						>
							{XLSX.utils.encode_col(col.index)}
						</div>
					))}
				</div>
				<div className="open-sheet-rowheads" style={{ width: rowHeadW, height: sheet.rows * ROW_H }}>
					{rows.map(row => (
						<div
							key={row.key}
							className={`open-sheet-rowhead${row.index >= range.r0 && row.index <= range.r1 ? ' is-selected' : ''}`}
							style={{ top: row.start - HEADER_H }}
							onMouseDown={event => startDrag(event, 'row')}
						>
							{row.index + 1}
						</div>
					))}
				</div>
				<div className="open-sheet-cells" onMouseDown={event => startDrag(event, 'cell')}>
					{rows.map(row => {
						const line = sheet.cells[row.index]
						return cols.map(col => {
							const cell = line?.[col.index]
							return (
								<div
									key={`${row.key}:${col.key}`}
									className={`open-sheet-cell is-${cell?.align ?? 'left'}`}
									style={{ top: row.start, left: col.start, width: col.size }}
								>
									{cell?.text}
								</div>
							)
						})
					})}
				</div>
				{activeRange ? <div className="open-anchor-box open-sheet-anchor" style={boxStyle(activeRange)} /> : null}
				{showSelection ? <div className="open-sheet-selection" style={boxStyle(range)} /> : null}
				<div
					className="open-sheet-active"
					style={boxStyle({
						r0: selection.anchor.r,
						r1: selection.anchor.r,
						c0: selection.anchor.c,
						c1: selection.anchor.c,
					})}
				/>
			</div>
		</div>
	)
}
