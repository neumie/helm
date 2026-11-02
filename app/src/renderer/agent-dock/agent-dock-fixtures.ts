// Storybook/Playwright-only agent-dock fixtures. Snapshots come from the REAL
// recorded Okena bodies (tests/fixtures/okena-claude) driven through the
// foundation reducer, never hand-written DockItems. Production code must not
// import this module: it pulls the reducer (and zod) into the bundle.

import showAsk from '../../../../tests/fixtures/okena-claude/show-ask.json'
import showIdle from '../../../../tests/fixtures/okena-claude/show-idle.json'
import stateAsk from '../../../../tests/fixtures/okena-claude/state-ask.json'
import {
	ACT_CONFIRM_MS,
	type AgentDockActRequest,
	type AgentDockActResult,
	type AgentDockObservation,
	type AgentDockSnapshot,
	type DockActOutcome,
	type DockAction,
	type DockItem,
} from '../../agent-dock/model'
import { type AgentDockState, agentDockSnapshot, createAgentDockState, reduce } from '../../agent-dock/reduce'
import type { AgentDockApi } from '../../shared'

export type AgentDockScenario =
	| 'connecting'
	| 'empty'
	| 'busy'
	| 'crowded'
	| 'orphaned'
	| 'down'
	/** One agent, one unchecked turn that ended a minute ago (the queue's single-entry layout). */
	| 'single-turn'
	/** Receipt states (built by running real act observations through the reducer). */
	| 'receipt-sending'
	| 'receipt-unconfirmed'
	| 'receipt-answered'
	| 'receipt-refused'
	| 'receipt-failed'

type Json = Record<string, unknown>

const PROFILE = 'storybook'
const MINUTE = 60_000
const clone = <T>(value: T): T => structuredClone(value)
/** Jakub runs Okena with the MCP channel OFF: no channel attachment, terminal-origin prompts. */
const channelOff = (body: Json): Json => ({ ...clone(body), channel_attached: false })
const recordedDialog = (): Json => clone((showAsk.dialogs as Json[])[0] as Json)

interface Pane {
	tid: string
	sid: string
	projectId: string
	project: string
	name: string
}

const panes = {
	ask: { tid: 'term-ask', sid: 'sess-ask', projectId: 'proj-helm', project: 'helm', name: 'agent-dock' },
	turn: { tid: 'term-turn', sid: 'sess-turn', projectId: 'proj-quip', project: 'quip', name: 'ios-sync' },
	working: { tid: 'term-work', sid: 'sess-work', projectId: 'proj-groove', project: 'groove-dungeon', name: 'levels' },
	background: {
		tid: 'term-bg',
		sid: 'sess-bg',
		projectId: 'proj-veka',
		project: 'neumie-veka',
		name: 'mobile-aktivity',
	},
	permission: {
		tid: 'term-perm',
		sid: 'sess-perm',
		projectId: 'proj-veka',
		project: 'neumie-veka',
		name: 'mobile-hamburger',
	},
	answered: { tid: 'term-done', sid: 'sess-done', projectId: 'proj-helm', project: 'helm', name: 'release-notes' },
	plan: { tid: 'term-plan', sid: 'sess-plan', projectId: 'proj-psyon', project: 'psyon', name: 'invoices-export' },
	release: {
		tid: 'term-release',
		sid: 'sess-release',
		projectId: 'proj-veka',
		project: 'neumie-veka',
		name: 'ios-release',
	},
} satisfies Record<string, Pane>

/**
 * Claude's own permission suggestion for a Bash dialog, in the shape Claude Code's
 * PermissionRequest hook sends and Okena passes through verbatim (`permission_suggestions`).
 */
const bashSuggestion = (command: string): Json => ({
	type: 'addRules',
	rules: [{ toolName: 'Bash', ruleContent: command }],
	behavior: 'allow',
	destination: 'localSettings',
})

function detail(pane: Pane, overrides: Json = {}): Json {
	return {
		...channelOff(showIdle as Json),
		terminal_id: pane.tid,
		session_id: pane.sid,
		...overrides,
	}
}

