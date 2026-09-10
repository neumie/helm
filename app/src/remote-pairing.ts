import { homedir } from 'node:os'
import { join } from 'node:path'
import qrcode from 'qrcode-generator'
import { z } from 'zod'
import { REMOTE_PAIRING_TTL_MS } from '../../src/remote/access'
import { type RemoteControlResponse, remoteControlRequest } from '../../src/remote/control-client'
import { readOwnerPrivateFile } from '../../src/remote/private-file'

const RUNTIME_PROTOCOL = 1
const MAX_ORIGIN_LENGTH = 512
const DEFAULT_ROOT = join(homedir(), '.helm', 'remote')

const grantSchema = z
	.object({
		personalCurrentAndFuture: z.literal(true),
		scopeIds: z.array(z.string().uuid()).length(0),
		operations: z
			.object({ read: z.literal(true), prompt: z.literal(true), interrupt: z.literal(true), answer: z.literal(true) })
			.strict(),
	})
	.strict()
const deviceGrantSchema = z
	.object({
		personalCurrentAndFuture: z.boolean(),
		scopeIds: z.array(z.string().uuid()).max(64),
		operations: z
			.object({ read: z.boolean(), prompt: z.boolean(), interrupt: z.boolean(), answer: z.boolean() })
			.strict(),
	})
	.strict()
const deviceSchema = z
	.object({
		id: z.string().uuid(),
		label: z.string().trim().min(1).max(80),
		createdAt: z.number().int().nonnegative().safe(),
		expiresAt: z.number().int().positive().safe(),
		revokedAt: z.number().int().nonnegative().safe().nullable(),
		grantRevision: z.number().int().positive().safe(),
		grant: deviceGrantSchema,
	})
	.strict()
const statusSchema = z
	.object({
		protocol: z.literal(RUNTIME_PROTOCOL),
		build: z.string().min(1).max(256),
		hostEpoch: z.string().uuid(),
		config: z
			.object({
				protocol: z.literal(RUNTIME_PROTOCOL),
				build: z.string().min(1).max(256),
				origin: z.string().min(1).max(MAX_ORIGIN_LENGTH),
				port: z.number().int().min(0).max(65535),
				browserHost: z.literal('127.0.0.1'),
				piSessionRoots: z.array(z.string()).max(8),
			})
			.strict(),
		listeningPort: z.number().int().min(0).max(65535).optional(),
	})
	.strict()
const devicesSchema = z.object({ devices: z.array(deviceSchema).max(128) }).strict()
const pairingSchema = z
	.object({
		code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/),
		qrCapability: z.string().regex(/^[\w-]{43}$/),
		expiresAt: z.number().int().positive().safe(),
		grant: grantSchema,
	})
	.strict()

export type RemotePairingDeviceState = 'active' | 'expired' | 'revoked'
export interface RemotePairingDevice {
	id: string
	label: string
	createdAt: number
	expiresAt: number
	revokedAt: number | null
	state: RemotePairingDeviceState
}
export type RemotePairingSnapshot =
	| { availability: 'available'; origin: string; devices: RemotePairingDevice[] }
	| { availability: 'unavailable'; message: string }
export interface RemotePairingPresentation {
	code: string
	qrDataUrl: string
	expiresAt: number
	origin: string
}
export type RemotePairingMutationResult =
	| { kind: 'created'; presentation: RemotePairingPresentation }
	| { kind: 'cancelled' }
	| { kind: 'revoked' }
	| { kind: 'not-found' }

interface RemotePairingWindow {
	isDestroyed(): boolean
	webContents: { mainFrame: unknown }
}

/** Authenticate the actual native IPC event, including the current top frame. */
export function requireRemotePairingSender<T extends RemotePairingWindow>(
	event: { sender: unknown; senderFrame: unknown },
	profileToken: unknown,
	requireProfile: (token: unknown) => void,
	currentWindow: () => T | null,
): T {
	requireProfile(profileToken)
	const win = currentWindow()
	if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
		throw new Error('Remote pairing is unavailable.')
	return win
}

