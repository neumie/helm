// SwipeTracker + attachSwipeBack — the gesture machinery behind helm's
// two-finger swipe-back (app/src/renderer/sidebar/swipe.ts; spec in
// docs/design-system.md §3.10). app/package.json has no `type: module`, so
// tsx loads the module as CJS — default-import + destructure, same pattern
// as the other helm tests.

import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error -- app/package.json is CJS; tsx exposes this TS module as its default value.
import swipeModule from '../app/src/renderer/sidebar/swipe.ts'

type SwipeModule = typeof import('../app/src/renderer/sidebar/swipe.ts')
const {
	SwipeTracker,
	attachSwipeBack,
	SWIPE_ENGAGE_PX,
	SWIPE_ENGAGE_DOMINANCE,
	SWIPE_COMMIT_FRACTION,
	SWIPE_FLICK_VELOCITY,
	SWIPE_MIN_FLICK_FRACTION,
	SWIPE_COOLDOWN_MS,
	SWIPE_COMMIT_MAX_MS,
	SWIPE_COMMIT_MIN_MS,
	SWIPE_SPRING_BACK_MS,
	swipeCommitDuration,
	swipeSpringDuration,
} = swipeModule as SwipeModule

const WIDTH = 340
const yes = () => true
const no = () => false

// --- pure tracker: engagement ------------------------------------------------------

test('axis lock: no engagement or movement below the accumulated travel threshold', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(-3, 1, 0, yes), 'pending')
	assert.equal(tracker.feed(-3, 1, 16, yes), 'pending')
	assert.equal(tracker.progressPx, 0)
	assert.equal(tracker.tracking, false)
	assert.equal(tracker.shouldCommit(), false)
})

test('clear horizontal intent locks quickly; progress tracks from the engage point', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(-5, 1, 0, yes), 'pending')
	assert.equal(tracker.feed(-5, 1, 16, yes), 'started')
	// 10px of back travel minus the axis-lock slop — no jump at engagement.
	assert.equal(tracker.progressPx, 10 - SWIPE_ENGAGE_PX)
	assert.ok(tracker.tracking)
	assert.equal(tracker.feed(-30, 0, 32, yes), 'tracking')
	assert.equal(tracker.progressPx, 40 - SWIPE_ENGAGE_PX)
})

test('diagonal motion without 2x horizontal dominance rejects the gesture for good', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(-4, 3, 0, yes), 'pending')
	// sumX -9 crosses the travel bar but 9 <= 2 x 6 — not dominant.
	assert.ok(9 <= SWIPE_ENGAGE_DOMINANCE * 6)
	assert.equal(tracker.feed(-5, 3, 16, yes), 'ignored')
	// later clean horizontal motion in the same gesture stays ignored
	assert.equal(tracker.feed(-60, 0, 32, yes), 'ignored')
	assert.equal(tracker.tracking, false)
})

test('vertical-dominant gesture rejects and stays rejected', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(-5, 40, 0, yes), 'ignored')
	assert.equal(tracker.feed(-60, 0, 16, yes), 'ignored')
	assert.equal(tracker.tracking, false)
	assert.equal(tracker.shouldCommit(), false)
})

test('forward-content pan (positive deltaX) rejects the gesture', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(40, 0, 0, yes), 'ignored')
	assert.equal(tracker.feed(-40, 0, 16, yes), 'ignored')
})

test('a consumer at engagement (scrollable ancestor / nothing to pop) rejects', () => {
	const tracker = new SwipeTracker(WIDTH)
	assert.equal(tracker.feed(-40, 0, 0, no), 'ignored')
	// the gesture cannot re-qualify mid-flight even if the consumer freed up
	assert.equal(tracker.feed(-40, 0, 16, yes), 'ignored')
})

// --- pure tracker: commit decision --------------------------------------------------

test('drag past half the pane width commits', () => {
	const tracker = new SwipeTracker(WIDTH)
	tracker.feed(-40, 0, 0, yes)
	assert.equal(tracker.shouldCommit(), false)
	for (let i = 1; i <= 5; i++) tracker.feed(-40, 0, i * 16, yes)
	// 240px travel - 8px axis lock = 232 >= 170 (half of 340)
	assert.ok(tracker.fraction >= SWIPE_COMMIT_FRACTION)
	assert.ok(tracker.shouldCommit())
})

