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

test('a click into a terminal closes the slide-over and the terminal takes the keys', async ({ page }) => {
	const view = await open(page, 'views-signals-detail--click-a-row')
	await view.row(505).click()
	await expect(view.detail).toBeVisible()
	// Presses inside the panel keep it open: its text, the answer field.
	await view.detail.locator('.signals-ask-body').click()
	await view.detail.locator('.signals-answer-input').click()
	await expect(view.detail).toBeVisible()
	await expect(view.detail.locator('.signals-answer-input')).toBeFocused()
	// Esc still closes it from inside the panel.
	await page.keyboard.press('Escape')
	await expect(view.detail).toHaveCount(0)
	await view.row(505).click()
	await expect(view.detail).toBeVisible()
	// A click on the terminal beside the panel: the panel closes, the clicked terminal has the focus.
	const terms = await page.locator('#terms').boundingBox()
	const panel = await view.detail.boundingBox()
	if (!terms || !panel) throw new Error('not laid out')
	await page.mouse.click(Math.round((panel.x + panel.width + terms.x + terms.width) / 2), Math.round(terms.y + 80))
	await expect(view.detail).toHaveCount(0)
	await expect(view.row(505)).not.toHaveAttribute('data-open', 'true')
	await expect
		.poll(() =>
			page.evaluate(() => {
				const active = document.activeElement
				return Boolean(active?.classList.contains('xterm-helper-textarea') && active.closest('#terms'))
			}),
		)
		.toBe(true)
	// And it stays there: nothing hands the keys back to the list afterwards.
	await page.waitForTimeout(100)
	await expect(view.signals).not.toBeFocused()
	expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false)).toBe(
		true,
	)
})

test('an unsent answer survives the panel closing on a terminal click', async ({ page }) => {
	const view = await open(page, 'views-signals-detail--click-a-row')
	await view.row(505).click()
	await view.detail.locator('.signals-answer-input').fill('Ano, ale až zítra')
	const terms = await page.locator('#terms').boundingBox()
	const panel = await view.detail.boundingBox()
	if (!terms || !panel) throw new Error('not laid out')
	await page.mouse.click(Math.round((panel.x + panel.width + terms.x + terms.width) / 2), Math.round(terms.y + 80))
	await expect(view.detail).toHaveCount(0)
	await view.row(505).click()
	await expect(view.detail.locator('.signals-answer-input')).toHaveValue('Ano, ale až zítra')
})

// D27 proposal variants (Proposals / D27 Quick answer feedback): the same production panel, a quick
// answer pressed by the story 1.5 s after load, the dock typing it in 0.7 s.
const d27 = (variant: string) => `proposals-d27-quick-answer-feedback-signals-detail--${variant}`

test('D27 A (picked): the sent answer stays pressed with a receipt line under the answers', async ({ page }) => {
	const view = await open(page, d27('picked'))
	await expect(view.detail.locator('.signals-detail-choice-sending')).toHaveText(/Ano/)
	await expect(view.detail.locator('.signals-detail-sent')).toHaveText(/Sending “Ano”/)
	await expect(view.detail.locator('.signals-detail-choice-sent')).toHaveText(/Ano/)
	await expect(view.detail.locator('.signals-detail-sent')).toHaveText(/Replied to .* · “Ano”/)
	// A second answer goes the same way.
	await page.keyboard.press('2')
	await expect(view.detail.locator('.signals-detail-choice-sent')).toHaveText(/Ne/)
})

test('D27 B (answered): the answers fold into the answer given; Answer again unfolds with the keys in the field', async ({
	page,
}) => {
	const view = await open(page, d27('answered'))
	const given = view.detail.locator('.signals-detail-given')
	await expect(given.locator('.signals-detail-given-receipt')).toHaveText(/Replied to/)
	await expect(given.locator('.signals-detail-given-text')).toHaveText('Ano')
	await expect(view.detail.locator('.signals-detail-choice')).toHaveCount(0)
	await expect(view.detail.locator('.signals-answer-input')).toHaveCount(0)
	await page.keyboard.press('r')
	await expect(view.detail.locator('.signals-answer-input')).toBeFocused()
	await expect(view.detail.locator('.signals-detail-choice')).toHaveCount(2)
	// A pointer press focuses that answer, which unmounts as it folds: the keys go to the folded answer.
	await view.detail.locator('.signals-detail-choice', { hasText: 'Ne' }).click()
	await expect(given.locator('.signals-detail-given-text')).toHaveText('Ne')
	await expect(given).toBeFocused()
	// ⌘↵ with the field folded away sends nothing.
	const before = (await calls(page))?.replies.length ?? 0
	await page.keyboard.press('Meta+Enter')
	await page.waitForTimeout(300)
	expect((await calls(page))?.replies.length ?? 0).toBe(before)
})

test('D27 C (flash): the pressed answer flashes once and a toast says where it went', async ({ page }) => {
	const view = await open(page, d27('flash'))
	await expect(view.detail.locator('.signals-detail-choice-flash')).toHaveText(/Ano/)
	await expect(page.locator('#toasts .toast')).toContainText('Replied to')
	await expect(view.detail.locator('.signals-detail-choice-flash')).toHaveCount(0)
	// The toast is outside the column but no press away from the panel.
	await page.locator('#toasts .toast').first().click()
	await expect(view.detail).toBeVisible()
})
