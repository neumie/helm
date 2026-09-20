import { type Page, expect, test } from '@playwright/test'

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
	const trigger = page.getByRole('button', { name: /Message delivery:/ })
	if (mode === 'touch') await trigger.tap()
	else await trigger.click()
	const menu = page.getByRole('menu', { name: /Message delivery:/ })
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
	const mode = page.getByRole('button', { name: /Message delivery:/ })
	await mode.press('ArrowDown')
	const followUp = page.getByRole('menuitemradio', { name: 'Follow up after current work' })
	await followUp.press('End')
	await expect(followUp).toBeFocused()
	const menuBox = await page.getByRole('menu', { name: /Message delivery:/ }).boundingBox()
	const modeBox = await mode.boundingBox()
	if (!menuBox || !modeBox) throw new Error('Missing menu')
	expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(modeBox.y)
	await followUp.press('Enter')
	await expect(mode).toBeFocused()
	await expect(mode).toHaveText('')
	await expect(mode).toHaveAccessibleName('Message delivery: Follow-up')
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(mode).toHaveText('')
	await expect(mode).toHaveAccessibleName('Message delivery: Follow-up')
	await expect(message).toHaveValue('Keep the conversation going')
	await send.click()
	await expect
		.poll(() => page.evaluate(() => window.__remoteFixture?.commands[0]?.operation))
		.toEqual({ kind: 'prompt', text: 'Keep the conversation going', delivery: 'followUp' })
})

test('delivery selection is icon-only, checked, focus-restored, and does not dispatch', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const trigger = page.getByRole('button', { name: 'Message delivery: During work' })
	await expect(trigger).toHaveText('')
	await expect(trigger).toHaveCSS('width', '44px')
	await expect(trigger).toHaveCSS('height', '44px')
	await trigger.click()
	await expect(page.getByRole('menuitemradio', { name: 'Steer at the next safe point' })).toBeChecked()
	await page.keyboard.press('Escape')
	await expect(trigger).toBeFocused()
	await trigger.click()
	await page.getByRole('menuitemradio', { name: 'Follow up after current work' }).click()
	await expect(page.getByRole('button', { name: 'Message delivery: Follow-up' })).toHaveText('')
	await expect.poll(() => page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	await page.getByRole('button', { name: 'Message delivery: Follow-up' }).click()
	await expect(page.getByRole('menuitemradio', { name: 'Follow up after current work' })).toBeChecked()
	await page.getByRole('menuitemradio', { name: 'Steer at the next safe point' }).click()
	await expect.poll(() => page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	await page.getByLabel('Message', { exact: true }).fill('Exact steer draft')
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect
		.poll(() => page.evaluate(() => window.__remoteFixture?.commands.map(command => command.operation)))
		.toEqual([{ kind: 'prompt', text: 'Exact steer draft', delivery: 'steer' }])
})

test('Interrupt dispatch is one composer action, adjacent to Send, and follows observed gates', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--working&viewMode=story')
	await expect(page.locator('.remote-header').getByRole('button', { name: 'Interrupt', exact: true })).toHaveCount(0)
	const interrupt = page.locator('.remote-composer').getByRole('button', { name: 'Interrupt', exact: true })
	const send = page.getByRole('button', { name: 'Send', exact: true })
	await expect(interrupt).toHaveCount(1)
	await expect(interrupt).toHaveCSS('width', '44px')
	await expect(interrupt).toHaveCSS('height', '44px')
	const interruptBox = await interrupt.boundingBox()
	const sendBox = await send.boundingBox()
	if (!interruptBox || !sendBox) throw new Error('Missing action geometry')
	expect(sendBox.x - (interruptBox.x + interruptBox.width)).toBe(8)
	await interrupt.click()
	await expect
		.poll(() =>
			page.evaluate(
				() => window.__remoteFixture?.commands.filter(command => command.operation.kind === 'interrupt').length,
			),
		)
		.toBe(1)
	await expect(
		page.evaluate(() => window.__remoteFixture?.commands.some(command => command.operation.kind === 'prompt')),
	).resolves.toBe(false)
	await page.evaluate(() => window.__remoteFixture?.setActivity('idle'))
	await expect(interrupt).toHaveCount(0)
})

test('waiting question keeps Interrupt beside Submit answers', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--questions&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const interrupt = page.locator('.remote-composer').getByRole('button', { name: 'Interrupt', exact: true })
	const submit = page.getByRole('button', { name: 'Submit answers', exact: true })
	await expect(interrupt).toHaveCount(1)
	const interruptBox = await interrupt.boundingBox()
	const submitBox = await submit.boundingBox()
	if (!interruptBox || !submitBox) throw new Error('Missing question action geometry')
	expect(submitBox.x - (interruptBox.x + interruptBox.width)).toBe(8)
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
	await expect(page.getByRole('button', { name: 'Message delivery: During work' })).toHaveText('')
	await message.fill(SIX_LINE_DRAFT)
	await expect.poll(() => message.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(40)
	await openAndSelectDelivery(page, viewport, 'Follow up after current work', 'pointer')
	await expect(page.getByRole('button', { name: 'Message delivery: Follow-up' })).toHaveText('')
	await expectFullyContained(page.locator('.remote-composer'), viewport)
	await expectFullyContained(page.locator('.remote-composer-actions'), viewport)
	await expectFullyContained(page.getByRole('button', { name: 'Send', exact: true }), viewport)
})

