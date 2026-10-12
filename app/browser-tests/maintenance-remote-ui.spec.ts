import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { RemoteDetail } from '../../src/remote/protocol.js'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'
import { openRemoteDestination } from './remote-navigation.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
		__maintenanceDetail?: RemoteDetail
	}
}
const story = '/iframe.html?id=views-helm-remote--browser-harness&viewMode=story'

async function openFixture(page: Page, url = story) {
	await page.goto(url)
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await expect(page.getByRole('navigation', { name: 'Live sessions', exact: true })).toBeVisible()
}

for (const replacement of ['incarnation', 'hostEpoch', 'scopeId', 'generation', 'sessionId'] as const) {
	test(`detail-only ${replacement} replacement cannot render or erase answer drafts`, async ({ page }) => {
		await openFixture(page)
		await page.evaluate(() => window.__remoteFixture?.ask())
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const answer = page.getByRole('radio', { name: /Keep the owner/ })
		await answer.check()
		await page.evaluate(async field => {
			const fixture = window.__remoteFixture
			if (!fixture) throw new Error('Missing Remote fixture')
			const directory = await fixture.transport.directory(new AbortController().signal)
			const session = directory.sessions[0]
			if (!session) throw new Error('Missing fixture session')
			const original = await fixture.transport.detail(session.target.sessionId, new AbortController().signal)
			window.__maintenanceDetail = original
			const replacement = structuredClone(original)
			if (field === 'hostEpoch') replacement.hostEpoch = crypto.randomUUID()
			else if (field === 'generation') replacement.snapshot.target.generation++
			else replacement.snapshot.target[field] = crypto.randomUUID()
			replacement.snapshot.messages = [
				{ id: 'foreign', role: 'assistant', text: 'Foreign owner secret', thinking: '', truncated: false },
			]
			if (replacement.snapshot.question) {
				replacement.snapshot.question.requestId = crypto.randomUUID()
				const question = replacement.snapshot.question.questions[0]
				if (!question) throw new Error('Missing fixture question')
				question.question = 'Foreign question'
			}
			fixture.transport.detail = async () => replacement
			document.dispatchEvent(new Event('visibilitychange'))
		}, replacement)
		await expect(answer).toHaveCount(0)
		await expect(page.getByText('Foreign owner secret')).toHaveCount(0)
		await expect(page.getByText('Foreign question')).toHaveCount(0)
		await page.evaluate(() => {
			const fixture = window.__remoteFixture
			const detail = window.__maintenanceDetail
			if (!fixture || !detail) throw new Error('Missing restoration fixture')
			fixture.transport.detail = async () => detail
			document.dispatchEvent(new Event('visibilitychange'))
		})
		await expect(answer).toBeChecked()
		expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	})
}

for (const text of ['界'.repeat(9000), '\\'.repeat(16384)]) {
	test(`oversize ${text.charCodeAt(0)} restores exact draft without POST or unknown receipt`, async ({ page }) => {
		let posts = 0
		await page.route('**/v1/commands', route => {
			posts++
			return route.abort()
		})
		await openFixture(page)
		await page.evaluate(() => window.__remoteFixture?.useProductionCommandTransport())
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const editor = page.getByRole('textbox', { name: 'Message', exact: true })
		await editor.fill(text)
		await editor.press('Control+Enter')
		await expect(page.locator('.remote-receipt')).toContainText('Message was not sent. Shorten the message')
		await expect(editor).toHaveValue(text)
		await expect(page.getByRole('button', { name: 'Check status', exact: true })).toHaveCount(0)
		expect(posts).toBe(0)
	})
}

test('choice sheets contain Tab and preserve a later choice during streaming', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openFixture(page)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.locator('.remote-navigation-trigger:visible').click()
	await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'Model' }).click()
	const sheet = page.getByRole('dialog', { name: 'Model', exact: true })
	const later = sheet.getByRole('radio', { name: /Opus 5/ })
	await later.focus()
	expect(
		await page
			.getByRole('textbox', { name: 'Message', exact: true, includeHidden: true })
			.evaluate(node => !!node.closest('[inert]')),
	).toBe(true)
	await page.evaluate(() => {
		window.__remoteFixture?.append('Streamed while choosing')
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.getByText('Streamed while choosing')).toBeAttached()
	await expect(later).toBeFocused()
	for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
		await page.keyboard.press(key)
		expect(await page.evaluate(() => !!document.activeElement?.closest('.remote-sheet-scrim'))).toBe(true)
	}
	await page.keyboard.press('Escape')
	await expect(sheet).toHaveCount(0)
	await expect(page.locator('.remote-navigation-trigger:visible')).toBeFocused()
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitem', { name: /^Effort/ }).click()
	await expect(page.getByRole('radio', { name: 'low', exact: true })).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused()
})

