import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
	type AgentKnowledgeCandidate,
	type KnowledgeCandidateOutboxEntry,
	type KnowledgeDeliveryReceipt,
	type KnowledgePurpose,
	type KnowledgeSnapshot,
	type KnowledgeSnapshotProvider,
	type KnowledgeSource,
	agentKnowledgeCandidatesSchema,
	knowledgeCandidateOutboxEntrySchema,
	knowledgeDeliveryReceiptSchema,
	knowledgeSnapshotSchema,
	knowledgeSourceSchema,
} from './schema.js'

function parseJson(value: unknown, field: string): unknown {
	if (typeof value !== 'string') throw new Error(`Knowledge evidence row ${field} is not JSON`)
	try {
		return JSON.parse(value)
	} catch {
		throw new Error(`Knowledge evidence row ${field} is invalid JSON`)
	}
}

function candidateIdempotencyKey(input: {
	profileId: string
	itemId: string
	projectSlug: string
	snapshotId: string | null
	bindingId: string
	providerId: string
	providerProjectId: string
	candidates: AgentKnowledgeCandidate[]
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				profileId: input.profileId,
				itemId: input.itemId,
				projectSlug: input.projectSlug,
				snapshotId: input.snapshotId,
				bindingId: input.bindingId,
				providerId: input.providerId,
				providerProjectId: input.providerProjectId,
				candidates: input.candidates,
			}),
		)
		.digest('hex')
}

export interface FrozenKnowledgeBinding {
	bindingId: string
	providerId: string
	providerProjectId: string
}

/** Profile-bound immutable evidence and delivery-only candidate outbox. */
export class KnowledgeStore {
	constructor(
		private readonly db: Database.Database,
		private readonly profile: string | (() => string) = 'work',
	) {}

	private get profileId(): string {
		return typeof this.profile === 'function' ? this.profile() : this.profile
	}

	private transaction<T>(operation: () => T): T {
		return this.db.transaction(operation)()
	}

