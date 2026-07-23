import * as path from 'node:path'
import { BrowserWindow, ipcMain, shell } from 'electron'
import type { HelmBridge } from './helm-bridge'
import type { RunContextDraft } from './shared-helm'

interface EditorState {
	itemId: string
	window: BrowserWindow
	dirty: boolean
	allowClose: boolean
}

interface RunContextWindowCallbacks {
	onAllClosed?(): void
	onCloseCancelled?(): void
	canOpen?(): boolean
}

function itemId(raw: unknown): string {
	const value = String(raw ?? '').trim()
	const hasControlCharacter = [...value].some(character => character.charCodeAt(0) < 32)
	if (!value || value.length > 200 || hasControlCharacter) throw new Error('Invalid Item id')
	return value
}

/** Owns the restricted, singleton-per-Item external run-context windows. */
export class RunContextWindows {
	private readonly byItem = new Map<string, EditorState>()
	private readonly byWebContents = new Map<number, EditorState>()

	constructor(
		private readonly bridge: HelmBridge,
		private readonly distDir: string,
		private readonly callbacks: RunContextWindowCallbacks = {},
	) {}

	hasDirtyWindows(): boolean {
		return [...this.byItem.values()].some(state => state.dirty)
	}

	/** Close every clean editor before a profile switch; dirty drafts block it. */
	prepareForProfileSwitch(): boolean {
		if (this.hasDirtyWindows()) return false
		for (const state of this.byItem.values()) {
			state.allowClose = true
			state.window.close()
		}
		return true
	}

	requestCloseAll(): void {
		for (const state of this.byItem.values()) state.window.close()
	}

	registerIpc(): void {
		const assertProfileAccess = () => {
			if (this.callbacks.canOpen?.() === false) throw new Error('Profile is switching — use Run Context afterward')
		}
		ipcMain.handle('run-context:open', (_event, rawId: unknown) => {
			assertProfileAccess()
			return this.open(itemId(rawId))
		})
		ipcMain.handle('run-context:load', event => {
			assertProfileAccess()
			const state = this.requireEditor(event.sender.id)
			return this.bridge.loadRunContext(state.itemId)
		})
		ipcMain.handle('run-context:save', (event, revision: unknown, document: RunContextDraft) => {
			assertProfileAccess()
			const state = this.requireEditor(event.sender.id)
			return this.bridge.saveRunContext(state.itemId, Number(revision), document)
		})
		ipcMain.handle('run-context:reset', (event, revision: unknown) => {
			assertProfileAccess()
			const state = this.requireEditor(event.sender.id)
			return this.bridge.resetRunContext(state.itemId, Number(revision))
		})
		ipcMain.on('run-context:dirty', (event, dirty: unknown) => {
			const state = this.byWebContents.get(event.sender.id)
			if (state && typeof dirty === 'boolean') state.dirty = dirty
		})
		ipcMain.on('run-context:close', (event, discard: unknown) => {
			const state = this.byWebContents.get(event.sender.id)
			if (!state || (state.dirty && discard !== true)) return
			state.allowClose = true
			state.window.close()
		})
		ipcMain.on('run-context:cancel-close', event => {
			if (this.byWebContents.has(event.sender.id)) this.callbacks.onCloseCancelled?.()
		})
	}

	private async open(id: string): Promise<void> {
		const existing = this.byItem.get(id)
		if (existing && !existing.window.isDestroyed()) {
			if (existing.window.isMinimized()) existing.window.restore()
			existing.window.show()
			existing.window.focus()
			return
		}

		const win = new BrowserWindow({
			width: 980,
			height: 760,
			minWidth: 720,
			minHeight: 520,
			title: 'Run context — Helm',
			show: false,
			backgroundColor: '#141517',
			titleBarStyle: 'hiddenInset',
			trafficLightPosition: { x: 14, y: 14 },
			webPreferences: {
				preload: path.join(this.distDir, 'preload-run-context.cjs'),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		})
		const state: EditorState = { itemId: id, window: win, dirty: false, allowClose: false }
		const webContentsId = win.webContents.id
		this.byItem.set(id, state)
		this.byWebContents.set(webContentsId, state)

		win.webContents.setWindowOpenHandler(({ url }) => {
			if (/^https?:/.test(url)) void shell.openExternal(url)
			return { action: 'deny' }
		})
		win.webContents.on('will-navigate', (event, url) => {
			event.preventDefault()
			if (/^https?:/.test(url)) void shell.openExternal(url)
		})
		win.on('close', event => {
			if (state.allowClose || !state.dirty) return
			event.preventDefault()
			win.webContents.send('run-context:close-requested')
		})
		win.on('closed', () => {
			this.byItem.delete(id)
			this.byWebContents.delete(webContentsId)
			if (this.byItem.size === 0) this.callbacks.onAllClosed?.()
		})
		win.once('ready-to-show', () => win.show())
		await win.loadFile(path.join(this.distDir, 'run-context-editor.html'))
	}

	private requireEditor(senderId: number): EditorState {
		const state = this.byWebContents.get(senderId)
		if (!state || state.window.isDestroyed()) throw new Error('Run context editor is not registered')
		return state
	}
}
