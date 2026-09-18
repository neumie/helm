import { randomUUID } from 'node:crypto'
import {
	constants,
	chmodSync,
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import qrcode from 'qrcode-generator'
import { createScopedCapability, hashScopedCapability, verifyScopedCapability } from '../auth/scoped-capability.js'
import { HELM_BUILD_ID } from '../build-id.generated.js'
import { RemoteAccess, type RemoteDeviceGrant } from './access.js'
import { PiSessionCatalog } from './catalog.js'
import { remoteControlRequest } from './control-client.js'
import { createRemoteAssets } from './development.js'
import { RemoteFavorites } from './favorites.js'
import { RemoteHost } from './host.js'
import { readOwnerPrivateFile } from './private-file.js'
import { remoteRegistrationRequestSchema, remoteSourceConfirmationSchema } from './protocol.js'
import { RemoteUsage } from './usage.js'

const RUNTIME_PROTOCOL = 1
const RUNTIME_BUILD = HELM_BUILD_ID
const ENROLLMENT_GRANT_TTL_MS = 30_000
const DEFAULT_GRANT: RemoteDeviceGrant = {
	personalCurrentAndFuture: true,
	scopeIds: [],
	operations: { read: true, prompt: true, interrupt: true, answer: true },
}

interface RuntimeConfiguration {
	protocol: number
	build: string
	origin: string
	port: number
	browserHost: '127.0.0.1'
	piSessionRoots: string[]
}
interface RuntimeStatus {
	protocol: number
	build: string
	hostEpoch: string
	config: RuntimeConfiguration
	listeningPort: number | undefined
}
interface FileIdentity {
	dev: number
	ino: number
}

export interface RemoteRuntimeOptions {
	root?: string
	origin: string
	assetsDirectory: string
	port?: number
	piSessionRoots?: string[]
	now?: () => number
	/** Deterministic lifecycle seam for owned-file race tests; never a browser API. */
	lifecycle?: {
		afterDiscoveryPublished?: () => void | Promise<void>
		beforeDiscoveryCleanup?: () => void | Promise<void>
	}
}
export interface RemoteRuntime {
	reused: boolean
	origin: string
	port?: number
	root: string
	stop(): Promise<void>
}
interface PersistentRuntimeSetup {
	origin: string
	piSessionRoots: string[]
}
const RUNTIME_SETUP_FILE = 'runtime-setup.json'
const MAX_RUNTIME_ROOTS = 8
const MAX_RUNTIME_SETUP_BYTES = 8192
const MAX_RUNTIME_LOCK_BYTES = 4096

/**
 * Persistent everyday host. The loopback listener is deliberately not a TLS/proxy
 * installer: configured HTTPS origin names the approved external boundary only.
 */
export async function startRemoteRuntime(options: RemoteRuntimeOptions): Promise<RemoteRuntime> {
	const root = privateDirectory(options.root ?? join(homedir(), '.helm', 'remote'))
	const config = runtimeConfiguration(options)
	const lockPath = join(root, 'runtime.lock')
	const instanceId = randomUUID()
	const lockDocument = { protocol: RUNTIME_PROTOCOL, build: RUNTIME_BUILD, instanceId }
	assertEncodedBytes(lockDocument, MAX_RUNTIME_LOCK_BYTES, 'Remote runtime lock')
	let ownsLock = false
	let lockIdentity: FileIdentity | undefined
	try {
		const lock = openSync(
			lockPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		)
		ownsLock = true
		try {
			lockIdentity = privateDescriptorIdentity(lock, 'Remote runtime lock')
			writeFileSync(lock, JSON.stringify(lockDocument), 'utf8')
		} finally {
			closeSync(lock)
		}
	} catch (error) {
		// Initial write can fail before JSON ownership evidence is complete. The exact
		// descriptor identity is enough for this invocation's failure cleanup.
		if (ownsLock && lockIdentity) unlinkOwnedPrivateFile(lockPath, lockIdentity)
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		const operatorToken = readOperatorToken(join(root, 'operator-token'))
		const response = await controlRequest(join(root, 'control.sock'), operatorToken, '/status')
		if (isCompatibleRuntimeStatus(response, config))
			return {
				reused: true,
				origin: response.config.origin,
				port: response.listeningPort,
				root,
				stop: async () => {},
			}
		throw new Error('Remote runtime lock exists but no compatible authenticated host answered; refuse to replace it')
	}

	let browser: ReturnType<typeof createServer> | undefined
	let bridge: ReturnType<typeof createServer> | undefined
	let control: ReturnType<typeof createServer> | undefined
	let catalog: PiSessionCatalog | undefined
	let discoveryIdentity: FileIdentity | undefined
	const sockets = new Map<string, FileIdentity>()
	try {
		// All initialization after ownership is covered: corrupt ledgers and missing assets never strand this lock.
		const operatorToken = ensurePrivateToken(join(root, 'operator-token'))
		// This capability can mint only short-lived per-context bridge grants over the
		// owner-private control socket; it deliberately cannot pair, list or revoke.
		const registrationToken = ensurePrivateToken(join(root, 'bridge-registration-token'))
		const access = new RemoteAccess(join(root, 'devices.json'), options.now)
		catalog = new PiSessionCatalog(config.piSessionRoots)
		await catalog.refresh()
		catalog.start()
		let favorites: RemoteFavorites | undefined
		try {
			favorites = new RemoteFavorites(join(realpathSync(root), 'favorites.json'))
		} catch {
			console.warn('Remote favorites unavailable; saved preferences were left untouched.')
		}
		const usage = new RemoteUsage({ now: options.now })
		const host = new RemoteHost({ origin: config.origin, access, catalog, favorites, usage, now: options.now })
		const assets = createRemoteAssets(options.assetsDirectory)
		browser = createServer(
			{ maxHeaderSize: 8192 },
			getRequestListener((input, env) => assets(input) ?? host.browser.fetch(input, env)),
		)
		bridge = createServer(
			{ maxHeaderSize: 8192 },
			getRequestListener((input, env) => host.local.fetch(input, env)),
		)
		control = controlServer({
			root,
			host,
			access,
			catalog,
			operatorToken,
			registrationToken,
			now: options.now ?? Date.now,
			config,
			listeningPort: () => listeningPort(browser),
		})
		for (const server of [browser, bridge, control]) configureServer(server)
		await listen(browser, config.port, config.browserHost)
		await listen(bridge, join(root, 'host.sock'))
		sockets.set(join(root, 'host.sock'), socketIdentity(join(root, 'host.sock')))
		await listen(control, join(root, 'control.sock'))
		sockets.set(join(root, 'control.sock'), socketIdentity(join(root, 'control.sock')))
		const discoveryPath = join(root, 'bridge-registration.json')
		const discovery = { protocol: 1, capability: registrationToken, socketPath: join(root, 'control.sock') }
		assertEncodedBytes(discovery, 1024, 'Remote registration discovery')
		discoveryIdentity = writePrivate(discoveryPath, JSON.stringify(discovery))
		await options.lifecycle?.afterDiscoveryPublished?.()
		chmodSocket(join(root, 'host.sock'))
		chmodSocket(join(root, 'control.sock'))
		const activeServers: Array<ReturnType<typeof createServer>> = [browser, bridge, control]
		return {
			reused: false,
			origin: config.origin,
			port: listeningPort(browser),
			root,
			async stop() {
				host.revoke()
				for (const server of activeServers) server.closeAllConnections()
				await Promise.all(activeServers.map(close))
				await catalog?.stop()
				for (const [path, identity] of sockets) unlinkOwnedSocket(path, identity)
				await options.lifecycle?.beforeDiscoveryCleanup?.()
				if (discoveryIdentity) unlinkOwnedPrivateFile(join(root, 'bridge-registration.json'), discoveryIdentity)
				if (lockIdentity) unlinkOwnedLock(lockPath, lockIdentity, instanceId)
			},
		}
	} catch (error) {
		for (const server of [browser, bridge, control]) server?.closeAllConnections()
		await Promise.all(
			[browser, bridge, control].filter((server): server is ReturnType<typeof createServer> => !!server).map(close),
		)
		for (const [path, identity] of sockets) unlinkOwnedSocket(path, identity)
		await catalog?.stop()
		if (discoveryIdentity) unlinkOwnedPrivateFile(join(root, 'bridge-registration.json'), discoveryIdentity)
		if (ownsLock && lockIdentity) unlinkOwnedLock(lockPath, lockIdentity, instanceId)
		throw error
	}
}

/** Persist the approved public origin and explicit Pi roots once; this does not configure any network service. */
export function configureRemoteRuntime(input: { root?: string; origin: string; piSessionRoots?: string[] }): {
	root: string
	origin: string
	piSessionRoots: string[]
} {
	const root = privateDirectory(input.root ?? join(homedir(), '.helm', 'remote'))
	const config = runtimeConfiguration(input)
	const setup = validatedRuntimeSetup({ origin: config.origin, piSessionRoots: config.piSessionRoots })
	writePrivate(join(root, RUNTIME_SETUP_FILE), JSON.stringify(setup))
	return { root, ...setup }
}
export function readRemoteRuntimeSetup(root: string): PersistentRuntimeSetup | null {
	try {
		const value = JSON.parse(
			readPrivate(join(root, RUNTIME_SETUP_FILE), MAX_RUNTIME_SETUP_BYTES),
		) as Partial<PersistentRuntimeSetup>
		return validatedRuntimeSetup(value)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw new Error('Remote runtime setup is invalid')
	}
}
function validatedRuntimeSetup(value: Partial<PersistentRuntimeSetup>): PersistentRuntimeSetup {
	if (!value || typeof value.origin !== 'string' || !Array.isArray(value.piSessionRoots)) throw new Error('invalid')
	const piSessionRoots = value.piSessionRoots.map(item => {
		if (typeof item !== 'string') throw new Error('invalid')
		return resolve(item)
	})
	const setup = { origin: strictHttpsOrigin(value.origin), piSessionRoots: [...new Set(piSessionRoots)].sort() }
	if (setup.piSessionRoots.length > MAX_RUNTIME_ROOTS) throw new Error('invalid')
	assertEncodedBytes(setup, MAX_RUNTIME_SETUP_BYTES, 'Remote runtime setup')
	return setup
}
function runtimeConfiguration(
	options: Pick<RemoteRuntimeOptions, 'origin' | 'port' | 'piSessionRoots'>,
): RuntimeConfiguration {
	const port = options.port ?? Number(process.env.HELM_REMOTE_PORT ?? 9784)
	if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Remote loopback port is invalid')
	const setup = validatedRuntimeSetup({
		origin: options.origin,
		piSessionRoots: options.piSessionRoots ?? [join(homedir(), '.pi', 'agent', 'sessions')],
	})
	return {
		protocol: RUNTIME_PROTOCOL,
		build: RUNTIME_BUILD,
		origin: setup.origin,
		port,
		browserHost: '127.0.0.1',
		piSessionRoots: setup.piSessionRoots,
	}
}
function configureServer(server: ReturnType<typeof createServer>): void {
	server.maxConnections = 64
	server.requestTimeout = 6000
	server.headersTimeout = 6000
	server.on('upgrade', (_request, socket) =>
		socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'),
	)
}
function controlServer(input: {
	root: string
	host: RemoteHost
	access: RemoteAccess
	catalog: PiSessionCatalog
	operatorToken: string
	registrationToken: string
	now: () => number
	config: RuntimeConfiguration
	listeningPort: () => number | undefined
}) {
	const app = new Hono()
	app.use('*', async (c, next) => {
		const registration = c.req.path === '/bridge-register'
		if (
			c.req.header('Origin') ||
			c.req.header('Upgrade') ||
			!(registration
				? matchesOperator(c.req.header('Authorization'), input.registrationToken)
				: matchesOperator(c.req.header('Authorization'), input.operatorToken))
		)
			return c.json({ error: 'unauthorized' }, 401)
		if (c.req.method === 'POST' && c.req.header('Content-Type') !== 'application/json')
			return c.json({ error: 'json_required' }, 415)
		await next()
	})
	app.use('*', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'payload_too_large' }, 413) }))
	app.post('/bridge-register', async c => {
		const parsed = remoteRegistrationRequestSchema.safeParse(await c.req.json().catch(() => null))
		if (!parsed.success) return c.json({ error: 'invalid_registration' }, 400)
		const { sessionId } = parsed.data
		try {
			const enrollmentId = randomUUID()
			const capability = createScopedCapability()
			input.host.issueEnrollment({
				id: enrollmentId,
				capabilityHash: hashScopedCapability(capability),
				scopeId: null,
				// Pi lifecycle fences are local only. Personal Remote authorization is
				// a stable null scope/generation, while each grant binds this UUID.
				generation: 1,
				sessionId,
				expiresAt: input.now() + ENROLLMENT_GRANT_TTL_MS,
			})
			return c.json(
				{
					protocol: 1,
					enrollmentId,
					capability,
					scopeId: null,
					generation: 1,
					socketPath: join(input.root, 'host.sock'),
				},
				201,
			)
		} catch {
			return c.json({ error: 'enrollment_unavailable' }, 409)
		}
	})
	app.get('/status', c =>
		c.json({
			protocol: RUNTIME_PROTOCOL,
			build: RUNTIME_BUILD,
			hostEpoch: input.host.epoch,
			config: input.config,
			listeningPort: input.listeningPort(),
		}),
	)
	// Operator repair only. This control-socket inventory intentionally excludes
	// browser/session content and never accepts the bridge registration token.
	app.get('/source-candidates', c => c.json(input.host.sourceCandidates()))
	app.post('/source-candidates/confirm', async c => {
		const parsed = remoteSourceConfirmationSchema.safeParse(await c.req.json().catch(() => null))
		if (!parsed.success) return c.json({ error: 'invalid_source_confirmation' }, 400)
		const result = input.host.confirmSource(parsed.data)
		if (!result.ok) return c.json({ error: result.error }, 409)
		return c.json(result.candidate)
	})
	app.post('/pair', async c => {
		const value = await c.req.json().catch(() => null)
		if (!value || typeof value !== 'object') return c.json({ error: 'invalid_pairing' }, 400)
		try {
			const pairing = input.access.createPairing(
				typeof (value as { label?: unknown }).label === 'string' ? (value as { label: string }).label : '',
				(value as { grant?: RemoteDeviceGrant }).grant ?? DEFAULT_GRANT,
			)
			return c.json(pairing, 201)
		} catch {
			return c.json({ error: 'invalid_pairing' }, 400)
		}
	})
	app.get('/devices', c => c.json({ devices: input.access.list() }))
	app.post('/devices/:id/revoke', c => {
		const id = c.req.param('id')
		if (!input.access.list().some(device => device.id === id)) return c.json({ error: 'not_found' }, 404)
		return input.access.revoke(id) ? c.json({ revoked: true }) : c.json({ error: 'revocation_persistence_failed' }, 503)
	})
	app.post('/catalog/refresh', async c => {
		await input.catalog.refresh()
		return c.json({ refreshed: true })
	})
	app.post('/enrollments', async c => {
		const value = await c.req.json().catch(() => null)
		if (!value || typeof value !== 'object') return c.json({ error: 'invalid_enrollment' }, 400)
		const scopeId = (value as { scopeId?: unknown }).scopeId
		const generation = (value as { generation?: unknown }).generation
		if (
			!(scopeId === null || (typeof scopeId === 'string' && /^[0-9a-f-]{36}$/i.test(scopeId))) ||
			!Number.isSafeInteger(generation) ||
			(generation as number) < 1
		)
			return c.json({ error: 'invalid_enrollment' }, 400)
		try {
			const enrollmentId = randomUUID()
			const capability = createScopedCapability()
			input.host.issueEnrollment({
				id: enrollmentId,
				capabilityHash: hashScopedCapability(capability),
				scopeId,
				generation: generation as number,
			})
			const path = join(input.root, `enroll-${enrollmentId}.json`)
			writePrivate(
				path,
				JSON.stringify({
					protocol: 1,
					enrollmentId,
					capability,
					scopeId,
					generation,
					socketPath: join(input.root, 'host.sock'),
				}),
			)
			return c.json({ enrollmentFile: path }, 201)
		} catch {
			return c.json({ error: 'enrollment_unavailable' }, 409)
		}
	})
	app.all('*', c => c.json({ error: 'not_found' }, 404))
	return createServer(
		{ maxHeaderSize: 8192 },
		getRequestListener((request, env) => app.fetch(request, env)),
	)
}

