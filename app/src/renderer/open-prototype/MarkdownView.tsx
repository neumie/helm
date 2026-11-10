// Story-only `helm open` Markdown renderer (docs/plans/helm-open/spec.md §Formats).
// marked's Lexer → explicit React elements. Parser HTML is never mounted: an `html` token shows as its
// raw text, images are never fetched (their alt text shows as a note), links never navigate.
import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked'
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import './doc.css'
import { loadText } from './fixtures'
import type { FeedbackAnchor, FeedbackHost, RendererProps } from './types'

// ---------------------------------------------------------------------------------------------
// Shared text-selection feedback (also used by DocxView).

const SKIP_ATTR = 'data-quote-skip'

/** Text nodes under root, in order, skipping display-only gutters. */
function textNodes(root: Node): Text[] {
	const out: Text[] = []
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: node =>
			node.parentElement?.closest(`[${SKIP_ATTR}]`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
	})
	for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text)
	return out
}

/**
 * The one Range under root whose text equals quote, ignoring whitespace (selection.toString() adds
 * line breaks between blocks that no text node holds; `ignore` widens that, e.g. to Markdown markers when a
 * rendered quote is painted over its source). Null when missing or ambiguous: a quote that occurs
 * twice is never guessed.
 */
export function findQuoteRange(root: Node, quote: string, ignore: RegExp = /\s/): Range | null {
	const needle = Array.from(quote)
		.filter(ch => !ignore.test(ch))
		.join('')
	if (needle.length === 0) return null
	let hay = ''
	const map: { node: Text; offset: number }[] = []
	for (const node of textNodes(root)) {
		const data = node.data
		for (let i = 0; i < data.length; i++) {
			const ch = data[i] as string
			if (ignore.test(ch)) continue
			hay += ch
			map.push({ node, offset: i })
		}
	}
	const first = hay.indexOf(needle)
	if (first < 0 || hay.indexOf(needle, first + 1) >= 0) return null
	const start = map[first]
	const end = map[first + needle.length - 1]
	if (!start || !end) return null
	const range = document.createRange()
	range.setStart(start.node, start.offset)
	range.setEnd(end.node, end.offset + 1)
	return range
}

function highlightsSupported(): boolean {
	return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

function sameAnchor(a: FeedbackAnchor, b: FeedbackAnchor): boolean {
	if (a === b) return true
	if (a.kind !== b.kind) return false
	if (a.kind === 'text' && b.kind === 'text') return a.quote === b.quote
	if (a.kind === 'lines' && b.kind === 'lines') return a.startLine === b.startLine && a.endLine === b.endLine
	return false
}

/**
 * Feedback mode for selectable text. A completed selection inside root reports an anchor (built by
 * anchorFor) with the range's viewport box; feedback.active stays painted through the CSS Custom
 * Highlight `highlight` (display only, never a DOM change). `content` re-runs painting after the
 * renderer replaces its DOM.
 */
export function useTextSelectionFeedback({
	root,
	feedback,
	highlight,
	anchorFor,
	rangeFor,
	content,
}: {
	root: RefObject<HTMLElement | null>
	feedback: FeedbackHost | null | undefined
	highlight: string
	anchorFor: (range: Range, quote: string) => FeedbackAnchor | null
	/** Finds a range for an anchor this view did not produce itself. Defaults to the quote. */
	rangeFor?: (root: HTMLElement, anchor: FeedbackAnchor) => Range | Range[] | null
	content: unknown
}) {
	const last = useRef<{ anchor: FeedbackAnchor; range: Range } | null>(null)
	const anchorForRef = useRef(anchorFor)
	anchorForRef.current = anchorFor
	const enabled = feedback != null
	const onAnchorRef = useRef(feedback?.onAnchor)
	onAnchorRef.current = feedback?.onAnchor

	// biome-ignore lint/correctness/useExhaustiveDependencies: `content` re-binds after the renderer replaces its root.
	useEffect(() => {
		const element = root.current
		if (!enabled || !element) return
		let frame = 0
		const capture = () => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				const selection = window.getSelection()
				if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
				const range = selection.getRangeAt(0)
				if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return
				const quote = selection.toString().trim()
				if (quote.length === 0) return
				const owned = range.cloneRange()
				const anchor = anchorForRef.current(owned, quote)
				if (!anchor) return
				last.current = { anchor, range: owned }
				onAnchorRef.current?.(anchor, owned.getBoundingClientRect())
			})
		}
		const onKeyUp = (event: globalThis.KeyboardEvent) => {
			if (event.shiftKey || event.key === 'Shift') capture()
		}
		element.addEventListener('pointerup', capture)
		element.addEventListener('keyup', onKeyUp)
		return () => {
			cancelAnimationFrame(frame)
			element.removeEventListener('pointerup', capture)
			element.removeEventListener('keyup', onKeyUp)
		}
	}, [enabled, root, content])

	const active = feedback?.active ?? null
	const rangeForRef = useRef(rangeFor)
	rangeForRef.current = rangeFor
	// biome-ignore lint/correctness/useExhaustiveDependencies: `content` is the repaint trigger.
	useEffect(() => {
		const element = root.current
		if (!highlightsSupported() || !element) return
		if (!active || (active.kind !== 'text' && active.kind !== 'lines')) {
			CSS.highlights.delete(highlight)
			return
		}
		let range: Range | Range[] | null = null
		const kept = last.current
		// A text anchor keeps the exact selected range; a lines anchor is painted as whole lines.
		if (
			kept &&
			active.kind === 'text' &&
			sameAnchor(kept.anchor, active) &&
			kept.range.startContainer.isConnected &&
			element.contains(kept.range.startContainer)
		) {
			range = kept.range
		} else {
			range = rangeForRef.current
				? rangeForRef.current(element, active)
				: active.kind === 'text'
					? findQuoteRange(element, active.quote)
					: null
		}
		const ranges = range == null ? [] : Array.isArray(range) ? range : [range]
		if (ranges.length > 0) CSS.highlights.set(highlight, new Highlight(...ranges))
		else CSS.highlights.delete(highlight)
		return () => {
			CSS.highlights.delete(highlight)
		}
	}, [active, highlight, root, content])
}

