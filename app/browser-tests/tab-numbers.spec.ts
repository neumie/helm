import { type Page, expect, test } from '@playwright/test'

const story = (id: string) => `/iframe.html?id=views-tab-numbers--${id}&viewMode=story`

async function open(page: Page, id: string) {
	await page.goto(story(id))
	await expect(page.locator('#tabs .tab.active .tab-label')).toHaveText('active shell')
}
const active = (page: Page) => page.locator('#tabs .tab.active .tab-label')
const tab = (page: Page, name: string) => page.locator('#tabs .tab', { has: page.getByText(name, { exact: true }) })
const digit = (page: Page, name: string) => tab(page, name).locator('.tab-number')
const buildHeader = (page: Page) => page.locator('#tabs .tab-group-toggle', { hasText: 'Build' })

test('Build collapsed: only visible tabs are numbered and ⌘N matches the shown digit', async ({ page }) => {
	await open(page, 'build-collapsed')
	const visible = page.locator('#tabs .tab:visible')
	await expect(visible.locator('.tab-number')).toHaveText(['1', '2', '3', '4', '5', '6', '7', '8'])
	// Members of collapsed folders take no number, and folder headers never show one.
	await expect(digit(page, 'compile')).toHaveCount(0)
	await expect(digit(page, 'tests')).toHaveCount(0)
	await expect(digit(page, 'release logs')).toHaveCount(0)
	await expect(page.locator('#tabs .tab-group-toggle .tab-number')).toHaveCount(0)
	// The digit is a dim 11px mono hint, hidden from assistive tech (the shortcut is not the tab's name).
	await expect(digit(page, 'dev server')).toHaveCSS('font-size', '11px')
	await expect(digit(page, 'dev server')).toHaveAttribute('aria-hidden', 'true')
	await expect(page.getByRole('tab', { name: 'dev server', exact: true })).toHaveCount(1)

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

test('Build expanded: compile takes ⌘2 and ⌘9 is the ninth visible tab', async ({ page }) => {
	await open(page, 'build-expanded')
	await expect(digit(page, 'compile')).toHaveText('2')
	await expect(digit(page, 'dev server')).toHaveText('3')
	await expect(digit(page, 'scratch')).toHaveText('9')
	await page.keyboard.press('Meta+Digit2')
	await expect(active(page)).toHaveText('compile')
	await page.keyboard.press('Meta+Digit9')
	await expect(active(page)).toHaveText('scratch')
})

test('collapsing and expanding a folder renumbers the strip live', async ({ page }) => {
	await open(page, 'build-expanded')
	await expect(digit(page, 'dev server')).toHaveText('3')
	await buildHeader(page).click()
	await expect(buildHeader(page)).toHaveAttribute('aria-expanded', 'false')
	await expect(digit(page, 'compile')).toHaveCount(0)
	await expect(digit(page, 'dev server')).toHaveText('2')
	await expect(digit(page, 'scratch')).toHaveText('8')
	await page.keyboard.press('Meta+Digit2')
	await expect(active(page)).toHaveText('dev server')

	const review = page.locator('#tabs .tab-group-toggle', { hasText: 'Review' })
	await review.click()
	await expect(review).toHaveAttribute('aria-expanded', 'true')
	await expect(digit(page, 'tests')).toHaveText('3')
	await expect(digit(page, 'release logs')).toHaveText('4')
	await expect(digit(page, 'api')).toHaveText('5')
	// Past nine visible tabs, the rest carry no digit.
	await expect(digit(page, 'scratch')).toHaveCount(0)
	await page.keyboard.press('Meta+Digit4')
	await expect(active(page)).toHaveText('release logs')
})
