import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BrowserWindow, Menu, app, ipcMain, screen, shell } from 'electron'
import * as pty from 'node-pty'
import { HelmBridge } from './helm-bridge'
import { parseHelmItemUrl } from './protocol'
import * as sessions from './sessions'
import { THEME_PRESETS } from './theme-presets'

// HELM_URL preferred; VIGIL_URL still honored (legacy compat).
const daemonUrl = process.env.HELM_URL ?? process.env.VIGIL_URL ?? 'http://localhost:7474'

// Single owner of daemon HTTP: one poller + command proxy, pushed to the
// renderer over IPC (the file:// renderer can't fetch :7474 itself).
const helmBridge = new HelmBridge(daemonUrl)

// --- CLI modes ---------------------------------------------------------------
// `electron . --screenshot=<path> [--user-data-dir-tmp]` renders the window
// without focusing it, waits for the sidebar + shell prompt to paint,
// writes a full-window PNG, and exits 0.
const screenshotPath = process.argv.find(a => a.startsWith('--screenshot='))?.slice('--screenshot='.length) || null

// `--ui-preview=<list|detail|settings|appearance>` forwards to the renderer
// (via preload additionalArguments) so screenshot runs can capture a specific
// sidebar page. `--ui-theme=<presetId>` applies a theme preset for the run
// (no persistence) so theme presets are screenshot-verifiable.
const uiPreviewArg = process.argv.find(a => a.startsWith('--ui-preview=')) || null
const uiThemeArg = process.argv.find(a => a.startsWith('--ui-theme=')) || null

app.setName('Helm')
// Must run before anything touches userData so a screenshot run never fights a
// running Helm instance over the same profile (locks, window-state writes).
if (process.argv.includes('--user-data-dir-tmp')) {
	app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'helm-')))
}

// --- helm:// deep links -------------------------------------------------------
// The app owns the `helm://` scheme (the extension's "Open" link is
// helm://item/<id> — the browser dashboard is gone) and ALSO registers the
// legacy `vigil://` scheme so pre-rename links keep working; the handler
// treats both identically. Skipped for screenshot runs: a throwaway capture
// must not steal the OS-level handler registration.
// On macOS an UNPACKAGED run (electron .) can't always claim the scheme —
// LaunchServices wants CFBundleURLTypes in the bundle's Info.plist — so a
// failed registration is logged, not fatal; a packaged Helm carries the scheme.
if (!screenshotPath) {
	for (const scheme of ['helm', 'vigil']) {
		if (!app.setAsDefaultProtocolClient(scheme)) {
			console.warn(`[helm] could not register as ${scheme}:// handler (unpackaged dev run?)`)
		}
	}
}

/** Deep link that arrived before the window/renderer was ready; delivered on load. */
let pendingOpenItemId: string | null = null

function deliverOpenItem(itemId: string): void {
	pendingOpenItemId = itemId
	const win = mainWindow
	if (!win || win.isDestroyed()) {
		// Cold start: whenReady's createWindow flushes the pending id on load.
		if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow()
		return
	}
	if (win.isMinimized()) win.restore()
	win.show()
	win.focus()
	if (!win.webContents.isLoading()) flushPendingOpenItem(win)
}

function flushPendingOpenItem(win: BrowserWindow): void {
	if (pendingOpenItemId === null || win.isDestroyed()) return
	win.webContents.send('nav:open-item', pendingOpenItemId)
	pendingOpenItemId = null
}

// macOS delivers protocol launches/activations here (registered before `ready`
// so a cold-start URL isn't missed). Windows/Linux would need a
// single-instance lock + `second-instance` argv scan instead — not wired.
app.on('open-url', (event, url) => {
	event.preventDefault()
	const itemId = parseHelmItemUrl(url)
	if (itemId) deliverOpenItem(itemId)
})

interface PtyEntry {
	proc: pty.IPty
	/** Backing dtach session; null = plain non-persistent shell. */
	sessionId: string | null
}

