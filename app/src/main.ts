import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BrowserWindow, Menu, Notification, app, dialog, ipcMain, screen, shell } from 'electron'
import * as pty from 'node-pty'
import { readLocalControlToken } from '../../src/auth/local-control'
import { scheduledSessionId, scheduledSocketPath } from '../../src/scheduled-runs/session-path'
import { APP_NAME, macApplicationMenu } from './app-menu'
import { BufferStore } from './buffers'
import { parseExternalHttpUrl } from './external-url'
import { HelmBridge } from './helm-bridge'
import { ProfileSwitchCoordinator } from './profile-switch'
import { reloadOrCreateProfileWindow } from './profile-window-load'
import { AppProfileStore } from './profiles'
import { parseHelmDestination } from './protocol'
import type { HelmItemDestination } from './protocol'
import { RunContextWindows } from './run-context-window'
import {
	ScheduledAttentionAdoptionCoordinator,
	type ScheduledSessionOwnership,
	scheduledDtachAttachArgs,
} from './scheduled-adoption-main'
import { ScheduledAttentionNotifier } from './scheduled-attention-notifier'
import { ElectronResidencyController } from './scheduled-residency'
import { createSessionIpcGate } from './session-ipc-gate'
import * as sessions from './sessions'
import type { TerminalTransferEvent } from './shared'
import type { HelmResult, ProfileActivationResult, ProfilesState } from './shared-helm'
import { createTerminalTransferIpcGate } from './terminal-transfer-ipc-gate'
import { TerminalTransferMainAdapter, type TerminalTransferProfileStorage } from './terminal-transfer-main'
import { THEME_PRESETS } from './theme-presets'

// HELM_URL preferred; VIGIL_URL still honored (legacy compat).
const daemonUrl = process.env.HELM_URL ?? process.env.VIGIL_URL ?? 'http://localhost:7474'

// Single owner of daemon HTTP: one poller + command proxy, pushed to the
// renderer over IPC (the file:// renderer can't fetch :7474 itself).
const helmBridge = new HelmBridge(daemonUrl, token => token === sessionProfileToken())
// Main-owned only: its local-control token and resident capability never cross IPC.
const scheduledResidency = new ElectronResidencyController({
	request: helmBridge.scheduledResidentLease.bind(helmBridge),
})
let profileSwitchCoordinator: ProfileSwitchCoordinator | null = null
let activeProfileSwitch: Promise<HelmResult<ProfileActivationResult>> | null = null
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
	canOpen: () => !profileSwitchCoordinator?.isSwitching(),
})

// --- CLI modes ---------------------------------------------------------------
// `electron . --screenshot=<path> [--user-data-dir-tmp]` renders the window
// without focusing it, waits for the sidebar + shell prompt to paint,
// writes a full-window PNG, and exits 0.
const screenshotPath = process.argv.find(a => a.startsWith('--screenshot='))?.slice('--screenshot='.length) || null
// Explicit release-canary mode. It is deliberately main-process-only and is
// never exposed through preload or the ordinary renderer bridge.
const profileSwitchAttestationPath =
	process.argv
		.find(a => a.startsWith('--profile-switch-attestation='))
		?.slice('--profile-switch-attestation='.length) || null
const profileSwitchAttestationMarker =
	process.argv
		.find(a => a.startsWith('--profile-switch-attestation-marker='))
		?.slice('--profile-switch-attestation-marker='.length) || null
const profileSwitchAttestationMode = profileSwitchAttestationPath !== null

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
let authoritativeProfilesState: ProfilesState = {
	version: 1,
	generation: 0,
	activeProfileId: sessionProfileId,
	profiles: appProfiles.getState().profiles,
}
/** Closed across daemon commitment until the target socket namespace is installed. */
let sessionIpcAdmissionOpen = true
const sessionProfileToken = () => `${sessionProfileId}:${sessionProfileGeneration}`
const acceptsSessionToken = (token: unknown) => token === sessionProfileToken()
const acceptsSessionIpcToken = (token: unknown) => sessionIpcAdmissionOpen && acceptsSessionToken(token)
const sessionIpcGate = createSessionIpcGate(acceptsSessionIpcToken)
// Transfer preflight is narrower than ordinary terminal IPC: it also requires
// the current main renderer. A future move must add the controller's complete
// snapshot/detach/attach capability hand-off before any move channel exists.
const terminalTransferIpcGate = createTerminalTransferIpcGate(
	acceptsSessionIpcToken,
	() => mainWindow?.webContents ?? null,
)
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
if (!screenshotPath && !profileSwitchAttestationMode) {
	for (const scheme of ['helm', 'vigil']) {
		if (!app.setAsDefaultProtocolClient(scheme)) {
			console.warn(`[helm] could not register as ${scheme}:// handler (unpackaged dev run?)`)
		}
	}
}

/** Deep link that arrived before the window/renderer was ready; delivered on load. */
let rendererProfileEpoch: number | null = null
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
let pendingOpenItem: { itemId: string; epoch: number | null } | null = (() => {
	const itemId = decodeStartupOpenItem(startupOpenItem)
	return itemId ? { itemId, epoch: null } : null
})()
let pendingProfileDestination: HelmItemDestination | null = null
/** Profile-qualified destinations are serialized so a late link cannot supersede an unknown explicit switch. */
let deepLinkDelivery: Promise<void> = Promise.resolve()

function deliverOpenItem(itemId: string, epoch: number | null = null): void {
	pendingOpenItem = { itemId, epoch }
	const win = mainWindow
	if (!win || win.isDestroyed()) {
		if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow()
		return
	}
	if (win.isMinimized()) win.restore()
	win.show()
	win.focus()
	if (!win.webContents.isLoading()) flushPendingOpenItem(win, epoch)
}

function flushPendingOpenItem(win: BrowserWindow, loadEpoch: number | null = rendererProfileEpoch): void {
	const pending = pendingOpenItem
	if (!pending || win.isDestroyed()) return
	// A prior renderer load may finish after a newer switch; it may neither
	// deliver nor clear the newer operation's requested Item.
	if (pending.epoch !== null && pending.epoch !== loadEpoch) return
	try {
		win.webContents.send('nav:open-item', pending.itemId)
		if (pendingOpenItem === pending) pendingOpenItem = null
	} catch (error) {
		console.warn('[helm] Could not deliver pending Item; retaining it for the next renderer load:', error)
	}
}

// macOS delivers protocol launches/activations here (registered before `ready`
// so a cold-start URL isn't missed). Windows/Linux would need a
// single-instance lock + `second-instance` argv scan instead — not wired.
async function routeDestination(destination: HelmItemDestination): Promise<void> {
	// A completion may itself be superseded. Loop until the authoritative
	// coordinator has no admitted operation before considering a deep-link switch.
	while (activeProfileSwitch) {
		const pending = activeProfileSwitch
		await pending
		if (activeProfileSwitch === pending) await Promise.resolve()
	}
	if (destination.profileId && destination.profileId !== appProfiles.activeProfileId()) {
		const result = await activateProfile(destination.profileId, destination.itemId)
		if (result.error !== undefined) {
			void dialog.showMessageBox({
				type: 'warning',
				message: 'Could not open Item',
				detail: result.error,
			})
		}
		return
	}
	deliverOpenItem(destination.itemId)
}

