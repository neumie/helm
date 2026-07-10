import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { GraceClose, HelmApi, PtySpawnResult, RestoredSession } from './shared'

// Captured synchronously at preload time so the renderer gets the URL without an async hop.
const { daemonUrl } = ipcRenderer.sendSync('config:get') as { daemonUrl: string }

function subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
	const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as Args))
	ipcRenderer.on(channel, handler)
	return () => ipcRenderer.removeListener(channel, handler)
}

const api: HelmApi = {
	pty: {
		spawn: (cols, rows, sessionId) =>
			ipcRenderer.invoke('pty:spawn', { cols, rows, sessionId }) as Promise<PtySpawnResult>,
		write: (id, data) => ipcRenderer.send('pty:write', id, data),
		resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
		kill: (id) => ipcRenderer.send('pty:kill', id),
		onData: (listener) => subscribe('pty:data', listener),
		onExit: (listener) => subscribe('pty:exit', listener),
	},
	sessions: {
		list: () => ipcRenderer.invoke('sessions:list') as Promise<RestoredSession[]>,
		setTitle: (sessionId, title) => ipcRenderer.send('session:title', sessionId, title),
		closeWithGrace: (ptyId) =>
			ipcRenderer.invoke('session:close-with-grace', ptyId) as Promise<GraceClose | null>,
		undoClose: (sessionId) => ipcRenderer.invoke('session:undo-close', sessionId) as Promise<boolean>,
	},
	config: {
		getDaemonUrl: () => daemonUrl,
		pingDaemon: () => ipcRenderer.invoke('daemon:ping') as Promise<boolean>,
	},
	tabs: {
		onNew: (listener) => subscribe('tab:new', listener),
		onClose: (listener) => subscribe('tab:close', listener),
	},
	platform: process.platform,
}

contextBridge.exposeInMainWorld('helm', api)
