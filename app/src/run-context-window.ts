import * as path from 'node:path'
import { BrowserWindow, ipcMain, shell } from 'electron'
import type { HelmBridge } from './helm-bridge'
import { RunContextAccess, type RunContextDrainResult } from './run-context-access'
import type { RunContextDraft } from './shared-helm'
import type { ShortcutChord } from './shortcuts'

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
	shortcutSaveBindings?(): ShortcutChord[]
	profileToken(): string
	allowsProfileToken(token: unknown): boolean
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
	private readonly access: RunContextAccess

	constructor(
		private readonly bridge: HelmBridge,
		private readonly distDir: string,
		private readonly callbacks: RunContextWindowCallbacks,
	) {
		this.access = new RunContextAccess(() => this.callbacks.canOpen?.() !== false)
	}

	hasDirtyWindows(): boolean {
		return [...this.byItem.values()].some(state => state.dirty)
	}

	/**
	 * Synchronously refuse dirty drafts before closing a window or changing
	 * admission. Once accepted, no new load/save/reset can enter the drain.
	 */
	beginProfileSwitchDrain(): RunContextDrainResult {
		return this.access.beginProfileSwitchDrain(
			() => this.hasDirtyWindows(),
			() => {
				for (const state of this.byItem.values()) {
					state.allowClose = true
					state.window.close()
				}
			},
		)
	}

	requestCloseAll(): void {
		for (const state of this.byItem.values()) state.window.close()
	}

	registerIpc(): void {
		ipcMain.on('run-context:bootstrap', event => {
			try {
				this.access.assertAdmissionOpen()
				this.access.itemIdFor(event.sender.id)
				const profileToken = this.callbacks.profileToken()
				if (!profileToken) throw new Error('Run Context profile capability is unavailable')
				event.returnValue = {
					profileToken,
					saveBindings: this.callbacks.shortcutSaveBindings?.() ?? [],
				}
			} catch {
				// A main renderer, destroyed editor, or switching profile receives no capability.
				event.returnValue = null
			}
		})
		ipcMain.handle('run-context:open', (_event, rawId: unknown) => {
			this.access.assertAdmissionOpen()
			return this.open(itemId(rawId))
		})
		ipcMain.handle('run-context:load', (event, profileToken: unknown) =>
			this.access.runForEditor(event.sender.id, itemId => {
				this.requireCurrentProfileToken(profileToken)
				return this.bridge.loadRunContext(itemId, profileToken)
			}),
		)
		ipcMain.handle('run-context:save', (event, revision: unknown, document: RunContextDraft, profileToken: unknown) =>
			this.access.runForEditor(event.sender.id, itemId => {
				this.requireCurrentProfileToken(profileToken)
				return this.bridge.saveRunContext(itemId, Number(revision), document, profileToken)
			}),
		)
		ipcMain.handle('run-context:reset', (event, revision: unknown, profileToken: unknown) =>
			this.access.runForEditor(event.sender.id, itemId => {
				this.requireCurrentProfileToken(profileToken)
				return this.bridge.resetRunContext(itemId, Number(revision), profileToken)
			}),
		)
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

	/** Publish only Save aliases: no generic preferences ever enter this preload. */
	publishShortcutSaveBindings(bindings: readonly ShortcutChord[], profileToken: string): void {
		for (const state of this.byItem.values()) {
			if (!state.window.isDestroyed())
				state.window.webContents.send('run-context:save-bindings', bindings, profileToken)
		}
	}

	private requireCurrentProfileToken(profileToken: unknown): void {
		if (this.callbacks.allowsProfileToken(profileToken) !== true)
			throw new Error('Run Context editor is no longer current')
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
		this.access.registerEditor(webContentsId, id, () => win.isDestroyed())

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
			this.access.unregisterEditor(webContentsId)
			if (this.byItem.size === 0) this.callbacks.onAllClosed?.()
		})
		win.once('ready-to-show', () => win.show())
		await win.loadFile(path.join(this.distDir, 'run-context-editor.html'))
	}
}
