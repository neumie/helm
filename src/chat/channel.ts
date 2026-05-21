import type { DB } from '../db/client.js'

/**
 * The single owner of a clarification session's live channel: the in-memory
 * listener registry AND the message-write operations that must wake those
 * listeners.
 *
 * Previously the invariant "every chat-message write must notify everyone
 * watching the session" was split across two layers — `DB.addChatMessage`
 * wrote the row, a free-function bus in `routes.ts` did the notify, and three
 * call sites (the SSE POST handler, the MCP send loop, the manual-chat API
 * route) had to remember to pair them by hand. One of them (the manual-chat
 * route) already forgot, so a live viewer missed the seeded assistant message.
 *
 * Folding write+notify into one operation concentrates that invariant here:
 * `postUser` / `postAssistant` are the ONLY way to add a message, and both
 * always notify. The bus can no longer be driven out of sync with the table.
 *
 * Two real consumers cross the wait/subscribe seam: the SSE stream
 * (`subscribe`) and the MCP `vigil_send_message` 24h block-and-poll loop
 * (`waitForEvent`). State is keyed by `sessionId`/DB rows — never by a
 * per-transport closure — so it survives the MCP transport's 30-min rotation.
 */
export class ChatChannel {
	private readonly listeners = new Map<string, Set<() => void>>()

	constructor(private readonly db: DB) {}

	/** Write a requester message and wake every listener on the session. */
	postUser(sessionId: string, content: string): string {
		const id = this.db.addChatMessage(sessionId, 'user', content)
		this.emit(sessionId)
		return id
	}

	/** Write an assistant (Vigil) message and wake every listener on the session. */
	postAssistant(sessionId: string, content: string): string {
		const id = this.db.addChatMessage(sessionId, 'assistant', content)
		this.emit(sessionId)
		return id
	}

	/**
	 * Wake listeners without writing a message — used when a session changes
	 * state (e.g. completed) so a live SSE stream / waiting MCP loop notices.
	 */
	notify(sessionId: string): void {
		this.emit(sessionId)
	}

	/**
	 * Subscribe to a session's events. Returns an unsubscribe function. Used by
	 * the SSE stream, which re-reads messages from the DB on each wake.
	 */
	subscribe(sessionId: string, listener: () => void): () => void {
		this.add(sessionId, listener)
		return () => this.remove(sessionId, listener)
	}

	/**
	 * Resolve on the next event for a session, then auto-unsubscribe. Used by the
	 * MCP send loop to wait for the next requester reply without polling.
	 */
	waitForEvent(sessionId: string): Promise<void> {
		return new Promise(resolve => {
			const listener = () => {
				this.remove(sessionId, listener)
				resolve()
			}
			this.add(sessionId, listener)
		})
	}

	private emit(sessionId: string): void {
		const listeners = this.listeners.get(sessionId)
		if (listeners) {
			for (const listener of listeners) listener()
		}
	}

	private add(sessionId: string, listener: () => void): void {
		let set = this.listeners.get(sessionId)
		if (!set) {
			set = new Set()
			this.listeners.set(sessionId, set)
		}
		set.add(listener)
	}

	private remove(sessionId: string, listener: () => void): void {
		const set = this.listeners.get(sessionId)
		if (!set) return
		set.delete(listener)
		if (set.size === 0) this.listeners.delete(sessionId)
	}
}
