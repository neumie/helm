import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BrowserWindow, Menu, app, dialog, ipcMain, screen, shell } from 'electron'
import * as pty from 'node-pty'
import { APP_NAME, macApplicationMenu } from './app-menu'
import { BufferStore } from './buffers'
import { HelmBridge } from './helm-bridge'
import { AppProfileStore } from './profiles'
import { parseHelmDestination } from './protocol'
import type { HelmItemDestination } from './protocol'
import { RunContextWindows } from './run-context-window'
import * as sessions from './sessions'
import { THEME_PRESETS } from './theme-presets'

// HELM_URL preferred; VIGIL_URL still honored (legacy compat).
const daemonUrl = process.env.HELM_URL ?? process.env.VIGIL_URL ?? 'http://localhost:7474'

// Single owner of daemon HTTP: one poller + command proxy, pushed to the
// renderer over IPC (the file:// renderer can't fetch :7474 itself).
const helmBridge = new HelmBridge(daemonUrl, token => token === sessionProfileToken())
let pendingEditorQuit = false
const runContextWindows = new RunContextWindows(helmBridge, __dirname, {
	onAllClosed: () => {
		if (!pendingEditorQuit) return
		pendingEditorQuit = false
		app.quit()
	},
	onCloseCancelled: () => {
		pendingEditorQuit = false
		quitRequested = false
	},
	canOpen: () => !profileSwitchInProgress,
})

// --- CLI modes ---------------------------------------------------------------
// `electron . --screenshot=<path> [--user-data-dir-tmp]` renders the window
// without focusing it, waits for the sidebar + shell prompt to paint,
// writes a full-window PNG, and exits 0.
const screenshotPath = process.argv.find(a => a.startsWith('--screenshot='))?.slice('--screenshot='.length) || null

// `--ui-preview=<list|project-list|queue-list|planned-list|detail|queue-detail|planned-detail|archive-detail|task|settings|appearance>` forwards to the renderer
// (via preload additionalArguments) so screenshot runs can capture a specific
// sidebar page. `--ui-theme=<presetId>` applies a theme preset for the run
// (no persistence) so theme presets are screenshot-verifiable.
const uiPreviewArg = process.argv.find(a => a.startsWith('--ui-preview=')) || null
const uiThemeArg = process.argv.find(a => a.startsWith('--ui-theme=')) || null

// `--term-cmd=<base64>` (screenshot runs): the renderer types the decoded
// command into the first tab's shell after startup — lets the harness put real
// output into a terminal so buffer-snapshot restore is screenshot-verifiable.
// `--term-scroll=<top|middle>` scrolls the active terminal before capture so
// the overlay scrollbar's extremes/mid-travel are screenshot-verifiable.
const termCmdArg = process.argv.find(a => a.startsWith('--term-cmd=')) || null
const termScrollArg = process.argv.find(a => a.startsWith('--term-scroll=')) || null

// `--window-size=WxH` (screenshot runs): capture at a specific window size so
// layout-dependent behavior (terminal fit/reflow) is verifiable at more than
// the default bounds. Ignored outside screenshot mode; clamped to minimums.
function parseWindowSize(): { width: number; height: number } | null {
	const arg = process.argv.find(a => a.startsWith('--window-size='))?.slice('--window-size='.length)
	const match = arg?.match(/^(\d{3,5})x(\d{3,5})$/)
	if (!match) return null
	return { width: Number(match[1]), height: Number(match[2]) }
}
const windowSizeArg = parseWindowSize()

app.setName(APP_NAME)
// Must run before anything touches userData so a screenshot run never fights a
// running Helm instance over the same profile (locks, window-state writes).
// --user-data-dir=<path> is the STABLE variant: two harness runs sharing one
// profile can verify relaunch behavior (session registry, parked terminals).
const userDataDirArg = process.argv.find(a => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
if (userDataDirArg) {
	fs.mkdirSync(path.resolve(userDataDirArg), { recursive: true })
	app.setPath('userData', path.resolve(userDataDirArg))
} else if (process.argv.includes('--user-data-dir-tmp')) {
	app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'helm-')))
}

