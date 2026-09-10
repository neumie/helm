import {
	type RemoteAccessDocument,
	type RemoteCatalogPage,
	type RemoteCommand,
	type RemoteDetail,
	type RemoteDirectory,
	type RemoteReceipt,
	remoteAccessSchema,
	remoteCatalogPageSchema,
	remoteDetailSchema,
	remoteDirectorySchema,
	remoteReceiptSchema,
} from '../../../../src/remote/protocol.js'

export interface RemoteTransport {
	access(signal: AbortSignal): Promise<RemoteAccessDocument>
	directory(signal: AbortSignal): Promise<RemoteDirectory>
	catalog(cursor: string | null, query: string, signal: AbortSignal): Promise<RemoteCatalogPage>
	detail(sessionId: string, signal: AbortSignal): Promise<RemoteDetail>
	send(command: RemoteCommand, signal: AbortSignal): Promise<RemoteReceipt>
	receipt(command: RemoteCommand, signal: AbortSignal): Promise<RemoteReceipt>
}
export class RemoteAccessError extends Error {
	constructor(readonly status: number) {
		super(`Remote request failed (${status})`)
	}
}

/**
 * HTTPS runtime uses its HttpOnly same-origin cookie. Passing a token is supported
 * only by the explicit loopback development fixture; no persistent HTTP fallback.
 */
export function createRemoteTransport(developmentToken?: string): RemoteTransport {
	if (developmentToken !== undefined && !/^[\w-]{43}$/.test(developmentToken)) throw new Error('Invalid access token')
	const catalogView = crypto.randomUUID()
	let catalogSequence = 0
	async function request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
		const response = await fetch(path, {
			method: body ? 'POST' : 'GET',
			signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
			credentials: developmentToken ? 'omit' : 'same-origin',
			cache: 'no-store',
			redirect: 'error',
			headers: {
				...(developmentToken ? { Authorization: `Bearer ${developmentToken}` } : {}),
				...(body ? { 'Content-Type': 'application/json', 'X-Helm-Remote': '1' } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		})
		if (!response.ok) throw new RemoteAccessError(response.status)
		return readJson(response)
	}
	return {
		access: async signal => remoteAccessSchema.parse(await request('/v1/access', signal)),
		directory: async signal => remoteDirectorySchema.parse(await request('/v1/sessions', signal)),
		catalog: async (cursor, query, signal) => {
			const params = new URLSearchParams({ view: catalogView, sequence: String(++catalogSequence) })
			if (cursor) params.set('cursor', cursor)
			if (query.trim()) params.set('q', query.trim())
			return remoteCatalogPageSchema.parse(await request(`/v1/catalog?${params}`, signal))
		},
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

/** Redeems a one-time QR fragment or manual code and leaves only the HttpOnly cookie. */
export async function pairRemote(value: { code?: string; qrCapability?: string }, signal: AbortSignal): Promise<void> {
	const response = await fetch('/v1/pair', {
		method: 'POST',
		signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
		credentials: 'same-origin',
		cache: 'no-store',
		redirect: 'error',
		headers: { 'Content-Type': 'application/json', 'X-Helm-Remote': '1' },
		body: JSON.stringify(value),
	})
	if (!response.ok) throw new RemoteAccessError(response.status)
	await readJson(response)
}

async function readJson(response: Response): Promise<unknown> {
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
