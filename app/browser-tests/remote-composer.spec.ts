import { type Page, expect, test } from '@playwright/test'
import { openRemoteDestination } from './remote-navigation.js'

const path = '/iframe.html?id=views-helm-remote--browser-harness&viewMode=story'
const SIX_LINE_DRAFT =
	'A longer thought\nwith several lines\nthat should grow\ninside one surface\nand then scroll\nwithout moving actions away'

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 320, height: 420 },
]) {
	test(`composer is compact at rest and has a two-row action layout on focus at ${viewport.width}x${viewport.height}`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport)
		await page.goto(path)
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const surface = page.locator('.remote-compose-surface')
		const message = page.getByLabel('Message', { exact: true })
		const delivery = page.getByRole('button', { name: /Message delivery:/ })
		const more = page.getByRole('button', { name: 'More', exact: true })
		const send = page.getByRole('button', { name: 'Send', exact: true })
		await expect.poll(async () => (await surface.boundingBox())?.height ?? 0).toBeLessThanOrEqual(60)
		await expect(delivery).toBeVisible()
		await expect(more).toBeVisible()
		await expect(send).toBeVisible()
		await message.focus()
		await expect.poll(async () => (await surface.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(96)
		await expect(delivery).toBeVisible()
		const field = await message.boundingBox()
		const action = await more.boundingBox()
		if (!field || !action) throw new Error('Missing composer controls')
		expect(field.y + field.height).toBeLessThanOrEqual(action.y + 2)
		await message.fill(SIX_LINE_DRAFT)
		await expectFullyContained(surface, viewport)
		await page.getByLabel('Conversation messages').focus()
		await expect.poll(async () => (await surface.boundingBox())?.height ?? 0).toBeLessThanOrEqual(60)
		await expect(delivery).toBeVisible()
		await expect(message).toHaveValue(SIX_LINE_DRAFT)
		await expect.poll(async () => (await message.boundingBox())?.height ?? 0).toBeLessThanOrEqual(44)
		await message.focus()
		await expect.poll(async () => (await surface.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(96)
		await expect(delivery).toBeVisible()
	})
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 320, height: 420 },
]) {
	test(`compact delivery is selectable without focusing the editor at ${viewport.width}x${viewport.height}`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport)
		await page.goto(path)
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const surface = page.locator('.remote-compose-surface')
		const mode = page.locator('.remote-mode-trigger')
		await expect(mode).toHaveAccessibleName('Message delivery: During work')
		await expectFullyContained(mode, viewport)
		await mode.press('ArrowDown')
		const menu = page.getByRole('menu', { name: 'Message delivery: During work' })
		await expectFullyContained(menu, viewport)
		const followUp = page.getByRole('menuitemradio', { name: 'Follow up after current work' })
		await followUp.press('End')
		await followUp.press('Enter')
		await expect(mode).toBeFocused()
		await expect(mode).toHaveAccessibleName('Message delivery: Follow-up')
		await expect(mode.locator('svg path')).toHaveAttribute('d', 'M8 2.5v7M5.5 7 8 9.5 10.5 7M3.5 12.5h9')
		await expectFullyContained(mode, viewport)
		await expect.poll(async () => (await surface.boundingBox())?.height ?? 0).toBeLessThanOrEqual(60)
		await expect.poll(() => page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	})
}

