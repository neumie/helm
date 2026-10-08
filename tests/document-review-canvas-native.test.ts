import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import persistenceModule from '../app/src/document-review/canvas-persistence'
import draftModule from '../app/src/document-review/drafts'
import requestModule from '../app/src/document-review/request'
import admissionModule from '../app/src/document-review/request-admission'
import sessionsModule from '../app/src/document-review/sessions'
import type { DocumentReviewWindows as ReviewWindowsType } from '../app/src/document-review/window'
import { feedbackSchema, sessionSchema } from '../src/document-review/protocol.js'
import type {
	CanvasReviewArchive,
	CanvasReviewEntry,
	ReviewPassage,
	ReviewRequest,
	ReviewResult,
	ReviewState,
} from '../src/document-review/types.js'
const { parseReviewRequest } = admissionModule
const { reviewPrompt, validatePassage } = requestModule
const { reviewDraftSchema } = draftModule
const { ReviewSessions } = sessionsModule
const { ReviewArchivePersistence } = persistenceModule
const revision = 'a'.repeat(64)
const source = '<p id="greeting">Hello</p>'
const canvas = {
	code: 'compiled',
	blocks: [{ id: 'greeting', start: 0, end: source.length }],
	fieldIds: ['email'],
	error: null,
}
const makeRequest = (): ReviewRequest => ({
	id: randomUUID(),
	documentId: randomUUID(),
	sessionId: `review:${randomUUID()}`,
	owner: randomUUID(),
	revision,
	intent: 'discuss',
	instruction: 'Explain this',
	passage: { revision, start: 0, end: source.length, source, quote: 'Hello', kind: 'block', canvasId: 'greeting' },
	canvasFields: [{ id: 'email', value: 'public@example.org' }],
})
const thread = {
	instruction: 'Explain this',
	intent: 'discuss' as const,
	passage: null,
	fields: [],
	provider: 'pi' as const,
	name: 'Original conversation',
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('native strict request and private wire accept bounded canvas evidence only', () => {
	const request = makeRequest()
	assert.deepEqual(parseReviewRequest(request), request)
	assert.equal(feedbackSchema.safeParse({ request, prompt: 'data', relativePath: 'view.tsx' }).success, true)
	for (const fields of [
		[{ id: 'email', value: 'x'.repeat(4001) }],
		Array.from({ length: 17 }, (_, i) => ({ id: `${i}`, value: false })),
		[
			{ id: 'x', value: true },
			{ id: 'x', value: false },
		],
		Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, value: 'x'.repeat(4000) })),
		[{ id: 'x', value: 3 }],
		[{ id: 'x', value: '', secret: true }],
	]) {
		assert.throws(() => parseReviewRequest({ ...request, canvasFields: fields }))
	}
	assert.throws(() => parseReviewRequest({ ...request, passage: { ...request.passage, canvasId: 'x'.repeat(81) } }))
})

test('native passage and fields bind compiler blocks, while Source exact ranges remain valid', () => {
	const request = makeRequest()
	const passage = request.passage
	assert.ok(passage)
	assert.match(reviewPrompt(request, source, 'view.tsx', canvas), /public@example.org/)
	assert.throws(() => reviewPrompt(request, source, 'view.md'), /canvas|Public fields/)
	assert.throws(
		() => reviewPrompt({ ...request, canvasFields: [{ id: 'forged', value: 'x' }] }, source, 'view.tsx', canvas),
		/Public fields/,
	)
	assert.throws(
		() => validatePassage(source, revision, { ...passage, canvasId: 'forged' }, canvas),
		/compiler-attested/,
	)
	assert.throws(() => validatePassage(source, revision, { ...passage, start: 1 }, canvas), /compiler-attested/)
	assert.doesNotThrow(() =>
		validatePassage(
			source,
			revision,
			{ revision, start: 0, end: source.length, source, quote: source, kind: 'exact' },
			canvas,
		),
	)
})

test('private draft schema preserves legacy IDs, explicit archive fence and canvas locator', () => {
	const draft = {
		instruction: '',
		annotations: [
			{ id: 'legacy: saved note', passage: makeRequest().passage, note: '', intent: 'discuss', resolved: false },
		],
		sessionId: null,
		paneWidth: 380,
		theme: 'dark',
		archiveRevision: null,
	}
	assert.deepEqual(reviewDraftSchema.parse(draft), draft)
	assert.throws(() => reviewDraftSchema.parse({ ...draft, archiveRevision: 'forged' }))
})

