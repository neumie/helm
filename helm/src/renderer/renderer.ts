import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import type { HelmApi } from '../shared'

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
const divider = el<HTMLDivElement>('divider')
const tabsEl = el<HTMLDivElement>('tabs')
const newTabButton = el<HTMLButtonElement>('new-tab')
const termsEl = el<HTMLDivElement>('terms')

// ---------- split divider ----------

const LEFT_WIDTH_KEY = 'helm.leftWidth'
const MIN_LEFT = 320
const maxLeft = () => Math.floor(window.innerWidth * 0.6)
const clampLeft = (width: number) => Math.min(Math.max(width, MIN_LEFT), maxLeft())

let leftWidth = clampLeft(Number(localStorage.getItem(LEFT_WIDTH_KEY)) || 480)

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

// ---------- dashboard iframe ----------

const daemonUrl = helm.config.getDaemonUrl()
daemonUrlLabel.textContent = daemonUrl

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function connectDashboard(): Promise<void> {
	// Never point the iframe at a dead daemon — a broken frame is uglier than the retry note.
	while (!(await helm.config.pingDaemon())) {
		await sleep(2000)
	}
	dashFrame.src = daemonUrl
	dashOffline.classList.add('hidden')
}
void connectDashboard()

// ---------- terminal tabs ----------

const termTheme = {
	background: '#141517',
	foreground: '#d4d6da',
	cursor: '#4c9aff',
	cursorAccent: '#141517',
	selectionBackground: 'rgba(76, 154, 255, 0.30)',
	black: '#292c31',
	red: '#f2585b',
	green: '#4ec98a',
	yellow: '#e0b341',
	blue: '#4c9aff',
	magenta: '#c07fd4',
	cyan: '#56c8d8',
	white: '#d4d6da',
	brightBlack: '#585c63',
	brightRed: '#ff6b6e',
	brightGreen: '#63e0a0',
	brightYellow: '#f0c66a',
	brightBlue: '#6fb1ff',
	brightMagenta: '#d49ae4',
	brightCyan: '#78dbe8',
	brightWhite: '#f0f1f2',
}

interface Tab {
	ptyId: number | null
	closed: boolean
	term: Terminal
	fit: FitAddon
	holder: HTMLDivElement
	tabButton: HTMLDivElement
}

const tabs: Tab[] = []
let activeTab: Tab | null = null
let tabCounter = 0

function fitActive(): void {
	if (!activeTab) return
	activeTab.fit.fit()
}

function activate(tab: Tab): void {
	activeTab = tab
	for (const t of tabs) {
		t.holder.classList.toggle('active', t === tab)
		t.tabButton.classList.toggle('active', t === tab)
	}
	// Fit after the holder becomes visible; hidden containers measure as 0x0.
	requestAnimationFrame(() => {
		fitActive()
		tab.term.focus()
	})
}

function closeTab(tab: Tab): void {
	if (tab.closed) return
	tab.closed = true
	if (tab.ptyId !== null) helm.pty.kill(tab.ptyId)
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
	// Keep the cockpit usable: closing the last terminal spawns a fresh one.
	if (tabs.length === 0) void createTab()
}

async function createTab(): Promise<void> {
	const term = new Terminal({
		cursorBlink: true,
		scrollback: 10000,
		fontSize: 13,
		fontFamily: "'SF Mono', Menlo, ui-monospace, monospace",
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

	const title = `Terminal ${++tabCounter}`
	const tabButton = document.createElement('div')
	tabButton.className = 'tab'
	const label = document.createElement('span')
	label.textContent = title
	const close = document.createElement('button')
	close.className = 'tab-close'
	close.textContent = '×'
	close.title = 'Close (⌘W)'
	tabButton.append(label, close)
	tabsEl.appendChild(tabButton)

	const tab: Tab = { ptyId: null, closed: false, term, fit, holder, tabButton }
	tabs.push(tab)

	tabButton.addEventListener('click', () => activate(tab))
	close.addEventListener('click', (event) => {
		event.stopPropagation()
		closeTab(tab)
	})

	activate(tab)
	fit.fit()

	const ptyId = await helm.pty.spawn(term.cols, term.rows)
	if (tab.closed) {
		helm.pty.kill(ptyId)
		return
	}
	tab.ptyId = ptyId
	term.onData((data) => helm.pty.write(ptyId, data))
	term.onResize(({ cols, rows }) => helm.pty.resize(ptyId, cols, rows))
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

newTabButton.addEventListener('click', () => void createTab())
helm.tabs.onNew(() => void createTab())
helm.tabs.onClose(() => {
	if (activeTab) closeTab(activeTab)
})

void createTab()
