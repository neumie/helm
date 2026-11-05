// Storybook/Playwright-only agent-dock fixtures. Snapshots come from the REAL
// recorded Okena bodies (tests/fixtures/okena-claude) driven through the
// foundation reducer, never hand-written DockItems. Production code must not
// import this module: it pulls the reducer (and zod) into the bundle.

import showAsk from '../../../../tests/fixtures/okena-claude/show-ask.json'
import showIdle from '../../../../tests/fixtures/okena-claude/show-idle.json'
import stateAsk from '../../../../tests/fixtures/okena-claude/state-ask.json'
import type { ObservedBackgroundTasks } from '../../agent-dock/background-tasks'
import {
	ACT_CONFIRM_MS,
	type AgentDockActRequest,
	type AgentDockActResult,
	type AgentDockMessageResult,
	type AgentDockObservation,
	type AgentDockPromptRequest,
	type AgentDockRevealResult,
	type AgentDockSnapshot,
	type DockActOutcome,
	type DockAction,
	type DockItem,
	type DockSourceId,
} from '../../agent-dock/model'
import {
	type AgentDockState,
	TURN_IDLE_MS,
	agentDockSnapshot,
	aggregateSourceHealth,
	createAgentDockState,
	reduce,
} from '../../agent-dock/reduce'
import { REVEAL_TEXT } from '../../agent-dock/reveal'
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
	/** `single-turn` whose last message is Claude's Markdown (`TURN_MARKDOWN_TEXT`): bold, nested lists, code. */
	| 'markdown-turn'
	/**
	 * Jakub's report ("tohle je křivý"): `single-turn` whose session has four PRs open, so the pane's
	 * facts row (PR #166 PR #164 PR #159 PR #136) sits between the message and Reply.
	 */
	| 'pr-links-turn'
	/**
	 * Jakub's report: a turn whose Markdown (headings, code blocks, lists) runs past the pane's
	 * height. Two finished turns: `ios-release` (short, 10m ago) first, then `ios-sync` (the long one,
	 * 1m ago) — ack the first from the dock and the pane moves on to the long one at 1/1.
	 */
	| 'long-turn'
	/**
	 * Jakub's real day: three items whose panes carry long ClientCare task titles. Two sessions share
	 * the worktree branch `fix/company-create-save-firm` (a question and a permission), one turn ended on
	 * `fix/repeated-android-camera-permission` with subagents still running; four agents, two busy.
	 */
	| 'real-case'
	/** Eight items from eight agents: the one-row queue shows what fits and one quiet "+N more" cell. */
	| 'overflow'
	/**
	 * Jakub's Agents pane: Psyon's main checkout on a detached HEAD (`d1aee9df`, no pane name) working
	 * 4m with 4 subagents; two JVS worktrees (Okena projects named after their branches) idle <1m with
	 * PRs; a Psyon worktree waiting on a question; a JVS worktree whose detail could not be read; and
	 * Claude in a Helm terminal with background work.
	 */
	| 'agents-pane'
	/**
	 * The Agents overview (every state relative to Jakub), through the real reducer: a question
	 * (12m), a permission (3m) and a plan (25m) need him; a JVS worktree's reply has waited 45m (with
	 * PRs); Psyon's detached checkout works with 4 subagents; a Helm-terminal agent runs a background
	 * shell (`1 shell`); another JVS worktree's turn was read (acked) 15m ago; one pane's detail is unreadable; one
	 * Okena pane runs Claude without hooks (not connected).
	 */
	| 'agents-overview'
	/** `agents-overview` with Okena unreachable since 2 minutes ago: its agents freeze, Helm's stays live. */
	| 'agents-okena-down'
	/**
	 * `agents-overview` (3 minutes earlier) before Helm's hub first answers: Okena connected with its
	 * agents, Helm terminals still connecting (no Helm agent yet).
	 */
	| 'agents-helm-connecting'
	/**
	 * Jakub's report: Claude merged PR #953, started the stage deploy in a background shell, said
	 * "ozvu se, až doběhne" and stopped 2m ago. Okena says idle; the shell makes it `background`
	 * with "1 shell", and the turn is still there to read.
	 */
	| 'background-shell'
	/** Receipt states (built by running real act observations through the reducer). */
	| 'receipt-sending'
	| 'receipt-unconfirmed'
	| 'receipt-answered'
	| 'receipt-refused'
	| 'receipt-failed'
	/**
	 * The crowded day running in Helm's own terminals (source `helm`) beside a reachable, empty Okena:
	 * the health names both sources, and the plan's Approve says it also switches to accept edits.
	 */
	| 'helm-terminals'
	/**
	 * `helm-terminals` with Claude also suggesting `addDirectories` for the permission: Helm's hub can
	 * only apply rule suggestions, so that pane offers Allow once and Deny, no "Always allow".
	 */
	| 'helm-add-directories'
	/**
	 * Jakub's report (a "Turn ended" pane for `service-date-and-people`, PR #960): "Show terminal" from an
	 * item pane or an agent's detail. A turn on `fix/service-date-and-people` that ended 2m ago and a
	 * question on `fix/rental-calendar-export` (4m), and `rental-pricing` working (no item: its Agents row
	 * opens the agent detail), all Okena worktrees of crane-rental.
	 */
	| 'reveal-okena'
	/**
	 * `reveal-okena` running in Helm's own terminals (source `helm`): the turn's pane is the workspace
	 * fixture's `compile` session, the question's its `tests` and the working agent's `logs`, so "Show terminal" switches
	 * to a real tab and pulses its frame.
	 */
	| 'reveal-helm'

type Json = Record<string, unknown>

/** A real Claude Code turn ending (Czech, Markdown, cut mid-sentence by the excerpt bound), verbatim, plus
 * the line of another real ending with a bare URL (the dock opens it in the browser). */
export const TURN_MARKDOWN_TEXT = [
	'**Původní problém:** jeden klient s vadným e-mailem (např. `jmeno@emailcz`) → SmartEmailing odmítne celou hromadnou kampaň. Worker pak spadl s chybou 500 a admin ukázal jen „Nepodařilo se odeslat kampaň." Nebylo poznat, kdo za to může.',
	'',
	'Hotovo, na stejném odkazu: https://claude.ai/artifact/MC5AvBgNCPmVLe7UrHeQmy',
	'',
	'**1. Kontrola e-mailů před odesláním**',
	'- Nová fce `isValidEmailAddress` v `lib/src/utils/email.ts`. Kontrola je záměrně volná, chytá jen adresy, které SmartEmailing stejně odmítne:',
	'  - adresa má jen jedno `@`',
	'  - doména má tečku (`jmeno@emailcz` neprojde)',
	'  - uvnitř nejsou mezery ani znaky `, ; : < > ( ) [ ] \\ "`, typicky čárka zbylá po kopírování',
	'- Worker (`worker/src/modules/smart-emailing/sendCampaign.ts`) zkontroluje všechny příjemce ještě před voláním SmartEmailingu.',
	'  - Pokud je e-mail chybný nebo chybí, vrátí 422 `invalidRecipients` s ID klientů a nic se neodešle.',
	'  - Dřív chybějící e-mail skončil chybou 500 a vadný se vůbec nekontroloval.',
	'',
	'**2. Když SmartEmailing odmítne nebo neodpoví**',
	'- Odpověď 4xx znamená jisté odmítnutí, nic neodešlo. Worker vrátí 502 `smartEmailingRejected` a důvod od SmartEmailingu.',
	'- Odpověď 5xx, výpadek spojení nebo nečitelná odpověď → 502 `smartEmailingUnconfirmed`. Kampaň mohla odejít, admin',
].join('\n')

