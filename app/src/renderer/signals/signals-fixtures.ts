// Signals review fixtures (Views / Signals): SignalThread rows, a dock snapshot and in-memory fakes of
// the column's services, so stories and browser tests drive the PRODUCTION column. Nothing here
// polls GitHub, Mail or Okena, and nothing is imported by production renderer code.

import type { AgentDockPromptRequest, AgentDockSnapshot, DockSession } from '../../agent-dock/model'
import type { SignalNewAgentRequest, SignalOkenaProject, SignalsBridgeState } from '../../shared'
import type {
	SignalFilteredEntry,
	SignalSourceHealth,
	SignalThread,
	SignalUpdate,
	SignalsSnapshot,
} from '../../shared-helm'
import { nextWeekdayMorning } from './model'
import type { DockService, SignalsService } from './services'

const MINUTE = 60_000
const iso = (at: number): string => new Date(at).toISOString()

type ThreadSeed = Partial<SignalThread> &
	Pick<SignalThread, 'id' | 'threadKey' | 'source' | 'kind' | 'ref' | 'fullRef' | 'title' | 'head'> & {
		/** Minutes before `now` of the latest foreign activity. */
		ago: number
	}

function thread(seed: ThreadSeed, now: number): SignalThread {
	const { ago, ...rest } = seed
	const at = iso(now - ago * MINUTE)
	return {
		reasons: [seed.kind],
		actor: null,
		url: null,
		repo: null,
		number: null,
		branch: null,
		state: 'new',
		owner: 'jakub',
		snoozedUntil: null,
		lastActivityAt: at,
		active: true,
		closedReason: null,
		note: null,
		noteAt: null,
		managedBy: null,
		routedAgent: null,
		routedHow: null,
		routedAt: null,
		createdAt: at,
		updatedAt: at,
		...rest,
	}
}