function enqueueDestination(destination: HelmItemDestination): void {
	deepLinkDelivery = deepLinkDelivery
		.catch(error => console.warn('[helm] previous deep-link delivery failed:', error))
		.then(() => routeDestination(destination))
}

app.on('open-url', (event, url) => {
	event.preventDefault()
	const destination = parseHelmDestination(url)
	if (!destination) return
	if (!app.isReady()) {
		pendingProfileDestination = destination
		return
	}
	enqueueDestination(destination)
})

interface PtyEntry {
	proc: pty.IPty
	/** Backing dtach session; null = plain non-persistent shell. */
	sessionId: string | null
	/** Scheduled clients detach only; they never signal/unlink another owner’s master. */
	backing: sessions.SessionBacking
	profileToken: string
	ready: boolean
	pendingOutput: string[]
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
let scheduledAdoption: ScheduledAttentionAdoptionCoordinator | null = null
let scheduledAttentionNotifier: ScheduledAttentionNotifier | null = null
let terminalTransferMain: TerminalTransferMainAdapter | null = null
let terminalTransferRecovery: Promise<void> = Promise.resolve()
const pendingTerminalTransferEvents = new Map<
	string,
	{
		sender: Electron.WebContents
		resolve: (value: unknown) => void
		reject: (error: Error) => void
		timer: NodeJS.Timeout
	}
>()

function dispatchTerminalTransferEvent(sender: Electron.WebContents, event: TerminalTransferEvent): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (sender.isDestroyed() || !terminalTransferIpcGate.allows(sender, event.profileToken)) {
			reject(new Error('source renderer is unavailable'))
			return
		}
		const timer = setTimeout(() => {
			pendingTerminalTransferEvents.delete(event.transactionId)
			reject(new Error('terminal transfer renderer acknowledgement timed out'))
		}, 5_000)
		pendingTerminalTransferEvents.set(event.transactionId, { sender, resolve, reject, timer })
		sender.send('terminal-transfer:event', event)
	})
}

/** Detach only Helm's client; resolve after its final data/exit events, never kill the dtach master. */
async function detachPtyForTransfer(sessionId: string): Promise<boolean> {
	for (const [ptyId, entry] of ptys) {
		if (entry.sessionId !== sessionId) continue
		ptys.delete(ptyId)
		return new Promise(resolve => {
			let settled = false
			const finish = (detached: boolean): void => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				exitListener.dispose()
				resolve(detached)
			}
			const exitListener = entry.proc.onExit(() => finish(true))
			const timer = setTimeout(() => finish(false), 2_000)
			try {
				entry.proc.kill()
			} catch {
				// Kill did not begin, so restore the still-owned client entry.
				ptys.set(ptyId, entry)
				finish(false)
			}
		})
	}
	return false
}

function getSessionSupport(): SessionSupport | null {
	// Session IPC is closed while the daemon identity is committed but the new
	// socket namespace is not installed. Never resolve mutable profile paths then.
	if (!sessionIpcAdmissionOpen) return null
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

/** Profile-explicit transfer storage; never derive it from mutable active paths. */
function transferStorageForProfile(profileId: string): TerminalTransferProfileStorage | null {
	if (!sessions.isValidSessionProfileId(profileId)) return null
	if (profileId === sessionProfileId) {
		const support = getSessionSupport()
		if (support) {
			return {
				registry: support.registry,
				buffers: support.buffers,
				registryPath: support.registry.filePath,
				bufferDir: path.join(appProfiles.profileDir(profileId), 'buffers'),
			}
		}
	}
	const profileDir = appProfiles.profileDir(profileId)
	return {
		registry: new sessions.SessionRegistry(path.join(profileDir, 'sessions.json')),
		buffers: new BufferStore(path.join(profileDir, 'buffers')),
		registryPath: path.join(profileDir, 'sessions.json'),
		bufferDir: path.join(profileDir, 'buffers'),
	}
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
			if (sessionIpcAdmissionOpen && profileToken === expectedProfileToken) finish()
		}
		const timer = setTimeout(finish, timeoutMs)
		ipcMain.on('buffers:flushed', onFlushed)
		win.webContents.send('buffers:flush', expectedProfileToken)
	})
}

/** True once app.quit() started — a flush-intercepted close must resume QUIT, not just re-close. */
let quitRequested = false
/** Set only after guarded before-quit has stopped resident admission. */
let residencyStoppedForQuit = false

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

function createWindow(): BrowserWindow {
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
	win.webContents.on('did-finish-load', () => {
		flushPendingOpenItem(win, rendererProfileEpoch)
		void scheduledAdoption?.restore(sessionProfileToken())
	})
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
	return win
}

async function syncProfilesFromDaemon(): Promise<void> {
	const result = await helmBridge.listProfiles()
	if (result.error !== undefined) return
	authoritativeProfilesState = result.data
	appProfiles.applyDaemonState(result.data)
	sessionProfileId = result.data.activeProfileId
	sessions.configureSessionProfile(sessionProfileId)
}

const PROFILE_WINDOW_LOAD_TIMEOUT_MS = 15_000

function reloadOrCreateWindowForProfile(epoch: number): Promise<void> {
	rendererProfileEpoch = epoch
	return reloadOrCreateProfileWindow({
		existing: mainWindow,
		createWindow,
		epoch,
		currentEpoch: () => rendererProfileEpoch,
		onLoaded: () => {
			const win = mainWindow
			if (win && !win.isDestroyed()) flushPendingOpenItem(win, epoch)
		},
		timeoutMs: PROFILE_WINDOW_LOAD_TIMEOUT_MS,
	})
}

function installSessionNamespace(profileId: string): void {
	// This is deliberately the only mutable-namespace install seam. It runs
	// while admission is closed; a failure leaves external IPC fail-closed.
	sessionProfileId = profileId
	sessions.configureSessionProfile(profileId)
	sessionSupport = undefined
}

function createProfileSwitchCoordinator(): ProfileSwitchCoordinator {
	return new ProfileSwitchCoordinator({
		currentState: () => authoritativeProfilesState,
		listProfiles: () => helmBridge.listProfiles(),
		beginRunContextDrain: () => runContextWindows.beginProfileSwitchDrain(),
		flushBuffers: () =>
			mainWindow && !mainWindow.isDestroyed()
				? flushRendererBuffers(mainWindow, BUFFER_FLUSH_TIMEOUT_MS)
				: Promise.resolve(),
		beginFence: target => helmBridge.beginProfileSwitch(target),
		advanceLocalGeneration: () => {
			sessionProfileGeneration += 1
		},
		restorePrecommitGeneration: () => {
			sessionProfileGeneration -= 1
		},
		activateDaemon: target => helmBridge.activateProfile(target),
		installAuthoritativeState: state => {
			authoritativeProfilesState = state
			appProfiles.applyDaemonState(state)
		},
		closeSessionIpc: () => {
			sessionIpcAdmissionOpen = false
		},
		flushOldRegistryBestEffort: () => sessionSupport?.registry.flush(),
		detachOldClients: () => {
			killAllPtyClients()
			sessionSupport = undefined
		},
		installSessionNamespace,
		openSessionIpc: () => {
			sessionIpcAdmissionOpen = true
		},
		reloadOrCreateWindow: reloadOrCreateWindowForProfile,
		queueOrDeliverItem: (itemId, epoch) => deliverOpenItem(itemId, epoch),
		refreshMenuBestEffort: buildMenu,
		log: (message, detail) => console.warn(`[helm] ${message}`, detail ?? ''),
	})
}

