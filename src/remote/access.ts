import { randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { createScopedCapability, hashScopedCapability, verifyScopedCapability } from '../auth/scoped-capability.js'
import { readOwnerPrivateFile } from './private-file.js'

const MAX_DEVICES = 128
export const REMOTE_DEVICE_DOCUMENT_BYTES = 128 * 1024
const deviceGrantSchema = z
	.object({
		// This is an explicit operator choice, never inferred from a native profile or cwd.
		personalCurrentAndFuture: z.boolean(),
		scopeIds: z.array(z.string().uuid()).max(64),
		operations: z
			.object({ read: z.boolean(), prompt: z.boolean(), interrupt: z.boolean(), answer: z.boolean() })
			.strict(),
	})
	.strict()
export type RemoteDeviceGrant = z.infer<typeof deviceGrantSchema>
const deviceSchema = z
	.object({
		id: z.string().uuid(),
		label: z.string().trim().min(1).max(80),
		credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
		createdAt: z.number().int().nonnegative().safe(),
		expiresAt: z.number().int().positive().safe(),
		revokedAt: z.number().int().nonnegative().safe().nullable(),
		grantRevision: z.number().int().positive().safe(),
		grant: deviceGrantSchema,
	})
	.strict()
const documentSchema = z.object({ version: z.literal(1), devices: z.array(deviceSchema).max(MAX_DEVICES) }).strict()
type Device = z.infer<typeof deviceSchema>
type DeviceDocument = z.infer<typeof documentSchema>
export interface RemotePrincipal {
	deviceId: string
	grantRevision: number
	grant: RemoteDeviceGrant
}
export interface RemotePairingPresentation {
	code: string
	qrCapability: string
	expiresAt: number
	grant: RemoteDeviceGrant
}
interface Challenge {
	code: string
	qrHash: string
	expiresAt: number
	failedGuesses: number
	burned: boolean
	label: string
	grant: RemoteDeviceGrant
}
export interface RemoteAccessOptions {
	/** Test seam for persistence-failure/retry behavior. */
	persist?: (path: string, content: string) => void
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** Pairing challenges are intentionally short-lived and never persisted. */
export const REMOTE_PAIRING_TTL_MS = 120_000

/** Private durable device ledger plus memory-only pairing challenges. */
export class RemoteAccess {
	private document: DeviceDocument
	private challenge: Challenge | null = null
	private dirtyRevocation = false
	private readonly revokeListeners = new Set<(deviceId: string, revision: number) => void>()

	constructor(
		private readonly path: string,
		private readonly now: () => number = Date.now,
		private readonly options: RemoteAccessOptions = {},
	) {
		this.ensurePrivateDirectory()
		this.document = this.readDocument()
	}

	createPairing(label: string, grant: RemoteDeviceGrant): RemotePairingPresentation {
		if (!/\S/.test(label) || label.length > 80) throw new Error('Invalid device label')
		const parsed = deviceGrantSchema.safeParse(grant)
		if (!parsed.success || !grant.operations.read) throw new Error('Invalid device grant')
		const code = Array.from({ length: 6 }, () => {
			const byte = randomBytes(1).at(0)
			if (byte === undefined) throw new Error('Random pairing code unavailable')
			return CROCKFORD[byte % CROCKFORD.length]
		}).join('')
		const qrCapability = createScopedCapability()
		const expiresAt = this.now() + REMOTE_PAIRING_TTL_MS
		this.challenge = {
			code,
			qrHash: hashScopedCapability(qrCapability),
			expiresAt,
			failedGuesses: 0,
			burned: false,
			label: label.trim(),
			grant: parsed.data,
		}
		return { code: `${code.slice(0, 3)}-${code.slice(3)}`, qrCapability, expiresAt, grant: parsed.data }
	}

	/** Code and QR redeem one challenge. It is burned before disk persistence can await/fail. */
	redeem(value: { code?: string; qrCapability?: string }): { credential: string; principal: RemotePrincipal } | null {
		const challenge = this.challenge
		if (!challenge || challenge.burned || challenge.expiresAt <= this.now()) {
			this.challenge = null
			return null
		}
		const code = value.code?.replace(/-/g, '').toUpperCase()
		const valid =
			(code !== undefined && code.length === 6 && code === challenge.code) ||
			(value.qrCapability !== undefined && verifyScopedCapability(value.qrCapability, challenge.qrHash))
		if (!valid) {
			challenge.failedGuesses++
			if (challenge.failedGuesses >= 5) challenge.burned = true
			return null
		}
		challenge.burned = true
		const credential = createScopedCapability()
		const device: Device = {
			id: randomUUID(),
			label: challenge.label,
			credentialHash: hashScopedCapability(credential),
			createdAt: this.now(),
			expiresAt: this.now() + DEVICE_TTL_MS,
			revokedAt: null,
			grantRevision: 1,
			grant: challenge.grant,
		}
		const prospective = { ...this.document, devices: [...this.document.devices, device] }
		if (!this.canAdmit(prospective)) return null
		try {
			this.writeDocument(prospective)
			this.document = prospective
			this.dirtyRevocation = false
		} catch {
			// Keep the trusted in-memory document: disk may predate an unpersisted
			// revocation. The burned challenge cannot be redeemed again.
			return null
		}
		return { credential, principal: principalFor(device) }
	}

	authenticate(credential: string | undefined): RemotePrincipal | null {
		if (!credential || credential.length !== 43) return null
		const device = this.document.devices.find(value => verifyScopedCapability(credential, value.credentialHash))
		return device && active(device, this.now()) ? principalFor(device) : null
	}

	principal(deviceId: string): RemotePrincipal | null {
		const device = this.document.devices.find(value => value.id === deviceId)
		return device && active(device, this.now()) ? principalFor(device) : null
	}

	allows(
		principal: RemotePrincipal,
		scopeId: string | null,
		operation: keyof RemoteDeviceGrant['operations'],
	): boolean {
		const current = this.principal(principal.deviceId)
		if (!current || current.grantRevision !== principal.grantRevision || !current.grant.operations[operation])
			return false
		return scopeId === null ? current.grant.personalCurrentAndFuture : current.grant.scopeIds.includes(scopeId)
	}

	list(): Array<Omit<Device, 'credentialHash'>> {
		return this.document.devices.map(({ credentialHash: _credentialHash, ...device }) => device)
	}

	revoke(deviceId: string): boolean {
		const index = this.document.devices.findIndex(device => device.id === deviceId)
		if (index < 0) return false
		const old = this.document.devices[index]
		if (!old) return false
		if (old.revokedAt !== null) {
			if (!this.dirtyRevocation) return true
			try {
				this.writeDocument(this.document)
				this.dirtyRevocation = false
				return true
			} catch {
				return false
			}
		}
		const device = { ...old, revokedAt: this.now(), grantRevision: old.grantRevision + 1 }
		const devices = [...this.document.devices]
		devices[index] = device
		this.document = { ...this.document, devices }
		// Fence memory and pending work even when the durable retry must happen later.
		for (const listener of this.revokeListeners) listener(device.id, device.grantRevision)
		try {
			this.writeDocument(this.document)
			this.dirtyRevocation = false
			return true
		} catch {
			this.dirtyRevocation = true
			return false
		}
	}

	onRevoke(listener: (deviceId: string, revision: number) => void): () => void {
		this.revokeListeners.add(listener)
		return () => this.revokeListeners.delete(listener)
	}

	private ensurePrivateDirectory(): void {
		const directory = dirname(this.path)
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		const directoryStat = lstatSync(directory)
		if (
			!directoryStat.isDirectory() ||
			directoryStat.isSymbolicLink() ||
			directoryStat.uid !== process.getuid?.() ||
			(directoryStat.mode & 0o777) !== 0o700
		)
			throw new Error('Remote access directory must be private')
	}

	private readDocument(): DeviceDocument {
		try {
			return documentSchema.parse(
				JSON.parse(readOwnerPrivateFile(this.path, REMOTE_DEVICE_DOCUMENT_BYTES, 'Remote device ledger')),
			)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, devices: [] }
			throw error
		}
	}

	private validDocument(document: DeviceDocument): boolean {
		return (
			documentSchema.safeParse(document).success &&
			Buffer.byteLength(`${JSON.stringify(document)}\n`) <= REMOTE_DEVICE_DOCUMENT_BYTES
		)
	}

	private canAdmit(document: DeviceDocument): boolean {
		// Replacing null with a timestamp grows the file. Admission must leave
		// enough space to revoke every device without exceeding the read bound.
		const revoked = {
			...document,
			devices: document.devices.map(device =>
				device.revokedAt === null
					? { ...device, revokedAt: Number.MAX_SAFE_INTEGER, grantRevision: device.grantRevision + 1 }
					: device,
			),
		}
		return this.validDocument(document) && this.validDocument(revoked)
	}

	private writeDocument(document: DeviceDocument): void {
		if (!this.validDocument(document)) throw new Error('Remote device ledger capacity exhausted')
		const directory = dirname(resolve(this.path))
		const temp = join(directory, `.devices-${randomUUID()}.tmp`)
		const content = `${JSON.stringify(document)}\n`
		try {
			if (this.options.persist) this.options.persist(temp, content)
			else writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
			renameSync(temp, this.path)
		} finally {
			try {
				unlinkSync(temp)
			} catch {
				/* atomically renamed */
			}
		}
	}
}

function active(device: Device, now: number): boolean {
	return device.revokedAt === null && device.expiresAt > now
}
function principalFor(device: Device): RemotePrincipal {
	return { deviceId: device.id, grantRevision: device.grantRevision, grant: device.grant }
}
