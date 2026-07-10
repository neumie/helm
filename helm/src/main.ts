import { app, BrowserWindow, Menu, ipcMain, screen, shell, webFrameMain } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as pty from 'node-pty'
import { dashEmbedScript } from './dash-embed'

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

const ptys = new Map<number, pty.IPty>()
let nextPtyId = 1
let mainWindow: BrowserWindow | null = null

function defaultShell(): string {
	if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe'
	return process.env.SHELL ?? '/bin/zsh'
}

function killAllPtys(): void {
	for (const p of ptys.values()) {
		try {
			p.kill()
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
		killAllPtys()
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
					killAllPtys()
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
		killAllPtys()
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
	const proc = pty.spawn(defaultShell(), process.platform === 'win32' ? [] : ['-l'], {
		name: 'xterm-256color',
		cols: Math.max(2, Math.floor(args.cols) || 80),
		rows: Math.max(2, Math.floor(args.rows) || 24),
		cwd: os.homedir(),
		env: shellEnv(),
	})
	ptys.set(id, proc)
	const contents = event.sender
	proc.onData((data) => {
		if (!contents.isDestroyed()) contents.send('pty:data', id, data)
	})
	proc.onExit(({ exitCode }) => {
		ptys.delete(id)
		if (!contents.isDestroyed()) contents.send('pty:exit', id, exitCode)
	})
	return id
})

ipcMain.on('pty:write', (_event, id: number, data: string) => {
	ptys.get(id)?.write(data)
})

ipcMain.on('pty:resize', (_event, id: number, cols: number, rows: number) => {
	const proc = ptys.get(id)
	if (!proc || !(cols > 0) || !(rows > 0)) return
	try {
		proc.resize(Math.floor(cols), Math.floor(rows))
	} catch {
		// pty already exited
	}
})

ipcMain.on('pty:kill', (_event, id: number) => {
	const proc = ptys.get(id)
	if (!proc) return
	ptys.delete(id)
	try {
		proc.kill()
	} catch {
		// already exited
	}
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
	killAllPtys()
	app.quit()
})

app.on('before-quit', killAllPtys)
