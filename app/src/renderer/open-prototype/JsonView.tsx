// Story-only `helm open` prototype: the structured-data renderer (JSON / JSONL / YAML / TOML).
// Tree (keyboard tree over a flattened, virtualized row list) and Raw (line-numbered source
// with display-only token coloring). Parsing never executes content: JSON.parse, the `yaml`
// core schema (no custom tags) and smol-toml only build plain values; nothing is rendered as HTML.
import { useVirtualizer } from '@tanstack/react-virtual'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { Btn, GLYPH } from '../sidebar/ui'
import { loadText } from './fixtures'
import './json.css'
import type { FeedbackHost, RendererProps } from './types'

// ---------------------------------------------------------------------------
// Model (pure)

type DataLanguage = 'JSON' | 'JSONL' | 'YAML' | 'TOML'

type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'date' | 'invalid'

/** A JSONL line that did not parse; kept as a leaf so the other lines still read. */
class InvalidLine {
	constructor(
		readonly source: string,
		readonly message: string,
	) {}
}

type Segment = string | number

interface Parsed {
	language: DataLanguage
	text: string
	lines: string[]
	/** Absent when the whole file failed to parse. */
	value?: unknown
	error?: string
	nodeCount: number
	/** JSONL: record index -> 1-based source line. */
	recordLines?: number[]
}

interface Row {
	path: string
	parentPath: string | null
	depth: number
	key: Segment | null
	/** Display label overriding the key (JSONL line numbers). */
	label?: string
	value: unknown
	kind: Kind
	/** Children count for containers. */
	size: number
}

function detectLanguage(name: string, hint?: string): DataLanguage {
	const ext = name.split('.').pop()?.toLowerCase() ?? ''
	if (ext === 'jsonl' || ext === 'ndjson') return 'JSONL'
	if (ext === 'yaml' || ext === 'yml') return 'YAML'
	if (ext === 'toml') return 'TOML'
	if (ext === 'json') return 'JSON'
	const h = hint?.toUpperCase()
	if (h === 'YAML' || h === 'TOML' || h === 'JSONL') return h
	return 'JSON'
}

function parseData(text: string, language: DataLanguage): Parsed {
	const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
	try {
		let value: unknown
		let recordLines: number[] | undefined
		if (language === 'JSON') value = JSON.parse(text)
		else if (language === 'YAML') value = parseYaml(text)
		else if (language === 'TOML') value = parseToml(text)
		else {
			const records: unknown[] = []
			recordLines = []
			lines.forEach((line, index) => {
				if (!line.trim()) return
				try {
					records.push(JSON.parse(line))
				} catch (error) {
					records.push(new InvalidLine(line, error instanceof Error ? error.message : String(error)))
				}
				recordLines?.push(index + 1)
			})
			value = records
		}
		return { language, text, lines, value, nodeCount: countNodes(value), recordLines }
	} catch (error) {
		return { language, text, lines, error: error instanceof Error ? error.message : String(error), nodeCount: 0 }
	}
}

function kindOf(value: unknown): Kind {
	if (value === null || value === undefined) return 'null'
	if (Array.isArray(value)) return 'array'
	if (value instanceof Date) return 'date'
	if (value instanceof InvalidLine) return 'invalid'
	switch (typeof value) {
		case 'string':
			return 'string'
		case 'number':
		case 'bigint':
			return 'number'
		case 'boolean':
			return 'boolean'
		case 'object':
			return 'object'
		default:
			return 'string'
	}
}

function entries(value: unknown, kind: Kind): [Segment, unknown][] {
	if (kind === 'array') return (value as unknown[]).map((child, index) => [index, child])
	if (kind === 'object') return Object.entries(value as Record<string, unknown>)
	return []
}

function sizeOf(value: unknown, kind: Kind): number {
	if (kind === 'array') return (value as unknown[]).length
	if (kind === 'object') return Object.keys(value as object).length
	return 0
}

