import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
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
const divider = el<HTMLDivElement>('divider')
const tabsEl = el<HTMLDivElement>('tabs')
const newTabButton = el<HTMLButtonElement>('new-tab')
const termsEl = el<HTMLDivElement>('terms')
const bgRoot = el<HTMLDivElement>('bg-root')
const bgToggle = el<HTMLButtonElement>('bg-toggle')
const bgCount = el<HTMLSpanElement>('bg-count')
const bgPopover = el<HTMLDivElement>('bg-popover')
const bgRows = el<HTMLDivElement>('bg-rows')

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
		// Final fit at the released size — don't leave it to the debounce.
		fitActive()
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

// ---------- native sidebar ----------
// The sidebar owns the daemon-connection signal (waiting card when
// unreachable, silence when connected) — the topbar carries no dot/branding.

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
	/** In the background list (strip-right stack button + popover) instead of the strip. */
	parked: boolean
	/** Exit code when the pty ended while parked — the popover row stays, state "Exited". */
	exitCode: number | null
	/** Output arrived since parking — quiet dot on the popover row; cleared on restore/exit. */
	activity: boolean
	/** Ignore output before this timestamp: a dtach reattach repaints on spawn (-r winch),
	 *  and that redraw is not "new output since parking". */
	activityMuteUntil: number
	/** Current normalized label (popover row title, toast detail). */
	title: string
	/** Output arrived since the last buffer-snapshot save (10s autosave picks it up). */
	dirty: boolean
	term: Terminal
	fit: FitAddon
	/** Buffer serializer for snapshot saves (restore-before-attach, app/src/buffers.ts). */
	serialize: SerializeAddon
	holder: HTMLDivElement
	tabButton: HTMLDivElement
	/** Custom overlay scrollbar (§3.14): full-pane track + pill thumb. */
	scrollbar: HTMLDivElement
	thumb: HTMLDivElement
	/** rAF-coalescing flags (one pending frame each, never stacked). */
	fitRetryPending: boolean
	scrollSyncPending: boolean
	/** dtach's attach client home+clears (\e[H\e[J) as its FIRST output on every
	 *  attach (verified against attach with `-r none`: the stream is exactly
	 *  those 6 bytes) — it would wipe a restored buffer snapshot, so the first
	 *  chunk of a session-backed spawn is filtered once (see filterAttachClear). */
	attachClearPending: boolean
	attachClearHeld: string
}

// FitAddon measures getComputedStyle(term.element.parentElement).width, which
// under box-sizing:border-box INCLUDES that element's own padding — so xterm
// must be mounted in an UNPADDED .term-mount inside the padded .term-holder,
// or fit overcounts columns by the padding and the last cells paint past the
// pane edge (that exact bug shipped once; don't mount into the holder again).

const tabs: Tab[] = []
// Background terminals (iTerm "bury session" analog): parked tabs leave the
// strip but keep their Terminal instance mounted in the hidden holder — the
// pty stays attached and scrollback keeps accumulating. Memory cost equals an
// inactive strip tab (those are already hidden, live xterm instances).
const parked: Tab[] = []
let activeTab: Tab | null = null

const findByPty = (id: number): Tab | undefined => tabs.find(t => t.ptyId === id) ?? parked.find(t => t.ptyId === id)

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

function fitTab(tab: Tab): void {
	// Hidden/zero-size holders measure 0x0 — fitting then would clamp the grid
	// to FitAddon's 2x1 floor. DEFER instead of silently skipping: retry on the
	// next frames until the holder is measurable (first-paint guard — an open
	// before layout settles must not leave a mis-sized terminal until a manual
	// resize). Parked/backgrounded holders stay 0x0 by design; activate()'s rAF
	// refits those once visible, so the retry loop only chases the ACTIVE tab.
	if (tab.holder.clientWidth === 0 || tab.holder.clientHeight === 0) {
		scheduleFitRetry(tab)
		return
	}
	tab.fit.fit()
	scheduleScrollbarSync(tab)
}

function scheduleFitRetry(tab: Tab): void {
	if (tab.fitRetryPending || tab.closed) return
	tab.fitRetryPending = true
	requestAnimationFrame(() => {
		tab.fitRetryPending = false
		// Only the active tab is meant to be measurable; a tab hidden/parked
		// since the skip gets its deferred fit from activate() instead.
		if (tab.closed || tab !== activeTab) return
		fitTab(tab)
	})
}

function fitActive(): void {
	if (activeTab) fitTab(activeTab)
}