function activateProfile(profileId: string, openItemId?: string): Promise<HelmResult<ProfileActivationResult>> {
	if (terminalTransferMain?.isBusy()) return Promise.resolve({ error: 'A terminal transfer is in progress.' })
	if (!profileSwitchCoordinator) return Promise.resolve({ error: 'Helm is still starting.' })
	const request = profileSwitchCoordinator.switchTo(profileId, openItemId)
	activeProfileSwitch = request
	void request.finally(() => {
		if (activeProfileSwitch === request) activeProfileSwitch = null
	})
	return request
}

interface ProfileSwitchAttestationEvidence {
	schemaVersion: 1
	result: 'passed' | 'failed'
	platform: string
	startedAt: string
	finishedAt: string
	marker: string
	paths: {
		userDataDir: string
		socketRoot: string
		workSocket: string | null
		targetSocketDir: string | null
	}
	daemon: {
		baseUrl: string
		activationCalls: string[]
		readyProfiles: string[]
		mixedSnapshotObserved: boolean
		snapshotObservations: Array<{
			expectedProfileId: string
			snapshotProfileId: string | null
			authoritativeProfileId: string
			itemProfileIds: string[]
		}>
	}
	window: {
		before: { browserWindowId: number; webContentsId: number } | null
		after: { browserWindowId: number; webContentsId: number } | null
		sameBrowserWindow: boolean
		sameWebContents: boolean
		reloadCount: number
	}
	workSession: {
		sessionId: string | null
		socketPath: string | null
		socketProbeBefore: sessions.SocketProbe | null
		socketProbeAfter: sessions.SocketProbe | null
		socketExistsAfter: boolean
		masterHolderPidsBefore: number[]
		masterHolderPidsAfter: number[]
		preservedMasterPids: number[]
		oldAttachClientPid: number | null
		oldAttachClientDetached: boolean
		newAttachClientPid: number | null
		newAttachClientAlive: boolean
		attachClientReplaced: boolean
	}
	buffer: {
		snapshotContainsMarkerAfterFlush: boolean
		snapshotContainsMarkerAfterReturn: boolean
		rendererMarkerVisibleAfterReturn: boolean
		restoreObservation: 'dom'
	}
	assertions: Record<string, boolean>
	error?: string
}

const ATTESTATION_TIMEOUT_MS = 25_000

function attestationError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function attestationPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function waitForAttestation<T>(label: string, read: () => T | null | Promise<T | null>): Promise<T> {
	const deadline = Date.now() + ATTESTATION_TIMEOUT_MS
	while (Date.now() < deadline) {
		const value = await read()
		if (value !== null) return value
		await new Promise(resolve => setTimeout(resolve, 100))
	}
	throw new Error(`Timed out waiting for ${label}`)
}

function writeAttestationEvidence(file: string, evidence: ProfileSwitchAttestationEvidence): void {
	const resolved = path.resolve(file)
	fs.mkdirSync(path.dirname(resolved), { recursive: true })
	const temporary = `${resolved}.tmp-${process.pid}`
	fs.writeFileSync(temporary, JSON.stringify(evidence, null, 2))
	fs.renameSync(temporary, resolved)
}

/**
 * Flag-gated macOS release canary. It does not add an automation API: its only
 * controls are the normal startup terminal command and production coordinator.
 */
