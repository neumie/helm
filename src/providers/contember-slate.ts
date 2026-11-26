import type { DescriptionBlock } from './provider.js'

/**
 * Contember (ClientCare) rich text is SlateJS JSON: `{ children: Node[], formatVersion }`
 * (comments are sometimes stored as a bare `Node[]`). Element nodes carry `type`
 * (`paragraph`, `heading` + `level`, `unorderedList`/`orderedList` → `listItem`,
 * `anchor` + `href`, `image`/`file` + `referenceId`, `table` → `tableRow` →
 * `tableCell`, `horizontalRule`) and an editor-internal `key`; text leaves carry
 * `text` plus marks (`isBold`/`bold`, `isItalic`, `isCode`, `isStruckThrough`,
 * `isUnderlined`, `color`).
 *
 * Text is read ONLY from leaf `text` (and a few known caption fields), never from
 * arbitrary object keys: an earlier fallback walked every key of a node with no
 * text and leaked the Slate `key` of whitespace-only paragraphs ("akrnuh") into
 * task descriptions.
 */

export interface SlateReference {
	id?: string | null
	file?: { url?: string | null; fileName?: string | null; fileType?: string | null } | null
}

interface ReferenceFile {
	url: string
	name?: string
	contentType?: string
}

type SlateNode = Record<string, unknown>

const MAX_DEPTH = 24
/** A GitHub issue body holds 65,536 characters; nothing longer is useful. */
const MARKDOWN_BUDGET = 60_000
const TEXT_KEYS = ['text', 'title', 'caption', 'alt', 'markdown'] as const
const CONTAINER_KEYS = ['children', 'content', 'nodes', 'items', 'document', 'value', 'data'] as const

