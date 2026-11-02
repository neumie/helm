import { type Page, expect, test } from '@playwright/test'

const story = (id: string, args = '') =>
	`/iframe.html?id=views-tab-numbers--${id}&viewMode=story${args ? `&args=${args}` : ''}`

async function open(page: Page, id: string, args = '') {
	await page.goto(story(id, args))
	await expect(page.locator('#tabs .tab.active .tab-label')).toHaveText('active shell')
}
const active = (page: Page) => page.locator('#tabs .tab.active .tab-label')
const buildHeader = (page: Page) => page.locator('#tabs .tab-group-toggle', { hasText: 'Build' })

test('today: ⌘2 opens compile while Build stays collapsed (the reported confusion)', async ({ page }) => {
	await open(page, 'today')
	await page.keyboard.press('Meta+Digit2')
	await expect(active(page)).toHaveText('compile')
	await expect(buildHeader(page)).toHaveAttribute('aria-expanded', 'false')
	await expect(page.locator('#tabs .tab', { hasText: 'compile' })).toBeHidden()
})

test('B1 skip-collapsed: ⌘N only reaches visible tabs and matches the shown digit', async ({ page }) => {
	await open(page, 'n-1-b-1')
	await expect(page.locator('#tabs .tab', { hasText: 'dev server' }).locator('.tab-number')).toHaveText('2')
	await page.keyboard.press('Meta+Digit2')
	await expect(active(page)).toHaveText('dev server')
	await expect(buildHeader(page)).toHaveAttribute('aria-expanded', 'false')
	await page.keyboard.press('Meta+Digit8')
	await expect(active(page)).toHaveText('scratch')
	// Nothing holds slot 9 with eight visible tabs.
	await page.keyboard.press('Meta+Digit9')
	await expect(active(page)).toHaveText('scratch')
	// The story's ⌥ stand-in reaches the same handler (browsers keep ⌘1–⌘9).
	await page.keyboard.press('Alt+Digit3')
	await expect(active(page)).toHaveText('api')
})

test('B2 folder-slot: a collapsed folder is one number that expands it and opens its last tab', async ({ page }) => {
	await open(page, 'n-1-b-2')
	await expect(buildHeader(page).locator('.tab-number')).toHaveText('2')
	await expect(page.locator('#tabs .tab', { hasText: 'dev server' }).locator('.tab-number')).toHaveText('3')
	await page.keyboard.press('Meta+Digit2')
	await expect(active(page)).toHaveText('compile')
	await expect(buildHeader(page)).toHaveAttribute('aria-expanded', 'true')
	await expect(page.locator('#tabs .tab', { hasText: 'compile' }).locator('.tab-number')).toHaveText('2')
	// Expanded Build header keeps an empty digit column, so its name never shifts.
	await expect(buildHeader(page).locator('.tab-number')).toHaveText('')
	// Review stays one slot and reopens its first member when none was active.
	await page.keyboard.press('Meta+Digit4')
	await expect(active(page)).toHaveText('tests')
	const review = page.locator('#tabs .tab-group-toggle', { hasText: 'Review' })
	await expect(review).toHaveAttribute('aria-expanded', 'true')
	// The slot remembers the member last shown, not merely the first one.
	await page.locator('#tabs .tab', { hasText: 'release logs' }).click()
	await expect(active(page)).toHaveText('release logs')
	await review.click()
	await expect(review).toHaveAttribute('aria-expanded', 'false')
	await expect(review.locator('.tab-number')).toHaveText('4')
	await page.keyboard.press('Meta+Digit1')
	await page.keyboard.press('Meta+Digit4')
	await expect(active(page)).toHaveText('release logs')
	await expect(review).toHaveAttribute('aria-expanded', 'true')
})

test('N2 hold: badges appear only after ⌘ is held alone, and leave on release', async ({ page }) => {
	await open(page, 'n-2-b-1')
	const strip = page.locator('#tabs')
	await expect(strip).not.toHaveClass(/tab-numbers-held/)
	await page.keyboard.down('Meta')
	await expect(strip).toHaveClass(/tab-numbers-held/)
	await expect(page.locator('#tabs .tab', { hasText: 'dev server' }).locator('.tab-number')).toHaveCSS('opacity', '1')
	await page.keyboard.up('Meta')
	await expect(strip).not.toHaveClass(/tab-numbers-held/)
	// A quick chord (⌘C) never flashes the badges.
	await page.keyboard.down('Meta')
	await page.keyboard.press('KeyC')
	await page.waitForTimeout(400)
	await expect(strip).not.toHaveClass(/tab-numbers-held/)
	await page.keyboard.up('Meta')
})

test('N3 trailing: the hint is the live ⌘N binding', async ({ page }) => {
	await open(page, 'n-3-b-2')
	await expect(page.locator('#tabs .tab.active .tab-number')).toHaveText('⌘1')
	await expect(buildHeader(page).locator('.tab-number')).toHaveText('⌘2')
	await page.keyboard.press('Meta+Digit3')
	await expect(active(page)).toHaveText('dev server')
})
