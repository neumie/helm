import { type Page, expect, test } from '@playwright/test'
import { PANE_MAX_SHARE, PANE_MIN_HEIGHT } from '../src/renderer/agent-dock/presentation'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
		/** PTY resizes since `watchResizes`, each with the animation frame it happened in. */
		__ptyResizes?: Array<{ rows: number; frame: number }>
		__frame?: number
	}
}

// Jakub's ask: a short "Turn ended" (1/2) sat in a pane kept tall by an earlier long item, and he wants to
// drag the height himself. Now (design §3.24 Pane height) the pane's terminal-side edge is a 6px
// row-resize target: the height follows the pointer within [216, the room that keeps 8 terminal rows]
// (past the 60% share cap), the terminal refits at most once per frame and once on release, the height
// is stored and every pane opens at it, a double-click goes back to automatic sizing, Esc cancels, and
// a drag never moves focus.

const harness = '/iframe.html?id=views-terminal-workspace--agent-dock-harness&viewMode=story'
const KEEPS_ROWS = 8
const STORED = 'helm.agentDock.paneHeight'

async function openHarness(page: Page, width: number, height: number, position: 'bottom' | 'top' = 'bottom') {
	await page.setViewportSize({ width, height })
	await page.goto(harness)
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#agent-dock .agent-dock-row')).toBeVisible()
	await page.evaluate(where => {
		const fixture = window.__helmWorkspaceFixture
		fixture?.setAgentDockPosition?.(where)
		fixture?.agentDock?.emitScenario('long-turn')
	}, position)
	await expect(row(page).locator('.agent-dock-entry')).toHaveCount(2)
	await expect.poll(() => xtermRows(page)).toBeGreaterThan(0)
}

/** Records every PTY resize with the animation frame it happened in. */
async function watchResizes(page: Page): Promise<void> {
	await page.evaluate(() => {
		const fixture = window.__helmWorkspaceFixture
		if (!fixture) throw new Error('no fixture')
		window.__ptyResizes = []
		window.__frame = 0
		const tick = () => {
			window.__frame = (window.__frame ?? 0) + 1
			requestAnimationFrame(tick)
		}
		requestAnimationFrame(tick)
		const pty = fixture.helm.pty
		const resize = pty.resize.bind(pty)
		pty.resize = (id, cols, rows) => {
			window.__ptyResizes?.push({ rows, frame: window.__frame ?? 0 })
			resize(id, cols, rows)
		}
	})
}

const row = (page: Page) => page.locator('#agent-dock .agent-dock-row')
const paneOf = (page: Page) => page.locator('.agent-dock-pane')
const edgeOf = (page: Page) => page.locator('.agent-dock-resize')
const longEntry = (page: Page) => row(page).locator('.agent-dock-entry[aria-label*="ios-sync"]')
const shortEntry = (page: Page) => row(page).locator('.agent-dock-entry[aria-label*="ios-release"]')
const terminal = (page: Page) => page.locator('.term-holder.active .xterm-helper-textarea')
const xtermRows = (page: Page) => page.locator('.term-holder.active .xterm-rows > div').count()
const paneHeight = (page: Page) => paneOf(page).evaluate(node => Math.round(node.getBoundingClientRect().height))
const stored = (page: Page) => page.evaluate(key => localStorage.getItem(key), STORED)
const resizes = (page: Page) => page.evaluate(() => window.__ptyResizes ?? [])
const shareCap = (page: Page) =>
	page.evaluate(
		share => Math.floor((document.querySelector('#right') as HTMLElement).clientHeight * share),
		PANE_MAX_SHARE,
	)

/** Presses the edge's middle; returns where. */
async function pressEdge(page: Page): Promise<{ x: number; y: number }> {
	const box = await edgeOf(page).boundingBox()
	if (!box) throw new Error('no edge')
	const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
	await page.mouse.move(at.x, at.y)
	await page.mouse.down()
	return at
}

/** Drags the edge by `dy` px (negative = up) and releases. */
async function dragEdge(page: Page, dy: number, steps = 12): Promise<void> {
	const at = await pressEdge(page)
	await page.mouse.move(at.x, at.y + dy, { steps })
	await page.mouse.up()
}

async function openShort(page: Page): Promise<void> {
	await shortEntry(page).click()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('1/2')
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT)
}