test('question durability precedes caller dispatch, final save is linked and retries never redispatch', async () => {
	let fail = true
	const entries: CanvasReviewEntry[] = []
	const persistence = new ReviewArchivePersistence(() => {})
	const sessions = new ReviewSessions(() => {})
	const session = sessions.connect('pi', '/approved', 'Original conversation', 'in-process')
	const listening = sessions.next(session.id, session.owner, 1000, new AbortController().signal)
	const owner = sessions.reserve(session.id, session.owner, '/approved')
	const request = { ...makeRequest(), sessionId: session.id, owner: session.owner }
	const archive = await persistence.begin(thread, async entry => {
		if (entry.type === 'settle' && fail) throw new Error('storage refused')
		entries.push(entry)
	})
	assert.equal(entries[0]?.type, 'thread')
	assert.notEqual(archive.id, request.id)
	sessions.dispatch(owner, request.id, 'fingerprint', { request, prompt: 'data', relativePath: 'view.tsx' }, archive)
	assert.equal((await listening)?.request.id, request.id)
	sessions.confirm(session.id, session.owner, request.id)
	sessions.report(session.id, session.owner, request.id, 0, 'working', 'partial')
	assert.equal(entries.length, 1)
	sessions.report(session.id, session.owner, request.id, 1, 'complete', 'final reply')
	await flush()
	assert.ok(persistence.error())
	assert.ok(persistence.failureId())
	assert.equal(persistence.unresolved(), true)
	assert.ok(sessions.list('/approved')[0]?.messages.every(message => message.archiveThreadId === archive.id))
	assert.equal(sessionSchema.safeParse(sessions.list('/approved')[0]).success, true)
	fail = false
	await persistence.retry()
	assert.equal(persistence.unresolved(), false)
	assert.deepEqual(entries[1], { version: 1, type: 'settle', id: archive.id, state: 'complete', reply: 'final reply' })
	assert.equal(sessions.prior(request.id, 'fingerprint')?.outcome, 'dispatched')
	assert.throws(() => sessions.reserve(session.id, session.owner, '/approved'), /not listening/)
})

test('failed question never invokes a caller and does not leave a final-save guard', async () => {
	const persistence = new ReviewArchivePersistence(() => {})
	await assert.rejects(
		persistence.begin(thread, async () => {
			throw new Error('question append failed')
		}),
		/question append failed/,
	)
	assert.equal(persistence.unresolved(), false)
	assert.equal(persistence.failureId(), null)
})

test('exact failure discard clears only that retained reply; stale IDs and active retry refuse', async () => {
	const persistence = new ReviewArchivePersistence(() => {})
	const release: { value?: () => void } = {}
	let retrying = false
	const writer = async (entry: CanvasReviewEntry) => {
		if (entry.type === 'thread') return
		if (retrying)
			await new Promise<void>(resolve => {
				release.value = resolve
			})
		throw new Error('refused')
	}
	const first = await persistence.begin(thread, writer)
	const second = await persistence.begin(thread, writer)
	first.settle({ state: 'complete', reply: 'one' })
	second.settle({ state: 'unknown', detail: 'unconfirmed original effect' })
	await flush()
	const id = persistence.failureId()
	assert.ok(id)
	assert.throws(() => persistence.discard(randomUUID()))
	retrying = true
	const retry = persistence.retry()
	await flush()
	assert.throws(() => persistence.discard(id), /no longer/)
	assert.doesNotThrow(() => first.settle({ state: 'complete', reply: 'different' }))
	release.value?.()
	await assert.rejects(retry)
	persistence.discard(id)
	assert.throws(() => persistence.discard(id))
	assert.ok(persistence.failureId())
	const nextId = persistence.failureId()
	assert.ok(nextId)
	persistence.discard(nextId)
	assert.equal(persistence.unresolved(), false)
})

test('owner disconnect settles exact thread as unknown without re-enrollment or replay', async () => {
	const entries: CanvasReviewEntry[] = []
	const persistence = new ReviewArchivePersistence(() => {})
	const archive = await persistence.begin(thread, async entry => {
		entries.push(entry)
	})
	const sessions = new ReviewSessions(() => {})
	const session = sessions.connect('pi', '/approved', 'original', 'in-process')
	const listening = sessions.next(session.id, session.owner, 1000, new AbortController().signal)
	const owner = sessions.reserve(session.id, session.owner, '/approved')
	const request = { ...makeRequest(), sessionId: session.id, owner: session.owner }
	sessions.dispatch(owner, request.id, 'original', { request, prompt: 'data', relativePath: 'view.tsx' }, archive)
	await listening
	sessions.disconnect(session.id, session.owner)
	await flush()
	assert.equal(entries[1]?.type, 'settle')
	if (entries[1]?.type === 'settle') assert.equal(entries[1].state, 'unknown')
	assert.equal(sessions.prior(request.id, 'original')?.outcome, 'unknown')
	assert.throws(() => sessions.report(session.id, session.owner, request.id, 1, 'complete', 'late'))
	assert.equal(entries.length, 2)
})

test('native archive admission bounds stalled question writes before their first await', async () => {
	const persistence = new ReviewArchivePersistence(() => {})
	const release: { value?: () => void } = {}
	const wait = new Promise<void>(resolve => {
		release.value = resolve
	})
	const admitted = Array.from({ length: 8 }, () => persistence.begin(thread, async () => wait))
	await assert.rejects(
		persistence.begin(thread, async () => {}),
		/review saves are outstanding/,
	)
	release.value?.()
	const handles = await Promise.all(admitted)
	for (const handle of handles) handle.settle({ state: 'rejected', detail: 'known not sent' })
	await flush()
	assert.equal(persistence.unresolved(), false)
})