function okenaState(version: number, live: Array<{ pane: Pane; body: Json }>): Json {
	const projects = new Map<string, Json>()
	for (const { pane } of live) {
		const project = projects.get(pane.projectId) ?? {
			id: pane.projectId,
			name: pane.project,
			path: `/fixture/${pane.project}`,
			layout: { type: 'split', children: [] as Json[] },
			terminal_names: {} as Record<string, string>,
		}
		;((project.layout as Json).children as Json[]).push({ type: 'terminal', terminal_id: pane.tid })
		;(project.terminal_names as Record<string, string>)[pane.tid] = pane.name
		projects.set(pane.projectId, project)
	}
	const dialogs: Record<string, number> = {}
	for (const { pane, body } of live) {
		const count = (body.dialogs as Json[] | undefined)?.length ?? 0
		if (count > 0) dialogs[pane.tid] = count
	}
	return {
		...clone(stateAsk as Json),
		state_version: version,
		claude_sessions: live.map(({ pane }) => pane.tid).sort(),
		claude_dialogs: dialogs,
		projects: [...projects.values()],
	}
}

function transcript(pane: Pane, entries: Json[], cursor: number, reset: boolean): Json {
	return { session_id: pane.sid, entries, cursor, reset }
}

const assistant = (uuid: string, text: string): Json => ({ kind: 'assistant', uuid, text })
const user = (uuid: string, text: string): Json => ({ kind: 'user', uuid, text, origin: 'terminal' })

/** Builds one poll; panes without a transcript this tick omit it, like the real source. */
function poll(
	version: number,
	live: Array<{ pane: Pane; body: Json; transcript?: Json }>,
): AgentDockObservation & { type: 'poll' } {
	return {
		type: 'poll',
		profile: PROFILE,
		state: { ok: true, body: okenaState(version, live) },
		terminals: live.map(({ pane, body, transcript: page }) => ({
			terminalId: pane.tid,
			detail: { ok: true, body },
			...(page ? { transcript: { ok: true, body: page } } : {}),
		})),
	}
}

const down = (error: string): AgentDockObservation => ({
	type: 'poll',
	profile: PROFILE,
	state: { ok: false, error },
	terminals: [],
})

/** Runs the timeline through the real reducer and returns its final state. */
function run(steps: Array<[number, AgentDockObservation]>, start: AgentDockState): AgentDockState {
	let state = start
	for (const [at, observation] of steps) state = reduce(state, observation, at).state
	return state
}

/**
 * Busy day: a two-question AskUserQuestion (recorded fixture) waiting 2h+, a
 * permission dialog waiting 40m, an unchecked turn from 6m ago, one working and
 * one background agent, and an ask already answered in the terminal. `crowded`
 * adds a plan approval waiting 25m and a second unchecked turn (five items).
 */
