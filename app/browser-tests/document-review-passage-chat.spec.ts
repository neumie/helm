import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type {} from '../src/renderer/document-review/DocumentReview.stories'

const excerpt = 'The selected owner must remain exact.'
const bubble = (page: Page) => page.locator('.review-passage-editor')
async function open(page: Page, story = 'reading') {
	await page.goto(`/iframe.html?id=views-document-review--${story}&viewMode=story`)
	await expect(
		page.getByRole('heading', { name: story === 'interactive-canvas' ? 'proposal.jsx' : 'spec.md', exact: true }),
	).toBeVisible()
}
async function select(page: Page, selector = '.review-block-text p', quote = excerpt, reverse = false) {
	const paragraph = page.locator(selector).filter({ hasText: quote }).first()
	await paragraph.scrollIntoViewIfNeeded()
	const points = await paragraph.evaluate((element, quote) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
		let first = walker.nextNode()
		while (first && !first.textContent?.includes(quote)) first = walker.nextNode()
		if (!first) throw new Error('Missing exact selection text')
		const start = first.textContent?.indexOf(quote) ?? 0
		const rect = (offset: number) => {
			const range = document.createRange()
			range.setStart(first, offset)
			range.setEnd(first, offset + 1)
			return range.getBoundingClientRect().toJSON()
		}
		return { first: rect(start), last: rect(start + quote.length - 1) }
	}, quote)
	const first = { x: points.first.x + 1, y: points.first.y + points.first.height / 2 }
	const last = { x: points.last.x + points.last.width - 1, y: points.last.y + points.last.height / 2 }
	await page.mouse.move(reverse ? last.x : first.x, reverse ? last.y : first.y)
	await page.mouse.down()
	await page.mouse.move(reverse ? first.x : last.x, reverse ? first.y : last.y, { steps: 12 })
	await page.mouse.up()
	await expect(bubble(page)).toBeVisible()
	await expect(bubble(page).getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
}
async function sendPassage(page: Page, text: string) {
	await bubble(page).getByRole('textbox', { name: 'Passage instruction' }).fill(text)
	await bubble(page).getByRole('button', { name: 'Send passage discussion', exact: true }).click()
}

for (const viewport of [
	{ width: 1197, height: 807 },
	{ width: 640, height: 520 },
]) {
	for (const story of ['reading', 'light']) {
		test(`${story}: selection opens editable passage chat on the document at ${viewport.width}x${viewport.height}`, async ({
			page,
		}, testInfo) => {
			await page.setViewportSize(viewport)
			await open(page, story)
			if (viewport.width > 900)
				await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Keep the entire-document draft')
			await select(page)
			await page.keyboard.type('My passage question')
			await expect(bubble(page).getByRole('textbox')).toHaveValue('My passage question')
			await expect(bubble(page).locator('blockquote')).toHaveCount(0)
			await expect(page.locator('.review-document-pane')).toBeVisible()
			const bounds = await bubble(page).boundingBox()
			const send = await bubble(page).getByRole('button', { name: 'Send passage discussion' }).boundingBox()
			expect(bounds).not.toBeNull()
			expect(send).not.toBeNull()
			if (!bounds || !send) throw new Error('Missing visible bubble controls')
			expect(bounds.width).toBeLessThanOrEqual(560)
			if (viewport.width > 900) expect(bounds.width).toBe(560)
			expect(bounds.height).toBeLessThan(300) // No empty transcript reserve before the first message.
			expect(bounds.y).toBeGreaterThanOrEqual(64)
			expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 16)
			expect(send.y + send.height).toBeLessThanOrEqual(bounds.y + bounds.height)
			await bubble(page).getByRole('button', { name: 'Writing options', exact: true }).click()
			await expect(bubble(page).getByRole('menuitem', { name: 'Save local comment', exact: true })).toBeVisible()
			await page.keyboard.press('Escape')
			await expect(bubble(page)).toBeVisible() // Escape closes the nested menu first.
			await page.screenshot({ path: testInfo.outputPath(`passage-${viewport.width}x${viewport.height}.png`) })
			await page.keyboard.press('Escape')
			await expect(bubble(page)).toHaveCount(0)
			await expect(page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })).toHaveValue(
				viewport.width > 900 ? 'Keep the entire-document draft' : '',
			)
			await select(page)
			await expect(bubble(page).getByRole('textbox')).toHaveValue('My passage question')
			expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
		})
	}
}

