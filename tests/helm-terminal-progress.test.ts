import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import progressModule from '../app/src/renderer/terminal-progress.ts'

const { createTerminalProgressTracker, shouldMarkTerminalCompletion } = progressModule
const ACTIVE = '\x1b]9;4;3\x07'
const CLEAR = '\x1b]9;4;0;\x07'

function harness() {
	const states: boolean[] = []
	const tracker = createTerminalProgressTracker(active => states.push(active))
	return { tracker, states }
}

test('tracks Pi active and clear progress without altering terminal bytes', () => {
	const { tracker, states } = harness()
	const activeChunk = `before${ACTIVE}after`
	const clearChunk = `before${CLEAR}after`
	tracker.feed(activeChunk)
	tracker.feed(activeChunk) // Pi keepalive is idempotent.
	tracker.feed(clearChunk)
	assert.deepEqual(states, [true, false])
	assert.equal(activeChunk, `before${ACTIVE}after`)
	assert.equal(clearChunk, `before${CLEAR}after`)
})

test('recognizes OSC progress sequences split across arbitrary PTY chunks', () => {
	const { tracker, states } = harness()
	tracker.feed('\x1b]9;')
	tracker.feed('4;3\x07ordinary\x1b]9;4;')
	tracker.feed('0;\x07')
	assert.deepEqual(states, [true, false])
})

test('ignores unrelated and malformed OSC 9 payloads', () => {
	const { tracker, states } = harness()
	tracker.feed('\x1b]9;4;2\x07')
	tracker.feed('\x1b]9;3;3\x07')
	tracker.feed('\x1b]0;Pi title\x07')
	assert.deepEqual(states, [])
})

test('clear resets a running tab on close or PTY exit', () => {
	const { tracker, states } = harness()
	tracker.feed(ACTIVE)
	tracker.clear()
	tracker.clear()
	assert.deepEqual(states, [true, false])
})

test('only an unseen active-to-clear transition requests attention', () => {
	assert.equal(
		shouldMarkTerminalCompletion({ wasRunning: true, closed: false, tabSelected: false, windowFocused: true }),
		true,
	)
	assert.equal(
		shouldMarkTerminalCompletion({ wasRunning: true, closed: false, tabSelected: true, windowFocused: false }),
		true,
	)
	assert.equal(
		shouldMarkTerminalCompletion({ wasRunning: true, closed: false, tabSelected: true, windowFocused: true }),
		false,
	)
	assert.equal(
		shouldMarkTerminalCompletion({ wasRunning: false, closed: false, tabSelected: false, windowFocused: true }),
		false,
	)
	assert.equal(
		shouldMarkTerminalCompletion({ wasRunning: true, closed: true, tabSelected: false, windowFocused: true }),
		false,
	)
})

test('renderer wires explicit progress into visible, accessible tab state', () => {
	const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf8')
	const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
	const component = readFileSync(new URL('../app/src/renderer/activity-indicator.tsx', import.meta.url), 'utf8')
	const story = readFileSync(
		new URL('../app/src/renderer/sidebar/ActivityIndicator.stories.tsx', import.meta.url),
		'utf8',
	)
	const css = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf8')
	assert.ok(renderer.indexOf('tab.progressTracker.feed(data)') < renderer.indexOf('tab.outputGuard.write(output'))
	assert.match(renderer, /createActivityIndicator\('Running'\)/)
	assert.match(renderer, /tabButton\.append\(running, label, close\)/)
	assert.match(renderer, /preview === 'running-tab'[\s\S]+setTabAgentRunning\(activeTab, true\)/)
	assert.match(renderer, /preview === 'attention-tab'[\s\S]+setTabAgentAttention\(activeTab, true\)/)
	assert.match(renderer, /clearTabAgentAttention\(tab\)/)
	assert.match(preload, /'running-tab'/)
	assert.match(preload, /'attention-tab'/)
	assert.match(component, /ACTIVITY_INDICATOR_DOTS = ACTIVITY_DOT_IDS\.length/)
	assert.equal(component.match(/'(top|middle|bottom)-(left|right)'/g)?.length, 6)
	assert.match(component, /aria-label=\{label\}/)
	assert.equal(renderer.match(/progressTracker\.clear\(\)/g)?.length, 3)
	assert.match(css, /\.activity-indicator\s*\{[^}]*grid-template-columns:\s*repeat\(2, 2px\)/s)
	assert.match(css, /\.activity-indicator-dot\s*\{[^}]*background:\s*var\(--text-0\)/s)
	assert.match(css, /\.activity-indicator-dot:nth-child\(6\)/)
	assert.match(css, /@keyframes activity-indicator-clockwise[\s\S]*background-color:\s*var\(--accent\)/)
	assert.match(component, /variant\?: ActivityIndicatorVariant/)
	assert.match(story, /variant: 'attention'/)
	assert.match(css, /\.activity-indicator\[data-variant=["']attention["']\]/)
	assert.match(
		css,
		/data-variant=["']attention["'][^}]*\.activity-indicator-dot\s*\{[^}]*activity-indicator-attention-color[^}]*1\.8s/s,
	)
	assert.match(css, /nth-child\(2\),[\s\S]*nth-child\(3\)[^}]*animation-delay:\s*-0\.6s/s)
	assert.match(css, /nth-child\(4\),[\s\S]*nth-child\(5\)[^}]*animation-delay:\s*-0\.3s/s)
	assert.match(css, /data-variant=["']attention["'][^}]*nth-child\(6\)[^}]*animation-delay:\s*0s/s)
	assert.match(
		css,
		/@keyframes activity-indicator-attention-color[\s\S]*background-color:\s*var\(--text-2\)[\s\S]*background-color:\s*var\(--accent\)/,
	)
	assert.match(story, /className="activity-indicator-label"/)
	assert.match(css, /\.activity-indicator-label\s*\{[^}]*animation:[^;}]*1\.8s/s)
	assert.match(css, /@keyframes activity-indicator-label-breathe[\s\S]*opacity:\s*0\.76/)
	assert.match(css, /\.tab-running\s*\{[^}]*margin-right:\s*2px/s)
})
