import { expect, test } from '@playwright/test'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'
import { openRemoteDestination } from './remote-navigation.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
	}
}
const path = '/iframe.html?id=views-helm-remote--browser-harness&viewMode=story'

test('Forward never adopts a replacement owner and does not strand the next Back', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.getByLabel('Message', { exact: true }).fill('Old owner only')
	await page.goBack()
	await page.evaluate(() => {
		window.__remoteFixture?.replaceOwner()
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	await expect
		.poll(() => page.locator('.remote-session-row').first().getAttribute('data-session-key'))
		.not.toContain('20000000-0000-4000-8000-000000000001')
	await page.goForward()
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
	await openRemoteDestination(page, 'Sessions')
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
})

test('focusable unavailable shared buttons cannot submit forms', async ({ page }) => {
	await page.goto('/iframe.html?id=primitives-button--form-submission&viewMode=story')
	const unavailable = page.getByRole('button', { name: 'Unavailable action' })
	await unavailable.focus()
	await expect(unavailable).toBeFocused()
	await unavailable.press('Enter')
	await expect(page.getByText('Submissions: 0', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Submit form' }).click()
	await expect(page.getByText('Submissions: 1', { exact: true })).toBeVisible()
})

test('Forward restores the same live identity and repeated Sessions activation cannot leave the workspace', async ({
	page,
}) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.getByLabel('Message', { exact: true }).fill('Retained through Forward')
	await page.goBack()
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	await page.goForward()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Retained through Forward')
	await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
	await page
		.getByRole('dialog', { name: 'Navigation' })
		.getByRole('button', { name: 'Sessions' })
		.evaluate(button => {
			button.click()
			button.click()
		})
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	await expect(page).toHaveURL(/views-helm-remote--browser-harness/)
})

test('same-task keyboard events admit only one command before the next render', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const message = page.getByLabel('Message', { exact: true })
	await message.fill('Exactly one admission')
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
	await message.evaluate(node => {
		for (let index = 0; index < 2; index++) {
			node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
		}
	})
	await expect.poll(() => page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(1)
})
