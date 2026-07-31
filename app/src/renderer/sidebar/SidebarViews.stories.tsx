import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ReactNode, useState } from 'react'
import type { PiAgentStatusIntegrationSnapshot } from '../../shared'
import type { DashboardItem, HelmSnapshot, ScheduledSchedule, ScheduledScheduleInput } from '../../shared-helm'
import { AgentIntegrationsPage } from './AgentIntegrationsPage'
import { AppearancePage } from './AppearancePage'
import { DetailPage } from './DetailPage'
import { PlanPage, TaskPage } from './DetailSubpages'
import { ListPage } from './ListPage'
import { NewItemPage } from './NewItemPage'
import { ProfilesPage } from './ProfilesPage'
import { ScheduledRunEditorPage, ScheduledRunsPage } from './ScheduledRunsPage'
import { SettingsPage, type SettingsStore } from './SettingsPage'
import { SidebarRoot } from './SidebarRoot'
import { TerminalSettingsPage } from './TerminalSettingsPage'

const NOW = '2026-07-21T12:00:00.000Z'

type StoryWindow = Window & {
	__createdItemBody?: unknown
	__createItemCalls?: number
	__deferCreateItem?: boolean
	__resolveCreateItem?: () => void
	__openedExternalUrls?: string[]
	__updatedConfigBody?: Record<string, unknown>
	__restartDaemonCalls?: number
	__failNextScheduledAction?: boolean
}

export function item(overrides: Partial<DashboardItem>): DashboardItem {
	const status = overrides.status ?? 'review'
	return {
		id: overrides.id ?? `item-${status}`,
		kind: 'solve',
		executionMode: 'solve',
		status,
		workMode: status === 'inbox' ? null : 'agent',
		projectSlug: 'helm',
		title: 'Keep terminal sessions visible after relaunch',
		displayName: 'Restore terminal sessions',
		assessment: null,
		source: { provider: 'Contember', externalId: 'task-story', url: 'https://example.test/tasks/story' },
		captured: false,
		runContextEdited: false,
		canAssignProject: false,
		baseRef: 'main',
		spawner: 'okena',
		groupId: null,
		group: null,
		branchName: 'fix/restore-terminal-sessions',
		forkContext: null,
		plan: null,
		planStatus: null,
		resultSummary: null,
		solveInputSnapshot: null,
		solverAgent: 'claude',
		solverModel: 'claude-sonnet-5',
		solverEffort: 'high',
		solverWorkspace: 'worktree',
		errorMessage: null,
		errorPhase: null,
		runOutcome: status === 'review' || status === 'done' ? 'ok' : null,
		deployState: null,
		card: {
			state: status,
			statusLabel: status === 'review' ? 'Needs review' : status,
			statusTone: 'gray',
			pulse: false,
		},
		allowedActions: status === 'review' ? [{ id: 'retry', label: 'Retry', tone: 'muted' }] : [],
		runObservation: {
			source: 'solve',
			state: status === 'running' ? 'running' : status === 'review' ? 'review' : 'idle',
			stateLabel: status === 'running' ? 'Running' : status === 'review' ? 'Ready for review' : 'Idle',
			summary: null,
			events: [],
			log: { path: null, available: false, content: '', truncated: false },
			pr: { url: null, state: null, merged: null },
			almanac: { runId: null, statusPath: null, status: null, round: null, summary: null, failureReason: null },
		},
		links: { source: { label: 'Contember', url: 'https://example.test/tasks/story' }, branch: null, pr: null },
		createdAt: '2026-07-21T08:00:00.000Z',
		queuedAt: '2026-07-21T08:05:00.000Z',
		startedAt: '2026-07-21T08:06:00.000Z',
		completedAt: status === 'review' || status === 'done' ? '2026-07-21T10:35:00.000Z' : null,
		plannedAt: null,
		updatedAt: NOW,
		...overrides,
	}
}

