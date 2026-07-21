import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import type { RestoredSession } from '../shared'
import { createActivityIndicator, setActivityIndicatorState } from './activity-indicator'
import { appearance } from './appearance'
import { mountSidebar } from './sidebar/SidebarRoot'
import { type SynchronizedOutputGuard, createSynchronizedOutputGuard } from './synchronized-output'
import {
	dragThresholdExceeded,
	moveToInsertionIndex,
	pointInExpandedRect,
	stripDropInsertionIndex,
	tabStripAutoScrollDelta,
} from './tab-drag'
import { decideTabTitle, isShellDefaultTitle, normalizeTabTitle } from './tab-title'
import { terminalShortcut } from './terminal-keybindings'
import {
	type TerminalProgressTracker,
	createTerminalProgressTracker,
	shouldMarkTerminalCompletion,
} from './terminal-progress'
import { showToast } from './toast'

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
const topbarDragSpace = el<HTMLDivElement>('topbar-drag-space')
const bgRoot = el<HTMLDivElement>('bg-root')
const bgToggle = el<HTMLButtonElement>('bg-toggle')
const bgCount = el<HTMLSpanElement>('bg-count')
const bgHeaderCount = el<HTMLSpanElement>('bg-header-count')
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
	/** Current APPLIED normalized title (label when unpinned; popover/toast text). */
	title: string
	/** Raw form of `title` — the tooltip shows it when normalization changed it. */
	titleRaw: string
	/** Last SEEN live OSC title (normalized/raw), applied or not — pinned tabs'
	 *  tooltip shows it and an unpin falls back to it. Null until OSC arrives. */
	oscTitle: string | null
	oscRaw: string | null
	/** Manual rename pin: label text, OSC-immune, persisted as registry customName. */
	customName: string | null
	/** Reattached an existing dtach session — arms restored-title stickiness. */
	restored: boolean
	/** A non-default OSC title applied since attach; stickiness is over. */
	titleSettled: boolean
	/** performance.now() when pty:spawn resolved; Infinity while spawning. */
	attachedAt: number
	/** Output arrived since the last buffer-snapshot save (10s autosave picks it up). */
	dirty: boolean
	/** Holds the last complete viewport over xterm while a large DEC synchronized
	 *  redraw parses; snapshot/scrollbar work also waits for this to clear. */
	frameOutputPending: boolean
	frameFreeze: HTMLElement | null
	outputGuard: SynchronizedOutputGuard
	/** Explicit OSC 9;4 state from Pi; never inferred from terminal output. */
	agentRunning: boolean
	/** A protocol-observed active→clear transition not yet viewed by the user. */
	agentAttention: boolean
	progressTracker: TerminalProgressTracker
	runningEl: HTMLOutputElement
	term: Terminal
	fit: FitAddon
	/** Buffer serializer for snapshot saves (restore-before-attach, app/src/buffers.ts). */
	serialize: SerializeAddon
	holder: HTMLDivElement
	tabButton: HTMLDivElement
	/** The tab's label span — renderTabLabel owns its text/tooltip. */
	labelEl: HTMLSpanElement
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

function persistTerminalOrder(): void {
	const sessionIds = [...tabs, ...parked].flatMap(tab => (tab.sessionId ? [tab.sessionId] : []))
	if (sessionIds.length > 0) helm.sessions.setOrder(sessionIds)
}

const findByPty = (id: number): Tab | undefined => tabs.find(t => t.ptyId === id) ?? parked.find(t => t.ptyId === id)

// Title normalization + arbitration (stickiness/pin rules) live in
// ./tab-title.ts — pure and node-testable (tests/helm-tab-title.test.ts).

/** Displayed tab name: the manual pin wins over the live/restored OSC title. */
function displayName(tab: Tab): string {
	return tab.customName ?? tab.title
}

/**
 * Render the label + tooltip from tab state. Unpinned: label = normalized
 * title, tooltip = raw title when normalization changed it (today's behavior).
 * Pinned: label = customName, tooltip = the live OSC title (raw preferred) so
 * the underlying shell/program identity stays one hover away.
 */
function renderTabLabel(tab: Tab): void {
	const text = displayName(tab)
	tab.labelEl.textContent = text
	const state = tab.agentRunning ? 'Running' : tab.agentAttention ? 'Run finished — unchecked' : null
	tab.tabButton.setAttribute('aria-label', state ? `${text} — ${state}` : text)
	const tip = tab.customName !== null ? (tab.oscRaw ?? tab.oscTitle ?? (tab.titleRaw || tab.title)) : tab.titleRaw
	if (tip && tip !== text) tab.labelEl.title = tip
	else tab.labelEl.removeAttribute('title')
}

function renderTabAgentState(tab: Tab): void {
	tab.runningEl.hidden = !tab.agentRunning && !tab.agentAttention
	if (tab.agentAttention) {
		setActivityIndicatorState(tab.runningEl, 'attention', 'Run finished — open tab to clear')
	} else {
		setActivityIndicatorState(tab.runningEl, 'progress', 'Running')
	}
	renderTabLabel(tab)
	if (tab.parked) updateBackgroundUi()
}