function strictHttpsOrigin(value: string): string {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('HELM_REMOTE_ORIGIN must be an explicit HTTPS origin')
	}
	if (
		url.protocol !== 'https:' ||
		url.origin !== value ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	)
		throw new Error('HELM_REMOTE_ORIGIN must be an explicit HTTPS origin')
	return value
}
function privateDirectory(path: string): string {
	const absolute = resolve(path)
	mkdirSync(absolute, { recursive: true, mode: 0o700 })
	const stat = lstatSync(absolute)
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
		throw new Error('Remote runtime directory must be owner-private and not a symlink')
	return absolute
}
function ensurePrivateToken(path: string): string {
	try {
		return readOperatorToken(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		const token = createScopedCapability()
		writePrivate(path, token)
		return token
	}
}
function readPrivate(path: string, max: number): string {
	return readOwnerPrivateFile(path, max, 'Remote runtime private file')
}
function readOperatorToken(path: string): string {
	const token = readPrivate(path, 128).trim()
	if (!/^[\w-]{43}$/.test(token)) throw new Error('Remote runtime operator token is invalid')
	return token
}
function writePrivate(path: string, content: string): FileIdentity {
	const directory = dirname(path)
	const temporary = join(directory, `.${randomUUID()}.tmp`)
	let identity: FileIdentity | undefined
	let fd: number | undefined
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
		identity = privateDescriptorIdentity(fd, 'Remote private file')
		writeFileSync(fd, content, 'utf8')
		closeSync(fd)
		fd = undefined
		renameSync(temporary, path)
		return identity
	} finally {
		if (fd !== undefined) closeSync(fd)
		// A failed rename leaves only our temp identity eligible for cleanup. Never
		// unlink a replacement that won the temporary pathname after a failure.
		if (identity) unlinkOwnedPrivateFile(temporary, identity)
	}
}
function chmodSocket(path: string): void {
	try {
		const stat = lstatSync(path)
		if (!stat.isSocket()) throw new Error('Remote socket missing')
		chmodSync(path, 0o600)
	} catch {
		throw new Error('Remote socket permissions unavailable')
	}
}
function socketIdentity(path: string): FileIdentity {
	const stat = lstatSync(path)
	if (!stat.isSocket()) throw new Error('Remote socket missing')
	return { dev: stat.dev, ino: stat.ino }
}
function unlinkOwnedSocket(path: string, expected: FileIdentity): void {
	try {
		const stat = lstatSync(path)
		if (stat.isSocket() && stat.dev === expected.dev && stat.ino === expected.ino) unlinkSync(path)
	} catch {
		/* listener cleanup or another identity owns this path */
	}
}
function assertEncodedBytes(value: unknown, maximum: number, label: string): void {
	if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) throw new Error(`${label} is too large`)
}
function privateDescriptorIdentity(fd: number, label: string): FileIdentity {
	const stat = fstatSync(fd)
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o777) !== 0o600
	)
		throw new Error(`${label} ownership is invalid`)
	return { dev: stat.dev, ino: stat.ino }
}
function unlinkOwnedPrivateFile(path: string, expected: FileIdentity): void {
	try {
		const stat = lstatSync(path)
		if (
			stat.isFile() &&
			!stat.isSymbolicLink() &&
			stat.nlink === 1 &&
			stat.uid === process.getuid?.() &&
			(stat.mode & 0o777) === 0o600 &&
			stat.dev === expected.dev &&
			stat.ino === expected.ino
		)
			unlinkSync(path)
	} catch {
		/* another identity owns this pathname */
	}
}
function unlinkOwnedLock(path: string, expected: FileIdentity, instanceId: string): void {
	try {
		const stat = lstatSync(path)
		if (stat.dev !== expected.dev || stat.ino !== expected.ino) return
		const value = JSON.parse(readPrivate(path, MAX_RUNTIME_LOCK_BYTES)) as { instanceId?: unknown }
		if (value.instanceId === instanceId) unlinkSync(path)
	} catch {
		/* never unlink another instance's ownership evidence */
	}
}
function listen(server: ReturnType<typeof createServer>, address: string | number, host?: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		server.once('error', reject)
		if (typeof address === 'string') server.listen(address, () => resolvePromise())
		else server.listen(address, host, () => resolvePromise())
	})
}
function close(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise(resolvePromise => server.close(() => resolvePromise()))
}
function listeningPort(server: ReturnType<typeof createServer> | undefined): number | undefined {
	const address = server?.address()
	return typeof address === 'object' && address ? address.port : undefined
}
function isCompatibleRuntimeStatus(value: unknown, expected: RuntimeConfiguration): value is RuntimeStatus {
	if (!value || typeof value !== 'object') return false
	const status = value as Partial<RuntimeStatus>
	return (
		status.protocol === expected.protocol &&
		status.build === expected.build &&
		!!status.config &&
		JSON.stringify(status.config) === JSON.stringify(expected)
	)
}
function matchesOperator(header: string | undefined, token: string): boolean {
	return (
		!!header && header.startsWith('Bearer ') && verifyScopedCapability(header.slice(7), hashScopedCapability(token))
	)
}
/** Renders a real QR matrix for an intentional local TTY; it is never logged by the service listener. */
export function renderPairingQr(value: string): string {
	const qr = qrcode(0, 'M')
	qr.addData(value, 'Byte')
	qr.make()
	const quiet = 2
	const size = qr.getModuleCount()
	const line = (row: number) =>
		Array.from({ length: size + quiet * 2 }, (_, column) => {
			const y = row - quiet
			const x = column - quiet
			return y >= 0 && y < size && x >= 0 && x < size && qr.isDark(y, x) ? '██' : '  '
		}).join('')
	return Array.from({ length: size + quiet * 2 }, (_, row) => line(row)).join('\n')
}