/** The threads every Signals story shows. Handles other than matej21 are illustrative. */
export function signalThreadFixtures(now = Date.now()): SignalThread[] {
	return [
		thread(
			{
				id: 311,
				threadKey: 'github:contember/okena#311',
				source: 'github',
				kind: 'review',
				ref: 'okena#311',
				fullRef: 'contember/okena#311',
				title: 'Claude dialogs answered in the terminal stay listed',
				head: 'review requested · matej21',
				actor: 'matej21',
				url: 'https://github.com/contember/okena/pull/311',
				repo: 'contember/okena',
				number: 311,
				branch: 'fix/dialog-listed-after-answer',
				ago: 8,
			},
			now,
		),
		thread(
			{
				id: 970,
				threadKey: 'github:contember-external/crane-rental#970',
				source: 'github',
				kind: 'comments',
				reasons: ['comments', 'ci'],
				ref: 'crane-rental#970',
				fullRef: 'contember-external/crane-rental#970',
				title: 'Offer PDF export',
				head: '2 comments · lukas-h',
				actor: 'lukas-h',
				url: 'https://github.com/contember-external/crane-rental/pull/970',
				repo: 'contember-external/crane-rental',
				number: 970,
				branch: 'feat/offer-pdf-export',
				ago: 23,
			},
			now,
		),
		thread(
			{
				id: 42,
				threadKey: 'sentry:PSYON-ADMIN-3F2',
				source: 'mail',
				kind: 'sentry',
				ref: 'PSYON-ADMIN-3F2',
				fullRef: 'Sentry <alerts@sentry.io>',
				title: "TypeError: Cannot read properties of undefined (reading 'slots')",
				head: "TypeError: Cannot read properties of undefined (reading 'slots')",
				actor: 'Sentry',
				url: 'message://%3Calert-3f2%40sentry.io%3E',
				ago: 64,
			},
			now,
		),
		thread(
			{
				id: 43,
				threadKey: 'mail:5f1c0e9d2a7b4c11',
				source: 'mail',
				kind: 'mail',
				ref: 'Psyon',
				fullRef: 'Klára D. <klara@psyon.example>',
				title: 'Nefunguje export rezervací do Excelu',
				head: 'Nefunguje export rezervací do Excelu',
				actor: 'Klára D.',
				url: 'message://%3Cexport-rezervaci%40psyon.example%3E',
				state: 'seen',
				routedAgent: 'reservations-export',
				routedHow: 'sent',
				routedAt: iso(now - 3 * MINUTE),
				ago: 182,
			},
			now,
		),
		thread(
			{
				id: 304,
				threadKey: 'github:contember/okena#304',
				source: 'github',
				kind: 'review',
				ref: 'okena#304',
				fullRef: 'contember/okena#304',
				title: 'Claude dialog answered in terminal',
				head: 'changes requested · matej21',
				actor: 'matej21',
				url: 'https://github.com/contember/okena/pull/304',
				repo: 'contember/okena',
				number: 304,
				branch: 'fix/claude-dialog-answered-in-terminal',
				state: 'seen',
				owner: 'managed',
				managedBy: 'claude-dialog-answered-in-terminal',
				note: 'round 2 · pushed 7c1e0b2 · CI passing',
				noteAt: iso(now - 14 * MINUTE),
				ago: 52,
			},
			now,
		),
		thread(
			{
				id: 44,
				threadKey: 'mail:9a0b3c7d1e2f4a55',
				source: 'mail',
				kind: 'mail',
				ref: 'JVS',
				fullRef: 'Pavel Š. <pavel@jvs.example>',
				title: 'Re: Import ceníku do e-shopu',
				head: 'Re: Import ceníku do e-shopu · 3 messages',
				actor: 'Pavel Š.',
				url: 'message://%3Cimport-ceniku%40jvs.example%3E',
				state: 'seen',
				owner: 'managed',
				managedBy: 'pricelist-import',
				note: 'reply drafted in Mail',
				noteAt: iso(now - 41 * MINUTE),
				ago: 95,
			},
			now,
		),
		thread(
			{
				id: 45,
				threadKey: 'mail:77aa01bc9d3e4f20',
				source: 'mail',
				kind: 'mail',
				ref: 'Hetzner',
				fullRef: 'Hetzner Online <noreply@hetzner.example>',
				title: 'Plánovaná údržba 14. 11.',
				head: 'Plánovaná údržba 14. 11.',
				actor: 'Hetzner Online',
				url: 'message://%3Cudrzba%40hetzner.example%3E',
				state: 'snoozed',
				snoozedUntil: nextWeekdayMorning(now).toISOString(),
				ago: 300,
			},
			now,
		),
		thread(
			{
				id: 298,
				threadKey: 'github:contember/okena#298',
				source: 'github',
				kind: 'review',
				ref: 'okena#298',
				fullRef: 'contember/okena#298',
				title: 'Stream reconnect backoff',
				head: 'review requested · matej21',
				actor: 'matej21',
				url: 'https://github.com/contember/okena/pull/298',
				repo: 'contember/okena',
				number: 298,
				state: 'done',
				active: false,
				closedReason: 'no longer open or requested',
				updatedAt: iso(now - 140 * MINUTE),
				ago: 300,
			},
			now,
		),
		thread(
			{
				id: 965,
				threadKey: 'github:contember-external/crane-rental#965',
				source: 'github',
				kind: 'comments',
				ref: 'crane-rental#965',
				fullRef: 'contember-external/crane-rental#965',
				title: 'Rental calendar sync',
				head: '1 comment · lukas-h',
				actor: 'lukas-h',
				url: 'https://github.com/contember-external/crane-rental/pull/965',
				repo: 'contember-external/crane-rental',
				number: 965,
				state: 'done',
				updatedAt: iso(now - 200 * MINUTE),
				ago: 260,
			},
			now,
		),
	]
}

