import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { ReviewViewResult } from '../../../src/document-review/protocol'
import { failureCause, gitRootRefusal, isReviewRefusal, refuse } from '../../../src/document-review/refusal'
import { decodeScreenshots, discardScreenshots, stageScreenshots } from '../../../src/document-review/screenshot-files'
import {
	REVIEW_SCREENSHOT_DIRECTORY,
	appendScreenshotPrompt,
	splitScreenshotPayload,
} from '../../../src/document-review/screenshot-format'
import type { StagedScreenshot } from '../../../src/document-review/screenshot-format'
import { parseExternalHttpUrl } from '../external-url'
import { sendToLiveRenderer } from '../renderer-lifecycle'
import type { SessionRegistry } from '../sessions'
import { requireReviewAccess } from './access'
import { type ActivitySources, ReviewActivityWatcher } from './activity-watcher'
import { appendReviewArtifact, parseReviewArtifact } from './canvas-artifact'
import { ReviewArchiveCapacity, ReviewArchivePersistence } from './canvas-persistence'
import { ReviewDocumentObservation, readReviewFile, reviewRevision } from './document'
import { ReviewDraftStore, reviewDraftSchema } from './drafts'
import { reviewPrompt } from './request'
import { parseReviewRequest } from './request-admission'
import { ReviewSessions, type SessionHint } from './sessions'
import { defaultReviewDraft } from './types'
import type {
	CanvasReviewEntry,
	CanvasReviewThread,
	ReviewProvider,
	ReviewReadResult,
	ReviewResult,
	ReviewState,
} from './types'
import { readViewerFile } from './viewer-file'
import type { HelmPrivatePaths } from './viewer-file'
import { VIEWER_INDEX_URL, ViewerFileTokens } from './viewer-protocol'
import type { ViewerSessionFactory, ViewerSessionHandle } from './viewer-session'

