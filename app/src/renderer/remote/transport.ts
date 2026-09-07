import {
	type RemoteCommand,
	type RemoteDetail,
	type RemoteDirectory,
	type RemoteReceipt,
	remoteDetailSchema,
	remoteDirectorySchema,
	remoteReceiptSchema,
} from '../../../../src/remote/protocol.js'

export interface RemoteTransport {
	directory(signal: AbortSignal): Promise<RemoteDirectory>
	detail(sessionId: string, signal: AbortSignal): Promise<RemoteDetail>
	send(command: RemoteCommand, signal: AbortSignal): Promise<RemoteReceipt>
	receipt(command: RemoteCommand, signal: AbortSignal): Promise<RemoteReceipt>
}
export class RemoteAccessError extends Error {
	constructor(readonly status: number) {
		super(`Remote request failed (${status})`)
	}
}

/** Same-origin, bearer-only client. No cookies, localStorage credentials or automatic command retry. */
export function createRemoteTransport(token: string): RemoteTransport {
	if (!/^[\w-]{43}$/.test(token)) throw new Error('Invalid access token')
	async function request(path: string, signal: AbortSignal, body?: RemoteCommand): Promise<unknown> {
		const response = await fetch(path, {
			method: body ? 'POST' : 'GET',
			signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
			credentials: 'omit',
			cache: 'no-store',
			redirect: 'error',
			headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
		})
		if (!response.ok) throw new RemoteAccessError(response.status)
		// Bound the response before JSON parsing; no arbitrary transcript arrays.
		const reader = response.body?.getReader()
		if (!reader) throw new Error('Missing response')
		const decoder = new TextDecoder()
		let text = ''
		let size = 0
		try {
			while (true) {
				const chunk = await reader.read()
				if (chunk.done) break
				size += chunk.value.byteLength
				if (size > 256 * 1024) {
					await reader.cancel()
					throw new Error('Response too large')
				}
				text += decoder.decode(chunk.value, { stream: true })
			}
			return JSON.parse(text + decoder.decode())
		} finally {
			reader.releaseLock()
		}
	}
	return {
		directory: async signal => remoteDirectorySchema.parse(await request('/v1/sessions', signal)),
		detail: async (sessionId, signal) =>
			remoteDetailSchema.parse(await request(`/v1/sessions/${encodeURIComponent(sessionId)}`, signal)),
		send: async (command, signal) => remoteReceiptSchema.parse(await request('/v1/commands', signal, command)),
		receipt: async (command, signal) => {
			const query = new URLSearchParams({
				sessionId: command.target.sessionId,
				incarnation: command.target.incarnation,
				hostEpoch: command.hostEpoch,
			})
			return remoteReceiptSchema.parse(await request(`/v1/commands/${command.commandId}?${query}`, signal))
		},
	}
}