export function signalSourcesFixture(
	now = Date.now(),
	mail: SignalSourceHealth['status'] = 'ok',
): SignalSourceHealth[] {
	return [
		{ source: 'github', status: 'ok', detail: null, lastPollAt: iso(now - MINUTE), lastOkAt: iso(now - MINUTE) },
		{
			source: 'mail',
			status: mail,
			detail:
				mail === 'needs_permission'
					? 'Allow node to control Mail in System Settings › Privacy & Security › Automation'
					: null,
			lastPollAt: iso(now - MINUTE),
			lastOkAt: mail === 'ok' ? iso(now - MINUTE) : null,
		},
	]
}

function session(
	partial: Partial<DockSession> & Pick<DockSession, 'terminalId' | 'project' | 'name' | 'status'>,
	now: number,
): DockSession {
	return {
		key: `okena-default:${partial.terminalId}`,
		source: 'okena',
		profile: 'okena-default',
		since: now - 4 * MINUTE,
		observedAt: now,
		subagents: 0,
		backgroundTasks: 0,
		backgroundShells: 0,
		queuedPrompts: 0,
		prLinks: [],
		hasTranscript: true,
		hooksAttached: true,
		channelAttached: false,
		sessionId: `session-${partial.terminalId}`,
		lastMessage: { uuid: `message-${partial.terminalId}`, text: 'Done.', at: now - 4 * MINUTE, seen: true },
		...partial,
	}
}

/** Agents the dock sees: the PR's own agent (idle), a busy one in the same repo, others. */
export function signalsDockFixture(now = Date.now()): AgentDockSnapshot {
	const health = { state: 'ok' as const, since: now - 60 * MINUTE, lastObservedAt: now }
	return {
		generatedAt: now,
		source: health,
		sources: { okena: health },
		items: [],
		sessions: [
			session(
				{
					terminalId: 't-offer',
					project: 'offer-pdf-export',
					repo: 'crane-rental',
					name: 'offer-pdf-export',
					branch: 'feat/offer-pdf-export',
					status: 'idle',
					prLinks: [
						{
							number: 970,
							url: 'https://github.com/contember-external/crane-rental/pull/970',
							repository: 'contember-external/crane-rental',
						},
					],
				},
				now,
			),
			session(
				{
					terminalId: 't-calendar',
					project: 'rental-calendar-sync',
					repo: 'crane-rental',
					name: 'rental-calendar-sync',
					branch: 'feat/rental-calendar-sync',
					status: 'working',
				},
				now,
			),
			session(
				{
					terminalId: 't-dialog',
					project: 'claude-dialog-answered-in-terminal',
					repo: 'okena',
					name: 'claude-dialog-answered-in-terminal',
					branch: 'fix/claude-dialog-answered-in-terminal',
					status: 'working',
					prLinks: [{ number: 304, url: 'https://github.com/contember/okena/pull/304', repository: 'contember/okena' }],
				},
				now,
			),
			session({ terminalId: 't-okena', project: 'okena', name: 'okena', branch: 'main', status: 'idle' }, now),
			session(
				{
					terminalId: 't-pricelist',
					project: 'pricelist-import',
					repo: 'jvs-eshop',
					name: 'pricelist-import',
					branch: 'feat/pricelist-import',
					status: 'idle',
				},
				now,
			),
			session(
				{
					terminalId: 't-reservations',
					project: 'reservations-export',
					repo: 'psyon-admin',
					name: 'reservations-export',
					branch: 'fix/reservations-export',
					status: 'idle',
				},
				now,
			),
		],
	}
}

