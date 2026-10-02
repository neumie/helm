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
}
export interface ReviewDocument {
	id: string
	name: string
	relativePath: string
	revision: string
	text: string
	previous: string | null
	error: string | null
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
}
export interface ReviewMessage {
	id: string
	role: 'user' | 'assistant' | 'activity'
	text: string
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
