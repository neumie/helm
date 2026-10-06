import type { ReviewApi, ReviewDraft, ReviewRequest, ReviewSession, ReviewState } from '../../document-review/types'
import { defaultReviewDraft } from '../../document-review/types'

const revision = (n: number) => n.toString(16).padStart(64, '0')
export const reviewFixtureText = `# Collaborative specification\n\nRead the actual document, refine a passage, and keep the wider conversation beside it.\n\n## Dispatch guarantees\n\nThe selected owner must remain exact. A **rendered quote** is not a Markdown offset.\n\n| Operation | Evidence |\n| --- | --- |\n| Discuss | No file edits requested |\n| Change | Read the actual file first |\n\n\`\`\`ts\nconst sameConversation = true\n\`\`\`\n\n<img src="https://never-fetch.invalid/private.png" onerror="alert(1)">\n\n${Array.from(
	{ length: 500 },
	(_, i) =>
		`### Requirement ${i + 1}\n\nThis is complete repository Markdown for a substantial specification. Preserve the operator’s exact conversation, the document revision, and the selected source block. Unicode 🐝 and **ordinary formatting** remain readable.\n\n`,
).join('')}## Final acceptance\n\nFinal acceptance sentinel: nothing truncated.\n`
const editorialText = `# A calmer workspace

A document should be easy to read before it asks you to configure anything. This proposal brings the important decisions closer to the text and keeps the supporting information within reach.

## Start with the document

Leave room for the reader to follow an idea across several paragraphs. The conversation sits alongside the document, ready for a question, a second opinion, or a precise change request.

A useful review does not need to interrupt the reading rhythm. Select a passage when a detail deserves attention, or ask about the document as a whole from the same writing surface.

## Keep the next step clear

Discuss asks the original agent to respond without requesting edits. Change asks it to work on the actual file. Both keep the existing conversation and its permissions; Helm does not create a replacement session.

The file remains the source of truth. If it changes while you are reading, an old selection is marked stale rather than silently moved. Your unsent thoughts stay in the editor.

## Make room for refinement

Supporting details are available when needed, not repeated above every conversation. Comments can stay local until you choose to send them, and a delivery receipt never stands in for evidence of a finished edit.
`
export type ReviewFixtureScenario =
	| 'normal'
	| 'light'
	| 'working'
	| 'missing'
	| 'uncertain'
	| 'comments'
	| 'stale'
	| 'changes'
	| 'save-failure'
	| 'no-agent'
	| 'not-listening'
	| 'editorial'
	| 'editorial-light'
