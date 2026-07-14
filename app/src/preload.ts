import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { GraceClose, HelmApi, PtySpawnResult, RestoredSession, ThemeListEntry, UiPreview } from './shared'
import type { DaemonApi, HelmResult, HelmSnapshot } from './shared-helm'

// Captured synchronously at preload time so the renderer gets the URL without an async hop.
const { daemonUrl } = ipcRenderer.sendSync('config:get') as { daemonUrl: string }

// --ui-preview=<list|detail|settings> arrives via webPreferences.additionalArguments
// (main.ts) for screenshot runs; the sidebar auto-navigates to the named page.
const uiPreviewArg = process.argv.find(arg => arg.startsWith('--ui-preview='))?.slice('--ui-preview='.length)
const UI_PREVIEWS: readonly UiPreview[] = [
	'list',
	'detail',
	'settings',
	'appearance',
	'background',
	'background-strip',
	'background-park',
	'background-restore',
	'rename',
	'rename-edit',
	'tab-drag',
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
	return ipcRenderer.invoke(channel, ...args) as Promise<HelmResult<T>>
}

const api: HelmApi = {
	pty: {
		spawn: (cols, rows, sessionId) =>
			ipcRenderer.invoke('pty:spawn', { cols, rows, sessionId }) as Promise<PtySpawnResult>,
		write: (id, data) => ipcRenderer.send('pty:write', id, data),
		resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
		kill: id => ipcRenderer.send('pty:kill', id),
		onData: listener => subscribe('pty:data', listener),
		onExit: listener => subscribe('pty:exit', listener),
	},
	sessions: {
		list: () => ipcRenderer.invoke('sessions:list') as Promise<RestoredSession[]>,
		setTitle: (sessionId, title) => ipcRenderer.send('session:title', sessionId, title),
		setCustomName: (sessionId, name) => ipcRenderer.send('session:set-custom-name', sessionId, name),
		setParked: (sessionId, parked) => ipcRenderer.send('session:set-parked', sessionId, parked),
		setOrder: sessionIds => ipcRenderer.send('session:set-order', sessionIds),
		closeWithGrace: ptyId => ipcRenderer.invoke('session:close-with-grace', ptyId) as Promise<GraceClose | null>,
		undoClose: sessionId => ipcRenderer.invoke('session:undo-close', sessionId) as Promise<boolean>,
	},
	buffers: {
		read: sessionId => ipcRenderer.invoke('buffer:read', sessionId) as Promise<string | null>,
		save: (sessionId, data) => ipcRenderer.send('buffer:save', sessionId, data),
		onFlush: listener => subscribe('buffers:flush', listener),
		flushed: () => ipcRenderer.send('buffers:flushed'),
	},
	config: {
		getDaemonUrl: () => daemonUrl,
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
		aiPass: (id, pass) => invokeHelm('daemon:aiPass', id, pass),
		createItem: body => invokeHelm('daemon:createItem', body),
		sourceTask: id => invokeHelm('daemon:sourceTask', id),
		setStatus: (id, status) => invokeHelm('daemon:setStatus', id, status),
		config: () => invokeHelm('daemon:config'),
		updateConfig: body => invokeHelm('daemon:updateConfig', body),
		restartDaemon: () => invokeHelm('daemon:restart'),
		pauseToggle: () => invokeHelm('daemon:pauseToggle'),
		poll: () => invokeHelm('daemon:poll'),
	} satisfies DaemonApi,
	tabs: {
		onNew: listener => subscribe('tab:new', listener),
		onClose: listener => subscribe('tab:close', listener),
		onBackground: listener => subscribe('tab:background', listener),
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