export interface RemotePairingControllerOptions {
	/** Main-only trusted test seam. The preload never supplies a root. */
	root?: string
	now?: () => number
	readToken?: (path: string) => string
	request?: (socketPath: string, token: string, path: string, body?: unknown) => Promise<RemoteControlResponse>
}

/**
 * Main-owned operator pairing authority. It speaks only the fixed private UDS
 * contract and projects deliberately safe device/presentation facts to IPC.
 */
export class RemotePairingController {
	private operation: Promise<void> | null = null
	private readonly root: string
	private readonly now: () => number
	private readonly readToken: (path: string) => string
	private readonly request: (
		socketPath: string,
		token: string,
		path: string,
		body?: unknown,
	) => Promise<RemoteControlResponse>

	constructor(options: RemotePairingControllerOptions = {}) {
		this.root = options.root ?? DEFAULT_ROOT
		this.now = options.now ?? Date.now
		this.readToken = options.readToken ?? readOperatorToken
		this.request = options.request ?? remoteControlRequest
	}

	async status(isCurrent: () => boolean): Promise<RemotePairingSnapshot> {
		this.requireCurrent(isCurrent)
		try {
			const token = this.readToken(join(this.root, 'operator-token'))
			this.requireCurrent(isCurrent)
			const response = await this.request(join(this.root, 'control.sock'), token, '/status')
			this.requireCurrent(isCurrent)
			const observation = response.status === 200 ? observationFromStatus(response.body) : null
			if (!observation) return unavailable()
			const devices = await this.devices(token, isCurrent)
			return { availability: 'available', origin: observation.origin, devices }
		} catch {
			// Transport/auth/config details can identify local infrastructure and are
			// not useful to the renderer. A retry is the only truthful recovery.
			return unavailable()
		}
	}

	async pair(
		label: unknown,
		isCurrent: () => boolean,
		confirm: () => Promise<boolean>,
	): Promise<RemotePairingMutationResult> {
		const normalizedLabel = validateLabel(label)
		return this.runExclusive(async () => {
			this.requireCurrent(isCurrent)
			const approved = await confirm()
			this.requireCurrent(isCurrent)
			if (!approved) return { kind: 'cancelled' }
			const token = this.readToken(join(this.root, 'operator-token'))
			this.requireCurrent(isCurrent)
			const status = await this.request(join(this.root, 'control.sock'), token, '/status')
			this.requireCurrent(isCurrent)
			const observed = status.status === 200 ? observationFromStatus(status.body) : null
			if (!observed) throw new Error('Helm Remote is unavailable.')
			const response = await this.request(join(this.root, 'control.sock'), token, '/pair', {
				label: normalizedLabel,
				grant: personalGrant(),
			})
			this.requireCurrent(isCurrent)
			if (response.status !== 201) throw new Error('Helm Remote could not create a pairing code.')
			const pairing = pairingSchema.safeParse(response.body)
			if (
				!pairing.success ||
				pairing.data.expiresAt <= this.now() ||
				pairing.data.expiresAt > this.now() + REMOTE_PAIRING_TTL_MS
			)
				throw new Error('Helm Remote returned an invalid pairing code.')
			const reattested = await this.request(join(this.root, 'control.sock'), token, '/status')
			this.requireCurrent(isCurrent)
			const current = reattested.status === 200 ? observationFromStatus(reattested.body) : null
			if (!current || current.origin !== observed.origin || current.hostEpoch !== observed.hostEpoch)
				throw new Error('Helm Remote changed while creating this pairing code.')
			return {
				kind: 'created',
				presentation: {
					code: pairing.data.code,
					qrDataUrl: pairingQrDataUrl(`${current.origin}/#pair=${pairing.data.qrCapability}`),
					expiresAt: pairing.data.expiresAt,
					origin: current.origin,
				},
			}
		})
	}