/**
 * Force the pty to the terminal's CURRENT fitted size after spawn/reattach.
 * fit.fit() only calls term.resize when dims changed, and term.onResize only
 * fires on change — so an equal-size fit sends nothing, and an equal-size pty
 * resize emits no SIGWINCH. For restored dtach sessions the REMOTE app's size
 * belief is stale from the previous run, so `nudge` forces a real WINCH pair
 * (cols-1 then cols): two TIOCSWINSZ changes → dtach client SIGWINCH → client
 * pushes its winsize to the session master → remote app relearns and relayouts.
 */
function syncPtySize(tab: Tab, spawnCols: number, spawnRows: number, nudge: boolean): void {
	if (tab.ptyId === null) return
	const { cols, rows } = tab.term
	if (cols !== spawnCols || rows !== spawnRows) {
		// Fitted size drifted while the spawn was in flight (onResize was not
		// attached yet, so the update was lost) — replay it.
		helm.pty.resize(tab.ptyId, cols, rows)
	} else if (nudge && cols > 2) {
		helm.pty.resize(tab.ptyId, cols - 1, rows)
		helm.pty.resize(tab.ptyId, cols, rows)
	}
}

// ---------- overlay scrollbar (§3.14) ----------
// xterm 6 scrolls through a monaco SmoothScrollableElement whose track is
// inline-sized to rows*cellHeight starting at the screen's top — inside the
// padded holder it can never reach the pane edges, and its square slider reads
// as a generic web scrollbar. Helm hides it (styles.css) and renders its own
// macOS-style overlay: a track spanning the FULL pane height with a pill
// thumb. Pure overlay — it lives inside FitAddon's fixed 14px scrollbar
// reserve, so it never reserves layout space or shifts terminal columns
// (columns are identical with or without scrollback).

const THUMB_MIN_PX = 24

function thumbMetrics(tab: Tab): { trackHeight: number; thumbHeight: number; maxTop: number } {
	const trackHeight = tab.scrollbar.clientHeight
	const thumbHeight = Math.max(THUMB_MIN_PX, Math.round((trackHeight * tab.term.rows) / tab.term.buffer.active.length))
	return { trackHeight, thumbHeight, maxTop: Math.max(0, trackHeight - thumbHeight) }
}

function syncScrollbar(tab: Tab): void {
	const buffer = tab.term.buffer.active
	// Alt-screen apps (vim/less) own the whole viewport — no scrollbar, like
	// Terminal.app. baseY === 0 = nothing has scrolled out yet.
	if (buffer.type === 'alternate' || buffer.baseY === 0) {
		tab.scrollbar.hidden = true
		return
	}
	tab.scrollbar.hidden = false
	const { trackHeight, thumbHeight, maxTop } = thumbMetrics(tab)
	if (trackHeight === 0) {
		// Hidden holder measures 0 — restore/activate refits and resyncs.
		tab.scrollbar.hidden = true
		return
	}
	const top = Math.round((maxTop * buffer.viewportY) / buffer.baseY)
	tab.thumb.style.height = `${thumbHeight}px`
	tab.thumb.style.transform = `translateY(${Math.min(maxTop, Math.max(0, top))}px)`
}

function scheduleScrollbarSync(tab: Tab): void {
	// rAF-coalesced: onWriteParsed can fire per chunk on the pty:data path —
	// one style write per frame, never per chunk (§6.2).
	if (tab.scrollSyncPending || tab.closed) return
	tab.scrollSyncPending = true
	requestAnimationFrame(() => {
		tab.scrollSyncPending = false
		if (!tab.closed) syncScrollbar(tab)
	})
}

function attachScrollbarInput(tab: Tab): void {
	tab.thumb.addEventListener('pointerdown', down => {
		if (down.button !== 0) return
		down.preventDefault()
		down.stopPropagation()
		tab.thumb.setPointerCapture(down.pointerId)
		tab.thumb.classList.add('active')
		const grabLine = tab.term.buffer.active.viewportY
		const startY = down.clientY
		const onMove = (move: PointerEvent): void => {
			const buffer = tab.term.buffer.active
			const { maxTop } = thumbMetrics(tab)
			if (maxTop <= 0) return
			const line = Math.round(grabLine + ((move.clientY - startY) * buffer.baseY) / maxTop)
			tab.term.scrollToLine(Math.min(buffer.baseY, Math.max(0, line)))
		}
		const onUp = (): void => {
			tab.thumb.classList.remove('active')
			tab.thumb.removeEventListener('pointermove', onMove)
			tab.thumb.removeEventListener('pointerup', onUp)
			tab.thumb.removeEventListener('pointercancel', onUp)
		}
		tab.thumb.addEventListener('pointermove', onMove)
		tab.thumb.addEventListener('pointerup', onUp)
		tab.thumb.addEventListener('pointercancel', onUp)
	})
	// Track click: macOS "jump to the spot that's clicked" — center the thumb
	// on the pointer.
	tab.scrollbar.addEventListener('pointerdown', event => {
		if (event.target !== tab.scrollbar || event.button !== 0) return
		event.preventDefault()
		const buffer = tab.term.buffer.active
		const { thumbHeight, maxTop } = thumbMetrics(tab)
		if (maxTop <= 0) return
		const top = Math.min(maxTop, Math.max(0, event.offsetY - thumbHeight / 2))
		tab.term.scrollToLine(Math.round((top * buffer.baseY) / maxTop))
	})
}