/** Mail the rules kept out (heads only), newest first. Senders are illustrative. */
export function signalFilteredFixtures(now = Date.now()): SignalFilteredEntry[] {
	const entry = (
		id: number,
		ago: number,
		seed: Pick<SignalFilteredEntry, 'senderName' | 'senderAddress' | 'subject' | 'reason'> &
			Partial<SignalFilteredEntry>,
	): SignalFilteredEntry => ({
		source: 'mail',
		senderIdentity: seed.senderAddress,
		mailbox: null,
		url: `message://%3Cfiltered-${id}%40mail.example%3E`,
		receivedAt: iso(now - ago * MINUTE),
		lastSeenAt: iso(now - MINUTE),
		id,
		...seed,
	})
	return [
		entry(8, 12, {
			senderName: 'Petra Nováková',
			senderAddress: 'petra@psyon.example',
			subject: 'Re: Dovolená do 14. 11.',
			reason: 'auto-reply',
		}),
		entry(7, 40, {
			senderName: 'Contember',
			senderAddress: 'news@contember.example',
			subject: 'What shipped in October',
			reason: 'newsletter',
		}),
		entry(6, 95, {
			senderName: 'Fakturoid',
			senderAddress: 'info@fakturoid.example',
			subject: 'Nové funkce pro listopad',
			reason: 'campaign',
			mailbox: 'Clientcare',
		}),
		entry(5, 180, {
			senderName: '',
			senderAddress: 'deals@shop.example',
			subject: 'Last chance: 40 % off',
			reason: 'junk',
		}),
		entry(4, 600, {
			senderName: 'Build bot',
			senderAddress: 'ci@builds.example',
			subject: 'Nightly build finished',
			reason: 'excluded',
		}),
	]
}

export const OKENA_PROJECTS_FIXTURE: SignalOkenaProject[] = [
	{ id: 'p-crane', name: 'crane-rental', repo: 'contember-external/crane-rental' },
	{ id: 'p-okena', name: 'okena', repo: 'contember/okena' },
	{ id: 'p-psyon', name: 'psyon-admin', repo: 'psyon/psyon-admin' },
	{ id: 'p-jvs', name: 'jvs-eshop', repo: null },
]

/** Every effect a story's column asked for (browser tests read them from `window.__signalsFixture`). */
export interface SignalsFixtureCalls {
	updates: Array<{ id: number; patch: SignalUpdate }>
	routed: Array<{ id: number; agent: string; how: string }>
	opened: string[]
	prompts: AgentDockPromptRequest[]
	okenaProjects: Array<string | null>
	newAgents: SignalNewAgentRequest[]
	/** Filtered-mail ids `i` asked to always show. */
	includes: number[]
}

/** The routing effects a browser test can hold in flight (`newAgent`: the Okena start, `prompt`: the dock send). */
export type SignalsHeldEffect = 'newAgent' | 'prompt'

export interface SignalsFixture {
	service: SignalsService
	dock: DockService
	calls: SignalsFixtureCalls
	/** Browser tests only: later calls of this effect wait (recorded at once) until `release`. */
	hold(effect: SignalsHeldEffect): void
	/** Lets every waiting call of this effect finish, and stops holding it. */
	release(effect: SignalsHeldEffect): void
}

export interface SignalsFixtureOptions {
	threads?: SignalThread[]
	sources?: SignalSourceHealth[]
	/** null: the agent dock has not pushed a snapshot (no agent listed). */
	dock?: AgentDockSnapshot | null
	now?: () => number
	/** Mail the rules kept out; default `signalFilteredFixtures`, `[]` for none. */
	filtered?: SignalFilteredEntry[]
}

/**
 * In-memory column services: updates apply like the daemon's store (state/owner/snooze rules, routed
 * receipts) and push a new snapshot, as main does after a re-read.
 */
