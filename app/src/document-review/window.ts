import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { parseExternalHttpUrl } from '../external-url'
import { sendToLiveRenderer } from '../renderer-lifecycle'
import type { SessionRegistry } from '../sessions'
import { requireReviewAccess } from './access'
import { ReviewDocumentObservation } from './document'
import { ReviewDraftStore } from './drafts'
import { reviewPrompt } from './request'
import { parseReviewRequest } from './request-admission'
import { ReviewSessions } from './sessions'
import type { ReviewDraft, ReviewProvider, ReviewResult, ReviewState } from './types'

const runFile = promisify(execFile)
interface WindowState {
	window: BrowserWindow
	senderId: number
	token: string
	profileId: string
	observation: ReviewDocumentObservation
	drafts: ReviewDraftStore
	sessions: ReviewSessions
	selectedSession: string | null
	dirty: boolean
	allowClose: boolean
	active: Set<Promise<unknown>>
}
interface ReviewWindowDependencies {
	distDir: string
	profileToken(): string
	allowsToken(token: unknown): boolean
	profileId(): string
	profileDir(id: string): string
	registry(id: string): SessionRegistry
	mainWindow(): BrowserWindow | null
	/** Resolve only a main-attested public plan artifact, never a renderer path. */
	planArtifact(itemId: string, name: string): string | null
	onAllClosed?(): void
}