for (const story of ['passage-long-reply', 'passage-long-reply-light'])
	for (const viewport of [
		{ width: 1197, height: 807 },
		{ width: 900, height: 600 },
		{ width: 640, height: 520 },
	])
		test(`${story}: long replies have reading room and visible writing at ${viewport.width}x${viewport.height}`, async ({
			page,
		}, info) => {
			await page.setViewportSize(viewport)
			await open(page, story)
			await page.getByRole('button', { name: 'Show passage conversation', exact: true }).first().click()
			const panel = bubble(page)
			const messages = panel.getByRole('region', { name: 'Passage messages' })
			const editor = panel.getByRole('textbox', { name: 'Passage instruction' })
			await expect(editor).toBeFocused()
			await editor.fill('Keep this passage draft while reading')
			const geometry = await panel.evaluate(element => {
				const messages = element.querySelector('.review-passage-bubble-messages') as HTMLElement
				const editor = element.querySelector('textarea') as HTMLElement
				const send = element.querySelector('.review-compose-actions > .btn:last-child') as HTMLElement
				const text = messages.querySelector('.review-message div')
				if (!text) throw new Error('Missing reply text')
				return {
					panel: element.getBoundingClientRect().toJSON(),
					messages: messages.getBoundingClientRect().toJSON(),
					editor: editor.getBoundingClientRect().toJSON(),
					send: send.getBoundingClientRect().toJSON(),
					overflow: messages.scrollHeight > messages.clientHeight,
					font: getComputedStyle(text).fontSize,
				}
			})
			expect(geometry.panel.width).toBe(560)
			expect(geometry.panel.height).toBeGreaterThan(380)
			expect(geometry.panel.y).toBeGreaterThanOrEqual(64)
			expect(geometry.panel.bottom).toBeLessThanOrEqual(viewport.height - 16)
			expect(geometry.messages.height).toBeGreaterThan(viewport.height > 600 ? 320 : 160)
			expect(geometry.editor.height).toBeGreaterThanOrEqual(64)
			expect(geometry.send.bottom).toBeLessThanOrEqual(geometry.panel.bottom)
			expect(geometry.send.top).toBeGreaterThanOrEqual(geometry.messages.bottom)
			expect(geometry.font).toBe('15px')
			expect(geometry.overflow).toBe(true)
			await messages.focus()
			await page.keyboard.press('End')
			await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
			await expect(editor).toHaveValue('Keep this passage draft while reading')
			await panel.getByRole('button', { name: 'Writing options', exact: true }).click()
			await expect(panel.getByRole('menuitem', { name: 'Save local comment', exact: true })).toBeVisible()
			await page.keyboard.press('Escape')
			await expect(panel).toBeVisible()
			expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
			await page.screenshot({ path: info.outputPath(`${story}-${viewport.width}x${viewport.height}.png`) })
			await page.setViewportSize({ width: 640, height: 520 })
			await expect(editor).toHaveValue('Keep this passage draft while reading')
			await expect(panel).toBeVisible()
		})

test('passage sends/replies stay in the bubble; companion sends remain whole-document', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	const whole = page.getByRole('textbox', { name: 'Whole-document message' })
	await whole.fill('Discuss the entire specification')
	await select(page)
	await sendPassage(page, 'Only about this passage')
	await expect(bubble(page)).toContainText('Only about this passage')
	await page.evaluate(() => window.__helmDocumentReviewProof?.settle())
	await expect(bubble(page)).toContainText('This is a fixture reply to the chosen request.')
	await expect(page.locator('.review-companion')).not.toContainText('Only about this passage')
	await expect(whole).toHaveValue('Discuss the entire specification')
	await page.locator('.review-companion').getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(page.locator('.review-chat')).toContainText('Discuss the entire specification')
	const requests = await page.evaluate(() => window.__helmDocumentReviewProof?.requests)
	expect(requests?.[0]?.passage?.quote).toBe(excerpt)
	expect(requests?.[1]?.passage).toBeNull()
	expect(requests?.[1]?.instruction).toBe('Discuss the entire specification')
})