// ---------- buffer snapshots (restore-before-attach) ----------
// dtach preserves the PROCESS, not the SCREEN: a reattached session renders
// nothing until new output, so restored tabs used to come back black. Each
// session-backed tab serializes its buffer (colors + scrollback tail) and main
// persists it (<userData>/buffers, app/src/buffers.ts); reattach writes the
// snapshot into the fresh xterm BEFORE the live pty stream, and the normal
// fit → syncPtySize WINCH nudge redraws the prompt/TUI in place under it — no
// marker line, the natural redraw is the seam.

/** Target snapshot size. The ladder steps the serialized scrollback down until
 *  the output fits — front-truncating VT output would shear escape sequences. */
const SNAPSHOT_MAX_CHARS = 200_000
const SNAPSHOT_SCROLLBACK_LADDER = [2000, 500, 120, 0]
const SNAPSHOT_AUTOSAVE_MS = 10_000

function serializeSnapshot(tab: Tab): string | null {
	for (const scrollback of SNAPSHOT_SCROLLBACK_LADDER) {
		let output: string
		try {
			// Alt-screen content is excluded: a live TUI repaints itself on the
			// reattach WINCH; replaying its stale frame first would only flash.
			output = tab.serialize.serialize({ scrollback, excludeAltBuffer: true })
		} catch {
			return null
		}
		if (output.length <= SNAPSHOT_MAX_CHARS) return output
	}
	return null
}

function saveSnapshot(tab: Tab): void {
	tab.dirty = false
	if (!tab.sessionId) return
	const snapshot = serializeSnapshot(tab)
	// Empty serialize (nothing ever painted) must not clobber a good snapshot.
	if (snapshot) helm.buffers.save(tab.sessionId, snapshot)
}

function saveAllSnapshots(): void {
	for (const tab of [...tabs, ...parked]) {
		if (!tab.closed && tab.ptyId !== null && tab.sessionId) saveSnapshot(tab)
	}
}

// Throttled autosave: only tabs whose pty produced output since the last save.
setInterval(() => {
	for (const tab of [...tabs, ...parked]) {
		if (!tab.closed && tab.dirty && tab.ptyId !== null && tab.sessionId) saveSnapshot(tab)
	}
}, SNAPSHOT_AUTOSAVE_MS)

// Quit/window-close: main intercepts the close, asks for one final flush
// (before the xterm instances are torn down), and resumes the close on the ack.
helm.buffers.onFlush(() => {
	saveAllSnapshots()
	helm.buffers.flushed()
})

/** dtach attach.c writes cursor-home + erase-below to its terminal the moment
 *  a client attaches — BEFORE the WINCH redraw it requests from the program.
 *  Left alone it erases the just-restored snapshot (the black-terminal bug in
 *  its second form). Strip exactly that one leading sequence from the spawn's
 *  first output; anything else (including a split chunk) passes through intact. */
const ATTACH_CLEAR = '\x1b[H\x1b[J'

