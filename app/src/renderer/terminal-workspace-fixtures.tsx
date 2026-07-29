import { useEffect, useRef } from 'react'
import type {
	BuffersApi,
	PtyApi,
	RestoredSession,
	TabGroup,
	TabGroupActionAuthorization,
	TabGroupActionIntent,
	TabGroupsApi,
	TerminalPlacementCommitCommand,
	TerminalPlacementCommitResult,
} from '../shared'
import { type MountedTerminalWorkspace, type TerminalWorkspaceHelm, mountTerminalWorkspace } from './terminal-workspace'

export interface TerminalWorkspaceFixtureOptions {
	sessions?: RestoredSession[]
	groups?: TabGroup[]
	/** Opens the production Background dialog after hydration. */
	openBackground?: boolean
	/** Exposed only by the dedicated browser harness for bridge-effect assertions. */
	expose?: boolean
}

export interface TerminalWorkspaceFixture {
	helm: TerminalWorkspaceHelm
	calls: {
		placement: TerminalPlacementCommitCommand[]
	}
	emitExit(sessionId: string, code: number): void
	/** Browser-only control: exercises the production mount cleanup boundary. */
	dispose(): void
	/** Browser-only control: the next durable placement completion waits for rejectDeferredPlacement. */
	deferNextPlacement(): void
	rejectDeferredPlacement(): void
}

function shellNode<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	id?: string,
	className?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag)
	if (id) node.id = id
	if (className) node.className = className
	return node
}

/** Builds only the static production shell; mountTerminalWorkspace renders terminal UI. */
function buildShell(root: HTMLElement): void {
	root.replaceChildren()
	const header = shellNode('header', 'topbar')
	const chrome = shellNode('div', undefined, 'topbar-left')
	chrome.setAttribute('aria-hidden', 'true')
	const strip = shellNode('div', 'tab-strip-region', 'topbar-right')
	strip.dataset.testid = 'tab-strip-region'
	const controls = shellNode('div', undefined, 'tab-strip-controls')
	controls.append(shellNode('div', 'tabs'))
	const newTab = shellNode('button', 'new-tab')
	newTab.type = 'button'
	newTab.title = 'New terminal'
	newTab.setAttribute('aria-label', 'New terminal')
	newTab.textContent = '+'
	controls.append(newTab)
	const dragSpace = shellNode('div', 'topbar-drag-space', 'topbar-drag-space')
	dragSpace.setAttribute('aria-hidden', 'true')
	const bgRoot = shellNode('div', 'bg-root')
	const toggle = shellNode('button', 'bg-toggle')
	toggle.type = 'button'
	toggle.hidden = true
	toggle.title = 'Background terminals'
	toggle.setAttribute('aria-label', 'Background terminals')
	toggle.setAttribute('aria-haspopup', 'dialog')
	toggle.setAttribute('aria-expanded', 'false')
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
	svg.setAttribute('class', 'background-icon')
	svg.setAttribute('width', '16')
	svg.setAttribute('height', '16')
	svg.setAttribute('viewBox', '0 0 16 16')
	svg.setAttribute('fill', 'currentColor')
	svg.setAttribute('aria-hidden', 'true')
	for (const d of [
		'M7 1a.75.75 0 0 1 .75.75V6h-1.5V1.75A.75.75 0 0 1 7 1ZM6.25 6v2.94L5.03 7.72a.75.75 0 0 0-1.06 1.06l2.5 2.5a.75.75 0 0 0 1.06 0l2.5-2.5a.75.75 0 1 0-1.06-1.06L7.75 8.94V6H10a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 0-2-2V8a2 2 0 0 1 2-2h2.25Z',
		'M4.268 14A2 2 0 0 0 6 15h6a2 2 0 0 0 2-2v-3a2 2 0 0 0-1-1.732V11a3 3 0 0 1-3 3H4.268Z',
	]) {
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
		path.setAttribute('d', d)
		svg.append(path)
	}
	const current = shellNode('span', 'bg-current', 'bg-current')
	current.hidden = true
	const count = shellNode('span', 'bg-count', 'bg-count')
	count.textContent = '0'
	toggle.append(svg, current, count)
	const popover = shellNode('div', 'bg-popover', 'menu-panel menu-end')
	popover.hidden = true
	popover.setAttribute('role', 'dialog')
	popover.setAttribute('aria-label', 'Background terminals')
	const popoverHeader = shellNode('div', undefined, 'bg-header')
	popoverHeader.textContent = 'Background terminals'
	popover.append(popoverHeader, shellNode('div', 'bg-rows'))
	bgRoot.append(toggle, popover)
	strip.append(controls, dragSpace, bgRoot)
	header.append(chrome, strip)
	const content = shellNode('div', 'content')
	content.append(shellNode('aside', 'left'), shellNode('div', 'divider'))
	const right = shellNode('main', 'right')
	right.append(shellNode('div', 'terms'))
	const empty = shellNode('div', 'no-terms')
	empty.hidden = true
	const emptyCard = shellNode('div', undefined, 'no-terms-card')
	const emptyTitle = shellNode('div', undefined, 'no-terms-title')
	emptyTitle.textContent = 'No terminals open'
	emptyCard.append(emptyTitle)
	empty.append(emptyCard)
	right.append(empty)
	content.append(right)
	root.append(header, content)
}

