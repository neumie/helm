import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, open, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { basename, join } from 'node:path'
import { z } from 'zod'
import {
	privateDirectory,
	privateNames,
	readPrivateJson,
	removePrivateFile,
	removeStrayTemps,
	writePrivateJson,
} from './private-state.js'
import {
	REVIEW_ACTIONS,
	REVIEW_CONNECT_FEATURES,
	REVIEW_FEATURES,
	REVIEW_PROTOCOL,
	REVIEW_VIEW_RATE,
	REVIEW_WIRE_BYTES,
	connectionSchema,
	envelopeSchema,
	reviewId,
} from './protocol.js'
import type { ReviewCallerCommand, ReviewCommand, ReviewConnection, ReviewViewResult } from './protocol.js'
import { describeReviewFailure, refuse, restartingRefusal } from './refusal.js'

/** A live process holds the review host lock: another Helm runs, or the previous one is still quitting. */
export const REVIEW_NAMESPACE_HELD = 'Another review host owns this private namespace.'
export interface CallerBinding {
	id: string
	owner: string
	profileId: string
	profileToken: string
	workspace: string
}
/**
 * What the host keeps on disk for one caller connection so it survives a Helm restart (S13): the identity, the
 * profile and workspace it was made in, the epoch it was made under and only a hash of its token (the CLI's own
 * connection file holds the token). Owner-private, next to the connection file, removed when the connection retires.
 */
export interface CallerBindingRecord {
	version: 1
	id: string
	owner: string
	epoch: string
	tokenHash: string
	profileId: string
	workspace: string
	createdAt: number
}
const bindingRecordSchema = z
	.object({
		version: z.literal(1),
		id: reviewId,
		owner: z.string().uuid(),
		epoch: z.string().uuid(),
		tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
		profileId: z.string().min(1).max(200),
		workspace: z.string().min(1).max(2048),
		createdAt: z.number().int().nonnegative().safe(),
	})
	.strict()
/** At most this many kept connections come back after a restart (newest first); the bound for live ones is 64. */
export const RESTORED_BINDINGS = 48
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export interface ReviewControlBackend {
	connect(command: Extract<ReviewCommand, { action: 'connect' }>): Promise<CallerBinding>
	/**
	 * After a restart: bring back the caller a kept connection belongs to, with the same id and owner and a fresh
	 * profile token, or null when it cannot come back (its state is gone, expired or unusable): a null retires the
	 * connection for good. 'later' leaves it on disk untouched (it belongs to a profile that is not active now).
	 * Absent on hosts that keep nothing; their connections never come back.
	 */
	restore?(record: CallerBindingRecord): Promise<CallerBinding | null | 'later'>
	current(binding: CallerBinding): boolean
	command(binding: CallerBinding, command: ReviewCallerCommand, signal: AbortSignal): Promise<unknown> | unknown
	/**
	 * Plain viewing (`helm open`): show each file read-only, without a caller. Every refusal is per file and names it.
	 * Absent on hosts that cannot show plain windows; the server then refuses `view` as a whole.
	 */
	view?(files: string[], signal: AbortSignal): Promise<ReviewViewResult>
	disconnect(binding: CallerBinding): void
	status(): { available: boolean }
}
interface Binding extends CallerBinding {
	/** sha256 of the binding token, compared in constant time; the token itself lives only in the CLI's file. */
	tokenHash: string
	/** The epoch this connection was made under: a restored connection keeps its own across restarts. */
	epoch: string
	file: string
	record: string
	operations: number
}
interface Identity {
	path: string
	dev: number
	ino: number
}
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
/** A name from an untrusted frame, safe for one log line and the CLI: ASCII word characters only, bounded. */
const frameName = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 40) || '?'
/**
 * Unknown actions and unknown fields are definite refusals (nothing ran), so a newer CLI can tell "this host does
 * not know that" from a failure after an effect. Older hosts answered both with the generic uncertain text.
 */
