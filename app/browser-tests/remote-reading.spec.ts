import { expect, test } from '@playwright/test'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'
declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
	}
}
const path = '/iframe.html?id=views-helm-remote--browser-harness&viewMode=story'
test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(path)
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await page.evaluate(() => window.__remoteFixture?.showMarkdownExample(true))
	await page.getByRole('button', { name: /Helm conversation/ }).click()
})
test('conversation Markdown renders headings, emphasis, lists, code and tables without fetching untrusted content', async ({
	page,
}) => {
	const requests: string[] = []
	page.on('request', request => {
		if (new URL(request.url()).hostname === 'example.com') requests.push(request.url())
	})
	const reading = page.getByLabel('Conversation messages')
	await expect(reading.getByRole('heading', { name: 'Inspection notes' })).toBeVisible()
	await expect(reading.locator('strong').filter({ hasText: 'Checkpoints' })).toHaveCount(1)
	await expect(reading.locator('li')).toHaveCount(2)
	await expect(reading.locator('pre code')).toContainText('  Převodovka\n    Těsnost')
	await expect(reading.getByRole('table')).toContainText('Gearbox')
	await expect(reading.getByRole('link', { name: 'Reference', exact: true })).toHaveAttribute(
		'rel',
		'noopener noreferrer',
	)
	await expect(reading.locator('img, script, iframe, [onerror], a[href^="javascript:"]')).toHaveCount(0)
	expect(requests).toEqual([])
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
test('activity is absent by default and available only through conversation options', async ({ page }) => {
	await expect(page.getByRole('button', { name: 'Thinking', exact: true })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Tool output', exact: true })).toHaveCount(0)
	await expect(page.locator('[data-message-id="markdown-tool"]')).toHaveCount(0)
	await page.getByRole('button', { name: 'Conversation options', exact: true }).click()
	const activity = page.getByRole('menuitemcheckbox', { name: 'Show activity', exact: true })
	await expect(activity).toHaveAttribute('aria-checked', 'false')
	await activity.click()
	const message = page.locator('[data-message-id="markdown-assistant"]')
	expect(await message.evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('0px')
	await expect(message.locator('.section')).toHaveCount(0)
	const thinking = message.getByRole('button', { name: 'Thinking', exact: true })
	await expect(thinking).toHaveAttribute('aria-expanded', 'false')
	await thinking.click()
	await expect(thinking).toHaveAttribute('aria-expanded', 'true')
	await expect(message.getByText('Compare the checklist with the component hierarchy.')).toBeVisible()
	await page.getByRole('button', { name: 'Tool output', exact: true }).click()
	await expect(page.getByText('Inspection file found.', { exact: false })).toBeVisible()
	await page.getByRole('button', { name: 'Conversation options', exact: true }).click()
	await expect(activity).toHaveAttribute('aria-checked', 'true')
	await activity.click()
	await expect(page.getByRole('button', { name: 'Thinking', exact: true })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Tool output', exact: true })).toHaveCount(0)
	await expect(page.getByText('Inspection file found.', { exact: false })).toHaveCount(0)
})

test('Pi replies chain across hidden activity and restart the author only after a user message', async ({ page }) => {
	await page.evaluate(() => window.__remoteFixture?.showChainedExample())
	const reading = page.getByLabel('Conversation messages')
	await expect(reading.getByText('I’ll check the implementation.')).toBeVisible()
	await expect(reading.getByText('The implementation is ready.')).toBeVisible()
	await expect(reading.getByRole('heading', { name: 'Pi', exact: true })).toHaveCount(1)
	await expect(reading.getByText('Tool: background_job', { exact: true })).toHaveCount(0)
	await expect(reading.locator('.remote-message')).toHaveCount(3)
	await expect(reading.getByRole('button', { name: 'Tool calls', exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'Conversation options', exact: true }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Show activity', exact: true }).click()
	await expect(reading.getByText('Tool: background_job', { exact: true })).toBeVisible()
	await expect(reading.getByRole('button', { name: 'Tool calls', exact: true })).toBeVisible()
	await expect(reading.getByRole('heading', { name: 'Pi', exact: true })).toHaveCount(1)
	await page.getByRole('button', { name: 'Conversation options', exact: true }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Show activity', exact: true }).click()
	await page.getByLabel('Message', { exact: true }).fill('Please continue')
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect(reading.getByText('Please continue', { exact: true })).toBeVisible()
	await page.evaluate(() => window.__remoteFixture?.append('Continuing after your message.'))
	await expect(reading.getByText('Continuing after your message.')).toBeVisible()
	await expect(reading.getByRole('heading', { name: 'Pi', exact: true })).toHaveCount(2)
})

test('Okena worktree metadata outranks a filesystem Pi label, is searchable, and never replaces its draft identity', async ({
	page,
}) => {
	await page.getByLabel('Message', { exact: true }).fill('Keep the same owner')
	await page.evaluate(() => window.__remoteFixture?.showTerminalMetadataExample())
	await expect(page.getByRole('heading', { name: 'feat/mobile', exact: true })).toBeVisible()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep the same owner')
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	const row = page.getByRole('button', { name: /feat\/mobile/ })
	await expect(row).toContainText('Group: Contember')
	await expect(row).toContainText('Project: JVS')
	await expect(row).toContainText('Branch: docs/mobile-phase-0')
	await expect(row).toContainText('Source: Okena')
	await expect(page.getByRole('button', { name: /Remote interface/ })).toContainText('Workbench')
	await page.getByRole('searchbox').fill('JVS')
	await expect(row).toBeVisible()
	await page.getByRole('searchbox').fill('divoka kremrole')
	await expect(row).toBeVisible()
	await page.getByRole('searchbox').fill('docs/mobile-phase-0')
	await expect(row).toBeVisible()
	await expect(page.getByRole('button', { name: /Remote interface/ })).toHaveCount(0)
	await row.click()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep the same owner')
})

test('live workspace omits root navigation while preserving drafts', async ({ page }) => {
	await page.getByLabel('Message', { exact: true }).fill('Keep this draft')
	await expect(page.getByRole('navigation', { name: 'App navigation' })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'App', exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await expect(page.getByRole('navigation', { name: 'Live sessions' })).toBeVisible()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft')
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await expect(page.getByRole('navigation', { name: 'Live sessions' })).toBeVisible()
})