function busyTimeline(
	now: number,
	crowded = false,
): {
	steps: Array<[number, AgentDockObservation]>
	live: Array<{ pane: Pane; body: Json }>
	version: number
} {
	const t0 = now - 2 * 60 * MINUTE - 15 * MINUTE
	const prefix = String(recordedDialog().id).split('-')[0]
	const askBody = detail(panes.ask, {
		busy: true,
		dialogs: [{ ...recordedDialog(), created_at_ms: t0 - MINUTE }],
	})
	const answeredBody = detail(panes.answered, {
		busy: true,
		dialogs: [
			{
				id: `${prefix}-2`,
				tool_name: 'ExitPlanMode',
				tool_input: { plan: '1. Write release notes\n2. Tag v1.4.0' },
				permission_suggestions: [],
				created_at_ms: t0 - 2 * MINUTE,
			},
		],
	})
	const working = detail(panes.working, { busy: true, pr_links: [] })
	const background = detail(panes.background, {
		busy: false,
		running_subagents: [
			{ agent_id: 'sub-1', agent_type: 'Explore' },
			{ agent_id: 'sub-2', agent_type: 'Explore' },
			{ agent_id: 'sub-3', agent_type: 'general-purpose' },
		],
	})
	const turnWorking = detail(panes.turn, {
		busy: true,
		pr_links: [
			{
				number: 212,
				url: 'https://github.com/example/quip/pull/212',
				repository: 'example/quip',
				last_seen_at: '2026-10-30T10:00:00Z',
			},
		],
	})
	const turnIdle = { ...turnWorking, busy: false }
	const seedPage = (pane: Pane, uuid: string) =>
		transcript(pane, [user(`${uuid}-u`, 'Start.'), assistant(uuid, 'Working on it.')], 1_000, true)
	const steps: Array<[number, AgentDockObservation]> = []
	let version = 4_000
	const seedLive = [
		{ pane: panes.ask, body: askBody, transcript: seedPage(panes.ask, 'ask-a0') },
		{ pane: panes.answered, body: answeredBody, transcript: seedPage(panes.answered, 'done-a0') },
		{ pane: panes.working, body: working, transcript: seedPage(panes.working, 'work-a0') },
		{ pane: panes.background, body: background, transcript: seedPage(panes.background, 'bg-a0') },
		{ pane: panes.turn, body: turnWorking, transcript: seedPage(panes.turn, 'turn-a0') },
	]
	steps.push([t0, poll(++version, seedLive)])
	// 40 minutes ago a permission dialog opens in a new pane.
	const permissionBody = detail(panes.permission, {
		busy: true,
		dialogs: [
			{
				id: `${prefix}-9`,
				tool_name: 'Bash',
				tool_input: { command: 'npm run deploy:stage', description: 'Deploy the worker to stage' },
				permission_suggestions: [bashSuggestion('npm run deploy:stage')],
				created_at_ms: now - 40 * MINUTE,
			},
		],
	})
	const planBody = detail(panes.plan, {
		busy: true,
		dialogs: [
			{
				id: `${prefix}-11`,
				tool_name: 'ExitPlanMode',
				tool_input: {
					plan: [
						'# Export invoices as ISDOC',
						'',
						'1. Add `isdoc` to the export format enum and the API schema.',
						'2. Map Invoice to ISDOC 6.0.2 (supplier, customer, lines, VAT recap).',
						'3. Validate against the official XSD in a unit test.',
						'4. Add an "Export ISDOC" action to the invoice detail menu.',
						'5. Ship behind the `isdoc-export` flag; enable for Psyon only.',
					].join('\n'),
				},
				permission_suggestions: [],
				created_at_ms: now - 25 * MINUTE,
			},
		],
	})
	const releaseWorking = detail(panes.release, { busy: true })
	const releaseIdle = { ...releaseWorking, busy: false }
	const withPermission = (turnBody: Json, turnPage?: Json, releaseBody = releaseWorking, releasePage?: Json) => [
		{ pane: panes.ask, body: askBody },
		{ pane: panes.answered, body: answeredBody },
		{ pane: panes.working, body: working },
		{ pane: panes.background, body: background },
		{ pane: panes.turn, body: turnBody, ...(turnPage ? { transcript: turnPage } : {}) },
		{ pane: panes.permission, body: permissionBody, transcript: seedPage(panes.permission, 'perm-a0') },
		...(crowded
			? [
					{ pane: panes.plan, body: planBody, transcript: seedPage(panes.plan, 'plan-a0') },
					{ pane: panes.release, body: releaseBody, ...(releasePage ? { transcript: releasePage } : {}) },
				]
			: []),
	]
	steps.push([
		now - 40 * MINUTE,
		poll(++version, withPermission(turnWorking, undefined, releaseWorking, seedPage(panes.release, 'release-a0'))),
	])
	if (crowded) {
		// 22 minutes ago the iOS release agent hands a device test back to Jakub.
		const releasePage = transcript(
			panes.release,
			[
				assistant(
					'release-a1',
					'Released v1.101.2. It is live on prod (build 4127, phased rollout 100%).\n\nPlease test on a real iPhone: open Aktivity, then Vybrané události, and check the list scrolls without the jank from the bug report. The simulator does not reproduce it.',
				),
			],
			2_000,
			false,
		)
		steps.push([now - 22 * MINUTE, poll(++version, withPermission(turnWorking, undefined, releaseIdle, releasePage))])
		steps.push([now - 22 * MINUTE + 9_000, poll(++version, withPermission(turnWorking, undefined, releaseIdle))])
	}
	const release = crowded ? releaseIdle : releaseWorking
	// 6 minutes ago the quip agent finishes its turn with a prose question; it stays idle.
	const turnPage = transcript(
		panes.turn,
		[
			assistant(
				'turn-a1',
				'Done. Migrated 3 screens, tests green.\n\nPR #212 is ready. Before I deploy to stage, can you confirm the secret is set in stage?',
			),
		],
		2_000,
		false,
	)
	steps.push([now - 6 * MINUTE, poll(++version, withPermission(turnIdle, turnPage, release))])
	steps.push([now - 6 * MINUTE + 9_000, poll(++version, withPermission(turnIdle, undefined, release))])
	// 3 minutes ago the release-notes plan was approved in its own terminal.
	const answeredNow = { ...answeredBody, dialogs: [] }
	const afterAnswer = withPermission(turnIdle, undefined, release).map(entry =>
		entry.pane === panes.answered ? { pane: panes.answered, body: answeredNow } : entry,
	)
	steps.push([now - 3 * MINUTE, poll(++version, afterAnswer)])
	steps.push([now - 1_000, poll(++version, afterAnswer)])
	return { steps, live: afterAnswer, version }
}