function filterAttachClear(tab: Tab, data: string): string {
	const buffered = tab.attachClearHeld + data
	if (buffered.length < ATTACH_CLEAR.length && ATTACH_CLEAR.startsWith(buffered)) {
		// Whole chunk is still a prefix of the clear — hold it, emit nothing yet.
		tab.attachClearHeld = buffered
		return ''
	}
	tab.attachClearPending = false
	tab.attachClearHeld = ''
	return buffered.startsWith(ATTACH_CLEAR) ? buffered.slice(ATTACH_CLEAR.length) : buffered
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
	const { title } = tab
	// Soft close (okena-style): main only DETACHES the pty client and arms a
	// grace timer — the dtach session dies when it fires. The toast's Undo
	// cancels the timer and reattaches the same session as a new tab.
	if (tab.ptyId !== null) {
		// Snapshot NOW, before dispose: the grace Undo replays exactly this
		// screen into the fresh xterm it reattaches.
		saveSnapshot(tab)
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
							if (alive) void createTerminal({ sessionId: grace.sessionId, title })
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

// ---------- background terminals (park / restore / kill + strip control) ----------
// iTerm2 "bury session" analog. A parked tab leaves the strip; its Terminal
// stays mounted in the hidden holder and the pty stays attached, so output
// keeps landing in scrollback. The strip-right stack button (visible only when
// parked.length > 0) opens the popover listing them.

/** dtach's `-r winch` repaint window after a reattach spawn — not "new output". */
const REATTACH_MUTE_MS = 2000

function parkTab(tab: Tab): void {
	if (tab.closed || tab.parked) return
	const index = tabs.indexOf(tab)
	if (index === -1) return
	tabs.splice(index, 1)
	tab.parked = true
	tab.activity = false
	parked.push(tab)
	tab.tabButton.remove()
	tab.holder.classList.remove('active')
	if (tab.sessionId) helm.sessions.setParked(tab.sessionId, true)
	// Park is a persistence point: a parked session relaunches as parked and
	// may only be restored (and repainted) much later.
	if (tab.ptyId !== null) saveSnapshot(tab)
	if (activeTab === tab) {
		activeTab = null
		const neighbor = tabs[Math.min(index, tabs.length - 1)]
		if (neighbor) activate(neighbor)
	}
	syncEmptyState()
	updateBackgroundUi()
}

/** Popover row click: back to the strip end, focused and refit. */
function restoreParked(tab: Tab): void {
	const index = parked.indexOf(tab)
	if (index === -1) return
	parked.splice(index, 1)
	tab.parked = false
	tab.activity = false // restore clears the activity dot
	tabs.push(tab)
	tabsEl.appendChild(tab.tabButton)
	if (tab.sessionId) helm.sessions.setParked(tab.sessionId, false)
	closeBackgroundPopover()
	updateBackgroundUi()
	syncEmptyState()
	// activate() refits via fitTab in its rAF once the holder is visible; the
	// pty stayed attached while parked, so the already-wired onResize replays
	// any pane-size drift to the pty (no WINCH nudge needed — nothing is stale).
	// An exited tab restores too: it shows the dead terminal's buffer.
	activate(tab)
}

/** Popover ✕: grace-close path; Undo restores to the BACKGROUND list, not a tab. */
function killParkedTab(tab: Tab): void {
	const index = parked.indexOf(tab)
	if (index === -1 || tab.closed) return
	tab.closed = true
	parked.splice(index, 1)
	const { title } = tab
	if (tab.ptyId !== null) {
		// Same snapshot-before-dispose as closeTab: Undo replays this screen.
		saveSnapshot(tab)
		void helm.sessions.closeWithGrace(tab.ptyId).then(grace => {
			if (!grace) return
			const toast = showToast({
				message: 'Background terminal closed',
				detail: title === 'zsh' ? undefined : title,
				ttlMs: grace.graceMs,
				countdown: true,
				action: {
					label: 'Undo',
					onClick: () => {
						toast.dismiss()
						void helm.sessions.undoClose(grace.sessionId).then(alive => {
							if (alive) void createTerminal({ sessionId: grace.sessionId, title, parked: true })
						})
					},
				},
			})
		})
	}
	// Exited rows (ptyId null) just remove — the session is already gone.
	tab.term.dispose()
	tab.holder.remove()
	updateBackgroundUi()
}

let bgOpen = false

function updateBackgroundUi(): void {
	bgToggle.hidden = parked.length === 0
	bgCount.textContent = String(parked.length)
	if (parked.length === 0) {
		closeBackgroundPopover()
		return
	}
	if (bgOpen) renderBackgroundRows()
}

function renderBackgroundRows(): void {
	// Preserve roving focus across re-renders (activity/exit updates).
	const focused = [...bgRows.querySelectorAll<HTMLElement>('.bg-row')].indexOf(document.activeElement as HTMLElement)
	bgRows.textContent = ''
	for (const tab of parked) {
		const row = document.createElement('div')
		row.className = 'bg-row'
		row.setAttribute('role', 'button')
		row.tabIndex = 0

		const dot = document.createElement('span')
		dot.className = `bg-dot${tab.activity ? ' on' : ''}`
		dot.setAttribute('aria-hidden', 'true')

		const title = document.createElement('span')
		title.className = `bg-title${tab.exitCode !== null ? ' exited' : ''}`
		title.textContent = tab.title

		const state = document.createElement('span')
		state.className = 'bg-state'
		state.textContent = tab.exitCode === null ? 'Running' : `Exited (${tab.exitCode})`

		const kill = document.createElement('button')
		kill.className = 'bg-kill'
		kill.textContent = '×'
		kill.title = 'Close'
		kill.setAttribute('aria-label', `Close ${tab.title}`)
		kill.addEventListener('click', event => {
			event.stopPropagation()
			killParkedTab(tab)
		})

		row.append(dot, title, state, kill)
		row.setAttribute('aria-label', `Restore ${tab.title}`)
		row.addEventListener('click', () => restoreParked(tab))
		row.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault()
				restoreParked(tab)
			}
		})
		bgRows.appendChild(row)
	}
	if (focused >= 0) {
		const rows = bgRows.querySelectorAll<HTMLElement>('.bg-row')
		rows[Math.min(focused, rows.length - 1)]?.focus()
	}
}