async function runProfileSwitchAttestation(): Promise<void> {
	const marker = profileSwitchAttestationMarker
	if (!profileSwitchAttestationPath || !marker)
		throw new Error('Profile-switch attestation requires an evidence path and marker.')
	const evidence: ProfileSwitchAttestationEvidence = {
		schemaVersion: 1,
		result: 'failed',
		platform: process.platform,
		startedAt: new Date().toISOString(),
		finishedAt: '',
		marker,
		paths: {
			userDataDir: app.getPath('userData'),
			socketRoot: process.env.HELM_SOCKET_DIR ?? '',
			workSocket: null,
			targetSocketDir: null,
		},
		daemon: {
			baseUrl: daemonUrl,
			activationCalls: [],
			readyProfiles: [],
			mixedSnapshotObserved: false,
			snapshotObservations: [],
		},
		window: {
			before: null,
			after: null,
			sameBrowserWindow: false,
			sameWebContents: false,
			reloadCount: 0,
		},
		workSession: {
			sessionId: null,
			socketPath: null,
			socketProbeBefore: null,
			socketProbeAfter: null,
			socketExistsAfter: false,
			masterHolderPidsBefore: [],
			masterHolderPidsAfter: [],
			preservedMasterPids: [],
			oldAttachClientPid: null,
			oldAttachClientDetached: false,
			newAttachClientPid: null,
			newAttachClientAlive: false,
			attachClientReplaced: false,
		},
		buffer: {
			snapshotContainsMarkerAfterFlush: false,
			snapshotContainsMarkerAfterReturn: false,
			rendererMarkerVisibleAfterReturn: false,
			restoreObservation: 'dom',
		},
		assertions: {},
	}
	const observeDaemonSnapshot = (expectedProfileId: string): void => {
		const snapshot = helmBridge.getSnapshot()
		const snapshotProfileId = snapshot.status?.profile?.id ?? null
		const itemProfileIds = [
			...new Set((snapshot.items ?? []).map(item => item.profileId).filter((id): id is string => id !== undefined)),
		]
		const authoritativeProfileId = authoritativeProfilesState.activeProfileId
		const mixed =
			snapshotProfileId !== expectedProfileId ||
			authoritativeProfileId !== expectedProfileId ||
			snapshot.items === null ||
			itemProfileIds.some(id => id !== snapshotProfileId)
		evidence.daemon.snapshotObservations.push({
			expectedProfileId,
			snapshotProfileId,
			authoritativeProfileId,
			itemProfileIds,
		})
		evidence.daemon.mixedSnapshotObserved ||= mixed
		if (mixed) throw new Error(`Mixed daemon snapshot observed while expecting ${expectedProfileId}.`)
	}
	try {
		if (process.platform !== 'darwin') throw new Error('Profile-switch attestation requires macOS.')
		const win = await waitForAttestation('initial BrowserWindow', () => (mainWindow?.isDestroyed() ? null : mainWindow))
		evidence.window.before = {
			browserWindowId: win.id,
			webContentsId: win.webContents.id,
		}
		await waitForAttestation('initial renderer load', () => (!win.webContents.isLoading() ? true : null))
		// Start counting only after the startup document settled; the two profile
		// transitions below must account for exactly two same-webContents reloads.
		win.webContents.on('did-finish-load', () => {
			evidence.window.reloadCount += 1
		})
		const initial = await waitForAttestation('Work dtach client', () => {
			for (const entry of ptys.values()) if (entry.sessionId !== null) return entry
			return null
		})
		const sessionId = initial.sessionId
		if (!sessionId) throw new Error('Initial terminal was not session-backed.')
		const support = getSessionSupport()
		if (!support) throw new Error('dtach session support is unavailable.')
		const workSocket = sessions.socketPath(sessionId)
		evidence.paths.workSocket = workSocket
		evidence.workSession.sessionId = sessionId
		evidence.workSession.socketPath = workSocket
		await waitForAttestation('marker snapshot after normal renderer flush', async () => {
			await flushRendererBuffers(win, BUFFER_FLUSH_TIMEOUT_MS)
			return support.buffers.read(sessionId)?.includes(marker) ? true : null
		})
		evidence.buffer.snapshotContainsMarkerAfterFlush = true
		evidence.workSession.socketProbeBefore = await sessions.probeSocket(workSocket)
		evidence.workSession.masterHolderPidsBefore = await sessions.pidsHoldingSocket(workSocket)
		evidence.workSession.oldAttachClientPid = initial.proc.pid
		if (!attestationPidAlive(initial.proc.pid)) throw new Error('Initial dtach attach client is not alive.')

		const targetId = 'profile-aaaaaaaaaaaa'
		const target = await activateProfile(targetId)
		if (target.error !== undefined) throw new Error(`A → B activation failed: ${target.error}`)
		evidence.daemon.readyProfiles.push(authoritativeProfilesState.activeProfileId)
		observeDaemonSnapshot(targetId)
		evidence.paths.targetSocketDir = sessions.socketDir()
		await waitForAttestation('old Work attach client to detach', () =>
			initial.proc.pid !== undefined && !attestationPidAlive(initial.proc.pid) ? true : null,
		)
		evidence.workSession.oldAttachClientDetached = true
		if ((await sessions.probeSocket(workSocket)) !== 'live') throw new Error('Work dtach socket did not survive A → B.')

		const returned = await activateProfile('work')
		if (returned.error !== undefined) throw new Error(`B → A activation failed: ${returned.error}`)
		evidence.daemon.readyProfiles.push(authoritativeProfilesState.activeProfileId)
		observeDaemonSnapshot('work')
		const returnedEntry = await waitForAttestation('reattached Work dtach client', () => {
			for (const entry of ptys.values()) if (entry.sessionId === sessionId) return entry
			return null
		})
		await waitForAttestation('reattached Work client to become live', () =>
			attestationPidAlive(returnedEntry.proc.pid) ? true : null,
		)
		evidence.window.after = {
			browserWindowId: win.id,
			webContentsId: win.webContents.id,
		}
		evidence.workSession.newAttachClientPid = returnedEntry.proc.pid
		evidence.workSession.newAttachClientAlive = true
		evidence.workSession.attachClientReplaced = returnedEntry.proc.pid !== initial.proc.pid
		evidence.workSession.socketProbeAfter = await sessions.probeSocket(workSocket)
		evidence.workSession.socketExistsAfter = fs.existsSync(workSocket)
		evidence.workSession.masterHolderPidsAfter = await sessions.pidsHoldingSocket(workSocket)
		evidence.workSession.preservedMasterPids = evidence.workSession.masterHolderPidsBefore.filter(
			pid => pid !== initial.proc.pid && attestationPidAlive(pid),
		)
		evidence.buffer.snapshotContainsMarkerAfterReturn =
			getSessionSupport()?.buffers.read(sessionId)?.includes(marker) === true
		evidence.buffer.rendererMarkerVisibleAfterReturn = await waitForAttestation(
			'marker in reloaded terminal DOM',
			async () => {
				const found = await win.webContents.executeJavaScript(
					`(() => { const marker = ${JSON.stringify(marker)}; const nodes = document.querySelectorAll('.xterm-screen, .xterm-accessibility, .xterm-accessibility-tree, .xterm-rows, [aria-label]'); return [...nodes].some(node => (node.textContent || node.getAttribute('aria-label') || '').includes(marker)) || document.body.innerText.includes(marker) })()`,
					true,
				)
				return found ? true : null
			},
		)
		evidence.window.sameBrowserWindow = evidence.window.before.browserWindowId === evidence.window.after.browserWindowId
		evidence.window.sameWebContents = evidence.window.before.webContentsId === evidence.window.after.webContentsId
		evidence.assertions = {
			sameBrowserWindow: evidence.window.sameBrowserWindow,
			sameWebContents: evidence.window.sameWebContents,
			workSocketLive:
				evidence.workSession.socketProbeBefore === 'live' && evidence.workSession.socketProbeAfter === 'live',
			workMasterSurvived: evidence.workSession.preservedMasterPids.length > 0,
			oldAttachDetached: evidence.workSession.oldAttachClientDetached,
			newAttachReattached: evidence.workSession.newAttachClientAlive && evidence.workSession.attachClientReplaced,
			bufferPersisted:
				evidence.buffer.snapshotContainsMarkerAfterFlush && evidence.buffer.snapshotContainsMarkerAfterReturn,
			bufferRestoredInRenderer: evidence.buffer.rendererMarkerVisibleAfterReturn,
			activationOrder: evidence.daemon.readyProfiles.join(',') === `${targetId},work`,
			noMixedSnapshot: !evidence.daemon.mixedSnapshotObserved && evidence.daemon.snapshotObservations.length === 2,
			namespaceIsolation:
				evidence.paths.targetSocketDir !== null && evidence.paths.targetSocketDir !== path.dirname(workSocket),
		}
		if (!Object.values(evidence.assertions).every(Boolean))
			throw new Error('One or more profile-switch assertions failed.')
		evidence.result = 'passed'
	} catch (error) {
		evidence.error = attestationError(error)
	} finally {
		evidence.finishedAt = new Date().toISOString()
		writeAttestationEvidence(profileSwitchAttestationPath, evidence)
	}
	if (evidence.result !== 'passed') throw new Error(evidence.error ?? 'Profile-switch attestation failed.')
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
						void dialog.showMessageBox({
							type: 'warning',
							message: 'Could not switch profiles',
							detail: result.error,
						})
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
				{
					label: 'New Terminal',
					accelerator: 'CmdOrCtrl+T',
					click: send('tab:new'),
				},
				// Main window: close its active terminal. Auxiliary editor: close that
				// window through its unsaved-draft guard instead of touching a terminal.
				{ label: 'Close', accelerator: 'CmdOrCtrl+W', click: closeFocused },
				// Park the active tab (iTerm "bury session" analog): the tab leaves
				// the strip, the terminal + pty stay alive behind the strip-right
				// stack button. Renderer owns the actual park (tab state lives there).
				{
					label: 'Move Terminal to Background',
					accelerator: 'CmdOrCtrl+Shift+B',
					click: send('tab:background'),
				},
			],
		},
		{ role: 'editMenu' },
		{
			// Custom View menu: the stock viewMenu role owns cmd+= / cmd+- / cmd+0
			// as webContents zoom — helm gives those to the terminal font size
			// (renderer applies bounds + persistence, mirroring the cmd+t pattern).
			label: 'View',
			submenu: [
				{
					label: 'Bigger text',
					accelerator: 'CmdOrCtrl+=',
					click: send('font:step', 1),
				},
				// Hidden twin so the literal ⌘⇧= ("cmd +") chord also works.
				{
					label: 'Bigger text',
					accelerator: 'CmdOrCtrl+Shift+=',
					visible: false,
					acceleratorWorksWhenHidden: true,
					click: send('font:step', 1),
				},
				{
					label: 'Smaller text',
					accelerator: 'CmdOrCtrl+-',
					click: send('font:step', -1),
				},
				{
					label: 'Reset text size',
					accelerator: 'CmdOrCtrl+0',
					click: send('font:step', 0),
				},
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
				{
					label: 'Back',
					accelerator: 'CmdOrCtrl+[',
					click: send('nav:go', 'back'),
				},
				{
					label: 'Forward',
					accelerator: 'CmdOrCtrl+]',
					click: send('nav:go', 'forward'),
				},
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

const scheduledOpenAcks = new Map<number, { resolve(opened: boolean): void; timer: NodeJS.Timeout }>()

/** Main-to-current-renderer open, fenced by both sender and profile token. */
function openScheduledRenderer(terminal: import('./shared').ScheduledTerminalOpen): Promise<boolean> {
	const win = mainWindow
	const token = sessionProfileToken()
	if (!win || win.isDestroyed() || !sessionIpcAdmissionOpen) return Promise.resolve(false)
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			scheduledOpenAcks.delete(terminal.ptyId)
			resolve(false)
		}, 30_000)
		scheduledOpenAcks.set(terminal.ptyId, {
			resolve: opened => {
				clearTimeout(timer)
				resolve(opened)
			},
			timer,
		})
		win.webContents.send('scheduled-adoption:open', terminal, token)
	})
}