type Live = Array<{ pane: Pane; body: Json; transcript?: Json }>

interface ScenarioRun {
	state: AgentDockState
	/** The panes as Okena last showed them (no transcript pages), for follow-up polls. */
	live: Live
	version: number
	/** Answers this run sent from the dock, as the dock would remember them (receipt stories). */
	sent?: Map<number, DockAction>
}

const bare = (live: Live): Live => live.map(({ pane, body }) => ({ pane, body }))

function scenarioRun(name: AgentDockScenario, now: number): ScenarioRun {
	const persisted = { version: 1 as const, nextItemId: 3, seen: { [`${PROFILE}:${panes.turn.tid}`]: 'turn-a0' } }
	const start = createAgentDockState(persisted, now - 3 * 60 * MINUTE)
	if (name === 'connecting') return { state: start, live: [], version: 0 }
	if (name === 'empty') return { state: run([[now - 1_000, poll(1, [])]], start), live: [], version: 1 }
	if (name === 'single-turn') {
		const working = detail(panes.turn, { busy: true })
		const idle = { ...working, busy: false }
		const page = transcript(
			panes.turn,
			[assistant('turn-a1', 'Hotovo. Commit 1a84c0e je na main, working tree je čistý.\n\nMám to pushnout?')],
			2_000,
			false,
		)
		const steps: Array<[number, AgentDockObservation]> = [
			[
				now - 20 * MINUTE,
				poll(5_001, [
					{
						pane: panes.turn,
						body: working,
						transcript: transcript(
							panes.turn,
							[user('turn-a0-u', 'Start.'), assistant('turn-a0', 'Working on it.')],
							1_000,
							true,
						),
					},
				]),
			],
			[now - MINUTE, poll(5_002, [{ pane: panes.turn, body: idle, transcript: page }])],
			[now - MINUTE + 9_000, poll(5_003, [{ pane: panes.turn, body: idle }])],
		]
		return { state: run(steps, start), live: [{ pane: panes.turn, body: idle }], version: 5_003 }
	}
	if (name === 'crowded') {
		const crowded = busyTimeline(now, true)
		return { state: run(crowded.steps, start), live: bare(crowded.live), version: crowded.version }
	}
	const busy = busyTimeline(now)
	if (name === 'busy') return { state: run(busy.steps, start), live: bare(busy.live), version: busy.version }
	if (name.startsWith('receipt-'))
		return receiptRun(name, now, { state: run(busy.steps, start), live: bare(busy.live), version: busy.version })
	// Both outage scenarios replace the final "now" poll; the timeline stays monotonic.
	const beforeNow = busy.steps.slice(0, -1)
	if (name === 'down')
		return {
			state: run([...beforeNow, [now - 2 * MINUTE, down('connect ECONNREFUSED')]], start),
			live: bare(busy.live),
			version: busy.version,
		}
	// orphaned: Okena goes away and comes back; the recorded question vanished meanwhile.
	const live = bare(busy.live).map(entry =>
		entry.pane === panes.ask ? { pane: panes.ask, body: detail(panes.ask, { busy: true }) } : entry,
	)
	return {
		state: run(
			[...beforeNow, [now - 150_000, down('connect ECONNREFUSED')], [now - MINUTE, poll(busy.version + 1, live)]],
			start,
		),
		live,
		version: busy.version + 1,
	}
}

/** Reducer state for a named scenario at `now` (ms). */
export function agentDockScenarioState(name: AgentDockScenario, now: number): AgentDockState {
	return scenarioRun(name, now).state
}

export function agentDockScenario(name: AgentDockScenario, now: number): AgentDockSnapshot {
	return agentDockSnapshot(agentDockScenarioState(name, now), now)
}

const paneOf = (item: DockItem): Pane | undefined =>
	Object.values(panes).find(pane => `${PROFILE}:${pane.tid}` === item.session)