const appProfiles = new AppProfileStore(app.getPath('userData'))
let sessionProfileId = appProfiles.activeProfileId()
let sessionProfileGeneration = 0
const sessionProfileToken = () => `${sessionProfileId}:${sessionProfileGeneration}`
const acceptsSessionToken = (token: unknown) => token === sessionProfileToken()
sessions.configureSessionProfile(sessionProfileId)

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
const startupOpenItem = process.argv.find(argument => argument.startsWith('--open-item='))?.slice('--open-item='.length)
function decodeStartupOpenItem(raw: string | undefined): string | null {
	if (!raw) return null
	try {
		const decoded = decodeURIComponent(raw)
		return decoded && !decoded.includes('/') ? decoded : null
	} catch {
		return null
	}
}
let pendingOpenItemId: string | null = decodeStartupOpenItem(startupOpenItem)
let pendingProfileDestination: HelmItemDestination | null = null
let pendingProfileReady: { profileId: string; promise: Promise<void> } | null = null

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
async function routeDestination(destination: HelmItemDestination): Promise<void> {
	if (pendingProfileReady) await pendingProfileReady.promise
	if (destination.profileId && destination.profileId !== appProfiles.activeProfileId()) {
		const result = await activateProfile(destination.profileId, destination.itemId)
		if (result.error !== undefined) {
			void dialog.showMessageBox({ type: 'warning', message: 'Could not open Item', detail: result.error })
		}
		return
	}
	deliverOpenItem(destination.itemId)
}

