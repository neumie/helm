import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { BaseWindow, WebContentsView, clipboard, dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import type { CallerBinding, CallerBindingRecord } from '../../../src/document-review/control-server'
import type { ReviewViewResult } from '../../../src/document-review/protocol'
import {
	failureCause,
	gitRootRefusal,
	isReviewRefusal,
	refuse,
	restartingRefusal,
} from '../../../src/document-review/refusal'
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
import { PNG_PASTEBOARD, copyPngToClipboard } from './image-copy'
import { OWNER_RECORD_TTL_MS, type ReviewOwnerStore } from './owner-store'
import { reviewPrompt } from './request'
import { parseReviewRequest } from './request-admission'
import { type ArchiveHandle, type ArchiveReference, ReviewSessions, type SessionHint } from './sessions'
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
/** Feedback-capable views (bound, unbound review and recovery) share today's bound of eight. */
export const REVIEW_WINDOW_LIMIT = 8
/** Plain `helm open` views have their own soft bound, so plain views never make `helm edit` fail. */
export const PLAIN_WINDOW_LIMIT = 32
/** HEIC conversion time one `view` batch may spend; below the CLI's 30 s deadline for the batch's answer. */
export const VIEW_CONVERT_BUDGET_MS = 24_000
/** The review surface (`--pane`) in the dark and light review themes: painted until a view's first frame. */
const REVIEW_DARK_BACKGROUND = '#141517'
const REVIEW_LIGHT_BACKGROUND = '#faf9f6'
/**
 * One document = one `WebContentsView` (docs/plans/helm-open/spec.md, Per-view access keys). Every access and
 * lifecycle decision uses the view's own `webContents`; the container only shows, focuses, titles and parents
 * dialogs, and a move changes nothing but `container`.
 */
interface ViewState {
	/** A plain `helm open` view: read-only, no caller, no saved state. Binding (`--listen`) clears it. */
	plain: boolean
	recoveryContext: ArchiveFileContext | null
	view: WebContentsView
	/**
	 * The view's own webContents, captured at creation: every sender check uses it. (`view.webContents` reads
	 * undefined once the contents are destroyed.)
	 */
	contents: WebContents
	/** Mutable: the window the view is in now. Never used for access. */
	container: ContainerState
	/** The view's `webContents.id`, its key in `views`; unchanged by a move. */
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
	/** The view's own helm-viewer: file tokens; they move with the view and die with it. */
	tokens: ViewerFileTokens
	viewerSession: ViewerSessionHandle | null
	/** The view's close path ran: `closeDocument` and `onAllClosed` happen once per view. */
	closed: boolean
	/** The review surface colour the view and its window paint before the first frame. */
	background: string
	/** Closed by a quit (S13): its caller keeps the document and gets it back on its next read. */
	quitClose: boolean
}
/** A `BaseWindow` holding views. One view per container until tabs exist (S7b). */
interface ContainerState {
	window: BaseWindow
	/** Strip order. */
	views: ViewState[]
	/** The shown view; the others are hidden but keep their access (live reload, a waiting caller). */
	active: ViewState | null
	/** Helm's own close of the container (last view gone, profile switch): the per-view guard already ran. */
	closing: boolean
	/**
	 * The guarded view that cancelled a close of the whole window (red button, quit). Once that view confirms and
	 * closes, the window close runs again, so the clean views close too and a pending quit can finish.
	 */
	resumeCloseFor: ViewState | null
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
	 * The view's in-memory session with the helm-viewer: handler, network block and deny-all permissions (main.ts
	 * passes the real one). Absent only in the fake-Electron window tests.
	 */
	viewerSession?: ViewerSessionFactory
	/**
	 * Called once per new view, before it loads. main.ts attaches its shortcut dispatcher here: a `BaseWindow` never
	 * fires `browser-window-created`.
	 */
	onViewCreated?(contents: WebContents): void
}
const displayPath = (file: string) => {
	const home = homedir()
	return file.startsWith(`${home}${sep}`) ? `~${file.slice(home.length)}` : file
}