const ptys = new Map<number, PtyEntry>()
let nextPtyId = 1
let mainWindow: BrowserWindow | null = null

function defaultShell(): string {
	if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe'
	return process.env.SHELL ?? '/bin/zsh'
}

// --- dtach session persistence ---------------------------------------------------
// Tabs are dtach sessions (see src/sessions.ts for the okena port). Persistence
// is resolved lazily and degrades to the classic non-persistent spawn when dtach
// is missing (logged once) or during screenshot runs (a throwaway capture must
// not leave detached shells behind).

interface SessionSupport {
	dtach: string
	registry: sessions.SessionRegistry
}

let sessionSupport: SessionSupport | null | undefined

function getSessionSupport(): SessionSupport | null {
	if (sessionSupport !== undefined) return sessionSupport
	if (screenshotPath || process.platform === 'win32') {
		sessionSupport = null
		return null
	}
	const dtach = sessions.resolveDtachBinary()
	if (!dtach) {
		console.warn(
			'[helm] dtach not found (checked /opt/homebrew/bin, /usr/local/bin, PATH) — terminals will not survive restarts',
		)
		sessionSupport = null
		return null
	}
	sessions.ensureSocketDir()
	sessionSupport = {
		dtach,
		registry: new sessions.SessionRegistry(path.join(app.getPath('userData'), 'sessions.json')),
	}
	return sessionSupport
}

// Soft close: explicit tab close detaches the client and arms this timer; the
// session dies only when it fires (okena soft_close.rs semantics; 5s default
// from okena settings.rs:494). Undo cancels the timer and the tab reattaches.
const graceCloser = new sessions.GraceCloser(sessions.closeGraceMs(), sessionId => {
	getSessionSupport()?.registry.remove(sessionId)
})

/**
 * Kill only the pty CLIENT processes. With dtach this DETACHES: the client
 * dies, the forked master (and the shell under it) keeps running for the next
 * launch — okena's `detach_all` / Drop behavior (pty_manager.rs:799-807,
 * 1130-1140: "On drop, just detach - don't kill sessions"). For non-persistent
 * ptys this is the old kill-everything, unchanged.
 *
 * Also drops pending grace-kill timers WITHOUT firing them: quit means detach
 * everything, so a session mid-grace survives and restores on next launch.
 */
function killAllPtyClients(): void {
	graceCloser.cancelAll()
	for (const entry of ptys.values()) {
		try {
			entry.proc.kill()
		} catch {
			// already exited
		}
	}
	ptys.clear()
}

// --- Window bounds persistence -------------------------------------------------

const MIN_WIDTH = 960
const MIN_HEIGHT = 620
const DEFAULT_BOUNDS = { width: 1400, height: 900 } as const
const SAVE_BOUNDS_DEBOUNCE_MS = 400

interface WindowState {
	x?: number
	y?: number
	width: number
	height: number
}

function windowStateFile(): string {
	return path.join(app.getPath('userData'), 'window-state.json')
}

function restoreWindowState(): WindowState {
	try {
		const raw = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8')) as Record<string, unknown>
		const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
		const { width, height, x, y } = raw
		if (!num(width) || !num(height)) return { ...DEFAULT_BOUNDS }
		const state: WindowState = {
			width: Math.max(MIN_WIDTH, Math.round(width)),
			height: Math.max(MIN_HEIGHT, Math.round(height)),
		}
		if (num(x) && num(y)) {
			// Restore position only while the title bar still lands on a connected
			// display — a detached monitor must not strand the window off-screen.
			const visible = screen.getAllDisplays().some(d => {
				const a = d.workArea
				return x >= a.x - 100 && x <= a.x + a.width - 100 && y >= a.y && y <= a.y + a.height - 40
			})
			if (visible) {
				state.x = Math.round(x)
				state.y = Math.round(y)
			}
		}
		return state
	} catch {
		return { ...DEFAULT_BOUNDS }
	}
}

