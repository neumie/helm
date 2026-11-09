import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const prefix = 'views-document-review-content-width'
const variants = [
	{ key: 'today', story: `${prefix}-today-680px-cap--window`, fixed: false },
	{ key: 'a', story: `${prefix}-a-prose-measure-wide-blocks-out--window`, fixed: true },
	{ key: 'b', story: `${prefix}-b-fluid-content--window`, fixed: true },
	{ key: 'c', story: `${prefix}-c-width-toggle--wide-window`, fixed: true },
	{ key: 'd', story: `${prefix}-d-measure-blocks-fit-content--window`, fixed: true },
] as const
const widths = [1000, 1400, 1900] as const

async function open(page: Page, id: string, width: number) {
	await page.setViewportSize({ width, height: 800 })
	await page.goto(`/iframe.html?id=${id}&viewMode=story`)
	await expect(page.getByRole('heading', { name: 'kontakty-a-notifikace.md', exact: true })).toBeVisible()
	await expect(page.locator('.review-prose table').first()).toBeVisible()
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
}

/** Widths of the measured flow pieces, plus whether any e-mail broke across lines. */
async function measure(page: Page) {
	return page.evaluate(() => {
		const width = (element: Element | null | undefined) => element?.getBoundingClientRect().width ?? 0
		const blocks = [...document.querySelectorAll('.review-prose > .review-block')]
		const contacts = document.querySelectorAll('.review-prose table')[0]
		const emails = [...(contacts?.querySelectorAll('tbody td:nth-child(2) code') ?? [])]
		const deploys = document.querySelectorAll('.review-prose table')[1]
		const dates = [...(deploys?.querySelectorAll('tbody td:nth-child(5)') ?? [])]
		const paragraph = blocks.find(block => block.querySelector(':scope > .review-block-text > p:not(:has(span))'))
		const inline = document.querySelector('.review-prose p code, .review-prose li code')
		const reading = document.querySelector('.review-reading')
		return {
			paragraph: width(paragraph),
			contactsTable: width(contacts),
			wideBox: width(document.querySelectorAll('.review-prose .review-table')[1]),
			column: width(document.querySelector('.review-prose')),
			code: width(document.querySelector('.review-prose pre')),
			emailsSplit: emails.filter(code => code.getClientRects().length > 1).map(code => code.textContent),
			// A whole date ("2026-11-04 14:32") may wrap at its space, never inside "2026-11-04".
			datesSplit: dates
				.filter(cell => {
					const text = cell.firstChild
					if (!(text instanceof Text)) return false
					const range = document.createRange()
					range.setStart(text, 0)
					range.setEnd(text, 10)
					return range.getClientRects().length > 1
				})
				.map(cell => cell.textContent),
			inlineCode: inline ? Number.parseFloat(getComputedStyle(inline).fontSize) : 0,
			inlineParent: inline?.parentElement ? Number.parseFloat(getComputedStyle(inline.parentElement).fontSize) : 0,
			pageScrolls: reading ? reading.scrollWidth > reading.clientWidth : true,
			companion: width(document.querySelector('.review-companion')),
		}
	})
}

for (const variant of variants)
	for (const width of widths)
		test(`content width ${variant.key} at ${width}px keeps the companion and reports its layout`, async ({
			page,
		}, testInfo) => {
			await open(page, `${variant.story}-${width}`, width)
			await page.screenshot({ path: testInfo.outputPath(`${variant.key}-${width}-top.png`) })
			await page
				.locator('.review-prose .review-block')
				.filter({ has: page.locator('table') })
				.first()
				.evaluate(element => element.scrollIntoView({ block: 'start' }))
			await page.screenshot({ path: testInfo.outputPath(`${variant.key}-${width}-tables.png`) })
			await page
				.locator('.review-prose .review-block')
				.filter({ has: page.locator('pre') })
				.first()
				.evaluate(element => element.scrollIntoView({ block: 'center' }))
			await page.screenshot({ path: testInfo.outputPath(`${variant.key}-${width}-code.png`) })
			const layout = await measure(page)
			testInfo.annotations.push({ type: 'layout', description: JSON.stringify(layout) })
			expect(layout.companion).toBeGreaterThan(300)
			expect(layout.pageScrolls).toBe(false)
			if (!variant.fixed) return
			expect(layout.emailsSplit).toEqual([])
			expect(layout.datesSplit).toEqual([])
			expect(layout.inlineCode).toBeCloseTo(layout.inlineParent * 0.92, 1)
		})

test('A keeps prose at the measure while tables and code take the column', async ({ page }) => {
	await open(page, `${prefix}-a-prose-measure-wide-blocks-out--window-1900`, 1900)
	const layout = await measure(page)
	expect(layout.paragraph).toBeLessThanOrEqual(680)
	expect(layout.contactsTable).toBeCloseTo(Math.min(layout.column, 1280), 0)
	expect(layout.code).toBeCloseTo(Math.min(layout.column, 1280), 0)
})

test('D sizes wide blocks to their content between the measure and the column', async ({ page }) => {
	await open(page, `${prefix}-d-measure-blocks-fit-content--window-1900`, 1900)
	const layout = await measure(page)
	expect(layout.paragraph).toBeLessThanOrEqual(680)
	expect(layout.contactsTable).toBeGreaterThanOrEqual(680)
	// Unlike A, a table narrower than the column stays at its own content width.
	expect(layout.contactsTable).toBeLessThan(Math.min(layout.column, 1280) - 100)
})

