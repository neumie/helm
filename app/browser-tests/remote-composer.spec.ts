import { expect, test } from '@playwright/test'

const path = '/iframe.html?id=views-helm-remote--browser-harness&viewMode=story'
const SIX_LINE_DRAFT =
	'A longer thought\nwith several lines\nthat should grow\ninside one surface\nand then scroll\nwithout moving actions away'

async function expectFullyContained(
	locator: import('@playwright/test').Locator,
	viewport: { width: number; height: number },
) {
	const box = await locator.boundingBox()
	expect(box).not.toBeNull()
	if (!box) return
	expect(box.x).toBeGreaterThanOrEqual(-1)
	expect(box.y).toBeGreaterThanOrEqual(-1)
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
	expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
}

async function expectHittableMenuEntry(
	locator: import('@playwright/test').Locator,
	viewport: { width: number; height: number },
) {
	await expect(locator).toBeVisible()
	await expect(locator).toBeInViewport()
	await expectFullyContained(locator, viewport)
	const hit = await locator.evaluate(node => {
		const box = node.getBoundingClientRect()
		const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
		return target === node || (target !== null && node.contains(target))
	})
	expect(hit).toBe(true)
}

async function openAndSelectDelivery(
	page: import('@playwright/test').Page,
	viewport: { width: number; height: number },
	label: string,
	mode: 'pointer' | 'touch',
) {
	const trigger = page.getByRole('button', { name: 'Message delivery' })
	if (mode === 'touch') await trigger.tap()
	else await trigger.click()
	const menu = page.getByRole('menu', { name: 'Message delivery' })
	await expect(menu).toBeVisible()
	await expect(menu).toHaveCSS('opacity', '1')
	for (const entry of ['Steer at the next safe point', 'Follow up after current work'])
		await expectHittableMenuEntry(page.getByRole('menuitemradio', { name: entry, exact: true }), viewport)
	const selected = page.getByRole('menuitemradio', { name: label, exact: true })
	if (mode === 'touch') await selected.tap()
	else await selected.click()
	await expect(menu).toHaveCount(0)
}