test('lost original listener after question append remains known not sent, never adopts replacement caller', async () => {
	const entries: CanvasReviewEntry[] = []
	const persistence = new ReviewArchivePersistence(() => {})
	const sessions = new ReviewSessions(() => {})
	const session = sessions.connect('pi', '/approved', 'original', 'in-process')
	const listening = sessions.next(session.id, session.owner, 1000, new AbortController().signal)
	const owner = sessions.reserve(session.id, session.owner, '/approved')
	const archive = await persistence.begin(thread, async entry => {
		entries.push(entry)
	})
	sessions.disconnect(session.id, session.owner)
	assert.equal(await listening, null)
	const replacement = sessions.connect('pi', '/approved', 'replacement', 'in-process')
	const request = { ...makeRequest(), sessionId: session.id, owner: session.owner }
	assert.throws(
		() =>
			sessions.dispatch(owner, request.id, 'original', { request, prompt: 'data', relativePath: 'view.tsx' }, archive),
		/disconnected/,
	)
	archive.settle({ state: 'rejected', detail: 'Nothing was sent.' })
	await flush()
	assert.deepEqual(entries[1], {
		version: 1,
		type: 'settle',
		id: archive.id,
		state: 'rejected',
		detail: 'Nothing was sent.',
	})
	assert.equal(sessions.list('/approved').find(value => value.id === replacement.id)?.messages.length, 0)
	assert.equal(sessions.prior(request.id, 'original'), null)
})