let saveBoundsTimer: NodeJS.Timeout | null = null

function saveWindowState(win: BrowserWindow): void {
	if (win.isDestroyed()) return
	try {
		// Normal bounds, so a maximized/fullscreen quit restores the pre-zoom size.
		fs.writeFileSync(windowStateFile(), JSON.stringify(win.getNormalBounds()))
	} catch {
		// best-effort; next launch falls back to defaults
	}
}

function trackWindowState(win: BrowserWindow): void {
	const schedule = () => {
		if (saveBoundsTimer) clearTimeout(saveBoundsTimer)
		saveBoundsTimer = setTimeout(() => saveWindowState(win), SAVE_BOUNDS_DEBOUNCE_MS)
	}
	win.on('move', schedule)
	win.on('resize', schedule)
	win.on('close', () => {
		if (saveBoundsTimer) clearTimeout(saveBoundsTimer)
		saveWindowState(win)
	})
}

// --- Screenshot harness ----------------------------------------------------------

const SCREENSHOT_SETTLE_MS = 3000
const SCREENSHOT_LOAD_TIMEOUT_MS = 20_000

function captureScreenshot(win: BrowserWindow, outPath: string): void {
	const resolved = path.resolve(outPath)
	const fail = (err: unknown): void => {
		console.error('[helm] screenshot failed:', err)
		killAllPtyClients()
		app.exit(1)
	}
	const loadTimeout = setTimeout(() => fail(new Error('window never finished loading')), SCREENSHOT_LOAD_TIMEOUT_MS)
	// Listener attaches before loadFile is called, so the load event cannot be missed.
	win.webContents.once('did-finish-load', () => {
		clearTimeout(loadTimeout)
		// Settle so the sidebar (or its waiting state) and the shell prompt paint.
		setTimeout(() => {
			win.webContents
				.capturePage()
				.then(image => {
					fs.mkdirSync(path.dirname(resolved), { recursive: true })
					fs.writeFileSync(resolved, image.toPNG())
					console.log(`[helm] screenshot written: ${resolved}`)
					killAllPtyClients()
					app.exit(0)
				})
				.catch(fail)
		}, SCREENSHOT_SETTLE_MS)
	})
}

function createWindow(): void {
	// Screenshot runs use fixed default bounds for deterministic captures.
	const state = screenshotPath ? { ...DEFAULT_BOUNDS } : restoreWindowState()
	const win = new BrowserWindow({
		...state,
		minWidth: MIN_WIDTH,
		minHeight: MIN_HEIGHT,
		title: 'Helm',
		show: false,
		backgroundColor: '#141517',
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: { x: 14, y: 12 },
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			// A screenshot run captures an unfocused window; keep it painting.
			backgroundThrottling: !screenshotPath,
			...(uiPreviewArg || uiThemeArg
				? { additionalArguments: [uiPreviewArg, uiThemeArg].filter((arg): arg is string => arg !== null) }
				: {}),
		},
	})
	// Terminal web-links + sidebar external links open in the default browser, never a new Electron window.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) void shell.openExternal(url)
		return { action: 'deny' }
	})
	win.on('closed', () => {
		if (mainWindow === win) mainWindow = null
		killAllPtyClients()
	})
	if (screenshotPath) {
		captureScreenshot(win, screenshotPath)
		// showInactive: window must paint for capturePage, but never steal focus.
		win.once('ready-to-show', () => win.showInactive())
	} else {
		trackWindowState(win)
		win.once('ready-to-show', () => win.show())
	}
	// A helm:// deep link may land before the renderer is up (cold start).
	win.webContents.on('did-finish-load', () => flushPendingOpenItem(win))
	// Native macOS three-finger swipe (System Settings "Swipe between pages"):
	// swiping right = back, left = forward — same channel as the Go menu.
	win.on('swipe', (_event, direction) => {
		if (direction === 'right') win.webContents.send('nav:go', 'back')
		else if (direction === 'left') win.webContents.send('nav:go', 'forward')
	})
	// Mice that report back/forward as app commands (renderer also handles
	// plain button-3/4 pointer events itself).
	win.on('app-command', (_event, command) => {
		if (command === 'browser-backward') win.webContents.send('nav:go', 'back')
		else if (command === 'browser-forward') win.webContents.send('nav:go', 'forward')
	})
	void win.loadFile(path.join(__dirname, 'index.html'))
	mainWindow = win
}