const reviewItem = item({
	id: 'review-story',
	title: 'Background terminals should preserve activity and explicit ownership',
	displayName: 'Preserve background terminals',
	assessment: {
		intent: 'Keep parked sessions alive and make Open distinct from restoring a tab.',
		verdict: 'clear',
		clarifyingQuestions: [],
		securityNote: null,
		assessedAt: NOW,
	},
	resultSummary: 'Added explicit Open, Tab, and Close controls with protocol-owned activity state.',
	solveInputSnapshot:
		'Treat parked state as ownership. Opening a parked terminal must not restore it to the tab strip.',
	deployState: {
		merged: false,
		mergedAt: null,
		mergeSha: null,
		deployments: [],
		checkedAt: NOW,
	},
	runObservation: {
		source: 'solve',
		state: 'review',
		stateLabel: 'Ready for review',
		summary: 'Implementation complete; tests and app build passed.',
		events: [
			{
				type: 'solve_completed',
				label: 'Implementation completed',
				tone: 'green',
				createdAt: '2026-07-21T10:35:00.000Z',
			},
			{ type: 'item_started', label: 'Agent started', tone: 'gray', createdAt: '2026-07-21T08:06:00.000Z' },
		],
		log: {
			path: 'logs/review-story.log',
			available: true,
			content:
				'[10:35:19] tests: 18 passed\n[10:34:02] app build completed\n[10:28:42] updated background terminal controls',
			truncated: false,
		},
		pr: { url: 'https://github.com/example/helm/pull/42', state: 'OPEN', merged: false },
		almanac: { runId: null, statusPath: null, status: null, round: null, summary: null, failureReason: null },
	},
	links: {
		source: { label: 'Contember', url: 'https://example.test/tasks/story' },
		branch: { label: 'fix/restore-terminal-sessions', url: null },
		pr: { label: 'Pull request #42', url: 'https://github.com/example/helm/pull/42' },
	},
	sourceTask: {
		title: 'Background terminals should preserve activity and explicit ownership',
		descriptionBlocks: [
			{ type: 'text', heading: 2, text: 'Expected behavior' },
			{ type: 'text', text: 'Open should display the terminal without moving it back into the tab strip.' },
			{ type: 'text', text: 'Tab should restore and focus it. Close should keep the five-second Undo grace period.' },
		],
		attachments: [
			{
				name: 'background-terminal-reference.png',
				url: '/api/items/review-story/attachments/reference.png',
				contentType: 'image/png',
			},
		],
		comments: [
			{
				author: 'Maya',
				createdAt: '2026-07-21T09:00:00.000Z',
				body: 'Please keep the activity signal consistent with active terminal tabs.',
			},
		],
		metadata: { Priority: 'High', Surface: 'Desktop' },
	},
	plan: {
		worktreePath: '/tmp/helm-review-story',
		branchName: 'fix/restore-terminal-sessions',
		planDirName: '2026-07-21-background-terminals',
		readmePath: 'docs/plans/2026-07-21-background-terminals/README.md',
	},
	planStatus: {
		stage: 'tickets_ready',
		specName: 'spec.md',
		localTickets: { total: 3, open: 0, readyForAgent: 0, readyForHuman: 0 },
		githubTickets: { total: 0, open: 0, readyForAgent: 0, readyForHuman: 0 },
		githubAvailable: true,
		checkedAt: NOW,
	},
	planArtifacts: [
		{
			name: 'spec.md',
			content:
				'# Background terminals\n\nPreserve ownership while allowing a parked session to be viewed.\n\n## Acceptance\n\n- Open keeps the session parked\n- Tab restores it\n- Close offers Undo',
		},
		{
			name: 'notes.md',
			content: 'Use OSC 9;4 as the only activity source. Never infer activity from arbitrary terminal output.',
		},
	],
	okenaWorkspace: {
		state: 'open',
		label: 'Focus in Okena',
		detail: 'The worktree is already open in Okena.',
		branchName: 'fix/restore-terminal-sessions',
		worktreePath: '/tmp/helm-review-story',
	},
})

const unassignedItem = item({
	id: 'unassigned-story',
	status: 'ready',
	workMode: null,
	projectSlug: null,
	title: 'Untitled item',
	displayName: null,
	source: null,
	canAssignProject: true,
	baseRef: null,
	branchName: null,
	startedAt: null,
	completedAt: null,
	runOutcome: null,
	allowedActions: [{ id: 'cancel', label: 'Cancel', tone: 'danger' }],
})