export class DocumentReviewWindows {
	private readonly windows = new Map<number, WindowState>()
	private readonly sessions = new Map<string, ReviewSessions>()
	private readonly drafts = new Map<string, ReviewDraftStore>()
	private opening = false
	private stopping = false
	private admissionEpoch = 0
	private publishTimer: ReturnType<typeof setTimeout> | null = null
	private readonly pendingProfiles = new Set<string>()
	constructor(private readonly deps: ReviewWindowDependencies) {}
	private current(state: WindowState): boolean {
		return (
			!this.stopping &&
			!state.window.isDestroyed() &&
			this.windows.get(state.senderId) === state &&
			this.deps.allowsToken(state.token)
		)
	}
	private require(event: IpcMainInvokeEvent, token: unknown): WindowState {
		const state = this.windows.get(event.sender.id)
		if (!state) throw new Error('This review is no longer current. Reopen it in the active profile.')
		requireReviewAccess(state.window.webContents, event.sender, event.senderFrame, state.token, token, () =>
			this.current(state),
		)
		return state
	}
	private optional(event: IpcMainInvokeEvent, token: unknown): WindowState | null {
		try {
			return this.require(event, token)
		} catch {
			return null
		}
	}
	private async run<T>(
		event: IpcMainInvokeEvent,
		token: unknown,
		effect: (state: WindowState) => Promise<T> | T,
	): Promise<ReviewResult<T>> {
		let state: WindowState | null = null
		try {
			state = this.require(event, token)
			if (state.active.size >= 16) throw new Error('Review is busy. Wait for the current operation to finish.')
			const admitted = Promise.resolve().then(() => {
				this.require(event, token)
				return effect(state as WindowState)
			})
			state.active.add(admitted)
			let data: T
			try {
				data = await admitted
			} finally {
				state.active.delete(admitted)
			}
			this.require(event, token)
			return { data }
		} catch (error) {
			try {
				this.require(event, token)
			} catch {
				return { error: 'This review is no longer current. Reopen it in the active profile.' }
			}
			// Our domain errors contain only actionable copy; never return native path/argv diagnostics.
			const message = error instanceof Error ? error.message : ''
			return {
				error:
					message && !/[\r\n]|(?:\/Users\/|\/home\/)|ENOENT|EACCES|ZodError/.test(message)
						? message.slice(0, 400)
						: 'Review unavailable. Check the document, provider or saved drafts and try again.',
			}
		}
	}
	registerIpc(): void {
		ipcMain.on('document-review:bootstrap', event => {
			const state = this.windows.get(event.sender.id)
			event.returnValue = this.optional(event, state?.token)?.token ?? null
		})
		ipcMain.handle('document-review:open', async (event, token: unknown, itemId?: unknown, name?: unknown) => {
			const win = this.deps.mainWindow()
			const epoch = this.admissionEpoch
			const current = () =>
				!this.stopping &&
				epoch === this.admissionEpoch &&
				!!win &&
				!win.isDestroyed() &&
				event.sender === win.webContents &&
				event.senderFrame === win.webContents.mainFrame &&
				this.deps.allowsToken(token)
			if (!current() || this.opening) return { error: 'Document opening is unavailable.' }
			this.opening = true
			try {
				let file: string | null = null
				if (typeof itemId === 'string' && typeof name === 'string') file = this.deps.planArtifact(itemId, name)
				if (itemId !== undefined && !file)
					throw new Error('That plan document is no longer available. Refresh its Item or use Open Markdown file.')
				if (!file) {
					const result = await dialog.showOpenDialog(win as BrowserWindow, {
						title: 'Open Markdown file for review',
						filters: [{ name: 'Markdown', extensions: ['md'] }],
						properties: ['openFile'],
					})
					if (!current()) throw new Error('The profile changed while choosing the file. Open it again.')
					if (result.canceled || !result.filePaths[0]) return { data: false }
					file = result.filePaths[0]
				}
				await this.openFile(file, token as string, current)
				return { data: true }
			} catch {
				return {
					error: 'Could not open the document. Choose a visible regular Markdown file in a repository you trust.',
				}
			} finally {
				this.opening = false
			}
		})
		ipcMain.handle('document-review:load', (event, token: unknown) =>
			this.run(event, token, state => this.snapshot(state)),
		)
		ipcMain.handle('document-review:retry', (event, token: unknown) =>
			this.run(event, token, async state => {
				await state.observation.refresh()
				return true
			}),
		)
		ipcMain.handle('document-review:save', (event, token: unknown, raw: unknown) =>
			this.run(event, token, state => {
				const draft = raw as ReviewDraft
				if (draft?.sessionId !== state.selectedSession)
					throw new Error('The conversation changed before saving. Your previous draft was not overwritten.')
				state.drafts.save(
					state.drafts.key(state.observation.root, state.observation.file, state.selectedSession),
					draft,
				)
				// A pointer in the document's default preference scope, never command authority.
				if (state.selectedSession) {
					const base = state.drafts.load(state.drafts.key(state.observation.root, state.observation.file, null))
					state.drafts.save(state.drafts.key(state.observation.root, state.observation.file, null), {
						...base,
						sessionId: state.selectedSession,
						paneWidth: draft.paneWidth,
						theme: draft.theme,
					})
				}
				return true
			}),
		)
		ipcMain.handle('document-review:select', (event, token: unknown, id: unknown) =>
			this.run(event, token, state => {
				if (
					state.sessions
						.list(state.observation.root)
						.some(session => session.id === state.selectedSession && session.busy)
				)
					throw new Error('Wait for the selected conversation to settle before switching.')
				if (
					id !== null &&
					(typeof id !== 'string' || !state.sessions.list(state.observation.root).some(session => session.id === id))
				)
					throw new Error('Choose a connected review agent.')
				state.selectedSession = id as string | null
				return {
					...state.drafts.load(state.drafts.key(state.observation.root, state.observation.file, state.selectedSession)),
					sessionId: state.selectedSession,
				}
			}),
		)
		ipcMain.handle('document-review:send', (event, token: unknown, raw: unknown) =>
			this.run(event, token, async state => {
				const request = parseReviewRequest(raw)
				if (request.documentId !== state.observation.id || request.sessionId !== state.selectedSession)
					throw new Error('This request no longer belongs to the chosen document and conversation.')
				const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
				const prior = state.sessions.prior(request.id, fingerprint)
				if (prior) return prior
				if ([...this.sessions.values()].reduce((n, sessions) => n + sessions.admittedCount(), 0) >= 8)
					throw new Error('Eight review turns are already in progress. Wait for a turn to settle.')
				const owner = state.sessions.reserve(request.sessionId, request.owner, state.observation.root)
				try {
					await state.observation.refresh()
					this.require(event, token)
					const document = state.observation.current()
					if (document.error) throw new Error(document.error)
					if (document.revision !== request.revision)
						throw new Error('The document changed before sending. Review the new content and select the passage again.')
					const prompt = reviewPrompt(request, document.text, document.relativePath)
					this.require(event, token)
					if (state.selectedSession !== request.sessionId)
						throw new Error('The chosen conversation changed before dispatch. Nothing was sent.')
					return state.sessions.dispatch(owner, request.id, fingerprint, {
						request,
						prompt,
						relativePath: document.relativePath,
					})
				} finally {
					state.sessions.release(owner)
				}
			}),
		)
		ipcMain.handle('document-review:interrupt', (event, token: unknown, id: string, owner: string) =>
			this.run(event, token, state => {
				this.requireSelectedOwner(state, id, owner)
				return state.sessions.interrupt()
			}),
		)
		ipcMain.handle('document-review:acknowledge', (event, token: unknown, id: string, owner: string) =>
			this.run(event, token, state => {
				this.requireSelectedOwner(state, id, owner)
				state.sessions.acknowledge(id, owner)
				return true
			}),
		)
		ipcMain.handle('document-review:receipt', (event, token: unknown, id: string) =>
			this.run(event, token, state =>
				state.selectedSession ? state.sessions.receipt(id, state.selectedSession) : null,
			),
		)
		ipcMain.on('document-review:dirty', (event, token: unknown, dirty: unknown) => {
			const state = this.optional(event, token)
			if (state && typeof dirty === 'boolean') state.dirty = dirty
		})
		ipcMain.on('document-review:close', (event, token: unknown) => {
			const state = this.optional(event, token)
			if (!state || state.dirty) return
			state.allowClose = true
			state.window.close()
		})
	}
	async chooseFileFromMenu(): Promise<void> {
		const win = this.deps.mainWindow()
		const token = this.deps.profileToken()
		const epoch = this.admissionEpoch
		const current = () =>
			!this.stopping &&
			epoch === this.admissionEpoch &&
			!!win &&
			!win.isDestroyed() &&
			this.deps.mainWindow() === win &&
			this.deps.allowsToken(token)
		if (!current() || this.opening) return
		this.opening = true
		try {
			const picked = await dialog.showOpenDialog(win as BrowserWindow, {
				title: 'Open Markdown file for review',
				filters: [{ name: 'Markdown', extensions: ['md'] }],
				properties: ['openFile'],
			})
			if (!current() || picked.canceled || !picked.filePaths[0]) return
			await this.openFile(picked.filePaths[0], token, current)
		} catch {
			if (current())
				await dialog.showMessageBox(win as BrowserWindow, {
					type: 'warning',
					message: 'Document review unavailable',
					detail: 'Choose a visible regular Markdown file inside a repository you trust. No agent was started.',
				})
		} finally {
			this.opening = false
		}
	}
	/** Only the private native control service calls this; no renderer can enroll a caller. */
	connectCaller(provider: ReviewProvider, workspace: string, name: string, transport: 'tool-return' | 'in-process') {
		return this.sessionsFor(this.deps.profileId()).connect(provider, workspace, name, transport)
	}
	callerSessions(profileId: string): ReviewSessions {
		return this.sessionsFor(profileId)
	}
	private sessionsFor(profileId: string): ReviewSessions {
		let sessions = this.sessions.get(profileId)
		if (!sessions) {
			sessions = new ReviewSessions(() => this.publish(profileId))
			this.sessions.set(profileId, sessions)
		}
		return sessions
	}
	async openForCaller(file: string, token: string, profileId: string, sessionId: string, owner: string) {
		// Share native/menu admission: concurrent CLI opens must not create duplicate
		// windows or race the eight-window bound before observation.start() settles.
		if (this.opening) throw new Error('Another document is opening. Wait before opening this document.')
		const connected = this.sessionsFor(profileId).get(sessionId, owner)
		const epoch = this.admissionEpoch
		const current = () =>
			!this.stopping &&
			epoch === this.admissionEpoch &&
			!connected.retired &&
			this.deps.allowsToken(token) &&
			this.deps.profileId() === profileId
		if (!current()) throw new Error('The active profile changed. Reconnect explicitly.')
		this.opening = true
		try {
			await this.openFile(file, token, current, sessionId, connected.workspace)
			if (!current()) throw new Error('The connection changed while opening.')
			const state = [...this.windows.values()].find(
				value => value.token === token && value.observation.file === file && value.selectedSession === sessionId,
			)
			if (!state) throw new Error('The document could not open for this connection.')
			const document = state.observation.current()
			return { documentId: document.id, revision: document.revision, relativePath: document.relativePath }
		} finally {
			this.opening = false
		}
	}
	async openFile(
		rawFile: string,
		token: string,
		current: () => boolean,
		sessionId?: string,
		expectedRoot?: string,
	): Promise<void> {
		const original = resolve(rawFile)
		const stat = await lstat(original)
		if (!current() || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular Markdown file')
		const file = await realpath(original)
		if (!current()) throw new Error('Profile changed')
		const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
		for (const key of Object.keys(environment))
			if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') Reflect.deleteProperty(environment, key)
		const result = await runFile('git', ['-C', dirname(file), 'rev-parse', '--show-toplevel'], {
			env: environment,
			timeout: 5000,
			maxBuffer: 8192,
		})
		if (!current()) throw new Error('Profile changed')
		const root = await realpath(result.stdout.trim())
		if (!current()) throw new Error('Profile changed')
		if (expectedRoot && root !== expectedRoot) throw new Error('The document is outside the connected repository.')
		for (const state of this.windows.values())
			if (state.token === token && state.observation.file === file) {
				if (sessionId && state.selectedSession !== sessionId) {
					if (state.selectedSession || state.dirty || state.active.size || state.sessions.isBusy())
						throw new Error(
							'This document already has a review owner or unsaved work. Choose the new connected agent explicitly in that window, or close it before opening again; nothing was rerouted.',
						)
					state.selectedSession = sessionId
					this.publish(state.profileId)
				}
				state.window.show()
				state.window.focus()
				return
			}
		if (this.windows.size >= 8) throw new Error('Close a review window before opening another.')
		const profileId = this.deps.profileId()
		const sessions = this.sessionsFor(profileId)
		if (!current()) throw new Error('Profile changed')
		let drafts = this.drafts.get(profileId)
		if (!drafts) {
			drafts = new ReviewDraftStore(this.deps.profileDir(profileId))
			this.drafts.set(profileId, drafts)
		}
		const observation = new ReviewDocumentObservation(root, file, () => this.publish(profileId))
		await observation.start()
		if (!current() || observation.current().error) {
			await observation.dispose()
			throw new Error('Document unavailable')
		}
		const win = new BrowserWindow({
			width: 1180,
			height: 800,
			minWidth: 640,
			minHeight: 520,
			title: `${observation.current().name} — Helm`,
			show: false,
			titleBarStyle: 'hidden',
			trafficLightPosition: { x: 16, y: 16 },
			webPreferences: {
				preload: join(this.deps.distDir, 'preload-document-review.cjs'),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		})
		const base = drafts.load(drafts.key(root, file, null))
		const senderId = win.webContents.id
		const state: WindowState = {
			window: win,
			senderId,
			token,
			profileId,
			observation,
			drafts,
			sessions,
			selectedSession:
				sessionId ?? (sessions.list(root).some(value => value.id === base.sessionId) ? base.sessionId : null),
			dirty: false,
			allowClose: false,
			active: new Set(),
		}
		this.windows.set(win.webContents.id, state)
		win.webContents.setWindowOpenHandler(({ url }) => {
			const safe = parseExternalHttpUrl(url)
			if (this.current(state) && safe) void shell.openExternal(safe)
			return { action: 'deny' }
		})
		win.webContents.on('will-navigate', event => event.preventDefault())
		win.webContents.on('before-input-event', (event, input) => {
			if (
				input.type === 'keyDown' &&
				input.code === 'KeyW' &&
				(process.platform === 'darwin' ? input.meta : input.control)
			) {
				event.preventDefault()
				win.close()
			}
		})
		win.on('close', event => {
			if (state.dirty && !state.allowClose) {
				event.preventDefault()
				sendToLiveRenderer(win.webContents, 'document-review:close-requested')
			}
		})
		win.on('closed', () => {
			this.windows.delete(senderId)
			void observation.dispose()
			if (!this.windows.size) this.deps.onAllClosed?.()
		})
		win.once('ready-to-show', () => {
			if (this.current(state)) win.show()
			else win.close()
		})
		try {
			await win.loadFile(join(this.deps.distDir, 'document-review.html'))
		} catch {
			win.destroy()
			throw new Error('The review window could not load.')
		}
	}
	private requireSelectedOwner(state: WindowState, id: string, owner: string): void {
		if (
			state.selectedSession !== id ||
			!state.sessions.list(state.observation.root).some(session => session.id === id && session.owner === owner)
		)
			throw new Error('The selected conversation owner changed. No control was dispatched.')
	}
	private snapshot(state: WindowState): ReviewState {
		const draft = state.drafts.load(
			state.drafts.key(state.observation.root, state.observation.file, state.selectedSession),
		)
		return {
			document: state.observation.current(),
			sessions: state.sessions.list(state.observation.root),
			draft: { ...draft, sessionId: state.selectedSession },
		}
	}
	private publish(profileId: string): void {
		if (![...this.windows.values()].some(state => state.profileId === profileId && this.current(state))) return
		this.pendingProfiles.add(profileId)
		if (this.publishTimer) return
		this.publishTimer = setTimeout(() => {
			this.publishTimer = null
			const profiles = new Set(this.pendingProfiles)
			this.pendingProfiles.clear()
			for (const state of this.windows.values())
				if (profiles.has(state.profileId) && this.current(state))
					sendToLiveRenderer(state.window.webContents, 'document-review:changed')
		}, 80)
		this.publishTimer.unref()
	}
	/** Close document authority before the existing profile fence advances. Admitted reads drain first. */
	async closeForProfileSwitch(): Promise<void> {
		if ([...this.windows.values()].some(state => state.dirty))
			throw new Error('Review drafts are still saving. Finish saving them before switching profiles.')
		this.admissionEpoch++
		for (const sessions of this.sessions.values()) sessions.stopOwned()
		const states = [...this.windows.values()]
		for (const state of states) {
			this.windows.delete(state.senderId)
			state.allowClose = true
			state.window.close()
		}
		await Promise.all(states.flatMap(state => [...state.active, state.observation.dispose()]))
	}
	hasDirty(): boolean {
		return [...this.windows.values()].some(state => state.dirty)
	}
	busy(): boolean {
		return [...this.sessions.values()].some(sessions => sessions.isBusy())
	}
	async stopOwned(): Promise<void> {
		this.admissionEpoch++
		this.stopping = true
		try {
			await Promise.allSettled([...this.windows.values()].flatMap(state => [...state.active]))
			await Promise.all([...this.sessions.values()].map(sessions => sessions.stopOwned()))
		} finally {
			this.stopping = false
			for (const profileId of this.sessions.keys()) this.publish(profileId)
		}
	}
	requestCloseAll(): void {
		for (const state of this.windows.values()) state.window.close()
	}
}