/** `long-turn`'s message: what overflowed the pane in Jakub's report (headings, code blocks, lists; under the 2 KiB excerpt). */
export const LONG_TURN_TEXT = [
	'## Shrnutí',
	'Sync na iOS teď běží na pozadí a po návratu do appky se dorovná.',
	'',
	'### Co se změnilo',
	'- `SyncScheduler` plánuje `BGAppRefreshTask` každých 15 minut.',
	'- Konflikty řeší `mergeByUpdatedAt`, novější záznam vyhrává.',
	'- Offline změny čekají ve frontě a odešlou se po připojení.',
	'',
	'```swift',
	'BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: nil) { task in',
	'    scheduler.run(task as! BGAppRefreshTask)',
	'}',
	'```',
	'',
	'### Testy',
	'1. Unit testy na merge: 14 nových, všechny zelené.',
	'2. UI test: přepnutí do pozadí a zpět, data se dorovnají.',
	'3. Ručně na iPhonu 15: airplane mode, úprava, připojení.',
	'',
	'```sh',
	'xcodebuild test -scheme Quip -destination "platform=iOS Simulator,name=iPhone 15"',
	'```',
	'',
	'### Soubory',
	'- `Sources/Sync/SyncScheduler.swift` — nové plánování na pozadí.',
	'- `Sources/Sync/Merge.swift` — `mergeByUpdatedAt` a jeho testy.',
	'- `Sources/Sync/OutboxQueue.swift` — fronta offline změn.',
	'- `Info.plist` — `BGTaskSchedulerPermittedIdentifiers`.',
	'',
	'### Otevřené otázky',
	'- Interval 15 minut je minimum, iOS ho stejně může natáhnout.',
	'- Chceš notifikaci po dokončení syncu, nebo jen tichý badge?',
	'',
	'PR #212 je připravený. Mám ho mergnout?',
].join('\n')

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
	/** Okena's terminal name for the pane (`terminal_names`); absent for a pane Okena never named. */
	name?: string
	/** The project's git branch (`git_status.branch`), when the fixture has one. */
	branch?: string
	/** The repository project this one is an Okena worktree of (`worktree_info.parent_project_id`). */
	parent?: { id: string; name: string }
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
			...(pane.branch ? { git_status: { branch: pane.branch } } : {}),
			...(pane.parent ? { worktree_info: { parent_project_id: pane.parent.id } } : {}),
		}
		;((project.layout as Json).children as Json[]).push({ type: 'terminal', terminal_id: pane.tid })
		if (pane.name !== undefined) (project.terminal_names as Record<string, string>)[pane.tid] = pane.name
		projects.set(pane.projectId, project)
	}
	// A worktree's repository is listed too, with or without panes of its own (JVS has none open).
	for (const { pane } of live)
		if (pane.parent && !projects.has(pane.parent.id))
			projects.set(pane.parent.id, {
				id: pane.parent.id,
				name: pane.parent.name,
				path: `/fixture/${pane.parent.name}`,
				terminal_names: {},
			})
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
	live: Array<{ pane: Pane; body: Json; transcript?: Json; background?: ObservedBackgroundTasks }>,
): AgentDockObservation & { type: 'poll' } {
	return {
		type: 'poll',
		source: 'okena',
		profile: PROFILE,
		state: { ok: true, body: okenaState(version, live) },
		terminals: live.map(({ pane, body, transcript: page, background }) => ({
			terminalId: pane.tid,
			detail: { ok: true, body },
			...(page ? { transcript: { ok: true, body: page } } : {}),
			...(background ? { background } : {}),
		})),
	}
}