test('local passage save keeps the whole-document instruction and exact local note separate', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Whole-document draft')
	await select(page)
	await bubble(page).getByRole('textbox').fill('A local passage comment')
	await bubble(page).getByRole('button', { name: 'Writing options', exact: true }).click()
	await bubble(page).getByRole('menuitem', { name: 'Save local comment', exact: true }).click()
	await expect(bubble(page)).toContainText('Saved locally · not sent')
	await expect
		.poll(async () =>
			page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0]?.note),
		)
		.toBe('A local passage comment')
	expect(
		await page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.instruction),
	).toBe('Whole-document draft')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
})

test('idle existing passage markers open reply writing with only their own thread', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page, 'passage-conversations')
	await page.getByRole('button', { name: 'Show passage conversation', exact: true }).first().click()
	await expect(bubble(page)).toBeVisible()
	await expect(bubble(page).getByRole('textbox')).toBeFocused()
	await expect(bubble(page)).toContainText('What does reading-first mean?')
	await expect(bubble(page)).not.toContainText('Why do we retain the exact owner?')
	await expect(page.locator('.review-chat')).not.toContainText('What does reading-first mean?')
})

test('keyboard selection remains copyable until explicit Alt+Enter opens bubble writing', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	const reading = page.locator('.review-reading')
	await reading.focus()
	await page.evaluate(() => {
		const node = [...document.querySelectorAll('.review-block-text p')].find(node =>
			node.textContent?.startsWith('The selected owner'),
		)?.firstChild
		if (!node) throw new Error('Missing paragraph')
		const range = document.createRange()
		range.setStart(node, 0)
		range.setEnd(node, 3)
		window.getSelection()?.removeAllRanges()
		window.getSelection()?.addRange(range)
	})
	await page.keyboard.press('Shift+ArrowRight')
	await expect(bubble(page)).toHaveCount(0)
	await page.keyboard.press('Alt+Enter')
	await expect(bubble(page).getByRole('textbox')).toBeFocused()
})

test('API replacement fences a late send and does not publish success or replay', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	await page.evaluate(() => {
		const proof = window.__helmDocumentReviewProof
		if (!proof) throw new Error('Missing production fixture')
		const original = proof.api.send
		Reflect.set(window, '__releasePassageSend', () => {})
		proof.api.send = async request => {
			await new Promise<void>(resolve => Reflect.set(window, '__releasePassageSend', resolve))
			return original(request)
		}
	})
	await select(page)
	await sendPassage(page, 'Fence this delayed request')
	await page.evaluate(() => window.__helmDocumentReviewProof?.replaceApi())
	await expect(bubble(page)).toHaveCount(0)
	await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible()
	await page.evaluate(() => Reflect.get(window, '__releasePassageSend')())
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(1)
	await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
})

test('same-task passage shortcuts share admission with whole-document Send', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Keep this whole request')
	await select(page)
	const editor = bubble(page).getByRole('textbox')
	await editor.fill('One selected-passage request')
	await editor.evaluate(element => {
		for (let index = 0; index < 2; index++)
			element.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
			)
	})
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(1)
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
})

for (const replacement of ['api', 'owner', 'source'] as const)
	test(`${replacement} replacement retires bubble and stale passage callbacks`, async ({ page }) => {
		await page.setViewportSize({ width: 1197, height: 807 })
		await open(page)
		await select(page)
		const editor = bubble(page).getByRole('textbox')
		await editor.fill('Do not send this retired selection')
		await editor.evaluate(element => {
			const key = Object.keys(element).find(key => key.startsWith('__reactProps'))
			if (!key) throw new Error('Missing production React handler')
			Reflect.set(window, '__retiredPassageKey', Reflect.get(element, key).onKeyDown)
		})
		await page.evaluate(replacement => {
			const proof = window.__helmDocumentReviewProof
			if (replacement === 'api') proof?.replaceApi()
			else if (replacement === 'owner') proof?.replaceOwner()
			else proof?.edit()
		}, replacement)
		await expect(bubble(page)).toHaveCount(0)
		await page.evaluate(() =>
			Reflect.get(window, '__retiredPassageKey')({ ctrlKey: true, key: 'Enter', preventDefault() {} }),
		)
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
	})

