import { type Page, expect, test } from '@playwright/test'
import type { SignalsFixture } from '../src/renderer/signals/signals-fixtures'

declare global {
	interface Window {
		__signalsFixture?: SignalsFixture
	}
}

// An agent row's detail panel in the Signals column (design §3.25), on the production column with the
// in-memory fixture services: a click (or ↵) opens it, a second click or Esc closes it; it shows the
// whole body, who filed it and its agent, clickable links (main opens them) and, for an ask, quick
// answers and an answer field sent through the same reply path. It slides over the terminals beside
// the column (Jakub's pick 2026-11-18).

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`

async function open(page: Page, id: string) {
	await page.setViewportSize({ width: 1400, height: 820 })
	await page.goto(story(id))
	const signals = page.locator('section.signals')
	await expect(signals).toBeVisible()
	await expect.poll(() => page.evaluate(() => Boolean(window.__signalsFixture))).toBe(true)
	return {
		signals,
		row: (id: number) => signals.locator(`.signals-tr[data-signal-id="${id}"]`),
		detail: page.locator('.signals-detail'),
	}
}

const calls = (page: Page) => page.evaluate(() => window.__signalsFixture?.calls)

test('slide-over: a click opens the detail over the terminals, a second click and Esc close it', async ({ page }) => {
	const view = await open(page, 'views-signals-detail--click-a-row')
	const terms = await page.locator('#terms').boundingBox()
	const column = await view.signals.boundingBox()
	await view.row(505).click()
	await expect(view.detail).toBeVisible()
	await expect(view.detail).toHaveAttribute('data-layout', 'slide-over')
	await expect(view.row(505)).toHaveAttribute('data-open', 'true')
	await expect(view.detail.locator('.signals-title-kind')).toHaveText('?Ask from dispatcher')
	await expect(view.detail.locator('.signals-ask-body')).toContainText('Doporučuju Ano.')
	// Who filed it and the agent in its terminal, as the dock names it.
	const facts = view.detail.locator('.signals-detail-facts li')
	await expect(facts.nth(0)).toHaveText('Asked by dispatcher · Okena terminal')
	await expect(facts.nth(1)).toHaveText(
		'signals-agent-asks · idle · helm · feat/signals-agent-asks · Okena terminal 5d3f8a2e',
	)
	await expect(view.detail.locator('a')).toHaveCount(0)
	// Over the terminals: the column keeps its width and the terminal area does not move.
	if (!terms || !column) throw new Error('not laid out')
	// (Once its 150 ms slide has settled.)
	await expect
		.poll(async () => (await view.detail.boundingBox())?.x ?? 0)
		.toBeGreaterThanOrEqual(column.x + column.width)
	expect(await view.signals.boundingBox()).toEqual(column)
	expect(await page.locator('#terms').boundingBox()).toEqual(terms)
	// Opening it marked the ask seen.
	await expect.poll(async () => (await calls(page))?.updates).toEqual([{ id: 505, patch: { state: 'seen' } }])
	await page.screenshot({ path: test.info().outputPath('signals-detail-slide-over.png') })
	// A second click on the same row closes it.
	await view.row(505).click()
	await expect(view.detail).toHaveCount(0)
	// ↵ opens it again, Esc closes it and the list keeps the keys.
	await page.keyboard.press('Enter')
	await expect(view.detail).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(view.detail).toHaveCount(0)
	await expect(view.signals).toBeFocused()
})

test('a quick answer sends that choice as the reply through the reply path', async ({ page }) => {
	const view = await open(page, 'views-signals-detail--ask')
	await expect(view.detail.locator('.signals-detail-choice')).toHaveText(['1 Ano', '2 Ne'])
	await view.signals.focus()
	await page.keyboard.press('1')
	await expect.poll(async () => (await calls(page))?.replies).toEqual([{ id: 505, text: 'Ano' }])
	const recorded = await calls(page)
	// Saved first, then typed into the idle asking agent as its next prompt, with the receipt saved.
	expect(recorded?.prompts).toHaveLength(1)
	expect(recorded?.prompts[0]?.text).toContain('Ano')
	await expect(view.detail.locator('.signals-note')).toHaveText('Replied to signals-agent-asks')
	await expect(view.row(505).locator('.signals-receipt')).toContainText('replied')
})

test('the answer field: r focuses it, digits type there, ⌘↵ sends it', async ({ page }) => {
	const view = await open(page, 'views-signals-detail--ask')
	await view.signals.focus()
	await page.keyboard.press('r')
	const field = view.detail.locator('.signals-answer-input')
	await expect(field).toBeFocused()
	await page.keyboard.type('Ano, ale 20 znaků')
	await page.keyboard.press('Meta+Enter')
	await expect.poll(async () => (await calls(page))?.replies).toEqual([{ id: 505, text: 'Ano, ale 20 znaků' }])
	await expect(field).toHaveValue('')
})

test('a link click asks main to open it (never an anchor)', async ({ page }) => {
	const view = await open(page, 'views-signals-detail--answer')
	// Another answer's row: the detail moves to it.
	await view.row(602).click()
	await expect(view.detail).toHaveAttribute('data-signal-id', '602')
	const links = view.detail.locator('.signals-detail-link')
	await expect(links).toHaveCount(1)
	await links.first().click()
	await expect
		.poll(async () => (await calls(page))?.openedLinks)
		.toEqual([
			{
				id: 602,
				index: 0,
				shown: 'https://github.com/neumie/helm/blob/main/AGENTS.md',
				url: 'https://github.com/neumie/helm/blob/main/AGENTS.md',
			},
		])
})

test('j/k move the list while the slide-over follows the selection', async ({ page }) => {
	const view = await open(page, 'views-signals-detail--ask')
	await expect(view.detail).toHaveAttribute('data-layout', 'slide-over')
	await expect(view.detail).toHaveAttribute('data-signal-id', '505')
	// The list stays beside it, with the column's own footer.
	await expect(view.row(505)).toHaveAttribute('data-open', 'true')
	await expect(view.signals.locator(':scope > .signals-foot')).toBeVisible()
	await view.signals.focus()
	await page.keyboard.press('j')
	await expect(view.detail).toHaveAttribute('data-signal-id', '506')
	await expect(view.row(506)).toHaveAttribute('data-selected', 'true')
	await expect(view.detail.locator('.signals-detail-facts li').nth(1)).toHaveText(
		'Okena terminal 0f4e9a12 · not in the dock',
	)
	await page.keyboard.press('k')
	await expect(view.detail).toHaveAttribute('data-signal-id', '505')
	await page.keyboard.press('Escape')
	await expect(view.detail).toHaveCount(0)
	await expect(view.row(505)).toHaveAttribute('data-selected', 'true')
})
