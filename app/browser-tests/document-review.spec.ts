import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
const evidencePath = (name: string) => test.info().outputPath(name)
const selectedParagraphQuote = 'The selected owner must remain exact. A rendered quote is not a Markdown offset.'
const introductionQuote = 'Read the actual document, refine a passage, and keep the wider conversation beside it.'
test.use({ deviceScaleFactor: 2 })
async function open(page: Page, story = 'reading') {
	await page.goto(`/iframe.html?id=views-document-review--${story}&viewMode=story`)
	await expect(page.getByRole('heading', { name: 'spec.md', exact: true })).toBeVisible({ timeout: 20000 })
}
async function documentView(page: Page, name: string) {
	await page.getByRole('button', { name: 'Document options', exact: true }).click()
	await page
		.getByRole('menuitemradio', { name: name === 'Comments' ? /^Comments(?: \d+)?$/ : name, exact: true })
		.click()
}
const passageEditor = (page: Page) => page.locator('.review-passage-editor')
async function commentAction(page: Page, changes = false) {
	const bubble = passageEditor(page)
	const menu = bubble.getByRole('menu', { name: 'Writing options', exact: true })
	if (!(await menu.isVisible())) await bubble.getByRole('button', { name: 'Writing options', exact: true }).click()
	return menu.getByRole('menuitem', { name: changes ? 'Save comment changes' : 'Save local comment', exact: true })
}
async function saveLocalComment(page: Page, changes = false) {
	await (await commentAction(page, changes)).click()
	await expect(page.getByText('Saved locally · not sent', { exact: true })).toBeVisible()
	await documentView(page, 'Comments')
}
async function pointerSelect(
	page: Page,
	selector = '.review-block-text p',
	text = 'The selected owner must remain exact.',
) {
	const paragraph = page.locator(selector).filter({ hasText: text }).first()
	await paragraph.scrollIntoViewIfNeeded()
	const points = await paragraph.evaluate(element => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
		const node = walker.nextNode()
		if (!node || !node.textContent || node.textContent.length < 24) throw new Error('Selection fixture needs text')
		let last = node
		if (!element.matches('.review-full-source')) {
			for (let next = walker.nextNode(); next; next = walker.nextNode()) {
				if (next.textContent?.length) last = next
			}
		}
		const rect = (textNode: Node, offset: number) => {
			const range = document.createRange()
			range.setStart(textNode, offset)
			range.setEnd(textNode, offset + 1)
			return range.getBoundingClientRect().toJSON()
		}
		return {
			start: rect(node, 0),
			end: rect(
				last,
				last === node && element.matches('.review-full-source') ? 23 : (last.textContent?.length ?? 1) - 1,
			),
		}
	})
	await page.mouse.move(points.start.x + 1, points.start.y + points.start.height / 2)
	await page.mouse.down()
	await page.mouse.move(points.end.x + points.end.width - 1, points.end.y + points.end.height / 2, { steps: 12 })
	await page.mouse.up()
}

async function pointerExcerpt(page: Page, paragraph: Locator, excerpt: string) {
	await paragraph.scrollIntoViewIfNeeded()
	const points = await paragraph.evaluate((element, length) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
		const first = walker.nextNode()
		if (!first) throw new Error('Missing excerpt')
		let last = first
		let offset = length - 1
		while (offset >= (last.textContent?.length ?? 0)) {
			offset -= last.textContent?.length ?? 0
			const next = walker.nextNode()
			if (!next) throw new Error('Excerpt exceeds paragraph')
			last = next
		}
		const rect = (node: Node, index: number) => {
			const range = document.createRange()
			range.setStart(node, index)
			range.setEnd(node, index + 1)
			return range.getBoundingClientRect().toJSON()
		}
		return { start: rect(first, 0), end: rect(last, offset) }
	}, excerpt.length)
	await page.mouse.move(points.start.x + 1, points.start.y + points.start.height / 2)
	await page.mouse.down()
	await page.mouse.move(points.end.x + points.end.width - 1, points.end.y + points.end.height / 2, { steps: 12 })
	await page.mouse.up()
}
async function paintedText(page: Page) {
	return page.evaluate(() => {
		const registry = Reflect.get(CSS, 'highlights') as Map<string, Iterable<Range>> | undefined
		return registry ? [...registry.values()].flatMap(highlight => [...highlight].map(range => range.toString())) : []
	})
}

async function selectionPaint(page: Page) {
	return page.evaluate(() => {
		const highlight = CSS.highlights?.get('helm-review-selection')
		return highlight ? [...highlight].map(range => range.toString()) : []
	})
}
async function savedAnnotationPaint(page: Page) {
	return page.evaluate(() => {
		const highlight = CSS.highlights?.get('helm-review-saved-annotations')
		return highlight ? [...highlight].map(range => range.toString()) : []
	})
}

async function commentPaint(page: Page) {
	return page.evaluate(() => {
		const highlight = CSS.highlights?.get('helm-review-comment-passage')
		return highlight ? [...highlight].map(range => range.toString()) : []
	})
}

for (const story of ['passage-list', 'passage-list-light'])
	for (const viewport of [
		{ width: 1197, height: 807 },
		{ width: 640, height: 520 },
	])
		test(`${story}: comment anchors to the actual list passage and highlights it at ${viewport.width}x${viewport.height}`, async ({
			page,
		}) => {
			await page.setViewportSize(viewport)
			await open(page, story)
			const list = page.locator('.review-block-text ol')
			const markers = page.getByRole('button', { name: 'Show passage conversation', exact: true })
			await expect(markers).toHaveCount(2)
			const expected = 'Jako provozák u jeřábníka uvedu jméno, telefon, nepovinný e-mail a národnost.'
			const item = list.locator('li').nth(2)
			await item.scrollIntoViewIfNeeded()
			const before = await list.boundingBox()
			const assertAligned = async () => {
				await expect
					.poll(async () => {
						const rect = await item.evaluate(element => {
							const range = document.createRange()
							range.selectNodeContents(element)
							const rect = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).at(-1)
							if (!rect) throw new Error('Missing selected list line')
							return rect.toJSON()
						})
						const button = await markers.first().boundingBox()
						if (!button) throw new Error('Missing passage marker')
						return Math.abs(button.y + button.height / 2 - rect.y - rect.height / 2)
					})
					.toBeLessThan(4)
			}
			await assertAligned()
			await markers.first().click()
			const bubble = page.getByRole('dialog', { name: 'Passage conversation' })
			await expect(bubble).toContainText('Národnost? Proč národnost?')
			await expect(bubble).not.toContainText(expected)
			await expect(bubble.locator('blockquote')).toHaveCount(0)
			await expect.poll(() => selectionPaint(page)).toEqual([expected])
			await expect(bubble.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
			expect(await list.boundingBox()).toEqual(before)
			const position = await bubble.evaluate(element => {
				const panel = element.getBoundingClientRect()
				const owner = document.querySelector('.review-document-pane')
				const range = [...(CSS.highlights.get('helm-review-selection') ?? [])][0]
				const target =
					range instanceof Range ? [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).at(-1) : null
				if (!owner || !target) throw new Error('Missing current passage anchor')
				const bounds = owner.getBoundingClientRect()
				const below = target.bottom + 8
				const preferred = below + panel.height <= bounds.bottom - 16 ? below : target.top - panel.height - 8
				return {
					top: panel.top,
					expected: Math.max(64, Math.min(Math.max(bounds.top + 16, preferred), innerHeight - panel.height - 16)),
					bottom: panel.bottom,
					left: panel.left,
					right: panel.right,
				}
			})
			expect(position.top).toBeCloseTo(position.expected, 0)
			expect(position.bottom).toBeLessThanOrEqual(viewport.height - 16)
			expect(position.left).toBeGreaterThanOrEqual(0)
			expect(position.right).toBeLessThanOrEqual(viewport.width)
			await page.screenshot({ path: evidencePath(`${story}-${viewport.width}x${viewport.height}-highlight.png`) })
			await page.keyboard.press('Escape')
			await expect.poll(() => commentPaint(page)).toEqual([])
			await expect(markers.first()).toBeFocused()
			await page.setViewportSize({ width: viewport.width === 640 ? 720 : 1117, height: viewport.height })
			await item.scrollIntoViewIfNeeded()
			await assertAligned()
			expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
		})

test('comment highlight is independent of an existing passage draft and only the open bubble owns paint', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page, 'passage-list')
	const first = page.locator('.review-block-text li').first()
	const firstQuote = await first.innerText()
	await pointerExcerpt(page, first, firstQuote)
	const editor = page.getByRole('textbox', { name: 'Passage instruction' })
	await editor.fill('Keep this draft and scope')
	await expect.poll(() => selectionPaint(page)).toEqual([firstQuote])
	const markers = page.getByRole('button', { name: 'Show passage conversation', exact: true })
	await markers.first().focus()
	await page.keyboard.press('Enter')
	await expect
		.poll(() => selectionPaint(page))
		.toEqual(['Jako provozák u jeřábníka uvedu jméno, telefon, nepovinný e-mail a národnost.'])
	await expect(editor).toHaveValue('Keep this draft and scope')
	await expect.poll(() => commentPaint(page)).toEqual([])
	// Auto-popover replacement must not let the prior toggle clear the newer highlight.
	await markers.nth(1).focus()
	await page.keyboard.press('Enter')
	await expect.poll(() => selectionPaint(page)).toEqual(['Jako provozák při střídání ukončím staré přiřazení'])
	await expect(page.getByRole('dialog', { name: 'Passage conversation' })).toContainText('Jak probíhá střídání?')
	await page.evaluate(() => window.__helmDocumentReviewProof?.replaceApi())
	await expect.poll(() => selectionPaint(page)).toEqual([])
	await markers.first().click()
	await expect.poll(() => selectionPaint(page)).not.toEqual([])
	await expect(editor).toHaveValue('Keep this draft and scope')
	await page.evaluate(() => window.__helmDocumentReviewProof?.edit())
	await expect.poll(() => selectionPaint(page)).toEqual([])
	await expect(markers).toHaveCount(0)
	await expect(passageEditor(page)).toHaveCount(0)
	await pointerExcerpt(page, page.locator('.review-block-text li').first(), firstQuote)
	await expect(editor).toHaveValue('Keep this draft and scope')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
})

test('display passage ranges reject ambiguous text and budgets while preserving formatting, breaks and Unicode', async ({
	page,
}) => {
	await open(page)
	const result = await page.evaluate(async url => {
		const { locatePassageDisplayRanges } = await import(url)
		const root = document.createElement('div')
		root.style.position = 'fixed'
		root.style.top = '-10000px'
		document.body.append(root)
		try {
			root.innerHTML = '<p>First <strong>line.</strong><br>Second line. 🌿</p>'
			const formatted = locatePassageDisplayRanges(root, ['First line.\nSecond line. 🌿', 'Second line. 🌿']).map(
				(range: Range | null) => range?.toString() ?? null,
			)
			root.textContent = 'Same text. Same text. Unicode 🐝 and [a-z]*; two  spaces.'
			const exact = locatePassageDisplayRanges(root, [
				'Same text.',
				'Missing',
				'Unicode 🐝 and [a-z]*',
				'two  spaces.',
				'two spaces.',
			]).map((range: Range | null) => range?.toString() ?? null)
			root.textContent = 'x'.repeat(512 * 1024 + 1)
			const bounded = locatePassageDisplayRanges(root, ['x']).map((range: Range | null) => range?.toString() ?? null)
			return { formatted, exact, bounded }
		} finally {
			root.remove()
		}
	}, '/src/renderer/document-review/passage-anchor.ts')
	expect(result).toEqual({
		formatted: ['First line.Second line. 🌿', 'Second line. 🌿'],
		exact: [null, null, 'Unicode 🐝 and [a-z]*', 'two  spaces.', null],
		bounded: [null],
	})
})

for (const story of ['passage-conversations', 'passage-conversations-light'])
	for (const viewport of [
		{ width: 1197, height: 807 },
		{ width: 640, height: 520 },
	])
		test(`${story}: existing passage bubble stays editable and bounded at ${viewport.width}x${viewport.height}`, async ({
			page,
		}) => {
			await page.setViewportSize(viewport)
			await open(page, story)
			const block = page.locator('.review-block').filter({ hasText: 'The selected owner must remain exact.' }).first()
			const marker = block.getByRole('button', { name: 'Show passage conversation', exact: true })
			await marker.scrollIntoViewIfNeeded()
			const before = await block.locator('.review-block-text').boundingBox()
			await marker.focus()
			await page.keyboard.press('Enter')
			const bubble = page.getByRole('dialog', { name: 'Passage conversation' })
			await expect(bubble).toBeVisible()
			await expect(bubble).toContainText('Why do we retain the exact owner?')
			await expect(bubble).toContainText('It keeps feedback in the original conversation.')
			await expect(bubble).not.toContainText('What does reading-first mean?')
			await expect(bubble).not.toContainText('Let’s refine the dispatch contract.')
			await expect(bubble.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
			await expect(page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })).toHaveValue('')
			await expect(bubble.locator('blockquote')).toHaveCount(0)
			await expect.poll(() => selectionPaint(page)).toEqual(['The selected owner must remain exact.'])
			await expect(bubble).toHaveCSS('border-radius', '8px')
			await bubble.getByRole('region', { name: 'Passage messages' }).focus()
			await expect(bubble.getByRole('region', { name: 'Passage messages' })).toBeFocused()
			await page.getByRole('button', { name: 'Close passage conversation' }).focus()
			await expect(page.getByRole('button', { name: 'Close passage conversation' })).toBeFocused()
			expect(await block.locator('.review-block-text').boundingBox()).toEqual(before)
			const bounds = await bubble.boundingBox()
			const reading = await page.locator('.review-reading').boundingBox()
			if (!bounds || !reading) throw new Error('Missing bubble bounds')
			expect(bounds.x).toBeGreaterThanOrEqual(reading.x)
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(reading.x + reading.width)
			expect(bounds.y).toBeGreaterThanOrEqual(reading.y)
			expect(bounds.y + bounds.height).toBeLessThanOrEqual(reading.y + reading.height)
			await page.screenshot({ path: evidencePath(`${story}-${viewport.width}x${viewport.height}-bubble.png`) })
			await page.keyboard.press('Escape')
			await expect(bubble).toHaveCount(0)
			await expect.poll(() => commentPaint(page)).toEqual([])
			await expect(marker).toBeFocused()
			await marker.click()
			await page.getByRole('button', { name: 'Close passage conversation' }).click()
			await expect(marker).toBeFocused()
			await marker.click()
			if (viewport.width > 900) {
				const editor = page.getByRole('textbox', { name: 'Whole-document message' })
				await editor.click()
				await expect(editor).toBeFocused()
			} else await page.getByRole('button', { name: 'Contents', exact: true }).click()
			await expect(bubble).toHaveCount(0)
			expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
		})

test('sending a passage question adds its bubble and live reply without normal delivery notices', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	await expect(page.getByRole('button', { name: 'Show passage conversation' })).toHaveCount(0)
	await pointerSelect(page)
	const editor = page.getByRole('textbox', { name: 'Passage instruction' })
	await editor.fill('Why this specific passage?')
	await page.getByRole('button', { name: 'Send passage discussion' }).click()
	await expect(page.getByRole('region', { name: 'Delivery and recovery' })).toHaveCount(0)
	await expect(page.getByText('Dispatched', { exact: true })).toHaveCount(0)
	const marker = page.getByRole('button', { name: 'Show passage conversation', exact: true })
	await marker.click()
	const bubble = page.getByRole('dialog', { name: 'Passage conversation' })
	await expect(bubble).toContainText('Why this specific passage?')
	await expect(bubble).not.toContainText('The source locator should identify')
	await page.evaluate(() => window.__helmDocumentReviewProof?.settle())
	await expect(bubble).toContainText('This is a fixture reply to the chosen request.')
	await expect(page.locator('.review-companion')).not.toContainText('Why this specific passage?')
	await expect(page.locator('.review-companion')).not.toContainText('This is a fixture reply to the chosen request.')
	// The marker was opened while our command was admitted: it offers read-only
	// inspection, not scope replacement, and settlement never upgrades it automatically.
	await expect(passageEditor(page)).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(1)
	await pointerExcerpt(page, bubble.locator('.review-message-user div'), 'Why this specific passage?')
	await expect(passageEditor(page)).toHaveCount(0)
	await expect(page.getByRole('group', { name: 'Pending selection' })).toHaveCount(0)
	await page.getByRole('button', { name: 'Close passage conversation' }).click()
	await marker.click()
	await expect(editor).toHaveValue('')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(1)
	await page.evaluate(() => window.__helmDocumentReviewProof?.edit())
	await expect(bubble).toHaveCount(0)
	await expect(marker).toHaveCount(0)
	await expect(page.locator('.review-companion')).not.toContainText('Why this specific passage?')
})

