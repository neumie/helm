// The CSV/TSV model of a plain `helm open` window (docs/plans/helm-open/spec.md, S5): pure functions shared by the
// grid's worker and its tests. No DOM. The worker keeps the decoded text and, per record, only where it starts and
// ends; cells are parsed again when the window asks for rows, so a million-row file is offsets, not strings.
//
// Parsing follows RFC 4180 and stays as lenient as the spreadsheets people export from: a quote opens a quoted
// value only at the start of a value, `""` inside one is a quote, line breaks inside one belong to the value, text
// after a closing quote is kept, a stray quote in an unquoted value is literal, and LF, CRLF and CR all end a row.

export type Delimiter = ',' | ';' | '\t' | '|'
export const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|']
export const DELIMITER_WORDS: Readonly<Record<Delimiter, string>> = {
	',': 'Comma-separated',
	';': 'Semicolon-separated',
	'\t': 'Tab-separated',
	'|': 'Pipe-separated',
}

/** Characters of a cell the grid draws; the value bar, search and copy use the whole value. */
export const CELL_DISPLAY_CHARS = 1000
/** A record longer than this has (almost certainly) lost a closing quote; the file is refused rather than held. */
export const RECORD_MAX_CHARS = 16 * 1024 * 1024
/** Cells a copy may hold: a whole million-row sheet is not a clipboard. */
export const COPY_CELL_LIMIT = 200_000
/** Cells a range's Count/Sum looks at; past this the status line shows neither. */
export const STATS_CELL_LIMIT = 5_000_000
/** Matches a search reports before it stops counting. */
export const MATCH_LIMIT = 10_000

const QUOTE = 34
const LF = 10
const CR = 13

/** Scanner states, carried across segments. */
const START = 0 // at the start of a value
const PLAIN = 1 // inside an unquoted value (or after a quoted value's closing quote)
const QUOTED = 2 // inside a quoted value
const QUOTE_SEEN = 3 // a quote inside a quoted value: `""` (escaped) or the closing quote

export interface ScannedRecord {
	/** Offset of the record's first character in its segment. */
	start: number
	/** Offset just past its last character (its line break is not part of it). */
	end: number
	/** Values in the record (delimiters outside quotes + 1). */
	fields: number
}

/**
 * Finds record boundaries in text that arrives in pieces. `scan(text, from)` reads `text` from `from`, calls
 * `record` for every record that ends in it and returns the offset where the unfinished record starts; the caller
 * carries `text.slice(that)` in front of the next piece and calls `scan` again with `from` = the carried length.
 * `finish(text)` ends the input: an unfinished record (no final line break) is a record too.
 */
export class CsvScanner {
	private state = START
	private fields = 1
	/** A CR ended the last record; an LF right after it belongs to the same line break. */
	private skipLf = false
	/** The record being scanned is inside a quoted value at the end of the input. */
	unclosedQuote = false
	constructor(private readonly delimiter: Delimiter) {}

	/** The input so far ends inside a quoted value. */
	get quoted(): boolean {
		return this.state === QUOTED
	}

	scan(text: string, from: number, record: (start: number, end: number, fields: number) => void): number {
		const delimiter = this.delimiter.charCodeAt(0)
		let start = 0
		let index = from
		if (this.skipLf && index < text.length) {
			this.skipLf = false
			if (text.charCodeAt(index) === LF) {
				index++
				start = index
			}
		}
		let state = this.state
		let fields = this.fields
		const length = text.length
		while (index < length) {
			const code = text.charCodeAt(index)
			if (state === QUOTED) {
				// The common case inside quotes: jump to the next quote.
				const next = text.indexOf('"', index)
				if (next < 0) {
					index = length
					break
				}
				index = next + 1
				state = QUOTE_SEEN
				continue
			}
			if (state === QUOTE_SEEN) {
				if (code === QUOTE) {
					state = QUOTED
					index++
					continue
				}
				state = PLAIN
			}
			if (code === delimiter) {
				fields++
				state = START
			} else if (code === LF || code === CR) {
				record(start, index, fields)
				fields = 1
				state = START
				index++
				if (code === CR) {
					if (index >= length) {
						this.skipLf = true
						start = index
						break
					}
					if (text.charCodeAt(index) === LF) index++
				}
				start = index
				continue
			} else if (state === START) state = code === QUOTE ? QUOTED : PLAIN
			index++
		}
		this.state = state
		this.fields = fields
		return start
	}

