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
import { appendReviewArtifact, parseReviewArtifact } from './canvas-artifact'
import { ReviewArchiveCapacity, ReviewArchivePersistence } from './canvas-persistence'
import { ReviewDocumentObservation, readReviewFile, reviewRevision } from './document'
import { ReviewDraftStore, reviewDraftSchema } from './drafts'
import { reviewPrompt } from './request'
import { parseReviewRequest } from './request-admission'
import { ReviewSessions } from './sessions'
import { defaultReviewDraft } from './types'
import type { CanvasReviewEntry, CanvasReviewThread, ReviewProvider, ReviewResult, ReviewState } from './types'

const runFile = promisify(execFile)
interface WindowState {
	recoveryContext: ArchiveFileContext | null
	window: BrowserWindow
	senderId: number
	token: string
	profileId: string
	observation: ReviewDocumentObservation
	drafts: ReviewDraftStore
	archive: ReviewArchivePersistence
	noteSave: boolean
	sessions: ReviewSessions
	selectedSession: string | null
	dirty: boolean
	allowClose: boolean
	fileFlights: Set<Promise<unknown>>
	active: Set<Promise<unknown>>
}
interface ArchiveFileContext {
	root: string
	file: string
	profileId: string
	token: string
	epoch: number
	archive: ReviewArchivePersistence
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
	private readonly archiveCapacity = new ReviewArchiveCapacity()
	private readonly archives = new Map<string, ArchiveFileContext>()
	private saveEpoch = 0
	private admissionClosed = false
	private drainOperation: Promise<void> | null = null
	private opening = false
	private stopping = false
	private admissionEpoch = 0
	private publishTimer: ReturnType<typeof setTimeout> | null = null
	private readonly pendingProfiles = new Set<string>()
	constructor(private readonly deps: ReviewWindowDependencies) {}
	private current(state: WindowState): boolean {
		return (
			!state.window.isDestroyed() &&
			this.windows.get(state.senderId) === state &&
			(state.recoveryContext
				? this.historicalCurrent(state.recoveryContext) &&
					this.archives.get(this.archiveKey(state.profileId, state.observation.root, state.observation.file)) ===
						state.recoveryContext
				: this.deps.allowsToken(state.token))
		)
	}
	private requireAdmission(): void {
		if (this.admissionClosed)
			throw new Error('Review admission is closed. Recover unsaved replies before leaving this profile.')
	}
	private requireWritable(state: WindowState): void {
		if (state.recoveryContext)
			throw new Error('This window only recovers an unsaved reply. No feedback or comment can be sent or saved.')
		this.requireAdmission()
	}
	private archiveKey(profileId: string, root: string, file: string): string {
		return JSON.stringify([profileId, root, file])
	}
	private historicalCurrent(context: ArchiveFileContext): boolean {
		return (
			context.epoch === this.saveEpoch &&
			this.deps.profileId() === context.profileId &&
			this.deps.profileToken() === context.token
		)
	}
	private pruneArchive(context: ArchiveFileContext): void {
		if (
			!context.archive.unresolved() &&
			![...this.windows.values()].some(
				state => state.profileId === context.profileId && state.observation.file === context.file,
			)
		)
			this.archives.delete(this.archiveKey(context.profileId, context.root, context.file))
	}
	private archiveFor(profileId: string, root: string, file: string, token: string): ArchiveFileContext {
		const key = this.archiveKey(profileId, root, file)
		const prior = this.archives.get(key)
		if (prior) return prior
		const context: ArchiveFileContext = {
			root,
			file,
			profileId,
			token,
			epoch: this.saveEpoch,
			archive: new ReviewArchivePersistence(() => {
				this.publish(profileId)
				this.pruneArchive(context)
			}, this.archiveCapacity),
		}
		this.archives.set(key, context)
		return context
	}
	private async appendHistoricalSettlement(
		context: ArchiveFileContext,
		start: CanvasReviewThread,
		entry: CanvasReviewEntry,
	): Promise<void> {
		const current = () => this.historicalCurrent(context)
		if (!current()) throw new Error('The original review save authority is no longer current.')
		const raw = await readReviewFile(context.root, context.file)
		if (!current()) throw new Error('The original review save authority changed while reading.')
		const { body, archive } = parseReviewArtifact(raw, /\.md$/i.test(context.file) ? 'markdown' : 'jsx')
		const existing = archive.threads.find((thread: CanvasReviewThread) => thread.id === start.id)
		const immutable = (thread: CanvasReviewThread) =>
			JSON.stringify({
				id: thread.id,
				instruction: thread.instruction,
				intent: thread.intent,
				passage: thread.passage,
				fields: thread.fields,
				provider: thread.provider,
				name: thread.name,
			})
		if (!existing || immutable(existing) !== immutable(start))
			throw new Error('The original review question is missing or changed. The reply was not saved.')
		await appendReviewArtifact(context.root, context.file, [entry], {
			expectedSourceRevision: reviewRevision(body),
			expectedArchiveRevision: archive.revision,
			current,
		})
		if (!current()) throw new Error('The original review save authority changed before publication.')
		// Metadata is observed by any current window, never by an obsolete renderer event.
		this.publish(context.profileId)
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
		fileOperation = false,
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
			if (fileOperation) state.fileFlights.add(admitted)
			let data: T
			try {
				data = await admitted
			} finally {
				state.active.delete(admitted)
				if (fileOperation) state.fileFlights.delete(admitted)
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
					throw new Error('That plan document is no longer available. Refresh its Item or use Open document.')
				if (!file) {
					const result = await dialog.showOpenDialog(win as BrowserWindow, {
						title: 'Open document for review',
						filters: [{ name: 'Markdown or JSX', extensions: ['md', 'jsx', 'tsx'] }],
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
					error:
						'Could not open the document. Choose a visible regular Markdown or JSX file in a repository you trust.',
				}
			} finally {
				this.opening = false
			}
		})
		ipcMain.handle('document-review:load', (event, token: unknown) =>
			this.run(event, token, state => this.snapshot(state)),
		)
		ipcMain.handle('document-review:retry', (event, token: unknown) =>
			this.run(
				event,
				token,
				async state => {
					await state.archive.retry()
					this.require(event, token)
					await state.observation.refresh()
					return true
				},
				true,
			),
		)
		ipcMain.handle('document-review:save', (event, token: unknown, raw: unknown) =>
			this.run(
				event,
				token,
				async state => {
					this.requireWritable(state)
					const draft = reviewDraftSchema.parse(raw)
					if (draft?.sessionId !== state.selectedSession)
						throw new Error('The conversation changed before saving. Your previous draft was not overwritten.')
					const document = state.observation.current()
					if (Object.hasOwn(draft, 'archiveRevision')) {
						if (draft.archiveRevision === undefined)
							throw new Error('An explicit review-note save needs its captured archive revision.')
						if (document.error) throw new Error(document.error)
						if (state.noteSave) throw new Error('Review notes are still saving. Wait before editing them again.')
						if (draft.archiveRevision === null && document.archive?.revision !== document.revision)
							throw new Error('Review notes changed before saving. Reload before editing again.')
						state.noteSave = true
						try {
							await appendReviewArtifact(
								state.observation.root,
								state.observation.file,
								[{ version: 1, type: 'annotations', annotations: draft.annotations }],
								{
									expectedSourceRevision: document.revision,
									expectedArchiveRevision: draft.archiveRevision ?? document.revision,
									current: () => !!this.optional(event, token) && state.selectedSession === draft.sessionId,
								},
							)
							this.require(event, token)
							await state.observation.refresh()
							this.require(event, token)
							if (state.selectedSession !== draft.sessionId)
								throw new Error('The selected conversation changed while saving.')
						} finally {
							state.noteSave = false
						}
					}
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
				},
				true,
			),
		)
		ipcMain.handle('document-review:select', (event, token: unknown, id: unknown) =>
			this.run(event, token, state => {
				this.requireWritable(state)
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
				return this.snapshot(state).draft
			}),
		)
		ipcMain.handle('document-review:send', (event, token: unknown, raw: unknown) =>
			this.run(
				event,
				token,
				async state => {
					this.requireWritable(state)
					const request = parseReviewRequest(raw)
					if (request.documentId !== state.observation.id || request.sessionId !== state.selectedSession)
						throw new Error('This request no longer belongs to the chosen document and conversation.')
					const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
					const prior = state.sessions.prior(request.id, fingerprint)
					if (prior) return prior
					if ([...this.sessions.values()].reduce((n, sessions) => n + sessions.admittedCount(), 0) >= 8)
						throw new Error('Eight review turns are already in progress. Wait for a turn to settle.')
					if (state.archive.error()) throw new Error(state.archive.error() as string)
					const owner = state.sessions.reserve(request.sessionId, request.owner, state.observation.root)
					try {
						await state.observation.refresh()
						this.require(event, token)
						const document = state.observation.current()
						if (document.error) throw new Error(document.error)
						if (document.revision !== request.revision)
							throw new Error(
								'The document changed before sending. Review the new content and select the passage again.',
							)
						const prompt = reviewPrompt(request, document.text, document.relativePath, document.canvas)
						this.require(event, token)
						if (state.selectedSession !== request.sessionId)
							throw new Error('The chosen conversation changed before dispatch. Nothing was sent.')
						const context = this.archiveFor(
							state.profileId,
							state.observation.root,
							state.observation.file,
							state.token,
						)
						const archive = await state.archive.begin(
							{
								instruction: request.instruction,
								intent: request.intent,
								passage: request.passage,
								fields: request.canvasFields ?? [],
								provider: owner.snapshot.provider,
								name: owner.snapshot.name,
							},
							async entry => {
								await appendReviewArtifact(state.observation.root, state.observation.file, [entry], {
									expectedSourceRevision: request.revision,
									current: () =>
										!this.admissionClosed &&
										!!this.optional(event, token) &&
										state.observation.current().revision === request.revision,
								})
								this.require(event, token)
							},
							(start, entry) => this.appendHistoricalSettlement(context, start, entry),
						)
						try {
							await state.observation.refresh()
							this.require(event, token)
							this.requireAdmission()
							if (
								state.selectedSession !== request.sessionId ||
								state.observation.current().error ||
								state.observation.current().revision !== request.revision ||
								owner.retired
							)
								throw new Error('The document or conversation changed before dispatch. Nothing was sent.')
							return state.sessions.dispatch(
								owner,
								request.id,
								fingerprint,
								{ request, prompt, relativePath: document.relativePath },
								archive,
							)
						} catch (error) {
							archive.settle({
								state: 'rejected',
								detail: 'The document or original listener changed before dispatch. Nothing was sent.',
							})
							throw error
						}
					} finally {
						state.sessions.release(owner)
					}
				},
				true,
			),
		)
		ipcMain.handle('document-review:interrupt', (event, token: unknown, id: string, owner: string) =>
			this.run(event, token, state => {
				this.requireWritable(state)
				this.requireSelectedOwner(state, id, owner)
				return state.sessions.interrupt()
			}),
		)
		ipcMain.handle('document-review:acknowledge', (event, token: unknown, id: string, owner: string) =>
			this.run(event, token, state => {
				this.requireWritable(state)
				this.requireSelectedOwner(state, id, owner)
				state.sessions.acknowledge(id, owner)
				return true
			}),
		)
		ipcMain.handle('document-review:discard-archive', (event, token: unknown, id: unknown) =>
			this.run(event, token, state => {
				if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
					throw new Error('Choose a current unsaved reply to discard.')
				state.archive.discard(id)
				return true
			}),
		)
		ipcMain.handle('document-review:receipt', (event, token: unknown, id: string) =>
			this.run(event, token, state => {
				this.requireWritable(state)
				return state.selectedSession ? state.sessions.receipt(id, state.selectedSession) : null
			}),
		)
		ipcMain.on('document-review:dirty', (event, token: unknown, dirty: unknown) => {
			const state = this.optional(event, token)
			if (state && !state.recoveryContext && typeof dirty === 'boolean') state.dirty = dirty
		})
		ipcMain.on('document-review:close', (event, token: unknown) => {
			const state = this.optional(event, token)
			if (!state || state.dirty || state.noteSave || state.fileFlights.size > 0 || state.archive.guarded()) return
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
				title: 'Open document for review',
				filters: [{ name: 'Markdown or JSX', extensions: ['md', 'jsx', 'tsx'] }],
				properties: ['openFile'],
			})
			if (!current() || picked.canceled || !picked.filePaths[0]) return
			await this.openFile(picked.filePaths[0], token, current)
		} catch {
			if (current())
				await dialog.showMessageBox(win as BrowserWindow, {
					type: 'warning',
					message: 'Document review unavailable',
					detail: 'Choose a visible regular Markdown or JSX file inside a repository you trust. No agent was started.',
				})
		} finally {
			this.opening = false
		}
	}
	/** Only the private native control service calls this; no renderer can enroll a caller. */
	connectCaller(provider: ReviewProvider, workspace: string, name: string, transport: 'tool-return' | 'in-process') {
		this.requireAdmission()
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
		this.requireAdmission()
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
		if (!current() || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular document file')
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
		if (
			this.admissionClosed &&
			!this.archives.get(this.archiveKey(this.deps.profileId(), root, file))?.archive.guarded()
		)
			throw new Error('Only unsaved review replies can be reopened during recovery.')
		if (expectedRoot && root !== expectedRoot) throw new Error('The document is outside the connected repository.')
		for (const state of this.windows.values())
			if (state.token === token && state.observation.file === file) {
				if (state.recoveryContext && sessionId)
					throw new Error('Close the recovery window before selecting a new caller.')
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
		await this.createWindow(observation, profileId, token, current, sessionId)
	}
	private async createWindow(
		observation: ReviewDocumentObservation,
		profileId: string,
		token: string,
		current: () => boolean,
		sessionId?: string,
		recoveryContext: ArchiveFileContext | null = null,
	): Promise<void> {
		if (!current() || this.windows.size >= 8) {
			await observation.dispose()
			throw new Error('Close a review window before opening another.')
		}
		const { root, file } = observation
		const sessions = this.sessionsFor(profileId)
		const drafts = this.drafts.get(profileId)
		if (!drafts) {
			await observation.dispose()
			throw new Error('Review preferences are unavailable.')
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
			recoveryContext,
			window: win,
			senderId,
			token,
			profileId,
			observation,
			drafts,
			archive: recoveryContext?.archive ?? this.archiveFor(profileId, root, file, token).archive,
			noteSave: false,
			sessions,
			selectedSession: recoveryContext
				? null
				: (sessionId ?? (sessions.list(root).some(value => value.id === base.sessionId) ? base.sessionId : null)),
			dirty: false,
			allowClose: false,
			fileFlights: new Set(),
			active: new Set(),
		}
		this.windows.set(win.webContents.id, state)
		win.webContents.setWindowOpenHandler(({ url }) => {
			const safe = parseExternalHttpUrl(url)
			if (!state.recoveryContext && this.current(state) && safe) void shell.openExternal(safe)
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
			if (
				(state.dirty || state.noteSave || state.fileFlights.size > 0 || state.archive.guarded()) &&
				!state.allowClose
			) {
				event.preventDefault()
				sendToLiveRenderer(win.webContents, 'document-review:close-requested')
			}
		})
		win.on('closed', () => {
			this.windows.delete(senderId)
			void observation.dispose()
			const context = this.archives.get(this.archiveKey(profileId, root, file))
			if (context) this.pruneArchive(context)
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
		const draft = state.recoveryContext
			? defaultReviewDraft()
			: state.drafts.load(state.drafts.key(state.observation.root, state.observation.file, state.selectedSession))
		return {
			document: state.observation.current(),
			sessions: state.recoveryContext ? [] : state.sessions.list(state.observation.root),
			draft: {
				...draft,
				...(state.observation.current().archive &&
				state.observation.current().archive?.revision !== state.observation.current().revision
					? { annotations: state.observation.current().archive?.annotations ?? [] }
					: {}),
				archiveRevision:
					state.observation.current().archive?.revision === state.observation.current().revision
						? null
						: state.observation.current().archive?.revision,
				sessionId: state.selectedSession,
			},
			archiveError: state.archive.error(),
			archiveFailureId: state.archive.failureId(),
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
	/** Main only: no pathname/authority comes from a renderer or an archive record. */
	async showArchiveRecovery(): Promise<void> {
		if (this.opening || this.stopping)
			throw new Error('Another review operation is still opening or draining. Retry recovery shortly.')
		const candidates = [...this.archives.values()].filter(
			context => this.historicalCurrent(context) && context.archive.failureId(),
		)
		if (!candidates.length) return
		this.opening = true
		try {
			for (const context of candidates) {
				const current = () =>
					this.historicalCurrent(context) &&
					this.archives.get(this.archiveKey(context.profileId, context.root, context.file)) === context &&
					!!context.archive.failureId()
				if (!current()) continue
				const existing = [...this.windows.values()].find(
					state => state.profileId === context.profileId && state.observation.file === context.file,
				)
				if (existing) {
					if (existing.dirty || existing.noteSave || existing.fileFlights.size)
						throw new Error('Finish the local draft before opening reply recovery in this window.')
					existing.recoveryContext = context
					existing.selectedSession = null
					existing.window.show()
					existing.window.focus()
					this.publish(context.profileId)
					continue
				}
				if (this.windows.size >= 8) throw new Error('Close a review window, then retry recovery of unsaved replies.')
				const observation = new ReviewDocumentObservation(context.root, context.file, () =>
					this.publish(context.profileId),
				)
				await observation.refresh() // Failure is honest shell state, never a new source grant.
				if (!current()) {
					await observation.dispose()
					continue
				}
				await this.createWindow(observation, context.profileId, context.token, current, undefined, context)
			}
		} finally {
			this.opening = false
		}
	}
	private async drainAndRevealFailure(): Promise<void> {
		if ([...this.windows.values()].some(state => state.dirty))
			throw new Error('Save or discard the local review draft before leaving this profile.')
		try {
			await this.drainOwned()
		} catch (error) {
			try {
				await this.showArchiveRecovery()
			} catch {
				throw new Error(
					'Review content still needs saving. Close another review window, then retry switching or quitting to open recovery.',
				)
			}
			throw error
		}
	}
	/** Refuse new effects first; the captured historical save epoch stays valid through the drain. */
	private drainOwned(): Promise<void> {
		if (this.drainOperation) return this.drainOperation
		if ([...this.windows.values()].some(state => state.dirty))
			throw new Error('Save or discard the local review draft before leaving this profile.')
		const acquiredNormal = !this.admissionClosed
		const saveLease = this.saveEpoch
		const profileLease = this.deps.profileId()
		const tokenLease = this.deps.profileToken()
		this.admissionClosed = true
		this.stopping = true
		const admissionLease = ++this.admissionEpoch
		let retired = false
		let lateDirty = false
		let fsFailed = false
		this.drainOperation = (async () => {
			const states = [...this.windows.values()]
			const requests = states.flatMap(state => [...state.active])
			const fileRequests = new Set(states.flatMap(state => [...state.fileFlights]))
			const results = await Promise.allSettled(requests)
			fsFailed = results.some(
				(result, index) => result.status === 'rejected' && fileRequests.has(requests[index] as Promise<unknown>),
			)
			// Await already-started finals without retrying failed writes or waiting
			// for an original agent. This preserves the late-dirty precommit boundary.
			await Promise.all([...this.archives.values()].map(context => context.archive.drain()))
			if ([...this.windows.values()].some(state => state.dirty)) {
				lateDirty = true
				throw new Error('Save or discard the new local review draft before leaving this profile.')
			}
			// No await between the authenticated dirty check and mailbox retirement.
			retired = true
			for (const sessions of this.sessions.values()) sessions.stopOwned()
			await Promise.all([...this.archives.values()].map(context => context.archive.drain()))
			if (
				this.admissionEpoch !== admissionLease ||
				this.saveEpoch !== saveLease ||
				this.deps.profileId() !== profileLease ||
				this.deps.profileToken() !== tokenLease
			)
				throw new Error('The original review lifecycle changed during drain.')
			if (this.hasDirty()) throw new Error('Unsaved review content must be recovered before leaving this profile.')
			this.saveEpoch++
			this.archives.clear()
		})().finally(() => {
			if (
				lateDirty &&
				acquiredNormal &&
				!retired &&
				!fsFailed &&
				this.admissionEpoch === admissionLease &&
				this.saveEpoch === saveLease &&
				this.deps.profileId() === profileLease &&
				this.deps.profileToken() === tokenLease &&
				![...this.archives.values()].some(context => context.archive.guarded())
			)
				this.admissionClosed = false
			this.stopping = false
			this.drainOperation = null
			for (const profileId of this.sessions.keys()) this.publish(profileId)
		})
		return this.drainOperation
	}
	async closeForProfileSwitch(): Promise<void> {
		if ([...this.windows.values()].some(state => state.dirty))
			throw new Error('Review drafts are still saving. Finish saving them before switching profiles.')
		await this.drainAndRevealFailure()
		const states = [...this.windows.values()]
		for (const state of states) {
			state.allowClose = true
			state.window.close()
		}
		await Promise.all(states.map(state => state.observation.dispose()))
		this.admissionClosed = false
	}
	hasDirty(): boolean {
		return (
			[...this.windows.values()].some(state => state.dirty || state.noteSave || state.fileFlights.size > 0) ||
			[...this.archives.values()].some(context => context.archive.guarded())
		)
	}
	busy(): boolean {
		return [...this.sessions.values()].some(sessions => sessions.isBusy())
	}
	async stopOwned(): Promise<void> {
		await this.drainAndRevealFailure()
	}
	requestCloseAll(): void {
		for (const state of this.windows.values()) state.window.close()
	}
}
