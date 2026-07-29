import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
	GraceClose,
	HelmApi,
	PtySpawnResult,
	RestoredSession,
	ScheduledTerminalOpen,
	TabGroup,
	TabGroupActionAuthorization,
	TerminalPlacementCommitResult,
	TerminalTransferEvent,
	TerminalTransferMoveResult,
	TerminalTransferPreflight,
	ThemeListEntry,
	UiPreview,
} from './shared'
import type { DaemonApi, HelmResult, HelmSnapshot, ProfilesApi } from './shared-helm'

// Captured synchronously at preload time so the renderer gets the URL without an async hop.
const { daemonUrl, sessionProfileToken } = ipcRenderer.sendSync('config:get') as {
	daemonUrl: string
	sessionProfileToken: string
}

// --ui-preview=<...> arrives via webPreferences.additionalArguments; keep this
// allowlist aligned with UiPreview so every deterministic app/terminal state is capturable.
const uiPreviewArg = process.argv.find(arg => arg.startsWith('--ui-preview='))?.slice('--ui-preview='.length)
const UI_PREVIEWS: readonly UiPreview[] = [
	'list',
	'project-list',
	'queue-list',
	'planned-list',
	'detail',
	'queue-detail',
	'planned-detail',
	'archive-detail',
	'task',
	'settings',
	'appearance',
	'background',
	'background-strip',
	'background-park',
	'background-open',
	'background-restore',
	'background-drag',
	'background-grouped-tab-drag',
	'background-group-drag',
	'rename',
	'rename-edit',
	'tab-drag',
	'running-tab',
	'attention-tab',
]
const uiPreview: UiPreview | null = UI_PREVIEWS.find(page => page === uiPreviewArg) ?? null

// --ui-theme=<presetId>: screenshot runs verify a theme preset visually.
const uiTheme = process.argv.find(arg => arg.startsWith('--ui-theme='))?.slice('--ui-theme='.length) ?? null

// --term-cmd=<base64>: screenshot runs type a command into the first tab's
// shell (base64 so shell metacharacters/spaces survive the argv hop).
function decodeTermCmd(): string | null {
	const raw = process.argv.find(arg => arg.startsWith('--term-cmd='))?.slice('--term-cmd='.length)
	if (!raw) return null
	try {
		return Buffer.from(raw, 'base64').toString('utf8')
	} catch {
		return null
	}
}
const termCmd = decodeTermCmd()

// --term-scroll=<top|middle>: screenshot runs verify scrollbar travel extremes.
const termScrollArg = process.argv.find(arg => arg.startsWith('--term-scroll='))?.slice('--term-scroll='.length)
const termScroll = termScrollArg === 'top' || termScrollArg === 'middle' ? termScrollArg : null

// HELM_TITLE_STICKY_MS: test override for the restored-title stickiness window
// (same convention as HELM_CLOSE_GRACE_MS in sessions.ts).
const titleStickyEnv = Number(process.env.HELM_TITLE_STICKY_MS)
const titleStickyMs = Number.isFinite(titleStickyEnv) && titleStickyEnv > 0 ? titleStickyEnv : null

function subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
	const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as Args))
	ipcRenderer.on(channel, handler)
	return () => ipcRenderer.removeListener(channel, handler)
}

// All daemon command channels resolve with the daemon's { data } | { error }
// envelope (the bridge never rejects), so the cast is one shared seam.
function invokeHelm<T>(channel: string, ...args: unknown[]): Promise<HelmResult<T>> {
	return ipcRenderer.invoke(channel, ...args, sessionProfileToken) as Promise<HelmResult<T>>
}