app.on('open-url', (event, url) => {
	event.preventDefault()
	const destination = parseHelmDestination(url)
	if (!destination) return
	if (!app.isReady()) {
		pendingProfileDestination = destination
		return
	}
	void routeDestination(destination)
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
	/** Buffer snapshots (<userData>/buffers): restore-before-attach screen state. */
	buffers: BufferStore
}

let sessionSupport: SessionSupport | null | undefined

function getSessionSupport(): SessionSupport | null {
	if (sessionSupport !== undefined) return sessionSupport
	// Screenshot runs are non-persistent (a throwaway capture must not leave
	// detached shells behind) UNLESS HELM_SOCKET_DIR points at an isolated test
	// pool — that combination exists so the dtach reattach path (restore → fit
	// → pty resize → WINCH) is screenshot-verifiable without touching the real
	// /tmp/helm-<uid> sessions.
	if ((screenshotPath && !process.env.HELM_SOCKET_DIR) || process.platform === 'win32') {
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
	// Over-long socket dirs (AF_UNIX sun_path cap) would mint sessions whose
	// liveness can never be probed again (node EINVALs the connect while dtach
	// happily serves) — the next launch would see live masters as dead. Refuse
	// persistence up front instead.
	if (!sessions.socketDirUsable()) {
		console.warn(
			`[helm] socket dir path too long for unix sockets (${sessions.socketDir()}) — terminals will not survive restarts`,
		)
		sessionSupport = null
		return null
	}
	sessions.ensureSocketDir()
	const profileDir = appProfiles.profileDir(sessionProfileId)
	sessionSupport = {
		dtach,
		registry: new sessions.SessionRegistry(path.join(profileDir, 'sessions.json')),
		buffers: new BufferStore(path.join(profileDir, 'buffers')),
	}
	return sessionSupport
}

// Soft close: explicit tab close detaches the client and arms this timer; the
// session dies only when it fires (okena soft_close.rs semantics; 5s default
// from okena settings.rs:494). Undo cancels the timer and the tab reattaches.
const graceCloseSupports = new Map<string, SessionSupport | null>()
const graceCloser = new sessions.GraceCloser(sessions.closeGraceMs(), sessionId => {
	const support = graceCloseSupports.get(sessionId) ?? null
	graceCloseSupports.delete(sessionId)
	support?.registry.remove(sessionId)
	// The session is truly dead now — its buffer snapshot dies with it.
	support?.buffers.remove(sessionId)
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
	graceCloseSupports.clear()
	// Clear the map BEFORE killing: the pty onExit handler treats "still in the
	// map" as exited-on-its-own and reaps the session — a detach-kill must never
	// be reapable (see the onExit comment).
	const entries = [...ptys.values()]
	ptys.clear()
	for (const entry of entries) {
		try {
			entry.proc.kill()
		} catch {
			// already exited
		}
	}
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

// --- Buffer snapshot flush (quit path) --------------------------------------------

// The renderer owns serialization, so quitting must round-trip: main asks
// (buffers:flush), the renderer serializes + saves every session-backed tab,
// then acks (buffers:flushed). Bounded by a timeout — a hung renderer can't
// wedge quit, it just costs at most the last autosave interval of output.
const BUFFER_FLUSH_TIMEOUT_MS = 800

function flushRendererBuffers(win: BrowserWindow, timeoutMs: number): Promise<void> {
	return new Promise(resolve => {
		if (win.isDestroyed() || win.webContents.isDestroyed() || !getSessionSupport()) {
			resolve()
			return
		}
		const expectedProfileToken = sessionProfileToken()
		let settled = false
		const finish = (): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			ipcMain.removeListener('buffers:flushed', onFlushed)
			resolve()
		}
		const onFlushed = (_event: Electron.IpcMainEvent, profileToken: unknown): void => {
			if (profileToken === expectedProfileToken) finish()
		}
		const timer = setTimeout(finish, timeoutMs)
		ipcMain.on('buffers:flushed', onFlushed)
		win.webContents.send('buffers:flush', expectedProfileToken)
	})
}

/** True once app.quit() started — a flush-intercepted close must resume QUIT, not just re-close. */
let quitRequested = false

// --- Screenshot harness ----------------------------------------------------------

const SCREENSHOT_SETTLE_MS = 3000
const SCREENSHOT_LOAD_TIMEOUT_MS = 20_000
const SCREENSHOT_FLUSH_TIMEOUT_MS = 1500

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
					// Screenshot runs exit via app.exit (no window close events), so
					// the buffer flush must happen here — a persistent-pool run
					// (HELM_SOCKET_DIR) relies on it to verify snapshot restore.
					void flushRendererBuffers(win, SCREENSHOT_FLUSH_TIMEOUT_MS).then(() => {
						killAllPtyClients()
						app.exit(0)
					})
				})
				.catch(fail)
		}, SCREENSHOT_SETTLE_MS)
	})
}