test('owner and API replacement retire an open passage bubble without reopening or sending', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page, 'passage-conversations')
	const marker = page.getByRole('button', { name: 'Show passage conversation' }).first()
	await marker.click()
	const bubble = page.getByRole('dialog', { name: 'Passage conversation' })
	await expect(bubble).toBeVisible()
	await page.evaluate(() => window.__helmDocumentReviewProof?.replaceApi())
	await expect(bubble).toHaveCount(0)
	await marker.click()
	await expect(bubble).toBeVisible()
	await page.evaluate(() => window.__helmDocumentReviewProof?.replaceOwner())
	await expect(bubble).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Show passage conversation' })).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
})

test('writing-first pointer selection receives first keyboard character with no intent gate', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	const editor = page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })
	await editor.evaluate(element => {
		Object.assign(window, { __reviewOriginalEditor: element })
	})
	await pointerSelect(page)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().saved)).toBe(0)
	await page.keyboard.type('X')
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('X')
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
	await expect(page.getByRole('group', { name: 'Selected passage actions' })).toHaveCount(0)
	await expect(passageEditor(page).getByRole('button', { name: 'Passage intent: Ask', exact: true })).toBeVisible()
	expect(await editor.evaluate(element => Reflect.get(window, '__reviewOriginalEditor') === element)).toBe(true)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	await expect(page.locator('.review-comment')).toHaveCount(0)
})

test('routine pointer re-selection updates typed passage immediately without Use selection', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	const annotations = await page.evaluate(
		async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations,
	)
	expect(annotations).toEqual([])
	const editor = page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })
	await editor.evaluate(element => {
		Object.assign(window, { __reviewOriginalEditor: element })
	})
	const first = 'The selected owner must remain exact.'
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: first }).first(), first)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().saved)).toBe(0)
	await page.keyboard.type('Keep these words')
	await chooseIntent(page, 'change')
	await expect.poll(() => paintedText(page)).toEqual([first])
	const next = 'Read the actual document, refine a passage'
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: next }).first(), next)
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toHaveCount(0)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
	await expect.poll(() => paintedText(page)).toEqual([next])
	// Reopening owns focus, not an inherited native textarea caret position.
	await page.keyboard.press('End')
	await page.keyboard.type('!')
	await expect(passageEditor(page).getByRole('textbox')).toHaveValue('Keep these words!')
	await expect(editor).toHaveValue('')
	await expect(
		passageEditor(page).getByRole('button', { name: 'Passage intent: Request change', exact: true }),
	).toBeVisible()
	expect(await editor.evaluate(element => Reflect.get(window, '__reviewOriginalEditor') === element)).toBe(true)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	expect(
		await page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations),
	).toEqual(annotations)
	await passageEditor(page).getByRole('button', { name: 'Send change request', exact: true }).click()
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.instruction).toBe('Keep these words!')
	expect(request?.intent).toBe('change')
	expect(request?.passage?.quote).toBe(next)
	expect(request?.passage?.kind).toBe('block')
	expect(request?.passage?.source).toContain(introductionQuote)
})

test('passage writing removes duplicate quote chrome while retaining exact send context', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	const editor = page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })
	await editor.evaluate(element => Object.assign(window, { __reviewOriginalEditor: element }))
	const excerpt = 'The selected owner must remain exact.'
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
	await page.keyboard.type('X')
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('X')
	expect(await editor.evaluate(element => Reflect.get(window, '__reviewOriginalEditor') === element)).toBe(true)
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	await expect(page.getByRole('heading', { name: 'Selected passage', exact: true })).toHaveCount(0)
	await expect(page.locator('.review-writing-surface blockquote')).toHaveCount(0)
	await expect(page.locator('.review-passage-context')).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Show full quote', exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.instruction).toBe('X')
	expect(request?.passage?.quote).toBe(excerpt)
	expect(request?.passage?.kind).toBe('block')
	expect(request?.passage?.source).toContain('A **rendered quote** is not a Markdown offset.')
})

test('routine pointer selection highlights only partial rendered text without painting its whole paragraph', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Keep my scoped question')
	const excerpt = 'The selected owner must remain exact.'
	const paragraph = page.locator('.review-block-text p').filter({ hasText: excerpt }).first()
	await paragraph.scrollIntoViewIfNeeded()
	const points = await paragraph.evaluate((element, length) => {
		const node = element.firstChild
		if (!node || (node.textContent?.length ?? 0) < length) throw new Error('Missing partial-selection text')
		const rect = (offset: number) => {
			const range = document.createRange()
			range.setStart(node, offset)
			range.setEnd(node, offset + 1)
			return range.getBoundingClientRect().toJSON()
		}
		return { start: rect(0), end: rect(length - 1) }
	}, excerpt.length)
	await page.mouse.move(points.start.x + 1, points.start.y + points.start.height / 2)
	await page.mouse.down()
	await page.mouse.move(points.end.x + points.end.width - 1, points.end.y + points.end.height / 2, { steps: 12 })
	await page.mouse.up()
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toHaveCount(0)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('')
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('Keep my scoped question')
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Only the selected passage')
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	const paint = await paragraph.evaluate(element => {
		const block = element.closest('.review-block-text')
		if (!block) throw new Error('Missing paragraph owner')
		const registry = Reflect.get(CSS, 'highlights') as Map<string, Iterable<Range>> | undefined
		return {
			background: getComputedStyle(block).backgroundColor,
			highlights: registry
				? [...registry.values()].flatMap(highlight => [...highlight].map(range => range.toString()))
				: [],
		}
	})
	expect(paint.background).toBe('rgba(0, 0, 0, 0)')
	expect(paint.highlights).toEqual([excerpt])
	await page.screenshot({ path: evidencePath('partial-selection-after-use.png') })
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.passage?.quote).toBe(excerpt)
	expect(request?.passage?.kind).toBe('block')
	expect(request?.passage?.source).toContain('A **rendered quote** is not a Markdown offset.')
})

test('review header keeps filename without a redundant Close action', async ({ page }) => {
	await open(page)
	await expect(page.locator('.review-header').getByRole('heading', { name: 'spec.md', exact: true })).toBeVisible()
	await expect(page.locator('.review-header').getByRole('button', { name: 'Close', exact: true })).toHaveCount(0)
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
})

test('exact pointer highlight survives writing, observation, return and resize', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	const excerpt = 'The selected owner must remain exact.'
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
	await page.keyboard.type('First character')
	const editor = page.getByRole('textbox', { name: 'Passage instruction' })
	await expect(editor).toHaveValue('First character')
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	await proof(page, 'settle')
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	await page.keyboard.press('Escape')
	await expect(page.locator('.review-reading')).toBeFocused()
	await page.setViewportSize({ width: 640, height: 520 })
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
	await expect(editor).toHaveValue('First character')
	await expect(page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })).toHaveValue('')
	await page.setViewportSize({ width: 1197, height: 807 })
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	await page.screenshot({ path: evidencePath('partial-selection-after-writing-return-resize.png') })
})

test('partial inline formatting in repeated prose highlights the actual second DOM passage', async ({ page }) => {
	await open(page)
	await page.evaluate(() =>
		window.__helmDocumentReviewProof?.edit(
			'# Repeated prose\n\nShared **phrase** stays here.\n\nShared **phrase** stays here.\n',
		),
	)
	await expect(page.locator('.review-block-text p')).toHaveCount(2)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Only the second occurrence')
	const target = page.locator('.review-block-text p').nth(1)
	await pointerExcerpt(page, target, 'Shared phrase')
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toHaveCount(0)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Only this second DOM occurrence')
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('Only the second occurrence')
	await expect.poll(() => paintedText(page)).toEqual(['Shared phrase'])
	expect(
		await target.evaluate(element => {
			const registry = Reflect.get(CSS, 'highlights') as Map<string, Iterable<Range>>
			const ranges = [...registry.values()].flatMap(highlight => [...highlight])
			return (
				ranges.length === 1 &&
				ranges[0]?.startContainer.parentElement?.closest('p') === element &&
				ranges[0]?.endContainer.parentElement?.closest('p') === element
			)
		}),
	).toBe(true)
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.passage?.quote).toBe('Shared phrase')
	expect(request?.passage?.kind).toBe('block')
	expect(request?.passage?.source).toContain('Shared **phrase** stays here.')
	expect(request?.passage?.start).toBeGreaterThan(40)
})

test('header Contents and document dots provide bounded heading navigation without draft effects', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	const longHeading =
		'A nested heading whose full readable label stays available without spreading navigation into a wide column'
	await page.evaluate(
		text => window.__helmDocumentReviewProof?.edit(text),
		`# A calm document\n\nOpening paragraph.\n\n### ${longHeading}\n\nNested paragraph.\n\n## Next section\n\nFinal paragraph.\n`,
	)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Keep this unsent thought while navigating.')
	const contents = page.locator('.review-header').getByRole('button', { name: 'Contents', exact: true })
	await expect(contents).toBeVisible()
	await expect(contents).toContainText('Contents')
	await expect(
		page.locator('.review-header').getByRole('button', { name: 'Document options', exact: true }),
	).toBeVisible()
	await expect(page.locator('.review-toolbar')).toHaveCount(0)
	await contents.click()
	const navigation = page.getByRole('navigation', { name: 'Contents', exact: true })
	await expect(navigation).toBeVisible()
	const bounds = await navigation.boundingBox()
	expect(bounds?.width).toBeGreaterThanOrEqual(220)
	expect(bounds?.width).toBeLessThanOrEqual(260)
	const nested = navigation.getByRole('button', { name: longHeading, exact: true })
	await expect(nested).toHaveAttribute('title', longHeading)
	expect((await nested.boundingBox())?.height).toBeLessThanOrEqual(48)
	await navigation.getByRole('button', { name: 'Next section', exact: true }).click()
	await expect(
		page.locator('.review-prose').getByRole('heading', { name: 'Next section', exact: true }),
	).toBeInViewport()
	await expect(navigation.getByRole('button', { name: 'Next section', exact: true })).toHaveAttribute(
		'aria-current',
		'location',
	)
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue(
		'Keep this unsent thought while navigating.',
	)
	await page.setViewportSize({ width: 640, height: 520 })
	await navigation.getByRole('button', { name: 'Close contents', exact: true }).focus()
	await page.keyboard.press('Escape')
	await expect(navigation).toHaveCount(0)
	await expect(contents).toBeFocused()
	await contents.click()
	await navigation.getByRole('button', { name: 'A calm document', exact: true }).click()
	await expect(navigation).toHaveCount(0)
	await expect(page.locator('.review-reading')).toBeFocused()
	await expect(
		page.locator('.review-prose').getByRole('heading', { name: 'A calm document', exact: true }),
	).toBeInViewport()
	await page.getByRole('button', { name: 'Conversation', exact: true }).click()
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue(
		'Keep this unsent thought while navigating.',
	)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	expect(
		await page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations),
	).toEqual([])
})

for (const story of ['reading', 'light'])
	test(`${story}: Contents pushes constrained reading content and preserves newer editor focus`, async ({ page }) => {
		await page.setViewportSize({ width: 1197, height: 807 })
		await open(page, story)
		const editor = page.getByRole('textbox', { name: 'Whole-document message' })
		await editor.fill('Retain this thought while browsing Contents.')
		const divider = page.getByRole('separator', { name: 'Resize conversation pane' })
		await divider.focus()
		await page.keyboard.press('End')
		await expect(divider).toHaveAttribute('aria-valuenow', '640')
		await expect(page.locator('.review-document-pane')).toHaveAttribute('data-contents-stacked', 'true')
		const before = await page.locator('.review-reading').boundingBox()
		await page.getByRole('button', { name: 'Contents', exact: true }).click()
		const navigation = page.getByRole('navigation', { name: 'Contents', exact: true })
		await expect(navigation).toBeVisible()
		const assertFlow = async () => {
			const nav = await navigation.boundingBox()
			const reading = await page.locator('.review-reading').boundingBox()
			const pane = await page.locator('.review-document-pane').boundingBox()
			if (!nav || !reading || !pane) throw new Error('Missing Contents/reading bounds')
			expect(nav.x).toBeGreaterThanOrEqual(pane.x)
			expect(nav.x + nav.width).toBeLessThanOrEqual(pane.x + pane.width + 1)
			expect(reading.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1)
			expect(reading.height).toBeGreaterThanOrEqual(96)
			expect(['absolute', 'fixed']).not.toContain(
				await navigation.evaluate(element => getComputedStyle(element).position),
			)
		}
		await assertFlow()
		expect((await page.locator('.review-reading').boundingBox())?.height).toBeLessThan(before?.height ?? 0)
		const regions = await page
			.locator('.review-header-controls, .review-header-controls .btn, .review-header-controls .menu-root')
			.evaluateAll(elements =>
				elements.map(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')),
			)
		for (const region of regions) expect(region).toBe('no-drag')
		await editor.click()
		await expect(navigation).toBeVisible()
		await expect(editor).toBeFocused()
		await expect(editor).toHaveValue('Retain this thought while browsing Contents.')
		await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveCount(0)
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
		await page.setViewportSize({ width: 640, height: 520 })
		await page.getByRole('button', { name: 'Document', exact: true }).click()
		await expect(navigation).toBeVisible()
		await assertFlow()
		await page.screenshot({ path: evidencePath(`${story}-contents-pushes-compact.png`) })
	})

test('Contents handles empty and duplicate headings and Source navigation without late focus or scope changes', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	await page.evaluate(() => window.__helmDocumentReviewProof?.edit('A document without headings.\n'))
	const contents = page.getByRole('button', { name: 'Contents', exact: true })
	await contents.click()
	const navigation = page.getByRole('navigation', { name: 'Contents', exact: true })
	await expect(navigation).toContainText('No headings in this document.')
	await page.keyboard.press('Escape')
	await expect(contents).toBeFocused()
	await page.evaluate(() => window.__helmDocumentReviewProof?.edit('#\n\n##   \n\nBody.\n'))
	await expect(page.locator('.review-prose p').getByText('Body.', { exact: true })).toBeVisible()
	await contents.click()
	await expect(navigation.locator('.review-contents-link')).toHaveCount(0)
	await expect(navigation.getByText('No headings in this document.', { exact: true })).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(contents).toBeFocused()
	await page.evaluate(() =>
		window.__helmDocumentReviewProof?.edit(
			`# Main section\n\n## Repeated heading\n\n${'First section body. '.repeat(150)}\n\n### Repeated heading\n\n${'Second section body. '.repeat(100)}\n`,
		),
	)
	const editor = page.getByRole('textbox', { name: 'Whole-document message' })
	await editor.fill('Preserve draft and chosen intent.')
	await chooseIntent(page, 'change')
	await contents.click()
	const repeated = navigation.getByRole('button', { name: 'Repeated heading', exact: true })
	await expect(repeated).toHaveCount(2)
	await repeated.nth(1).focus()
	await page.keyboard.press('Enter')
	await expect(page.locator('.review-prose h3')).toBeInViewport()
	await expect(repeated.nth(1)).toHaveAttribute('aria-current', 'location')
	await expect(repeated.nth(0)).not.toHaveAttribute('aria-current', 'location')
	await page.keyboard.press('Enter')
	await expect(repeated.nth(1)).toHaveAttribute('aria-current', 'location')
	await documentView(page, 'Source')
	await expect(page.locator('.review-full-source')).toBeVisible()
	await navigation.getByRole('button', { name: 'Main section', exact: true }).focus()
	await page.keyboard.press('Enter')
	await expect(page.locator('.review-prose h1')).toHaveText('Main section')
	await expect(page.locator('.review-prose h1')).toBeInViewport()
	await expect(navigation.getByRole('button', { name: 'Main section', exact: true })).toHaveAttribute(
		'aria-current',
		'location',
	)
	await editor.click()
	await proof(page, 'edit')
	await page.evaluate(() => window.__helmDocumentReviewProof?.replaceApi())
	await expect(editor).toBeFocused()
	await expect(editor).toHaveValue('Preserve draft and chosen intent.')
	await expect(page.getByRole('button', { name: 'Feedback intent: Request change', exact: true })).toBeVisible()
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveCount(0)
	await page.evaluate(
		() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	)
	await expect(editor).toBeFocused()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	expect(
		await page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations),
	).toEqual([])
})

