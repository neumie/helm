// JSON / JSON Lines / YAML / TOML for the data view (docs/plans/helm-open/spec.md, Formats tier 1). Pure and
// iterative: it runs inside the data worker, which keeps the parsed value and answers with plain rows, so the window
// never receives a 32 MiB object graph. Node ids are RFC 6901 JSON Pointers ('' is the root).
import { parse as parseToml } from 'smol-toml'
import { parseAllDocuments } from 'yaml'
import type { DataLanguage } from '../../../../src/document-review/formats'

/** "Billion laughs": YAML aliases a document may expand. */
export const YAML_ALIAS_LIMIT = 100
/** Children of one node listed before an "N more" row (formats.ts VIEWER_DATA_CHILDREN). */
export const CHILD_LIMIT = 10_000
/** Rows one tree projection returns; deeper expansion beyond it is cut with a note. */
export const ROW_LIMIT = 200_000
/** Matches one search returns, and nodes it may visit. */
export const MATCH_LIMIT = 1_000
export const SEARCH_VISITS = 2_000_000
/** Largest node ⌘C copies as JSON. */
export const COPY_LIMIT = 4 * 1024 * 1024
const PREVIEW = 200

/** A JSON Lines line that is not JSON: shown as an invalid leaf, the other records still parse. */
export class InvalidLine {
	constructor(
		readonly source: string,
		readonly message: string,
	) {}
}
/** JSON Lines records, keyed by their 1-based line number. */
export class JsonLines {
	constructor(
		readonly lines: number[],
		readonly values: unknown[],
	) {}
}
/** A YAML file with several `---` documents. */
export class YamlDocuments {
	constructor(readonly values: unknown[]) {}
}

export interface ParsedData {
	root: unknown
	/** First line of the parser's message, never a stack; null when the file parsed. */
	error: string | null
}

const firstLine = (error: unknown) => {
	const text = error instanceof Error ? error.message : String(error)
	return (text.split('\n').find(line => line.trim()) ?? 'unreadable').trim().slice(0, 300)
}

/** A digit run long enough to pass 2^53: only then does JSON parsing pay for the exact-integer reviver. */
const LONG_DIGITS = /\d{16}/
type SourceContext = { source?: string }
/** JSON.parse keeping integers beyond 2^53 exact (as bigint), from the parser's own source text. */
function parseJson(text: string): unknown {
	if (!LONG_DIGITS.test(text)) return JSON.parse(text)
	return JSON.parse(text, (_key, value: unknown, context?: SourceContext) => {
		if (typeof value !== 'number' || Number.isSafeInteger(value) || !Number.isFinite(value)) return value
		const source = context?.source
		return source && /^-?\d+$/.test(source) ? BigInt(source) : value
	})
}