function createWindow(): void {
	// Screenshot runs use fixed bounds (default or --window-size) for
	// deterministic captures.
	const state = screenshotPath
		? {
				width: Math.max(MIN_WIDTH, windowSizeArg?.width ?? DEFAULT_BOUNDS.width),
				height: Math.max(MIN_HEIGHT, windowSizeArg?.height ?? DEFAULT_BOUNDS.height),
			}
		: restoreWindowState()
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
			...(uiPreviewArg || uiThemeArg || termCmdArg || termScrollArg
				? {
						additionalArguments: [uiPreviewArg, uiThemeArg, termCmdArg, termScrollArg].filter(
							(arg): arg is string => arg !== null,
						),
					}
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
	// Quit/close buffer flush: serialize every tab's screen BEFORE the renderer
	// (and its xterm instances) is torn down — dtach preserves processes, not
	// screens, so this snapshot is what the next launch paints. Intercept once,
	// flush (bounded), then resume the close/quit that was interrupted.
	let buffersFlushed = false
	win.on('close', event => {
		if (buffersFlushed) return
		event.preventDefault()
		void flushRendererBuffers(win, BUFFER_FLUSH_TIMEOUT_MS).then(() => {
			buffersFlushed = true
			if (win.isDestroyed()) return
			if (quitRequested) app.quit()
			else win.close()
		})
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

let profileSwitchInProgress = false

async function syncProfilesFromDaemon(): Promise<void> {
	const result = await helmBridge.listProfiles()
	if (result.error !== undefined) return
	appProfiles.applyDaemonState(result.data)
	sessionProfileId = appProfiles.activeProfileId()
	sessions.configureSessionProfile(sessionProfileId)
}

async function activateProfile(
	profileId: string,
	openItemId?: string,
): Promise<Awaited<ReturnType<HelmBridge['activateProfile']>>> {
	if (profileSwitchInProgress) return { error: 'A profile switch is already in progress.' }
	if (profileId === appProfiles.activeProfileId()) {
		const listed = await helmBridge.listProfiles()
		if (listed.error !== undefined) return listed
		return { data: { state: listed.data, applied: true } }
	}
	// Acquire before the first await: menu, Settings, and deep-link activation
	// can otherwise overlap and commit conflicting active-profile pointers.
	profileSwitchInProgress = true
	if (!runContextWindows.prepareForProfileSwitch()) {
		profileSwitchInProgress = false
		return { error: 'Save or discard the open Run Context draft before switching profiles.' }
	}
	if (mainWindow && !mainWindow.isDestroyed()) await flushRendererBuffers(mainWindow, BUFFER_FLUSH_TIMEOUT_MS)
	// Fence before asking the daemon to switch: an old renderer must never see or
	// command the target profile during the activation response window.
	const profileReady = helmBridge.beginProfileSwitch(profileId)
	sessionProfileGeneration += 1
	const result = await helmBridge.activateProfile(profileId)
	if (result.error !== undefined) {
		sessionProfileGeneration -= 1
		helmBridge.cancelProfileSwitch()
		profileSwitchInProgress = false
		return result
	}
	try {
		appProfiles.applyDaemonState(result.data.state)
	} catch (err) {
		// Continue the in-memory switch safely; the daemon pointer is already
		// committed and the profile id—not its display name—owns every path.
		console.error('[helm] Could not persist app profile cache:', err)
	}

	// Detach old-profile clients only after daemon activation succeeds. dtach
	// masters keep running; the reloaded renderer restores the target profile.
	sessionSupport?.registry.flush()
	killAllPtyClients()
	sessionSupport = undefined
	sessionProfileId = profileId
	sessions.configureSessionProfile(profileId)
	pendingProfileReady = { profileId, promise: profileReady }
	buildMenu()

	const win = mainWindow
	if (win && !win.isDestroyed()) win.webContents.reload()
	else createWindow()
	void profileReady.then(() => {
		if (pendingProfileReady?.profileId === profileId) pendingProfileReady = null
		profileSwitchInProgress = false
		if (openItemId) deliverOpenItem(openItemId)
	})
	return result
}

function profileMenu(): Electron.MenuItemConstructorOptions {
	const state = appProfiles.getState()
	return {
		label: 'Profile',
		submenu: state.profiles
			.filter(profile => profile.archivedAt === null)
			.map(profile => ({
				label: profile.name,
				type: 'radio' as const,
				checked: profile.id === state.activeProfileId,
				click: () => {
					void activateProfile(profile.id).then(result => {
						if (result.error === undefined) return
						void dialog.showMessageBox({ type: 'warning', message: 'Could not switch profiles', detail: result.error })
					})
				},
			})),
	}
}

function buildMenu(): void {
	const send =
		(channel: string, ...args: unknown[]) =>
		() =>
			mainWindow?.webContents.send(channel, ...args)
	const closeFocused = () => {
		const focused = BrowserWindow.getFocusedWindow()
		if (focused && focused !== mainWindow) focused.close()
		else mainWindow?.webContents.send('tab:close')
	}
	const template: Electron.MenuItemConstructorOptions[] = [
		...(process.platform === 'darwin' ? [macApplicationMenu(profileMenu())] : [profileMenu()]),
		{
			label: 'Shell',
			submenu: [
				{ label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: send('tab:new') },
				// Main window: close its active terminal. Auxiliary editor: close that
				// window through its unsaved-draft guard instead of touching a terminal.
				{ label: 'Close', accelerator: 'CmdOrCtrl+W', click: closeFocused },
				// Park the active tab (iTerm "bury session" analog): the tab leaves
				// the strip, the terminal + pty stay alive behind the strip-right
				// stack button. Renderer owns the actual park (tab state lives there).
				{ label: 'Move Terminal to Background', accelerator: 'CmdOrCtrl+Shift+B', click: send('tab:background') },
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
	profileToken: string
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
	if (!acceptsSessionToken(args.profileToken)) throw new Error('Terminal profile changed — reload and try again')
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
		if (!contents.isDestroyed()) contents.send('pty:data', id, data, args.profileToken)
	})
	proc.onExit(({ exitCode }) => {
		// Only a pty still in the map exited ON ITS OWN (shell `exit`, external
		// kill). Every helm-initiated kill — quit detach (killAllPtyClients),
		// hard kill (pty:kill), soft close (session:close-with-grace) — removes
		// the entry BEFORE killing and owns its own session teardown, so it must
		// not be reaped here: quit means detach, and a probe false negative on
		// the way out used to get a LIVE session's socket unlinked (the
		// vanishing-socket bug — quit destroyed what persistence was supposed
		// to keep).
		const selfExit = ptys.has(id)
		ptys.delete(id)
		if (selfExit && sessionId && support) {
			const sid = sessionId
			void sessions.reapSessionIfDead(sid).then(dead => {
				if (dead) {
					support.registry.remove(sid)
					support.buffers.remove(sid)
				}
			})
		}
		if (!contents.isDestroyed()) contents.send('pty:exit', id, exitCode, args.profileToken)
	})
	return { id, sessionId }
})

ipcMain.on('pty:write', (_event, id: number, data: string, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken)) return
	ptys.get(id)?.proc.write(data)
})

ipcMain.on('pty:resize', (_event, id: number, cols: number, rows: number, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken)) return
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
ipcMain.on('pty:kill', (_event, id: number, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken)) return
	const entry = ptys.get(id)
	if (!entry) return
	ptys.delete(id)
	if (entry.sessionId) {
		const sid = entry.sessionId
		const support = getSessionSupport()
		graceCloser.undo(sid) // a hard kill supersedes any pending grace timer
		graceCloseSupports.delete(sid)
		void sessions.killSession(sid).then(() => {
			support?.registry.remove(sid)
			support?.buffers.remove(sid)
		})
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
ipcMain.handle('session:close-with-grace', (_event, id: number, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken)) return null
	const entry = ptys.get(id)
	if (!entry) return null
	ptys.delete(id)
	try {
		entry.proc.kill()
	} catch {
		// already exited
	}
	if (!entry.sessionId) return null
	graceCloseSupports.set(entry.sessionId, getSessionSupport())
	graceCloser.schedule(entry.sessionId)
	return { sessionId: entry.sessionId, graceMs: graceCloser.graceMs }
})

// Undo a soft close: cancel the pending kill. True = session untouched, the
// renderer may reattach it as a new tab. False = timer already fired (or
// nothing pending) — nothing to restore.
ipcMain.handle('session:undo-close', (_event, sessionId: unknown, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken) || !sessions.isValidSessionId(sessionId)) return false
	const undone = graceCloser.undo(sessionId)
	if (undone) graceCloseSupports.delete(sessionId)
	return undone
})

