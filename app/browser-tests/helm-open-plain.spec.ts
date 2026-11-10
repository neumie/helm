// helm open S1: a plain window shows the file read-only, with no conversation, comments or selection feedback, and
// zooms its reading area. Production DocumentReview over the Views/Document review/Plain viewing display fixture.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function open(page: Page) {
	await page.setViewportSize({ width: 1180, height: 800 })
	await page.goto('/iframe.html?id=views-document-review--plain-viewing&viewMode=story')
	await expect(page.getByRole('heading', { name: 'notes.md', exact: true })).toBeVisible({ timeout: 20000 })
}
const zoom = (page: Page, step: -1 | 0 | 1) =>
	page.evaluate(value => {
		const proof = (window as unknown as { __helmDocumentReviewProof?: { zoom(step: -1 | 0 | 1): void } })
			.__helmDocumentReviewProof
		if (!proof) throw new Error('Plain viewing fixture is not mounted')
		proof.zoom(value)
	}, step)
const proseSize = (page: Page) =>
	page.locator('.review-prose').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))

test('a plain window has no conversation, no divider and no Comments view, and the document fills the width', async ({
	page,
}) => {
	await open(page)
	await expect(page.locator('.review-companion')).toBeHidden()
	await expect(page.getByRole('separator', { name: 'Resize conversation pane' })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Conversation', exact: true })).toHaveCount(0)
	const pane = await page.locator('.review-document-pane').boundingBox()
	expect(pane?.width).toBeGreaterThan(1100)
	await page.getByRole('button', { name: 'Document options', exact: true }).click()
	await expect(page.getByRole('menuitemradio', { name: 'Read', exact: true })).toBeVisible()
	await expect(page.getByRole('menuitemradio', { name: 'Source', exact: true })).toBeVisible()
	await expect(page.getByRole('menuitemradio', { name: /^Comments/ })).toHaveCount(0)
	await page.getByRole('menuitemcheckbox', { name: 'Document details' }).click()
	const details = page.getByRole('region', { name: 'Document details' })
	await expect(details).toContainText('~/Downloads/notes.md')
	await expect(details).toContainText('run helm edit on this file')
	await expect(details.getByRole('button', { name: 'Clear empty saved preferences' })).toHaveCount(0)
})

test('selecting text in a plain window only selects it: no passage chat, no Use selection', async ({ page }) => {
	await open(page)
	const paragraph = page.locator('.review-prose p').first()
	const box = await paragraph.boundingBox()
	if (!box) throw new Error('No paragraph to select')
	await page.mouse.move(box.x + 2, box.y + 6)
	await page.mouse.down()
	await page.mouse.move(box.x + Math.min(box.width - 4, 260), box.y + 6, { steps: 8 })
	await page.mouse.up()
	expect((await page.evaluate(() => window.getSelection()?.toString() ?? '')).length).toBeGreaterThan(4)
	await expect(page.locator('.review-passage-bubble')).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Use selection' })).toHaveCount(0)
	await page.keyboard.press('Alt+Enter')
	await expect(page.locator('.review-passage-bubble')).toHaveCount(0)
})

test('⌘= / ⌘- / ⌘0 zoom the reading area in steps and reset it, leaving the header alone', async ({ page }) => {
	await open(page)
	const base = await proseSize(page)
	const header = await page
		.locator('.review-header h1')
		.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))
	await zoom(page, 1)
	await expect.poll(() => proseSize(page)).toBeCloseTo(base * 1.1, 1)
	await zoom(page, 1)
	await expect.poll(() => proseSize(page)).toBeCloseTo(base * 1.25, 1)
	await zoom(page, -1)
	await zoom(page, -1)
	await zoom(page, -1)
	await expect.poll(() => proseSize(page)).toBeCloseTo(base * 0.9, 1)
	await zoom(page, 0)
	await expect.poll(() => proseSize(page)).toBeCloseTo(base, 1)
	for (let step = 0; step < 12; step++) await zoom(page, 1)
	await expect.poll(() => proseSize(page)).toBeCloseTo(base * 2, 1)
	expect(
		await page.locator('.review-header h1').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize)),
	).toBe(header)
	await page.screenshot({ path: test.info().outputPath('plain-zoomed.png') })
})

test('the reading surface switches in a plain window without saving or marking anything unsaved', async ({ page }) => {
	await open(page)
	const theme = () => page.locator('main.document-review').getAttribute('data-review-theme')
	const first = await theme()
	await page.getByRole('button', { name: 'Document options', exact: true }).click()
	await page.getByRole('menuitem', { name: /reading surface$/ }).click()
	await expect.poll(theme).not.toBe(first)
	await page.waitForTimeout(500) // past the 300ms autosave debounce
	const stats = await page.evaluate(() =>
		(
			window as unknown as {
				__helmDocumentReviewProof?: { stats(): { saved: number; dirty: boolean } }
			}
		).__helmDocumentReviewProof?.stats(),
	)
	expect(stats?.saved).toBe(0)
	expect(stats?.dirty).toBe(false)
})