test('cached Usage ages against display time after failed refresh', async ({ page }) => {
	await page.clock.install()
	await openFixture(page, '/iframe.html?id=views-helm-remote--usage&viewMode=story')
	await page.evaluate(async () => {
		const fixture = window.__remoteFixture
		if (!fixture?.transport.usage) throw new Error('Missing Usage fixture')
		const response = await fixture.transport.usage(new AbortController().signal)
		let calls = 0
		fixture.transport.usage = async () => {
			if (calls++) throw new Error('refresh unavailable')
			return response
		}
	})
	await openRemoteDestination(page, 'Usage')
	const panel = page.getByRole('region', { name: 'Usage' })
	await expect(panel.getByText('From this Mac’s last Codex record · 5h ago')).toBeVisible()
	await page.clock.fastForward(3 * 3600_000)
	await expect(panel.getByText('From this Mac’s last Codex record · 8h ago')).toBeVisible()
	await expect(panel.getByRole('img', { name: '5-hour: 23% used, resets now' })).toBeVisible()
	await expect(panel).toContainText('Showing last known limits.')
})

test('production message rows and canonical anchors share the pure visibility policy', async ({ page }) => {
	await openFixture(page)
	await page.evaluate(() => {
		const fixture = window.__remoteFixture
		if (!fixture) throw new Error('Missing message fixture')
		const read = fixture.transport.detail
		fixture.transport.detail = async (...args) => {
			const detail = await read(...args)
			detail.snapshot.messages = [
				{ id: 'legacy', role: 'assistant', text: '\nTool: bash', thinking: '', truncated: false },
				{ id: 'prose', role: 'assistant', text: '\nTool: bash', toolCalls: '', thinking: '', truncated: false },
				{ id: 'ansi', role: 'assistant', text: '', thinking: '\u001b[31m\u001b[0m', truncated: false },
				{ id: 'thinking', role: 'assistant', text: '', thinking: 'Useful thought', truncated: false },
			]
			return detail
		}
	})
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.locator('.remote-message')).toHaveCount(2)
	await expect(page.locator('[data-message-id="prose"]')).toHaveCount(1)
	await expect(page.locator('[data-message-id="thinking"]')).toHaveCount(1)
	await expect(page.locator('[data-message-id="legacy"], [data-message-id="ansi"]')).toHaveCount(0)
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Show tool activity' }).click()
	await expect(page.locator('[data-message-id="legacy"]')).toHaveCount(1)
	await expect(page.locator('[data-message-id="ansi"]')).toHaveCount(0)
})

test('empty sheet has a focus target and dismissal does not steal newer focus', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openFixture(page)
	await page.evaluate(() => {
		const fixture = window.__remoteFixture
		if (!fixture) throw new Error('Missing model fixture')
		const read = fixture.transport.detail
		fixture.transport.detail = async (...args) => {
			const detail = await read(...args)
			detail.snapshot.models = []
			return detail
		}
	})
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.locator('.remote-navigation-trigger:visible').click()
	await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'Model' }).click()
	const sheet = page.getByRole('dialog', { name: 'Model', exact: true })
	await expect(sheet).toBeFocused()
	await page.keyboard.press('Tab')
	await expect(page.getByRole('button', { name: 'Close Model' })).toBeFocused()
	await page.keyboard.press('Shift+Tab')
	await expect(page.getByRole('button', { name: 'Close Model' })).toBeFocused()
	await page.evaluate(() => {
		// A newer external surface mounted after the modal acquired its background.
		const button = document.createElement('button')
		button.id = 'newer-focus'
		button.textContent = 'Newer surface'
		document.body.append(button)
		button.focus()
	})
	await page.keyboard.press('Escape')
	await expect(sheet).toHaveCount(0)
	await expect(page.locator('#newer-focus')).toBeFocused()
})
