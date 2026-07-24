import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const SCOPED_CAPABILITY_BYTES = 32
export const scopedCapabilityDigestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest')
export const RESIDENT_LEASE_TTL_MS = 45_000

export interface ResidentLease {
	capability: string
	expiresAt: number
}

/** A random, bearer-style capability suitable for one narrowly scoped operation. */
export function createScopedCapability(): string {
	return randomBytes(SCOPED_CAPABILITY_BYTES).toString('base64url')
}

/** Store this digest instead of a report or resident-lease capability. */
export function hashScopedCapability(capability: string): string {
	return createHash('sha256').update(capability).digest('hex')
}

/** Compares a supplied capability to its stored SHA-256 digest in constant time. */
export function verifyScopedCapability(capability: string, expectedHash: string): boolean {
	if (!isCapabilityDigest(expectedHash)) return false
	const actual = Buffer.from(hashScopedCapability(capability), 'hex')
	const expected = Buffer.from(expectedHash, 'hex')
	return timingSafeEqual(actual, expected)
}

/**
 * Holds exactly one short-lived Electron resident-admission lease in memory.
 * Issuing a lease replaces any prior one; only the current holder can renew or
 * revoke it, and expiry is enforced without a timer.
 */
export class ResidentLeaseManager {
	private lease: { hash: string; expiresAt: number } | null = null

	constructor(
		private readonly ttlMs = RESIDENT_LEASE_TTL_MS,
		private readonly now: () => number = Date.now,
	) {}

	issue(): ResidentLease {
		const capability = createScopedCapability()
		const expiresAt = this.now() + this.ttlMs
		this.lease = { hash: hashScopedCapability(capability), expiresAt }
		return { capability, expiresAt }
	}

	heartbeat(capability: string): ResidentLease | null {
		if (!this.matchesCurrent(capability)) return null
		const expiresAt = this.now() + this.ttlMs
		this.lease = { hash: hashScopedCapability(capability), expiresAt }
		return { capability, expiresAt }
	}

	revoke(capability: string): boolean {
		if (!this.matchesCurrent(capability)) return false
		this.lease = null
		return true
	}

	isActive(): boolean {
		this.clearExpired()
		return this.lease !== null
	}

	/** Verify current ownership without extending the lease. */
	isHeld(capability: string): boolean {
		return this.matchesCurrent(capability)
	}

	private matchesCurrent(capability: string): boolean {
		this.clearExpired()
		return this.lease !== null && verifyScopedCapability(capability, this.lease.hash)
	}

	private clearExpired(): void {
		if (this.lease && this.lease.expiresAt <= this.now()) this.lease = null
	}
}

function isCapabilityDigest(value: string): boolean {
	return scopedCapabilityDigestSchema.safeParse(value).success
}
