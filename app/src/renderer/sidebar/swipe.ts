// Two-finger swipe-back for the push stack (docs/design-system.md §3.10
// gestures): macOS trackpads deliver horizontal pan as wheel events with
// deltaX. SwipeTracker is the pure gesture state machine (unit-tested from
// tests/helm-swipe.test.ts); attachSwipeBack is the DOM controller that drives
// the page transforms and owns gesture-boundary timing.
//
// Sign convention: with macOS natural scrolling, fingers moving RIGHT (the
// Safari back gesture) produce NEGATIVE wheel deltaX ("scroll toward the left
// edge of the content"). Back progress therefore accumulates -deltaX.
//
// WheelEvent carries no gesture-phase info in Chromium: fingers-down motion,
// the lift, and the momentum tail (same-sign deltas decaying roughly
// exponentially over ~300-800ms) arrive as one undifferentiated delta stream.
// Everything below is calibrated around that blindness:
//   - engagement is an 8px AXIS LOCK (accumulated travel + dominance), not a
//     first-event bet or a sticky dead zone;
//   - the page stays finger-owned until the wheel stream reaches its 140ms
//     release/quiescence boundary; thresholds choose a target only then;
//   - after settle, a REFRACTORY gap swallows/restarts on back-horizontal tail
//     events, so one physical gesture can never pop a second page.

// --- tuning constants (documented in design-system.md §3.10) --------------------

/** Axis-lock slop: enough accumulated travel to classify intent without the
 *  sticky 30px dead zone the first implementation imposed. Once locked, this
 *  slop is subtracted so the page begins at exactly 0 with no jump. */
export const SWIPE_ENGAGE_PX = 8
/** …and horizontal must dominate: |ΣdeltaX| > this ×|ΣdeltaY| at the engage
 *  decision, or the gesture is rejected for its whole lifetime. */
export const SWIPE_ENGAGE_DOMINANCE = 2
/** Commit the pop once the page is dragged past this fraction of pane width. */
export const SWIPE_COMMIT_FRACTION = 0.5
/** …or on a genuine flick: back-velocity over the trailing window above this
 *  (px/ms). Ordinary two-finger scrolling runs ~0.3-1 px/ms; a deliberate
 *  flick lands 2-4. The old 0.7 fired on ordinary scroll speed. */
export const SWIPE_FLICK_VELOCITY = 1.5
/** Flick velocity is averaged over this trailing window, anchored at the
 *  newest event — recent motion only, so an early burst in a long drag or a
 *  decayed momentum tail can't smuggle a commit through. */
export const SWIPE_FLICK_WINDOW_MS = 80
/** A flick also needs this fraction of pane width in real travel — the lower
 *  axis-lock slop must not turn one early burst into an accidental pop. */
export const SWIPE_MIN_FLICK_FRACTION = 0.3
/** No wheel events for this long = the gesture ended. Long enough to bridge
 *  fingers resting mid-drag and intra-tail hiccups; post-release latency is
 *  dominated by the momentum tail (which keeps events flowing), not this. */
export const SWIPE_WHEEL_IDLE_MS = 140
/** Refractory quiescence gap after any engaged gesture settles (commit OR
 *  spring-back). Every back-horizontal tail event restarts it; unrelated
 *  vertical input stays available. */
export const SWIPE_COOLDOWN_MS = 280
/** Commit settle: remaining distance and release velocity choose a duration
 *  inside this range. The curve is compositor-driven and lands with zero snap. */
export const SWIPE_COMMIT_MAX_MS = 240
/** …floored so the last few px never blink. */
export const SWIPE_COMMIT_MIN_MS = 90
/** Maximum spring-back duration; short drags return faster. */
export const SWIPE_SPRING_BACK_MS = 240
/** Apple-style deceleration: fast response, long soft tail, no overshoot. */
export const SWIPE_COMMIT_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
/** Soft iOS-style return without overshooting either endpoint. */
export const SWIPE_SPRING_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

export function swipeCommitDuration(remainingPx: number, paneWidth: number, velocityPxMs: number): number {
	const width = Math.max(1, paneWidth)
	const remaining = Math.max(0, remainingPx)
	const baseSpeed = width / SWIPE_COMMIT_MAX_MS
	const releaseSpeed = Math.max(0, velocityPxMs) * 0.85
	const duration = remaining / Math.max(baseSpeed, releaseSpeed)
	return Math.round(Math.min(SWIPE_COMMIT_MAX_MS, Math.max(SWIPE_COMMIT_MIN_MS, duration)))
}

