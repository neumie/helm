import { type Page, expect, test } from '@playwright/test'
import type { SignalsFixture } from '../src/renderer/signals/signals-fixtures'

declare global {
	interface Window {
		__signalsFixture?: SignalsFixture
	}
}

// Agent answers in the Signals column (design §3.25), on the production column with the in-memory
// fixture services: an answer reads differently from an ask (↳, no `r`, never counted in Needs you),
// `↵` reads it in full and marks it seen, `d` closes it (Done today: `read`). The four placement
// variants are review-only (`answerLayout`) until Jakub picks one.

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

test('A: answers sit on their own band under Needs you, read as ↳ with no reply', async ({ page }) => {
	const view = await open(page, 'views-signals-answers--answers-band')
	const answers = view.section('Answers')
	await expect(answers).toBeVisible()
	await expect(answers.locator('.signals-band-count')).toHaveText('3')
	// New answers light the band mark in the accent, not the warn of waiting.
	await expect(answers.locator('.signals-braille-mark')).toHaveAttribute('data-tone', 'info')
	const answer = view.row(601)
	await expect(answer).toHaveAttribute('data-section', 'answers')
	await expect(answer.locator('.signals-glyph')).toHaveText('↳')
	await expect(answer.locator('.signals-glyph')).toHaveAttribute('data-kind', 'answer')
	await expect(answer.locator('.signals-td-ref')).toHaveText('dispatcher')
	await expect(answer.locator('.signals-td-what')).toHaveText('Proxy blokuje Remote')
	// Bands in order: Needs you, Answers, Managed.
	const bands = await view.signals.locator('.signals-band-label').allTextContents()
	expect(bands.slice(0, 3)).toEqual(['Needs you', 'Answers', 'Managed'])
	// Needs you does not list (or count) answers.
	await expect(view.section('Needs you').locator('.signals-tr[data-signal-id="601"]')).toHaveCount(0)
	await answer.click()
	const hints = view.signals.locator('.signals-foot-hints')
	await expect(hints).toContainText('↵ read')
	await expect(hints).toContainText('d done')
	await expect(hints).not.toContainText('reply')
	// r does nothing on an answer: no reply flow opens.
	await page.keyboard.press('r')
	await expect(page.locator('.signals-answer-input')).toHaveCount(0)
	expect((await calls(page))?.replies).toEqual([])
	await page.screenshot({ path: test.info().outputPath('signals-answers-a-band.png') })
})

test('↵ reads the whole answer, marks it seen; d closes it and Done today says read', async ({ page }) => {
	const view = await open(page, 'views-signals-answers--answers-band')
	await view.row(601).click()
	await page.keyboard.press('Enter')
	const flow = page.locator('.signals-flow-keys[data-flow="read"]')
	await expect(flow).toBeVisible()
	await expect(flow.locator('.signals-title-kind')).toHaveText('↳Answer from dispatcher')
	await expect(flow.locator('.signals-ask-body')).toContainText('Nic dalšího po tobě nechci')
	await expect(flow.locator('a')).toHaveCount(0)
	await expect.poll(async () => (await calls(page))?.updates).toEqual([{ id: 601, patch: { state: 'seen' } }])
	await page.screenshot({ path: test.info().outputPath('signals-answers-read.png') })
	// Esc goes back without closing it (layout A); it is still listed, now seen.
	await page.keyboard.press('Escape')
	await expect(flow).toHaveCount(0)
	await expect(view.row(601).locator('.signals-glyph')).not.toHaveAttribute('data-kind', 'answer')
	await page.keyboard.press('d')
	await expect(view.row(601)).toHaveCount(0)
	await expect(view.note).toHaveText('Closed the answer from dispatcher')
	await page.keyboard.press('Shift+D')
	const done = page.locator('.signals-flow-keys')
	await expect(done.locator('.signals-tr[data-signal-id="601"] .signals-done-reason')).toHaveText(' · read')
	await expect(done.locator('.signals-tr[data-signal-id="604"] .signals-done-reason')).toHaveText(' · read')
})

test('B: answers stay in Needs you, marked only by ↳, and the band counts only what waits', async ({ page }) => {
	const view = await open(page, 'views-signals-answers--in-needs-you')
	await expect(view.section('Answers')).toHaveCount(0)
	const needs = view.section('Needs you')
	await expect(needs.locator('.signals-tr[data-signal-id="601"]')).toBeVisible()
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
	await page.screenshot({ path: test.info().outputPath('signals-answers-b-needs.png') })
})

test('C: an answer reads in the list, six lines, then says there is more', async ({ page }) => {
	const view = await open(page, 'views-signals-answers--read-in-the-list')
	const body = view.row(601).locator('.signals-td-answer')
	await expect(body).toContainText('Remote z telefonu nejde')
	await expect(body.locator('.signals-td-answer-more')).toHaveText('… ↵ read all')
	await expect(body).not.toContainText('Nic dalšího po tobě nechci')
	await expect(view.row(602).locator('.signals-td-answer-more')).toHaveText('1 link')
	await page.screenshot({ path: test.info().outputPath('signals-answers-c-inline.png') })
})

test('D: leaving the Read flow closes the answer as read', async ({ page }) => {
	const view = await open(page, 'views-signals-answers--reading-closes-it')
	await view.row(601).click()
	await page.keyboard.press('Enter')
	const flow = page.locator('.signals-flow-keys[data-flow="read"]')
	await expect(flow.locator('.signals-note')).toHaveText('Going back closes it as read')
	await page.keyboard.press('Escape')
	await expect(flow).toHaveCount(0)
	await expect(view.row(601)).toHaveCount(0)
	await expect(view.signals).toBeFocused()
	const updates = (await calls(page))?.updates
	expect(updates).toEqual([
		{ id: 601, patch: { state: 'seen' } },
		{ id: 601, patch: { state: 'done' } },
	])
	// The next answer is selected.
	await expect(view.row(602)).toHaveAttribute('data-selected', 'true')
})