/** Every value in the document, containers included. Iterative: deep files must not overflow. */
function countNodes(root: unknown): number {
	let count = 0
	const stack: unknown[] = [root]
	while (stack.length > 0) {
		const value = stack.pop()
		count += 1
		const kind = kindOf(value)
		for (const [, child] of entries(value, kind)) stack.push(child)
	}
	return count
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function childPath(parent: string, key: Segment): string {
	if (typeof key === 'number') return `${parent}[${key}]`
	if (IDENTIFIER.test(key)) return `${parent}.${key}`
	return `${parent}['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`
}

/** Inverse of childPath, for the paths this module writes ($, .ident, [n], ['quoted']). */
function parsePath(path: string): Segment[] | null {
	if (!path.startsWith('$')) return null
	const segments: Segment[] = []
	let i = 1
	while (i < path.length) {
		if (path[i] === '.') {
			const match = /^[A-Za-z_$][\w$]*/.exec(path.slice(i + 1))
			if (!match) return null
			segments.push(match[0])
			i += 1 + match[0].length
		} else if (path.startsWith("['", i)) {
			let j = i + 2
			let key = ''
			while (j < path.length && path[j] !== "'") {
				if (path[j] === '\\') j += 1
				key += path[j] ?? ''
				j += 1
			}
			if (path[j + 1] !== ']') return null
			segments.push(key)
			i = j + 2
		} else if (path[i] === '[') {
			const match = /^\[(\d+)\]/.exec(path.slice(i))
			if (!match?.[1]) return null
			segments.push(Number(match[1]))
			i += match[0].length
		} else return null
	}
	return segments
}

/** `$`, `$.a`, `$.a.b` … for a path, the path itself last. */
function pathChain(path: string): string[] {
	const segments = parsePath(path)
	if (!segments) return []
	const chain = ['$']
	let current = '$'
	for (const segment of segments) {
		current = childPath(current, segment)
		chain.push(current)
	}
	return chain
}

function isDescendant(path: string, ancestor: string): boolean {
	if (!path.startsWith(ancestor) || path.length === ancestor.length) return false
	const next = path[ancestor.length]
	return next === '.' || next === '['
}

/** The rows a reader can see: only expanded containers are walked (O(visible), not O(file)). */
function flatten(parsed: Parsed, expanded: ReadonlySet<string>): Row[] {
	const rows: Row[] = []
	if (parsed.value === undefined) return rows
	const walk = (
		value: unknown,
		path: string,
		parentPath: string | null,
		depth: number,
		key: Segment | null,
		label?: string,
	) => {
		const kind = kindOf(value)
		const size = sizeOf(value, kind)
		rows.push({ path, parentPath, depth, key, label, value, kind, size })
		if ((kind !== 'object' && kind !== 'array') || !expanded.has(path)) return
		const isRecords = depth === 0 && parsed.recordLines !== undefined
		for (const [childKey, child] of entries(value, kind)) {
			const childLabel =
				isRecords && typeof childKey === 'number' ? String(parsed.recordLines?.[childKey] ?? '') : undefined
			walk(child, childPath(path, childKey), path, depth + 1, childKey, childLabel)
		}
	}
	walk(parsed.value, '$', null, 0, null)
	return rows
}

/** Root plus its direct containers, unless the root is a long list (JSONL, big arrays). */
function initialExpanded(parsed: Parsed): Set<string> {
	const expanded = new Set<string>(['$'])
	const kind = kindOf(parsed.value)
	const children = entries(parsed.value, kind)
	if (children.length > 50 || parsed.language === 'JSONL') return expanded
	for (const [key, child] of children) {
		const childKind = kindOf(child)
		if (childKind === 'object' || childKind === 'array') expanded.add(childPath('$', key))
	}
	return expanded
}

function containerSummary(kind: Kind, size: number): string {
	if (kind === 'array') return `[${size} ${size === 1 ? 'item' : 'items'}]`
	return `{${size} ${size === 1 ? 'key' : 'keys'}}`
}

/** One-line literal text for a leaf, as it would read in the source. */
function leafText(value: unknown, kind: Kind): string {
	switch (kind) {
		case 'string':
			return JSON.stringify(value)
		case 'number':
		case 'boolean':
			return String(value)
		case 'null':
			return 'null'
		case 'date':
			return (value as Date).toISOString()
		case 'invalid':
			return (value as InvalidLine).source
		default:
			return ''
	}
}

/** Short preview for a feedback anchor. */
function previewOf(row: Row): string {
	if (row.kind === 'object' || row.kind === 'array') return containerSummary(row.kind, row.size)
	const text = leafText(row.value, row.kind)
	return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

function groupDigits(n: number): string {
	return n.toLocaleString('en-US').replace(/,/g, ' ')
}

// ---------------------------------------------------------------------------
// Raw source tokens (display-only coloring; plain text spans, never HTML).

type TokenType = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'comment' | 'section' | 'plain'
interface Token {
	t: TokenType
	s: string
}

const JSON_TOKEN =
	/"(?:[^"\\]|\\.)*"?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}[\],:]|\s+|[^\s"{}[\],:]+/g

