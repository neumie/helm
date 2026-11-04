import { type Page, expect, test } from '@playwright/test'
import { PANE_MAX_SHARE, PANE_MIN_HEIGHT } from '../src/renderer/agent-dock/presentation'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
		__termHeights?: number[]
	}
}

// Jakub's report: a long "Turn ended" at 1/1 showed ~5 lines of its message in a ~216px pane while the
// window had room above. The pane had opened on a short turn (216) and kept that height when it moved
// on to the long one after the ack. Now (design §3.24) the pane opens at the shown content's natural
// height up to a share of #right (PANE_MAX_SHARE, never below 480, always leaving 8 terminal rows), and
// content that replaces it without a step (a move-on, an agent opened from the Agents list) or arrives
// right after the open may grow it once; ‹ › stepping never changes it, and it never shrinks while open.

const harness = '/iframe.html?id=views-terminal-workspace--agent-dock-harness&viewMode=story'
const KEEPS_ROWS = 8

/** `readDelayMs`: the agent detail's live message (Okena's last message) arrives this late. */
async function openLongTurn(page: Page, width: number, height: number, readDelayMs = 0): Promise<void> {
	await page.setViewportSize({ width, height })
	await page.goto(harness)
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#agent-dock .agent-dock-row')).toBeVisible()
	await page.evaluate(delay => {
		const api = window.__helmWorkspaceFixture?.agentDock?.api
		if (api && delay > 0) {
			const read = api.lastMessage.bind(api)
			api.lastMessage = async session => {
				await new Promise(resolve => setTimeout(resolve, delay))
				return read(session)
			}
		}
		window.__helmWorkspaceFixture?.agentDock?.emitScenario('long-turn')
	}, readDelayMs)
	await expect(row(page).locator('.agent-dock-entry')).toHaveCount(2)
	await expect.poll(() => xtermRows(page)).toBeGreaterThan(0)
	// Every terminal-row height change from here: the observer's first report, then one per refit.
	await page.evaluate(() => {
		const terms = document.querySelector('#terms') as HTMLElement
		const heights: number[] = []
		new ResizeObserver(() => heights.push(terms.getBoundingClientRect().height)).observe(terms)
		window.__termHeights = heights
	})
	await expect.poll(() => termHeights(page)).toHaveLength(1)
}

const row = (page: Page) => page.locator('#agent-dock .agent-dock-row')
const paneOf = (page: Page) => page.locator('.agent-dock-pane')
const longEntry = (page: Page) => row(page).locator('.agent-dock-entry[aria-label*="ios-sync"]')
const shortEntry = (page: Page) => row(page).locator('.agent-dock-entry[aria-label*="ios-release"]')
const terminal = (page: Page) => page.locator('.term-holder.active .xterm-helper-textarea')
const xtermRows = (page: Page) => page.locator('.term-holder.active .xterm-rows > div').count()
const termHeights = (page: Page) => page.evaluate(() => window.__termHeights ?? [])
const paneHeight = (page: Page) => paneOf(page).evaluate(node => node.getBoundingClientRect().height)
const bodyHeight = (page: Page) =>
	page.locator('.agent-dock-pane .agent-dock-pane-scroll').evaluate(node => node.clientHeight)
const rightHeight = (page: Page) => page.evaluate(() => (document.querySelector('#right') as HTMLElement).clientHeight)
/** The share cap for this window (above 480, below the room that keeps the terminal's rows). */
const shareCap = async (page: Page) => Math.floor((await rightHeight(page)) * PANE_MAX_SHARE)

/** ⌘⇧J from the terminal, then Enter on the first entry (the short turn): a keyboard open. */
async function openShortByKeys(page: Page): Promise<void> {
	await terminal(page).focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(shortEntry(page)).toBeFocused()
	await page.keyboard.press('Enter')
	await expect(paneOf(page)).toBeFocused()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('1/2')
}

