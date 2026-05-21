// TaskRecord + its enums are derived from the Zod schema (single source of
// truth for the tasks table). Imported for local use (SolverResult references
// Tier) and re-exported so existing imports keep working.
import type { ErrorPhase, TaskRecord, TaskStatus, Tier } from './db/task-schema.js'
export type { ErrorPhase, TaskRecord, TaskStatus, Tier }

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

export interface SolverResult {
	tier: Tier
	confidence: number
	summary: string
	filesChanged: string[]
	analysis?: string
	questionsForRequester?: string[]
	remainingWork?: string[]
	prReady: boolean
	prTitle?: string
	prBody?: string
	prUrl?: string
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

export interface ChatSession {
	id: string
	taskId: string
	token: string
	status: 'active' | 'completed'
	createdAt: string
	completedAt: string | null
}

export interface ChatMessage {
	id: string
	sessionId: string
	role: 'assistant' | 'user'
	content: string
	createdAt: string
}