export function createSignalsFixture(options: SignalsFixtureOptions = {}): SignalsFixture {
	const clock = options.now ?? Date.now
	const start = clock()
	let threads = (options.threads ?? signalThreadFixtures(start)).map(entry => ({ ...entry }))
	const sources = options.sources ?? signalSourcesFixture(start)
	let filtered = (options.filtered ?? signalFilteredFixtures(start)).map(entry => ({ ...entry }))
	const included: string[] = []
	let seq = 1
	const listeners = new Set<() => void>()
	const snapshotOf = (): SignalsSnapshot => ({
		threads,
		sources,
		seq,
		generatedAt: iso(clock()),
		filteredCount: filtered.length,
	})
	let state: SignalsBridgeState = { snapshot: snapshotOf(), error: null, at: start }
	const publish = (): void => {
		seq += 1
		state = { snapshot: snapshotOf(), error: null, at: clock() }
		for (const listener of listeners) listener()
	}
	const calls: SignalsFixtureCalls = {
		updates: [],
		routed: [],
		opened: [],
		prompts: [],
		okenaProjects: [],
		newAgents: [],
		includes: [],
	}
	const held = new Map<SignalsHeldEffect, { wait: Promise<void>; release(): void }>()
	const hold = (effect: SignalsHeldEffect): void => {
		if (held.has(effect)) return
		let release = (): void => undefined
		const wait = new Promise<void>(resolve => {
			release = resolve
		})
		held.set(effect, { wait, release })
	}
	const release = (effect: SignalsHeldEffect): void => {
		held.get(effect)?.release()
		held.delete(effect)
	}
	const gate = async (effect: SignalsHeldEffect): Promise<void> => {
		await held.get(effect)?.wait
	}
	const change = (id: number, apply: (entry: SignalThread, at: string) => SignalThread) => {
		const current = threads.find(entry => entry.id === id)
		if (!current) return { error: 'Signal not found', status: 404 } as const
		// Strictly newer than anything the column holds, even within one millisecond.
		const at = iso(Math.max(clock(), Date.parse(current.updatedAt) + 1))
		const next = apply(current, at)
		threads = threads.map(entry => (entry.id === id ? next : entry))
		publish()
		return { data: next } as const
	}
	const service: SignalsService = {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		async update(id, patch) {
			calls.updates.push({ id, patch })
			return change(id, (entry, at) => ({
				...entry,
				...(patch.owner ? { owner: patch.owner } : {}),
				...(patch.managedBy !== undefined ? { managedBy: patch.managedBy } : {}),
				...(patch.state
					? {
							state: patch.state,
							snoozedUntil: patch.state === 'snoozed' ? (patch.snoozedUntil ?? null) : null,
							closedReason: null,
						}
					: {}),
				updatedAt: at,
			}))
		},
		async routed(id, body) {
			calls.routed.push({ id, ...body })
			return change(id, (entry, at) => ({
				...entry,
				routedAgent: body.agent,
				routedHow: body.how,
				routedAt: at,
				state: entry.state === 'new' ? 'seen' : entry.state,
				updatedAt: at,
			}))
		},
		async open(url) {
			calls.opened.push(url)
			return { data: true }
		},
		async filtered() {
			return { data: { entries: filtered.map(entry => ({ ...entry })), total: filtered.length, retentionDays: 7 } }
		},
		async include(id) {
			calls.includes.push(id)
			const entry = filtered.find(item => item.id === id)
			if (!entry) return { error: 'Filtered mail not found', status: 404 }
			const address = entry.senderIdentity
			const added = !included.includes(address)
			if (added) included.push(address)
			// As the daemon: the sender's rows leave the log, and the next poll keeps their mail.
			filtered = filtered.filter(item => item.senderIdentity !== address)
			publish()
			return { data: { address, added } }
		},
		async okenaProjects(repo) {
			calls.okenaProjects.push(repo)
			const matches = repo
				? OKENA_PROJECTS_FIXTURE.filter(project => project.repo?.toLowerCase() === repo.toLowerCase())
				: []
			return {
				data: { projects: OKENA_PROJECTS_FIXTURE, suggested: matches.length === 1 ? (matches[0]?.id ?? null) : null },
			}
		},
		async newAgent(request) {
			calls.newAgents.push(request)
			await gate('newAgent')
			return { data: { terminalId: 't-new', sessionId: 'session-new', agentName: request.branch } }
		},
	}
	const dockSnapshot = options.dock === undefined ? signalsDockFixture(start) : options.dock
	const dock: DockService = {
		snapshot: () => dockSnapshot,
		subscribe: () => () => undefined,
		async prompt(request) {
			calls.prompts.push(request)
			await gate('prompt')
			return { ok: true, outcome: { status: 'sent', delivery: 'pty' } }
		},
	}
	return { service, dock, calls, hold, release }
}
