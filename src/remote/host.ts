import { createHash, randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { verifyScopedCapability } from '../auth/scoped-capability.js'
import type { RemoteAccess, RemotePrincipal } from './access.js'
import { commandFingerprint } from './admission.js'
import type { PiSessionCatalog } from './catalog.js'
import { FAVORITES_HEADER, FAVORITES_REQUEST_BYTES, favoriteRequestSchema } from './favorites-protocol.js'
import { FavoriteCapacityError, type RemoteFavorites } from './favorites.js'
import {
	HISTORY_HEADER,
	HISTORY_REQUEST_BYTES,
	HISTORY_RESULT_BYTES,
	historyRequestSchema,
	historyResultSchema,
} from './history-protocol.js'
import { type HistoryReadFailure, RemoteHistoryReads } from './history-reads.js'
import { ImageResponseError, RemoteImageBody, readImageDescriptor } from './image-body.js'
import { IMAGE_INPUT_HEADER, IMAGE_INPUT_VERSION, type ImageStoreBinding } from './image-input-protocol.js'
import { RemoteImageStore } from './image-store.js'
import { readInformationBody } from './information-body.js'
import {
	INFORMATION_HEADER,
	INFORMATION_TTL_MS,
	type InformationEnvelope,
	informationEnvelopeSchema,
	informationResponseSchema,
} from './information-protocol.js'
import {
	REMOTE_BODY_LIMIT,
	REMOTE_CATALOG_LABEL_MAX_LENGTH,
	REMOTE_COMMAND_TTL_MS,
	REMOTE_MAX_OWNERS,
	REMOTE_PROTOCOL,
	REMOTE_STALE_MS,
	type RemoteCommand,
	type RemoteReceipt,
	type RemoteSnapshot,
	type RemoteSourceCandidate,
	type RemoteSourceCandidates,
	type RemoteSourceConfirmation,
	type RemoteSummary,
	type RemoteTarget,
	type RemoteTerminalSource,
	remoteCommandSchema,
	remoteExchangeSchema,
	remoteImageReadRequestSchema,
	sameRemoteTarget,
} from './protocol.js'
import { SUBAGENT_ACTIVITY_HEADER } from './subagent-activity-protocol.js'
import { USAGE_HEADER } from './usage-protocol.js'
import type { RemoteUsage } from './usage.js'

/**
 * Which grant a command needs. Choosing the model directs the conversation, so it
 * carries the same authority as prompting rather than the weaker authority to stop one.
 */
function commandAuthority(kind: RemoteCommand['operation']['kind']): 'prompt' | 'interrupt' | 'answer' {
	if (kind === 'answer') return 'answer'
	return kind === 'interrupt' ? 'interrupt' : 'prompt'
}

export interface RemoteEnrollment {
	id: string
	capabilityHash: string
	scopeId: string | null
	generation: number
	/** Automatic registration grants are bound to one validated Pi session UUID. */
	sessionId?: string
	/** Fresh registration grants expire until their first owner exchange. */
	expiresAt?: number
}
interface CommandEntry {
	fingerprint: string
	receipt: RemoteReceipt
	pending?: RemoteCommand
	expiresAt: number
	delivered: boolean
	deviceId?: string
	grantRevision?: number
	imageBinding?: ImageStoreBinding
}
interface Session {
	enrollment: RemoteEnrollment
	snapshot: RemoteSnapshot
	seenAt: number
	commands: Map<string, CommandEntry>
	/** Operator-confirmed display source; memory-only and never native ownership evidence. */
	manualSource?: RemoteTerminalSource
	historyV1?: boolean
	informationV1?: boolean
	informationSupportRevision?: symbol
	informationSequence?: number
	information?: { envelope: InformationEnvelope; receivedAt: number }
	imageInput?: { available: boolean; present: boolean; supportRevision: symbol }
}
interface RetiredIncarnation {
	expiresAt: number
	receipts: Map<string, { receipt: RemoteReceipt; deviceId?: string }>
}

// Receipt history is evidence only. It is bounded independently from live-owner
// admission so replacements cannot retain authority or unbounded command maps.
const RETIRED_RECEIPT_TTL_MS = 60_000
const MAX_RETIRED_INCARNATIONS = 64
const MAX_RETIRED_RECEIPTS = 512
const MAX_RETIRED_RECEIPTS_PER_INCARNATION = 32

/**
 * Session admission and browser projection only. Filesystem cataloging and runtime
 * ownership deliberately stay outside this component.
 */
export class RemoteHost {
	readonly epoch = randomUUID()
	readonly browser = new Hono()
	readonly local = new Hono()
	private readonly enrollments: Map<string, RemoteEnrollment>
	private readonly sessions = new Map<string, Session>()
	private readonly retired = new Map<string, RetiredIncarnation>()
	private revoked = false
	private globalAllowance = 4096
	private unauthenticatedAllowance = 120
	private readonly deviceAllowance = new Map<string, number>()
	private windowStart = 0
	private readonly now: () => number
	private readonly access?: RemoteAccess
	private readonly browserPrincipals = new WeakMap<Request, RemotePrincipal | undefined>()
	private revokeAccess?: () => void
	private readonly historyReads: RemoteHistoryReads
	private readonly imageStore: RemoteImageStore
	private readonly imageBody: RemoteImageBody

	constructor(
		private readonly options: {
			/** Development-only explicit bearer. Persistent runtime supplies access instead. */
			browserCapabilityHash?: string
			origin: string
			enrollments?: RemoteEnrollment[]
			access?: RemoteAccess
			catalog?: PiSessionCatalog
			favorites?: RemoteFavorites
			usage?: RemoteUsage
			now?: () => number
		},
	) {
		let url: URL
		try {
			url = new URL(options.origin)
		} catch {
			throw new Error('Invalid Remote origin')
		}
		if (url.origin !== options.origin || !['http:', 'https:'].includes(url.protocol))
			throw new Error('Invalid Remote origin')
		if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
			throw new Error('Remote requires HTTPS')
		if (!options.browserCapabilityHash && !options.access) throw new Error('Remote requires browser access')
		if (options.browserCapabilityHash && options.access) throw new Error('Remote access modes are exclusive')
		const enrollments = options.enrollments ?? []
		if (enrollments.length > REMOTE_MAX_OWNERS) throw new Error('Too many proof enrollments')
		this.enrollments = new Map(enrollments.map(entry => [entry.id, { ...entry }]))
		if (this.enrollments.size !== enrollments.length) throw new Error('Duplicate enrollment')
		this.now = options.now ?? Date.now
		this.historyReads = new RemoteHistoryReads(this.now)
		this.access = options.access
		this.imageStore = new RemoteImageStore({ now: this.now, isBindingLive: binding => this.imageBindingLive(binding) })
		this.imageBody = new RemoteImageBody(this.imageStore, this.now)
		this.revokeAccess = options.access?.onRevoke((deviceId, revision) => this.revokeDevice(deviceId, revision))
		this.installBrowserRoutes(url.host)
		this.installLocalRoutes()
	}

	/** Runtime-only grant issuance; the capability is returned only for an owner-private descriptor. */
	issueEnrollment(input: {
		id: string
		capabilityHash: string
		scopeId: string | null
		generation: number
		sessionId?: string
		expiresAt?: number
	}): void {
		this.expireEnrollments()
		this.reclaimStaleOwners()
		this.expireRetired()
		if (this.revoked || this.enrollments.has(input.id) || this.enrollments.size >= REMOTE_MAX_OWNERS)
			throw new Error('Remote enrollment unavailable')
		this.enrollments.set(input.id, { ...input })
	}

	/** Revocation invalidates the whole ephemeral development host only. */
	revoke(): void {
		this.revoked = true
		this.historyReads.cancel(() => true)
		this.revokeAccess?.()
		this.imageBody.dispose()
		this.imageStore.dispose()
		this.sessions.clear()
		this.retired.clear()
		this.enrollments.clear()
	}

	/** Operator-only source inventory; no transcript, model, path, or capability data leaves this seam. */
	sourceCandidates(): RemoteSourceCandidates {
		this.expireRetired()
		return {
			hostEpoch: this.epoch,
			candidates: this.revoked ? [] : [...this.sessions.values()].map(session => this.sourceCandidate(session)),
		}
	}

	/**
	 * Confirm or clear a source on one fresh, current owner. The source is a display
	 * repair only: it never changes the Pi snapshot/revision or command admission.
	 */
	confirmSource(
		input: RemoteSourceConfirmation,
	):
		| { ok: true; candidate: RemoteSourceCandidate }
		| { ok: false; error: 'inactive' | 'stale_target' | 'disconnected' } {
		if (input.hostEpoch !== this.epoch) return { ok: false, error: 'stale_target' }
		if (this.revoked) return { ok: false, error: 'inactive' }
		const session = this.sessionForTarget(input.target)
		if (!session) return { ok: false, error: 'stale_target' }
		if (!this.freshness(session).connected) return { ok: false, error: 'disconnected' }
		// Native metadata wins. Clearing here prevents a race from allowing a stale
		// manual fallback to reappear after a later native-metadata loss.
		if (session.snapshot.terminal) session.manualSource = undefined
		else session.manualSource = input.source ?? undefined
		return { ok: true, candidate: this.sourceCandidate(session) }
	}

	private installBrowserRoutes(host: string): void {
		this.browser.use('*', async (c, next) => {
			c.header('Cache-Control', 'no-store')
			c.header('X-Content-Type-Options', 'nosniff')
			c.header('Referrer-Policy', 'no-referrer')
			c.header(
				'Content-Security-Policy',
				"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
			)
			if (this.revoked || !c.req.header('Host')) return c.json({ error: 'unauthorized' }, 401)
			if (c.req.header('Host') !== host || c.req.header('Upgrade')) return c.json({ error: 'origin_denied' }, 403)
			const origin = c.req.header('Origin')
			if (origin !== undefined && origin !== this.options.origin) return c.json({ error: 'origin_denied' }, 403)
			if (c.req.method === 'POST') {
				// RFC 9562 defines versions 1-8 and Pi names its sessions with v7; a narrower
				// pattern silently reclassifies a real upload as JSON and refuses it as CSRF.
				const binaryUpload =
					/^\/v1\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/images$/i.test(
						c.req.path,
					)
				if (
					origin !== this.options.origin ||
					(!binaryUpload && c.req.header('Content-Type') !== 'application/json') ||
					(binaryUpload && c.req.header('Content-Type') !== 'image/jpeg') ||
					((binaryUpload || this.access) && c.req.header('X-Helm-Remote') !== '1') ||
					(binaryUpload && c.req.header(IMAGE_INPUT_HEADER) !== '1')
				)
					return c.json({ error: 'csrf_denied' }, 403)
				const site = c.req.header('Sec-Fetch-Site')
				if (site && site !== 'same-origin' && site !== 'none') return c.json({ error: 'csrf_denied' }, 403)
			}
			await next()
		})
		this.browser.use(
			'/v1/history/read',
			bodyLimit({ maxSize: HISTORY_REQUEST_BYTES, onError: c => c.json({ error: 'payload_too_large' }, 413) }),
		)
		// The exact binary upload is authenticated here before the generic JSON limit.
		// Every other /v1 route remains subject to the 24 KiB body limit below.
		this.browser.post('/v1/sessions/:id/images', async c => {
			// Arrival is logged before any check so a send that never lands is distinguishable
			// from one the host refused.
			console.warn(`Remote received an image upload: ${c.req.header('Content-Length') ?? 'no length'} bytes declared`)
			const url = new URL(c.req.url)
			const requiredQuery = ['hostEpoch', 'incarnation', 'scopeId', 'generation'] as const
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.req.param('id')) ||
				url.searchParams.size !== requiredQuery.length ||
				requiredQuery.some(key => url.searchParams.getAll(key).length !== 1)
			)
				return c.json({ error: 'invalid_image_request' }, 400)
			const authorization = this.browserAuthorization(c.req.raw)
			if (!authorization) return c.json({ error: 'unauthorized' }, 401)
			const principalValue = authorization.principal
			if (!this.takeDeviceAllowance(principalValue?.deviceId ?? 'development') || !this.takeGlobalAllowance())
				return c.json({ error: 'rate_limited' }, 429)
			this.browserPrincipals.set(c.req.raw, principalValue)
			const session = this.findSession(c.req.param('id'))
			const target = session?.snapshot.target
			const query = {
				hostEpoch: c.req.query('hostEpoch'),
				incarnation: c.req.query('incarnation'),
				scopeId: c.req.query('scopeId'),
				generation: c.req.query('generation'),
			}
			if (!session || !target) {
				console.warn('Remote refused an image upload: unknown session')
				return c.json({ error: 'image_unavailable' }, 409)
			}
			// Named rather than bundled: at the device every refusal looks identical.
			const refused = (
				[
					['host_epoch', query.hostEpoch === this.epoch],
					['incarnation', query.incarnation === target.incarnation],
					['scope', query.scopeId === (target.scopeId ?? '')],
					['generation', query.generation === String(target.generation)],
					['not_allowed', this.allowed(principalValue, session, 'prompt')],
					['image_unavailable', this.imageAvailable(session)],
				] as const
			).find(([, met]) => !met)
			if (refused) {
				console.warn(`Remote refused an image upload: ${refused[0]}`)
				return c.json({ error: 'image_unavailable' }, 409)
			}
			const binding = this.imageBinding(session, principalValue)
			try {
				const image = await this.imageBody.upload(c.req.raw, binding, principalValue?.deviceId)
				if (!this.imageBindingLive(binding)) return c.json({ error: 'image_unavailable' }, 409)
				c.header(IMAGE_INPUT_HEADER, '1')
				return c.json({ protocol: IMAGE_INPUT_VERSION, hostEpoch: this.epoch, image }, 201)
			} catch (error) {
				const reason = error instanceof Error ? error.message : ''
				console.warn(`Remote could not accept an image body: ${reason || 'unknown'}`)
				const status =
					reason === 'image_capacity'
						? 429
						: reason === 'image_oversize'
							? 413
							: reason === 'image_timeout'
								? 408
								: reason === 'image_unavailable'
									? 409
									: 400
				return c.json(
					{
						error:
							reason === 'image_capacity'
								? 'image_capacity'
								: reason === 'image_oversize'
									? 'image_oversize'
									: reason === 'image_timeout'
										? 'image_timeout'
										: 'image_upload',
					},
					status,
				)
			}
		})
		this.browser.use(
			'/v1/favorites',
			bodyLimit({ maxSize: FAVORITES_REQUEST_BYTES, onError: c => c.json({ error: 'payload_too_large' }, 413) }),
		)
		this.browser.use('*', bodyLimit({ maxSize: 24 * 1024, onError: c => c.json({ error: 'payload_too_large' }, 413) }))
		this.browser.post('/v1/pair', async c => {
			if (!this.takeUnauthenticatedAllowance()) return c.json({ error: 'rate_limited' }, 429)
			if (!this.access) return c.json({ error: 'not_found' }, 404)
			const value = await c.req.json().catch(() => null)
			if (!value || typeof value !== 'object') return c.json({ error: 'invalid_pairing' }, 400)
			const result = this.access.redeem(value as { code?: string; qrCapability?: string })
			if (!result) return c.json({ error: 'pairing_unavailable' }, 403)
			c.header(
				'Set-Cookie',
				`__Host-helm-remote=${result.credential}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=7776000`,
			)
			return c.json(
				{ hostEpoch: this.epoch, device: { id: result.principal.deviceId, grant: result.principal.grant } },
				201,
			)
		})
		this.browser.use('/v1/*', async (c, next) => {
			const authorization = this.browserAuthorization(c.req.raw)
			if (!authorization) {
				if (!this.takeUnauthenticatedAllowance()) return c.json({ error: 'rate_limited' }, 429)
				return c.json({ error: 'unauthorized' }, 401)
			}
			// Rejected unauthenticated traffic and an exhausted device must not
			// consume the shared authenticated budget.
			if (!this.takeDeviceAllowance(authorization.principal?.deviceId ?? 'development'))
				return c.json({ error: 'rate_limited' }, 429)
			if (!this.takeGlobalAllowance()) return c.json({ error: 'rate_limited' }, 429)
			this.browserPrincipals.set(c.req.raw, authorization.principal)
			await next()
		})
		this.installFavoriteRoutes()
		this.installUsageRoutes()
		const principal = (c: { req: { raw: Request } }) => this.browserPrincipals.get(c.req.raw)
		this.browser.get('/v1/access', c => {
			const value = principal(c)
			return c.json({
				hostEpoch: this.epoch,
				device: value ? { id: value.deviceId, grant: value.grant } : { development: true },
			})
		})
		this.browser.get('/v1/catalog', c => {
			const owner = principal(c)
			if (!this.options.catalog || (this.access && (!owner || !this.access.allows(owner, null, 'read'))))
				return c.json({ error: 'not_found' }, 404)
			const liveSessionIds = this.liveSessionIds(owner)
			return c.json(
				this.options.catalog.page(this.epoch, c.req.query('cursor'), c.req.query('q') ?? '', liveSessionIds, {
					viewId: c.req.query('view') ?? undefined,
					sequence: Number(c.req.query('sequence') ?? 0),
					principalId: owner?.deviceId ?? 'development',
					overlayStamp: overlayStamp(liveSessionIds),
				}),
			)
		})
		this.browser.get('/v1/sessions', c => {
			const activityOptIn = c.req.header(SUBAGENT_ACTIVITY_HEADER) === '1'
			const imageOptIn = c.req.header(IMAGE_INPUT_HEADER) === '1'
			if (imageOptIn) c.header(IMAGE_INPUT_HEADER, '1')
			if (activityOptIn) c.header(SUBAGENT_ACTIVITY_HEADER, '1')
			return c.json({
				protocol: REMOTE_PROTOCOL,
				hostEpoch: this.epoch,
				overlayStamp: overlayStamp(this.liveSessionIds(principal(c))),
				sessions: [...this.sessions.values()]
					.flatMap(session => {
						if (!this.allowed(principal(c), session, 'read')) return []
						const { messages: _messages, question: _question, ...summary } = this.projectSnapshot(principal(c), session)
						return [{ ...summary, ...this.freshness(session) }]
					})
					.map(summary => {
						const projected = activityOptIn
							? this.projectBrowserActivity(summary, this.findSession(summary.target.sessionId))
							: summary
						const activityProjection = projected as typeof projected & { subagentsFreshForMs?: number }
						const { subagents, subagentsFreshForMs, imageInput, ...base } = activityProjection
						return {
							...base,
							...(activityOptIn && subagents ? { subagents } : {}),
							...(activityOptIn && subagentsFreshForMs ? { subagentsFreshForMs } : {}),
							...(imageOptIn && imageInput ? { imageInput } : {}),
						}
					}),
			})
		})
		this.browser.get('/v1/sessions/:id/information', c => {
			const admitted = principal(c)
			const current = this.access && admitted ? this.access.principal(admitted.deviceId) : admitted
			if (this.revoked || (this.access && (!current || current.grantRevision !== admitted?.grantRevision)))
				return c.json({ error: 'unauthorized' }, 401)
			const session = this.findSession(c.req.param('id'))
			if (!session || !this.allowed(current ?? undefined, session, 'read')) return c.json({ error: 'not_found' }, 404)
			const target = session.snapshot.target
			if (
				c.req.query('hostEpoch') !== this.epoch ||
				c.req.query('incarnation') !== target.incarnation ||
				c.req.query('scopeId') !== (target.scopeId ?? '') ||
				c.req.query('generation') !== String(target.generation)
			)
				return c.json({ error: 'stale_target' }, 409)
			if (c.req.header(INFORMATION_HEADER) !== '1') return c.json({ error: 'unsupported' }, 409)
			const remaining = session.information
				? Math.max(
						0,
						Math.min(INFORMATION_TTL_MS, Math.floor(session.information.receivedAt + INFORMATION_TTL_MS - this.now())),
					)
				: 0
			const available =
				session.informationV1 && this.freshness(session).connected && remaining > 0 && session.information
			if (!remaining) session.information = undefined
			const response = informationResponseSchema.safeParse({
				version: 1,
				hostEpoch: this.epoch,
				target,
				status: !session.informationV1 ? 'unsupported' : available ? 'available' : 'unavailable',
				freshForMs: available ? remaining : 0,
				information: available ? available.envelope : null,
			})
			if (!response.success) return c.json({ error: 'information_unavailable' }, 503)
			c.header(INFORMATION_HEADER, '1')
			return c.json(response.data)
		})
		this.browser.get('/v1/sessions/:id', c => {
			const session = this.findSession(c.req.param('id'))
			if (!session || !this.allowed(principal(c), session, 'read')) return c.json({ error: 'not_found' }, 404)
			if (c.req.header(SUBAGENT_ACTIVITY_HEADER) === '1') c.header(SUBAGENT_ACTIVITY_HEADER, '1')
			const snapshot = { ...this.projectSnapshot(principal(c), session), ...this.freshness(session) }
			const activity = c.req.header(SUBAGENT_ACTIVITY_HEADER) === '1'
			const image = c.req.header(IMAGE_INPUT_HEADER) === '1'
			if (image) c.header(IMAGE_INPUT_HEADER, '1')
			const projected = activity ? this.projectBrowserActivity(snapshot, session) : snapshot
			const activityProjection = projected as typeof projected & { subagentsFreshForMs?: number }
			const { subagents, subagentsFreshForMs, imageInput, ...base } = activityProjection
			const output = {
				...base,
				...(activity && subagents ? { subagents } : {}),
				...(activity && subagentsFreshForMs ? { subagentsFreshForMs } : {}),
				...(image && imageInput ? { imageInput } : {}),
			}
			return c.json({ protocol: REMOTE_PROTOCOL, hostEpoch: this.epoch, snapshot: output, resync: true })
		})
		this.browser.post('/v1/history/read', async c => {
			const parsed = historyRequestSchema.safeParse(await c.req.json().catch(() => null))
			if (!parsed.success) return c.json({ error: 'invalid_history' }, 400)
			const request = parsed.data
			const admitted = principal(c)
			const session = this.sessionForTarget(request.target)
			const valid = (): HistoryReadFailure | null => {
				if (
					this.revoked ||
					request.hostEpoch !== this.epoch ||
					!session ||
					this.sessions.get(session.enrollment.id) !== session ||
					!sameRemoteTarget(request.target, session.snapshot.target)
				)
					return 'stale_target'
				const current = this.access && admitted ? this.access.principal(admitted.deviceId) : admitted
				if (this.access && (!current || current.grantRevision !== admitted?.grantRevision)) return 'unauthorized'
				if (!this.allowed(current ?? undefined, session, 'read')) return 'unauthorized'
				if (!this.freshness(session).connected) return 'disconnected'
				return session.historyV1 ? null : 'unsupported'
			}
			const device = admitted?.deviceId ?? 'development'
			const principalKey = createHash('sha256')
				.update(JSON.stringify([device, admitted?.grantRevision ?? 0]))
				.digest('hex')
			const reply = await this.historyReads.request(request, principalKey, device, valid, c.req.raw.signal)
			// Recheck immediately before disclosure, including after promise settlement.
			const error = valid() ?? ('error' in reply ? reply.error : null)
			if (error)
				return c.json(
					{ error },
					error === 'invalid_history'
						? 400
						: error === 'unauthorized'
							? 401
							: error === 'busy'
								? 429
								: error === 'timeout'
									? 503
									: 409,
				)
			return 'result' in reply ? c.json(reply.result) : c.json({ error: 'history_unavailable' }, 503)
		})
		this.browser.get('/v1/commands/:id', c => {
			if (c.req.query('hostEpoch') !== this.epoch) return c.json({ error: 'stale_target' }, 409)
			const sessionId = c.req.query('sessionId') ?? ''
			const incarnation = c.req.query('incarnation') ?? ''
			const owner = principal(c)?.deviceId
			this.expireRetired()
			const retired = this.retired.get(`${sessionId}:${incarnation}`)?.receipts.get(c.req.param('id'))
			if (retired && (!retired.deviceId || retired.deviceId === owner)) return c.json(retired.receipt)
			const session = this.findSession(sessionId)
			if (
				!session ||
				incarnation !== session.snapshot.target.incarnation ||
				!this.allowed(principal(c), session, 'read')
			)
				return c.json({ error: 'stale_target' }, 409)
			this.expireCommands(session)
			const receipt = session.commands.get(c.req.param('id'))
			return receipt && (!receipt.deviceId || receipt.deviceId === owner)
				? c.json(receipt.receipt)
				: c.json({ error: 'unknown_command' }, 404)
		})
		this.browser.post('/v1/commands', async c => {
			const parsed = remoteCommandSchema.safeParse(await c.req.json().catch(() => null))
			if (!parsed.success) return c.json({ error: 'invalid_command' }, 400)
			const admitted = principal(c)
			const current = (admitted && this.access ? this.access.principal(admitted.deviceId) : admitted) ?? undefined
			if (this.access && (!current || current.grantRevision !== admitted?.grantRevision))
				return c.json({ error: 'unauthorized' }, 401)
			const command = parsed.data
			const session = this.findSession(command.target.sessionId)
			if (!session || command.hostEpoch !== this.epoch || !sameRemoteTarget(command.target, session.snapshot.target))
				return c.json({ error: 'stale_target' }, 409)
			// Choosing the model directs the conversation, so it needs the same authority as
			// prompting rather than the weaker authority to stop it.
			const operation = commandAuthority(command.operation.kind)
			if (!this.allowed(current, session, operation)) return c.json({ error: 'forbidden' }, 403)
			this.expireCommands(session)
			const fingerprint = commandFingerprint(command)
			const prior = session.commands.get(command.commandId)
			if (prior)
				return prior.fingerprint === fingerprint && (!prior.deviceId || prior.deviceId === principal(c)?.deviceId)
					? c.json(prior.receipt)
					: c.json({ error: 'id_reused' }, 409)
			if (command.operation.kind === 'prompt' && command.operation.images?.length) {
				if (c.req.header(IMAGE_INPUT_HEADER) !== '1' || !this.imageAvailable(session))
					return c.json({ error: 'image_input_unsupported' }, 409)
			}
			if (!this.freshness(session).connected) return c.json({ error: 'disconnected' }, 409)
			// Model selection is offered by the bridge listing models, not by a capability
			// flag, and a model nobody listed is never dispatched.
			const selection = command.operation.kind === 'model' ? command.operation : undefined
			if (
				selection
					? !session.snapshot.models?.some(value => value.provider === selection.provider && value.id === selection.id)
					: !session.snapshot.capabilities[operation]
			)
				return c.json({ error: 'unsupported' }, 409)
			if (session.commands.size >= 4096 || [...session.commands.values()].filter(entry => entry.pending).length >= 8)
				return c.json({ error: 'admission_full' }, 429)
			if (command.operation.kind === 'answer' && command.operation.requestId !== session.snapshot.question?.requestId)
				return c.json({ error: 'question_closed' }, 409)
			const images = command.operation.kind === 'prompt' ? command.operation.images : undefined
			const imageBinding = images?.length ? this.imageBinding(session, current) : undefined
			const commandExpiresAt = this.now() + REMOTE_COMMAND_TTL_MS
			if (imageBinding && !this.imageStore.bind(images ?? [], imageBinding, command.commandId, commandExpiresAt))
				return c.json({ error: 'image_unavailable' }, 409)
			const receipt: RemoteReceipt = { commandId: command.commandId, status: 'pending' }
			const owner = current
			session.commands.set(command.commandId, {
				fingerprint,
				receipt,
				pending: command,
				expiresAt: commandExpiresAt,
				delivered: false,
				deviceId: owner?.deviceId,
				grantRevision: owner?.grantRevision,
				imageBinding,
			})
			return c.json(receipt, 202)
		})
		this.browser.all('*', c => c.json({ error: 'not_found' }, 404))
		this.browser.onError((_error, c) => c.json({ error: 'remote_error' }, 500))
	}

	/** Host-wide provider limits: readable by any admitted device, never a control surface. */
	private installUsageRoutes(): void {
		this.browser.get('/v1/usage', async c => {
			const usage = this.options.usage
			if (!usage || c.req.header(USAGE_HEADER) !== '1') return c.json({ error: 'unsupported' }, 404)
			const read = await usage.providers()
			c.header(USAGE_HEADER, '1')
			return c.json({ hostEpoch: this.epoch, refreshedAt: read.refreshedAt, providers: read.providers })
		})
	}

	private installFavoriteRoutes(): void {
		this.browser.get('/v1/favorites', c => {
			const favorites = this.options.favorites
			if (!favorites || c.req.header(FAVORITES_HEADER) !== '1') return c.json({ error: 'unsupported' }, 404)
			const principal = this.browserPrincipals.get(c.req.raw)
			c.header(FAVORITES_HEADER, '1')
			return c.json({
				hostEpoch: this.epoch,
				entries: [...this.sessions.values()].flatMap(session =>
					this.allowed(principal, session, 'read')
						? [
								{
									target: session.snapshot.target,
									favorite: favorites.has(session.snapshot.target),
									canEdit: this.allowed(principal, session, 'prompt'),
								},
							]
						: [],
				),
			})
		})
		this.browser.post('/v1/favorites', async c => {
			const favorites = this.options.favorites
			if (!favorites || c.req.header(FAVORITES_HEADER) !== '1') return c.json({ error: 'unsupported' }, 404)
			if (c.req.header('X-Helm-Remote') !== '1') return c.json({ error: 'csrf_denied' }, 403)
			const admitted = this.browserPrincipals.get(c.req.raw)
			const input = favoriteRequestSchema.safeParse(await c.req.json().catch(() => null))
			// Body reading is an await: re-attest the device and host before any write.
			const authorization = this.browserAuthorization(c.req.raw)
			const principal = authorization?.principal
			if (
				this.revoked ||
				!authorization ||
				principal?.deviceId !== admitted?.deviceId ||
				principal?.grantRevision !== admitted?.grantRevision
			)
				return c.json({ error: 'unauthorized' }, 401)
			if (!input.success) return c.json({ error: 'invalid_favorite' }, 400)
			const session = this.findSession(input.data.target.sessionId)
			if (!session || !this.allowed(principal, session, 'read')) return c.json({ error: 'not_found' }, 404)
			if (input.data.hostEpoch !== this.epoch || !sameRemoteTarget(input.data.target, session.snapshot.target))
				return c.json({ error: 'stale_target' }, 409)
			if (!this.allowed(principal, session, 'prompt')) return c.json({ error: 'forbidden' }, 403)
			try {
				favorites.set(session.snapshot.target, input.data.favorite)
			} catch (error) {
				return error instanceof FavoriteCapacityError
					? c.json({ error: 'favorite_limit' }, 409)
					: c.json({ error: 'favorite_save_failed' }, 503)
			}
			c.header(FAVORITES_HEADER, '1')
			return c.json(input.data)
		})
	}

	private installLocalRoutes(): void {
		this.local.use('*', async (c, next) => {
			if (this.revoked || c.req.header('Origin') || c.req.header('Upgrade')) return c.json({ error: 'denied' }, 403)
			const enrollment = this.enrollments.get(c.req.header('X-Helm-Enrollment') ?? '')
			if (!enrollment || !this.matches(c.req.header('Authorization'), enrollment.capabilityHash))
				return c.json({ error: 'unauthorized' }, 401)
			if (c.req.header('Content-Type') !== 'application/json') return c.json({ error: 'json_required' }, 415)
			await next()
		})
		// This route deliberately precedes Hono's generic body middleware: capture
		// owner/support before ANY body await, and independently count actual bytes.
		this.local.post('/extension-information', async c => {
			const id = c.req.header('X-Helm-Enrollment') ?? ''
			const enrollment = this.enrollments.get(id)
			const session = this.sessions.get(id)
			const supportRevision = session?.informationSupportRevision
			const valid = () =>
				!this.revoked &&
				!!session &&
				!!enrollment &&
				this.enrollments.get(id) === enrollment &&
				this.sessions.get(id) === session &&
				this.matches(c.req.header('Authorization'), enrollment.capabilityHash) &&
				session.informationV1 === true &&
				session.informationSupportRevision === supportRevision &&
				this.freshness(session).connected &&
				c.req.header(INFORMATION_HEADER) === '1'
			if (!valid()) return c.json({ error: 'information_unavailable' }, 409)
			const body = await readInformationBody(c.req.raw)
			if (!valid() || !session || c.req.raw.signal.aborted) return c.json({ error: 'information_unavailable' }, 409)
			if ('error' in body)
				return c.json({ error: body.error === 413 ? 'payload_too_large' : 'invalid_information' }, body.error)
			const parsed = informationEnvelopeSchema.safeParse(body.value)
			if (!parsed.success) return c.json({ error: 'invalid_information' }, 400)
			const envelope = parsed.data
			if (envelope.hostEpoch !== this.epoch || !sameRemoteTarget(envelope.target, session.snapshot.target))
				return c.json({ error: 'stale_target' }, 409)
			if (session.informationSequence !== undefined && envelope.sequence <= session.informationSequence)
				return c.json({ error: 'information_replay' }, 409)
			if (!valid()) return c.json({ error: 'information_unavailable' }, 409)
			session.informationSequence = envelope.sequence
			session.information = { envelope, receivedAt: this.now() }
			c.header(INFORMATION_HEADER, '1')
			return c.json({ ok: true })
		})
		this.local.post('/image-input', async c => {
			const started = this.now()
			const enrollmentId = c.req.header('X-Helm-Enrollment') ?? ''
			const enrollment = this.enrollments.get(enrollmentId)
			const session = enrollment ? this.sessions.get(enrollmentId) : undefined
			const initialSupport = session?.imageInput?.supportRevision
			const authorization = c.req.header('Authorization')
			const signal = c.req.raw.signal
			if (!enrollment || !session || !initialSupport || !this.matches(authorization, enrollment.capabilityHash))
				return c.json({ error: 'image_unavailable' }, 409)
			const target = { ...session.snapshot.target }
			const ownerCurrent = () =>
				!this.revoked &&
				!signal.aborted &&
				this.enrollments.get(enrollmentId) === enrollment &&
				this.sessions.get(enrollmentId) === session &&
				this.matches(authorization, enrollment.capabilityHash) &&
				session.imageInput?.supportRevision === initialSupport &&
				sameRemoteTarget(target, session.snapshot.target) &&
				this.imageAvailable(session)
			if (!ownerCurrent()) return c.json({ error: 'image_unavailable' }, 409)
			let setup: ReturnType<RemoteImageBody['beginSetup']> | undefined
			const deadline = started + 2000
			try {
				setup = this.imageBody.beginSetup(this.imageBinding(session, undefined), { deadline, signal: c.req.raw.signal })
				const body = await readImageDescriptor(c.req.raw, { signal: setup.controller.signal })
				if ('error' in body)
					return c.json({ error: body.error === 413 ? 'payload_too_large' : 'invalid_image_request' }, body.error)
				const parsed = remoteImageReadRequestSchema.safeParse(body.value)
				if (!parsed.success || this.now() >= deadline || setup.controller.signal.aborted)
					return c.json({ error: 'invalid_image_request' }, 400)
				if (!ownerCurrent() || parsed.data.hostEpoch !== this.epoch || !sameRemoteTarget(parsed.data.target, target))
					return c.json({ error: 'image_unavailable' }, 409)
				const entry = session.commands.get(parsed.data.commandId)
				if (
					!entry ||
					entry.expiresAt <= this.now() ||
					!entry.delivered ||
					!entry.pending ||
					!entry.imageBinding ||
					entry.pending.operation.kind !== 'prompt' ||
					!entry.pending.operation.images?.some(image => image.handle === parsed.data.image.handle)
				)
					return c.json({ error: 'image_unavailable' }, 409)
				const principalValue =
					entry.deviceId && this.access ? (this.access.principal(entry.deviceId) ?? undefined) : undefined
				if (this.access && (!principalValue || principalValue.grantRevision !== entry.grantRevision))
					return c.json({ error: 'image_unavailable' }, 409)
				const imageBinding = entry.imageBinding
				if (
					!imageBinding ||
					!sameRemoteTarget(imageBinding.target, parsed.data.target) ||
					!this.imageBindingLive(imageBinding)
				)
					return c.json({ error: 'image_unavailable' }, 409)
				const pending = entry.pending
				const commandId = parsed.data.commandId
				const expiresAt = entry.expiresAt
				const valid = () =>
					ownerCurrent() &&
					session.commands.get(commandId) === entry &&
					entry.pending === pending &&
					entry.imageBinding === imageBinding &&
					entry.delivered &&
					entry.receipt.status === 'pending' &&
					entry.expiresAt === expiresAt &&
					this.now() < expiresAt &&
					imageBinding.hostEpoch === this.epoch &&
					imageBinding.supportRevision === initialSupport &&
					entry.deviceId === imageBinding.deviceId &&
					entry.grantRevision === imageBinding.grantRevision &&
					this.imageBindingLive(imageBinding)
				return this.imageBody.response(
					parsed.data.image,
					imageBinding,
					principalValue?.deviceId,
					parsed.data.commandId,
					parsed.data.image.bytes,
					entry.expiresAt,
					valid,
					(c.env as { outgoing?: ServerResponse } | undefined)?.outgoing,
					setup,
				)
			} catch (error) {
				if (error instanceof ImageResponseError) return c.json({ error: error.message }, error.status)
				throw error
			} finally {
				if (setup) this.imageBody.finishSetup(setup)
			}
		})
		this.local.use(
			'/history-result',
			bodyLimit({ maxSize: HISTORY_RESULT_BYTES, onError: c => c.json({ error: 'payload_too_large' }, 413) }),
		)
		this.local.use(
			'*',
			bodyLimit({ maxSize: REMOTE_BODY_LIMIT, onError: c => c.json({ error: 'payload_too_large' }, 413) }),
		)
		this.local.post('/history-result', async c => {
			const parsed = historyResultSchema.safeParse(await c.req.json().catch(() => null))
			if (!parsed.success) return c.json({ error: 'invalid_history' }, 400)
			const session = this.sessions.get(c.req.header('X-Helm-Enrollment') ?? '')
			if (
				!session ||
				!session.historyV1 ||
				parsed.data.hostEpoch !== this.epoch ||
				!sameRemoteTarget(parsed.data.target, session.snapshot.target)
			)
				return c.json({ error: 'stale_target' }, 409)
			// Unlike exchange, a read result cannot register an owner or renew seenAt.
			return this.historyReads.complete(parsed.data) ? c.json({ ok: true }) : c.json({ error: 'stale_read' }, 409)
		})
		this.local.post('/exchange', async c => {
			const parsed = remoteExchangeSchema.safeParse(await c.req.json().catch(() => null))
			if (!parsed.success) return c.json({ error: 'invalid_exchange' }, 400)
			const { enrollmentId, snapshot, receipts } = parsed.data
			// Body parsing may have consumed an unused grant's TTL. Recheck at the
			// final binding boundary rather than trusting the pre-await clock.
			this.expireEnrollments()
			if (enrollmentId !== c.req.header('X-Helm-Enrollment')) return c.json({ error: 'scope_denied' }, 403)
			const enrollment = this.enrollments.get(enrollmentId)
			if (
				!enrollment ||
				(enrollment.expiresAt !== undefined &&
					!this.sessions.has(enrollmentId) &&
					enrollment.expiresAt <= this.now()) ||
				enrollment.scopeId !== snapshot.target.scopeId ||
				enrollment.generation !== snapshot.target.generation ||
				(enrollment.sessionId !== undefined && enrollment.sessionId !== snapshot.target.sessionId)
			)
				return c.json({ error: 'scope_denied' }, 403)
			let session = this.sessions.get(enrollmentId)
			if (!session) {
				const prior = this.findSession(snapshot.target.sessionId)
				if (prior) {
					// UUID binding identifies a conversation, not continuity of its owner.
					// Even automatic grants must wait for the prior observation to stale;
					// a second TUI must never displace a live owner merely by naming its UUID.
					if (
						this.freshness(prior).connected ||
						prior.enrollment.scopeId !== enrollment.scopeId ||
						prior.enrollment.generation !== enrollment.generation ||
						prior.snapshot.target.incarnation === snapshot.target.incarnation
					)
						return c.json({ error: 'owner_conflict' }, 409)
					this.retire(prior)
				}
				session = { enrollment, snapshot, seenAt: this.now(), commands: new Map() }
				this.sessions.set(enrollmentId, session)
			}
			if (!sameRemoteTarget(session.snapshot.target, snapshot.target) || snapshot.revision < session.snapshot.revision)
				return c.json({ error: 'owner_conflict' }, 409)
			this.expireCommands(session)
			const imageV1 = c.req.header(IMAGE_INPUT_HEADER) === '1'
			const nextImageAvailable = imageV1 && snapshot.imageInput?.available === true
			const nextImagePresent = imageV1 && snapshot.imageInput !== undefined
			if (
				!session.imageInput ||
				session.imageInput.available !== nextImageAvailable ||
				session.imageInput.present !== nextImagePresent
			) {
				if (session.imageInput) {
					const oldBinding: ImageStoreBinding = {
						target: session.snapshot.target,
						hostEpoch: this.epoch,
						supportRevision: session.imageInput.supportRevision,
					}
					this.imageBody.invalidateExact(oldBinding)
					this.imageStore.invalidate(binding => binding.target.sessionId === session.snapshot.target.sessionId)
				}
				session.imageInput = { available: nextImageAvailable, present: nextImagePresent, supportRevision: Symbol() }
			}
			// Once native metadata is observed, discard any operator fallback. If the
			// native observer later disappears, it must not resurrect that stale source.
			if (snapshot.terminal) session.manualSource = undefined
			session.snapshot = snapshot
			session.seenAt = this.now()
			if (!this.imageAvailable(session)) {
				const belongsToOwner = (binding: ImageStoreBinding) => sameRemoteTarget(binding.target, snapshot.target)
				this.imageBody.invalidate(belongsToOwner)
				this.imageStore.invalidate(belongsToOwner)
			}
			const informationV1 = c.req.header(INFORMATION_HEADER) === '1'
			if (session.informationV1 !== informationV1) {
				session.informationSupportRevision = Symbol()
				session.information = undefined
			}
			session.informationV1 = informationV1
			if (informationV1) c.header(INFORMATION_HEADER, '1')
			if (imageV1) c.header(IMAGE_INPUT_HEADER, '1')
			const activityV1 = c.req.header(SUBAGENT_ACTIVITY_HEADER) === '1'
			if (activityV1) c.header(SUBAGENT_ACTIVITY_HEADER, '1')
			session.historyV1 = c.req.header(HISTORY_HEADER) === '1'
			if (!session.historyV1)
				this.historyReads.cancel(request => sameRemoteTarget(request.target, snapshot.target), 'unsupported')
			for (const receipt of receipts) {
				const entry = session.commands.get(receipt.commandId)
				if (entry && (entry.pending || entry.receipt.status === 'unknown') && receipt.status !== 'pending') {
					this.retireEntryImages(session, entry)
					entry.receipt = receipt
					entry.pending = undefined
				}
			}
			const historyRead = session.historyV1
				? this.historyReads.deliver({ hostEpoch: this.epoch, target: snapshot.target })
				: undefined
			const response = {
				protocol: REMOTE_PROTOCOL,
				hostEpoch: this.epoch,
				commands: [] as Array<{ command: RemoteCommand; expiresAt: number }>,
				...(historyRead ? { historyRead } : {}),
			}
			// Reserve the read descriptor before marking commands delivered. Oversized
			// combined responses defer work instead of expanding the256KiB envelope.
			for (const entry of session.commands.values()) {
				if (!entry.pending || !this.deliveryAllowed(entry, session)) continue
				const value = { command: entry.pending, expiresAt: entry.expiresAt }
				response.commands.push(value)
				if (Buffer.byteLength(JSON.stringify(response)) > REMOTE_BODY_LIMIT) {
					response.commands.pop()
					continue
				}
				entry.delivered = true
			}
			return c.json(response)
		})
		this.local.all('*', c => c.json({ error: 'not_found' }, 404))
		this.local.onError((_error, c) => c.json({ error: 'remote_error' }, 500))
	}

	private browserAuthorization(request: Request): { principal: RemotePrincipal | undefined } | null {
		if (this.access) {
			const principal = this.access.authenticate(
				cookie(request.headers.get('Cookie'), '__Host-helm-remote') ?? undefined,
			)
			return principal ? { principal } : null
		}
		return this.matches(request.headers.get('Authorization') ?? undefined, this.options.browserCapabilityHash ?? '')
			? { principal: undefined }
			: null
	}
	private liveSessionIds(principal: RemotePrincipal | undefined): Set<string> {
		return new Set(
			[...this.sessions.values()]
				.filter(session => this.allowed(principal, session, 'read'))
				.map(session => session.snapshot.target.sessionId),
		)
	}
	/** Last refusal reported, so a 2-second poll cannot flood the log with one fact. */
	private imageRefusalLog = ''
	private imageAvailable(session: Session): boolean {
		const conditions = {
			negotiated: session.imageInput?.available === true,
			connected: this.freshness(session).connected,
			notWaiting: session.snapshot.activity !== 'waiting',
			canPrompt: session.snapshot.capabilities.prompt,
			noQuestion: !session.snapshot.question,
		}
		const available = Object.values(conditions).every(Boolean)
		// A refused image is otherwise indistinguishable from the others at the device.
		// The model is named because 'negotiated' has two very different causes: a model
		// that cannot take images, and a model the bridge never managed to read.
		if (!available && this.imageRefusalLog !== JSON.stringify([conditions, session.snapshot.model])) {
			this.imageRefusalLog = JSON.stringify([conditions, session.snapshot.model])
			console.warn(
				`Remote refused images for model ${session.snapshot.model ?? 'unknown'} (image input ${
					session.imageInput
						? `present=${session.imageInput.present} available=${session.imageInput.available}`
						: 'never advertised'
				}): ${Object.entries(conditions)
					.filter(([, met]) => !met)
					.map(([name]) => name)
					.join(', ')}`,
			)
		}
		return available
	}
	private imageBinding(session: Session, principal: RemotePrincipal | undefined): ImageStoreBinding {
		return {
			target: session.snapshot.target,
			hostEpoch: this.epoch,
			deviceId: principal?.deviceId,
			grantRevision: principal?.grantRevision,
			supportRevision: session.imageInput?.supportRevision ?? Symbol(),
		}
	}
	private imageBindingLive(binding: ImageStoreBinding): boolean {
		if (this.revoked || binding.hostEpoch !== this.epoch) return false
		const session = [...this.sessions.values()].find(item => sameRemoteTarget(item.snapshot.target, binding.target))
		if (!session || session.imageInput?.supportRevision !== binding.supportRevision || !session.imageInput?.available)
			return false
		if (
			!this.freshness(session).connected ||
			session.snapshot.activity === 'waiting' ||
			!session.snapshot.capabilities.prompt ||
			session.snapshot.question
		)
			return false
		const principal =
			(binding.deviceId && this.access ? this.access.principal(binding.deviceId) : undefined) ?? undefined
		if (this.access && (!principal || principal.grantRevision !== binding.grantRevision)) return false
		return this.allowed(principal, session, 'prompt')
	}
	private allowed(
		principal: RemotePrincipal | undefined,
		session: Session,
		operation: 'read' | 'prompt' | 'interrupt' | 'answer',
	): boolean {
		return !this.access || (!!principal && this.access.allows(principal, session.snapshot.target.scopeId, operation))
	}
	private projectBrowserActivity<T extends RemoteSnapshot | RemoteSummary>(value: T, session: Session | undefined): T {
		if (!session || !value.subagents) return value
		const remaining = Math.max(0, Math.min(REMOTE_STALE_MS, Math.floor(session.seenAt + REMOTE_STALE_MS - this.now())))
		if (!this.freshness(session).connected || remaining <= 0)
			return { ...value, subagents: { availability: 'unavailable', coverage: 'unavailable', active: null } }
		return value.subagents.availability === 'available' ? { ...value, subagentsFreshForMs: remaining } : value
	}
	private projectSnapshot(principal: RemotePrincipal | undefined, session: Session): RemoteSnapshot {
		const snapshot = session.snapshot
		const terminal =
			snapshot.terminal ??
			(session.manualSource
				? {
						source: session.manualSource,
						project: null,
						worktree: null,
						branch: null,
						name: null,
						group: null,
					}
				: undefined)
		return {
			...snapshot,
			...(terminal ? { terminal } : {}),
			...(session.imageInput?.present
				? {
						imageInput: {
							version: IMAGE_INPUT_VERSION,
							available: session.imageInput.available && this.allowed(principal, session, 'prompt'),
						},
					}
				: { imageInput: undefined }),
			capabilities: {
				prompt: snapshot.capabilities.prompt && this.allowed(principal, session, 'prompt'),
				interrupt: snapshot.capabilities.interrupt && this.allowed(principal, session, 'interrupt'),
				answer: snapshot.capabilities.answer && this.allowed(principal, session, 'answer'),
			},
		}
	}
	private deliveryAllowed(entry: CommandEntry, session: Session): boolean {
		if (!entry.pending) return false
		if (!this.access || !entry.deviceId) return true
		const principal = this.access.principal(entry.deviceId)
		const operation = commandAuthority(entry.pending.operation.kind)
		if (
			principal &&
			principal.grantRevision === entry.grantRevision &&
			this.access.allows(principal, session.snapshot.target.scopeId, operation)
		)
			return true
		this.retireEntryImages(session, entry)
		entry.receipt = { commandId: entry.receipt.commandId, status: entry.delivered ? 'unknown' : 'rejected' }
		entry.pending = undefined
		return false
	}
	private revokeDevice(deviceId: string, _revision: number): void {
		this.historyReads.cancel((_request, device) => device === deviceId, 'unauthorized')
		this.imageBody.invalidate(binding => binding.deviceId === deviceId)
		this.imageStore.invalidate(binding => binding.deviceId === deviceId)
		for (const session of this.sessions.values())
			for (const entry of session.commands.values())
				if (entry.deviceId === deviceId && entry.pending) {
					this.retireEntryImages(session, entry)
					entry.receipt = { commandId: entry.receipt.commandId, status: entry.delivered ? 'unknown' : 'rejected' }
					entry.pending = undefined
				}
	}
	private retireEntryImages(_session: Session, entry: CommandEntry): void {
		const binding = entry.imageBinding
		if (binding) {
			this.imageStore.retireCommand(binding, entry.receipt.commandId)
			this.imageBody.invalidateCommand(binding, entry.receipt.commandId)
		}
		entry.imageBinding = undefined
	}
	private expireCommands(session: Session): void {
		for (const entry of session.commands.values()) {
			if (!entry.pending || (this.now() < entry.expiresAt && (!entry.delivered || this.freshness(session).connected)))
				continue
			this.retireEntryImages(session, entry)
			entry.receipt = { commandId: entry.receipt.commandId, status: entry.delivered ? 'unknown' : 'rejected' }
			entry.pending = undefined
		}
	}
	private retire(session: Session): void {
		this.historyReads.cancel(request => sameRemoteTarget(request.target, session.snapshot.target))
		this.imageBody.invalidate(binding => sameRemoteTarget(binding.target, session.snapshot.target))
		this.imageStore.invalidate(binding => sameRemoteTarget(binding.target, session.snapshot.target))
		this.expireRetired()
		const receipts = new Map<string, { receipt: RemoteReceipt; deviceId?: string }>()
		for (const [id, entry] of session.commands) {
			if (receipts.size >= MAX_RETIRED_RECEIPTS_PER_INCARNATION) break
			receipts.set(id, {
				receipt: entry.pending ? { commandId: id, status: entry.delivered ? 'unknown' : 'rejected' } : entry.receipt,
				deviceId: entry.deviceId,
			})
		}
		const { sessionId, incarnation } = session.snapshot.target
		// Empty histories are intentionally not retained: an old target is stale,
		// but it has no receipt evidence to serve.
		if (receipts.size) {
			while (
				this.retired.size >= MAX_RETIRED_INCARNATIONS ||
				this.retiredReceiptCount() + receipts.size > MAX_RETIRED_RECEIPTS
			)
				this.dropOldestRetired()
			this.retired.set(`${sessionId}:${incarnation}`, {
				expiresAt: this.now() + RETIRED_RECEIPT_TTL_MS,
				receipts,
			})
		}
		this.sessions.delete(session.enrollment.id)
		this.enrollments.delete(session.enrollment.id)
	}
	private reclaimStaleOwners(): void {
		for (const session of [...this.sessions.values()]) if (!this.freshness(session).connected) this.retire(session)
	}
	private expireRetired(): void {
		for (const [key, retired] of this.retired) if (retired.expiresAt <= this.now()) this.retired.delete(key)
	}
	private retiredReceiptCount(): number {
		let count = 0
		for (const retired of this.retired.values()) count += retired.receipts.size
		return count
	}
	private dropOldestRetired(): void {
		const oldest = this.retired.keys().next().value
		if (oldest === undefined) return
		this.retired.delete(oldest)
	}
	private expireEnrollments(): void {
		for (const [id, enrollment] of this.enrollments)
			if (enrollment.expiresAt !== undefined && enrollment.expiresAt <= this.now() && !this.sessions.has(id))
				this.enrollments.delete(id)
	}
	private findSession(id: string): Session | undefined {
		return [...this.sessions.values()].find(session => session.snapshot.target.sessionId === id)
	}
	private sessionForTarget(target: RemoteTarget): Session | undefined {
		return [...this.sessions.values()].find(session => sameRemoteTarget(session.snapshot.target, target))
	}
	private sourceCandidate(session: Session): RemoteSourceCandidate {
		const nativeSource = session.snapshot.terminal?.source ?? null
		return {
			target: { ...session.snapshot.target },
			caption: sourceCaption(session.snapshot),
			connected: this.freshness(session).connected,
			nativeSource,
			manualSource: nativeSource ? null : (session.manualSource ?? null),
		}
	}
	private freshness(session: Session) {
		const connected = this.now() - session.seenAt < REMOTE_STALE_MS
		return { connected, activity: connected ? session.snapshot.activity : ('unknown' as const) }
	}
	private matches(header: string | undefined, hash: string): boolean {
		return (
			!!header && header.length === 50 && header.startsWith('Bearer ') && verifyScopedCapability(header.slice(7), hash)
		)
	}
	private resetAllowances(): void {
		if (this.now() - this.windowStart < 60_000) return
		this.windowStart = this.now()
		this.globalAllowance = 4096
		this.unauthenticatedAllowance = 120
		this.deviceAllowance.clear()
	}
	private takeGlobalAllowance(): boolean {
		this.resetAllowances()
		return this.globalAllowance-- > 0
	}
	private takeUnauthenticatedAllowance(): boolean {
		this.resetAllowances()
		return this.unauthenticatedAllowance-- > 0
	}
	private takeDeviceAllowance(deviceId: string): boolean {
		this.resetAllowances()
		const remaining = this.deviceAllowance.get(deviceId) ?? 300
		if (remaining <= 0) return false
		this.deviceAllowance.set(deviceId, remaining - 1)
		return true
	}
}

function sourceCaption(snapshot: RemoteSnapshot): string {
	const clean = (value: string): string =>
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: operator-facing captions must not carry terminal controls.
			.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
			.trim()
			.slice(0, REMOTE_CATALOG_LABEL_MAX_LENGTH)
			.replace(/[\uD800-\uDBFF]$/, '')
	const caption = clean(snapshot.label)
	if (caption && caption.toLowerCase() !== 'pi session') return caption
	return clean(snapshot.workspace) || 'Pi session'
}
function overlayStamp(ids: ReadonlySet<string>): string {
	return createHash('sha256')
		.update([...ids].sort().join('\0'))
		.digest('base64url')
		.slice(0, 24)
}
function cookie(value: string | null, name: string): string | undefined {
	return value
		?.split(';')
		.map(part => part.trim())
		.find(part => part.startsWith(`${name}=`))
		?.slice(name.length + 1)
}