export function createReviewFixture(scenario: ReviewFixtureScenario = 'normal') {
	const listeners = new Set<() => void>()
	const requests: ReviewRequest[] = []
	let saved = 0
	let sends = 0
	const session: ReviewSession = {
		id: 'review:11111111-1111-4111-8111-111111111111',
		owner: '22222222-2222-4222-8222-222222222222',
		provider: 'claude',
		capabilities: {
			transport: 'tool-return',
			continuation: 'live-session',
			readOnlyPolicy: 'session-owned',
			interactiveQuestions: true,
			interrupt: 'unsupported',
			providerAcknowledgement: false,
			minimumVersion: null,
		},
		name: 'Claude Code · specification',
		state: scenario === 'working' ? 'working' : scenario === 'uncertain' ? 'error' : 'idle',
		listening: !['working', 'uncertain', 'not-listening'].includes(scenario),
		busy: scenario === 'working',
		needsAcknowledgement: scenario === 'uncertain',
		messages: [
			{ id: 'a', role: 'user', text: 'Let’s refine the dispatch contract.' },
			{
				id: 'b',
				role: 'assistant',
				text: 'The source locator should identify the containing Markdown block. If the file changes, we should re-read before proposing an edit.',
			},
		],
		error:
			scenario === 'uncertain'
				? 'The last request did not confirm completion. Inspect the document before continuing.'
				: null,
		historyTruncated: false,
	}
	const editorial = scenario === 'editorial' || scenario === 'editorial-light'
	if (editorial) {
		session.provider = 'pi'
		session.name = 'Workspace reading and conversation — an intentionally long original Pi session name'
		session.messages = []
	}
	const draft = defaultReviewDraft()
	draft.sessionId = scenario === 'no-agent' ? null : session.id
	draft.theme = scenario === 'light' || scenario === 'editorial-light' ? 'light' : 'dark'
	if (scenario === 'comments' || scenario === 'stale')
		draft.annotations = [
			{
				id: 'comment-1',
				passage: {
					revision: revision(scenario === 'stale' ? 0 : 1),
					start: 0,
					end: 30,
					source: reviewFixtureText.slice(0, 30),
					quote: 'Collaborative specification',
					kind: 'block',
				},
				note: 'Keep the document as the hero.',
				intent: 'discuss',
				resolved: false,
			},
		]
	const state: ReviewState = {
		document: {
			id: '33333333-3333-4333-8333-333333333333',
			name: 'spec.md',
			relativePath: 'docs/plans/review/spec.md',
			text: editorial ? editorialText : reviewFixtureText,
			revision: revision(1),
			previous: scenario === 'changes' ? reviewFixtureText.replace('A **rendered quote**', 'A rendered quote') : null,
			error:
				scenario === 'missing' ? 'Document unavailable. It may have moved, been deleted, or lost permission.' : null,
		},
		sessions: scenario === 'no-agent' ? [] : [session],
		draft,
	}
	const scoped = new Map<string, ReviewDraft>()
	const receipts = new Map<string, { id: string; outcome: 'dispatched' | 'unknown'; detail: string }>()
	let generation = 0
	const publish = () => {
		for (const listener of listeners) listener()
	}
	const api: ReviewApi = {
		load: async () => ({ data: structuredClone(state) }),
		selectSession: async id => {
			scoped.set(state.draft.sessionId ?? '', structuredClone(state.draft))
			state.draft = { ...structuredClone(scoped.get(id ?? '') ?? defaultReviewDraft()), sessionId: id }
			return { data: structuredClone(state.draft) }
		},
		save: async draft => {
			if (scenario === 'save-failure')
				return { error: 'Saved drafts are unavailable. Retry or discard only unsaved changes.' }
			saved++
			state.draft = structuredClone(draft)
			scoped.set(draft.sessionId ?? '', structuredClone(draft))
			return { data: true }
		},
		send: async request => {
			sends++
			const owner = state.sessions.find(owner => owner.id === request.sessionId && owner.owner === request.owner)
			if (!owner || !owner.listening || owner.busy || request.revision !== state.document.revision)
				return { error: 'The document or conversation changed before sending.' }
			const original = receipts.get(request.id)
			if (original) return { data: original }
			requests.push(structuredClone(request))
			owner.busy = true
			owner.listening = false
			owner.state = 'working'
			owner.messages.push({ id: request.id, role: 'user', text: request.instruction })
			const captured = generation
			const receipt = {
				id: request.id,
				outcome: 'dispatched' as const,
				detail: 'Fixture dispatch only; not live-provider certification.',
			}
			receipts.set(request.id, receipt)
			publish()
			await new Promise(resolve => setTimeout(resolve, 100))
			if (captured !== generation)
				return { error: 'The conversation owner changed before delivery could be confirmed.' }
			return { data: receipt }
		},
		interrupt: async (id, owner) => {
			const selected = state.sessions.find(s => s.id === id && s.owner === owner)
			if (selected) {
				selected.busy = false
				selected.state = 'error'
				selected.error = 'Interrupted. Inspect the document before continuing.'
			}
			publish()
			return { data: true }
		},
		acknowledge: async (id, owner) => {
			const selected = state.sessions.find(s => s.id === id && s.owner === owner)
			if (!selected || selected.busy) return { error: 'Wait for settlement.' }
			selected.error = null
			selected.state = 'idle'
			publish()
			return { data: true }
		},
		receipt: async id => ({ data: receipts.get(id) ?? null }),
		retryDocument: async () => {
			state.document.error = null
			publish()
			return { data: true }
		},
		dirty: () => {},
		onCloseRequested: () => () => {},
		close: () => {},
		onChanged: listener => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
	return {
		api,
		requests,
		/** Display fixture enrollment stands in for an external CLI/native connection, never UI creation. */
		connect: (provider: ReviewSession['provider'] = 'pi') => {
			const next: ReviewSession = {
				...structuredClone(session),
				id: `review:${crypto.randomUUID()}`,
				owner: crypto.randomUUID(),
				provider,
				name: `${provider} · original session`,
				listening: true,
				busy: false,
				messages: [],
				error: null,
				needsAcknowledgement: false,
				state: 'idle',
			}
			state.sessions.push(next)
			publish()
			return next.id
		},
		disconnect: () => {
			for (const owner of state.sessions) {
				owner.listening = false
				owner.state = 'disconnected'
			}
			publish()
		},
		stats: () => ({ saved, sends, listeners: listeners.size }),
		edit: (text = `${state.document.text}\nExternal edit sentinel.\n`) => {
			state.document.previous = state.document.text
			state.document.text = text
			state.document.revision = revision(Number.parseInt(state.document.revision, 16) + 1)
			publish()
		},
		settle: (unknown = false) => {
			for (const owner of state.sessions)
				if (owner.busy) {
					owner.busy = false
					owner.listening = !unknown
					owner.needsAcknowledgement = unknown
					owner.state = unknown ? 'error' : 'idle'
					owner.error = unknown ? 'Provider completion is unknown. Inspect the document.' : null
					if (!unknown)
						owner.messages.push({
							id: crypto.randomUUID(),
							role: 'assistant',
							text: 'This is a fixture reply to the chosen request.',
						})
				}
			if (unknown) for (const [id, receipt] of receipts) receipts.set(id, { ...receipt, outcome: 'unknown' })
			publish()
		},
		replaceOwner: () => {
			generation++
			state.sessions[0] = { ...session, owner: crypto.randomUUID(), busy: false }
			publish()
		},
		dispose: () => {
			generation++
			listeners.clear()
		},
	}
}
