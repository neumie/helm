// Promise wrapper over one CSV worker: one worker per token (a live reload opens a new one), terminated when the grid
// moves on or unmounts. Progress and failure arrive as events; questions about rows and ranges as promises.
import type { ReviewViewerCsv } from '../../document-review/types'
import type { CellRange } from './csv-model'
import type { CsvEvent, CsvRequest, CsvResponse, CsvWorkerMessage } from './csv-protocol'
import { createCsvWorker } from './csv-worker-factory'

type Pending = (response: CsvResponse) => void
type Body<T extends CsvRequest['type']> = Omit<Extract<CsvRequest, { type: T }>, 'id' | 'type'>

export class CsvClient {
	private readonly worker: Worker
	private next = 1
	private readonly pending = new Map<number, Pending>()
	private closed = false
	constructor(
		csv: ReviewViewerCsv,
		private readonly onEvent: (event: CsvEvent) => void,
		worker: Worker = createCsvWorker(),
	) {
		this.worker = worker
		this.worker.onmessage = (message: MessageEvent<CsvWorkerMessage>) => {
			if (this.closed) return
			const data = message.data
			if (data.kind === 'event') {
				this.onEvent(data.event)
				return
			}
			const resolve = this.pending.get(data.response.id)
			this.pending.delete(data.response.id)
			resolve?.(data.response)
		}
		this.worker.onerror = event => {
			event.preventDefault()
			this.fail('The CSV worker stopped.')
			if (!this.closed) this.onEvent({ type: 'failed', error: 'The CSV worker stopped.' })
		}
		// A worker resolves a relative URL against its own script (assets/), not the page: send it absolute.
		const url = typeof document === 'undefined' ? csv.url : new URL(csv.url, document.baseURI).href
		this.worker.postMessage({ id: 0, type: 'open', ...csv, url } satisfies CsvRequest)
	}
	private fail(error: string) {
		for (const [id, resolve] of this.pending) resolve({ id, type: 'failed', error })
		this.pending.clear()
	}
	private ask<T extends CsvRequest['type']>(type: T, body: Body<T>): Promise<CsvResponse> {
		if (this.closed) return Promise.resolve({ id: 0, type: 'failed', error: 'closed' })
		const id = this.next++
		return new Promise(resolve => {
			this.pending.set(id, resolve)
			this.worker.postMessage({ id, type, ...body } as unknown as CsvRequest)
		})
	}
	rows(start: number, count: number) {
		return this.ask('rows', { start, count })
	}
	cell(row: number, column: number) {
		return this.ask('cell', { row, column })
	}
	copy(range: CellRange) {
		return this.ask('copy', range)
	}
	stats(range: CellRange) {
		return this.ask('stats', range)
	}
	search(query: string) {
		return this.ask('search', { query })
	}
	close() {
		if (this.closed) return
		this.closed = true
		this.fail('closed')
		this.worker.terminate()
	}
}
