import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import type { HelmApi, RestoredSession } from '../shared'
import { appearance } from './appearance'
import { mountSidebar } from './sidebar/SidebarRoot'
import { showToast } from './toast'

declare global {
	interface Window {
		helm: HelmApi
	}
}

const helm = window.helm

// Apply the persisted theme/scale/font-size before anything paints or mounts.
appearance.init()

function el<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id)
	if (!node) throw new Error(`missing #${id}`)
	return node as T
}

const leftPane = el<HTMLElement>('left')
const connDot = el<HTMLSpanElement>('conn-dot')
const divider = el<HTMLDivElement>('divider')
const tabsEl = el<HTMLDivElement>('tabs')
const newTabButton = el<HTMLButtonElement>('new-tab')
const termsEl = el<HTMLDivElement>('terms')

// ---------- split divider ----------

const LEFT_WIDTH_KEY = 'helm.leftWidth'
// The native sidebar is designed FOR 340px (docs/design-system.md §1 principle
// 4): default 340, draggable between 300 and 420 — never a desktop layout.
const MIN_LEFT = 300
const MAX_LEFT = 420
const DEFAULT_LEFT = 340
const maxLeft = () => Math.min(MAX_LEFT, Math.floor(window.innerWidth * 0.6))
const clampLeft = (width: number) => Math.min(Math.max(width, MIN_LEFT), maxLeft())

let leftWidth = clampLeft(Number(localStorage.getItem(LEFT_WIDTH_KEY)) || DEFAULT_LEFT)

function applyLeftWidth(): void {
	document.documentElement.style.setProperty('--left-width', `${leftWidth}px`)
}
applyLeftWidth()

divider.addEventListener('pointerdown', down => {
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

// ---------- daemon connection (topbar dot) + native sidebar ----------

// Reachability comes from the HelmBridge poller in main — the old renderer
// ping loop (daemon:ping) is gone. Snapshots are pushed only on change, so the
// initial subscribe() seeds the dot before the first change lands.
function reflectDaemonState(reachable: boolean): void {
	connDot.classList.toggle('offline', !reachable)
}

helm.daemon.onSnapshot(snapshot => reflectDaemonState(snapshot.reachable))
void helm.daemon.subscribe().then(snapshot => reflectDaemonState(snapshot.reachable))

mountSidebar(leftPane)

// ---------- terminal tabs ----------
// The xterm theme comes from the appearance token map (--term-* / --ansi-*,
// docs/design-system.md §2.8) — the old hardcoded termTheme literal is gone;
// theme-presets.ts HELM_TOKENS carries the canonical ANSI-16 values.

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

// Shell OSC titles usually arrive as "user@host:cwd" — noise at tab width.
// Normalize to the trailing path segment ("helm"); a bare "user@host" (no
// path) falls back to "zsh". Anything else (ssh banners, app-set titles)
// passes through untouched. The raw title survives as the label's tooltip.
function normalizeTabTitle(raw: string): string {
	const text = raw.trim()
	if (!text) return 'zsh'
	if (!/^\S+@\S+(:.*)?$/.test(text)) return text
	const colon = text.indexOf(':')
	const path = colon === -1 ? '' : text.slice(colon + 1).trim()
	const segment = path.replace(/\/+$/, '').split('/').pop() ?? ''
	return segment || 'zsh'
}

function applyTabTitle(label: HTMLSpanElement, raw: string): string {
	const text = normalizeTabTitle(raw)
	label.textContent = text
	// Tooltip carries the raw title whenever normalization changed/ellipsized it.
	const trimmed = raw.trim()
	if (trimmed && trimmed !== text) label.title = trimmed
	else label.removeAttribute('title')
	return text
}

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
		void helm.sessions.closeWithGrace(tab.ptyId).then(grace => {
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
						void helm.sessions.undoClose(grace.sessionId).then(alive => {
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
		fontSize: appearance.getTermFontSize(),
		fontFamily: "'SF Mono', Menlo, ui-monospace, monospace",
		// Spec asks for CSS line-height 1.45 (13px -> ~19px). xterm's lineHeight
		// multiplies the font's natural cell height (~15.5px here), so 1.2 lands
		// at that same ~19px; a literal 1.45 would render ~22px cells.
		lineHeight: 1.2,
		macOptionIsMeta: true,
		theme: appearance.getTermTheme(),
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
	// reattached shell emits a fresh OSC title (normalized too — older runs
	// persisted raw "user@host:cwd" titles).
	applyTabTitle(label, restore?.title ?? '')
	// Shell title arrives via OSC title events; empty titles fall back to "zsh".
	term.onTitleChange(title => {
		const text = applyTabTitle(label, title)
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
	tabButton.addEventListener('keydown', event => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault()
			activate(tab)
		}
	})
	close.addEventListener('click', event => {
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
	term.onData(data => helm.pty.write(spawned.id, data))
	term.onResize(({ cols, rows }) => helm.pty.resize(spawned.id, cols, rows))
}

helm.pty.onData((id, data) => {
	tabs.find(t => t.ptyId === id)?.term.write(data)
})

helm.pty.onExit(id => {
	const tab = tabs.find(t => t.ptyId === id)
	if (tab) {
		tab.ptyId = null // pty is gone; don't kill it again on close
		closeTab(tab)
	}
})

new ResizeObserver(() => fitActive()).observe(termsEl)

// ---------- appearance: live re-theme + font-size ----------

// Theme/font changes re-apply to every open terminal. Only the ACTIVE tab can
// refit (hidden holders measure 0x0); background tabs refit in activate()'s
// rAF, so every terminal lands on the new metrics by the time it's visible.
appearance.subscribe(() => {
	const theme = appearance.getTermTheme()
	const fontSize = appearance.getTermFontSize()
	for (const tab of tabs) {
		tab.term.options.theme = theme
		if (tab.term.options.fontSize !== fontSize) tab.term.options.fontSize = fontSize
	}
	fitActive()
})

// cmd+= / cmd+- / cmd+0 (View menu accelerators — same main→IPC pattern as
// cmd+t): bounds + persistence live in the appearance store.
helm.appearance.onFontStep(step => appearance.stepTermFontSize(step))

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
	event => {
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
