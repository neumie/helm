import { StringDecoder } from 'node:string_decoder'
import type { SolverAgent } from './agent.js'

export type ReviewAgentEvent =
	| { type: 'identity'; id: string }
	| { type: 'text'; id: string; text: string; replace: boolean }
	| { type: 'working' }
	| { type: 'complete' }
	| { type: 'error'; message: string }

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const textBlocks = (content: unknown): string =>
	Array.isArray(content)
		? content
				.map(value => {
					const block = object(value)
					return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
				})
				.join('\n')
		: ''

/** Display projection only; tool arguments, commands, credentials and raw diagnostics stay out. */
export function projectReviewEvent(provider: SolverAgent, value: unknown): ReviewAgentEvent[] {
	const record = object(value)
	if (provider === 'claude') {
		if (record.type === 'system' && record.subtype === 'init' && typeof record.session_id === 'string')
			return [{ type: 'identity', id: record.session_id }]
		if (record.type === 'stream_event') {
			const event = object(record.event)
			if (event.type === 'message_start') return [{ type: 'working' }]
			const delta = object(event.delta)
			if (event.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string')
				return [{ type: 'text', id: 'reply', text: delta.text, replace: false }]
		}
		if (record.type === 'assistant') {
			const text = textBlocks(object(record.message).content)
			return text ? [{ type: 'text', id: 'reply', text, replace: true }] : []
		}
		if (record.type === 'result') {
			if (record.is_error === true)
				return [
					{
						type: 'error',
						message:
							'Claude Code could not complete this turn. Check provider authentication or permissions; the request is not replayed.',
					},
				]
			return [
				...(typeof record.result === 'string'
					? [{ type: 'text' as const, id: 'reply', text: record.result, replace: true }]
					: []),
				{ type: 'complete' },
			]
		}
	}
	if (provider === 'codex') {
		if (record.type === 'thread.started' && typeof record.thread_id === 'string')
			return [{ type: 'identity', id: record.thread_id }]
		if (record.type === 'turn.started') return [{ type: 'working' }]
		const item = object(record.item)
		if (record.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string')
			return [{ type: 'text', id: typeof item.id === 'string' ? item.id : 'reply', text: item.text, replace: true }]
		if (record.type === 'turn.completed') return [{ type: 'complete' }]
		if (record.type === 'turn.failed' || record.type === 'error')
			return [
				{
					type: 'error',
					message:
						'Codex could not complete this turn. Check provider authentication or permissions; the request is not replayed.',
				},
			]
	}
	if (provider === 'pi') {
		if (record.type === 'session' && typeof record.id === 'string') return [{ type: 'identity', id: record.id }]
		if (record.type === 'agent_start') return [{ type: 'working' }]
		if (record.type === 'message_update') {
			const event = object(record.assistantMessageEvent)
			if (event.type === 'text_delta' && typeof event.delta === 'string')
				return [{ type: 'text', id: 'reply', text: event.delta, replace: false }]
		}
		if (record.type === 'message_end') {
			const message = object(record.message)
			if (message.role !== 'assistant') return []
			if (message.stopReason === 'error' || message.stopReason === 'aborted')
				return [
					{
						type: 'error',
						message: 'Pi did not complete this turn. Check its provider configuration; the request is not replayed.',
					},
				]
			const text = textBlocks(message.content)
			return text ? [{ type: 'text', id: 'reply', text, replace: true }] : []
		}
		if (record.type === 'agent_end' || record.type === 'agent_settled') return [{ type: 'complete' }]
	}
	return []
}

export class ReviewJsonLines {
	private decoder = new StringDecoder('utf8')
	private pending = ''
	constructor(
		private readonly provider: SolverAgent,
		private readonly publish: (event: ReviewAgentEvent) => void,
	) {}
	push(chunk: Buffer): void {
		this.pending += this.decoder.write(chunk)
		if (this.pending.length > 512 * 1024) throw new Error('Provider event is too large')
		while (true) {
			const newline = this.pending.indexOf('\n')
			if (newline < 0) break
			const line = this.pending.slice(0, newline).replace(/\r$/, '')
			this.pending = this.pending.slice(newline + 1)
			if (!line.trim()) continue
			for (const event of projectReviewEvent(this.provider, JSON.parse(line))) this.publish(event)
		}
	}
	finish(): void {
		const tail = this.decoder.end()
		if (tail) this.pending += tail
		if (this.pending.trim()) this.push(Buffer.from('\n'))
	}
}