test('Contents left-aligns real heading levels and retains fractional duplicate target as current', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	const longHeading =
		'Typed registry and content ownership across repeated native navigation, pending requests and recovery boundaries'
	await page.evaluate(
		text => window.__helmDocumentReviewProof?.edit(text),
		`# Implementation decisions\n\nA document should remain readable while its Contents helps readers move between decisions.\n\n## Product and domain model\n\nProject, worktree and conversation retain distinct meanings.\n\n#### ${longHeading}\n\nSkipped heading levels keep their real hierarchy without adding placeholder sections.\n\n##### Deep module seams\n\nSmall interfaces keep their implementation details inside their owner.\n\n###### Authorization and audit across owner replacement and queued delivery\n\nPermission and observation remain explicit.\n\n## Repeated heading\n\n${'First section keeps its own target. '.repeat(40)}\n\n### Repeated heading\n\n${'Second section keeps a distinct target. '.repeat(40)}\n\n## Delayed vacation email and supersession\n\nScheduling and replacement remain separate decisions.\n\n## Observability and manual repair\n\nOperators need concise evidence.\n\n## Final acceptance\n\nNothing hidden or duplicated.\n`,
	)
	await expect(page.locator('.review-prose h1')).toHaveText('Implementation decisions')
	await page.evaluate(() => document.fonts.ready)
	await page.getByRole('button', { name: 'Contents', exact: true }).click()
	const navigation = page.getByRole('navigation', { name: 'Contents', exact: true })
	const labels = await navigation.locator('.review-contents-link').evaluateAll(elements =>
		elements.map(element => ({
			level: Number((element as HTMLElement).dataset.level),
			offset:
				(element.firstElementChild as HTMLElement).getBoundingClientRect().left - element.getBoundingClientRect().left,
		})),
	)
	for (const label of labels) expect(label.offset).toBe(12 + Math.min(4, label.level - 1) * 8)
	const repeated = navigation.getByRole('button', { name: 'Repeated heading', exact: true })
	await Promise.all([
		page.locator('.review-reading').evaluate(
			owner =>
				new Promise<void>(resolve => {
					owner.addEventListener('scroll', () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), {
						once: true,
					})
				}),
		),
		repeated.nth(1).click(),
	])
	const gap = await page.locator('.review-prose h3').evaluate(element => {
		const owner = element.closest('.review-reading')
		const block = element.closest('[data-source-start]')
		if (!owner || !block) throw new Error('Missing heading owner/block')
		return block.getBoundingClientRect().top - owner.getBoundingClientRect().top
	})
	expect(gap).toBeGreaterThan(40)
	expect(gap).toBeLessThan(41)
	await expect(repeated.nth(1)).toHaveAttribute('aria-current', 'location')
	await expect(repeated.nth(0)).not.toHaveAttribute('aria-current', 'location')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveCount(0)
})

test('document prose has no Review controls and keyboard selection still opens scoped writing', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	const editor = page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })
	await editor.evaluate(element => Object.assign(window, { __reviewOriginalEditor: element }))
	const paragraph = page
		.locator('.review-block-text p')
		.filter({ hasText: 'The selected owner must remain exact.' })
		.first()
	await paragraph.scrollIntoViewIfNeeded()
	await paragraph.hover()
	const reading = page.locator('.review-reading')
	await reading.focus()
	await paragraph.evaluate(element => {
		const node = element.firstChild
		if (!node) throw new Error('Missing keyboard fixture text')
		window.getSelection()?.setBaseAndExtent(node, 0, node, 1)
	})
	for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowRight')
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('The')
	await expect(reading).toBeFocused()
	await expect.poll(() => paintedText(page)).toEqual([])
	await page.keyboard.press('Alt+Enter')
	await page.keyboard.type('K')
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
	await expect(passageEditor(page).getByRole('textbox')).toHaveValue('K')
	await expect(editor).toHaveValue('')
	expect(await editor.evaluate(element => Reflect.get(window, '__reviewOriginalEditor') === element)).toBe(true)
	await expect.poll(() => paintedText(page)).toEqual(['The'])
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	await expect(page.getByRole('button', { name: /^Review passage / })).toHaveCount(0)
	await expect(page.locator('.review-block-action')).toHaveCount(0)
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.instruction).toBe('K')
	expect(request?.passage?.quote).toBe('The')
	expect(request?.passage?.kind).toBe('block')
	expect(request?.passage?.source).toContain('A **rendered quote** is not a Markdown offset.')
})

test('seeded keyboard selection extends until Alt+Enter paints exact text', async ({ page }) => {
	await open(page)
	const paragraph = page
		.locator('.review-block-text p')
		.filter({ hasText: 'The selected owner must remain exact.' })
		.first()
	await paragraph.scrollIntoViewIfNeeded()
	await page.locator('.review-reading').focus()
	await paragraph.evaluate(element => {
		const node = element.firstChild
		if (!node) throw new Error('Missing keyboard fixture text')
		window.getSelection()?.setBaseAndExtent(node, 0, node, 1)
	})
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('T')
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
	await expect.poll(() => paintedText(page)).toEqual([])
	for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowRight')
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('The')
	await expect(page.locator('.review-reading')).toBeFocused()
	await expect.poll(() => paintedText(page)).toEqual([])
	await page.keyboard.press('Alt+Enter')
	await page.keyboard.type('K')
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('K')
	await expect.poll(() => paintedText(page)).toEqual(['The'])
})

test('hard-break selection paints captured DOM range while preserving visible quote line break', async ({ page }) => {
	await open(page)
	await page.evaluate(() => window.__helmDocumentReviewProof?.edit('# Heading\n\nFirst line.  \nSecond line.\n'))
	await expect(page.locator('.review-block-text p')).toHaveCount(1)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Explain both lines')
	await page.evaluate(() => {
		document.addEventListener(
			'pointerup',
			() => {
				const selection = window.getSelection()
				Reflect.set(window, '__reviewHardBreakSelection', {
					quote: selection?.toString(),
					raw: selection?.rangeCount ? selection.getRangeAt(0).toString() : null,
				})
			},
			{ capture: true, once: true },
		)
	})
	await pointerExcerpt(page, page.locator('.review-block-text p'), 'First line.Second line.')
	const selected = await page.evaluate(
		() => Reflect.get(window, '__reviewHardBreakSelection') as { quote: string; raw: string },
	)
	expect(selected.quote).toBe('First line.\nSecond line.')
	expect(selected.raw).toBe('First line.Second line.')
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toHaveCount(0)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('')
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('Explain both lines')
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Explain this line break')
	await expect.poll(() => paintedText(page)).toEqual(['First line.Second line.'])
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.passage?.quote).toBe('First line.\nSecond line.')
	expect(request?.passage?.source).toContain('First line.  \nSecond line.')
	expect(request?.passage?.kind).toBe('block')
})

for (const boundaries of [['revision', 'owner'], ['API', 'DOM remount'], ['clear']])
	test(`${boundaries.join(' and ')} invalidate exact highlight without painting a replacement paragraph`, async ({
		page,
	}) => {
		for (const boundary of boundaries) {
			await open(page)
			const excerpt = 'The selected owner must remain exact.'
			await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
			await expect.poll(() => paintedText(page)).toEqual([excerpt])
			if (boundary === 'revision') await proof(page, 'edit')
			if (boundary === 'API') await page.evaluate(() => window.__helmDocumentReviewProof?.replaceApi())
			if (boundary === 'owner') await proof(page, 'replaceOwner')
			if (boundary === 'DOM remount') {
				await documentView(page, 'Source')
				await documentView(page, 'Read')
			}
			if (boundary === 'clear') {
				await page.getByRole('button', { name: 'Writing options', exact: true }).click()
				await page.getByRole('menuitem', { name: /^Clear passage(?: |$)/ }).click()
			}
			await expect.poll(() => paintedText(page)).toEqual([])
			expect(
				await page
					.locator('.review-block-text p')
					.filter({ hasText: excerpt })
					.first()
					.evaluate(element => getComputedStyle(element.closest('.review-block-text') as Element).backgroundColor),
			).toBe('rgba(0, 0, 0, 0)')
			expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
		}
	})

test('blocked pending selection cannot replace an admitted request highlight', async ({ page }) => {
	await open(page)
	const excerpt = 'The selected owner must remain exact.'
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Admit this exact passage')
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	const other = page
		.locator('.review-block-text p')
		.filter({ hasText: 'Read the actual document, refine a passage' })
		.first()
	await pointerExcerpt(page, other, 'Read the actual document')
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	await proof(page, 'settle', true)
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0]?.passage?.quote)).toBe(excerpt)
})

test('saved annotation keeps its truthful source-block marker without a Review control', async ({ page }) => {
	await open(page, 'comments')
	await documentView(page, 'Comments')
	await page.getByRole('button', { name: 'Edit / send feedback', exact: true }).click()
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
	await documentView(page, 'Read')
	await expect.poll(() => paintedText(page)).toEqual([])
	const block = page.locator('.review-block[data-selected="true"] > .review-block-text')
	await expect(block).toContainText('Collaborative specification')
	expect(await block.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
	await expect(page.getByRole('button', { name: /^Review passage / })).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})
async function selectPassage(page: Page) {
	await pointerSelect(page)
}
async function selectHeading(page: Page, text: string) {
	await pointerExcerpt(page, page.locator('.review-block-text').getByRole('heading', { name: text, exact: true }), text)
}
async function keyboardHeading(page: Page, text: string) {
	const heading = page.locator('.review-block-text').getByRole('heading', { name: text, exact: true })
	await heading.scrollIntoViewIfNeeded()
	await page.locator('.review-reading').focus()
	await heading.evaluate(element => {
		const node = element.firstChild
		if (!node) throw new Error('Missing keyboard heading text')
		window.getSelection()?.setBaseAndExtent(node, 0, node, 1)
	})
	for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowRight')
	await page.keyboard.press('Alt+Enter')
}
async function chooseIntent(page: Page, intent: 'discuss' | 'change') {
	const use = page.getByRole('button', { name: 'Use selection', exact: true })
	if (await use.isVisible()) await use.click()
	const passage = await passageEditor(page).isVisible()
	const surface = passage ? passageEditor(page) : page.locator('.review-companion')
	const prefix = passage ? 'Passage intent' : 'Feedback intent'
	const name = intent === 'discuss' ? 'Ask' : 'Request change'
	const current = surface.getByRole('button', { name: `${prefix}: ${name}`, exact: true })
	if (await current.isVisible()) return
	await surface.getByRole('group', { name: 'Feedback intent', exact: true }).getByRole('button').click()
	await surface.getByRole('menuitemradio', { name: new RegExp(`^${name}(?: |$)`) }).click()
}

test('return to document preserves passage scope and explicit change intent', async ({ page }) => {
	await page.setViewportSize({ width: 640, height: 520 })
	await open(page)
	const excerpt = 'The selected owner must remain exact.'
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
	await chooseIntent(page, 'change')
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Keep this change scoped to my passage')
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	await page.keyboard.press('Escape')
	await expect(page.locator('.review-reading')).toBeFocused()
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue(
		'Keep this change scoped to my passage',
	)
	await expect.poll(() => paintedText(page)).toEqual([excerpt])
	await passageEditor(page).getByRole('button', { name: 'Send change request', exact: true }).click()
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.intent).toBe('change')
	expect(request?.passage?.quote).toBe(excerpt)
})

