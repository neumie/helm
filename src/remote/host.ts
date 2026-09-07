import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { verifyScopedCapability } from '../auth/scoped-capability.js'
import { commandFingerprint } from './admission.js'
import {
	REMOTE_BODY_LIMIT,
	REMOTE_COMMAND_TTL_MS,
	REMOTE_PROTOCOL,
	REMOTE_STALE_MS,
	type RemoteCommand,
	type RemoteReceipt,
	type RemoteSnapshot,
	remoteCommandSchema,
	remoteExchangeSchema,
	sameRemoteTarget,
} from './protocol.js'

export interface RemoteEnrollment {
	id: string
	capabilityHash: string
	scopeId: string | null
	generation: number
}
interface Session {
	enrollment: RemoteEnrollment
	snapshot: RemoteSnapshot
	seenAt: number
	commands: Map<
		string,
		{ fingerprint: string; receipt: RemoteReceipt; pending?: RemoteCommand; expiresAt: number; delivered: boolean }
	>
}

/** Isolated proof host. No daemon, DB, process, filesystem or activation authority. */
export class RemoteHost {
	readonly epoch = randomUUID()
	readonly browser = new Hono()
	readonly local = new Hono()
	private readonly enrollments: Map<string, RemoteEnrollment>
	private readonly sessions = new Map<string, Session>()
	// At most 16 initial grants can be burned. Retain receipts, never old transcripts.
	private readonly retired = new Map<string, Map<string, RemoteReceipt>>()
	private revoked = false
	private allowance = 240
	private windowStart = 0
	private readonly now: () => number