function setTabAgentAttention(tab: Tab, attention: boolean): void {
	if (tab.agentAttention === attention) return
	tab.agentAttention = attention
	renderTabAgentState(tab)
}

function clearTabAgentAttention(tab: Tab): void {
	setTabAgentAttention(tab, false)
}

function setTabAgentRunning(tab: Tab, running: boolean): void {
	if (tab.agentRunning === running) return
	const wasRunning = tab.agentRunning
	tab.agentRunning = running
	if (running) tab.agentAttention = false
	else {
		tab.agentAttention = shouldMarkTerminalCompletion({
			wasRunning,
			closed: tab.closed,
			tabSelected: activeTab === tab,
			windowFocused: document.hasFocus(),
		})
	}
	renderTabAgentState(tab)
}

// ---------- manual rename (double-click a tab / context-menu "Rename…") ----------
// A committed name PINS the tab (registry customName): OSC never overwrites
// it, it survives relaunch and park/restore. An empty commit unpins — OSC
// title following resumes. Spec: docs/design-system.md §3.14 (tab labels).

function commitCustomName(tab: Tab, name: string | null): void {
	const trimmed = (name ?? '').trim().slice(0, 200)
	tab.customName = trimmed === '' ? null : trimmed
	if (tab.sessionId) helm.sessions.setCustomName(tab.sessionId, tab.customName)
	if (tab.customName === null && tab.oscTitle !== null) {
		// Unpin resumes OSC following from the live truth seen while pinned.
		tab.title = tab.oscTitle
		tab.titleRaw = tab.oscRaw ?? ''
		if (tab.sessionId) helm.sessions.setTitle(tab.sessionId, tab.title)
	}
	renderTabLabel(tab)
	if (tab.parked) updateBackgroundUi()
}

function startRename(tab: Tab): void {
	if (tab.closed || tab.tabButton.querySelector('.tab-rename')) return
	const input = document.createElement('input')
	input.className = 'tab-rename'
	input.type = 'text'
	input.value = displayName(tab)
	input.setAttribute('aria-label', 'Rename terminal')
	tab.labelEl.hidden = true
	tab.tabButton.insertBefore(input, tab.labelEl)
	let done = false
	const finish = (commit: boolean): void => {
		if (done) return
		done = true
		const value = input.value
		input.remove()
		tab.labelEl.hidden = false
		// Unchanged value is a no-op — a stray double-click + click-away must
		// not silently pin the current OSC title.
		if (commit && value.trim() !== displayName(tab).trim()) commitCustomName(tab, value)
		if (tab === activeTab) tab.term.focus()
	}
	input.addEventListener('keydown', event => {
		event.stopPropagation() // keep ⌘1-9/global capture handlers out of the field
		if (event.key === 'Enter') finish(true)
		else if (event.key === 'Escape') finish(false)
	})
	input.addEventListener('blur', () => finish(true))
	// Don't let the click that opened the editor re-activate/re-open things.
	input.addEventListener('pointerdown', event => event.stopPropagation())
	input.focus()
	input.select()
}

// Vertical inset flexes so the grid packs the MAXIMUM rows that fit (§3.14):
// with a fixed 14px inset pair, the integer-row remainder (0..cellHeight-1)
// stacked on the bottom inset left up to ~31px blank below the last line —
// more than a whole row, which read as "one line is missing". Rows are now
// computed against the minimum inset (6px); the leftover splits into
// top/bottom insets capped at the nominal 14px (any excess beyond that stays
// at the bottom, exactly like the old remainder).
const TERM_VINSET_NOMINAL = 14
const TERM_VINSET_MIN = 6

/** xterm core render service (same private seam FitAddon reads/uses). */
interface CoreRenderAccess {
	_core: {
		_renderService: {
			dimensions: { css: { cell: { height: number } } }
			clear(): void
		}
	}
}

