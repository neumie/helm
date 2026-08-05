import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { KnowledgeIntegration } from '../src/knowledge/integration.js'
import { KnowledgeOutboxDrainer } from '../src/knowledge/outbox-drainer.js'
import { type KnowledgeProvider, KnowledgeProviderError, KnowledgeProviderRegistry } from '../src/knowledge/provider.js'

function sha256(value: string) {
	return createHash('sha256').update(value).digest('hex')
}

class DeliveryProvider implements KnowledgeProvider {
	readonly id = 'delivery-provider'
	readonly type = 'fake'
	readonly protocolVersion = 1
	readonly submissions: Array<Parameters<KnowledgeProvider['submitCandidates']>[0]> = []
	failures: KnowledgeProviderError[] = []

	async prepareBrief(): Promise<never> {
		throw new Error('not used')
	}

	async submitCandidates(input: Parameters<KnowledgeProvider['submitCandidates']>[0]) {
		this.submissions.push(input)
		const failure = this.failures.shift()
		if (failure) throw failure
		return {
			receiptRef: `receipt-${input.idempotencyKey.slice(0, 12)}`,
			candidateRefs: input.candidates.map((_, index) => `candidate-${index}`),
			recordRef: 'record-1',
			jobRef: 'job-1',
			acceptedAt: '2030-01-01T00:00:00.000Z',
			replayed: this.submissions.length > 1,
		}
	}
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'helm-knowledge-outbox-'))
	const db = new DB(join(root, 'helm.db'), 'work')
	const config = configSchema.parse({
		provider: {
			type: 'contember',
			apiBaseUrl: 'https://example.test',
			projectSlug: 'test',
			apiToken: 'test',
		},
		projects: [{ slug: 'sample-project', repoPath: root, baseBranch: 'main' }],
		knowledge: {
			providers: [
				{
					id: 'delivery-provider',
					type: 'hold',
					socketPath: join(root, 'hold.sock'),
					capabilityFile: join(root, 'hold.capability'),
				},
			],
		},
	})
	const provider = new DeliveryProvider()
	const integration = new KnowledgeIntegration(
		config,
		profileId => ({
			id: profileId,
			name: 'Test',
			createdAt: '2030-01-01T00:00:00.000Z',
			enabledProjects: ['sample-project'],
			knowledgeBindings: [],
			archivedAt: null,
		}),
		new KnowledgeProviderRegistry([provider]),
	)
	return {
		root,
		db,
		provider,
		integration,
		cleanup() {
			db.close()
			rmSync(root, { recursive: true, force: true })
		},
	}
}

function enqueue(db: DB, profileId = 'work', providerProjectId = 'hold-project-original') {
	return db.forProfile(profileId).knowledge.enqueueCandidateBatch({
		itemId: `item-${profileId}`,
		projectSlug: 'sample-project',
		snapshotId: null,
		binding: {
			bindingId: sha256(`${profileId}:binding`),
			providerId: 'delivery-provider',
			providerProjectId,
		},
		candidates: [{ type: 'lesson', title: 'Durable retry', content: 'Retry with the same key.' }],
	})
}

test('candidate delivery retries an ambiguous timeout with the same frozen target and key', async () => {
	const env = fixture()
	let now = new Date('2030-01-01T00:00:00.000Z')
	const entry = enqueue(env.db)
	env.provider.failures.push(new KnowledgeProviderError('timeout', 'Provider timed out', true, true))
	const drainer = new KnowledgeOutboxDrainer(env.db, env.integration, () => ['work'], {
		sweepIntervalMs: 1_000_000,
		now: () => now,
	})
	try {
		drainer.start()
		const first = await drainer.runSweep()
		assert.deepEqual(first, { claimed: 1, delivered: 0, retried: 1, blocked: 0 })
		const pending = env.db.knowledge.listCandidateBatches(entry.itemId)[0]
		assert.equal(pending.state, 'pending')
		assert.equal(pending.attemptCount, 1)

		now = new Date('2030-01-01T02:00:00.000Z')
		const second = await drainer.runSweep()
		assert.deepEqual(second, { claimed: 1, delivered: 1, retried: 0, blocked: 0 })
		const delivered = env.db.knowledge.listCandidateBatches(entry.itemId)[0]
		assert.equal(delivered.state, 'delivered')
		assert.equal(env.provider.submissions.length, 2)
		assert.equal(env.provider.submissions[0].idempotencyKey, env.provider.submissions[1].idempotencyKey)
		assert.equal(env.provider.submissions[1].providerProjectId, 'hold-project-original')
	} finally {
		await drainer.stop()
		env.cleanup()
	}
})

test('delivery recovers an expired lease and blocks permanent authorization failures', async () => {
	const env = fixture()
	const leased = enqueue(env.db)
	env.db.knowledge.claimCandidateBatches(1, '2030-01-01T00:00:00.000Z', 'dead-owner', '2030-01-01T00:01:00.000Z')
	env.provider.failures.push(new KnowledgeProviderError('authorization', 'Authorization failed', false))
	const drainer = new KnowledgeOutboxDrainer(env.db, env.integration, () => ['work'], {
		sweepIntervalMs: 1_000_000,
		now: () => new Date('2030-01-01T00:02:00.000Z'),
	})
	try {
		drainer.start()
		const result = await drainer.runSweep()
		assert.deepEqual(result, { claimed: 1, delivered: 0, retried: 0, blocked: 1 })
		const blocked = env.db.knowledge.listCandidateBatches(leased.itemId)[0]
		assert.equal(blocked.state, 'blocked')
		assert.equal(blocked.lastErrorCode, 'authorization')
		assert.equal(blocked.leaseOwner, null)

		assert.equal(
			env.db.knowledge.retryBlockedCandidateBatch(leased.id, leased.itemId, '2030-01-01T00:02:00.000Z'),
			true,
		)
		assert.equal(env.db.knowledge.listCandidateBatches(leased.itemId)[0]?.state, 'pending')
		assert.equal((await drainer.runSweep()).delivered, 1)
		assert.equal(env.db.knowledge.listCandidateBatches(leased.itemId)[0]?.state, 'delivered')
	} finally {
		await drainer.stop()
		env.cleanup()
	}
})

test('one sweep services distinct profiles without crossing profile-owned rows', async () => {
	const env = fixture()
	const secondProfile = 'profile-aaaaaaaaaaaa'
	enqueue(env.db, 'work', 'hold-work')
	enqueue(env.db, secondProfile, 'hold-private')
	const drainer = new KnowledgeOutboxDrainer(env.db, env.integration, () => ['work', secondProfile], {
		sweepIntervalMs: 1_000_000,
		now: () => new Date('2030-01-01T00:00:00.000Z'),
	})
	try {
		drainer.start()
		const result = await drainer.runSweep()
		assert.deepEqual(result, { claimed: 2, delivered: 2, retried: 0, blocked: 0 })
		assert.equal(env.db.knowledge.listCandidateBatches('item-work')[0].state, 'delivered')
		assert.equal(
			env.db.forProfile(secondProfile).knowledge.listCandidateBatches(`item-${secondProfile}`)[0].state,
			'delivered',
		)
		assert.deepEqual(env.provider.submissions.map(submission => submission.providerProjectId).sort(), [
			'hold-private',
			'hold-work',
		])
	} finally {
		await drainer.stop()
		env.cleanup()
	}
})
