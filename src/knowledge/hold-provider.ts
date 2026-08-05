import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { z } from 'zod'
import type { HoldKnowledgeProviderConfig } from '../config.js'
import { type HoldCapability, assertPrivateUnixSocket, readPrivateHoldCapability } from './credentials.js'
import { type KnowledgeProvider, KnowledgeProviderError } from './provider.js'
import {
	type KnowledgeDeliveryReceipt,
	type ProviderKnowledgeBrief,
	knowledgeDeliveryReceiptSchema,
	providerKnowledgeBriefSchema,
} from './schema.js'

const MAX_RESPONSE_BYTES = 1_250_000
const capabilityOperationSchema = z.enum(['brief:prepare', 'candidates:submit', 'records:capture'])
const handshakeSchema = z
	.object({
		protocolVersion: z.literal(1),
		capabilityId: z.string().min(1).max(200),
		operations: z.array(capabilityOperationSchema),
		projectIds: z.array(z.string().min(1).max(200)),
		limits: z
			.object({
				briefCharacters: z.number().int().min(100).max(200_000),
				candidateBatchItems: z.number().int().min(1).max(20),
				candidateContentCharacters: z.number().int().min(1).max(20_000),
			})
			.strict(),
	})
	.strict()
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z
	.object({
		sourceId: z.string().min(1).max(200),
		role: z.enum(['schema', 'foundational', 'index', 'recent', 'relevant']),
		relativePath: z.string().min(1).max(1_000),
		heading: z.string().max(1_000).optional(),
		contentHash: sha256Schema,
		sourceHash: sha256Schema,
		characterCount: z.number().int().nonnegative().max(200_000),
		start: z.number().int().nonnegative(),
		end: z.number().int().nonnegative(),
	})
	.strict()
const briefResponseSchema = z
	.object({
		context: z.string().min(1).max(400_000),
		selectionId: sha256Schema,
		generation: z.number().int().nonnegative(),
		catalogRevision: sha256Schema,
		createdAt: z.string().datetime({ offset: true }),
		hash: sha256Schema,
		manifest: z.array(manifestSchema).max(500),
	})
	.strict()
const candidateReceiptSchema = z
	.object({
		receiptId: z.string().min(1).max(200),
		candidateIds: z.array(z.string().min(1).max(200)).min(1).max(20),
		recordId: z.string().min(1).max(200),
		jobId: z.string().min(1).max(200),
		idempotentReplay: z.boolean(),
		createdAt: z.string().datetime({ offset: true }),
	})
	.strict()
const errorResponseSchema = z
	.object({
		error: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(1_000) }).strict(),
	})
	.strict()

type Handshake = z.infer<typeof handshakeSchema>
type Operation = z.infer<typeof capabilityOperationSchema>

export class HoldKnowledgeProvider implements KnowledgeProvider {
	readonly type = 'hold'
	readonly protocolVersion = 1
	readonly id: string
	private handshakeCache: { token: string; value: Handshake } | null = null

	constructor(private readonly config: HoldKnowledgeProviderConfig) {
		this.id = config.id
	}

	async prepareBrief(input: Parameters<KnowledgeProvider['prepareBrief']>[0]): Promise<ProviderKnowledgeBrief> {
		const capability = await readPrivateHoldCapability(this.config.capabilityFile)
		const handshake = await this.ensureHandshake(capability, 'brief:prepare', input.providerProjectId, input.signal)
		if (input.characterBudget > handshake.limits.briefCharacters) {
			throw new KnowledgeProviderError('configuration', 'Knowledge character budget exceeds provider limits', false)
		}
		const response = parseResponse(
			briefResponseSchema,
			await this.post(
				`/v1/projects/${encodeURIComponent(input.providerProjectId)}/brief`,
				{
					purpose: input.purpose,
					query: input.query,
					characterBudget: input.characterBudget,
				},
				capability.token,
				this.config.timeouts.briefMs,
				input.signal,
				false,
				200,
			),
		)
		const brief = parseResponse(providerKnowledgeBriefSchema, {
			briefRef: response.selectionId,
			revision: `${response.generation}:${response.catalogRevision}`,
			generatedAt: response.createdAt,
			context: response.context,
			contextHash: response.hash,
			sources: response.manifest.map(source => ({
				sourceRef: source.sourceId,
				role: source.role,
				label: source.relativePath,
				heading: source.heading ?? null,
				contentHash: source.contentHash,
				sourceHash: source.sourceHash,
				characters: source.characterCount,
				range: { start: source.start, end: source.end, unit: 'utf16-code-units' as const },
			})),
		})
		verifyNormalizedBrief(brief)
		return brief
	}