// Startup restore: live sessions from the socket dir (stale sockets GC'd),
// labeled from the registry. The renderer reattaches one tab per entry.
ipcMain.handle('sessions:list', async (_event, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken)) return []
	const support = getSessionSupport()
	if (!support) return []
	const { live, unknownIds } = await sessions.scanSessions()
	// Registry loss must not make surviving dtach sessions permanently
	// unnameable/unorderable: cosmetic writers correctly ignore unknown ids, so
	// adopt every definitively-live socket before returning it to the renderer.
	for (const session of live) support.registry.ensure(session.sessionId, session.createdAt)
	// Retention = live ∪ unknown-probe: a probe timeout must not cost a live
	// session its registry metadata (title/customName/parked) — that was a real
	// loss path: prune-on-unknown left long-lived sessions restoring as "zsh".
	const retainIds = new Set([...live.map(s => s.sessionId), ...unknownIds])
	// Buffer-snapshot orphan sweep: keep snapshots for retained sessions plus
	// parked registry entries; everything else — killed while the app was
	// closed, dead-socket GC — is deleted with its session. Computed BEFORE
	// prune(), which drops non-retained registry entries.
	const keepSnapshots = new Set(retainIds)
	for (const id of support.registry.ids()) {
		if (support.registry.get(id)?.parked === true) keepSnapshots.add(id)
	}
	support.buffers.removeOrphans(keepSnapshots)
	support.registry.prune(retainIds)
	return live
		.map(s => ({
			sessionId: s.sessionId,
			title: support.registry.get(s.sessionId)?.lastTitle ?? null,
			// Manual rename pin — wins over lastTitle in the renderer, OSC-immune.
			customName: support.registry.get(s.sessionId)?.customName ?? null,
			// Parked sessions restore as parked (popover rows), never as strip tabs.
			parked: support.registry.get(s.sessionId)?.parked === true,
			// Registry createdAt (original spawn) beats socket birthtime for ordering.
			createdAt: support.registry.get(s.sessionId)?.createdAt ?? s.createdAt,
			order: support.registry.get(s.sessionId)?.order,
		}))
		.sort(sessions.compareSessionOrder)
		.map(({ sessionId, title, customName, parked }) => ({ sessionId, title, customName, parked }))
})

