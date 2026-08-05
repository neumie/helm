import { z } from 'zod'

export const MAX_KNOWLEDGE_CONTEXT_CHARACTERS = 200_000
const MAX_KNOWLEDGE_CONTEXT_UTF16_UNITS = 400_000
export const MAX_KNOWLEDGE_MANIFEST_SOURCES = 500

export const knowledgePurposeSchema = z.enum(['planning', 'solve'])
export type KnowledgePurpose = z.infer<typeof knowledgePurposeSchema>

export const knowledgeCandidateTypeSchema = z.enum(['convention', 'decision', 'entity', 'event', 'lesson'])
export type KnowledgeCandidateType = z.infer<typeof knowledgeCandidateTypeSchema>

function isSafeRelativeLabel(value: string): boolean {
	const normalized = value.replaceAll('\\', '/')
	return (
		!normalized.startsWith('/') &&
		!/^[a-zA-Z]:\//.test(normalized) &&
		!normalized.split('/').includes('..') &&
		!normalized.includes('\0')
	)
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

/** Historical migration-32 evidence. Never coerce these rows into Hold provenance. */
export const legacyKnowledgeSourceSchema = z
	.object({
		role: z.enum(['master', 'recent', 'search']),
		path: z.string().trim().min(1).max(1_000).refine(isSafeRelativeLabel, 'Knowledge source path must be relative'),
		title: z.string().trim().min(1).max(1_000),
		heading: z.string().trim().max(1_000).nullable(),
		hash: z.string().trim().min(1).max(128),
		sourceUpdatedAt: z.string().datetime({ offset: true }),
		characters: z.number().int().min(0).max(MAX_KNOWLEDGE_CONTEXT_CHARACTERS),
	})
	.strict()
export type LegacyKnowledgeSource = z.infer<typeof legacyKnowledgeSourceSchema>

/** Provider-neutral exact evidence; UTF-16 ranges preserve Hold protocol-v1 offsets. */
export const knowledgeEvidenceSourceSchema = z
	.object({
		sourceRef: z.string().min(1).max(256),
		role: z.string().min(1).max(64),
		label: z.string().min(1).max(1_000).refine(isSafeRelativeLabel, 'Knowledge source label must be relative'),
		heading: z.string().max(1_000).nullable(),
		contentHash: sha256Schema,
		sourceHash: sha256Schema,
		characters: z.number().int().min(0).max(MAX_KNOWLEDGE_CONTEXT_CHARACTERS),
		range: z
			.object({
				start: z.number().int().nonnegative(),
				end: z.number().int().nonnegative(),
				unit: z.literal('utf16-code-units'),
			})
			.strict()
			.refine(range => range.end >= range.start, 'Knowledge source range must be ordered'),
	})
	.strict()
export type KnowledgeEvidenceSource = z.infer<typeof knowledgeEvidenceSourceSchema>

export const knowledgeSourceSchema = z.union([knowledgeEvidenceSourceSchema, legacyKnowledgeSourceSchema])
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>

/** One exact normalized provider response before Helm-owned persistence. */
export const providerKnowledgeBriefSchema = z
	.object({
		briefRef: z.string().min(1).max(256),
		revision: z.string().min(1).max(256),
		generatedAt: z.string().datetime({ offset: true }),
		context: z.string().min(1).max(MAX_KNOWLEDGE_CONTEXT_UTF16_UNITS),
		contextHash: sha256Schema,
		sources: z.array(knowledgeEvidenceSourceSchema).max(MAX_KNOWLEDGE_MANIFEST_SOURCES),
	})
	.strict()
export type ProviderKnowledgeBrief = z.infer<typeof providerKnowledgeBriefSchema>

export const knowledgeSnapshotProviderSchema = z
	.object({
		bindingId: sha256Schema,
		providerId: z.string().min(1).max(64),
		providerType: z.string().min(1).max(64),
		providerProjectId: z.string().min(1).max(200),
		briefRef: z.string().min(1).max(256),
		revision: z.string().min(1).max(256),
		generatedAt: z.string().datetime({ offset: true }),
		contextHash: sha256Schema,
		protocolVersion: z.number().int().positive(),
	})
	.strict()
export type KnowledgeSnapshotProvider = z.infer<typeof knowledgeSnapshotProviderSchema>

/** Exact provider bytes and manifest consumed by one planning/solve attempt. */
export const knowledgeSnapshotSchema = z
	.object({
		id: z.string().min(1).max(256),
		profileId: z.string().min(1).max(256),
		itemId: z.string().min(1).max(256),
		projectSlug: z.string().min(1).max(256),
		purpose: knowledgePurposeSchema,
		sequence: z.number().int().positive(),
		query: z.string().max(4_000),
		characterBudget: z.number().int().min(100).max(MAX_KNOWLEDGE_CONTEXT_CHARACTERS).nullable(),
		context: z.string().min(1).max(MAX_KNOWLEDGE_CONTEXT_UTF16_UNITS),
		manifest: z.array(knowledgeSourceSchema).max(MAX_KNOWLEDGE_MANIFEST_SOURCES),
		provider: knowledgeSnapshotProviderSchema.nullable(),
		createdAt: z.string().datetime({ offset: true }),
	})
	.strict()
export type KnowledgeSnapshot = z.infer<typeof knowledgeSnapshotSchema>

/** Attempt-local learned facts. The configured provider owns review and acceptance. */
export const agentKnowledgeCandidateSchema = z
	.object({
		type: knowledgeCandidateTypeSchema,
		title: z.string().trim().min(1).max(200),
		content: z.string().trim().min(1).max(4_000),
	})
	.strict()
export type AgentKnowledgeCandidate = z.infer<typeof agentKnowledgeCandidateSchema>

export const agentKnowledgeCandidatesSchema = z.array(agentKnowledgeCandidateSchema).max(5)

const legacyAgentKnowledgeCandidateSchema = z
	.object({
		title: z.string().trim().min(1).max(200),
		content: z.string().trim().min(1).max(4_000),
	})
	.strict()
	.transform(candidate => ({ ...candidate, type: 'lesson' as const }))
const storedAgentKnowledgeCandidatesSchema = z
	.array(z.union([agentKnowledgeCandidateSchema, legacyAgentKnowledgeCandidateSchema]))
	.max(5)

export const knowledgeDeliveryReceiptSchema = z
	.object({
		receiptRef: z.string().min(1).max(256),
		candidateRefs: z.array(z.string().min(1).max(256)).min(1).max(20),
		recordRef: z.string().min(1).max(256),
		jobRef: z.string().min(1).max(256),
		acceptedAt: z.string().datetime({ offset: true }),
		replayed: z.boolean(),
	})
	.strict()
export type KnowledgeDeliveryReceipt = z.infer<typeof knowledgeDeliveryReceiptSchema>

export const storedKnowledgeReceiptSchema = z.union([
	knowledgeDeliveryReceiptSchema,
	z.object({ legacyReceipt: z.string().min(1).max(4_000) }).strict(),
])
export type StoredKnowledgeReceipt = z.infer<typeof storedKnowledgeReceiptSchema>

export const knowledgeCandidateOutboxStateSchema = z.enum(['pending', 'delivering', 'delivered', 'blocked'])
export type KnowledgeCandidateOutboxState = z.infer<typeof knowledgeCandidateOutboxStateSchema>

/** Durable Helm-owned delivery state with a destination frozen at enqueue time. */
export const knowledgeCandidateOutboxEntrySchema = z
	.object({
		id: z.string().min(1).max(256),
		profileId: z.string().min(1).max(256),
		itemId: z.string().min(1).max(256),
		projectSlug: z.string().min(1).max(256),
		snapshotId: z.string().min(1).max(256).nullable(),
		bindingId: sha256Schema.nullable(),
		providerId: z.string().min(1).max(64).nullable(),
		providerProjectId: z.string().min(1).max(200).nullable(),
		// New rows use SHA-256. Blocked migration-33 rows retain their historical
		// key solely as evidence and are never submitted without explicit adoption.
		idempotencyKey: z.string().min(1).max(256),
		candidates: storedAgentKnowledgeCandidatesSchema,
		state: knowledgeCandidateOutboxStateSchema,
		attemptCount: z.number().int().nonnegative(),
		nextAttemptAt: z.string().datetime({ offset: true }).nullable(),
		leaseOwner: z.string().min(1).max(200).nullable(),
		leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
		lastErrorCode: z.string().min(1).max(100).nullable(),
		lastError: z.string().max(1_000).nullable(),
		receipt: storedKnowledgeReceiptSchema.nullable(),
		createdAt: z.string().datetime({ offset: true }),
		updatedAt: z.string().datetime({ offset: true }),
		deliveredAt: z.string().datetime({ offset: true }).nullable(),
	})
	.strict()
export type KnowledgeCandidateOutboxEntry = z.infer<typeof knowledgeCandidateOutboxEntrySchema>
