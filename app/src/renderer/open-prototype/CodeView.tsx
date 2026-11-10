// Story-only `helm open` prototype: code + plain text renderer (docs/plans/helm-open/spec.md).
// CodeMirror 6, read-only but focusable: `readOnly` blocks every edit while the content stays a
// keyboard selection surface, so arrows/Shift+arrows, ⌘A, copy and ⌘F search all keep working.
// File content is only ever text in the editor document: nothing is evaluated or loaded remotely.
import { defaultKeymap } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { SearchQuery, findNext, openSearchPanel, search, searchKeymap, setSearchQuery } from '@codemirror/search'
import { EditorState, type Extension, RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import {
	Decoration,
	type DecorationSet,
	EditorView,
	GutterMarker,
	type ViewUpdate,
	drawSelection,
	gutterLineClass,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useEffect, useRef, useState } from 'react'
import './code.css'
import { loadText } from './fixtures'
import type { FeedbackAnchor, FeedbackHost, RendererProps, ViewerFile, ViewerStatus } from './types'

/** Longest quote an anchor carries (the rest stays in the file). */
const QUOTE_LIMIT = 2000

interface Language {
	word: string
	extension: Extension | null
}

/** Language by file extension; anything unknown is plain text. */
export function languageFor(file: ViewerFile): Language {
	const ext = file.name.toLowerCase().split('.').pop() ?? ''
	switch (ext) {
		case 'ts':
		case 'mts':
		case 'cts':
			return { word: 'TypeScript', extension: javascript({ typescript: true }) }
		case 'tsx':
			return { word: 'TypeScript', extension: javascript({ typescript: true, jsx: true }) }
		case 'js':
		case 'mjs':
		case 'cjs':
			return { word: 'JavaScript', extension: javascript() }
		case 'jsx':
			return { word: 'JavaScript', extension: javascript({ jsx: true }) }
		case 'json':
			return { word: 'JSON', extension: json() }
		case 'py':
			return { word: 'Python', extension: python() }
		case 'md':
		case 'markdown':
			return { word: 'Markdown', extension: markdown() }
		case 'css':
			return { word: 'CSS', extension: css() }
		case 'html':
		case 'htm':
			return { word: 'HTML', extension: html() }
		default:
			return { word: file.language ?? 'Plain text', extension: null }
	}
}

// Syntax color is glyph color only, from the terminal ANSI tokens; never a fill.
const helmHighlight = HighlightStyle.define([
	{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: 'var(--ansi-magenta)' },
	{ tag: [t.definitionKeyword, t.self, t.null, t.bool, t.atom], color: 'var(--ansi-magenta)' },
	{ tag: [t.string, t.special(t.string), t.regexp, t.escape], color: 'var(--ansi-green)' },
	{ tag: [t.number, t.integer, t.float], color: 'var(--ansi-cyan)' },
	{ tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--text-2)' },
	{ tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: 'var(--ansi-yellow)' },
	{
		tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))],
		color: 'var(--ansi-blue)',
	},
	{ tag: [t.propertyName, t.attributeName], color: 'var(--ansi-white)' },
	{ tag: [t.tagName, t.heading], color: 'var(--ansi-blue)' },
	{ tag: [t.link, t.url], color: 'var(--ansi-cyan)' },
	{ tag: t.invalid, color: 'var(--ansi-red)' },
	{ tag: t.strong, fontWeight: '600' },
	{ tag: [t.meta, t.processingInstruction, t.punctuation, t.bracket], color: 'var(--text-1)' },
])

// Visuals live in code.css under a prefix that outranks CodeMirror's own light/dark base rules;
// the theme only marks the editor dark so no light defaults paint first.
const helmTheme = EditorView.theme({}, { dark: true })

// Search panel phrases, sentence case (CodeMirror's own are lowercase).
const phrases = EditorState.phrases.of({
	Find: 'Find in file',
	next: 'Next',
	previous: 'Previous',
	all: 'All',
	'match case': 'Match case',
	regexp: 'Regular expression',
	'by word': 'Whole word',
	close: 'Close',
	'current match': 'current match',
	'on line': 'on line',
})

// ---- feedback anchor paint ----

interface LineRange {
	start: number
	end: number
}

const setAnchorLines = StateEffect.define<LineRange | null>()

const anchorLineDeco = Decoration.line({ class: 'cm-open-code-anchor' })
const anchorGutterMarker = new (class extends GutterMarker {
	override elementClass = 'cm-open-code-anchor-gutter'
})()

interface AnchorPaint {
	lines: DecorationSet
	gutter: RangeSet<GutterMarker>
}

