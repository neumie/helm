import type {
	RemoteCommand,
	RemoteDetail,
	RemoteDirectory,
	RemoteReceipt,
	RemoteView,
} from '../../../../src/remote/protocol.js'
import { RemoteAccessError, type RemoteTransport } from './transport.js'

export function createRemoteFixture() {
	const hostEpoch = '10000000-0000-4000-8000-000000000000'
	const views: RemoteView[] = [0, 1].map(index => ({
		target: {
			sessionId: `10000000-0000-4000-8000-00000000000${index + 1}`,
			incarnation: `20000000-0000-4000-8000-00000000000${index + 1}`,
			scopeId: null,
			generation: 1,
		},
		revision: 1,
		label: index === 0 ? 'Helm conversation' : 'Planning conversation',
		workspace: index === 0 ? 'helm' : 'planning',
		model: 'openai-codex/gpt-model',
		activity: 'idle',
		connected: true,
		capabilities: { prompt: true, interrupt: true, answer: false },
		question: null,
		historyTruncated: true,
		// A bounded live window from a 10,000-message source, not 10,000 mounted nodes.
		messages: Array.from({ length: 40 }, (_, offset) => ({
			id: `message-${9960 + offset}`,
			role: offset % 2 ? 'assistant' : 'user',
			text: `Message ${9960 + offset}\n${'A readable conversation with enough detail to exercise wrapping and scrolling. '.repeat(12)}`,
			thinking: offset % 3 ? '' : 'Thinking remains collapsed until requested.',
			truncated: false,
		})),
	}))
	const first = views[0]
	if (!first) throw new Error('Missing fixture session')
	let online = true
	let ambiguous = false
	let revoked = false
	let holdQuestionRefresh = false
	const receipts = new Map<string, RemoteReceipt>()
	const commands: RemoteCommand[] = []
	const assertOnline = () => {
		if (revoked) throw new RemoteAccessError(401)
		if (!online) throw new Error('offline')
	}
	const transport: RemoteTransport = {
		async directory(): Promise<RemoteDirectory> {
			assertOnline()
			return structuredClone({
				protocol: 1,
				hostEpoch,
				sessions: views.map(({ messages: _messages, question: _question, ...summary }) => summary),
			})
		},
		async detail(id): Promise<RemoteDetail> {
			assertOnline()
			const snapshot = views.find(view => view.target.sessionId === id)
			if (!snapshot) throw new RemoteAccessError(404)
			return structuredClone({ protocol: 1, hostEpoch, snapshot, resync: true })
		},
		async send(command) {
			assertOnline()
			const prior = receipts.get(command.commandId)
			if (prior) return prior
			commands.push(structuredClone(command))
			const view = views.find(value => value.target.sessionId === command.target.sessionId)
			if (!view) throw new RemoteAccessError(404)
			if (command.operation.kind === 'prompt')
				view.messages = [
					...view.messages,
					{
						id: command.commandId,
						role: 'user' as const,
						text: command.operation.text,
						thinking: '',
						truncated: false,
					},
				].slice(-40)
			if (command.operation.kind === 'answer' && !holdQuestionRefresh) {
				view.question = null
				view.capabilities.answer = false
				view.activity = 'idle'
			}
			view.revision++
			const receipt: RemoteReceipt = {
				commandId: command.commandId,
				status: command.operation.kind === 'answer' ? 'answered' : 'dispatched',
			}
			receipts.set(command.commandId, receipt)
			if (ambiguous) {
				ambiguous = false
				throw new Error('response lost after dispatch')
			}
			return receipt
		},
		async receipt(command) {
			assertOnline()
			const receipt = receipts.get(command.commandId)
			if (!receipt) throw new RemoteAccessError(404)
			return receipt
		},
	}
	return {
		transport,
		commands,
		setOnline(value: boolean) {
			online = value
		},
		revoke() {
			revoked = true
		},
		loseNextResponse() {
			ambiguous = true
		},
		holdQuestionRefresh() {
			holdQuestionRefresh = true
		},
		clearQuestion() {
			first.question = null
			first.activity = 'idle'
			first.capabilities.answer = false
			first.revision++
		},
		replaceOwner() {
			first.target = { ...first.target, incarnation: crypto.randomUUID() }
			first.revision++
		},

		append(text: string) {
			const view = first
			view.messages = [
				...view.messages.slice(1),
				{ id: crypto.randomUUID(), role: 'assistant' as const, text, thinking: '', truncated: false },
			]
			view.revision++
		},
		ask() {
			const view = first
			view.question = {
				requestId: '30000000-0000-4000-8000-000000000001',
				questions: [
					{
						question: 'Choose an implementation?',
						header: 'Single',
						options: [
							{
								label: 'Keep the owner',
								description: 'Leave Pi in the terminal',
								preview: 'Pi → local host → browser',
							},
							{ label: 'Review options', description: 'Inspect the alternatives' },
						],
					},
					{
						question: 'Which checks?',
						header: 'Multi',
						multiSelect: true,
						options: [
							{ label: 'Desktop', description: 'Wide viewport' },
							{ label: 'Mobile', description: 'Narrow viewport' },
						],
					},
					{
						question: 'Anything else?',
						header: 'Custom',
						options: [
							{ label: 'Continue', description: 'Proceed' },
							{ label: 'Pause', description: 'Wait' },
						],
					},
				],
			}
			view.activity = 'waiting'
			view.capabilities.answer = true
			view.revision++
		},
	}
}
export type RemoteFixture = ReturnType<typeof createRemoteFixture>