test('unknown passage delivery preserves recovery in its bubble and never restores into whole-document writing', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Entire document draft')
	await page.evaluate(() => {
		if (window.__helmDocumentReviewProof)
			window.__helmDocumentReviewProof.api.send = async () => {
				throw new Error('Fixture ambiguous delivery')
			}
	})
	await select(page)
	await sendPassage(page, 'Only this selected passage')
	await expect(bubble(page)).toContainText('Outcome not confirmed')
	await bubble(page).getByRole('button', { name: 'Restore request text', exact: true }).click()
	await expect(bubble(page).getByRole('textbox')).toHaveValue('Only this selected passage')
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('Entire document draft')
	await expect(bubble(page).getByRole('button', { name: 'Send passage discussion' })).toBeDisabled()
	await bubble(page).getByRole('button', { name: 'I checked the outcome', exact: true }).click()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
})

test('a busy caller still permits highlighting to open local passage writing without dispatch', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page, 'working')
	await select(page)
	await bubble(page).getByRole('textbox').fill('Draft while the original caller works')
	await expect(bubble(page).getByRole('button', { name: 'Send passage discussion' })).toBeDisabled()
	await bubble(page).getByRole('button', { name: 'Writing options', exact: true }).click()
	await expect(bubble(page).getByRole('menuitem', { name: 'Save local comment', exact: true })).toBeDisabled()
	await page.keyboard.press('Escape')
	await page.evaluate(() => window.__helmDocumentReviewProof?.settle())
	await expect(bubble(page).getByRole('button', { name: 'Send passage discussion' })).toBeEnabled()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
})

for (const reverse of [false, true])
	test(`scrolled multi-line mid-paragraph selection opens passage writing (${reverse ? 'reverse' : 'forward'})`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1197, height: 807 })
		await open(page)
		const quote =
			'Delayed processing can use facts or roles that no longer match the triggering event. Email history exists, but it is not connected to one canonical internal notification or to in-app and push delivery. Users cannot see one shared notification history across Admin and Mobile, and operators lack a uniform occurrence'
		await page.evaluate(
			quote =>
				window.__helmDocumentReviewProof?.edit(
					`# Selection proof\n\n${'Earlier context remains visible.\n\n'.repeat(25)}Webhooks can create duplicates. ${quote} and delivery audit trail.\n`,
				),
			quote,
		)
		await select(page, '.review-block-text p', quote, reverse)
		await page.keyboard.type('Discuss these selected lines')
		await expect(bubble(page).getByRole('textbox')).toHaveValue('Discuss these selected lines')
		await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('')
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
	})

test('canvas Send preserves selected DOM endpoints when the first passage marker appears', async ({ page }) => {
	await page.setViewportSize({ width: 1180, height: 800 })
	await open(page, 'interactive-canvas')
	await expect(page.getByRole('textbox', { name: 'Public workshop name', exact: true })).toHaveValue('Workshop')
	await select(page, '.review-canvas p', 'Keep the reading surface calm')
	await sendPassage(page, 'Ask about this canvas passage')
	await expect(bubble(page)).toContainText('Ask about this canvas passage')
	await page.evaluate(() => window.__helmCanvasReviewProof?.settle())
	await expect(bubble(page)).toContainText('This is a fixture reply to the chosen request.')
	await expect(page.locator('.review-chat')).not.toContainText('Ask about this canvas passage')
	const request = await page.evaluate(() => window.__helmCanvasReviewProof?.requests[0])
	expect(request?.passage?.canvasId).toBe('intro')
	expect(request?.canvasFields?.map(field => field.id)).toEqual(['name', 'count'])
})