// Optional isolated composition consumes the real peer modules, never substitutes
// artifact/compiler implementations. Integration uses the local assembled files.
const nativeDir = resolve('app/src/document-review')
const artifactSource = process.env.HELM_DOCUMENT_REVIEW_ARTIFACT_SOURCE ?? join(nativeDir, 'canvas-artifact.ts')
const compilerSource = process.env.HELM_DOCUMENT_REVIEW_COMPILER_SOURCE ?? join(nativeDir, 'canvas-compiler.ts')
const compositionAvailable = existsSync(artifactSource) && existsSync(compilerSource)
const runFile = promisify(execFile)
let fixtureBundle: string | null = null
interface FixtureBundlePlugin {
	onResolve(
		options: { filter: RegExp },
		callback: (args: { path: string }) => { path: string; namespace?: string },
	): void
	onLoad(options: { filter: RegExp; namespace: string }, callback: () => { contents: string; loader: string }): void
}
interface NativeFixtureModule {
	DocumentReviewWindows: typeof ReviewWindowsType
	parseReviewArtifact(raw: string, format: 'markdown' | 'jsx'): { body: string; archive: CanvasReviewArchive }
	appendReviewArtifact(
		root: string,
		file: string,
		entries: CanvasReviewEntry[],
		options: { expectedSourceRevision: string; expectedArchiveRevision?: string; current: () => boolean },
	): Promise<{ body: string; archive: CanvasReviewArchive }>
}
type FixtureIpcHandler = (...args: unknown[]) => unknown
let fixtureModule: NativeFixtureModule | null = null
const handlers = new Map<string, FixtureIpcHandler>()
const ipcEvents = new EventEmitter()
const createdWindows: FixtureWindow[] = []
let nextContentsId = 0
class FixtureWindow extends EventEmitter {
	dead = false
	webContents = Object.assign(new EventEmitter(), {
		id: ++nextContentsId,
		mainFrame: {
			dead: false,
			isDestroyed() {
				return this.dead
			},
			send() {},
		},
		isDestroyed: () => this.dead,
		setWindowOpenHandler() {},
	})
	constructor(_options: unknown) {
		super()
		createdWindows.push(this)
	}
	isDestroyed() {
		return this.dead
	}
	show() {}
	focus() {}
	async loadFile(_file: string) {}
	close() {
		let prevented = false
		this.emit('close', {
			preventDefault() {
				prevented = true
			},
		})
		if (prevented) return false
		this.destroy()
		return true
	}
	destroy() {
		if (this.dead) return
		this.dead = true
		this.webContents.mainFrame.dead = true
		this.emit('closed')
	}
	reloadFrame() {
		this.webContents.mainFrame.dead = true
		this.webContents.mainFrame = {
			dead: false,
			isDestroyed() {
				return this.dead
			},
			send() {},
		}
	}
}
async function loadNativeFixture() {
	if (fixtureModule) return fixtureModule
	const temp = await mkdtemp('/tmp/hr-cn-bundle-')
	fixtureBundle = temp
	const electron = {
		BrowserWindow: FixtureWindow,
		ipcMain: {
			handle: (channel: string, handler: FixtureIpcHandler) => handlers.set(channel, handler),
			on: (channel: string, handler: FixtureIpcHandler) => ipcEvents.on(channel, handler),
		},
		dialog: {},
		shell: {},
	}
	Object.defineProperty(globalThis, '__helmNativeReviewElectron', { value: electron, configurable: true })
	const esbuild = createRequire(resolve('app/package.json'))('esbuild')
	await esbuild.build({
		stdin: {
			contents:
				"export { DocumentReviewWindows } from './window'; export { appendReviewArtifact, parseReviewArtifact } from './canvas-artifact';",
			resolveDir: nativeDir,
			sourcefile: 'native-correction-fixture.ts',
			loader: 'ts',
		},
		outfile: join(temp, 'native.cjs'),
		bundle: true,
		platform: 'node',
		format: 'cjs',
		plugins: [
			{
				name: 'real-peers-and-isolated-electron',
				setup(build: FixtureBundlePlugin) {
					build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'native-electron-effect' }))
					build.onLoad({ filter: /.*/, namespace: 'native-electron-effect' }, () => ({
						contents: 'module.exports = globalThis.__helmNativeReviewElectron;',
						loader: 'js',
					}))
					build.onResolve({ filter: /^\.\/canvas-(artifact|compiler)$/ }, (args: { path: string }) => ({
						path: args.path === './canvas-artifact' ? artifactSource : compilerSource,
					}))
				},
			},
		],
	})
	const loaded = createRequire(import.meta.url)(join(temp, 'native.cjs')) as NativeFixtureModule
	fixtureModule = loaded
	return loaded
}
after(async () => {
	for (const window of createdWindows) window.destroy()
	if (fixtureBundle) await rm(fixtureBundle, { recursive: true, force: true })
	Reflect.deleteProperty(globalThis, '__helmNativeReviewElectron')
})
async function nativeFixture(format: 'md' | 'tsx' = 'md') {
	const module = await loadNativeFixture()
	handlers.clear()
	ipcEvents.removeAllListeners()
	const root = await realpath(await mkdtemp('/tmp/hr-cn-files-'))
	await runFile('git', ['init', '-q', root])
	const profileDir = join(root, '.private')
	await mkdir(profileDir, { mode: 0o700 })
	const file = join(root, `review.${format}`)
	const body =
		format === 'md'
			? '\uFEFF# Original\r\n\r\nRead this paragraph.\r\n'
			: 'export default function Review() { return <p id="greeting">Original</p> }\n'
	await writeFile(file, body, { mode: 0o600 })
	let rendererAdmission = true
	const manager = new module.DocumentReviewWindows({
		distDir: '/fixture-dist',
		profileToken: () => 'current',
		allowsToken: (token: unknown) => rendererAdmission && token === 'current',
		profileId: () => 'profile',
		profileDir: () => profileDir,
		registry: () => {
			throw new Error('This caller fixture has no terminal registry.')
		},
		mainWindow: () => null,
		planArtifact: () => null,
	})
	manager.registerIpc()
	const session = manager.connectCaller('pi', root, 'Original conversation', 'in-process')
	const sessions = manager.callerSessions('profile')
	const reopen = async () => {
		await manager.openFile(file, 'current', () => rendererAdmission, undefined, root)
		return createdWindows.at(-1) as FixtureWindow
	}
	let window = await reopen()
	const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame })
	const invoke = async <T = boolean>(channel: string, ...args: unknown[]): Promise<ReviewResult<T>> => {
		const handler = handlers.get(`document-review:${channel}`)
		assert.ok(handler)
		return (await handler(event(), 'current', ...args)) as ReviewResult<T>
	}
	await invoke('select', session.id)
	const snapshot = async () => {
		const result = await invoke<ReviewState>('load')
		assert.ok(result.data)
		return result.data
	}
	const read = async () =>
		module.parseReviewArtifact(await readFile(file, 'utf8'), format === 'md' ? 'markdown' : 'jsx')
	const send = async (intent: 'discuss' | 'change' = 'change') => {
		const state = await snapshot()
		let passage: ReviewPassage | null = null
		if (format === 'tsx') {
			const block = state.document.canvas?.blocks[0]
			assert.ok(block)
			passage = {
				revision: state.document.revision,
				start: block.start,
				end: block.end,
				source: state.document.text.slice(block.start, block.end),
				quote: 'Original',
				kind: 'block',
				canvasId: 'greeting',
			}
		}
		const request: ReviewRequest = {
			id: randomUUID(),
			documentId: state.document.id,
			sessionId: session.id,
			owner: session.owner,
			revision: state.document.revision,
			intent,
			instruction: 'Explain or improve this source',
			passage,
		}
		const listener = sessions.next(session.id, session.owner, 10000, new AbortController().signal)
		const result = await invoke('send', request)
		assert.ok(result.data, result.error)
		const feedback = await listener
		assert.ok(feedback)
		assert.equal(feedback.request.id, request.id)
		sessions.confirm(session.id, session.owner, request.id)
		return { request, feedback }
	}
	return {
		module,
		manager,
		sessions,
		session,
		root,
		file,
		body,
		read,
		invoke,
		snapshot,
		send,
		window: () => window,
		useLatestWindow: () => {
			window = createdWindows.at(-1) as FixtureWindow
			return window
		},
		setRendererAdmission: (value: boolean) => {
			rendererAdmission = value
		},
		reopen: async () => {
			window = await reopen()
			return window
		},
		close: async () => {
			for (const value of createdWindows) value.destroy()
			try {
				await manager.stopOwned()
			} catch {
				/* Failed-save fixtures deliberately retain a recovery guard until teardown. */
			}
			for (const value of createdWindows) value.destroy()
			await rm(root, { recursive: true, force: true })
		},
	}
}
async function archiveSettled(f: Awaited<ReturnType<typeof nativeFixture>>, state: string) {
	for (let attempts = 0; attempts < 300; attempts++) {
		if ((await f.read()).archive.threads[0]?.state === state && !f.manager.hasDirty()) return
		await new Promise(resolve => setTimeout(resolve, 5))
	}
	throw new Error(`Expected archived ${state}`)
}