export class DocumentReviewWindows {
	/** Keyed by each view's own `webContents.id`. */
	private readonly windows = new Map<number, ViewState>()
	private readonly containers = new Set<ContainerState>()
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
	/** Where callers are kept across a restart (S13); set by the review host before anything connects. */
	private ownerStore: ReviewOwnerStore | null = null
	/** A quit has started: no new feedback is admitted, and closing windows keep their callers' documents. */
	private suspending = false
	/** True only while requestCloseAll closes containers, so their close handlers know it is the quit. */
	private quitClosing = false
	constructor(private readonly deps: ReviewWindowDependencies) {
		this.activity = new ReviewActivityWatcher(
			() => this.sessions.entries(),
			profileId => this.publish(profileId),
			deps.activitySources,
		)
	}
	private current(state: ViewState): boolean {
		return (
			!state.closed &&
			!state.contents.isDestroyed() &&
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
	private requireWritable(state: ViewState): void {
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
		// This very settlement landed already (a write that finished before a crash or restart, S13): nothing to add.
		// A different one stays a conflict, as before.
		if (
			entry.type === 'settle' &&
			existing.state === entry.state &&
			existing.reply === entry.reply &&
			existing.detail === entry.detail
		)
			return
		await appendReviewArtifact(context.root, context.file, [entry], {
			expectedSourceRevision: reviewRevision(body),
			expectedArchiveRevision: archive.revision,
			current,
		})
		if (!current()) throw new Error('The original review save authority changed before publication.')
		// Metadata is observed by any current window, never by an obsolete renderer event.
		this.publish(context.profileId)
	}
	private require(event: IpcMainInvokeEvent, token: unknown): ViewState {
		const state = this.windows.get(event.sender.id)
		if (!state) throw new Error('This review is no longer current. Reopen it in the active profile.')
		requireReviewAccess(state.contents, event.sender, event.senderFrame, state.token, token, () => this.current(state))
		return state
	}
	private optional(event: IpcMainInvokeEvent, token: unknown): ViewState | null {
		try {
			return this.require(event, token)
		} catch {
			return null
		}
	}
	private async run<T>(
		event: IpcMainInvokeEvent,
		token: unknown,
		effect: (state: ViewState) => Promise<T> | T,
		fileOperation = false,
	): Promise<ReviewResult<T>> {
		let state: ViewState | null = null
		// Once the effect resolved, a failure can no longer mean "not sent": report it as uncertain.
		let effected = false
		try {
			state = this.require(event, token)
			if (state.active.size >= 16) throw new Error('Review is busy. Wait for the current operation to finish.')
			const admitted = Promise.resolve().then(() => {
				this.require(event, token)
				return effect(state as ViewState)
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
		ipcMain.handle('document-review:copy-image', (event, token: unknown, raw: unknown) =>
			this.run(event, token, state => {
				if (!state.plain || state.observation.current().format !== 'image')
					throw new Error('Only a picture window copies an image.')
				copyPngToClipboard(raw, bytes => clipboard.writeBuffer(PNG_PASTEBOARD, bytes))
				return true
			}),
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
					if (this.suspending)
						throw new Error('Helm is restarting. Your feedback was not sent; send it again after Helm starts.')
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
							// The thread's place travels with the feedback, so a reply after a restart settles it.
							const handle: ArchiveHandle = {
								id: archive.id,
								settle: value => archive.settle(value),
								reference: { thread: archive.thread, root: context.root, file: context.file },
							}
							return state.sessions.dispatch(
								owner,
								request.id,
								fingerprint,
								{ request, prompt: delivered, relativePath: document.relativePath },
								handle,
							)
						} catch (error) {
							await discardScreenshots(staged)
							const detail =
								error instanceof Error && error.message.includes('Nothing was sent.')
									? error.message
									: 'The document or original listener changed before dispatch. Nothing was sent.'
							void archive.settle({ state: 'rejected', detail })
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
			const container = state.container
			const resume = container.resumeCloseFor === state
			// Only this view: its siblings stay open, unless it had cancelled a close of the whole window.
			this.closeView(state)
			if (resume && !container.closing && !container.window.isDestroyed() && container.views.length)
				container.window.close()
		})
	}
	/** File → Open document… (⌘O in a document view). The dialog belongs to `parent`'s window. */
	async chooseFileFromMenu(parent?: WebContents): Promise<void> {
		const win = this.deps.mainWindow()
		const owner = parent ? this.windows.get(parent.id) : undefined
		const dialogParent: BaseWindow | null =
			owner && owner.contents === parent && this.current(owner) ? owner.container.window : win
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
			const picked = await dialog.showOpenDialog(dialogParent as BaseWindow, {
				title: 'Open document for review',
				filters: [{ name: 'Markdown, JSX or TSX', extensions: ['md', 'jsx', 'tsx'] }],
				properties: ['openFile'],
			})
			if (!current() || picked.canceled || !picked.filePaths[0]) return
			await this.openFile(picked.filePaths[0], token, current)
		} catch (error) {
			if (current())
				await dialog.showMessageBox(dialogParent as BaseWindow, {
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
	/**
	 * Exact window identity, never a file/name lookup or replacement-window fallback. The one exception is a window
	 * of THIS caller that a quit closed (S13): it comes back, with the same id, before the read waits.
	 */
	async nextForCallerDocument(
		profileId: string,
		sessionId: string,
		owner: string,
		documentId: string,
		timeoutMs: number,
		signal: AbortSignal,
		listener?: string,
	): Promise<ReviewReadResult> {
		const sessions = this.sessionsFor(profileId)
		sessions.get(sessionId, owner)
		if (sessions.isSuspended()) throw restartingRefusal()
		if (signal.aborted) throw new Error('Listening was cancelled.')
		const find = () =>
			[...this.windows.values()].find(state => state.profileId === profileId && state.observation.id === documentId)
		let window = find()
		if (!window) {
			const kept = sessions.restorableDocument(sessionId, owner, documentId)
			if (!kept) return { closed: true, documentId }
			await this.reopenForCaller(profileId, sessionId, owner, documentId, kept, signal)
			window = find()
			if (!window) return { closed: true, documentId }
		}
		if (window.selectedSession !== sessionId || !this.current(window))
			throw new Error('The document window owner or lifecycle changed. Nothing was rerouted.')
		return sessions.next(sessionId, owner, timeoutMs, signal, documentId, listener)
	}
	/** An unscoped read of a caller (legacy `helm review wait`, Pi): its quit-closed windows come back first. */
	async reopenCallerDocuments(profileId: string, sessionId: string, owner: string, signal: AbortSignal): Promise<void> {
		const sessions = this.sessionsFor(profileId)
		for (const kept of sessions.restorableDocuments(sessionId, owner))
			await this.reopenForCaller(profileId, sessionId, owner, kept.documentId, kept, signal).catch(() => {})
	}
	/**
	 * Reopen one quit-closed window of this caller with its old document id (S13): same file, full repository
	 * admission, inactive (never steals focus). Waits for another opening to finish rather than failing the read.
	 */
	private async reopenForCaller(
		profileId: string,
		sessionId: string,
		owner: string,
		documentId: string,
		kept: { root: string; file: string },
		signal: AbortSignal,
	): Promise<void> {
		for (let waited = 0; this.opening; waited += 50) {
			if (signal.aborted || waited > 15000) throw restartingRefusal()
			await new Promise(done => setTimeout(done, 50))
		}
		this.requireAdmission()
		const sessions = this.sessionsFor(profileId)
		const connected = sessions.get(sessionId, owner)
		const token = this.deps.profileToken()
		const epoch = this.admissionEpoch
		const current = () =>
			!this.stopping &&
			!this.suspending &&
			!signal.aborted &&
			epoch === this.admissionEpoch &&
			!connected.retired &&
			this.deps.allowsToken(token) &&
			this.deps.profileId() === profileId
		if (!current()) throw restartingRefusal()
		this.opening = true
		try {
			await this.openFile(kept.file, token, current, sessionId, connected.workspace, documentId)
			const state = [...this.windows.values()].find(
				value => value.profileId === profileId && value.observation.id === documentId,
			)
			if (!state || state.selectedSession !== sessionId)
				throw refuse(`${basename(kept.file)} could not come back for this connection. Run helm edit on it again.`)
			sessions.track(sessionId, owner, documentId, state.observation.root, state.observation.file)
		} finally {
			this.opening = false
		}
	}
	private sessionsFor(profileId: string): ReviewSessions {
		let sessions = this.sessions.get(profileId)
		if (!sessions) {
			const store = this.ownerStore
			sessions = new ReviewSessions(
				() => {
					this.publish(profileId)
					this.activity.kick()
				},
				undefined,
				undefined,
				undefined,
				store ? { profileId, save: (id, record) => store.save(id, record) } : null,
			)
			this.sessions.set(profileId, sessions)
		}
		return sessions
	}
	/** The review host's store for callers kept across a restart (S13). Call before any caller connects. */
	keepCallers(store: ReviewOwnerStore): void {
		this.ownerStore = store
	}
	/**
	 * After a restart: bring back one caller from its kept record, with the same id and owner, in the active profile.
	 * 'later' leaves another profile's caller on disk untouched; null drops it (gone, expired or unusable).
	 */
	async restoreCaller(binding: CallerBindingRecord): Promise<CallerBinding | null | 'later'> {
		const store = this.ownerStore
		if (!store) return null
		const profileId = this.deps.profileId()
		const profileToken = this.deps.profileToken()
		if (binding.profileId !== profileId || !this.deps.allowsToken(profileToken)) return 'later'
		const record = await store.load(binding.id)
		const drop = async () => {
			await store.remove(binding.id).catch(() => {})
			return null
		}
		if (
			!record ||
			record.snapshot.owner !== binding.owner ||
			record.profileId !== binding.profileId ||
			record.workspace !== binding.workspace
		)
			return drop()
		if (Date.now() - record.usedAt > OWNER_RECORD_TTL_MS) {
			// Expired with feedback outstanding: its journal thread says the outcome is unknown, nothing is replayed.
			const reference = record.pending?.archive
			if (reference)
				await this.resumeArchive(profileId, reference)
					.settle({
						state: 'unknown',
						detail: 'Helm restarted and the agent did not come back within a day. Nothing was replayed.',
					})
					.catch(() => false)
			return drop()
		}
		if ((await realpath(record.workspace).catch(() => null)) !== record.workspace) return drop()
		if (this.deps.profileId() !== profileId || !this.deps.allowsToken(profileToken)) return 'later'
		try {
			this.sessionsFor(profileId).restore(record, reference => this.resumeArchive(profileId, reference))
		} catch {
			return drop()
		}
		return { id: binding.id, owner: binding.owner, profileId, profileToken, workspace: record.workspace }
	}
	/** The journal thread of a feedback sent before a restart, ready for its settlement. */
	private resumeArchive(profileId: string, reference: ArchiveReference): ArchiveHandle {
		const context = this.archiveFor(profileId, reference.root, reference.file, this.deps.profileToken())
		const handle = context.archive.resume(reference.thread, (start, entry) =>
			this.appendHistoricalSettlement(context, start, entry),
		)
		return { id: handle.id, settle: value => handle.settle(value), reference: structuredClone(reference) }
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
			// Kept with the caller: a quit or restart brings this window back for it (S13).
			this.sessionsFor(profileId).track(sessionId, owner, document.id, state.observation.root, state.observation.file)
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
		/** Reopening a quit-closed window (S13): the document keeps this id, and the window opens inactive. */
		restoreId?: string,
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
				if (restoreId)
					throw refuse(
						`${basename(file)} is open in Helm again under a new window. Run helm edit on it again; nothing was rerouted.`,
					)
				if (state.plain) {
					// D2: an agent's --listen binds the plain window showing this file, after full feedback admission.
					if (sessionId) await this.bindPlainWindow(state, root, sessionId, current)
					this.reveal(state)
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
				this.reveal(state)
				return
			}
		if (this.feedbackViews() >= REVIEW_WINDOW_LIMIT)
			throw refuse('Eight review windows are open. Close one before opening another.')
		const profileId = this.deps.profileId()
		if (!current()) throw refuse('The active Helm profile changed. Nothing was opened.')
		let drafts = this.drafts.get(profileId)
		if (!drafts) {
			drafts = new ReviewDraftStore(this.deps.profileDir(profileId))
			this.drafts.set(profileId, drafts)
		}
		const observation = new ReviewDocumentObservation(root, file, () => this.publish(profileId), null, restoreId)
		await observation.start()
		if (!current() || observation.current().error) {
			const failure = observation.failure
			await observation.dispose()
			if (!current()) throw refuse('The active Helm profile changed. Nothing was opened.')
			throw isReviewRefusal(failure)
				? failure
				: refuse(`${basename(file)} could not be read for review (${failureCause(failure)}). Nothing was opened.`)
		}
		await this.createWindow(
			observation,
			profileId,
			token,
			current,
			sessionId,
			null,
			restoreId ? { inactive: true } : {},
		)
	}
	/** The caps count views, wherever they are shown. */
	private feedbackViews(): number {
		return [...this.windows.values()].filter(state => !state.plain).length
	}
	private plainViews(): number {
		return [...this.windows.values()].filter(state => state.plain).length
	}
	/**
	 * The focused Helm document window, for the menu and the cockpit's shortcut path: non-null whenever one of
	 * Helm's document containers (or a view's undocked DevTools) has focus, so the caller never falls back to the
	 * cockpit. `contents` is the shown view while it is open, even when it lost its access (a profile switch, a
	 * lapsed recovery): closing still goes through its guard, and `zoom`/`chooseFileFromMenu` check access
	 * themselves. Null contents only for a window whose last view is closing.
	 */
	focused(): { contents: WebContents | null } | null {
		const open = (state: ViewState | null): state is ViewState =>
			!!state && !state.closed && !state.contents.isDestroyed() && this.windows.get(state.senderId) === state
		const focused = BaseWindow.getFocusedWindow()
		if (focused)
			for (const container of this.containers)
				if (container.window === focused) return { contents: open(container.active) ? container.active.contents : null }
		// BaseWindow.getFocusedWindow does not count a view's undocked DevTools; BrowserWindow's did before S7a.
		for (const state of this.windows.values())
			if (open(state) && state.contents.isDevToolsFocused()) return { contents: state.contents }
		return null
	}
	/** Viewer zoom for ⌘= / ⌘- / ⌘0 in a document view; the renderer scales its own reading surface. */
	zoom(contents: WebContents, step: -1 | 0 | 1): void {
		const state = this.windows.get(contents.id)
		if (state && state.contents === contents && this.current(state))
			sendToLiveRenderer(contents, 'document-review:zoom', step)
	}
	/** ⌘W / File → Close in a document view: closes that view only, through its close guard. */
	closeViewOf(contents: WebContents): void {
		const state = this.windows.get(contents.id)
		if (!state || state.contents !== contents) return
		state.quitClose = false
		this.closeView(state)
	}
	/**
	 * D2: replace a plain window's observation with a feedback-mode one for the caller. Runs the full repository
	 * admission (`readReviewFile`: hidden names, hard links, owner and mode) on the window's canonical file first;
	 * a refusal binds nothing and leaves the plain window as it was.
	 */
	private async bindPlainWindow(
		state: ViewState,
		root: string,
		sessionId: string,
		current: () => boolean,
	): Promise<void> {
		if (state.dirty || state.active.size || state.fileFlights.size)
			throw refuse('This document window is busy. Try again when it settles; nothing was rerouted.')
		if (this.feedbackViews() >= REVIEW_WINDOW_LIMIT)
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
		// HEIC conversions of one batch share a budget that ends before the CLI's 30 s answer deadline; a file that
		// cannot finish in it is refused by name (killing its sips child) instead of the whole answer being lost.
		const convert = AbortSignal.any([signal, AbortSignal.timeout(VIEW_CONVERT_BUDGET_MS)])
		try {
			for (const file of files) {
				try {
					if (!current()) throw refuse(`${basename(file)} was not opened: the active Helm profile changed.`)
					result.opened.push({ file, ...(await this.viewFile(file, token, profileId, paths, current, convert)) })
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
		convert?: AbortSignal,
	): Promise<{ documentId: string; format: string }> {
		if (!isAbsolute(raw)) throw refuse(`${basename(raw)} was not opened: helm open sends absolute paths.`)
		const { file, format } = await readViewerFile(raw, paths)
		if (!current()) throw refuse(`${basename(file)} was not opened: the active Helm profile changed.`)
		// One window per canonical file. A wire open never takes focus, not even of an existing window.
		for (const state of this.windows.values())
			if (state.token === token && state.observation.file === file) {
				const shown = state.observation.current().format ?? format
				// The registry's name: a window bound by helm edit on a .tsx shows the canvas; a picture keeps the
				// admission's word (image/svg/heic), as on a first open.
				return {
					documentId: state.observation.id,
					format: shown === 'jsx' ? 'canvas' : shown === 'image' ? format : shown,
				}
			}
		if (this.plainViews() >= PLAIN_WINDOW_LIMIT)
			throw refuse(`${basename(file)} was not opened: ${PLAIN_WINDOW_LIMIT} files are already open. Close one first.`)
		if (!this.drafts.get(profileId)) this.drafts.set(profileId, new ReviewDraftStore(this.deps.profileDir(profileId)))
		const tokens = new ViewerFileTokens()
		const observation = new ReviewDocumentObservation(dirname(file), file, () => this.publish(profileId), {
			paths,
			displayPath: displayPath(file),
			tokens,
		})
		await observation.start({ convert })
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
		if (!current() || (plain ? this.plainViews() >= PLAIN_WINDOW_LIMIT : this.feedbackViews() >= REVIEW_WINDOW_LIMIT)) {
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
		// Every view (plain or feedback) gets its own in-memory session before anything loads in it; the session,
		// its protocol handler and its tokens move with the view and end with it.
		const viewerSession = this.deps.viewerSession ? this.deps.viewerSession(tokens) : null
		// A BaseWindow has no ready-to-show: the view shows once its page loaded, so the window and view paint the
		// review surface colour (the renderer's --pane) until the first frame lands, never the default white.
		const background =
			!plain && drafts.load(drafts.key(root, file, sessionId ?? null)).theme === 'light'
				? REVIEW_LIGHT_BACKGROUND
				: REVIEW_DARK_BACKGROUND
		const view = new WebContentsView({
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
		view.setBackgroundColor(background)
		const contents = view.webContents
		const senderId = contents.id
		const container = this.createContainer(`${observation.current().name} — Helm`, background)
		const state: ViewState = {
			plain,
			recoveryContext,
			view,
			contents,
			container,
			senderId,
			token,
			profileId,
			observation,
			drafts,
			// A plain view never saves review content: it gets an inert archive of its own, never the file's shared
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
			closed: false,
			background,
			quitClose: false,
		}
		this.windows.set(senderId, state)
		this.attach(state, container)
		contents.setWindowOpenHandler(({ url }) => {
			const safe = parseExternalHttpUrl(url)
			if (!state.recoveryContext && this.current(state) && safe) void shell.openExternal(safe)
			return { action: 'deny' }
		})
		contents.on('will-navigate', event => event.preventDefault())
		// No document content creates frames in this slice; any subframe navigation is refused.
		contents.on('will-frame-navigate', event => {
			if (!event.isMainFrame) event.preventDefault()
		})
		contents.on('before-input-event', (event, input) => {
			if (
				input.type === 'keyDown' &&
				input.code === 'KeyW' &&
				(process.platform === 'darwin' ? input.meta : input.control)
			) {
				event.preventDefault()
				state.quitClose = false
				this.closeView(state)
			}
		})
		// Anything that ends the view's webContents runs the view's own close path.
		contents.once('destroyed', () => this.finishView(state))
		this.deps.onViewCreated?.(contents)
		try {
			await contents.loadURL(VIEWER_INDEX_URL)
		} catch {
			state.allowClose = true
			this.finishView(state)
			throw new Error('The review window could not load.')
		}
		if (state.closed) throw new Error('The review window could not load.')
		// A view has no ready-to-show: it is shown once its page loaded. A view that lost its authority while loading
		// closes unseen.
		if (!this.current(state)) {
			state.allowClose = true
			this.finishView(state)
			return
		}
		// A wire `view` never takes focus or activates Helm (spec: No focus stealing).
		this.reveal(state, options.inactive ? 'inactive' : 'show')
	}
	/** A container for views: today's review window chrome, without a page of its own. */
	private createContainer(title: string, backgroundColor: string): ContainerState {
		const window = new BaseWindow({
			backgroundColor,
			width: 1180,
			height: 800,
			minWidth: 640,
			minHeight: 520,
			title,
			show: false,
			titleBarStyle: 'hidden',
			trafficLightPosition: { x: 16, y: 16 },
		})
		const container: ContainerState = { window, views: [], active: null, closing: false, resumeCloseFor: null }
		this.containers.add(container)
		// A BaseWindow neither sizes its views nor hands them keyboard focus.
		const layout = () => this.layout(container)
		window.on('resize', layout)
		window.on('maximize', layout)
		window.on('unmaximize', layout)
		window.on('restore', layout)
		window.on('enter-full-screen', layout)
		window.on('leave-full-screen', layout)
		window.on('focus', () => {
			const active = container.active
			if (active && !active.closed && !active.contents.isDestroyed()) active.contents.focus()
		})
		window.on('close', event => {
			if (container.closing) return
			// Jakub's own close of the window (red button), not the quit's: his close ends the documents for good.
			if (!this.quitClosing) for (const state of container.views) state.quitClose = false
			// One guarded view keeps the whole window open and asks in its own tab; the others stay too.
			const guarded = container.views.find(state => this.guarded(state))
			if (guarded) {
				event.preventDefault()
				container.resumeCloseFor = guarded
				this.select(guarded)
				sendToLiveRenderer(guarded.contents, 'document-review:close-requested')
				return
			}
			container.closing = true
			for (const state of [...container.views]) this.finishView(state)
		})
		window.on('closed', () => {
			// A BaseWindow does not destroy its views' webContents: each remaining view runs its own close path.
			container.closing = true
			for (const state of [...container.views]) this.finishView(state)
			this.containers.delete(container)
		})
		return container
	}
	private layout(container: ContainerState): void {
		if (container.window.isDestroyed()) return
		const { width, height } = container.window.getContentBounds()
		for (const state of container.views) state.view.setBounds({ x: 0, y: 0, width, height })
	}
	/** Shows `state` in its container; the container's other views stay hidden but keep their access. */
	private select(state: ViewState): void {
		const container = state.container
		container.active = state
		for (const other of container.views) other.view.setVisible(other === state)
		this.layout(container)
		if (!container.window.isDestroyed()) container.window.setTitle(`${state.observation.current().name} — Helm`)
	}
	private attach(state: ViewState, container: ContainerState): void {
		state.container = container
		container.views.push(state)
		container.window.contentView.addChildView(state.view)
		this.select(state)
	}
	private detach(state: ViewState): void {
		const container = state.container
		const index = container.views.indexOf(state)
		if (index < 0) return
		container.views.splice(index, 1)
		if (!container.window.isDestroyed()) container.window.contentView.removeChildView(state.view)
		if (container.active !== state) return
		container.active = null
		const next = container.views[Math.min(index, container.views.length - 1)]
		if (next) this.select(next)
	}
	/**
	 * Select the view's tab, then show its window. `focus` for reopen, `openForCaller` and recovery; `show` and
	 * `inactive` for a new view (a wire `view` never takes focus).
	 */
	private reveal(state: ViewState, mode: 'focus' | 'show' | 'inactive' = 'focus'): void {
		if (state.closed) return
		this.select(state)
		const window = state.container.window
		if (window.isDestroyed()) return
		if (mode === 'inactive') {
			window.showInactive()
			return
		}
		window.show()
		if (mode === 'focus') window.focus()
		state.contents.focus()
	}
	/**
	 * Moves a view into the window showing `targetViewId`, or into a new window. Moving is not closing: the view
	 * keeps its webContents, key, viewer session, tokens, document and caller, and a waiting caller gets no
	 * `closed`. S7b's Merge All Windows, drag-out and Move Tab to New Window use it; S7a has no UI for it.
	 */
	moveView(viewId: number, targetViewId?: number): boolean {
		const state = this.windows.get(viewId)
		if (!state || !this.current(state)) return false
		const target = targetViewId === undefined ? null : this.windows.get(targetViewId)
		if (targetViewId !== undefined && (!target || !this.current(target) || target.profileId !== state.profileId))
			return false
		const source = state.container
		if (target?.container === source) return true
		const destination = target
			? target.container
			: this.createContainer(`${state.observation.current().name} — Helm`, state.background)
		this.detach(state)
		this.attach(state, destination)
		if (!source.views.length) this.destroyContainer(source)
		this.reveal(state)
		return true
	}
	/** The main-side close guard (BaseWindow has no cancellable per-view close). */
	private guarded(state: ViewState): boolean {
		return (
			!state.plain &&
			!state.allowClose &&
			(state.dirty || state.noteSave || state.fileFlights.size > 0 || state.archive.guarded())
		)
	}
	/** Close one view: a guarded view asks in its own tab and stays; otherwise only this view closes. */
	private closeView(state: ViewState): boolean {
		if (state.closed) return true
		if (this.guarded(state)) {
			// A close of this view alone replaces an earlier close of its whole window.
			if (state.container.resumeCloseFor === state) state.container.resumeCloseFor = null
			this.select(state)
			sendToLiveRenderer(state.contents, 'document-review:close-requested')
			return false
		}
		this.finishView(state)
		return true
	}
	/** The view's own close path, exactly once: never a container event, never a move. */
	private finishView(state: ViewState): void {
		if (state.closed) return
		state.closed = true
		const container = state.container
		if (container.resumeCloseFor === state) container.resumeCloseFor = null
		this.detach(state)
		this.windows.delete(state.senderId)
		// The view's CURRENT observation: binding a plain view replaces it. A quit's close keeps it for its caller.
		if (state.quitClose || this.suspending) state.sessions.closeDocumentForRestart(state.observation.id)
		else state.sessions.closeDocument(state.observation.id)
		void state.observation.dispose()
		void state.tokens.revokeAll()
		// WebContents.close() ends the page later: its session (network block, helm-viewer: handler) is disposed only
		// once the contents are destroyed, never under a still-live page.
		const viewerSession = state.viewerSession
		if (state.contents.isDestroyed()) viewerSession?.dispose()
		else {
			if (viewerSession) state.contents.once('destroyed', () => viewerSession.dispose())
			state.contents.close()
		}
		const context = state.plain
			? undefined
			: this.archives.get(this.archiveKey(state.profileId, state.observation.root, state.observation.file))
		if (context) this.pruneArchive(context)
		if (!container.views.length && !container.closing) this.destroyContainer(container)
		if (!this.windows.size) this.deps.onAllClosed?.()
	}
	/** Helm's own close of a container whose views already closed (or are closed by its `closed`). */
	private destroyContainer(container: ContainerState): void {
		container.closing = true
		if (!container.window.isDestroyed()) container.window.close()
	}
	private requireSelectedOwner(state: ViewState, id: string, owner: string): void {
		if (
			state.selectedSession !== id ||
			!state.sessions.list(state.observation.root).some(session => session.id === id && session.owner === owner)
		)
			throw new Error('The selected conversation owner changed. No control was dispatched.')
	}
	private snapshot(state: ViewState): ReviewState {
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
					sendToLiveRenderer(state.contents, 'document-review:changed')
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
					// A recovery view never stays hidden behind another tab.
					this.reveal(existing)
					this.publish(context.profileId)
					continue
				}
				if (this.feedbackViews() >= REVIEW_WINDOW_LIMIT)
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
			this.closeView(state)
		}
		for (const container of [...this.containers]) this.destroyContainer(container)
		await Promise.all(states.map(state => state.observation.dispose()))
		// Retired callers are forgotten on disk too before the switch commits: none comes back in a later start.
		await this.ownerStore?.drain()
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
		// Disconnecting is a deliberate end: a suspended quit that could not keep its callers retires them now.
		this.resumeAfterCancelledQuit()
		await this.drainAndRevealFailure()
		await this.ownerStore?.drain()
	}
	/**
	 * Quit or restart (S13): callers are KEPT, not retired. New feedback is refused, sends already admitted finish,
	 * every listener is told Helm is restarting (its CLI waits and asks again), and every caller is written to disk.
	 * Rejects when a caller could not be written; nothing was retired then.
	 */
	async suspendForQuit(): Promise<void> {
		this.suspending = true
		await Promise.allSettled([...this.windows.values()].flatMap(state => [...state.active]))
		await Promise.allSettled([...this.archives.values()].map(context => context.archive.drain()))
		await Promise.all([...this.sessions.values()].map(sessions => sessions.suspend()))
		await this.ownerStore?.drain()
	}
	/** The quit did not happen (Keep editing, a refused close): callers work again, as before. */
	resumeAfterCancelledQuit(): void {
		if (!this.suspending) return
		this.suspending = false
		for (const sessions of this.sessions.values()) sessions.resume()
	}
	isSuspended(): boolean {
		return this.suspending
	}
	/**
	 * Quit: every container closes through its guard; a dirty view keeps its window open and asks. These closes
	 * are the quit's: a caller listening on one is told Helm restarts and gets its window back (S13).
	 */
	requestCloseAll(): void {
		for (const state of this.windows.values()) state.quitClose = true
		this.quitClosing = true
		try {
			for (const container of [...this.containers]) if (!container.window.isDestroyed()) container.window.close()
		} finally {
			this.quitClosing = false
		}
	}
}
