import type { RemoteSnapshot } from './protocol.js'

type Message = RemoteSnapshot['messages'][number]
export const REMOTE_CONVERSATION_RESERVE = 10

export function isRemoteConversationMessage(message: Message): boolean {
	return message.role === 'user' || (message.role === 'assistant' && !!message.text.trim())
}

/** Prefer dropping old activity once only ten conversation messages remain. Ordering is unchanged. */
export function evictRemoteMessage(messages: Message[]): void {
	const protectedContext = messages.filter(isRemoteConversationMessage).length <= REMOTE_CONVERSATION_RESERVE
	const activity = protectedContext ? messages.findIndex(message => !isRemoteConversationMessage(message)) : -1
	messages.splice(activity < 0 ? 0 : activity, 1)
}

/** Same 40-entry ceiling for seed, completed and streaming projections. */
export function trimRemoteMessages(messages: Message[]): boolean {
	const dropped = messages.length > 40
	while (messages.length > 40) evictRemoteMessage(messages)
	return dropped
}

/** Bounded Pi message projection; tool calls are evidence, never conversation prose or executable requests. */
export function projectRemoteMessage(value: unknown, id: string): RemoteSnapshot['messages'][number] | null {
	if (!value || typeof value !== 'object') return null
	const message = value as { role?: string; content?: unknown }
	if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') return null
	let text = ''
	let thinking = ''
	let toolCalls = ''
	let truncated = false
	if (typeof message.content === 'string') {
		text = message.content.slice(0, 8192)
		truncated = message.content.length > 8192
	} else if (Array.isArray(message.content)) {
		truncated = message.content.length > 100
		for (const block of message.content.slice(0, 100)) {
			if (!block || typeof block !== 'object') continue
			if (block.type === 'text' && typeof block.text === 'string') {
				truncated ||= text.length + block.text.length > 8192
				text = (text + block.text.slice(0, 8192)).slice(0, 8192)
			}
			if (block.type === 'thinking' && typeof block.thinking === 'string') {
				truncated ||= thinking.length + block.thinking.length > 8192
				thinking = (thinking + block.thinking.slice(0, 8192)).slice(0, 8192)
			}
			if (block.type === 'toolCall' && typeof block.name === 'string') {
				const call = `${toolCalls ? '\n' : ''}${block.name.slice(0, 100)}`
				truncated ||= toolCalls.length + call.length > 8192 || block.name.length > 100
				toolCalls = (toolCalls + call).slice(0, 8192)
			}
			if (block.type === 'image') text = `${text}\n[Image not included in this proof]`.slice(0, 8192)
		}
	}
	// Presence distinguishes structured evidence from legacy Tool: name text.
	return { id, role: message.role, text, thinking, toolCalls, truncated }
}