const listItems = [
	unassignedItem,
	reviewItem,
	item({
		id: 'failed-story',
		status: 'failed',
		projectSlug: 'client-care',
		displayName: 'Repair deployment watcher',
		title: 'Repair deployment watcher after a network timeout',
		errorMessage: 'GitHub request timed out',
		errorPhase: 'dispatch',
		runOutcome: 'errored',
		card: { state: 'failed', statusLabel: 'Failed', statusTone: 'red', pulse: false },
		allowedActions: [
			{ id: 'retry', label: 'Retry', tone: 'primary' },
			{ id: 'reopen', label: 'Reopen', tone: 'muted' },
		],
	}),
	item({
		id: 'running-story',
		status: 'running',
		projectSlug: 'helm',
		displayName: 'Normalize Storybook coverage',
		title: 'Normalize visual coverage across all Helm surfaces',
		completedAt: null,
		runOutcome: null,
		card: { state: 'running', statusLabel: 'Running', statusTone: 'blue', pulse: true },
		allowedActions: [{ id: 'cancel', label: 'Cancel', tone: 'danger' }],
	}),
	item({
		id: 'queue-story',
		status: 'ready',
		projectSlug: 'almanac',
		displayName: 'Improve loop diagnostics',
		title: 'Improve loop diagnostics and retain the original failure context',
		workMode: null,
		startedAt: null,
		completedAt: null,
		runOutcome: null,
		card: { state: 'ready', statusLabel: 'Queue', statusTone: 'gray', pulse: false },
		allowedActions: [{ id: 'start', label: 'Start', tone: 'primary' }],
	}),
	item({
		id: 'inbox-story',
		status: 'inbox',
		projectSlug: 'client-care',
		displayName: 'Clarify invoice export',
		title: 'Clarify the intended invoice export ordering',
		workMode: null,
		startedAt: null,
		completedAt: null,
		runOutcome: null,
		assessment: {
			intent: 'Choose the intended invoice sort order.',
			verdict: 'needs_clarification',
			clarifyingQuestions: ['Should invoices be sorted by issue date or invoice number?'],
			securityNote: null,
			assessedAt: NOW,
		},
		card: { state: 'inbox', statusLabel: 'Inbox', statusTone: 'amber', pulse: false },
		allowedActions: [
			{ id: 'approve', label: 'Approve and queue', tone: 'primary' },
			{ id: 'reject', label: 'Reject', tone: 'danger' },
		],
	}),
]

const snapshot: HelmSnapshot = {
	reachable: true,
	status: {
		protocolVersion: 37,
		buildId: 'storybook',
		uptime: 3600,
		profile: {
			id: 'work',
			name: 'Work',
			createdAt: NOW,
			enabledProjects: ['helm', 'client-care', 'almanac'],
			archivedAt: null,
		},
		profileGeneration: 3,
		queue: { paused: false, pending: 1, active: 1, maxConcurrency: 3, activeTasks: [] },
		projects: ['helm', 'client-care', 'almanac'],
		pollInterval: 30,
	},
	items: listItems,
	config: {
		projectColors: { helm: '#7aa2f7', 'client-care': '#bb9af7', almanac: '#9ece6a' },
		projects: [{ slug: 'helm' }, { slug: 'client-care' }, { slug: 'almanac' }],
		solver: { type: 'default', agent: 'claude', model: 'claude-sonnet-5', workspace: 'worktree' },
		modelCatalog: {
			claude: [{ id: 'claude-sonnet-5', label: 'Sonnet 5' }],
			codex: [{ id: 'gpt-5.6-luna', label: 'Luna' }],
			pi: [{ id: 'anthropic/claude-sonnet-5', label: 'Anthropic · Sonnet 5' }],
		},
	},
}

const profileDocument = {
	version: 1 as const,
	generation: 3,
	activeProfileId: 'work',
	configuredProjects: ['helm', 'clientcare', 'personal'],
	profiles: [
		{ id: 'work', name: 'Work', createdAt: NOW, enabledProjects: ['helm', 'clientcare'], archivedAt: null },
		{
			id: 'profile-0123456789ab',
			name: 'Personal',
			createdAt: NOW,
			enabledProjects: ['personal'],
			archivedAt: null,
		},
	],
}