function copySession(session: RestoredSession): RestoredSession {
	return { ...session }
}

function membersFor(sessions: readonly RestoredSession[], groupId: string): string[] {
	return sessions
		.filter(session => session.groupId === groupId && session.placementEligible)
		.map(session => session.sessionId)
}

/**
 * Stateful, in-memory implementation of the narrow production bridge. It deliberately
 * models only renderer-visible ids and metadata: no Electron, daemon, paths, or caps.
 */
export function createTerminalWorkspaceFixture(
	options: TerminalWorkspaceFixtureOptions = {},
): TerminalWorkspaceFixture {
	const sessions = (options.sessions ?? fixtureSessions()).map(copySession)
	const groups = (options.groups ?? fixtureGroups()).map(group => ({ ...group }))
	let authoritativeOrder = sessions.map(session => session.sessionId)
	const calls: TerminalWorkspaceFixture['calls'] = { placement: [] }
	const ptyBySession = new Map<string, number>()
	const ptyExitListeners = new Set<(id: number, exitCode: number) => void>()
	const ptyDataListeners = new Set<(id: number, data: string) => void>()
	let nextPty = 1
	let deferredPlacement: { reject: () => void } | null = null
	let deferNextPlacement = false
	const noOpUnsubscribe = () => {}

	const placementCommit = async (
		command: TerminalPlacementCommitCommand,
	): Promise<TerminalPlacementCommitResult | null> => {
		calls.placement.push(command)
		if (deferNextPlacement) {
			deferNextPlacement = false
			return await new Promise<TerminalPlacementCommitResult | null>(resolve => {
				deferredPlacement = { reject: () => resolve(null) }
			})
		}
		if (command.type === 'set-collapsed') {
			const group = groups.find(candidate => candidate.id === command.groupId)
			if (!group) return null
			if (command.surface === 'strip') group.collapsedStrip = command.collapsed
			else group.collapsedBackground = command.collapsed
		} else {
			const order = [...command.strip, ...command.background]
			authoritativeOrder = [...order, ...authoritativeOrder.filter(id => !order.includes(id))]
			for (const session of sessions) {
				const index = order.indexOf(session.sessionId)
				if (index >= 0) session.parked = index >= command.strip.length
			}
			if (command.type === 'set-membership') {
				const session = sessions.find(candidate => candidate.sessionId === command.terminalId)
				if (session) session.groupId = command.groupId
			}
		}
		const order = authoritativeOrder.filter(sessionId =>
			sessions.some(session => session.sessionId === sessionId && session.placementEligible),
		)
		return {
			registryEpoch: calls.placement.length,
			affectedIds:
				command.type === 'set-collapsed'
					? []
					: command.type === 'set-membership'
						? [command.terminalId]
						: command.affectedIds,
			authoritativeOrder: order,
			authoritativeGroups: groups.map(group => ({ ...group, memberIds: membersFor(sessions, group.id) })),
		}
	}

	const tabGroups: TabGroupsApi = {
		list: async () => groups.map(group => ({ ...group })),
		create: async (name, sessionIds) => {
			const group: TabGroup = {
				id: `group-${(groups.length + 1).toString(16).padStart(8, '0')}`,
				name,
				color: 'blue',
				collapsedStrip: false,
				collapsedBackground: false,
			}
			groups.push(group)
			for (const id of sessionIds) {
				const session = sessions.find(candidate => candidate.sessionId === id)
				if (session) session.groupId = group.id
			}
			return { ...group }
		},
		rename: async (groupId, name) => {
			const group = groups.find(candidate => candidate.id === groupId)
			if (!group) return null
			group.name = name
			return { ...group }
		},
		setColor: async (groupId, color) => {
			const group = groups.find(candidate => candidate.id === groupId)
			if (!group) return null
			group.color = color
			return { ...group }
		},
		delete: async groupId => {
			const index = groups.findIndex(group => group.id === groupId)
			if (index < 0) return false
			groups.splice(index, 1)
			for (const session of sessions) if (session.groupId === groupId) session.groupId = null
			return true
		},
		setMembership: async (sessionId, groupId) => {
			const session = sessions.find(candidate => candidate.sessionId === sessionId)
			if (!session) return false
			session.groupId = groupId
			return true
		},
		setCollapsed: async (groupId, surface, collapsed) => {
			const group = groups.find(candidate => candidate.id === groupId)
			if (!group) return false
			if (surface === 'strip') group.collapsedStrip = collapsed
			else group.collapsedBackground = collapsed
			return true
		},
		move: async (groupId, parked) =>
			membersFor(sessions, groupId).map(sessionId => {
				const session = sessions.find(candidate => candidate.sessionId === sessionId)
				if (session) session.parked = parked
				return sessionId
			}),
		intent: async (intent: TabGroupActionIntent): Promise<TabGroupActionAuthorization | null> => {
			const groupId = 'groupId' in intent ? intent.groupId : null
			if (groupId && !groups.some(group => group.id === groupId)) return null
			return { intent, memberIds: groupId ? membersFor(sessions, groupId) : [] }
		},
	}

	const pty: PtyApi = {
		spawn: async (_cols, _rows, sessionId) => {
			const id = nextPty++
			const bound = sessionId ?? `fresh-${id}`
			ptyBySession.set(bound, id)
			if (!sessions.some(session => session.sessionId === bound)) {
				sessions.push({
					sessionId: bound,
					title: 'zsh',
					customName: null,
					parked: false,
					groupId: null,
					agentRunning: false,
					agentAttention: false,
					placementEligible: true,
				})
			}
			return { id, sessionId: bound }
		},
		write: (id, data) => {
			for (const listener of ptyDataListeners) listener(id, data)
		},
		resize: () => {},
		kill: id => {
			for (const listener of ptyExitListeners) listener(id, 0)
		},
		onData: listener => {
			ptyDataListeners.add(listener)
			return () => ptyDataListeners.delete(listener)
		},
		onExit: listener => {
			ptyExitListeners.add(listener)
			return () => ptyExitListeners.delete(listener)
		},
	}
	const buffers: BuffersApi = {
		read: async () => null,
		save: () => {},
		saveAndAck: async () => true,
		onFlush: () => noOpUnsubscribe,
		flushed: () => {},
	}
	const helm = {
		pty,
		sessions: {
			list: async () => sessions.map(copySession),
			placementCommit,
			onScheduledOpen: () => noOpUnsubscribe,
			groups: tabGroups,
			setTitle: () => {},
			setCustomName: () => {},
			setActivity: () => {},
			closeWithGrace: async () => null,
			undoClose: async () => false,
		},
		terminalTransfer: {
			profileToken: () => 'storybook:1',
			preflight: async () => ({ status: 'unavailable' as const, reason: 'no-targets' as const }),
			move: async () => ({ status: 'rejected' as const, reason: 'fixture' }),
			onEvent: () => noOpUnsubscribe,
			ack: async () => true,
		},
		buffers,
		external: { open: async () => true },
		appearance: { listThemes: async () => [], onFontStep: () => noOpUnsubscribe },
		tabs: {
			onNew: () => noOpUnsubscribe,
			onClose: () => noOpUnsubscribe,
			onBackground: () => noOpUnsubscribe,
			guardNativeDoubleClick: () => true,
		},
		profiles: {
			list: async () => ({ error: 'fixture' }),
			onChanged: () => noOpUnsubscribe,
			create: async () => ({ error: 'fixture' }),
			update: async () => ({ error: 'fixture' }),
			archive: async () => ({ error: 'fixture' }),
			restore: async () => ({ error: 'fixture' }),
			activate: async () => ({ error: 'fixture' }),
		},
		platform: 'darwin' as NodeJS.Platform,
		uiPreview: null,
		termCmd: null,
		termScroll: null,
		titleStickyMs: 0,
	} satisfies TerminalWorkspaceHelm
	return {
		helm,
		calls,
		emitExit(sessionId, code) {
			const id = ptyBySession.get(sessionId)
			if (id !== undefined) for (const listener of ptyExitListeners) listener(id, code)
		},
		dispose() {},
		deferNextPlacement() {
			deferNextPlacement = true
		},
		rejectDeferredPlacement() {
			deferredPlacement?.reject()
			deferredPlacement = null
		},
	}
}

