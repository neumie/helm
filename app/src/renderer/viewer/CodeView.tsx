// The read-only code and text view of a plain `helm open` window (docs/plans/helm-open/spec.md, S2). CodeMirror 6,
// read-only but focusable: the text stays a keyboard selection surface (arrows, Shift+arrows, ⌘A, ⌘C, ⌘F). File
// content is only ever the editor document; nothing in it is evaluated, linked or loaded.
import { cursorLineDown, cursorLineUp, cursorPageDown, cursorPageUp, defaultKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import {
	SearchQuery,
	findNext,
	findPrevious,
	getSearchQuery,
	openSearchPanel,
	search,
	searchKeymap,
	setSearchQuery,
} from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
	EditorView,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { loadLanguage } from './code-languages'
import { changedSpan } from './text-span'

// Syntax color is glyph color only, from the --syntax-* tokens (viewer.css; light surface overrides them).
const helmHighlight = HighlightStyle.define([
	{
		tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier],
		color: 'var(--syntax-keyword)',
	},
	{ tag: [t.definitionKeyword, t.self, t.null, t.bool, t.atom], color: 'var(--syntax-keyword)' },
	{ tag: [t.string, t.special(t.string), t.regexp, t.escape, t.character], color: 'var(--syntax-string)' },
	{ tag: [t.number, t.integer, t.float], color: 'var(--syntax-number)' },
	{ tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syntax-comment)' },
	{ tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: 'var(--syntax-type)' },
	{
		tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))],
		color: 'var(--syntax-function)',
	},
	{ tag: [t.propertyName, t.attributeName, t.labelName], color: 'var(--syntax-property)' },
	{ tag: [t.tagName, t.heading], color: 'var(--syntax-function)' },
	{ tag: [t.link, t.url], color: 'var(--syntax-number)' },
	{ tag: [t.inserted], color: 'var(--syntax-string)' },
	{ tag: [t.deleted, t.invalid], color: 'var(--syntax-invalid)' },
	{ tag: t.strong, fontWeight: '600' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: [t.meta, t.processingInstruction, t.punctuation, t.bracket], color: 'var(--text-1)' },
])

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

// Space / ⇧Space page and J / K move a line (spec Keyboard-first); harmless in a read-only document.
const readingKeys = keymap.of([
	{ key: 'Space', run: cursorPageDown, shift: cursorPageUp },
	{ key: 'j', run: cursorLineDown },
	{ key: 'k', run: cursorLineUp },
])

export interface CodeViewProps {
	/** File name, for the accessible label. */
	name: string
	text: string
	/** Language id (formats.ts CODE_LANGUAGES); unknown or 'plain' shows plain text. */
	language: string
	theme: 'dark' | 'light'
	/** Reading zoom; a change re-measures the editor. */
	zoom: number
	/** Bumped to open search (the window menu's Find). */
	find?: number
	/** Cursor or selection position, e.g. "Ln 4, Col 2". */
	onPosition?(position: string): void
}

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
	// A multi-line selection ending at column 1 does not include that last line.
	const last = to === end.from ? end.number - 1 : end.number
	return `Lines ${start.number}–${last}`
}

export function CodeView({ name, text, language, theme, zoom, find = 0, onPosition }: CodeViewProps) {
	const host = useRef<HTMLDivElement>(null)
	const view = useRef<EditorView | null>(null)
	const languageSlot = useRef(new Compartment())
	const darkSlot = useRef(new Compartment())
	const positionRef = useRef(onPosition)
	positionRef.current = onPosition
	const initial = useRef({ text, theme, name })

	// One editor per mount; text, language and theme changes reconfigure it in place.
	useEffect(() => {
		const parent = host.current
		if (!parent) return
		const start = initial.current
		const editor = new EditorView({
			parent,
			state: EditorState.create({
				doc: start.text,
				extensions: [
					lineNumbers(),
					highlightActiveLine(),
					highlightActiveLineGutter(),
					drawSelection(),
					EditorState.readOnly.of(true),
					EditorView.editable.of(true),
					EditorState.tabSize.of(4),
					EditorView.contentAttributes.of({
						'aria-label': `${start.name}, read only`,
						'aria-readonly': 'true',
						spellcheck: 'false',
						autocorrect: 'off',
						autocapitalize: 'off',
					}),
					search({ top: true }),
					keymap.of([...searchKeymap, ...defaultKeymap]),
					readingKeys,
					phrases,
					languageSlot.current.of([]),
					syntaxHighlighting(helmHighlight),
					darkSlot.current.of(EditorView.darkTheme.of(start.theme === 'dark')),
					EditorView.updateListener.of(update => {
						if (update.selectionSet || update.docChanged) positionRef.current?.(positionOf(update.state))
					}),
				],
			}),
		})
		view.current = editor
		positionRef.current?.(positionOf(editor.state))
		return () => {
			editor.destroy()
			view.current = null
		}
	}, [])

	// Live reload: replace only the span that changed (common prefix and suffix kept), so the selection and cursor
	// map through it instead of collapsing to the start, and keep the scroll position.
	useEffect(() => {
		const editor = view.current
		if (!editor) return
		const before = editor.state.doc.toString()
		if (before === text) return
		const change = changedSpan(before, text)
		const scroll = editor.scrollSnapshot()
		editor.dispatch({ changes: change, effects: scroll })
	}, [text])

	useEffect(() => {
		let current = true
		void loadLanguage(language).then(extension => {
			if (current && view.current) view.current.dispatch({ effects: languageSlot.current.reconfigure(extension ?? []) })
		})
		return () => {
			current = false
		}
	}, [language])

	useEffect(() => {
		view.current?.dispatch({ effects: darkSlot.current.reconfigure(EditorView.darkTheme.of(theme === 'dark')) })
	}, [theme])

	useEffect(() => {
		if (zoom) view.current?.requestMeasure()
	}, [zoom])

	useEffect(() => {
		if (find && view.current) openSearchPanel(view.current)
	}, [find])

	// ⌘F / ⌘G / ⇧⌘G work wherever focus is in the window (the editor's own keymap covers focus inside it).
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const editor = view.current
			if (!editor || event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return
			if (editor.dom.contains(event.target as Node)) return
			const key = event.key.toLowerCase()
			if (key === 'f' && !event.shiftKey) {
				event.preventDefault()
				openSearchPanel(editor)
			} else if (key === 'g') {
				event.preventDefault()
				if (!getSearchQuery(editor.state).search) openSearchPanel(editor)
				else if (event.shiftKey) findPrevious(editor)
				else findNext(editor)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	return <div ref={host} className="viewer-code" data-viewer-code="" />
}

/** Open search with a query and select its first match (stories and tests). */
export function searchCode(root: ParentNode, query: string): boolean {
	const dom = root.querySelector<HTMLElement>('.viewer-code .cm-editor')
	const editor = dom ? EditorView.findFromDOM(dom) : null
	if (!editor) return false
	openSearchPanel(editor)
	editor.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query })) })
	findNext(editor)
	return true
}