	async revoke(
		deviceId: unknown,
		isCurrent: () => boolean,
		confirm: () => Promise<boolean>,
	): Promise<RemotePairingMutationResult> {
		const id = z.string().uuid().safeParse(deviceId)
		if (!id.success) throw new Error('Invalid Remote device.')
		return this.runExclusive(async () => {
			this.requireCurrent(isCurrent)
			const approved = await confirm()
			this.requireCurrent(isCurrent)
			if (!approved) return { kind: 'cancelled' }
			const token = this.readToken(join(this.root, 'operator-token'))
			this.requireCurrent(isCurrent)
			const response = await this.request(join(this.root, 'control.sock'), token, `/devices/${id.data}/revoke`, {})
			this.requireCurrent(isCurrent)
			if (response.status === 404) return { kind: 'not-found' }
			if (response.status !== 200 || !isRevoked(response.body))
				throw new Error('Helm Remote could not revoke this device.')
			return { kind: 'revoked' }
		})
	}

	private async devices(token: string, isCurrent: () => boolean): Promise<RemotePairingDevice[]> {
		const response = await this.request(join(this.root, 'control.sock'), token, '/devices')
		this.requireCurrent(isCurrent)
		if (response.status !== 200) throw new Error('Remote devices unavailable')
		const parsed = devicesSchema.safeParse(response.body)
		if (!parsed.success) throw new Error('Invalid Remote devices')
		return parsed.data.devices.map(device => ({
			id: device.id,
			label: device.label,
			createdAt: device.createdAt,
			expiresAt: device.expiresAt,
			revokedAt: device.revokedAt,
			state: device.revokedAt !== null ? 'revoked' : device.expiresAt <= this.now() ? 'expired' : 'active',
		}))
	}

	private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		if (this.operation) throw new Error('A Remote device operation is already in progress.')
		let release: (() => void) | undefined
		this.operation = new Promise<void>(resolve => {
			release = resolve
		})
		try {
			return await operation()
		} finally {
			release?.()
			this.operation = null
		}
	}

	private requireCurrent(isCurrent: () => boolean): void {
		if (!isCurrent()) throw new Error('Remote pairing request is no longer current.')
	}
}

function readOperatorToken(path: string): string {
	const token = readOwnerPrivateFile(path, 128, 'Remote runtime operator token').trim()
	if (!/^[\w-]{43}$/.test(token)) throw new Error('Remote runtime operator token is invalid')
	return token
}

function validateLabel(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Enter a device name.')
	const label = value.trim()
	if (label.length < 1 || label.length > 80) throw new Error('Device names must be 1 to 80 characters.')
	return label
}

function personalGrant() {
	return {
		personalCurrentAndFuture: true,
		scopeIds: [],
		operations: { read: true, prompt: true, interrupt: true, answer: true },
	} as const
}

function observationFromStatus(value: unknown): { hostEpoch: string; origin: string } | null {
	const parsed = statusSchema.safeParse(value)
	if (!parsed.success || !strictHttpsOrigin(parsed.data.config.origin)) return null
	return { hostEpoch: parsed.data.hostEpoch, origin: parsed.data.config.origin }
}

function strictHttpsOrigin(value: string): boolean {
	try {
		const url = new URL(value)
		return (
			url.protocol === 'https:' &&
			url.origin === value &&
			url.hostname.length > 0 &&
			url.username === '' &&
			url.password === '' &&
			url.pathname === '/' &&
			url.search === '' &&
			url.hash === ''
		)
	} catch {
		return false
	}
}

function pairingQrDataUrl(value: string): string {
	const qr = qrcode(0, 'M')
	qr.addData(value, 'Byte')
	qr.make()
	const dataUrl = qr.createDataURL(4, 16)
	if (!dataUrl.startsWith('data:image/gif;base64,') || dataUrl.length > 128 * 1024)
		throw new Error('Pairing QR is invalid')
	return dataUrl
}

function isRevoked(value: unknown): boolean {
	return (
		!!value &&
		typeof value === 'object' &&
		Object.keys(value).length === 1 &&
		(value as { revoked?: unknown }).revoked === true
	)
}

function unavailable(): RemotePairingSnapshot {
	return { availability: 'unavailable', message: 'Helm Remote is unavailable. Retry when its local runtime is online.' }
}
