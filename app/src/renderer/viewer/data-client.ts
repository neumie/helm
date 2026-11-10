// Promise wrapper over the data worker; one worker per data view, terminated when the view unmounts.
import type { DataLanguage } from '../../../../src/document-review/formats'
import type { DataRequest, DataResponse } from './data-protocol'
import { createDataWorker } from './data-worker-factory'

type Pending = (response: DataResponse) => void
type Body<T extends DataRequest['type']> = Omit<Extract<DataRequest, { type: T }>, 'id' | 'type'>

export class DataClient {
	private readonly worker: Worker
	private next = 1
	private readonly pending = new Map<number, Pending>()
	private closed = false
	constructor(worker: Worker = createDataWorker()) {
		this.worker = worker
		this.worker.onmessage = (event: MessageEvent<DataResponse>) => {
			const resolve = this.pending.get(event.data.id)
			this.pending.delete(event.data.id)
			resolve?.(event.data)
		}
		this.worker.onerror = event => {
			event.preventDefault()
			this.fail('The data worker stopped.')
		}
	}
	private fail(error: string) {
		for (const [id, resolve] of this.pending) resolve({ id, type: 'failed', error })
		this.pending.clear()
	}
	private ask<T extends DataRequest['type']>(type: T, body: Body<T>): Promise<DataResponse> {
		if (this.closed) return Promise.resolve({ id: 0, type: 'failed', error: 'closed' })
		const id = this.next++
		return new Promise(resolve => {
			this.pending.set(id, resolve)
			this.worker.postMessage({ id, type, ...body } as unknown as DataRequest)
		})
	}
	open(text: string, language: DataLanguage) {
		return this.ask('open', { text, language })
	}
	rows(expanded: Iterable<string>) {
		return this.ask('rows', { expanded: [...expanded] })
	}
	search(query: string) {
		return this.ask('search', { query })
	}
	copy(pointer: string) {
		return this.ask('copy', { pointer })
	}
	close() {
		this.closed = true
		this.fail('closed')
		this.worker.terminate()
	}
}