test('local save stays in writing and repeat save updates same comment', async ({ page }) => {
	await open(page)
	await pointerSelect(page)
	await chooseIntent(page, 'change')
	const editor = page.getByRole('textbox', { name: 'Passage instruction' })
	await editor.fill('First local thought')
	await expect.poll(() => selectionPaint(page)).toEqual([selectedParagraphQuote])
	await expect.poll(() => savedAnnotationPaint(page)).toEqual([])
	await (await commentAction(page)).click()
	await expect(page.getByText('Saved locally · not sent', { exact: true })).toBeVisible()
	await expect(editor).toHaveValue('First local thought')
	await expect.poll(() => selectionPaint(page)).toEqual([selectedParagraphQuote])
	await expect.poll(() => savedAnnotationPaint(page)).toEqual([selectedParagraphQuote])
	await expect.poll(() => paintedText(page)).toEqual([selectedParagraphQuote, selectedParagraphQuote])
	const firstSaved = await page.evaluate(
		async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0],
	)
	expect(firstSaved?.passage.quote).toBe(selectedParagraphQuote)
	await editor.fill('Revised local thought')
	await expect(page.getByText('Saved locally · not sent', { exact: true })).toHaveCount(0)
	await (await commentAction(page, true)).click()
	await expect(page.getByText('Saved locally · not sent', { exact: true })).toBeVisible()
	await documentView(page, 'Comments')
	await expect(page.locator('.review-comment')).toHaveCount(1)
	await expect(page.locator('.review-comment')).toContainText('Revised local thought')
	await expect(page.locator('.review-comment blockquote')).toHaveText(selectedParagraphQuote)
	const revisedSaved = await page.evaluate(
		async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0],
	)
	expect(revisedSaved?.id).toBe(firstSaved?.id)
	expect(revisedSaved?.passage.quote).toBe(selectedParagraphQuote)
	await page.getByRole('button', { name: 'Edit / send feedback', exact: true }).click()
	await expect(
		passageEditor(page).getByRole('button', { name: 'Passage intent: Request change', exact: true }),
	).toBeVisible()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('failed local save never claims saved and retry preserves one comment', async ({ page }) => {
	await open(page)
	await pointerSelect(page)
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('A recoverable local comment')
	await page.evaluate(() => {
		const api = window.__helmDocumentReviewProof?.api
		if (!api) throw new Error('Missing fixture')
		const original = api.save
		Reflect.set(window, '__restoreCommentSave', () => {
			api.save = original
		})
		api.save = async value => {
			Reflect.set(window, '__failedCommentPayload', structuredClone(value))
			return { error: 'Fixture local comment save refused.' }
		}
	})
	await (await commentAction(page)).click()
	await expect(page.getByText('Comment not saved. Retry save.', { exact: true })).toBeVisible()
	await expect(page.getByText('Saved locally · not sent', { exact: true })).toHaveCount(0)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('A recoverable local comment')
	await page.evaluate(() => (Reflect.get(window, '__restoreCommentSave') as () => void)())
	await page.evaluate(() => {
		const api = window.__helmDocumentReviewProof?.api
		if (!api) throw new Error('Missing fixture')
		const original = api.save
		api.save = async value => {
			Reflect.set(window, '__retryCommentPayload', structuredClone(value))
			await new Promise<void>(resolve => Reflect.set(window, '__releaseRetrySave', resolve))
			api.save = original
			return original(value)
		}
	})
	await page.getByRole('button', { name: 'Retry comment save', exact: true }).click()
	await expect
		.poll(() => page.evaluate(() => Reflect.get(window, '__retryCommentPayload')))
		.toEqual(await page.evaluate(() => Reflect.get(window, '__failedCommentPayload')))
	await expect(page.getByText('Saved locally · not sent', { exact: true })).toHaveCount(0)
	await page.evaluate(() => (Reflect.get(window, '__releaseRetrySave') as () => void)())
	await expect
		.poll(() =>
			page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations.length),
		)
		.toBe(1)
	// Retry is outside the popover: persistence completes without reopening or focus theft.
	await expect(passageEditor(page)).toHaveCount(0)
	await documentView(page, 'Comments')
	await expect(page.locator('.review-comment')).toHaveCount(1)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('saved-comment Return to document leaves Comments without losing passage draft', async ({ page }) => {
	await page.setViewportSize({ width: 640, height: 520 })
	await open(page)
	const excerpt = 'The selected owner must remain exact.'
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
	await chooseIntent(page, 'change')
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Return with this scoped comment')
	await saveLocalComment(page)
	await expect(page.locator('.review-comment blockquote')).toHaveText(excerpt)
	const savedId = await page.evaluate(
		async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0]?.id,
	)
	await page.getByRole('button', { name: 'Edit / send feedback', exact: true }).click()
	await page.getByRole('button', { name: 'Writing options', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Return to document', exact: true }).click()
	await expect(page.locator('.review-reading')).toBeFocused()
	await expect(page.locator('.review-prose')).toBeVisible()
	await expect(page.locator('.review-comments')).toHaveCount(0)
	await documentView(page, 'Comments')
	await page.getByRole('button', { name: 'Edit / send feedback', exact: true }).click()
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue(
		'Return with this scoped comment',
	)
	await expect(
		passageEditor(page).getByRole('button', { name: 'Passage intent: Request change', exact: true }),
	).toBeVisible()
	await expect(await commentAction(page, true)).toBeEnabled()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	await saveLocalComment(page, true)
	await expect(page.locator('.review-comment')).toHaveCount(1)
	await expect(page.locator('.review-comment blockquote')).toHaveText(excerpt)
	const retained = await page.evaluate(
		async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0],
	)
	expect(retained?.id).toBe(savedId)
	expect(retained?.passage.quote).toBe(excerpt)
	expect(retained?.intent).toBe('change')
})

test('thrown send and restored text require outcome check rather than passive wait', async ({ page }) => {
	await open(page)
	await page.evaluate(() => {
		const api = window.__helmDocumentReviewProof?.api
		if (!api) throw new Error('Missing fixture')
		api.send = async () => {
			throw new Error('Fixture delivery uncertainty')
		}
	})
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('A request with unknown delivery')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await page.getByRole('button', { name: 'Restore request text', exact: true }).click()
	await expect(page.getByLabel('Writing status')).toContainText('Check the outcome in your conversation')
	await expect(page.getByLabel('Writing status')).not.toContainText('Wait for the current request')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await page.keyboard.press('Meta+Enter')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

for (const interruption of ['none', 'newer edit', 'owner replacement', 'API replacement'])
	test(`local save is same-task single-flight and fences ${interruption} completion`, async ({ page }) => {
		await open(page)
		await pointerSelect(page)
		const editor = page.getByRole('textbox', { name: 'Passage instruction' })
		await editor.fill('Original saved comment')
		await page.evaluate(() => {
			const api = window.__helmDocumentReviewProof?.api
			if (!api) throw new Error('Missing fixture')
			const original = api.save
			api.save = async value => {
				// Preference autosave is not admission of the explicit annotation effect.
				if (!Object.hasOwn(value, 'archiveRevision')) return original(value)
				const admitted = Reflect.get(window, '__admittedCommentSaves') ?? []
				admitted.push(structuredClone(value))
				Reflect.set(window, '__admittedCommentSaves', admitted)
				await new Promise<void>(resolve => Reflect.set(window, '__releaseCommentSave', resolve))
				api.save = original
				return original(value)
			}
		})
		const action = await commentAction(page)
		await action.evaluate(element => {
			element.click()
			element.click()
		})
		await expect(page.getByText('Saving local comment…', { exact: true })).toBeVisible()
		await expect.poll(() => page.evaluate(() => Reflect.get(window, '__admittedCommentSaves')?.length ?? 0)).toBe(1)
		const admitted = await page.evaluate(async () => ({
			payload: Reflect.get(window, '__admittedCommentSaves')[0],
			state: (await window.__helmDocumentReviewProof?.api.load())?.data,
		}))
		expect(admitted.payload.archiveRevision).toBeNull()
		expect(admitted.payload.instruction).toBe('') // Passage text never enters the whole-document autosave.
		expect(admitted.payload.annotations).toHaveLength(1)
		const annotation = admitted.payload.annotations[0]
		expect(annotation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
		expect(annotation).toMatchObject({ note: 'Original saved comment', intent: 'discuss', resolved: false })
		expect(annotation.passage).toMatchObject({
			quote: selectedParagraphQuote,
			revision: admitted.state?.document.revision,
			kind: 'block',
		})
		expect(annotation.passage.source).toBe(
			admitted.state?.document.text.slice(annotation.passage.start, annotation.passage.end),
		)
		await expect(await commentAction(page, true)).toBeDisabled()
		await expect(page.getByRole('menuitem', { name: /^Clear passage(?: |$)/ })).toBeDisabled()
		await page.keyboard.press('Escape')
		if (interruption === 'none') {
			await expect.poll(() => selectionPaint(page)).toEqual([selectedParagraphQuote])
			const next = 'Read the actual document, refine a passage'
			await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: next }).first(), next)
			await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
			await expect.poll(() => selectionPaint(page)).toEqual([selectedParagraphQuote])
			await expect(passageEditor(page)).toHaveCount(0)
		}
		if (interruption === 'newer edit') await editor.fill('A newer unsaved thought')
		if (interruption === 'owner replacement') await proof(page, 'replaceOwner')
		if (interruption === 'API replacement') await page.evaluate(() => window.__helmDocumentReviewProof?.replaceApi())
		await page.evaluate(() => (Reflect.get(window, '__releaseCommentSave') as () => void)())
		await expect
			.poll(() =>
				page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations.length),
			)
			.toBe(1)
		if (interruption === 'none') {
			await expect(passageEditor(page)).toHaveCount(0)
			await expect.poll(() => selectionPaint(page)).toEqual([selectedParagraphQuote])
			await expect.poll(() => savedAnnotationPaint(page)).toEqual([selectedParagraphQuote])
			await expect.poll(() => paintedText(page)).toEqual([selectedParagraphQuote, selectedParagraphQuote])
		} else {
			await expect(page.getByText('Saved locally · not sent', { exact: true })).toHaveCount(0)
			if (interruption === 'newer edit') await expect(editor).toHaveValue('A newer unsaved thought')
			else await expect(passageEditor(page)).toHaveCount(0)
		}
		await documentView(page, 'Comments')
		await expect(page.locator('.review-comment')).toHaveCount(1)
		if (interruption === 'none')
			await expect(page.locator('.review-comment blockquote')).toHaveText(selectedParagraphQuote)
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	})

for (const interruption of ['owner replacement', 'API replacement'])
	test(`queued local comment behind held preference refuses ${interruption} without dispatch`, async ({ page }) => {
		await open(page)
		const editor = page.getByRole('textbox', { name: 'Passage instruction' })
		await page.evaluate(() => {
			const api = window.__helmDocumentReviewProof?.api
			if (!api) throw new Error('Missing fixture')
			const original = api.save
			const calls: unknown[] = []
			Reflect.set(window, '__queuedCommentSaveCalls', calls)
			api.save = async value => {
				calls.push(structuredClone(value))
				if (Object.hasOwn(value, 'archiveRevision')) return original(value)
				Reflect.set(window, '__heldPreferencePayload', structuredClone(value))
				await new Promise<void>(resolve => Reflect.set(window, '__releasePreferenceSave', resolve))
				const result = await original(value)
				Reflect.set(window, '__preferenceSaveSettled', result)
				return result
			}
		})
		await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Whole draft owns the held preference')
		await pointerSelect(page)
		await editor.fill('Queued unsent comment')
		await expect
			.poll(() => page.evaluate(() => Reflect.get(window, '__heldPreferencePayload')))
			.toMatchObject({ instruction: 'Whole draft owns the held preference', annotations: [] })
		expect(
			await page.evaluate(() => Object.hasOwn(Reflect.get(window, '__heldPreferencePayload'), 'archiveRevision')),
		).toBe(false)
		const action = await commentAction(page)
		await action.evaluate(element => {
			if (!(element instanceof HTMLElement)) throw new Error('Missing native comment menu action')
			element.click()
			element.click()
		})
		await expect(page.getByText('Saving local comment…', { exact: true })).toBeVisible()
		expect(await page.evaluate(() => Reflect.get(window, '__queuedCommentSaveCalls').length)).toBe(1)
		await expect(await commentAction(page, true)).toBeDisabled()
		await page.keyboard.press('Escape')
		if (interruption === 'owner replacement') await proof(page, 'replaceOwner')
		else await page.evaluate(() => window.__helmDocumentReviewProof?.replaceApi())
		await page.evaluate(() => (Reflect.get(window, '__releasePreferenceSave') as () => void)())
		await expect.poll(() => page.evaluate(() => Reflect.get(window, '__preferenceSaveSettled'))).toEqual({ data: true })
		await expect(page.getByRole('alert')).toContainText(
			'This unsaved comment belongs to an earlier document or conversation. Discard it deliberately; nothing was moved.',
		)
		await expect(page.getByText('Saved locally · not sent', { exact: true })).toHaveCount(0)
		await expect(passageEditor(page)).toHaveCount(0)
		await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue(
			'Whole draft owns the held preference',
		)
		expect(
			await page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations),
		).toEqual([])
		await documentView(page, 'Comments')
		await expect(page.locator('.review-comment')).toHaveCount(1)
		await expect(page.locator('.review-comment')).toContainText('Queued unsent comment')
		await expect(page.locator('.review-comment blockquote')).toHaveText(selectedParagraphQuote)
		expect(
			await page.evaluate(() =>
				Reflect.get(window, '__queuedCommentSaveCalls').every(
					(value: { annotations: unknown[]; archiveRevision?: string | null }) =>
						value.annotations.length === 0 && !Object.hasOwn(value, 'archiveRevision'),
				),
			),
		).toBe(true)
		expect(await page.evaluate(() => Reflect.get(window, '__queuedCommentSaveCalls').length)).toBe(1)
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	})

for (const story of ['reading', 'light'])
	test(`${story}: writing invitation and enabled controls use readable secondary text`, async ({ page }) => {
		await open(page, story)
		await pointerSelect(page)
		const colors = await passageEditor(page)
			.locator('.review-writing-surface')
			.evaluate(surface => {
				const reference = document.createElement('span')
				reference.style.color = 'var(--text-1)'
				surface.append(reference)
				const expected = getComputedStyle(reference).color
				reference.remove()
				const editor = surface.querySelector('textarea')
				if (!editor) throw new Error('Missing editor')
				return {
					expected,
					placeholder: getComputedStyle(editor, '::placeholder').color,
					radius: getComputedStyle(editor).borderTopLeftRadius,
					controls: [...surface.querySelectorAll('.review-intents .btn,.review-compose-more .btn')].map(
						control => getComputedStyle(control).color,
					),
				}
			})
		expect(colors.placeholder).toBe(colors.expected)
		expect(colors.radius).toBe('6px')
		for (const color of colors.controls) expect(color).toBe(colors.expected)
		await passageEditor(page).getByRole('button', { name: 'Passage intent: Ask', exact: true }).click()
		for (const color of await page
			.locator('.review-passage-editor .review-intents .menu-item-meta')
			.evaluateAll(elements => elements.map(element => getComputedStyle(element).color)))
			expect(color).toBe(colors.expected)
	})