function isNode(value: unknown): value is SlateNode {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The top-level node list of a Slate document (`{ children }` or a bare array). */
export function slateRootNodes(data: unknown): unknown[] {
	if (Array.isArray(data)) return data
	if (isNode(data) && Array.isArray(data.children)) return data.children
	return []
}

/**
 * Flat plain text of a Slate value: text leaves (plus known caption fields) in
 * document order, whitespace collapsed. Used for the solve prompt, comments and
 * project descriptions.
 */
export function extractPlainText(value: unknown, depth = 0): string {
	if (depth > MAX_DEPTH || value === null || value === undefined) return ''
	if (typeof value === 'string') return value.trim()
	if (Array.isArray(value)) {
		return value
			.map(item => extractPlainText(item, depth + 1))
			.filter(Boolean)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim()
	}
	if (!isNode(value)) return ''

	const chunks: string[] = []
	for (const key of TEXT_KEYS) {
		const entry = value[key]
		if (typeof entry === 'string' && !isBlank(entry)) chunks.push(entry.trim())
	}
	for (const key of CONTAINER_KEYS) {
		const nested = extractPlainText(value[key], depth + 1)
		if (nested) chunks.push(nested)
	}
	return chunks.join(' ').replace(/\s+/g, ' ').trim()
}

function referenceMap(references: readonly (SlateReference | null | undefined)[] | null | undefined) {
	const map = new Map<string, ReferenceFile>()
	for (const ref of references ?? []) {
		if (ref?.id && ref.file?.url) {
			map.set(ref.id, {
				url: ref.file.url,
				name: ref.file.fileName ?? undefined,
				contentType: ref.file.fileType ?? undefined,
			})
		}
	}
	return map
}

/**
 * Walk the top-level Slate blocks in document order, emitting text blocks and
 * inline image blocks (resolved via `referenceId` → references[].file.url), so
 * the dashboard can render images between the surrounding paragraphs instead of
 * collecting them all at the end. Non-image references stay out (they surface as
 * attachments); whitespace-only and unrecognized blocks degrade to nothing.
 */
export function extractDescriptionBlocks(
	data: unknown,
	references: readonly (SlateReference | null | undefined)[] | null | undefined,
): DescriptionBlock[] {
	const refMap = referenceMap(references)
	const blocks: DescriptionBlock[] = []
	for (const child of slateRootNodes(data)) {
		const node = isNode(child) ? child : {}
		if (node.type === 'image' && typeof node.referenceId === 'string' && refMap.has(node.referenceId)) {
			const file = refMap.get(node.referenceId)
			if (file) blocks.push({ type: 'image', ...file })
			continue
		}
		const text = extractPlainText(child)
		if (!isBlank(text)) {
			const heading = node.type === 'heading' && typeof node.level === 'number' ? node.level : undefined
			blocks.push(heading ? { type: 'text', text, heading } : { type: 'text', text })
		}
	}
	return blocks
}

// -- Markdown --

interface Marks {
	bold: boolean
	italic: boolean
	strike: boolean
	code: boolean
}

interface Run {
	text: string
	marks: Marks
}

function leafMarks(leaf: SlateNode): Marks {
	return {
		bold: leaf.isBold === true || leaf.bold === true,
		italic: leaf.isItalic === true || leaf.italic === true,
		strike: leaf.isStruckThrough === true || leaf.strikethrough === true,
		code: leaf.isCode === true || leaf.code === true,
	}
}

function sameMarks(a: Marks, b: Marks): boolean {
	return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code
}

function hasControlCharacter(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index)
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

// Spaces inside a URL are percent-encoded by linkDestination; control characters never make a link.
function isSafeImageUrl(url: string): boolean {
	return /^https?:\/\/\S/i.test(url) && !hasControlCharacter(url)
}

function isSafeLinkUrl(url: string): boolean {
	return /^(https?:\/\/|mailto:)\S/i.test(url) && !hasControlCharacter(url)
}

/** A link destination that cannot end the `(...)` early or hide a markdown escape. */
function linkDestination(url: string): string {
	return url.replace(/[()<>\\\s]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** Text that cannot close a `[...]` link label. */
function escapeLabel(text: string): string {
	return text.replace(/[\\[\]]/g, '\\$&')
}

function codeSpan(text: string): string {
	let longest = 0
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
	const fence = '`'.repeat(longest + 1)
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
	return `${fence}${pad}${text}${pad}${fence}`
}

const ZERO_WIDTH = /\u200b|\u200c|\u200d|\u2060|\ufeff/g

/** Whitespace-only, counting zero-width characters as whitespace. */
function isBlank(text: string): boolean {
	return text.replace(ZERO_WIDTH, '').trim().length === 0
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * One marked segment (no blank line inside). Markdown delimiters only work when
 * they flank the text: `**Stav:**hotovo` stays literal on GitHub. Where a word
 * character touches a delimiter that sits next to punctuation (or a code span),
 * the run falls back to the equivalent HTML tags, which GitHub allows.
 */
function renderMarked(core: string, marks: Marks, inLabel: boolean, before: string, after: string): string {
	const first = core[0] ?? ''
	const last = core.at(-1) ?? ''
	const flanks =
		!marks.code &&
		(!WORD_CHARACTER.test(before) || WORD_CHARACTER.test(first)) &&
		(!WORD_CHARACTER.test(after) || WORD_CHARACTER.test(last))
	const needsDelimiters = marks.bold || marks.italic || marks.strike
	if (!needsDelimiters || flanks || !(WORD_CHARACTER.test(before) || WORD_CHARACTER.test(after))) {
		let out = marks.code ? codeSpan(core.replace(/\n/g, ' ')) : inLabel ? escapeLabel(core) : core
		if (marks.strike) out = `~~${out}~~`
		if (marks.italic) out = `*${out}*`
		if (marks.bold) out = `**${out}**`
		return out
	}
	let out = marks.code ? `<code>${escapeHtml(core.replace(/\n/g, ' '))}</code>` : inLabel ? escapeLabel(core) : core
	if (marks.strike) out = `<del>${out}</del>`
	if (marks.italic) out = `<em>${out}</em>`
	if (marks.bold) out = `<strong>${out}</strong>`
	return out
}

/**
 * One mark-run as markdown. Whitespace stays outside the delimiters so `**word**`
 * renders, and a run is wrapped per paragraph: emphasis cannot cross a blank line.
 */
function renderRun(run: Run, inLabel: boolean, before: string, after: string): string {
	const { marks } = run
	if (!marks.bold && !marks.italic && !marks.strike && !marks.code) return inLabel ? escapeLabel(run.text) : run.text
	const pieces = run.text.split(/(\n[^\S\n]*\n\s*)/)
	return pieces
		.map((piece, index) => {
			if (index % 2 === 1) return piece
			const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece)
			const lead = match?.[1] ?? ''
			const core = match?.[2] ?? ''
			const trail = match?.[3] ?? ''
			if (!core) return inLabel ? escapeLabel(piece) : piece
			const left = lead ? ' ' : index === 0 ? before : '\n'
			const right = trail ? ' ' : index === pieces.length - 1 ? after : '\n'
			return `${lead}${renderMarked(core, marks, inLabel, left, right)}${trail}`
		})
		.join('')
}

function renderRuns(runs: Run[], inLabel: boolean): string {
	const merged: Run[] = []
	for (const run of runs) {
		const last = merged.at(-1)
		if (last && sameMarks(last.marks, run.marks)) last.text += run.text
		else merged.push({ text: run.text, marks: run.marks })
	}
	return merged
		.map((run, index) =>
			renderRun(run, inLabel, merged[index - 1]?.text.at(-1) ?? '', merged[index + 1]?.text[0] ?? ''),
		)
		.join('')
}

interface Context {
	refs: Map<string, ReferenceFile>
}

/** Inline content (leaves, links, inline images) of one block as markdown. */
function renderInline(nodes: unknown, ctx: Context, depth: number, inLabel = false): string {
	if (!Array.isArray(nodes) || depth > MAX_DEPTH) return ''
	let out = ''
	let runs: Run[] = []
	const flush = () => {
		out += renderRuns(runs, inLabel)
		runs = []
	}
	for (const child of nodes) {
		if (!isNode(child)) continue
		if (typeof child.text === 'string') {
			runs.push({ text: child.text, marks: leafMarks(child) })
			continue
		}
		flush()
		if (child.type === 'anchor') {
			const label = renderInline(child.children, ctx, depth + 1, true).trim()
			const href = typeof child.href === 'string' ? child.href.trim() : ''
			if (href && isSafeLinkUrl(href) && !inLabel) {
				const shown = label || escapeLabel(href.replace(/^mailto:/i, ''))
				out += `[${shown}](${linkDestination(href)})`
			} else {
				out += label
			}
			continue
		}
		if (child.type === 'image') {
			out += imageMarkdown(child, ctx)
			continue
		}
		// Unknown inline element: keep its text, never its keys.
		out += renderInline(child.children, ctx, depth + 1, inLabel)
	}
	flush()
	return out
}

function imageMarkdown(node: SlateNode, ctx: Context): string {
	const file = typeof node.referenceId === 'string' ? ctx.refs.get(node.referenceId) : undefined
	if (!file || !isSafeImageUrl(file.url)) return ''
	return `![${escapeLabel(file.name ?? 'image')}](${linkDestination(file.url)})`
}

function isInlineNode(node: unknown): boolean {
	return isNode(node) && (typeof node.text === 'string' || node.type === 'anchor')
}

/** Collapse an inline paragraph to its markdown, dropping whitespace-only content. */
function paragraphText(markdown: string): string {
	return isBlank(markdown) ? '' : markdown.trim()
}

/** Indent every line after the first so it stays inside a list item. */
function indentContinuation(text: string, indent: string): string {
	return text.replace(/\n/g, `\n${indent}`)
}

function renderList(node: SlateNode, ctx: Context, depth: number): string {
	const ordered = node.type === 'orderedList'
	const items = Array.isArray(node.children) ? node.children : []
	const lines: string[] = []
	let number = 1
	for (const item of items) {
		if (!isNode(item)) continue
		const body = renderListItem(item, ctx, depth + 1)
		if (!body) continue
		const marker = ordered ? `${number}. ` : '- '
		number++
		lines.push(`${marker}${indentContinuation(body, ' '.repeat(marker.length))}`)
	}
	return lines.join('\n')
}

function renderListItem(item: SlateNode, ctx: Context, depth: number): string {
	const children = Array.isArray(item.children) ? item.children : []
	// A list item may hold inline content directly, block children, or a mix.
	const parts: string[] = []
	let inline: unknown[] = []
	const flushInline = () => {
		const text = paragraphText(renderInline(inline, ctx, depth))
		if (text) parts.push(text)
		inline = []
	}
	for (const child of children) {
		if (isInlineNode(child)) {
			inline.push(child)
			continue
		}
		flushInline()
		const block = renderBlock(child, ctx, depth + 1)
		if (block) parts.push(block)
	}
	flushInline()
	return parts.join('\n')
}

function tableCellText(cell: unknown, ctx: Context, depth: number): string {
	if (!isNode(cell)) return ''
	const children = Array.isArray(cell.children) ? cell.children : []
	const parts = children.map(child =>
		isInlineNode(child) ? renderInline([child], ctx, depth) : renderBlock(child, ctx, depth),
	)
	return parts
		.join(' ')
		.replace(/\s*\n\s*/g, '<br>')
		.replace(/(\\*)\|/g, (_, slashes: string) => `${slashes}${slashes}\\|`)
		.trim()
}

const TABLE_MAX_ROWS = 500
const TABLE_MAX_COLUMNS = 50

function renderTable(node: SlateNode, ctx: Context, depth: number): string {
	const allRows = (Array.isArray(node.children) ? node.children : []).filter(isNode)
	const rows = allRows
		.slice(0, TABLE_MAX_ROWS)
		.map(row =>
			(Array.isArray(row.children) ? row.children : [])
				.slice(0, TABLE_MAX_COLUMNS)
				.map(cell => tableCellText(cell, ctx, depth + 1)),
		)
		.filter(row => row.length > 0)
	if (rows.length === 0) return ''
	const width = Math.max(...rows.map(row => row.length))
	const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`
	const [header = [], ...body] = rows
	const table = [line(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)]
	const cut =
		allRows.length > TABLE_MAX_ROWS ||
		allRows.some(row => Array.isArray(row.children) && row.children.length > TABLE_MAX_COLUMNS)
	return cut ? `${table.join('\n')}\n\n_(table truncated)_` : table.join('\n')
}

function renderBlock(node: unknown, ctx: Context, depth: number): string {
	if (!isNode(node) || depth > MAX_DEPTH) return ''
	switch (node.type) {
		case 'heading': {
			const text = paragraphText(renderInline(node.children, ctx, depth + 1))
			if (!text) return ''
			const level = typeof node.level === 'number' ? Math.min(6, Math.max(1, Math.trunc(node.level))) : 2
			return `${'#'.repeat(level)} ${text.replace(/\n+/g, ' ')}`
		}
		case 'unorderedList':
		case 'orderedList':
			return renderList(node, ctx, depth)
		case 'listItem':
			return renderListItem(node, ctx, depth)
		case 'image':
			return imageMarkdown(node, ctx)
		case 'file':
			// Non-image references surface as the task's attachment list.
			return ''
		case 'table':
			return renderTable(node, ctx, depth)
		case 'horizontalRule':
			// `***`, not `---`: right under a line of text `---` makes that line a heading.
			return '***'
		default: {
			const children = Array.isArray(node.children) ? node.children : []
			if (children.length > 0 && !children.some(isInlineNode) && children.every(isNode)) {
				// Unknown container of blocks: render its blocks.
				return children
					.map(child => renderBlock(child, ctx, depth + 1))
					.filter(Boolean)
					.join('\n\n')
			}
			return paragraphText(renderInline(children, ctx, depth + 1))
		}
	}
}

/**
 * The description as GitHub-flavoured markdown: paragraphs, headings, bullet and
 * numbered lists (nested), links (http(s) and mailto), bold/italic/strikethrough/
 * inline code, inline images, tables and rules. Whitespace-only blocks are
 * dropped. Leaf text is inserted as written (tasks sometimes carry markdown typed
 * as text, e.g. ones Helm promoted from email), so callers that show it to
 * readers must still treat it as untrusted.
 */
export function slateToMarkdown(
	data: unknown,
	references?: readonly (SlateReference | null | undefined)[] | null,
): string {
	const ctx: Context = { refs: referenceMap(references) }
	let out = ''
	let previousList: unknown
	for (const node of slateRootNodes(data)) {
		const block = renderBlock(node, ctx, 0)
		if (isBlank(block)) continue
		const list = isNode(node) && (node.type === 'unorderedList' || node.type === 'orderedList') ? node.type : null
		// Two lists of one kind in a row would merge into one (renumbered) list.
		if (out) out += list && list === previousList ? '\n\n<!-- -->\n\n' : '\n\n'
		out += block
		previousList = list
		if (out.length > MARKDOWN_BUDGET) return `${out.slice(0, MARKDOWN_BUDGET)}\n\n… (truncated)`
	}
	return out
}
