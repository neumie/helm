/**
 * A discovered task from the external source.
 * Minimal info needed to decide whether to enqueue it.
 */
export interface DiscoveredTask {
	externalId: string
	title: string
	createdAt: string
}

/**
 * Vigil's canonical internal representation of a task.
 * Each provider normalizes its native data into this shape.
 * All fields optional except title — providers fill in what they can.
 */
/** One block of a rich task description, in document order, so inline images
 *  render between the surrounding text instead of all dumped at the end. */
export type DescriptionBlock =
	| { type: 'text'; text: string; heading?: number }
	| { type: 'image'; url: string; name?: string; contentType?: string }

export interface TaskContext {
	title: string
	description?: string
	/** Ordered rich blocks (text + inline images). `description` stays the flat
	 *  text used for the solve prompt; this is for faithful display only. */
	descriptionBlocks?: DescriptionBlock[]
	metadata?: Record<string, string>
	comments?: Array<{ author: string; createdAt: string; body: string }>
	attachments?: Array<{ name: string; url: string; contentType?: string }>
	projectContext?: string
}

/**
 * Lightweight task summary used when enqueueing a task by its external id —
 * enough to insert a DB row and generate a sensible branch name.
 */
export interface TaskSummary {
	projectSlug: string
	title: string
}

/**
 * Abstract interface that all task sources must implement.
 */
export interface TaskProvider {
	readonly name: string
	pollNewTasks(projectSlug: string, since: string): Promise<DiscoveredTask[]>
	getTaskContext(externalId: string): Promise<TaskContext | null>
	resolveTaskSummary(externalId: string): Promise<TaskSummary | null>
	postComment(externalId: string, markdown: string): Promise<string | null>
}