test('Writing options popup sits eight pixels above its dots trigger within compact viewport', async ({ page }) => {
	await page.setViewportSize({ width: 640, height: 520 })
	await open(page)
	const excerpt = 'The selected owner must remain exact.'
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
	const editor = page.getByRole('textbox', { name: 'Passage instruction' })
	await editor.fill('Retain writing beneath this nearby menu.')
	const trigger = page.getByRole('button', { name: 'Writing options', exact: true })
	await trigger.click()
	const menu = page.getByRole('menu', { name: 'Writing options', exact: true })
	await menu.evaluate(async element => {
		await Promise.all(element.getAnimations().map(animation => animation.finished))
	})
	const triggerBox = await trigger.boundingBox()
	const menuBox = await menu.boundingBox()
	if (!triggerBox || !menuBox) throw new Error('Missing visible Writing options bounds')
	expect(triggerBox.y - (menuBox.y + menuBox.height)).toBeCloseTo(8, 0)
	expect(menuBox.x).toBeGreaterThanOrEqual(0)
	expect(menuBox.y).toBeGreaterThanOrEqual(0)
	expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(640)
	expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(520)
	expect((await editor.boundingBox())?.height).toBeGreaterThanOrEqual(64)
	expect(
		await page.getByRole('menuitem', { name: 'Save local comment', exact: true }).evaluate(element => {
			const r = element.getBoundingClientRect()
			return element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
		}),
	).toBe(true)
	await page.keyboard.press('Escape')
	await expect(trigger).toBeFocused()
	await expect(editor).toHaveValue('Retain writing beneath this nearby menu.')
	await page.setViewportSize({ width: 1280, height: 900 })
	await page.getByRole('separator', { name: 'Resize conversation pane' }).focus()
	await page.keyboard.press('Home')
	await expect(page.getByRole('separator', { name: 'Resize conversation pane' })).toHaveAttribute(
		'aria-valuenow',
		'280',
	)
	await pointerExcerpt(page, page.locator('.review-block-text p').filter({ hasText: excerpt }).first(), excerpt)
	await trigger.click()
	await menu.evaluate(async element => {
		await Promise.all(element.getAnimations().map(animation => animation.finished))
	})
	const narrowTrigger = await trigger.boundingBox()
	const narrowMenu = await menu.boundingBox()
	const companion = await passageEditor(page).boundingBox()
	if (!narrowTrigger || !narrowMenu || !companion) throw new Error('Missing reopened passage Writing options bounds')
	expect(narrowTrigger.y - (narrowMenu.y + narrowMenu.height)).toBeCloseTo(8, 0)
	expect(narrowMenu.x).toBeGreaterThanOrEqual(companion.x)
	expect(narrowMenu.x + narrowMenu.width).toBeLessThanOrEqual(companion.x + companion.width)
	expect(narrowMenu.y).toBeGreaterThanOrEqual(0)
	expect(
		await page.getByRole('menuitem', { name: 'Save local comment', exact: true }).evaluate(element => {
			const r = element.getBoundingClientRect()
			return element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
		}),
	).toBe(true)
	await page.keyboard.press('Escape')
	await expect(trigger).toBeFocused()
	await expect(editor).toHaveValue('Retain writing beneath this nearby menu.')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

for (const story of ['reading', 'light'])
	test(`${story}: compact menus keep writing floor and Writing options beside its trigger`, async ({ page }) => {
		await page.setViewportSize({ width: 640, height: 520 })
		await open(page, story)
		await pointerSelect(page)
		await expect(page.locator('.review-writing-surface blockquote')).toHaveCount(0)
		const editor = page.getByRole('textbox', { name: 'Passage instruction' })
		for (const menu of ['Writing options', 'Passage intent: Ask']) {
			await page.getByRole('button', { name: menu, exact: true }).click()
			const box = await editor.boundingBox()
			expect(box?.height).toBeGreaterThanOrEqual(64)
			if (menu === 'Writing options') {
				await page.getByRole('menu', { name: menu, exact: true }).evaluate(async element => {
					await Promise.all(element.getAnimations().map(animation => animation.finished))
				})
				const triggerBox = await page.getByRole('button', { name: menu, exact: true }).boundingBox()
				const menuBox = await page.getByRole('menu', { name: menu, exact: true }).boundingBox()
				if (!triggerBox || !menuBox) throw new Error('Missing compact Writing options bounds')
				expect(triggerBox.y - (menuBox.y + menuBox.height)).toBeCloseTo(8, 0)
				expect(menuBox.x).toBeGreaterThanOrEqual(0)
				expect(menuBox.y).toBeGreaterThanOrEqual(0)
				expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(640)
				expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(520)
				expect(
					await page.getByRole('menuitem', { name: 'Save local comment', exact: true }).evaluate(element => {
						const r = element.getBoundingClientRect()
						return element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
					}),
				).toBe(true)
			} else {
				expect(
					await editor.evaluate(element => {
						const r = element.getBoundingClientRect()
						return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === element
					}),
				).toBe(true)
			}
			await page.screenshot({
				path: evidencePath(`${story}-compact-writing-${menu.startsWith('Writing') ? 'more' : 'intent'}.png`),
			})
			await page.keyboard.press('Escape')
		}
	})

test('nonempty paused draft gets one immediate send reason; empty writing stays quiet', async ({ page }) => {
	await open(page, 'listener-paused')
	await expect(page.getByLabel('Writing status')).toHaveCount(0)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Waiting draft')
	await expect(page.getByLabel('Writing status')).toContainText('Feedback paused.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('')
	await expect(page.getByLabel('Writing status')).toHaveCount(0)
})
async function proof(page: Page, command: 'settle' | 'edit' | 'replaceOwner', value?: boolean) {
	await page.evaluate(
		({ command, value }) => {
			const fixture = window.__helmDocumentReviewProof
			if (!fixture) throw new Error('Missing production UI fixture')
			if (command === 'settle') fixture.settle(value)
			else fixture[command]()
		},
		{ command, value },
	)
}

for (const story of ['reading', 'light'])
	test(`${story}: narrow pointer selection writes immediately and Escape restores reading`, async ({ page }) => {
		await page.setViewportSize({ width: 640, height: 520 })
		await open(page, story)
		await pointerSelect(page)
		await page.keyboard.type('First thought')
		await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('First thought')
		await expect(page.getByRole('button', { name: 'Document', exact: true })).toHaveAttribute('aria-current', 'page')
		await page.screenshot({ path: evidencePath(`${story}-writing-first-640x520.png`) })
		await page.keyboard.press('Escape')
		await expect(page.locator('.review-reading')).toBeFocused()
		await expect(page.getByRole('button', { name: 'Document', exact: true })).toHaveAttribute('aria-current', 'page')
		await pointerSelect(page)
		await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('First thought')
	})

test('keyboard selection extends and remains copyable until Alt+Enter preserves text and intent', async ({ page }) => {
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Keep keyboard draft')
	await chooseIntent(page, 'change')
	const reading = page.locator('.review-reading')
	await reading.focus()
	await page
		.locator('.review-block-text p')
		.filter({ hasText: 'The selected owner must remain exact.' })
		.first()
		.evaluate(element => {
			const node = element.firstChild
			if (!node) throw new Error('Missing text')
			window.getSelection()?.setBaseAndExtent(node, 0, node, 1)
		})
	await page.keyboard.press('Shift+ArrowRight')
	const first = await page.evaluate(() => window.getSelection()?.toString())
	await page.keyboard.press('Shift+ArrowRight')
	const second = await page.evaluate(() => window.getSelection()?.toString())
	expect(second?.length).toBeGreaterThan(first?.length ?? 0)
	await expect(reading).toBeFocused()
	await page.keyboard.press('Meta+C')
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(second)
	await expect(reading).toBeFocused()
	await page.keyboard.press('Alt+Enter')
	await page.keyboard.type('K')
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('K')
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('Keep keyboard draft')
	await expect(passageEditor(page).getByRole('button', { name: 'Passage intent: Ask', exact: true })).toBeVisible()
	await expect(
		page.locator('.review-companion').getByRole('button', { name: 'Feedback intent: Request change', exact: true }),
	).toBeVisible()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('Source pointer selection keeps exact UTF-16 offsets and receives first character', async ({ page }) => {
	await open(page)
	await documentView(page, 'Source')
	await pointerSelect(page, '.review-full-source', '# Collaborative specification')
	const quote = '# Collaborative specific'
	await expect.poll(() => paintedText(page)).toEqual([quote])
	await page.keyboard.type('S')
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('S')
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.passage?.kind).toBe('exact')
	expect(request?.passage?.quote).toBe(quote)
	expect(request?.passage?.source).toBe(quote)
	const text = await page.evaluate(
		async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.document.text,
	)
	expect(text?.slice(request?.passage?.start, request?.passage?.end)).toBe(quote)
	expect(request?.passage?.start).toBe(0)
	expect(request?.passage?.end).toBe(24)
	expect((request?.passage?.end ?? 0) - (request?.passage?.start ?? 0)).toBe(quote.length)
})

test('routine selections update nonempty whole draft and active passage while preserving text and intent', async ({
	page,
}) => {
	await open(page)
	const whole = page.getByRole('textbox', { name: 'Whole-document message' })
	await whole.fill('Protected whole-document thought')
	await chooseIntent(page, 'change')
	await pointerSelect(page)
	await expect(whole).toHaveValue('Protected whole-document thought')
	await expect(page.getByRole('group', { name: 'Pending selection' })).toHaveCount(0)
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await expect(input).toHaveValue('')
	await chooseIntent(page, 'change')
	await input.fill('Protected passage thought')
	await expect(
		passageEditor(page).getByRole('button', { name: 'Passage intent: Request change', exact: true }),
	).toBeVisible()
	await expect.poll(() => paintedText(page)).toEqual([selectedParagraphQuote])
	await pointerSelect(page, '.review-block-text p', 'Read the actual document, refine a passage')
	await expect.poll(() => paintedText(page)).toEqual([introductionQuote])
	await expect(input).toHaveValue('Protected passage thought')
	await expect(whole).toHaveValue('Protected whole-document thought')
	await expect(input).toBeFocused()
	await expect(
		passageEditor(page).getByRole('button', { name: 'Passage intent: Request change', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toHaveCount(0)
	await input.fill('')
	await expect.poll(() => paintedText(page)).toEqual([introductionQuote])
	await pointerSelect(page)
	await expect.poll(() => paintedText(page)).toEqual([selectedParagraphQuote])
	await expect(input).toHaveValue('')
	await expect(input).toBeFocused()
	await expect(
		passageEditor(page).getByRole('button', { name: 'Passage intent: Request change', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('comment editing and explicit re-anchor retain same annotation and saved Change intent', async ({ page }) => {
	await open(page)
	await pointerSelect(page)
	await chooseIntent(page, 'change')
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('One local annotation')
	await saveLocalComment(page)
	const original = await page.evaluate(
		async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0],
	)
	await page.getByRole('button', { name: 'Edit / send feedback', exact: true }).click()
	await expect(await commentAction(page, true)).toBeEnabled()
	await chooseIntent(page, 'discuss')
	// Changing the unsaved editor intent cannot rewrite the saved re-anchor intent.
	await proof(page, 'edit')
	await documentView(page, 'Comments')
	await page.getByRole('button', { name: 'Re-anchor', exact: true }).click()
	await pointerSelect(page)
	await expect(page.getByText('Choose a current passage to re-anchor your comment.', { exact: false })).toBeVisible()
	await page.getByRole('button', { name: 'Use selection', exact: true }).click()
	await expect(
		passageEditor(page).getByRole('button', { name: 'Passage intent: Request change', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('One local annotation')
	await saveLocalComment(page, true)
	await expect(page.locator('.review-comment')).toHaveCount(1)
	await expect(page.locator('.review-comment-meta')).toContainText('Current source')
	const saved = await page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data)
	expect(saved?.draft.annotations[0]).toMatchObject({ id: original?.id, note: original?.note, intent: 'change' })
	expect(saved?.draft.annotations[0]?.passage.revision).toBe(saved?.document.revision)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

for (const existingScope of ['whole', 'passage'])
	test(`stale saved annotation Edit keeps saved scope and fences effects over existing ${existingScope} draft`, async ({
		page,
	}) => {
		await open(page, 'stale-anchor')
		if (existingScope === 'passage') await pointerSelect(page)
		await chooseIntent(page, 'change')
		await page
			.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })
			.fill('An unrelated draft must never receive the saved comment without its scope.')
		await documentView(page, 'Comments')
		const saved = await page.evaluate(
			async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0],
		)
		await expect(page.locator('.review-comment blockquote')).toHaveText(saved?.passage.quote ?? '')
		await page.getByRole('button', { name: 'Edit / send feedback', exact: true }).click()
		const editor = page.getByRole('textbox', { name: 'Passage instruction' })
		await expect(editor).toBeFocused()
		await expect(editor).toHaveValue(saved?.note ?? '')
		await expect(page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })).toHaveValue(
			'An unrelated draft must never receive the saved comment without its scope.',
		)
		await expect.poll(() => paintedText(page)).toEqual([])
		await expect(page.locator('.review-compose-status')).toContainText('This selection is stale.')
		await expect(passageEditor(page).getByRole('button', { name: 'Passage intent: Ask', exact: true })).toBeVisible()
		await expect(await commentAction(page, true)).toBeDisabled()
		await expect(page.getByRole('button', { name: 'Send passage discussion', exact: true })).toBeDisabled()
		await page.keyboard.press('Meta+Enter')
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
		await page.getByRole('button', { name: 'Re-anchor', exact: true }).click()
		await pointerSelect(page)
		await expect(page.getByText('Choose a current passage to re-anchor your comment.', { exact: false })).toBeVisible()
		await page.getByRole('button', { name: 'Use selection', exact: true }).click()
		await expect(editor).toHaveValue(saved?.note ?? '')
		await expect(await commentAction(page, true)).toBeEnabled()
		await saveLocalComment(page, true)
		await expect(page.locator('.review-comment')).toHaveCount(1)
		await expect(page.locator('.review-comment-meta')).toContainText('Current source')
		await expect(page.locator('.review-comment blockquote')).toHaveText(selectedParagraphQuote)
		const reanchored = await page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data)
		expect(reanchored?.draft.annotations[0]?.passage.quote).toBe(selectedParagraphQuote)
		expect(reanchored?.draft.annotations[0]?.passage.revision).toBe(reanchored?.document.revision)
		expect(reanchored?.draft.annotations[0]?.passage.revision).not.toBe(saved?.passage.revision)
		expect(reanchored?.draft.annotations[0]?.intent).toBe(saved?.intent)
		expect(reanchored?.draft.annotations[0]?.note).toBe(saved?.note)
		await expect
			.poll(async () =>
				page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0]?.id),
			)
			.toBe(saved?.id)
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	})

test('pending and unknown commands fence Use selection without changing scope or replaying', async ({ page }) => {
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Admitted whole request')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await pointerSelect(page)
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
	await proof(page, 'settle', true)
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
})

test('other connected callers do not change passage scope or add a conversation picker', async ({ page }) => {
	await open(page, 'multiple-connected-agents')
	await page.evaluate(() => {
		const fixture = window.__helmDocumentReviewProof
		if (!fixture) throw new Error('Missing fixture')
		fixture.api.selectSession = async () => {
			throw new Error('The renderer must not select a caller')
		}
	})
	await pointerSelect(page)
	const editor = page.getByRole('textbox', { name: 'Passage instruction' })
	await expect(editor).toBeFocused()
	await editor.fill('Keep this with the opener.')
	await expect(page.getByRole('combobox', { name: 'Choose review conversation' })).toHaveCount(0)
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0]?.sessionId)).toBe(
		'review:11111111-1111-4111-8111-111111111111',
	)
})

test('ordinary clicks, programmatic selection and invalid oversized source never open writing', async ({ page }) => {
	await open(page)
	const reading = page.locator('.review-reading')
	await expect(page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })).not.toBeFocused()
	const paragraph = page
		.locator('.review-block-text p')
		.filter({ hasText: 'The selected owner must remain exact.' })
		.first()
	await paragraph.evaluate(element => {
		const range = document.createRange()
		range.selectNodeContents(element)
		window.getSelection()?.removeAllRanges()
		window.getSelection()?.addRange(range)
		document.dispatchEvent(new Event('selectionchange'))
	})
	await reading.dispatchEvent('pointerup')
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
	await paragraph.click({ position: { x: 4, y: 4 } })
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
	await documentView(page, 'Source')
	await reading.focus()
	await page.locator('.review-full-source').evaluate(element => {
		const node = element.firstChild
		if (!node) throw new Error('Missing source')
		window.getSelection()?.setBaseAndExtent(node, 0, node, 8001)
	})
	await reading.dispatchEvent('keyup', { key: 'Shift' })
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeVisible()
	await expect(page.getByRole('alert')).not.toContainText('Select one source block')
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
	await expect(reading).toBeFocused()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().saved)).toBe(0)
})

test('refresh and owner replacement invalidate pending selection without stealing newer focus', async ({ page }) => {
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Keep local text')
	for (const boundary of ['edit', 'replaceOwner'] as const) {
		await page.locator('.review-reading').focus()
		await page
			.locator('.review-block-text p')
			.filter({ hasText: 'The selected owner must remain exact.' })
			.first()
			.evaluate(element => {
				const node = element.firstChild
				if (!node) throw new Error('Missing keyboard fixture text')
				window.getSelection()?.setBaseAndExtent(node, 0, node, 1)
			})
		await page.keyboard.press('Shift+ArrowRight')
		await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeVisible()
		await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('Keep local text')
		await proof(page, boundary)
		await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toHaveCount(0)
	}
	const newer = page.getByRole('button', { name: 'Contents', exact: true })
	await newer.focus()
	await page.evaluate(
		() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	)
	await expect(newer).toBeFocused()
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('Keep local text')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('complete large Markdown, safe content, Contents, and wide dark layout', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	let remoteRequests = 0
	page.on('request', request => {
		if (request.url().includes('never-fetch.invalid')) remoteRequests++
	})
	await open(page)
	await expect(page.locator('.review-prose h3')).toHaveCount(500)
	await expect(page.locator('.review-prose table')).toHaveCount(1)
	await expect(page.locator('.review-prose pre')).toContainText('sameConversation')
	await expect(page.locator('.review-prose img')).toHaveCount(0)
	expect(remoteRequests).toBe(0)
	await page.getByRole('button', { name: 'Contents', exact: true }).click()
	await expect(page.getByRole('navigation', { name: 'Contents', exact: true })).toBeVisible()
	await page
		.getByRole('navigation', { name: 'Contents', exact: true })
		.getByRole('button', { name: 'Final acceptance', exact: true })
		.click()
	await expect(page.getByText('Final acceptance sentinel: nothing truncated.', { exact: true })).toBeVisible()
	await expect(page.getByRole('heading', { name: 'Claude Code · specification', exact: true })).toBeVisible()
	const divider = page.getByRole('separator', { name: 'Resize conversation pane' })
	await divider.focus()
	await page.keyboard.press('ArrowLeft')
	await expect(divider).toHaveAttribute('aria-valuenow', '400')
	await page.keyboard.press('ArrowRight')
	await expect(divider).toHaveAttribute('aria-valuenow', '380')
	await page.screenshot({ path: evidencePath('wide-dark-outline-tail.png') })
})

test('selection preserves source block, chosen owner, and same-task double-submit is single-flight', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await selectPassage(page)
	await chooseIntent(page, 'discuss')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await expect(input).toBeFocused()
	await input.fill('Explain this guarantee precisely.')
	await page.screenshot({ path: evidencePath('wide-dark-anchored-discuss.png') })
	await input.evaluate(element => {
		for (let i = 0; i < 2; i++)
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
	})
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.intent).toBe('discuss')
	expect(request?.sessionId).toBe('review:11111111-1111-4111-8111-111111111111')
	expect(request?.passage?.source).toContain('**rendered quote**')
	expect(request?.passage?.quote).toContain('rendered quote')
	expect(request?.passage?.kind).toBe('block')
	await expect(page.getByRole('button', { name: 'Send passage discussion', exact: true })).toBeDisabled()
	await proof(page, 'settle')
	await expect(input).toHaveValue('')
	await page.getByRole('button', { name: 'Writing options', exact: true }).click()
	await page.getByRole('menuitem', { name: /^Clear passage(?: |$)/ }).click()
	const chat = page.getByRole('textbox', { name: 'Whole-document message' })
	await chat.fill('Continue the wider discussion.')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(2)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests[1]?.sessionId)).toBe(request?.sessionId)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests[1]?.passage)).toBeNull()
})

test('keyboard text selection, Escape focus restoration, and explicit change intent', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await keyboardHeading(page, 'Dispatch guarantees')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await expect(input).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(page.locator('.review-reading')).toBeFocused()
	await selectPassage(page)
	await chooseIntent(page, 'change')
	await input.fill('Clarify this paragraph without changing its meaning.')
	await page.getByRole('button', { name: 'Send change request', exact: true }).click()
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.requests[0]?.intent)).toBe('change')
})

