import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { showToast } from './toast'
import type { HelmApi, RestoredSession } from '../shared'

declare global {
	interface Window {
		helm: HelmApi
	}
}

const helm = window.helm

function el<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id)
	if (!node) throw new Error(`missing #${id}`)
	return node as T
}

const dashFrame = el<HTMLIFrameElement>('dash')
const dashOffline = el<HTMLDivElement>('dash-offline')
const daemonUrlLabel = el<HTMLElement>('daemon-url')
const connDot = el<HTMLSpanElement>('conn-dot')
const divider = el<HTMLDivElement>('divider')
const tabsEl = el<HTMLDivElement>('tabs')
const newTabButton = el<HTMLButtonElement>('new-tab')
const termsEl = el<HTMLDivElement>('terms')

// ---------- split divider ----------

const LEFT_WIDTH_KEY = 'helm.leftWidth'
const MIN_LEFT = 320
// 52% of the default 1400px window gives the dashboard iframe ≥720px — the
// width where vigil comfortably renders list + detail side by side. Narrower
// panes are fine: the embed CSS injected from main collapses vigil to one
// column below 720px (see src/dash-embed.ts).
const DEFAULT_LEFT_FRACTION = 0.52
const maxLeft = () => Math.floor(window.innerWidth * 0.6)
const clampLeft = (width: number) => Math.min(Math.max(width, MIN_LEFT), maxLeft())

let leftWidth = clampLeft(
	Number(localStorage.getItem(LEFT_WIDTH_KEY)) || Math.round(window.innerWidth * DEFAULT_LEFT_FRACTION),
)

function applyLeftWidth(): void {
	document.documentElement.style.setProperty('--left-width', `${leftWidth}px`)
}
applyLeftWidth()

divider.addEventListener('pointerdown', (down) => {
	divider.setPointerCapture(down.pointerId)
	document.body.classList.add('dragging')
	const onMove = (move: PointerEvent) => {
		leftWidth = clampLeft(move.clientX)
		applyLeftWidth()
	}
	const onUp = () => {
		divider.removeEventListener('pointermove', onMove)
		divider.removeEventListener('pointerup', onUp)
		document.body.classList.remove('dragging')
		localStorage.setItem(LEFT_WIDTH_KEY, String(leftWidth))
	}
	divider.addEventListener('pointermove', onMove)
	divider.addEventListener('pointerup', onUp)
})

window.addEventListener('resize', () => {
	const clamped = clampLeft(leftWidth)
	if (clamped !== leftWidth) {
		leftWidth = clamped
		applyLeftWidth()
	}
})

// ---------- daemon connection (dot + dashboard iframe) ----------

const daemonUrl = helm.config.getDaemonUrl()
daemonUrlLabel.textContent = (() => {
	try {
		return new URL(daemonUrl).host
	} catch {
		return daemonUrl
	}
})()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Never point the iframe at a dead daemon — a broken frame is uglier than the
// waiting card. Once loaded, the dashboard polls and recovers on its own, so
// later outages surface through the amber dot only (no card flicker over live UI).
let dashLoaded = false

function reflectDaemonState(reachable: boolean): void {
	connDot.classList.toggle('offline', !reachable)
	if (reachable && !dashLoaded) {
		dashLoaded = true
		dashFrame.src = daemonUrl
		dashOffline.classList.add('hidden')
	}
}

async function pingLoop(): Promise<void> {
	for (;;) {
		reflectDaemonState(await helm.config.pingDaemon())
		await sleep(2000)
	}
}
void pingLoop()

// ---------- terminal tabs ----------

const termTheme = {
	background: '#0f1113',
	foreground: '#ececee',
	cursor: '#4c9aff',
	cursorAccent: '#0f1113',
	selectionBackground: 'rgba(76, 154, 255, 0.25)',
	black: '#2a2e33',
	red: '#f2585b',
	green: '#4ec98a',
	yellow: '#e0b341',
	blue: '#4c9aff',
	magenta: '#c08ae0',
	cyan: '#54c6d6',
	white: '#c9ccd1',
	brightBlack: '#5b6068',
	brightRed: '#ff7477',
	brightGreen: '#6fe0a8',
	brightYellow: '#f2cd6d',
	brightBlue: '#78b5ff',
	brightMagenta: '#d5a9f0',
	brightCyan: '#74dcea',
	brightWhite: '#f5f6f7',
}

