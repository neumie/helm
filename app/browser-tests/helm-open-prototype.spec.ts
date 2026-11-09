import { type Page, expect, test } from '@playwright/test'

// Story-only `helm open` prototype (docs/plans/helm-open/spec.md): every design variant renders its
// real fixture without a page error or a horizontal page scroll at both review widths, and the
// feedback-anchor stories open their bubble against the painted anchor. Nothing here ships.

const story = (id: string) => `/iframe.html?id=views-helm-open-${id}&viewMode=story`

const STORIES: { id: string; ready: string }[] = [
	{ id: 'a-window-chrome--a-1-title-row-plain', ready: '.open-pdf-page canvas' },
	{ id: 'a-window-chrome--a-1-title-row-bound', ready: '.open-companion' },
	{ id: 'a-window-chrome--a-2-status-line-plain', ready: '.open-pdf-page canvas' },
	{ id: 'a-window-chrome--a-2-status-line-bound', ready: '.open-pdf-page canvas' },
	{ id: 'a-window-chrome--a-3-breadcrumb-plain', ready: '.open-a3-crumbs' },
	{ id: 'a-window-chrome--a-3-breadcrumb-bound', ready: '.open-pdf-page canvas' },
	{ id: 'a-window-chrome--a-4-path-then-name-plain', ready: '.open-pdf-page canvas' },
	{ id: 'a-window-chrome--a-4-path-then-name-bound', ready: '.open-companion' },
	{ id: 'a-window-chrome--a-5-name-then-path-plain', ready: '.open-pdf-page canvas' },
	{ id: 'a-window-chrome--a-5-name-then-path-bound', ready: '.open-companion' },
	{ id: 'a-window-chrome--a-6-collapsing-plain', ready: '.open-pdf-page canvas' },
	{ id: 'a-window-chrome--a-6-collapsing-bound', ready: '.open-companion' },
	{ id: 'a-window-chrome--long-path-compare', ready: '.hy-compare' },
	{ id: 'b-multiple-files--b-1-tabs', ready: '.open-tab-active' },
	{ id: 'b-multiple-files--b-2-window-per-file', ready: '.open-palette-field' },
	{ id: 'b-multiple-files--b-3-sidebar', ready: '.open-b3-row-active' },
	{ id: 'c-format-views-pdf--default', ready: '.open-pdf-page canvas' },
	{ id: 'c-format-views-spreadsheet--workbook', ready: '.open-sheet-tabs' },
	{ id: 'c-format-views-spreadsheet--csv', ready: '.open-format-status' },
	{ id: 'c-format-views-image--default', ready: '.open-image-canvas img' },
	{ id: 'c-format-views-json--tree', ready: '[role="tree"]' },
	{ id: 'c-format-views-code--default', ready: '.cm-editor' },
	{ id: 'c-format-views-documents--docx', ready: '.open-docx-paper' },
	{ id: 'c-format-views-documents--markdown', ready: '.open-md' },
]

async function settle(page: Page, id: string, ready: string) {
	const errors: string[] = []
	page.on('pageerror', error => errors.push(error.message))
	await page.goto(story(id))
	await expect(page.locator(ready).first()).toBeVisible({ timeout: 15_000 })
	return errors
}

for (const width of [900, 1400]) {
	for (const { id, ready } of STORIES) {
		test(`${id} renders at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: width === 900 ? 700 : 900 })
			const errors = await settle(page, id, ready)
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
			expect(overflow).toBeLessThanOrEqual(1)
			expect(errors).toEqual([])
		})
	}
}

const ANCHORS: { id: string; place: RegExp }[] = [
	{ id: 'pdf-text-selection', place: /Page 1/ },
	{ id: 'pdf-region', place: /Page 1/ },
	{ id: 'spreadsheet-range', place: /Summary/ },
	{ id: 'image-region', place: /Region/ },
	{ id: 'json-node', place: /Value/ },
	{ id: 'code-lines', place: /Lines 18–23/ },
]

for (const { id, place } of ANCHORS) {
	test(`feedback anchor ${id} opens its bubble beside the anchor`, async ({ page }) => {
		await page.setViewportSize({ width: 1400, height: 900 })
		const errors = await settle(page, `d-feedback-anchors--${id}`, '.open-bubble')
		const bubble = page.getByRole('dialog', { name: /Feedback on/ })
		await expect(bubble).toBeVisible()
		await expect(bubble.locator('.open-bubble-place')).toHaveText(place)
		await expect(bubble.getByRole('textbox', { name: 'Feedback' })).toBeFocused()
		const box = await bubble.boundingBox()
		expect(box && box.x >= 0 && box.x + box.width <= 1400).toBe(true)
		await page.keyboard.press('Escape')
		await expect(bubble).toBeHidden()
		expect(errors).toEqual([])
	})
}

test('A4–A6 narrow title rows keep the name and fold the path', async ({ page }) => {
	await page.setViewportSize({ width: 900, height: 700 })
	await settle(page, 'a-window-chrome--long-path-compare', '.hy-compare')
	const row = (label: string) => page.getByRole('region', { name: label })
	for (const label of ['A4 Path, then name', 'A5 Name, then path', 'A6 Collapsing path'])
		await expect(row(label).getByRole('heading', { name: 'platform-report-2026-10.pdf' })).toBeVisible()
	await expect(row('A4 Path, then name').getByRole('button', { name: 'Reports', exact: true })).toBeHidden()
	await expect(row('A4 Path, then name').getByRole('button', { name: 'October', exact: true })).toBeVisible()
	await expect(row('A6 Collapsing path').getByRole('button', { name: 'October', exact: true })).toBeHidden()
	await expect(row('A6 Collapsing path').getByRole('button', { name: /^Path:/ })).toBeVisible()
	const a5 = row('A5 Name, then path').locator('.hy-a5-crumbs')
	await expect.poll(() => a5.evaluate(node => node.getBoundingClientRect().width)).toBeLessThan(1)
	await row('A5 Name, then path').getByRole('heading').hover()
	await expect.poll(() => a5.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(100)
})