test('comments edit, resolve, orphan, explicitly re-anchor, and delete without provider sends', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await selectPassage(page)
	await chooseIntent(page, 'discuss')
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('A saved annotation note.')
	await saveLocalComment(page)
	await expect(page.locator('.review-comment')).toContainText('A saved annotation note.')
	const original = await page.evaluate(
		async () => (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0],
	)
	await page.getByRole('button', { name: 'Edit / send feedback', exact: true }).click()
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Edited annotation note.')
	await saveLocalComment(page, true)
	await page.getByRole('button', { name: 'Resolve', exact: true }).click()
	await expect(page.locator('.review-comment-meta')).toContainText('Resolved')
	await expect
		.poll(() =>
			page.evaluate(async () => {
				const saved = (await window.__helmDocumentReviewProof?.api.load())?.data?.draft.annotations[0]
				return saved ? { id: saved.id, intent: saved.intent, resolved: saved.resolved } : null
			}),
		)
		.toEqual({ id: original?.id, intent: original?.intent, resolved: true })
	await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeEnabled()
	await expect(page.getByText('Saving local comment…', { exact: true })).toHaveCount(0)
	await proof(page, 'edit')
	await expect(page.locator('.review-comment-meta')).toContainText('Anchor changed')
	await page.getByRole('button', { name: 'Re-anchor', exact: true }).click()
	await expect(page.getByText('Choose a current passage to re-anchor your comment.', { exact: false })).toBeVisible()
	await selectPassage(page)
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeEnabled()
	await page.getByRole('button', { name: 'Use selection', exact: true }).click()
	await chooseIntent(page, 'discuss')
	await saveLocalComment(page, true)
	await expect(page.locator('.review-comment-meta')).toContainText('Current source')
	const reanchored = await page.evaluate(async () => (await window.__helmDocumentReviewProof?.api.load())?.data)
	expect(reanchored?.draft.annotations[0]?.id).toBe(original?.id)
	expect(reanchored?.draft.annotations[0]?.intent).toBe(original?.intent)
	expect(reanchored?.draft.annotations[0]?.resolved).toBe(true)
	expect(reanchored?.draft.annotations[0]?.passage.quote).toBe(selectedParagraphQuote)
	expect(reanchored?.draft.annotations[0]?.passage.revision).toBe(reanchored?.document.revision)
	expect(reanchored?.draft.annotations[0]?.passage.revision).not.toBe(original?.passage.revision)
	await page.screenshot({ path: evidencePath('wide-dark-comment-lifecycle.png') })
	await page.getByRole('button', { name: 'Delete', exact: true }).click()
	await expect(page.locator('.review-comment')).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('external edit retires the passage DOM, retains the draft for explicit selection, and exposes change review', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await selectPassage(page)
	await chooseIntent(page, 'change')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('Keep my in-progress note.')
	await proof(page, 'edit')
	await expect(passageEditor(page)).toHaveCount(0)
	await expect.poll(() => selectionPaint(page)).toEqual([])
	await page.keyboard.press('Meta+Enter')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	await documentView(page, 'Changes')
	await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible()
	await expect(page.locator('.review-change-view')).toContainText('External edit sentinel.')
	await page.screenshot({ path: evidencePath('wide-dark-change-review.png') })
	await page.getByRole('button', { name: 'Back to reading', exact: true }).click()
	await selectPassage(page)
	await expect(input).toHaveValue('Keep my in-progress note.')
	await expect(input).toBeFocused()
	await expect(page.locator('.review-companion').getByRole('textbox', { name: 'Whole-document message' })).toHaveValue(
		'',
	)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('unknown outcomes retain text, require explicit acknowledgement, and never replay', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Retain this request text.')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await proof(page, 'settle', true)
	await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await page.getByRole('button', { name: 'Restore request text', exact: true }).click()
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('Retain this request text.')
	await page.getByRole('button', { name: 'I checked the outcome', exact: true }).click()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
	await page.screenshot({ path: evidencePath('wide-dark-unknown-recovery.png') })
})

test('replacement owner fences late send results and cannot silently receive another request', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('A held send.')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await proof(page, 'replaceOwner')
	await expect(
		page.getByText(
			'The conversation owner changed. Close this window and reopen the document from the original agent.',
			{
				exact: true,
			},
		),
	).toBeVisible()
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Never route to a replacement implicitly.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
})

for (const story of ['reading', 'light'])
	test(`${story}: wide/narrow visual, accessible reading owners and reduced motion`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' })
		for (const [width, height] of [
			[1280, 900],
			[800, 620],
			[640, 520],
		] as const) {
			await page.setViewportSize({ width, height })
			await open(page, story)
			await expect(page.getByLabel('Document reading area', { exact: true })).toHaveAttribute('tabindex', '0')
			expect(
				await page
					.locator('.review-reading')
					.first()
					.evaluate(element => getComputedStyle(element).transitionDuration),
			).toBe('0s')
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			if (width < 960) {
				await page.getByRole('button', { name: 'Conversation', exact: true }).click()
				await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
				const button = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
				expect(button && button.y + button.height <= height).toBe(true)
				await page.screenshot({ path: evidencePath(`${story}-${width}x${height}-conversation.png`) })
				await page.getByRole('button', { name: 'Document', exact: true }).click()
			}
			await page.screenshot({ path: evidencePath(`${story}-${width}x${height}-document.png`) })
		}
	})

test('external callers cannot redirect the opener’s unsent draft or feedback', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	const input = page.getByRole('textbox', { name: 'Whole-document message' })
	await input.fill('Draft for the original conversation.')
	const connected = await page.evaluate(() => window.__helmDocumentReviewProof?.connect('codex'))
	expect(connected).toBeTruthy()
	await expect(page.getByRole('combobox', { name: 'Choose review conversation' })).toHaveCount(0)
	await expect(page.locator('.review-conversation-header h2')).toHaveText('Claude Code · specification')
	await expect(input).toHaveValue('Draft for the original conversation.')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.sessionId).toBe('review:11111111-1111-4111-8111-111111111111')
	expect(request?.owner).toBe('22222222-2222-4222-8222-222222222222')
	expect(request?.instruction).toBe('Draft for the original conversation.')
	expect(request?.sessionId).not.toBe(connected)
})

test('absent/paused callers keep drafts not sent and no UI action launches an agent', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	for (const story of ['no-connected-agent', 'listener-paused']) {
		await open(page, story)
		const input = page.getByRole('textbox', { name: 'Whole-document message' })
		await input.fill('Keep this feedback in the current review.')
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
		await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toHaveCount(0)
		await page.evaluate(() => window.__helmDocumentReviewProof?.connect('pi'))
		await expect(page.getByRole('combobox', { name: 'Choose review conversation' })).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
		await input.press('Meta+Enter')
		await page.evaluate(() => window.__helmDocumentReviewProof?.disconnect())
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
		await expect(input).toHaveValue('Keep this feedback in the current review.')
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	}
})

test('failed draft saves offer explicit local discard without provider delivery', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page, 'save-failure')
	const input = page.getByRole('textbox', { name: 'Whole-document message' })
	await input.fill('This unsaved local change may be discarded.')
	await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Discard unsaved changes', exact: true }).click()
	await expect(input).toHaveValue('')
	await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('missing file preserves readable bytes and blocks sends until explicit successful retry', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page, 'missing-file')
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Cannot send against an unavailable file.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await expect(page.locator('.review-prose h1')).toContainText('Collaborative specification')
	await page.screenshot({ path: evidencePath('wide-dark-missing-file.png') })
	await page.getByRole('button', { name: 'Retry read', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
})

test('separate passage editor preserves draft and reading anchor across resize without copying into companion', async ({
	page,
}) => {
	await page.setViewportSize({ width: 800, height: 620 })
	await open(page)
	const reading = page.locator('.review-reading')
	await keyboardHeading(page, 'Dispatch guarantees')
	const scroll = await page.locator('.review-reading').evaluate(element => element.scrollTop)
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await expect(input).toBeFocused()
	await expect(page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })).toHaveCount(1)
	await expect(page.locator('.review-companion .review-writing-surface')).toHaveCount(1)
	await expect(passageEditor(page).getByRole('button', { name: 'Passage intent: Ask', exact: true })).toBeVisible()
	await chooseIntent(page, 'change')
	await expect(
		passageEditor(page).getByRole('button', { name: 'Passage intent: Request change', exact: true }),
	).toBeVisible()
	await input.fill('Keep this scope and draft across layouts.')
	await page.keyboard.press('Escape')
	await expect(reading).toBeFocused()
	await keyboardHeading(page, 'Dispatch guarantees')
	await expect(input).toHaveValue('Keep this scope and draft across layouts.')
	await input.focus()
	await page.setViewportSize({ width: 1280, height: 900 })
	await expect(input).toBeFocused()
	await expect(input).toHaveValue('Keep this scope and draft across layouts.')
	await page.setViewportSize({ width: 640, height: 520 })
	await expect(input).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(reading).toBeFocused()
	expect(await page.locator('.review-reading').evaluate(element => element.scrollTop)).toBe(scroll)
	await keyboardHeading(page, 'Dispatch guarantees')
	await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'Writing options', exact: true }).click()
	await page.getByRole('menuitem', { name: /^Clear passage(?: |$)/ }).click()
	await page.getByRole('button', { name: 'Conversation', exact: true }).click()
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('')
	await page.getByRole('button', { name: 'Document', exact: true }).click()
	await keyboardHeading(page, 'Dispatch guarantees')
	await expect(input).toHaveValue('Keep this scope and draft across layouts.')
})

for (const story of ['reading', 'light'])
	test(`${story}: passage at exact sizes and bounded long quote/draft/receipt`, async ({ page }) => {
		for (const [width, height] of [
			[1280, 900],
			[800, 620],
			[640, 520],
		] as const) {
			await page.setViewportSize({ width, height })
			await open(page, story)
			await selectPassage(page)
			await chooseIntent(page, 'discuss')
			const input = page.getByRole('textbox', { name: 'Passage instruction' })
			await expect(input).toBeFocused()
			await input.fill('Explain this guarantee precisely, keeping the original conversation and source block.')
			await expect(page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })).toHaveCount(1)
			const bounds = await page.getByRole('button', { name: 'Send passage discussion', exact: true }).boundingBox()
			expect(bounds && bounds.y + bounds.height <= height).toBe(true)
			await page.screenshot({ path: evidencePath(`${story}-${width}x${height}-passage.png`) })
		}
		await page.getByRole('button', { name: 'Writing options', exact: true }).click()
		await page.getByRole('menuitem', { name: /^Clear passage(?: |$)/ }).click()
		await page.evaluate(() =>
			window.__helmDocumentReviewProof?.edit('Preserve the original session and exact source block. '.repeat(100)),
		)
		await page.getByRole('button', { name: 'Document', exact: true }).click()
		await pointerExcerpt(
			page,
			page.locator('.review-block-text p').last(),
			'Preserve the original session and exact source block.',
		)
		await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toHaveCount(0)
		const input = page.getByRole('textbox', { name: 'Passage instruction' })
		await input.fill('A request with an uncertain receipt.')
		await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
		await proof(page, 'settle', true)
		await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible()
		await input.fill('A long unsent local draft.\n'.repeat(100))
		await expect(page.getByRole('button', { name: 'Send passage discussion', exact: true })).toHaveText('Send')
		await expect(page.locator('.review-receipt')).toBeVisible()
		const bounds = await page.getByRole('button', { name: 'Send passage discussion', exact: true }).boundingBox()
		expect(bounds && bounds.y + bounds.height <= 520).toBe(true)
		await page.screenshot({ path: evidencePath(`${story}-640x520-long-passage-draft-receipt.png`) })
	})