test('composer actions stay hittable as focus moves and return to the compact row afterward', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const surface = page.locator('.remote-compose-surface')
	const message = page.getByLabel('Message', { exact: true })
	const more = page.getByRole('button', { name: 'More', exact: true })
	await more.click()
	await expect(page.getByRole('dialog', { name: 'More' })).toBeVisible()
	await expect.poll(async () => (await surface.boundingBox())?.height ?? 0).toBeLessThanOrEqual(60)
	await page.keyboard.press('Escape')
	await message.fill('Ready to send')
	await expect.poll(async () => (await surface.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(96)
	await more.click()
	await expect(page.getByRole('dialog', { name: 'More' })).toBeVisible()
	await expect.poll(async () => (await surface.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(96)
	await page.keyboard.press('Escape')
	await more.press('Tab')
	await expect(page.getByRole('button', { name: /Message delivery:/ })).toBeFocused()
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect
		.poll(() =>
			page.evaluate(
				() => window.__remoteFixture?.commands.filter(command => command.operation.kind === 'prompt').length,
			),
		)
		.toBe(1)
	await expect.poll(async () => (await surface.boundingBox())?.height ?? 0).toBeLessThanOrEqual(60)
})

test.describe('touch composer actions', () => {
	test.use({ hasTouch: true })
	test('compact delivery opens and switches mode by touch without editor focus', async ({ page }) => {
		const viewport = { width: 320, height: 420 }
		await page.setViewportSize(viewport)
		await page.goto(path)
		await page.getByRole('button', { name: /Helm conversation/ }).tap()
		const message = page.getByLabel('Message', { exact: true })
		const mode = page.getByRole('button', { name: 'Message delivery: During work' })
		await expect(message).not.toBeFocused()
		await mode.tap()
		await expectFullyContained(page.getByRole('menu', { name: 'Message delivery: During work' }), viewport)
		await page.getByRole('menuitemradio', { name: 'Follow up after current work' }).tap()
		await expect(page.getByRole('button', { name: 'Message delivery: Follow-up' })).toBeVisible()
		await expect(message).not.toBeFocused()
		await expect.poll(() => page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	})
	test('Send and delivery remain tappable after editor focus expands the capsule', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await page.goto(path)
		await page.getByRole('button', { name: /Helm conversation/ }).tap()
		const message = page.getByLabel('Message', { exact: true })
		await message.fill('Touch send')
		await page.getByRole('button', { name: /Message delivery:/ }).tap()
		await page.getByRole('menuitemradio', { name: 'Follow up after current work' }).tap()
		await page.getByRole('button', { name: 'Send', exact: true }).tap()
		await expect
			.poll(() => page.evaluate(() => window.__remoteFixture?.commands.map(command => command.operation)))
			.toEqual([{ kind: 'prompt', text: 'Touch send', delivery: 'followUp' }])
	})
})

test('focused composer follows the visual keyboard edge when WebKit dvh leaves a gap', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.addInitScript(() => {
		const viewport = Object.assign(new EventTarget(), {
			height: 844,
			width: 390,
			offsetTop: 0,
			offsetLeft: 0,
			pageTop: 0,
			pageLeft: 0,
			scale: 1,
		})
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
	})
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	// Model the installed-PWA failure: keyboard is at 520px, but 100dvh resolves to 390px.
	await page.addStyleTag({ content: '.remote-workspace { height: var(--remote-keyboard-height, 390px) !important; }' })
	const message = page.getByLabel('Message', { exact: true })
	const workspace = page.locator('.remote-workspace')
	const keyboardHeight = () => workspace.evaluate(node => node.style.getPropertyValue('--remote-keyboard-height'))
	const surface = page.locator('.remote-compose-surface')
	const gap = (visibleBottom: number) =>
		surface.evaluate((node, bottom) => bottom - node.getBoundingClientRect().bottom, visibleBottom)
	await message.focus()
	// Focus with a hardware keyboard alone must not switch away from the CSS viewport.
	await expect.poll(keyboardHeight).toBe('')
	await page.evaluate(() => {
		const viewport = window.visualViewport
		if (!viewport) throw new Error('Missing visual viewport')
		// Some installed WebKit builds publish offsetTop one frame after resize.
		Object.assign(viewport, { height: 500, offsetTop: 0 })
		viewport.dispatchEvent(new Event('resize'))
		requestAnimationFrame(() => Object.assign(viewport, { offsetTop: 20 }))
	})
	await expect.poll(() => gap(520)).toBeGreaterThanOrEqual(8)
	await expect.poll(() => gap(520)).toBeLessThanOrEqual(28)
	await expect(message).toBeFocused()
	// Visual-viewport panning moves its bottom even without another resize.
	await page.evaluate(() => {
		const viewport = window.visualViewport
		if (!viewport) throw new Error('Missing visual viewport')
		Object.assign(viewport, { offsetTop: 40 })
		viewport.dispatchEvent(new Event('scroll'))
	})
	await expect.poll(() => gap(540)).toBeLessThanOrEqual(28)
	// The same correction keeps a too-tall CSS viewport out of the keyboard too.
	await page.addStyleTag({ content: '.remote-workspace { height: var(--remote-keyboard-height, 844px) !important; }' })
	await expect.poll(() => gap(540)).toBeGreaterThanOrEqual(8)
	await expect.poll(() => gap(540)).toBeLessThanOrEqual(28)
	// Blurring does not leave keyboard geometry behind in the conversation or directory.
	await message.evaluate(node => (node as HTMLTextAreaElement).blur())
	await expect.poll(keyboardHeight).toBe('')
	await message.focus()
	await expect.poll(() => gap(540)).toBeLessThanOrEqual(28)
	await page.evaluate(() => {
		const viewport = window.visualViewport
		if (!viewport) throw new Error('Missing visual viewport')
		Object.assign(viewport, { height: 844, offsetTop: 0 })
		viewport.dispatchEvent(new Event('resize'))
	})
	await expect.poll(keyboardHeight).toBe('')
})

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
	await page.getByLabel('Message', { exact: true }).focus()
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
		await expect(jump).toHaveCSS('backdrop-filter', 'blur(12px)')
		const glass = await jump.evaluate(node => ({
			border: getComputedStyle(node).borderWidth,
			shadow: getComputedStyle(node).boxShadow,
			pointerEvents: getComputedStyle(node).pointerEvents,
		}))
		expect(glass.border).toBe('0px')
		expect(glass.shadow.match(/inset/g)).toHaveLength(2)
		expect(glass.pointerEvents).toBe('auto')
		await expect(page.locator('.remote-jump')).toHaveCSS('pointer-events', 'none')
		expect(await transcript.boundingBox()).toEqual(before)
		expect(await page.locator('.remote-composer').boundingBox()).toEqual(composerBefore)
		const bounds = await jump.boundingBox()
		if (!bounds || !before) throw new Error('Missing layout')
		expect(bounds.y + bounds.height).toBeLessThan(before.y + before.height)
		if (!composerBefore) throw new Error('Missing composer geometry')
		expect(bounds.y + bounds.height).toBeLessThanOrEqual(composerBefore.y - 11)
		expect(bounds.y).toBeGreaterThan(before.y)
		await jump.click()
		await expect(jump).toHaveCount(0)
	})
}

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 320, height: 420 },
]) {
	test(`floating composer tracks a growing draft and keeps the reading tail clear at ${viewport.width}x${viewport.height}`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport)
		await page.goto(path)
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const message = page.getByLabel('Message', { exact: true })
		await message.fill(SIX_LINE_DRAFT)
		const measure = () =>
			page.evaluate(() => {
				const stage = document.querySelector<HTMLElement>('.remote-reading-stage')
				const composer = document.querySelector<HTMLElement>('.remote-composer')
				const reading = document.querySelector<HTMLElement>('.remote-reading-area')
				const surface = document.querySelector<HTMLElement>('.remote-compose-surface')
				const transcript = document.querySelector<HTMLElement>('.remote-transcript')
				if (!stage || !composer || !reading || !surface || !transcript) throw new Error('Missing chat layout')
				transcript.scrollTop = transcript.scrollHeight
				return {
					measuredHeight: Number.parseFloat(stage.style.getPropertyValue('--remote-composer-overlap')),
					actualHeight: composer.getBoundingClientRect().height,
					readingBottom: reading.getBoundingClientRect().bottom,
					composerBottom: composer.getBoundingClientRect().bottom,
					tailBottom: transcript.querySelector<HTMLElement>('.remote-message:last-of-type')?.getBoundingClientRect()
						.bottom,
					surfaceTop: surface.getBoundingClientRect().top,
				}
			})
		await expect.poll(async () => (await measure()).measuredHeight).toBeGreaterThan(76)
		const geometry = await measure()
		expect(geometry.measuredHeight).toBeCloseTo(Math.ceil(geometry.actualHeight), 1)
		expect(geometry.readingBottom).toBeCloseTo(geometry.composerBottom, 1)
		expect(geometry.tailBottom).toBeLessThanOrEqual(geometry.surfaceTop - 20)
		await expectFullyContained(page.locator('.remote-compose-surface'), viewport)
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
	await openRemoteDestination(page, 'Sessions')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(mode).toBeVisible()
	await message.focus()
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
	await expect(trigger.locator('svg path')).toHaveAttribute('d', 'M6.5 4 3 7.5 6.5 11M3.5 7.5H9a4 4 0 0 1 4 4')
	await trigger.click()
	await expect(page.getByRole('menuitemradio', { name: 'Steer at the next safe point' })).toBeChecked()
	await page.keyboard.press('Escape')
	await expect(trigger).toBeFocused()
	await trigger.click()
	await page.getByRole('menuitemradio', { name: 'Follow up after current work' }).click()
	const followUpTrigger = page.getByRole('button', { name: 'Message delivery: Follow-up' })
	await expect(followUpTrigger).toHaveText('')
	await expect(followUpTrigger.locator('svg path')).toHaveAttribute('d', 'M8 2.5v7M5.5 7 8 9.5 10.5 7M3.5 12.5h9')
	await expect.poll(() => page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	await page.getByRole('button', { name: 'Message delivery: Follow-up' }).click()
	await expect(page.getByRole('menuitemradio', { name: 'Follow up after current work' })).toBeChecked()
	await page.getByRole('menuitemradio', { name: 'Steer at the next safe point' }).click()
	await expect(trigger.locator('svg path')).toHaveAttribute('d', 'M6.5 4 3 7.5 6.5 11M3.5 7.5H9a4 4 0 0 1 4 4')
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
	await expect(page.locator('.remote-information-footer')).toHaveCount(0)
	await expect(composer).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
	await expectFullyContained(composer, viewport)
	await expectFullyContained(message, viewport)
	await expectFullyContained(actions, viewport)
	await expectFullyContained(send, viewport)
	await expectFullyContained(delivery, viewport)
	await expectFullyContained(interrupt, viewport)
	await message.focus()
	await expectFullyContained(delivery, viewport)
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
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Info', exact: true }).click()
}