const down = (error: string): AgentDockObservation => ({
	type: 'poll',
	source: 'okena',
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
	permissionSuggestions: Json[] = [bashSuggestion('npm run deploy:stage')],
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
				permission_suggestions: permissionSuggestions,
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

/** ClientCare task titles as Okena names the panes Helm launched for them (long on purpose). */
const CC_COMPANY_TITLE =
	'Při zakládání nové společnosti se po kliknutí na Uložit neuloží firma a formulář se vrátí bez chybové hlášky (ClientCare #4182)'
const CC_CAMERA_TITLE =
	'Android: aplikace se při každém spuštění znovu ptá na oprávnění ke kameře, i když ho uživatel už povolil (ClientCare #4153)'
const CC_ISDOC_TITLE = 'Export faktur do formátu ISDOC pro účetní z detailu faktury (ClientCare #4120)'

const realPanes = {
	company: {
		tid: 'term-cc-company-1',
		sid: 'sess-cc-company-1',
		projectId: 'proj-crm',
		project: 'crm',
		name: CC_COMPANY_TITLE,
		branch: 'fix/company-create-save-firm',
	},
	companyTwo: {
		tid: 'term-cc-company-2',
		sid: 'sess-cc-company-2',
		projectId: 'proj-crm',
		project: 'crm',
		name: CC_COMPANY_TITLE,
		branch: 'fix/company-create-save-firm',
	},
	camera: {
		tid: 'term-cc-camera',
		sid: 'sess-cc-camera',
		projectId: 'proj-crm-mobile',
		project: 'crm-mobile',
		name: CC_CAMERA_TITLE,
		branch: 'fix/repeated-android-camera-permission',
	},
	isdoc: {
		tid: 'term-cc-isdoc',
		sid: 'sess-cc-isdoc',
		projectId: 'proj-crm-billing',
		project: 'crm-billing',
		name: CC_ISDOC_TITLE,
		branch: 'feat/isdoc-export',
	},
} satisfies Record<string, Pane>

const seedPage = (pane: Pane, uuid: string): Json =>
	transcript(pane, [user(`${uuid}-u`, 'Start.'), assistant(uuid, 'Working on it.')], 1_000, true)

const CRANE = { id: 'proj-crane', name: 'crane-rental' }

/** 'reveal-okena' / 'reveal-helm' (see AgentDockScenario), through the real reducer. */
function revealRun(now: number, start: AgentDockState, source: DockSourceId): ScenarioRun {
	const helm = source === 'helm'
	const turnPane: Pane = {
		tid: helm ? 'compile' : 'term-crane-sdp',
		sid: 'sess-crane-sdp',
		projectId: 'proj-crane-sdp',
		project: 'fix/service-date-and-people',
		name: 'Servisní protokol: datum servisu a přítomné osoby (ClientCare #4302)',
		branch: 'fix/service-date-and-people',
		parent: CRANE,
	}
	const askPane: Pane = {
		tid: helm ? 'tests' : 'term-crane-export',
		sid: 'sess-crane-export',
		projectId: 'proj-crane-export',
		project: 'fix/rental-calendar-export',
		name: 'Export kalendáře pronájmů do iCal (ClientCare #4310)',
		branch: 'fix/rental-calendar-export',
		parent: CRANE,
	}
	// Owes Jakub nothing (working, PR open): its Agents row opens its detail, not an item.
	const workPane: Pane = {
		tid: helm ? 'logs' : 'term-crane-pricing',
		sid: 'sess-crane-pricing',
		projectId: 'proj-crane-pricing',
		project: 'feat/rental-pricing',
		name: 'Ceník pronájmu podle délky (ClientCare #4288)',
		branch: 'feat/rental-pricing',
		parent: CRANE,
	}
	const working = detail(workPane, { busy: true, pr_links: [prLink(957)] })
	const turnWorking = detail(turnPane, { busy: true, pr_links: [prLink(960)] })
	const turnIdle = { ...turnWorking, busy: false }
	const askWorking = detail(askPane, { busy: true })
	const askOpen = detail(askPane, {
		busy: true,
		dialogs: [{ ...recordedDialog(), created_at_ms: now - 4 * MINUTE }],
	})
	const ended = transcript(
		turnPane,
		[
			assistant(
				'sdp-a1',
				'Hotovo. Servisní protokol teď ukládá datum servisu a přítomné osoby a obojí se propíše do PDF.\n\n- Datum servisu se předvyplní dnešním dnem a jde změnit.\n- Osoby se vybírají ze seznamu kontaktů zákazníka.\n\nPR #960 čeká na review.',
			),
		],
		2_000,
		false,
	)
	const steps: Array<[number, AgentDockObservation]> = [
		[
			now - 20 * MINUTE,
			poll(7_001, [
				{ pane: turnPane, body: turnWorking, transcript: seedPage(turnPane, 'sdp-a0') },
				{ pane: askPane, body: askWorking, transcript: seedPage(askPane, 'export-a0') },
				{ pane: workPane, body: working, transcript: seedPage(workPane, 'pricing-a0') },
			]),
		],
		[
			now - 4 * MINUTE,
			poll(7_002, [
				{ pane: turnPane, body: turnWorking },
				{ pane: askPane, body: askOpen },
				{ pane: workPane, body: working },
			]),
		],
		[
			now - 2 * MINUTE,
			poll(7_003, [
				{ pane: turnPane, body: turnIdle, transcript: ended },
				{ pane: askPane, body: askOpen },
				{ pane: workPane, body: working },
			]),
		],
		[
			now - 2 * MINUTE + TURN_IDLE_MS + 1_000,
			poll(7_004, [
				{ pane: turnPane, body: turnIdle },
				{ pane: askPane, body: askOpen },
				{ pane: workPane, body: working },
			]),
		],
	]
	const live: Live = [
		{ pane: turnPane, body: turnIdle },
		{ pane: askPane, body: askOpen },
		{ pane: workPane, body: working },
	]
	if (!helm) return { state: run(steps, start), live, version: 7_004 }
	const helmSteps: Array<[number, AgentDockObservation]> = steps.map(([at, observation]) => [
		at,
		{ ...observation, source: 'helm' } as AgentDockObservation,
	])
	// Okena answers too (nothing of its own open), so both sources read connected.
	helmSteps.push([now - 1_000, { ...poll(1, []), profile: 'okena-storybook', source: 'okena' }])
	return { state: run(helmSteps, start), live, version: 7_004, source: 'helm' }
}

/** `long-turn` (see AgentDockScenario), through the real reducer. */
function longTurnRun(now: number, start: AgentDockState): ScenarioRun {
	const working = (pane: Pane) => detail(pane, { busy: true })
	const idle = (pane: Pane) => ({ ...working(pane), busy: false })
	const said = (pane: Pane, uuid: string, text: string) => transcript(pane, [assistant(uuid, text)], 2_000, false)
	const steps: Array<[number, AgentDockObservation]> = [
		[
			now - 30 * MINUTE,
			poll(6_001, [
				{ pane: panes.release, body: working(panes.release), transcript: seedPage(panes.release, 'release-a0') },
				{ pane: panes.turn, body: working(panes.turn), transcript: seedPage(panes.turn, 'turn-a0') },
			]),
		],
		[
			now - 10 * MINUTE,
			poll(6_002, [
				{
					pane: panes.release,
					body: idle(panes.release),
					transcript: said(panes.release, 'release-a1', 'Build 4127 je na TestFlightu. Zkusíš ho?'),
				},
				{ pane: panes.turn, body: working(panes.turn) },
			]),
		],
		[
			now - 10 * MINUTE + 9_000,
			poll(6_003, [
				{ pane: panes.release, body: idle(panes.release) },
				{ pane: panes.turn, body: working(panes.turn) },
			]),
		],
		[
			now - MINUTE,
			poll(6_004, [
				{ pane: panes.release, body: idle(panes.release) },
				{ pane: panes.turn, body: idle(panes.turn), transcript: said(panes.turn, 'turn-a1', LONG_TURN_TEXT) },
			]),
		],
		[
			now - MINUTE + 9_000,
			poll(6_005, [
				{ pane: panes.release, body: idle(panes.release) },
				{ pane: panes.turn, body: idle(panes.turn) },
			]),
		],
	]
	return {
		state: run(steps, start),
		live: [
			{ pane: panes.release, body: idle(panes.release) },
			{ pane: panes.turn, body: idle(panes.turn) },
		],
		version: 6_005,
	}
}

/** Jakub's real case (see AgentDockScenario 'real-case'), through the real reducer. */
function realCaseTimeline(now: number): { steps: Array<[number, AgentDockObservation]>; live: Live; version: number } {
	const prefix = String(recordedDialog().id).split('-')[0]
	const question = detail(realPanes.company, {
		busy: true,
		dialogs: [
			{
				id: `${prefix}-41`,
				tool_name: 'AskUserQuestion',
				tool_input: {
					questions: [
						{
							header: 'IČO',
							question: 'Má jít firma uložit i bez IČO, nebo má formulář IČO vyžadovat ještě před uložením?',
							multiSelect: false,
							options: [
								{ label: 'Uložit bez IČO', description: 'IČO zůstane prázdné; doplní se později v detailu firmy.' },
								{
									label: 'Vyžadovat IČO',
									description: 'Tlačítko Uložit zůstane neaktivní, dokud IČO nebude vyplněné.',
								},
								{ label: 'Jen pro tuzemské firmy', description: 'IČO povinné jen u firem se sídlem v ČR.' },
							],
						},
					],
				},
				permission_suggestions: [],
				created_at_ms: now - 52 * MINUTE,
			},
		],
	})
	const permission = detail(realPanes.companyTwo, {
		busy: true,
		dialogs: [
			{
				id: `${prefix}-42`,
				tool_name: 'Bash',
				tool_input: {
					command: 'php artisan test --filter=CompanyCreateTest',
					description: 'Run the company create feature tests',
				},
				permission_suggestions: [bashSuggestion('php artisan test:*')],
				created_at_ms: now - 12 * MINUTE,
			},
		],
	})
	const cameraWorking = detail(realPanes.camera, { busy: true })
	const cameraDone = {
		...cameraWorking,
		busy: false,
		running_subagents: [{ agent_id: 'sub-cam-1', agent_type: 'Explore' }],
	}
	const isdoc = detail(realPanes.isdoc, { busy: true })
	const companyTwoWorking = detail(realPanes.companyTwo, { busy: true })
	const live = (camera: Json, page?: Json, companyTwo = permission): Live => [
		{ pane: realPanes.company, body: question },
		{ pane: realPanes.companyTwo, body: companyTwo },
		{ pane: realPanes.camera, body: camera, ...(page ? { transcript: page } : {}) },
		{ pane: realPanes.isdoc, body: isdoc },
	]
	const steps: Array<[number, AgentDockObservation]> = [
		[
			now - 70 * MINUTE,
			poll(6_001, [
				{
					pane: realPanes.company,
					body: detail(realPanes.company, { busy: true }),
					transcript: seedPage(realPanes.company, 'cc1-a0'),
				},
				{ pane: realPanes.companyTwo, body: companyTwoWorking, transcript: seedPage(realPanes.companyTwo, 'cc2-a0') },
				{ pane: realPanes.camera, body: cameraWorking, transcript: seedPage(realPanes.camera, 'cam-a0') },
				{ pane: realPanes.isdoc, body: isdoc, transcript: seedPage(realPanes.isdoc, 'isdoc-a0') },
			]),
		],
		[now - 52 * MINUTE, poll(6_002, live(cameraWorking, undefined, companyTwoWorking))],
		[now - 12 * MINUTE, poll(6_003, live(cameraWorking))],
	]
	const cameraPage = transcript(
		realPanes.camera,
		[
			assistant(
				'cam-a1',
				'Hotovo. Oprávnění ke kameře se teď drží přes ActivityResultContracts.RequestPermission a stav se ukládá do DataStore, takže se dialog po restartu aplikace už neukazuje. Ověřeno na Pixelu 7 (Android 15) i na emulátoru s Androidem 13.\n\nMám otevřít PR do develop, nebo to ještě chceš vyzkoušet na svém telefonu?',
			),
		],
		2_000,
		false,
	)
	steps.push([now - MINUTE, poll(6_004, live(cameraDone, cameraPage))])
	steps.push([now - MINUTE + 9_000, poll(6_005, live(cameraDone))])
	return { steps, live: live(cameraDone), version: 6_005 }
}

/** Eight agents, one item each, oldest first: what a full day can look like at 1100px. */
function overflowTimeline(now: number): { steps: Array<[number, AgentDockObservation]>; live: Live; version: number } {
	const prefix = String(recordedDialog().id).split('-')[0]
	const branches = [
		'fix/company-create-save-firm',
		'fix/repeated-android-camera-permission',
		'feat/isdoc-export',
		'fix/invoice-rounding-vat',
		'chore/upgrade-laravel-12',
		'feat/contact-person-roles',
		'refactor/address-autocomplete',
		'fix/login-throttle-message',
	]
	const overflowPanes: Pane[] = branches.map((branch, at) => ({
		tid: `term-over-${at + 1}`,
		sid: `sess-over-${at + 1}`,
		projectId: `proj-over-${at + 1}`,
		project: at % 3 === 1 ? 'crm-mobile' : 'crm',
		name: `ClientCare #${4100 + at * 7}`,
		branch,
	}))
	// Asks every other pane (question / permission), unchecked turns in between, oldest first.
	const ageOf = (at: number) => (8 - at) * 17 * MINUTE
	const isTurn = (at: number) => at % 3 === 2
	const askBody = (pane: Pane, at: number): Json =>
		detail(pane, {
			busy: true,
			dialogs: [
				at % 2 === 0
					? { ...recordedDialog(), id: `${prefix}-${60 + at}`, created_at_ms: now - ageOf(at) }
					: {
							id: `${prefix}-${60 + at}`,
							tool_name: 'Bash',
							tool_input: { command: 'npm test', description: 'Run the unit tests' },
							permission_suggestions: [],
							created_at_ms: now - ageOf(at),
						},
			],
		})
	const working = (pane: Pane) => detail(pane, { busy: true })
	const idle = (pane: Pane) => ({ ...working(pane), busy: false })
	const steps: Array<[number, AgentDockObservation]> = [
		[
			now - 3 * 60 * MINUTE,
			poll(
				7_001,
				overflowPanes.map(pane => ({ pane, body: working(pane), transcript: seedPage(pane, `${pane.tid}-a0`) })),
			),
		],
	]
	let version = 7_001
	const state = overflowPanes.map(
		pane => ({ pane, body: working(pane) }) as { pane: Pane; body: Json; transcript?: Json },
	)
	for (const [at, pane] of overflowPanes.entries()) {
		const entry = state[at] as { pane: Pane; body: Json; transcript?: Json }
		if (isTurn(at)) {
			entry.body = idle(pane)
			entry.transcript = transcript(
				pane,
				[assistant(`${pane.tid}-a1`, 'Done. Tests green.\n\nShall I open the PR?')],
				2_000,
				false,
			)
		} else entry.body = askBody(pane, at)
		steps.push([
			now - ageOf(at),
			poll(
				++version,
				state.map(({ pane: p, body, transcript: page }) => ({ pane: p, body, ...(page ? { transcript: page } : {}) })),
			),
		])
		entry.transcript = undefined
		steps.push([
			now - ageOf(at) + 9_000,
			poll(
				++version,
				state.map(({ pane: p, body }) => ({ pane: p, body })),
			),
		])
	}
	const live = state.map(({ pane, body }) => ({ pane, body }))
	steps.push([now - 1_000, poll(++version, live)])
	return { steps, live, version }
}

type Live = Array<{ pane: Pane; body: Json; transcript?: Json; background?: ObservedBackgroundTasks }>

const PSYON = { id: 'proj-psyon', name: 'Psyon' }
const JVS = { id: 'proj-jvs', name: 'JVS' }

/** The Agents pane's day (AgentDockScenario 'agents-pane'): Okena's panes, then the Helm terminal. */
const agentsPanes = {
	psyon: { tid: 'term-psyon', sid: 'sess-psyon', projectId: PSYON.id, project: PSYON.name, branch: 'd1aee9df' },
	repair: {
		tid: 'term-jvs-repair',
		sid: 'sess-jvs-repair',
		projectId: 'proj-jvs-repair',
		project: 'fix/repair-done-still-out-of-service',
		name: '[Echo] Kubo, tady bude chybka. Stav po dokončení …',
		branch: 'fix/repair-done-still-out-of-service',
		parent: JVS,
	},
	imageLink: {
		tid: 'term-jvs-image',
		sid: 'sess-jvs-image',
		projectId: 'proj-jvs-image',
		project: 'feat/service-protocol-image-link',
		name: 'Servisní protokol, udělat odkaz na obrázek, Nejlíp kdyby v protokolu byl odkaz na obrázek a nebo do emailu poslat jako přílohu v odkaze.',
		branch: 'feat/service-protocol-image-link',
		parent: JVS,
	},
	invoices: {
		tid: 'term-psyon-invoices',
		sid: 'sess-psyon-invoices',
		projectId: 'proj-psyon-invoices',
		project: 'feat/invoice-pdf-export',
		name: 'Export faktur do PDF s logem firmy (ClientCare #4211)',
		branch: 'feat/invoice-pdf-export',
		parent: PSYON,
	},
	calendar: {
		tid: 'term-jvs-calendar',
		sid: 'sess-jvs-calendar',
		projectId: 'proj-jvs-calendar',
		project: 'fix/rental-calendar-overlap',
		name: 'Kalendář pronájmů: překrývající se rezervace jeřábu (ClientCare #4198)',
		branch: 'fix/rental-calendar-overlap',
		parent: JVS,
	},
	helm: {
		tid: 'term-helm-vault',
		sid: 'sess-helm-vault',
		projectId: 'cwd:/fixture/vault',
		project: 'vault',
		name: 'inbox-triage',
		branch: 'main',
	},
} satisfies Record<string, Pane>

const prLink = (number: number): Json => ({
	number,
	url: `https://github.com/contember-external/crane-rental/pull/${number}`,
	repository: 'contember-external/crane-rental',
	last_seen_at: '2026-11-03T09:00:00Z',
})

/** The Agents pane's day, through the real reducer: Okena polls and Helm's hub polls, interleaved. */
function agentsPaneTimeline(now: number): {
	steps: Array<[number, AgentDockObservation]>
	live: Live
	version: number
} {
	const p = agentsPanes
	const prefix = String(recordedDialog().id).split('-')[0]
	const subagents = (count: number): Json[] =>
		Array.from({ length: count }, (_, index) => ({ agent_id: `sub-psyon-${index + 1}`, agent_type: 'Explore' }))
	const busy = (pane: Pane, overrides: Json = {}) => detail(pane, { busy: true, ...overrides })
	const idle = (pane: Pane, overrides: Json = {}) => detail(pane, { busy: false, ...overrides })
	const repairPrs = { pr_links: [prLink(956), prLink(484)] }
	const imagePrs = { pr_links: [prLink(953)] }
	const question = busy(p.invoices, {
		dialogs: [
			{
				id: `${prefix}-71`,
				tool_name: 'AskUserQuestion',
				tool_input: {
					questions: [
						{
							header: 'Logo',
							question: 'Má být logo firmy v PDF vpravo nahoře, nebo v patičce?',
							multiSelect: false,
							options: [{ label: 'Vpravo nahoře' }, { label: 'V patičce' }],
						},
					],
				},
				permission_suggestions: [],
				created_at_ms: now - 12 * MINUTE,
			},
		],
	})
	const okena = (version: number, live: Live, unreadable: Pane[] = []): AgentDockObservation => {
		const observation = poll(version, live)
		return {
			...observation,
			terminals: observation.terminals.map(terminal =>
				unreadable.some(pane => pane.tid === terminal.terminalId)
					? { terminalId: terminal.terminalId, detail: { ok: false, error: 'read timed out after 5000 ms' } }
					: terminal,
			),
		}
	}
	const helm = (version: number, body: Json, page?: Json): AgentDockObservation => ({
		...poll(version, [{ pane: p.helm, body, ...(page ? { transcript: page } : {}) }]),
		source: 'helm',
		profile: 'helm',
	})
	const ended = (pane: Pane, uuid: string, text: string): Json =>
		transcript(pane, [assistant(uuid, text)], 2_000, false)
	// Before: everything busy except Psyon's main checkout (idle until it starts 4 minutes ago).
	const early: Live = [
		{ pane: p.psyon, body: idle(p.psyon), transcript: seedPage(p.psyon, 'psyon-a0') },
		{ pane: p.repair, body: busy(p.repair, repairPrs), transcript: seedPage(p.repair, 'repair-a0') },
		{ pane: p.imageLink, body: busy(p.imageLink, imagePrs), transcript: seedPage(p.imageLink, 'image-a0') },
		{ pane: p.invoices, body: busy(p.invoices), transcript: seedPage(p.invoices, 'invoices-a0') },
		{ pane: p.calendar, body: busy(p.calendar), transcript: seedPage(p.calendar, 'calendar-a0') },
	]
	const at12: Live = bare(early).map(entry =>
		entry.pane === p.invoices ? { pane: p.invoices, body: question } : entry,
	)
	const at4: Live = at12.map(entry =>
		entry.pane === p.psyon ? { pane: p.psyon, body: busy(p.psyon, { running_subagents: subagents(4) }) } : entry,
	)
	const endedNow: Live = at4.map(entry =>
		entry.pane === p.repair
			? {
					pane: p.repair,
					body: idle(p.repair, repairPrs),
					transcript: ended(p.repair, 'repair-a1', 'Hotovo, PR #956 je mergnutý. Mám zavřít i #484?'),
				}
			: entry.pane === p.imageLink
				? {
						pane: p.imageLink,
						body: idle(p.imageLink, imagePrs),
						transcript: ended(
							p.imageLink,
							'image-a1',
							'PR #953 je otevřený, odkaz na obrázek je v protokolu i v e-mailu.',
						),
					}
				: entry,
	)
	const helmWorking = busy(p.helm)
	const helmBackground = idle(p.helm, {
		running_subagents: [{ agent_id: 'background-1', agent_type: 'background task' }],
	})
	const steps: Array<[number, AgentDockObservation]> = [
		[now - 30 * MINUTE, okena(8_001, early)],
		[now - 30 * MINUTE + 1_000, helm(1, helmWorking, seedPage(p.helm, 'helm-a0'))],
		[now - 12 * MINUTE, okena(8_002, at12)],
		[now - 9 * MINUTE, helm(2, helmBackground)],
		[now - 4 * MINUTE, okena(8_003, at4)],
		[now - 2 * MINUTE, okena(8_004, bare(at4), [p.calendar])],
		[now - 40_000, okena(8_005, endedNow, [p.calendar])],
		[now - 30_000, okena(8_006, bare(endedNow), [p.calendar])],
		[now - 1_500, helm(3, helmBackground)],
		[now - 1_000, okena(8_007, bare(endedNow), [p.calendar])],
	]
	return { steps, live: bare(endedNow), version: 8_007 }
}

/** The Agents overview's panes (AgentDockScenario 'agents-overview'); `helm` is a Helm terminal. */
const overviewPanes = {
	...agentsPanes,
	deploy: {
		tid: 'term-jvs-deploy',
		sid: 'sess-jvs-deploy',
		projectId: 'proj-jvs-deploy',
		project: 'chore/stage-deploy',
		name: 'Nasadit stage s novými API klíči (ClientCare #4230)',
		branch: 'chore/stage-deploy',
		parent: JVS,
	},
	contacts: {
		tid: 'term-psyon-contacts',
		sid: 'sess-psyon-contacts',
		projectId: 'proj-psyon-contacts',
		project: 'feat/contact-import',
		name: 'Import kontaktů z CSV podle IČO (ClientCare #4219)',
		branch: 'feat/contact-import',
		parent: PSYON,
	},
	notes: {
		tid: 'term-vault-notes',
		sid: 'sess-vault-notes',
		projectId: 'proj-vault',
		project: 'vault',
		name: 'notes',
		branch: 'main',
	},
} satisfies Record<string, Pane>

/** What each overview agent last said (first lines are what the Agents pane shows). */
export const OVERVIEW_MESSAGES = {
	psyon: 'Procházím všechny moduly fakturace a sepisuji, co jde sdílet.\n\nZatím: export, upomínky, ISDOC.',
	invoices: 'Generátor PDF je hotový, zbývá rozhodnout umístění loga.',
	deploy: 'Klíče jsou vygenerované, teď je nahraju na stage.',
	contacts: 'Plán importu kontaktů je hotový, posílám ho ke schválení.',
	repair: 'Hotovo, PR #956 je mergnutý a oprava stavu po dokončení opravy je na stage.\n\nMám zavřít i #484?',
	imageLink: [
		'**PR #953 je otevřený**: odkaz na obrázek je v protokolu i v e-mailu.',
		'',
		'- Protokol: odkaz pod fotkou vede na plnou velikost (`/media/{id}`).',
		'- E-mail: příloha zůstala jen jako odkaz, aby zpráva nepřekročila limit.',
		'',
		'Testy prošly; čeká to na review.',
	].join('\n'),
	calendar: 'Opravuji kontrolu překryvu rezervací jeřábu.',
	notes: 'Poznámky jsou seřazené podle data.',
	helm: 'Třídím inbox: 12 poznámek, 3 k archivaci.\n\nNa pozadí běží přepočet odkazů.',
} as const

/**
 * The Agents overview's day, through the real reducer: Okena polls and Helm's hub polls, interleaved.
 * `withHelm: false` leaves Helm's hub out (its agent never shows).
 */
function agentsOverviewRun(now: number, start: AgentDockState, withHelm = true): ScenarioRun {
	const p = overviewPanes
	const m = OVERVIEW_MESSAGES
	const prefix = String(recordedDialog().id).split('-')[0]
	const busy = (pane: Pane, overrides: Json = {}) => detail(pane, { busy: true, ...overrides })
	const idle = (pane: Pane, overrides: Json = {}) => detail(pane, { busy: false, ...overrides })
	const seed = (pane: Pane, uuid: string, text: string): Json =>
		transcript(pane, [user(`${uuid}-u`, 'Start.'), assistant(uuid, text)], 1_000, true)
	const ended = (pane: Pane, uuid: string, text: string): Json =>
		transcript(pane, [assistant(uuid, text)], 2_000, false)
	const dialog = (n: number, tool: string, input: Json, at: number): Json => ({
		id: `${prefix}-${n}`,
		tool_name: tool,
		tool_input: input,
		permission_suggestions: [],
		created_at_ms: at,
	})
	const repairPrs = { pr_links: [prLink(956), prLink(484)] }
	const imagePrs = { pr_links: [prLink(953)] }
	const subagents = Array.from({ length: 4 }, (_, index) => ({ agent_id: `sub-${index + 1}`, agent_type: 'Explore' }))
	const notConnected = { ...detail(p.notes), hooks_attached: false, channel_attached: false, busy: undefined }

	const question = busy(p.invoices, {
		dialogs: [
			dialog(
				71,
				'AskUserQuestion',
				{
					questions: [
						{
							header: 'Logo',
							question: 'Má být logo firmy v PDF vpravo nahoře, nebo v patičce?',
							multiSelect: false,
							options: [{ label: 'Vpravo nahoře' }, { label: 'V patičce' }],
						},
					],
				},
				now - 12 * MINUTE,
			),
		],
	})
	const plan = busy(p.contacts, {
		dialogs: [
			dialog(
				72,
				'ExitPlanMode',
				{
					plan: '# Import kontaktů z CSV\n1. Načíst CSV\n2. Spárovat kontakty podle IČO\n3. Nové založit, staré doplnit',
				},
				now - 25 * MINUTE,
			),
		],
	})
	const permission = busy(p.deploy, {
		dialogs: [
			dialog(
				73,
				'Bash',
				{ command: 'npm run keys:rotate -- --env stage', description: 'Rotate the stage API keys' },
				now - 3 * MINUTE,
			),
		],
	})

	let live: Live = [
		{ pane: p.psyon, body: idle(p.psyon), transcript: seed(p.psyon, 'psyon-a0', m.psyon) },
		{ pane: p.invoices, body: busy(p.invoices), transcript: seed(p.invoices, 'invoices-a0', m.invoices) },
		{ pane: p.deploy, body: busy(p.deploy), transcript: seed(p.deploy, 'deploy-a0', m.deploy) },
		{ pane: p.contacts, body: busy(p.contacts), transcript: seed(p.contacts, 'contacts-a0', m.contacts) },
		{ pane: p.repair, body: busy(p.repair, repairPrs), transcript: seed(p.repair, 'repair-a0', 'Začínám.') },
		{ pane: p.imageLink, body: busy(p.imageLink, imagePrs), transcript: seed(p.imageLink, 'image-a0', 'Začínám.') },
		{ pane: p.calendar, body: busy(p.calendar), transcript: seed(p.calendar, 'calendar-a0', m.calendar) },
		{ pane: p.notes, body: notConnected, transcript: seed(p.notes, 'notes-a0', m.notes) },
	]
	let version = 9_000
	let state = start
	const okena = (at: number, unreadable: Pane[] = []) => {
		const observation = poll(++version, live)
		state = reduce(
			state,
			{
				...observation,
				terminals: observation.terminals.map(terminal =>
					unreadable.some(pane => pane.tid === terminal.terminalId)
						? { terminalId: terminal.terminalId, detail: { ok: false, error: 'read timed out after 5000 ms' } }
						: terminal,
				),
			},
			at,
		).state
		live = bare(live)
	}
	const swap = (pane: Pane, body: Json, page?: Json) => {
		live = live.map(entry => (entry.pane === pane ? { pane, body, ...(page ? { transcript: page } : {}) } : entry))
	}
	let helmVersion = 0
	const helm = (at: number, body: Json, page?: Json) => {
		if (!withHelm) return
		state = reduce(
			state,
			{
				...poll(++helmVersion, [{ pane: p.helm, body, ...(page ? { transcript: page } : {}) }]),
				source: 'helm',
				profile: 'helm',
			},
			at,
		).state
	}
	// Helm's hub counts the Stop hook's background tasks: one shell (the link recount) still runs.
	const helmBackground = idle(p.helm, { background_tasks: 1, background_shells: 1 })

	okena(now - 60 * MINUTE)
	helm(now - 60 * MINUTE + 1_000, busy(p.helm), seed(p.helm, 'helm-a0', m.helm))
	// Repair: its turn ends 45 minutes ago and still waits for a reply.
	swap(p.repair, idle(p.repair, repairPrs), ended(p.repair, 'repair-a1', m.repair))
	okena(now - 45 * MINUTE)
	okena(now - 45 * MINUTE + TURN_IDLE_MS + 1_000)
	// Service protocol: its turn ends 25 minutes ago and is read (acked) 15 minutes ago; a plan asks.
	swap(p.imageLink, idle(p.imageLink, imagePrs), ended(p.imageLink, 'image-a1', m.imageLink))
	swap(p.contacts, plan)
	okena(now - 25 * MINUTE)
	okena(now - 25 * MINUTE + TURN_IDLE_MS + 1_000)
	const read = state.items.find(item => item.session === `${PROFILE}:${p.imageLink.tid}` && item.kind === 'turn')
	if (read) state = reduce(state, { type: 'ack', itemId: read.id }, now - 15 * MINUTE).state
	swap(p.invoices, question)
	okena(now - 12 * MINUTE)
	helm(now - 9 * MINUTE, helmBackground)
	swap(p.psyon, busy(p.psyon, { running_subagents: subagents }))
	okena(now - 4 * MINUTE)
	swap(p.deploy, permission)
	okena(now - 3 * MINUTE)
	okena(now - 2 * MINUTE, [p.calendar])
	helm(now - 1_500, helmBackground)
	okena(now - 1_000, [p.calendar])
	return {
		state,
		live,
		version,
		...(withHelm ? { helmLive: [{ pane: p.helm, body: helmBackground }] } : {}),
		unreadable: [p.calendar.tid],
	}
}

/** 'agents-okena-down' / 'agents-helm-connecting': the overview's day with one source not answering. */
function agentsSourceHealthRun(
	name: 'agents-okena-down' | 'agents-helm-connecting',
	now: number,
	start: AgentDockState,
): ScenarioRun {
	if (name === 'agents-okena-down') {
		const run = agentsOverviewRun(now - 3 * MINUTE, start)
		return { ...run, state: reduce(run.state, down('connect ECONNREFUSED'), now - 2 * MINUTE).state }
	}
	// Helm's hub registered but has not answered yet: the shape of its first poll still on its way.
	const run = agentsOverviewRun(now, start, false)
	const sources: AgentDockState['sources'] = {
		...run.state.sources,
		helm: { seeded: false, epoch: 0, health: { state: 'pending', since: now - 20_000, lastObservedAt: null } },
	}
	return { ...run, state: { ...run.state, sources, source: aggregateSourceHealth(sources, run.state.source) } }
}

/** 'background-shell': the stage deploy runs in a background shell after Claude stopped. */
function backgroundShellTimeline(now: number): {
	steps: Array<[number, AgentDockObservation]>
	live: Live
	version: number
} {
	const pane = agentsPanes.imageLink
	const shell: ObservedBackgroundTasks = { sessionId: pane.sid, tasks: 1, shells: 1 }
	const working = detail(pane, { busy: true, pr_links: [prLink(953)] })
	const idle = { ...working, busy: false }
	const start = transcript(
		pane,
		[user('image-u0', 'Mergni to a nasaď na stage.'), assistant('image-a0', 'Jdu na to.')],
		1_000,
		true,
	)
	const ended = transcript(
		pane,
		[assistant('image-a1', 'PR #953 je mergnutý. Stage deploy běží, ozvu se, až doběhne.')],
		2_000,
		false,
	)
	const steps: Array<[number, AgentDockObservation]> = [
		[now - 20 * MINUTE, poll(9_001, [{ pane, body: working, transcript: start }])],
		[now - 2 * MINUTE, poll(9_002, [{ pane, body: idle, transcript: ended, background: shell }])],
		[now - 2 * MINUTE + TURN_IDLE_MS, poll(9_003, [{ pane, body: idle, background: shell }])],
	]
	return { steps, live: [{ pane, body: idle, background: shell }], version: 9_003 }
}

interface ScenarioRun {
	state: AgentDockState
	/** The panes as Okena last showed them (no transcript pages), for follow-up polls. */
	live: Live
	/** Panes of Helm's own hub when the run has both sources (follow-up polls of those carry `helm`). */
	helmLive?: Live
	/** Panes whose detail stays unreadable in follow-up polls. */
	unreadable?: string[]
	version: number
	/** Answers this run sent from the dock, as the dock would remember them (receipt stories). */
	sent?: Map<number, DockAction>
	/** Source the run's panes belong to (default Okena); follow-up polls carry it. */
	source?: DockSourceId
}

const fromSource = (scenario: ScenarioRun, observation: AgentDockObservation): AgentDockObservation => {
	if (observation.type !== 'poll') return observation
	const unreadable = scenario.unreadable ?? []
	const terminals = unreadable.length
		? observation.terminals.map(terminal =>
				unreadable.includes(terminal.terminalId)
					? { terminalId: terminal.terminalId, detail: { ok: false as const, error: 'read timed out after 5000 ms' } }
					: terminal,
			)
		: observation.terminals
	return { ...observation, ...(scenario.source ? { source: scenario.source } : {}), terminals }
}

const bare = (live: Live): Live =>
	live.map(({ pane, body, background }) => ({ pane, body, ...(background ? { background } : {}) }))

function scenarioRun(name: AgentDockScenario, now: number): ScenarioRun {
	const persisted = { version: 1 as const, nextItemId: 3, seen: { [`${PROFILE}:${panes.turn.tid}`]: 'turn-a0' } }
	const start = createAgentDockState(persisted, now - 3 * 60 * MINUTE)
	if (name === 'connecting') return { state: start, live: [], version: 0 }
	if (name === 'empty') return { state: run([[now - 1_000, poll(1, [])]], start), live: [], version: 1 }
	if (name === 'single-turn' || name === 'markdown-turn' || name === 'pr-links-turn') {
		const prs = name === 'pr-links-turn' ? { pr_links: [166, 164, 159, 136].map(prLink) } : {}
		const working = detail(panes.turn, { busy: true, ...prs })
		const idle = { ...working, busy: false }
		const page = transcript(
			panes.turn,
			[
				assistant(
					'turn-a1',
					name === 'markdown-turn'
						? TURN_MARKDOWN_TEXT
						: 'Hotovo. Commit 1a84c0e je na main, working tree je čistý.\n\nMám to pushnout?',
				),
			],
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
	if (name === 'long-turn') return longTurnRun(now, start)
	if (name === 'reveal-okena') return revealRun(now, start, 'okena')
	if (name === 'reveal-helm') return revealRun(now, start, 'helm')
	if (name === 'agents-pane') {
		const timeline = agentsPaneTimeline(now)
		return { state: run(timeline.steps, start), live: timeline.live, version: timeline.version }
	}
	if (name === 'agents-overview') return agentsOverviewRun(now, start)
	if (name === 'agents-okena-down' || name === 'agents-helm-connecting') return agentsSourceHealthRun(name, now, start)
	if (name === 'background-shell') {
		const timeline = backgroundShellTimeline(now)
		return { state: run(timeline.steps, start), live: timeline.live, version: timeline.version }
	}
	if (name === 'real-case' || name === 'overflow') {
		const timeline = name === 'real-case' ? realCaseTimeline(now) : overflowTimeline(now)
		return { state: run(timeline.steps, start), live: bare(timeline.live), version: timeline.version }
	}
	if (name === 'crowded') {
		const crowded = busyTimeline(now, true)
		return { state: run(crowded.steps, start), live: bare(crowded.live), version: crowded.version }
	}
	if (name === 'helm-terminals' || name === 'helm-add-directories') {
		const crowded = busyTimeline(
			now,
			true,
			name === 'helm-add-directories'
				? [
						bashSuggestion('npm run deploy:stage'),
						{ type: 'addDirectories', directories: ['/fixture/neumie-veka-worker'], destination: 'session' },
					]
				: undefined,
		)
		const steps: Array<[number, AgentDockObservation]> = crowded.steps.map(([at, observation]) => [
			at,
			{ ...observation, source: 'helm' } as AgentDockObservation,
		])
		// Okena answers too (nothing of its own open), so the row's health names both sources.
		steps.push([now - 1_000, { ...poll(1, []), profile: 'okena-storybook', source: 'okena' }])
		return { state: run(steps, start), live: bare(crowded.live), version: crowded.version, source: 'helm' }
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

const paneOfKey = (key: string): Pane | undefined =>
	[
		...Object.values(panes),
		...Object.values(realPanes),
		...Object.values(agentsPanes),
		...Object.values(overviewPanes),
	].find(pane => `${PROFILE}:${pane.tid}` === key || `helm:${pane.tid}` === key)

const paneOf = (item: DockItem): Pane | undefined => paneOfKey(item.session)

/**
 * The next Okena poll after Jakub's answer landed (from the dock, or typed in the terminal): the
 * dialog is gone from its pane, or (a reply) the pane is busy and the transcript shows the user entry.
 */
function landedPoll(scenario: ScenarioRun, item: DockItem, reply = '(reply from the dock)'): AgentDockObservation {
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
			transcript: transcript(entry.pane, [user(`reply-${item.id}`, reply)], 9_000 + scenario.version, false),
		}
	})
	scenario.live = bare(live)
	return fromSource(scenario, poll(scenario.version, live))
}

/**
 * The next poll after a reply from the agent detail landed: the pane works on it and its transcript
 * shows the user entry after the message Jakub read.
 */
function promptLandedPoll(scenario: ScenarioRun, key: string): AgentDockObservation {
	const pane = paneOfKey(key)
	const onHelm = scenario.helmLive?.some(entry => entry.pane === pane) === true
	const live = (onHelm ? scenario.helmLive : scenario.live) ?? []
	scenario.version += 1
	const next: Live = live.map(entry =>
		entry.pane !== pane
			? entry
			: {
					pane: entry.pane,
					body: { ...entry.body, busy: true },
					transcript: transcript(
						entry.pane,
						[user(`dock-reply-${scenario.version}`, '(reply from the dock)')],
						9_000 + scenario.version,
						false,
					),
				},
	)
	if (onHelm) {
		scenario.helmLive = bare(next)
		return { ...poll(scenario.version, next), source: 'helm', profile: 'helm' }
	}
	scenario.live = bare(next)
	return fromSource(scenario, poll(scenario.version, next))
}

/** A poll that shows nothing new (the answer has not landed). */
function samePoll(scenario: ScenarioRun): AgentDockObservation {
	scenario.version += 1
	return fromSource(scenario, poll(scenario.version, scenario.live))
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

/** What `emitArrival` brings in: a new agent's ask of that kind, or its finished turn. */
export type AgentDockArrivalKind = 'question' | 'permission' | 'plan' | 'turn'

/** The agent each arrival comes from (numbered past the first, so every arrival is a new pane). */
function arrivalPane(kind: AgentDockArrivalKind, n: number): Pane {
	const branch = {
		question: 'feat/invoice-reminders',
		permission: 'chore/rotate-stage-keys',
		plan: 'feat/contact-import',
		turn: 'fix/pdf-export-fonts',
	}[kind]
	return {
		tid: `term-arrive-${n}`,
		sid: `sess-arrive-${n}`,
		// A project of its own: Okena reports the git branch per project.
		projectId: `proj-arrive-${n}`,
		project: 'crm-billing',
		name: `ClientCare #${4200 + n}`,
		branch: n > 1 ? `${branch}-${n}` : branch,
	}
}

/** The pane as Okena shows it once the arriving item is up (at `at`). */
function arrivalBody(kind: AgentDockArrivalKind, pane: Pane, n: number, at: number): Json {
	const prefix = String(recordedDialog().id).split('-')[0]
	const id = `${prefix}-${90 + n}`
	if (kind === 'turn') return detail(pane, { busy: false })
	const dialog =
		kind === 'question'
			? {
					id,
					tool_name: 'AskUserQuestion',
					tool_input: {
						questions: [
							{
								header: 'Reminder',
								question: 'Kdy poslat první upomínku k neuhrazené faktuře?',
								multiSelect: false,
								options: [
									{ label: 'Den po splatnosti', description: 'Hned následující pracovní den.' },
									{ label: 'Týden po splatnosti', description: 'Dá klientovi čas na pomalou platbu.' },
								],
							},
						],
					},
				}
			: kind === 'plan'
				? { id, tool_name: 'ExitPlanMode', tool_input: { plan: '1. Parse the CSV\n2. Upsert contacts by IČO' } }
				: {
						id,
						tool_name: 'Bash',
						tool_input: { command: 'npm run keys:rotate -- --env stage', description: 'Rotate the stage API keys' },
					}
	return detail(pane, { busy: true, dialogs: [{ ...dialog, permission_suggestions: [], created_at_ms: at }] })
}

/** How the in-memory act behaves (browser tests switch it; stories use the default). */
export type AgentDockActMode = 'confirm' | 'unconfirmed' | 'refused' | 'error'

/**
 * What the next "Show in Okena" does: focus and raise Okena (default), focus without raising it (plainly,
 * or blocked by Automation with main's once-per-run fix), find the terminal gone, or find Okena
 * unreachable (main's words, `reveal.ts` REVEAL_TEXT).
 */
export type AgentDockRevealMode = 'shown' | 'not-raised' | 'needs-automation' | 'gone' | 'unreachable'

const REVEAL_MODE_RESULT: Record<AgentDockRevealMode, AgentDockRevealResult> = {
	shown: { ok: true, activated: true },
	'not-raised': { ok: true, activated: false },
	'needs-automation': { ok: true, activated: false, note: REVEAL_TEXT.needsAutomation },
	gone: { ok: false, detail: "The agent's terminal is no longer open in Okena." },
	unreachable: { ok: false, detail: 'Okena is unreachable: connect ECONNREFUSED 127.0.0.1:19100' },
}

/** Pause between the fixture act's steps, so Sending… is visible. */
export const FIXTURE_ACT_STEP_MS = 250

export interface AgentDockFixture {
	api: AgentDockApi
	calls: {
		visible: boolean[]
		acks: number[]
		acts: AgentDockActRequest[]
		prompts: AgentDockPromptRequest[]
		reads: string[]
		/** Session keys "Show in Okena" asked main to show (Helm terminals never reach the api). */
		reveals: string[]
		/** Every "Notify when Helm is in the background" value the dock reported to main. */
		notify: boolean[]
	}
	/** Answers the current scenario already sent from the dock (the receipt stories), for AgentDock's initialSent. */
	sent(): ReadonlyMap<number, DockAction>
	/** Replaces the reducer state with a scenario and pushes its snapshot through the production subscription. */
	emitScenario(name: AgentDockScenario): void
	/**
	 * A new agent's item arrives in the current scenario, through the real reducer: the pane is first
	 * seen working, then asks (one poll later) or ends its turn (and stays idle past TURN_IDLE_MS). One
	 * snapshot is pushed, with the new item.
	 */
	emitArrival(kind: AgentDockArrivalKind): void
	/**
	 * Jakub answers an item in its terminal, not from the dock: the next poll shows its dialog gone
	 * (an ask: answered in terminal) or the pane working on his reply after the turn (replied in terminal).
	 */
	emitAnsweredInTerminal(itemId: number): void
	/** What the next acts do: land and get observed (default), never get observed, refused (answered elsewhere), or fail. */
	setActMode(mode: AgentDockActMode): void
	/** What the next "Show in Okena" answers. */
	setRevealMode(mode: AgentDockRevealMode): void
	/** Main's half of a clicked dock notification: the window came forward; open the pane on this item. */
	emitNotificationClick(itemId: number | null): void
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
	const calls: AgentDockFixture['calls'] = {
		visible: [],
		acks: [],
		acts: [],
		prompts: [],
		reads: [],
		reveals: [],
		notify: [],
	}
	const openListeners = new Set<(itemId: number | null) => void>()
	let scenario: ScenarioRun | null = initial ? scenarioRun(initial, clock()) : null
	let mode: AgentDockActMode = 'confirm'
	let revealMode: AgentDockRevealMode = 'shown'
	let arrivals = 0
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
			setNotify(enabled) {
				calls.notify.push(enabled)
			},
			onOpenItem(listener) {
				openListeners.add(listener)
				return () => openListeners.delete(listener)
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
			// A reply from the agent detail: the same act observations main would apply, then the landing poll.
			async prompt(request): Promise<AgentDockActResult> {
				calls.prompts.push(structuredClone(request))
				const current = scenario
				if (!current?.state.sessions[request.session])
					return { ok: false, outcome: { status: 'refused', reason: 'gone', detail: 'The agent is no longer listed.' } }
				apply({
					type: 'prompt.sending',
					session: request.session,
					...(request.assistantUuid ? { assistantUuid: request.assistantUuid } : {}),
				})
				await wait(FIXTURE_ACT_STEP_MS)
				const outcome: DockActOutcome =
					mode === 'error'
						? {
								status: 'failed',
								detail: `Okena POST /v1/claude/terminals/${paneOfKey(request.session)?.tid ?? 'unknown'}/prompt failed (500): bridge unavailable`,
							}
						: mode === 'refused'
							? { status: 'refused', reason: 'changed', detail: 'The agent said something new; check it again.' }
							: { status: 'sent', delivery: 'pty' }
				apply({ type: 'prompt.result', session: request.session, outcome })
				if (mode === 'confirm') later(() => apply(promptLandedPoll(current, request.session)))
				if (mode === 'unconfirmed') later(() => apply(samePoll(current), clock() + ACT_CONFIRM_MS))
				return { ok: outcome.status === 'sent', outcome }
			},
			// The live read: what the reducer last read for the pane (its full text, in memory).
			async lastMessage(session): Promise<AgentDockMessageResult> {
				calls.reads.push(session)
				const record = scenario?.state.sessions[session]
				if (!record) return { ok: false, detail: 'The agent is no longer listed.' }
				const last = record.tail.lastAssistant
				return {
					ok: true,
					...(record.session.sessionId ? { sessionId: record.session.sessionId } : {}),
					...(last ? { message: { uuid: last.uuid, text: last.text } } : {}),
				}
			},
			// Main's "Show in Okena": the call is recorded; the answer follows setRevealMode after a beat.
			async reveal(session): Promise<AgentDockRevealResult> {
				calls.reveals.push(session)
				await wait(FIXTURE_ACT_STEP_MS)
				return structuredClone(REVEAL_MODE_RESULT[revealMode])
			},
		},
		emitNotificationClick(itemId) {
			for (const listener of openListeners) listener(itemId)
		},
		emitScenario(name) {
			scenario = scenarioRun(name, clock())
			push()
		},
		emitArrival(kind) {
			if (!scenario) return
			const current = scenario
			const at = clock()
			const n = ++arrivals
			const pane = arrivalPane(kind, n)
			const step = (live: Live, stamp = at) => {
				current.version += 1
				current.state = reduce(current.state, fromSource(current, poll(current.version, live)), stamp).state
			}
			step([
				...current.live,
				{ pane, body: detail(pane, { busy: true }), transcript: seedPage(pane, `${pane.tid}-a0`) },
			])
			const body = arrivalBody(kind, pane, n, at)
			const page =
				kind === 'turn'
					? transcript(
							pane,
							[assistant(`${pane.tid}-a1`, 'Hotovo. Fonty v PDF exportu se teď vkládají celé.\n\nMám otevřít PR?')],
							2_000,
							false,
						)
					: undefined
			step([...current.live, { pane, body, ...(page ? { transcript: page } : {}) }])
			current.live = [...current.live, { pane, body }]
			// A turn counts once the pane stayed idle TURN_IDLE_MS (Storybook only: stamped ahead of the wall clock).
			if (kind === 'turn') step(current.live, at + TURN_IDLE_MS + 1)
			push()
		},
		emitAnsweredInTerminal(itemId) {
			const current = scenario
			const item = current?.state.items.find(candidate => candidate.id === itemId)
			if (!current || !item) return
			apply(landedPoll(current, item, '(typed in the terminal)'))
		},
		setActMode(next) {
			mode = next
		},
		setRevealMode(next) {
			revealMode = next
		},
		sent: () => scenario?.sent ?? new Map(),
		listenerCount: () => listeners.size,
	}
}

/** A recorded-looking shell session for stories: fills the terminal so the rows above the dock show. */
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
 * block. A stress test for the dock's edge (§3.24 Surface): Claude Code's own thin rules
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
