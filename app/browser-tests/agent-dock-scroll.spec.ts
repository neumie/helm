import { type Locator, type Page, expect, test } from '@playwright/test'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
	}
}

// Jakub's report: a long turn opened by keys could not be scrolled by keys (design §3.24 Keys). While
// the body overflows and has no live choices, ↑ ↓ scroll it by a line step, Page keys and Space page,
// Home End jump — from the pane, its body, ‹ ›, the footer buttons and an empty Reply. Ask panes keep
// ↑ ↓ for their choices; Page keys scroll their body from anywhere in the pane.

const harness = '/iframe.html?id=views-terminal-workspace--agent-dock-harness&viewMode=story'

async function openHarness(page: Page, height = 820): Promise<void> {
	await page.setViewportSize({ width: 1400, height })
	await page.goto(harness)
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#agent-dock .agent-dock-row')).toBeVisible()
}

async function emitScenario(page: Page, name: 'long-turn' | 'helm-terminals' | 'crowded'): Promise<void> {
	await page.evaluate(scenario => {
		const dock = window.__helmWorkspaceFixture?.agentDock
		if (!dock) throw new Error('Missing agent-dock fixture')
		dock.emitScenario(scenario)
	}, name)
}

const row = (page: Page) => page.locator('#agent-dock .agent-dock-row')
const paneOf = (page: Page) => page.locator('.agent-dock-pane')
const bodyOf = (page: Page) => page.locator('.agent-dock-pane .agent-dock-pane-scroll')
const terminal = (page: Page) => page.locator('.term-holder.active .xterm-helper-textarea')
const longEntry = (page: Page) => row(page).locator('.agent-dock-entry[aria-label*="ios-sync"]')
const shortEntry = (page: Page) => row(page).locator('.agent-dock-entry[aria-label*="ios-release"]')

const scrollTop = (page: Page) => bodyOf(page).evaluate(node => node.scrollTop)
const maxScroll = (page: Page) => bodyOf(page).evaluate(node => node.scrollHeight - node.clientHeight)
const setScroll = (page: Page, top: number) =>
	bodyOf(page).evaluate((node, value) => {
		node.scrollTop = value
	}, top)
const xtermRows = (page: Page) => page.locator('.term-holder.active .xterm-rows > div').count()

/** The body clips the message: it is what Jakub needs to scroll. */
async function expectOverflow(page: Page): Promise<void> {
	await expect.poll(() => maxScroll(page)).toBeGreaterThan(120)
}

/** From the terminal by keys: ⌘⇧J, → onto the long turn, Enter. */
async function openLongByEnter(page: Page): Promise<Locator> {
	await openHarness(page)
	await emitScenario(page, 'long-turn')
	await expect(row(page).locator('.agent-dock-entry')).toHaveCount(2)
	await terminal(page).focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(shortEntry(page)).toBeFocused()
	await page.keyboard.press('ArrowRight')
	await expect(longEntry(page)).toBeFocused()
	await page.keyboard.press('Enter')
	const pane = paneOf(page)
	await expect(pane).toBeFocused()
	await expect(pane.locator('.agent-dock-step-count')).toContainText('2/2')
	await expectOverflow(page)
	return pane
}

/** ↓ scrolls a line step (3 lines, never a page), ↑ comes back; the item and focus stay. */
async function expectLineScroll(page: Page, focused: Locator, count: string): Promise<void> {
	await setScroll(page, 0)
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => scrollTop(page)).toBeGreaterThanOrEqual(36)
	const line = await scrollTop(page)
	expect(line).toBeLessThanOrEqual(72)
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => scrollTop(page)).toBeGreaterThan(line)
	await page.keyboard.press('ArrowUp')
	await page.keyboard.press('ArrowUp')
	await expect.poll(() => scrollTop(page)).toBe(0)
	await expect(focused).toBeFocused()
	await expect(paneOf(page).locator('.agent-dock-step-count')).toContainText(count)
}

/** PageDown / PageUp, Space / Shift+Space page; End / Home jump; focus stays. */
async function expectPageKeys(page: Page, focused: Locator, { space = true, homeEnd = true } = {}): Promise<void> {
	const page1 = await bodyOf(page).evaluate(node => node.clientHeight - 32)
	await setScroll(page, 0)
	await page.keyboard.press('PageDown')
	await expect.poll(() => scrollTop(page)).toBeGreaterThanOrEqual(Math.min(page1, await maxScroll(page)) - 1)
	await page.keyboard.press('PageUp')
	await expect.poll(() => scrollTop(page)).toBe(0)
	if (space) {
		await page.keyboard.press('Space')
		await expect.poll(() => scrollTop(page)).toBeGreaterThanOrEqual(Math.min(page1, await maxScroll(page)) - 1)
		await page.keyboard.press('Shift+Space')
		await expect.poll(() => scrollTop(page)).toBe(0)
	}
	if (homeEnd) {
		await page.keyboard.press('End')
		await expect.poll(async () => (await maxScroll(page)) - (await scrollTop(page))).toBeLessThanOrEqual(1)
		await page.keyboard.press('Home')
		await expect.poll(() => scrollTop(page)).toBe(0)
	}
	await expect(focused).toBeFocused()
}

