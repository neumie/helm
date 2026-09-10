import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	isRemoteConversationMessage,
	projectRemoteMessage,
	trimRemoteMessages,
} from '../src/remote/message-projection.js'

test('tool calls stay separate from assistant prose, including literal Tool: lines', () => {
	const message = projectRemoteMessage(
		{
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Tool: this is a literal line\n\nI found the problem.' },
				{ type: 'thinking', thinking: 'Inspect the source.' },
				{ type: 'toolCall', name: 'read', arguments: { secret: 'never project arguments' } },
				{ type: 'toolCall', name: 'background_job', arguments: { command: 'private command' } },
			],
		},
		'example',
	)
	assert.deepEqual(message, {
		id: 'example',
		role: 'assistant',
		text: 'Tool: this is a literal line\n\nI found the problem.',
		thinking: 'Inspect the source.',
		toolCalls: 'read\nbackground_job',
		truncated: false,
	})
	assert.equal(JSON.stringify(message).includes('private command'), false)
	assert.equal(JSON.stringify(message).includes('never project arguments'), false)
	assert.equal(projectRemoteMessage({ role: 'assistant', content: 'Tool: a real message' }, 'literal')?.toolCalls, '')
})

test('activity bursts retain ten readable messages within forty ordered previews, including streaming and reverse seed', () => {
	const history = Array.from({ length: 110 }, (_, index) =>
		projectRemoteMessage({ role: index < 10 ? 'assistant' : 'toolResult', content: `Message ${index}` }, String(index)),
	)
	const messages: NonNullable<ReturnType<typeof projectRemoteMessage>>[] = []
	for (const message of history) {
		assert.ok(message)
		messages.push(message)
		trimRemoteMessages(messages)
		assert.ok(messages.length <= 40)
	}
	assert.equal(messages.filter(isRemoteConversationMessage).length, 10)
	assert.deepEqual(
		messages.map(message => Number(message.id)),
		[...Array.from({ length: 10 }, (_, index) => index), ...Array.from({ length: 30 }, (_, index) => index + 80)],
	)
	const seed: typeof messages = []
	for (const message of [...history].reverse()) {
		assert.ok(message)
		seed.unshift(message)
		trimRemoteMessages(seed)
	}
	assert.deepEqual(seed, messages)
	const current = projectRemoteMessage({ role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] }, 'current')
	assert.ok(current)
	const streaming = [...messages, current]
	assert.equal(trimRemoteMessages(streaming), true)
	assert.equal(streaming.length, 40)
	assert.equal(streaming.filter(isRemoteConversationMessage).length, 10)
	assert.equal(streaming.at(-1), current)
	assert.equal(messages.at(-1)?.id, '109', 'streaming projection must not mutate completed evidence')
})

test('tool-only projections have no fake message text and remain bounded', () => {
	const message = projectRemoteMessage(
		{
			role: 'assistant',
			content: Array.from({ length: 101 }, () => ({
				type: 'toolCall',
				name: 'a'.repeat(110),
				arguments: { large: 'ignored' },
			})),
		},
		'tools',
	)
	assert.equal(message?.text, '')
	assert.equal(message?.toolCalls?.length, 8192)
	assert.equal(message?.truncated, true)
	assert.equal(projectRemoteMessage({ role: 'system', content: 'Not a conversation message' }, 'system'), null)
})