for (const width of [390, 1280]) {
	test(`floating latest control never resizes chat or composer at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 })
		await page.goto(path)
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const transcript = page.getByLabel('Conversation messages')
		await expect(transcript.locator('.remote-message')).toHaveCount(40)
		const before = await transcript.boundingBox()
		const composerBefore = await page.locator('.remote-composer').boundingBox()
		await transcript.evaluate(node => {
			node.scrollTop = node.scrollHeight / 2
		})
		const jump = page.getByRole('button', { name: 'Jump to latest' })
		await expect(jump).toBeVisible()
		expect(await transcript.boundingBox()).toEqual(before)
		expect(await page.locator('.remote-composer').boundingBox()).toEqual(composerBefore)
		const bounds = await jump.boundingBox()
		if (!bounds || !before) throw new Error('Missing layout')
		expect(bounds.y + bounds.height).toBeLessThan(before.y + before.height)
		expect(bounds.y).toBeGreaterThan(before.y)
		await jump.click()
		await expect(jump).toHaveCount(0)
	})
}

test('integrated composer uses a keyboard menu, preserves delivery, and sends the selected mode', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const message = page.getByLabel('Message', { exact: true })
	await message.fill('Keep the conversation going')
	await expect(page.locator('.remote-composer select')).toHaveCount(0)
	expect(await message.evaluate(node => getComputedStyle(node).borderTopWidth)).toBe('0px')
	const send = page.getByRole('button', { name: 'Send', exact: true })
	const size = await send.boundingBox()
	expect(size?.width).toBe(44)
	expect(size?.height).toBe(44)
	const mode = page.getByRole('button', { name: 'Message delivery' })
	await mode.press('ArrowDown')
	const followUp = page.getByRole('menuitemradio', { name: 'Follow up after current work' })
	await followUp.press('End')
	await expect(followUp).toBeFocused()
	const menuBox = await page.getByRole('menu', { name: 'Message delivery' }).boundingBox()
	const modeBox = await mode.boundingBox()
	if (!menuBox || !modeBox) throw new Error('Missing menu')
	expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(modeBox.y)
	await followUp.press('Enter')
	await expect(mode).toBeFocused()
	await expect(mode).toHaveText(/Follow-up/)
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(mode).toHaveText(/Follow-up/)
	await expect(message).toHaveValue('Keep the conversation going')
	await send.click()
	await expect
		.poll(() => page.evaluate(() => window.__remoteFixture?.commands[0]?.operation))
		.toEqual({ kind: 'prompt', text: 'Keep the conversation going', delivery: 'followUp' })
})

test('compact delivery menu stays visible and pointer-selects both entries before and after growth', async ({
	page,
}) => {
	const viewport = { width: 390, height: 420 }
	await page.setViewportSize(viewport)
	await page.goto('/iframe.html?id=views-helm-remote--composer&viewMode=story')
	const message = page.getByLabel('Message', { exact: true })
	await expect(message).toBeVisible()
	await openAndSelectDelivery(page, viewport, 'Steer at the next safe point', 'pointer')
	await expect(page.getByRole('button', { name: 'Message delivery' })).toHaveText(/During work/)
	await message.fill(SIX_LINE_DRAFT)
	await expect.poll(() => message.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(40)
	await openAndSelectDelivery(page, viewport, 'Follow up after current work', 'pointer')
	await expect(page.getByRole('button', { name: 'Message delivery' })).toHaveText(/Follow-up/)
	await expectFullyContained(page.locator('.remote-composer'), viewport)
	await expectFullyContained(page.locator('.remote-composer-actions'), viewport)
	await expectFullyContained(page.getByRole('button', { name: 'Send', exact: true }), viewport)
})

test('writing grows within its well, keeps actions reachable, and interrupt lives with running work', async ({
	page,
}) => {
	const viewport = { width: 390, height: 420 }
	await page.setViewportSize(viewport)
	await page.goto('/iframe.html?id=views-helm-remote--composer&viewMode=story')
	const message = page.getByLabel('Message', { exact: true })
	const composer = page.locator('.remote-composer')
	const surface = page.locator('.remote-compose-surface')
	const actions = page.locator('.remote-composer-actions')
	const send = page.getByRole('button', { name: 'Send', exact: true })
	const delivery = page.getByRole('button', { name: 'Message delivery' })
	const interrupt = page.locator('.remote-header').getByRole('button', { name: 'Interrupt', exact: true })
	await expect(message).toBeVisible()
	await expect(page.locator('.remote-conversation .remote-session-source')).toHaveText('Source unavailable')
	await expectFullyContained(composer, viewport)
	await expectFullyContained(message, viewport)
	await expectFullyContained(actions, viewport)
	await expectFullyContained(send, viewport)
	await expectFullyContained(delivery, viewport)
	await expectFullyContained(interrupt, viewport)
	const initial = await message.evaluate(node => node.getBoundingClientRect().height)
	await message.fill(SIX_LINE_DRAFT)
	await expect.poll(() => message.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(initial)
	const textareaMetrics = await message.evaluate(node => {
		const style = getComputedStyle(node)
		return {
			height: node.getBoundingClientRect().height,
			clientHeight: node.clientHeight,
			scrollHeight: node.scrollHeight,
			overflowY: style.overflowY,
		}
	})
	expect(textareaMetrics.height).toBeGreaterThan(initial)
	expect(textareaMetrics.scrollHeight).toBeGreaterThan(textareaMetrics.clientHeight)
	expect(textareaMetrics.overflowY).toBe('auto')
	await expectFullyContained(composer, viewport)
	await expectFullyContained(surface, viewport)
	await expectFullyContained(message, viewport)
	await expectFullyContained(actions, viewport)
	await expectFullyContained(send, viewport)
	await expectFullyContained(delivery, viewport)
	await expectFullyContained(interrupt, viewport)
	await expect(page.locator('.remote-composer').getByRole('button', { name: 'Interrupt', exact: true })).toHaveCount(0)
	expect(
		await page.getByLabel('Conversation messages').evaluate(node => node.getBoundingClientRect().height),
	).toBeGreaterThanOrEqual(96)
})
