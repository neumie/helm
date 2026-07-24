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

test('attention adoption grants are exact-bound, replace prior grants, and burn before completion', () => {
	let now = 1_000
	const grants = new AttentionAdoptionGrantManager(ATTENTION_ADOPTION_GRANT_TTL_MS, () => now)
	const first = binding()
	const firstGrant = grants.issue(first)
	assert.equal(grants.hasRedeemed(first), false)
	assert.equal(grants.redeem({ ...first, revision: first.revision + 1 }, firstGrant.capability), false)
	assert.equal(grants.redeem(first, firstGrant.capability), true)
	assert.equal(grants.hasRedeemed(first), true)
	assert.equal(grants.redeem(first, firstGrant.capability), false, 'replay is burned')

	const replacement = binding()
	const replacementGrant = grants.issue(replacement)
	assert.equal(grants.hasRedeemed(first), false, 'issuance replaces prior binding')
	assert.equal(grants.redeem(first, replacementGrant.capability), false)
	assert.equal(grants.redeem(replacement, replacementGrant.capability), true)
	assert.equal(grants.revoke(first), false)
	assert.equal(grants.revoke(replacement), true)
	assert.equal(grants.hasRedeemed(replacement), false)

	const expiring = binding()
	const expiringGrant = grants.issue(expiring)
	now += ATTENTION_ADOPTION_GRANT_TTL_MS
	assert.equal(grants.redeem(expiring, expiringGrant.capability), false)
	grants.clear()
	assert.equal(grants.hasRedeemed(expiring), false)
})