	/** The end of the input: `text` is the carried, unfinished record (possibly empty). */
	finish(text: string, record: (start: number, end: number, fields: number) => void) {
		this.unclosedQuote = this.state === QUOTED
		if (text.length > 0) record(0, text.length, this.fields)
		this.state = START
		this.fields = 1
		this.skipLf = false
	}
}

/** The values of one record (`text.slice(start, end)`), unquoted. */
export function parseRecord(text: string, start: number, end: number, delimiter: Delimiter): string[] {
	const values: string[] = []
	const separator = delimiter.charCodeAt(0)
	let index = start
	for (;;) {
		if (index < end && text.charCodeAt(index) === QUOTE) {
			// Quoted: up to the closing quote, `""` is a quote; anything after it up to the delimiter is kept.
			let value = ''
			index++
			for (;;) {
				const next = text.indexOf('"', index)
				if (next < 0 || next >= end) {
					value += text.slice(index, end)
					index = end
					break
				}
				value += text.slice(index, next)
				if (next + 1 < end && text.charCodeAt(next + 1) === QUOTE) {
					value += '"'
					index = next + 2
					continue
				}
				index = next + 1
				break
			}
			let stop = index
			while (stop < end && text.charCodeAt(stop) !== separator) stop++
			values.push(stop > index ? value + text.slice(index, stop) : value)
			index = stop
		} else {
			let stop = index
			while (stop < end && text.charCodeAt(stop) !== separator) stop++
			values.push(text.slice(index, stop))
			index = stop
		}
		if (index >= end) break
		index++ // the delimiter
		if (index === end) {
			values.push('')
			break
		}
	}
	return values
}

/** Whether a record's quotes are not RFC 4180 with this delimiter. */
function awkwardQuotes(text: string, start: number, end: number, delimiter: Delimiter): boolean {
	const separator = delimiter.charCodeAt(0)
	let index = start
	while (index <= end) {
		if (index < end && text.charCodeAt(index) === QUOTE) {
			index++
			for (;;) {
				const next = text.indexOf('"', index)
				if (next < 0 || next >= end) return false // unclosed: the record ends inside it
				if (text.charCodeAt(next + 1) === QUOTE && next + 1 < end) {
					index = next + 2
					continue
				}
				index = next + 1
				break
			}
			if (index < end && text.charCodeAt(index) !== separator) return true
		} else {
			while (index < end && text.charCodeAt(index) !== separator) {
				if (text.charCodeAt(index) === QUOTE) return true
				index++
			}
		}
		index++
	}
	return false
}

/** Records of a sample, for detection: `{ start, end, fields }` with a given delimiter. */
function sampleRecords(sample: string, delimiter: Delimiter, limit: number): ScannedRecord[] {
	const records: ScannedRecord[] = []
	const scanner = new CsvScanner(delimiter)
	const add = (start: number, end: number, fields: number) => {
		if (records.length < limit) records.push({ start, end, fields })
	}
	const rest = scanner.scan(sample, 0, add)
	// The sample's last record may be cut off; count it only when it is the whole input.
	if (rest === 0 && records.length === 0) scanner.finish(sample, add)
	return records
}

/**
 * The delimiter of a `.csv` sample: the candidate (comma, semicolon, tab, pipe) that splits the most records into
 * the same number of values, more than one. Comma when nothing splits (a one-column file). A first line `sep=;`
 * (Excel writes it) names the delimiter outright.
 */
export function detectDelimiter(sample: string): Delimiter {
	const declared = /^sep=(.)(?:\r\n|\n|\r|$)/.exec(sample)?.[1]
	if (declared && (DELIMITERS as readonly string[]).includes(declared)) return declared as Delimiter
	let best: { delimiter: Delimiter; score: number; fields: number } = { delimiter: ',', score: 0, fields: 1 }
	for (const delimiter of DELIMITERS) {
		const records = sampleRecords(sample, delimiter, 100).filter(record => record.end > record.start)
		if (!records.length) continue
		// A record whose quotes do not line up with this delimiter (text after a closing quote, a quote inside an
		// unquoted value) does not vote for it: `"Novák, Jan";1,5` splits into two values on commas too.
		const counts = new Map<number, number>()
		for (const record of records)
			if (!awkwardQuotes(sample, record.start, record.end, delimiter))
				counts.set(record.fields, (counts.get(record.fields) ?? 0) + 1)
		let modal = 1
		let modalCount = 0
		for (const [fields, count] of counts)
			if (count > modalCount || (count === modalCount && fields > modal)) {
				modal = fields
				modalCount = count
			}
		if (modal < 2) continue
		const score = modalCount / records.length
		if (score > best.score || (score === best.score && modal > best.fields)) best = { delimiter, score, fields: modal }
	}
	return best.delimiter
}