function installBridge(
	detail: DashboardItem = reviewItem,
	piStatus: PiAgentStatusIntegrationSnapshot = {
		status: 'not-installed',
		message: 'Configure the pi-agent-status package for precise terminal status.',
	},
): void {
	const scheduledRuns: ScheduledSchedule[] = [
		{
			id: 'schedule-story',
			profileId: 'work',
			revision: 2,
			name: 'Morning checks',
			enabled: true,
			target: { kind: 'project', projectSlug: 'helm' },
			agent: 'claude',
			maximumRuntimeMinutes: 45,
			cron: '0 9 * * 1-5',
			cadenceKind: 'cron',
			timezone: 'America/New_York',
			nextRunAt: '2026-07-22T13:00:00.000Z',
			disabledReason: null,
			archivedAt: null,
			createdAt: NOW,
			updatedAt: NOW,
		},
	]
	Object.assign(window, {
		helm: {
			uiPreview: null,
			agentIntegrations: {
				piStatus: async () => piStatus,
			},
			external: {
				open: async (url: string) => {
					const storyWindow = window as StoryWindow
					storyWindow.__openedExternalUrls = [...(storyWindow.__openedExternalUrls ?? []), url]
					return true
				},
			},
			terminalPreferences: {
				get: async () => ({
					defaultCwd: '/Users/you/Developer',
					effectiveCwd: '/Users/you/Developer',
					usingFallback: false,
				}),
				chooseDefaultCwd: async () => null,
				resetDefaultCwd: async () => ({
					defaultCwd: null,
					effectiveCwd: '/Users/you',
					usingFallback: false,
				}),
			},
			daemon: {
				config: async () => (settingsStore.doc ? { data: settingsStore.doc } : { error: 'Settings unavailable' }),
				updateConfig: async (body: Record<string, unknown>) => {
					;(window as StoryWindow).__updatedConfigBody = structuredClone(body)
					return { data: { message: 'Restart required for preview', applied: false } }
				},
				restartDaemon: async () => {
					const storyWindow = window as StoryWindow
					storyWindow.__restartDaemonCalls = (storyWindow.__restartDaemonCalls ?? 0) + 1
					return { data: { message: 'Daemon restarting', applied: true } }
				},
				createItem: async (body: unknown) => {
					const storyWindow = window as StoryWindow
					storyWindow.__createdItemBody = body
					storyWindow.__createItemCalls = (storyWindow.__createItemCalls ?? 0) + 1
					if (storyWindow.__deferCreateItem) {
						await new Promise<void>(resolve => {
							storyWindow.__resolveCreateItem = resolve
						})
					}
					return { data: { id: 'draft-created' } }
				},
				subscribe: async () => snapshot,
				onSnapshot: () => noOp,
				item: async () => ({ data: detail }),
				itemAction: async () => ({ data: detail }),
				assignItem: async () => ({ data: detail }),
				setStatus: async () => ({ data: detail }),
				openOkena: async () => ({ error: 'Preview only' }),
				plan: async () => ({ error: 'Preview only' }),
				sourceTask: async () => ({ data: detail }),
				listScheduledRuns: async () => ({ data: structuredClone(scheduledRuns) }),
				createScheduledRun: async (_profileId: string, body: ScheduledScheduleInput) => {
					const created: ScheduledSchedule = {
						id: `schedule-story-${scheduledRuns.length + 1}`,
						profileId: 'work',
						revision: 1,
						name: body.name,
						enabled: body.enabled,
						target: body.definition.target,
						agent: body.definition.agent,
						maximumRuntimeMinutes: body.definition.maximumRuntimeMinutes,
						cron: body.cron,
						cadenceKind: body.cadenceKind,
						timezone: body.timezone,
						nextRunAt: null,
						disabledReason: null,
						archivedAt: null,
						createdAt: NOW,
						updatedAt: NOW,
					}
					scheduledRuns.push(created)
					return { data: structuredClone(created) }
				},
				updateScheduledRun: async (
					_profileId: string,
					_id: string,
					body: ScheduledScheduleInput & { revision: number },
				) => ({
					data: {
						id: 'schedule-story',
						profileId: 'work',
						revision: body.revision + 1,
						name: body.name,
						enabled: body.enabled,
						target: body.definition.target,
						agent: body.definition.agent,
						maximumRuntimeMinutes: body.definition.maximumRuntimeMinutes,
						cron: body.cron,
						cadenceKind: body.cadenceKind,
						timezone: body.timezone,
						nextRunAt: null,
						disabledReason: null,
						archivedAt: null,
						createdAt: NOW,
						updatedAt: NOW,
					},
				}),
				scheduledRunAction: async (_profileId: string, _id: string, action: string) => {
					const storyWindow = window as StoryWindow
					if (storyWindow.__failNextScheduledAction) {
						storyWindow.__failNextScheduledAction = false
						return { error: 'Validation failed' }
					}
					if (action !== 'run') return { data: structuredClone(scheduledRuns[0]) }
					return {
						data: {
							id: 'run-overlap',
							profileId: 'work',
							scheduleId: 'schedule-story',
							scheduleRevision: 2,
							scheduledFor: NOW,
							localCivilSlot: 'manual',
							utcOffsetMinutes: 0,
							state: 'skipped_overlap' as const,
							revision: 0,
							reportKind: null,
							reportSummary: null,
							startedAt: null,
							reportedAt: null,
							closedAt: NOW,
							missedCount: 0,
							missedMany: false,
							sessionAvailability: 'unavailable' as const,
							terminalResolvedAt: null,
							notificationClaimedAt: null,
							notificationDeliveredAt: null,
							createdAt: NOW,
							updatedAt: NOW,
						},
					}
				},
				cancelScheduledRun: async (_profileId: string, _runId: string, revision: number) => ({
					data: {
						id: 'run-story',
						profileId: 'work',
						scheduleId: 'schedule-story',
						scheduleRevision: 1,
						scheduledFor: NOW,
						localCivilSlot: '2026-07-21 12:00',
						utcOffsetMinutes: 0,
						state: 'cancel_requested',
						revision: revision + 1,
						reportKind: 'needs_attention',
						reportSummary: 'Choose the deployment target.',
						startedAt: NOW,
						reportedAt: NOW,
						closedAt: null,
						missedCount: 0,
						missedMany: false,
						sessionAvailability: 'unavailable',
						terminalResolvedAt: null,
						notificationClaimedAt: NOW,
						notificationDeliveredAt: NOW,
						createdAt: NOW,
						updatedAt: NOW,
					},
				}),
				scheduledRunHistory: async () => ({
					data: [
						{
							id: 'run-attention',
							profileId: 'work',
							scheduleId: 'schedule-story',
							scheduleRevision: 2,
							scheduledFor: NOW,
							localCivilSlot: '2026-07-21T09:00',
							utcOffsetMinutes: -240,
							state: 'needs_attention' as const,
							revision: 3,
							reportKind: 'needs_attention' as const,
							reportSummary: 'Please choose the release window before continuing.',
							startedAt: NOW,
							reportedAt: NOW,
							closedAt: null,
							missedCount: 0,
							missedMany: false,
							sessionAvailability: 'available' as const,
							terminalResolvedAt: null,
							notificationClaimedAt: null,
							notificationDeliveredAt: null,
							createdAt: NOW,
							updatedAt: NOW,
						},
					],
				}),
				openScheduledTerminal: async () => ({ data: { status: 'completed' } }),
			},
			nav: {
				onOpenItem: () => noOp,
				onGo: () => noOp,
			},
			config: { getDaemonUrl: () => 'http://localhost:7474' },
			appearance: { listThemes: async () => [] },
			profiles: {
				list: async () => ({ data: profileDocument }),
				onChanged: () => noOp,
				create: async () => ({ error: 'Preview only' }),
				update: async () => ({ error: 'Preview only' }),
				archive: async () => ({ error: 'Preview only' }),
				restore: async () => ({ error: 'Preview only' }),
				activate: async () => ({ error: 'Preview only' }),
			},
			runContext: { open: async () => ({ data: undefined }) },
		},
	})
}