function onBgOutside(event: PointerEvent): void {
	if (!(event.target instanceof Node) || !bgRoot.contains(event.target)) closeBackgroundPopover()
}

function onBgKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape') {
		event.stopPropagation()
		closeBackgroundPopover()
		bgToggle.focus()
		return
	}
	if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
	const rows = [...bgRows.querySelectorAll<HTMLElement>('.bg-row')]
	if (rows.length === 0) return
	event.preventDefault()
	const current = rows.indexOf(document.activeElement as HTMLElement)
	const next = event.key === 'ArrowDown' ? rows[Math.min(current + 1, rows.length - 1)] : rows[Math.max(current - 1, 0)]
	next?.focus()
}

function openBackgroundPopover(): void {
	if (bgOpen || parked.length === 0) return
	closeTabMenu()
	bgOpen = true
	renderBackgroundRows()
	bgPopover.hidden = false
	bgToggle.setAttribute('aria-expanded', 'true')
	bgRows.querySelector<HTMLElement>('.bg-row')?.focus()
	document.addEventListener('pointerdown', onBgOutside, true)
	document.addEventListener('keydown', onBgKeydown, true)
}

function closeBackgroundPopover(): void {
	if (!bgOpen) return
	bgOpen = false
	bgPopover.hidden = true
	bgToggle.setAttribute('aria-expanded', 'false')
	document.removeEventListener('pointerdown', onBgOutside, true)
	document.removeEventListener('keydown', onBgKeydown, true)
}

bgToggle.addEventListener('click', () => {
	if (bgOpen) closeBackgroundPopover()
	else openBackgroundPopover()
})

// ---------- tab context menu (§3.8 panel at the pointer) ----------

let tabMenuCleanup: (() => void) | null = null

function closeTabMenu(): void {
	tabMenuCleanup?.()
}

interface TabMenuItem {
	label: string
	hint?: string
	onPick: () => void
}

function openTabMenu(tab: Tab, x: number, y: number): void {
	closeTabMenu()
	closeBackgroundPopover()
	const panel = document.createElement('div')
	panel.className = 'menu-panel menu-fixed'
	panel.setAttribute('role', 'menu')

	const items: TabMenuItem[] = [
		{ label: 'Move to background', hint: '⇧⌘B', onPick: () => parkTab(tab) },
		{ label: 'Close', hint: '⌘W', onPick: () => closeTab(tab) },
	]
	const buttons: HTMLButtonElement[] = []
	for (const item of items) {
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'menu-item'
		button.setAttribute('role', 'menuitem')
		const label = document.createElement('span')
		label.textContent = item.label
		button.appendChild(label)
		if (item.hint) {
			const hint = document.createElement('span')
			hint.className = 'menu-hint'
			hint.textContent = item.hint
			button.appendChild(hint)
		}
		button.addEventListener('click', () => {
			closeTabMenu()
			item.onPick()
		})
		buttons.push(button)
		panel.appendChild(button)
	}

	const onOutside = (event: PointerEvent): void => {
		if (!(event.target instanceof Node) || !panel.contains(event.target)) closeTabMenu()
	}
	const onKeydown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.stopPropagation()
			closeTabMenu()
			return
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
		event.preventDefault()
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
		const delta = event.key === 'ArrowDown' ? 1 : -1
		buttons[(current + delta + buttons.length) % buttons.length]?.focus()
	}
	tabMenuCleanup = () => {
		tabMenuCleanup = null
		panel.remove()
		document.removeEventListener('pointerdown', onOutside, true)
		document.removeEventListener('keydown', onKeydown, true)
	}
	document.addEventListener('pointerdown', onOutside, true)
	document.addEventListener('keydown', onKeydown, true)

	document.body.appendChild(panel)
	// Clamp inside the viewport now that the panel has a size.
	const rect = panel.getBoundingClientRect()
	panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
	panel.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
	buttons[0]?.focus()
}