function buildMenu(): void {
	const send =
		(channel: string, ...args: unknown[]) =>
		() =>
			mainWindow?.webContents.send(channel, ...args)
	const template: Electron.MenuItemConstructorOptions[] = [
		...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
		{
			label: 'Shell',
			submenu: [
				{ label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: send('tab:new') },
				// Owning cmd+w here keeps it from closing the window (no window-menu close role).
				{ label: 'Close Terminal', accelerator: 'CmdOrCtrl+W', click: send('tab:close') },
			],
		},
		{ role: 'editMenu' },
		{
			// Custom View menu: the stock viewMenu role owns cmd+= / cmd+- / cmd+0
			// as webContents zoom — helm gives those to the terminal font size
			// (renderer applies bounds + persistence, mirroring the cmd+t pattern).
			label: 'View',
			submenu: [
				{ label: 'Bigger text', accelerator: 'CmdOrCtrl+=', click: send('font:step', 1) },
				// Hidden twin so the literal ⌘⇧= ("cmd +") chord also works.
				{
					label: 'Bigger text',
					accelerator: 'CmdOrCtrl+Shift+=',
					visible: false,
					acceleratorWorksWhenHidden: true,
					click: send('font:step', 1),
				},
				{ label: 'Smaller text', accelerator: 'CmdOrCtrl+-', click: send('font:step', -1) },
				{ label: 'Reset text size', accelerator: 'CmdOrCtrl+0', click: send('font:step', 0) },
				{ type: 'separator' },
				{ role: 'reload' },
				{ role: 'forceReload' },
				{ role: 'toggleDevTools' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' },
			],
		},
		{
			// Sidebar push-stack navigation (design-system.md §3.10 gestures):
			// keyboard equivalents live in the menu because xterm swallows
			// renderer keydowns when a terminal has focus.
			label: 'Go',
			submenu: [
				{ label: 'Back', accelerator: 'CmdOrCtrl+[', click: send('nav:go', 'back') },
				{ label: 'Forward', accelerator: 'CmdOrCtrl+]', click: send('nav:go', 'forward') },
			],
		},
		{ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
	]
	Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

interface SpawnArgs {
	cols: number
	rows: number
	/** Restored session to reattach; omitted = create a fresh session. */
	sessionId?: string
}

// Helm is usually launched via `bun run start` / `npm start`, and those
// launchers inject npm_config_*/npm_lifecycle_*/BUN_* vars into our process.
// Passing them into the interactive shell breaks tooling in the user's rc
// files (nvm hard-errors on npm_config_prefix). Spawn shells with a scrubbed
// environment instead.
function shellEnv(): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue
		if (key.startsWith('npm_') || key.startsWith('BUN_') || key === 'NODE_ENV' || key === 'INIT_CWD') continue
		env[key] = value
	}
	return env
}

ipcMain.handle('pty:spawn', (event, args: SpawnArgs) => {
	const id = nextPtyId++
	const shell = defaultShell()
	const support = getSessionSupport()

	// With dtach: the pty child is the dtach CLIENT (`dtach -A <sock> -E -r winch
	// <shell> -l`). `-A` makes one spawn path serve both fresh tabs (creates the
	// session) and restored tabs (attaches to the surviving socket); `-r winch`
	// makes dtach SIGWINCH the program on attach so vim/less repaint after a
	// reattach. See src/sessions.ts for the okena citations.
	let file = shell
	let argv = process.platform === 'win32' ? [] : ['-l']
	let sessionId: string | null = null
	if (support) {
		const restoring = sessions.isValidSessionId(args.sessionId)
		sessionId = restoring ? (args.sessionId as string) : sessions.newSessionId()
		file = support.dtach
		argv = sessions.buildSessionArgs(sessionId, shell)
		if (!restoring) support.registry.add(sessionId)
	}

	const proc = pty.spawn(file, argv, {
		name: 'xterm-256color',
		cols: Math.max(2, Math.floor(args.cols) || 80),
		rows: Math.max(2, Math.floor(args.rows) || 24),
		cwd: os.homedir(),
		env: shellEnv(),
	})
	ptys.set(id, { proc, sessionId })
	const contents = event.sender
	proc.onData(data => {
		if (!contents.isDestroyed()) contents.send('pty:data', id, data)
	})
	proc.onExit(({ exitCode }) => {
		ptys.delete(id)
		// A client exiting on its own usually means the session ended (shell
		// `exit` → master gone → client EOF), but a detach-kill during quit lands
		// here too — reapSessionIfDead only forgets the session when the socket
		// no longer answers, so detached sessions are never dropped.
		if (sessionId && support) {
			const sid = sessionId
			void sessions.reapSessionIfDead(sid).then(dead => {
				if (dead) support.registry.remove(sid)
			})
		}
		if (!contents.isDestroyed()) contents.send('pty:exit', id, exitCode)
	})
	return { id, sessionId }
})

ipcMain.on('pty:write', (_event, id: number, data: string) => {
	ptys.get(id)?.proc.write(data)
})

ipcMain.on('pty:resize', (_event, id: number, cols: number, rows: number) => {
	const entry = ptys.get(id)
	if (!entry || !(cols > 0) || !(rows > 0)) return
	try {
		entry.proc.resize(Math.floor(cols), Math.floor(rows))
	} catch {
		// pty already exited
	}
})

// Immediate hard kill — SIGTERM the socket holders and unlink the socket
// (okena kill_session, session_backend.rs:398-442). Used for the renderer's
// spawn-race cleanup (tab closed before spawn resolved); interactive tab
// closes go through session:close-with-grace instead.
ipcMain.on('pty:kill', (_event, id: number) => {
	const entry = ptys.get(id)
	if (!entry) return
	ptys.delete(id)
	if (entry.sessionId) {
		const sid = entry.sessionId
		graceCloser.undo(sid) // a hard kill supersedes any pending grace timer
		void sessions.killSession(sid).then(() => getSessionSupport()?.registry.remove(sid))
	}
	try {
		entry.proc.kill()
	} catch {
		// already exited
	}
})

// Explicit tab close (× / cmd+W): okena-style soft close. Detach the client
// NOW (tab disappears, session keeps running) and arm the grace timer; the
// session is killed for real only when the timer fires. Returns the grace
// window so the renderer can show an Undo toast, or null when the pty had no
// session (non-persistent fallback → the client kill was the real kill).
ipcMain.handle('session:close-with-grace', (_event, id: number) => {
	const entry = ptys.get(id)
	if (!entry) return null
	ptys.delete(id)
	try {
		entry.proc.kill()
	} catch {
		// already exited
	}
	if (!entry.sessionId) return null
	graceCloser.schedule(entry.sessionId)
	return { sessionId: entry.sessionId, graceMs: graceCloser.graceMs }
})

// Undo a soft close: cancel the pending kill. True = session untouched, the
// renderer may reattach it as a new tab. False = timer already fired (or
// nothing pending) — nothing to restore.
ipcMain.handle('session:undo-close', (_event, sessionId: unknown) => {
	if (!sessions.isValidSessionId(sessionId)) return false
	return graceCloser.undo(sessionId)
})

// Startup restore: live sessions from the socket dir (stale sockets GC'd),
// labeled from the registry. The renderer reattaches one tab per entry.
ipcMain.handle('sessions:list', async () => {
	const support = getSessionSupport()
	if (!support) return []
	const live = await sessions.listLiveSessions()
	support.registry.prune(new Set(live.map(s => s.sessionId)))
	return live
		.map(s => ({
			sessionId: s.sessionId,
			title: support.registry.get(s.sessionId)?.lastTitle ?? null,
			// Registry createdAt (original spawn) beats socket birthtime for ordering.
			createdAt: support.registry.get(s.sessionId)?.createdAt ?? s.createdAt,
		}))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.map(({ sessionId, title }) => ({ sessionId, title }))
})

ipcMain.on('session:title', (_event, sessionId: unknown, title: unknown) => {
	if (!sessions.isValidSessionId(sessionId) || typeof title !== 'string') return
	getSessionSupport()?.registry.setTitle(sessionId, title)
})

ipcMain.on('config:get', event => {
	event.returnValue = { daemonUrl }
})

// --- Themes (<userData>/themes/*.json, docs/design-system.md §2.8) --------------
// Main owns the directory: presets are seeded as editable files on first list,
// any other *.json dropped in the dir shows up in the Appearance theme picker.
// The renderer bundles THEME_PRESETS as its synchronous fallback, so this IPC
// is never on the first-paint path.

function themesDir(): string {
	return path.join(app.getPath('userData'), 'themes')
}

interface ThemeFileEntry {
	id: string
	name: string
	tokens: Record<string, string>
}

function readThemeFile(file: string): ThemeFileEntry | null {
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
		const tokens: Record<string, string> = {}
		if (typeof raw.tokens === 'object' && raw.tokens !== null) {
			for (const [key, value] of Object.entries(raw.tokens)) {
				if (key.startsWith('--') && typeof value === 'string') tokens[key] = value
			}
		}
		if (Object.keys(tokens).length === 0) return null
		const id = path.basename(file, '.json')
		return { id, name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id, tokens }
	} catch {
		return null // unreadable/invalid file — skip, never break the list
	}
}

