import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { HelmApi } from './shared'

// Captured synchronously at preload time so the renderer gets the URL without an async hop.
const { daemonUrl } = ipcRenderer.sendSync('config:get') as { daemonUrl: string }

function subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
	const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as Args))
	ipcRenderer.on(channel, handler)
	return () => ipcRenderer.removeListener(channel, handler)
}

const api: HelmApi = {
	pty: {
		spawn: (cols, rows) => ipcRenderer.invoke('pty:spawn', { cols, rows }) as Promise<number>,
		write: (id, data) => ipcRenderer.send('pty:write', id, data),
		resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
		kill: (id) => ipcRenderer.send('pty:kill', id),
		onData: (listener) => subscribe('pty:data', listener),
		onExit: (listener) => subscribe('pty:exit', listener),
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