test('a long turn opens at the share cap, far taller than before; ‹ › keep it; one refit each way', async ({
	page,
}) => {
	await openLongTurn(page, 1400, 900)
	const rowsBefore = await xtermRows(page)
	const [termsBefore] = await termHeights(page)
	const cap = await shareCap(page)
	// 60% of a 862px #right: past the old 480px cap.
	expect(cap).toBeGreaterThan(480)
	await longEntry(page).click()
	const pane = paneOf(page)
	await expect(pane.locator('.agent-dock-step-count')).toContainText('2/2')
	await expect.poll(() => paneHeight(page)).toBe(cap)
	// The message gets ~21 lines (it showed ~6 in the reported 216px pane); the rest scrolls.
	expect(await bodyHeight(page)).toBeGreaterThan(400)
	expect(await xtermRows(page)).toBeGreaterThanOrEqual(KEEPS_ROWS)
	// Stepping to the short turn and back never resizes the pane or refits the terminal.
	await pane.getByRole('button', { name: 'Previous item' }).click()
	await expect(pane.locator('.agent-dock-step-count')).toContainText('1/2')
	expect(await paneHeight(page)).toBe(cap)
	await pane.getByRole('button', { name: 'Next item' }).click()
	await expect(pane.locator('.agent-dock-step-count')).toContainText('2/2')
	expect(await paneHeight(page)).toBe(cap)
	await pane.getByRole('button', { name: 'Close details' }).click()
	await expect(pane).toHaveCount(0)
	await expect.poll(() => xtermRows(page)).toBe(rowsBefore)
	// The observer's first report, then exactly two changes: the split, then back.
	const seen = await termHeights(page)
	expect(seen).toHaveLength(3)
	expect(seen[1]).toBeLessThan(termsBefore ?? 0)
	expect(seen[2]).toBe(termsBefore)
})

test('a short turn stays compact', async ({ page }) => {
	await openLongTurn(page, 1400, 900)
	await shortEntry(page).click()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('1/2')
	await expect.poll(() => paneHeight(page)).toBe(PANE_MIN_HEIGHT)
	await expect(paneOf(page).locator('.agent-dock-hint[data-scroll]')).toHaveCount(0)
})

test('Jakub’s report: acked the short turn, the pane moves on to the long one and grows to it once', async ({
	page,
}) => {
	await openLongTurn(page, 1400, 900)
	const [termsBefore] = await termHeights(page)
	const cap = await shareCap(page)
	await openShortByKeys(page)
	expect(await paneHeight(page)).toBe(PANE_MIN_HEIGHT)
	await page.keyboard.press('Meta+Backspace')
	const pane = paneOf(page)
	await expect(pane.locator('.agent-dock-step-count')).toContainText('1/1')
	await expect(pane.locator('.agent-dock-title')).toContainText('Turn ended')
	await expect.poll(() => paneHeight(page)).toBe(cap)
	await expect(pane).toBeFocused()
	expect(await bodyHeight(page)).toBeGreaterThan(400)
	expect(await xtermRows(page)).toBeGreaterThanOrEqual(KEEPS_ROWS)
	await page.keyboard.press('Escape')
	await expect(pane).toHaveCount(0)
	// Open, the one growth, close.
	await expect.poll(() => termHeights(page)).toHaveLength(4)
	const seen = await termHeights(page)
	expect(seen[1]).toBeLessThan(termsBefore ?? 0)
	expect(seen[2]).toBeLessThan(seen[1] ?? 0)
	expect(seen[3]).toBe(termsBefore)
})

test('moving on to a shorter item never shrinks the pane', async ({ page }) => {
	await openLongTurn(page, 1400, 900)
	const cap = await shareCap(page)
	await terminal(page).focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await page.keyboard.press('ArrowRight')
	await expect(longEntry(page)).toBeFocused()
	await page.keyboard.press('Enter')
	const pane = paneOf(page)
	await expect(pane.locator('.agent-dock-step-count')).toContainText('2/2')
	await expect.poll(() => paneHeight(page)).toBe(cap)
	await page.keyboard.press('Meta+Backspace')
	await expect(pane.locator('.agent-dock-step-count')).toContainText('1/1')
	await expect(pane).toContainText('TestFlight')
	expect(await paneHeight(page)).toBe(cap)
	// Open only: no growth, no shrink.
	expect(await termHeights(page)).toHaveLength(2)
})

test('an agent detail opened from the Agents list grows once to its live message', async ({ page }) => {
	await openLongTurn(page, 1400, 900)
	const cap = await shareCap(page)
	// Both turns read elsewhere: the agents owe Jakub nothing, so a row opens its detail.
	await page.evaluate(async () => {
		const dock = window.__helmWorkspaceFixture?.agentDock
		const ids = [...document.querySelectorAll('.agent-dock-entry[data-item-id]')].map(node =>
			Number(node.getAttribute('data-item-id')),
		)
		for (const id of ids) await dock?.api.ack(id)
	})
	await expect(row(page).locator('.agent-dock-entry')).toHaveCount(0)
	await row(page).locator('.agent-dock-agents-entry').click()
	const pane = paneOf(page)
	await expect(pane.locator('.agent-dock-agent')).toHaveCount(2)
	const listHeight = await paneHeight(page)
	expect(listHeight).toBeLessThan(cap)
	await pane
		.locator('.agent-dock-agent')
		.filter({ has: page.locator('.agent-dock-agent-name', { hasText: 'ios-sync' }) })
		.click()
	await expect(pane.locator('.agent-dock-md')).toContainText('Otevřené otázky')
	await expect.poll(() => paneHeight(page)).toBe(cap)
	expect(await xtermRows(page)).toBeGreaterThanOrEqual(KEEPS_ROWS)
	// ‹ › to the other agent keeps it.
	const previous = pane.getByRole('button', { name: 'Previous agent' })
	await ((await previous.isEnabled()) ? previous : pane.getByRole('button', { name: 'Next agent' })).click()
	await expect(pane.locator('.agent-dock-title-kind')).toContainText('ios-release')
	expect(await paneHeight(page)).toBe(cap)
	// Open, the one growth.
	expect(await termHeights(page)).toHaveLength(3)
})

