import {
	FAVORITES_HEADER,
	FAVORITES_REQUEST_BYTES,
	FAVORITES_RESPONSE_BYTES,
	type FavoriteRequest,
	type FavoritesResponse,
	favoriteRequestSchema,
	favoriteResultSchema,
	favoritesResponseSchema,
} from '../../../../src/remote/favorites-protocol.js'
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

import {
	HISTORY_RESULT_BYTES,
	type HistoryRequest,
	type HistoryResult,
	historyRequestSchema,
	historyResultSchema,
} from '../../../../src/remote/history-protocol.js'

import {
	IMAGE_INPUT_HEADER,
	IMAGE_PROCESSED_MAX_BYTES,
	IMAGE_UPLOAD_TIMEOUT_MS,
	type ImageUploadEnvelope,
	imageUploadEnvelopeSchema,
} from '../../../../src/remote/image-input-protocol.js'
import {
	INFORMATION_HEADER,
	INFORMATION_RESPONSE_BYTES,
	type InformationResponse,
	informationResponseSchema,
} from '../../../../src/remote/information-protocol.js'
import { type RemoteTarget, sameRemoteTarget } from '../../../../src/remote/protocol.js'
import { SUBAGENT_ACTIVITY_HEADER } from '../../../../src/remote/subagent-activity-protocol.js'
import {
	USAGE_HEADER,
	USAGE_RESPONSE_BYTES,
	type UsageResponse,
	usageResponseSchema,
} from '../../../../src/remote/usage-protocol.js'

export interface InformationTarget {
	hostEpoch: string
	target: RemoteTarget
}

export interface RemoteTransport {
	favorites?(signal: AbortSignal): Promise<FavoritesResponse>
	usage?(signal: AbortSignal): Promise<UsageResponse>
	setFavorite?(request: FavoriteRequest, signal: AbortSignal): Promise<FavoriteRequest>
	/** Optional for legacy/workbench adapters; production uses the negotiated binary route. */
	uploadImage?(
		owner: { hostEpoch: string; target: RemoteTarget },
		image: Blob,
		signal: AbortSignal,
	): Promise<ImageUploadEnvelope>
	/** Separate negotiated information read; absent legacy adapters are unavailable, not proven unsupported. */
	information?(request: InformationTarget, signal: AbortSignal): Promise<InformationResponse>
	/** Optional only for legacy/workbench adapters; production negotiates through the separate endpoint. */
	history?(request: HistoryRequest, signal: AbortSignal): Promise<HistoryResult>
	access(signal: AbortSignal): Promise<RemoteAccessDocument>
	directory(signal: AbortSignal): Promise<RemoteDirectory>
	catalog(cursor: string | null, query: string, signal: AbortSignal): Promise<RemoteCatalogPage>
	detail(sessionId: string, signal: AbortSignal): Promise<RemoteDetail>
	send(command: RemoteCommand, signal: AbortSignal): Promise<RemoteReceipt>
	receipt(command: RemoteCommand, signal: AbortSignal): Promise<RemoteReceipt>
}
type StrippedValue = Record<string, unknown> | unknown[] | string | number | boolean | null
function stripImageFields(value: unknown): StrippedValue {
	if (!value || typeof value !== 'object') return value as StrippedValue
	const copy = Object.fromEntries(
		Object.entries(structuredClone(value) as Record<string, unknown>).filter(([key]) => key !== 'imageInput'),
	)
	if (copy.snapshot && typeof copy.snapshot === 'object') copy.snapshot = stripImageFields(copy.snapshot)
	if (Array.isArray(copy.sessions)) copy.sessions = copy.sessions.map(item => stripImageFields(item))
	return copy
}
function stripSubagentFields(value: unknown): StrippedValue {
	if (!value || typeof value !== 'object') return value as StrippedValue
	const copy = Object.fromEntries(
		Object.entries(structuredClone(value) as Record<string, unknown>).filter(
			([key]) => key !== 'subagents' && key !== 'subagentsFreshForMs',
		),
	)
	if (copy.snapshot && typeof copy.snapshot === 'object') copy.snapshot = stripSubagentFields(copy.snapshot)
	if (Array.isArray(copy.sessions)) copy.sessions = copy.sessions.map(item => stripSubagentFields(item))
	return copy
}

export class RemoteAccessError extends Error {
	constructor(readonly status: number) {
		super(`Remote request failed (${status})`)
	}
}