function paintFor(state: EditorState, range: LineRange | null): AnchorPaint {
	if (!range) return { lines: Decoration.none, gutter: RangeSet.empty }
	const lines = new RangeSetBuilder<Decoration>()
	const gutter = new RangeSetBuilder<GutterMarker>()
	const last = Math.min(range.end, state.doc.lines)
	for (let n = Math.max(1, range.start); n <= last; n++) {
		const from = state.doc.line(n).from
		lines.add(from, from, anchorLineDeco)
		gutter.add(from, from, anchorGutterMarker)
	}
	return { lines: lines.finish(), gutter: gutter.finish() }
}

const anchorField = StateField.define<AnchorPaint>({
	create: () => ({ lines: Decoration.none, gutter: RangeSet.empty }),
	update(value, tr) {
		for (const effect of tr.effects) if (effect.is(setAnchorLines)) return paintFor(tr.state, effect.value)
		return value
	},
	provide: field => [
		EditorView.decorations.from(field, value => value.lines),
		gutterLineClass.from(field, value => value.gutter),
	],
})

function activeLines(active: FeedbackAnchor | null | undefined): LineRange | null {
	return active?.kind === 'lines' ? { start: active.startLine, end: active.endLine } : null
}

// ---- status ----

function positionOf(state: EditorState): string {
	const { from, to, head } = state.selection.main
	const doc = state.doc
	if (from === to) {
		const line = doc.lineAt(head)
		return `Ln ${line.number}, Col ${head - line.from + 1}`
	}
	const start = doc.lineAt(from)
	const end = doc.lineAt(to)
	if (start.number === end.number) return `Ln ${start.number}, Col ${from - start.from + 1}–${to - start.from}`
	return `Lines ${start.number}–${selectionEndLine(state)}`
}

/** A multi-line selection ending at column 1 does not include that last line. */
function selectionEndLine(state: EditorState): number {
	const { from, to } = state.selection.main
	const end = state.doc.lineAt(to)
	return to === end.from && to > from && end.number > state.doc.lineAt(from).number ? end.number - 1 : end.number
}

/** On-screen box of the selected range, clipped to the visible scroller. */
function selectionBox(view: EditorView): DOMRect | null {
	const { from, to } = view.state.selection.main
	const start = view.coordsAtPos(from, 1)
	const end = view.coordsAtPos(to, -1)
	if (!start || !end) return null
	const scroller = view.scrollDOM.getBoundingClientRect()
	const content = view.contentDOM.getBoundingClientRect()
	const singleLine = view.state.doc.lineAt(from).number === view.state.doc.lineAt(to).number
	const left = singleLine ? Math.min(start.left, end.left) : content.left
	const right = singleLine ? Math.max(start.right, end.right) : Math.min(content.right, scroller.right)
	const top = Math.max(start.top, scroller.top)
	const bottom = Math.min(end.bottom, scroller.bottom)
	return new DOMRect(Math.max(left, scroller.left), top, Math.max(0, right - left), Math.max(0, bottom - top))
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; text: string }