test('crossing halfway never commits if the user drags back before release', () => {
	const tracker = new SwipeTracker(WIDTH)
	for (let i = 0; i < 5; i++) tracker.feed(-40, 0, i * 16, yes)
	assert.equal(tracker.shouldCommit(), true)
	tracker.feed(100, 0, 90, yes)
	assert.ok(tracker.fraction < SWIPE_COMMIT_FRACTION)
	assert.equal(tracker.shouldCommit(), false)
})

test('ordinary scroll speed below half width never commits (velocity bar)', () => {
	const tracker = new SwipeTracker(WIDTH)
	// ~0.94 px/ms — brisk normal scrolling. Under the old 0.7 px/ms bar with a
	// 40px travel floor this committed: the hair trigger this rewrite removes.
	for (let i = 0; i <= 9; i++) {
		tracker.feed(-15, 0, i * 16, yes)
		assert.equal(tracker.shouldCommit(), false)
	}
	assert.ok(tracker.fraction < SWIPE_COMMIT_FRACTION)
	assert.ok(tracker.progressPx >= SWIPE_MIN_FLICK_FRACTION * WIDTH)
	assert.ok(tracker.recentVelocity() < SWIPE_FLICK_VELOCITY)
})

test('a genuine flick commits below half width', () => {
	const tracker = new SwipeTracker(WIDTH)
	// ~2.5 px/ms over the trailing window, 130px tracked travel (< 170px half)
	for (let i = 0; i <= 3; i++) tracker.feed(-40, 0, i * 16, yes)
	assert.ok(tracker.fraction < SWIPE_COMMIT_FRACTION)
	assert.ok(tracker.progressPx >= SWIPE_MIN_FLICK_FRACTION * WIDTH)
	assert.ok(tracker.recentVelocity() >= SWIPE_FLICK_VELOCITY)
	assert.ok(tracker.shouldCommit())
})

test('flick intent survives same-sign velocity decay but reversal disarms it', () => {
	const tracker = new SwipeTracker(WIDTH)
	for (let i = 0; i <= 3; i++) tracker.feed(-40, 0, i * 16, yes)
	assert.equal(tracker.shouldCommit(), true)
	tracker.feed(-2, 0, 120, yes)
	tracker.feed(-1, 0, 136, yes)
	assert.ok(tracker.recentVelocity() < SWIPE_FLICK_VELOCITY)
	assert.equal(tracker.shouldCommit(), true)
	tracker.feed(70, 0, 152, yes)
	assert.equal(tracker.shouldCommit(), false)
})

test('a violent two-event twitch never commits (min flick travel)', () => {
	const tracker = new SwipeTracker(WIDTH)
	tracker.feed(-40, 0, 0, yes)
	tracker.feed(-20, 0, 8, yes) // huge velocity, 30px of tracked travel
	assert.ok(tracker.recentVelocity() >= SWIPE_FLICK_VELOCITY)
	assert.ok(tracker.progressPx < SWIPE_MIN_FLICK_FRACTION * WIDTH)
	assert.equal(tracker.shouldCommit(), false)
})

test('a decaying momentum tail cannot flick-commit (velocity is recent-window only)', () => {
	const tracker = new SwipeTracker(WIDTH)
	// Fast start engages and travels, but stays below every commit bar…
	tracker.feed(-50, 0, 0, yes)
	assert.equal(tracker.shouldCommit(), false)
	tracker.feed(-30, 0, 16, yes)
	assert.equal(tracker.shouldCommit(), false)
	// …then a macOS-style momentum tail: same-sign deltas decaying roughly
	// exponentially. Total travel passes the min-flick floor, but the trailing
	// 80ms window sees only the decayed rate — no commit at ANY point.
	let delta = -16
	let time = 32
	while (Math.abs(delta) >= 1) {
		tracker.feed(delta, 0, time, yes)
		assert.equal(tracker.shouldCommit(), false)
		delta *= 0.7
		time += 16
	}
	assert.ok(tracker.progressPx >= SWIPE_MIN_FLICK_FRACTION * WIDTH)
	assert.ok(tracker.fraction < SWIPE_COMMIT_FRACTION)
})

