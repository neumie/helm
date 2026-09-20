import { expect, test } from '@playwright/test'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
	}
}

const STORY = '/iframe.html?id=views-helm-remote--browser-harness&viewMode=story'

async function openConversation(page: import('@playwright/test').Page) {
	await page.goto(STORY)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.locator('.remote-conversation')).toBeVisible()
}

async function openSheet(page: import('@playwright/test').Page, name: 'Model' | 'Effort') {
	// The model is a header control, the way a chat app titles the screen; effort is
	// reached through More.
	if (name === 'Model') await page.getByRole('button', { name: /^Model:/ }).click()
	else {
		await page.getByRole('button', { name: 'More', exact: true }).click()
		await page.getByRole('menuitem', { name: /^Effort/ }).click()
	}
	return page.getByRole('dialog', { name, exact: true })
}

test('More lists actions, and the model is titled in the header rather than buried', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)

	// The model is the subject of the screen, one tap from anywhere in the conversation.
	await expect(page.getByRole('button', { name: /^Model: GPT model/ })).toBeVisible()

	await page.getByRole('button', { name: 'More', exact: true }).click()
	const sheet = page.getByRole('dialog', { name: 'More', exact: true })
	await expect(sheet.locator('.remote-sheet-option-label')).toHaveText([
		// This story's bridge advertises no image input, so the entry states that instead.
		/photos/i,
		'Effort',
		'Show tool activity',
		'Info',
	])
	// Effort answers "what is it now" without opening anything.
	await expect(sheet.locator('.remote-sheet-option-meta')).toHaveText(['high'])
	// Actions, not alternatives: nothing here reports a selection.
	await expect(sheet.getByRole('radio')).toHaveCount(0)
})

test('the model sheet lists every model, marks the current one and sends one command', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)
	const sheet = await openSheet(page, 'Model')

	await expect(sheet.locator('.remote-sheet-option-label')).toHaveText(['GPT model', 'Opus 5'])
	await expect(sheet.getByRole('radio', { name: /GPT model/ })).toHaveAttribute('aria-checked', 'true')
	// Image support is known before the choice, not after a refused attachment.
	await expect(sheet.getByRole('radio', { name: /Opus 5/ })).toContainText('Images')

	await sheet.getByRole('radio', { name: /Opus 5/ }).click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect
		.poll(
			async () =>
				await page.evaluate(() =>
					(window.__remoteFixture?.commands ?? [])
						.filter(command => command.operation.kind === 'model')
						.map(command => command.operation),
				),
		)
		.toEqual([{ kind: 'model', provider: 'anthropic', id: 'claude-opus-5' }])
})

test('the effort sheet offers only the levels this model publishes', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)
	const sheet = await openSheet(page, 'Effort')

	// The tick is decoration inside the row, so assert the labels rather than the text.
	await expect(sheet.locator('.remote-sheet-option-label')).toHaveText(['low', 'medium', 'high'])
	await expect(sheet.getByRole('radio', { name: 'high', exact: true })).toHaveAttribute('aria-checked', 'true')

	await sheet.getByRole('radio', { name: 'low', exact: true }).click()
	await expect
		.poll(
			async () =>
				await page.evaluate(() =>
					(window.__remoteFixture?.commands ?? [])
						.filter(command => command.operation.kind === 'thinking')
						.map(command => command.operation),
				),
		)
		.toEqual([{ kind: 'thinking', level: 'low' }])
})

test('a sheet dismisses by backdrop and by Escape, returning focus to the control that opened it', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)
	const plus = page.getByRole('button', { name: 'More', exact: true })

	await openSheet(page, 'Model')
	await page.locator('.remote-sheet-dismiss').click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(plus).toBeFocused()

	await openSheet(page, 'Effort')
	await page.keyboard.press('Escape')
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(plus).toBeFocused()
	// Dismissing is not choosing.
	expect(await page.evaluate(() => (window.__remoteFixture?.commands ?? []).length)).toBe(0)
})

test('a conversation whose bridge lists no models says so in the sheet instead of showing an empty one', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(STORY)
	await page.waitForFunction(() => (window.__remoteFixture?.views.length ?? 0) > 0)
	const stripped = await page.evaluate(() => {
		const views = window.__remoteFixture?.views ?? []
		for (const view of views) {
			delete (view as { models?: unknown }).models
			view.revision += 1
		}
		return views.length
	})
	expect(stripped).toBeGreaterThan(0)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.locator('.remote-conversation')).toBeVisible()

	const sheet = await openSheet(page, 'Model')
	await expect(sheet.getByRole('radio')).toHaveCount(0)
	await expect(sheet).toContainText('Reload this conversation’s terminal to choose a model.')
})

test('the composer menu survives a pending question, so Info never becomes unreachable', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)
	await page.evaluate(() => window.__remoteFixture?.ask())
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible()

	// Info is reached only through this control now, and the model stays in the header.
	await expect(page.getByRole('button', { name: /^Model:/ })).toBeVisible()
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await expect(page.getByRole('menuitem', { name: 'Info', exact: true })).toBeVisible()
})
