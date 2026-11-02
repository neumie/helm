import { z } from 'zod'

/**
 * A discovered task from the external source.
 * Minimal info needed to decide whether to enqueue it.
 */
export interface DiscoveredTask {
	externalId: string
	title: string
	createdAt: string
}

/** One block of a rich task description, in document order, so inline images
 *  render between the surrounding text instead of all dumped at the end. */
export const descriptionImageBlockSchema = z.object({
	type: z.literal('image'),
	url: z.string(),
	name: z.string().optional(),
	contentType: z.string().optional(),
})

export const descriptionBlockSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('text'), text: z.string(), heading: z.number().optional() }),
	descriptionImageBlockSchema,
])
export type DescriptionBlock = z.infer<typeof descriptionBlockSchema>

/**
 * Helm's canonical internal representation of a task. Each provider normalizes
 * its native data into this shape; all fields optional except title. It is a Zod
 * schema (not just an interface) because an Item can FREEZE one as its
 * `capturedContext` column (an ingested email etc., with no live provider to
 * re-poll), so it must validate on the DB round-trip. Plain (non-strict) z.object:
 * unknown keys are STRIPPED on parse, so any new field a provider sets must also
 * be declared here or it will silently vanish on the next `captured_context` read.
 */
export const taskContextSchema = z.object({
	title: z.string(),
	description: z.string().optional(),
	/** Ordered rich blocks (text + inline images). `description` stays the flat
	 *  text used for the solve prompt; this is for faithful display only. */
	descriptionBlocks: z.array(descriptionBlockSchema).optional(),
	metadata: z.record(z.string()).optional(),
	comments: z.array(z.object({ author: z.string(), createdAt: z.string(), body: z.string() })).optional(),
	attachments: z.array(z.object({ name: z.string(), url: z.string(), contentType: z.string().optional() })).optional(),
	projectContext: z.string().optional(),
})
export type TaskContext = z.infer<typeof taskContextSchema>

/**
 * Lightweight task summary used when enqueueing a task by its external id —
 * enough to insert a DB row and generate a sensible branch name.
 */
export interface TaskSummary {
	projectSlug: string
	title: string
}

/** Result of creating a task in the source system. */
export interface CreatedSourceTask {
	externalId: string
	url?: string
}

export type ProviderUnavailableReason = 'timeout' | 'unreachable' | 'connection_lost' | 'unavailable'

/**
 * The task source could not be reached or did not answer in time (network
 * failure, timeout, or a gateway 502/503/504). Providers throw it from their
 * transport so routes can answer 502 with operator wording instead of a 500.
 * The message states only what happened at the provider; each route adds what
 * that means for Helm-side effects (e.g. "Nothing was created" only where true).
 *
 * `unreachable` is reserved for failures before a connection existed, so the
 * request provably never arrived. Every other reason on a mutation sets
 * `mayHaveApplied`, and the message then tells the operator to check the
 * provider before retrying: the change may already be there.
 */
export class ProviderUnavailableError extends Error {
	readonly reason: ProviderUnavailableReason
	readonly providerLabel: string
	readonly mayHaveApplied: boolean

	constructor(
		providerLabel: string,
		reason: ProviderUnavailableReason,
		options?: { cause?: unknown; status?: number; mayHaveApplied?: boolean },
	) {
		const mayHaveApplied = options?.mayHaveApplied === true && reason !== 'unreachable'
		const what =
			reason === 'timeout'
				? `${providerLabel} did not respond in time (timed out).`
				: reason === 'unreachable'
					? `${providerLabel} could not be reached.`
					: reason === 'connection_lost'
						? `The connection to ${providerLabel} failed mid-request.`
						: `${providerLabel} is unavailable (HTTP ${options?.status ?? 'error'}).`
		super(
			mayHaveApplied
				? `${what} The change may still have been applied in ${providerLabel}; check there before retrying.`
				: what,
			options?.cause === undefined ? undefined : { cause: options.cause },
		)
		this.name = 'ProviderUnavailableError'
		this.reason = reason
		this.providerLabel = providerLabel
		this.mayHaveApplied = mayHaveApplied
	}
}

/**
 * Abstract interface that all task sources must implement.
 */
export interface TaskProvider {
	readonly name: string
	pollNewTasks(projectSlug: string, since: string): Promise<DiscoveredTask[]>
	/** Bounded pages in observation order; the initial timestamp boundary is inclusive. */
	pollNewTaskPages?(projectSlug: string, since: string, signal?: AbortSignal): AsyncIterable<DiscoveredTask[]>
	getTaskContext(externalId: string): Promise<TaskContext | null>
	resolveTaskSummary(externalId: string): Promise<TaskSummary | null>
	postComment(externalId: string, markdown: string): Promise<string | null>
	/**
	 * Optional capability: create a task in the source system (used to promote a
	 * captured/ingested Item — e.g. an email — into a real tracked task). The
	 * projectSlug is the helm project slug, which by convention matches the
	 * provider's project identifier. Throws on failure.
	 */
	createTask?(input: { projectSlug: string; title: string; description?: string }): Promise<CreatedSourceTask>
}
