import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
	ATTENTION_ADOPTION_GRANT_TTL_MS,
	AttentionAdoptionGrantManager,
} from '../src/scheduled-runs/adoption-grants.js'

function binding() {
	return {
		profileId: 'alpha',
		runId: randomUUID(),
		revision: 3,
		adoptionId: randomUUID(),
		adopter: randomUUID(),
	}
}

test('attention adoption grants are independent, exact-bound, replaceable before redemption, and burn on redeem', () => {
	let now = 1_000
	const grants = new AttentionAdoptionGrantManager(ATTENTION_ADOPTION_GRANT_TTL_MS, () => now)
	const first = binding()
	const firstGrant = grants.issue(first)
	const replacementGrant = grants.issue(first)
	assert.equal(grants.redeem(first, firstGrant.capability), false, 'same-binding replacement revokes the old bearer')
	assert.equal(grants.redeem({ ...first, revision: first.revision + 1 }, replacementGrant.capability), false)
	assert.equal(grants.redeem(first, replacementGrant.capability), true)
	assert.equal(grants.hasRedeemed(first), true)
	assert.equal(grants.redeem(first, replacementGrant.capability), false, 'replay is burned')
	assert.throws(() => grants.issue(first), /awaiting completion/)

	const second = binding()
	const secondGrant = grants.issue(second)
	assert.equal(grants.hasRedeemed(first), true, 'another reservation cannot replace a redeemed marker')
	assert.equal(grants.redeem(second, secondGrant.capability), true)
	assert.equal(grants.hasRedeemed(second), true)

	now += ATTENTION_ADOPTION_GRANT_TTL_MS
	assert.equal(grants.hasRedeemed(first), true, 'completion authorization survives bearer TTL')
	assert.equal(grants.hasRedeemed(second), true)
	assert.equal(grants.revoke(first), true)
	assert.equal(grants.hasRedeemed(first), false)
	assert.equal(grants.hasRedeemed(second), true)

	const expiring = binding()
	const expiringGrant = grants.issue(expiring)
	now += ATTENTION_ADOPTION_GRANT_TTL_MS
	assert.equal(grants.redeem(expiring, expiringGrant.capability), false)
	grants.clear()
	assert.equal(grants.hasRedeemed(second), false)
})