	constructor(
		private readonly options: {
			browserCapabilityHash: string
			origin: string
			enrollments: RemoteEnrollment[]
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
		if (options.enrollments.length > 16) throw new Error('Too many proof enrollments')
		this.enrollments = new Map(options.enrollments.map(entry => [entry.id, { ...entry }]))
		if (this.enrollments.size !== options.enrollments.length) throw new Error('Duplicate enrollment')
		this.now = options.now ?? Date.now
		this.installBrowserRoutes(url.host)
		this.installLocalRoutes()
	}

	/** Revocation invalidates reads, writes, queued commands and extension exchanges. */
	revoke(): void {
		this.revoked = true
		this.sessions.clear()
		this.retired.clear()
		this.enrollments.clear()
	}

	private installBrowserRoutes(host: string): void {
		this.browser.use('*', async (c, next) => {
			c.header('Cache-Control', 'no-store')
			c.header('X-Content-Type-Options', 'nosniff')
			c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
			if (this.revoked || !this.matches(c.req.header('Authorization'), this.options.browserCapabilityHash))
				return c.json({ error: 'unauthorized' }, 401)
			const origin = c.req.header('Origin')
			// Same-origin browser GETs normally omit Origin. Bearers are explicit,
			// never ambient cookies; mutations still require an exact Origin.
			if (
				(origin !== undefined && origin !== this.options.origin) ||
				(c.req.method === 'POST' && origin !== this.options.origin) ||
				c.req.header('Host') !== host ||
				c.req.header('Upgrade')
			)
				return c.json({ error: 'origin_denied' }, 403)
			if (!this.takeAllowance()) return c.json({ error: 'rate_limited' }, 429)
			if (c.req.method === 'POST' && c.req.header('Content-Type') !== 'application/json')
				return c.json({ error: 'json_required' }, 415)
			await next()
		})
		this.browser.use('*', bodyLimit({ maxSize: 24 * 1024, onError: c => c.json({ error: 'payload_too_large' }, 413) }))
		this.browser.get('/v1/sessions', c =>
			c.json({
				protocol: REMOTE_PROTOCOL,
				hostEpoch: this.epoch,
				sessions: [...this.sessions.values()].map(session => {
					const { messages: _messages, question: _question, ...summary } = session.snapshot
					return { ...summary, ...this.freshness(session) }
				}),
			}),
		)
		this.browser.get('/v1/sessions/:id', c => {
			const session = this.findSession(c.req.param('id'))
			if (!session) return c.json({ error: 'not_found' }, 404)
			return c.json({
				protocol: REMOTE_PROTOCOL,
				hostEpoch: this.epoch,
				snapshot: { ...session.snapshot, ...this.freshness(session) },
				resync: true,
			})
		})
		this.browser.get('/v1/commands/:id', c => {
			if (c.req.query('hostEpoch') !== this.epoch) return c.json({ error: 'stale_target' }, 409)
			const sessionId = c.req.query('sessionId') ?? ''
			const incarnation = c.req.query('incarnation') ?? ''
			const retired = this.retired.get(`${sessionId}:${incarnation}`)?.get(c.req.param('id'))
			if (retired) return c.json(retired)
			const session = this.findSession(sessionId)
			if (!session || incarnation !== session.snapshot.target.incarnation) return c.json({ error: 'stale_target' }, 409)
			this.expireCommands(session)
			const receipt = session.commands.get(c.req.param('id'))?.receipt
			return receipt ? c.json(receipt) : c.json({ error: 'unknown_command' }, 404)
		})
		this.browser.post('/v1/commands', async c => {
			const parsed = remoteCommandSchema.safeParse(await c.req.json().catch(() => null))
			if (!parsed.success) return c.json({ error: 'invalid_command' }, 400)
			const command = parsed.data
			const session = this.findSession(command.target.sessionId)
			if (!session || command.hostEpoch !== this.epoch || !sameRemoteTarget(command.target, session.snapshot.target))
				return c.json({ error: 'stale_target' }, 409)
			this.expireCommands(session)
			const fingerprint = commandFingerprint(command)
			const prior = session.commands.get(command.commandId)
			if (prior) return prior.fingerprint === fingerprint ? c.json(prior.receipt) : c.json({ error: 'id_reused' }, 409)
			if (!this.freshness(session).connected) return c.json({ error: 'disconnected' }, 409)
			if (
				!session.snapshot.capabilities[
					command.operation.kind === 'answer' ? 'answer' : command.operation.kind === 'prompt' ? 'prompt' : 'interrupt'
				]
			)
				return c.json({ error: 'unsupported' }, 409)
			if (session.commands.size >= 4096 || [...session.commands.values()].filter(entry => entry.pending).length >= 8)
				return c.json({ error: 'admission_full' }, 429)
			if (command.operation.kind === 'answer' && command.operation.requestId !== session.snapshot.question?.requestId)
				return c.json({ error: 'question_closed' }, 409)
			const receipt: RemoteReceipt = { commandId: command.commandId, status: 'pending' }
			session.commands.set(command.commandId, {
				fingerprint,
				receipt,
				pending: command,
				expiresAt: this.now() + REMOTE_COMMAND_TTL_MS,
				delivered: false,
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
			if (enrollmentId !== c.req.header('X-Helm-Enrollment')) return c.json({ error: 'scope_denied' }, 403)
			const enrollment = this.enrollments.get(enrollmentId)
			if (
				!enrollment ||
				enrollment.scopeId !== snapshot.target.scopeId ||
				enrollment.generation !== snapshot.target.generation
			)
				return c.json({ error: 'scope_denied' }, 403)
			let session = this.sessions.get(enrollmentId)
			if (!session) {
				const prior = this.findSession(snapshot.target.sessionId)
				if (prior) {
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
					if (!entry.pending) return []
					entry.delivered = true
					return [{ command: entry.pending, expiresAt: entry.expiresAt }]
				}),
			})
		})
		this.local.all('*', c => c.json({ error: 'not_found' }, 404))
		this.local.onError((_error, c) => c.json({ error: 'remote_error' }, 500))
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
		const receipts = new Map<string, RemoteReceipt>()
		for (const [id, entry] of session.commands)
			receipts.set(id, entry.pending ? { commandId: id, status: 'unknown' } : entry.receipt)
		const { sessionId, incarnation } = session.snapshot.target
		this.retired.set(`${sessionId}:${incarnation}`, receipts)
		this.sessions.delete(session.enrollment.id)
		this.enrollments.delete(session.enrollment.id)
	}

	private findSession(id: string): Session | undefined {
		return [...this.sessions.values()].find(session => session.snapshot.target.sessionId === id)
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
	private takeAllowance(): boolean {
		if (this.now() - this.windowStart >= 60_000) {
			this.windowStart = this.now()
			this.allowance = 240
		}
		return this.allowance-- > 0
	}
}