/** Spawn only a lowercase dtach attach client. It cannot create/rebind a master. */
async function attachScheduledPty(input: {
	sessionId: string
	ownership: ScheduledSessionOwnership
	descriptor: { socketPath: string; mode: 'attach-existing'; redraw: 'winch' }
}): Promise<{ ptyId: number }> {
	if (!acceptsSessionIpcToken(sessionProfileToken()) || input.ownership.profileId !== sessionProfileId)
		throw new Error('Scheduled session profile changed')
	const support = getSessionSupport()
	if (!support) throw new Error('Persistent terminal support is unavailable')
	const expectedSocket = scheduledSocketPath(input.ownership.profileId, scheduledSessionId(input.ownership.runId))
	if (
		input.descriptor.socketPath !== expectedSocket ||
		input.descriptor.mode !== 'attach-existing' ||
		input.descriptor.redraw !== 'winch'
	)
		throw new Error('Scheduled attach descriptor is invalid')
	const ptyId = nextPtyId++
	const token = sessionProfileToken()
	const proc = pty.spawn(support.dtach, scheduledDtachAttachArgs(expectedSocket), {
		name: 'xterm-256color',
		cols: 80,
		rows: 24,
		cwd: os.homedir(),
		env: shellEnv(),
	})
	const entry: PtyEntry = {
		proc,
		sessionId: input.sessionId,
		backing: 'run-owned',
		profileToken: token,
		ready: false,
		pendingOutput: [],
	}
	ptys.set(ptyId, entry)
	proc.onData(data => {
		if (!entry.ready) {
			entry.pendingOutput.push(data)
			return
		}
		const win = mainWindow
		if (win && !win.isDestroyed()) win.webContents.send('pty:data', ptyId, data, token)
	})
	proc.onExit(({ exitCode }) => {
		const selfExit = ptys.has(ptyId)
		ptys.delete(ptyId)
		if (selfExit) {
			const win = mainWindow
			if (win && !win.isDestroyed()) win.webContents.send('pty:exit', ptyId, exitCode, token)
		}
	})
	return { ptyId }
}

function detachScheduledPty(ptyId: number): void {
	const entry = ptys.get(ptyId)
	if (!entry || entry.backing !== 'run-owned') return
	ptys.delete(ptyId)
	try {
		entry.proc.kill()
	} catch {
		// Only the attach client is ours; never infer or signal the scheduled master.
	}
}

const scheduledRegistryAdapter = {
	registerRunOwned(sessionId: string, ownership: ScheduledSessionOwnership): boolean {
		return getSessionSupport()?.registry.registerRunOwned(sessionId, ownership) ?? false
	},
	removeRunOwned(sessionId: string): boolean {
		return getSessionSupport()?.registry.removeRunOwned(sessionId) ?? false
	},
	listRunOwned() {
		return (getSessionSupport()?.registry.listRunOwned() ?? []).map(entry => ({
			sessionId: entry.sessionId,
			ownership: entry.ownership,
			restored: {
				sessionId: entry.sessionId,
				title: entry.meta.lastTitle ?? null,
				customName: entry.meta.customName ?? null,
				parked: entry.meta.parked === true,
				groupId: entry.meta.groupId ?? null,
				agentRunning: entry.meta.agentRunning === true,
				agentAttention: entry.meta.agentAttention === true,
			},
		}))
	},
}

ipcMain.handle(
	'scheduled-adoption:opened',
	(event, ptyId: unknown, sessionId: unknown, profileToken: unknown, opened: unknown) => {
		const validPtyId = typeof ptyId === 'number' ? ptyId : null
		const ack = validPtyId === null ? undefined : scheduledOpenAcks.get(validPtyId)
		const entry = validPtyId === null ? undefined : ptys.get(validPtyId)
		if (
			validPtyId === null ||
			!ack ||
			!entry ||
			entry.backing !== 'run-owned' ||
			entry.sessionId !== sessionId ||
			!sessionIpcGate.allows(profileToken) ||
			event.sender !== mainWindow?.webContents
		)
			return false
		scheduledOpenAcks.delete(validPtyId)
		if (opened !== true) {
			ack.resolve(false)
			return false
		}
		entry.ready = true
		const win = mainWindow
		if (win && !win.isDestroyed())
			for (const data of entry.pendingOutput.splice(0))
				win.webContents.send('pty:data', validPtyId, data, entry.profileToken)
		ack.resolve(true)
		return true
	},
)

ipcMain.handle('external:open', async (event, value: unknown, profileToken: unknown) => {
	if (!sessionIpcGate.allows(profileToken) || event.sender !== mainWindow?.webContents) return false
	const href = parseExternalHttpUrl(value)
	if (!href) return false
	try {
		await shell.openExternal(href)
		return true
	} catch {
		return false
	}
})

ipcMain.handle('pty:spawn', (event, args: SpawnArgs) => {
	sessionIpcGate.require(args.profileToken)
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
	ptys.set(id, {
		proc,
		sessionId,
		backing: 'ordinary',
		profileToken: args.profileToken,
		ready: true,
		pendingOutput: [],
	})
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
		const selfEntry = ptys.get(id)
		const selfExit = selfEntry !== undefined
		ptys.delete(id)
		if (selfExit && sessionId && support && selfEntry?.backing !== 'run-owned') {
			const sid = sessionId
			void sessions.reapSessionIfDead(sid).then(dead => {
				if (dead) {
					support.registry.remove(sid)
					support.buffers.remove(sid)
				}
			})
		}
		if (!contents.isDestroyed() && !terminalTransferMain?.isSessionBusy(sessionId ?? ''))
			contents.send('pty:exit', id, exitCode, args.profileToken)
	})
	return { id, sessionId }
})

