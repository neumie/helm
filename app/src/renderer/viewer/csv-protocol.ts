// Messages between a CSV grid and its worker. The worker reads the view's token by range, decodes it strictly,
// keeps the text and where each record starts and ends, and answers the window's questions about rows and ranges.
import type { ReviewViewerCsv } from '../../document-review/types'
import type { CellRange, Delimiter } from './csv-model'

export type CsvRequest =
	| ({ id: number; type: 'open' } & ReviewViewerCsv)
	| { id: number; type: 'rows'; start: number; count: number }
	| { id: number; type: 'cell'; row: number; column: number }
	| ({ id: number; type: 'copy' } & CellRange)
	| ({ id: number; type: 'stats' } & CellRange)
	| { id: number; type: 'search'; query: string }

/** What the worker has read so far; every one also says how the file is laid out. */
export interface CsvProgress {
	type: 'progress'
	/** Records parsed so far (rows of the grid). */
	rows: number
	/** Values in the widest record so far. */
	columns: number
	/** Bytes read of `size`. */
	bytes: number
	size: number
	delimiter: Delimiter
	/** Whether the first record looks like a header row (from the first records). */
	header: boolean
	/** Per column, the widest value of the first records (cut), for column widths. */
	samples: string[]
	/** Excel's `sep=;` first line was hidden. */
	sepLine: boolean
	done: boolean
	/** Set when done and the last record is inside a quoted value that never closes (shown as it is): its row. */
	unclosedQuote: number | null
}

export type CsvEvent =
	| CsvProgress
	| { type: 'failed'; error: string }
	/** The token answered 409/404: the file changed and main is reading the new version. */
	| { type: 'stale' }

export type CsvResponse =
	| { id: number; type: 'rows'; start: number; rows: string[][] }
	| { id: number; type: 'cell'; value: string | null; truncated: boolean }
	/** `text` null: more than COPY_CELL_LIMIT cells. */
	| { id: number; type: 'copy'; text: string | null; cells: number }
	/** `count` null: more than STATS_CELL_LIMIT cells, not counted. */
	| { id: number; type: 'stats'; count: number | null; numbers: number; sum: number }
	| { id: number; type: 'search'; matches: [number, number][]; truncated: boolean }
	| { id: number; type: 'failed'; error: string }

export type CsvWorkerMessage = { kind: 'event'; event: CsvEvent } | { kind: 'response'; response: CsvResponse }