function parseRuntimeSetupArgs(args: string[]): { origin: string; piSessionRoots?: string[] } {
	let origin: string | undefined
	const piSessionRoots: string[] = []
	for (let index = 0; index < args.length; index++) {
		const value = args[index]
		if (value === '--origin') {
			origin = args[++index]
			continue
		}
		if (value === '--pi-root') {
			const root = args[++index]
			if (root) piSessionRoots.push(root)
			continue
		}
		throw new Error('Usage: remote/bun run setup --origin https://approved.example [--pi-root ~/.pi/agent/sessions]')
	}
	if (!origin) throw new Error('Setup requires an explicit HTTPS --origin')
	return { origin, piSessionRoots: piSessionRoots.length > 0 ? piSessionRoots : undefined }
}

/** Backward-compatible successful-response helper used by the runtime and CLI. */
export async function controlRequest(
	socketPath: string,
	token: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	const response = await remoteControlRequest(socketPath, token, path, body)
	if (response.status !== 200 && response.status !== 201) throw new Error('Remote control refused')
	return response.body
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const root = privateDirectory(process.env.HELM_REMOTE_ROOT ?? join(homedir(), '.helm', 'remote'))
	if (process.argv[2] === 'setup') {
		// Setup is an explicit repair operation: do not parse a malformed prior
		// document before validating and atomically replacing it.
		const configured = configureRemoteRuntime({ root, ...parseRuntimeSetupArgs(process.argv.slice(3)) })
		console.log(
			`Helm Remote setup saved for ${configured.origin} with ${configured.piSessionRoots.length} Pi session root(s). No TLS, proxy, Tailscale, or Pi settings were changed.`,
		)
	} else {
		const setup = readRemoteRuntimeSetup(root)
		if (process.argv[2] === 'pair') {
			if (!process.stdout.isTTY) throw new Error('Pairing secrets are displayed only in an intentional local TTY')
			const origin = strictHttpsOrigin(process.env.HELM_REMOTE_ORIGIN ?? setup?.origin ?? '')
			const result = await controlRequest(
				join(root, 'control.sock'),
				readOperatorToken(join(root, 'operator-token')),
				'/pair',
				{ label: process.argv.slice(3).join(' ').trim() || 'Browser device', grant: DEFAULT_GRANT },
			)
			if (!result || typeof result !== 'object' || typeof (result as { code?: unknown }).code !== 'string')
				throw new Error('Remote pairing did not return a challenge')
			const pairing = result as { code: string; qrCapability?: string; expiresAt: number }
			const pairingUrl = `${origin}/#pair=${pairing.qrCapability}`
			console.log(
				`Pairing code: ${pairing.code}\nThis device receives personal Remote authority: read, prompt, interrupt, and answer for current and future personal Pi conversations. It lasts 90 days unless revoked locally.\nScan this one-time QR code or enter the code above; the fragment is consumed on use and must not be shared.\n${renderPairingQr(pairingUrl)}\nPairing URL (one-time fragment): ${pairingUrl}\nExpires: ${new Date(pairing.expiresAt).toLocaleTimeString()}`,
			)
			process.exitCode = 0
		} else {
			const origin = process.env.HELM_REMOTE_ORIGIN ?? setup?.origin
			if (!origin)
				throw new Error(
					'Run `remote/bun run setup --origin https://approved.example --pi-root ~/.pi/agent/sessions` once before starting Remote; this does not deploy one.',
				)
			const assets = fileURLToPath(new URL('../../app/remote-dist', import.meta.url))
			const configuredRoots = process.env.HELM_REMOTE_PI_ROOTS
			const runtime = await startRemoteRuntime({
				root,
				origin,
				assetsDirectory: assets,
				piSessionRoots: configuredRoots ? configuredRoots.split(',').filter(Boolean) : setup?.piSessionRoots,
			})
			if (runtime.reused) console.log('Helm Remote is already running with a compatible authenticated runtime.')
			else
				console.log(
					`Helm Remote ready on loopback port ${runtime.port}. Public origin configured as ${runtime.origin}; no proxy was installed.`,
				)
			process.send?.({ type: 'helm-remote-ready', reused: runtime.reused })
			let stopping = false
			const stop = () => {
				if (!stopping) {
					stopping = true
					void runtime.stop()
				}
			}
			process.once('SIGINT', stop)
			process.once('SIGTERM', stop)
		}
	}
}