test('empty composer uses native single-row sizing without a forced scrollHeight read', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 420 })
	await page.addInitScript(() => {
		const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')
		if (!descriptor?.get) throw new Error('Missing native scrollHeight getter')
		const read = descriptor.get
		const counts = { empty: 0, filled: 0 }
		Object.assign(window, { composerMeasurements: counts })
		Object.defineProperty(Element.prototype, 'scrollHeight', {
			...descriptor,
			get() {
				if (this instanceof HTMLTextAreaElement && this.id === 'remote-prompt') {
					if (this.value) counts.filled++
					else counts.empty++
				}
				return read.call(this)
			},
		})
	})
	await page.goto('/iframe.html?id=views-helm-remote--composer&viewMode=story')
	const message = page.getByLabel('Message', { exact: true })
	await expect(message).toBeVisible()
	const initial = await message.evaluate(node => node.getBoundingClientRect().height)
	await message.fill(SIX_LINE_DRAFT)
	await expect.poll(() => message.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(initial)
	await message.fill('')
	await expect.poll(() => message.evaluate(node => node.getBoundingClientRect().height)).toBe(initial)
	const counts = await page.evaluate(
		() => (window as unknown as { composerMeasurements: { empty: number; filled: number } }).composerMeasurements,
	)
	expect(counts.empty).toBe(0)
	expect(counts.filled).toBeGreaterThan(0)
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
	const delivery = page.getByRole('button', { name: /Message delivery:/ })
	const interrupt = page.locator('.remote-composer').getByRole('button', { name: 'Interrupt', exact: true })
	await expect(message).toBeVisible()
	await expect(page.locator('.remote-conversation .remote-information-footer-source')).toHaveText('Source unavailable')
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
	await expect(page.locator('.remote-header').getByRole('button', { name: 'Interrupt', exact: true })).toHaveCount(0)
	expect(
		await page.getByLabel('Conversation messages').evaluate(node => node.getBoundingClientRect().height),
	).toBeGreaterThanOrEqual(96)
})

for (const gate of ['disconnected', 'no capability', 'unresolved'] as const) {
	test(`composer Interrupt is disabled for ${gate}`, async ({ page }) => {
		await page.goto('/iframe.html?id=views-helm-remote--working&viewMode=story')
		const interrupt = page.locator('.remote-composer').getByRole('button', { name: 'Interrupt', exact: true })
		await expect(interrupt).toBeEnabled()
		await page.evaluate(gate => {
			const f = window.__remoteFixture
			if (!f) throw new Error('Missing fixture')
			if (gate === 'disconnected') f.setConnected(false)
			else if (gate === 'no capability') f.setReadOnly(true)
			else {
				const send = f.transport.send.bind(f.transport)
				f.transport.send = async (...args) => ({ ...(await send(...args)), status: 'pending' })
				f.transport.receipt = async command => ({ commandId: command.commandId, status: 'pending' })
			}
		}, gate)
		if (gate === 'unresolved') {
			await page.getByLabel('Message', { exact: true }).fill('Admitted prompt')
			await page.getByRole('button', { name: 'Send', exact: true }).click()
		}
		await expect(interrupt).toBeDisabled()
		expect(
			await page.evaluate(() => window.__remoteFixture?.commands.filter(c => c.operation.kind === 'interrupt')),
		).toEqual([])
	})
}
test('compact covered question keeps Interrupt beside local Back without an answer effect', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 420 })
	await page.goto('/iframe.html?id=views-helm-remote--information-question&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await openInfo(page)
	const stop = page.locator('.remote-composer').getByRole('button', { name: 'Interrupt', exact: true })
	const back = page.locator('.remote-composer').getByRole('button', { name: 'Back to conversation', exact: true })
	await expect(stop).toHaveCSS('width', '44px')
	await expect(stop).toHaveCSS('height', '44px')
	const a = await stop.boundingBox()
	const b = await back.boundingBox()
	if (!a || !b) throw new Error('Missing covered-question actions')
	expect(b.x - a.x - a.width).toBe(8)
	expect(b.y).toBe(a.y)
	await expectFullyContained(stop, { width: 320, height: 420 })
	await expectFullyContained(back, { width: 320, height: 420 })
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toHaveCount(0)
	await back.click()
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible()
	expect(await page.evaluate(() => window.__remoteFixture?.commands)).toEqual([])
})

async function openInfo(page: Page) {
	await page.getByRole('button', { name: 'Attachments, model and effort', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Info', exact: true }).click()
}