export function swipeSpringDuration(progressPx: number, paneWidth: number): number {
	const fraction = Math.min(1, Math.max(0, progressPx / Math.max(1, paneWidth)))
	return Math.round(140 + (SWIPE_SPRING_BACK_MS - 140) * fraction)
}

// --- pure gesture core -----------------------------------------------------------

export type SwipeFeedResult = 'ignored' | 'pending' | 'started' | 'tracking'

type Sample = { t: number; cum: number }

/**
 * Accumulates one wheel-gesture's horizontal deltas into back-swipe progress.
 * A gesture starts UNDECIDED ('pending'): deltas accumulate invisibly until
 * either clear back intent emerges (≥ SWIPE_ENGAGE_PX axis-lock travel that
 * dominates vertical by SWIPE_ENGAGE_DOMINANCE, with a consumer-free start)
 * → engaged, or the accumulation first crosses the threshold any other way
 * (vertical, diagonal, forward pan, consumed) → rejected for its lifetime.
 */
export class SwipeTracker {
	private readonly width: number
	private sumX = 0
	private sumY = 0
	private progress = 0
	private cum = 0
	private flickArmed = false
	private state: 'pending' | 'rejected' | 'engaged' = 'pending'
	private samples: Sample[] = []

	constructor(paneWidth: number) {
		this.width = Math.max(1, paneWidth)
	}

	feed(deltaX: number, deltaY: number, timeMs: number, canStart: () => boolean): SwipeFeedResult {
		if (this.state === 'rejected') return 'ignored'
		this.cum += -deltaX
		this.samples.push({ t: timeMs, cum: this.cum })
		this.pruneSamples(timeMs)
		if (this.state === 'pending') {
			this.sumX += deltaX
			this.sumY += deltaY
			if (Math.max(Math.abs(this.sumX), Math.abs(this.sumY)) < SWIPE_ENGAGE_PX) return 'pending'
			const back = -this.sumX
			const engages =
				back >= SWIPE_ENGAGE_PX && Math.abs(this.sumX) > SWIPE_ENGAGE_DOMINANCE * Math.abs(this.sumY) && canStart()
			if (!engages) {
				this.state = 'rejected'
				this.samples = []
				return 'ignored'
			}
			this.state = 'engaged'
			// Track from the engage point: axis-lock slop is subtracted so the
			// page starts moving from 0 instead of jumping SWIPE_ENGAGE_PX in.
			this.progress = Math.min(this.width, back - SWIPE_ENGAGE_PX)
			this.updateFlickIntent(deltaX)
			return 'started'
		}
		this.progress = Math.min(this.width, Math.max(0, this.progress - deltaX))
		this.updateFlickIntent(deltaX)
		return 'tracking'
	}

	/** Keep exactly one sample at/beyond the window edge as the velocity anchor. */
	private pruneSamples(nowMs: number): void {
		while (this.samples.length > 1) {
			const next = this.samples[1]
			if (!next || nowMs - next.t < SWIPE_FLICK_WINDOW_MS) break
			this.samples.shift()
		}
	}

	private updateFlickIntent(deltaX: number): void {
		// A deliberate reversal hands control back to distance at release; an old
		// fast burst must never force a commit after the user pulls the page home.
		if (deltaX > 0) {
			this.flickArmed = false
			return
		}
		if (this.fraction >= SWIPE_MIN_FLICK_FRACTION && this.recentVelocity() >= SWIPE_FLICK_VELOCITY) {
			this.flickArmed = true
		}
	}

	/** Back-velocity (px/ms) averaged over the trailing SWIPE_FLICK_WINDOW_MS,
	 *  anchored at the newest event. A single event has no measurable rate → 0. */
	recentVelocity(): number {
		const last = this.samples[this.samples.length - 1]
		const anchor = this.samples[0]
		if (!last || !anchor || last === anchor) return 0
		const span = last.t - anchor.t
		if (span <= 0) return 0
		return (last.cum - anchor.cum) / span
	}

