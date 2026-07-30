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

test('agent integrations require an explicit Pi status installation', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--agent-integrations&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Agent integrations', exact: true })).toBeVisible()
	await expect(page.getByText('Not installed', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Install' }).click()
	await expect(page.getByText('Installed', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Remove integration' })).toBeVisible()
})