// Park/unpark a session in the registry so background terminals survive a
// relaunch as background terminals (renderer owns the in-memory tab state).
ipcMain.on('session:set-parked', (_event, sessionId: unknown, parked: unknown, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken) || !sessions.isValidSessionId(sessionId) || typeof parked !== 'boolean') return
	getSessionSupport()?.registry.setParked(sessionId, parked)
})

ipcMain.on('session:set-order', (_event, sessionIds: unknown, profileToken: unknown) => {
	if (
		!acceptsSessionToken(profileToken) ||
		!Array.isArray(sessionIds) ||
		sessionIds.length > 100 ||
		!sessionIds.every(sessions.isValidSessionId)
	)
		return
	getSessionSupport()?.registry.setOrder(sessionIds)
})

ipcMain.on('session:title', (_event, sessionId: unknown, title: unknown, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken) || !sessions.isValidSessionId(sessionId) || typeof title !== 'string') return
	getSessionSupport()?.registry.setTitle(sessionId, title)
})

// Manual rename pin: persist so the name survives relaunch/park; null clears.
ipcMain.on('session:set-custom-name', (_event, sessionId: unknown, name: unknown, profileToken: unknown) => {
	if (
		!acceptsSessionToken(profileToken) ||
		!sessions.isValidSessionId(sessionId) ||
		(name !== null && typeof name !== 'string')
	)
		return
	getSessionSupport()?.registry.setCustomName(sessionId, name)
})

// --- Terminal buffer snapshots (app/src/buffers.ts) ------------------------------
// The renderer serializes (it owns the Terminal); main owns the file IO. Saves
// are fire-and-forget and size-capped in the store; reads happen once per
// reattach, BEFORE the live pty stream is written into the fresh xterm.

