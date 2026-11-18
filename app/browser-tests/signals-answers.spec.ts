import { type Page, expect, test } from '@playwright/test'
import type { SignalsFixture } from '../src/renderer/signals/signals-fixtures'

declare global {
	interface Window {
		__signalsFixture?: SignalsFixture
	}
}

// Agent answers in the Signals column (design §3.25), on the production column with the in-memory
// fixture services: an answer reads differently from an ask (↳, no `r`, never counted in Needs you),
// `↵` (or a click) opens its detail and marks it seen, `d` closes it (Done today: `read`). Answers are
// listed in Needs you, set apart only by ↳ (Jakub's pick 2026-11-18).

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
		section: (label: string) => signals.locator(`section.signals-section[aria-label="${label}"]`),
		note: signals.locator('.signals-note'),
	}
}

const calls = (page: Page) => page.evaluate(() => window.__signalsFixture?.calls)

test('answers stay in Needs you, read as ↳ with no reply, and the band counts only what waits', async ({ page }) => {
	const view = await open(page, 'views-signals-answers--in-needs-you')
	// No band of their own.
	await expect(view.section('Answers')).toHaveCount(0)
	const needs = view.section('Needs you')
	const answer = needs.locator('.signals-tr[data-signal-id="601"]')
	await expect(answer).toBeVisible()
	await expect(answer).toHaveAttribute('data-section', 'needs')
	await expect(answer.locator('.signals-glyph')).toHaveText('↳')
	await expect(answer.locator('.signals-glyph')).toHaveAttribute('data-kind', 'answer')
	await expect(answer.locator('.signals-td-ref')).toHaveText('dispatcher')
	await expect(answer.locator('.signals-td-what')).toHaveText('Proxy blokuje Remote')
	// Three answers listed there, none counted: the count is the rows that wait on Jakub (no ↳, no receipt).
	const waiting = await needs
		.locator('.signals-tr')
		.evaluateAll(
			rows =>
				rows.filter(
					row => row.querySelector('.signals-glyph')?.textContent !== '↳' && !row.querySelector('.signals-receipt'),
				).length,
		)
	await expect(needs.locator('.signals-tr .signals-glyph', { hasText: '↳' })).toHaveCount(3)
	await expect(needs.locator('.signals-band-count')).toHaveText(String(waiting))
	await page.screenshot({ path: test.info().outputPath('signals-answers-needs.png') })
	await answer.click()
	// The click opens its detail; the column's own footer still says what the row offers.
	const hints = view.signals.locator(':scope > .signals-foot .signals-foot-hints')
	await expect(hints).toContainText('↵ read')
	await expect(hints).toContainText('d done')
	await expect(hints).not.toContainText('reply')
	// r does nothing on an answer: no reply flow opens.
	await page.keyboard.press('r')
	await expect(page.locator('.signals-answer-input')).toHaveCount(0)
	expect((await calls(page))?.replies).toEqual([])
})

test('↵ reads the whole answer, marks it seen; d closes it and Done today says read', async ({ page }) => {
	const view = await open(page, 'views-signals-answers--in-needs-you')
	await view.row(601).click()
	const flow = page.locator('.signals-detail')
	// The click already opened it; ↵ closes it and ↵ again opens it.
	await expect(flow).toBeVisible()
	await expect(flow).toHaveAttribute('data-layout', 'slide-over')
	await page.keyboard.press('Enter')
	await expect(flow).toHaveCount(0)
	await page.keyboard.press('Enter')
	await expect(flow).toBeVisible()
	await expect(flow.locator('.signals-title-kind')).toHaveText('↳Answer from dispatcher')
	await expect(flow.locator('.signals-ask-body')).toContainText('Nic dalšího po tobě nechci')
	await expect(flow.locator('.signals-note')).toHaveText('Close it once read')
	await expect(flow.locator('a')).toHaveCount(0)
	await expect.poll(async () => (await calls(page))?.updates).toEqual([{ id: 601, patch: { state: 'seen' } }])
	await page.screenshot({ path: test.info().outputPath('signals-answers-read.png') })
	// Esc goes back without closing it; it is still listed in Needs you, now seen.
	await page.keyboard.press('Escape')
	await expect(flow).toHaveCount(0)
	await expect(view.row(601)).toHaveAttribute('data-section', 'needs')
	await expect(view.row(601).locator('.signals-glyph')).not.toHaveAttribute('data-kind', 'answer')
	await page.keyboard.press('d')
	await expect(view.row(601)).toHaveCount(0)
	await expect(view.note).toHaveText('Closed the answer from dispatcher')
	await page.keyboard.press('Shift+D')
	const done = page.locator('.signals-flow-keys')
	await expect(done.locator('.signals-tr[data-signal-id="601"] .signals-done-reason')).toHaveText(' · read')
	await expect(done.locator('.signals-tr[data-signal-id="604"] .signals-done-reason')).toHaveText(' · read')
})

test('Done today: ↵ on a read answer shows it in place of that list, Esc goes back there', async ({ page }) => {
	await open(page, 'views-signals-answers--done-today')
	const done = page.locator('.signals-flow-keys')
	const row = done.locator('.signals-tr[data-signal-id="604"]')
	await expect(row.locator('.signals-done-reason')).toHaveText(' · read')
	await row.click()
	await page.keyboard.press('Enter')
	const detail = page.locator('.signals-detail')
	await expect(detail).toHaveAttribute('data-layout', 'in-place')
	await expect(detail).toHaveAttribute('data-signal-id', '604')
	await expect(detail).toBeFocused()
	await expect(detail.locator('.signals-note')).toHaveText('Read and closed')
	await expect(done).toHaveCount(0)
	await page.keyboard.press('Escape')
	await expect(detail).toHaveCount(0)
	await expect(page.locator('.signals-flow-keys .signals-tr[data-signal-id="604"]')).toBeVisible()
})