ipcMain.on('pty:write', (_event, id: number, data: string, profileToken: unknown) => {
	if (!sessionIpcGate.allows(profileToken)) return
	const entry = ptys.get(id)
	if (!entry || terminalTransferMain?.isSessionBusy(entry.sessionId ?? '')) return
	entry.proc.write(data)
})

ipcMain.on('pty:resize', (_event, id: number, cols: number, rows: number, profileToken: unknown) => {
	if (!sessionIpcGate.allows(profileToken)) return
	const entry = ptys.get(id)
	if (!entry || terminalTransferMain?.isSessionBusy(entry.sessionId ?? '') || !(cols > 0) || !(rows > 0)) return
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
	if (!sessionIpcGate.allows(profileToken)) return
	const entry = ptys.get(id)
	if (!entry || terminalTransferMain?.isSessionBusy(entry.sessionId ?? '')) return
	ptys.delete(id)
	if (entry.sessionId && entry.backing !== 'run-owned') {
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
	if (terminalTransferMain?.isBusy() || !sessionIpcGate.allows(profileToken)) return null
	const entry = ptys.get(id)
	if (!entry || terminalTransferMain?.isSessionBusy(entry.sessionId ?? '')) return null
	ptys.delete(id)
	try {
		entry.proc.kill()
	} catch {
		// already exited
	}
	if (!entry.sessionId || entry.backing === 'run-owned') return null
	graceCloseSupports.set(entry.sessionId, getSessionSupport())
	graceCloser.schedule(entry.sessionId)
	return { sessionId: entry.sessionId, graceMs: graceCloser.graceMs }
})

// Undo a soft close: cancel the pending kill. True = session untouched, the
// renderer may reattach it as a new tab. False = timer already fired (or
// nothing pending) — nothing to restore.
ipcMain.handle('session:undo-close', (_event, sessionId: unknown, profileToken: unknown) => {
	if (!sessionIpcGate.allows(profileToken) || !sessions.isValidSessionId(sessionId)) return false
	const undone = graceCloser.undo(sessionId)
	if (undone) graceCloseSupports.delete(sessionId)
	return undone
})

// Startup restore: live sessions from the socket dir (stale sockets GC'd),
// labeled from the registry. The renderer reattaches one tab per entry.
ipcMain.handle('sessions:list', async (_event, profileToken: unknown) => {
	await terminalTransferRecovery
	if (!sessionIpcGate.allows(profileToken)) return []
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
			groupId: support.registry.get(s.sessionId)?.groupId ?? null,
			agentRunning: support.registry.get(s.sessionId)?.agentRunning === true,
			agentAttention: support.registry.get(s.sessionId)?.agentAttention === true,
			// Registry createdAt (original spawn) beats socket birthtime for ordering.
			createdAt: support.registry.get(s.sessionId)?.createdAt ?? s.createdAt,
			order: support.registry.get(s.sessionId)?.order,
		}))
		.sort(sessions.compareSessionOrder)
		.map(({ sessionId, title, customName, parked, groupId, agentRunning, agentAttention }) => ({
			sessionId,
			title,
			customName,
			parked,
			groupId,
			agentRunning,
			agentAttention,
		}))
})

const TAB_GROUP_ACTION_TYPES = new Set<sessions.TabGroupActionIntent['type']>([
	'rename',
	'move',
	'open-all',
	'restore-all',
	'move-all-background',
	'close-all',
])

/** Validate a declarative action only; this adapter must never control a PTY. */
function parseTabGroupActionIntent(value: unknown): sessions.TabGroupActionIntent | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
	const input = value as Record<string, unknown>
	if (
		typeof input.type !== 'string' ||
		!TAB_GROUP_ACTION_TYPES.has(input.type as sessions.TabGroupActionIntent['type'])
	)
		return null
	return sessions.tabGroupActionIntent(input.type as sessions.TabGroupActionIntent['type'], {
		groupId: input.groupId,
		name: input.name,
		sessionId: input.sessionId,
		targetGroupId: input.type === 'move' ? input.groupId : undefined,
	})
}

// Tab groups are persisted metadata only. PTY/DOM effects for declarative
// actions are intentionally deferred to the renderer adapter slice.
ipcMain.handle('tab-groups:list', (_event, profileToken: unknown) =>
	sessionIpcGate.handle(profileToken, [], () => getSessionSupport()?.registry.getGroups() ?? []),
)

ipcMain.handle('tab-groups:create', (_event, name: unknown, sessionIds: unknown, profileToken: unknown) =>
	sessionIpcGate.handle(profileToken, null, () => {
		if (
			typeof name !== 'string' ||
			!Array.isArray(sessionIds) ||
			sessionIds.length > 100 ||
			!sessionIds.every(sessions.isValidSessionId)
		)
			return null
		return getSessionSupport()?.registry.createGroup(name, sessionIds) ?? null
	}),
)

ipcMain.handle('tab-groups:rename', (_event, groupId: unknown, name: unknown, profileToken: unknown) =>
	sessionIpcGate.handle(profileToken, null, () => {
		if (!sessions.isValidTabGroupId(groupId) || typeof name !== 'string') return null
		return getSessionSupport()?.registry.renameGroup(groupId, name) ?? null
	}),
)

ipcMain.handle('tab-groups:delete', (_event, groupId: unknown, profileToken: unknown) =>
	sessionIpcGate.handle(profileToken, false, () =>
		sessions.isValidTabGroupId(groupId) ? (getSessionSupport()?.registry.deleteGroup(groupId) ?? false) : false,
	),
)

ipcMain.handle('tab-groups:set-membership', (_event, sessionId: unknown, groupId: unknown, profileToken: unknown) =>
	sessionIpcGate.handle(profileToken, false, () => {
		if (!sessions.isValidSessionId(sessionId) || (groupId !== null && !sessions.isValidTabGroupId(groupId)))
			return false
		return getSessionSupport()?.registry.setSessionGroup(sessionId, groupId) ?? false
	}),
)

ipcMain.handle(
	'tab-groups:set-collapsed',
	(_event, groupId: unknown, surface: unknown, collapsed: unknown, profileToken: unknown) =>
		sessionIpcGate.handle(profileToken, false, () => {
			if (
				!sessions.isValidTabGroupId(groupId) ||
				(surface !== 'strip' && surface !== 'background') ||
				typeof collapsed !== 'boolean'
			)
				return false
			return getSessionSupport()?.registry.setGroupCollapsed(groupId, surface, collapsed) ?? false
		}),
)

ipcMain.handle('tab-groups:move', (_event, groupId: unknown, parked: unknown, profileToken: unknown) =>
	sessionIpcGate.handle(profileToken, null, () => {
		if (!sessions.isValidTabGroupId(groupId) || typeof parked !== 'boolean') return null
		return getSessionSupport()?.registry.moveGroup(groupId, parked) ?? null
	}),
)

