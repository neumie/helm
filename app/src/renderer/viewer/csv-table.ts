// The parsed CSV a grid's worker holds (docs/plans/helm-open/spec.md, S5): decoded text in segments and, per record,
// its segment and offsets. Pure (no fetch, no DOM) so the tests drive it with any split of the input.
import { VIEWER_CSV_COLUMNS, VIEWER_CSV_ROWS, countText } from '../../../../src/document-review/formats'
import {
	COPY_CELL_LIMIT,
	type CellRange,
	CsvScanner,
	type Delimiter,
	MATCH_LIMIT,
	RECORD_MAX_CHARS,
	STATS_CELL_LIMIT,
	detectDelimiter,
	detectHeader,
	displayValue,
	isSepLine,
	numericValue,
	parseRecord,
	tsvValue,
} from './csv-model'

/** Records whose values feed column widths and header detection. */
export const SAMPLE_RECORDS = 1000
const HEADER_SAMPLE = 101
const SAMPLE_CHARS = 80
/** Characters of a `.csv` that decide its delimiter. */
const DETECT_CHARS = 64 * 1024
/** Characters of one value the value bar receives. */
export const CELL_VALUE_CHARS = 100_000

/**
 * About how wide a value renders, in digit widths, so a column keeps its widest value rather than its longest:
 * `Číslo faktury` has more characters than `FV-2026-0001` but is narrower. Only picks the sample; the grid
 * measures that sample with the real font.
 */
