import { createHash, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { verifyScopedCapability } from '../auth/scoped-capability.js'
import type { RemoteAccess, RemotePrincipal } from './access.js'
import { commandFingerprint } from './admission.js'
import type { PiSessionCatalog } from './catalog.js'
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
	type RemoteTarget,
	type RemoteTerminalSource,
	remoteCommandSchema,
	remoteExchangeSchema,
	sameRemoteTarget,
} from './protocol.js'

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
}
interface Session {
	enrollment: RemoteEnrollment
	snapshot: RemoteSnapshot
	seenAt: number
	commands: Map<string, CommandEntry>
	/** Operator-confirmed display source; memory-only and never native ownership evidence. */
	manualSource?: RemoteTerminalSource
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

	constructor(
		private readonly options: {
			/** Development-only explicit bearer. Persistent runtime supplies access instead. */
			browserCapabilityHash?: string
			origin: string
			enrollments?: RemoteEnrollment[]
			access?: RemoteAccess
			catalog?: PiSessionCatalog
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
		this.access = options.access
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
		this.revokeAccess?.()
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
				if (
					origin !== this.options.origin ||
					c.req.header('Content-Type') !== 'application/json' ||
					(this.access && c.req.header('X-Helm-Remote') !== '1')
				)
					return c.json({ error: 'csrf_denied' }, 403)
				const site = c.req.header('Sec-Fetch-Site')
				if (site && site !== 'same-origin' && site !== 'none') return c.json({ error: 'csrf_denied' }, 403)
			}
			await next()
		})
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
		this.browser.get('/v1/sessions', c =>
			c.json({
				protocol: REMOTE_PROTOCOL,
				hostEpoch: this.epoch,
				overlayStamp: overlayStamp(this.liveSessionIds(principal(c))),
				sessions: [...this.sessions.values()].flatMap(session => {
					if (!this.allowed(principal(c), session, 'read')) return []
					const { messages: _messages, question: _question, ...summary } = this.projectSnapshot(principal(c), session)
					return [{ ...summary, ...this.freshness(session) }]
				}),
			}),
		)
		this.browser.get('/v1/sessions/:id', c => {
			const session = this.findSession(c.req.param('id'))
			if (!session || !this.allowed(principal(c), session, 'read')) return c.json({ error: 'not_found' }, 404)
			return c.json({
				protocol: REMOTE_PROTOCOL,
				hostEpoch: this.epoch,
				snapshot: { ...this.projectSnapshot(principal(c), session), ...this.freshness(session) },
				resync: true,
			})
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
			const operation =
				command.operation.kind === 'answer' ? 'answer' : command.operation.kind === 'prompt' ? 'prompt' : 'interrupt'
			if (!this.allowed(current, session, operation)) return c.json({ error: 'forbidden' }, 403)
			this.expireCommands(session)
			const fingerprint = commandFingerprint(command)
			const prior = session.commands.get(command.commandId)
			if (prior)
				return prior.fingerprint === fingerprint && (!prior.deviceId || prior.deviceId === principal(c)?.deviceId)
					? c.json(prior.receipt)
					: c.json({ error: 'id_reused' }, 409)
			if (!this.freshness(session).connected) return c.json({ error: 'disconnected' }, 409)
			if (!session.snapshot.capabilities[operation]) return c.json({ error: 'unsupported' }, 409)
			if (session.commands.size >= 4096 || [...session.commands.values()].filter(entry => entry.pending).length >= 8)
				return c.json({ error: 'admission_full' }, 429)
			if (command.operation.kind === 'answer' && command.operation.requestId !== session.snapshot.question?.requestId)
				return c.json({ error: 'question_closed' }, 409)
			const receipt: RemoteReceipt = { commandId: command.commandId, status: 'pending' }
			const owner = current
			session.commands.set(command.commandId, {
				fingerprint,
				receipt,
				pending: command,
				expiresAt: this.now() + REMOTE_COMMAND_TTL_MS,
				delivered: false,
				deviceId: owner?.deviceId,
				grantRevision: owner?.grantRevision,
			})
			return c.json(receipt, 202)
		})
		this.browser.all('*', c => c.json({ error: 'not_found' }, 404))
		this.browser.onError((_error, c) => c.json({ error: 'remote_error' }, 500))
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
		this.local.use(
			'*',
			bodyLimit({ maxSize: REMOTE_BODY_LIMIT, onError: c => c.json({ error: 'payload_too_large' }, 413) }),
		)
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
			// Once native metadata is observed, discard any operator fallback. If the
			// native observer later disappears, it must not resurrect that stale source.
			if (snapshot.terminal) session.manualSource = undefined
			session.snapshot = snapshot
			session.seenAt = this.now()
			for (const receipt of receipts) {
				const entry = session.commands.get(receipt.commandId)
				if (entry && (entry.pending || entry.receipt.status === 'unknown') && receipt.status !== 'pending') {
					entry.receipt = receipt
					entry.pending = undefined
				}
			}
			return c.json({
				protocol: REMOTE_PROTOCOL,
				hostEpoch: this.epoch,
				commands: [...session.commands.values()].flatMap(entry => {
					if (!entry.pending || !this.deliveryAllowed(entry, session)) return []
					entry.delivered = true
					return [{ command: entry.pending, expiresAt: entry.expiresAt }]
				}),
			})
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
	private allowed(
		principal: RemotePrincipal | undefined,
		session: Session,
		operation: 'read' | 'prompt' | 'interrupt' | 'answer',
	): boolean {
		return !this.access || (!!principal && this.access.allows(principal, session.snapshot.target.scopeId, operation))
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
		const operation =
			entry.pending.operation.kind === 'answer'
				? 'answer'
				: entry.pending.operation.kind === 'prompt'
					? 'prompt'
					: 'interrupt'
		if (
			principal &&
			principal.grantRevision === entry.grantRevision &&
			this.access.allows(principal, session.snapshot.target.scopeId, operation)
		)
			return true
		entry.receipt = { commandId: entry.receipt.commandId, status: entry.delivered ? 'unknown' : 'rejected' }
		entry.pending = undefined
		return false
	}
	private revokeDevice(deviceId: string, _revision: number): void {
		for (const session of this.sessions.values())
			for (const entry of session.commands.values())
				if (entry.deviceId === deviceId && entry.pending) {
					entry.receipt = { commandId: entry.receipt.commandId, status: entry.delivered ? 'unknown' : 'rejected' }
					entry.pending = undefined
				}
	}
	private expireCommands(session: Session): void {
		for (const entry of session.commands.values()) {
			if (!entry.pending || (this.now() < entry.expiresAt && (!entry.delivered || this.freshness(session).connected)))
				continue
			entry.receipt = { commandId: entry.receipt.commandId, status: entry.delivered ? 'unknown' : 'rejected' }
			entry.pending = undefined
		}
	}
	private retire(session: Session): void {
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
