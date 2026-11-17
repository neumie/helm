// The read-only grid of a plain `helm open` CSV/TSV window (docs/plans/helm-open/spec.md, S5). The file lives in the
// grid's worker; this view asks it for the rows on screen (in blocks), the active cell's whole value, a range's
// Count/Sum, a range as TSV and search matches. Virtualised in both axes: a million rows or 500 columns mount only
// what is visible. Column letters and row numbers stay put; a detected header row stays under the letters.
import { useVirtualizer } from '@tanstack/react-virtual'
import {
	type ClipboardEvent as ReactClipboardEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react'
import { Btn } from '../button'
import { useDocumentUiScale } from '../document-review/ui-scale'
import type { CsvClient } from './csv-client'
import { type CellRange, MATCH_LIMIT, alignRight, columnName, rangeRef } from './csv-model'

/** Rows the grid asks the worker for at a time, and how many blocks it keeps. */
const BLOCK = 100
const BLOCK_CACHE = 400
/** Characters of the active value a screen reader hears, and the value bar's tooltip shows. */
const ANNOUNCE_CHARS = 500
const TITLE_CHARS = 1000
const ROW_H = 24
const MIN_COL_W = 56
const MAX_COL_W = 320
const DEFAULT_COL_W = 96
/** Chromium stops laying out near 33.5 M px; the grid keeps its height under this so the last row stays reachable. */
export const GRID_MAX_HEIGHT = 30_000_000

interface Pos {
	r: number
	c: number
}
export interface Selection {
	anchor: Pos
	focus: Pos
}
const ORIGIN: Selection = { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } }
const normalize = (selection: Selection): CellRange => ({
	r0: Math.min(selection.anchor.r, selection.focus.r),
	r1: Math.max(selection.anchor.r, selection.focus.r),
	c0: Math.min(selection.anchor.c, selection.focus.c),
	c1: Math.max(selection.anchor.c, selection.focus.c),
})

/** The grid's scale for a zoom: rows grow with the font, but never past the height Chromium can scroll. */
export function gridScale(zoom: number, rows: number): number {
	const fit = GRID_MAX_HEIGHT / ((rows + 2) * ROW_H)
	return Math.max(0.5, Math.min(zoom, fit))
}

let measureCanvas: CanvasRenderingContext2D | null | undefined
/** Column widths at scale 1 from the widest sample value of each column (text width + padding, clamped). */
export function columnWidths(samples: readonly string[], columns: number, font: string): number[] {
	if (measureCanvas === undefined) measureCanvas = document.createElement('canvas').getContext('2d')
	if (measureCanvas) measureCanvas.font = font
	const widths: number[] = []
	for (let column = 0; column < columns; column++) {
		const sample = samples[column]
		if (sample === undefined) {
			widths.push(DEFAULT_COL_W)
			continue
		}
		// Cells use tabular figures, which a canvas cannot measure: every digit is as wide as a zero there.
		const text = sample.replace(/[0-9]/g, '0')
		const width = measureCanvas ? measureCanvas.measureText(text).width : text.length * 7
		// 16px padding, 1px rule and a few pixels for rounding.
		widths.push(Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, Math.ceil(width) + 22))))
	}
	return widths
}

export interface CsvGridStatus {
	/** `B12 · Amount` or `A2:D9`. */
	position: string
	/** Count, Sum, copy results. */
	facts: string[]
}

export interface CsvGridHandle {
	openFind(): void
	copy(): void
	selectAll(): void
}

export interface CsvGridProps {
	name: string
	client: CsvClient
	rows: number
	columns: number
	samples: readonly string[]
	/** The first row is a header: it stays under the column letters. */
	header: boolean
	zoom: number
	onStatus(status: CsvGridStatus): void
	handle?: RefObject<CsvGridHandle | null>
	/** Story/test seam: a selection to open with. */
	initialSelection?: Selection
}

/** Rows of one block, and the worker that answered (a live reload's new worker replaces them as they arrive). */
type Block = { rows: string[][]; size: number; client: CsvClient }