function cellHeightOf(term: Terminal): number {
	return (term as unknown as CoreRenderAccess)._core._renderService.dimensions.css.cell.height
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
	// Cols come from FitAddon (width math unchanged — vertical padding never
	// affects the mount's width); rows are packed against the flexed inset.
	const proposal = tab.fit.proposeDimensions()
	const cellHeight = cellHeightOf(tab.term)
	if (!proposal || Number.isNaN(proposal.cols) || !(cellHeight > 0)) {
		scheduleFitRetry(tab) // renderer metrics not ready yet (fresh open)
		return
	}
	// clientHeight = padding box (border-box, no border): the full pane height.
	const paneHeight = tab.holder.clientHeight
	const rows = Math.max(2, Math.floor((paneHeight - 2 * TERM_VINSET_MIN) / cellHeight))
	const leftover = Math.max(0, paneHeight - Math.ceil(rows * cellHeight))
	const padTop = Math.max(TERM_VINSET_MIN, Math.min(TERM_VINSET_NOMINAL, Math.floor(leftover / 2)))
	const padBottom = Math.max(TERM_VINSET_MIN, leftover - padTop)
	tab.holder.style.paddingTop = `${padTop}px`
	tab.holder.style.paddingBottom = `${padBottom}px`
	const cols = Math.max(2, proposal.cols)
	if (tab.term.cols !== cols || tab.term.rows !== rows) {
		// Mirror FitAddon.fit(): clear the renderer before resizing, else the
		// DOM renderer can leave artifacts of the old grid.
		;(tab.term as unknown as CoreRenderAccess)._core._renderService.clear()
		tab.term.resize(cols, rows)
	}
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
	// xterm's model mutates while a synchronized redraw is still hidden behind
	// the last complete visual frame. Keep the matching scrollbar stable too.
	if (tab.frameOutputPending) return
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
	// Never persist xterm's transient clear/partial replay. Leave dirty set so
	// the next autosave captures the completed synchronized frame.
	if (tab.frameOutputPending) return
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

function freezeTerminalFrame(tab: Tab): void {
	tab.frameOutputPending = true
	if (tab.frameFreeze) return
	const screen = tab.holder.querySelector('.xterm-screen')
	if (!(screen instanceof HTMLElement) || !screen.parentElement) return
	const freeze = screen.cloneNode(true)
	if (!(freeze instanceof HTMLElement)) return
	freeze.classList.add('term-frame-freeze')
	freeze.setAttribute('aria-hidden', 'true')
	// cloneNode does not copy canvas pixels. The current renderer is DOM-based,
	// but preserving canvases keeps this guard correct if xterm changes renderer.
	const sourceCanvases = screen.querySelectorAll('canvas')
	const frozenCanvases = freeze.querySelectorAll('canvas')
	for (let index = 0; index < Math.min(sourceCanvases.length, frozenCanvases.length); index += 1) {
		const source = sourceCanvases.item(index)
		const target = frozenCanvases.item(index)
		const context = target.getContext('2d')
		if (context) context.drawImage(source, 0, 0)
	}
	screen.parentElement.append(freeze)
	tab.frameFreeze = freeze
}

function unfreezeTerminalFrame(tab: Tab): void {
	tab.frameOutputPending = false
	tab.frameFreeze?.remove()
	tab.frameFreeze = null
	scheduleScrollbarSync(tab)
}

function activate(tab: Tab): void {
	activeTab = tab
	clearTabAgentAttention(tab)
	for (const t of [...tabs, ...parked]) t.holder.classList.toggle('active', t === tab)
	for (const t of tabs) {
		t.tabButton.classList.toggle('active', t === tab)
		t.tabButton.setAttribute('aria-selected', String(t === tab))
	}
	syncEmptyState()
	// Fit after the holder becomes visible; hidden containers measure as 0x0.
	requestAnimationFrame(() => {
		fitActive()
		// A double-click runs activate (click) before startRename (dblclick):
		// this deferred focus would land on the just-opened rename input and
		// blur-commit it within a frame. The editor owns focus while open.
		if (document.activeElement?.classList.contains('tab-rename')) return
		tab.term.focus()
	})
}

// A completion that arrived while Helm was behind another app remains unseen
// even when its tab was selected; focusing Helm is the user's explicit check.
window.addEventListener('focus', () => {
	if (activeTab) clearTabAgentAttention(activeTab)
})

function cycleTab(delta: number): void {
	if (tabs.length === 0) return
	const activeIndex = activeTab ? tabs.indexOf(activeTab) : -1
	const current = activeIndex >= 0 ? activeIndex : delta > 0 ? -1 : 0
	const next = tabs[(current + delta + tabs.length) % tabs.length]
	if (next && next !== activeTab) activate(next)
}

function closeTab(tab: Tab): void {
	if (tab.closed) return
	tab.closed = true
	// Snapshot before releasing a synchronized redraw guard: saveSnapshot skips
	// a pending replacement frame, preserving the previous complete snapshot.
	if (tab.ptyId !== null) saveSnapshot(tab)
	tab.outputGuard.abort()
	tab.progressTracker.clear()
	const { title, customName } = tab
	const shown = customName ?? title
	// Soft close (okena-style): main only DETACHES the pty client and arms a
	// grace timer — the dtach session dies when it fires. The toast's Undo
	// cancels the timer and reattaches the same session as a new tab.
	if (tab.ptyId !== null) {
		void helm.sessions.closeWithGrace(tab.ptyId).then(grace => {
			if (!grace) return // non-persistent pty — already fully killed, nothing to undo
			const toast = showToast({
				message: 'Terminal closed',
				detail: shown === 'zsh' ? undefined : shown,
				ttlMs: grace.graceMs,
				countdown: true,
				action: {
					label: 'Undo',
					onClick: () => {
						toast.dismiss()
						void helm.sessions.undoClose(grace.sessionId).then(alive => {
							// Undo keeps the rename pin — it reattaches the same session.
							if (alive) void createTerminal({ sessionId: grace.sessionId, title, customName })
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
	persistTerminalOrder()
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

function parkTab(tab: Tab): void {
	if (tab.closed || tab.parked) return
	const index = tabs.indexOf(tab)
	if (index === -1) return
	tabs.splice(index, 1)
	tab.parked = true
	parked.push(tab)
	tab.tabButton.remove()
	tab.holder.classList.remove('active')
	if (tab.sessionId) helm.sessions.setParked(tab.sessionId, true)
	persistTerminalOrder()
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

/** Open the terminal pane without changing its persisted background ownership. */
function openParked(tab: Tab): void {
	if (!parked.includes(tab) || tab.closed) return
	closeBackgroundPopover()
	activate(tab)
	updateBackgroundUi()
}

/** Move back to the strip end, focused and refit. */
function restoreParked(tab: Tab): void {
	const index = parked.indexOf(tab)
	if (index === -1) return
	parked.splice(index, 1)
	tab.parked = false
	tabs.push(tab)
	tabsEl.appendChild(tab.tabButton)
	if (tab.sessionId) helm.sessions.setParked(tab.sessionId, false)
	persistTerminalOrder()
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
	// Same snapshot-before-guard-release rule as closeTab.
	if (tab.ptyId !== null) saveSnapshot(tab)
	tab.outputGuard.abort()
	tab.progressTracker.clear()
	parked.splice(index, 1)
	persistTerminalOrder()
	const { title, customName } = tab
	const shown = customName ?? title
	if (tab.ptyId !== null) {
		void helm.sessions.closeWithGrace(tab.ptyId).then(grace => {
			if (!grace) return
			const toast = showToast({
				message: 'Background terminal closed',
				detail: shown === 'zsh' ? undefined : shown,
				ttlMs: grace.graceMs,
				countdown: true,
				action: {
					label: 'Undo',
					onClick: () => {
						toast.dismiss()
						void helm.sessions.undoClose(grace.sessionId).then(alive => {
							if (alive) void createTerminal({ sessionId: grace.sessionId, title, customName, parked: true })
						})
					},
				},
			})
		})
	}
	// Exited rows (ptyId null) just remove — the session is already gone.
	tab.term.dispose()
	tab.holder.remove()
	if (activeTab === tab) {
		activeTab = null
		const neighbor = tabs[0]
		if (neighbor) activate(neighbor)
	}
	syncEmptyState()
	updateBackgroundUi()
}

let bgOpen = false

function updateBackgroundUi(): void {
	const empty = parked.length === 0
	const focusWasInPopover = empty && bgPopover.contains(document.activeElement)
	bgToggle.hidden = empty
	bgCount.textContent = String(parked.length)
	bgHeaderCount.textContent = String(parked.length)
	if (empty) {
		closeBackgroundPopover()
		if (focusWasInPopover) newTabButton.focus()
		return
	}
	if (bgOpen) renderBackgroundRows()
}

function renderBackgroundRows(): void {
	// Preserve the row across re-renders (OSC activity / exit / title updates).
	const focusedRow = document.activeElement?.closest('.bg-row')
	const focused = [...bgRows.querySelectorAll<HTMLElement>('.bg-row')].indexOf(focusedRow as HTMLElement)
	bgRows.textContent = ''
	for (const tab of parked) {
		const sessionState = tab.exitCode === null ? 'Running' : `Exited (${tab.exitCode})`
		const agentState = tab.agentAttention ? 'Run finished, needs attention' : tab.agentRunning ? 'Agent running' : null
		const row = document.createElement('div')
		row.className = `bg-row${activeTab === tab ? ' active' : ''}`

		const open = document.createElement('button')
		open.className = 'bg-open'
		open.title = 'Open and keep in background'
		open.setAttribute(
			'aria-label',
			`Open ${displayName(tab)} and keep in background — ${sessionState}${agentState ? `, ${agentState}` : ''}`,
		)
		open.addEventListener('click', () => openParked(tab))

		const activitySlot = document.createElement('span')
		activitySlot.className = 'bg-activity-slot'
		if (tab.agentRunning || tab.agentAttention) {
			const indicator = createActivityIndicator(
				tab.agentAttention ? 'Run finished — open terminal to clear' : 'Agent running',
				tab.agentAttention ? 'attention' : 'progress',
			)
			indicator.classList.add('bg-activity')
			activitySlot.append(indicator)
		}

		const title = document.createElement('span')
		title.className = `bg-title${tab.exitCode !== null ? ' exited' : ''}`
		title.textContent = displayName(tab) // rename pin shows here too

		const state = document.createElement('span')
		state.className = 'bg-state'
		state.textContent = sessionState
		open.append(activitySlot, title, state)

		const restore = document.createElement('button')
		restore.className = 'bg-action'
		restore.textContent = '⇥'
		restore.title = 'Move to tabs and open'
		restore.setAttribute('aria-label', `Move ${displayName(tab)} to tabs and open`)
		restore.addEventListener('click', () => restoreParked(tab))

		const kill = document.createElement('button')
		kill.className = 'bg-kill'
		kill.textContent = '×'
		kill.title = 'Close'
		kill.setAttribute('aria-label', `Close ${displayName(tab)}`)
		kill.addEventListener('click', () => killParkedTab(tab))

		row.append(open, restore, kill)
		bgRows.appendChild(row)
	}
	if (focused >= 0) {
		const rows = bgRows.querySelectorAll<HTMLElement>('.bg-row')
		rows[Math.min(focused, rows.length - 1)]?.querySelector<HTMLElement>('.bg-open')?.focus()
	}
}

function onBgOutside(event: PointerEvent): void {
	if (event.target instanceof Node && bgRoot.contains(event.target)) return
	const clickedTitlebar = event.target === topbarDragSpace
	closeBackgroundPopover()
	// A native titlebar target cannot receive DOM focus. Avoid leaving focus in
	// the now-hidden row; ordinary outside controls receive focus after pointerdown.
	if (clickedTitlebar) bgToggle.focus()
}

function onBgKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape') {
		event.stopPropagation()
		closeBackgroundPopover()
		bgToggle.focus()
		return
	}
	if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
	const rows = [...bgRows.querySelectorAll<HTMLElement>('.bg-open')]
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
	// Native Electron drag regions swallow DOM pointer events. While this
	// non-modal popover is open, make only the trailing whitespace a regular
	// hit target so clicking the titlebar dismisses it; closing restores drag.
	topbarDragSpace.classList.add('popover-catcher')
	bgRows.querySelector<HTMLElement>('.bg-open')?.focus()
	document.addEventListener('pointerdown', onBgOutside, true)
	document.addEventListener('keydown', onBgKeydown, true)
}

function closeBackgroundPopover(): void {
	if (!bgOpen) return
	bgOpen = false
	bgPopover.hidden = true
	bgToggle.setAttribute('aria-expanded', 'false')
	topbarDragSpace.classList.remove('popover-catcher')
	document.removeEventListener('pointerdown', onBgOutside, true)
	document.removeEventListener('keydown', onBgKeydown, true)
}

bgToggle.addEventListener('click', () => {
	if (bgOpen) closeBackgroundPopover()
	else openBackgroundPopover()
})

// ---------- direct-manipulation tab drag (live reorder / magnetic park) ----------

type TabDropTarget = 'strip' | 'background' | null

interface TabPointerDrag {
	tab: Tab
	pointerId: number
	startX: number
	startY: number
	x: number
	y: number
	offsetX: number
	offsetY: number
	originalTabs: Tab[]
	started: boolean
	preview: HTMLDivElement | null
	dropTarget: TabDropTarget
	frame: number | null
}

let tabPointerDrag: TabPointerDrag | null = null
const suppressTabClick = new WeakSet<Tab>()
const tabReflowAnimations = new WeakMap<Tab, Animation>()

function reducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function setTabOrder(next: readonly Tab[], animate: boolean): boolean {
	if (next.every((candidate, index) => candidate === tabs[index])) return false
	const previousLeft = new Map(tabs.map(candidate => [candidate, candidate.tabButton.getBoundingClientRect().left]))
	tabs.splice(0, tabs.length, ...next)
	for (const candidate of tabs) tabsEl.appendChild(candidate.tabButton)
	if (animate && !reducedMotion()) {
		for (const candidate of tabs) {
			const delta = (previousLeft.get(candidate) ?? 0) - candidate.tabButton.getBoundingClientRect().left
			if (Math.abs(delta) < 1) continue
			tabReflowAnimations.get(candidate)?.cancel()
			const animation = candidate.tabButton.animate(
				[{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
				{ duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
			)
			tabReflowAnimations.set(candidate, animation)
			animation.addEventListener('finish', () => {
				if (tabReflowAnimations.get(candidate) === animation) tabReflowAnimations.delete(candidate)
			})
		}
	}
	return true
}

function positionTabPreview(drag: TabPointerDrag): void {
	if (!drag.preview) return
	const left = drag.x - drag.offsetX
	const top = drag.y - drag.offsetY
	const scale = drag.dropTarget === 'background' ? 0.92 : 1.02
	drag.preview.style.transform = `translate3d(${left}px, ${top}px, 0) scale(${scale})`
}

function updateTabDragTarget(drag: TabPointerDrag): void {
	const backgroundRect = bgToggle.getBoundingClientRect()
	const overNewTab = pointInExpandedRect(drag.x, drag.y, newTabButton.getBoundingClientRect())
	if (!overNewTab && pointInExpandedRect(drag.x, drag.y, backgroundRect, 8)) {
		drag.dropTarget = 'background'
		bgToggle.classList.add('drag-over')
		drag.preview?.classList.add('over-background')
		positionTabPreview(drag)
		return
	}

	bgToggle.classList.remove('drag-over')
	drag.preview?.classList.remove('over-background')
	const stripRect = tabsEl.getBoundingClientRect()
	if (!pointInExpandedRect(drag.x, drag.y, stripRect, 10)) {
		drag.dropTarget = null
		positionTabPreview(drag)
		return
	}

	drag.dropTarget = 'strip'
	const insertionIndex = stripDropInsertionIndex(
		drag.x,
		tabs.map(tab => tab.tabButton.getBoundingClientRect()),
	)
	setTabOrder(moveToInsertionIndex(tabs, drag.tab, insertionIndex), true)
	positionTabPreview(drag)
}

function tabDragFrame(): void {
	const drag = tabPointerDrag
	if (!drag?.started) return
	if (drag.dropTarget === 'strip') {
		const stripRect = tabsEl.getBoundingClientRect()
		const delta = tabStripAutoScrollDelta(drag.x, stripRect, tabsEl.scrollLeft, tabsEl.scrollWidth, tabsEl.clientWidth)
		if (delta !== 0) {
			tabsEl.scrollLeft += delta
			updateTabDragTarget(drag)
		}
	}
	drag.frame = requestAnimationFrame(tabDragFrame)
}

function startTabPointerDrag(drag: TabPointerDrag): void {
	drag.started = true
	closeTabMenu()
	closeBackgroundPopover()
	const rect = drag.tab.tabButton.getBoundingClientRect()
	const preview = drag.tab.tabButton.cloneNode(true) as HTMLDivElement
	preview.className = 'tab tab-drag-preview'
	preview.setAttribute('aria-hidden', 'true')
	preview.style.width = `${rect.width}px`
	document.body.appendChild(preview)
	drag.preview = preview
	drag.tab.tabButton.classList.add('drag-placeholder')
	document.body.classList.add('tab-dragging')
	bgToggle.hidden = false
	bgToggle.classList.add('drag-ready')
	bgToggle.title = 'Move to background'
	positionTabPreview(drag)
	updateTabDragTarget(drag)
	drag.frame = requestAnimationFrame(tabDragFrame)
}

function removeTabPointerListeners(drag: TabPointerDrag): void {
	document.removeEventListener('pointermove', onTabPointerMove)
	document.removeEventListener('pointerup', onTabPointerUp)
	document.removeEventListener('pointercancel', onTabPointerCancel)
	document.removeEventListener('keydown', onTabDragKeydown, true)
	window.removeEventListener('blur', onTabDragBlur)
	try {
		if (drag.tab.tabButton.hasPointerCapture(drag.pointerId)) drag.tab.tabButton.releasePointerCapture(drag.pointerId)
	} catch {
		// synthetic screenshot drag / element removed mid-gesture
	}
}

function settleTabPreview(drag: TabPointerDrag, target: DOMRect, intoBackground: boolean): void {
	const preview = drag.preview
	const cleanup = () => {
		preview?.remove()
		drag.tab.tabButton.classList.remove('drag-placeholder')
	}
	if (!preview || reducedMotion()) {
		cleanup()
		return
	}
	const left = drag.x - drag.offsetX
	const top = drag.y - drag.offsetY
	const destinationX = intoBackground ? target.left + (target.width - preview.offsetWidth) / 2 : target.left
	const destinationY = intoBackground ? target.top + (target.height - preview.offsetHeight) / 2 : target.top
	const animation = preview.animate(
		[
			{ transform: `translate3d(${left}px, ${top}px, 0) scale(${intoBackground ? 0.92 : 1.02})`, opacity: 1 },
			{
				transform: `translate3d(${destinationX}px, ${destinationY}px, 0) scale(${intoBackground ? 0.72 : 1})`,
				opacity: intoBackground ? 0 : 1,
			},
		],
		{ duration: intoBackground ? 140 : 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
	)
	animation.addEventListener('finish', cleanup, { once: true })
	animation.addEventListener('cancel', cleanup, { once: true })
}

function finishTabPointerDrag(cancelled: boolean): void {
	const drag = tabPointerDrag
	if (!drag) return
	tabPointerDrag = null
	removeTabPointerListeners(drag)
	if (drag.frame !== null) cancelAnimationFrame(drag.frame)
	if (!drag.started) return

	suppressTabClick.add(drag.tab)
	setTimeout(() => suppressTabClick.delete(drag.tab), 0)
	const intoBackground = !cancelled && drag.dropTarget === 'background'
	let target: DOMRect
	if (intoBackground) {
		target = bgToggle.getBoundingClientRect()
		parkTab(drag.tab)
	} else {
		if (cancelled || drag.dropTarget !== 'strip') setTabOrder(drag.originalTabs, true)
		else persistTerminalOrder()
		target = drag.tab.tabButton.getBoundingClientRect()
	}

	document.body.classList.remove('tab-dragging')
	bgToggle.classList.remove('drag-ready', 'drag-over')
	bgToggle.title = 'Background terminals'
	updateBackgroundUi()
	settleTabPreview(drag, target, intoBackground)
}

function onTabPointerMove(event: PointerEvent): void {
	const drag = tabPointerDrag
	if (!drag || event.pointerId !== drag.pointerId) return
	drag.x = event.clientX
	drag.y = event.clientY
	if (!drag.started) {
		if (!dragThresholdExceeded(drag.startX, drag.startY, drag.x, drag.y)) return
		startTabPointerDrag(drag)
	} else {
		updateTabDragTarget(drag)
	}
	event.preventDefault()
}

function onTabPointerUp(event: PointerEvent): void {
	const drag = tabPointerDrag
	if (!drag || event.pointerId !== drag.pointerId) return
	drag.x = event.clientX
	drag.y = event.clientY
	if (drag.started) updateTabDragTarget(drag)
	finishTabPointerDrag(false)
}

function onTabPointerCancel(event: PointerEvent): void {
	if (tabPointerDrag && event.pointerId === tabPointerDrag.pointerId) finishTabPointerDrag(true)
}

function onTabDragKeydown(event: KeyboardEvent): void {
	if (event.key !== 'Escape' || !tabPointerDrag) return
	event.preventDefault()
	finishTabPointerDrag(true)
}

function onTabDragBlur(): void {
	if (tabPointerDrag) finishTabPointerDrag(true)
}

function createTabPointerDrag(tab: Tab, pointerId: number, x: number, y: number): TabPointerDrag {
	const rect = tab.tabButton.getBoundingClientRect()
	return {
		tab,
		pointerId,
		startX: x,
		startY: y,
		x,
		y,
		offsetX: x - rect.left,
		offsetY: y - rect.top,
		originalTabs: [...tabs],
		started: false,
		preview: null,
		dropTarget: null,
		frame: null,
	}
}

function beginTabPointerDrag(tab: Tab, event: PointerEvent): void {
	if (
		tabPointerDrag ||
		event.button !== 0 ||
		tab.closed ||
		tab.parked ||
		tab.tabButton.querySelector('.tab-rename') ||
		(event.target instanceof Element && event.target.closest('.tab-close, .tab-rename'))
	) {
		return
	}
	tabPointerDrag = createTabPointerDrag(tab, event.pointerId, event.clientX, event.clientY)
	tab.tabButton.setPointerCapture(event.pointerId)
	document.addEventListener('pointermove', onTabPointerMove, { passive: false })
	document.addEventListener('pointerup', onTabPointerUp)
	document.addEventListener('pointercancel', onTabPointerCancel)
	document.addEventListener('keydown', onTabDragKeydown, true)
	window.addEventListener('blur', onTabDragBlur)
}

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
		{ label: 'Rename…', onPick: () => startRename(tab) },
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
	if (empty) empty.hidden = tabs.length > 0 || activeTab !== null
}

interface TerminalOpts {
	/** Restored/undone session to reattach; omitted = create a fresh session. */
	sessionId?: string
	/** Persisted label shown until the shell emits a fresh OSC title. */
	title?: string | null
	/** Persisted manual rename pin — label text, never overwritten by OSC. */
	customName?: string | null
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
	const running = createActivityIndicator('Running')
	running.classList.add('tab-running')
	running.hidden = true
	const close = document.createElement('button')
	close.className = 'tab-close'
	close.textContent = '×'
	close.title = 'Close (⌘W)'
	close.setAttribute('aria-label', 'Close terminal')
	tabButton.append(running, label, close)

	let tab!: Tab
	const outputGuard = createSynchronizedOutputGuard({
		onFreeze: () => freezeTerminalFrame(tab),
		onUnfreeze: () => unfreezeTerminalFrame(tab),
	})
	const progressTracker = createTerminalProgressTracker(active => setTabAgentRunning(tab, active))
	tab = {
		ptyId: null,
		sessionId: null,
		closed: false,
		parked: startParked,
		exitCode: null,
		title: '',
		titleRaw: '',
		oscTitle: null,
		oscRaw: null,
		customName: opts?.customName ?? null,
		// Reattaching an existing session arms restored-title stickiness; a
		// fresh tab keeps today's title behavior exactly.
		restored: opts?.sessionId !== undefined,
		titleSettled: false,
		attachedAt: Number.POSITIVE_INFINITY,
		dirty: false,
		frameOutputPending: false,
		frameFreeze: null,
		outputGuard,
		agentRunning: false,
		agentAttention: false,
		progressTracker,
		runningEl: running,
		term,
		fit,
		serialize,
		holder,
		tabButton,
		labelEl: label,
		scrollbar,
		thumb,
		fitRetryPending: false,
		scrollSyncPending: false,
		attachClearPending: true,
		attachClearHeld: '',
	}
	attachScrollbarInput(tab)
	term.attachCustomKeyEventHandler(event => {
		const shortcut = terminalShortcut(helm.platform, event)
		if (!shortcut) return true
		if (event.type === 'keydown' && tab.ptyId !== null) {
			helm.pty.write(tab.ptyId, shortcut.input)
		}
		return !shortcut.suppress
	})
	// Restored tabs keep the label persisted from the previous run until the
	// reattached shell emits a fresh OSC title (normalized too — older runs
	// persisted raw "user@host:cwd" titles). A pinned name wins over both.
	tab.title = normalizeTabTitle(opts?.title ?? '')
	tab.titleRaw = (opts?.title ?? '').trim()
	renderTabLabel(tab)
	// Shell title arrives via OSC title events; empty titles fall back to "zsh".
	// Arbitration (pin / restored-title stickiness / live follow) is the pure
	// decideTabTitle — see ./tab-title.ts for the diagnosis + rules.
	term.onTitleChange(title => {
		const normalized = normalizeTabTitle(title)
		// Track the live OSC title even when it won't apply: a pinned tab's
		// tooltip shows it, and an unpin falls back to it.
		tab.oscTitle = normalized
		tab.oscRaw = title.trim() || null
		const apply = decideTabTitle({
			pinned: tab.customName !== null,
			restored: tab.restored,
			titleSettled: tab.titleSettled,
			sinceAttachMs: performance.now() - tab.attachedAt,
			incoming: normalized,
			...(helm.titleStickyMs !== null ? { stickyWindowMs: helm.titleStickyMs } : {}),
		})
		if (apply) {
			tab.title = normalized
			tab.titleRaw = title.trim()
			if (!isShellDefaultTitle(normalized)) tab.titleSettled = true
			// Persist only APPLIED titles: a suppressed shell-default title must
			// not clobber the registry's restored name either. While pinned,
			// lastTitle stays put — customName owns the restored label.
			if (tab.sessionId) helm.sessions.setTitle(tab.sessionId, normalized)
			renderTabLabel(tab)
		} else if (tab.customName !== null) {
			renderTabLabel(tab) // label unchanged (pin), tooltip follows live OSC
		}
		if (tab.parked) updateBackgroundUi()
	})
	term.onScroll(() => scheduleScrollbarSync(tab))
	term.onResize(() => scheduleScrollbarSync(tab))
	// Content growth while scrolled up moves no viewport (no onScroll fires)
	// but changes the thumb's proportion — onWriteParsed catches it.
	term.onWriteParsed(() => scheduleScrollbarSync(tab))

	tabButton.addEventListener('pointerdown', event => beginTabPointerDrag(tab, event))
	tabButton.addEventListener('click', () => {
		if (suppressTabClick.delete(tab)) return
		activate(tab)
	})
	// Double-click the tab = inline rename (pin); the close × keeps its meaning.
	tabButton.addEventListener('dblclick', event => {
		if (event.target instanceof Node && close.contains(event.target)) return
		startRename(tab)
	})
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
	persistTerminalOrder()
	// The pty is attached NOW — restored-title stickiness counts from here.
	tab.attachedAt = performance.now()
	// Re-assert the parked flag under the REAL session id (a fresh spawn mints
	// one) so a parked terminal relaunches as parked. Same for a rename pin
	// committed while the spawn was in flight.
	if (tab.parked && spawned.sessionId) helm.sessions.setParked(spawned.sessionId, true)
	if (tab.customName !== null && spawned.sessionId) helm.sessions.setCustomName(spawned.sessionId, tab.customName)
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
	tab.progressTracker.feed(data)
	// Session-backed spawns: swallow dtach's one-time attach clear so it can't
	// wipe the restored snapshot (non-dtach fallback ptys emit no such prefix).
	let output = data
	if (tab.attachClearPending && tab.sessionId !== null) {
		output = filterAttachClear(tab, data)
		if (output === '') return
	}
	tab.outputGuard.write(output, (data, onParsed) => tab.term.write(data, onParsed))
	tab.dirty = true // snapshot autosave picks this tab up on the next tick
})

helm.pty.onExit((id, exitCode) => {
	const tab = findByPty(id)
	if (!tab) return
	tab.outputGuard.abort()
	tab.progressTracker.clear()
	tab.ptyId = null // pty is gone; don't kill it again on close
	tab.dirty = false // session over — its snapshot is reaped with it, don't re-save
	if (tab.parked) {
		// Exited in the background: keep the row (state "Exited"), no toast spam.
		// The exit burst is a death rattle, not activity — the state says it all.
		tab.exitCode = exitCode
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
	for (const tab of [...tabs, ...parked]) {
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
	if (!activeTab) return
	if (activeTab.parked) killParkedTab(activeTab)
	else closeTab(activeTab)
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
	if (preview === 'running-tab' || preview === 'attention-tab') {
		if (activeTab) {
			if (preview === 'running-tab') setTabAgentRunning(activeTab, true)
			else setTabAgentAttention(activeTab, true)
		}
		return
	}
	if (preview === 'tab-drag') {
		while (tabs.length < 3) await createTerminal().catch(() => {})
		const names = ['api', 'deploy', 'logs']
		tabs.forEach((tab, index) => commitCustomName(tab, names[index] ?? `shell ${index + 1}`))
		const tab = tabs.at(-1)
		const first = tabs[0]
		if (tab && first) {
			const source = tab.tabButton.getBoundingClientRect()
			const target = first.tabButton.getBoundingClientRect()
			const drag = createTabPointerDrag(tab, -1, source.left + source.width / 2, source.top + source.height / 2)
			tabPointerDrag = drag
			drag.x = target.left + target.width * 0.25
			drag.y = target.top + target.height / 2 + 3
			startTabPointerDrag(drag)
		}
		return
	}
	// background-park: park the ACTIVE tab (after any --term-cmd output landed)
	// so a later run against the same profile/socket pool verifies parked
	// snapshot restore. background-open previews the first parked holder without
	// changing ownership; background-restore moves it back to a tab.
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
	// rename-edit: open the inline rename editor on the active tab (input
	// styling + select-all shot). rename: commit the fixed pin "deploy watch"
	// through the SAME commit path the editor uses, so a relaunch against the
	// same profile/socket pool verifies pin persistence.
	if (preview === 'rename-edit') {
		await new Promise(resolve => setTimeout(resolve, 800)) // let activate()'s rAF focus settle first
		const tab = activeTab
		if (tab) startRename(tab)
		return
	}
	if (preview === 'rename') {
		const tab = activeTab
		if (tab) commitCustomName(tab, 'deploy watch')
		return
	}
	if (preview !== 'background' && preview !== 'background-strip' && preview !== 'background-open') return
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
		setTabAgentRunning(running, true)
	}
	if (preview === 'background') openBackgroundPopover()
	else if (preview === 'background-open' && running) openParked(running)
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
			await createTerminal({
				sessionId: session.sessionId,
				title: session.title,
				customName: session.customName,
			}).catch(() => {})
		}
		const first = tabs[0]
		if (first) activate(first)
	}
	for (const session of parkedSessions) {
		await createTerminal({
			sessionId: session.sessionId,
			title: session.title,
			customName: session.customName,
			parked: true,
		}).catch(() => {})
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