test('the edge is a separator with nothing visible at rest; hover and drag turn it accent', async ({ page }) => {
	await openHarness(page, 1400, 900)
	await expect(edgeOf(page)).toHaveCount(0)
	await openShort(page)
	const edge = edgeOf(page)
	await expect(edge).toHaveAttribute('role', 'separator')
	await expect(edge).toHaveAttribute('aria-orientation', 'horizontal')
	await expect(edge).toHaveAttribute('aria-label', 'Resize agent pane')
	await expect(edge).toHaveAttribute('aria-valuenow', String(PANE_MIN_HEIGHT))
	await expect(edge).toHaveAttribute('aria-valuemin', String(PANE_MIN_HEIGHT))
	await expect(edge).toHaveAttribute('tabindex', '-1')
	expect(await edge.evaluate(node => getComputedStyle(node).cursor)).toBe('row-resize')
	// 6px, centered on the dock's 1px terminal-side edge (the pane's top).
	const box = await edge.boundingBox()
	const dockTop = await page.locator('#agent-dock').evaluate(node => node.getBoundingClientRect().top)
	expect(box?.height).toBe(6)
	expect(box?.y).toBe(dockTop - 3)
	expect(await edge.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
	const edgeLine = () =>
		page.locator('#agent-dock').evaluate(node => {
			const line = getComputedStyle(node, '::before')
			return { color: line.backgroundColor, height: line.height }
		})
	const accent = await page.evaluate(() => {
		const probe = document.createElement('div')
		probe.style.background = 'var(--accent)'
		document.querySelector('#agent-dock')?.append(probe)
		const color = getComputedStyle(probe).backgroundColor
		probe.remove()
		return color
	})
	// At rest (once the items' arrival flash has faded): the quiet hairline.
	await expect.poll(async () => (await edgeLine()).color, { timeout: 4000 }).not.toBe(accent)
	await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 3)
	await expect.poll(async () => (await edgeLine()).color).toBe(accent)
	expect((await edgeLine()).height).toBe('1px')
	await page.mouse.down()
	await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) - 40, { steps: 4 })
	await expect.poll(async () => (await edgeLine()).height).toBe('2px')
	await page.mouse.up()
	await page.mouse.move(10, 10)
	await expect.poll(async () => (await edgeLine()).color).not.toBe(accent)
})

test('drag from 216 to 500: the pane follows, the PTY refits at most once per frame and once on release', async ({
	page,
}) => {
	await openHarness(page, 1400, 900)
	await openShort(page)
	await expect(terminal(page)).toBeFocused()
	await watchResizes(page)
	const at = await pressEdge(page)
	await page.mouse.move(at.x, at.y - 284, { steps: 24 })
	await expect.poll(() => paneHeight(page)).toBe(500)
	await expect(edgeOf(page)).toHaveAttribute('aria-valuenow', '500')
	// Let the last frame's refit land, then release.
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
	const during = await resizes(page)
	expect(during.length).toBeGreaterThan(0)
	expect(new Set(during.map(entry => entry.frame)).size).toBe(during.length)
	await page.mouse.up()
	await expect.poll(() => stored(page)).toBe('500')
	await page.waitForTimeout(150)
	// Release: one more at most (none when the last frame already fitted this height).
	expect((await resizes(page)).length).toBeLessThanOrEqual(during.length + 1)
	expect(await paneHeight(page)).toBe(500)
	expect(await xtermRows(page)).toBeGreaterThanOrEqual(KEEPS_ROWS)
	await expect(terminal(page)).toBeFocused()
	await expect(paneOf(page)).toBeVisible()
})

test('a burst of pointer moves in one frame refits once, then once on release', async ({ page }) => {
	await openHarness(page, 1400, 900)
	await openShort(page)
	await watchResizes(page)
	const counts = await page.evaluate(async () => {
		const edge = document.querySelector('.agent-dock-resize') as HTMLElement
		const box = edge.getBoundingClientRect()
		const y = box.top + box.height / 2
		const init = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 300 }
		edge.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientY: y, button: 0, buttons: 1 }))
		for (let step = 1; step <= 30; step++)
			edge.dispatchEvent(new PointerEvent('pointermove', { ...init, clientY: y - step * 8, buttons: 1 }))
		const synchronous = window.__ptyResizes?.length ?? 0
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		const framed = window.__ptyResizes?.length ?? 0
		edge.dispatchEvent(new PointerEvent('pointermove', { ...init, clientY: y - 260, buttons: 1 }))
		edge.dispatchEvent(new PointerEvent('pointerup', { ...init, clientY: y - 260, button: 0, buttons: 0 }))
		const released = window.__ptyResizes?.length ?? 0
		return { synchronous, framed, released }
	})
	expect(counts.synchronous).toBe(0)
	expect(counts.framed).toBe(1)
	expect(counts.released).toBe(2)
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT + 260)
	await expect.poll(() => stored(page)).toBe(String(PANE_MIN_HEIGHT + 260))
})