test('progress clamps to the pane width and to zero', () => {
	const tracker = new SwipeTracker(WIDTH)
	tracker.feed(-300, 0, 0, yes)
	tracker.feed(-300, 0, 16, yes)
	assert.equal(tracker.progressPx, WIDTH)
	assert.equal(tracker.fraction, 1)
	// dragging back past the origin clamps at 0
	tracker.feed(900, 0, 32, yes)
	assert.equal(tracker.progressPx, 0)
})

test('settle duration responds to release velocity and stays bounded', () => {
	const slow = swipeCommitDuration(240, WIDTH, 0.4)
	const flick = swipeCommitDuration(240, WIDTH, 3)
	assert.ok(flick < slow)
	assert.ok(flick >= SWIPE_COMMIT_MIN_MS)
	assert.ok(slow <= SWIPE_COMMIT_MAX_MS)
	assert.equal(swipeCommitDuration(0, WIDTH, 10), SWIPE_COMMIT_MIN_MS)
})

test('spring return scales with travel and stays bounded', () => {
	const short = swipeSpringDuration(20, WIDTH)
	const long = swipeSpringDuration(250, WIDTH)
	assert.ok(long > short)
	assert.ok(short >= 140)
	assert.ok(long <= SWIPE_SPRING_BACK_MS)
})

// --- DOM controller: refractory gap + native single-owner --------------------------
// attachSwipeBack needs window timers and an Element global for the
// scroll-consumer walk; reduced-motion mode keeps it off document/rAF.

const g = globalThis as Record<string, unknown>
g.window ??= { setTimeout, clearTimeout }
g.Element ??= class {}

type Runtime = NonNullable<Parameters<typeof attachSwipeBack>[2]>

class ManualSwipeRuntime implements Runtime {
	private nextId = 1
	private now = 0
	private readonly frames = new Map<number, FrameRequestCallback>()
	private readonly timers = new Map<number, { at: number; callback: () => void }>()

	requestFrame(callback: FrameRequestCallback): number {
		const id = this.nextId++
		this.frames.set(id, callback)
		return id
	}

	cancelFrame(id: number): void {
		this.frames.delete(id)
	}

	setTimer(callback: () => void, ms: number): number {
		const id = this.nextId++
		this.timers.set(id, { at: this.now + ms, callback })
		return id
	}

	clearTimer(id: number): void {
		this.timers.delete(id)
	}

	flushFrame(stepMs = 16): void {
		this.now += stepMs
		const callbacks = [...this.frames.values()]
		this.frames.clear()
		for (const callback of callbacks) callback(this.now)
	}

	advance(ms: number): void {
		const target = this.now + ms
		while (true) {
			const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
			if (!next || next[1].at > target) break
			this.now = next[1].at
			this.timers.delete(next[0])
			next[1].callback()
		}
		this.now = target
	}

	get pendingFrames(): number {
		return this.frames.size
	}
}

type RecordingPage = {
	element: HTMLElement
	transforms: string[]
	emitTransformEnd(): void
}

function recordingPage(): RecordingPage {
	const classes = new Set<string>()
	const transforms: string[] = []
	const listeners = new Set<(event: TransitionEvent) => void>()
	const style = { transition: '' } as CSSStyleDeclaration
	Object.defineProperty(style, 'transform', {
		get: () => transforms[transforms.length - 1] ?? '',
		set: value => {
			transforms.push(value)
		},
	})
	const element = {
		style,
		classList: {
			add: (...names: string[]) => {
				for (const name of names) classes.add(name)
			},
			remove: (...names: string[]) => {
				for (const name of names) classes.delete(name)
			},
		},
		append() {},
		getBoundingClientRect: () => ({
			width: WIDTH,
			height: 600,
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: WIDTH,
			bottom: 600,
		}),
		addEventListener: (type: string, listener: (event: TransitionEvent) => void) => {
			if (type === 'transitionend') listeners.add(listener)
		},
		removeEventListener: (type: string, listener: (event: TransitionEvent) => void) => {
			if (type === 'transitionend') listeners.delete(listener)
		},
	} as unknown as HTMLElement
	return {
		element,
		transforms,
		emitTransformEnd: () => {
			for (const listener of listeners)
				listener({ target: element, propertyName: 'transform' } as unknown as TransitionEvent)
		},
	}
}