/**
 * The next Okena poll after Jakub's dock answer landed: the dialog is gone from its
 * pane, or (a reply) the pane is busy and the transcript shows the user entry.
 */
function landedPoll(scenario: ScenarioRun, item: DockItem): AgentDockObservation {
	const pane = paneOf(item)
	scenario.version += 1
	const live: Live = scenario.live.map(entry => {
		if (entry.pane !== pane) return entry
		if (item.fact.kind === 'ask') {
			const dialogId = item.fact.dialogId
			const dialogs = ((entry.body.dialogs as Json[] | undefined) ?? []).filter(dialog => dialog.id !== dialogId)
			return { pane: entry.pane, body: { ...entry.body, dialogs } }
		}
		return {
			pane: entry.pane,
			body: { ...entry.body, busy: true },
			transcript: transcript(
				entry.pane,
				[user(`dock-${item.id}`, '(reply from the dock)')],
				9_000 + scenario.version,
				false,
			),
		}
	})
	scenario.live = bare(live)
	return poll(scenario.version, live)
}

/** A poll that shows nothing new (the answer has not landed). */
function samePoll(scenario: ScenarioRun): AgentDockObservation {
	scenario.version += 1
	return poll(scenario.version, scenario.live)
}

const actionKind = (action: DockAction) => ({
	action: action.type,
	...(action.type === 'allow' && action.always ? { always: true } : {}),
})

/** Receipt stories: the busy day, then one dock answer on the question card, through the real reducer. */
function receiptRun(name: AgentDockScenario, now: number, scenario: ScenarioRun): ScenarioRun {
	const question = scenario.state.items.find(item => item.kind === 'ask' && item.state === 'open')
	if (!question) return scenario
	const step = (observation: AgentDockObservation, at: number) => {
		scenario.state = reduce(scenario.state, observation, at).state
	}
	const answer: DockAction = { type: 'answer', picks: [{ options: [1] }, { options: [0] }] }
	scenario.sent = new Map([[question.id, answer]])
	step({ type: 'act.sending', itemId: question.id, ...actionKind(answer) }, now - 2_000)
	if (name === 'receipt-sending') return scenario
	if (name === 'receipt-failed') {
		step(
			{
				type: 'act.result',
				itemId: question.id,
				outcome: {
					status: 'failed',
					detail: `Okena POST /v1/claude/terminals/${panes.ask.tid}/dialogs/${(question.fact as { dialogId: string }).dialogId} failed (500): bridge unavailable`,
				},
			},
			now - 1_500,
		)
		return scenario
	}
	if (name === 'receipt-refused') {
		step(
			{
				type: 'act.result',
				itemId: question.id,
				outcome: { status: 'refused', reason: 'gone', detail: 'already answered elsewhere' },
			},
			now - 1_500,
		)
		// Storybook only: stamped ahead of the wall clock so the lingering receipt stays put for review.
		step(landedPoll(scenario, question), now + 10 * MINUTE)
		return scenario
	}
	step({ type: 'act.result', itemId: question.id, outcome: { status: 'sent' } }, now - 1_500)
	if (name === 'receipt-unconfirmed') {
		step(samePoll(scenario), now - 1_500 + ACT_CONFIRM_MS)
		return scenario
	}
	// receipt-answered — Storybook only: stamped ahead of the wall clock so "✓ answered" stays put for review.
	step(landedPoll(scenario, question), now + 10 * MINUTE)
	return scenario
}

/** How the in-memory act behaves (browser tests switch it; stories use the default). */
export type AgentDockActMode = 'confirm' | 'unconfirmed' | 'refused' | 'error'

/** Pause between the fixture act's steps, so Sending… is visible. */
export const FIXTURE_ACT_STEP_MS = 250

export interface AgentDockFixture {
	api: AgentDockApi
	calls: { visible: boolean[]; acks: number[]; acts: AgentDockActRequest[] }
	/** Answers the current scenario already sent from the dock (the receipt stories), for AgentDock's initialSent. */
	sent(): ReadonlyMap<number, DockAction>
	/** Replaces the reducer state with a scenario and pushes its snapshot through the production subscription. */
	emitScenario(name: AgentDockScenario): void
	/** What the next acts do: land and get observed (default), never get observed, refused (answered elsewhere), or fail. */
	setActMode(mode: AgentDockActMode): void
	listenerCount(): number
}