function parseEnvelope(bytes: Buffer) {
	const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	const command = (raw as { command?: { action?: unknown } } | null)?.command
	const action = command?.action
	if (typeof action === 'string' && !REVIEW_ACTIONS.has(action))
		// The reply names the caller's own command; the log line never repeats frame content.
		throw refuse(
			`Unknown review command "${frameName(action)}". Nothing was done; update the helm CLI and the Helm desktop to the same version.`,
			'malformed command (command.action unknown)',
		)
	if (action === 'connect') {
		const { features, session } = command as { features?: unknown; session?: unknown }
		if (Array.isArray(features))
			for (const feature of features)
				if (typeof feature === 'string' && !(REVIEW_CONNECT_FEATURES as readonly string[]).includes(feature))
					throw refuse(
						`Unknown connect feature "${frameName(feature)}". Nothing was done; update the helm CLI and the Helm desktop to the same version.`,
						'malformed command (connect feature unknown)',
					)
		if (session !== undefined && !(Array.isArray(features) && features.includes('session-hint')))
			throw refuse(
				'A session hint needs the session-hint connect feature. Nothing was done.',
				'malformed command (session without session-hint)',
			)
	}
	const parsed = envelopeSchema.safeParse(raw)
	if (parsed.success) return parsed.data
	for (const issue of parsed.error.issues)
		if (issue.code === 'unrecognized_keys' && issue.path[0] === 'command' && typeof action === 'string') {
			const keys = issue.keys.slice(0, 4).map(frameName).join(', ')
			throw refuse(
				`Unknown field ${keys} in review command "${frameName(action)}". Nothing was done; update the helm CLI and the Helm desktop to the same version.`,
				'malformed command (command unrecognized_keys)',
			)
		}
	throw parsed.error
}