function Frame({ children, width = 340 }: { children: ReactNode; width?: number }) {
	return (
		<div
			style={{
				minHeight: '100vh',
				padding: 24,
				display: 'grid',
				placeItems: 'start center',
				background: 'var(--chrome)',
			}}
		>
			<div className="sidebar" style={{ width, height: 800, boxShadow: 'var(--shadow-2)' }}>
				<div className="nav-viewport">
					<div className="nav-page">{children}</div>
				</div>
			</div>
		</div>
	)
}

function SidebarRootFrame() {
	return (
		<div
			style={{
				minHeight: '100vh',
				padding: 24,
				display: 'grid',
				placeItems: 'start center',
				background: 'var(--chrome)',
			}}
		>
			<div id="left" style={{ width: 340, height: 800, boxShadow: 'var(--shadow-2)' }}>
				<SidebarRoot />
			</div>
		</div>
	)
}

function SwipeFrame() {
	return (
		<div
			style={{
				minHeight: '100vh',
				padding: 24,
				display: 'grid',
				placeItems: 'start center',
				background: 'var(--chrome)',
			}}
		>
			<div className="sidebar" style={{ width: 340, height: 800, boxShadow: 'var(--shadow-2)' }}>
				<div className="nav-viewport">
					<div className="nav-page nav-swiping nav-swipe-under" style={{ transform: 'translate3d(-51px, 0, 0)' }}>
						<DetailPage
							id={reviewItem.id}
							snapshot={snapshot}
							draft={{}}
							onDraftChange={noOp}
							active={false}
							onBack={noOp}
							onOpenPlan={noOp}
							onOpenTask={noOp}
						/>
						<div className="swipe-scrim" style={{ opacity: 0.6 }} />
					</div>
					<div className="nav-page nav-swiping nav-swipe-top" style={{ transform: 'translate3d(136px, 0, 0)' }}>
						<TaskPage id={reviewItem.id} snapshot={snapshot} onBack={noOp} />
					</div>
				</div>
			</div>
		</div>
	)
}