	createSnapshot(input: {
		itemId: string
		projectSlug: string
		purpose: KnowledgePurpose
		query: string
		characterBudget: number
		context: string
		manifest: KnowledgeSource[]
		provider: KnowledgeSnapshotProvider
	}): KnowledgeSnapshot {
		return this.transaction(() => {
			const sequenceRow = this.db
				.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
					FROM item_knowledge_snapshots WHERE profile_id = ? AND item_id = ? AND purpose = ?`)
				.get(this.profileId, input.itemId, input.purpose) as { sequence: number }
			const snapshot = knowledgeSnapshotSchema.parse({
				id: randomUUID(),
				profileId: this.profileId,
				itemId: input.itemId,
				projectSlug: input.projectSlug,
				purpose: input.purpose,
				sequence: sequenceRow.sequence,
				query: input.query,
				characterBudget: input.characterBudget,
				context: input.context,
				manifest: input.manifest,
				provider: input.provider,
				createdAt: new Date().toISOString(),
			})
			this.db
				.prepare(`INSERT INTO item_knowledge_snapshots (
					id, profile_id, item_id, project_slug, purpose, sequence, query,
					character_budget, context, manifest, binding_id, provider_id,
					provider_type, provider_project_id, provider_brief_ref,
					provider_revision, provider_created_at, context_hash,
					provider_protocol_version, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(
					snapshot.id,
					snapshot.profileId,
					snapshot.itemId,
					snapshot.projectSlug,
					snapshot.purpose,
					snapshot.sequence,
					snapshot.query,
					snapshot.characterBudget,
					snapshot.context,
					JSON.stringify(snapshot.manifest),
					snapshot.provider?.bindingId,
					snapshot.provider?.providerId,
					snapshot.provider?.providerType,
					snapshot.provider?.providerProjectId,
					snapshot.provider?.briefRef,
					snapshot.provider?.revision,
					snapshot.provider?.generatedAt,
					snapshot.provider?.contextHash,
					snapshot.provider?.protocolVersion,
					snapshot.createdAt,
				)
			return snapshot
		})
	}

	snapshotForItem(snapshotId: string, itemId: string): KnowledgeSnapshot | null {
		const row = this.db
			.prepare('SELECT * FROM item_knowledge_snapshots WHERE id = ? AND profile_id = ? AND item_id = ?')
			.get(snapshotId, this.profileId, itemId) as Record<string, unknown> | undefined
		return row ? this.toSnapshot(row) : null
	}

	latestSnapshot(itemId: string): KnowledgeSnapshot | null {
		const row = this.db
			.prepare(`SELECT * FROM item_knowledge_snapshots
				WHERE profile_id = ? AND item_id = ?
				ORDER BY created_at DESC, sequence DESC, id DESC LIMIT 1`)
			.get(this.profileId, itemId) as Record<string, unknown> | undefined
		return row ? this.toSnapshot(row) : null
	}

	getSnapshot(id: string): KnowledgeSnapshot | null {
		const row = this.db
			.prepare('SELECT * FROM item_knowledge_snapshots WHERE profile_id = ? AND id = ?')
			.get(this.profileId, id) as Record<string, unknown> | undefined
		return row ? this.toSnapshot(row) : null
	}

	enqueueCandidateBatch(input: {
		itemId: string
		projectSlug: string
		snapshotId: string | null
		binding: FrozenKnowledgeBinding
		candidates: AgentKnowledgeCandidate[]
	}): KnowledgeCandidateOutboxEntry {
		const candidates = agentKnowledgeCandidatesSchema.parse(input.candidates)
		if (candidates.length === 0) throw new Error('Knowledge candidate batch is empty')
		if (input.snapshotId) {
			const snapshot = this.getSnapshot(input.snapshotId)
			if (
				!snapshot ||
				snapshot.itemId !== input.itemId ||
				snapshot.projectSlug !== input.projectSlug ||
				snapshot.provider?.bindingId !== input.binding.bindingId
			) {
				throw new Error('Knowledge snapshot not found for candidate batch')
			}
		}
		const idempotencyKey = candidateIdempotencyKey({
			profileId: this.profileId,
			itemId: input.itemId,
			projectSlug: input.projectSlug,
			snapshotId: input.snapshotId,
			bindingId: input.binding.bindingId,
			providerId: input.binding.providerId,
			providerProjectId: input.binding.providerProjectId,
			candidates,
		})
		const now = new Date().toISOString()
		this.db
			.prepare(`INSERT OR IGNORE INTO knowledge_candidate_outbox (
				id, profile_id, item_id, project_slug, snapshot_id, binding_id,
				provider_id, provider_project_id, idempotency_key, candidates,
				state, attempt_count, next_attempt_at, lease_owner, lease_expires_at,
				last_error_code, last_error, receipt, created_at, updated_at, delivered_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`)
			.run(
				randomUUID(),
				this.profileId,
				input.itemId,
				input.projectSlug,
				input.snapshotId,
				input.binding.bindingId,
				input.binding.providerId,
				input.binding.providerProjectId,
				idempotencyKey,
				JSON.stringify(candidates),
				now,
				now,
			)
		const entry = this.getCandidateBatchByKey(idempotencyKey)
		if (!entry) throw new Error('Knowledge candidate batch was not persisted')
		return entry
	}

	listCandidateBatches(itemId: string, limit = 20): KnowledgeCandidateOutboxEntry[] {
		return (
			this.db
				.prepare(`SELECT * FROM knowledge_candidate_outbox
					WHERE profile_id = ? AND item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
				.all(this.profileId, itemId, limit) as Record<string, unknown>[]
		).map(row => this.toCandidateBatch(row))
	}

	listPendingCandidateBatches(limit = 50, now = new Date().toISOString()): KnowledgeCandidateOutboxEntry[] {
		return (
			this.db
				.prepare(`SELECT * FROM knowledge_candidate_outbox
					WHERE profile_id = ? AND state = 'pending'
					AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
					ORDER BY created_at ASC, id ASC LIMIT ?`)
				.all(this.profileId, now, limit) as Record<string, unknown>[]
		).map(row => this.toCandidateBatch(row))
	}

	retryBlockedCandidateBatch(outboxId: string, itemId: string, now = new Date().toISOString()): boolean {
		const result = this.db
			.prepare(
				`UPDATE knowledge_candidate_outbox
				 SET state = 'pending', next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
				     last_error_code = NULL, last_error = NULL, updated_at = ?
				 WHERE id = ? AND item_id = ? AND profile_id = ? AND state = 'blocked'
				   AND provider_id IS NOT NULL AND provider_project_id IS NOT NULL AND binding_id IS NOT NULL`,
			)
			.run(now, now, outboxId, itemId, this.profileId)
		return result.changes === 1
	}

	recoverExpiredDeliveryLeases(now: string): number {
		return this.db
			.prepare(`UPDATE knowledge_candidate_outbox
				SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
				WHERE profile_id = ? AND state = 'delivering' AND lease_expires_at <= ?`)
			.run(now, this.profileId, now).changes
	}

	releaseDeliveryLeases(owner: string, now: string): number {
		return this.db
			.prepare(`UPDATE knowledge_candidate_outbox
				SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
				WHERE profile_id = ? AND state = 'delivering' AND lease_owner = ?`)
			.run(now, this.profileId, owner).changes
	}

	claimCandidateBatches(
		limit: number,
		now: string,
		owner: string,
		leaseExpiresAt: string,
	): KnowledgeCandidateOutboxEntry[] {
		return this.transaction(() => {
			const ids = this.db
				.prepare(`SELECT id FROM knowledge_candidate_outbox
					WHERE profile_id = ? AND state = 'pending'
					AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
					ORDER BY created_at ASC, id ASC LIMIT ?`)
				.all(this.profileId, now, limit) as Array<{ id: string }>
			const claim = this.db.prepare(`UPDATE knowledge_candidate_outbox
				SET state = 'delivering', lease_owner = ?, lease_expires_at = ?, updated_at = ?
				WHERE profile_id = ? AND id = ? AND state = 'pending'`)
			const claimed: KnowledgeCandidateOutboxEntry[] = []
			for (const { id } of ids) {
				if (claim.run(owner, leaseExpiresAt, now, this.profileId, id).changes === 1) {
					claimed.push(this.requireCandidateBatch(id))
				}
			}
			return claimed
		})
	}

	recordCandidateDeliveryFailure(
		id: string,
		owner: string,
		errorCode: string,
		error: string,
		nextAttemptAt: string,
	): KnowledgeCandidateOutboxEntry {
		const result = this.db
			.prepare(`UPDATE knowledge_candidate_outbox
				SET state = 'pending', attempt_count = attempt_count + 1, next_attempt_at = ?,
					lease_owner = NULL, lease_expires_at = NULL,
					last_error_code = ?, last_error = ?, updated_at = ?
				WHERE profile_id = ? AND id = ? AND state = 'delivering' AND lease_owner = ?`)
			.run(
				nextAttemptAt,
				errorCode.slice(0, 100),
				error.slice(0, 1_000),
				new Date().toISOString(),
				this.profileId,
				id,
				owner,
			)
		if (result.changes === 0) throw new Error('Pending knowledge candidate batch not found')
		return this.requireCandidateBatch(id)
	}

	markCandidateBatchBlocked(
		id: string,
		owner: string,
		errorCode: string,
		error: string,
	): KnowledgeCandidateOutboxEntry {
		const result = this.db
			.prepare(`UPDATE knowledge_candidate_outbox
				SET state = 'blocked', next_attempt_at = NULL, lease_owner = NULL,
					lease_expires_at = NULL, last_error_code = ?, last_error = ?, updated_at = ?
				WHERE profile_id = ? AND id = ? AND state = 'delivering' AND lease_owner = ?`)
			.run(errorCode.slice(0, 100), error.slice(0, 1_000), new Date().toISOString(), this.profileId, id, owner)
		if (result.changes === 0) throw new Error('Pending knowledge candidate batch not found')
		return this.requireCandidateBatch(id)
	}

	markCandidateBatchDelivered(
		id: string,
		owner: string,
		receiptInput: KnowledgeDeliveryReceipt,
	): KnowledgeCandidateOutboxEntry {
		const receipt = knowledgeDeliveryReceiptSchema.parse(receiptInput)
		const receiptJson = JSON.stringify(receipt)
		const now = new Date().toISOString()
		const result = this.db
			.prepare(`UPDATE knowledge_candidate_outbox
				SET state = 'delivered', receipt = ?, last_error_code = NULL,
					last_error = NULL, next_attempt_at = NULL, lease_owner = NULL,
					lease_expires_at = NULL, updated_at = ?, delivered_at = ?
				WHERE profile_id = ? AND id = ? AND state = 'delivering' AND lease_owner = ?`)
			.run(receiptJson, now, now, this.profileId, id, owner)
		if (result.changes === 0) {
			const current = this.requireCandidateBatch(id)
			if (current.state === 'delivered' && JSON.stringify(current.receipt) === receiptJson) return current
			throw new Error('Knowledge candidate batch delivery conflict')
		}
		return this.requireCandidateBatch(id)
	}

	private getCandidateBatchByKey(idempotencyKey: string): KnowledgeCandidateOutboxEntry | null {
		const row = this.db
			.prepare('SELECT * FROM knowledge_candidate_outbox WHERE profile_id = ? AND idempotency_key = ?')
			.get(this.profileId, idempotencyKey) as Record<string, unknown> | undefined
		return row ? this.toCandidateBatch(row) : null
	}

	private requireCandidateBatch(id: string): KnowledgeCandidateOutboxEntry {
		const row = this.db
			.prepare('SELECT * FROM knowledge_candidate_outbox WHERE profile_id = ? AND id = ?')
			.get(this.profileId, id) as Record<string, unknown> | undefined
		if (!row) throw new Error('Knowledge candidate batch not found')
		return this.toCandidateBatch(row)
	}

	private toSnapshot(row: Record<string, unknown>): KnowledgeSnapshot {
		const provider =
			typeof row.provider_id === 'string'
				? {
						bindingId: row.binding_id,
						providerId: row.provider_id,
						providerType: row.provider_type,
						providerProjectId: row.provider_project_id,
						briefRef: row.provider_brief_ref,
						revision: row.provider_revision,
						generatedAt: row.provider_created_at,
						contextHash: row.context_hash,
						protocolVersion: row.provider_protocol_version,
					}
				: null
		return knowledgeSnapshotSchema.parse({
			id: row.id,
			profileId: row.profile_id,
			itemId: row.item_id,
			projectSlug: row.project_slug,
			purpose: row.purpose,
			sequence: row.sequence,
			query: row.query,
			characterBudget: row.character_budget ?? null,
			context: row.context,
			manifest: (parseJson(row.manifest, 'manifest') as unknown[]).map(value => knowledgeSourceSchema.parse(value)),
			provider,
			createdAt: row.created_at,
		})
	}

	private toCandidateBatch(row: Record<string, unknown>): KnowledgeCandidateOutboxEntry {
		return knowledgeCandidateOutboxEntrySchema.parse({
			id: row.id,
			profileId: row.profile_id,
			itemId: row.item_id,
			projectSlug: row.project_slug,
			snapshotId: row.snapshot_id,
			bindingId: row.binding_id ?? null,
			providerId: row.provider_id ?? null,
			providerProjectId: row.provider_project_id ?? null,
			idempotencyKey: row.idempotency_key,
			candidates: parseJson(row.candidates, 'candidates'),
			state: row.state,
			attemptCount: row.attempt_count,
			nextAttemptAt: row.next_attempt_at ?? null,
			leaseOwner: row.lease_owner ?? null,
			leaseExpiresAt: row.lease_expires_at ?? null,
			lastErrorCode: row.last_error_code ?? null,
			lastError: row.last_error ?? null,
			receipt: row.receipt === null || row.receipt === undefined ? null : parseJson(row.receipt, 'receipt'),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			deliveredAt: row.delivered_at ?? null,
		})
	}
}

export function frozenBinding(binding: {
	bindingId: string
	providerId: string
	providerProjectId: string
}): FrozenKnowledgeBinding {
	return {
		bindingId: binding.bindingId,
		providerId: binding.providerId,
		providerProjectId: binding.providerProjectId,
	}
}
