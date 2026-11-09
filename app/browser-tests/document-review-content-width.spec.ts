import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const story = 'views-document-review-content-width--window'
const widths = [1000, 1400, 1900] as const
const MEASURE = 680
const BLOCK_MAX = 1280

async function open(page: Page, width: number) {
	await page.setViewportSize({ width, height: 800 })
	await page.goto(`/iframe.html?id=${story}-${width}&viewMode=story`)
	await expect(page.getByRole('heading', { name: 'kontakty-a-notifikace.md', exact: true })).toBeVisible()
	await expect(page.locator('.review-prose table').first()).toBeVisible()
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
}

/** Widths of the measured flow pieces, plus every table token that broke across lines. */
async function measure(page: Page) {
	return page.evaluate(() => {
		const width = (element: Element | null | undefined) => element?.getBoundingClientRect().width ?? 0
		const blocks = [...document.querySelectorAll('.review-prose > .review-block')]
		const tables = document.querySelectorAll('.review-prose table')
		const deploys = tables[1]
		const dates = [...(deploys?.querySelectorAll('tbody td:nth-child(5)') ?? [])]
		const textBlocks = blocks.filter(block =>
			block.querySelector(':scope > .review-block-text > :is(p, ul, ol, blockquote, h2)'),
		)
		const inline = document.querySelector('.review-prose p code, .review-prose li code')
		const reading = document.querySelector('.review-reading')
		return {
			widestText: Math.max(...textBlocks.map(width)),
			contactsTable: width(tables[0]),
			deploysBox: width(document.querySelectorAll('.review-prose .review-table')[1]),
			column: width(document.querySelector('.review-prose')),
			code: width(document.querySelector('.review-prose pre')),
			// E-mails, URLs and paths in cells: written as code or as plain-text autolinks.
			tokens: document.querySelectorAll('.review-prose td :is(code, [data-reading-token])').length,
			tokensSplit: [...document.querySelectorAll('.review-prose td :is(code, [data-reading-token])')]
				.filter(token => token.getClientRects().length > 1)
				.map(token => token.textContent),
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

for (const width of widths)
	test(`reading width at ${width}px: prose at the measure, tables and code fit their content`, async ({
		page,
	}, testInfo) => {
		await open(page, width)
		await page.screenshot({ path: testInfo.outputPath(`${width}-top.png`) })
		await page
			.locator('.review-prose .review-block')
			.filter({ has: page.locator('table') })
			.first()
			.evaluate(element => element.scrollIntoView({ block: 'start' }))
		await page.screenshot({ path: testInfo.outputPath(`${width}-tables.png`) })
		await page
			.locator('.review-prose .review-block')
			.filter({ has: page.locator('pre') })
			.first()
			.evaluate(element => element.scrollIntoView({ block: 'center' }))
		await page.screenshot({ path: testInfo.outputPath(`${width}-code.png`) })
		const layout = await measure(page)
		testInfo.annotations.push({ type: 'layout', description: JSON.stringify(layout) })
		const room = Math.min(layout.column, BLOCK_MAX)
		expect(layout.companion).toBeGreaterThan(300)
		expect(layout.pageScrolls).toBe(false)
		expect(layout.widestText).toBeLessThanOrEqual(MEASURE)
		for (const block of [layout.contactsTable, layout.deploysBox, layout.code]) {
			expect(block).toBeGreaterThanOrEqual(Math.min(MEASURE, layout.column) - 1)
			expect(block).toBeLessThanOrEqual(room + 1)
		}
		expect(layout.tokens).toBe(9)
		expect(layout.tokensSplit).toEqual([])
		expect(layout.datesSplit).toEqual([])
		expect(layout.inlineCode).toBeCloseTo(layout.inlineParent * 0.92, 1)
	})

test('a table narrower than the column keeps its own content width', async ({ page }) => {
	await open(page, 1900)
	const layout = await measure(page)
	expect(layout.contactsTable).toBeGreaterThan(MEASURE)
	expect(layout.contactsTable).toBeLessThan(Math.min(layout.column, BLOCK_MAX) - 100)
	// The code block grows past the measure to its longest line, still inside the 1280px cap.
	expect(layout.code).toBeGreaterThan(MEASURE + 200)
	expect(layout.code).toBeLessThanOrEqual(Math.min(layout.column, BLOCK_MAX))
})

test('plain-text e-mails and URLs are marked as whole tokens, links stay safe', async ({ page }) => {
	await open(page, 1400)
	const contacts = page.locator('.review-prose table').first()
	// A mailto autolink renders as inert text, marked so the cell keeps it whole.
	await expect(contacts.locator('span[data-reading-token]')).toHaveText([
		'petr.vacek@neumie.dev',
		'jakub.neumann+psyon-alerts@neumie.dev',
	])
	await expect(contacts.locator('a')).toHaveCount(0)
	const deploys = page.locator('.review-prose table').nth(1)
	await expect(deploys.locator('a[data-reading-token]')).toHaveText([
		'https://staging-admin.psyon-consulting.cz/fakturace/prehled',
		'https://api.psyon-consulting.cz/v2/notifications/webhooks',
	])
	await expect(deploys.locator('a[data-reading-token]').first()).toHaveAttribute('target', '_blank')
})

test('--font-mono is defined on :root and sets inline code, code blocks, cells and Source', async ({ page }) => {
	await open(page, 1400)
	const token = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-mono'))
	expect(token).toContain('SF Mono')
	expect(token).toContain('monospace')
	const family = (selector: string) =>
		page
			.locator(selector)
			.first()
			.evaluate(element => getComputedStyle(element).fontFamily)
	const mono = token.trim().replace(/'/g, '"')
	expect((await family('.review-prose p code')).replace(/'/g, '"')).toBe(mono)
	expect((await family('.review-prose pre code')).replace(/'/g, '"')).toBe(mono)
	expect((await family('.review-prose td code')).replace(/'/g, '"')).toBe(mono)
	await page.getByRole('button', { name: 'Document options', exact: true }).click()
	await page.getByRole('menuitemradio', { name: 'Source', exact: true }).click()
	await expect(page.locator('.review-full-source')).toContainText('# Kontakty a notifikace pro Psyon')
	expect((await family('.review-full-source')).replace(/'/g, '"')).toBe(mono)
})

test('Contents rail and selection bubble still fit beside wider content', async ({ page }, testInfo) => {
	await open(page, 1400)
	await page.getByRole('button', { name: 'Contents' }).click()
	const rail = page.locator('#review-contents')
	await expect(rail).toBeVisible()
	const [railBox, readingBox] = await Promise.all([rail.boundingBox(), page.locator('.review-reading').boundingBox()])
	if (!railBox || !readingBox) throw new Error('Missing Contents or reading box')
	expect(railBox.x + railBox.width).toBeLessThanOrEqual(readingBox.x + 1)
	expect(await page.evaluate(() => document.querySelector('.review-reading')?.scrollWidth)).toBeLessThanOrEqual(
		readingBox.width + 1,
	)
	await page.screenshot({ path: testInfo.outputPath('1400-contents.png') })
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
	const [bubbleBox, reading] = await Promise.all([bubble.boundingBox(), page.locator('.review-reading').boundingBox()])
	if (!bubbleBox || !reading) throw new Error('Missing bubble or reading box')
	expect(bubbleBox.x).toBeGreaterThanOrEqual(reading.x - 1)
	expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(reading.x + reading.width + 1)
	// The bubble never covers the selected lines: it sits below them, or above when there is no room.
	const below = bubbleBox.y >= points.last.y + points.last.height - 1
	const above = bubbleBox.y + bubbleBox.height <= points.first.y + 1
	expect(below || above).toBe(true)
	await page.screenshot({ path: testInfo.outputPath('1400-bubble.png') })
})

test('the interactive canvas keeps prose at the measure', async ({ page }) => {
	await page.setViewportSize({ width: 1900, height: 800 })
	await page.goto('/iframe.html?id=views-document-review--interactive-canvas&viewMode=story')
	const canvas = page.locator('.review-canvas')
	await expect(canvas).toHaveAttribute('data-reading-width', '')
	await expect(canvas.locator('h1').first()).toBeVisible()
	const widths = await canvas.evaluate(element =>
		[...element.children].map(child => child.getBoundingClientRect().width),
	)
	expect(widths.length).toBeGreaterThan(0)
	expect(Math.max(...widths)).toBeLessThanOrEqual(MEASURE)
})
