// S7a: per-view access keys (docs/plans/helm-open/spec.md § Per-view access keys). The real DocumentReviewWindows
// over fake BaseWindow containers and WebContentsViews: access is the view's own sender check, lifecycle is per
// view, a move is never a close, and the caps count views. Moves have no UI until S7b; `moveView` is the seam.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import type { ReviewResult, ReviewState } from '../app/src/document-review/types'
import type { HelmPrivatePaths } from '../app/src/document-review/viewer-file'
import type { DocumentReviewWindows as ReviewWindowsType } from '../app/src/document-review/window'
import shortcuts from '../app/src/window-shortcuts'
import { FixtureContainer, type FixtureContents, FixtureView, createdWindows } from './helpers/review-window-fakes'

const runFile = promisify(execFile)
const { focusedShortcutTarget, routeShortcut, shortcutEffect } = shortcuts
const nativeDir = resolve('app/src/document-review')
type Handler = (...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const ipcEvents = new EventEmitter()
let bundleDir: string | null = null
interface Bundle {
	DocumentReviewWindows: typeof ReviewWindowsType
	helmPrivatePaths(options: Record<string, unknown>): Promise<HelmPrivatePaths>
}
let bundle: Bundle | null = null
async function load(): Promise<Bundle> {
	if (bundle) return bundle
	bundleDir = await mkdtemp('/tmp/hr-views-')
	Object.defineProperty(globalThis, '__helmViewsElectron', {
		configurable: true,
		value: {
			BaseWindow: FixtureContainer,
			WebContentsView: FixtureView,
			ipcMain: {
				handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
				on: (channel: string, handler: Handler) => ipcEvents.on(channel, handler),
			},
			dialog: {},
			shell: {},
			clipboard: {},
		},
	})
	const esbuild = createRequire(resolve('app/package.json'))('esbuild')
	await esbuild.build({
		stdin: {
			contents: "export { DocumentReviewWindows } from './window'; export { helmPrivatePaths } from './viewer-file';",
			resolveDir: nativeDir,
			sourcefile: 'views-fixture.ts',
			loader: 'ts',
		},
		outfile: join(bundleDir, 'views.cjs'),
		bundle: true,
		platform: 'node',
		format: 'cjs',
		plugins: [
			{
				name: 'fake-electron',
				setup(build: {
					onResolve(o: { filter: RegExp }, f: () => { path: string; namespace: string }): void
					onLoad(o: { filter: RegExp; namespace: string }, f: () => { contents: string; loader: string }): void
				}) {
					build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake-electron' }))
					build.onLoad({ filter: /.*/, namespace: 'fake-electron' }, () => ({
						contents: 'module.exports = globalThis.__helmViewsElectron;',
						loader: 'js',
					}))
				},
			},
		],
	})
	bundle = createRequire(import.meta.url)(join(bundleDir, 'views.cjs')) as Bundle
	return bundle
}
after(async () => {
	for (const window of createdWindows) window.destroy()
	if (bundleDir) await rm(bundleDir, { recursive: true, force: true })
	Reflect.deleteProperty(globalThis, '__helmViewsElectron')
})

interface ViewInternals {
	senderId: number
	view: FixtureView
	container: { window: FixtureContainer; views: unknown[]; active: unknown }
	observation: { id: string; file: string }
	selectedSession: string | null
	tokens: { has(token: string): boolean }
	viewerSession: { disposed: boolean; tokens: unknown } | null
	token: string
	closed: boolean
}
interface Internals {
	windows: Map<number, ViewInternals>
	archives: Map<string, { archive: { failureId(): string | null } }>
	activity: { activity(profileId: string, session: string | null, documentId: string): unknown }
	publish(profileId: string): void
}

async function fixture() {
	const module = await load()
	handlers.clear()
	ipcEvents.removeAllListeners()
	const base = await realpath(await mkdtemp('/tmp/hr-views-files-'))
	const root = join(base, 'repo')
	await mkdir(root)
	await runFile('git', ['init', '-q', root])
	const profileDir = join(base, 'profile')
	await mkdir(profileDir, { mode: 0o700 })
	const file = async (name: string, body = `# ${name}\n`) => {
		const path = join(root, name)
		await writeFile(path, body, { mode: 0o600 })
		return path
	}
	const paths = await module.helmPrivatePaths({
		home: join(base, 'home'),
		userData: join(base, 'ud'),
		daemonRoots: [],
		authFile: join(base, 'home', '.helm', 'token'),
		uid: process.getuid?.() ?? null,
		tmp: join(base, 'tmp'),
	})
	const sessions: { disposed: boolean; tokens: unknown }[] = []
	let allClosed = 0
	const created: number[] = []
	const manager = new module.DocumentReviewWindows({
		distDir: base,
		profileToken: () => 'current',
		allowsToken: (token: unknown) => token === 'current',
		profileId: () => 'profile',
		profileDir: () => profileDir,
		registry: () => {
			throw new Error('no registry in this fixture')
		},
		mainWindow: () => null,
		planArtifact: () => null,
		privatePaths: async () => paths,
		onAllClosed: () => {
			allClosed++
		},
		onViewCreated: contents => created.push(contents.id),
		viewerSession: tokens => {
			const handle = {
				disposed: false,
				tokens,
				session: {} as never,
				dispose() {
					handle.disposed = true
				},
			}
			sessions.push(handle)
			return handle
		},
	})
	manager.registerIpc()
	const internals = manager as unknown as Internals
	const caller = manager.connectCaller('pi', root, 'Original conversation', 'in-process')
	const callerSessions = manager.callerSessions('profile')
	const closedDocuments: string[] = []
	const closeDocument = callerSessions.closeDocument.bind(callerSessions)
	callerSessions.closeDocument = (id: string) => {
		closedDocuments.push(id)
		return closeDocument(id)
	}
	const view = (path: string) => {
		const state = [...internals.windows.values()].find(value => value.observation.file === path)
		assert.ok(state, `a view for ${path}`)
		return state
	}
	const edit = async (path: string) => {
		await manager.openForCaller(path, 'current', 'profile', caller.id, caller.owner)
		return view(path)
	}
	const plain = async (...files: string[]) => {
		const result = await manager.viewFiles(files, new AbortController().signal)
		assert.deepEqual(result.refused, [])
		return files.map(view)
	}
	const contents = (state: ViewInternals) => state.view.webContents as FixtureContents
	const event = (sender: unknown, frame?: unknown) => ({
		sender,
		senderFrame: frame ?? (sender as FixtureContents).mainFrame,
	})
	const invoke = async <T>(channel: string, sender: unknown, frame?: unknown, ...args: unknown[]) => {
		const handler = handlers.get(`document-review:${channel}`)
		assert.ok(handler)
		return (await handler(event(sender, frame), 'current', ...args)) as ReviewResult<T>
	}
	const notify = (channel: string, sender: FixtureContents, ...args: unknown[]) =>
		ipcEvents.emit(`document-review:${channel}`, event(sender), 'current', ...args)
	return {
		manager,
		internals,
		root,
		file,
		caller,
		callerSessions,
		closedDocuments,
		sessions,
		created,
		allClosed: () => allClosed,
		view,
		edit,
		plain,
		contents,
		invoke,
		notify,
		async close() {
			for (const window of createdWindows) window.destroy()
			await rm(base, { recursive: true, force: true })
		},
	}
}
const live = (state: ViewInternals) => !state.closed && !state.view.webContents.dead

test('access is the view’s own sender: a sibling, a forged sender or a stray view never reaches another state', async () => {
	const f = await fixture()
	try {
		const a = await f.edit(await f.file('a.md'))
		const b = await f.edit(await f.file('b.md'))
		assert.equal(f.manager.moveView(b.senderId, a.senderId), true)
		assert.equal(a.container, b.container, 'one window, two views')
		// Each view reads its own document, the background one included.
		const fromA = await f.invoke<ReviewState>('load', f.contents(a))
		const fromB = await f.invoke<ReviewState>('load', f.contents(b))
		assert.equal(fromA.data?.document.id, a.observation.id)
		assert.equal(fromB.data?.document.id, b.observation.id)
		// A with B's frame, a forged sender carrying B's id, and a stray webContents (a strip, the container) fail.
		assert.match((await f.invoke('load', f.contents(a), f.contents(b).mainFrame)).error ?? '', /no longer current/)
		const forged = { id: b.senderId, isDestroyed: () => false, mainFrame: f.contents(b).mainFrame }
		assert.match((await f.invoke('load', forged, f.contents(b).mainFrame)).error ?? '', /no longer current/)
		const stray = new FixtureView().webContents
		assert.match((await f.invoke('load', stray)).error ?? '', /no longer current/)
		// A presenting the valid profile token still cannot send for B's document.
		const request = {
			id: '6f0a4a61-2a8e-4d7a-9a55-0d1e7b5c3a10',
			documentId: b.observation.id,
			sessionId: f.caller.id,
			owner: f.caller.owner,
			revision: fromB.data?.document.revision,
			intent: 'discuss',
			instruction: 'Explain',
			passage: null,
		}
		assert.match((await f.invoke('send', f.contents(a), undefined, request)).error ?? '', /no longer belongs/)
		// Dirty from A marks A only; a dirty event from a stray sender marks nothing.
		f.notify('dirty', f.contents(a), true)
		f.notify('dirty', stray, true)
		assert.equal((a as unknown as { dirty: boolean }).dirty, true)
		assert.equal((b as unknown as { dirty: boolean }).dirty, false)
	} finally {
		await f.close()
	}
})

test('document-review:close and ⌘W close one view; its window’s other view stays open and is shown', async () => {
	const f = await fixture()
	try {
		const a = await f.edit(await f.file('a.md'))
		const b = await f.edit(await f.file('b.md'))
		const c = await f.edit(await f.file('c.md'))
		f.manager.moveView(b.senderId, a.senderId)
		f.manager.moveView(c.senderId, a.senderId)
		const window = a.container.window
		f.notify('close', f.contents(b))
		assert.equal(live(b), false)
		assert.equal(f.contents(b).dead, true, 'the closed view’s webContents is closed')
		assert.equal(live(a) && live(c), true)
		assert.equal(window.dead, false)
		assert.deepEqual(f.closedDocuments, [b.observation.id], 'closed: true exactly once, for that document only')
		// ⌘W in the shown view closes that view only.
		assert.equal(a.container.active, c)
		f.contents(c).emit(
			'before-input-event',
			{ preventDefault() {} },
			{ type: 'keyDown', code: 'KeyW', meta: true, control: true },
		)
		assert.equal(live(c), false)
		assert.equal(a.container.active, a)
		assert.equal(a.view.visible, true)
		// The last view closes its window.
		f.manager.closeViewOf(f.contents(a) as never)
		assert.equal(window.dead, true)
		assert.deepEqual(f.closedDocuments, [b.observation.id, c.observation.id, a.observation.id])
		assert.equal(f.allClosed(), 1)
	} finally {
		await f.close()
	}
})

test('a moved view keeps its webContents, key, tokens, viewer session, document and caller, and no closed is sent', async () => {
	const f = await fixture()
	try {
		const csv = (name: string) => f.file(name, 'id,name\n1,Ada\n2,Grace\n')
		const [p, q] = await f.plain(await csv('p.csv'), await csv('q.csv'))
		const tokenOf = async (state: ViewInternals) => {
			const url = (await f.invoke<ReviewState>('load', f.contents(state))).data?.document.csv?.url
			assert.ok(url)
			return decodeURIComponent(url.split('/').at(-1) as string)
		}
		const [pToken, qToken] = [await tokenOf(p), await tokenOf(q)]
		const before = { contents: f.contents(p), id: p.senderId, tokens: p.tokens, session: p.viewerSession }
		// Each view's session serves that view's own token table.
		assert.equal(p.viewerSession?.tokens, p.tokens)
		assert.equal(q.viewerSession?.tokens, q.tokens)
		assert.notEqual(p.tokens, q.tokens)
		const source = p.container.window
		assert.equal(f.manager.moveView(p.senderId, q.senderId), true)
		assert.equal(source.dead, true, 'the emptied window closes')
		assert.equal(f.contents(p), before.contents)
		assert.equal(f.contents(p).dead, false)
		assert.equal(f.contents(p).loads.length, 1, 'no reload')
		assert.equal(p.senderId, before.id)
		assert.equal(p.tokens, before.tokens)
		assert.equal(p.viewerSession, before.session)
		assert.equal(p.viewerSession?.disposed, false)
		assert.equal(p.viewerSession?.tokens, p.tokens, 'the moved view keeps its session bound to its own tokens')
		assert.notEqual(p.viewerSession?.tokens, q.tokens)
		// Each view's tokens serve only its own session: a sibling's token is refused from it.
		assert.equal(p.tokens.has(pToken), true)
		assert.equal(p.tokens.has(qToken), false)
		assert.equal(q.tokens.has(pToken), false)
		assert.equal(await tokenOf(p), pToken)
		// A bound view moved out to a new window and back keeps its caller listening.
		const bound = await f.edit(await f.file('bound.md'))
		const document = bound.observation.id
		const listening = f.manager.nextForCallerDocument(
			'profile',
			f.caller.id,
			f.caller.owner,
			document,
			30_000,
			new AbortController().signal,
		)
		let settled = false
		void listening.then(() => {
			settled = true
		})
		assert.equal(f.manager.moveView(bound.senderId, q.senderId), true)
		assert.equal(f.manager.moveView(bound.senderId), true, 'Move Tab to New Window')
		await new Promise(resolve => setTimeout(resolve, 50))
		assert.equal(settled, false, 'a move never ends the read')
		assert.deepEqual(f.closedDocuments, [])
		assert.equal(bound.observation.id, document)
		assert.equal(bound.selectedSession, f.caller.id)
		f.manager.closeViewOf(f.contents(bound) as never)
		assert.deepEqual(await listening, { closed: true, documentId: document })
		assert.deepEqual(f.closedDocuments, [document])
		// Closing a plain view disposes its own session and tokens, the session only once its page is gone: Electron
		// ends the page on a later task, and the session keeps its network block and handler until then.
		f.contents(p).deferDestroy = true
		f.manager.closeViewOf(f.contents(p) as never)
		assert.equal(p.closed, true)
		assert.equal(p.viewerSession?.disposed, false, 'not under a still-live page')
		await new Promise(resolve => setImmediate(resolve))
		assert.equal(f.contents(p).dead, true)
		assert.equal(p.viewerSession?.disposed, true)
		assert.equal(q.viewerSession?.disposed, false)
	} finally {
		await f.close()
	}
})

test('a window with one dirty view refuses to close and asks there; a clean window closes every view once', async () => {
	const f = await fixture()
	try {
		const a = await f.edit(await f.file('a.md'))
		const b = await f.edit(await f.file('b.md'))
		f.manager.moveView(a.senderId, b.senderId) // one window: A shown, B in the background
		const window = a.container.window
		assert.equal(a.container.active, a)
		f.notify('dirty', f.contents(b), true)
		assert.equal(window.close(), false)
		assert.equal(live(a) && live(b), true, 'the clean view stays until the user decides')
		assert.equal(a.container.active, b, 'the dirty view is shown to ask')
		assert.equal(b.view.visible, true)
		assert.equal(a.view.visible, false)
		assert.deepEqual(f.contents(b).sent, ['document-review:close-requested'])
		assert.deepEqual(f.closedDocuments, [])
		// The user confirms in B: the window close runs again, so A closes with it.
		f.notify('dirty', f.contents(b), false)
		f.notify('close', f.contents(b))
		assert.equal(live(a) || live(b), false)
		assert.equal(window.dead, true)
		assert.deepEqual(f.closedDocuments, [b.observation.id, a.observation.id])
		// ⌘W in the asking view after a cancelled window close is a close of that view only.
		const g = await f.edit(await f.file('g.md'))
		const h = await f.edit(await f.file('h.md'))
		f.manager.moveView(h.senderId, g.senderId)
		f.notify('dirty', f.contents(h), true)
		assert.equal(g.container.window.close(), false)
		f.contents(h).emit(
			'before-input-event',
			{ preventDefault() {} },
			{ type: 'keyDown', code: 'KeyW', meta: true, control: true },
		)
		f.notify('dirty', f.contents(h), false)
		f.notify('close', f.contents(h))
		assert.equal(live(h), false)
		assert.equal(live(g), true, 'the window close is not resumed')
		f.manager.closeViewOf(f.contents(g) as never)
		// A clean window closes every view once.
		const a2 = await f.edit(await f.file('a2.md'))
		const c = await f.edit(await f.file('c.md'))
		f.manager.moveView(c.senderId, a2.senderId)
		f.closedDocuments.length = 0
		assert.equal(a2.container.window.close(), true)
		assert.equal(live(a2) || live(c), false)
		assert.equal(f.contents(a2).dead && f.contents(c).dead, true, 'each view’s webContents is closed')
		assert.deepEqual(f.closedDocuments, [a2.observation.id, c.observation.id])
		// A container destroyed from outside still runs each view's own close path once.
		const d = await f.edit(await f.file('d.md'))
		d.container.window.destroy()
		assert.equal(f.contents(d).dead, true)
		assert.equal(f.closedDocuments.filter(id => id === d.observation.id).length, 1)
		assert.equal(f.internals.windows.size, 0)
	} finally {
		await f.close()
	}
})

test('a profile switch closes every view and window', async () => {
	const f = await fixture()
	try {
		const a = await f.edit(await f.file('a.md'))
		const b = await f.edit(await f.file('b.md'))
		const [p] = await f.plain(await f.file('p.md'))
		f.manager.moveView(b.senderId, a.senderId)
		await f.manager.closeForProfileSwitch()
		for (const state of [a, b, p as ViewInternals]) assert.equal(f.contents(state).dead, true)
		assert.equal(a.container.window.dead && (p as ViewInternals).container.window.dead, true)
		assert.equal(f.internals.windows.size, 0)
	} finally {
		await f.close()
	}
})

test('quit closes clean windows; a window with a dirty view stays and asks there', async () => {
	const f = await fixture()
	try {
		const c = await f.edit(await f.file('c.md'))
		const d = await f.edit(await f.file('d.md'))
		const e = await f.edit(await f.file('e.md'))
		f.manager.moveView(d.senderId, c.senderId)
		f.notify('dirty', f.contents(d), true)
		f.manager.requestCloseAll()
		assert.equal(live(c) && live(d), true)
		assert.equal(live(e), false)
		// A coalesced `changed` from the opens may land first (80 ms timer, load-dependent); only the ask matters.
		assert.deepEqual(
			f.contents(d).sent.filter(channel => channel !== 'document-review:changed'),
			['document-review:close-requested'],
		)
		assert.equal(f.allClosed(), 0)
		// Once the user discards in D, the quit's window close finishes: C closes too and the quit can go on.
		f.notify('dirty', f.contents(d), false)
		f.notify('close', f.contents(d))
		assert.equal(live(c) || live(d), false)
		assert.equal(c.container.window.dead, true)
		assert.equal(f.internals.windows.size, 0)
		assert.equal(f.allClosed(), 1)
	} finally {
		await f.close()
	}
})

test('reopen and recovery select a background view and show its window', async () => {
	const f = await fixture()
	try {
		const a = await f.edit(await f.file('a.md'))
		const bFile = await f.file('b.md')
		const b = await f.edit(bFile)
		f.manager.moveView(a.senderId, b.senderId)
		assert.equal(b.container.active, a)
		const window = b.container.window
		window.calls.length = 0
		await f.edit(bFile)
		assert.equal(b.container.active, b)
		assert.deepEqual(window.calls, ['show', 'focus'])
		await f.edit(a.observation.file)
		assert.equal(b.container.active, a)
		// An unsaved reply for B's file: recovery reuses B's view and must not leave it behind A.
		const entry = [...f.internals.archives.entries()].find(([key]) => key.includes(bFile))
		assert.ok(entry, 'B’s file has its archive context')
		const archive = entry[1].archive
		const original = archive.failureId.bind(archive)
		archive.failureId = () => '00000000-0000-4000-8000-000000000001'
		window.calls.length = 0
		await f.manager.showArchiveRecovery()
		archive.failureId = original
		assert.equal(b.container.active, b)
		assert.equal(b.view.visible, true)
		assert.deepEqual(window.calls, ['show', 'focus'])
		assert.equal(b.selectedSession, null, 'recovery has no caller')
	} finally {
		await f.close()
	}
})

test('document-review:changed and the activity line reach a background view, before and after a move', async () => {
	const f = await fixture()
	try {
		const a = await f.edit(await f.file('a.md'))
		const b = await f.edit(await f.file('b.md'))
		f.manager.moveView(a.senderId, b.senderId) // A shown, B in the background
		assert.equal(a.container.active, a)
		const line = { phase: 'working', at: 1 }
		const original = f.internals.activity.activity.bind(f.internals.activity)
		f.internals.activity.activity = (profileId, session, documentId) =>
			profileId === 'profile' && session === f.caller.id && documentId === b.observation.id
				? line
				: original(profileId, session, documentId)
		const sent = (state: ViewInternals) =>
			f.contents(state).sent.filter(channel => channel === 'document-review:changed')
		f.internals.publish('profile')
		await new Promise(resolve => setTimeout(resolve, 150))
		assert.equal(sent(b).length, 1, 'the background view is told')
		assert.equal(sent(a).length, 1)
		assert.deepEqual((await f.invoke<ReviewState>('load', f.contents(b))).data?.activity, line)
		f.manager.moveView(b.senderId)
		assert.deepEqual((await f.invoke<ReviewState>('load', f.contents(b))).data?.activity, line)
		f.internals.publish('profile')
		await new Promise(resolve => setTimeout(resolve, 150))
		assert.equal(sent(b).length, 2)
		f.internals.activity.activity = original
	} finally {
		await f.close()
	}
})

test('caps count views wherever they are shown, and every view gets the shortcut dispatcher', async () => {
	const f = await fixture()
	try {
		const views: ViewInternals[] = []
		for (let index = 0; index < 8; index++) views.push(await f.edit(await f.file(`v${index}.md`)))
		for (const state of views.slice(1)) f.manager.moveView(state.senderId, (views[0] as ViewInternals).senderId)
		assert.equal(new Set(views.map(state => state.container)).size, 1)
		await assert.rejects(f.edit(await f.file('ninth.md')), /Eight review windows are open/)
		// Plain views have their own bound and never count against the eight.
		const plain: ViewInternals[] = []
		for (let batch = 0; batch < 4; batch++)
			plain.push(
				...(await f.plain(...(await Promise.all(Array.from({ length: 8 }, (_, i) => f.file(`p${batch * 8 + i}.md`)))))),
			)
		for (const state of plain.slice(1, 16)) f.manager.moveView(state.senderId, (plain[0] as ViewInternals).senderId)
		assert.ok(new Set(plain.map(state => state.container)).size < 32, 'the plain cap counts views, not windows')
		const extra = await f.file('p32.md')
		const refused = await f.manager.viewFiles([extra], new AbortController().signal)
		assert.equal(refused.refused.length, 1)
		assert.match(refused.refused[0]?.reason ?? '', /p32\.md was not opened: 32 files are already open/)
		assert.equal(f.internals.windows.size, 40)
		// Separate bounds: at 32 plain views, closing one feedback view frees a feedback slot only.
		f.manager.closeViewOf(f.contents(views[7] as ViewInternals) as never)
		await f.edit(await f.file('ninth-again.md'))
		// Closing one plain view frees a plain slot.
		f.manager.closeViewOf(f.contents(plain[3] as ViewInternals) as never)
		assert.equal((await f.manager.viewFiles([extra], new AbortController().signal)).refused.length, 0)
		assert.deepEqual(f.created.sort(), [...f.internals.windows.keys(), views[7]?.senderId, plain[3]?.senderId].sort())
	} finally {
		await f.close()
	}
})

test('focused() maps the focused document window (or a view’s undocked DevTools) to its shown view', async () => {
	const f = await fixture()
	try {
		FixtureContainer.focusedWindow = null
		const cockpit = { name: 'cockpit' }
		assert.equal(f.manager.focused(), null, 'no document window has focus')
		const a = await f.edit(await f.file('a.md'))
		const b = await f.edit(await f.file('b.md'))
		const window = a.container.window
		window.focus()
		assert.equal(f.manager.focused()?.contents, f.contents(a))
		assert.deepEqual(focusedShortcutTarget(f.manager.focused(), null, cockpit), { review: f.contents(a) })
		// It follows the shown view: a view moved in, then a reselected one.
		f.manager.moveView(b.senderId, a.senderId)
		assert.equal(f.manager.focused()?.contents, f.contents(b))
		await f.edit(a.observation.file)
		assert.equal(f.manager.focused()?.contents, f.contents(a))
		// A shown view that lost its access (a profile switch) is still the target: File → Close goes through its
		// guard, never to the cockpit.
		a.token = 'previous profile'
		assert.equal(f.manager.focused()?.contents, f.contents(a))
		a.token = 'current'
		// A view's undocked DevTools have focus while no container does: still that view.
		FixtureContainer.focusedWindow = null
		f.contents(b).devToolsFocused = true
		assert.equal(f.manager.focused()?.contents, f.contents(b))
		f.contents(b).devToolsFocused = false
		assert.equal(f.manager.focused(), null)
		// A window the user focused, then closed with its last view: nothing is focused.
		window.focus()
		f.manager.closeViewOf(f.contents(a) as never)
		f.manager.closeViewOf(f.contents(b) as never)
		assert.equal(window.dead, true)
		assert.equal(f.manager.focused(), null)
	} finally {
		FixtureContainer.focusedWindow = null
		await f.close()
	}
})

test('a window and its view paint the review surface colour until the first frame, in either theme', async () => {
	const f = await fixture()
	try {
		const a = await f.edit(await f.file('a.md'))
		assert.equal(a.container.window.backgroundColor, '#141517')
		assert.equal(a.view.backgroundColor, '#141517')
		const lightFile = await f.file('light.md')
		const drafts = (
			f.manager as unknown as {
				drafts: Map<
					string,
					{
						key(r: string, f: string, s: string | null): string
						load(k: string): object
						save(k: string, d: object): void
					}
				>
			}
		).drafts.get('profile')
		assert.ok(drafts)
		const key = drafts.key(f.root, lightFile, f.caller.id)
		drafts.save(key, { ...drafts.load(key), theme: 'light' })
		const light = await f.edit(lightFile)
		assert.equal(light.container.window.backgroundColor, '#faf9f6')
		assert.equal(light.view.backgroundColor, '#faf9f6')
		// A moved-out view's new window keeps that colour.
		f.manager.moveView(light.senderId, a.senderId)
		f.manager.moveView(light.senderId)
		assert.equal(light.container.window.backgroundColor, '#faf9f6')
	} finally {
		await f.close()
	}
})

test('⌘W, File → Close and the font keys in a focused document window never reach the cockpit', () => {
	const key = (code: string, extra: Partial<{ shiftKey: boolean }> = {}) => ({
		code,
		metaKey: true,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...extra,
	})
	const menuKey = { code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }
	const cockpit = { name: 'cockpit' }
	const view = { name: 'view' }
	// A focused document window resolves to its view, or to nothing while that view closes; never the cockpit.
	assert.deepEqual(focusedShortcutTarget({ contents: view }, null, cockpit), { review: view })
	assert.equal(focusedShortcutTarget({ contents: null }, null, cockpit), null)
	assert.deepEqual(focusedShortcutTarget(null, null, cockpit), { window: cockpit })
	const effect = (action: Parameters<typeof routeShortcut>[1], pressed = key('KeyW')) =>
		shortcutEffect({ review: view }, routeShortcut('document', action, pressed, 'darwin'))
	assert.deepEqual(effect('closeFocused'), { kind: 'close-view', view })
	assert.deepEqual(effect('closeFocused', menuKey), { kind: 'close-view', view }, 'File → Close')
	assert.deepEqual(effect('fontBigger', menuKey), { kind: 'zoom', view, step: 1 })
	assert.deepEqual(effect('fontSmaller', key('Minus')), { kind: 'zoom', view, step: -1 })
	assert.deepEqual(effect('fontReset', key('Digit0')), { kind: 'zoom', view, step: 0 })
	assert.deepEqual(effect(null, key('KeyO')), { kind: 'open-file', view })
	assert.deepEqual(effect(null, key('KeyR')), { kind: 'none' })
	// The cockpit keeps its own handlers.
	assert.deepEqual(
		shortcutEffect({ window: cockpit }, routeShortcut('cockpit', 'closeFocused', key('KeyW'), 'darwin')),
		{ kind: 'action', action: 'closeFocused', target: { window: cockpit } },
	)
})
