// The CSV grid's worker (docs/plans/helm-open/spec.md: parsers that touch untrusted bytes run in dedicated workers).
// Loaded from helm-viewer://app/assets/csv-worker.js, so it takes the viewer CSP from its own response. It reads the
// view's token by range, decodes strictly, and keeps the parsed table; the window asks it for rows and ranges.
import { ENCODING_LABEL, decoderLabel } from '../../../../src/document-review/formats'
import type { CsvEvent, CsvRequest, CsvResponse, CsvWorkerMessage } from './csv-protocol'
import { CsvRefusal, CsvTable } from './csv-table'
import { readTokenRange } from './pdf-range'

/** Bytes per range read: 32 reads for the largest file Helm shows. */
export const CSV_READ_BYTES = 4 * 1024 * 1024

const scope = self as unknown as {
	onmessage: ((event: MessageEvent<CsvRequest>) => void) | null
	postMessage(message: CsvWorkerMessage): void
}
const emit = (event: CsvEvent) => scope.postMessage({ kind: 'event', event })
const answer = (response: CsvResponse) => scope.postMessage({ kind: 'response', response })

let table: CsvTable | null = null
let opened = false

function progress(table: CsvTable, bytes: number, size: number, done: boolean) {
	emit({
		type: 'progress',
		rows: table.rows,
		columns: table.columns,
		bytes,
		size,
		delimiter: table.delimiter ?? ',',
		header: table.headerGuess,
		samples: table.samples,
		sepLine: table.sepLine,
		done,
		unclosedQuote: done ? table.unclosedQuote : null,
	})
}

async function open(request: Extract<CsvRequest, { type: 'open' }>) {
	const next = new CsvTable(request.kind === 'tsv' ? '\t' : null)
	const decoder = new TextDecoder(decoderLabel(request.encoding), { fatal: true })
	const signal = new AbortController().signal
	const decode = (bytes?: Uint8Array) => {
		try {
			return bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode()
		} catch {
			throw new CsvRefusal(
				request.encoding.startsWith('utf-8')
					? 'This file is not valid UTF-8 text; Helm shows UTF-8 and UTF-16 (with a byte order mark) text.'
					: `This file is not valid ${ENCODING_LABEL[request.encoding]} text.`,
			)
		}
	}
	for (let offset = 0; offset < request.size; offset += CSV_READ_BYTES) {
		const end = Math.min(request.size, offset + CSV_READ_BYTES)
		const read = await readTokenRange(request.url, request.size, offset, end, signal, 'The file')
		if (read.kind === 'stale') {
			emit({ type: 'stale' })
			return
		}
		next.push(decode(read.bytes))
		// The first rows show as soon as they are parsed; then progress every read.
		if (table !== next && next.rows > 0) table = next
		if (table === next) progress(next, end, request.size, false)
	}
	next.push(decode())
	next.finish()
	table = next
	progress(next, request.size, request.size, true)
}

scope.onmessage = event => {
	const request = event.data
	if (request.type === 'open') {
		if (opened) return
		opened = true
		void open(request).catch(error => {
			const message =
				error instanceof CsvRefusal
					? error.message
					: error instanceof Error
						? (error.message.split('\n')[0] ?? 'The file could not be read.')
						: 'The file could not be read.'
			table = null
			emit({ type: 'failed', error: message })
		})
		return
	}
	try {
		const current = table
		if (!current) {
			answer({ id: request.id, type: 'failed', error: 'not ready' })
			return
		}
		if (request.type === 'rows')
			answer({
				id: request.id,
				type: 'rows',
				start: request.start,
				rows: current.rowsForDisplay(request.start, request.count),
			})
		else if (request.type === 'cell')
			answer({ id: request.id, type: 'cell', ...current.cell(request.row, request.column) })
		else if (request.type === 'copy') answer({ id: request.id, type: 'copy', ...current.copy(request) })
		else if (request.type === 'stats') answer({ id: request.id, type: 'stats', ...current.stats(request) })
		else answer({ id: request.id, type: 'search', ...current.search(request.query) })
	} catch (error) {
		const message = error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : 'failed'
		answer({ id: request.id, type: 'failed', error: message })
	}
}
