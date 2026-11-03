import { type Page, expect, test } from '@playwright/test'
import { ARRIVAL_FLASH_MS } from '../src/renderer/agent-dock/use-arrival-flash'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
	}
}

// Jakub's real day, then a new agent's question arrives 1s after the terminal is ready.
const story = (id: string) => `/iframe.html?id=views-agent-dock-arrival--${id}&viewMode=story`

async function open(page: Page, id: string): Promise<void> {
	await page.goto(story(id))
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#agent-dock .agent-dock-entry')).toHaveCount(3)
}

const entries = (page: Page) => page.locator('#agent-dock .agent-dock-row .agent-dock-entry')
const flashing = (page: Page) => page.locator('#agent-dock .agent-dock-row [data-arrival]')
const animationName = (page: Page) =>
	flashing(page)
		.first()
		.evaluate(node => getComputedStyle(node).animationName)
/** The dock's terminal-side edge (`.agent-dock::before`). */
const edge = (page: Page) => page.locator('#agent-dock').evaluate(node => getComputedStyle(node, '::before'))
const edgeAnimation = (page: Page) =>
	page.locator('#agent-dock').evaluate(node => getComputedStyle(node, '::before').animationName)
const edgeColor = (page: Page) =>
	page.locator('#agent-dock').evaluate(node => getComputedStyle(node, '::before').backgroundColor)
/** A token resolved to the computed color the edge would show for it. */
const token = (page: Page, name: string) =>
	page.locator('#agent-dock').evaluate((dock, value) => {
		const probe = document.createElement('span')
		probe.style.backgroundColor = `var(${value})`
		dock.append(probe)
		const color = getComputedStyle(probe).backgroundColor
		probe.remove()
		return color
	}, name)
const arrive = (page: Page, kind: 'question' | 'turn') =>
	page.evaluate(next => window.__helmWorkspaceFixture?.agentDock?.emitArrival(next), kind)

test('an arriving item pulses the edge and tints its cell once, never on the first snapshot, and the flash ends', async ({
	page,
}) => {
	await page.clock.install()
	await open(page, 'question')
	// The first snapshot is the baseline: none of its three items flashes.
	await expect(flashing(page)).toHaveCount(0)
	expect(await edgeAnimation(page)).toBe('none')
	const rowHeight = (await page.locator('#agent-dock .agent-dock-row').boundingBox())?.height
	const dockBox = await page.locator('#agent-dock').boundingBox()

	await page.clock.runFor(1_100)
	await expect(entries(page)).toHaveCount(4)
	const arrived = page.locator('#agent-dock .agent-dock-entry[data-arrival="question"]')
	await expect(arrived).toHaveCount(1)
	await expect(arrived).toHaveAttribute('aria-label', /^Question, invoice-reminders/)
	await expect(flashing(page)).toHaveCount(1)
	expect(await animationName(page)).toBe('agent-dock-arrival-fill')
	expect(await edgeAnimation(page)).toBe('agent-dock-arrival-edge-warn')
	// The flash takes no focus and no room: the row stays one 28px line, the dock where it was.
	expect(await page.evaluate(() => document.activeElement?.closest('#agent-dock') ?? null)).toBeNull()
	expect(rowHeight).toBe(28)
	expect((await page.locator('#agent-dock .agent-dock-row').boundingBox())?.height).toBe(28)
	expect(await page.locator('#agent-dock').boundingBox()).toEqual(dockBox)
	expect((await edge(page)).height).toBe('1px')

	await page.clock.runFor(ARRIVAL_FLASH_MS + 100)
	await expect(flashing(page)).toHaveCount(0)
	expect(await edgeAnimation(page)).toBe('none')
	await expect(entries(page)).toHaveCount(4)

	// Ticking re-renders never bring it back; the next arrival flashes alone, in its own kind.
	await arrive(page, 'turn')
	await expect(page.locator('#agent-dock .agent-dock-row [data-arrival="turn"]')).toHaveCount(1)
	await page.clock.runFor(ARRIVAL_FLASH_MS + 100)
	await expect(flashing(page)).toHaveCount(0)
})

test('the edge takes the most urgent arrival: a turn --accent, a question arriving over it --warn', async ({
	page,
}) => {
	await page.clock.install()
	await open(page, 'turn')
	await page.clock.runFor(1_100)
	await expect(page.locator('#agent-dock .agent-dock-row [data-arrival="turn"]')).toHaveCount(1)
	expect(await edgeAnimation(page)).toBe('agent-dock-arrival-edge-accent')
	await arrive(page, 'question')
	await expect(flashing(page)).toHaveCount(2)
	expect(await edgeAnimation(page)).toBe('agent-dock-arrival-edge-warn')
	await page.clock.runFor(ARRIVAL_FLASH_MS + 100)
	await expect(flashing(page)).toHaveCount(0)
	expect(await edgeAnimation(page)).toBe('none')
})

test('the pulse wins over the focus edge while it runs, then the edge is the focus edge again', async ({ page }) => {
	await page.clock.install()
	await open(page, 'question')
	const accent = await token(page, '--accent')
	const hairline = await token(page, '--hairline')
	await expect.poll(() => edgeColor(page)).toBe(hairline)
	// The dock holds the keys: the edge is --accent.
	await entries(page).first().focus()
	await expect.poll(() => edgeColor(page)).toBe(accent)

	await page.clock.runFor(1_100)
	await expect(flashing(page)).toHaveCount(1)
	expect(await edgeAnimation(page)).toBe('agent-dock-arrival-edge-warn')
	// Focus stays where it was.
	await expect(entries(page).first()).toBeFocused()

	await page.clock.runFor(ARRIVAL_FLASH_MS + 100)
	await expect(flashing(page)).toHaveCount(0)
	expect(await edgeAnimation(page)).toBe('none')
	await expect.poll(() => edgeColor(page)).toBe(accent)
})

test('reduced motion: no animation, the edge and tint hold statically while the arrival is fresh', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.clock.install()
	await open(page, 'question')
	const warn = await token(page, '--warn')
	const accent = await token(page, '--accent')
	await entries(page).first().focus()
	await expect.poll(() => edgeColor(page)).toBe(accent)

	await page.clock.runFor(1_100)
	await expect(flashing(page)).toHaveCount(1)
	expect(await animationName(page)).toBe('none')
	expect(await edgeAnimation(page)).toBe('none')
	const tint = await flashing(page)
		.first()
		.evaluate(node => getComputedStyle(node).backgroundColor)
	expect(tint).not.toBe('rgba(0, 0, 0, 0)')
	// Static, it still outranks the focus edge.
	await expect.poll(() => edgeColor(page)).toBe(warn)

	await page.clock.runFor(ARRIVAL_FLASH_MS + 100)
	await expect(flashing(page)).toHaveCount(0)
	await expect.poll(() => edgeColor(page)).toBe(accent)
})