function noOp(): void {}
async function noOpAsync(): Promise<void> {}

const settingsStore: SettingsStore = {
	doc: {
		config: {
			...(snapshot.config ?? {}),
			scheduledRuns: { enabled: false, systemTargetsEnabled: false },
		},
		dashboard: snapshot.config ?? {},
		edit: {
			sections: [
				{ id: 'projects', title: 'Projects', description: 'Repositories available to Helm.', controls: [] },
				{ id: 'execution', title: 'Execution', description: 'Agent, model, and workspace defaults.', controls: [] },
				{ id: 'scheduled-runs', title: 'Scheduled runs', description: 'Controls scheduled recurrence.', controls: [] },
			],
		},
		secretRedaction: '••••••••',
	},
	draft: {},
	dirty: false,
	saving: false,
	loadError: null,
	pendingRestart: 'The daemon must restart before these settings take effect.',
	restarting: false,
	update: noOp,
	updateAndSave: async () => ({ message: 'Settings applied', applied: true }),
	addListItem: noOp,
	removeListItem: noOp,
	save: noOpAsync,
	restartNow: async () => true,
}

const meta: Meta = {
	title: 'Views/Sidebar',
	parameters: { layout: 'fullscreen' },
	decorators: [
		story => {
			installBridge()
			return story()
		},
	],
}

export default meta
type Story = StoryObj

export const WorkList: Story = {
	render: () => (
		<Frame>
			<ListPage
				snapshot={snapshot}
				onOpenItem={noOp}
				onNewItem={noOp}
				onOpenArchive={noOp}
				onOpenProfiles={noOp}
				onOpenScheduledRuns={noOp}
				onOpenSettings={noOp}
				onPoll={noOp}
				onPauseToggle={noOp}
				onStartAgent={noOpAsync}
				onWorkManually={noOpAsync}
			/>
		</Frame>
	),
}

export const NewItem: Story = {
	render: function NewItemStory() {
		const [draft, setDraft] = useState({ title: '', prompt: '' })
		return (
			<Frame>
				<NewItemPage draft={draft} onDraftChange={setDraft} onBack={noOp} onCreated={noOp} />
			</Frame>
		)
	},
}