/** Production mount host used identically by Storybook and Playwright. */
export function TerminalWorkspaceFixtureView({ options = {} }: { options?: TerminalWorkspaceFixtureOptions }) {
	const rootRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const root = rootRef.current
		if (!root) return
		buildShell(root)
		const fixture = createTerminalWorkspaceFixture(options)
		const workspace: MountedTerminalWorkspace = mountTerminalWorkspace({ root, helm: fixture.helm })
		fixture.dispose = () => workspace.dispose()
		if (options.expose)
			(window as Window & { __helmWorkspaceFixture?: TerminalWorkspaceFixture }).__helmWorkspaceFixture = fixture
		void workspace.ready.then(() => {
			if (options.openBackground) (root.querySelector('#bg-toggle') as HTMLButtonElement | null)?.click()
		})
		return () => {
			workspace.dispose()
			if (options.expose)
				(window as Window & { __helmWorkspaceFixture?: TerminalWorkspaceFixture }).__helmWorkspaceFixture = undefined
		}
	}, [options])
	return <div id="app" className="terminal-workspace-fixture" ref={rootRef} />
}

export function fixtureSessions(): RestoredSession[] {
	return [
		{
			sessionId: 'shell',
			title: 'zsh',
			customName: 'active shell',
			parked: false,
			groupId: null,
			agentRunning: false,
			agentAttention: false,
			placementEligible: true,
		},
		{
			sessionId: 'compile',
			title: 'compile',
			customName: null,
			parked: false,
			groupId: 'group-000000a1',
			agentRunning: true,
			agentAttention: false,
			placementEligible: true,
		},
		{
			sessionId: 'tests',
			title: 'tests',
			customName: null,
			parked: true,
			groupId: 'group-000000b2',
			agentRunning: false,
			agentAttention: true,
			placementEligible: true,
		},
		{
			sessionId: 'logs',
			title: 'logs',
			customName: 'release logs',
			parked: true,
			groupId: 'group-000000b2',
			agentRunning: false,
			agentAttention: false,
			placementEligible: true,
		},
	]
}

export function fixtureGroups(): TabGroup[] {
	return [
		{ id: 'group-000000a1', name: 'Build', color: 'blue', collapsedStrip: false, collapsedBackground: false },
		{ id: 'group-000000b2', name: 'Review', color: 'purple', collapsedStrip: false, collapsedBackground: false },
	]
}
