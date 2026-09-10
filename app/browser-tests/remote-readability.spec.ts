import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
	}
}

const path = '/iframe.html?id=views-helm-remote--readability&viewMode=story'
const LONG_IDENTITY = 'release-workspace-with-a-long-name-for-readability-suffix-z9'
const SIX_LINE_DRAFT =
	'A longer thought\nwith several lines\nthat should grow\ninside one surface\nand then scroll\nwithout moving actions away'

async function expectFullyContained(locator: Locator, viewport: { width: number; height: number }) {
	const box = await locator.boundingBox()
	expect(box).not.toBeNull()
	if (!box) return
	expect(box.x).toBeGreaterThanOrEqual(-1)
	expect(box.y).toBeGreaterThanOrEqual(-1)
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
	expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
}

async function expectHittableMenuEntry(locator: Locator, viewport: { width: number; height: number }) {
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
	page: Page,
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

async function swipeTouch(page: Page, box: { x: number; y: number; width: number; height: number }) {
	const client = await page.context().newCDPSession(page)
	const x = box.x + box.width / 2
	const startY = box.y + box.height - 8
	const endY = box.y + 8
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ id: 1, x, y: startY, radiusX: 4, radiusY: 4, force: 1 }],
	})
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchMove',
		touchPoints: [{ id: 1, x, y: endY, radiusX: 4, radiusY: 4, force: 1 }],
	})
	await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
	await client.detach()
}

async function loadReadability(page: Page) {
	await page.goto(path)
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await expect(page.locator('.remote-session-row')).toHaveCount(3)
}

async function loadRowDensity(page: Page) {
	await page.goto('/iframe.html?id=views-helm-remote--row-density&viewMode=story')
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await expect(page.locator('.remote-session-row')).toHaveCount(6)
}

async function useLongNativeIdentity(page: Page) {
	await page.evaluate(name => {
		if (!window.__remoteFixture) throw new Error('Expected native fixture')
		window.__remoteFixture.showTerminalMetadataExample(name)
		document.dispatchEvent(new Event('visibilitychange'))
	}, LONG_IDENTITY)
	await expect(page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' })).toContainText(LONG_IDENTITY)
}

test('session rows stay compact for repeated unavailable sources and grow with rich metadata', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await loadRowDensity(page)

	const rows = page.locator('.remote-session-row')
	const unavailable = rows.filter({ hasText: 'Source unavailable' })
	const rich = rows.filter({ hasText: 'Source: Okena' })
	await expect(unavailable).toHaveCount(4)
	await expect(unavailable.locator('.remote-session-context')).toHaveCount(0)
	await expect(unavailable.locator('.remote-session-branch')).toHaveCount(0)
	await expect(unavailable.locator('.remote-session-primary')).toHaveCount(4)
	await expect(unavailable.locator('.remote-session-source')).toHaveCount(4)
	await expect(rich).toHaveCount(1)
	await expect(rich).toContainText('Group: Contember')
	await expect(rich).toContainText('Project: JVS')
	await expect(rich).toContainText('Branch: docs/mobile-phase-0')

	const compactMetrics = await unavailable.evaluateAll(values =>
		values.map(row => {
			const info = row.querySelector('.remote-session-info')
			const chip = row.querySelector('.chip')
			if (!info || !chip) throw new Error('Session row is missing its info or shared Chip')
			const rowBox = row.getBoundingClientRect()
			const infoBox = info.getBoundingClientRect()
			const style = getComputedStyle(row)
			const chipStyle = getComputedStyle(chip)
			return {
				height: rowBox.height,
				width: rowBox.width,
				infoHeight: infoBox.height,
				minHeight: style.minHeight,
				paddingTop: style.paddingTop,
				paddingBottom: style.paddingBottom,
				borderRadius: style.borderRadius,
				chipRadius: chipStyle.borderRadius,
				chipPadding: chipStyle.padding,
			}
		}),
	)
	const listWidth = await page.locator('.remote-session-list').evaluate(node => node.getBoundingClientRect().width)
	for (const metric of compactMetrics) {
		expect(metric.minHeight).toBe('44px')
		expect(metric.height).toBeGreaterThanOrEqual(44)
		expect(metric.height).toBeLessThan(88)
		expect(metric.height - metric.infoHeight).toBeCloseTo(16, 0)
		expect(metric.paddingTop).toBe('8px')
		expect(metric.paddingBottom).toBe('8px')
		expect(metric.borderRadius).toBe('0px')
		expect(metric.width).toBeCloseTo(listWidth, 0)
		expect(metric.chipRadius).toBe('999px')
		expect(metric.chipPadding).toBe('2px 8px')
	}

	const richMetric = await rich.evaluate(row => {
		const info = row.querySelector('.remote-session-info')
		if (!info) throw new Error('Rich session row is missing its info')
		return {
			height: row.getBoundingClientRect().height,
			infoHeight: info.getBoundingClientRect().height,
			paddingTop: getComputedStyle(row).paddingTop,
			paddingBottom: getComputedStyle(row).paddingBottom,
		}
	})
	expect(richMetric.infoHeight).toBeGreaterThan(compactMetrics[0]?.infoHeight ?? 0)
	expect(richMetric.height).toBeGreaterThan(compactMetrics[0]?.height ?? 0)
	expect(richMetric.height - richMetric.infoHeight).toBeCloseTo(16, 0)
	expect(richMetric.height).not.toBe(88)
	expect(richMetric.paddingTop).toBe('8px')
	expect(richMetric.paddingBottom).toBe('8px')
})