function tokenizeJson(line: string): Token[] {
	const tokens: Token[] = []
	const parts = line.match(JSON_TOKEN) ?? []
	for (let i = 0; i < parts.length; i += 1) {
		const s = parts[i] ?? ''
		if (s.startsWith('"')) {
			let j = i + 1
			while (j < parts.length && /^\s+$/.test(parts[j] ?? '')) j += 1
			tokens.push({ t: parts[j] === ':' ? 'key' : 'string', s })
		} else if (/^-?\d/.test(s)) tokens.push({ t: 'number', s })
		else if (s === 'true' || s === 'false' || s === 'null') tokens.push({ t: 'literal', s })
		else if (/^[{}[\],:]$/.test(s)) tokens.push({ t: 'punct', s })
		else tokens.push({ t: 'plain', s })
	}
	return tokens
}

const SCALAR =
	/"(?:[^"\\]|\\.)*"?|'(?:[^']|'')*'?|\s+#.*$|-?(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|,|]|}|$)|\b(?:true|false|null|True|False|Null|NULL|~|inf|nan)\b|[{}[\],]|\s+|[^\s"'{}[\],]+/g

/** Value side of a YAML/TOML line: quoted strings, numbers, literals, flow punctuation. */
function tokenizeScalar(text: string, bareIsString: boolean): Token[] {
	const tokens: Token[] = []
	const parts = text.match(SCALAR) ?? []
	for (const s of parts) {
		if (/^\s+#/.test(s)) tokens.push({ t: 'comment', s })
		else if (s.startsWith('"') || s.startsWith("'")) tokens.push({ t: 'string', s })
		else if (/^-?(?:0x|\d)/.test(s)) tokens.push({ t: 'number', s })
		else if (/^(?:true|false|null|True|False|Null|NULL|~|inf|nan)$/.test(s)) tokens.push({ t: 'literal', s })
		else if (/^[{}[\],]$/.test(s)) tokens.push({ t: 'punct', s })
		else if (/^\s+$/.test(s)) tokens.push({ t: 'plain', s })
		else tokens.push({ t: bareIsString ? 'string' : 'plain', s })
	}
	// A bare multi-word scalar ("ubuntu-latest", "Run tests") reads as one string.
	if (bareIsString) {
		const merged: Token[] = []
		for (const token of tokens) {
			const last = merged[merged.length - 1]
			const prev = merged[merged.length - 2]
			if (
				token.t === 'string' &&
				last?.t === 'plain' &&
				prev?.t === 'string' &&
				!prev.s.startsWith('"') &&
				!prev.s.startsWith("'")
			) {
				merged.pop()
				prev.s += last.s + token.s
			} else merged.push({ ...token })
		}
		return merged
	}
	return tokens
}

/** Which YAML lines sit inside a `|` / `>` block scalar (computed once, O(lines)). */
function yamlBlockLines(lines: string[]): boolean[] {
	const inBlock = new Array<boolean>(lines.length).fill(false)
	let blockIndent = -1
	lines.forEach((line, index) => {
		const indent = line.length - line.trimStart().length
		if (blockIndent >= 0) {
			if (!line.trim() || indent > blockIndent) {
				inBlock[index] = true
				return
			}
			blockIndent = -1
		}
		const content = line.replace(/\s+#.*$/, '')
		if (/:\s*[|>][-+0-9]*\s*$/.test(content) || /^\s*-\s+[|>][-+0-9]*\s*$/.test(content)) blockIndent = indent
	})
	return inBlock
}

function tokenizeYaml(line: string, inBlock: boolean): Token[] {
	if (inBlock) return [{ t: 'string', s: line }]
	const tokens: Token[] = []
	const comment = /^(\s*)(#.*)$/.exec(line)
	if (comment)
		return [
			{ t: 'plain', s: comment[1] ?? '' },
			{ t: 'comment', s: comment[2] ?? '' },
		]
	let rest = line
	const lead = /^(\s*)((?:-\s+)*)/.exec(rest)
	if (lead) {
		if (lead[1]) tokens.push({ t: 'plain', s: lead[1] })
		if (lead[2]) tokens.push({ t: 'punct', s: lead[2] })
		rest = rest.slice(lead[0].length)
	}
	const key = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[][^:#]*?)(:)(\s|$)/.exec(rest)
	if (key) {
		tokens.push({ t: 'key', s: key[1] ?? '' }, { t: 'punct', s: key[2] ?? '' })
		rest = rest.slice((key[1]?.length ?? 0) + 1)
	}
	if (/^\s*[|>][-+0-9]*\s*$/.test(rest)) {
		tokens.push({ t: 'punct', s: rest })
		return tokens
	}
	const trimmed = rest.trimStart()
	// Flow collections and quoted scalars tokenize; a plain scalar is one value up to its comment.
	if (/^["'[{]/.test(trimmed) || !trimmed) return [...tokens, ...tokenizeScalar(rest, true)]
	const plain = /^(\s*)(.*?)(\s+#.*)?$/.exec(rest)
	const body = plain?.[2] ?? ''
	tokens.push({ t: 'plain', s: plain?.[1] ?? '' })
	const literal = /^(?:true|false|null|True|False|Null|NULL|~)$/.test(body)
	const numeric = /^-?(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(body)
	tokens.push({ t: literal ? 'literal' : numeric ? 'number' : 'string', s: body })
	if (plain?.[3]) tokens.push({ t: 'comment', s: plain[3] })
	return tokens
}

function tokenizeToml(line: string): Token[] {
	const comment = /^(\s*)(#.*)$/.exec(line)
	if (comment)
		return [
			{ t: 'plain', s: comment[1] ?? '' },
			{ t: 'comment', s: comment[2] ?? '' },
		]
	const section = /^(\s*)(\[\[?[^\]]*\]\]?)(.*)$/.exec(line)
	if (section)
		return [
			{ t: 'plain', s: section[1] ?? '' },
			{ t: 'section', s: section[2] ?? '' },
			...tokenizeScalar(section[3] ?? '', false),
		]
	const pair = /^(\s*)([^=#]+?)(\s*=\s*)(.*)$/.exec(line)
	if (pair)
		return [
			{ t: 'plain', s: pair[1] ?? '' },
			{ t: 'key', s: pair[2] ?? '' },
			{ t: 'punct', s: pair[3] ?? '' },
			...tokenizeScalar(pair[4] ?? '', false),
		]
	return tokenizeScalar(line, false)
}

// ---------------------------------------------------------------------------
// Renderer

type Mode = 'tree' | 'raw'

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; parsed: Parsed }

export interface JsonViewOptions {
	/** Story knob: start in Raw. */
	initialMode?: Mode
	/** Story knob: select this path and expand down to it. */
	initialPath?: string
	/** Story knob: also expand these containers (and their ancestors). */
	initialExpand?: string[]
}

export function JsonView(props: RendererProps) {
	return <JsonViewer {...props} />
}

export function JsonViewer({
	file,
	onStatus,
	feedback = null,
	initialMode = 'tree',
	initialPath,
	initialExpand,
}: RendererProps & JsonViewOptions) {
	const [load, setLoad] = useState<LoadState>({ status: 'loading' })
	const [mode, setMode] = useState<Mode>(initialMode)

	useEffect(() => {
		const controller = new AbortController()
		setLoad({ status: 'loading' })
		loadText(file, controller.signal)
			.then(text => setLoad({ status: 'ready', parsed: parseData(text, detectLanguage(file.name, file.language)) }))
			.catch(error => {
				if (!controller.signal.aborted)
					setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
			})
		return () => controller.abort()
	}, [file])

	if (load.status !== 'ready') {
		return (
			<div className="open-view open-json">
				{load.status === 'loading' ? (
					<p className="open-note">Opening {file.name}…</p>
				) : (
					<p className="open-note">
						<b>Couldn't read this file</b>
						{load.message}
					</p>
				)}
			</div>
		)
	}

	return (
		<JsonBody
			parsed={load.parsed}
			mode={mode}
			setMode={setMode}
			onStatus={onStatus}
			feedback={feedback}
			initialPath={initialPath}
			initialExpand={initialExpand}
		/>
	)
}

function JsonBody({
	parsed,
	mode,
	setMode,
	onStatus,
	feedback,
	initialPath,
	initialExpand,
}: {
	parsed: Parsed
	mode: Mode
	setMode: (mode: Mode) => void
	onStatus?: RendererProps['onStatus']
	feedback: FeedbackHost | null
	initialPath?: string
	initialExpand?: string[]
}) {
	const activePath = feedback?.active?.kind === 'json-path' ? feedback.active.path : null
	const [expanded, setExpanded] = useState<Set<string>>(() => {
		const set = initialExpanded(parsed)
		for (const path of [...(initialExpand ?? []), initialPath, activePath]) {
			if (!path) continue
			const chain = pathChain(path)
			// Expand the ancestors of a selected path; an explicit expand also opens the node itself.
			const open = initialExpand?.includes(path) ? chain : chain.slice(0, -1)
			for (const p of open) set.add(p)
		}
		return set
	})
	const [selected, setSelected] = useState<string>(() => initialPath ?? activePath ?? '$')
	const [copied, setCopied] = useState(false)

	// A newly active anchor (set by the chrome) is revealed, never collapsed away.
	useEffect(() => {
		if (!activePath) return
		setExpanded(current => {
			const chain = pathChain(activePath).slice(0, -1)
			if (chain.every(p => current.has(p))) return current
			const next = new Set(current)
			for (const p of chain) next.add(p)
			return next
		})
	}, [activePath])

	const rows = useMemo(() => flatten(parsed, expanded), [parsed, expanded])
	const lineCount = parsed.lines.length

	useEffect(() => {
		// The language is the format word the chrome already prints (formatWord), so it is not repeated here.
		const facts = [`${groupDigits(parsed.nodeCount)} nodes`]
		if (parsed.language === 'JSONL' && Array.isArray(parsed.value))
			facts.unshift(`${groupDigits(parsed.value.length)} records`)
		if (parsed.error) facts[facts.length - 1] = 'not parsed'
		onStatus?.({
			position: mode === 'tree' && !parsed.error ? selected : `${groupDigits(lineCount)} lines`,
			facts,
		})
	}, [onStatus, parsed, mode, selected, lineCount])

	useEffect(() => {
		if (!copied) return
		const timer = window.setTimeout(() => setCopied(false), 1200)
		return () => window.clearTimeout(timer)
	}, [copied])

	const copyPath = async () => {
		try {
			await navigator.clipboard.writeText(selected)
			setCopied(true)
		} catch {
			// Clipboard refused (permissions, unfocused document): the path stays selectable text.
		}
	}

	const showTree = mode === 'tree' && !parsed.error

	return (
		<div className="open-view open-json">
			<div className="open-json-toolbar">
				<fieldset className="open-json-seg" aria-label="View">
					<button type="button" aria-pressed={mode === 'tree'} onClick={() => setMode('tree')}>
						Tree
					</button>
					<button type="button" aria-pressed={mode === 'raw'} onClick={() => setMode('raw')}>
						Raw
					</button>
				</fieldset>
				{showTree ? (
					<>
						<span className="open-json-path open-mono" title={selected}>
							<span>{selected}</span>
						</span>
						<Btn
							tone="ghost"
							sm
							className="open-json-copy"
							ariaLabel={copied ? 'Path copied' : 'Copy path'}
							title="Copy path"
							onClick={copyPath}
						>
							{copied ? GLYPH.check : GLYPH.copy}
						</Btn>
					</>
				) : null}
			</div>
			{mode === 'tree' && parsed.error ? (
				<div className="open-json-scroll">
					<p className="open-note">
						<b>This isn't valid {parsed.language}</b>
						{parsed.error}
						<br />
						Raw shows the file as it is.
					</p>
				</div>
			) : showTree ? (
				<JsonTree
					rows={rows}
					language={parsed.language}
					selected={selected}
					setSelected={setSelected}
					expanded={expanded}
					setExpanded={setExpanded}
					feedback={feedback}
					activePath={activePath}
				/>
			) : (
				<RawSource parsed={parsed} />
			)}
		</div>
	)
}

const ROW_HEIGHT = 24
const INDENT = 16

function JsonTree({
	rows,
	language,
	selected,
	setSelected,
	expanded,
	setExpanded,
	feedback,
	activePath,
}: {
	rows: Row[]
	language: DataLanguage
	selected: string
	setSelected: (path: string) => void
	expanded: Set<string>
	setExpanded: (update: (current: Set<string>) => Set<string>) => void
	feedback: FeedbackHost | null
	activePath: string | null
}) {
	const scrollRef = useRef<HTMLDivElement>(null)
	const baseId = useId()
	const indexByPath = useMemo(() => new Map(rows.map((row, index) => [row.path, index])), [rows])
	const selectedIndex = indexByPath.get(selected) ?? 0
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 16,
	})

	// Keep the selected row rendered and in view (aria-activedescendant needs it in the DOM).
	// The first reveal centers it, so an initial deep selection shows its surroundings.
	const revealed = useRef(false)
	useEffect(() => {
		virtualizer.scrollToIndex(selectedIndex, { align: revealed.current ? 'auto' : 'center' })
		revealed.current = true
	}, [virtualizer, selectedIndex])

	const toggle = (row: Row, open?: boolean) => {
		if (row.kind !== 'object' && row.kind !== 'array') return
		setExpanded(current => {
			const isOpen = current.has(row.path)
			const want = open ?? !isOpen
			if (want === isOpen) return current
			const next = new Set(current)
			if (want) next.add(row.path)
			else next.delete(row.path)
			return next
		})
		if (open === false || (open === undefined && expanded.has(row.path))) {
			if (isDescendant(selected, row.path)) setSelected(row.path)
		}
	}

	const anchor = (row: Row, element: Element) => {
		feedback?.onAnchor({ kind: 'json-path', path: row.path, preview: previewOf(row) }, element.getBoundingClientRect())
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const row = rows[selectedIndex]
		if (!row) return
		const isContainer = row.kind === 'object' || row.kind === 'array'
		const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 240) / ROW_HEIGHT) - 1)
		const go = (index: number) => {
			const target = rows[Math.max(0, Math.min(rows.length - 1, index))]
			if (target) setSelected(target.path)
		}
		switch (event.key) {
			case 'ArrowDown':
				go(selectedIndex + 1)
				break
			case 'ArrowUp':
				go(selectedIndex - 1)
				break
			case 'PageDown':
				go(selectedIndex + pageRows)
				break
			case 'PageUp':
				go(selectedIndex - pageRows)
				break
			case 'Home':
				go(0)
				break
			case 'End':
				go(rows.length - 1)
				break
			case 'ArrowRight':
				if (!isContainer || row.size === 0) break
				if (expanded.has(row.path)) go(selectedIndex + 1)
				else toggle(row, true)
				break
			case 'ArrowLeft':
				if (isContainer && expanded.has(row.path)) toggle(row, false)
				else if (row.parentPath) setSelected(row.parentPath)
				break
			case 'Enter': {
				// Feedback mode: Enter points at the row (the keyboard twin of a click); Space toggles.
				const element = document.getElementById(`${baseId}-${selectedIndex}`)
				if (feedback && element) anchor(row, element)
				else toggle(row)
				break
			}
			case ' ':
				toggle(row)
				break
			case '*': {
				const siblings = rows.filter(
					r => r.parentPath === row.parentPath && (r.kind === 'object' || r.kind === 'array'),
				)
				setExpanded(current => {
					const next = new Set(current)
					for (const sibling of siblings) next.add(sibling.path)
					return next
				})
				break
			}
			default:
				return
		}
		event.preventDefault()
	}

	const items = virtualizer.getVirtualItems()
	return (
		<div
			ref={scrollRef}
			className={`open-json-scroll open-json-tree${feedback ? ' is-feedback' : ''}`}
			role="tree"
			aria-label={`${language} tree`}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the tree is one focus stop (APG aria-activedescendant pattern)
			tabIndex={0}
			aria-activedescendant={rows[selectedIndex] ? `${baseId}-${selectedIndex}` : undefined}
			onKeyDown={onKeyDown}
		>
			<div className="open-json-rows" style={{ height: virtualizer.getTotalSize() }} role="presentation">
				{items.map(item => {
					const row = rows[item.index]
					if (!row) return null
					const isContainer = row.kind === 'object' || row.kind === 'array'
					const isOpen = isContainer && expanded.has(row.path)
					const classes = ['open-json-row']
					if (row.path === selected) classes.push('is-selected')
					if (row.path === activePath) classes.push('is-anchor')
					return (
						// biome-ignore lint/a11y/useKeyWithClickEvents: keys live on the tree (aria-activedescendant), not per row
						<div
							key={row.path}
							id={`${baseId}-${item.index}`}
							className={classes.join(' ')}
							role="treeitem"
							aria-level={row.depth + 1}
							aria-expanded={isContainer && row.size > 0 ? isOpen : undefined}
							aria-selected={row.path === selected}
							style={{ transform: `translateY(${item.start}px)`, paddingLeft: 16 + row.depth * INDENT }}
							onClick={event => {
								setSelected(row.path)
								if (feedback) anchor(row, event.currentTarget)
							}}
							onDoubleClick={() => {
								if (!feedback) toggle(row)
							}}
						>
							{/* biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut; Space/Enter/arrows toggle from the tree */}
							<span
								className="open-json-twisty"
								aria-hidden="true"
								onClick={event => {
									if (!isContainer || row.size === 0) return
									event.stopPropagation()
									setSelected(row.path)
									toggle(row)
								}}
							>
								{isContainer && row.size > 0 ? (isOpen ? '▾' : '▸') : ''}
							</span>
							<RowKey row={row} />
							{isContainer ? (
								<span className="open-json-summary">{containerSummary(row.kind, row.size)}</span>
							) : (
								<RowValue row={row} />
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}

function RowKey({ row }: { row: Row }) {
	if (row.key === null) return <span className="open-json-key is-root">$</span>
	if (row.label !== undefined) {
		return (
			<span className="open-json-key is-index" title={`Line ${row.label}`}>
				{row.label}
				<span className="open-json-colon">:</span>
			</span>
		)
	}
	return (
		<span className={`open-json-key${typeof row.key === 'number' ? ' is-index' : ''}`} title={String(row.key)}>
			{row.key}
			<span className="open-json-colon">:</span>
		</span>
	)
}

function RowValue({ row }: { row: Row }) {
	const text = leafText(row.value, row.kind)
	if (row.kind === 'invalid') {
		return (
			<span className="open-json-value is-invalid" title={(row.value as InvalidLine).message}>
				<span className="open-json-invalid-mark">
					<span className="open-json-invalid-glyph" aria-hidden="true">
						×
					</span>{' '}
					not valid JSON
				</span>{' '}
				{text}
			</span>
		)
	}
	return (
		<span className={`open-json-value is-${row.kind}`} title={row.kind === 'string' ? String(row.value) : text}>
			{text}
		</span>
	)
}

const LINE_HEIGHT = 20

function RawSource({ parsed }: { parsed: Parsed }) {
	const scrollRef = useRef<HTMLElement>(null)
	const { lines, language } = parsed
	const blockLines = useMemo(() => (language === 'YAML' ? yamlBlockLines(lines) : null), [language, lines])
	// Small files render every line (so select-all + copy takes the whole file); big ones window.
	const virtualizer = useVirtualizer({
		count: lines.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => LINE_HEIGHT,
		overscan: lines.length <= 2000 ? lines.length : 40,
	})
	const gutter = `${String(lines.length).length}ch`
	const tokensFor = (index: number): Token[] => {
		const line = lines[index] ?? ''
		if (language === 'YAML') return tokenizeYaml(line, blockLines?.[index] ?? false)
		if (language === 'TOML') return tokenizeToml(line)
		return tokenizeJson(line)
	}
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable source region must be keyboard-scrollable
		<section ref={scrollRef} className="open-json-scroll open-json-raw" tabIndex={0} aria-label={`${language} source`}>
			<pre className="open-json-pre" style={{ height: virtualizer.getTotalSize() + 16 }}>
				{virtualizer.getVirtualItems().map(item => (
					<div key={item.index} className="open-json-line" style={{ transform: `translateY(${item.start}px)` }}>
						<span className="open-json-ln" style={{ width: gutter }} aria-hidden="true">
							{item.index + 1}
						</span>
						<code className="open-json-code">
							{tokensFor(item.index).map((token, i) =>
								token.t === 'plain' ? (
									token.s
								) : (
									// biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional within one line
									<span key={i} className={`tok-${token.t}`}>
										{token.s}
									</span>
								),
							)}
							{'\n'}
						</code>
					</div>
				))}
			</pre>
		</section>
	)
}