ipcMain.on('buffer:save', (_event, sessionId: unknown, data: unknown, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken)) return
	const support = getSessionSupport()
	if (!support || !sessions.isValidSessionId(sessionId) || typeof data !== 'string') return
	support.buffers.save(sessionId, data)
})

ipcMain.handle('buffer:read', (_event, sessionId: unknown, profileToken: unknown) => {
	if (!acceptsSessionToken(profileToken)) return null
	const support = getSessionSupport()
	if (!support || !sessions.isValidSessionId(sessionId)) return null
	return support.buffers.read(sessionId)
})

ipcMain.on('config:get', event => {
	event.returnValue = { daemonUrl, sessionProfileToken: sessionProfileToken() }
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
runContextWindows.registerIpc()

function applyProfileMutation(result: Awaited<ReturnType<HelmBridge['createProfile']>>): void {
	if (result.error !== undefined) return
	appProfiles.applyDaemonState(result.data.state)
	buildMenu()
	for (const window of BrowserWindow.getAllWindows()) window.webContents.send('profiles:changed')
}

const staleProfileRenderer = (token: unknown) =>
	acceptsSessionToken(token) ? null : { error: 'Profile changed — reload Helm and try again.', status: 409 }

ipcMain.handle('profiles:list', async (_event, profileToken: unknown) => {
	if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
	const result = await helmBridge.listProfiles()
	if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
	if (result.error === undefined) {
		appProfiles.applyDaemonState(result.data)
		buildMenu()
	}
	return result
})
ipcMain.handle('profiles:create', async (_event, name: string, enabledProjects: string[], profileToken: unknown) => {
	if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
	const result = await helmBridge.createProfile(name, enabledProjects)
	if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
	applyProfileMutation(result)
	return result
})
ipcMain.handle(
	'profiles:update',
	async (_event, id: string, body: { name?: string; enabledProjects?: string[] }, profileToken: unknown) => {
		if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
		const result = await helmBridge.updateProfile(id, body)
		if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
		applyProfileMutation(result)
		return result
	},
)
ipcMain.handle('profiles:archive', async (_event, id: string, profileToken: unknown) => {
	if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
	const result = await helmBridge.archiveProfile(id)
	if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
	applyProfileMutation(result)
	return result
})
ipcMain.handle('profiles:restore', async (_event, id: string, profileToken: unknown) => {
	if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
	const result = await helmBridge.restoreProfile(id)
	if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
	applyProfileMutation(result)
	return result
})
ipcMain.handle('profiles:activate', (_event, id: string, profileToken: unknown) => {
	if (staleProfileRenderer(profileToken)) return staleProfileRenderer(profileToken)
	return activateProfile(id)
})

void app.whenReady().then(async () => {
	app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })
	await syncProfilesFromDaemon()
	buildMenu()
	helmBridge.start()
	createWindow()
	if (pendingProfileDestination) {
		const destination = pendingProfileDestination
		pendingProfileDestination = null
		void routeDestination(destination)
	}
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

app.on('window-all-closed', () => {
	killAllPtyClients()
	app.quit()
})

// Quit detaches (clients die, dtach sessions live on for the next launch) —
// the pre-dtach behavior of killing the shells is gone by design. Buffer
// snapshots are flushed by the window-close interception (the renderer still
// holds every xterm buffer after the clients detach).
app.on('before-quit', event => {
	if (runContextWindows.hasDirtyWindows()) {
		// Keep the main window, bridge, and attached dtach clients alive until
		// every dirty editor explicitly saves/discards. Keep editing cancels quit.
		event.preventDefault()
		pendingEditorQuit = true
		quitRequested = false
		runContextWindows.requestCloseAll()
		return
	}
	quitRequested = true
})

app.on('will-quit', () => {
	helmBridge.stop()
	killAllPtyClients()
	sessionSupport?.registry.flush()
})