// Zero terminals is a valid state — show a quiet hint instead of respawning
// (closing the last tab used to auto-open a new one; deliberate removal).
function syncEmptyState(): void {
	const empty = document.getElementById('no-terms')
	if (empty) empty.hidden = tabs.length > 0
}

interface TerminalOpts {
	/** Restored/undone session to reattach; omitted = create a fresh session. */
	sessionId?: string
	/** Persisted label shown until the shell emits a fresh OSC title. */
	title?: string | null
	/** Create straight into the background list (startup parked restore, kill-undo). */
	parked?: boolean
}

async function createTerminal(opts?: TerminalOpts): Promise<void> {
	const startParked = opts?.parked === true
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
	const serialize = new SerializeAddon()
	term.loadAddon(serialize)
	term.loadAddon(new WebLinksAddon())

	const holder = document.createElement('div')
	holder.className = 'term-holder'
	// Unpadded measurement/mount element — see the comment above interface Tab.
	const mount = document.createElement('div')
	mount.className = 'term-mount'
	holder.appendChild(mount)
	// Overlay scrollbar: sibling of the mount, so the track spans the holder's
	// FULL padding box (pane top to pane bottom) instead of the inset text area.
	const scrollbar = document.createElement('div')
	scrollbar.className = 'term-scrollbar'
	scrollbar.hidden = true
	scrollbar.setAttribute('aria-hidden', 'true')
	const thumb = document.createElement('div')
	thumb.className = 'term-scrollbar-thumb'
	scrollbar.appendChild(thumb)
	holder.appendChild(scrollbar)
	termsEl.appendChild(holder)
	term.open(mount)

	const tabButton = document.createElement('div')
	tabButton.className = 'tab'
	tabButton.setAttribute('role', 'tab')
	tabButton.tabIndex = 0
	const label = document.createElement('span')
	label.className = 'tab-label'
	const close = document.createElement('button')
	close.className = 'tab-close'
	close.textContent = '×'
	close.title = 'Close (⌘W)'
	close.setAttribute('aria-label', 'Close terminal')
	tabButton.append(label, close)

	const tab: Tab = {
		ptyId: null,
		sessionId: null,
		closed: false,
		parked: startParked,
		exitCode: null,
		activity: false,
		// A parked reattach repaints on spawn (dtach -r winch); that redraw must
		// not light the "output since parking" dot.
		activityMuteUntil: startParked ? performance.now() + REATTACH_MUTE_MS : 0,
		title: '',
		dirty: false,
		term,
		fit,
		serialize,
		holder,
		tabButton,
		scrollbar,
		thumb,
		fitRetryPending: false,
		scrollSyncPending: false,
		attachClearPending: true,
		attachClearHeld: '',
	}
	attachScrollbarInput(tab)
	// Restored tabs keep the label persisted from the previous run until the
	// reattached shell emits a fresh OSC title (normalized too — older runs
	// persisted raw "user@host:cwd" titles).
	tab.title = applyTabTitle(label, opts?.title ?? '')
	// Shell title arrives via OSC title events; empty titles fall back to "zsh".
	term.onTitleChange(title => {
		tab.title = applyTabTitle(label, title)
		if (tab.sessionId) helm.sessions.setTitle(tab.sessionId, tab.title)
		if (tab.parked) updateBackgroundUi()
	})
	term.onScroll(() => scheduleScrollbarSync(tab))
	term.onResize(() => scheduleScrollbarSync(tab))
	// Content growth while scrolled up moves no viewport (no onScroll fires)
	// but changes the thumb's proportion — onWriteParsed catches it.
	term.onWriteParsed(() => scheduleScrollbarSync(tab))

	tabButton.addEventListener('click', () => activate(tab))
	tabButton.addEventListener('keydown', event => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault()
			activate(tab)
		}
	})
	tabButton.addEventListener('contextmenu', event => {
		event.preventDefault()
		openTabMenu(tab, event.clientX, event.clientY)
	})
	close.addEventListener('click', event => {
		event.stopPropagation()
		closeTab(tab)
	})

	if (startParked) {
		// Headless: hidden holder, no strip button — listed in the popover only.
		parked.push(tab)
		updateBackgroundUi()
	} else {
		tabs.push(tab)
		tabsEl.appendChild(tabButton)
		activate(tab)
		fitTab(tab)
	}

	// Restore-before-attach: write the previous run's screen into the fresh
	// xterm BEFORE the live dtach stream lands (startup tabs, background
	// restore, and grace-undo all pass sessionId — one seam). The reattach
	// WINCH repaint then redraws the prompt/TUI in place under the restored
	// content; snapshot/live overlap needs no marker line. Awaited before
	// spawn so no live byte can beat the snapshot into the write queue.
	if (opts?.sessionId) {
		try {
			const snapshot = await helm.buffers.read(opts.sessionId)
			if (snapshot && !tab.closed) {
				tab.term.write(snapshot, () => {
					if (tab.closed) return
					// Belt-and-braces first-paint guard: force the restored frame
					// onto the screen even if the session never emits another byte.
					tab.term.refresh(0, tab.term.rows - 1)
					scheduleScrollbarSync(tab)
				})
			}
		} catch {
			// no snapshot — the reattach shows the live redraw only
		}
	}

	// Spawn with the best-known size, but treat it as provisional: layout can
	// settle during the await (activate()'s rAF fit, fonts, first paint), and
	// any term.resize in that window is LOST — onResize is attached only below.
	const spawnCols = term.cols
	const spawnRows = term.rows
	const spawned = await helm.pty.spawn(spawnCols, spawnRows, opts?.sessionId)
	if (tab.closed) {
		helm.pty.kill(spawned.id)
		return
	}
	tab.ptyId = spawned.id
	tab.sessionId = spawned.sessionId
	// Re-assert the parked flag under the REAL session id (a fresh spawn mints
	// one) so a parked terminal relaunches as parked.
	if (tab.parked && spawned.sessionId) helm.sessions.setParked(spawned.sessionId, true)
	term.onData(data => helm.pty.write(spawned.id, data))
	term.onResize(({ cols, rows }) => helm.pty.resize(spawned.id, cols, rows))
	// spawn → mount → fit → resize pty: re-fit now that layout settled, then
	// force the pty onto the fitted size (with a WINCH nudge for reattached
	// sessions whose remote app still believes the previous run's size).
	// A tab restored from the background mid-spawn lands here too (parked is
	// false again), replaying the fitted size the lost-resize window ate.
	if (!tab.parked) {
		fitTab(tab)
		syncPtySize(tab, spawnCols, spawnRows, opts?.sessionId !== undefined)
	}
}

