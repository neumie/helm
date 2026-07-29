import { expect, test } from '@playwright/test'

test('terminal settings show the selected folder and reset new terminals to Home', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--terminal-settings&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible()
	await expect(page.getByText('/Users/you/Developer')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Choose folder' })).toBeVisible()

	await page.getByRole('button', { name: 'Use Home folder' }).click()
	await expect(page.getByText('/Users/you', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Use Home folder' })).toHaveCount(0)
})