// ---------------------------------------------------------------------------------------------
// Markdown → React.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Marked keeps source entities in text tokens; show them as the characters they name. */
function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
		if (body[0] === '#') {
			const code =
				body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
		}
		return ENTITIES[body.toLowerCase()] ?? match
	})
}

function inline(tokens: Token[] | undefined, keyBase: string): ReactNode[] {
	if (!tokens) return []
	return tokens.map((token, index) => renderInline(token, `${keyBase}.${index}`))
}

function renderInline(raw: Token, key: string): ReactNode {
	const token = raw as MarkedToken
	switch (token.type) {
		case 'text':
			return token.tokens ? <span key={key}>{inline(token.tokens, key)}</span> : decodeEntities(token.text)
		case 'escape':
			return decodeEntities(token.text)
		case 'strong':
			return <strong key={key}>{inline(token.tokens, key)}</strong>
		case 'em':
			return <em key={key}>{inline(token.tokens, key)}</em>
		case 'del':
			return <del key={key}>{inline(token.tokens, key)}</del>
		case 'codespan':
			return (
				<code key={key} className="open-md-code">
					{decodeEntities(token.text)}
				</code>
			)
		case 'br':
			return <br key={key} />
		case 'link':
			// Never navigates: the address is shown on hover, the text keeps link color.
			return (
				<span key={key} className="open-md-link" title={token.href}>
					{inline(token.tokens, key)}
				</span>
			)
		case 'image':
			return (
				<span key={key} className="open-md-image-note" title={token.href}>
					Image not loaded{token.text ? `: ${token.text}` : ''}
				</span>
			)
		case 'html':
			// Raw HTML is shown as the text it is, never parsed.
			return (
				<span key={key} className="open-md-raw">
					{token.raw}
				</span>
			)
		case 'checkbox':
			return (
				<span key={key} className="open-md-check" aria-label={token.checked ? 'Done' : 'Not done'}>
					{token.checked ? '☑' : '☐'}{' '}
				</span>
			)
		default:
			return 'raw' in raw ? raw.raw : null
	}
}

function renderBlocks(tokens: Token[], keyBase: string, top: boolean): ReactNode[] {
	const out: ReactNode[] = []
	tokens.forEach((token, index) => {
		const key = `${keyBase}.${index}`
		const node = renderBlock(token, key)
		if (node == null) return
		out.push(
			top ? (
				<div key={key} className="open-md-block" data-block-id={`b${index}`}>
					{node}
				</div>
			) : (
				node
			),
		)
	})
	return out
}