test(
	'native correction: real JSX edits preserve journal and settle after renderer reload/clean close',
	{ skip: !compositionAvailable },
	async () => {
		const f = await nativeFixture('tsx')
		try {
			const { request, feedback } = await f.send()
			assert.match(feedback.prompt, /preserve the trailing helm-review:v1 journal exactly/)
			const raw = await readFile(f.file, 'utf8')
			const original = await f.read()
			f.window().reloadFrame() // the dispatch's original IpcMainInvokeEvent is obsolete
			assert.equal(f.window().close(), true) // pending original caller is not a dirty editor
			assert.equal(f.manager.hasDirty(), false)
			const replacement = join(f.root, 'replacement.tsx')
			await writeFile(replacement, raw.replace('>Original<', '>Changed<'), { mode: 0o600 })
			await rename(replacement, f.file) // ordinary atomic editor saves may replace inode
			f.sessions.report(f.session.id, f.session.owner, request.id, 0, 'complete', 'Changed the source.')
			await archiveSettled(f, 'complete')
			const saved = await f.read()
			assert.match(saved.body, />Changed</)
			assert.equal(saved.archive.threads[0].id, original.archive.threads[0].id)
			assert.equal(saved.archive.threads[0].passage.revision, request.revision)
			await f.reopen()
			assert.notEqual(saved.archive.threads[0].passage.revision, (await f.snapshot()).document.revision)
			assert.equal(saved.archive.threads[0].reply, 'Changed the source.')
			assert.equal((await f.snapshot()).archiveError, null)
		} finally {
			await f.close()
		}
	},
)

test(
	'native correction: missing or replaced immutable question fails closed and reopens exact recovery',
	{ skip: !compositionAvailable },
	async () => {
		const f = await nativeFixture()
		try {
			const { request } = await f.send()
			const preserved = await readFile(f.file, 'utf8')
			const { archive } = await f.read()
			assert.equal(f.window().close(), true)
			await writeFile(f.file, f.body, { mode: 0o600 }) // agent lost the original journal
			f.sessions.report(f.session.id, f.session.owner, request.id, 0, 'complete', 'Final answer')
			await new Promise(resolve => setTimeout(resolve, 40))
			assert.equal(f.manager.hasDirty(), true)
			await f.reopen()
			for (let attempts = 0; !(await f.snapshot()).archiveFailureId && attempts < 300; attempts++)
				await new Promise(resolve => setTimeout(resolve, 5))
			let state = await f.snapshot()
			assert.ok(state.archiveError)
			const failureId = state.archiveFailureId
			assert.ok(failureId)
			assert.equal(f.window().close(), false)
			const forged = { ...archive.threads[0], instruction: 'Replacement question' }
			await f.module.appendReviewArtifact(f.root, f.file, [{ version: 1, type: 'thread', thread: forged }], {
				expectedSourceRevision: revisionOf(f.body),
				current: () => true,
			})
			assert.ok((await f.invoke('retry')).error)
			assert.equal((await f.read()).archive.threads[0].instruction, 'Replacement question')
			await writeFile(f.file, preserved, { mode: 0o600 })
			assert.equal((await f.invoke('retry')).data, true)
			await archiveSettled(f, 'complete')
			state = await f.snapshot()
			assert.equal(state.archiveFailureId, null)
			assert.ok((await f.invoke('discard-archive', failureId)).error)
			assert.equal(f.sessions.list(f.root)[0].messages.filter(message => message.role === 'user').length, 1)
		} finally {
			await f.close()
		}
	},
)

function revisionOf(text: string) {
	return createRequire(import.meta.url)('node:crypto')
		.createHash('sha256')
		.update(text)
		.digest('hex')
}

test(
	'native correction: retryDocument never retries failed annotation CAS or preference migration',
	{ skip: !compositionAvailable },
	async () => {
		const f = await nativeFixture()
		try {
			const initial = await f.snapshot()
			const local = {
				id: 'legacy-note',
				passage: {
					revision: initial.document.revision,
					start: 0,
					end: 1,
					source: f.body.slice(0, 1),
					quote: 'Original',
					kind: 'exact',
				},
				note: 'Mine',
				intent: 'discuss',
				resolved: false,
			}
			await f.module.appendReviewArtifact(
				f.root,
				f.file,
				[{ version: 1, type: 'annotations', annotations: [{ ...local, id: 'concurrent', note: 'Newer operator' }] }],
				{ expectedSourceRevision: initial.document.revision, current: () => true },
			)
			const before = await readFile(f.file, 'utf8')
			const staleSave = { ...initial.draft, annotations: [local], archiveRevision: null }
			assert.ok((await f.invoke('save', staleSave)).error)
			assert.equal((await f.invoke('retry')).data, true)
			assert.equal(await readFile(f.file, 'utf8'), before)
			assert.equal((await f.read()).archive.annotations[0].id, 'concurrent')
			const { archiveRevision: _fence, ...preference } = staleSave
			assert.equal((await f.invoke('save', { ...preference, instruction: 'Private draft' })).data, true)
			assert.equal(await readFile(f.file, 'utf8'), before)
			assert.equal(f.manager.hasDirty(), false)
			// A failure clears native note admission: an explicit fresh operator mutation is possible.
			const refreshed = await f.snapshot()
			assert.equal((await f.invoke('save', { ...refreshed.draft, annotations: [local] })).data, true)
			assert.equal((await f.read()).archive.annotations[0].id, 'legacy-note')
		} finally {
			await f.close()
		}
	},
)