	/** True while this gesture is interactively dragging the page. */
	get tracking(): boolean {
		return this.state === 'engaged'
	}

	get progressPx(): number {
		return this.progress
	}

	/** 0..1 of pane width. */
	get fraction(): number {
		return this.progress / this.width
	}

	/** Destination decision, evaluated only when the wheel stream reaches its
	 *  release/quiescence boundary. Distance uses the final position; a genuine
	 *  flick is latched before its momentum tail decays the velocity sample. */
	shouldCommit(): boolean {
		if (this.state !== 'engaged') return false
		if (this.fraction >= SWIPE_COMMIT_FRACTION) return true
		return this.flickArmed && this.fraction >= SWIPE_MIN_FLICK_FRACTION
	}
}

// --- DOM controller ---------------------------------------------------------------

export interface SwipeBackHandlers {
	/** A pushed page exists, no push/pop animation is running, no sheet is open. */
	canPop(): boolean
	/** Top page + the page beneath it (the one that peeks). */
	getPages(): { top: HTMLElement; under: HTMLElement } | null
	/** Instant pop — the controller already animated the pages into place. */
	commitPop(): void
	reducedMotion(): boolean
}

export interface SwipeBackControl {
	dispose(): void
	/** Single-owner check for the native three-finger-swipe / Go-channel BACK
	 *  handler ("two or three fingers" system setting can deliver ONE physical
	 *  gesture both as wheel deltas and as a native 'swipe' event). Returns
	 *  true when the wheel path already owns the gesture (engaged tracking,
	 *  settle animation, or refractory) — the caller must swallow the native
	 *  event or one gesture pops twice. Otherwise returns false (caller pops)
	 *  and arms the refractory gap so the same gesture's wheel deltas can't
	 *  ALSO trigger a pop after the native one. */
	interceptNativeNav(): boolean
}

/** True when an ancestor (target→viewport) can still scroll leftward and thus
 *  owns leftward horizontal pan — code blocks, log wells. At scrollLeft 0 the
 *  gesture falls through to navigation (Safari's edge rule). */
function hasHorizontalScrollConsumer(target: EventTarget | null, viewport: HTMLElement): boolean {
	let el = target instanceof Element ? target : null
	while (el && el !== viewport) {
		if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1 && el.scrollLeft > 0) return true
		el = el.parentElement
	}
	return false
}

export interface SwipeRuntime {
	requestFrame(callback: FrameRequestCallback): number
	cancelFrame(id: number): void
	setTimer(callback: () => void, ms: number): number
	clearTimer(id: number): void
}

const browserSwipeRuntime: SwipeRuntime = {
	requestFrame: callback => requestAnimationFrame(callback),
	cancelFrame: id => cancelAnimationFrame(id),
	setTimer: (callback, ms) => window.setTimeout(callback, ms),
	clearTimer: id => window.clearTimeout(id),
}

/**
 * Wires interactive swipe-back onto the nav viewport. Input only updates the
 * logical position; one rAF publishes the newest position to the compositor.
 * Settlement starts after that exact frame and completes on transitionend,
 * with an idempotent watchdog for hidden/throttled renderers.
 */