function fakePage(): HTMLElement {
	return {
		classList: { add() {}, remove() {} },
		style: {},
		appendChild() {},
	} as unknown as HTMLElement
}

function harness(width = WIDTH, runtime?: Runtime) {
	const listeners = new Map<string, (event: unknown) => void>()
	let pops = 0
	const pages = { top: fakePage(), under: fakePage() }
	const viewport = {
		clientWidth: width,
		addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
		removeEventListener: (type: string) => listeners.delete(type),
	} as unknown as HTMLElement
	const control = attachSwipeBack(
		viewport,
		{
			canPop: () => true,
			getPages: () => pages,
			commitPop: () => {
				pops += 1
			},
			reducedMotion: () => true,
		},
		runtime,
	)
	const wheel = (deltaX: number, deltaY: number, timeStamp: number) =>
		listeners.get('wheel')?.({ deltaX, deltaY, timeStamp, target: null, preventDefault: () => {} })
	return { wheel, control, pops: () => pops }
}

function visualHarness() {
	const listeners = new Map<string, (event: unknown) => void>()
	const runtime = new ManualSwipeRuntime()
	const top = recordingPage()
	const under = recordingPage()
	let currentPages = { top: top.element, under: under.element }
	let pops = 0
	g.document = {
		createElement: () => ({ className: '', style: {}, remove() {} }),
	}
	const viewport = {
		clientWidth: WIDTH,
		addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
		removeEventListener: (type: string) => listeners.delete(type),
	} as unknown as HTMLElement
	const control = attachSwipeBack(
		viewport,
		{
			canPop: () => true,
			getPages: () => currentPages,
			commitPop: () => {
				pops += 1
			},
			reducedMotion: () => false,
		},
		runtime,
	)
	const wheel = (deltaX: number, deltaY: number, timeStamp: number, deltaMode = 0) => {
		let prevented = false
		listeners.get('wheel')?.({
			deltaX,
			deltaY,
			deltaMode,
			timeStamp,
			ctrlKey: false,
			target: null,
			preventDefault: () => {
				prevented = true
			},
		})
		return { prevented }
	}
	return {
		control,
		runtime,
		top,
		under,
		wheel,
		pops: () => pops,
		replacePages: () => {
			currentPages = { top: fakePage(), under: fakePage() }
		},
	}
}

test('tracking publishes only the newest position once per animation frame', () => {
	const h = visualHarness()
	assert.equal(h.wheel(-9, 0, 0).prevented, true)
	assert.equal(h.wheel(-12, 0, 8).prevented, true)
	assert.equal(h.top.transforms.length, 0)
	assert.equal(h.runtime.pendingFrames, 1)
	h.runtime.flushFrame()
	assert.deepEqual(h.top.transforms, ['translate3d(13px, 0, 0)'])
	h.control.dispose()
})

test('a drag at the destination still waits for release before committing', () => {
	const h = visualHarness()
	h.wheel(-400, 0, 0)
	assert.equal(h.pops(), 0)
	h.runtime.flushFrame()
	assert.equal(h.pops(), 0)
	h.runtime.advance(140)
	assert.equal(h.runtime.pendingFrames, 1)
	h.runtime.flushFrame()
	assert.equal(h.pops(), 1)
	assert.equal(h.runtime.pendingFrames, 0)
	h.control.dispose()
})

test('normal-motion settle owns tails and completes exactly once', () => {
	const h = visualHarness()
	h.wheel(-120, 0, 0)
	h.wheel(-80, 0, 16) // crosses 50%, but fingers still own the page
	assert.equal(h.top.transforms.length, 0)
	assert.equal(h.runtime.pendingFrames, 1)
	assert.equal(h.wheel(-20, 0, 32).prevented, true)
	h.runtime.flushFrame()
	assert.equal(h.top.transforms.at(-1), 'translate3d(212px, 0, 0)')
	assert.equal(h.pops(), 0)
	h.runtime.advance(140)
	assert.equal(h.runtime.pendingFrames, 1)
	h.runtime.flushFrame()
	assert.equal(h.top.transforms.at(-1), 'translate3d(212px, 0, 0)')
	assert.equal(h.runtime.pendingFrames, 1)
	h.runtime.flushFrame()
	assert.equal(h.top.transforms.at(-1), `translate3d(${WIDTH}px, 0, 0)`)
	h.top.emitTransformEnd()
	assert.equal(h.pops(), 1)
	// The idempotent watchdog cannot replay completion.
	h.runtime.advance(SWIPE_COMMIT_MAX_MS + 100)
	assert.equal(h.pops(), 1)
	assert.equal(h.wheel(-8, 0, 64).prevented, true)
	h.control.dispose()
})

