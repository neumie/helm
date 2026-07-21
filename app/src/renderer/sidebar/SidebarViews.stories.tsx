import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import type { DashboardItem, HelmSnapshot } from '../../shared-helm'
import { AppearancePage } from './AppearancePage'
import { DetailPage } from './DetailPage'
import { PlanPage, TaskPage } from './DetailSubpages'
import { ListPage } from './ListPage'
import { SettingsPage, type SettingsStore } from './SettingsPage'

const NOW = '2026-07-21T12:00:00.000Z'

function item(overrides: Partial<DashboardItem>): DashboardItem {
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

const listItems = [
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
		protocolVersion: 30,
		buildId: 'storybook',
		uptime: 3600,
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
		},
	},
}

function installBridge(detail: DashboardItem = reviewItem): void {
	Object.assign(window, {
		helm: {
			uiPreview: null,
			daemon: {
				item: async () => ({ data: detail }),
				itemAction: async () => ({ data: detail }),
				setStatus: async () => ({ data: detail }),
				openOkena: async () => ({ error: 'Preview only' }),
				plan: async () => ({ error: 'Preview only' }),
				sourceTask: async () => ({ data: detail }),
			},
			config: { getDaemonUrl: () => 'http://localhost:7474' },
			appearance: { listThemes: async () => [] },
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
		config: {},
		dashboard: snapshot.config ?? {},
		edit: {
			sections: [
				{ id: 'projects', title: 'Projects', description: 'Repositories available to Helm.', controls: [] },
				{ id: 'execution', title: 'Execution', description: 'Agent, model, and workspace defaults.', controls: [] },
				{ id: 'automation', title: 'Automation', description: 'Polling and deployment observation.', controls: [] },
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
	addListItem: noOp,
	removeListItem: noOp,
	save: noOpAsync,
	restartNow: noOpAsync,
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
				onOpenSettings={noOp}
				onPoll={noOp}
				onPauseToggle={noOp}
				onStartAgent={noOpAsync}
				onWorkManually={noOpAsync}
			/>
		</Frame>
	),
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
			<SettingsPage store={settingsStore} onBack={noOp} onOpenSection={noOp} onOpenAppearance={noOp} />
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
