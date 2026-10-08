import { z } from 'zod'
import { REVIEW_INSTRUCTION_UNITS, REVIEW_PASSAGE_UNITS } from './types.js'
import type { ReviewRequest } from './types.js'
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const passage = z
	.object({
		revision,
		start: z.number().int().nonnegative().safe(),
		end: z.number().int().positive().safe(),
		source: z.string().max(REVIEW_PASSAGE_UNITS),
		quote: z.string().max(REVIEW_PASSAGE_UNITS),
		kind: z.enum(['exact', 'block']),
		canvasId: z.string().min(1).max(80).optional(),
	})
	.strict()
export const reviewRequestSchema = z
	.object({
		id: z.string().uuid(),
		documentId: z.string().uuid(),
		sessionId: z
			.string()
			.regex(/^review:[a-f0-9-]{36}$/)
			.refine(value => z.string().uuid().safeParse(value.slice(7)).success),
		owner: z.string().uuid(),
		revision,
		intent: z.enum(['discuss', 'change']),
		instruction: z
			.string()
			.min(1)
			.max(REVIEW_INSTRUCTION_UNITS)
			.refine(value => value.trim().length > 0),
		passage: passage.nullable(),
		canvasFields: z
			.array(z.object({ id: z.string().min(1).max(80), value: z.union([z.string().max(4000), z.boolean()]) }).strict())
			.max(16)
			.refine(
				fields =>
					new Set(fields.map(field => field.id)).size === fields.length &&
					fields.reduce((n, field) => n + (typeof field.value === 'string' ? field.value.length : 0), 0) <= 16384,
			)
			.optional(),
	})
	.strict()
export function parseReviewRequest(value: unknown): ReviewRequest {
	const parsed = reviewRequestSchema.safeParse(value)
	if (!parsed.success) throw new Error('Invalid or oversized review request. Nothing was sent.')
	return parsed.data
}