	async submitCandidates(
		input: Parameters<KnowledgeProvider['submitCandidates']>[0],
	): Promise<KnowledgeDeliveryReceipt> {
		const capability = await readPrivateHoldCapability(this.config.capabilityFile)
		const handshake = await this.ensureHandshake(capability, 'candidates:submit', input.providerProjectId, input.signal)
		if (input.candidates.length > handshake.limits.candidateBatchItems) {
			throw new KnowledgeProviderError('invalid-request', 'Knowledge candidate batch exceeds provider limits', false)
		}
		const candidates = input.candidates.map(candidate => {
			const content = `# ${candidate.title}\n\n${candidate.content}`
			if ([...content].length > handshake.limits.candidateContentCharacters) {
				throw new KnowledgeProviderError('invalid-request', 'Knowledge candidate exceeds provider limits', false)
			}
			return {
				type: candidate.type,
				content,
				provenance: {
					attemptId: input.attemptRef,
					sourceRefs: [...new Set(input.sourceRefs)].slice(0, 20),
				},
			}
		})
		const response = parseResponse(
			candidateReceiptSchema,
			await this.post(
				`/v1/projects/${encodeURIComponent(input.providerProjectId)}/candidates`,
				{ idempotencyKey: input.idempotencyKey, candidates },
				capability.token,
				this.config.timeouts.candidatesMs,
				input.signal,
				true,
				202,
			),
		)
		return parseResponse(knowledgeDeliveryReceiptSchema, {
			receiptRef: response.receiptId,
			candidateRefs: response.candidateIds,
			recordRef: response.recordId,
			jobRef: response.jobId,
			acceptedAt: response.createdAt,
			replayed: response.idempotentReplay,
		})
	}

	private async ensureHandshake(
		capability: HoldCapability,
		operation: Operation,
		providerProjectId: string,
		signal?: AbortSignal,
	): Promise<Handshake> {
		let handshake = this.handshakeCache?.token === capability.token ? this.handshakeCache.value : undefined
		if (!handshake) {
			handshake = parseResponse(
				handshakeSchema,
				await this.post(
					'/v1/handshake',
					{ protocolVersion: 1 },
					capability.token,
					this.config.timeouts.handshakeMs,
					signal,
					false,
					200,
				),
			)
			if (handshake.capabilityId !== capability.id) {
				throw new KnowledgeProviderError(
					'invalid-response',
					'Knowledge provider returned the wrong capability identity',
					false,
				)
			}
			this.handshakeCache = { token: capability.token, value: handshake }
		}
		if (!handshake.operations.includes(operation)) {
			throw new KnowledgeProviderError('scope', 'Knowledge provider capability lacks the required operation', false)
		}
		if (!handshake.projectIds.includes(providerProjectId)) {
			throw new KnowledgeProviderError('scope', 'Knowledge provider capability lacks the required project', false)
		}
		return handshake
	}

