import { z } from 'zod'

export const SUBAGENT_ACTIVITY_HEADER = 'X-Helm-Subagent-Activity'
export const SUBAGENT_ACTIVITY_REQUEST_EVENT = 'pi-subagents:activity:v1:request'
export const SUBAGENT_ACTIVITY_READY_EVENT = 'pi-subagents:activity:v1:ready'

export const remoteSubagentActivitySchema = z.discriminatedUnion('availability', [
	z.object({ availability: z.literal('available'), coverage: z.literal('limited'), active: z.boolean() }).strict(),
	z
		.object({
			availability: z.enum(['unavailable', 'unsupported']),
			coverage: z.literal('unavailable'),
			active: z.null(),
		})
		.strict(),
])
export type RemoteSubagentActivity = z.infer<typeof remoteSubagentActivitySchema>

const uuidSchema = z.string().uuid()

export const remoteSubagentActivityFrameSchema = z
	.object({
		binding: z
			.object({
				version: z.literal(1),
				scope: z.literal('session'),
				sessionId: uuidSchema,
				providerId: uuidSchema,
				sequence: z.number().int().positive().safe(),
			})
			.strict(),
		activity: remoteSubagentActivitySchema,
	})
	.strict()
export type RemoteSubagentActivityFrame = z.infer<typeof remoteSubagentActivityFrameSchema>

export const remoteSubagentActivityCapabilitySchema = z
	.object({
		version: z.literal(1),
		scope: z.literal('session'),
		sessionId: uuidSchema,
		providerId: uuidSchema,
		readActivity: z.function(),
	})
	.strict()