export function CsvGrid({
	name,
	client,
	rows,
	columns,
	samples,
	header,
	zoom,
	onStatus,
	handle,
	initialSelection,
}: CsvGridProps) {
	const scroller = useRef<HTMLDivElement>(null)
	const content = useRef<HTMLDivElement>(null)
	const field = useRef<HTMLInputElement>(null)
	const statusRef = useRef(onStatus)
	statusRef.current = onStatus

	// Cells are sized here, not in CSS, so the grid applies the cockpit's UI scale itself (§9 ruling 108).
	const scale = gridScale(zoom * useDocumentUiScale(), rows)
	const rowH = Math.round(ROW_H * scale)
	const headH = rowH
	const fontSize = Math.round(12 * scale * 100) / 100
	const first = header && rows > 0 ? 1 : 0
	const bodyRows = Math.max(0, rows - first)
	const bandH = first ? rowH : 0
	const top = headH + bandH

	// Column widths: measured once per sample set at scale 1, then scaled.
	const baseWidths = useMemo(() => {
		const family = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'
		return columnWidths(samples, columns, `12px ${family}`)
	}, [samples, columns])
	const widths = useMemo(() => baseWidths.map(width => Math.round(width * scale)), [baseWidths, scale])
	const rowHeadW = Math.round(Math.max(40, String(rows).length * 7 + 16) * scale)
	const colStarts = useMemo(() => {
		const starts = [rowHeadW]
		for (const width of widths) starts.push((starts[starts.length - 1] ?? 0) + width)
		return starts
	}, [widths, rowHeadW])
	const totalW = colStarts[colStarts.length - 1] ?? rowHeadW
	const totalH = top + bodyRows * rowH

	const rowVirtual = useVirtualizer({
		count: bodyRows,
		getScrollElement: () => scroller.current,
		estimateSize: () => rowH,
		paddingStart: top,
		overscan: 8,
		useFlushSync: false,
	})
	const colVirtual = useVirtualizer({
		horizontal: true,
		count: columns,
		getScrollElement: () => scroller.current,
		estimateSize: index => widths[index] ?? DEFAULT_COL_W,
		paddingStart: rowHeadW,
		overscan: 3,
		useFlushSync: false,
	})
	// Sizes change with zoom, samples and the header row.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these change every item's size or offset.
	useEffect(() => {
		rowVirtual.measure()
		colVirtual.measure()
	}, [rowH, widths, top, rowHeadW])
	const items = rowVirtual.getVirtualItems()
	const cols = colVirtual.getVirtualItems()

	// ---- rows from the worker, in blocks ----
	const cache = useRef(new Map<number, Block>())
	const asked = useRef(new Map<number, number>())
	const [, setArrived] = useState(0)
	// A new worker (live reload) asks again; the old rows stay on screen until the new ones arrive.
	const cacheClient = useRef(client)
	if (cacheClient.current !== client) {
		cacheClient.current = client
		asked.current = new Map()
	}
	const firstRow = (items[0]?.index ?? 0) + first
	const lastRow = (items[items.length - 1]?.index ?? -1) + first
	const lastBlock = Math.floor(Math.max(lastRow, 0) / BLOCK)
	/** The blocks on screen (and the header's): never evicted while they are. */
	const wantedBlocks = useRef(new Set<number>())
	useEffect(() => {
		const wanted: number[] = []
		if (first) wanted.push(0)
		for (let block = Math.floor(firstRow / BLOCK); block <= lastBlock; block++) wanted.push(block)
		wantedBlocks.current = new Set(wanted)
		for (const block of wanted) {
			const size = Math.min(BLOCK, rows - block * BLOCK)
			if (size <= 0) continue
			const have = cache.current.get(block)
			const pending = asked.current.get(block)
			if (have) {
				// Least recently shown goes first.
				cache.current.delete(block)
				cache.current.set(block, have)
			}
			if ((have && have.size >= size && have.client === client) || (pending !== undefined && pending >= size)) continue
			asked.current.set(block, size)
			void client.rows(block * BLOCK, size).then(response => {
				if (cacheClient.current !== client) return
				if (asked.current.get(block) === size) asked.current.delete(block)
				if (response.type !== 'rows') return
				cache.current.delete(block)
				cache.current.set(block, { rows: response.rows, size: response.rows.length, client })
				for (const key of cache.current.keys()) {
					if (cache.current.size <= BLOCK_CACHE) break
					if (key !== block && !wantedBlocks.current.has(key)) cache.current.delete(key)
				}
				setArrived(value => value + 1)
			})
		}
	}, [client, rows, firstRow, lastBlock, first])
	const valuesOf = (row: number): string[] | undefined => cache.current.get(Math.floor(row / BLOCK))?.rows[row % BLOCK]

	// ---- selection ----
	const [selection, setSelectionState] = useState<Selection>(initialSelection ?? ORIGIN)
	const selectionRef = useRef(selection)
	selectionRef.current = selection
	const clampPos = useCallback(
		(pos: Pos): Pos => ({
			r: Math.max(0, Math.min(Math.max(0, rows - 1), pos.r)),
			c: Math.max(0, Math.min(Math.max(0, columns - 1), pos.c)),
		}),
		[rows, columns],
	)
	const setSelection = useCallback(
		(next: Selection) => setSelectionState({ anchor: clampPos(next.anchor), focus: clampPos(next.focus) }),
		[clampPos],
	)
	// A reload with fewer rows or columns keeps the selection inside the file.
	useEffect(() => {
		const current = selectionRef.current
		const anchor = clampPos(current.anchor)
		const focus = clampPos(current.focus)
		if (
			anchor.r !== current.anchor.r ||
			anchor.c !== current.anchor.c ||
			focus.r !== current.focus.r ||
			focus.c !== current.focus.c
		)
			setSelectionState({ anchor, focus })
	}, [clampPos])
	const range = normalize(selection)

	const ensureVisible = useCallback(
		(pos: Pos) => {
			const element = scroller.current
			if (!element) return
			// The header band is always on screen: going to it shows the first body row under it.
			const y = top + (Math.max(pos.r, first) - first) * rowH
			if (y < element.scrollTop + top) element.scrollTop = y - top
			else if (y + rowH > element.scrollTop + element.clientHeight) element.scrollTop = y + rowH - element.clientHeight
			const left = colStarts[pos.c] ?? 0
			const right = colStarts[pos.c + 1] ?? totalW
			if (left < element.scrollLeft + rowHeadW) element.scrollLeft = left - rowHeadW
			else if (right > element.scrollLeft + element.clientWidth)
				element.scrollLeft = Math.min(left - rowHeadW, right - element.clientWidth)
		},
		[first, top, rowH, colStarts, totalW, rowHeadW],
	)
	const opened = useRef(false)
	useEffect(() => {
		if (opened.current || !initialSelection || rows === 0) return
		opened.current = true
		ensureVisible(initialSelection.focus)
	}, [initialSelection, ensureVisible, rows])

	const cellAt = useCallback(
		(clientX: number, clientY: number): Pos => {
			const box = content.current?.getBoundingClientRect()
			const view = scroller.current?.getBoundingClientRect()
			if (!box || !view) return { r: 0, c: 0 }
			const x = clientX - box.left
			// The header band stays under the letters wherever the grid is scrolled.
			const inBand = first && clientY >= view.top + headH && clientY < view.top + top
			const r = inBand ? 0 : first + Math.floor((clientY - box.top - top) / rowH)
			let lo = 0
			let hi = Math.max(0, columns - 1)
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1
				if ((colStarts[mid] ?? 0) <= x) lo = mid
				else hi = mid - 1
			}
			return clampPos({ r, c: lo })
		},
		[first, headH, top, rowH, columns, colStarts, clampPos],
	)

	// Pointer: press, drag (scrolling past the edges), release. Column letters pick columns, numbers pick rows.
	const drag = useRef<{ x: number; y: number; frame: number } | null>(null)
	const stopDrag = useRef<(() => void) | null>(null)
	const startDrag = (event: ReactMouseEvent, mode: 'cell' | 'row' | 'column' | 'all') => {
		if (event.button !== 0) return
		event.preventDefault()
		scroller.current?.focus({ preventScroll: true })
		const lastR = Math.max(0, rows - 1)
		const lastC = Math.max(0, columns - 1)
		const shaped = (anchor: Pos, focus: Pos): Selection =>
			mode === 'row'
				? { anchor: { r: anchor.r, c: 0 }, focus: { r: focus.r, c: lastC } }
				: mode === 'column'
					? { anchor: { r: 0, c: anchor.c }, focus: { r: lastR, c: focus.c } }
					: mode === 'all'
						? { anchor: { r: 0, c: 0 }, focus: { r: lastR, c: lastC } }
						: { anchor, focus }
		const pos = cellAt(event.clientX, event.clientY)
		const anchor = event.shiftKey ? selectionRef.current.anchor : pos
		setSelection(shaped(anchor, pos))
		if (mode === 'all') return
		// A press on the letters, the numbers or the header band sits past an edge already: that edge scrolls only
		// once the pointer has been inside the body. Column picks never scroll rows, row picks never columns.
		const start = scroller.current?.getBoundingClientRect()
		const armed = {
			left: !start || event.clientX >= start.left + rowHeadW,
			up: !start || event.clientY >= start.top + top,
		}
		const tick = () => {
			const state = drag.current
			const element = scroller.current
			if (!state || !element) return
			const view = element.getBoundingClientRect()
			if (state.x >= view.left + rowHeadW) armed.left = true
			if (state.y >= view.top + top) armed.up = true
			let dx = 0
			let dy = 0
			if (mode !== 'row') {
				if (armed.left && state.x < view.left + rowHeadW) dx = -rowH
				else if (state.x > view.left + element.clientWidth) dx = rowH
			}
			if (mode !== 'column') {
				if (armed.up && state.y < view.top + top) dy = -rowH
				else if (state.y > view.top + element.clientHeight) dy = rowH
			}
			if (dx || dy) {
				element.scrollLeft += dx
				element.scrollTop += dy
				setSelection(shaped(anchor, cellAt(state.x, state.y)))
			}
			state.frame = requestAnimationFrame(tick)
		}
		drag.current = { x: event.clientX, y: event.clientY, frame: requestAnimationFrame(tick) }
		const move = (moveEvent: MouseEvent) => {
			const state = drag.current
			if (!state) return
			state.x = moveEvent.clientX
			state.y = moveEvent.clientY
			setSelection(shaped(anchor, cellAt(moveEvent.clientX, moveEvent.clientY)))
		}
		const up = () => {
			window.removeEventListener('mousemove', move)
			window.removeEventListener('mouseup', up)
			if (drag.current) cancelAnimationFrame(drag.current.frame)
			drag.current = null
			stopDrag.current = null
		}
		window.addEventListener('mousemove', move)
		window.addEventListener('mouseup', up)
		stopDrag.current = up
	}
	useEffect(() => () => stopDrag.current?.(), [])

	// ---- status: position, active value, Count/Sum ----
	const [cellValue, setValue] = useState<{ r: number; c: number; text: string; truncated: boolean } | null>(null)
	const anchorR = selection.anchor.r
	const anchorC = selection.anchor.c
	// Only the active cell's own value: a previous cell's never shows next to the new reference.
	const value = cellValue && cellValue.r === anchorR && cellValue.c === anchorC ? cellValue : null
	useEffect(() => {
		let live = true
		if (rows === 0) {
			setValue(null)
			return
		}
		void client.cell(anchorR, anchorC).then(response => {
			if (live && response.type === 'cell')
				setValue({ r: anchorR, c: anchorC, text: response.value ?? '', truncated: response.truncated })
		})
		return () => {
			live = false
		}
	}, [client, anchorR, anchorC, rows])
	const headerNames = useRef<string[]>([])
	headerNames.current = first ? (valuesOf(0) ?? headerNames.current) : []
	const [note, setNote] = useState('')
	const [stats, setStats] = useState<string[]>([])
	const single = range.r0 === range.r1 && range.c0 === range.c1
	// biome-ignore lint/correctness/useExhaustiveDependencies: the range's bounds are the inputs.
	useEffect(() => {
		setNote('')
		setStats([])
		if (single || rows === 0) return
		let live = true
		const timer = window.setTimeout(() => {
			void client.stats(range).then(response => {
				if (!live || response.type !== 'stats') return
				if (response.count === null) setStats([])
				else
					setStats([
						...(response.numbers > 0 ? [`Sum ${grouped(response.sum)}`] : []),
						`Count ${response.count.toLocaleString('en-US')}`,
					])
			})
		}, 120)
		return () => {
			live = false
			window.clearTimeout(timer)
		}
	}, [client, range.r0, range.r1, range.c0, range.c1, single, rows])
	const columnHeader = single && first && range.r0 > 0 ? headerNames.current[range.c0] : undefined
	const position =
		rows === 0 ? '' : `${rangeRef(range)}${columnHeader ? ` · ${columnHeader.replace(/ ↵ /g, ' ')}` : ''}`
	useEffect(() => {
		statusRef.current({ position, facts: note ? [note, ...stats] : stats })
	}, [position, note, stats])

	// ---- copy as TSV ----
	const writing = useRef(false)
	const copyRange = useCallback(() => {
		if (rows === 0) return
		const target = normalize(selectionRef.current)
		void client.copy(target).then(response => {
			if (response.type !== 'copy') return
			if (response.text === null) {
				setNote(`Too many cells to copy (${response.cells.toLocaleString('en-US')}; up to 200,000)`)
				return
			}
			const text = response.text
			const write = (event: ClipboardEvent) => {
				event.preventDefault()
				event.stopImmediatePropagation()
				event.clipboardData?.setData('text/plain', text)
			}
			// The worker answered asynchronously: fire the copy again while the key press's user activation lasts
			// (clipboard permissions are denied in viewer windows).
			writing.current = true
			document.addEventListener('copy', write, { once: true, capture: true })
			const copied = document.execCommand('copy')
			document.removeEventListener('copy', write, { capture: true })
			writing.current = false
			setNote(
				copied
					? `Copied ${response.cells === 1 ? 'a cell' : `${response.cells.toLocaleString('en-US')} cells`} as TSV`
					: 'Copy failed',
			)
		})
	}, [client, rows])

	// ---- find ----
	const [searchOpen, setSearchOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [matches, setMatches] = useState<[number, number][]>([])
	const [matchIndex, setMatchIndex] = useState(0)
	const [truncated, setTruncated] = useState(false)
	const [pending, setPending] = useState(false)
	const goTo = useCallback(
		(pos: Pos) => {
			setSelection({ anchor: pos, focus: pos })
			// Rows may still be arriving: scroll once the selection is set.
			requestAnimationFrame(() => ensureVisible(pos))
		},
		[setSelection, ensureVisible],
	)
	const searched = useRef('')
	const matchIndexRef = useRef(matchIndex)
	matchIndexRef.current = matchIndex
	const matchesRef = useRef(matches)
	matchesRef.current = matches
	// More rows (while reading) rerun the query; the current match stays when it still matches.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `rows` is the trigger, not an input.
	useEffect(() => {
		if (!searchOpen) return
		if (!query) {
			searched.current = ''
			setMatches([])
			setTruncated(false)
			setPending(false)
			return
		}
		let live = true
		const timer = window.setTimeout(() => {
			void client.search(query).then(response => {
				if (!live || response.type !== 'search') return
				const rerun = searched.current === query
				searched.current = query
				setPending(false)
				setTruncated(response.truncated)
				if (rerun) {
					const current = matchesRef.current[matchIndexRef.current]
					const kept = current ? response.matches.findIndex(([r, c]) => r === current[0] && c === current[1]) : -1
					setMatchIndex(Math.max(0, kept))
				} else {
					setMatchIndex(0)
					const [r, c] = response.matches[0] ?? []
					if (r !== undefined && c !== undefined) goTo({ r, c })
				}
				setMatches(response.matches)
			})
		}, 150)
		return () => {
			live = false
			window.clearTimeout(timer)
		}
	}, [client, query, searchOpen, rows, goTo])
	const matchSet = useMemo(() => new Set(matches.map(([r, c]) => `${r}:${c}`)), [matches])
	const step = (delta: number) => {
		if (!matches.length) return
		const index = (matchIndex + delta + matches.length) % matches.length
		setMatchIndex(index)
		const [r, c] = matches[index] ?? []
		if (r !== undefined && c !== undefined) goTo({ r, c })
	}
	const stepRef = useRef(step)
	stepRef.current = step
	const openFind = useCallback(() => {
		setSearchOpen(true)
		requestAnimationFrame(() => {
			field.current?.focus()
			field.current?.select()
		})
	}, [])
	const closeFind = () => {
		setSearchOpen(false)
		setQuery('')
		setMatches([])
		setTruncated(false)
		searched.current = ''
		scroller.current?.focus({ preventScroll: true })
	}
	const selectAll = useCallback(() => {
		setSelection({ anchor: { r: 0, c: 0 }, focus: { r: rows - 1, c: columns - 1 } })
	}, [setSelection, rows, columns])
	useImperativeHandle(handle, () => ({ openFind, copy: copyRange, selectAll }), [openFind, copyRange, selectAll])

	// ⌘F / ⌘G / ⇧⌘G from anywhere in the window.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return
			const key = event.key.toLowerCase()
			if (key === 'f' && !event.shiftKey) {
				event.preventDefault()
				openFind()
			} else if (key === 'g') {
				event.preventDefault()
				stepRef.current(event.shiftKey ? -1 : 1)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [openFind])

	// ---- keys ----
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget || rows === 0) return
		const { anchor, focus } = selection
		const lastR = rows - 1
		const lastC = Math.max(0, columns - 1)
		const meta = event.metaKey || event.ctrlKey
		const page = Math.max(1, Math.floor(((scroller.current?.clientHeight ?? 0) - top) / rowH) - 1)
		const key = event.key
		if (meta && !event.altKey && key.toLowerCase() === 'a') {
			event.preventDefault()
			selectAll()
			return
		}
		if (meta && !event.altKey && !event.shiftKey && key.toLowerCase() === 'c') {
			event.preventDefault()
			copyRange()
			return
		}
		if (event.altKey) return
		const from = event.shiftKey ? focus : anchor
		let to: Pos | null = null
		switch (key) {
			case 'ArrowUp':
				to = { r: meta ? 0 : from.r - 1, c: from.c }
				break
			case 'ArrowDown':
				to = { r: meta ? lastR : from.r + 1, c: from.c }
				break
			case 'ArrowLeft':
				to = { r: from.r, c: meta ? 0 : from.c - 1 }
				break
			case 'ArrowRight':
			case 'Tab':
				if (key === 'Tab' && (event.shiftKey || meta)) return
				to = { r: from.r, c: meta ? lastC : from.c + 1 }
				break
			case 'Enter':
				to = { r: from.r + (event.shiftKey ? -1 : 1), c: from.c }
				break
			case 'Home':
				to = meta ? { r: 0, c: 0 } : { r: from.r, c: 0 }
				break
			case 'End':
				to = meta ? { r: lastR, c: lastC } : { r: from.r, c: lastC }
				break
			case 'PageUp':
				to = { r: from.r - page, c: from.c }
				break
			case 'PageDown':
				to = { r: from.r + page, c: from.c }
				break
			case ' ':
				to = { r: from.r + (event.shiftKey ? -page : page), c: from.c }
				break
			case 'Escape':
				if (anchor.r !== focus.r || anchor.c !== focus.c) {
					event.preventDefault()
					setSelection({ anchor, focus: anchor })
				}
				return
			default:
				return
		}
		event.preventDefault()
		const target = clampPos(to)
		const extend = event.shiftKey && key !== 'Enter' && key !== ' '
		if (extend) setSelection({ anchor, focus: target })
		else setSelection({ anchor: target, focus: target })
		ensureVisible(target)
	}
	const onCopy = (event: ReactClipboardEvent) => {
		// Edit → Copy (or a copy event from anywhere in the grid): answer with the range as TSV.
		if (writing.current) return
		event.preventDefault()
		copyRange()
	}

	// ---- paint ----
	const box = (target: CellRange) => {
		const y0 = Math.max(target.r0, first)
		return {
			left: colStarts[target.c0] ?? 0,
			top: top + (y0 - first) * rowH,
			width: (colStarts[target.c1 + 1] ?? totalW) - (colStarts[target.c0] ?? 0),
			height: (target.r1 - y0 + 1) * rowH,
		}
	}
	const bodyRange = range.r1 >= first ? range : null
	const bandSelected = first && range.r0 === 0
	const currentMatch = matches[matchIndex]
	const cellClass = (row: number, column: number, text: string | undefined) => {
		let name = 'viewer-grid-cell'
		if (text && alignRight(text)) name += ' is-number'
		if (matchSet.has(`${row}:${column}`)) {
			name += ' is-match'
			if (currentMatch && currentMatch[0] === row && currentMatch[1] === column) name += ' is-current-match'
		}
		return name
	}
	const renderCells = (row: number, y: number) => {
		const values = valuesOf(row)
		return cols.map(col => {
			const text = values?.[col.index]
			return (
				<div
					key={`${row}:${col.index}`}
					className={cellClass(row, col.index, text)}
					style={{ top: y, left: col.start, width: col.size, height: rowH, lineHeight: `${rowH - 1}px` }}
				>
					{text}
				</div>
			)
		})
	}
	const announceId = useId()
	const label = `${name}, ${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}, ${columns.toLocaleString('en-US')} ${columns === 1 ? 'column' : 'columns'}`
	const activeValue = value ? value.text.replace(/\r\n|\r|\n/g, ' ↵ ') + (value.truncated ? '…' : '') : ''
	// The one announcement per move: the range and the start of its value, never a 100,000-character string.
	const spoken = activeValue.length > ANNOUNCE_CHARS ? `${activeValue.slice(0, ANNOUNCE_CHARS)}…` : activeValue

	return (
		<div className="viewer-grid" style={{ fontSize }}>
			{searchOpen && (
				// biome-ignore lint/a11y/useSemanticElements: React's DOM types have no <search> element yet.
				<div role="search" className="viewer-search" aria-label="Find in cells">
					<input
						ref={field}
						type="search"
						className="viewer-search-field"
						placeholder="Find in cells"
						aria-label="Find in cells"
						value={query}
						spellCheck={false}
						onChange={event => {
							setQuery(event.target.value)
							setPending(Boolean(event.target.value))
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
						{!query
							? ''
							: pending
								? 'Searching…'
								: matches.length
									? `${matchIndex + 1} of ${matches.length.toLocaleString('en-US')}${truncated ? '+' : ''}`
									: 'No matches'}
					</output>
					<Btn sm tone="ghost" disabled={!matches.length} onClick={() => step(-1)}>
						Previous
					</Btn>
					<Btn sm tone="ghost" disabled={!matches.length} onClick={() => step(1)}>
						Next
					</Btn>
					<Btn sm tone="ghost" ariaLabel="Close find" onClick={closeFind}>
						×
					</Btn>
					{query && truncated && (
						<span className="viewer-grid-search-note">
							Showing the first {MATCH_LIMIT.toLocaleString('en-US')} matches
						</span>
					)}
				</div>
			)}
			<div className="viewer-grid-bar">
				<span className="viewer-grid-ref" aria-label="Selected range">
					{rows > 0 ? rangeRef(range) : ''}
				</span>
				<output
					className="viewer-grid-value"
					aria-label="Value"
					aria-live="off"
					title={value ? value.text.slice(0, TITLE_CHARS) : undefined}
				>
					{activeValue}
				</output>
			</div>
			<div
				ref={scroller}
				className="viewer-grid-scroll"
				// Not role=grid: the virtual cells carry no row/cell semantics, so a screen reader would find an empty grid.
				// The keys pass through to the grid, and the active range and value are announced from the line below.
				role="application"
				aria-roledescription="table"
				aria-label={label}
				aria-describedby={announceId}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the grid takes the keys (arrows, ⌘A, ⌘C, Page keys).
				tabIndex={0}
				onKeyDown={onKeyDown}
				onCopy={onCopy}
			>
				<div ref={content} className="viewer-grid-content" style={{ width: totalW, height: totalH }}>
					<div className="viewer-grid-letters" style={{ width: totalW, height: headH }}>
						<div
							className="viewer-grid-corner"
							style={{ width: rowHeadW, height: headH }}
							onMouseDown={event => startDrag(event, 'all')}
						/>
						{cols.map(col => (
							<div
								key={col.index}
								className="viewer-grid-letter"
								data-selected={(col.index >= range.c0 && col.index <= range.c1) || undefined}
								style={{ left: col.start, width: col.size, height: headH }}
								onMouseDown={event => startDrag(event, 'column')}
							>
								{columnName(col.index)}
							</div>
						))}
					</div>
					{first ? (
						<div className="viewer-grid-band" style={{ top: headH, width: totalW, height: rowH }}>
							<div
								className="viewer-grid-number"
								data-selected={bandSelected || undefined}
								style={{ width: rowHeadW, height: rowH, lineHeight: `${rowH - 1}px` }}
								onMouseDown={event => startDrag(event, 'row')}
							>
								1
							</div>
							<div className="viewer-grid-band-cells" onMouseDown={event => startDrag(event, 'cell')}>
								{renderCells(0, 0)}
							</div>
							{bandSelected && (
								<div
									className={`viewer-grid-selection${range.r1 === 0 ? '' : ' is-open-bottom'}`}
									style={{
										left: colStarts[range.c0] ?? 0,
										top: 0,
										width: (colStarts[range.c1 + 1] ?? totalW) - (colStarts[range.c0] ?? 0),
										height: rowH,
									}}
								/>
							)}
							{selection.anchor.r === 0 && (
								<div
									className="viewer-grid-active"
									style={{
										left: colStarts[selection.anchor.c] ?? 0,
										top: 0,
										width: (colStarts[selection.anchor.c + 1] ?? totalW) - (colStarts[selection.anchor.c] ?? 0),
										height: rowH,
									}}
								/>
							)}
						</div>
					) : null}
					<div className="viewer-grid-numbers" style={{ width: rowHeadW, height: bodyRows * rowH }}>
						{items.map(item => {
							const row = item.index + first
							return (
								<div
									key={row}
									className="viewer-grid-number"
									data-selected={(row >= range.r0 && row <= range.r1) || undefined}
									style={{ top: item.start - top, height: rowH, lineHeight: `${rowH - 1}px` }}
									onMouseDown={event => startDrag(event, 'row')}
								>
									{(row + 1).toLocaleString('en-US')}
								</div>
							)
						})}
					</div>
					<div className="viewer-grid-cells" onMouseDown={event => startDrag(event, 'cell')}>
						{items.map(item => renderCells(item.index + first, item.start))}
					</div>
					{bodyRange && rows > 0 && (
						<div className={`viewer-grid-selection${bandSelected ? ' is-open-top' : ''}`} style={box(bodyRange)} />
					)}
					{rows > 0 && selection.anchor.r >= first && (
						<div
							className="viewer-grid-active"
							style={box({
								r0: selection.anchor.r,
								r1: selection.anchor.r,
								c0: selection.anchor.c,
								c1: selection.anchor.c,
							})}
						/>
					)}
				</div>
			</div>
			<span id={announceId} className="viewer-grid-hidden" aria-live="polite">
				{rows > 0 ? `${rangeRef(range)} ${spoken}` : ''}
			</span>
		</div>
	)
}

function grouped(value: number): string {
	const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100
	const [whole, fraction] = String(Math.abs(rounded)).split('.')
	const digits = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
	return `${rounded < 0 ? '−' : ''}${digits}${fraction ? `.${fraction}` : ''}`
}