export class RemoteHistoryError extends RemoteAccessError {
	constructor(
		status: number,
		readonly reason: string,
	) {
		super(status)
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
	async function request(
		path: string,
		signal: AbortSignal,
		body?: unknown,
		extraHeaders: Record<string, string> = {},
		maxBytes = 256 * 1024,
	): Promise<{ value: unknown; headers: Headers }> {
		const response = await fetch(path, {
			method: body ? 'POST' : 'GET',
			signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
			credentials: developmentToken ? 'omit' : 'same-origin',
			cache: 'no-store',
			redirect: 'error',
			headers: {
				...(developmentToken ? { Authorization: `Bearer ${developmentToken}` } : {}),
				...(body ? { 'Content-Type': 'application/json', 'X-Helm-Remote': '1' } : {}),
				...extraHeaders,
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		})
		if (!response.ok) throw new RemoteAccessError(response.status)
		return { value: await readJson(response, maxBytes), headers: response.headers }
	}
	return {
		favorites: async signal => {
			const response = await request(
				'/v1/favorites',
				signal,
				undefined,
				{ [FAVORITES_HEADER]: '1' },
				FAVORITES_RESPONSE_BYTES,
			)
			if (response.headers.get(FAVORITES_HEADER) !== '1') throw new Error('Favorites unavailable')
			return favoritesResponseSchema.parse(response.value)
		},
		usage: async signal => {
			const response = await request('/v1/usage', signal, undefined, { [USAGE_HEADER]: '1' }, USAGE_RESPONSE_BYTES)
			if (response.headers.get(USAGE_HEADER) !== '1') throw new Error('Usage unavailable')
			return usageResponseSchema.parse(response.value)
		},
		setFavorite: async (input, signal) => {
			const body = favoriteRequestSchema.parse(input)
			if (new TextEncoder().encode(JSON.stringify(body)).length > FAVORITES_REQUEST_BYTES)
				throw new Error('Favorite request too large')
			const response = await request(
				'/v1/favorites',
				signal,
				body,
				{ [FAVORITES_HEADER]: '1' },
				FAVORITES_REQUEST_BYTES,
			)
			if (response.headers.get(FAVORITES_HEADER) !== '1') throw new Error('Favorites unavailable')
			const result = favoriteResultSchema.parse(response.value)
			if (
				result.hostEpoch !== body.hostEpoch ||
				!sameRemoteTarget(result.target, body.target) ||
				result.favorite !== body.favorite
			)
				throw new Error('Favorite response mismatch')
			return result
		},
		uploadImage: async (owner, image, signal) => {
			if (image.type !== 'image/jpeg' || image.size < 1 || image.size > IMAGE_PROCESSED_MAX_BYTES)
				throw new Error('Invalid processed image')
			// A JSON poll and a megabyte-and-a-half photo cannot share a deadline: six
			// seconds is generous for one and hopeless for the other on a phone connection.
			const bounded = AbortSignal.any([signal, AbortSignal.timeout(IMAGE_UPLOAD_TIMEOUT_MS)])
			const query = new URLSearchParams({
				hostEpoch: owner.hostEpoch,
				incarnation: owner.target.incarnation,
				scopeId: owner.target.scopeId ?? '',
				generation: String(owner.target.generation),
			})
			const response = await fetch(`/v1/sessions/${encodeURIComponent(owner.target.sessionId)}/images?${query}`, {
				method: 'POST',
				signal: bounded,
				credentials: developmentToken ? 'omit' : 'same-origin',
				cache: 'no-store',
				redirect: 'error',
				headers: {
					...(developmentToken ? { Authorization: `Bearer ${developmentToken}` } : {}),
					'Content-Type': 'image/jpeg',
					'X-Helm-Remote': '1',
					[IMAGE_INPUT_HEADER]: '1',
				},
				body: image,
			})
			if (!response.ok) {
				void response.body?.cancel().catch(() => {})
				throw new RemoteAccessError(response.status)
			}
			if (response.headers.get(IMAGE_INPUT_HEADER) !== '1') {
				void response.body?.cancel().catch(() => {})
				throw new Error('Image input negotiation unavailable')
			}
			const value = imageUploadEnvelopeSchema.parse(await readJson(response, 4096))
			if (value.hostEpoch !== owner.hostEpoch) throw new Error('Image owner changed')
			return value
		},
		information: async (request, signal) => {
			const bounded = AbortSignal.any([signal, AbortSignal.timeout(2000)])
			const query = new URLSearchParams({
				hostEpoch: request.hostEpoch,
				incarnation: request.target.incarnation,
				scopeId: request.target.scopeId ?? '',
				generation: String(request.target.generation),
			})
			const response = await fetch(
				`/v1/sessions/${encodeURIComponent(request.target.sessionId)}/information?${query}`,
				{
					signal: bounded,
					credentials: developmentToken ? 'omit' : 'same-origin',
					cache: 'no-store',
					redirect: 'error',
					headers: {
						[INFORMATION_HEADER]: '1',
						...(developmentToken ? { Authorization: `Bearer ${developmentToken}` } : {}),
					},
				},
			)
			if (!response.ok) {
				void response.body?.cancel().catch(() => {})
				throw new RemoteAccessError(response.status)
			}
			if (response.headers.get(INFORMATION_HEADER) !== '1') {
				void response.body?.cancel().catch(() => {})
				throw new Error('Information negotiation unavailable')
			}
			const value = informationResponseSchema.parse(await readInformationJson(response, bounded))
			if (value.hostEpoch !== request.hostEpoch || !sameRemoteTarget(value.target, request.target))
				throw new Error('Information owner changed')
			return value
		},
		history: async (value, signal) => {
			const response = await fetch('/v1/history/read', {
				method: 'POST',
				signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
				credentials: developmentToken ? 'omit' : 'same-origin',
				cache: 'no-store',
				redirect: 'error',
				headers: {
					...(developmentToken ? { Authorization: `Bearer ${developmentToken}` } : {}),
					'Content-Type': 'application/json',
					'X-Helm-Remote': '1',
				},
				body: JSON.stringify(historyRequestSchema.parse(value)),
			})
			if (!response.ok) {
				const value = (await readJson(response, 4096).catch(() => null)) as { error?: unknown } | null
				throw new RemoteHistoryError(
					response.status,
					response.status === 404 ? 'unsupported' : typeof value?.error === 'string' ? value.error : 'unavailable',
				)
			}
			const result = historyResultSchema.parse(await readJson(response, HISTORY_RESULT_BYTES))
			const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
			if (
				result.page &&
				(bytes(result.page.records) > 64 * 1024 || result.page.records.some(record => bytes(record) > 48 * 1024))
			)
				throw new Error('History response too large')
			return result
		},
		access: async signal => remoteAccessSchema.parse((await request('/v1/access', signal)).value),
		directory: async signal => {
			const response = await request('/v1/sessions', signal, undefined, {
				[SUBAGENT_ACTIVITY_HEADER]: '1',
				[IMAGE_INPUT_HEADER]: '1',
			})
			let value =
				response.headers.get(SUBAGENT_ACTIVITY_HEADER) === '1' ? response.value : stripSubagentFields(response.value)
			if (response.headers.get(IMAGE_INPUT_HEADER) !== '1') value = stripImageFields(value)
			return remoteDirectorySchema.parse(value)
		},
		catalog: async (cursor, query, signal) => {
			const params = new URLSearchParams({ view: catalogView, sequence: String(++catalogSequence) })
			if (cursor) params.set('cursor', cursor)
			if (query.trim()) params.set('q', query.trim())
			return remoteCatalogPageSchema.parse((await request(`/v1/catalog?${params}`, signal)).value)
		},
		detail: async (sessionId, signal) => {
			const response = await request(`/v1/sessions/${encodeURIComponent(sessionId)}`, signal, undefined, {
				[SUBAGENT_ACTIVITY_HEADER]: '1',
				[IMAGE_INPUT_HEADER]: '1',
			})
			let value =
				response.headers.get(SUBAGENT_ACTIVITY_HEADER) === '1' ? response.value : stripSubagentFields(response.value)
			if (response.headers.get(IMAGE_INPUT_HEADER) !== '1') value = stripImageFields(value)
			return remoteDetailSchema.parse(value)
		},
		send: async (command, signal) => {
			const body = JSON.stringify(command)
			if (new TextEncoder().encode(body).byteLength > 24 * 1024) throw new Error('Command too large')
			const image = command.operation.kind === 'prompt' && !!command.operation.images?.length
			return remoteReceiptSchema.parse(
				(await request('/v1/commands', signal, command, image ? { [IMAGE_INPUT_HEADER]: '1' } : {})).value,
			)
		},
		receipt: async (command, signal) => {
			const query = new URLSearchParams({
				sessionId: command.target.sessionId,
				incarnation: command.target.incarnation,
				hostEpoch: command.hostEpoch,
			})
			return remoteReceiptSchema.parse((await request(`/v1/commands/${command.commandId}?${query}`, signal)).value)
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

async function readJson(response: Response, maxBytes = 256 * 1024): Promise<unknown> {
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
			if (size > maxBytes) {
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

/** The information budget/deadline applies to actual bytes, including stalled streams. */
async function readInformationJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const reader = response.body?.getReader()
	if (!reader) throw new Error('Missing information response')
	let rejectAbort: (error: unknown) => void = () => {}
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const abort = () => {
		rejectAbort(signal.reason ?? new Error('Information read aborted'))
		void reader.cancel().catch(() => {})
	}
	signal.addEventListener('abort', abort, { once: true })
	if (signal.aborted) abort()
	const decoder = new TextDecoder('utf-8', { fatal: true })
	let size = 0
	let text = ''
	try {
		while (true) {
			const chunk = await Promise.race([reader.read(), aborted])
			if (signal.aborted) throw signal.reason
			if (chunk.done) break
			size += chunk.value.byteLength
			if (size > INFORMATION_RESPONSE_BYTES) throw new Error('Information response too large')
			text += decoder.decode(chunk.value, { stream: true })
		}
		return JSON.parse(text + decoder.decode())
	} finally {
		signal.removeEventListener('abort', abort)
		void reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}
