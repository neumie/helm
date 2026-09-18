import { historyEntryIdSchema } from './history-protocol.js'
import type { HistoryManager } from './history-reader.js'
import {
	REMOTE_CONVERSATION_RESERVE,
	evictRemoteMessage,
	isRemoteConversationMessage,
	projectRemoteMessage,
	trimRemoteMessages,
} from './message-projection.js'
import type { RemoteSnapshot } from './protocol.js'

/** Canonical completed rows come from Pi's observed manager, never message_end timing. */
export function readRemoteLiveMessages(manager: HistoryManager): {
	messages: RemoteSnapshot['messages']
	historyTruncated: boolean
} {
	const messages: RemoteSnapshot['messages'] = []
	let historyTruncated = false
	let next = manager.getLeafId()
	const seen = new Set<string>() // At most the existing 200-attempt live window.
	for (
		let attempts = 0;
		next &&
		attempts < 200 &&
		(messages.length < 40 || messages.filter(isRemoteConversationMessage).length < REMOTE_CONVERSATION_RESERVE);
		attempts++
	) {
		if (!historyEntryIdSchema.safeParse(next).success || seen.has(next)) {
			historyTruncated = true
			break
		}
		seen.add(next)
		const entry = manager.getEntry(next)
		if (
			!entry ||
			entry.id !== next ||
			(entry.parentId !== null && !historyEntryIdSchema.safeParse(entry.parentId).success)
		) {
			historyTruncated = true
			break
		}
		if (entry.type === 'message') {
			const projected = projectRemoteMessage(entry.message, entry.id)
			if (projected) {
				messages.unshift(projected)
				historyTruncated = trimRemoteMessages(messages) || historyTruncated
			}
		}
		next = entry.parentId
	}
	historyTruncated ||= next !== null
	while (messages.length && Buffer.byteLength(JSON.stringify(messages)) > 160 * 1024) {
		evictRemoteMessage(messages)
		historyTruncated = true
	}
	return { messages, historyTruncated }
}

/** The bridge's event preview and manager observation have deliberately separate identities. */
export class RemoteLiveMessageObservation {
	private leaf: string | null | undefined
	private completed: ReturnType<typeof readRemoteLiveMessages> = { messages: [], historyTruncated: false }
	private current: RemoteSnapshot['messages'][number] | null = null
	private disposed = false
	revision = 0
	constructor(private readonly manager: () => HistoryManager | null) {}
	publish(value: unknown, provisional = false): void {
		if (this.disposed) return
		this.current = provisional ? projectRemoteMessage(value, 'current') : null
		this.revision++
	}
	snapshot(): ReturnType<typeof readRemoteLiveMessages> {
		const manager = this.disposed ? null : this.manager()
		if (!manager) {
			this.current = null
			this.leaf = undefined
			this.completed = { messages: [], historyTruncated: false }
			return this.completed
		}
		const leaf = manager.getLeafId()
		if (leaf !== this.leaf) {
			this.completed = readRemoteLiveMessages(manager)
			this.leaf = leaf
			this.revision++
		}
		const messages = this.current ? [...this.completed.messages, this.current] : [...this.completed.messages]
		let historyTruncated = trimRemoteMessages(messages) || this.completed.historyTruncated
		while (messages.length && Buffer.byteLength(JSON.stringify(messages)) > 160 * 1024) {
			evictRemoteMessage(messages)
			historyTruncated = true
		}
		return { messages, historyTruncated }
	}
	dispose(): void {
		this.current = null
		this.completed = { messages: [], historyTruncated: false }
		this.disposed = true
		this.leaf = undefined
	}
}
