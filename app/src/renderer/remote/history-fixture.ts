import type { HistoryPage, HistoryRequest, HistoryResult } from '../../../../src/remote/history-protocol.js'

import { RemoteHistoryError } from './transport.js'

export type HistoryFixtureState = 'progress' | 'expired' | 'unsupported' | 'gap'

/** Display-only workbench service. Browser acceptance replaces this with the real reader through intercepted HTTP. */
export function createHistoryFixture(count: number, state?: HistoryFixtureState) {
	let closed = false
	return async (request: HistoryRequest): Promise<HistoryResult> => {
		const result: HistoryResult = {
			version: 1,
			requestId: crypto.randomUUID(),
			hostEpoch: request.hostEpoch,
			target: request.target,
			viewId: request.viewId,
			sequence: request.sequence,
			input: request.action,
			state: 'page',
			page: null,
			continuation: null,
			attempts: 40,
			examined: 40,
		}
		if (request.action.kind === 'close') {
			closed = true
			return { ...result, state: 'closed' }
		}
		if (request.action.kind === 'open') closed = false
		if (closed) return { ...result, state: 'expired' }
		if (state === 'unsupported') throw new RemoteHistoryError(404, 'unsupported')
		if (state === 'expired' || state === 'gap') return { ...result, state }
		if (state === 'progress') return { ...result, state, continuation: 'fixture-continuation', examined: 128 }
		const end =
			request.action.kind === 'open'
				? request.action.anchor
					? Number.parseInt(request.action.anchor, 16) - 1
					: count
				: Number(request.action.cursor)
		const start = Math.max(1, end - 39)
		const page: HistoryPage = {
			newest: end ? end.toString(16).padStart(8, '0') : null,
			oldest: end ? start.toString(16).padStart(8, '0') : null,
			records: Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => ({
				kind: 'message',
				message: {
					id: (start + index).toString(16).padStart(8, '0'),
					role: 'user',
					text: `Earlier message ${start + index}\nA bounded range from this conversation.`,
					thinking: '',
					truncated: false,
				},
			})),
			omissions: { clipped: 0, images: 0, unsupported: 0 },
			reread: String(end),
			older: start > 1 ? String(start - 1) : null,
			newer: end < count ? String(Math.min(count, end + 40)) : null,
			stopped: start === 1 ? 'root' : 'records',
		}
		return { ...result, page }
	}
}