test('typing in the terminal ends the growth chance: a late message never resizes the PTY under the keys', async ({
	page,
}) => {
	// A pointer-opened pane leaves the keys in the terminal; the agent's message is read late (900ms).
	await openLongTurn(page, 1400, 900, 900)
	await page.evaluate(async () => {
		const dock = window.__helmWorkspaceFixture?.agentDock
		const ids = [...document.querySelectorAll('.agent-dock-entry[data-item-id]')].map(node =>
			Number(node.getAttribute('data-item-id')),
		)
		for (const id of ids) await dock?.api.ack(id)
	})
	await expect(row(page).locator('.agent-dock-entry')).toHaveCount(0)
	await row(page).locator('.agent-dock-agents-entry').click()
	const pane = paneOf(page)
	await pane
		.locator('.agent-dock-agent')
		.filter({ has: page.locator('.agent-dock-agent-name', { hasText: 'ios-sync' }) })
		.click()
	await expect(terminal(page)).toBeFocused()
	const before = await paneHeight(page)
	await page.keyboard.type('ls')
	await expect(pane.locator('.agent-dock-md')).toContainText('Otevřené otázky')
	await page.waitForTimeout(200)
	// The message came in after Jakub typed: the pane keeps its height (the body scrolls), no refit.
	expect(await paneHeight(page)).toBe(before)
	expect(await termHeights(page)).toHaveLength(2)
})

test('a pane opened in a window too short for it gets its height back when the window grows', async ({ page }) => {
	await openLongTurn(page, 900, 560)
	await longEntry(page).click()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('2/2')
	await expect.poll(() => xtermRows(page)).toBe(KEEPS_ROWS)
	const clamped = await paneHeight(page)
	expect(clamped).toBeLessThan(480)
	await page.setViewportSize({ width: 1400, height: 900 })
	// The height it was given at open (60% of a 522px #right is under 480, so 480), no longer clamped.
	await expect.poll(() => paneHeight(page)).toBe(480)
	await expect.poll(() => xtermRows(page)).toBeGreaterThan(KEEPS_ROWS)
})

test('a short window: the room that keeps 8 terminal rows caps the pane', async ({ page }) => {
	await openLongTurn(page, 1400, 700)
	await longEntry(page).click()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('2/2')
	// 60% of a 662px #right is under 480: the 480 floor of the cap, then the room, win.
	expect(await shareCap(page)).toBeLessThan(480)
	await expect.poll(() => xtermRows(page)).toBe(KEEPS_ROWS)
	expect(await paneHeight(page)).toBeLessThan(480)
	expect(await paneHeight(page)).toBeGreaterThan(400)
})

test('a narrow, short window clamps the pane and the terminal keeps its rows', async ({ page }) => {
	await openLongTurn(page, 900, 560)
	await longEntry(page).click()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText('2/2')
	await expect.poll(() => xtermRows(page)).toBe(KEEPS_ROWS)
	// Under the cap's 480 floor: the room is what binds.
	expect(await paneHeight(page)).toBeLessThan(480)
	expect(await paneHeight(page)).toBeGreaterThan(PANE_MIN_HEIGHT)
})

test('window resize while open: the pane keeps its height unless the room shrinks below it', async ({ page }) => {
	await openLongTurn(page, 1400, 900)
	const cap = await shareCap(page)
	await longEntry(page).click()
	await expect.poll(() => paneHeight(page)).toBe(cap)
	await page.setViewportSize({ width: 1400, height: 700 })
	await expect.poll(() => paneHeight(page)).toBeLessThan(cap)
	await expect.poll(() => xtermRows(page)).toBeGreaterThanOrEqual(KEEPS_ROWS)
	await page.setViewportSize({ width: 1400, height: 982 })
	// Taller than when it opened: the height it was given, not a new share.
	await expect.poll(() => paneHeight(page)).toBe(cap)
})