helm.pty.onData((id, data) => {
	const tab = findByPty(id)
	if (!tab) return
	// Session-backed spawns: swallow dtach's one-time attach clear so it can't
	// wipe the restored snapshot (non-dtach fallback ptys emit no such prefix).
	let output = data
	if (tab.attachClearPending && tab.sessionId !== null) {
		output = filterAttachClear(tab, data)
		if (output === '') return
	}
	tab.term.write(output)
	tab.dirty = true // snapshot autosave picks this tab up on the next tick
	// Quiet activity dot: first output since parking (once — no per-chunk DOM
	// work on the pty:data path, §6.2).
	if (tab.parked && !tab.activity && performance.now() >= tab.activityMuteUntil) {
		tab.activity = true
		updateBackgroundUi()
	}
})

helm.pty.onExit((id, exitCode) => {
	const tab = findByPty(id)
	if (!tab) return
	tab.ptyId = null // pty is gone; don't kill it again on close
	tab.dirty = false // session over — its snapshot is reaped with it, don't re-save
	if (tab.parked) {
		// Exited in the background: keep the row (state "Exited"), no toast spam.
		// The exit burst is a death rattle, not activity — the state says it all.
		tab.exitCode = exitCode
		tab.activity = false
		updateBackgroundUi()
	} else {
		closeTab(tab)
	}
})

// Debounced refit on pane size changes (~50ms): #terms tracks every source of
// terminal-pane width change (divider drag, window resize, --left-width), and
// rapid divider drags would otherwise refit + pty-resize every pointermove.
// The drag-end pointerup calls fitActive() directly for the final size.
let fitTimer: ReturnType<typeof setTimeout> | undefined
new ResizeObserver(() => {
	clearTimeout(fitTimer)
	fitTimer = setTimeout(fitActive, 50)
}).observe(termsEl)

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