interface Tab {
	ptyId: number | null
	/** dtach session behind the pty; null while spawning or when persistence is off. */
	sessionId: string | null
	closed: boolean
	term: Terminal
	fit: FitAddon
	holder: HTMLDivElement
	tabButton: HTMLDivElement
}

const tabs: Tab[] = []
let activeTab: Tab | null = null

function fitActive(): void {
	if (!activeTab) return
	activeTab.fit.fit()
}

function activate(tab: Tab): void {
	activeTab = tab
	for (const t of tabs) {
		t.holder.classList.toggle('active', t === tab)
		t.tabButton.classList.toggle('active', t === tab)
		t.tabButton.setAttribute('aria-selected', String(t === tab))
	}
	syncEmptyState()
	// Fit after the holder becomes visible; hidden containers measure as 0x0.
	requestAnimationFrame(() => {
		fitActive()
		tab.term.focus()
	})
}

function cycleTab(delta: number): void {
	if (tabs.length === 0) return
	const current = activeTab ? tabs.indexOf(activeTab) : 0
	const next = tabs[(current + delta + tabs.length) % tabs.length]
	if (next && next !== activeTab) activate(next)
}

function closeTab(tab: Tab): void {
	if (tab.closed) return
	tab.closed = true
	const title = tab.tabButton.querySelector('.tab-label')?.textContent ?? 'zsh'
	// Soft close (okena-style): main only DETACHES the pty client and arms a
	// grace timer — the dtach session dies when it fires. The toast's Undo
	// cancels the timer and reattaches the same session as a new tab.
	if (tab.ptyId !== null) {
		void helm.sessions.closeWithGrace(tab.ptyId).then((grace) => {
			if (!grace) return // non-persistent pty — already fully killed, nothing to undo
			const toast = showToast({
				message: 'Terminal closed',
				detail: title === 'zsh' ? undefined : title,
				ttlMs: grace.graceMs,
				countdown: true,
				action: {
					label: 'Undo',
					onClick: () => {
						toast.dismiss()
						void helm.sessions.undoClose(grace.sessionId).then((alive) => {
							if (alive) void createTab({ sessionId: grace.sessionId, title })
						})
					},
				},
			})
		})
	}
	tab.term.dispose()
	tab.holder.remove()
	tab.tabButton.remove()
	const index = tabs.indexOf(tab)
	tabs.splice(index, 1)
	if (activeTab === tab) {
		activeTab = null
		const neighbor = tabs[Math.min(index, tabs.length - 1)]
		if (neighbor) activate(neighbor)
	}
	syncEmptyState()
}

// Zero terminals is a valid state — show a quiet hint instead of respawning
// (closing the last tab used to auto-open a new one; deliberate removal).
function syncEmptyState(): void {
	const empty = document.getElementById('no-terms')
	if (empty) empty.hidden = tabs.length > 0
}

