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

function bindingKey(binding: AttentionAdoptionGrantBinding): string {
	return [binding.profileId, binding.runId, binding.revision, binding.adoptionId, binding.adopter].join('\u0000')
}

/**
 * Memory-only capabilities for the Electron adoption bridge. Each reservation
 * owns an independent slot. Redeeming burns bearer authority synchronously;
 * its completion marker then survives bearer TTL until complete/rollback/stop
 * explicitly revokes it.
 */
export class AttentionAdoptionGrantManager {
	private readonly grants = new Map<string, StoredGrant>()

	constructor(
		private readonly ttlMs = ATTENTION_ADOPTION_GRANT_TTL_MS,
		private readonly now: () => number = Date.now,
	) {}

	issue(binding: AttentionAdoptionGrantBinding): AttentionAdoptionGrant {
		const key = bindingKey(binding)
		if (this.grants.has(key)) throw new Error('Attention adoption grant is already active')
		const capability = createScopedCapability()
		const expiresAt = this.now() + this.ttlMs
		this.grants.set(key, { ...binding, hash: hashScopedCapability(capability), expiresAt, redeemed: false })
		return { capability, expiresAt }
	}

	/** Burn the bearer capability before a caller can await Electron registration. */
	redeem(binding: AttentionAdoptionGrantBinding, capability: string): boolean {
		const grant = this.matching(binding)
		if (!grant || grant.redeemed || grant.hash === null || !verifyScopedCapability(capability, grant.hash)) return false
		grant.hash = null
		grant.redeemed = true
		return true
	}

	hasActive(binding: AttentionAdoptionGrantBinding): boolean {
		return this.matching(binding) !== null
	}

	/** Distinguishes this process's expired grant from a pre-restart durable reservation. */
	wasIssued(binding: AttentionAdoptionGrantBinding): boolean {
		return this.grants.has(bindingKey(binding))
	}

	/** Completion remains permitted after bearer expiry once redemption succeeded. */
	hasRedeemed(binding: AttentionAdoptionGrantBinding): boolean {
		return this.matching(binding)?.redeemed === true
	}

	revoke(binding: AttentionAdoptionGrantBinding): boolean {
		return this.grants.delete(bindingKey(binding))
	}

	clear(): void {
		this.grants.clear()
	}

	private matching(binding: AttentionAdoptionGrantBinding): StoredGrant | null {
		const key = bindingKey(binding)
		const grant = this.grants.get(key)
		if (!grant) return null
		if (!grant.redeemed && grant.expiresAt <= this.now()) return null
		return grant
	}
}