/** Production push-stack integration: opener focus, Escape, and create admission. */
export const NewItemNavigation: Story = {
	render: () => <SidebarRootFrame />,
}

/** Deterministic 40% two-finger Task→Detail gesture: compositor layers, parallax,
 * scrim, and pane edges without running Electron. */
export const SwipeBackMidGesture: Story = {
	render: () => <SwipeFrame />,
}

export const ItemDetail: Story = {
	render: () => (
		<Frame>
			<DetailPage
				id={reviewItem.id}
				snapshot={snapshot}
				draft={{}}
				onDraftChange={noOp}
				active
				onBack={noOp}
				onOpenPlan={noOp}
				onOpenTask={noOp}
			/>
		</Frame>
	),
}

export const UnassignedItemDetail: Story = {
	render: () => {
		installBridge(unassignedItem)
		return (
			<Frame>
				<DetailPage
					id={unassignedItem.id}
					snapshot={{ ...snapshot, items: [unassignedItem, ...(snapshot.items ?? [])] }}
					draft={{}}
					onDraftChange={noOp}
					active
					onBack={noOp}
					onOpenPlan={noOp}
					onOpenTask={noOp}
				/>
			</Frame>
		)
	},
}

export const TaskReading: Story = {
	render: () => (
		<Frame>
			<TaskPage id={reviewItem.id} snapshot={snapshot} onBack={noOp} />
		</Frame>
	),
}

export const PlanDocuments: Story = {
	render: () => (
		<Frame>
			<PlanPage id={reviewItem.id} snapshot={snapshot} onBack={noOp} />
		</Frame>
	),
}

export const Settings: Story = {
	render: () => (
		<Frame>
			<SettingsPage
				store={settingsStore}
				onBack={noOp}
				onOpenSection={noOp}
				onOpenAppearance={noOp}
				onOpenProfiles={noOp}
				onOpenTerminal={noOp}
				onOpenAgentIntegrations={noOp}
				onOpenScheduledRuns={noOp}
				activeProfileName="Work"
			/>
		</Frame>
	),
}

export const TerminalSettings: Story = {
	render: () => (
		<Frame>
			<TerminalSettingsPage onBack={noOp} />
		</Frame>
	),
}

export const AgentIntegrations: Story = {
	render: () => (
		<Frame>
			<AgentIntegrationsPage onBack={noOp} />
		</Frame>
	),
}

export const AgentIntegrationsExternal: Story = {
	render: () => {
		installBridge(reviewItem, {
			status: 'external',
			message: 'Precise Pi terminal status is managed by a Pi package.',
		})
		return (
			<Frame>
				<AgentIntegrationsPage onBack={noOp} />
			</Frame>
		)
	},
}

export const ScheduledRuns: Story = {
	render: () => (
		<Frame>
			<ScheduledRunsPage profileId="work" profileName="Work" schedulingEnabled onBack={noOp} onOpenEditor={noOp} />
		</Frame>
	),
}

export const ScheduledRunsDisabled: Story = {
	render: () => (
		<Frame>
			<ScheduledRunsPage
				profileId="work"
				profileName="Work"
				schedulingEnabled={false}
				schedulingControl={{
					configured: false,
					ready: true,
					saving: false,
					restartPending: false,
					restarting: false,
					enable: async () => ({ message: 'Restart required', applied: false }),
					restart: async () => true,
				}}
				onBack={noOp}
				onOpenEditor={noOp}
			/>
		</Frame>
	),
}

export const ScheduledRunEditor: Story = {
	render: () => (
		<Frame>
			<ScheduledRunEditorPage profileId="work" config={snapshot.config} onBack={noOp} />
		</Frame>
	),
}

export const ScheduledRunHistory: Story = {
	render: () => (
		<Frame>
			<ScheduledRunEditorPage profileId="work" scheduleId="schedule-story" config={snapshot.config} onBack={noOp} />
		</Frame>
	),
}

export const Profiles: Story = {
	render: () => (
		<Frame>
			<ProfilesPage onBack={noOp} onOpen={noOp} />
		</Frame>
	),
}

export const Appearance: Story = {
	render: () => (
		<Frame>
			<AppearancePage onBack={noOp} />
		</Frame>
	),
}
