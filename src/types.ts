// TaskRecord + its enums are derived from the Zod schema (single source of
// truth for the tasks table); re-exported so existing imports keep working.
export type { ErrorPhase, TaskRecord, TaskStatus } from './db/task-schema.js'
// SolverResult is derived from its own Zod schema (single source of truth for
// the agent's solver-result.json); re-exported here so existing imports keep working.
export type { SolverResult } from './solver/result-schema.js'

export interface PollState {
	projectSlug: string
	lastPollAt: string
	lastTaskSeen: string | null
}

export interface EventLogEntry {
	id: number
	taskId: string | null
	eventType: string
	payload: string | null
	createdAt: string
}

export interface ClaudeEvent {
	type: 'file_read' | 'edit' | 'command' | 'assessment' | 'error' | 'tool_call'
	timestamp?: string
	detail: string
	file?: string
}

export interface QueueStatus {
	paused: boolean
	pending: number
	active: number
	maxConcurrency: number
	activeTasks: Array<{ taskId: string; title: string; startedAt: string }>
}