export function attachSwipeBack(
	viewport: HTMLElement,
	handlers: SwipeBackHandlers,
	runtime: SwipeRuntime = browserSwipeRuntime,
): SwipeBackControl {
	let tracker: SwipeTracker | null = null
	let pages: { top: HTMLElement; under: HTMLElement } | null = null
	let scrim: HTMLDivElement | null = null
	let visualsBegun = false
	let paneWidth = Math.max(1, viewport.clientWidth)
	let activeWidth = paneWidth
	let idleTimer: number | null = null
	let animationTimer: number | null = null
	let cooldownTimer: number | null = null
	let visualFrame: number | null = null
	let settleFrame: number | null = null
	let pendingVisual: { fraction: number; px: number } | null = null
	let transitionTarget: HTMLElement | null = null
	let transitionListener: ((event: TransitionEvent) => void) | null = null
	/** 'animating' = commit/spring-back in flight; 'cooldown' = refractory gap. */
	let phase: 'idle' | 'gesturing' | 'animating' | 'cooldown' = 'idle'
	const resizeObserver =
		typeof ResizeObserver === 'function'
			? new ResizeObserver(entries => {
					const width = entries[0]?.contentRect.width
					if (width && width > 0) paneWidth = width
				})
			: null
	resizeObserver?.observe(viewport)

	const clearTimer = (id: number | null) => {
		if (id !== null) runtime.clearTimer(id)
	}
	const clearFrame = (id: number | null) => {
		if (id !== null) runtime.cancelFrame(id)
	}
	const clearTransitionListener = () => {
		if (transitionTarget && transitionListener)
			transitionTarget.removeEventListener('transitionend', transitionListener)
		transitionTarget = null
		transitionListener = null
	}
	const pagesAreCurrent = () => {
		if (!pages) return false
		const current = handlers.getPages()
		return current?.top === pages.top && current.under === pages.under
	}

	const render = (fraction: number, px: number) => {
		if (!pages) return
		const underPx = -0.25 * activeWidth * (1 - fraction)
		pages.top.style.transform = `translate3d(${px}px, 0, 0)`
		pages.under.style.transform = `translate3d(${underPx}px, 0, 0)`
		if (scrim) scrim.style.opacity = String(1 - fraction)
	}

	const publishVisual = (fraction: number, px: number) => {
		pendingVisual = { fraction, px }
		if (visualFrame !== null) return
		visualFrame = runtime.requestFrame(() => {
			visualFrame = null
			const next = pendingVisual
			pendingVisual = null
			if (!pagesAreCurrent()) {
				tracker = null
				cleanupVisuals()
				enterCooldown()
				return
			}
			if (next) {
				beginVisuals()
				render(next.fraction, next.px)
			}
		})
	}

	const beginVisuals = () => {
		if (!pages || visualsBegun) return
		visualsBegun = true
		pages.top.classList.add('nav-swiping', 'nav-swipe-top')
		pages.under.classList.add('nav-swiping', 'nav-swipe-under')
		scrim = document.createElement('div')
		scrim.className = 'swipe-scrim'
		pages.under.append(scrim)
	}

	const cleanupVisuals = () => {
		clearFrame(visualFrame)
		clearFrame(settleFrame)
		visualFrame = null
		settleFrame = null
		pendingVisual = null
		clearTransitionListener()
		if (pages && visualsBegun) {
			pages.top.classList.remove('nav-swiping', 'nav-swipe-top')
			pages.under.classList.remove('nav-swiping', 'nav-swipe-under')
			for (const el of [pages.top, pages.under]) {
				el.style.transform = ''
				el.style.transition = ''
			}
		}
		scrim?.remove()
		scrim = null
		visualsBegun = false
		pages = null
	}

	const abandonGesture = () => {
		tracker = null
		phase = 'animating'
		if (settleFrame !== null) return
		settleFrame = runtime.requestFrame(() => {
			settleFrame = null
			cleanupVisuals()
			enterCooldown()
		})
	}

	const enterCooldown = () => {
		phase = 'cooldown'
		clearTimer(cooldownTimer)
		cooldownTimer = runtime.setTimer(() => {
			cooldownTimer = null
			phase = 'idle'
		}, SWIPE_COOLDOWN_MS)
	}

	const setTransitions = (ms: number, easing: string) => {
		if (!pages) return
		pages.top.style.transition = `transform ${ms}ms ${easing}`
		pages.under.style.transition = `transform ${ms}ms ${easing}`
		if (scrim) scrim.style.transition = `opacity ${ms}ms ${easing}`
	}

	const settle = (done: SwipeTracker, commits: boolean) => {
		clearTimer(idleTimer)
		idleTimer = null
		tracker = null
		clearFrame(visualFrame)
		visualFrame = null
		pendingVisual = null
		if (!pagesAreCurrent()) {
			cleanupVisuals()
			enterCooldown()
			return
		}
		if (handlers.reducedMotion()) {
			cleanupVisuals()
			if (commits) handlers.commitPop()
			enterCooldown()
			return
		}

		phase = 'animating'
		const targetPx = commits ? activeWidth : 0
		const targetFraction = commits ? 1 : 0
		const ms = commits
			? swipeCommitDuration(activeWidth - done.progressPx, activeWidth, done.recentVelocity())
			: swipeSpringDuration(done.progressPx, activeWidth)
		const easing = commits ? SWIPE_COMMIT_EASING : SWIPE_SPRING_EASING
		let completed = false
		const complete = () => {
			if (completed) return
			completed = true
			clearTimer(animationTimer)
			animationTimer = null
			clearTransitionListener()
			// SidebarRoot flushes the pop synchronously, so clearing stale inline
			// transforms cannot expose one snap-back frame. If another navigation
			// already replaced this pair, cleanup wins and the stale swipe cannot pop.
			if (commits && pagesAreCurrent()) handlers.commitPop()
			cleanupVisuals()
			enterCooldown()
		}

		// Frame 1 publishes the exact final finger position. Frame 2 installs the
		// transition and target. No wheel callback writes styles or forces layout.
		settleFrame = runtime.requestFrame(() => {
			settleFrame = null
			if (!pagesAreCurrent()) {
				complete()
				return
			}
			beginVisuals()
			render(done.fraction, done.progressPx)
			if (Math.abs(targetPx - done.progressPx) < 0.5) {
				complete()
				return
			}
			settleFrame = runtime.requestFrame(() => {
				settleFrame = null
				if (!pagesAreCurrent()) {
					complete()
					return
				}
				setTransitions(ms, easing)
				transitionTarget = pages?.top ?? null
				transitionListener = event => {
					if (event.target === transitionTarget && event.propertyName === 'transform') complete()
				}
				transitionTarget?.addEventListener('transitionend', transitionListener)
				render(targetFraction, targetPx)
				animationTimer = runtime.setTimer(complete, ms + 80)
			})
		})
	}

	const finish = () => {
		idleTimer = null
		const done = tracker
		if (!done?.tracking || !pages) {
			tracker = null
			cleanupVisuals()
			phase = 'idle'
			return
		}
		settle(done, done.shouldCommit())
	}

	const isBackHorizontalPixel = (event: WheelEvent) =>
		(event.deltaMode === undefined || event.deltaMode === 0) &&
		event.deltaX < 0 &&
		Math.abs(event.deltaX) > Math.abs(event.deltaY)

	const onWheel = (event: WheelEvent) => {
		if (phase === 'gesturing' && pages && !pagesAreCurrent()) {
			if (isBackHorizontalPixel(event)) event.preventDefault()
			abandonGesture()
			return
		}
		if (phase === 'animating' || phase === 'cooldown') {
			if (isBackHorizontalPixel(event)) {
				event.preventDefault()
				if (phase === 'cooldown') enterCooldown()
			}
			return
		}
		if (event.ctrlKey || (event.deltaMode !== undefined && event.deltaMode !== 0)) return
		if (!tracker) {
			activeWidth = paneWidth
			tracker = new SwipeTracker(activeWidth)
			phase = 'gesturing'
		}
		const result = tracker.feed(
			event.deltaX,
			event.deltaY,
			event.timeStamp,
			() => handlers.canPop() && !hasHorizontalScrollConsumer(event.target, viewport),
		)
		if (result === 'started') {
			pages = handlers.getPages()
			if (!pages) {
				tracker = null
				phase = 'idle'
				return
			}
			if (!handlers.reducedMotion()) publishVisual(tracker.fraction, tracker.progressPx)
			event.preventDefault()
		} else if (result === 'tracking' && pages) {
			if (!handlers.reducedMotion()) publishVisual(tracker.fraction, tracker.progressPx)
			event.preventDefault()
		}
		clearTimer(idleTimer)
		idleTimer = runtime.setTimer(finish, SWIPE_WHEEL_IDLE_MS)
	}

	const interceptNativeNav = (): boolean => {
		if (phase === 'animating') return true
		if (phase === 'cooldown') {
			enterCooldown()
			return true
		}
		if (phase === 'gesturing' && tracker?.tracking) return true
		clearTimer(idleTimer)
		idleTimer = null
		tracker = null
		cleanupVisuals()
		enterCooldown()
		return false
	}

	viewport.addEventListener('wheel', onWheel, { passive: false })
	return {
		dispose: () => {
			viewport.removeEventListener('wheel', onWheel)
			clearTimer(idleTimer)
			clearTimer(animationTimer)
			clearTimer(cooldownTimer)
			resizeObserver?.disconnect()
			cleanupVisuals()
		},
		interceptNativeNav,
	}
}
