import { expect, test } from '@playwright/test'

test('item detail keeps exact provider knowledge evidence collapsed and read-only', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--item-detail&viewMode=story')

	const heading = page.getByRole('heading', { name: 'Knowledge used' })
	await expect(heading).toBeVisible({ timeout: 15_000 })
	const disclosure = heading.locator('xpath=ancestor::section[1]')
	await expect(disclosure.getByText('1 source · solve 1')).toBeVisible()
	await expect(disclosure.getByText(/Background terminals retain process ownership/)).toHaveCount(0)
	await disclosure.getByRole('button', { name: 'Show' }).click()
	await expect(disclosure.getByText(/Background terminals retain process ownership/)).toBeVisible()
	await expect(disclosure.getByRole('button', { name: 'Hide' })).toBeVisible()
	await expect(disclosure.getByRole('button', { name: 'Recover delivery' })).toBeVisible()
	await expect(disclosure.getByRole('button', { name: 'Retry delivery' })).toBeVisible()
	await expect(disclosure.getByText(/1 candidate · not queued/)).toBeVisible()
	await expect(disclosure.getByText(/2 candidates · blocked/)).toBeVisible()
	await expect(disclosure.getByRole('button')).toHaveCount(3)
})

test('profile editor owns explicit project knowledge mappings', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--profile-knowledge&viewMode=story')

	await expect(page.getByText('Project knowledge')).toBeVisible({ timeout: 15_000 })
	await expect(page.getByLabel('personal', { exact: true })).toHaveValue('local-hold')
	await expect(page.getByLabel('personal provider project ID')).toHaveValue('prj_personal')
	await expect(page.getByLabel('personal knowledge character budget')).toHaveValue('20000')
	await expect(page.getByRole('switch', { name: 'Allow personal knowledge sharing' })).toHaveAttribute(
		'aria-checked',
		'false',
	)
})