const byteString = (bytes: Uint8Array) => {
	let binary = ''
	for (let index = 0; index < bytes.length; index += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
	return btoa(binary)
}
/**
 * YAML's JavaScript values as the tree shows them: `!!omap`/`!!pairs` maps become objects in order, `!!set` an array,
 * `!!binary` its base64 text, and integers parsed as bigint go back to numbers while they are exact. Iterative, and
 * aliases (shared references) convert once.
 */
function plainYaml(value: unknown): unknown {
	const converted = new WeakMap<object, unknown>()
	const leaf = (item: unknown): unknown => {
		if (typeof item === 'bigint')
			return item >= Number.MIN_SAFE_INTEGER && item <= Number.MAX_SAFE_INTEGER ? Number(item) : item
		if (ArrayBuffer.isView(item)) return byteString(new Uint8Array(item.buffer, item.byteOffset, item.byteLength))
		return item
	}
	const stack: { value: object; done: boolean }[] = []
	const container = (item: unknown): unknown => {
		if (item === null || typeof item !== 'object' || item instanceof Date || ArrayBuffer.isView(item)) return leaf(item)
		const known = converted.get(item)
		if (known !== undefined) return known
		let target: Record<string, unknown> | unknown[]
		if (item instanceof Map) {
			const object: Record<string, unknown> = {}
			for (const [key, child] of item)
				Object.defineProperty(object, String(key), {
					value: child,
					enumerable: true,
					writable: true,
					configurable: true,
				})
			target = object
		} else if (item instanceof Set) target = [...item]
		else target = item as Record<string, unknown> | unknown[]
		converted.set(item, target)
		stack.push({ value: target, done: false })
		return target
	}
	const root = container(value)
	while (stack.length) {
		const next = stack.pop() as { value: object }
		const record = next.value as Record<string, unknown>
		for (const key of Object.keys(record)) record[key] = container(record[key])
	}
	return root
}

export function parseData(text: string, language: DataLanguage): ParsedData {
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
	try {
		if (language === 'json') return { root: parseJson(source), error: null }
		if (language === 'jsonl') {
			const lines: number[] = []
			const values: unknown[] = []
			let line = 0
			for (const raw of source.split(/\r?\n/)) {
				line++
				if (!raw.trim()) continue
				lines.push(line)
				try {
					values.push(parseJson(raw))
				} catch (error) {
					values.push(new InvalidLine(raw.slice(0, PREVIEW), firstLine(error)))
				}
			}
			return { root: new JsonLines(lines, values), error: null }
		}
		if (language === 'yaml') {
			const documents = parseAllDocuments(source, { prettyErrors: false, merge: true, intAsBigInt: true })
			const list = Array.isArray(documents) ? documents : [documents]
			for (const document of list) {
				const problem = document.errors[0]
				if (problem) return { root: null, error: firstLine(problem) }
			}
			const values = list.map(document => plainYaml(document.toJS({ maxAliasCount: YAML_ALIAS_LIMIT })))
			return { root: values.length === 1 ? values[0] : new YamlDocuments(values), error: null }
		}
		return { root: parseToml(source, { integersAsBigInt: 'asNeeded' }), error: null }
	} catch (error) {
		return { root: null, error: firstLine(error) }
	}
}

export type NodeKind =
	| 'object'
	| 'array'
	| 'string'
	| 'number'
	| 'boolean'
	| 'null'
	| 'date'
	| 'invalid'
	| 'records'
	| 'documents'

export function kindOf(value: unknown): NodeKind {
	if (value === null || value === undefined) return 'null'
	if (value instanceof InvalidLine) return 'invalid'
	if (value instanceof JsonLines) return 'records'
	if (value instanceof YamlDocuments) return 'documents'
	if (value instanceof Date) return 'date'
	if (Array.isArray(value)) return 'array'
	const type = typeof value
	if (type === 'string') return 'string'
	if (type === 'number' || type === 'bigint') return 'number'
	if (type === 'boolean') return 'boolean'
	return 'object'
}
const isContainer = (kind: NodeKind) =>
	kind === 'object' || kind === 'array' || kind === 'records' || kind === 'documents'

/** Children as [pointer token, display key, value]; containers only. */
function childCount(value: unknown, kind: NodeKind): number {
	if (kind === 'array') return (value as unknown[]).length
	if (kind === 'records') return (value as JsonLines).values.length
	if (kind === 'documents') return (value as YamlDocuments).values.length
	if (kind === 'object') return Object.keys(value as object).length
	return 0
}
function* children(value: unknown, kind: NodeKind, limit: number): Generator<[string, string, unknown]> {
	if (kind === 'array') {
		const list = value as unknown[]
		for (let index = 0; index < Math.min(list.length, limit); index++) yield [String(index), String(index), list[index]]
	} else if (kind === 'records') {
		const records = value as JsonLines
		for (let index = 0; index < Math.min(records.values.length, limit); index++)
			yield [String(index), `Line ${records.lines[index]}`, records.values[index]]
	} else if (kind === 'documents') {
		const documents = value as YamlDocuments
		for (let index = 0; index < Math.min(documents.values.length, limit); index++)
			yield [String(index), `Document ${index + 1}`, documents.values[index]]
	} else if (kind === 'object') {
		let index = 0
		for (const key of Object.keys(value as object)) {
			if (index++ >= limit) break
			yield [key, key, (value as Record<string, unknown>)[key]]
		}
	}
}

export const escapePointerToken = (token: string) => token.replace(/~/g, '~0').replace(/\//g, '~1')
export const unescapePointerToken = (token: string) => token.replace(/~1/g, '/').replace(/~0/g, '~')
export const childPointer = (parent: string, token: string) => `${parent}/${escapePointerToken(token)}`

/** The value at a JSON Pointer, or undefined. Own keys only (never the prototype chain). */
export function nodeAt(root: unknown, pointer: string): { value: unknown } | undefined {
	if (pointer === '') return { value: root }
	if (!pointer.startsWith('/')) return undefined
	let value = root
	for (const raw of pointer.slice(1).split('/')) {
		const token = unescapePointerToken(raw)
		const kind = kindOf(value)
		if (kind === 'array' || kind === 'records' || kind === 'documents') {
			if (!/^(0|[1-9]\d*)$/.test(token)) return undefined
			const list =
				kind === 'array'
					? (value as unknown[])
					: kind === 'records'
						? (value as JsonLines).values
						: (value as YamlDocuments).values
			const index = Number(token)
			if (index >= list.length) return undefined
			value = list[index]
		} else if (kind === 'object') {
			if (!Object.hasOwn(value as object, token)) return undefined
			value = (value as Record<string, unknown>)[token]
		} else return undefined
	}
	return { value }
}

/** Every ancestor pointer of a pointer, root first (the pointer itself excluded). */
export function ancestors(pointer: string): string[] {
	const out = ['']
	if (!pointer) return []
	const tokens = pointer.slice(1).split('/')
	let current = ''
	for (const token of tokens.slice(0, -1)) {
		current = `${current}/${token}`
		out.push(current)
	}
	return out
}

const clip = (text: string) => (text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text)
/** One-line text of a leaf: strings quoted, numbers literal, dates ISO. */
export function leafText(value: unknown, kind: NodeKind): string {
	if (kind === 'string') return clip(JSON.stringify(value as string))
	if (kind === 'number') return String(value)
	if (kind === 'boolean') return String(value)
	if (kind === 'null') return 'null'
	if (kind === 'date') {
		const date = value as Date
		return Number.isNaN(date.getTime()) ? 'Invalid date' : date.toISOString()
	}
	if (kind === 'invalid') return clip((value as InvalidLine).source)
	return ''
}
export function containerSummary(kind: NodeKind, count: number): string {
	if (kind === 'object') return count === 1 ? '1 key' : `${count.toLocaleString('en-US')} keys`
	if (kind === 'records') return count === 1 ? '1 record' : `${count.toLocaleString('en-US')} records`
	if (kind === 'documents') return `${count.toLocaleString('en-US')} documents`
	return count === 1 ? '1 item' : `${count.toLocaleString('en-US')} items`
}

export interface DataRow {
	pointer: string
	depth: number
	/** Display key ('' for the root). */
	key: string
	kind: NodeKind | 'more'
	/** Leaf value text, or a container summary. */
	text: string
	expandable: boolean
	expanded: boolean
	/** InvalidLine's parser message. */
	note?: string
	/** For a 'more' row: how many children are not listed. */
	hidden?: number
}

/** The visible rows for an expansion set, depth first, children capped per node and rows capped overall. */
export function flatten(
	root: unknown,
	expanded: ReadonlySet<string>,
	childLimit = CHILD_LIMIT,
	rowLimit = ROW_LIMIT,
): { rows: DataRow[]; truncated: boolean } {
	const rows: DataRow[] = []
	const stack: { pointer: string; depth: number; key: string; value: unknown }[] = [
		{ pointer: '', depth: 0, key: '', value: root },
	]
	while (stack.length) {
		if (rows.length >= rowLimit) return { rows, truncated: true }
		const item = stack.pop() as (typeof stack)[number]
		if (item.key === '\u0000more') {
			rows.push({
				pointer: item.pointer,
				depth: item.depth,
				key: '',
				kind: 'more',
				text: '',
				expandable: false,
				expanded: false,
				hidden: item.value as number,
			})
			continue
		}
		const kind = kindOf(item.value)
		const container = isContainer(kind)
		const count = container ? childCount(item.value, kind) : 0
		const open = container && expanded.has(item.pointer)
		rows.push({
			pointer: item.pointer,
			depth: item.depth,
			key: item.key,
			kind,
			text: container ? containerSummary(kind, count) : leafText(item.value, kind),
			expandable: container && count > 0,
			expanded: open && count > 0,
			...(kind === 'invalid' ? { note: (item.value as InvalidLine).message } : {}),
		})
		if (!open) continue
		const pending: typeof stack = []
		for (const [token, key, value] of children(item.value, kind, childLimit))
			pending.push({ pointer: childPointer(item.pointer, token), depth: item.depth + 1, key, value })
		if (count > childLimit)
			pending.push({
				pointer: `${item.pointer}/\u0000more`,
				depth: item.depth + 1,
				key: '\u0000more',
				value: count - childLimit,
			})
		for (let index = pending.length - 1; index >= 0; index--) stack.push(pending[index] as (typeof stack)[number])
	}
	return { rows, truncated: false }
}

/** Pointers whose key or leaf text contains the query (case-insensitive), in document order. */
export function search(
	root: unknown,
	query: string,
	childLimit = CHILD_LIMIT,
	limit = MATCH_LIMIT,
	visits = SEARCH_VISITS,
): { matches: string[]; truncated: boolean } {
	const needle = query.toLocaleLowerCase()
	const matches: string[] = []
	if (!needle) return { matches, truncated: false }
	const stack: { pointer: string; key: string; value: unknown }[] = [{ pointer: '', key: '', value: root }]
	let seen = 0
	while (stack.length) {
		if (matches.length >= limit || ++seen > visits) return { matches, truncated: true }
		const item = stack.pop() as (typeof stack)[number]
		const kind = kindOf(item.value)
		const text = isContainer(kind) ? '' : kind === 'string' ? (item.value as string) : leafText(item.value, kind)
		if (item.pointer && (item.key.toLocaleLowerCase().includes(needle) || text.toLocaleLowerCase().includes(needle)))
			matches.push(item.pointer)
		if (!isContainer(kind)) continue
		const pending: typeof stack = []
		for (const [token, key, value] of children(item.value, kind, childLimit))
			pending.push({ pointer: childPointer(item.pointer, token), key, value })
		for (let index = pending.length - 1; index >= 0; index--) stack.push(pending[index] as (typeof stack)[number])
	}
	return { matches, truncated: false }
}

/**
 * A node as JSON text (2-space indent): integers beyond 2^53 keep their digits, dates become ISO strings, JSON Lines
 * and YAML documents become arrays, an invalid line its source string. Null when it would exceed `limit`.
 */
export function copyJson(value: unknown, limit = COPY_LIMIT): string | null {
	const parts: string[] = []
	let size = 0
	const push = (text: string) => {
		size += text.length
		parts.push(text)
		return size <= limit
	}
	type Frame = { value: unknown; indent: string; tail: string }
	const stack: Frame[] = [{ value, indent: '', tail: '' }]
	while (stack.length) {
		const frame = stack.pop() as Frame
		if (typeof frame.value === 'string' && frame.indent === '\u0000raw') {
			if (!push(frame.value)) return null
			continue
		}
		const kind = kindOf(frame.value)
		let text: string | null = null
		if (kind === 'string') text = JSON.stringify(frame.value)
		else if (kind === 'number') text = String(frame.value)
		else if (kind === 'boolean') text = String(frame.value)
		else if (kind === 'null') text = 'null'
		else if (kind === 'date') text = JSON.stringify(leafText(frame.value, kind))
		else if (kind === 'invalid') text = JSON.stringify((frame.value as InvalidLine).source)
		if (text !== null) {
			if (!push(text + frame.tail)) return null
			continue
		}
		const list =
			kind === 'array'
				? (frame.value as unknown[]).map((item, index) => [String(index), item] as const)
				: kind === 'records'
					? (frame.value as JsonLines).values.map((item, index) => [String(index), item] as const)
					: kind === 'documents'
						? (frame.value as YamlDocuments).values.map((item, index) => [String(index), item] as const)
						: Object.keys(frame.value as object).map(
								key => [key, (frame.value as Record<string, unknown>)[key]] as const,
							)
		const object = kind === 'object'
		if (!list.length) {
			if (!push((object ? '{}' : '[]') + frame.tail)) return null
			continue
		}
		const inner = `${frame.indent}  `
		if (!push(object ? '{\n' : '[\n')) return null
		const closing = `\n${frame.indent}${object ? '}' : ']'}${frame.tail}`
		const pending: Frame[] = []
		list.forEach(([key, item], index) => {
			pending.push({ value: `${inner}${object ? `${JSON.stringify(key)}: ` : ''}`, indent: '\u0000raw', tail: '' })
			pending.push({ value: item, indent: inner, tail: index < list.length - 1 ? ',\n' : '' })
		})
		pending.push({ value: closing, indent: '\u0000raw', tail: '' })
		for (let index = pending.length - 1; index >= 0; index--) stack.push(pending[index] as Frame)
	}
	return parts.join('')
}

/** Top-level facts for the status: node count is bounded so a huge file never stalls the worker. */
export function topLevel(root: unknown): { kind: NodeKind; count: number } {
	const kind = kindOf(root)
	return { kind, count: isContainer(kind) ? childCount(root, kind) : 0 }
}
