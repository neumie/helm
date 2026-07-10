import { app, BrowserWindow, Menu, ipcMain, screen, shell, webFrameMain } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as pty from 'node-pty'
import { dashEmbedScript } from './dash-embed'
import * as sessions from './sessions'

const daemonUrl = process.env.VIGIL_URL ?? 'http://localhost:7474'
const daemonOrigin = (() => {
	try {
		return new URL(daemonUrl).origin
	} catch {
		return null
	}
})()

// --- CLI modes ---------------------------------------------------------------
// `electron . --screenshot=<path> [--user-data-dir-tmp]` renders the window
// without focusing it, waits for the dashboard iframe + shell prompt to paint,
// writes a full-window PNG, and exits 0.
const screenshotPath =
	process.argv.find((a) => a.startsWith('--screenshot='))?.slice('--screenshot='.length) || null

app.setName('Helm')
// Must run before anything touches userData so a screenshot run never fights a
// running Helm instance over the same profile (locks, window-state writes).
if (process.argv.includes('--user-data-dir-tmp')) {
	app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'helm-')))
}

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
const graceCloser = new sessions.GraceCloser(sessions.closeGraceMs(), (sessionId) => {
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
			const visible = screen.getAllDisplays().some((d) => {
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
	const loadTimeout = setTimeout(
		() => fail(new Error('window never finished loading')),
		SCREENSHOT_LOAD_TIMEOUT_MS,
	)
	// Listener attaches before loadFile is called, so the load event cannot be missed.
	win.webContents.once('did-finish-load', () => {
		clearTimeout(loadTimeout)
		// Settle so the dashboard iframe (or its waiting card) and the shell prompt paint.
		setTimeout(() => {
			win.webContents
				.capturePage()
				.then((image) => {
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
		},
	})
	// Terminal web-links + dashboard target=_blank links open in the default browser, never a new Electron window.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) void shell.openExternal(url)
		return { action: 'deny' }
	})
	// Re-skin the embedded vigil dashboard on every load of its (cross-origin)
	// iframe — the renderer can't reach into that document, only main can.
	win.webContents.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
		if (isMainFrame || !daemonOrigin) return
		try {
			const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
			if (!frame || new URL(frame.url).origin !== daemonOrigin) return
			// Frame may navigate away mid-flight; the next load re-injects.
			frame.executeJavaScript(dashEmbedScript()).catch(() => {})
		} catch {
			// about:blank / destroyed frame — nothing to style
		}
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
	void win.loadFile(path.join(__dirname, 'index.html'))
	mainWindow = win
}

function buildMenu(): void {
	const send = (channel: string) => () => mainWindow?.webContents.send(channel)
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
		{ role: 'viewMenu' },
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
	proc.onData((data) => {
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
			void sessions.reapSessionIfDead(sid).then((dead) => {
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
	support.registry.prune(new Set(live.map((s) => s.sessionId)))
	return live
		.map((s) => ({
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

ipcMain.on('config:get', (event) => {
	event.returnValue = { daemonUrl }
})

ipcMain.handle('daemon:ping', async () => {
	try {
		const res = await fetch(daemonUrl, { signal: AbortSignal.timeout(2000) })
		return res.ok
	} catch {
		return false
	}
})

void app.whenReady().then(() => {
	app.setAboutPanelOptions({ applicationName: 'Helm', applicationVersion: app.getVersion() })
	buildMenu()
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
	killAllPtyClients()
	sessionSupport?.registry.flush()
})