test('the stored height opens every pane, survives a reload; a double-click goes back to automatic', async ({
	page,
}) => {
	await openHarness(page, 1400, 900)
	const cap = await shareCap(page)
	await openShort(page)
	await dragEdge(page, -284)
	await expect.poll(() => stored(page)).toBe('500')
	await paneOf(page).getByRole('button', { name: 'Close details' }).click()
	await expect(paneOf(page)).toHaveCount(0)
	// The long turn (auto: the 517 cap) and the short one (auto: 216) both open at Jakub's 500.
	await longEntry(page).click()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('2/2')
	await expect.poll(() => paneHeight(page)).toBe(500)
	expect(cap).toBeGreaterThan(500)
	await paneOf(page).getByRole('button', { name: 'Close details' }).click()
	await shortEntry(page).click()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('1/2')
	await page.waitForTimeout(300)
	expect(await paneHeight(page)).toBe(500)
	// Reloaded (Helm restarted): still 500.
	await openHarness(page, 1400, 900)
	await shortEntry(page).click()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('1/2')
	await expect.poll(() => paneHeight(page)).toBe(500)
	// Double-click: automatic again — the short turn's own height, the setting cleared.
	await edgeOf(page).dblclick()
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT)
	expect(await stored(page)).toBeNull()
	await expect(terminal(page)).toBeFocused()
	await paneOf(page).getByRole('button', { name: 'Close details' }).click()
	await longEntry(page).click()
	await expect.poll(() => paneHeight(page)).toBe(cap)
})

test('a drag past the share cap stops where the terminal keeps 8 rows', async ({ page }) => {
	await openHarness(page, 1400, 900)
	const cap = await shareCap(page)
	await openShort(page)
	await dragEdge(page, -2000)
	await expect.poll(() => xtermRows(page)).toBe(KEEPS_ROWS)
	const height = await paneHeight(page)
	expect(height).toBeGreaterThan(cap)
	expect(await stored(page)).toBe(String(height))
	// Back down past the minimum: 216.
	await dragEdge(page, 2000)
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT)
	expect(await stored(page)).toBe(String(PANE_MIN_HEIGHT))
})

test('a shorter window clamps the stored height on screen and gives it back when it grows', async ({ page }) => {
	await openHarness(page, 1400, 900)
	await openShort(page)
	await dragEdge(page, -2000)
	const tall = Number(await stored(page))
	expect(tall).toBeGreaterThan(500)
	await page.setViewportSize({ width: 1400, height: 700 })
	await expect.poll(() => paneHeight(page)).toBeLessThan(tall)
	await expect.poll(() => xtermRows(page)).toBeGreaterThanOrEqual(KEEPS_ROWS)
	expect(await stored(page)).toBe(String(tall))
	await page.setViewportSize({ width: 1400, height: 900 })
	await expect.poll(() => paneHeight(page)).toBe(tall)
})

test('dock above the terminal: the pane’s bottom edge is the one to drag', async ({ page }) => {
	await openHarness(page, 1400, 900, 'top')
	await openShort(page)
	const box = await edgeOf(page).boundingBox()
	const dockBottom = await page.locator('#agent-dock').evaluate(node => node.getBoundingClientRect().bottom)
	expect(box?.y).toBe(dockBottom - 3)
	await dragEdge(page, 200)
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT + 200)
	expect(await stored(page)).toBe(String(PANE_MIN_HEIGHT + 200))
	await expect(terminal(page)).toBeFocused()
})

test('a drag never moves focus: keys in the pane stay in the pane', async ({ page }) => {
	await openHarness(page, 1400, 900)
	await terminal(page).focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(shortEntry(page)).toBeFocused()
	await page.keyboard.press('Enter')
	await expect(paneOf(page)).toBeFocused()
	await dragEdge(page, -100)
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT + 100)
	await expect(paneOf(page)).toBeFocused()
	// A plain click (no move) on the edge: nothing changes, focus stays.
	await dragEdge(page, 0)
	await expect(paneOf(page)).toBeFocused()
	expect(await paneHeight(page)).toBe(PANE_MIN_HEIGHT + 100)
})

test('⌥↑ ⌥↓ from the pane move the edge a terminal row', async ({ page }) => {
	await openHarness(page, 1400, 900)
	await terminal(page).focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await page.keyboard.press('Enter')
	await expect(paneOf(page)).toBeFocused()
	await page.keyboard.press('Alt+ArrowUp')
	await expect.poll(() => paneHeight(page)).toBeGreaterThan(PANE_MIN_HEIGHT)
	const up = await paneHeight(page)
	expect(up - PANE_MIN_HEIGHT).toBeLessThan(30)
	expect(await stored(page)).toBe(String(up))
	await page.keyboard.press('Alt+ArrowDown')
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT)
	// Still the turn, still focused: the keys only moved the edge.
	await expect(paneOf(page)).toBeFocused()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('1/2')
})