/** Whether a first line is Excel's `sep=X` hint (hidden like Excel hides it). */
export const isSepLine = (record: string, delimiter: Delimiter) => record === `sep=${delimiter}`

const NUMBER_LIKE =
	/^[-+−]?(?:[$€£¥]\s?)?(?:\d{1,3}(?:[ ,.  ']\d{3})+|\d+)(?:[.,]\d+)?(?:[eE][-+]?\d+)?\s?(?:%|[$€£¥]|Kč|CZK|EUR|USD)?$/
const DATE_LIKE =
	/^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}[./]\s?\d{1,2}[./]\s?\d{2,4})$/

/** Numbers, amounts and dates sit right, as in every spreadsheet. */
export function alignRight(value: string): boolean {
	const trimmed = value.trim()
	return trimmed !== '' && trimmed.length < 40 && (NUMBER_LIKE.test(trimmed) || DATE_LIKE.test(trimmed))
}

/**
 * The value of a cell for Sum, or null. Only unambiguous numbers: `1234.5`, `-3`, `1e3`, and in a semicolon file
 * (where the decimal mark is a comma) `1234,5`. Grouped thousands are not summed: they read both ways (`1,234`,
 * and `1.500` in a semicolon file, where Czech and German Excel group thousands with a dot).
 */
export function numericValue(value: string, delimiter: Delimiter): number | null {
	const trimmed = value.trim()
	if (delimiter === ';' && /^[-+]?\d{1,3}\.\d{3}$/.test(trimmed)) return null
	if (/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) return Number(trimmed)
	if (delimiter === ';' && /^[-+]?\d+,\d+$/.test(trimmed)) return Number(trimmed.replace(',', '.'))
	return null
}

/**
 * Whether the first record is a header row, from a sample of records (the first included). A header names its
 * columns: its values are text, mostly present and distinct; and the columns below it look different from it
 * (numbers or dates under a name, values of one length under a name of another, never the name itself).
 */
export function detectHeader(records: readonly (readonly string[])[]): boolean {
	const [first, ...rest] = records
	if (!first || rest.length === 0) return false
	const named = first.filter(value => value.trim() !== '')
	if (named.length === 0 || named.length * 2 < first.length) return false
	if (named.some(value => alignRight(value) || value.length > 120)) return false
	if (new Set(named.map(value => value.trim().toLowerCase())).size !== named.length) return false
	let votes = 0
	for (let column = 0; column < first.length; column++) {
		const name = first[column]?.trim() ?? ''
		if (!name) continue
		const values = rest.map(record => record[column]?.trim() ?? '').filter(Boolean)
		if (values.length === 0) continue
		if (values.some(value => value.toLowerCase() === name.toLowerCase())) {
			votes--
			continue
		}
		const right = values.filter(alignRight).length
		if (right * 10 >= values.length * 7) {
			votes++
			continue
		}
		const length = values[0]?.length ?? 0
		if (values.length >= 2 && values.every(value => value.length === length) && name.length !== length) votes++
	}
	return votes > 0
}

/** `A`, `Z`, `AA`, `XFD`: a column's letters. */
export function columnName(index: number): string {
	let name = ''
	for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
		name = String.fromCharCode(65 + ((value - 1) % 26)) + name
	return name
}

export interface CellRange {
	r0: number
	c0: number
	r1: number
	c1: number
}

/** `B12` or `A2:D9`, rows and columns from 1 as the file numbers them. */
export function rangeRef(range: CellRange): string {
	const start = `${columnName(range.c0)}${range.r0 + 1}`
	if (range.r0 === range.r1 && range.c0 === range.c1) return start
	return `${start}:${columnName(range.c1)}${range.r1 + 1}`
}

/** One value for TSV: quoted (with `""`) when it holds a tab, a line break or a quote, as spreadsheets paste it. */
export function tsvValue(value: string): string {
	return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** A cell drawn in the grid: line breaks shown as ↵ and long values cut. */
export function displayValue(value: string): string {
	const cut = value.length > CELL_DISPLAY_CHARS ? `${value.slice(0, CELL_DISPLAY_CHARS)}…` : value
	return cut.replace(/\r\n|\r|\n/g, ' ↵ ')
}