function renderBlock(raw: Token, key: string): ReactNode {
	const token = raw as MarkedToken
	switch (token.type) {
		case 'space':
		case 'def':
			return null
		case 'heading': {
			const children = inline(token.tokens, key)
			const Tag = `h${Math.min(Math.max(token.depth, 1), 6)}` as 'h1'
			return (
				<Tag key={key} className="open-md-heading">
					{children}
				</Tag>
			)
		}
		case 'paragraph':
			return <p key={key}>{inline(token.tokens, key)}</p>
		case 'text':
			// Tight list items carry block-level text tokens.
			return <span key={key}>{token.tokens ? inline(token.tokens, key) : decodeEntities(token.text)}</span>
		case 'code':
			return (
				<pre key={key} className="open-md-pre" aria-label={token.lang ? `${token.lang} code` : 'Code'}>
					<code>{token.text}</code>
				</pre>
			)
		case 'blockquote':
			return <blockquote key={key}>{renderBlocks(token.tokens, key, false)}</blockquote>
		case 'hr':
			return <hr key={key} />
		case 'list': {
			const items = token.items.map((item, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lexer output is immutable; its position is the identity.
				<li key={`${key}.${index}`} className={item.task ? 'open-md-task' : undefined}>
					{renderBlocks(item.tokens, `${key}.${index}`, false)}
				</li>
			))
			return token.ordered ? (
				<ol key={key} start={typeof token.start === 'number' && token.start !== 1 ? token.start : undefined}>
					{items}
				</ol>
			) : (
				<ul key={key}>{items}</ul>
			)
		}
		case 'table':
			return (
				<div key={key} className="open-md-table-scroll">
					<table>
						<thead>
							<tr>
								{token.header.map((cell, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: lexer output is immutable; its position is the identity.
									<th key={`${key}.h${index}`} style={cell.align ? { textAlign: cell.align } : undefined}>
										{inline(cell.tokens, `${key}.h${index}`)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{token.rows.map((row, r) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: lexer output is immutable; its position is the identity.
								<tr key={`${key}.r${r}`}>
									{row.map((cell, c) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: lexer output is immutable; its position is the identity.
										<td key={`${key}.r${r}.${c}`} style={cell.align ? { textAlign: cell.align } : undefined}>
											{inline(cell.tokens, `${key}.r${r}.${c}`)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)
		case 'html':
			return (
				<pre key={key} className="open-md-raw-block">
					{token.raw}
				</pre>
			)
		default:
			return 'raw' in raw ? <p key={key}>{raw.raw}</p> : null
	}
}

// ---------------------------------------------------------------------------------------------

/** A heading counts as current once its top passes this line (toolbar 32 + prose padding 32). */
const HEADING_LINE = 72
/** Characters a rendered quote loses from its source: whitespace and inline emphasis/code markers. */
const MARKDOWN_MARKERS = /[\s*_`~]/

type Mode = 'rendered' | 'source'
const MODES: { id: Mode; label: string }[] = [
	{ id: 'rendered', label: 'Rendered' },
	{ id: 'source', label: 'Source' },
]

function Segmented({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
	const refs = useRef<(HTMLButtonElement | null)[]>([])
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
		event.preventDefault()
		const index = MODES.findIndex(m => m.id === mode)
		const next = (index + (event.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length
		const target = MODES[next]
		if (!target) return
		onChange(target.id)
		refs.current[next]?.focus()
	}
	return (
		<div className="open-md-segmented" role="radiogroup" aria-label="Show as" onKeyDown={onKeyDown}>
			{MODES.map((m, index) => (
				<button
					key={m.id}
					ref={el => {
						refs.current[index] = el
					}}
					type="button"
					// biome-ignore lint/a11y/useSemanticElements: a segmented control is one tab stop with arrow keys (design-system §4).
					role="radio"
					aria-checked={mode === m.id}
					tabIndex={mode === m.id ? 0 : -1}
					onClick={() => onChange(m.id)}
				>
					{m.label}
				</button>
			))}
		</div>
	)
}

function countWords(element: HTMLElement): number {
	return (element.textContent ?? '').split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length
}

export function MarkdownView({
	file,
	onStatus,
	feedback,
	initialMode = 'rendered',
}: RendererProps & { initialMode?: Mode }) {
	const [text, setText] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [mode, setMode] = useState<Mode>(initialMode)
	const scrollRef = useRef<HTMLDivElement>(null)
	const contentRef = useRef<HTMLElement>(null)
	const [words, setWords] = useState(0)
	const [heading, setHeading] = useState<string | undefined>(undefined)

	useEffect(() => {
		const controller = new AbortController()
		setText(null)
		setError(null)
		loadText(file, controller.signal).then(setText, (reason: unknown) => {
			if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
		})
		return () => controller.abort()
	}, [file])

	const blocks = useMemo(() => (text == null ? null : renderBlocks(Lexer.lex(text, { gfm: true }), 'md', true)), [text])
	const lines = useMemo(() => (text == null ? [] : text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')), [text])

	// Word count from the rendered prose (what a reader reads), once per file.
	useEffect(() => {
		if (blocks && mode === 'rendered' && contentRef.current) setWords(countWords(contentRef.current))
	}, [blocks, mode])

	// Current heading while scrolling: the last heading whose top passed the reading line.
	useEffect(() => {
		const root = scrollRef.current
		const content = contentRef.current
		if (!root || !content || mode !== 'rendered' || !blocks) {
			setHeading(undefined)
			return
		}
		const headings = Array.from(content.querySelectorAll<HTMLElement>('.open-md-heading'))
		if (headings.length === 0) return
		const pick = () => {
			const limit = root.getBoundingClientRect().top + HEADING_LINE
			// At the end of a short document the last headings never reach the line: take the last one in view.
			const atEnd = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2
			const bottom = root.getBoundingClientRect().bottom
			let current = headings[0]
			for (const h of headings) {
				const top = h.getBoundingClientRect().top
				if (top <= limit || (atEnd && top < bottom)) current = h
				else break
			}
			setHeading(current?.textContent?.trim() || undefined)
		}
		const observer = new IntersectionObserver(pick, {
			root,
			threshold: [0, 1],
			rootMargin: `-${HEADING_LINE}px 0px 0px 0px`,
		})
		for (const h of headings) observer.observe(h)
		root.addEventListener('scroll', pick, { passive: true })
		pick()
		return () => {
			observer.disconnect()
			root.removeEventListener('scroll', pick)
		}
	}, [blocks, mode])

	const onStatusRef = useRef(onStatus)
	onStatusRef.current = onStatus
	useEffect(() => {
		if (text == null) return
		const facts = mode === 'rendered' ? [`${words} words`] : [`${lines.length} lines`]
		onStatusRef.current?.({ position: mode === 'rendered' ? heading : undefined, facts })
	}, [text, mode, words, heading, lines.length])

	useTextSelectionFeedback({
		root: contentRef,
		feedback,
		highlight: 'open-feedback-md',
		content: `${mode}:${blocks ? 'ready' : 'empty'}`,
		anchorFor: (range, quote) => {
			const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
			if (mode === 'source') {
				const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
				const a = Number(start?.closest<HTMLElement>('[data-line]')?.dataset.line)
				const b = Number(end?.closest<HTMLElement>('[data-line]')?.dataset.line)
				if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null
				return { kind: 'lines', startLine: Math.min(a, b), endLine: Math.max(a, b), quote }
			}
			const blockId = start?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId
			return blockId ? { kind: 'text', quote, blockId } : { kind: 'text', quote }
		},
		rangeFor: (root, anchor) => {
			if (anchor.kind === 'text')
				return findQuoteRange(root, anchor.quote, mode === 'source' ? MARKDOWN_MARKERS : undefined)
			if (anchor.kind !== 'lines') return null
			// One range per line's text, so the line-number gutter stays unpainted.
			const ranges: Range[] = []
			for (let line = anchor.startLine; line <= anchor.endLine; line++) {
				const cell = root.querySelector(`[data-line="${line}"] .open-md-src-text`)
				if (!cell || cell.childNodes.length === 0) continue
				const range = document.createRange()
				range.selectNodeContents(cell)
				ranges.push(range)
			}
			return ranges
		},
	})

	const feedbackOn = feedback != null
	return (
		<div
			ref={scrollRef}
			className="open-view open-md"
			data-feedback={feedbackOn ? 'on' : undefined}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll owner is keyboard-scrollable.
			tabIndex={0}
			aria-label={`${file.name}, ${mode === 'rendered' ? 'rendered' : 'source'}`}
		>
			<div className="open-md-toolbar">
				<Segmented mode={mode} onChange={setMode} />
			</div>
			{error ? (
				<div className="open-note" role="alert">
					<b>Can't show this file</b>
					{error}
				</div>
			) : text == null ? (
				<div className="open-note">Opening {file.name}…</div>
			) : mode === 'rendered' ? (
				<article ref={contentRef} className="open-md-prose">
					{blocks}
				</article>
			) : (
				<section ref={contentRef} className="open-md-source" aria-label="Markdown source">
					{lines.map((line, index) => (
						<div key={`${index}:${line}`} className="open-md-src-line" data-line={index + 1}>
							<span className="open-md-src-num" data-quote-skip="" aria-hidden="true">
								{index + 1}
							</span>
							<span className="open-md-src-text">{line.length > 0 ? line : '​'}</span>
						</div>
					))}
				</section>
			)}
		</div>
	)
}