test('a stale settle cannot pop a newly changed navigation stack', () => {
	const h = visualHarness()
	h.wheel(-120, 0, 0)
	h.wheel(-80, 0, 16)
	h.runtime.flushFrame()
	h.runtime.advance(140)
	h.runtime.flushFrame()
	h.runtime.flushFrame()
	h.replacePages()
	h.top.emitTransformEnd()
	assert.equal(h.pops(), 0)
	h.runtime.advance(SWIPE_COMMIT_MAX_MS + 100)
	assert.equal(h.pops(), 0)
	h.control.dispose()
})

test('stale tracking enters cooldown so its tail cannot engage the replacement stack', () => {
	const h = visualHarness()
	h.wheel(-60, 0, 0)
	h.runtime.flushFrame()
	h.replacePages()
	assert.equal(h.wheel(-20, 0, 16).prevented, true)
	assert.equal(h.runtime.pendingFrames, 1)
	h.runtime.flushFrame()
	for (let i = 0; i < 6; i++) assert.equal(h.wheel(-40, 0, 32 + i * 16).prevented, true)
	h.runtime.advance(SWIPE_COOLDOWN_MS - 1)
	assert.equal(h.pops(), 0)
	h.control.dispose()
})

test('sub-threshold drag springs back through the same frame-owned settle path', () => {
	const h = visualHarness()
	h.wheel(-60, 0, 0)
	h.runtime.flushFrame()
	assert.equal(h.top.transforms.at(-1), 'translate3d(52px, 0, 0)')
	h.runtime.advance(140)
	assert.equal(h.runtime.pendingFrames, 1)
	h.runtime.flushFrame()
	assert.equal(h.top.transforms.at(-1), 'translate3d(52px, 0, 0)')
	assert.equal(h.runtime.pendingFrames, 1)
	h.runtime.flushFrame()
	assert.equal(h.top.transforms.at(-1), 'translate3d(0px, 0, 0)')
	h.top.emitTransformEnd()
	assert.equal(h.pops(), 0)
	assert.equal(h.wheel(-8, 0, 200).prevented, true)
	h.control.dispose()
})

test('dispose cancels a pending visual frame without mutating the stack', () => {
	const h = visualHarness()
	h.wheel(-20, 0, 0)
	assert.equal(h.runtime.pendingFrames, 1)
	h.control.dispose()
	assert.equal(h.runtime.pendingFrames, 0)
	h.runtime.flushFrame()
	assert.equal(h.pops(), 0)
})

test('pane width is cached outside wheel dispatch', () => {
	let widthReads = 0
	const listeners = new Map<string, (event: unknown) => void>()
	const pages = { top: fakePage(), under: fakePage() }
	const viewport = {
		get clientWidth() {
			widthReads += 1
			return WIDTH
		},
		addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
		removeEventListener: (type: string) => listeners.delete(type),
	} as unknown as HTMLElement
	const control = attachSwipeBack(viewport, {
		canPop: () => true,
		getPages: () => pages,
		commitPop: () => {},
		reducedMotion: () => true,
	})
	assert.equal(widthReads, 1)
	listeners.get('wheel')?.({ deltaX: -20, deltaY: 0, timeStamp: 0, target: null, preventDefault: () => {} })
	listeners.get('wheel')?.({ deltaX: -20, deltaY: 0, timeStamp: 16, target: null, preventDefault: () => {} })
	assert.equal(widthReads, 1)
	control.dispose()
})