test('paused/disconnected listeners retain passage drafts and local comments without sends', async ({ page }) => {
	await page.setViewportSize({ width: 800, height: 620 })
	await open(page, 'listener-paused')
	await selectPassage(page)
	await chooseIntent(page, 'discuss')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('Local comment while the listener is paused.')
	await expect(page.getByRole('button', { name: 'Send passage discussion', exact: true })).toBeDisabled()
	await expect(await commentAction(page)).toBeEnabled()
	await page.evaluate(() => window.__helmDocumentReviewProof?.disconnect())
	await expect(input).toHaveValue('Local comment while the listener is paused.')
	await expect(page.getByRole('button', { name: 'Send passage discussion', exact: true })).toBeDisabled()
	await saveLocalComment(page)
	await expect(page.locator('.review-comment')).toContainText('Local comment while the listener is paused.')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('dispatch settlement preserves a newer draft and the selected passage', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await selectHeading(page, 'Dispatch guarantees')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('The admitted request.')
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	await input.fill('A newer unsent draft.')
	await proof(page, 'settle')
	await expect(input).toHaveValue('A newer unsent draft.')
	await expect(page.locator('.review-block[data-selected="true"]')).toHaveCount(1)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
})

for (const story of ['reading', 'light']) {
	test(`${story}: slim visible scrollbars retain keyboard scrolling`, async ({ page }) => {
		await page.setViewportSize({ width: 1202, height: 813 })
		await open(page, story)
		const reading = page.locator('.review-reading')
		const chrome = await reading.evaluate(element => {
			const bar = getComputedStyle(element, '::-webkit-scrollbar')
			const track = getComputedStyle(element, '::-webkit-scrollbar-track')
			const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb')
			return {
				width: bar.width,
				display: bar.display,
				track: track.backgroundColor,
				thumb: thumb.backgroundColor,
				border: thumb.borderLeftWidth,
				overflow: getComputedStyle(element).overflowY,
				scrollable: element.scrollHeight > element.clientHeight,
			}
		})
		expect(chrome.width).toBe('10px')
		expect(chrome.display).not.toBe('none')
		expect(chrome.track).toBe('rgba(0, 0, 0, 0)')
		expect(chrome.thumb).not.toBe('rgba(0, 0, 0, 0)')
		expect(chrome.border).toBe('3px')
		expect(chrome.overflow).toBe('auto')
		expect(chrome.scrollable).toBe(true)
		await reading.focus()
		await page.keyboard.press('PageDown')
		await expect.poll(() => reading.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
		await page.screenshot({ path: evidencePath(`${story}-quiet-scrollbars.png`) })
	})
}

for (const story of ['editorial', 'editorial-light']) {
	test(`${story}: single conversation is just a bounded name and status with no setup chrome`, async ({ page }) => {
		for (const [width, height] of [
			[1197, 807],
			[640, 520],
		] as const) {
			await page.setViewportSize({ width, height })
			await open(page, story)
			if (width === 640) await page.getByRole('button', { name: 'Conversation', exact: true }).click()
			const header = page.locator('.review-conversation-header')
			await expect(header.locator('h2')).toContainText('intentionally long original Pi session name')
			await expect(header).toContainText('Pi · Ready')
			await expect(header.locator('details')).toHaveCount(0)
			await expect(page.getByRole('combobox', { name: 'Choose review conversation' })).toHaveCount(0)
			await expect(page.getByText('Select a passage or write below.', { exact: true })).toHaveCount(0)
			await expect(page.getByRole('heading', { name: 'Ask about this document', exact: true })).toHaveCount(0)
			await expect(page.locator('.review-chat')).toHaveText('')
			expect((await header.boundingBox())?.height).toBeLessThanOrEqual(96)
			await page.getByRole('textbox', { name: 'Whole-document message' }).fill('My unsent thought.')
			await page.screenshot({ path: evidencePath(`${story}-${width}x${height}-simple-conversation.png`) })
			expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
		}
	})
}

test('paused feedback is not a disconnected conversation and header exposes no technical identities', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1202, height: 813 })
	await open(page, 'listener-paused')
	const header = page.locator('.review-conversation-header')
	await expect(header).toContainText('Feedback paused')
	await expect(header).not.toContainText('Disconnected')
	const input = page.getByRole('textbox', { name: 'Whole-document message' })
	await input.fill('Keep this until feedback resumes.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await expect(page.getByRole('combobox', { name: 'Choose review conversation' })).toHaveCount(0)
	await expect(header.locator('details')).toHaveCount(0)
	await expect(header).not.toContainText('Caller:')
	await expect(header).not.toContainText('Owner:')
	await expect(header).not.toContainText('helm review')
	await expect(header).not.toContainText('11111111-1111-4111-8111-111111111111')
	await expect(header).not.toContainText('22222222-2222-4222-8222-222222222222')
	await page.screenshot({ path: evidencePath('paused-clean-conversation.png') })
	await page.evaluate(() => window.__helmDocumentReviewProof?.replaceOwner())
	await expect(header).toContainText('Needs attention')
	await expect(page.getByRole('combobox', { name: 'Choose review conversation' })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('document details preserve keyboard access and drafts without conversation selection', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page, 'editorial')
	const input = page.getByRole('textbox', { name: 'Whole-document message' })
	await input.fill('Keep my unsent thought while browsing.')
	await expect(page.getByRole('combobox', { name: 'Choose review conversation' })).not.toBeVisible()
	const more = page.getByRole('button', { name: 'Document options', exact: true })
	await more.focus()
	await page.keyboard.press('ArrowDown')
	await expect(page.getByRole('menuitemradio', { name: 'Read', exact: true })).toBeFocused()
	await page.keyboard.press('ArrowDown')
	await expect(page.getByRole('menuitemradio', { name: 'Source', exact: true })).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(more).toBeFocused()
	for (const destination of ['Source', 'Changes', 'Comments']) {
		await documentView(page, destination)
		await expect(page.locator('.review-active-view')).toHaveText(destination)
		await page.getByRole('button', { name: 'Back to reading', exact: true }).click()
		await expect(input).toHaveValue('Keep my unsent thought while browsing.')
	}
	await more.click()
	await page.getByRole('menuitemcheckbox', { name: 'Document details', exact: true }).click()
	await expect(page.getByRole('region', { name: 'Document details' })).toContainText('docs/plans/review/spec.md')
	await expect(page.getByRole('region', { name: 'Document details' })).toContainText(
		'0000000000000000000000000000000000000000000000000000000000000001',
	)
	await expect(page.locator('.review-permission-note')).toBeVisible()
	await expect(page.locator('.review-permission-note')).toContainText('not a new sandbox')
	await page.getByRole('button', { name: 'Hide details', exact: true }).click()
	await more.click()
	await input.click()
	await expect(page.getByRole('menu', { name: 'Document options' })).toHaveCount(0)
	await expect(page.locator('.review-conversation-header h2')).toContainText(
		'intentionally long original Pi session name',
	)
	await page.evaluate(() => window.__helmDocumentReviewProof?.connect('codex'))
	await expect(page.getByRole('combobox', { name: 'Choose review conversation' })).toHaveCount(0)
	await expect(page.locator('.review-conversation-header h2')).toContainText(
		'intentionally long original Pi session name',
	)
	await expect(page.locator('.review-conversation-header')).not.toContainText('Caller:')
	await expect(page.locator('.review-conversation-header')).not.toContainText('Owner:')
	await expect(page.locator('.review-conversation-header')).not.toContainText('helm review')
	await input.focus()
	await expect(input).toBeFocused()
	await expect(input).toHaveValue('Keep my unsent thought while browsing.')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('Back to reading returns from Conversation to Document without losing passage or draft', async ({ page }) => {
	await page.setViewportSize({ width: 640, height: 520 })
	await open(page, 'editorial')
	await selectHeading(page, 'Start with the document')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('Preserve this passage and unsent draft.')
	await documentView(page, 'Source')
	await page.getByRole('button', { name: 'Conversation', exact: true }).click()
	await expect(passageEditor(page)).toHaveCount(0)
	const whole = page.getByRole('textbox', { name: 'Whole-document message' })
	await whole.fill('Separate whole-document draft.')
	const back = page.getByRole('button', { name: 'Back to reading', exact: true })
	await back.focus()
	await page.keyboard.press('Enter')
	await expect(page.getByLabel('Document reading area', { exact: true })).toBeVisible()
	await expect(page.locator('.review-prose')).toBeVisible()
	await expect(page.locator('.review-full-source')).toHaveCount(0)
	await expect(page.locator('.review-block[data-selected="true"]')).toHaveCount(1)
	await expect(page.getByRole('button', { name: 'Document options', exact: true })).toBeFocused()
	await expect(back).toHaveCount(0)
	await selectHeading(page, 'Start with the document')
	await expect(input).toHaveValue('Preserve this passage and unsent draft.')
	await expect(await commentAction(page)).toBeVisible()
	// A programmatic activation in split view must not steal a newer companion focus.
	await page.setViewportSize({ width: 1197, height: 807 })
	await documentView(page, 'Source')
	await whole.focus()
	await back.evaluate(element => element.click())
	await expect(whole).toBeFocused()
	await expect(whole).toHaveValue('Separate whole-document draft.')
	await selectHeading(page, 'Start with the document')
	await expect(input).toHaveValue('Preserve this passage and unsent draft.')
	await expect(page.locator('.review-block[data-selected="true"]')).toHaveCount(1)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

async function actionInnerBounds(page: Page) {
	return passageEditor(page)
		.locator('.review-compose-actions')
		.evaluate(row => {
			const surface = row.closest<HTMLElement>('.review-writing-surface')
			if (!surface) throw new Error('Missing writing surface')
			const r = row.getBoundingClientRect()
			const w = surface.getBoundingClientRect()
			const css = getComputedStyle(surface)
			const inner = {
				left: w.left + Number.parseFloat(css.paddingLeft) + Number.parseFloat(css.borderLeftWidth),
				right: w.right - Number.parseFloat(css.paddingRight) - Number.parseFloat(css.borderRightWidth),
				top: w.top + Number.parseFloat(css.paddingTop) + Number.parseFloat(css.borderTopWidth),
				bottom: w.bottom - Number.parseFloat(css.paddingBottom) - Number.parseFloat(css.borderBottomWidth),
			}
			return {
				inner,
				row: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
				controls: [...row.querySelectorAll('button')]
					.filter(button => button.getClientRects().length)
					.map(button => {
						const b = button.getBoundingClientRect()
						return {
							label: button.textContent,
							left: b.left,
							right: b.right,
							top: b.top,
							bottom: b.bottom,
							inside:
								b.left >= inner.left &&
								b.right <= inner.right &&
								b.top >= inner.top &&
								b.bottom <= inner.bottom &&
								b.left >= r.left &&
								b.right <= r.right &&
								b.top >= r.top &&
								b.bottom <= r.bottom,
							unclipped: button.scrollWidth <= button.clientWidth,
							inViewport: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
						}
					}),
			}
		})
}

for (const width of [280, 360, 380])
	for (const localAction of ['Keep comment', 'Save comment'])
		test(`${width}px companion: ${localAction} and idle/busy Send stay within action inner bounds`, async ({
			page,
		}, testInfo) => {
			await page.setViewportSize({ width: 1197, height: 807 })
			await open(page, 'editorial')
			if (width === 380 && localAction === 'Keep comment')
				await page.screenshot({ path: evidencePath('operator-1197x807-idle.png') })
			await selectHeading(page, 'Start with the document')
			const input = page.getByRole('textbox', { name: 'Passage instruction' })
			await input.fill('Preserve this local passage feedback.')
			if (localAction === 'Save comment') {
				await saveLocalComment(page)
				await page.getByRole('button', { name: 'Edit / send feedback', exact: true }).click()
				await expect(input).toHaveValue('Preserve this local passage feedback.')
				await documentView(page, 'Read')
			}
			const divider = page.getByRole('separator', { name: 'Resize conversation pane' })
			if (width !== 380) {
				await divider.focus()
				await page.keyboard.press('Home')
				for (let next = 300; next <= width; next += 20) {
					await page.keyboard.press('ArrowLeft')
					await expect(divider).toHaveAttribute('aria-valuenow', String(next))
				}
			}
			expect(await page.locator('.review-companion').evaluate(element => element.getBoundingClientRect().width)).toBe(
				width,
			)
			// Resizing the companion deliberately dismisses the popover; reopen the same source scope.
			await selectHeading(page, 'Start with the document')
			if (localAction === 'Save comment') {
				// A saved annotation retains association; accepting a new visual range is explicit.
				const use = page.getByRole('button', { name: 'Use selection', exact: true })
				await expect(use).toBeEnabled()
				await use.click()
			}
			await expect(input).toHaveValue('Preserve this local passage feedback.')
			await expect(passageEditor(page).getByRole('button', { name: 'Passage intent: Ask', exact: true })).toBeVisible()
			await page.evaluate(() => {
				const fixture = window.__helmDocumentReviewProof
				if (!fixture) throw new Error('Missing production-component fixture')
				const original = fixture.api.send
				fixture.api.send = async request => {
					const result = original(request)
					await new Promise<void>(resolve => Object.assign(window, { __reviewReleaseSend: resolve }))
					return result
				}
			})
			const send = page.getByRole('button', { name: 'Send passage discussion', exact: true })
			for (const phase of ['idle', 'busy']) {
				if (phase === 'busy') {
					await send.click()
					await expect(send).toHaveText('Send…')
					await expect(send).toBeDisabled()
				}
				const measured = await actionInnerBounds(page)
				expect(measured.controls.map(control => control.label)).toEqual([
					'',
					'Ask',
					phase === 'busy' ? 'Send…' : 'Send',
				])
				for (const control of measured.controls) {
					expect(control.inside, JSON.stringify({ inner: measured.inner, row: measured.row, control })).toBe(true)
					expect(control.unclipped, JSON.stringify(control)).toBe(true)
					expect(control.inViewport, JSON.stringify(control)).toBe(true)
				}
				await testInfo.attach(`${width}-${localAction}-${phase}-inner-bounds`, {
					body: JSON.stringify(measured, null, 2),
					contentType: 'application/json',
				})
				await page.screenshot({
					path: evidencePath(
						`operator-1197x807-companion-${width}-${localAction === 'Keep comment' ? 'keep' : 'save'}-${phase}.png`,
					),
				})
			}
			await page.evaluate(() => {
				const release = Reflect.get(window, '__reviewReleaseSend') as (() => void) | undefined
				release?.()
				Reflect.deleteProperty(window, '__reviewReleaseSend')
			})
			await expect(send).toHaveText('Send')
			expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
		})

test('passage intent stays owned across companion resize without changing the whole-document intent', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page, 'editorial')
	await selectHeading(page, 'Start with the document')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('Keep this passage draft through a resize.')
	const divider = page.getByRole('separator', { name: 'Resize conversation pane' })
	await divider.focus()
	await page.keyboard.press('Home')
	expect(await page.locator('.review-companion').evaluate(element => element.getBoundingClientRect().width)).toBe(280)
	await selectHeading(page, 'Start with the document')
	const intent = passageEditor(page).getByRole('button', { name: 'Passage intent: Ask', exact: true })
	await intent.focus()
	await page.keyboard.press('ArrowDown')
	await expect(page.getByRole('menuitemradio', { name: /^Ask(?: |$)/ })).toHaveAttribute('aria-checked', 'true')
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('Enter')
	const changed = passageEditor(page).getByRole('button', { name: 'Passage intent: Request change', exact: true })
	await expect(changed).toHaveText('Request change')
	await expect(changed).toBeFocused()
	const row = await passageEditor(page).locator('.review-compose-actions').boundingBox()
	for (const name of ['Passage intent: Request change', 'Writing options', 'Send change request']) {
		const bounds = await passageEditor(page).getByRole('button', { name, exact: true }).boundingBox()
		expect(bounds && row && bounds.x >= row.x && bounds.x + bounds.width <= row.x + row.width).toBe(true)
		expect(bounds && row && bounds.y >= row.y && bounds.y + bounds.height <= row.y + row.height).toBe(true)
	}
	await changed.press('ArrowDown')
	await page.keyboard.press('Escape')
	await expect(changed).toBeFocused()
	await page.screenshot({ path: evidencePath('editorial-1280x900-companion-280.png') })
	await changed.press('ArrowDown')
	// Drive the real divider handler without shifting the intent-owned focus.
	for (const width of [300, 320, 340, 360]) {
		await divider.evaluate(element =>
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
		)
		await expect(divider).toHaveAttribute('aria-valuenow', String(width))
	}
	await expect(passageEditor(page).getByRole('menu', { name: 'Passage intent: Request change' })).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(changed).toBeFocused()
	await expect(input).toHaveValue('Keep this passage draft through a resize.')
	await input.focus()
	await divider.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
	await expect(input).toBeFocused()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

for (const story of ['editorial', 'editorial-light'])
	test(`${story}: reading-first exact viewport evidence and bounded details/recovery`, async ({ page }) => {
		for (const [width, height] of [
			[1197, 807],
			[1280, 900],
			[640, 520],
		] as const) {
			await page.setViewportSize({ width, height })
			await open(page, story)
			await expect(page.locator('.review-conversation-header details')).toHaveCount(0)
			await expect(page.locator('.review-identity')).not.toContainText('docs/plans')
			await expect(page.getByText('Ready to refine', { exact: true })).toHaveCount(0)
			await page.screenshot({ path: evidencePath(`${story}-${width}x${height}-idle.png`) })
			if (width === 640) await page.getByRole('button', { name: 'Conversation', exact: true }).click()
			await expect(page.getByText('Pi · Ready', { exact: true })).toBeVisible()
			await page.screenshot({ path: evidencePath(`${story}-${width}x${height}-empty-conversation.png`) })
			if (width === 640) await page.getByRole('button', { name: 'Document', exact: true }).click()
			await selectHeading(page, 'Start with the document')
			const input = page.getByRole('textbox', { name: 'Passage instruction' })
			await input.fill('Explain this passage.')
			await expect(page.locator('.review-writing-surface blockquote')).toHaveCount(0)
			await page.screenshot({ path: evidencePath(`${story}-${width}x${height}-passage-writing.png`) })
			await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
			await proof(page, 'settle', true)
			await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible()
			await input.fill('Keep a newer unsent thought.')
			await proof(page, 'edit')
			await expect(passageEditor(page)).toHaveCount(0)
			await expect.poll(() => selectionPaint(page)).toEqual([])
			await selectHeading(page, 'Start with the document')
			await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
			await expect(passageEditor(page)).toHaveCount(0)
			if (width === 640) await page.getByRole('button', { name: 'Conversation', exact: true }).click()
			await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Independent whole-document draft.')
			await expect(
				page.locator('.review-companion').getByRole('button', { name: 'Send message', exact: true }),
			).toBeDisabled()
			const measured = await compactBounds(page, false)
			for (const control of measured.controls) expect(control.fullyInside, JSON.stringify(control)).toBe(true)
			expect(measured.chat.height).toBeGreaterThanOrEqual(96)
			expect(measured.receipt.height).toBeGreaterThanOrEqual(32)
			await page.screenshot({ path: evidencePath(`${story}-${width}x${height}-retired-passage-recovery.png`) })
			await page.getByRole('button', { name: 'I checked the outcome', exact: true }).click()
			await expect(passageEditor(page)).toHaveCount(0)
			if (width === 640) await page.getByRole('button', { name: 'Document', exact: true }).click()
			await selectHeading(page, 'Start with the document')
			await expect(input).toHaveValue('Keep a newer unsent thought.')
			await expect(page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })).toHaveValue(
				'Independent whole-document draft.',
			)
			expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
		}
	})

async function compactBounds(page: Page, passage = true) {
	return page.evaluate(passage => {
		const bounds = (selector: string) => {
			const element = document.querySelector<HTMLElement>(
				`${passage ? '.review-passage-editor' : '.review-companion'} ${selector}`,
			)
			if (!element) throw new Error(`Missing passage ${selector}`)
			const r = element.getBoundingClientRect()
			let fullyInside = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
			for (let parent = element.parentElement; parent; parent = parent.parentElement) {
				const css = getComputedStyle(parent)
				const p = parent.getBoundingClientRect()
				if (css.overflowY !== 'visible') fullyInside &&= r.top >= p.top && r.bottom <= p.bottom
				if (css.overflowX !== 'visible') fullyInside &&= r.left >= p.left && r.right <= p.right
			}
			return {
				selector,
				hasText: !!element.textContent?.trim(),
				top: r.top,
				bottom: r.bottom,
				height: r.height,
				fullyInside,
				overflowY: getComputedStyle(element).overflowY,
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
			}
		}
		return {
			controls: [
				'.review-writing-surface textarea',
				'.review-intents',
				'.review-compose-actions',
				'.review-compose-actions > .btn:last-child',
			].map(bounds),
			receipt: bounds('.review-feedback-status'),
			chat: bounds(passage ? '.review-passage-bubble-messages' : '.review-chat'),
			writing: bounds('.review-writing-surface'),
			guidance: bounds('.review-compose-status'),
			bottom: bounds(passage ? '.review-passage-writing' : '.review-companion-bottom'),
		}
	}, passage)
}

for (const story of ['reading', 'light'])
	test(`${story}: compact passage writing and retired-source recovery retain full controls and admission gates`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width: 640, height: 520 })
		await open(page, story)
		await page.evaluate(() =>
			window.__helmDocumentReviewProof?.edit('Preserve the original session and exact source block. '.repeat(100)),
		)
		await pointerExcerpt(
			page,
			page.locator('.review-block-text p').last(),
			'Preserve the original session and exact source block.',
		)
		const input = page.getByRole('textbox', { name: 'Passage instruction' })
		await input.fill('An uncertain request.')
		const send = page.getByRole('button', { name: 'Send passage discussion', exact: true })
		await send.click()
		await expect(page.getByText('Dispatched', { exact: true })).toHaveCount(0)
		await expect(page.getByRole('region', { name: 'Delivery and recovery' })).toHaveCount(0)
		await proof(page, 'settle', true)
		await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible()
		await input.fill('Long retained local draft.\n'.repeat(100))
		await expect(send).toHaveText('Send')
		await expect(page.locator('.review-writing-surface blockquote')).toHaveCount(0)
		for (const state of ['passage-writing-unknown', 'passage-writing-retired-unknown']) {
			const retired = state.includes('retired')
			if (retired) {
				await proof(page, 'edit')
				await expect(passageEditor(page)).toHaveCount(0)
				await expect.poll(() => selectionPaint(page)).toEqual([])
				await pointerExcerpt(
					page,
					page
						.locator('.review-block-text p')
						.filter({ hasText: 'Preserve the original session and exact source block.' })
						.first(),
					'Preserve the original session and exact source block.',
				)
				await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
				await expect(passageEditor(page)).toHaveCount(0)
				await page.getByRole('button', { name: 'Conversation', exact: true }).click()
				await page
					.getByRole('textbox', { name: 'Whole-document message' })
					.fill('Independent whole draft, not passage text.')
				await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
			}
			const measured = await compactBounds(page, !retired)
			for (const control of measured.controls) expect(control.fullyInside, JSON.stringify(control)).toBe(true)
			expect(measured.controls[0]?.height).toBeGreaterThanOrEqual(64)
			expect(measured.writing.height).toBeGreaterThanOrEqual(128)
			expect(measured.guidance.height).toBeGreaterThanOrEqual(32)
			expect(measured.receipt.height).toBeGreaterThanOrEqual(32)
			if (retired || measured.chat.hasText) {
				expect(measured.chat.height).toBeGreaterThanOrEqual(96)
				expect(measured.chat.fullyInside).toBe(true)
			} else expect(measured.chat.height).toBe(0)
			expect(measured.receipt.fullyInside).toBe(true)
			expect(measured.guidance.overflowY).toBe('auto')
			expect(measured.guidance.fullyInside).toBe(true)
			await testInfo.attach(`${story}-${state}-computed-bounds`, {
				body: JSON.stringify(measured, null, 2),
				contentType: 'application/json',
			})
			const guidance = page.getByLabel('Writing status')
			await guidance.focus()
			await page.keyboard.press('End')
			await expect
				.poll(() =>
					guidance.evaluate(element => Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight))),
				)
				.toBeLessThanOrEqual(1)
			await expect(guidance).toContainText('Check the outcome in your conversation')
			const recovery = page.getByRole('region', { name: 'Delivery and recovery' })
			await recovery.focus()
			await page.keyboard.press('Home')
			await expect.poll(() => recovery.evaluate(element => element.scrollTop)).toBe(0)
			await page.screenshot({ path: evidencePath(`${story}-640x520-${state}.png`) })
			await page.keyboard.press('End')
			await expect
				.poll(() =>
					recovery.evaluate(element => Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight))),
				)
				.toBeLessThanOrEqual(1)
			await expect(recovery.getByRole('button', { name: 'Discard text', exact: true })).toBeInViewport()
			if (!retired) await expect(input).toHaveValue('Long retained local draft.\n'.repeat(100))
		}
		await page.getByRole('button', { name: 'I checked the outcome', exact: true }).click()
		await expect(passageEditor(page)).toHaveCount(0)
		await page.getByRole('button', { name: 'Document', exact: true }).click()
		await pointerExcerpt(
			page,
			page
				.locator('.review-block-text p')
				.filter({ hasText: 'Preserve the original session and exact source block.' })
				.first(),
			'Preserve the original session and exact source block.',
		)
		await expect(input).toHaveValue('Long retained local draft.\n'.repeat(100))
		await expect(page.getByRole('textbox', { name: 'Whole-document message', includeHidden: true })).toHaveValue(
			'Independent whole draft, not passage text.',
		)
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
	})

