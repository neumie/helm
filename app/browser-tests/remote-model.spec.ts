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

test('the footer model names the current model and offers the others', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)

	await page.getByRole('button', { name: 'Attachments, model and effort' }).click()
	const menu = page.getByRole('menu')
	await expect(menu.getByRole('menuitemradio')).toHaveText([/GPT model/, /Opus 5/, 'low', 'medium', 'high'])
	// The current model is marked, so choosing is a change rather than a guess.
	await expect(menu.getByRole('menuitemradio', { name: /GPT model/ })).toHaveAttribute('aria-checked', 'true')
	await expect(menu.getByRole('menuitemradio', { name: /Opus 5/ })).toHaveAttribute('aria-checked', 'false')
	// Image support travels with the choice, before any attachment is attempted.
	await expect(menu.getByRole('menuitemradio', { name: /Opus 5/ })).toContainText('Images')
})

test('choosing a model sends exactly one model command for that model', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)

	await page.getByRole('button', { name: 'Attachments, model and effort' }).click()
	await page.getByRole('menuitemradio', { name: /Opus 5/ }).click()
	await expect(page.getByRole('menu')).toHaveCount(0)

	const sent = async () =>
		await page.evaluate(() =>
			(window.__remoteFixture?.commands ?? [])
				.filter(command => command.operation.kind === 'model')
				.map(command => command.operation),
		)
	await expect.poll(sent).toEqual([{ kind: 'model', provider: 'anthropic', id: 'claude-opus-5' }])
})

test('a conversation whose bridge lists no models keeps a plain, unclickable model line', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(STORY)
	// A bridge from before model selection omits the field; it does not send an empty one.
	await page.waitForFunction(() => (window.__remoteFixture?.views.length ?? 0) > 0)
	const stripped = await page.evaluate(() => {
		const views = window.__remoteFixture?.views ?? []
		for (const view of views) {
			delete (view as { models?: unknown }).models
			// Polling is revision-driven, so an edit nobody announces is correctly ignored.
			view.revision += 1
		}
		return views.length
	})
	// Without this the loop can run over nothing and the test would assert its own no-op.
	expect(stripped).toBeGreaterThan(0)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.locator('.remote-conversation')).toBeVisible()

	await page.getByRole('button', { name: 'Attachments, model and effort' }).click()
	// No models listed means no model choices, and a stated reason rather than silence.
	// Effort is published separately, so its levels are unaffected.
	await expect(page.getByRole('menu').getByRole('menuitemradio', { name: /model|Opus|GPT/i })).toHaveCount(0)
	const reason = page.getByRole('menuitem', { name: 'Reload this terminal to choose a model' })
	await expect(reason).toBeVisible()
	await expect(reason).toBeDisabled()
	await expect(page.locator('.remote-information-footer-model')).toContainText('openai-codex/gpt-model')
})

test('the conversation menu reads as one list: model first, named once, actions below', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)
	await page.getByRole('button', { name: 'Attachments, model and effort' }).click()

	const menu = page.getByRole('menu')
	// A heading per entry would print "Model" once per model; it belongs to the group.
	await expect(menu.locator('.menu-section-label')).toHaveText(['Model', 'Effort'])
	// Attach first, then identity, then effort, then the view options.
	const items = menu.locator('.menu-item .menu-item-label')
	await expect(items).toHaveText([
		// This story's bridge advertises no image input, so the entry states that instead.
		/photos/i,
		'GPT model',
		'Opus 5',
		'low',
		'medium',
		'high',
		'Info',
		'Show tool activity',
	])
	// The options are divided from the models rather than continuing the same list.
	await expect(menu.locator('.menu-separator')).toHaveCount(1)
})

test('effort is chosen from the same menu and sends one thinking command', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)
	await page.getByRole('button', { name: 'Attachments, model and effort' }).click()

	const menu = page.getByRole('menu')
	await expect(menu.locator('.menu-section-label')).toHaveText(['Model', 'Effort'])
	// Only the levels this model publishes, not Pi's whole set.
	const effort = menu.getByRole('menuitemradio', { name: /^(off|minimal|low|medium|high|xhigh|max)$/ })
	await expect(effort).toHaveText(['low', 'medium', 'high'])
	await expect(menu.getByRole('menuitemradio', { name: 'high', exact: true })).toHaveAttribute('aria-checked', 'true')

	await menu.getByRole('menuitemradio', { name: 'low', exact: true }).click()
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

test('the composer menu survives a pending question, so Info never becomes unreachable', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await openConversation(page)
	await page.evaluate(() => window.__remoteFixture?.ask())
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible()

	// The header menu is gone, so this control is the only route to Info and the model.
	await page.getByRole('button', { name: 'Attachments, model and effort' }).click()
	await expect(page.getByRole('menuitem', { name: 'Info', exact: true })).toBeVisible()
	await expect(page.getByRole('menuitemradio', { name: 'Opus 5' })).toBeVisible()
})
