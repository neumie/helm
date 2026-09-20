import type {
	RemoteAccessDocument,
	RemoteCatalogPage,
	RemoteCommand,
	RemoteDetail,
	RemoteDirectory,
	RemoteReceipt,
	RemoteView,
} from '../../../../src/remote/protocol.js'
import { type HistoryFixtureState, createHistoryFixture } from './history-fixture.js'
import { informationFixture } from './information-fixture.js'
import { RemoteAccessError, type RemoteTransport, createRemoteTransport } from './transport.js'

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
		// Two models with different image support, so the picker can be exercised and the
		// image marker means something.
		models: [
			{ provider: 'openai-codex', id: 'gpt-model', label: 'GPT model', image: false },
			{ provider: 'anthropic', id: 'claude-opus-5', label: 'Opus 5', image: true },
		],
		// A model that publishes only some levels, so the effort list is not the full set.
		thinking: { level: 'high' as const, levels: ['low', 'medium', 'high'] as const },
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
	let catalogState: RemoteCatalogPage['state'] = 'ready'
	let catalogDelayMs = 0
	let catalogFailure = false
	let catalogCalls = 0
	let omissions = { malformed: 0, unsupported: 0 }
	let readOnly = false
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
	let informationEnabled = false
	const transport: RemoteTransport = {
		async information(owner) {
			assertOnline()
			if (!informationEnabled) return { version: 1, ...owner, status: 'unavailable', freshForMs: 0, information: null }
			return informationFixture(owner)
		},
		async access(): Promise<RemoteAccessDocument> {
			assertOnline()
			return { hostEpoch, device: { development: true } }
		},
		async catalog(cursor, query): Promise<RemoteCatalogPage> {
			catalogCalls++
			assertOnline()
			if (catalogDelayMs > 0) await new Promise(resolve => setTimeout(resolve, catalogDelayMs))
			if (catalogFailure) throw new Error('fixture catalog failure')
			const offset = cursor ? Number(cursor) : 0
			const rows = Array.from({ length: 120 }, (_, index) => ({
				id: `catalog_${String(index).padStart(32, '0')}`,
				label: index === 0 ? 'Earlier planning conversation' : 'Pi conversation',
				createdAt: 1_700_000_000_000 + index,
				modifiedAt: 1_700_000_000_000 + index,
				messageCount: null,
				hasParent: index % 3 === 0,
				liveness: 'unknown' as const,
				readOnly: true as const,
			})).filter(row => row.label.toLowerCase().includes(query.toLowerCase()))
			return {
				protocol: 1,
				hostEpoch,
				state: catalogState,
				omissions,
				rows: rows.slice(offset, offset + 50),
				pageCursor: String(offset),
				previousCursor: offset > 0 ? String(Math.max(0, offset - 50)) : null,
				nextCursor: offset + 50 < rows.length ? String(offset + 50) : null,
				overlayStamp: 'fixture-overlay',
				reason: null,
			}
		},
		async directory(): Promise<RemoteDirectory> {
			assertOnline()
			return structuredClone({
				protocol: 1,
				hostEpoch,
				overlayStamp: 'fixture-overlay',
				sessions: views.map(({ messages: _messages, question: _question, ...summary }) => ({
					...summary,
					capabilities: readOnly ? { prompt: false, interrupt: false, answer: false } : summary.capabilities,
				})),
			})
		},
		async detail(id): Promise<RemoteDetail> {
			assertOnline()
			const snapshot = views.find(view => view.target.sessionId === id)
			if (!snapshot) throw new RemoteAccessError(404)
			return structuredClone({
				protocol: 1,
				hostEpoch,
				snapshot: {
					...snapshot,
					capabilities: readOnly ? { prompt: false, interrupt: false, answer: false } : snapshot.capabilities,
				},
				resync: true,
			})
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
		enableHistory(count = 440, http = false, state?: HistoryFixtureState, thinkingBoundary = false) {
			// Stories use a display-only service; HTTP acceptance selects the production transport with fixture interception.
			transport.history = http ? createRemoteTransport().history : createHistoryFixture(count, state)
			first.messages = Array.from({ length: 40 }, (_, index) => ({
				id: (count - 39 + index).toString(16).padStart(8, '0'),
				role: 'user' as const,
				text: `Repeated message ${count - 39 + index}`,
				thinking: '',
				truncated: false,
			}))
			const boundary = first.messages[0]
			if (thinkingBoundary && boundary) {
				first.messages[0] = {
					...boundary,
					role: 'assistant',
					text: '',
					thinking: 'Live boundary thinking',
				}
			}
			first.revision++
		},
		showMarkdownExample(includeUnsafe = false) {
			first.historyTruncated = false
			first.messages = [
				{ id: 'markdown-user', role: 'user', text: 'Explain the inspection notes.', thinking: '', truncated: false },
				{
					id: 'markdown-assistant',
					role: 'assistant',
					thinking: 'Compare the checklist with the component hierarchy.',
					truncated: false,
					text: `# Inspection notes\n\n**Checkpoints**, not inventory parts.\n\n- Inspect deformation\n- Check tightness\n\n\`\`\`text\nZdvihová jednotka\n  Převodovka\n    Těsnost\n\`\`\`\n\n| Part | Check |\n| --- | --- |\n| Gearbox | Tightness |\n\n[Reference](https://example.com)${includeUnsafe ? '\n\n<img src="https://example.com/tracker" onerror="alert(1)">\n\n[Unsafe](javascript:alert(1))\n\n![Hidden image](https://example.com/private-tracker.png)' : ''}`,
				},
				{
					id: 'markdown-tool',
					role: 'toolResult',
					text: 'Inspection file found.\nAll checks accounted for.',
					thinking: '',
					truncated: false,
				},
			]
			first.revision++
		},
		showTerminalMetadataExample(name: string | null = null, additionalUnavailable = 0) {
			// Realistic Okena worktree: the Pi session label is a filesystem basename,
			// the parent project, worktree label and checked-out branch are distinct.
			first.label = 'divoka kremrole'
			first.terminal = {
				source: 'okena',
				name,
				project: 'JVS',
				worktree: 'feat/mobile',
				branch: 'docs/mobile-phase-0',
				group: 'Contember',
			}
			first.revision++
			const second = views[1]
			if (second) {
				second.label = 'Pi session'
				second.activity = 'waiting'
				second.terminal = {
					source: 'helm',
					name: 'Remote interface',
					project: null,
					worktree: null,
					branch: null,
					group: 'Workbench',
				}
				second.revision++
				if (!views[2]) {
					views.push({
						...second,
						target: {
							...second.target,
							sessionId: '10000000-0000-4000-8000-000000000003',
							incarnation: '20000000-0000-4000-8000-000000000003',
							scopeId: null,
						},
						label: 'Pi session',
						workspace: 'release-workspace-with-a-long-name-for-readability-suffix-z9',
						model: 'anthropic/claude-sonnet',
						activity: 'working',
						terminal: undefined,
						messages: second.messages.map(message => ({ ...message })),
					})
				}
			}
			const unavailable = views[2]
			const extraWorkspaces = [
				'neumie-divoka-kremrole',
				'helm-item-znaceni-procesu-a-prace-s-nimi-c31c0',
				'feat-add-consumable-components',
			]
			if (unavailable && additionalUnavailable > 0) {
				for (const [index, workspace] of extraWorkspaces.slice(0, additionalUnavailable).entries()) {
					const suffix = String(index + 4).padStart(12, '0')
					views.push({
						...unavailable,
						target: {
							...unavailable.target,
							sessionId: `10000000-0000-4000-8000-${suffix}`,
							incarnation: `20000000-0000-4000-8000-${suffix}`,
							scopeId: null,
						},
						workspace,
						messages: unavailable.messages.map(message => ({ ...message })),
					})
				}
			}
		},
		setTerminalMetadata(enabled: boolean) {
			if (enabled) {
				first.label = 'divoka kremrole'
				first.terminal = {
					source: 'okena',
					name: null,
					project: 'JVS',
					worktree: 'feat/mobile',
					branch: 'docs/mobile-phase-0',
					group: 'Contember',
				}
			} else {
				first.label = 'Helm conversation'
				first.terminal = undefined
			}
		},
		setModel(value: string | null) {
			first.model = value
		},
		changeTerminalSource(source: 'okena' | 'helm' | null) {
			const terminal = first.terminal
			first.terminal = source
				? {
						...terminal,
						source,
						project: terminal?.project ?? null,
						worktree: terminal?.worktree ?? null,
						branch: terminal?.branch ?? null,
						name: terminal?.name ?? null,
						group: terminal?.group ?? null,
					}
				: undefined
			// Deliberately leave revision unchanged: source metadata is its own authority.
		},
		showThinkingMatrix() {
			first.historyTruncated = false
			first.messages = [
				{ id: 'thinking-user', role: 'user', text: 'Inspect this.', thinking: '', truncated: false },
				{
					id: 'thinking-structured',
					role: 'assistant',
					text: 'Structured reply',
					toolCalls: 'read',
					thinking: '<b>literal</b>\n![not an image](https://example.com/x)',
					truncated: false,
				},
				{
					id: 'thinking-legacy',
					role: 'assistant',
					text: '\nTool: background_job',
					thinking: 'Legacy reasoning survives.',
					truncated: false,
				},
				{
					id: 'thinking-prose',
					role: 'assistant',
					text: 'Ordinary prose with\nTool: not_a_tool\ninside it.',
					thinking: '  padded\nlong reasoning '.repeat(32),
					truncated: false,
				},
				{ id: 'thinking-tool', role: 'toolResult', text: 'Hidden tool output', thinking: '', truncated: false },
			]
			first.revision++
		},
		showChainedExample() {
			first.historyTruncated = false
			first.messages = [
				{ id: 'chain-user', role: 'user', text: 'Check the implementation.', thinking: '', truncated: false },
				{
					id: 'chain-start',
					role: 'assistant',
					text: 'I’ll check the implementation.',
					toolCalls: 'read',
					thinking: '',
					truncated: false,
				},
				{
					id: 'chain-thinking',
					role: 'assistant',
					text: '',
					thinking: 'Compare the existing behavior.',
					truncated: false,
				},
				{ id: 'chain-call', role: 'assistant', text: '\nTool: background_job', thinking: '', truncated: false },
				{ id: 'chain-tool', role: 'toolResult', text: 'Checks passed.', thinking: '', truncated: false },
				{ id: 'chain-done', role: 'assistant', text: 'The implementation is ready.', thinking: '', truncated: false },
			]
			first.revision++
		},
		setCatalogOmissions(value: RemoteCatalogPage['omissions']) {
			omissions = value
		},
		setCatalogState(value: RemoteCatalogPage['state']) {
			catalogState = value
		},
		setCatalogDelay(value: number) {
			catalogDelayMs = Math.max(0, value)
		},
		setCatalogFailure(value: boolean) {
			catalogFailure = value
		},
		catalogCallCount() {
			return catalogCalls
		},
		enableInformation() {
			informationEnabled = true
		},
		useProductionInformationTransport() {
			transport.information = createRemoteTransport().information
		},
		transport,
		commands,
		/** Exposed so a test can model a bridge that omits a field rather than empties it. */
		views,
		addScopedSession() {
			for (const session of views.slice(1))
				session.target = { ...session.target, scopeId: '40000000-0000-4000-8000-000000000001' }
		},
		showComposerExample() {
			first.label = 'Refining the conversation'
			first.model = 'Claude Sonnet'
			first.activity = 'working'
			first.historyTruncated = false
			first.messages = [
				{
					role: 'user' as const,
					text: 'Make this feel like a conversation, not a settings form. The controls should get out of the way.',
				},
				{
					role: 'assistant' as const,
					text: 'I’ll bring the message and its actions into one writing surface. Delivery mode can stay quietly in the corner, and interrupt belongs with the running conversation—not beside every message.',
				},
				{ role: 'user' as const, text: 'And when I scroll back, don’t push everything around just to show a button.' },
				{
					role: 'assistant' as const,
					text: 'The latest-message control will float over the bottom of the chat. It won’t take a row or move what you’re reading. Your position stays anchored as new messages arrive.',
				},
				{ role: 'user' as const, text: 'Does changing delivery mode affect a message I already sent?' },
				{
					role: 'assistant' as const,
					text: 'No. That choice belongs to the next message. Anything already sent keeps its original delivery mode and receipt. If delivery is uncertain, the interface still asks you to check before sending again.',
				},
				{ role: 'user' as const, text: 'Keep it restrained. It should still feel like Helm.' },
				{
					role: 'assistant' as const,
					text: 'One quiet writing surface. A small delivery menu. One clear send action.\n\nI’m checking the narrow layout and keyboard behavior now. Your existing conversation and unsent draft stay exactly where they belong.',
				},
			].map((message, index) => ({ ...message, id: `preview-${index}`, thinking: '', truncated: false }))
		},
		setReadOnly(value: boolean) {
			readOnly = value
		},
		setConnected(value: boolean) {
			first.connected = value
		},
		setActivity(value: RemoteView['activity']) {
			// Activity is an independent observed field, not a message revision or local send state.
			first.activity = value
		},
		showTerminalDialog() {
			first.question = null
			first.activity = 'waiting'
		},
		restoreAccess() {
			revoked = false
		},
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
		replaceQuestion() {
			if (!first.question) return
			first.question = { ...first.question, requestId: crypto.randomUUID() }
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

/** Workbench-only pairing service. It mounts the production entry, never real HTTP auth. */
export function createRemoteEntryFixture(qr = false, authenticated = false, unavailable = false) {
	const workspace = createRemoteFixture()
	let authorized = authenticated
	let accessUnavailable = unavailable
	let transportCreations = 0
	const requests: Array<{
		input: { code?: string; qrCapability?: string }
		signal: AbortSignal
		resolve(): void
		reject(): void
	}> = []
	const fixture = {
		takeFragment: () => (qr ? 'workbench-one-time-fragment' : null),
		createTransport() {
			transportCreations++
			return {
				...workspace.transport,
				async access(signal: AbortSignal) {
					if (accessUnavailable) throw new RemoteAccessError(503)
					if (!authorized) throw new RemoteAccessError(401)
					return workspace.transport.access(signal)
				},
			}
		},
		pair(input: { code?: string; qrCapability?: string }, signal: AbortSignal) {
			return new Promise<void>((resolve, reject) => {
				requests.push({
					input,
					signal,
					resolve() {
						authorized = true
						workspace.restoreAccess()
						resolve()
					},
					reject() {
						reject(new RemoteAccessError(401))
					},
				})
			})
		},
	}
	return {
		fixture,
		workspace,
		requests,
		transportCreations: () => transportCreations,
		setAccessUnavailable(value: boolean) {
			accessUnavailable = value
		},
	}
}
export type RemoteEntryTestFixture = ReturnType<typeof createRemoteEntryFixture>
