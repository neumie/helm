// The JSON / JSON Lines / YAML / TOML tree of a plain `helm open` window (docs/plans/helm-open/spec.md, S2). The
// file is parsed in a dedicated worker; this view only asks it for the visible rows of an expansion set, for search
// matches and for a node's JSON. The tree is virtualised, so a 30 MiB file mounts only what is on screen.
import { useVirtualizer } from '@tanstack/react-virtual'
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from 'react'
import type { DataLanguage } from '../../../../src/document-review/formats'
import { Btn } from '../button'
import { DataClient } from './data-client'
import { CHILD_LIMIT, type DataRow, MATCH_LIMIT, ROW_LIMIT, ancestors } from './data-model'

export interface DataViewProps {
	text: string
	language: DataLanguage
	/** Reading zoom; rows are re-measured when it changes. */
	zoom: number
	/** False while the window shows the raw source instead: window keys then belong to the code view. */
	active?: boolean
	/** Bumped to open search (the window menu's Find). */
	find?: number
	/** The worker's parse result: null parsed, else the parser's first line. */
	onParsed?(error: string | null): void
	/** Status-line text: the focused node's JSON Pointer, a copy result. */
	onStatus?(status: string): void
	/** Test seam: the worker to talk to (defaults to the bundled data worker). */
	createClient?: () => DataClient
}

type Load = { kind: 'loading' } | { kind: 'failed'; error: string } | { kind: 'ready' }
interface SearchState {
	query: string
	matches: string[]
	index: number
	truncated: boolean
	pending: boolean
}
const NO_SEARCH: SearchState = { query: '', matches: [], index: 0, truncated: false, pending: false }

const parentOf = (pointer: string) => (pointer ? pointer.slice(0, pointer.lastIndexOf('/')) : null)
const pointerLabel = (pointer: string) => (pointer ? `JSON Pointer ${pointer}` : 'Root')