	private async post(
		path: string,
		body: unknown,
		token: string,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		outcomeUnknownOnTransportFailure: boolean,
		expectedStatus: 200 | 202,
	): Promise<unknown> {
		if (signal?.aborted) throw new KnowledgeProviderError('cancelled', 'Knowledge request was cancelled', false)
		const socketPath = await assertPrivateUnixSocket(this.config.socketPath)
		const payload = Buffer.from(JSON.stringify(body), 'utf8')
		if (payload.byteLength > 300 * 1024) {
			throw new KnowledgeProviderError('invalid-request', 'Knowledge request exceeds its transport bound', false)
		}
		return new Promise((resolveRequest, rejectRequest) => {
			let timedOut = false
			let settled = false
			const timeout: { timer?: ReturnType<typeof setTimeout> } = {}
			let request: ReturnType<typeof httpRequest> | undefined
			const onAbort = () => {
				request?.destroy()
				fail(
					new KnowledgeProviderError(
						'cancelled',
						'Knowledge request was cancelled',
						false,
						outcomeUnknownOnTransportFailure,
					),
				)
			}
			const finish = (operation: () => void) => {
				if (settled) return
				settled = true
				if (timeout.timer) clearTimeout(timeout.timer)
				signal?.removeEventListener('abort', onAbort)
				operation()
			}
			const fail = (error: KnowledgeProviderError) => finish(() => rejectRequest(error))
			try {
				request = httpRequest(
					{
						method: 'POST',
						socketPath,
						path,
						agent: false,
						headers: {
							authorization: `Bearer ${token}`,
							'content-type': 'application/json',
							'content-length': String(payload.byteLength),
							accept: 'application/json',
						},
					},
					response => {
						const chunks: Buffer[] = []
						let bytes = 0
						response.on('error', () => {
							fail(
								new KnowledgeProviderError(
									'unavailable',
									'Knowledge provider response was interrupted',
									true,
									outcomeUnknownOnTransportFailure,
								),
							)
						})
						response.on('data', (chunk: Buffer) => {
							bytes += chunk.byteLength
							if (bytes > MAX_RESPONSE_BYTES) {
								request?.destroy()
								fail(new KnowledgeProviderError('invalid-response', 'Knowledge provider response is too large', false))
								return
							}
							chunks.push(chunk)
						})
						response.on('end', () => {
							if (settled) return
							const contentType = response.headers['content-type'] ?? ''
							const cacheControl = response.headers['cache-control'] ?? ''
							if (!contentType.includes('application/json') || !cacheControl.includes('no-store')) {
								fail(
									new KnowledgeProviderError(
										'invalid-response',
										'Knowledge provider response headers are invalid',
										false,
									),
								)
								return
							}
							let parsed: unknown
							try {
								const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
								parsed = JSON.parse(text)
							} catch {
								fail(new KnowledgeProviderError('invalid-response', 'Knowledge provider response is invalid', false))
								return
							}
							if (response.statusCode !== expectedStatus) {
								const error = errorResponseSchema.safeParse(parsed)
								if (response.statusCode === 401) this.handshakeCache = null
								fail(errorForStatus(response.statusCode ?? 500, error.success ? error.data.error.code : undefined))
								return
							}
							finish(() => resolveRequest(parsed))
						})
					},
				)
			} catch {
				fail(
					new KnowledgeProviderError(
						'unavailable',
						'Knowledge provider request could not start',
						true,
						outcomeUnknownOnTransportFailure,
					),
				)
				return
			}
			timeout.timer = setTimeout(() => {
				timedOut = true
				request?.destroy()
				fail(
					new KnowledgeProviderError(
						'timeout',
						'Knowledge provider request timed out',
						true,
						outcomeUnknownOnTransportFailure,
					),
				)
			}, timeoutMs)
			signal?.addEventListener('abort', onAbort, { once: true })
			if (signal?.aborted) {
				onAbort()
				return
			}
			request.on('error', () => {
				if (settled || timedOut) return
				fail(
					new KnowledgeProviderError(
						'unavailable',
						'Knowledge provider is unavailable',
						true,
						outcomeUnknownOnTransportFailure,
					),
				)
			})
			try {
				request.end(payload)
			} catch {
				fail(
					new KnowledgeProviderError(
						'unavailable',
						'Knowledge provider request could not be sent',
						true,
						outcomeUnknownOnTransportFailure,
					),
				)
			}
		})
	}
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value)
	if (!parsed.success) {
		throw new KnowledgeProviderError(
			'invalid-response',
			'Knowledge provider response violated the protocol contract',
			false,
		)
	}
	return parsed.data
}

function verifyNormalizedBrief(brief: ProviderKnowledgeBrief): void {
	if (createHash('sha256').update(brief.context).digest('hex') !== brief.contextHash) {
		throw new KnowledgeProviderError('invalid-response', 'Knowledge provider returned an invalid context hash', false)
	}
	let previousEnd = 0
	for (const source of brief.sources) {
		if (source.range.start < previousEnd || source.range.end > brief.context.length) {
			throw new KnowledgeProviderError('invalid-response', 'Knowledge provider returned an invalid source range', false)
		}
		const selected = brief.context.slice(source.range.start, source.range.end)
		if (
			createHash('sha256').update(selected).digest('hex') !== source.contentHash ||
			[...selected].length !== source.characters
		) {
			throw new KnowledgeProviderError('invalid-response', 'Knowledge provider returned invalid source evidence', false)
		}
		previousEnd = source.range.end
	}
}

function errorForStatus(status: number, code?: string): KnowledgeProviderError {
	switch (status) {
		case 400:
		case 413:
			return new KnowledgeProviderError('invalid-request', 'Knowledge provider rejected the request', false)
		case 401:
			return new KnowledgeProviderError('authorization', 'Knowledge provider authorization failed', false)
		case 404:
			return new KnowledgeProviderError('scope', 'Knowledge provider project is unavailable', false)
		case 409:
			return new KnowledgeProviderError('conflict', 'Knowledge provider reported an idempotency conflict', false)
		case 426:
			return new KnowledgeProviderError('version', 'Knowledge provider protocol version is incompatible', false)
		case 423:
		case 503:
			return new KnowledgeProviderError('unavailable', 'Knowledge provider is temporarily unavailable', true)
		default:
			return new KnowledgeProviderError(
				code === 'UNAUTHORIZED' ? 'authorization' : 'unavailable',
				'Knowledge provider request failed',
				status >= 500,
			)
	}
}