test('wide-start passage remembers Conversation and narrowing preserves focused editor without resize focus calls', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await keyboardHeading(page, 'Dispatch guarantees')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('Wide-start draft and passage.')
	await input.evaluate(element => {
		const original = element.focus.bind(element)
		Object.assign(window, { __reviewResizeFocusCalls: 0 })
		Object.defineProperty(element, 'focus', {
			configurable: true,
			value: (options?: FocusOptions) => {
				Object.assign(window, { __reviewResizeFocusCalls: Reflect.get(window, '__reviewResizeFocusCalls') + 1 })
				original(options)
			},
		})
	})
	await page.setViewportSize({ width: 640, height: 520 })
	await expect(input).toBeVisible()
	await expect(input).toBeFocused()
	await expect(input).toHaveValue('Wide-start draft and passage.')
	expect(await page.evaluate(() => Reflect.get(window, '__reviewResizeFocusCalls'))).toBe(0)
	await page.screenshot({ path: evidencePath('reading-wide-to-640x520-focused-passage.png') })
	await page.getByRole('button', { name: 'Document', exact: true }).click()
	await page.setViewportSize({ width: 1280, height: 900 })
	await page.setViewportSize({ width: 640, height: 520 })
	await expect(page.getByLabel('Document reading area', { exact: true })).toBeVisible()
	await expect(input).not.toBeVisible()
	await page.setViewportSize({ width: 1280, height: 900 })
	await keyboardHeading(page, 'Dispatch guarantees')
	await input.focus()
	const calls = await page.evaluate(() => Reflect.get(window, '__reviewResizeFocusCalls'))
	await page.setViewportSize({ width: 640, height: 520 })
	await expect(input).toBeFocused()
	await expect(input).toBeVisible()
	expect(await page.evaluate(() => Reflect.get(window, '__reviewResizeFocusCalls'))).toBe(calls)
	await expect(input).toHaveValue('Wide-start draft and passage.')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	await page.keyboard.press('Escape')
	await expect(page.getByLabel('Document reading area', { exact: true })).toBeFocused()
})

// Maintenance R1/R4: production renderer + explicit display services, not Electron certification.
test('maintenance: passage-only dirty projection survives dismissal and protects native close', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	await pointerSelect(page)
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Keep this unsaved passage.')
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.stats().dirty)).toBe(true)
	await page.getByRole('button', { name: 'Close passage conversation' }).click()
	let confirmations = 0
	page.on('dialog', async dialog => {
		expect(dialog.message()).toContain('Discard the unsent passage draft')
		confirmations++
		await dialog.dismiss()
	})
	await page.evaluate(() => window.__helmDocumentReviewProof?.requestClose())
	expect(confirmations).toBe(1)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().closes)).toBe(0)
	await pointerSelect(page)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('Keep this unsaved passage.')
	page.removeAllListeners('dialog')
	page.once('dialog', dialog => dialog.accept())
	await page.evaluate(() => window.__helmDocumentReviewProof?.requestClose())
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.stats().closes)).toBe(1)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().dirty)).toBe(false)
})

test('maintenance: delayed whole autosave cannot clear a newer passage dirty slot', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page)
	await page.evaluate(() => {
		const proof = window.__helmDocumentReviewProof
		if (!proof) throw new Error('Missing review fixture')
		const save = proof.api.save
		proof.api.save = async value => {
			Reflect.set(window, '__maintenanceSavePayload', value)
			await new Promise<void>(resolve => Reflect.set(window, '__maintenanceReleaseSave', resolve))
			return save(value)
		}
	})
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Whole draft only.')
	await expect.poll(() => page.evaluate(() => !!Reflect.get(window, '__maintenanceReleaseSave'))).toBe(true)
	await pointerSelect(page)
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Separate passage only.')
	await page.evaluate(() => Reflect.get(window, '__maintenanceReleaseSave')())
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.stats().saved)).toBe(1)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().dirty)).toBe(true)
	const payload = await page.evaluate(() => Reflect.get(window, '__maintenanceSavePayload'))
	expect(payload.instruction).toBe('Whole draft only.')
	expect(payload.annotations).toEqual([])
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('Separate passage only.')
})

for (const outcome of ['success', 'error', 'rejection'] as const)
	test(`maintenance: old API acknowledgement ${outcome} cannot refresh or clear replacement state`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1197, height: 807 })
		await open(page)
		await page.getByRole('textbox', { name: 'Whole-document message' }).fill('An uncertain request.')
		await page.getByRole('button', { name: 'Send message', exact: true }).click()
		await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(1)
		await page.evaluate(() => window.__helmDocumentReviewProof?.settle(true))
		await expect(page.getByRole('button', { name: 'I checked the outcome', exact: true })).toBeEnabled()
		await page.evaluate(() => {
			const proof = window.__helmDocumentReviewProof
			if (!proof) throw new Error('Missing acknowledgement fixture')
			proof.api.acknowledge = () =>
				new Promise((resolve, reject) => {
					Reflect.set(window, '__maintenanceReleaseAck', resolve)
					Reflect.set(window, '__maintenanceRejectAck', reject)
				})
		})
		await page.getByRole('button', { name: 'I checked the outcome', exact: true }).click()
		await expect.poll(() => page.evaluate(() => !!Reflect.get(window, '__maintenanceReleaseAck'))).toBe(true)
		await page.evaluate(() => {
			const proof = window.__helmDocumentReviewProof
			if (!proof) throw new Error('Missing API replacement fixture')
			// The replacement copies the legitimate load. Only the stale API gets this trap.
			proof.replaceApi()
			const load = proof.api.load
			Reflect.set(window, '__maintenanceOldLoads', 0)
			proof.api.load = async () => {
				Reflect.set(window, '__maintenanceOldLoads', Reflect.get(window, '__maintenanceOldLoads') + 1)
				return load()
			}
		})
		await expect(page.getByRole('button', { name: 'I checked the outcome', exact: true })).toBeEnabled()
		await page.evaluate(async result => {
			if (result === 'rejection') Reflect.get(window, '__maintenanceRejectAck')(new Error('Old acknowledgement error'))
			else
				Reflect.get(
					window,
					'__maintenanceReleaseAck',
				)(result === 'success' ? { data: true } : { error: 'Old acknowledgement error' })
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
		}, outcome)
		expect(await page.evaluate(() => Reflect.get(window, '__maintenanceOldLoads'))).toBe(0)
		await expect(page.getByRole('button', { name: 'I checked the outcome', exact: true })).toBeVisible()
		await expect(page.getByText('Old acknowledgement error', { exact: true })).toHaveCount(0)
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(1)
	})

async function maintenanceDetails(page: Page) {
	await page.getByRole('button', { name: 'Document options', exact: true }).click()
	await page.getByRole('menuitemcheckbox', { name: 'Document details', exact: true }).click()
}

test('maintenance: explicit empty preference cleanup preserves drafts and admits one effect', async ({ page }) => {
	await page.setViewportSize({ width: 1197, height: 807 })
	await open(page, 'empty-preferences-recovery')
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Retained whole-document text.')
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.stats().saved)).toBeGreaterThan(0)
	await pointerSelect(page)
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Retained passage text.')
	await page.getByRole('button', { name: 'Close passage conversation' }).click()
	await maintenanceDetails(page)
	await page.evaluate(() => {
		const proof = window.__helmDocumentReviewProof
		const clear = proof?.api.clearEmptyPreferences
		if (!proof || !clear) throw new Error('Missing cleanup fixture')
		proof.api.clearEmptyPreferences = async () => {
			const result = await clear()
			await new Promise<void>(resolve => Reflect.set(window, '__maintenanceReleaseClear', resolve))
			return result
		}
	})
	const clear = page.getByRole('button', { name: 'Clear empty saved preferences', exact: true })
	await clear.evaluate(button => {
		;(button as HTMLButtonElement).click()
		;(button as HTMLButtonElement).click()
	})
	await expect(clear).toBeDisabled()
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.stats().clearedPreferences)).toBe(1)
	await page.evaluate(() => Reflect.get(window, '__maintenanceReleaseClear')())
	await expect(page.getByRole('region', { name: 'Document details' })).toContainText(
		'Cleared 3 empty saved preference entries.',
	)
	await expect(clear).toBeEnabled()
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue(
		'Retained whole-document text.',
	)
	await page.getByRole('button', { name: 'Hide details', exact: true }).click()
	await pointerSelect(page)
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toHaveValue('Retained passage text.')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().dirty)).toBe(true)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().sends)).toBe(0)
})

for (const outcome of ['success', 'error'] as const)
	test(`maintenance: empty preference cleanup ${outcome} is fenced after API replacement`, async ({ page }) => {
		await open(page, 'empty-preferences-recovery')
		await maintenanceDetails(page)
		await page.evaluate(() => {
			const proof = window.__helmDocumentReviewProof
			if (!proof) throw new Error('Missing cleanup replacement fixture')
			proof.api.clearEmptyPreferences = () =>
				new Promise(resolve => {
					Reflect.set(window, '__maintenanceClearResult', resolve)
				})
		})
		const clear = page.getByRole('button', { name: 'Clear empty saved preferences', exact: true })
		await clear.click()
		await expect.poll(() => page.evaluate(() => !!Reflect.get(window, '__maintenanceClearResult'))).toBe(true)
		await page.evaluate(() => window.__helmDocumentReviewProof?.replaceApi())
		await expect(clear).toBeEnabled()
		await page.evaluate(async result => {
			Reflect.get(
				window,
				'__maintenanceClearResult',
			)(result === 'success' ? { data: { removed: 37 } } : { error: 'Old cleanup failure' })
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
		}, outcome)
		await expect(page.getByText(/Cleared 37|Old cleanup failure/)).toHaveCount(0)
		await expect(clear).toBeEnabled()
	})

test('maintenance: unsupported and unresolved feedback never admit empty preference cleanup', async ({ page }) => {
	await open(page)
	await maintenanceDetails(page)
	await expect(page.getByRole('button', { name: 'Clear empty saved preferences', exact: true })).toHaveCount(0)
	await open(page, 'empty-preferences-recovery')
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Unresolved feedback blocks cleanup.')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await maintenanceDetails(page)
	await expect(page.getByRole('button', { name: 'Clear empty saved preferences', exact: true })).toBeDisabled()
	await page.evaluate(() => window.__helmDocumentReviewProof?.settle(true))
	await expect(page.getByRole('button', { name: 'I checked the outcome', exact: true })).toBeEnabled()
	await expect(page.getByRole('button', { name: 'Clear empty saved preferences', exact: true })).toBeDisabled()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.stats().clearedPreferences)).toBe(0)
})

test('conversation sticks to the newest message unless the reader has scrolled away', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 })
	await open(page)
	const chat = page.locator('.review-chat')
	const input = page.getByRole('textbox', { name: 'Whole-document message' })
	const send = page.locator('.review-companion').getByRole('button', { name: 'Send message', exact: true })
	const tailDistance = () =>
		chat.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
	const resting = await chat.evaluate(element => {
		const messages = [...element.querySelectorAll('.review-message')]
		const first = messages[0]?.getBoundingClientRect()
		const last = messages.at(-1)?.getBoundingClientRect()
		const box = element.getBoundingClientRect()
		if (!first || !last) throw new Error('Missing opening conversation')
		return { above: first.top - box.top, below: box.bottom - last.bottom }
	})
	expect(resting.above).toBeGreaterThan(resting.below)
	expect(resting.below).toBeLessThanOrEqual(48)
	for (const marker of ['Tail one', 'Tail two', 'Tail three']) {
		await input.fill(`${marker}\n${'Keep the newest edit visible.\n'.repeat(6)}`)
		await send.click()
		await expect(chat).toContainText(marker)
		await proof(page, 'settle')
		await expect(chat).toContainText('This is a fixture reply to the chosen request.')
		await expect.poll(tailDistance).toBeLessThanOrEqual(1)
	}
	await expect(chat.getByText('Tail three', { exact: false }).last()).toBeInViewport()
	await chat.evaluate(element => {
		element.scrollTop = 0
		element.dispatchEvent(new Event('scroll'))
	})
	await expect.poll(tailDistance).toBeGreaterThan(24)
	const held = await chat.evaluate(element => element.scrollTop)
	await input.fill('Do not yank this earlier reading')
	await send.click()
	await expect(chat).toContainText('Do not yank this earlier reading')
	expect(await chat.evaluate(element => element.scrollTop)).toBe(held)
	await proof(page, 'settle')
	expect(await chat.evaluate(element => element.scrollTop)).toBe(held)
	await chat.evaluate(element => {
		element.scrollTop = element.scrollHeight
		element.dispatchEvent(new Event('scroll'))
	})
	await expect.poll(tailDistance).toBeLessThanOrEqual(1)
	await input.fill('Followed tail marker')
	await send.click()
	await expect(chat).toContainText('Followed tail marker')
	await expect.poll(tailDistance).toBeLessThanOrEqual(1)
	await expect(chat.getByText('Followed tail marker', { exact: true })).toBeInViewport()
})
