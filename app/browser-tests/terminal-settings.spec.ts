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

test('agent integrations direct package setup without installing files', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--agent-integrations&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Agent integrations', exact: true })).toBeVisible()
	await expect(page.getByText('Not configured', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'View setup' }).click()
	await expect
		.poll(() =>
			page.evaluate(() => (window as typeof window & { __openedExternalUrls?: string[] }).__openedExternalUrls),
		)
		.toEqual(['https://github.com/neumie/pi-agent-status#installation'])
	await expect(page.getByRole('button', { name: 'Install' })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Remove integration' })).toHaveCount(0)
})

test('externally managed Pi status packages expose no Helm mutation controls', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--agent-integrations-external&viewMode=story')
	await expect(page.getByText('Managed by Pi', { exact: true })).toBeVisible()
	await expect(page.getByText('Precise Pi terminal status is managed by a Pi package.')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Install' })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Remove integration' })).toHaveCount(0)
})