/**
 * In-memory AgentDockApi over the REAL reducer: ack and act feed it the same
 * observations main would (act.sending → act.result → the next Okena poll), so
 * receipts move Sending… → ✓ answered / sent, unconfirmed / refused / error.
 */
export function createAgentDockFixture(
	initial: AgentDockScenario | null,
	clock: () => number = Date.now,
): AgentDockFixture {
	const listeners = new Set<(snapshot: AgentDockSnapshot) => void>()
	const calls: AgentDockFixture['calls'] = { visible: [], acks: [], acts: [] }
	let scenario: ScenarioRun | null = initial ? scenarioRun(initial, clock()) : null
	let mode: AgentDockActMode = 'confirm'
	const push = () => {
		if (!scenario) return
		const snapshot = agentDockSnapshot(scenario.state, clock())
		for (const listener of listeners) listener(snapshot)
	}
	const apply = (observation: AgentDockObservation, at = clock()) => {
		if (!scenario) return
		scenario.state = reduce(scenario.state, observation, at).state
		push()
	}
	const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
	// A poll scheduled for one scenario never lands in the next one (emitScenario replaces it).
	const later = (run: () => void) => {
		const owner = scenario
		setTimeout(() => {
			if (scenario === owner) run()
		}, FIXTURE_ACT_STEP_MS)
	}
	return {
		calls,
		api: {
			onSnapshot(listener) {
				listeners.add(listener)
				if (scenario) listener(agentDockSnapshot(scenario.state, clock()))
				return () => listeners.delete(listener)
			},
			setVisible(visible) {
				calls.visible.push(visible)
			},
			async ack(itemId) {
				calls.acks.push(itemId)
				if (!scenario) return false
				const before = scenario.state.items.find(item => item.id === itemId)?.state
				scenario.state = reduce(scenario.state, { type: 'ack', itemId }, clock()).state
				const acked =
					before !== 'resolved' && scenario.state.items.find(item => item.id === itemId)?.state === 'resolved'
				if (acked) push()
				return acked
			},
			async act(request): Promise<AgentDockActResult> {
				calls.acts.push(structuredClone(request))
				const current = scenario
				const item = current?.state.items.find(candidate => candidate.id === request.itemId)
				if (!current || !item || item.state !== 'open')
					return {
						ok: false,
						outcome: { status: 'refused', reason: 'not_open', detail: 'not open for an answer right now' },
					}
				if (request.rev !== undefined && request.rev !== item.rev)
					return { ok: false, outcome: { status: 'refused', reason: 'changed', detail: 'it changed since you looked' } }
				apply({ type: 'act.sending', itemId: item.id, ...actionKind(request.action) })
				await wait(FIXTURE_ACT_STEP_MS)
				let outcome: DockActOutcome
				if (mode === 'error') {
					const target = item.fact.kind === 'ask' ? `dialogs/${item.fact.dialogId}` : 'prompt'
					outcome = {
						status: 'failed',
						detail: `Okena POST /v1/claude/terminals/${paneOf(item)?.tid ?? 'unknown'}/${target} failed (500): bridge unavailable`,
					}
				} else if (mode === 'refused')
					outcome = { status: 'refused', reason: 'gone', detail: 'already answered elsewhere' }
				else outcome = { status: 'sent', ...(item.kind === 'turn' ? { delivery: 'pty' as const } : {}) }
				apply({ type: 'act.result', itemId: item.id, outcome })
				if (mode === 'confirm' || mode === 'refused') later(() => apply(landedPoll(current, item)))
				// Not observed: the next poll comes after the confirmation window.
				if (mode === 'unconfirmed') later(() => apply(samePoll(current), clock() + ACT_CONFIRM_MS))
				return { ok: outcome.status === 'sent', outcome }
			},
		},
		emitScenario(name) {
			scenario = scenarioRun(name, clock())
			push()
		},
		setActMode(next) {
			mode = next
		},
		sent: () => scenario?.sent ?? new Map(),
		listenerCount: () => listeners.size,
	}
}