async function createTab(restore?: RestoredSession): Promise<void> {
	const term = new Terminal({
		cursorBlink: true,
		scrollback: 10000,
		fontSize: 13,
		fontFamily: "'SF Mono', Menlo, ui-monospace, monospace",
		// Spec asks for CSS line-height 1.45 (13px -> ~19px). xterm's lineHeight
		// multiplies the font's natural cell height (~15.5px here), so 1.2 lands
		// at that same ~19px; a literal 1.45 would render ~22px cells.
		lineHeight: 1.2,
		macOptionIsMeta: true,
		theme: termTheme,
	})
	const fit = new FitAddon()
	term.loadAddon(fit)
	term.loadAddon(new WebLinksAddon())

	const holder = document.createElement('div')
	holder.className = 'term-holder'
	termsEl.appendChild(holder)
	term.open(holder)

	const tabButton = document.createElement('div')
	tabButton.className = 'tab'
	tabButton.setAttribute('role', 'tab')
	tabButton.tabIndex = 0
	const label = document.createElement('span')
	label.className = 'tab-label'
	// Restored tabs keep the label persisted from the previous run until the
	// reattached shell emits a fresh OSC title.
	label.textContent = restore?.title || 'zsh'
	// Shell title arrives via OSC title events; empty titles fall back to "zsh".
	term.onTitleChange((title) => {
		const text = title.trim() || 'zsh'
		label.textContent = text
		if (tab.sessionId) helm.sessions.setTitle(tab.sessionId, text)
	})
	const close = document.createElement('button')
	close.className = 'tab-close'
	close.textContent = '×'
	close.title = 'Close (⌘W)'
	close.setAttribute('aria-label', 'Close terminal')
	tabButton.append(label, close)
	tabsEl.appendChild(tabButton)

	const tab: Tab = { ptyId: null, sessionId: null, closed: false, term, fit, holder, tabButton }
	tabs.push(tab)

	tabButton.addEventListener('click', () => activate(tab))
	tabButton.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault()
			activate(tab)
		}
	})
	close.addEventListener('click', (event) => {
		event.stopPropagation()
		closeTab(tab)
	})

	activate(tab)
	fit.fit()

	const spawned = await helm.pty.spawn(term.cols, term.rows, restore?.sessionId)
	if (tab.closed) {
		helm.pty.kill(spawned.id)
		return
	}
	tab.ptyId = spawned.id
	tab.sessionId = spawned.sessionId
	term.onData((data) => helm.pty.write(spawned.id, data))
	term.onResize(({ cols, rows }) => helm.pty.resize(spawned.id, cols, rows))
}

helm.pty.onData((id, data) => {
	tabs.find((t) => t.ptyId === id)?.term.write(data)
})

helm.pty.onExit((id) => {
	const tab = tabs.find((t) => t.ptyId === id)
	if (tab) {
		tab.ptyId = null // pty is gone; don't kill it again on close
		closeTab(tab)
	}
})

new ResizeObserver(() => fitActive()).observe(termsEl)

// New-tab actions are gated until session restore finishes, so restored tabs
// always come first and a fast cmd+T can't interleave with reattachment.
let tabsReady = false

newTabButton.addEventListener('click', () => {
	if (tabsReady) void createTab()
})
helm.tabs.onNew(() => {
	if (tabsReady) void createTab()
})
helm.tabs.onClose(() => {
	if (activeTab) closeTab(activeTab)
})

// cmd+1..9 select tab, cmd+shift+[ / ] cycle. Capture phase so the shortcuts
// win over xterm's own key handling when a terminal has focus.
window.addEventListener(
	'keydown',
	(event) => {
		if (!event.metaKey || event.ctrlKey || event.altKey) return
		if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
			const target = tabs[Number(event.key) - 1]
			if (target) {
				event.preventDefault()
				activate(target)
			}
			return
		}
		if (event.shiftKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
			event.preventDefault()
			cycleTab(event.code === 'BracketRight' ? 1 : -1)
		}
	},
	{ capture: true },
)

// Startup: reattach every dtach session that survived the previous run (one
// tab per session, saved titles restored); fresh single tab only when nothing
// survived. Zero tabs stays a valid state after that — closing restored tabs
// never respawns.
void (async () => {
	let restored: RestoredSession[] = []
	try {
		restored = await helm.sessions.list()
	} catch {
		// persistence unavailable — fall through to a fresh tab
	}
	if (restored.length === 0) {
		await createTab().catch(() => {})
	} else {
		for (const session of restored) {
			// One failed reattach must not sink the remaining sessions.
			await createTab(session).catch(() => {})
		}
		const first = tabs[0]
		if (first) activate(first)
	}
	tabsReady = true
})()