test(
	'native correction: profile/quit drain retires original mailboxes and persists unknown before revoking epoch',
	{ skip: !compositionAvailable },
	async () => {
		for (const quit of [false, true]) {
			const f = await nativeFixture()
			try {
				const { request } = await f.send('discuss')
				assert.equal(f.window().close(), true)
				f.setRendererAdmission(false) // profile coordinator already closed renderer IPC admission
				const drain = quit ? f.manager.stopOwned() : f.manager.closeForProfileSwitch()
				assert.throws(() => f.manager.connectCaller('pi', f.root, 'New', 'in-process'), /admission is closed/)
				await drain
				assert.equal((await f.read()).archive.threads[0].state, 'unknown')
				assert.equal(f.manager.hasDirty(), false)
				assert.throws(
					() => f.sessions.report(f.session.id, f.session.owner, request.id, 0, 'complete', 'late'),
					/unavailable/,
				)
			} finally {
				await f.close()
			}
		}
	},
)

test(
	'native correction: failed lifecycle drain keeps main-owned closed-file guards and recovery-only access',
	{ skip: !compositionAvailable },
	async () => {
		const f = await nativeFixture()
		try {
			const { request } = await f.send()
			const preserved = await readFile(f.file, 'utf8')
			assert.equal(f.window().close(), true)
			await writeFile(f.file, f.body, { mode: 0o600 })
			await assert.rejects(f.manager.stopOwned(), /not saved/)
			assert.equal(f.manager.hasDirty(), true)
			assert.throws(() => f.manager.connectCaller('pi', f.root, 'new', 'in-process'), /admission is closed/)
			await f.reopen()
			const state = await f.snapshot()
			assert.ok(state.archiveFailureId)
			assert.ok((await f.invoke('send', { ...request, id: randomUUID() })).error)
			assert.equal(f.window().close(), false)
			assert.ok((await f.invoke('discard-archive', randomUUID())).error)
			await writeFile(f.file, preserved, { mode: 0o600 })
			assert.equal((await f.invoke('retry')).data, true)
			assert.equal((await f.read()).archive.threads[0].state, 'unknown')
			await f.manager.stopOwned()
			assert.equal(f.manager.hasDirty(), false)
		} finally {
			await f.close()
		}
	},
)

test(
	'native correction: dirty preflight preserves original caller and editor admission; actual save flight drains',
	{ skip: !compositionAvailable },
	async () => {
		const f = await nativeFixture()
		try {
			const listenerAbort = new AbortController()
			const listener = f.sessions.next(f.session.id, f.session.owner, 10000, listenerAbort.signal)
			const event = { sender: f.window().webContents, senderFrame: f.window().webContents.mainFrame }
			ipcEvents.emit('document-review:dirty', event, 'current', true)
			await assert.rejects(f.manager.stopOwned(), /local review draft/)
			assert.equal(f.sessions.list(f.root)[0]?.listening, true)
			assert.equal(
				(await f.invoke('save', { ...(await f.snapshot()).draft, archiveRevision: undefined })).error !== undefined,
				true,
			)
			const { archiveRevision: _tag, ...privateDraft } = (await f.snapshot()).draft
			assert.equal((await f.invoke('save', { ...privateDraft, instruction: 'Still editable' })).data, true)
			ipcEvents.emit('document-review:dirty', event, 'current', false)
			assert.equal(f.sessions.list(f.root)[0]?.listening, true)
			listenerAbort.abort()
			await assert.rejects(listener)
			// A genuine admitted annotation FS operation guards ordinary close and is
			// awaited before the lifecycle epoch is revoked, without filesystem mocks.
			const draft = (await f.snapshot()).draft
			const save = f.invoke('save', { ...draft, annotations: [] })
			await Promise.resolve()
			assert.equal(f.window().close(), false)
			const drain = f.manager.stopOwned()
			assert.throws(() => f.manager.connectCaller('pi', f.root, 'new', 'in-process'), /admission is closed/)
			assert.equal((await save).data, true)
			await drain
			assert.equal(f.manager.hasDirty(), false)
			assert.equal((await f.read()).archive.annotations.length, 0)
		} finally {
			await f.close()
		}
	},
)

test(
	'native correction: exact discard after failed drain changes no file, owner or command evidence',
	{ skip: !compositionAvailable },
	async () => {
		const f = await nativeFixture()
		try {
			const { request } = await f.send()
			assert.equal(f.window().close(), true)
			await writeFile(f.file, f.body, { mode: 0o600 })
			await assert.rejects(f.manager.stopOwned())
			await f.reopen()
			const state = await f.snapshot()
			assert.ok(state.archiveFailureId)
			const raw = await readFile(f.file, 'utf8')
			const prior = f.sessions.receipt(request.id)
			assert.equal((await f.invoke('discard-archive', state.archiveFailureId)).data, true)
			assert.equal(await readFile(f.file, 'utf8'), raw)
			assert.deepEqual(f.sessions.receipt(request.id), prior)
			assert.equal(f.manager.hasDirty(), false)
			assert.equal(f.window().close(), true)
			await f.manager.stopOwned()
		} finally {
			await f.close()
		}
	},
)