/** Private desktop-only UDS. No daemon, provider process, terminal input, or session-file access. */
export class ReviewControlServer {
	readonly epoch = randomUUID()
	private readonly token = randomBytes(32).toString('hex')
	private readonly bindings = new Map<string, Binding>()
	private readonly sockets = new Set<Socket>()
	private readonly active = new Set<Promise<unknown>>()
	private readonly identities: Identity[] = []
	private server: Server | null = null
	private stopping = false
	private pendingConnections = 0
	/** Admission times of plain-view files in the last second, and the one view command allowed at a time. */
	private viewTimes: number[] = []
	private viewing = false
	constructor(
		readonly root: string,
		private readonly backend: ReviewControlBackend,
	) {}
	async start(): Promise<void> {
		const root = await privateDirectory(this.root)
		const socket = join(root, 'control.sock')
		if (Buffer.byteLength(socket) > 103) throw new Error('Review control socket path exceeds the local platform limit.')
		const lock = join(root, 'host.lock')
		// A dead PID is only stale-lock evidence, never authority to kill a process.
		try {
			const lockIdentity = await lstat(lock)
			const previous = await readPrivateJson(lock)
			const lockAfter = await lstat(lock)
			if (lockAfter.dev !== lockIdentity.dev || lockAfter.ino !== lockIdentity.ino)
				throw new Error('Review host lock changed; it was preserved.')
			const pid = (previous as { pid?: unknown }).pid
			if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new Error('Review host lock is unavailable.')
			try {
				process.kill(pid as number, 0)
				throw new Error(REVIEW_NAMESPACE_HELD)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
			}
			// Preserve substituted/unsafe artifacts. Only the same owner-private inode is reclaimed.
			for (const name of ['discovery.json', 'control.sock', 'host.lock']) {
				const path = join(root, name)
				// Another stale-cleanup contender may already have installed a live host.
				const stillLocked = await lstat(lock).catch(() => null)
				if (!stillLocked || stillLocked.dev !== lockIdentity.dev || stillLocked.ino !== lockIdentity.ino)
					throw new Error('Review host lock changed; remaining state was preserved.')
				try {
					const before = await lstat(path)
					if (
						before.isSymbolicLink() ||
						before.uid !== process.getuid?.() ||
						before.mode & 0o077 ||
						(!before.isFile() && !before.isSocket()) ||
						(before.isFile() && before.nlink !== 1)
					)
						throw new Error('Review stale state is unsafe; it was preserved.')
					const after = await lstat(path)
					if (after.dev !== before.dev || after.ino !== before.ino)
						throw new Error('Review stale state changed; it was preserved.')
					await unlink(path)
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		// Atomic singleton admission: a temp+rename publication could replace a simultaneous winner's lock.
		const lease = await open(
			lock,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		)
		try {
			const stat = await lease.stat()
			this.identities.push({ path: lock, dev: stat.dev, ino: stat.ino })
			await lease.writeFile(JSON.stringify({ epoch: this.epoch, pid: process.pid }))
			await lease.sync()
		} catch (error) {
			await this.stop()
			throw error
		} finally {
			await lease.close()
		}
		try {
			await this.restore(root)
			this.server = createServer(socket => this.accept(socket))
			await new Promise<void>((resolve, reject) => {
				const server = this.server as Server
				server.once('error', reject)
				server.listen(socket, () => {
					server.removeListener('error', reject)
					resolve()
				})
			})
			// Keep crash-recovery evidence owner-private as well as protecting the parent.
			await chmod(socket, 0o600)
			await this.capture(socket)
			const discovery = join(root, 'discovery.json')
			await writePrivateJson(discovery, { version: 1, epoch: this.epoch, socket, token: this.token })
			await this.capture(discovery)
		} catch (error) {
			await this.stop()
			throw error
		}
	}
	/**
	 * Bring back the connections a previous host kept (S13). Each needs its record AND the CLI's connection file
	 * with the same identity, epoch and token; the backend decides whether the caller itself can come back. Anything
	 * that does not come back is removed, as are connection files no record names (crashes, older desktops).
	 */
	private async restore(root: string): Promise<void> {
		await removeStrayTemps(root)
		const records: { uuid: string; record: CallerBindingRecord }[] = []
		const named = new Set<string>()
		for (const name of await privateNames(root, /^binding-[a-f0-9-]{36}\.json$/)) {
			// `binding-<key>` pairs with `connection-<key>`; the key is random, never the caller's id.
			const uuid = name.slice('binding-'.length, -'.json'.length)
			named.add(uuid)
			const parsed = bindingRecordSchema.safeParse(await readPrivateJson(join(root, name)).catch(() => null))
			if (parsed.success) records.push({ uuid, record: parsed.data })
			else await this.removeKept(root, uuid)
		}
		for (const name of await privateNames(root, /^connection-[a-f0-9-]{36}\.json$/))
			if (!named.has(name.slice('connection-'.length, -'.json'.length)))
				await removePrivateFile(join(root, name)).catch(() => {})
		records.sort((a, b) => b.record.createdAt - a.record.createdAt)
		const restored = new Set<string>()
		for (const [index, { uuid, record }] of records.entries()) {
			const file = join(root, `connection-${uuid}.json`)
			let binding: Binding | null = null
			let later = false
			try {
				const descriptor = connectionSchema.parse(await readPrivateJson(file))
				if (
					index < RESTORED_BINDINGS &&
					!restored.has(record.id) &&
					descriptor.id === record.id &&
					descriptor.owner === record.owner &&
					descriptor.epoch === record.epoch &&
					descriptor.socket === join(root, 'control.sock') &&
					equal(hashToken(descriptor.token), record.tokenHash)
				) {
					const owner = await this.backend.restore?.(record)
					if (owner === 'later') later = true
					else if (owner && owner.id === record.id && owner.owner === record.owner && this.backend.current(owner))
						binding = {
							...owner,
							tokenHash: record.tokenHash,
							epoch: record.epoch,
							file,
							record: join(root, `binding-${uuid}.json`),
							operations: 0,
						}
					else if (owner) this.backend.disconnect(owner)
				}
			} catch {
				binding = null
			}
			if (later) continue
			if (!binding) {
				await this.removeKept(root, uuid)
				continue
			}
			restored.add(binding.id)
			await this.capture(binding.file)
			await this.capture(binding.record)
			this.bindings.set(binding.id, binding)
		}
	}
	private async removeKept(root: string, uuid: string): Promise<void> {
		for (const name of [`connection-${uuid}.json`, `binding-${uuid}.json`])
			await removePrivateFile(join(root, name)).catch(() =>
				console.warn('[helm] review connection state retained after cleanup failure'),
			)
	}
	private async capture(path: string): Promise<void> {
		const stat = await lstat(path)
		this.identities.push({ path, dev: stat.dev, ino: stat.ino })
	}
	private accept(socket: Socket): void {
		if (this.stopping || this.sockets.size >= 64) {
			socket.destroy()
			return
		}
		this.sockets.add(socket)
		const abort = new AbortController()
		const chunks: Buffer[] = []
		let bytes = 0
		let admitted = false
		const timer = setTimeout(() => socket.destroy(), 2000)
		const fail = (message: string) => {
			if (!socket.destroyed) socket.end(`${JSON.stringify({ error: message })}\n`)
		}
		socket.on('error', () => {})
		socket.once('close', () => {
			clearTimeout(timer)
			this.sockets.delete(socket)
			abort.abort()
		})
		socket.on('data', chunk => {
			if (admitted) {
				socket.destroy()
				return
			}
			bytes += chunk.length
			if (bytes > REVIEW_WIRE_BYTES) {
				fail('Review command exceeds its byte limit.')
				return
			}
			chunks.push(chunk)
			if (!chunk.includes(10)) return
			admitted = true
			clearTimeout(timer)
			const data = Buffer.concat(chunks, bytes)
			chunks.length = 0
			if (data.indexOf(10) !== data.length - 1) {
				fail('Use one framed review command per connection.')
				return
			}
			const context = { action: 'unparsed' }
			const operation = this.handle(data.subarray(0, -1), abort.signal, context)
			this.active.add(operation)
			void operation
				.then(
					value => {
						if (abort.signal.aborted || socket.destroyed) return
						const encoded = Buffer.from(`${JSON.stringify({ data: value })}\n`)
						if (encoded.length > REVIEW_WIRE_BYTES) fail('Review response exceeds its byte limit.')
						else socket.end(encoded)
					},
					error => {
						// One diagnosable line per failure; never tokens, feedback or document text.
						const { reply, log } = describeReviewFailure(error)
						console.warn(`[helm] review: ${context.action} failed: ${log}`)
						fail(reply)
					},
				)
				.finally(() => this.active.delete(operation))
		})
	}
	private async handle(bytes: Buffer, signal: AbortSignal, context: { action: string }): Promise<unknown> {
		const message = parseEnvelope(bytes)
		context.action = message.command.action
		// A caller's connection outlives this host: tell it to come back rather than to start over.
		if (this.stopping)
			throw message.id ? restartingRefusal() : refuse('Helm is closing its review host. Nothing was done.')
		if (signal.aborted) throw refuse('The review command was cancelled before it ran.')
		const kept = message.id ? this.bindings.get(message.id) : undefined
		// Discovery frames are this host's own; a connection is checked against the epoch it was made under.
		if (message.epoch !== (kept ? kept.epoch : this.epoch))
			throw refuse(
				'Helm restarted its review host since this handle was made. Nothing was done; open the document again.',
			)
		if (!message.id) {
			if (message.owner || !equal(message.token, this.token))
				throw refuse('The review discovery token is not current. Nothing was done; connect again.')
			// Synchronous, effect-free and without a generic-error path: a new CLI must never mistake a transient
			// failure here for an old host and quietly downgrade.
			if (message.command.action === 'hello') return { protocol: REVIEW_PROTOCOL, features: [...REVIEW_FEATURES] }
			if (message.command.action === 'status') return { version: 1, epoch: this.epoch, ...this.backend.status() }
			if (message.command.action === 'view') return this.view(message.command.files, signal)
			if (message.command.action !== 'connect') throw refuse('Connect first; nothing was done.')
			for (const binding of this.bindings.values())
				if (binding.operations === 0 && !this.backend.current(binding)) await this.retire(binding)
			if (this.bindings.size + this.pendingConnections >= 64 || this.pendingConnections >= 8)
				throw refuse('Too many review connections are open. Disconnect unused ones; nothing was done.')
			this.pendingConnections++
			let owner: CallerBinding | null = null
			let published: Binding | null = null
			try {
				owner = await this.backend.connect(message.command)
				if (this.stopping || signal.aborted || !this.backend.current(owner))
					throw refuse('The active Helm profile changed while connecting. Nothing was opened; connect again.')
				const token = randomBytes(32).toString('hex')
				// One random key names the connection file and its record, so a restart can pair them.
				const uuid = randomUUID()
				const binding: Binding = {
					...owner,
					tokenHash: hashToken(token),
					epoch: this.epoch,
					file: join(this.root, `connection-${uuid}.json`),
					record: join(this.root, `binding-${uuid}.json`),
					operations: 0,
				}
				published = binding
				const descriptor: ReviewConnection = {
					version: 1,
					epoch: this.epoch,
					socket: join(this.root, 'control.sock'),
					id: owner.id,
					owner: owner.owner,
					token,
				}
				await writePrivateJson(binding.file, descriptor)
				await this.capture(binding.file)
				const record: CallerBindingRecord = {
					version: 1,
					id: owner.id,
					owner: owner.owner,
					epoch: this.epoch,
					tokenHash: binding.tokenHash,
					profileId: owner.profileId,
					workspace: owner.workspace,
					createdAt: Date.now(),
				}
				await writePrivateJson(binding.record, record)
				await this.capture(binding.record)
				if (this.stopping || signal.aborted || !this.backend.current(owner))
					throw refuse('The active Helm profile changed while connecting. Nothing was opened; connect again.')
				this.bindings.set(owner.id, binding)
				return { connection: binding.file, id: owner.id, owner: owner.owner }
			} catch (error) {
				if (owner) this.backend.disconnect(owner)
				if (published) await this.retire(published)
				throw error
			} finally {
				this.pendingConnections--
			}
		}
		const binding = kept
		if (
			!binding ||
			message.owner !== binding.owner ||
			!equal(hashToken(message.token), binding.tokenHash) ||
			message.command.action === 'connect' ||
			message.command.action === 'hello' ||
			message.command.action === 'view' ||
			!this.backend.current(binding)
		)
			throw refuse(
				'Review connection unavailable: it is no longer valid (Helm restarted, the profile changed, or it was disconnected). Nothing was done; open the document again.',
			)
		if (binding.operations >= 2) throw refuse('This connection already has two operations running. Nothing was done.')
		binding.operations++
		try {
			const value = await this.backend.command(binding, message.command as ReviewCallerCommand, signal)
			// Quitting while it ran: every caller command is safe to send again with the same connection (an offered
			// feedback goes again only to the same listener, acks and replies are idempotent).
			if (this.stopping && !signal.aborted) throw restartingRefusal()
			if (signal.aborted || (message.command.action !== 'disconnect' && !this.backend.current(binding)))
				throw new Error('Connection admission changed.')
			return value
		} finally {
			binding.operations--
			if (binding.operations === 0 && !this.backend.current(binding)) await this.retire(binding)
		}
	}
	/**
	 * Plain viewing. One view command at a time, and at most REVIEW_VIEW_RATE files per second for the whole host:
	 * files over the rate are refused by name (the CLI sends batches a second apart, so it never hits this).
	 */
	private async view(files: string[], signal: AbortSignal): Promise<ReviewViewResult> {
		const view = this.backend.view?.bind(this.backend)
		if (!view) throw refuse('This Helm desktop cannot show files with helm open. Nothing was opened.')
		if (this.viewing) throw refuse('Helm is still opening files from another helm open. Nothing was opened; try again.')
		const now = Date.now()
		this.viewTimes = this.viewTimes.filter(time => now - time < 1000)
		const budget = Math.max(0, REVIEW_VIEW_RATE - this.viewTimes.length)
		const admitted = files.slice(0, budget)
		const late = files.slice(budget).map(file => ({
			file,
			reason: `${basename(file)} was not opened: Helm opens at most ${REVIEW_VIEW_RATE} files per second. Open it again.`,
		}))
		for (const _file of admitted) this.viewTimes.push(now)
		if (!admitted.length) return { opened: [], refused: late }
		this.viewing = true
		try {
			const result = await view(admitted, signal)
			return { opened: result.opened, refused: [...result.refused, ...late] }
		} finally {
			this.viewing = false
		}
	}
	private async retire(binding: Binding): Promise<void> {
		if (this.bindings.get(binding.id) === binding) this.bindings.delete(binding.id)
		this.backend.disconnect(binding)
		for (const path of [binding.file, binding.record]) {
			const index = this.identities.findIndex(value => value.path === path)
			if (index < 0) continue
			const identity = this.identities.splice(index, 1)[0] as Identity
			try {
				const stat = await lstat(identity.path)
				if (stat.dev === identity.dev && stat.ino === identity.ino) await unlink(identity.path)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
					console.warn('[helm] review connection state retained after cleanup failure')
			}
		}
	}
	/**
	 * Stop listening (quit or restart). Live connections are KEPT: their connection files and records stay, so the
	 * next host brings them back (S13); the backend has already suspended its callers. Commands still running are
	 * cut off; a caller sends the same command again once Helm is back. Only retired connections were removed.
	 */
	async stop(): Promise<void> {
		if (this.stopping) return
		this.stopping = true
		// Commands still running answer first (a suspended backend refuses them as restarting), so the caller reads
		// "send it again", never a lost answer; only what does not settle within a second is cut off.
		await Promise.race([Promise.allSettled(this.active), new Promise(done => setTimeout(done, 1000).unref())])
		await Promise.race([
			Promise.all(
				[...this.sockets].map(
					socket => new Promise(done => (socket.destroyed ? done(null) : socket.once('close', done))),
				),
			),
			new Promise(done => setTimeout(done, 1000).unref()),
		])
		for (const socket of this.sockets) socket.destroy()
		await Promise.allSettled(this.active)
		if (this.server) await new Promise<void>(resolve => this.server?.close(() => resolve()))
		const kept = new Set([...this.bindings.values()].flatMap(binding => [binding.file, binding.record]))
		for (const identity of this.identities.reverse()) {
			if (kept.has(identity.path)) continue
			try {
				const stat = await lstat(identity.path)
				if (stat.dev === identity.dev && stat.ino === identity.ino) await unlink(identity.path)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
					console.warn('[helm] review control state retained after cleanup failure')
			}
		}
		this.bindings.clear()
	}
}