test('Esc during a drag goes back to where it started and reaches nothing else', async ({ page }) => {
	await openHarness(page, 1400, 900)
	await openShort(page)
	await expect(terminal(page)).toBeFocused()
	await page.evaluate(() => window.__helmWorkspaceFixture?.clearWrites())
	const at = await pressEdge(page)
	await page.mouse.move(at.x, at.y - 200, { steps: 8 })
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT + 200)
	await page.keyboard.press('Escape')
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT)
	// The rest of the gesture moves nothing.
	await page.mouse.move(at.x, at.y - 300, { steps: 4 })
	await page.mouse.up()
	expect(await paneHeight(page)).toBe(PANE_MIN_HEIGHT)
	expect(await stored(page)).toBeNull()
	await expect(paneOf(page)).toBeVisible()
	await expect(terminal(page)).toBeFocused()
	const writes = await page.evaluate(() => window.__helmWorkspaceFixture?.calls.writes ?? [])
	expect(writes.some(write => write.data.includes('\x1b'))).toBe(false)
	await expect.poll(() => xtermRows(page)).toBeGreaterThan(KEEPS_ROWS)
})

test('text selection in the pane still works and resizes nothing', async ({ page }) => {
	await openHarness(page, 1400, 900)
	await longEntry(page).click()
	const pane = paneOf(page)
	await expect(pane.locator('.agent-dock-step-count')).toContainText('2/2')
	const before = await paneHeight(page)
	const body = pane.locator('.agent-dock-pane-scroll')
	const box = await body.boundingBox()
	if (!box) throw new Error('no body')
	await page.mouse.move(box.x + 24, box.y + 12)
	await page.mouse.down()
	await page.mouse.move(box.x + 320, box.y + 60, { steps: 8 })
	await page.mouse.up()
	const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
	expect(selected.length).toBeGreaterThan(10)
	expect(await paneHeight(page)).toBe(before)
	expect(await stored(page)).toBeNull()
})

test('a drag whose release Helm never sees ends where it is: blur, a buttonless move, lost capture', async ({
	page,
}) => {
	await openHarness(page, 1400, 900)
	await openShort(page)
	// Window blur mid-drag (⌘⇥ with the button held): the drag ends at the height shown, nothing follows.
	const at = await pressEdge(page)
	await page.mouse.move(at.x, at.y - 100, { steps: 4 })
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT + 100)
	await page.evaluate(() => window.dispatchEvent(new Event('blur')))
	await expect.poll(() => stored(page)).toBe(String(PANE_MIN_HEIGHT + 100))
	await page.mouse.move(at.x, at.y - 250, { steps: 4 })
	await page.mouse.up()
	expect(await paneHeight(page)).toBe(PANE_MIN_HEIGHT + 100)
	// The pointerup went elsewhere: the next move has no button held — the pane never follows a hover.
	const y = await edgeOf(page).evaluate(node => node.getBoundingClientRect().top + 3)
	await page.evaluate(top => {
		const edge = document.querySelector('.agent-dock-resize') as HTMLElement
		const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, clientX: 300 }
		edge.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientY: top, button: 0, buttons: 1 }))
		edge.dispatchEvent(new PointerEvent('pointermove', { ...init, clientY: top - 40, buttons: 1 }))
		edge.dispatchEvent(new PointerEvent('pointermove', { ...init, clientY: top - 200, buttons: 0 }))
		edge.dispatchEvent(new PointerEvent('pointermove', { ...init, clientY: top - 220, buttons: 1 }))
	}, y)
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT + 140)
	expect(await stored(page)).toBe(String(PANE_MIN_HEIGHT + 140))
	// Capture lost without a release: same.
	const top = await edgeOf(page).evaluate(node => node.getBoundingClientRect().top + 3)
	await page.evaluate(top => {
		const edge = document.querySelector('.agent-dock-resize') as HTMLElement
		const init = { bubbles: true, cancelable: true, pointerId: 8, pointerType: 'mouse', isPrimary: true, clientX: 300 }
		edge.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientY: top, button: 0, buttons: 1 }))
		edge.dispatchEvent(new PointerEvent('pointermove', { ...init, clientY: top + 60, buttons: 1 }))
		edge.dispatchEvent(new PointerEvent('lostpointercapture', init))
		edge.dispatchEvent(new PointerEvent('pointermove', { ...init, clientY: top + 120, buttons: 1 }))
	}, top)
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT + 80)
	expect(await stored(page)).toBe(String(PANE_MIN_HEIGHT + 80))
	await expect(terminal(page)).toBeFocused()
	// Nothing is left holding the pane: a press outside closes it as ever.
	await page.mouse.click(5, 5)
	await expect(paneOf(page)).toHaveCount(0)
})