test(
	'native correction: eight failed historical files share the global bound before any ninth question write',
	{ skip: !compositionAvailable },
	async () => {
		const f = await nativeFixture()
		try {
			for (let index = 0; index < 8; index++) {
				const file = index === 0 ? f.file : join(f.root, `review-${index}.md`)
				if (index > 0) {
					await writeFile(file, f.body, { mode: 0o600 })
					await f.manager.openFile(file, 'current', () => true, undefined, f.root)
				}
				const window = createdWindows.at(-1) as FixtureWindow
				const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
				const invoke = async <T>(channel: string, ...args: unknown[]) =>
					(await handlers.get(`document-review:${channel}`)?.(event, 'current', ...args)) as ReviewResult<T>
				const owner = index === 0 ? f.session : f.manager.connectCaller('pi', f.root, `Original ${index}`, 'in-process')
				assert.equal((await invoke('select', owner.id)).data !== undefined, true)
				const snapshot = await invoke<ReviewState>('load')
				assert.ok(snapshot.data)
				const request: ReviewRequest = {
					id: randomUUID(),
					documentId: snapshot.data.document.id,
					sessionId: owner.id,
					owner: owner.owner,
					revision: snapshot.data.document.revision,
					intent: 'discuss',
					instruction: 'Explain',
					passage: null,
				}
				const waiting = f.sessions.next(owner.id, owner.owner, 10000, new AbortController().signal)
				assert.ok((await invoke('send', request)).data)
				await waiting
				f.sessions.confirm(owner.id, owner.owner, request.id)
				assert.equal(window.close(), true)
				await writeFile(file, f.body, { mode: 0o600 })
				f.sessions.report(owner.id, owner.owner, request.id, 0, 'complete', 'Reply retained')
			}
			const ninth = join(f.root, 'review-nine.md')
			await writeFile(ninth, f.body, { mode: 0o600 })
			await f.manager.openFile(ninth, 'current', () => true, undefined, f.root)
			const window = createdWindows.at(-1) as FixtureWindow
			const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
			const invoke = async <T>(channel: string, ...args: unknown[]) =>
				(await handlers.get(`document-review:${channel}`)?.(event, 'current', ...args)) as ReviewResult<T>
			const owner = f.manager.connectCaller('pi', f.root, 'Ninth original', 'in-process')
			await invoke('select', owner.id)
			const snapshot = await invoke<ReviewState>('load')
			assert.ok(snapshot.data)
			const abort = new AbortController()
			const waiting = f.sessions.next(owner.id, owner.owner, 10000, abort.signal)
			const result = await invoke('send', {
				id: randomUUID(),
				documentId: snapshot.data.document.id,
				sessionId: owner.id,
				owner: owner.owner,
				revision: snapshot.data.document.revision,
				intent: 'discuss',
				instruction: 'Ninth question',
				passage: null,
			})
			assert.match(result.error ?? '', /Eight review saves/)
			assert.equal(await readFile(ninth, 'utf8'), f.body)
			abort.abort()
			await assert.rejects(waiting)
		} finally {
			await f.close()
		}
	},
)

test(
	'native correction: changed source refuses both pre-dispatch question and explicit annotation CAS',
	{ skip: !compositionAvailable },
	async () => {
		const f = await nativeFixture()
		try {
			const original = await f.snapshot()
			const changed = f.body.replace('Original', 'External change')
			await writeFile(f.file, changed, { mode: 0o600 })
			assert.ok((await f.invoke('save', { ...original.draft, annotations: [] })).error)
			const abort = new AbortController()
			const waiting = f.sessions.next(f.session.id, f.session.owner, 10000, abort.signal)
			const result = await f.invoke('send', {
				id: randomUUID(),
				documentId: original.document.id,
				sessionId: f.session.id,
				owner: f.session.owner,
				revision: original.document.revision,
				intent: 'change',
				instruction: 'Never admit against changed source',
				passage: null,
			})
			assert.match(result.error ?? '', /document changed/)
			assert.equal(await readFile(f.file, 'utf8'), changed)
			assert.equal((await f.read()).archive.threads.length, 0)
			assert.equal(f.sessions.list(f.root)[0]?.messages.length, 0)
			abort.abort()
			await assert.rejects(waiting)
		} finally {
			await f.close()
		}
	},
)

test(
	'native correction: conflicting terminal evidence remains unchanged and requires exact failure discard',
	{ skip: !compositionAvailable },
	async () => {
		const f = await nativeFixture()
		try {
			const { request } = await f.send()
			const { body, archive } = await f.read()
			await f.module.appendReviewArtifact(
				f.root,
				f.file,
				[
					{
						version: 1,
						type: 'settle',
						id: archive.threads[0].id,
						state: 'complete',
						reply: 'Other terminal evidence',
					},
				],
				{ expectedSourceRevision: revisionOf(body), current: () => true },
			)
			const exact = await readFile(f.file, 'utf8')
			f.sessions.report(f.session.id, f.session.owner, request.id, 0, 'complete', 'Validated original reply')
			let state = await f.snapshot()
			for (let attempts = 0; !state.archiveFailureId && attempts < 300; attempts++) {
				await new Promise(resolve => setTimeout(resolve, 5))
				state = await f.snapshot()
			}
			assert.ok(state.archiveFailureId)
			assert.ok((await f.invoke('retry')).error)
			assert.equal(await readFile(f.file, 'utf8'), exact)
			assert.equal((await f.invoke('discard-archive', state.archiveFailureId)).data, true)
			assert.equal(await readFile(f.file, 'utf8'), exact)
			assert.equal(f.manager.hasDirty(), false)
		} finally {
			await f.close()
		}
	},
)

