import type { CanvasFieldValue, CanvasReviewArchive, ReviewCanvasCompilation } from './canvas-types.js'
export type * from './canvas-types.js'

/** Review is a surface of an already-running caller, never an agent launcher. */
export type ReviewProvider = 'claude' | 'codex' | 'pi'
export type ReviewIntent = 'discuss' | 'change'
export interface ReviewCapabilities {
	transport: 'tool-return' | 'in-process'
	continuation: 'live-session'
	readOnlyPolicy: 'session-owned'
	interactiveQuestions: true
	interrupt: 'unsupported'
	providerAcknowledgement: false
	minimumVersion: string | null
}
export interface ReviewPassage {
	revision: string
	start: number
	end: number
	source: string
	quote: string
	kind: 'exact' | 'block'
	/** Display locator for a compiler-attested JSX block; never an invented text offset. */
	canvasId?: string
}
export interface ReviewDocument {
	id: string
	name: string
	relativePath: string
	revision: string
	text: string
	previous: string | null
	error: string | null
	format?: 'markdown' | 'jsx'
	canvas?: ReviewCanvasCompilation
	archive?: CanvasReviewArchive
}
export interface ReviewAnnotation {
	id: string
	passage: ReviewPassage
	note: string
	intent: ReviewIntent
	resolved: boolean
}
export interface ReviewDraft {
	instruction: string
	annotations: ReviewAnnotation[]
	sessionId: string | null
	paneWidth: number
	theme: 'dark' | 'light'
	/** Optimistic metadata fence, not a persisted caller binding. */
	archiveRevision?: string | null
}
export interface ReviewMessage {
	id: string
	role: 'user' | 'assistant' | 'activity'
	text: string
	/** Display-only source association on an admitted passage question. Never command authority. */
	passageContext?: { documentId: string; passage: ReviewPassage }
	/** Display-only link to an embedded thread; never caller or command authority. */
	archiveThreadId?: string
}
export interface ReviewSession {
	id: string
	owner: string
	provider: ReviewProvider
	capabilities: ReviewCapabilities
	name: string
	state: 'idle' | 'starting' | 'working' | 'waiting' | 'disconnected' | 'error'
	/** Only the live connector can make this true; identity alone is not availability. */
	listening: boolean
	busy: boolean
	needsAcknowledgement: boolean
	messages: ReviewMessage[]
	error: string | null
	historyTruncated: boolean
}
export interface ReviewRequest {
	id: string
	documentId: string
	revision: string
	sessionId: string
	owner: string
	intent: ReviewIntent
	instruction: string
	passage: ReviewPassage | null
	/** Explicit, bounded public document fields; JSX only. Never password/file inputs. */
	canvasFields?: CanvasFieldValue[]
}
export interface ReviewReceipt {
	id: string
	outcome: 'pending' | 'dispatched' | 'rejected' | 'unknown'
	detail: string
}
export interface ReviewState {
	document: ReviewDocument
	sessions: ReviewSession[]
	draft: ReviewDraft
	/** Saving review content failed; retryDocument retries persistence, never dispatch. */
	archiveError?: string | null
	archiveFailureId?: string | null
}
export type ReviewResult<T> = { data: T; error?: never } | { error: string; data?: never }
export interface ReviewApi {
	load(): Promise<ReviewResult<ReviewState>>
	send(request: ReviewRequest): Promise<ReviewResult<ReviewReceipt>>
	interrupt(sessionId: string, owner: string): Promise<ReviewResult<boolean>>
	save(draft: ReviewDraft): Promise<ReviewResult<boolean>>
	selectSession(id: string | null): Promise<ReviewResult<ReviewDraft>>
	acknowledge(sessionId: string, owner: string): Promise<ReviewResult<boolean>>
	receipt(id: string): Promise<ReviewResult<ReviewReceipt | null>>
	retryDocument(): Promise<ReviewResult<boolean>>
	discardArchive?(failureId: string): Promise<ReviewResult<boolean>>
	dirty(value: boolean): void
	onCloseRequested(listener: () => void): () => void
	onChanged(listener: () => void): () => void
	close(): void
}
export interface ReviewFeedback {
	request: ReviewRequest
	prompt: string
	relativePath: string
}
export const REVIEW_DOCUMENT_BYTES = 512 * 1024
export const REVIEW_PROMPT_UNITS = 24000
export const REVIEW_INSTRUCTION_UNITS = 8000
export const REVIEW_PASSAGE_UNITS = 8000
export const defaultReviewDraft = (): ReviewDraft => ({
	instruction: '',
	annotations: [],
	sessionId: null,
	paneWidth: 380,
	theme: 'dark',
})
