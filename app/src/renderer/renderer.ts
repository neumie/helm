import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { appearance } from './appearance'
import { mountSidebar } from './sidebar/SidebarRoot'
import { mountTerminalWorkspace } from './terminal-workspace'

// Apply the persisted theme/scale/font-size before anything paints or mounts.
appearance.init()

function el<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id)
	if (!node) throw new Error(`missing #${id}`)
	return node as T
}

const leftPane = el<HTMLElement>('left')
const divider = el<HTMLDivElement>('divider')

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

// ---------- native sidebar ----------
// The sidebar owns the daemon-connection signal (waiting card when
// unreachable; silence when connected) — the topbar carries no dot/branding.

mountSidebar(leftPane)

// The workspace receives the preload-captured bridge explicitly. ADR-0003's
// canonical ID-based placement module owns placement; runtime Tab/xterm objects
// are only ID-keyed projection adapters.
const workspace = mountTerminalWorkspace({ root: document, helm: window.helm, appearance })

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
		// Final fit at the released size — don't leave it to the debounce.
		workspace.fitActive()
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

// Profile activation reloads this renderer after its bridge fence and buffer
// flush. The mount remains profile-token-bound through window.helm for its full
// lifetime; no other namespace can reuse it.
void workspace.ready