test('a long turn opened with Enter scrolls by keys from the pane: ↑ ↓ lines, Page keys and Space, Home End', async ({
	page,
}) => {
	const pane = await openLongByEnter(page)
	// Scrolling never moves the pane or refits the terminal.
	const placed = await pane.boundingBox()
	const rows = await xtermRows(page)
	await expectLineScroll(page, pane, '2/2')
	await expectPageKeys(page, pane)
	expect(await pane.boundingBox()).toEqual(placed)
	expect(await xtermRows(page)).toBe(rows)
	// The footer says so, quietly, while the body overflows.
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText(
		/^↑↓ scroll\s*⌘↵ send\s*⌘⌫ ack\s*⌘O terminal\s*esc close$/,
	)
	// ← → still step items.
	await page.keyboard.press('ArrowLeft')
	await expect(pane.locator('.agent-dock-step-count')).toContainText('1/2')
	await expect(pane).toBeFocused()
	// The short turn fits: no scroll hint, and ↓ ↑ step items as before.
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText(/^⌘↵ send\s*⌘⌫ ack\s*⌘O terminal\s*esc close$/)
	await page.keyboard.press('ArrowDown')
	await expect(pane.locator('.agent-dock-step-count')).toContainText('2/2')
})

test('moving on after ⌘⌫ lands on the long turn at 1/1, and ↓ ↑ scroll it', async ({ page }) => {
	await openHarness(page)
	await emitScenario(page, 'long-turn')
	await expect(row(page).locator('.agent-dock-entry')).toHaveCount(2)
	await terminal(page).focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await page.keyboard.press('Enter')
	const pane = paneOf(page)
	await expect(pane).toBeFocused()
	await expect(pane.locator('.agent-dock-step-count')).toContainText('1/2')
	await page.keyboard.press('Meta+Backspace')
	await expect(shortEntry(page)).toHaveCount(0)
	await expect(pane.locator('.agent-dock-step-count')).toContainText('1/1')
	await expect(pane).toBeFocused()
	await expectOverflow(page)
	await expectLineScroll(page, pane, '1/1')
	await expectPageKeys(page, pane)
})

test('⌘⇧J into a long turn opened by pointer: the pane takes the keys and they scroll it', async ({ page }) => {
	await openHarness(page)
	await emitScenario(page, 'long-turn')
	await terminal(page).focus()
	await longEntry(page).click()
	await expect(terminal(page)).toBeFocused()
	await page.keyboard.press('Meta+Shift+KeyJ')
	const pane = paneOf(page)
	await expect(pane).toBeFocused()
	await expectOverflow(page)
	await expectLineScroll(page, pane, '2/2')
	await expectPageKeys(page, pane)
})

test('the keys scroll the long turn from ‹ ›, Ack and the body too, and focus stays where it is', async ({ page }) => {
	const pane = await openLongByEnter(page)
	const previous = pane.getByRole('button', { name: 'Previous item' })
	await previous.focus()
	await expectLineScroll(page, previous, '2/2')
	await expectPageKeys(page, previous)
	const ack = pane.getByRole('button', { name: /^Ack item/ })
	await ack.focus()
	await expectLineScroll(page, ack, '2/2')
	await expectPageKeys(page, ack)
	// Space paged instead of pressing: nothing was acked.
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.acks)).toEqual([])
	const body = bodyOf(page)
	await body.focus()
	await expectLineScroll(page, body, '2/2')
	await expectPageKeys(page, body)
	// Enter on a focused button still presses it.
	await previous.focus()
	await page.keyboard.press('Enter')
	await expect(pane.locator('.agent-dock-step-count')).toContainText('1/2')
})

test('the empty Reply scrolls the message with ↑ ↓ and Page keys; once it has text the keys edit it', async ({
	page,
}) => {
	const pane = await openLongByEnter(page)
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await reply.evaluate(node => (node as HTMLTextAreaElement).focus({ preventScroll: true }))
	await expect(reply).toBeFocused()
	await expectLineScroll(page, reply, '2/2')
	await expectPageKeys(page, reply, { space: false, homeEnd: false })
	await expect(reply).toHaveValue('')
	// Space types into it.
	await page.keyboard.press('Space')
	await expect(reply).toHaveValue(' ')
	await page.keyboard.type('ok')
	// With text, ↑ ↓ move the caret (to the start, back to the end), never the body.
	const caret = () => reply.evaluate(node => (node as HTMLTextAreaElement).selectionStart)
	await page.keyboard.press('ArrowUp')
	expect(await caret()).toBe(0)
	await page.keyboard.press('ArrowDown')
	expect(await caret()).toBe(3)
	await expect(pane.locator('.agent-dock-hint[data-scroll]')).toBeHidden()
	await expect(reply).toBeFocused()
})

