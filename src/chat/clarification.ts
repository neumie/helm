import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { TaskProvider } from '../providers/provider.js'
import { log } from '../util/logger.js'
import { formatTranscript } from './format.js'
import type { ChatLinks } from './links.js'
import { emitSessionEvent, waitForSessionEvent } from './routes.js'
import { sendWebhook } from './webhook.js'

const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24h block-and-poll ceiling

/** A fresh clarification invite: the backing session id (the MCP addressing key) and its public URL. */
export interface ClarificationInvite {
	sessionId: string
	chatUrl: string
}

/** Outcome of awaiting a requester reply on a session. */
export type ReplyOutcome =
	| { kind: 'reply'; text: string }
	| { kind: 'closed' }
	| { kind: 'timeout' }
	| { kind: 'inactive' }

/**
 * The clarification-chat orchestration as a deep module: open an invite, wait for
 * a requester reply, end and read the transcript. All of the multi-step domain
 * behaviour (session create + provider comment + webhook, the block-and-poll wait
 * loop, transcript assembly) lives here so the MCP tools that expose it are a thin
 * adapter and the logic is testable without an MCP transport.
 *
 * State for the long (24h) wait is keyed by `sessionId`/DB rows — never by any
 * per-transport closure — so it survives the MCP transport's 30-min rotation.
 *
 * `sessionId` is the addressing key throughout (the DB primary key); the signed
 * `token` only ever appears inside the `chatUrl` minted by `ChatLinks`. Callers
 * never see the token and never address by it.
 */
export class ClarificationChat {
	constructor(
		private readonly config: VigilConfig,
		private readonly db: DB,
		private readonly provider: TaskProvider,
		private readonly chatLinks: ChatLinks,
	) {}

	/**
	 * Open a clarification invite for a task: create the session, post the chat
	 * link as a comment on the source task, and fire the configured webhook.
	 * Returns the session id (addressing key) and the public chat URL.
	 */
	async createInvite(params: {
		taskId: string
		taskTitle: string
		taskDescription?: string
	}): Promise<ClarificationInvite> {
		const { taskId, taskTitle, taskDescription } = params
		const { session, chatUrl } = this.chatLinks.createSession(taskId)
		log.info('chat', `Created chat session ${session.id} for task ${taskId}`)

		const task = this.db.getTask(taskId)
		if (task) {
			const comment = `I need more details about this task before I can solve it.\n\n[Click here to chat](${chatUrl})`
			try {
				await this.provider.postComment(task.clientcareId, comment)
				log.success('chat', `Posted chat link as comment on task ${task.clientcareId}`)
			} catch (err) {
				log.warn('chat', `Failed to post comment: ${err instanceof Error ? err.message : err}`)
			}
		}

		if (this.config.chat?.webhook) {
			await sendWebhook(this.config.chat.webhook, {
				event: 'clarification_needed',
				taskId,
				taskTitle,
				taskDescription,
				chatUrl,
				message: `I need more details about this task. Please click the link to chat: ${chatUrl}`,
			})
		}

		return { sessionId: session.id, chatUrl }
	}

	/**
	 * Post an assistant message on a session and block until the requester replies,
	 * the session closes, or the 24h ceiling elapses. The wait is driven by the
	 * session event bus + DB reads keyed on `sessionId`, so it is unaffected by
	 * MCP transport rotation.
	 */
	async sendAndAwaitReply(sessionId: string, message: string): Promise<ReplyOutcome> {
		const session = this.db.getChatSession(sessionId)
		if (!session || session.status !== 'active') return { kind: 'inactive' }

		const msgId = this.db.addChatMessage(sessionId, 'assistant', message)
		emitSessionEvent(sessionId)
		log.info('chat', `Chat ${sessionId}: sent message, waiting for response...`)

		const start = Date.now()
		while (Date.now() - start < WAIT_TIMEOUT_MS) {
			await waitForSessionEvent(sessionId)

			const newMessages = this.db.getNewUserMessages(sessionId, msgId)
			if (newMessages.length > 0) {
				log.info('chat', `Chat ${sessionId}: received response`)
				return { kind: 'reply', text: newMessages.map(m => m.content).join('\n') }
			}

			const current = this.db.getChatSession(sessionId)
			if (!current || current.status !== 'active') return { kind: 'closed' }
		}

		return { kind: 'timeout' }
	}

	/**
	 * End a session and return its full transcript. Returns `null` if the session
	 * does not exist.
	 */
	end(sessionId: string): string | null {
		const session = this.db.getChatSession(sessionId)
		if (!session) return null

		this.db.completeChatSession(sessionId)
		emitSessionEvent(sessionId)

		const messages = this.db.getChatMessages(sessionId)
		log.info('chat', `Chat ${sessionId}: ended with ${messages.length} messages`)
		return formatTranscript(messages)
	}
}