for (const width of [320, 390, 1280]) {
	test(`source and status remain readable and reachable at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 844 })
		await loadReadability(page)

		const okena = page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' })
		const helm = page.locator('.remote-session-row').filter({ hasText: 'Source: Helm' })
		const unavailable = page.locator('.remote-session-row').filter({ hasText: 'Source unavailable' })
		await expect(okena).toContainText('Ready')
		await expect(okena).toContainText('Project: JVS')
		await expect(okena).toContainText('Branch: docs/mobile-phase-0')
		await expect(helm).toContainText('Needs you')
		await expect(unavailable).toContainText('Working')
		await expect(unavailable).toContainText(LONG_IDENTITY)
		await expect(unavailable).not.toContainText('Pi session')
		await expect(okena.locator('.chip')).toHaveCount(1)
		await expect(okena.locator('.chip')).not.toHaveAttribute('role', 'button')
		await expect(okena.locator('.chip')).not.toHaveAttribute('tabindex')
		await expect(page.locator('.remote-session-row .chip')).toHaveCount(3)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

		if (width === 390) {
			await unavailable.focus()
			await unavailable.press('Enter')
			await expect(page.getByRole('heading', { name: LONG_IDENTITY })).toBeVisible()
			await page.getByRole('button', { name: 'Back to live conversations', exact: true }).focus()
			await page.getByRole('button', { name: 'Back to live conversations', exact: true }).press('Enter')
			await expect(unavailable).toBeFocused()
		} else {
			await page.screenshot({ path: testInfo.outputPath(`remote-readability-${width}.png`) })
		}
	})
}

for (const viewport of [
	{ width: 320, height: 844 },
	{ width: 390, height: 844 },
	{ width: 390, height: 420 },
]) {
	test(`long detail identity wraps fully at ${viewport.width}x${viewport.height}`, async ({ page }) => {
		await page.setViewportSize(viewport)
		await loadReadability(page)
		await page.locator('.remote-session-row').filter({ hasText: LONG_IDENTITY }).click()
		const detail = page.getByRole('region', { name: 'Conversation' })
		const heading = detail.getByRole('heading', { name: LONG_IDENTITY })
		await expect(heading).toBeVisible()
		const geometry = await heading.evaluate((node, suffix) => {
			const style = getComputedStyle(node)
			const textNode = Array.from(node.childNodes).find(child => child.nodeType === Node.TEXT_NODE)
			if (!textNode || !textNode.textContent) throw new Error('Detail heading has no text node')
			const range = document.createRange()
			const start = textNode.textContent.length - suffix.length
			range.setStart(textNode, start)
			range.setEnd(textNode, textNode.textContent.length)
			const box = node.getBoundingClientRect()
			const suffixBox = range.getBoundingClientRect()
			const lineHeight = Number.parseFloat(style.lineHeight)
			return {
				height: box.height,
				lineHeight,
				whiteSpace: style.whiteSpace,
				overflow: style.overflow,
				textOverflow: style.textOverflow,
				wraps: box.height > lineHeight * 1.5,
				suffixVisible:
					suffixBox.top >= box.top - 1 &&
					suffixBox.bottom <= box.bottom + 1 &&
					suffixBox.left >= box.left - 1 &&
					suffixBox.right <= box.right + 1,
			}
		}, 'suffix-z9')
		expect(geometry.whiteSpace).toBe('normal')
		expect(geometry.overflow).toBe('visible')
		expect(geometry.textOverflow).toBe('clip')
		expect(geometry.wraps).toBe(true)
		expect(geometry.suffixVisible).toBe(true)
		await expectFullyContained(
			detail.getByRole('button', { name: 'Back to live conversations', exact: true }),
			viewport,
		)
		await expectFullyContained(detail.getByRole('button', { name: 'Interrupt', exact: true }), viewport)
		await expectFullyContained(detail.getByRole('button', { name: 'Conversation options', exact: true }), viewport)
		const composerBox = await detail.locator('.remote-composer').boundingBox()
		expect(composerBox).not.toBeNull()
		if (composerBox) expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(viewport.height + 1)
	})
}

for (const height of [420, 480, 560]) {
	test(`metadata-rich detail keeps controls, reading action, and composer reachable at 390x${height}`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height })
		await loadReadability(page)
		await page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' }).click()
		const detail = page.getByRole('region', { name: 'Conversation' })
		await expect(detail.getByRole('heading', { name: 'feat/mobile', exact: true })).toBeVisible()
		await expect(detail.locator('.remote-session-source')).toHaveText('Source: Okena')
		await expect(detail.locator('.remote-session-context')).toHaveText('Group: Contember · Project: JVS')
		await expect(detail.locator('.remote-session-branch')).toHaveText('Branch: docs/mobile-phase-0')
		await expect(detail.getByText('Model: openai-codex/gpt-model', { exact: true })).toBeVisible()
		await expect(detail.locator('.remote-meta .chip')).toHaveText('Ready')
		await expectFullyContained(detail.getByRole('button', { name: 'Back to live conversations', exact: true }), {
			width: 390,
			height,
		})
		await expectFullyContained(detail.getByRole('button', { name: 'Conversation options', exact: true }), {
			width: 390,
			height,
		})

		const reading = detail.locator('.remote-reading-area')
		const readingBefore = await reading.boundingBox()
		const minimumReadingHeight = Math.max(56, Math.min(96, height * 0.15))
		expect(readingBefore?.height).toBeGreaterThanOrEqual(minimumReadingHeight - 1)
		const composer = detail.locator('.remote-composer')
		const composerBox = await composer.boundingBox()
		expect(composerBox).not.toBeNull()
		if (composerBox) expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(height + 1)

		await detail.getByLabel('Conversation messages').evaluate(node => node.scrollTo(0, node.scrollHeight / 2))
		const jump = detail.getByRole('button', { name: 'Jump to latest' })
		await expect(jump).toBeVisible()
		await expect(jump).toBeInViewport()
		const jumpBox = await jump.boundingBox()
		const readingAfter = await reading.boundingBox()
		expect(readingAfter).toEqual(readingBefore)
		expect(jumpBox).not.toBeNull()
		if (jumpBox && readingAfter) {
			expect(jumpBox.y).toBeGreaterThanOrEqual(readingAfter.y - 1)
			expect(jumpBox.y + jumpBox.height).toBeLessThanOrEqual(readingAfter.y + readingAfter.height + 1)
		}
	})
}

test('metadata-rich Okena detail keeps full composer and metadata reachable for an empty and six-line draft', async ({
	page,
}) => {
	const viewport = { width: 390, height: 420 }
	await page.setViewportSize(viewport)
	await loadReadability(page)
	await page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' }).click()
	const detail = page.getByRole('region', { name: 'Conversation' })
	const message = detail.getByLabel('Message', { exact: true })
	const composer = detail.locator('.remote-composer')
	const surface = detail.locator('.remote-compose-surface')
	const actions = detail.locator('.remote-composer-actions')
	const send = detail.getByRole('button', { name: 'Send', exact: true })
	const delivery = detail.getByRole('button', { name: 'Message delivery' })
	const metadata = detail.locator('.remote-meta')
	const source = detail.locator('.remote-session-source')
	const context = detail.locator('.remote-session-context')
	const branch = detail.locator('.remote-session-branch')
	const model = detail.getByText('Model: openai-codex/gpt-model', { exact: true })
	await expect(source).toHaveText('Source: Okena')
	await expect(context).toHaveText('Group: Contember · Project: JVS')
	await expect(branch).toHaveText('Branch: docs/mobile-phase-0')
	await expect(model).toBeVisible()
	await expect(detail.locator('.remote-meta .chip')).toHaveText('Ready')
	await expectFullyContained(metadata, viewport)
	await expectFullyContained(composer, viewport)
	await expectFullyContained(message, viewport)
	await expectFullyContained(actions, viewport)
	await expectFullyContained(send, viewport)
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
	await expectFullyContained(metadata, viewport)
	await expectFullyContained(composer, viewport)
	await expectFullyContained(surface, viewport)
	await expectFullyContained(message, viewport)
	await expectFullyContained(actions, viewport)
	await expectFullyContained(send, viewport)
	await expectFullyContained(delivery, viewport)
	await expectFullyContained(detail.getByRole('button', { name: 'Back to live conversations', exact: true }), viewport)
	await expectFullyContained(detail.getByRole('button', { name: 'Conversation options', exact: true }), viewport)
	await expect(metadata).toHaveAttribute('tabindex', '0')
	await metadata.focus()
	await metadata.press('End')
	await expect(metadata).toBeFocused()
	await expectFullyContained(model, viewport)
	expect(
		await detail.getByLabel('Conversation messages').evaluate(node => node.getBoundingClientRect().height),
	).toBeGreaterThanOrEqual(96)

	for (const target of [branch, model]) {
		await target.scrollIntoViewIfNeeded()
		const metadataBox = await metadata.boundingBox()
		const targetBox = await target.boundingBox()
		expect(metadataBox).not.toBeNull()
		expect(targetBox).not.toBeNull()
		if (metadataBox && targetBox) {
			expect(targetBox.y).toBeGreaterThanOrEqual(metadataBox.y - 1)
			expect(targetBox.y + targetBox.height).toBeLessThanOrEqual(metadataBox.y + metadataBox.height + 1)
		}
	}

	const reading = detail.locator('.remote-reading-area')
	const readingBefore = await reading.boundingBox()
	await detail.getByLabel('Conversation messages').evaluate(node => node.scrollTo(0, node.scrollHeight / 2))
	const jump = detail.getByRole('button', { name: 'Jump to latest' })
	await expect(jump).toBeVisible()
	await expectFullyContained(jump, viewport)
	const readingAfter = await reading.boundingBox()
	expect(readingAfter).toEqual(readingBefore)
})

test('compact native-rich long identity and source-unavailable details keep empty and typed composers contained', async ({
	page,
}, testInfo) => {
	const viewport = { width: 390, height: 420 }
	await page.setViewportSize(viewport)
	await loadReadability(page)
	await useLongNativeIdentity(page)

	const verify = async (detail: Locator, source: string, caseName: string) => {
		await expect(detail.locator('.remote-session-source')).toHaveText(source)
		const message = detail.getByLabel('Message', { exact: true })
		const composer = detail.locator('.remote-composer')
		const surface = detail.locator('.remote-compose-surface')
		const actions = detail.locator('.remote-composer-actions')
		const send = detail.getByRole('button', { name: 'Send', exact: true })
		const delivery = detail.getByRole('button', { name: 'Message delivery' })
		const reading = detail.locator('.remote-reading-area')
		await expectFullyContained(composer, viewport)
		await expectFullyContained(surface, viewport)
		await expectFullyContained(actions, viewport)
		await expectFullyContained(send, viewport)
		await expectFullyContained(delivery, viewport)
		expect(await composer.evaluate(node => getComputedStyle(node).overflow)).toBe('visible')
		expect(await surface.evaluate(node => getComputedStyle(node).overflow)).toBe('visible')
		expect((await reading.boundingBox())?.height).toBeGreaterThanOrEqual(96)
		await page.screenshot({ path: testInfo.outputPath(`${caseName}-empty.png`) })

		await message.fill(SIX_LINE_DRAFT)
		await expect.poll(() => message.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(40)
		const metrics = await message.evaluate(node => ({
			height: node.getBoundingClientRect().height,
			clientHeight: node.clientHeight,
			scrollHeight: node.scrollHeight,
			overflowY: getComputedStyle(node).overflowY,
		}))
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
		expect(metrics.overflowY).toBe('auto')
		await expectFullyContained(composer, viewport)
		await expectFullyContained(surface, viewport)
		await expectFullyContained(actions, viewport)
		await expectFullyContained(send, viewport)
		await expectFullyContained(delivery, viewport)
		expect(await actions.evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(56, 0)
		await openAndSelectDelivery(page, viewport, 'Follow up after current work', 'pointer')
		await page.screenshot({ path: testInfo.outputPath(`${caseName}-typed.png`) })
	}

	const nativeRow = page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' })
	await nativeRow.click()
	const nativeDetail = page.getByRole('region', { name: 'Conversation' })
	await expect(nativeDetail.getByRole('heading', { name: LONG_IDENTITY, exact: true })).toBeVisible()
	await expect(nativeDetail.locator('.remote-session-context')).toContainText('Project: JVS')
	await expect(nativeDetail.locator('.remote-session-branch')).toContainText('docs/mobile-phase-0')
	await verify(nativeDetail, 'Source: Okena', 'combined-native-long')
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	const longRow = page.locator('.remote-session-row').filter({ hasText: 'Source unavailable' })
	await longRow.click()
	const longDetail = page.getByRole('region', { name: 'Conversation' })
	await expect(longDetail.getByRole('heading', { name: LONG_IDENTITY, exact: true })).toBeVisible()
	await verify(longDetail, 'Source unavailable', 'unavailable-long')
})

test.describe('compact touch input', () => {
	test.use({ hasTouch: true })

	test('native-rich long identity scrolls metadata by touch and keeps menu rows hittable after growth', async ({
		page,
	}) => {
		const viewport = { width: 390, height: 420 }
		await page.setViewportSize(viewport)
		await loadReadability(page)
		await useLongNativeIdentity(page)
		await page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' }).tap()
		const detail = page.getByRole('region', { name: 'Conversation' })
		const metadata = detail.locator('.remote-meta')
		const before = await metadata.evaluate(node => ({
			scrollTop: node.scrollTop,
			scrollHeight: node.scrollHeight,
			clientHeight: node.clientHeight,
		}))
		expect(before.scrollHeight).toBeGreaterThan(before.clientHeight)
		const metadataBox = await metadata.boundingBox()
		expect(metadataBox).not.toBeNull()
		if (!metadataBox) return
		await swipeTouch(page, metadataBox)
		await expect.poll(() => metadata.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
		const model = detail.getByText('Model: openai-codex/gpt-model', { exact: true })
		await expectFullyContained(model, viewport)
		await openAndSelectDelivery(page, viewport, 'Steer at the next safe point', 'touch')
		await expect(detail.getByRole('button', { name: 'Message delivery' })).toHaveText(/During work/)

		const message = detail.getByLabel('Message', { exact: true })
		await message.fill(SIX_LINE_DRAFT)
		await expect.poll(() => message.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(40)
		await openAndSelectDelivery(page, viewport, 'Follow up after current work', 'touch')
		await expect(detail.getByRole('button', { name: 'Message delivery' })).toHaveText(/Follow-up/)
		await expectFullyContained(detail.locator('.remote-composer'), viewport)
		await expectFullyContained(detail.locator('.remote-composer-actions'), viewport)
		await expectFullyContained(detail.getByRole('button', { name: 'Send', exact: true }), viewport)
	})
})

test('source, raw labels and workspace remain searchable without changing the full identity draft', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await loadReadability(page)
	const search = page.getByRole('searchbox')
	const okena = page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' })
	await search.fill('JVS')
	await expect(okena).toBeVisible()
	await search.fill('docs/mobile-phase-0')
	await expect(okena).toBeVisible()
	await search.fill('divoka kremrole')
	await expect(okena).toBeVisible()
	await search.fill('release-workspace-with-a-long-name')
	await expect(page.locator('.remote-session-row')).toHaveCount(1)
	await search.fill('Pi session')
	const sourceUnavailable = page.locator('.remote-session-row').filter({ hasText: 'Source unavailable' })
	await expect(sourceUnavailable).toHaveCount(1)
	await expect(sourceUnavailable).toContainText(LONG_IDENTITY)

	await search.fill('JVS')
	await okena.click()
	await page.getByLabel('Message', { exact: true }).fill('Keep this exact owner draft')
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await search.fill('')
	await page.locator('.remote-session-row').filter({ hasText: 'Source: Helm' }).click()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await okena.click()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this exact owner draft')
})

test('detail uses the same source and status truth and exposes disconnected as a neutral badge', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await loadReadability(page)
	const okena = page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' })
	await okena.click()
	const detail = page.getByRole('region', { name: 'Conversation' })
	await expect(detail.locator('.remote-session-source')).toHaveText('Source: Okena')
	await expect(detail.locator('.remote-session-branch')).toHaveText('Branch: docs/mobile-phase-0')
	await expect(detail.locator('.remote-session-info-detail .chip')).toHaveText('Ready')
	await expect(detail.getByText('Model: openai-codex/gpt-model', { exact: true })).toBeVisible()
	await expect(detail.locator('.remote-session-info-detail .chip')).not.toHaveAttribute('role', 'button')

	await page.evaluate(() => {
		window.__remoteFixture?.setOnline(false)
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(detail.locator('.remote-session-info-detail .chip')).toHaveText('Disconnected')
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await expect(page.locator('.remote-session-row .chip')).toHaveCount(3)
	await expect(page.locator('.remote-session-row .chip').first()).toHaveText('Disconnected')
})

test.describe('touch activation', () => {
	test.use({ hasTouch: true })

	test('reaches the same pushed detail without changing the source presentation', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await loadReadability(page)
		const helm = page.locator('.remote-session-row').filter({ hasText: 'Source: Helm' })
		await helm.tap()
		const detail = page.getByRole('region', { name: 'Conversation' })
		await expect(detail.locator('.remote-session-source')).toHaveText('Source: Helm')
		await expect(detail.locator('.remote-session-info-detail .chip')).toHaveText('Needs you')
		await expectFullyContained(page.getByRole('button', { name: 'Back to live conversations', exact: true }), {
			width: 390,
			height: 844,
		})
	})
})