ipcMain.handle('tab-groups:intent', (_event, value: unknown, profileToken: unknown) =>
	sessionIpcGate.handle(profileToken, null, () => {
		const intent = parseTabGroupActionIntent(value)
		if (!intent) return null
		const registry = getSessionSupport()?.registry
		if (!registry) return null
		if (intent.type === 'move') {
			return registry.get(intent.sessionId) &&
				(intent.groupId === null || registry.getGroups().some(group => group.id === intent.groupId))
				? { intent, memberIds: [] }
				: null
		}
		const memberIds = registry.groupMembers(intent.groupId)
		return memberIds ? { intent, memberIds } : null
	}),
)

// Park/unpark a session in the registry so background terminals survive a
// relaunch as background terminals (renderer owns the in-memory tab state).
ipcMain.on('session:set-parked', (_event, sessionId: unknown, parked: unknown, profileToken: unknown) => {
	if (!sessionIpcGate.allows(profileToken) || !sessions.isValidSessionId(sessionId) || typeof parked !== 'boolean')
		return
	getSessionSupport()?.registry.setParked(sessionId, parked)
})

ipcMain.on('session:set-activity', (_event, sessionId: unknown, activity: unknown, profileToken: unknown) => {
	if (
		!sessionIpcGate.allows(profileToken) ||
		!sessions.isValidSessionId(sessionId) ||
		!activity ||
		typeof activity !== 'object'
	)
		return
	const value = activity as { agentRunning?: unknown; agentAttention?: unknown }
	if (typeof value.agentRunning !== 'boolean' || typeof value.agentAttention !== 'boolean') return
	getSessionSupport()?.registry.setActivity(sessionId, {
		agentRunning: value.agentRunning,
		agentAttention: value.agentAttention,
	})
})

ipcMain.on('session:set-order', (_event, sessionIds: unknown, profileToken: unknown) => {
	if (
		!sessionIpcGate.allows(profileToken) ||
		!Array.isArray(sessionIds) ||
		sessionIds.length > 100 ||
		!sessionIds.every(sessions.isValidSessionId)
	)
		return
	getSessionSupport()?.registry.setOrder(sessionIds)
})

ipcMain.on('session:title', (_event, sessionId: unknown, title: unknown, profileToken: unknown) => {
	if (!sessionIpcGate.allows(profileToken) || !sessions.isValidSessionId(sessionId) || typeof title !== 'string') return
	getSessionSupport()?.registry.setTitle(sessionId, title)
})

