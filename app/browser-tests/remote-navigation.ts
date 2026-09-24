import type { Page } from '@playwright/test'

export async function openRemoteDestination(page: Page, destination: 'Sessions' | 'Usage'): Promise<void> {
	await page.locator('.remote-navigation-trigger:visible').click()
	const navigation = page.getByRole('dialog', { name: 'Navigation' })
	await navigation.getByRole('button', { name: destination, exact: true }).click()
}
