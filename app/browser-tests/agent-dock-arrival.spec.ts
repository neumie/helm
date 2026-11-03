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

test('an arriving item flashes once in its kind color, never on the first snapshot, and the flash ends', async ({
	page,
}) => {
	await page.clock.install()
	await open(page, 'f-1-tinted-cell')
	// The first snapshot is the baseline: none of its three items flashes.
	await expect(flashing(page)).toHaveCount(0)

	await page.clock.runFor(1_100)
	await expect(entries(page)).toHaveCount(4)
	const arrived = page.locator('#agent-dock .agent-dock-entry[data-arrival="question"]')
	await expect(arrived).toHaveCount(1)
	await expect(arrived).toHaveAttribute('aria-label', /^Question, invoice-reminders/)
	await expect(flashing(page)).toHaveCount(1)
	expect(await animationName(page)).toBe('agent-dock-arrival-fill')
	// The flash takes no focus and no room: the row stays one 28px line.
	expect(await page.evaluate(() => document.activeElement?.closest('#agent-dock') ?? null)).toBeNull()
	expect((await page.locator('#agent-dock .agent-dock-row').boundingBox())?.height).toBe(28)

	await page.clock.runFor(ARRIVAL_FLASH_MS + 100)
	await expect(flashing(page)).toHaveCount(0)
	await expect(entries(page)).toHaveCount(4)

	// Ticking re-renders never bring it back; the next arrival flashes alone, in its own kind.
	await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.emitArrival('turn'))
	await expect(page.locator('#agent-dock .agent-dock-row [data-arrival="turn"]')).toHaveCount(1)
	await page.clock.runFor(ARRIVAL_FLASH_MS + 100)
	await expect(flashing(page)).toHaveCount(0)
})

test('each variant animates its own way; the F3 edge takes the most urgent arrival', async ({ page }) => {
	await page.clock.install()
	await open(page, 'f-2-glyph-name')
	await page.clock.runFor(1_100)
	await expect(flashing(page)).toHaveCount(1)
	expect(
		await flashing(page)
			.first()
			.evaluate(node => getComputedStyle(node.querySelector('.agent-dock-entry-name') as Element).animationName),
	).toBe('agent-dock-arrival-text')

	await open(page, 'f-3-edge-pulse')
	const edge = () => page.locator('#agent-dock').evaluate(node => getComputedStyle(node, '::before').animationName)
	expect(await edge()).toBe('none')
	await page.clock.runFor(1_100)
	expect(await edge()).toBe('agent-dock-arrival-edge-warn')
	await page.clock.runFor(ARRIVAL_FLASH_MS + 100)
	expect(await edge()).toBe('none')
	// A turn alone pulses the edge --accent; a question arriving while it still flashes takes the edge (--warn).
	const arrive = (kind: 'question' | 'turn') =>
		page.evaluate(next => window.__helmWorkspaceFixture?.agentDock?.emitArrival(next), kind)
	await arrive('turn')
	await expect(flashing(page)).toHaveCount(1)
	expect(await edge()).toBe('agent-dock-arrival-edge-accent')
	await arrive('question')
	await expect(flashing(page)).toHaveCount(2)
	await expect(page.locator('#agent-dock .agent-dock-row [data-arrival="turn"]')).toHaveCount(1)
	expect(await edge()).toBe('agent-dock-arrival-edge-warn')
})

test('reduced motion: no animation, a static tint while the arrival is fresh', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.clock.install()
	await open(page, 'f-1-tinted-cell')
	await page.clock.runFor(1_100)
	await expect(flashing(page)).toHaveCount(1)
	expect(await animationName(page)).toBe('none')
	const tint = await flashing(page)
		.first()
		.evaluate(node => getComputedStyle(node).backgroundColor)
	expect(tint).not.toBe('rgba(0, 0, 0, 0)')
	await page.clock.runFor(ARRIVAL_FLASH_MS + 100)
	await expect(flashing(page)).toHaveCount(0)
})