const api: HelmApi = {
	pty: {
		spawn: (cols, rows, sessionId) =>
			ipcRenderer.invoke('pty:spawn', {
				cols,
				rows,
				sessionId,
				profileToken: sessionProfileToken,
			}) as Promise<PtySpawnResult>,
		write: (id, data) => ipcRenderer.send('pty:write', id, data, sessionProfileToken),
		resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows, sessionProfileToken),
		kill: id => ipcRenderer.send('pty:kill', id, sessionProfileToken),
		onData: listener =>
			subscribe<[number, string, string]>('pty:data', (id, data, profileToken) => {
				if (profileToken === sessionProfileToken) listener(id, data)
			}),
		onExit: listener =>
			subscribe<[number, number, string]>('pty:exit', (id, exitCode, profileToken) => {
				if (profileToken === sessionProfileToken) listener(id, exitCode)
			}),
	},
	sessions: {
		list: () => ipcRenderer.invoke('sessions:list', sessionProfileToken) as Promise<RestoredSession[]>,
		placementCommit: command =>
			ipcRenderer.invoke(
				'sessions:placement:commit',
				command,
				sessionProfileToken,
			) as Promise<TerminalPlacementCommitResult | null>,
		onScheduledOpen: listener =>
			subscribe<[ScheduledTerminalOpen, string]>('scheduled-adoption:open', (terminal, profileToken) => {
				if (profileToken !== sessionProfileToken) return
				void Promise.resolve(listener(terminal))
					.then(opened =>
						ipcRenderer.invoke(
							'scheduled-adoption:opened',
							terminal.ptyId,
							terminal.sessionId,
							profileToken,
							opened === true,
						),
					)
					.catch(() => undefined)
			}),
		groups: {
			list: () => ipcRenderer.invoke('tab-groups:list', sessionProfileToken) as Promise<TabGroup[]>,
			create: (name, sessionIds) =>
				ipcRenderer.invoke('tab-groups:create', name, sessionIds, sessionProfileToken) as Promise<TabGroup | null>,
			rename: (groupId, name) =>
				ipcRenderer.invoke('tab-groups:rename', groupId, name, sessionProfileToken) as Promise<TabGroup | null>,
			setColor: (groupId, color) =>
				ipcRenderer.invoke('tab-groups:set-color', groupId, color, sessionProfileToken) as Promise<TabGroup | null>,
			delete: groupId => ipcRenderer.invoke('tab-groups:delete', groupId, sessionProfileToken) as Promise<boolean>,
			setMembership: (sessionId, groupId) =>
				ipcRenderer.invoke('tab-groups:set-membership', sessionId, groupId, sessionProfileToken) as Promise<boolean>,
			setCollapsed: (groupId, surface, collapsed) =>
				ipcRenderer.invoke(
					'tab-groups:set-collapsed',
					groupId,
					surface,
					collapsed,
					sessionProfileToken,
				) as Promise<boolean>,
			move: (groupId, parked) =>
				ipcRenderer.invoke('tab-groups:move', groupId, parked, sessionProfileToken) as Promise<string[] | null>,
			intent: intent =>
				ipcRenderer.invoke(
					'tab-groups:intent',
					intent,
					sessionProfileToken,
				) as Promise<TabGroupActionAuthorization | null>,
		},
		setTitle: (sessionId, title) => ipcRenderer.send('session:title', sessionId, title, sessionProfileToken),
		setCustomName: (sessionId, name) =>
			ipcRenderer.send('session:set-custom-name', sessionId, name, sessionProfileToken),
		setActivity: (sessionId, activity) =>
			ipcRenderer.send('session:set-activity', sessionId, activity, sessionProfileToken),
		closeWithGrace: ptyId =>
			ipcRenderer.invoke('session:close-with-grace', ptyId, sessionProfileToken) as Promise<GraceClose | null>,
		undoClose: sessionId =>
			ipcRenderer.invoke('session:undo-close', sessionId, sessionProfileToken) as Promise<boolean>,
	},
	terminalTransfer: {
		profileToken: () => sessionProfileToken,
		preflight: sessionId =>
			ipcRenderer.invoke(
				'terminal-transfer:preflight',
				sessionId,
				sessionProfileToken,
			) as Promise<TerminalTransferPreflight>,
		move: (sessionId, destinationProfileId) =>
			ipcRenderer.invoke(
				'terminal-transfer:move',
				sessionId,
				destinationProfileId,
				sessionProfileToken,
			) as Promise<TerminalTransferMoveResult>,
		onEvent: listener =>
			subscribe<[TerminalTransferEvent]>('terminal-transfer:event', event => {
				if (event.profileToken === sessionProfileToken) listener(event)
			}),
		ack: (event, result) =>
			ipcRenderer.invoke('terminal-transfer:ack', event, result, sessionProfileToken) as Promise<boolean>,
	},
	buffers: {
		read: sessionId => ipcRenderer.invoke('buffer:read', sessionId, sessionProfileToken) as Promise<string | null>,
		save: (sessionId, data) => ipcRenderer.send('buffer:save', sessionId, data, sessionProfileToken),
		saveAndAck: (sessionId, data) =>
			ipcRenderer.invoke('buffer:save-and-ack', sessionId, data, sessionProfileToken) as Promise<boolean>,
		onFlush: listener =>
			subscribe<[string]>('buffers:flush', profileToken => {
				if (profileToken === sessionProfileToken) listener()
			}),
		flushed: () => ipcRenderer.send('buffers:flushed', sessionProfileToken),
	},
	config: {
		getDaemonUrl: () => daemonUrl,
	},
	terminalPreferences: {
		get: () => ipcRenderer.invoke('terminal-preferences:get', sessionProfileToken),
		chooseDefaultCwd: () => ipcRenderer.invoke('terminal-preferences:choose', sessionProfileToken),
		resetDefaultCwd: () => ipcRenderer.invoke('terminal-preferences:reset', sessionProfileToken),
	},
	external: {
		open: url => ipcRenderer.invoke('external:open', url, sessionProfileToken) as Promise<boolean>,
	},
	appearance: {
		listThemes: () => ipcRenderer.invoke('themes:list') as Promise<ThemeListEntry[]>,
		onFontStep: listener => subscribe('font:step', listener),
	},
	daemon: {
		subscribe: () => ipcRenderer.invoke('daemon:subscribe') as Promise<HelmSnapshot>,
		onSnapshot: listener => subscribe('daemon:snapshot', listener),
		item: id => invokeHelm('daemon:item', id),
		itemAction: (id, action, body) => invokeHelm('daemon:itemAction', id, action, body),
		plan: (id, body) => invokeHelm('daemon:plan', id, body),
		openOkena: id => invokeHelm('daemon:openOkena', id),
		aiPass: (id, pass) => invokeHelm('daemon:aiPass', id, pass),
		createItem: body => invokeHelm('daemon:createItem', body),
		sourceTask: id => invokeHelm('daemon:sourceTask', id),
		setStatus: (id, status) => invokeHelm('daemon:setStatus', id, status),
		config: () => invokeHelm('daemon:config'),
		updateConfig: body => invokeHelm('daemon:updateConfig', body),
		restartDaemon: () => invokeHelm('daemon:restart'),
		pauseToggle: () => invokeHelm('daemon:pauseToggle'),
		poll: () => invokeHelm('daemon:poll'),
		listScheduledRuns: profileId => invokeHelm('daemon:scheduled:list', profileId),
		createScheduledRun: (profileId, body) => invokeHelm('daemon:scheduled:create', profileId, body),
		updateScheduledRun: (profileId, id, body) => invokeHelm('daemon:scheduled:update', profileId, id, body),
		scheduledRunAction: (profileId, id, action, revision) =>
			invokeHelm('daemon:scheduled:action', profileId, id, action, revision),
		scheduledRunHistory: (profileId, id, limit) => invokeHelm('daemon:scheduled:history', profileId, id, limit),
		cancelScheduledRun: (profileId, runId, revision) =>
			invokeHelm('daemon:scheduled:cancel-run', profileId, runId, revision),
		openScheduledTerminal: (profileId, runId, revision) =>
			invokeHelm('daemon:scheduled:open-terminal', profileId, runId, revision),
	} satisfies DaemonApi,
	profiles: {
		list: () => invokeHelm('profiles:list'),
		onChanged: listener => subscribe('profiles:changed', listener),
		create: (name, enabledProjects) => invokeHelm('profiles:create', name, enabledProjects),
		update: (id, body) => invokeHelm('profiles:update', id, body),
		archive: id => invokeHelm('profiles:archive', id),
		restore: id => invokeHelm('profiles:restore', id),
		activate: id => invokeHelm('profiles:activate', id),
	} satisfies ProfilesApi,
	runContext: {
		open: itemId => ipcRenderer.invoke('run-context:open', itemId) as Promise<void>,
	},
	tabs: {
		onNew: listener => subscribe('tab:new', listener),
		onClose: listener => subscribe('tab:close', listener),
		onBackground: listener => subscribe('tab:background', listener),
		guardNativeDoubleClick: () => ipcRenderer.sendSync('window:guard-tab-double-click', sessionProfileToken) as boolean,
	},
	nav: {
		onOpenItem: listener => subscribe('nav:open-item', listener),
		onGo: listener =>
			subscribe<[string]>('nav:go', direction => {
				if (direction === 'back' || direction === 'forward') listener(direction)
			}),
	},
	platform: process.platform,
	uiPreview,
	uiTheme,
	termCmd,
	termScroll,
	titleStickyMs,
}

contextBridge.exposeInMainWorld('helm', api)