export function textWeight(text: string): number {
	let weight = 0
	for (const char of text) {
		if (/[\p{Cf}\p{M}]/u.test(char)) continue
		if (/[ .,:;'!|()[\]{}iIjlft\-]/.test(char)) weight += 0.45
		else if (/\p{Ll}/u.test(char)) weight += 0.85
		else if (/[MWmw@%]/.test(char)) weight += 1.35
		else weight += (char.codePointAt(0) ?? 0) > 0x2e80 ? 1.8 : 1
	}
	return weight
}

/** A refusal the window shows as it is (after the file name). */
export class CsvRefusal extends Error {}

export class CsvTable {
	delimiter: Delimiter | null
	rows = 0
	columns = 0
	header = false
	sepLine = false
	samples: string[] = []
	private sampleWeights: number[] = []
	unclosedQuote: number | null = null
	private scanner: CsvScanner | null = null
	private segments: string[] = []
	private segmentOf = new Uint32Array(1024)
	private startOf = new Uint32Array(1024)
	private endOf = new Uint32Array(1024)
	private carry = ''
	private first = true
	private headerSample: string[][] = []
	private headerDecided = false
	private finished = false

	/** `delimiter` for a `.tsv`; null for a `.csv`, which detects its own from the first characters. */
	constructor(delimiter: Delimiter | null) {
		this.delimiter = delimiter
	}

	/** The next decoded piece of the file. */
	push(piece: string) {
		if (this.finished) throw new Error('The table is finished.')
		if (piece.includes('\u0000')) throw new CsvRefusal('This file contains NUL bytes, so it is not a text file.')
		const text = this.carry + piece
		if (!this.scanner) {
			// The delimiter needs a sample: wait for enough characters (or the end). Nothing is scanned yet.
			if (text.length < DETECT_CHARS) {
				this.carry = text
				return
			}
			this.start(text)
			this.scan(text, 0)
		} else this.scan(text, this.carry.length)
		this.decideHeader()
	}

	/** The end of the file. */
	finish() {
		if (this.finished) return
		if (!this.scanner) {
			// A file shorter than the detection sample: everything is still unscanned.
			this.start(this.carry)
			this.scan(this.carry, 0)
		}
		const scanner = this.scanner as CsvScanner
		const rest = this.carry
		const index = this.segments.length
		let added = false
		scanner.finish(rest, (start, end, fields) => {
			added = this.add(index, rest, start, end, fields) || added
		})
		if (added) this.segments.push(rest)
		this.carry = ''
		if (scanner.unclosedQuote && this.rows > 0) this.unclosedQuote = this.rows - 1
		this.finished = true
		this.decideHeader(true)
	}

	private start(sample: string) {
		this.delimiter ??= detectDelimiter(sample.slice(0, DETECT_CHARS))
		this.scanner = new CsvScanner(this.delimiter)
	}

	private scan(text: string, from: number) {
		const scanner = this.scanner as CsvScanner
		const index = this.segments.length
		let added = false
		const rest = scanner.scan(text, from, (start, end, fields) => {
			added = this.add(index, text, start, end, fields) || added
		})
		if (added) this.segments.push(rest === text.length ? text : text.slice(0, rest))
		this.carry = rest === 0 ? text : text.slice(rest)
		// An unfinished record fails early; a finished one is measured in `add`, so every split refuses alike.
		if (this.carry.length > RECORD_MAX_CHARS) throw this.tooLong(scanner.quoted)
	}

	private tooLong(quoted: boolean): CsvRefusal {
		return new CsvRefusal(
			`Row ${countText(this.rows + 1)} runs past ${countText(RECORD_MAX_CHARS)} characters${quoted ? ': a quoted value is probably missing its closing quote' : ''}.`,
		)
	}

	/** Stores one record; false when it was Excel's hidden `sep=` line. */
	private add(segment: number, text: string, start: number, end: number, fields: number): boolean {
		if (end - start > RECORD_MAX_CHARS) throw this.tooLong(false)
		if (this.first) {
			this.first = false
			// `sep=;` splits into `sep=` and an empty value on its own delimiter: compare the raw line.
			if (fields <= 2 && isSepLine(text.slice(start, end), this.delimiter as Delimiter)) {
				this.sepLine = true
				return false
			}
		}
		if (this.rows >= VIEWER_CSV_ROWS)
			throw new CsvRefusal(
				`This file has more than ${countText(VIEWER_CSV_ROWS)} rows; Helm shows CSV files up to ${countText(VIEWER_CSV_ROWS)} rows.`,
			)
		if (fields > VIEWER_CSV_COLUMNS)
			throw new CsvRefusal(
				`Row ${countText(this.rows + 1)} has ${countText(fields)} columns; Helm shows CSV files up to ${countText(VIEWER_CSV_COLUMNS)} columns.`,
			)
		if (this.rows === this.startOf.length) this.grow()
		this.segmentOf[this.rows] = segment
		this.startOf[this.rows] = start
		this.endOf[this.rows] = end
		this.rows++
		if (fields > this.columns) this.columns = fields
		if (this.rows <= SAMPLE_RECORDS) {
			const values = parseRecord(text, start, end, this.delimiter as Delimiter)
			if (this.headerSample.length < HEADER_SAMPLE) this.headerSample.push(values)
			values.forEach((value, column) => {
				const shown = displayValue(value).slice(0, SAMPLE_CHARS)
				const weight = textWeight(shown)
				if (weight > (this.sampleWeights[column] ?? -1)) {
					this.samples[column] = shown
					this.sampleWeights[column] = weight
				}
			})
		}
		return true
	}

	private grow() {
		const size = this.startOf.length * 2
		const widen = (from: Uint32Array) => {
			const to = new Uint32Array(size)
			to.set(from)
			return to
		}
		this.segmentOf = widen(this.segmentOf)
		this.startOf = widen(this.startOf)
		this.endOf = widen(this.endOf)
	}

	/** The header answer to show now: final once decided, else what the records read so far say. */
	get headerGuess(): boolean {
		return this.headerDecided || this.headerSample.length === 0 ? this.header : detectHeader(this.headerSample)
	}

	private decideHeader(force = false) {
		if (this.headerDecided || !(force || this.headerSample.length >= HEADER_SAMPLE)) return
		this.headerDecided = true
		this.header = detectHeader(this.headerSample)
		this.headerSample = []
	}

	/** The values of a row (as many as it has; fewer than `columns` is normal). */
	row(index: number): string[] {
		if (!(index >= 0 && index < this.rows)) return []
		const segment = this.segments[this.segmentOf[index] as number] ?? ''
		return parseRecord(segment, this.startOf[index] as number, this.endOf[index] as number, this.delimiter as Delimiter)
	}

	/** Rows `[start, start + count)` as the grid draws them. */
	rowsForDisplay(start: number, count: number): string[][] {
		const rows: string[][] = []
		const end = Math.min(this.rows, start + count)
		for (let index = Math.max(0, start); index < end; index++) rows.push(this.row(index).map(displayValue))
		return rows
	}

	/** One value for the value bar, cut at CELL_VALUE_CHARS. */
	cell(row: number, column: number): { value: string | null; truncated: boolean } {
		if (!(row >= 0 && row < this.rows)) return { value: null, truncated: false }
		const value = this.row(row)[column]
		if (value === undefined) return { value: '', truncated: false }
		return value.length > CELL_VALUE_CHARS
			? { value: value.slice(0, CELL_VALUE_CHARS), truncated: true }
			: { value, truncated: false }
	}

	private clamp(range: CellRange): CellRange | null {
		const r0 = Math.max(0, Math.min(range.r0, range.r1))
		const r1 = Math.min(this.rows - 1, Math.max(range.r0, range.r1))
		const c0 = Math.max(0, Math.min(range.c0, range.c1))
		const c1 = Math.min(Math.max(0, this.columns - 1), Math.max(range.c0, range.c1))
		return r1 < r0 || c1 < c0 ? null : { r0, r1, c0, c1 }
	}

	/** The range as TSV (values quoted when they hold tabs, line breaks or quotes), or null past COPY_CELL_LIMIT. */
	copy(range: CellRange): { text: string | null; cells: number } {
		const clamped = this.clamp(range)
		if (!clamped) return { text: '', cells: 0 }
		const cells = (clamped.r1 - clamped.r0 + 1) * (clamped.c1 - clamped.c0 + 1)
		if (cells > COPY_CELL_LIMIT) return { text: null, cells }
		const lines: string[] = []
		for (let index = clamped.r0; index <= clamped.r1; index++) {
			const values = this.row(index)
			const line: string[] = []
			for (let column = clamped.c0; column <= clamped.c1; column++) line.push(tsvValue(values[column] ?? ''))
			lines.push(line.join('\t'))
		}
		return { text: lines.join('\n'), cells }
	}

	/** Count of values and the Sum of unambiguous numbers in a range; count null past STATS_CELL_LIMIT. */
	stats(range: CellRange): { count: number | null; numbers: number; sum: number } {
		const clamped = this.clamp(range)
		if (!clamped) return { count: 0, numbers: 0, sum: 0 }
		if ((clamped.r1 - clamped.r0 + 1) * (clamped.c1 - clamped.c0 + 1) > STATS_CELL_LIMIT)
			return { count: null, numbers: 0, sum: 0 }
		let count = 0
		let numbers = 0
		let sum = 0
		for (let index = clamped.r0; index <= clamped.r1; index++) {
			const values = this.row(index)
			const last = Math.min(clamped.c1, values.length - 1)
			for (let column = clamped.c0; column <= last; column++) {
				const value = values[column] ?? ''
				if (value.trim() === '') continue
				count++
				const number = numericValue(value, this.delimiter as Delimiter)
				if (number !== null && Number.isFinite(number)) {
					numbers++
					sum += number
				}
			}
		}
		return { count, numbers, sum }
	}

	/**
	 * Cells whose value contains `query` (case-insensitive), in reading order, at most MATCH_LIMIT. A row's raw text
	 * without its quote characters is checked first: a value is its field's raw characters minus quotes (`"Praha" 4`
	 * is `Praha 4`), plus the quote a `""` stands for, which a needle without quotes cannot need.
	 */
	search(query: string): { matches: [number, number][]; truncated: boolean } {
		const needle = query.toLowerCase()
		const matches: [number, number][] = []
		if (!needle) return { matches, truncated: false }
		const prefilter = !needle.includes('"')
		for (let index = 0; index < this.rows; index++) {
			if (prefilter) {
				const segment = this.segments[this.segmentOf[index] as number] ?? ''
				const raw = segment.slice(this.startOf[index], this.endOf[index])
				const plain = raw.includes('"') ? raw.replaceAll('"', '') : raw
				if (!plain.toLowerCase().includes(needle)) continue
			}
			const values = this.row(index)
			for (let column = 0; column < values.length; column++)
				if ((values[column] ?? '').toLowerCase().includes(needle)) {
					if (matches.length === MATCH_LIMIT) return { matches, truncated: true }
					matches.push([index, column])
				}
		}
		return { matches, truncated: false }
	}
}
