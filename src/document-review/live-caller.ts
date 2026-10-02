import { z } from 'zod'
import { callReview, connectReview, loadReviewConnection } from './client.js'
import { feedbackSchema, openedSchema } from './protocol.js'
import type { ReviewConnection } from './protocol.js'
import type { ReviewFeedback } from './types.js'

interface Report {
	sequence: number
	state: 'working' | 'complete' | 'error'
	text: string
}
export interface LiveCallerDependencies {
	/** Pure session/lifecycle check; never a heuristic based on idle time or PIDs. */
	current(): boolean
	/** Synchronous native dispatch into the exact captured running conversation. */
	dispatch(feedback: ReviewFeedback): void
	unavailable(): void
}
/** Native adapter transport. One listener, one feedback, one coalesced report; no process ownership. */
export class LiveReviewCaller {
	private readonly abort = new AbortController()
	private readonly authority: ReviewConnection
	private disposed = false
	private active: ReviewFeedback | null = null
	private confirmed = false
	private terminal = false
	private sequence = 0
	private report: Report | null = null
	private reporting = false
	private listening: Promise<void> | null = null
	private reportWork: Promise<void> | null = null
	private constructor(
		readonly connectionFile: string,
		authority: ReviewConnection,
		private readonly deps: LiveCallerDependencies,
	) {
		this.authority = authority
	}
	static async connect(
		workspace: string,
		file: string,
		deps: LiveCallerDependencies,
		root?: string,
	): Promise<LiveReviewCaller> {
		const connected = await connectReview(
			{
				action: 'connect',
				workspace,
				provider: 'pi',
				label: 'Pi · original terminal session',
				transport: 'in-process',
			},
			root,
		)
		const authority = await loadReviewConnection(connected.connection)
		const caller = new LiveReviewCaller(connected.connection, authority, deps)
		try {
			if (!deps.current()) throw new Error('Pi lifecycle changed while connecting.')
			await callReview(authority, { action: 'open', file }, openedSchema)
			if (!deps.current()) throw new Error('Pi lifecycle changed while opening.')
			return caller
		} catch (error) {
			await caller.dispose()
			throw error
		}
	}
	start(): void {
		if (this.listening || this.disposed) return
		this.listening = this.listen()
			.catch(() => this.failed())
			.finally(() => {
				this.listening = null
			})
	}
	get feedback(): ReviewFeedback | null {
		return this.active
	}
	private current(): boolean {
		try {
			return !this.disposed && !this.abort.signal.aborted && this.deps.current()
		} catch {
			return false
		}
	}
	private async listen(): Promise<void> {
		while (this.current() && !this.active) {
			const feedback = await callReview(
				this.authority,
				{ action: 'next', timeoutMs: 60000 },
				feedbackSchema.nullable(),
				this.abort.signal,
			)
			if (!this.current()) return
			if (!feedback) continue
			if (feedback.request.sessionId !== this.authority.id || feedback.request.owner !== this.authority.owner)
				throw new Error('Feedback owner changed.')
			this.active = feedback
			this.confirmed = false
			this.terminal = false
			this.sequence = 0
			// Never await between the lifecycle check and Pi's synchronous dispatch.
			this.deps.dispatch(feedback)
			if (!this.current()) return
			await callReview(
				this.authority,
				{ action: 'ack', requestId: feedback.request.id },
				z.literal(true),
				this.abort.signal,
			)
			if (!this.current() || this.active !== feedback) return
			this.confirmed = true
			this.pump()
		}
	}
	publish(state: 'working' | 'complete' | 'error', text: string): void {
		if (!this.current() || !this.active || this.terminal) return
		this.terminal = state !== 'working'
		this.report = { sequence: this.sequence++, state, text: text.slice(0, 64000) }
		this.pump()
	}
	private pump(): void {
		if (!this.current() || !this.confirmed || !this.active || !this.report || this.reporting) return
		const feedback = this.active
		const report = this.report
		this.report = null
		this.reporting = true
		this.reportWork = callReview(
			this.authority,
			{ action: 'reply', requestId: feedback.request.id, ...report },
			z.literal(true),
			this.abort.signal,
		)
			.then(() => {
				if (!this.current() || this.active !== feedback) return
				if (report.state !== 'working') {
					this.active = null
					this.confirmed = false
				}
			})
			.catch(() => this.failed())
			.finally(() => {
				this.reporting = false
				this.reportWork = null
				if (!this.current()) return
				if (this.active) this.pump()
				else {
					// The old read coroutine may be finishing its ACK. Do not overlap listeners.
					void Promise.resolve(this.listening).then(() => this.start())
				}
			})
	}
	private failed(): void {
		if (this.disposed) return
		try {
			this.deps.unavailable()
		} catch {
			/* a disposed UI cannot keep transport authority alive */
		}
		void this.dispose()
	}
	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		this.abort.abort()
		// Disconnect is idempotent at the native owner; never signal or resume Pi.
		try {
			await callReview(this.authority, { action: 'disconnect' }, z.literal(true))
		} catch {
			/* host/owner already unavailable; no reconnect or replay */
		}
	}
}