test('an agent detail with a long last message: ↓ ↑ scroll it instead of stepping agents', async ({ page }) => {
	await openHarness(page)
	await emitScenario(page, 'long-turn')
	await expect(row(page).locator('.agent-dock-entry')).toHaveCount(2)
	// Both turns read elsewhere: the agents owe Jakub nothing, so a row opens its detail.
	await page.evaluate(async () => {
		const dock = window.__helmWorkspaceFixture?.agentDock
		const ids = [...document.querySelectorAll('.agent-dock-entry[data-item-id]')].map(node =>
			Number(node.getAttribute('data-item-id')),
		)
		for (const id of ids) await dock?.api.ack(id)
	})
	await expect(row(page).locator('.agent-dock-entry')).toHaveCount(0)
	await terminal(page).focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await page.keyboard.press('End')
	await expect(row(page).locator('.agent-dock-agents-entry')).toBeFocused()
	await page.keyboard.press('Enter')
	const pane = paneOf(page)
	const agent = pane
		.locator('.agent-dock-agent')
		.filter({ has: page.locator('.agent-dock-agent-name', { hasText: 'ios-sync' }) })
	await expect(pane.locator('.agent-dock-agent').first()).toBeFocused()
	await agent.focus()
	await page.keyboard.press('Enter')
	await expect(pane).toBeFocused()
	await expect(pane.locator('.agent-dock-md')).toContainText('Otevřené otázky')
	await expectOverflow(page)
	const count = (await pane.locator('.agent-dock-step-count').textContent()) ?? ''
	await expectLineScroll(page, pane, count)
	await expect(pane.locator('.agent-dock-title-kind')).toContainText('ios-sync')
	await expectPageKeys(page, pane)
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText(/^↑↓ scroll/)
})

test('a long plan: ↓ still goes to its choices; Page keys scroll it from the pane, a choice and ‹ ›', async ({
	page,
}) => {
	// A short window leaves the pane a few body rows, so the plan overflows.
	await openHarness(page, 440)
	await emitScenario(page, 'helm-terminals')
	const plan = row(page).locator('.agent-dock-entry[aria-label^="Plan,"]')
	await expect(plan).toHaveCount(1)
	await terminal(page).focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await plan.focus()
	await page.keyboard.press('Enter')
	const pane = paneOf(page)
	await expect(pane).toBeFocused()
	await expect(pane.locator('.agent-dock-title-kind')).toContainText('Plan')
	await expect.poll(() => maxScroll(page)).toBeGreaterThan(20)
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText(/^⇞⇟ scroll/)
	await expectPageKeys(page, pane, { space: true, homeEnd: true })
	// ↓ from the pane enters the choices, as before.
	await page.keyboard.press('ArrowDown')
	const choice = pane.getByRole('radio', { name: /Approve the plan/ })
	await expect(choice).toBeFocused()
	await expectPageKeys(page, choice, { space: false, homeEnd: false })
	await expect(pane.getByRole('radio', { checked: true })).toHaveCount(0)
	const previous = pane.getByRole('button', { name: 'Previous item' })
	await previous.focus()
	await expectPageKeys(page, previous)
})

test('a turn a few px past the locked pane height, every line in view, still steps with ↑ ↓ and shows no scroll hint', async ({
	page,
}) => {
	// `crowded` 4/5 fixes the pane's height; 5/5 is a little taller, so only the body's bottom padding
	// is cut off: there is nothing to read below, and ↑ must not turn into a 3px scroll.
	await openHarness(page)
	await emitScenario(page, 'crowded')
	await terminal(page).focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await row(page).locator('.agent-dock-entry[aria-label^="Turn ended"]').first().focus()
	await page.keyboard.press('Enter')
	const pane = paneOf(page)
	await expect(pane).toBeFocused()
	await expect(pane.locator('.agent-dock-step-count')).toContainText('4/5')
	await page.keyboard.press('ArrowDown')
	await expect(pane.locator('.agent-dock-step-count')).toContainText('5/5')
	const clip = await bodyOf(page).evaluate(node => {
		const bottom = node.getBoundingClientRect().bottom
		const content = Math.max(...[...node.querySelectorAll('*')].map(child => child.getBoundingClientRect().bottom))
		return { clipped: node.scrollHeight - node.clientHeight, inView: content <= bottom + 1 }
	})
	// The case under test: the body scrolls by a few px, yet every line is in view.
	expect(clip.clipped).toBeGreaterThan(1)
	expect(clip.inView).toBe(true)
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText(/^⌘↵ send\s*⌘⌫ ack\s*⌘O terminal\s*esc close$/)
	await page.keyboard.press('ArrowUp')
	await expect(pane.locator('.agent-dock-step-count')).toContainText('4/5')
	await expect(pane).toBeFocused()
})