test('C switches width from the menu and the shortcut and remembers it app-wide', async ({ page }, testInfo) => {
	await open(page, `${prefix}-c-width-toggle--wide-window-1900`, 1900)
	await page.evaluate(() => localStorage.removeItem('helm.reading.width'))
	const prose = page.locator('.review-prose')
	await expect(prose).toHaveAttribute('data-reading-width', 'wide')
	await page.getByRole('button', { name: 'Document options' }).click()
	await expect(page.getByRole('menuitemradio', { name: /Wide/ })).toHaveAttribute('aria-checked', 'true')
	await page
		.getByRole('menu')
		.evaluate(menu => Promise.all(menu.getAnimations({ subtree: true }).map(animation => animation.finished)))
	await page.screenshot({ path: testInfo.outputPath('c-1900-menu.png') })
	await page.getByRole('menuitemradio', { name: /Full/ }).click()
	await expect(prose).toHaveAttribute('data-reading-width', 'full')
	await page.locator('.review-reading').focus()
	const primary = (await page.evaluate(() => /Mac/.test(navigator.userAgent))) ? 'Meta' : 'Control'
	await page.keyboard.press(`${primary}+Alt+Digit1`)
	await expect(prose).toHaveAttribute('data-reading-width', 'narrow')
	expect(await page.evaluate(() => localStorage.getItem('helm.reading.width'))).toBe('narrow')
	await page.keyboard.press(`${primary}+Alt+Digit2`)
	await expect(prose).toHaveAttribute('data-reading-width', 'wide')
})

for (const variant of variants.filter(variant => variant.fixed))
	test(`${variant.key}: Contents rail and selection bubble still fit beside wider content`, async ({
		page,
	}, testInfo) => {
		await open(page, `${variant.story}-1400`, 1400)
		await page.getByRole('button', { name: 'Contents' }).click()
		const rail = page.locator('#review-contents')
		await expect(rail).toBeVisible()
		const [railBox, readingBox] = await Promise.all([rail.boundingBox(), page.locator('.review-reading').boundingBox()])
		if (!railBox || !readingBox) throw new Error('Missing Contents or reading box')
		expect(railBox.x + railBox.width).toBeLessThanOrEqual(readingBox.x + 1)
		expect(await page.evaluate(() => document.querySelector('.review-reading')?.scrollWidth)).toBeLessThanOrEqual(
			readingBox.width + 1,
		)
		await page.screenshot({ path: testInfo.outputPath(`${variant.key}-1400-contents.png`) })
		await rail.getByRole('button', { name: 'Close contents' }).click()

		const quote = 'Rozhodnutí potřebujeme hlavně u upomínek'
		const paragraph = page.locator('.review-block-text blockquote p').filter({ hasText: quote }).first()
		await paragraph.scrollIntoViewIfNeeded()
		const points = await paragraph.evaluate((element, quote) => {
			const text = element.firstChild as Text
			const range = document.createRange()
			range.setStart(text, 0)
			range.setEnd(text, quote.length)
			const rects = [...range.getClientRects()]
			const first = rects[0]
			const last = rects.at(-1)
			if (!first || !last) throw new Error('Missing selection rects')
			return { first: first.toJSON(), last: last.toJSON() }
		}, quote)
		await page.mouse.move(points.first.x + 1, points.first.y + points.first.height / 2)
		await page.mouse.down()
		await page.mouse.move(points.last.x + points.last.width - 1, points.last.y + points.last.height / 2, { steps: 12 })
		await page.mouse.up()
		const bubble = page.locator('.review-passage-editor')
		await expect(bubble).toBeVisible()
		const [bubbleBox, reading] = await Promise.all([
			bubble.boundingBox(),
			page.locator('.review-reading').boundingBox(),
		])
		if (!bubbleBox || !reading) throw new Error('Missing bubble or reading box')
		expect(bubbleBox.x).toBeGreaterThanOrEqual(reading.x - 1)
		expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(reading.x + reading.width + 1)
		// The bubble never covers the selected lines: it sits below them, or above when there is no room.
		const below = bubbleBox.y >= points.last.y + points.last.height - 1
		const above = bubbleBox.y + bubbleBox.height <= points.first.y + 1
		expect(below || above).toBe(true)
		await page.screenshot({ path: testInfo.outputPath(`${variant.key}-1400-bubble.png`) })
	})

for (const choice of ['narrow', 'full'] as const)
	test(`C ${choice} keeps whole e-mails at 1900px`, async ({ page }, testInfo) => {
		await open(page, `${prefix}-c-width-toggle--${choice}-window-1900`, 1900)
		await expect(page.locator('.review-prose')).toHaveAttribute('data-reading-width', choice)
		await page.screenshot({ path: testInfo.outputPath(`c-${choice}-1900-top.png`) })
		await page
			.locator('.review-prose .review-block')
			.filter({ has: page.locator('table') })
			.first()
			.evaluate(element => element.scrollIntoView({ block: 'start' }))
		await page.screenshot({ path: testInfo.outputPath(`c-${choice}-1900-tables.png`) })
		const layout = await measure(page)
		expect(layout.emailsSplit).toEqual([])
		expect(layout.pageScrolls).toBe(false)
	})