export function DataTree({
	text,
	language,
	zoom,
	active = true,
	find = 0,
	onParsed,
	onStatus,
	createClient,
}: DataViewProps) {
	const client = useRef<DataClient | null>(null)
	const [load, setLoad] = useState<Load>({ kind: 'loading' })
	const [rows, setRows] = useState<DataRow[]>([])
	const [truncated, setTruncated] = useState(false)
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['']))
	const [focused, setFocused] = useState('')
	const [searchOpen, setSearchOpen] = useState(false)
	const [found, setFound] = useState<SearchState>(NO_SEARCH)
	const scroller = useRef<HTMLDivElement>(null)
	const tree = useRef<HTMLDivElement>(null)
	const field = useRef<HTMLInputElement>(null)
	const opened = useRef(0)
	const rowsAsked = useRef(0)
	const id = useId()
	const parsedRef = useRef(onParsed)
	parsedRef.current = onParsed
	const statusRef = useRef(onStatus)
	statusRef.current = onStatus
	const makeClient = useRef(createClient)

	useEffect(() => {
		const worker = makeClient.current?.() ?? new DataClient()
		client.current = worker
		return () => {
			worker.close()
			client.current = null
		}
	}, [])

	// Parse (again on live reload); expansion, focus and search stay, so a reload keeps the reader's place.
	useEffect(() => {
		const worker = client.current
		if (!worker) return
		const ticket = ++opened.current
		void worker.open(text, language).then(response => {
			if (ticket !== opened.current) return
			if (response.type === 'opened') {
				parsedRef.current?.(response.error)
				setLoad(response.error ? { kind: 'failed', error: response.error } : { kind: 'ready' })
			} else if (response.type === 'failed' && response.error !== 'closed') {
				parsedRef.current?.(response.error)
				setLoad({ kind: 'failed', error: response.error })
			}
		})
	}, [text, language])

	useEffect(() => {
		const worker = client.current
		if (!worker || load.kind !== 'ready') return
		const ticket = ++rowsAsked.current
		void worker.rows(expanded).then(response => {
			if (ticket !== rowsAsked.current || response.type !== 'rows') return
			setRows(response.rows)
			setTruncated(response.truncated)
		})
	}, [expanded, load])

	const indexOf = useMemo(() => {
		const map = new Map<string, number>()
		rows.forEach((row, index) => map.set(row.pointer, index))
		return map
	}, [rows])
	const focusIndex = indexOf.get(focused) ?? 0
	const matchSet = useMemo(() => new Set(found.matches), [found.matches])
	const current = found.matches[found.index] ?? null

	const virtual = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scroller.current,
		estimateSize: () => Math.round(22 * zoom),
		overscan: 24,
	})
	// biome-ignore lint/correctness/useExhaustiveDependencies: zoom changes every row's height.
	useEffect(() => {
		virtual.measure()
	}, [zoom])

	useEffect(() => {
		const row = rows[focusIndex]
		if (row)
			statusRef.current?.(
				row.kind === 'more' ? `${pointerLabel(parentOf(row.pointer) ?? '')}` : pointerLabel(row.pointer),
			)
	}, [rows, focusIndex])

	const focusRow = useCallback(
		(index: number) => {
			const row = rows[Math.max(0, Math.min(rows.length - 1, index))]
			if (!row) return
			setFocused(row.pointer)
			virtual.scrollToIndex(indexOf.get(row.pointer) ?? 0, { align: 'auto' })
		},
		[rows, indexOf, virtual],
	)

	const toggle = (pointer: string, open?: boolean) =>
		setExpanded(previous => {
			const next = new Set(previous)
			if (open ?? !next.has(pointer)) next.add(pointer)
			else next.delete(pointer)
			return next
		})

	// Reveal a match: expand its ancestors, focus it, and scroll to it once its row exists.
	const reveal = useRef<string | null>(null)
	// Bumped on every reveal: a match whose ancestors are already open changes no rows, yet must still scroll.
	const [revealTick, setRevealTick] = useState(0)
	const revealMatch = (pointer: string) => {
		reveal.current = pointer
		setRevealTick(tick => tick + 1)
		setExpanded(previous => {
			const needed = ancestors(pointer).filter(item => !previous.has(item))
			if (!needed.length) return previous
			return new Set([...previous, ...needed])
		})
		setFocused(pointer)
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: revealTick is the trigger; the pointer is in a ref.
	useEffect(() => {
		const pointer = reveal.current
		if (pointer === null) return
		const index = indexOf.get(pointer)
		if (index === undefined) return
		reveal.current = null
		virtual.scrollToIndex(index, { align: 'center' })
	}, [indexOf, virtual, revealTick])

	// Search runs in the worker, 150 ms after the last keystroke. A new parse (load) reruns the same query quietly:
	// the current match stays current when it still matches and nothing moves, so a reload keeps the reader's place.
	// revealMatch only writes state setters and a ref, so it never needs to rerun the search.
	const searched = useRef('')
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above.
	useEffect(() => {
		const worker = client.current
		if (!worker || !searchOpen || load.kind !== 'ready') return
		const query = found.query
		if (!query) {
			searched.current = ''
			setFound(value => (value.matches.length || value.pending ? { ...NO_SEARCH, query: value.query } : value))
			return
		}
		let live = true
		const timer = window.setTimeout(() => {
			void worker.search(query).then(response => {
				if (!live || response.type !== 'search') return
				const rerun = searched.current === query
				searched.current = query
				if (rerun) {
					setFound(value => {
						const kept = response.matches.indexOf(value.matches[value.index] ?? '')
						return {
							query,
							matches: response.matches,
							index: Math.max(0, kept),
							truncated: response.truncated,
							pending: false,
						}
					})
					return
				}
				setFound({ query, matches: response.matches, index: 0, truncated: response.truncated, pending: false })
				const first = response.matches[0]
				if (first !== undefined) revealMatch(first)
			})
		}, 150)
		return () => {
			live = false
			window.clearTimeout(timer)
		}
	}, [found.query, searchOpen, load])

	const step = (delta: number) => {
		if (!found.matches.length) return
		const index = (found.index + delta + found.matches.length) % found.matches.length
		setFound(value => ({ ...value, index }))
		const pointer = found.matches[index]
		if (pointer !== undefined) revealMatch(pointer)
	}
	const stepRef = useRef(step)
	stepRef.current = step

	const openSearch = () => {
		setSearchOpen(true)
		requestAnimationFrame(() => {
			field.current?.focus()
			field.current?.select()
		})
	}
	const openRef = useRef(openSearch)
	openRef.current = openSearch
	const closeSearch = () => {
		setSearchOpen(false)
		setFound(NO_SEARCH)
		searched.current = ''
		tree.current?.focus({ preventScroll: true })
	}

	useEffect(() => {
		if (find) openRef.current()
	}, [find])

	// ⌘F / ⌘G / ⇧⌘G from anywhere in the window.
	useEffect(() => {
		if (!active) return
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return
			const key = event.key.toLowerCase()
			if (key === 'f' && !event.shiftKey) {
				event.preventDefault()
				openRef.current()
			} else if (key === 'g') {
				event.preventDefault()
				stepRef.current(event.shiftKey ? -1 : 1)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [active])

	// ⌘C copies the focused node as JSON. The worker answers asynchronously, so the copy event is re-fired with
	// execCommand while the keydown's user activation lasts (clipboard permission is denied in viewer windows).
	const copyNode = (pointer: string) => {
		const worker = client.current
		if (!worker) return
		void worker.copy(pointer).then(response => {
			if (response.type !== 'copy') return
			if (response.text === null) {
				statusRef.current?.('Too large to copy as JSON (over 4 MiB)')
				return
			}
			const json = response.text
			const write = (event: ClipboardEvent) => {
				event.preventDefault()
				event.clipboardData?.setData('text/plain', json)
			}
			document.addEventListener('copy', write, { once: true, capture: true })
			const copied = document.execCommand('copy')
			document.removeEventListener('copy', write, { capture: true })
			statusRef.current?.(copied ? `Copied ${pointerLabel(pointer)} as JSON` : 'Copy failed')
		})
	}

	const onTreeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const row = rows[focusIndex]
		if (!row) return
		const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / Math.round(22 * zoom)) - 1)
		const meta = event.metaKey || event.ctrlKey
		if (meta && event.key.toLowerCase() === 'c' && !event.shiftKey && !event.altKey) {
			const selection = window.getSelection()
			if (selection && !selection.isCollapsed && tree.current?.contains(selection.anchorNode)) return
			event.preventDefault()
			if (row.kind !== 'more') copyNode(row.pointer)
			return
		}
		if (meta && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
			event.preventDefault()
			focusRow(event.key === 'ArrowUp' ? 0 : rows.length - 1)
			return
		}
		if (meta || event.altKey) return
		let handled = true
		switch (event.key) {
			case 'ArrowDown':
			case 'j':
				focusRow(focusIndex + 1)
				break
			case 'ArrowUp':
			case 'k':
				focusRow(focusIndex - 1)
				break
			case 'Home':
				focusRow(0)
				break
			case 'End':
				focusRow(rows.length - 1)
				break
			case 'PageDown':
				focusRow(focusIndex + page)
				break
			case 'PageUp':
				focusRow(focusIndex - page)
				break
			case ' ':
				focusRow(focusIndex + (event.shiftKey ? -page : page))
				break
			case 'ArrowRight':
				if (row.expandable && !row.expanded) toggle(row.pointer, true)
				else if (row.expanded) focusRow(focusIndex + 1)
				break
			case 'ArrowLeft': {
				if (row.expanded) toggle(row.pointer, false)
				else {
					const parent = parentOf(row.pointer)
					if (parent !== null) {
						const index = indexOf.get(parent)
						if (index !== undefined) focusRow(index)
					}
				}
				break
			}
			case 'Enter':
				if (row.expandable) toggle(row.pointer)
				break
			default:
				handled = false
		}
		if (handled) event.preventDefault()
	}

	if (load.kind === 'loading') return <p className="viewer-note">Reading the data…</p>
	if (load.kind === 'failed') return null

	const items = virtual.getVirtualItems()
	return (
		<div className="viewer-data">
			{searchOpen && (
				// biome-ignore lint/a11y/useSemanticElements: React's DOM types have no <search> element yet.
				<div role="search" className="viewer-search" aria-label="Find in data">
					<input
						ref={field}
						type="search"
						className="viewer-search-field"
						placeholder="Find keys and values"
						aria-label="Find keys and values"
						value={found.query}
						spellCheck={false}
						onChange={event => {
							const query = event.target.value
							setFound(value => ({ ...value, query, pending: Boolean(query) }))
						}}
						onKeyDown={event => {
							if (event.key === 'Escape') {
								event.preventDefault()
								closeSearch()
							} else if (event.key === 'Enter') {
								event.preventDefault()
								step(event.shiftKey ? -1 : 1)
							}
						}}
					/>
					<output className="viewer-search-count" aria-live="polite">
						{!found.query
							? ''
							: found.pending
								? 'Searching…'
								: found.matches.length
									? `${found.index + 1} of ${found.matches.length.toLocaleString('en-US')}${found.truncated ? '+' : ''}`
									: 'No matches'}
					</output>
					<Btn sm tone="ghost" disabled={!found.matches.length} onClick={() => step(-1)}>
						Previous
					</Btn>
					<Btn sm tone="ghost" disabled={!found.matches.length} onClick={() => step(1)}>
						Next
					</Btn>
					<Btn sm tone="ghost" ariaLabel="Close find" onClick={closeSearch}>
						×
					</Btn>
				</div>
			)}
			{(truncated || found.truncated) && (
				<p className="viewer-note viewer-note-inline">
					{truncated
						? `Showing the first ${ROW_LIMIT.toLocaleString('en-US')} rows; collapse a node to see more.`
						: `Showing the first ${MATCH_LIMIT.toLocaleString('en-US')} matches.`}
				</p>
			)}
			<div ref={scroller} className="viewer-data-scroll">
				<div
					ref={tree}
					role="tree"
					aria-label="Data tree"
					aria-activedescendant={rows.length ? `${id}-${focusIndex}` : undefined}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: role=tree is the keyboard owner (aria-activedescendant).
					tabIndex={0}
					className="viewer-tree"
					style={{ height: virtual.getTotalSize() }}
					onKeyDown={onTreeKey}
				>
					{items.map(item => {
						const row = rows[item.index] as DataRow
						return (
							// biome-ignore lint/a11y/useKeyWithClickEvents: keys belong to the tree (aria-activedescendant).
							<div
								key={row.pointer}
								id={`${id}-${item.index}`}
								ref={virtual.measureElement}
								data-index={item.index}
								role="treeitem"
								aria-level={row.depth + 1}
								aria-expanded={row.expandable ? row.expanded : undefined}
								aria-selected={item.index === focusIndex}
								data-kind={row.kind}
								data-match={matchSet.has(row.pointer) || undefined}
								data-current-match={row.pointer === current || undefined}
								className="viewer-tree-row"
								style={{
									transform: `translateY(${item.start}px)`,
									paddingInlineStart: `calc(${row.depth} * 16px + 8px)`,
								}}
								onPointerDown={() => setFocused(row.pointer)}
								onClick={event => {
									if (row.expandable && !(window.getSelection()?.toString() ?? '')) {
										toggle(row.pointer)
										event.currentTarget.closest<HTMLElement>('[role="tree"]')?.focus({ preventScroll: true })
									}
								}}
							>
								{row.kind === 'more' ? (
									<span className="viewer-tree-more">
										{(row.hidden ?? 0).toLocaleString('en-US')} more not shown (the tree lists the first{' '}
										{CHILD_LIMIT.toLocaleString('en-US')} of each node)
									</span>
								) : (
									<>
										<span className="viewer-tree-twisty" aria-hidden="true">
											{row.expandable ? (row.expanded ? '▾' : '▸') : ''}
										</span>
										{row.key !== '' && (
											<>
												<span className="viewer-tree-key">{row.key}</span>
												<span className="viewer-tree-colon" aria-hidden="true">
													:
												</span>
											</>
										)}
										<span className="viewer-tree-value">{row.text}</span>
										{row.note && <span className="viewer-tree-note">{row.note}</span>}
									</>
								)}
							</div>
						)
					})}
				</div>
			</div>
		</div>
	)
}