/** A recorded-looking shell session for review stories: fills the terminal so the rows the popover keeps visible show. */
export const AGENT_DOCK_TERMINAL_TEXT = [
	'\x1b[38;5;242m~/code/neumie/helm\x1b[0m \x1b[38;5;110mfeat/agent-dock\x1b[0m',
	'\x1b[1m❯\x1b[0m git log --oneline -12',
	'\x1b[33m4f1c2a9\x1b[0m feat(agent-dock): card rail replaces the expanded list',
	'\x1b[33m9b07e3d\x1b[0m feat(agent-dock): keep permission_suggestions on ask facts',
	'\x1b[33m1e5d0c4\x1b[0m fix(agent-dock): never all-clear while an agent is unreadable',
	'\x1b[33m7a2b9f1\x1b[0m feat(agent-dock): ⌘⇧J goes to the dock',
	'\x1b[33m3c8e6d2\x1b[0m feat(agent-dock): orphan open asks across an Okena restart',
	'\x1b[33m0d4f7a8\x1b[0m feat(agent-dock): spool events for helm dock watch',
	'\x1b[33m6e9a1b3\x1b[0m feat(agent-dock): read Okena Claude Remote sessions',
	'\x1b[33m2f3c5e7\x1b[0m chore: bump xterm to 6.0.0',
	'\x1b[33m8a1d4c6\x1b[0m fix(terminal): refit after the sidebar hides',
	'\x1b[33m5b6e2f9\x1b[0m feat(remote): limited subagent observation',
	'\x1b[33mc4a7d10\x1b[0m docs(design-system): §3.21 activity indicator',
	'\x1b[33me1f8b52\x1b[0m test(browser): sidebar visibility harness',
	'',
	'\x1b[38;5;242m~/code/neumie/helm\x1b[0m \x1b[38;5;110mfeat/agent-dock\x1b[0m',
	'\x1b[1m❯\x1b[0m npm run test -- tests/helm-agent-dock-*.test.ts',
	'',
	'\x1b[32m✔\x1b[0m opens an ask when Okena reports a dialog \x1b[38;5;242m(0.41ms)\x1b[0m',
	'\x1b[32m✔\x1b[0m resolves an ask answered in the terminal \x1b[38;5;242m(0.22ms)\x1b[0m',
	'\x1b[32m✔\x1b[0m orphans open asks across an Okena restart \x1b[38;5;242m(0.37ms)\x1b[0m',
	'\x1b[32m✔\x1b[0m supersedes a turn when the agent continues \x1b[38;5;242m(0.19ms)\x1b[0m',
	'\x1b[32m✔\x1b[0m never persists turn text \x1b[38;5;242m(0.08ms)\x1b[0m',
	'\x1b[32m✔\x1b[0m backs off while Okena is unreachable \x1b[38;5;242m(1.92ms)\x1b[0m',
	'\x1b[32m✔\x1b[0m pushes nothing while idle \x1b[38;5;242m(0.66ms)\x1b[0m',
	'\x1b[32m✔\x1b[0m rail keeps every item in view at 900px \x1b[38;5;242m(0.12ms)\x1b[0m',
	'\x1b[32m✔\x1b[0m popover never covers the last terminal rows \x1b[38;5;242m(0.09ms)\x1b[0m',
	'\x1b[38;5;245mℹ\x1b[0m tests 48',
	'\x1b[38;5;245mℹ\x1b[0m pass 48',
	'\x1b[38;5;245mℹ\x1b[0m fail 0',
	'\x1b[38;5;245mℹ\x1b[0m duration_ms 214.00',
	'',
	'\x1b[38;5;242m~/code/neumie/helm\x1b[0m \x1b[38;5;110mfeat/agent-dock\x1b[0m',
	'\x1b[1m❯\x1b[0m git status --short',
	' \x1b[31mM\x1b[0m app/src/renderer/agent-dock/AgentDock.tsx',
	' \x1b[31mM\x1b[0m app/src/renderer/styles.css',
	' \x1b[31mM\x1b[0m docs/design-system.md',
	'',
	'\x1b[38;5;242m~/code/neumie/helm\x1b[0m \x1b[38;5;110mfeat/agent-dock\x1b[0m',
	'\x1b[1m❯\x1b[0m ',
].join('\r\n')