export function CodeView({ file, onStatus, feedback = null }: RendererProps) {
	const [load, setLoad] = useState<Load>({ kind: 'loading' })
	const host = useRef<HTMLDivElement>(null)
	const [view, setView] = useState<EditorView | null>(null)
	const statusRef = useRef(onStatus)
	statusRef.current = onStatus
	const feedbackRef = useRef<FeedbackHost | null>(feedback)
	feedbackRef.current = feedback
	const reported = useRef<string | null>(null)

	useEffect(() => {
		const abort = new AbortController()
		setLoad({ kind: 'loading' })
		loadText(file, abort.signal)
			.then(text => setLoad({ kind: 'ready', text }))
			.catch((error: unknown) => {
				if (!abort.signal.aborted)
					setLoad({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
			})
		return () => abort.abort()
	}, [file])

	const text = load.kind === 'ready' ? load.text : null
	useEffect(() => {
		const parent = host.current
		if (text === null || !parent) return
		const language = languageFor(file)
		const lineEnding = text.includes('\r\n') ? 'CRLF' : 'LF'
		// A final newline ends the last line; it does not start another one.
		const lineCount = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0)
		const report = (state: EditorState) => {
			const status: ViewerStatus = {
				position: positionOf(state),
				// The language is the format word the chrome already prints (formatWord), so it is not repeated here.
				facts: [`${lineCount.toLocaleString('en-US')} ${lineCount === 1 ? 'line' : 'lines'}`, 'UTF-8', lineEnding],
			}
			statusRef.current?.(status)
		}
		const state = EditorState.create({
			doc: text,
			extensions: [
				lineNumbers(),
				highlightActiveLine(),
				highlightActiveLineGutter(),
				drawSelection(),
				EditorState.readOnly.of(true),
				EditorState.tabSize.of(2),
				EditorView.contentAttributes.of({ 'aria-label': `${file.name}, read only`, 'aria-readonly': 'true' }),
				search({ top: true }),
				keymap.of([...searchKeymap, ...defaultKeymap]),
				phrases,
				language.extension ?? [],
				syntaxHighlighting(helmHighlight),
				helmTheme,
				anchorField,
				EditorView.updateListener.of((update: ViewUpdate) => {
					if (update.selectionSet || update.docChanged) report(update.state)
				}),
			],
		})
		const view = new EditorView({ state, parent })
		setView(view)
		report(view.state)
		const initial = activeLines(feedbackRef.current?.active)
		if (initial) view.dispatch({ effects: setAnchorLines.of(initial) })

		// Feedback mode: a finished, non-empty selection becomes a lines anchor.
		const finish = () => {
			const host = feedbackRef.current
			if (!host) return
			const { from, to } = view.state.selection.main
			if (from === to) return
			const key = `${from}:${to}`
			if (reported.current === key) return
			const box = selectionBox(view)
			if (!box) return
			reported.current = key
			host.onAnchor(
				{
					kind: 'lines',
					startLine: view.state.doc.lineAt(from).number,
					endLine: selectionEndLine(view.state),
					quote: view.state.sliceDoc(from, Math.min(to, from + QUOTE_LIMIT)),
				},
				box,
			)
		}
		const onMouseUp = () => requestAnimationFrame(finish)
		const onKeyUp = (event: KeyboardEvent) => {
			const selectAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a'
			if (event.shiftKey || event.key === 'Shift' || selectAll) finish()
		}
		view.contentDOM.addEventListener('mouseup', onMouseUp)
		view.contentDOM.addEventListener('keyup', onKeyUp)

		// Contenteditable always matches :focus-visible, so the ring is drawn only when focus
		// arrived from the keyboard (Tab), never from a click into the text.
		const root = parent.parentElement
		let pointerFirst = false
		const onPointerDown = () => {
			pointerFirst = true
			root?.removeAttribute('data-focus-ring')
		}
		const onKeyDown = () => {
			pointerFirst = false
		}
		const onFocus = () => root?.toggleAttribute('data-focus-ring', !pointerFirst)
		const onBlur = () => root?.removeAttribute('data-focus-ring')
		window.addEventListener('pointerdown', onPointerDown, true)
		window.addEventListener('keydown', onKeyDown, true)
		view.contentDOM.addEventListener('focus', onFocus)
		view.contentDOM.addEventListener('blur', onBlur)
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true)
			window.removeEventListener('keydown', onKeyDown, true)
			view.contentDOM.removeEventListener('focus', onFocus)
			view.contentDOM.removeEventListener('blur', onBlur)
			root?.removeAttribute('data-focus-ring')
			view.contentDOM.removeEventListener('mouseup', onMouseUp)
			view.contentDOM.removeEventListener('keyup', onKeyUp)
			view.destroy()
			setView(null)
			reported.current = null
		}
	}, [text, file])

	// Keep feedback.active painted; scroll it into view only when it lies off screen.
	const range = activeLines(feedback?.active)
	const rangeKey = range ? `${range.start}-${range.end}` : ''
	useEffect(() => {
		if (!view) return
		const lines = rangeKey ? rangeKey.split('-').map(Number) : null
		const value = lines ? { start: lines[0] ?? 1, end: lines[1] ?? 1 } : null
		const effects: StateEffect<unknown>[] = [setAnchorLines.of(value)]
		if (value && value.start <= view.state.doc.lines) {
			effects.push(EditorView.scrollIntoView(view.state.doc.line(value.start).from, { y: 'nearest' }))
		}
		view.dispatch({ effects })
		if (!value) reported.current = null
	}, [rangeKey, view])

	if (load.kind === 'error') {
		return (
			<div className="open-view open-code">
				<p className="open-note">
					<b>This file could not be read</b>
					{load.message}
				</p>
			</div>
		)
	}
	return (
		<div className="open-view open-code" data-feedback={feedback ? 'on' : undefined}>
			{load.kind === 'loading' ? <p className="open-note">Reading {file.name}…</p> : null}
			<div ref={host} className="open-code-host" hidden={load.kind !== 'ready'} />
		</div>
	)
}

/** Open the search panel with a query highlighted and its first match selected (stories, ⌘F). */
export function searchInView(root: HTMLElement, query: string): boolean {
	const dom = root.querySelector<HTMLElement>('.cm-editor')
	const view = dom ? EditorView.findFromDOM(dom) : null
	if (!view) return false
	openSearchPanel(view)
	view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query })) })
	findNext(view)
	return true
}