test(
	'native correction: deleted/malformed closed files reveal authenticated recovery-only shells',
	{ skip: !compositionAvailable },
	async () => {
		for (const unavailable of ['deleted', 'malformed']) {
			const f = await nativeFixture()
			try {
				await f.send()
				const preserved = await readFile(f.file, 'utf8')
				assert.equal(f.window().close(), true)
				if (unavailable === 'deleted') await rm(f.file)
				else await writeFile(f.file, `${f.body}\n<!-- helm-review:v1 not-valid-record -->`, { mode: 0o600 })
				// Profile and quit drains both reveal the exact retained failed context,
				// without lstat/realpath success or an obsolete renderer frame/event.
				f.setRendererAdmission(false)
				await assert.rejects(unavailable === 'deleted' ? f.manager.stopOwned() : f.manager.closeForProfileSwitch())
				const recovery = f.useLatestWindow()
				assert.equal(recovery.isDestroyed(), false)
				const state = await f.snapshot()
				assert.ok(state.document.error)
				assert.equal(state.document.text, '')
				assert.equal(state.document.revision, '')
				assert.equal(state.document.canvas, undefined)
				assert.equal(state.sessions.length, 0)
				assert.ok(state.archiveFailureId)
				assert.ok((await f.invoke('retry')).error)
				for (const operation of ['save', 'select', 'send', 'acknowledge', 'interrupt', 'receipt'])
					assert.ok((await f.invoke(operation, state.draft)).error, operation)
				assert.equal(recovery.close(), false)
				const foreign = new FixtureWindow({})
				const discard = handlers.get('document-review:discard-archive')
				assert.ok(discard)
				const foreignResult = (await discard(
					{ sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame },
					'current',
					state.archiveFailureId,
				)) as ReviewResult<boolean>
				assert.ok(foreignResult.error)
				assert.ok((await f.invoke('discard-archive', randomUUID())).error)
				assert.equal((await f.snapshot()).archiveFailureId, state.archiveFailureId)
				if (unavailable === 'deleted') {
					assert.equal((await f.invoke('discard-archive', state.archiveFailureId)).data, true)
					assert.equal(existsSync(f.file), false) // no recreation or repair
				} else {
					// Deliberate restoration is operator-owned; retry still matches the
					// captured immutable start before saving its original unknown report.
					await writeFile(f.file, preserved, { mode: 0o600 })
					assert.equal((await f.invoke('retry')).data, true)
					assert.equal((await f.read()).archive.threads[0].state, 'unknown')
				}
				assert.equal(f.manager.hasDirty(), false)
				assert.equal(recovery.close(), true)
				await f.manager.stopOwned()
				const count = createdWindows.length
				await f.manager.showArchiveRecovery()
				assert.equal(createdWindows.length, count) // retired/missing contexts cannot reopen authority
			} finally {
				await f.close()
			}
		}
	},
)

test(
	'native correction: lease-owned late dirty restores only its own clean normal admission',
	{ skip: !compositionAvailable },
	async () => {
		for (const staleLease of [false, true]) {
			const f = await nativeFixture()
			try {
				const internals = f.manager as unknown as {
					windows: Map<number, { observation: { refresh(): Promise<void> } }>
					admissionEpoch: number
				}
				const state = internals.windows.get(f.window().webContents.id)
				assert.ok(state)
				const originalRefresh = state.observation.refresh.bind(state.observation)
				let release: () => void = () => {}
				let started: () => void = () => {}
				const heldPublication = new Promise<void>(resolve => {
					release = resolve
				})
				const actualReadDone = new Promise<void>(resolve => {
					started = resolve
				})
				// Hold the native admission/publication seam after its REAL descriptor
				// read, not a filesystem mock or a replacement artifact implementation.
				state.observation.refresh = async () => {
					await originalRefresh()
					started()
					await heldPublication
				}
				const listening = f.sessions.next(f.session.id, f.session.owner, 10000, new AbortController().signal)
				const refresh = f.invoke('retry')
				await actualReadDone
				const drain = f.manager.stopOwned()
				assert.throws(() => f.manager.connectCaller('pi', f.root, 'During drain', 'in-process'), /admission is closed/)
				if (staleLease) internals.admissionEpoch++ // isolated admission supersession
				const event = { sender: f.window().webContents, senderFrame: f.window().webContents.mainFrame }
				ipcEvents.emit('document-review:dirty', event, 'current', true)
				release()
				assert.equal((await refresh).data, true)
				await assert.rejects(drain, /local review draft/)
				state.observation.refresh = originalRefresh
				assert.equal(f.sessions.list(f.root)[0]?.listening, true)
				assert.equal((await f.read()).archive.threads.length, 0)
				const { archiveRevision: _fence, ...privateDraft } = (await f.snapshot()).draft
				const saved = await f.invoke('save', { ...privateDraft, instruction: 'Late text stays editable' })
				if (staleLease) assert.match(saved.error ?? '', /admission is closed/)
				else assert.equal(saved.data, true)
				ipcEvents.emit('document-review:dirty', event, 'current', false)
				await f.manager.stopOwned()
				assert.equal(await listening, null)
				assert.equal(f.manager.hasDirty(), false)
			} finally {
				await f.close()
			}
		}
	},
)