// First-paint guard: cell metrics measured before a font finished loading
// mis-size the grid until the next resize — refit once the font set settles.
// (SF Mono/Menlo are local, so this usually resolves before the first fit.)
void document.fonts.ready.then(() => fitActive())

// New-tab actions are gated until session restore finishes, so restored tabs
// always come first and a fast cmd+T can't interleave with reattachment.
let tabsReady = false

newTabButton.addEventListener('click', () => {
	if (tabsReady) void createTerminal()
})
helm.tabs.onNew(() => {
	if (tabsReady) void createTerminal()
})
helm.tabs.onClose(() => {
	if (activeTab) closeTab(activeTab)
})
// ⌘⇧B (Shell menu accelerator — xterm swallows renderer keys): park the
// active tab into the background list.
helm.tabs.onBackground(() => {
	if (tabsReady && activeTab) parkTab(activeTab)
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

// --ui-preview=background[-strip] (screenshot harness): park one running and
// one exited session — real ptys, really parked — so the strip control, badge,
// and both popover row states are capturable without a daemon or manual setup.
// `background` opens the popover; `background-strip` leaves it closed.
async function runUiPreview(): Promise<void> {
	const preview = helm.uiPreview
	// background-park: park the ACTIVE tab (after any --term-cmd output landed)
	// so a later run against the same profile/socket pool verifies parked
	// snapshot restore. background-restore: restore the first startup-parked
	// session back to a tab — the popover row-click analog, screenshot-driven.
	if (preview === 'background-park') {
		await new Promise(resolve => setTimeout(resolve, 1500))
		if (activeTab) parkTab(activeTab)
		return
	}
	if (preview === 'background-restore') {
		const first = parked[0]
		if (first) restoreParked(first)
		return
	}
	if (preview !== 'background' && preview !== 'background-strip') return
	await createTerminal().catch(() => {})
	const exiting = activeTab
	if (exiting) {
		parkTab(exiting)
		// A real exit, observed through the normal pty:exit path → "Exited (0)".
		if (exiting.ptyId !== null) helm.pty.write(exiting.ptyId, 'exit\r')
	}
	await createTerminal().catch(() => {})
	const running = activeTab
	if (running) {
		parkTab(running)
		// Output after parking lights the quiet activity dot.
		if (running.ptyId !== null) helm.pty.write(running.ptyId, 'true\r')
	}
	if (preview === 'background') openBackgroundPopover()
}

// Startup: reattach every dtach session that survived the previous run —
// non-parked sessions as strip tabs (saved titles restored), parked sessions
// headless into the background popover. Fresh single tab only when no strip
// tab survived. Zero tabs stays a valid state after that — closing restored
// tabs never respawns.
void (async () => {
	let restored: RestoredSession[] = []
	try {
		restored = await helm.sessions.list()
	} catch {
		// persistence unavailable — fall through to a fresh tab
	}
	const stripSessions = restored.filter(s => !s.parked)
	const parkedSessions = restored.filter(s => s.parked)
	if (stripSessions.length === 0) {
		await createTerminal().catch(() => {})
	} else {
		for (const session of stripSessions) {
			// One failed reattach must not sink the remaining sessions.
			await createTerminal({ sessionId: session.sessionId, title: session.title }).catch(() => {})
		}
		const first = tabs[0]
		if (first) activate(first)
	}
	for (const session of parkedSessions) {
		await createTerminal({ sessionId: session.sessionId, title: session.title, parked: true }).catch(() => {})
	}
	tabsReady = true
	// --term-cmd (screenshot harness): type a command into the first tab's
	// shell. The pty input buffer holds it until the shell is ready to read.
	// (read through a closure: top-level CFA otherwise keeps activeTab narrowed
	// to its `null` initializer — the createTerminal calls above reassigned it)
	const cmdTab = ((): Tab | null => activeTab)()
	if (helm.termCmd && cmdTab && cmdTab.ptyId !== null) helm.pty.write(cmdTab.ptyId, `${helm.termCmd}\r`)
	// --term-scroll (screenshot harness): after the command's output lands
	// (~2.2s < the 3s capture settle), pin the viewport to a scroll extreme so
	// the overlay scrollbar's top-reach / mid-travel are capturable.
	if (helm.termScroll) {
		const target = helm.termScroll
		setTimeout(() => {
			const tab = ((): Tab | null => activeTab)()
			if (!tab) return
			const buffer = tab.term.buffer.active
			tab.term.scrollToLine(target === 'top' ? 0 : Math.floor(buffer.baseY / 2))
		}, 2200)
	}
	await runUiPreview()
})()
