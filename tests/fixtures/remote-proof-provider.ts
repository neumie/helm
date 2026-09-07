import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AssistantMessage, createAssistantMessageEventStream } from '@earendil-works/pi-ai'
// Offline deterministic provider for REAL Pi TUI integration tests, never a production model.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function proofProvider(pi: ExtensionAPI) {
	pi.registerProvider('remote-proof', {
		api: 'openai-completions',
		baseUrl: 'http://127.0.0.1:1',
		apiKey: 'offline-proof-not-a-credential',
		models: [
			{
				id: 'deterministic',
				name: 'Offline proof',
				reasoning: true,
				input: ['text'],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1000,
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream()
			void (async () => {
				const last = context.messages.at(-1)
				const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)
				const output: AssistantMessage = {
					role: 'assistant',
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
					stopReason: 'pending',
				}
				stream.push({ type: 'start', partial: output })
				if (last?.role === 'user' && text.includes('question')) {
					const questions = [
						{
							question: 'Pick one?',
							header: 'Single',
							options: [
								{ label: 'First', description: 'First choice', preview: '**First preview**' },
								{ label: 'Second', description: 'Second choice' },
							],
						},
						{
							question: 'Pick several?',
							header: 'Multi',
							multiSelect: true,
							options: [
								{ label: 'Red', description: 'Red choice' },
								{ label: 'Blue', description: 'Blue choice' },
							],
						},
						{
							question: 'Write your answer?',
							header: 'Custom',
							options: [
								{ label: 'Yes', description: 'Yes choice' },
								{ label: 'No', description: 'No choice' },
							],
						},
					]
					output.content = [
						{
							type: 'toolCall',
							id: randomUUID(),
							name: 'ask_user_question',
							arguments: { questions: text.includes('single') ? questions.slice(0, 1) : questions },
						},
					]
					output.stopReason = 'toolUse'
					stream.push({ type: 'done', reason: 'toolUse', message: output })
					stream.end()
					return
				}
				output.content = [
					{ type: 'thinking', thinking: 'Offline proof thinking' },
					{ type: 'text', text: '' },
				]
				const answer = `Proof reply: ${text}`
				for (const delta of [answer.slice(0, 12), answer.slice(12)]) {
					await new Promise(resolve => setTimeout(resolve, text.includes('slow') ? 1200 : 50))
					if (options?.signal?.aborted) {
						output.stopReason = 'aborted'
						stream.push({ type: 'error', reason: 'aborted', error: output })
						stream.end()
						return
					}
					const block = output.content[1]
					if (block.type === 'text') block.text += delta
					stream.push({ type: 'text_delta', contentIndex: 1, delta, partial: output })
				}
				output.stopReason = 'stop'
				stream.push({ type: 'done', reason: 'stop', message: output })
				stream.end()
			})()
			return stream
		},
	})
	pi.on('session_start', (event, ctx) => {
		pi.setSessionName(`Proof terminal ${process.env.HELM_REMOTE_PROOF_SLOT}`)
		const root = process.env.HELM_REMOTE_PROOF_ROOT
		if (root)
			writeFileSync(
				join(root, `ready-${process.env.HELM_REMOTE_PROOF_SLOT}.json`),
				JSON.stringify({ pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), reason: event.reason }),
				{ mode: 0o600 },
			)
	})
}