ipcMain.handle('themes:list', () => {
	const dir = themesDir()
	try {
		fs.mkdirSync(dir, { recursive: true })
		for (const [id, preset] of Object.entries(THEME_PRESETS)) {
			const file = path.join(dir, `${id}.json`)
			if (!fs.existsSync(file)) {
				fs.writeFileSync(file, `${JSON.stringify({ name: preset.name, tokens: preset.tokens }, null, '\t')}\n`)
			}
		}
	} catch (err) {
		console.warn('[helm] theme seeding failed:', err)
	}
	let files: string[] = []
	try {
		files = fs.readdirSync(dir).filter(name => name.endsWith('.json'))
	} catch {
		// dir unreadable — fall through to bundled presets only
	}
	const fromDisk = new Map<string, ThemeFileEntry>()
	for (const name of files) {
		const entry = readThemeFile(path.join(dir, name))
		if (entry) fromDisk.set(entry.id, entry)
	}
	// Preset order first (a user-edited preset file wins over the bundled copy,
	// a corrupt one falls back to it), then custom themes alphabetically.
	const list: ThemeFileEntry[] = Object.entries(THEME_PRESETS).map(
		([id, preset]) => fromDisk.get(id) ?? { id, name: preset.name, tokens: preset.tokens },
	)
	const custom = [...fromDisk.values()]
		.filter(entry => !THEME_PRESETS[entry.id])
		.sort((a, b) => a.name.localeCompare(b.name))
	return [...list, ...custom]
})

helmBridge.registerIpc()

void app.whenReady().then(() => {
	app.setAboutPanelOptions({ applicationName: 'Helm', applicationVersion: app.getVersion() })
	buildMenu()
	helmBridge.start()
	createWindow()
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

app.on('window-all-closed', () => {
	killAllPtyClients()
	app.quit()
})

// Quit detaches (clients die, dtach sessions live on for the next launch) —
// the pre-dtach behavior of killing the shells is gone by design.
app.on('before-quit', () => {
	helmBridge.stop()
	killAllPtyClients()
	sessionSupport?.registry.flush()
})