const CC_DIM = '\x1b[38;2;136;136;136m'
const CC_RULE = '\x1b[38;2;102;102;102m'
const CC_GREEN = '\x1b[38;2;78;186;101m'
const CC_PINK = '\x1b[38;2;255;107;128m'
const CC_RESET = '\x1b[0m'
/** Wider than any terminal: drawn with autowrap off, it stops at the right margin like Claude Code's own rules. */
const CC_FULL_RULE = `${CC_RULE}${'─'.repeat(512)}${CC_RESET}`
/** A full-width rule with a title right-aligned before its last `─` (cursor to the margin, then back). */
const ccTitledRule = (title: string): string => {
	const tail = ` ${title} ─`
	return `${CC_FULL_RULE}\x1b[999C\x1b[${[...tail].length - 1}D${CC_RULE}${tail}${CC_RESET}`
}

/**
 * The bottom of a Claude Code session as the terminal shows it under the dock: transcript,
 * the session's titled rule, the prompt box between two full-width rules, then the status
 * block. A stress test for the dock's edge (§3.24 Divider): Claude Code's own thin rules
 * sit right above it. Autowrap is off while it draws so the rules fit any width; the
 * cursor is hidden, as Claude Code hides it.
 */
export const CLAUDE_CODE_TERMINAL_TEXT = `\x1b[?25l\x1b[?7l${[
	`${CC_DIM}>${CC_RESET} zkontroluj, proč nejde vidět divider v docku`,
	'',
	`${CC_GREEN}⏺${CC_RESET} Read(app/src/renderer/styles.css)`,
	`  ${CC_DIM}⎿  Read 2825 lines${CC_RESET}`,
	'',
	`${CC_GREEN}⏺${CC_RESET} Search(pattern: "agent-dock-strip", path: "app/src/renderer")`,
	`  ${CC_DIM}⎿  Found 4 files${CC_RESET}`,
	'',
	'⏺ Strip má nahoře jen inset hairline rgba(255,255,255,.07) a pane sedí na --term-bg,',
	'  takže hranice terminál → dock je jen další tenká čára. Claude Code kreslí přesně',
	'  takové čáry kolem promptu, proto ji oko nepozná.',
	'',
	`${CC_GREEN}⏺${CC_RESET} Bash(git status --short)`,
	`  ${CC_DIM}⎿   M projects/helm/helm.md${CC_RESET}`,
	`  ${CC_DIM}     M projects/jvs/jvs.md${CC_RESET}`,
	'',
	`${CC_GREEN}⏺${CC_RESET} Update(projects/helm/helm.md)`,
	`  ${CC_DIM}⎿  Updated projects/helm/helm.md with 3 additions and 1 removal${CC_RESET}`,
	`  ${CC_DIM}     41    ## Agent dock${CC_RESET}`,
	`  ${CC_DIM}     42 -  - divider: hairline${CC_RESET}`,
	`  ${CC_DIM}     42 +  - divider: surface / pane gap / accent edge (review)${CC_RESET}`,
	`  ${CC_DIM}     43 +  - stress test: Claude Code session under the dock${CC_RESET}`,
	'',
	`${CC_GREEN}⏺${CC_RESET} Bash(git commit -am "docs(helm): agent dock divider variants")`,
	`  ${CC_DIM}⎿  [main 1a84c0e] docs(helm): agent dock divider variants${CC_RESET}`,
	`  ${CC_DIM}     2 files changed, 9 insertions(+), 3 deletions(-)${CC_RESET}`,
	'',
	'⏺ Hotovo. Commit 1a84c0e je na main, working tree je čistý.',
	'',
	'  - helm.md: tři varianty divideru s poznámkou, co která řeší',
	'  - jvs.md: odkaz na screenshoty v scratchpadu',
	'',
	'  Mám to pushnout?',
	'',
	`${CC_DIM}>${CC_RESET} a co ten queue strip dole, ta prázdná buňka uprostřed?`,
	'',
	'⏺ To je výplň mezi poslední položkou a sloupcem Agents: má vlastní horní hairline,',
	'  takže vypadá jako chybějící karta. Opravím to spolu s dividerem.',
	'',
	ccTitledRule('helm · agent dock divider'),
	CC_FULL_RULE,
	'❯ jo pushni to',
	CC_FULL_RULE,
	`  ${CC_DIM}~/vault${CC_RESET}`,
	`  ${CC_DIM}Opus 5.5 · effort high · ctx 15%${CC_RESET}`,
	`  ${CC_PINK}▸▸ bypass permissions on${CC_RESET}${CC_DIM} (shift+tab to cycle) · ← 1 agent${CC_RESET}`,
].join('\r\n')}\x1b[?7h`
