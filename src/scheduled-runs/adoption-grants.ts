import { createScopedCapability, hashScopedCapability, verifyScopedCapability } from '../auth/scoped-capability.js'

export const ATTENTION_ADOPTION_GRANT_TTL_MS = 30_000

/** Exact durable identity the transient Electron capability is bound to. */
export interface AttentionAdoptionGrantBinding {
	profileId: string
	runId: string
	revision: number
	adoptionId: string
	adopter: string
}

export interface AttentionAdoptionGrant {
	capability: string
	expiresAt: number
}

type StoredGrant = AttentionAdoptionGrantBinding & {
	hash: string | null
	expiresAt: number
	redeemed: boolean
}

/**
 * Memory-only capabilities for the future Electron adoption bridge. Issuing a
 * new grant replaces the old one; redeeming burns its bearer hash synchronously
 * before any caller can await durable registration.
 */
export class AttentionAdoptionGrantManager {
	private grant: StoredGrant | null = null

	constructor(
		private readonly ttlMs = ATTENTION_ADOPTION_GRANT_TTL_MS,
		private readonly now: () => number = Date.now,
	) {}

	issue(binding: AttentionAdoptionGrantBinding): AttentionAdoptionGrant {
		const capability = createScopedCapability()
		const expiresAt = this.now() + this.ttlMs
		this.grant = { ...binding, hash: hashScopedCapability(capability), expiresAt, redeemed: false }
		return { capability, expiresAt }
	}

	/** Burn the bearer capability before a caller can await Electron registration. */
	redeem(binding: AttentionAdoptionGrantBinding, capability: string): boolean {
		if (!this.matches(binding)) return false
		const grant = this.grant
		if (!grant || grant.hash === null || !verifyScopedCapability(capability, grant.hash)) return false
		grant.hash = null
		grant.redeemed = true
		return true
	}

	/** Completion is permitted only after a matching grant was redeemed. */
	hasRedeemed(binding: AttentionAdoptionGrantBinding): boolean {
		return this.matches(binding) && this.grant?.redeemed === true
	}

	revoke(binding: AttentionAdoptionGrantBinding): boolean {
		if (!this.matches(binding)) return false
		this.grant = null
		return true
	}

	clear(): void {
		this.grant = null
	}

	private matches(binding: AttentionAdoptionGrantBinding): boolean {
		this.clearExpired()
		const grant = this.grant
		return (
			grant !== null &&
			grant.profileId === binding.profileId &&
			grant.runId === binding.runId &&
			grant.revision === binding.revision &&
			grant.adoptionId === binding.adoptionId &&
			grant.adopter === binding.adopter
		)
	}

	private clearExpired(): void {
		if (this.grant && this.grant.expiresAt <= this.now()) this.grant = null
	}
}
