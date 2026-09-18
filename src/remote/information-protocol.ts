import { z } from 'zod'
import { remoteTargetSchema, sameRemoteTarget } from './protocol.js'

/** Information-v1 is independent of the legacy strict live/history/command wire. */
export const INFORMATION_HEADER = 'X-Helm-Information'
export const INFORMATION_RESPONSE_BYTES = 32 * 1024
export const INFORMATION_RESPONSE_RESERVE = 1024
export const INFORMATION_PUBLISH_BYTES = INFORMATION_RESPONSE_BYTES - INFORMATION_RESPONSE_RESERVE
export const INFORMATION_SIDEBAR_BYTES = 20 * 1024
export const INFORMATION_TTL_MS = 5000
export const INFORMATION_MAX_SECTIONS = 7 // Footer reserves the eighth section.
export const INFORMATION_MAX_ROWS = 83 // Footer reserves thirteen of ninety-six entries.
export const INFORMATION_MAX_SECTION_ROWS = 24
const integer = z.number().int().nonnegative().safe()
const omitted = integer.max(10_000)
const availability = z.enum(['available', 'unavailable', 'unsupported'])
const scope = z.enum(['session', 'process'])

/** Conservative obvious-sensitive-text rejection, not semantic secrecy detection. */
export function safeInformationText(value: string): boolean {
	return (
		value.trim().length > 0 &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) &&
		!/[\\/<>`]|https?:|file:|(?:bearer|api[_ -]?key|token|password|secret)\s*[:=]|\bbearer\s+|\b(?:sk-|ghp_|github_pat_)/iu.test(
			value,
		)
	)
}
const text = (max: number) => z.string().max(max).refine(safeInformationText)
const nullableText = text(160).nullable()
const goalPhase = z.enum(['active', 'paused', 'cancelling', 'cancelled', 'completed', 'budget_exhausted', 'faulted'])
export const informationFooterFieldsSchema = z
	.object({
		cwd: nullableText,
		trusted: z.boolean().nullable(),
		sessionName: nullableText,
		model: nullableText,
		thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable(),
		inputTokens: integer.nullable(),
		outputTokens: integer.nullable(),
		contextTokens: integer.nullable(),
		contextWindow: integer.nullable(),
		contextPercent: z.number().finite().min(0).max(100).nullable(),
		goalAvailable: z.boolean(),
		goalPhase: goalPhase.nullable(),
		omittedStatuses: omitted.nullable(),
		omitted,
	})
	.strict()
	.refine(value => value.goalAvailable || value.goalPhase === null)
export const informationFooterSchema = z
	.object({
		availability,
		fields: informationFooterFieldsSchema.nullable(),
	})
	.strict()
	.refine(value => (value.availability === 'available') === (value.fields !== null))
export const informationRowSchema = z
	.object({
		label: text(80),
		value: z.union([text(160), integer, z.boolean(), z.null()]),
	})
	.strict()
export const informationSectionSchema = z
	.object({
		title: text(80),
		scope,
		availability,
		coverage: z.enum(['complete', 'limited', 'unavailable']),
		rows: z.array(informationRowSchema).max(INFORMATION_MAX_SECTION_ROWS),
		omitted,
	})
	.strict()
	.refine(value =>
		value.availability === 'available'
			? value.coverage !== 'unavailable' && (value.omitted === 0 || value.coverage === 'limited')
			: value.coverage === 'unavailable' && value.rows.length === 0,
	)
export const informationSidebarSchema = z
	.object({
		availability,
		sections: z.array(informationSectionSchema).max(INFORMATION_MAX_SECTIONS),
		omittedProviders: omitted,
	})
	.strict()
	.refine(
		value =>
			(value.availability === 'available' || value.sections.length === 0) &&
			value.sections.reduce((total, section) => total + section.rows.length, 0) <= INFORMATION_MAX_ROWS,
	)
	.refine(value => informationBytes(value) <= INFORMATION_SIDEBAR_BYTES)

/** Only call on detached schema-parsed data, never on producer callback objects. */
export function informationBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
export const informationEnvelopeSchema = z
	.object({
		version: z.literal(1),
		hostEpoch: z.string().uuid(),
		target: remoteTargetSchema,
		sequence: integer,
		footer: informationFooterSchema,
		sidebar: informationSidebarSchema,
	})
	.strict()
	.refine(value => informationBytes(value) <= INFORMATION_PUBLISH_BYTES)
export type InformationEnvelope = z.infer<typeof informationEnvelopeSchema>
export type InformationFooter = z.infer<typeof informationFooterSchema>
export type InformationSidebar = z.infer<typeof informationSidebarSchema>
export type InformationSection = z.infer<typeof informationSectionSchema>
export const informationResponseSchema = z
	.object({
		version: z.literal(1),
		hostEpoch: z.string().uuid(),
		target: remoteTargetSchema,
		status: availability,
		freshForMs: integer.max(INFORMATION_TTL_MS),
		information: informationEnvelopeSchema.nullable(),
	})
	.strict()
	.refine(value =>
		value.status === 'available'
			? value.information !== null &&
				value.freshForMs > 0 &&
				value.hostEpoch === value.information.hostEpoch &&
				sameRemoteTarget(value.target, value.information.target)
			: value.information === null && value.freshForMs === 0,
	)
	.refine(value => informationBytes(value) <= INFORMATION_RESPONSE_BYTES)
export type InformationResponse = z.infer<typeof informationResponseSchema>
