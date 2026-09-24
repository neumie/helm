import { expect, test } from '@playwright/test'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'
import { openRemoteDestination } from './remote-navigation.js'
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
test('tool activity is absent by default while thinking stays visible and literal', async ({ page }) => {
	await expect(page.getByRole('button', { name: 'Thinking', exact: true })).toHaveCount(0)
	await expect(page.getByText('Compare the checklist with the component hierarchy.', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Tool output', exact: true })).toHaveCount(0)
	await expect(page.locator('[data-message-id="markdown-tool"]')).toHaveCount(0)
	await page.getByRole('button', { name: 'More', exact: true }).click()
	const activity = page.getByRole('menuitemcheckbox', { name: 'Show tool activity', exact: true })
	await expect(activity).toHaveAttribute('aria-checked', 'false')
	await activity.click()
	const message = page.locator('[data-message-id="markdown-assistant"]')
	expect(await message.evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('0px')
	await expect(message.locator('.section')).toHaveCount(0)
	await expect(message.getByText('Compare the checklist with the component hierarchy.', { exact: true })).toBeVisible()
	await expect(message.locator('.remote-thinking-text')).toHaveCSS('white-space', 'pre-wrap')
	await expect(message.getByRole('button', { name: 'Thinking', exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'Tool output', exact: true }).click()
	await expect(page.getByText('Inspection file found.', { exact: false })).toBeVisible()
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await expect(activity).toHaveAttribute('aria-checked', 'true')
	await activity.click()
	await expect(page.getByRole('button', { name: 'Thinking', exact: true })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Tool output', exact: true })).toHaveCount(0)
	await expect(page.getByText('Inspection file found.', { exact: false })).toHaveCount(0)
})

test('thinking matrix stays literal while structured and legacy tools remain opt-in', async ({ page }) => {
	await page.evaluate(() => window.__remoteFixture?.showThinkingMatrix())
	const reading = page.getByLabel('Conversation messages')
	await expect(reading.locator('.remote-thinking-text')).toHaveCount(3)
	await expect(reading.locator('.remote-thinking-text').nth(0)).toContainText('<b>literal</b>')
	await expect(reading.locator('.remote-thinking-text').nth(0)).toContainText('![not an image](https://example.com/x)')
	await expect(reading.locator('.remote-markdown').filter({ hasText: 'Tool: not_a_tool' })).toBeVisible()
	await expect(reading.getByText('Hidden tool output', { exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Show tool activity', exact: true }).click()
	await reading.getByRole('button', { name: 'Tool output', exact: true }).click()
	await expect(reading.getByText('Hidden tool output', { exact: true })).toBeVisible()
	await expect(reading.locator('.remote-thinking-text')).toHaveCount(3)
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Show tool activity', exact: true }).click()
	await expect(reading.getByText('Legacy reasoning survives.', { exact: true })).toBeVisible()
	await expect(reading.getByText('Tool: background_job', { exact: true })).toHaveCount(0)
})

test('ANSI thinking is plain literal text and control-only thinking creates no ghost row', async ({ page }) => {
	const expected = '  Inspect <b>literal</b> 🌿\n\t[39m \\x1b[39m link'
	await page.evaluate(() => {
		const fixture = window.__remoteFixture
		if (!fixture) throw new Error('Missing fixture')
		fixture.showThinkingMatrix()
		const detail = fixture.transport.detail.bind(fixture.transport)
		fixture.transport.detail = async (id, signal) => {
			const result = await detail(id, signal)
			result.snapshot.messages = [
				{
					id: 'ansi-visible',
					role: 'assistant',
					text: '',
					toolCalls: 'read',
					truncated: false,
					thinking:
						'\u001b[38;2;150;160;170m  Inspect <b>literal</b> 🌿\n\t[39m \\x1b[39m \u001b[39m\u009d8;;https://example.invalid\u009clink\u009d8;;\u001b\\',
				},
				{ id: 'ansi-only', role: 'assistant', text: '', toolCalls: 'read', truncated: false, thinking: '\u001b[39m' },
			]
			return result
		}
	})
	const pane = page.getByLabel('Conversation messages')
	await expect(pane.locator('[data-message-id="ansi-visible"] .remote-thinking-text')).toHaveText(expected, {
		useInnerText: false,
	})
	await expect(pane.locator('[data-message-id="ansi-only"]')).toHaveCount(0)
	await expect(pane.locator('.remote-thinking-text b, .remote-thinking-text a')).toHaveCount(0)
	await page.getByLabel('Message', { exact: true }).fill('Preserve this draft')
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Show tool activity', exact: true }).click()
	await expect(pane.locator('[data-message-id="ansi-only"]')).toHaveCount(1)
	await expect(pane.locator('[data-message-id="ansi-only"] .remote-thinking')).toHaveCount(0)
	await expect(pane.locator('.remote-thinking-text')).toHaveText(expected, { useInnerText: false })
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Preserve this draft')
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
})

test('Pi replies chain across hidden activity and restart the author only after a user message', async ({ page }) => {
	await page.evaluate(() => window.__remoteFixture?.showChainedExample())
	const reading = page.getByLabel('Conversation messages')
	await expect(reading.getByText('I’ll check the implementation.')).toBeVisible()
	await expect(reading.getByText('The implementation is ready.')).toBeVisible()
	await expect(reading.getByRole('heading', { name: 'Pi', exact: true })).toHaveCount(1)
	await expect(reading.getByText('Tool: background_job', { exact: true })).toHaveCount(0)
	await expect(reading.locator('.remote-message')).toHaveCount(4)
	await expect(reading.getByRole('button', { name: 'Tool calls', exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Show tool activity', exact: true }).click()
	await expect(reading.getByText('Tool: background_job', { exact: true })).toBeVisible()
	await expect(reading.getByRole('button', { name: 'Tool calls', exact: true })).toBeVisible()
	await expect(reading.getByRole('heading', { name: 'Pi', exact: true })).toHaveCount(1)
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Show tool activity', exact: true }).click()
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
	await openRemoteDestination(page, 'Sessions')
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
	await openRemoteDestination(page, 'Sessions')
	await expect(page.getByRole('navigation', { name: 'Live sessions' })).toBeVisible()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft')
	await openRemoteDestination(page, 'Sessions')
	await expect(page.getByRole('navigation', { name: 'Live sessions' })).toBeVisible()
})

test('decorated thinking is accessible plain source text and label-only thinking has no live anchor', async ({
	page,
}) => {
	const requests: string[] = []
	page.on('request', request => {
		if (request.url().startsWith('https://example.invalid/')) requests.push(request.url())
	})
	const expected =
		'Inspect nested text and x\n<img src="https://example.invalid/thinking"> [link](https://example.invalid/link) ![image](https://example.invalid/image)'
	await page.evaluate(() => {
		const f = window.__remoteFixture
		if (!f) throw new Error('Missing fixture')
		const detail = f.transport.detail.bind(f.transport)
		f.transport.detail = async (...args) => {
			const result = await detail(...args)
			result.snapshot.messages = [
				{
					id: 'decorated-thinking',
					role: 'assistant',
					text: '',
					thinking:
						'**Thinking:** **Inspect *nested* text** and *x*\n<img src="https://example.invalid/thinking"> [link](https://example.invalid/link) ![image](https://example.invalid/image)',
					toolCalls: 'read',
					truncated: false,
				},
				{ id: 'label-only-thinking', role: 'assistant', text: '', thinking: '**Thinking:**', truncated: false },
			]
			return result
		}
	})
	const pane = page.getByLabel('Conversation messages')
	const group = pane.getByRole('group', { name: 'Thinking', exact: true })
	await expect(group).toHaveText(expected, { useInnerText: false })
	await expect(pane.locator('[data-message-id="decorated-thinking"]')).toHaveCount(1)
	await expect(pane.locator('[data-message-id="label-only-thinking"]')).toHaveCount(0)
	await expect(group.locator('strong, em, img, a, b, script, h1, h2')).toHaveCount(0)
	await expect(pane.locator('.remote-thinking-label')).toHaveCount(0)
	await page.getByLabel('Message', { exact: true }).fill('Keep decorated draft')
	for (let i = 0; i < 2; i++) {
		await page.getByRole('button', { name: 'More', exact: true }).click()
		await page.getByRole('menuitemcheckbox', { name: 'Show tool activity', exact: true }).click()
		await expect(group).toHaveText(expected, { useInnerText: false })
		await expect(pane.locator('[data-message-id="label-only-thinking"]')).toHaveCount(0)
	}
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep decorated draft')
	expect(await page.evaluate(() => window.__remoteFixture?.commands)).toEqual([])
	expect(requests).toEqual([])
})