test('a horizontal scroll consumer owns the pan until it reaches its left edge', () => {
	class ScrollElement {
		parentElement: HTMLElement | null = null
		scrollWidth = 400
		clientWidth = 200
		scrollLeft = 24
	}
	g.Element = ScrollElement
	g.HTMLElement = ScrollElement
	const target = new ScrollElement()
	const runtime = new ManualSwipeRuntime()
	const listeners = new Map<string, (event: unknown) => void>()
	const viewport = {
		clientWidth: WIDTH,
		addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
		removeEventListener: (type: string) => listeners.delete(type),
	} as unknown as HTMLElement
	target.parentElement = viewport
	const pages = { top: fakePage(), under: fakePage() }
	const control = attachSwipeBack(
		viewport,
		{
			canPop: () => true,
			getPages: () => pages,
			commitPop: () => {},
			reducedMotion: () => true,
		},
		runtime,
	)
	const wheel = () => {
		let prevented = false
		listeners.get('wheel')?.({
			deltaX: -20,
			deltaY: 0,
			deltaMode: 0,
			timeStamp: 0,
			ctrlKey: false,
			target,
			preventDefault: () => {
				prevented = true
			},
		})
		return prevented
	}
	assert.equal(wheel(), false)
	runtime.advance(140)
	target.scrollLeft = 0
	assert.equal(wheel(), true)
	control.dispose()
})

test('non-pixel wheel input never masquerades as a trackpad navigation gesture', () => {
	const h = visualHarness()
	assert.equal(h.wheel(-200, 0, 0, 1).prevented, false)
	assert.equal(h.runtime.pendingFrames, 0)
	assert.equal(h.pops(), 0)
	h.control.dispose()
})

test('momentum tail after release pops exactly ONE page', () => {
	const runtime = new ManualSwipeRuntime()
	const h = harness(WIDTH, runtime)
	// Fingers: strong back swipe arms a release destination but does not pop.
	let time = 0
	for (let i = 0; i < 6; i++) {
		h.wheel(-40, 0, time)
		time += 16
	}
	assert.equal(h.pops(), 0)
	// Fingers lift; macOS momentum tail continues to move the page while the
	// same gesture remains owned.
	let delta = -32
	while (Math.abs(delta) >= 1) {
		h.wheel(delta, 0, time)
		time += 16
		delta *= 0.85
	}
	assert.equal(h.pops(), 0)
	runtime.advance(140)
	assert.equal(h.pops(), 1)
	h.control.dispose()
})

test('a fresh swipe after the quiescence gap can pop again', () => {
	const runtime = new ManualSwipeRuntime()
	const h = harness(WIDTH, runtime)
	let time = 0
	for (let i = 0; i < 6; i++) {
		h.wheel(-40, 0, time)
		time += 16
	}
	assert.equal(h.pops(), 0)
	runtime.advance(140)
	assert.equal(h.pops(), 1)
	h.wheel(-8, 0, time) // tail crumb keeps the gap alive
	runtime.advance(SWIPE_COOLDOWN_MS + 1)
	time += 1000
	for (let i = 0; i < 6; i++) {
		h.wheel(-40, 0, time)
		time += 16
	}
	assert.equal(h.pops(), 1)
	runtime.advance(140)
	assert.equal(h.pops(), 2)
	h.control.dispose()
})

test('native swipe overlapping a wheel gesture is swallowed without a double pop', () => {
	const runtime = new ManualSwipeRuntime()
	const h = harness(WIDTH, runtime)
	let time = 0
	for (let i = 0; i < 6; i++) {
		h.wheel(-40, 0, time)
		time += 16
	}
	assert.equal(h.pops(), 0)
	// Same physical gesture also recognized by macOS as a page swipe.
	assert.equal(h.control.interceptNativeNav(), true)
	assert.equal(h.pops(), 0)
	runtime.advance(140)
	assert.equal(h.pops(), 1)
	assert.equal(h.control.interceptNativeNav(), true)
	assert.equal(h.pops(), 1)
	h.control.dispose()
})

test('native swipe during engaged wheel tracking is owned by the wheel path', () => {
	const h = harness()
	h.wheel(-40, 0, 0) // engaged (past axis lock), below every commit bar
	assert.equal(h.control.interceptNativeNav(), true)
	assert.equal(h.pops(), 0)
	h.control.dispose()
})

test('native swipe with no wheel engagement proceeds and arms the refractory gap', () => {
	const h = harness()
	assert.equal(h.control.interceptNativeNav(), false) // caller pops natively
	// The same gesture's wheel deltas must not ALSO pop.
	let time = 0
	for (let i = 0; i < 8; i++) {
		h.wheel(-40, 0, time)
		time += 16
	}
	assert.equal(h.pops(), 0)
	h.control.dispose()
})