const runFile = promisify(execFile)
/** Feedback-capable windows (bound, unbound review and recovery) share today's bound of eight. */
export const REVIEW_WINDOW_LIMIT = 8
/** Plain `helm open` windows have their own soft bound, so plain views never make `helm edit` fail. */
export const PLAIN_WINDOW_LIMIT = 32
interface WindowState {
	/** A plain `helm open` window: read-only, no caller, no saved state. Binding (`--listen`) clears it. */
	plain: boolean
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
	/** The window's own helm-viewer: file tokens; they die with the window. */
	tokens: ViewerFileTokens
	viewerSession: ViewerSessionHandle | null
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
	/** Helm's own private paths, refused by plain viewing (by path and by inode). */
	privatePaths?(): Promise<HelmPrivatePaths>
	onAllClosed?(): void
	/** Test seam: where provider session files are read from (default: the user's Claude/Codex roots). */
	activitySources?: ActivitySources
	/**
	 * The window's in-memory session with the helm-viewer: handler, network block and deny-all permissions (main.ts
	 * passes the real one). Absent only in the fake-Electron window tests.
	 */
	viewerSession?: ViewerSessionFactory
}
const displayPath = (file: string) => {
	const home = homedir()
	return file.startsWith(`${home}${sep}`) ? `~${file.slice(home.length)}` : file
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
	/** Display-only progress from hinted callers' own session files (S12); never trusted beyond deadline renewal. */
	private readonly activity: ReviewActivityWatcher
	constructor(private readonly deps: ReviewWindowDependencies) {
		this.activity = new ReviewActivityWatcher(
			() => this.sessions.entries(),
			profileId => this.publish(profileId),
			deps.activitySources,
		)
	}
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
			throw refuse('Review admission is closed. Recover unsaved replies before leaving this profile.')
	}
	private requireWritable(state: WindowState): void {
		if (state.plain) throw new Error('This window only shows the file. Open it with helm edit to send feedback.')
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
				state => !state.plain && state.profileId === context.profileId && state.observation.file === context.file,
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
		// Once the effect resolved, a failure can no longer mean "not sent": report it as uncertain.
		let effected = false
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
			effected = true
			this.require(event, token)
			return { data }
		} catch (error) {
			try {
				this.require(event, token)
			} catch {
				return {
					error: 'This review is no longer current. Reopen it in the active profile.',
					...(effected ? { uncertain: true as const } : {}),
				}
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
						filters: [{ name: 'Markdown, JSX or TSX', extensions: ['md', 'jsx', 'tsx'] }],
						properties: ['openFile'],
					})
					if (!current()) throw new Error('The profile changed while choosing the file. Open it again.')
					if (result.canceled || !result.filePaths[0]) return { data: false }
					file = result.filePaths[0]
				}
				await this.openFile(file, token as string, current)
				return { data: true }
			} catch (error) {
				return {
					error: isReviewRefusal(error)
						? error.message
						: 'Could not open the document. Choose a visible regular Markdown, JSX or TSX file in a repository you trust.',
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
					// A plain window has no review content to save: Retry only reads the file again.
					if (state.plain) {
						await state.observation.refresh()
						return true
					}
					await state.archive.retry()
					this.require(event, token)
					await state.observation.refresh()
					return true
				},
				true,
			),
		)
		ipcMain.handle('document-review:clear-empty-preferences', (event, token: unknown) =>
			this.run(
				event,
				token,
				state => {
					this.requireWritable(state)
					return { removed: state.drafts.discardEmptyPreferences() }
				},
				true,
			),
		)
		ipcMain.handle('document-review:save', (event, token: unknown, raw: unknown) =>
			this.run(
				event,
				token,
				async state => {
					// Plain viewing keeps no saved state; its appearance choices live only in the open window.
					if (state.plain) return true
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
					const split = splitScreenshotPayload(raw)
					const request = parseReviewRequest(split.request)
					const decoded = decodeScreenshots(split.screenshots)
					if (request.documentId !== state.observation.id || request.sessionId !== state.selectedSession)
						throw new Error('This request no longer belongs to the chosen document and conversation.')
					const fingerprintHash = createHash('sha256').update(JSON.stringify(request))
					for (const shot of decoded) fingerprintHash.update(shot.bytes)
					const fingerprint = fingerprintHash.digest('hex')
					const prior = state.sessions.prior(request.id, fingerprint)
					if (prior) return prior
					if ([...this.sessions.values()].reduce((n, sessions) => n + sessions.admittedCount(), 0) >= 8)
						throw new Error('Eight review turns are already in progress. Wait for a turn to settle.')
					if (state.archive.error()) throw new Error(state.archive.error() as string)
					const owner = state.sessions.reserve(
						request.sessionId,
						request.owner,
						state.observation.root,
						request.documentId,
					)
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
						let staged: StagedScreenshot[] = []
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
							if (decoded.length > 0) {
								const profile = await realpath(this.deps.profileDir(state.profileId))
								this.require(event, token)
								this.requireAdmission()
								if (
									state.selectedSession !== request.sessionId ||
									state.observation.current().revision !== request.revision ||
									owner.retired
								)
									throw new Error('The document or conversation changed before dispatch. Nothing was sent.')
								staged = await stageScreenshots(join(profile, REVIEW_SCREENSHOT_DIRECTORY), decoded)
								this.require(event, token)
								this.requireAdmission()
								if (
									state.selectedSession !== request.sessionId ||
									state.observation.current().revision !== request.revision ||
									owner.retired
								)
									throw new Error('The document or conversation changed before dispatch. Nothing was sent.')
							}
							const delivered = appendScreenshotPrompt(prompt, staged)
							return state.sessions.dispatch(
								owner,
								request.id,
								fingerprint,
								{ request, prompt: delivered, relativePath: document.relativePath },
								archive,
							)
						} catch (error) {
							await discardScreenshots(staged)
							const detail =
								error instanceof Error && error.message.includes('Nothing was sent.')
									? error.message
									: 'The document or original listener changed before dispatch. Nothing was sent.'
							archive.settle({ state: 'rejected', detail })
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
				if (state.plain) throw new Error('This window only shows the file. It has no unsaved reply.')
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
			if (state && !state.plain && !state.recoveryContext && typeof dirty === 'boolean') state.dirty = dirty
		})
		ipcMain.on('document-review:close', (event, token: unknown) => {
			const state = this.optional(event, token)
			if (!state || state.dirty || state.noteSave || state.fileFlights.size > 0 || state.archive.guarded()) return
			state.allowClose = true
			state.window.close()
		})
	}
	/** File → Open document… (⌘O in a review window). `parent` is a review window the dialog belongs to. */
	async chooseFileFromMenu(parent?: BrowserWindow): Promise<void> {
		const win = this.deps.mainWindow()
		const dialogParent = parent && this.ownsWindow(parent) ? parent : win
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
			const picked = await dialog.showOpenDialog(dialogParent as BrowserWindow, {
				title: 'Open document for review',
				filters: [{ name: 'Markdown, JSX or TSX', extensions: ['md', 'jsx', 'tsx'] }],
				properties: ['openFile'],
			})
			if (!current() || picked.canceled || !picked.filePaths[0]) return
			await this.openFile(picked.filePaths[0], token, current)
		} catch (error) {
			if (current())
				await dialog.showMessageBox(dialogParent as BrowserWindow, {
					type: 'warning',
					message: 'Document review unavailable',
					detail: isReviewRefusal(error)
						? `${error.message} No agent was started.`
						: 'Choose a regular Markdown, JSX or TSX file inside a repository you trust. No agent was started.',
				})
		} finally {
			this.opening = false
		}
	}
	/** Only the private native control service calls this; no renderer can enroll a caller. */
	connectCaller(
		provider: ReviewProvider,
		workspace: string,
		name: string,
		transport: 'tool-return' | 'in-process',
		hint?: SessionHint,
	) {
		this.requireAdmission()
		return this.sessionsFor(this.deps.profileId()).connect(provider, workspace, name, transport, hint)
	}
	callerSessions(profileId: string): ReviewSessions {
		return this.sessionsFor(profileId)
	}
	/** Exact window identity, never a file/name lookup or replacement-window fallback. */
	nextForCallerDocument(
		profileId: string,
		sessionId: string,
		owner: string,
		documentId: string,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<ReviewReadResult> {
		const sessions = this.sessionsFor(profileId)
		sessions.get(sessionId, owner)
		if (signal.aborted) return Promise.reject(new Error('Listening was cancelled.'))
		const window = [...this.windows.values()].find(
			state => state.profileId === profileId && state.observation.id === documentId,
		)
		if (!window) return Promise.resolve({ closed: true, documentId })
		if (window.selectedSession !== sessionId || !this.current(window))
			return Promise.reject(new Error('The document window owner or lifecycle changed. Nothing was rerouted.'))
		return sessions.next(sessionId, owner, timeoutMs, signal, documentId)
	}
	private sessionsFor(profileId: string): ReviewSessions {
		let sessions = this.sessions.get(profileId)
		if (!sessions) {
			sessions = new ReviewSessions(() => {
				this.publish(profileId)
				this.activity.kick()
			})
			this.sessions.set(profileId, sessions)
		}
		return sessions
	}
	async openForCaller(file: string, token: string, profileId: string, sessionId: string, owner: string) {
		// Share native/menu admission: concurrent CLI opens must not create duplicate
		// windows or race the eight-window bound before observation.start() settles.
		this.requireAdmission()
		if (this.opening) throw refuse('Another document is opening. Wait before opening this document.')
		const connected = this.sessionsFor(profileId).get(sessionId, owner)
		const epoch = this.admissionEpoch
		const current = () =>
			!this.stopping &&
			epoch === this.admissionEpoch &&
			!connected.retired &&
			this.deps.allowsToken(token) &&
			this.deps.profileId() === profileId
		if (!current()) throw refuse('The active Helm profile changed. Nothing was opened; reconnect explicitly.')
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
		const stat = await lstat(original).catch(() => null)
		if (!current()) throw refuse('The active Helm profile changed. Nothing was opened.')
		if (!stat) throw refuse(`${basename(original)} does not exist.`)
		if (stat.isSymbolicLink()) throw refuse(`${basename(original)} is a symlink. Open the real file.`)
		if (!stat.isFile()) throw refuse(`${basename(original)} is not a regular file.`)
		const file = await realpath(original)
		if (!current()) throw refuse('The active Helm profile changed. Nothing was opened.')
		const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
		for (const key of Object.keys(environment))
			if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') Reflect.deleteProperty(environment, key)
		const result = await runFile('git', ['-C', dirname(file), 'rev-parse', '--show-toplevel'], {
			env: environment,
			timeout: 5000,
			maxBuffer: 8192,
		}).catch(error => {
			throw gitRootRefusal(error, basename(file))
		})
		if (!current()) throw refuse('The active Helm profile changed. Nothing was opened.')
		const root = await realpath(result.stdout.trim())
		if (!current()) throw refuse('The active Helm profile changed. Nothing was opened.')
		if (
			this.admissionClosed &&
			!this.archives.get(this.archiveKey(this.deps.profileId(), root, file))?.archive.guarded()
		)
			throw refuse('Only unsaved review replies can be reopened during recovery.')
		if (expectedRoot && root !== expectedRoot)
			throw refuse(
				`${basename(file)} is in repository ${basename(root)}, outside the connected repository ${basename(expectedRoot)}. Run helm edit from that repository.`,
			)
		for (const state of this.windows.values())
			if (state.token === token && state.observation.file === file) {
				if (state.plain) {
					// D2: an agent's --listen binds the plain window showing this file, after full feedback admission.
					if (sessionId) await this.bindPlainWindow(state, root, sessionId, current)
					state.window.show()
					state.window.focus()
					return
				}
				if (state.recoveryContext && sessionId) throw refuse('Close the recovery window before selecting a new caller.')
				if (sessionId && state.selectedSession !== sessionId) {
					if (state.selectedSession || state.dirty || state.active.size || state.sessions.isBusy())
						throw refuse(
							'This document already has a review owner or unsaved work. Close that window before opening it from another agent; nothing was rerouted.',
						)
					state.selectedSession = sessionId
					this.publish(state.profileId)
				}
				state.window.show()
				state.window.focus()
				return
			}
		if (this.feedbackWindows() >= REVIEW_WINDOW_LIMIT)
			throw refuse('Eight review windows are open. Close one before opening another.')
		const profileId = this.deps.profileId()
		if (!current()) throw refuse('The active Helm profile changed. Nothing was opened.')
		let drafts = this.drafts.get(profileId)
		if (!drafts) {
			drafts = new ReviewDraftStore(this.deps.profileDir(profileId))
			this.drafts.set(profileId, drafts)
		}
		const observation = new ReviewDocumentObservation(root, file, () => this.publish(profileId))
		await observation.start()
		if (!current() || observation.current().error) {
			const failure = observation.failure
			await observation.dispose()
			if (!current()) throw refuse('The active Helm profile changed. Nothing was opened.')
			throw isReviewRefusal(failure)
				? failure
				: refuse(`${basename(file)} could not be read for review (${failureCause(failure)}). Nothing was opened.`)
		}
		await this.createWindow(observation, profileId, token, current, sessionId)
	}
	private feedbackWindows(): number {
		return [...this.windows.values()].filter(state => !state.plain).length
	}
	private plainWindows(): number {
		return [...this.windows.values()].filter(state => state.plain).length
	}
	/** A Helm review or plain viewing window, for the window-aware shortcut dispatcher. */
	ownsWindow(win: BrowserWindow): boolean {
		return [...this.windows.values()].some(state => state.window === win)
	}
	/** Viewer zoom for ⌘= / ⌘- / ⌘0 in a review window; the renderer scales its own reading surface. */
	zoom(win: BrowserWindow, step: -1 | 0 | 1): void {
		const state = [...this.windows.values()].find(value => value.window === win)
		if (state && this.current(state)) sendToLiveRenderer(win.webContents, 'document-review:zoom', step)
	}
	/**
	 * D2: replace a plain window's observation with a feedback-mode one for the caller. Runs the full repository
	 * admission (`readReviewFile`: hidden names, hard links, owner and mode) on the window's canonical file first;
	 * a refusal binds nothing and leaves the plain window as it was.
	 */
	private async bindPlainWindow(
		state: WindowState,
		root: string,
		sessionId: string,
		current: () => boolean,
	): Promise<void> {
		if (state.dirty || state.active.size || state.fileFlights.size)
			throw refuse('This document window is busy. Try again when it settles; nothing was rerouted.')
		if (this.feedbackWindows() >= REVIEW_WINDOW_LIMIT)
			throw refuse('Eight review windows are open. Close one before opening another.')
		const observation = new ReviewDocumentObservation(root, state.observation.file, () => this.publish(state.profileId))
		await observation.start()
		if (!current() || !this.current(state) || !state.plain || observation.current().error) {
			const failure = observation.failure
			await observation.dispose()
			if (!current()) throw refuse('The active Helm profile changed. Nothing was opened.')
			if (!this.current(state) || !state.plain)
				throw refuse('The document window changed while binding. Nothing was rerouted.')
			throw isReviewRefusal(failure)
				? failure
				: refuse(
						`${basename(state.observation.file)} could not be read for review (${failureCause(failure)}). Nothing was opened.`,
					)
		}
		const previous = state.observation
		state.observation = observation
		state.plain = false
		state.selectedSession = sessionId
		state.archive = this.archiveFor(state.profileId, root, observation.file, state.token).archive
		// The plain observation id ends here; nobody can listen on it (plain windows have no caller).
		state.sessions.closeDocument(previous.id)
		void previous.dispose()
		this.publish(state.profileId)
	}
	/**
	 * Plain viewing over the wire (`helm open`): each file read-only in its own window, opened inactive. Shares the
	 * opening gate with native, menu and caller opens; every refusal is per file and names it.
	 */
	async viewFiles(files: string[], signal: AbortSignal): Promise<ReviewViewResult> {
		const paths = await this.deps.privatePaths?.()
		if (!paths) throw refuse('This Helm desktop cannot show files with helm open. Nothing was opened.')
		this.requireAdmission()
		if (this.opening) throw refuse('Another document is opening in Helm. Nothing was opened; try again.')
		const profileId = this.deps.profileId()
		const token = this.deps.profileToken()
		const epoch = this.admissionEpoch
		const current = () =>
			!this.stopping &&
			!signal.aborted &&
			epoch === this.admissionEpoch &&
			this.deps.allowsToken(token) &&
			this.deps.profileId() === profileId
		if (!current())
			throw refuse('No Helm profile is active (Helm is switching profiles or closing). Nothing was opened.')
		this.opening = true
		const result: ReviewViewResult = { opened: [], refused: [] }
		try {
			for (const file of files) {
				try {
					if (!current()) throw refuse(`${basename(file)} was not opened: the active Helm profile changed.`)
					result.opened.push({ file, ...(await this.viewFile(file, token, profileId, paths, current)) })
				} catch (error) {
					result.refused.push({
						file,
						reason: isReviewRefusal(error)
							? error.message.slice(0, 400)
							: `${basename(file)} could not be opened (${failureCause(error)}).`.slice(0, 400),
					})
				}
			}
		} finally {
			this.opening = false
		}
		return result
	}
	private async viewFile(
		raw: string,
		token: string,
		profileId: string,
		paths: HelmPrivatePaths,
		current: () => boolean,
	): Promise<{ documentId: string; format: string }> {
		if (!isAbsolute(raw)) throw refuse(`${basename(raw)} was not opened: helm open sends absolute paths.`)
		const { file, format } = await readViewerFile(raw, paths)
		if (!current()) throw refuse(`${basename(file)} was not opened: the active Helm profile changed.`)
		// One window per canonical file. A wire open never takes focus, not even of an existing window.
		for (const state of this.windows.values())
			if (state.token === token && state.observation.file === file) {
				const shown = state.observation.current().format ?? format
				// The registry's name: a window bound by helm edit on a .tsx shows the canvas.
				return { documentId: state.observation.id, format: shown === 'jsx' ? 'canvas' : shown }
			}
		if (this.plainWindows() >= PLAIN_WINDOW_LIMIT)
			throw refuse(`${basename(file)} was not opened: ${PLAIN_WINDOW_LIMIT} files are already open. Close one first.`)
		if (!this.drafts.get(profileId)) this.drafts.set(profileId, new ReviewDraftStore(this.deps.profileDir(profileId)))
		const tokens = new ViewerFileTokens()
		const observation = new ReviewDocumentObservation(dirname(file), file, () => this.publish(profileId), {
			paths,
			displayPath: displayPath(file),
			tokens,
		})
		await observation.start()
		if (!current() || observation.current().error) {
			const failure = observation.failure
			await observation.dispose()
			await tokens.revokeAll()
			if (!current()) throw refuse(`${basename(file)} was not opened: the active Helm profile changed.`)
			throw isReviewRefusal(failure)
				? failure
				: refuse(`${basename(file)} could not be read (${failureCause(failure)}). Nothing was opened.`)
		}
		await this.createWindow(observation, profileId, token, current, undefined, null, {
			plain: true,
			inactive: true,
			tokens,
		})
		return { documentId: observation.id, format }
	}
	private async createWindow(
		observation: ReviewDocumentObservation,
		profileId: string,
		token: string,
		current: () => boolean,
		sessionId?: string,
		recoveryContext: ArchiveFileContext | null = null,
		options: { plain?: boolean; inactive?: boolean; tokens?: ViewerFileTokens } = {},
	): Promise<void> {
		const plain = options.plain === true
		const tokens = options.tokens ?? new ViewerFileTokens()
		if (
			!current() ||
			(plain ? this.plainWindows() >= PLAIN_WINDOW_LIMIT : this.feedbackWindows() >= REVIEW_WINDOW_LIMIT)
		) {
			await observation.dispose()
			await tokens.revokeAll()
			throw new Error('Close a review window before opening another.')
		}
		const { root, file } = observation
		const sessions = this.sessionsFor(profileId)
		const drafts = this.drafts.get(profileId)
		if (!drafts) {
			await observation.dispose()
			await tokens.revokeAll()
			throw new Error('Review preferences are unavailable.')
		}
		// Every review window (plain or feedback) gets its own in-memory session before anything loads in it.
		const viewerSession = this.deps.viewerSession ? this.deps.viewerSession(tokens) : null
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
				plugins: false,
				webviewTag: false,
				...(viewerSession ? { session: viewerSession.session } : {}),
			},
		})
		const senderId = win.webContents.id
		const state: WindowState = {
			plain,
			recoveryContext,
			window: win,
			senderId,
			token,
			profileId,
			observation,
			drafts,
			// A plain window never saves review content: it gets an inert archive of its own, never the file's shared
			// one, so a retained feedback archive neither blocks its close nor becomes reachable through it.
			archive: plain
				? new ReviewArchivePersistence(() => {}, this.archiveCapacity)
				: (recoveryContext?.archive ?? this.archiveFor(profileId, root, file, token).archive),
			noteSave: false,
			sessions,
			// Persisted preferences are not an authenticated opening caller.
			selectedSession: recoveryContext ? null : (sessionId ?? null),
			dirty: false,
			allowClose: false,
			fileFlights: new Set(),
			active: new Set(),
			tokens,
			viewerSession,
		}
		this.windows.set(win.webContents.id, state)
		win.webContents.setWindowOpenHandler(({ url }) => {
			const safe = parseExternalHttpUrl(url)
			if (!state.recoveryContext && this.current(state) && safe) void shell.openExternal(safe)
			return { action: 'deny' }
		})
		win.webContents.on('will-navigate', event => event.preventDefault())
		// No document content creates frames in this slice; any subframe navigation is refused.
		win.webContents.on('will-frame-navigate', event => {
			if (!event.isMainFrame) event.preventDefault()
		})
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
				!state.plain &&
				(state.dirty || state.noteSave || state.fileFlights.size > 0 || state.archive.guarded()) &&
				!state.allowClose
			) {
				event.preventDefault()
				sendToLiveRenderer(win.webContents, 'document-review:close-requested')
			}
		})
		win.on('closed', () => {
			this.windows.delete(senderId)
			// The window's CURRENT observation: binding a plain window replaces it.
			sessions.closeDocument(state.observation.id)
			void state.observation.dispose()
			void state.tokens.revokeAll()
			state.viewerSession?.dispose()
			const context = state.plain
				? undefined
				: this.archives.get(this.archiveKey(profileId, state.observation.root, state.observation.file))
			if (context) this.pruneArchive(context)
			if (!this.windows.size) this.deps.onAllClosed?.()
		})
		win.once('ready-to-show', () => {
			// A wire `view` never takes focus or activates Helm (spec: No focus stealing).
			if (!this.current(state)) win.close()
			else if (options.inactive) win.showInactive()
			else win.show()
		})
		try {
			await win.loadURL(VIEWER_INDEX_URL)
		} catch {
			win.destroy()
			void tokens.revokeAll()
			viewerSession?.dispose()
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
		if (state.plain)
			return {
				mode: 'plain',
				document: state.observation.current(),
				sessions: [],
				draft: { ...defaultReviewDraft(), sessionId: null, archiveRevision: null },
				archiveError: null,
				archiveFailureId: null,
			}
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
			activity: state.recoveryContext
				? null
				: this.activity.activity(state.profileId, state.selectedSession, state.observation.id),
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
				// A plain window reads through the viewer admission; recovery needs its own feedback-mode window.
				const existing = [...this.windows.values()].find(
					state => !state.plain && state.profileId === context.profileId && state.observation.file === context.file,
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
				if (this.feedbackWindows() >= REVIEW_WINDOW_LIMIT)
					throw new Error('Close a review window, then retry recovery of unsaved replies.')
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