// Manual rename pin: persist so the name survives relaunch/park; null clears.
ipcMain.on('session:set-custom-name', (_event, sessionId: unknown, name: unknown, profileToken: unknown) => {
	if (
		!sessionIpcGate.allows(profileToken) ||
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
	if (!sessionIpcGate.allows(profileToken)) return
	const support = getSessionSupport()
	if (!support || !sessions.isValidSessionId(sessionId) || typeof data !== 'string') return
	support.buffers.save(sessionId, data)
})

ipcMain.handle('buffer:read', (_event, sessionId: unknown, profileToken: unknown) => {
	if (!sessionIpcGate.allows(profileToken)) return null
	const support = getSessionSupport()
	if (!support || !sessions.isValidSessionId(sessionId)) return null
	return support.buffers.read(sessionId)
})

ipcMain.handle('buffer:save-and-ack', (_event, sessionId: unknown, data: unknown, profileToken: unknown) => {
	if (!sessionIpcGate.allows(profileToken) || !sessions.isValidSessionId(sessionId) || typeof data !== 'string')
		return false
	const support = getSessionSupport()
	return support?.buffers.save(sessionId, data) ?? false
})

ipcMain.on('config:get', event => {
	event.returnValue = { daemonUrl, sessionProfileToken: sessionProfileToken() }
})

ipcMain.handle('terminal-transfer:ack', (event, command: unknown, result: unknown, profileToken: unknown) => {
	if (!terminalTransferIpcGate.allows(event.sender, profileToken) || !command || typeof command !== 'object')
		return false
	const transactionId = (command as { transactionId?: unknown }).transactionId
	if (typeof transactionId !== 'string') return false
	const pending = pendingTerminalTransferEvents.get(transactionId)
	if (!pending || pending.sender !== event.sender) return false
	pendingTerminalTransferEvents.delete(transactionId)
	clearTimeout(pending.timer)
	pending.resolve(result)
	return true
})

ipcMain.handle('terminal-transfer:preflight', (event, sessionId: unknown, profileToken: unknown) =>
	terminalTransferIpcGate.handle(
		event.sender,
		profileToken,
		{ status: 'unavailable' as const, reason: 'stale-profile' as const },
		() => {
			if (!terminalTransferMain || !sessions.isValidSessionId(sessionId))
				return { status: 'unavailable' as const, reason: 'invalid-session' as const }
			return terminalTransferMain.preflight({
				sourceProfileId: sessionProfileId,
				sessionId,
				profileToken: profileToken as string,
				destinationProfileIds: appProfiles
					.getState()
					.profiles.filter(profile => profile.archivedAt === null)
					.map(profile => profile.id),
			})
		},
	),
)

ipcMain.handle(
	'terminal-transfer:move',
	async (event, sessionId: unknown, destinationProfileId: unknown, profileToken: unknown) =>
		terminalTransferIpcGate.handle(
			event.sender,
			profileToken,
			Promise.resolve({ status: 'rejected' as const, reason: 'stale-profile' }),
			async () => {
				if (
					!terminalTransferMain ||
					!sessions.isValidSessionId(sessionId) ||
					!sessions.isValidSessionProfileId(destinationProfileId)
				)
					return { status: 'rejected' as const, reason: 'admission-unavailable' }
				const destination = appProfiles.getState().profiles.find(profile => profile.id === destinationProfileId)
				if (!destination || destination.archivedAt !== null)
					return { status: 'rejected' as const, reason: 'destination-unavailable' }
				const entry = [...ptys.values()].find(candidate => candidate.sessionId === sessionId)
				if (!entry || graceCloser.has(sessionId)) return { status: 'rejected' as const, reason: 'session-ineligible' }
				const capability = {
					profileToken: profileToken as string,
					sessionId,
					dispatch: (command: TerminalTransferEvent) => dispatchTerminalTransferEvent(event.sender, command),
				}
				if (!terminalTransferMain.registerRendererCapability(capability))
					return { status: 'rejected' as const, reason: 'admission-unavailable' }
				try {
					const result = await terminalTransferMain.move({
						sourceProfileId: sessionProfileId,
						destinationProfileId,
						sessionId,
						profileToken: profileToken as string,
					})
					return result.status === 'moved'
						? { status: 'moved' as const }
						: result.status === 'busy'
							? { status: 'busy' as const }
							: result.status === 'quarantined'
								? { status: 'quarantined' as const }
								: { status: 'rejected' as const, reason: result.reason }
				} finally {
					terminalTransferMain.unregisterRendererCapability(sessionId, capability)
				}
			},
		),
)

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
		return {
			id,
			name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
			tokens,
		}
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
	authoritativeProfilesState = result.data.state
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
		authoritativeProfilesState = result.data
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
	app.setAboutPanelOptions({
		applicationName: APP_NAME,
		applicationVersion: app.getVersion(),
	})
	await syncProfilesFromDaemon()
	terminalTransferMain = new TerminalTransferMainAdapter({
		userDataDir: app.getPath('userData'),
		runtime: {
			storageForProfile: transferStorageForProfile,
			currentProfile: () => ({
				profileId: sessionProfileId,
				token: sessionProfileToken(),
			}),
		},
		detachAttachClient: sessionId => detachPtyForTransfer(sessionId),
		// A post-detach ambiguous failure remains journaled rather than creating
		// another client/session from mutable namespace state.
		attachSourceClient: () => false,
	})
	// Journal recovery happens before a renderer can invoke sessions:list. A
	// quarantine is deliberately retained/fenced rather than repaired by guess.
	terminalTransferRecovery = terminalTransferMain.recoverStartup().then(result => {
		if (result.status === 'quarantined') console.warn('[helm] terminal transfer recovery quarantined:', result.reason)
	})
	await terminalTransferRecovery
	scheduledAdoption = new ScheduledAttentionAdoptionCoordinator({
		daemon: {
			reserve: async ownership => {
				const token = await readLocalControlToken()
				const result = await helmBridge.scheduledAttention<{ revision: number; adoption: { capability: string } }>(
					`/scheduled-runs/runs/${encodeURIComponent(ownership.runId)}/attention-adoption/reserve`,
					ownership,
					token,
				)
				if (!result.data) throw new Error('Scheduled attention adoption is unavailable')
				return { revision: result.data.revision, capability: result.data.adoption.capability }
			},
			descriptor: async input => {
				const token = await readLocalControlToken()
				const result = await helmBridge.scheduledAttention<{
					socketPath: string
					mode: 'attach-existing'
					redraw: 'winch'
				}>(`/scheduled-runs/runs/${encodeURIComponent(input.runId)}/attention-adoption/attach-descriptor`, input, token)
				if (!result.data) throw new Error('Scheduled attention adoption is unavailable')
				return result.data
			},
			complete: async ownership => {
				const token = await readLocalControlToken()
				const result = await helmBridge.scheduledAttention(
					`/scheduled-runs/runs/${encodeURIComponent(ownership.runId)}/attention-adoption/complete`,
					{ ...ownership, ownershipRegistered: true },
					token,
				)
				if (!result.data) throw new Error('Scheduled attention adoption is unavailable')
			},
			rollback: async ownership => {
				const token = await readLocalControlToken()
				await helmBridge.scheduledAttention(
					`/scheduled-runs/runs/${encodeURIComponent(ownership.runId)}/attention-adoption/rollback`,
					ownership,
					token,
				)
			},
			restoreDescriptor: async ownership => {
				const token = await readLocalControlToken()
				const result = await helmBridge.scheduledAttention<{
					socketPath: string
					mode: 'attach-existing'
					redraw: 'winch'
				}>(
					`/scheduled-runs/runs/${encodeURIComponent(ownership.runId)}/attention-adoption/completed-owner/attach-descriptor`,
					ownership,
					token,
				)
				if (!result.data) throw new Error('Scheduled attention adoption is unavailable')
				return result.data
			},
		},
		attach: { attach: attachScheduledPty, detach: detachScheduledPty },
		registry: scheduledRegistryAdapter,
		renderer: { open: openScheduledRenderer },
		newSessionId: sessions.newSessionId,
		isCurrent: (profileId, token) => profileId === sessionProfileId && acceptsSessionIpcToken(token),
	})
	void scheduledAdoption.recoverAmbiguous()
	profileSwitchCoordinator = createProfileSwitchCoordinator()
	scheduledAttentionNotifier = new ScheduledAttentionNotifier({
		list: async () => {
			const token = await readLocalControlToken()
			const result = await helmBridge.scheduledAttentionRead<
				Array<{
					profileId: string
					runId: string
					revision: number
					scheduleName: string
					reportSummary: string
					notificationClaimedAt: string | null
					notificationDeliveredAt: string | null
				}>
			>('/scheduled-runs/attention-notifications', token)
			if (!result.data) throw new Error('Scheduled attention notifications are unavailable')
			return result.data
		},
		claim: async input => {
			const token = await readLocalControlToken()
			const result = await helmBridge.scheduledAttention<typeof input>(
				`/scheduled-runs/runs/${encodeURIComponent(input.runId)}/attention-notification/claim`,
				{ profileId: input.profileId, revision: input.revision },
				token,
			)
			return result.data ?? null
		},
		markDelivered: async input => {
			const token = await readLocalControlToken()
			const result = await helmBridge.scheduledAttention(
				`/scheduled-runs/runs/${encodeURIComponent(input.runId)}/attention-notification/delivered`,
				{ profileId: input.profileId, revision: input.revision },
				token,
			)
			return result.data !== undefined
		},
		notification: content => {
			const native = new Notification(content)
			return {
				show: () => {
					native.show()
					return undefined
				},
				onClick: listener => native.on('click', listener),
			}
		},
		focusAndRestore: () => {
			const win = mainWindow
			if (!win || win.isDestroyed()) return
			if (win.isMinimized()) win.restore()
			win.show()
			win.focus()
		},
		activateProfile: async profileId => {
			const result = await activateProfile(profileId)
			return result.data !== undefined && sessionProfileId === profileId
		},
		currentProfileToken: profileId =>
			profileId === sessionProfileId && mainWindow && !mainWindow.isDestroyed() && sessionIpcAdmissionOpen
				? sessionProfileToken()
				: null,
		adopt: input => scheduledAdoption?.adopt(input) ?? Promise.resolve({ status: 'rejected' }),
	})
	buildMenu()
	helmBridge.start()
	// Screenshot harnesses use app.exit(), bypassing guarded lease revocation, and
	// must never admit real scheduled work as a side effect of rendering fixtures.
	if (!screenshotPath) void scheduledResidency.start()
	createWindow()
	// A click must fence against an actual current BrowserWindow/token.
	if (!screenshotPath) scheduledAttentionNotifier.start()
	if (profileSwitchAttestationMode) {
		void runProfileSwitchAttestation()
			.then(() => app.quit())
			.catch(error => {
				console.error('[helm] profile-switch attestation failed:', error)
				process.exitCode = 1
				app.quit()
			})
	}
	if (pendingProfileDestination) {
		const destination = pendingProfileDestination
		pendingProfileDestination = null
		enqueueDestination(destination)
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
	if (terminalTransferMain?.isBusy()) {
		event.preventDefault()
		void terminalTransferMain.whenIdle().then(() => app.quit())
		return
	}
	if (runContextWindows.hasDirtyWindows()) {
		// Keep the main window, bridge, and attached dtach clients alive until
		// every dirty editor explicitly saves/discards. Keep editing cancels quit.
		event.preventDefault()
		pendingEditorQuit = true
		quitRequested = false
		runContextWindows.requestCloseAll()
		return
	}
	if (!residencyStoppedForQuit) {
		event.preventDefault()
		void Promise.all([scheduledResidency.stop(), scheduledAttentionNotifier?.stop()]).finally(() => {
			residencyStoppedForQuit = true
			app.quit()
		})
		return
	}
	quitRequested = true
})

app.on('will-quit', () => {
	profileSwitchCoordinator?.stop()
	// before-quit waits for stop/revoke before re-entering app.quit, so bridge
	// shutdown always follows the final resident lease attempt.
	helmBridge.stop()
	killAllPtyClients()
	sessionSupport?.registry.flush()
})
