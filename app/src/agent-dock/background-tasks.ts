// Agent dock: background tasks a Claude session's main agent started and that
// have not ended (Bash `run_in_background` shells, background Workflows,
// Monitors), read from the session's own JSONL transcript lines. Pure: no IO,
// no clocks (callers pass `now`); claude-transcript-tail.ts feeds it lines.
//
// Why the JSONL and not Okena's transcript API: Okena's page shows the start
// (a tool_result "Command running in background with ID: …") but drops every
// end signal: `<task-notification>` user records (origin.kind
// `task-notification`), `queue-operation` records and queued `task-notification`
// attachments are all filtered out. Helm's own hub gets a count from the Stop
// hook's `background_tasks` instead (no transcript parsing there).
//
// Structured fields only (Claude wrote them): `toolUseResult` of the main
// agent's tool results and the `<task-id>`/`<status>` tags of task
// notifications. Unknown shapes are ignored (no claim). Background subagents
// (Agent `run_in_background`) are not counted here: Okena lists them in
// `running_subagents` already.

export type BackgroundTaskKind = 'shell' | 'workflow' | 'monitor'

export interface BackgroundTask {
	id: string
	kind: BackgroundTaskKind
	/** A Monitor with a timeout ends by then even if its expiry event was not seen (ms). */
	deadline?: number
}

export interface BackgroundTaskState {
	/** Running, oldest first, at most BACKGROUND_TASKS_MAX. */
	running: BackgroundTask[]
	/** Recently ended ids (bounded): a start read after its own end does not count again. */
	ended: string[]
}

/** What the source reports per pane: only for `sessionId`, and only counts. */
export interface ObservedBackgroundTasks {
	sessionId: string
	/** Running background tasks (shells included). */
	tasks: number
	/** How many of `tasks` are shells. */
	shells: number
}

export const BACKGROUND_TASKS_MAX = 32
const ENDED_MAX = 64
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Lines that cannot carry a start or an end are never parsed (api-request blobs can be huge). */
const NEEDLES = ['"backgroundTaskId"', '"async_launched"', '"timeoutMs"', '"task_id"', '<task-notification>']

export const emptyBackgroundTasks = (): BackgroundTaskState => ({ running: [], ended: [] })

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const taskId = (value: unknown): string | undefined =>
	typeof value === 'string' && TASK_ID.test(value) ? value : undefined

/** One JSONL line (any record type); returns the next state, `state` untouched. */
export function applyBackgroundLine(state: BackgroundTaskState, line: string): BackgroundTaskState {
	if (!NEEDLES.some(needle => line.includes(needle))) return state
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch {
		return state
	}
	const entry = record(parsed)
	// Sidechain records belong to a subagent: its shells are its own business.
	if (!entry || entry.isSidechain === true) return state
	if (entry.type === 'user') {
		const result = record(entry.toolUseResult)
		if (result) {
			const started = startOf(result, entry.timestamp)
			if (started) return start(state, started)
			const stopped = stoppedOf(result)
			if (stopped) return end(state, stopped)
			return state
		}
		const content = record(entry.message)?.content
		return typeof content === 'string' ? notification(state, content) : state
	}
	// Claude enqueues the notification the moment the task ends; it is delivered later.
	if (entry.type === 'queue-operation' && entry.operation === 'enqueue' && typeof entry.content === 'string')
		return notification(state, entry.content)
	if (entry.type === 'attachment') {
		const attachment = record(entry.attachment)
		if (attachment?.type === 'queued_command' && typeof attachment.prompt === 'string')
			return notification(state, attachment.prompt)
	}
	return state
}

function startOf(result: Record<string, unknown>, timestamp: unknown): BackgroundTask | undefined {
	const shell = taskId(result.backgroundTaskId)
	if (shell) return { id: shell, kind: 'shell' }
	// Workflow: {status: 'async_launched', taskId, taskType}. An async Agent has agentId, no taskId.
	const id = taskId(result.taskId)
	if (!id) return undefined
	if (result.status === 'async_launched') return { id, kind: 'workflow' }
	// Monitor: {taskId, timeoutMs, persistent}.
	if (typeof result.timeoutMs === 'number' && Number.isFinite(result.timeoutMs) && result.timeoutMs > 0) {
		const at = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN
		const deadline = result.persistent !== true && Number.isFinite(at) ? at + result.timeoutMs : undefined
		return { id, kind: 'monitor', ...(deadline !== undefined ? { deadline } : {}) }
	}
	return undefined
}

/** TaskStop / KillShell: `{message: 'Successfully stopped task: …', task_id}`. */
function stoppedOf(result: Record<string, unknown>): string | undefined {
	const id = taskId(result.task_id)
	return id && typeof result.message === 'string' && result.message.startsWith('Successfully stopped') ? id : undefined
}

/** `<task-notification>` with a `<task-id>` and a `<status>` (completed, failed, killed, stopped, …) ends that task. */
function notification(state: BackgroundTaskState, text: string): BackgroundTaskState {
	const body = text.trimStart()
	if (!body.startsWith('<task-notification>')) return state
	const close = body.indexOf('</task-notification>')
	const inner = close === -1 ? body : body.slice(0, close)
	const id = taskId(/<task-id>([^<]*)<\/task-id>/.exec(inner)?.[1]?.trim())
	const status = /<status>([^<]*)<\/status>/.exec(inner)?.[1]?.trim()
	// A Monitor event has no status: the monitor keeps running.
	return id && status ? end(state, id) : state
}

function start(state: BackgroundTaskState, task: BackgroundTask): BackgroundTaskState {
	if (state.ended.includes(task.id) || state.running.some(running => running.id === task.id)) return state
	if (state.running.length >= BACKGROUND_TASKS_MAX) return state
	return { running: [...state.running, task], ended: state.ended }
}

function end(state: BackgroundTaskState, id: string): BackgroundTaskState {
	if (state.ended.includes(id)) return state
	return {
		running: state.running.filter(task => task.id !== id),
		ended: [...state.ended, id].slice(-ENDED_MAX),
	}
}

/** Counts at `now` (Monitors past their deadline no longer count). */
export function backgroundTaskCounts(state: BackgroundTaskState, now: number): { tasks: number; shells: number } {
	const running = state.running.filter(task => task.deadline === undefined || now < task.deadline)
	return { tasks: running.length, shells: running.filter(task => task.kind === 'shell').length }
}
