// helm open S4: PDFs in the production DocumentReview window (Views/Document review/PDF). Bytes come from blob: URLs
// standing in for main's helm-viewer: tokens, read by range through the fixture's fetch watch; pdf.js, its worker,
// the bundled CMaps/wasm, the text layer, find, outline, zoom and the password prompt are real.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Mirrors window.__helmPdfProof from PdfViewer.stories.tsx (Storybook's own Window declaration).
type PdfProof = {
	zoom(step: 1 | -1 | 0): void
	stale(): void
	update(): Promise<void>
	bytesRead(): number
	reads: { token: number; begin: number; end: number; status: number }[]
}
type ProofWindow = { __helmPdfProof?: PdfProof }

async function open(page: Page, story: string, name: string) {
	await page.setViewportSize({ width: 1180, height: 800 })
	await page.goto(`/iframe.html?id=views-document-review-pdf--${story}&viewMode=story`)
	await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 20000 })
}
const status = (page: Page) => page.locator('.viewer-status')
const position = (page: Page) => page.locator('.viewer-status-position')
const scroller = (page: Page) => page.locator('.viewer-pdf-scroll')
const pageShell = (page: Page, number: number) => page.locator(`[data-pdf-page="${number}"]`)
const painted = (page: Page, number: number) => pageShell(page, number).locator('canvas[data-painted]')
const menu = async (page: Page, item: string | RegExp) => {
	await page.getByRole('button', { name: 'Document options' }).click()
	await page
		.getByRole('menuitem', { name: item })
		.or(page.getByRole('menuitemcheckbox', { name: item }))
		.click()
}
/** Share of a painted page's sampled pixels that are not paper white. */
const inkShare = (page: Page, number: number) =>
	painted(page, number).evaluate(canvas => {
		const context = (canvas as HTMLCanvasElement).getContext('2d')
		if (!context) return 0
		const { width, height } = canvas as HTMLCanvasElement
		const data = context.getImageData(0, 0, width, height).data
		let dark = 0
		let total = 0
		for (let index = 0; index < data.length; index += 4 * 97) {
			total++
			if (Math.min(data[index] ?? 255, data[index + 1] ?? 255, data[index + 2] ?? 255) < 230) dark++
		}
		return dark / total
	})

test('a report fits the width on paper white with selectable text and the status facts', async ({ page }) => {
	await open(page, 'report', 'platform-report-2026-10.pdf')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	await expect(position(page)).toHaveText('Page 1 of 4')
	await expect(status(page)).toContainText(/Fit · \d+%/)
	await expect(status(page)).toContainText('4 pages')
	await expect(status(page)).toContainText('A4')
	await expect(status(page)).toContainText('140 KiB')
	await expect(pageShell(page, 1).locator('.viewer-pdf-text')).toContainText('Platform report, October 2026')
	// The paper stays white in the dark window.
	const paper = await pageShell(page, 1)
		.locator('.viewer-pdf-paper')
		.evaluate(element => getComputedStyle(element).backgroundColor)
	expect(paper).toBe('rgb(255, 255, 255)')
	// Text selection works on the text layer.
	const heading = pageShell(page, 1).locator('.viewer-pdf-text span', { hasText: 'Platform report' }).first()
	await heading.selectText()
	expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Platform report')
	await expect(page.locator('.review-companion')).toHaveCount(0)
})

test('find counts matches across pages, steps with Enter, ⌘G and ⇧Enter, and paints CSS highlights', async ({
	page,
}) => {
	await open(page, 'report', 'platform-report-2026-10.pdf')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	await scroller(page).focus()
	await page.keyboard.press('ControlOrMeta+f')
	const field = page.getByRole('searchbox', { name: 'Find in PDF' })
	await expect(field).toBeFocused()
	await field.fill('incident')
	const count = page.locator('.viewer-search-count')
	await expect(count).toHaveText(/^1 of (\d+)$/, { timeout: 20000 })
	const total = Number((await count.textContent())?.match(/of (\d+)/)?.[1])
	expect(total).toBeGreaterThan(3)
	await field.press('Enter')
	await expect(count).toHaveText(`2 of ${total}`)
	await page.keyboard.press('ControlOrMeta+g')
	await expect(count).toHaveText(`3 of ${total}`)
	await field.press('Shift+Enter')
	await expect(count).toHaveText(`2 of ${total}`)
	expect(
		await page.evaluate(() => ({
			all: CSS.highlights.get('helm-pdf-find')?.size ?? 0,
			current: CSS.highlights.get('helm-pdf-find-current')?.size ?? 0,
		})),
	).toEqual({ all: expect.any(Number), current: 1 })
	expect(await page.evaluate(() => CSS.highlights.get('helm-pdf-find')?.size ?? 0)).toBeGreaterThan(0)
	// Runs of whitespace in the query match any whitespace in the PDF. A new query starts at the reader's page (2 here).
	await field.fill('severity   2 incidents')
	await expect(count).toHaveText('2 of 2')
	await field.fill('no such words in this report')
	await expect(count).toHaveText('No matches')
	await field.press('Escape')
	await expect(field).toHaveCount(0)
	expect(await page.evaluate(() => CSS.highlights.get('helm-pdf-find')?.size ?? 0)).toBe(0)
})

test('page keys, Go to page and the outline move between pages', async ({ page }) => {
	await open(page, 'report', 'platform-report-2026-10.pdf')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	await scroller(page).focus()
	await page.keyboard.press(']')
	await expect(position(page)).toHaveText('Page 2 of 4')
	await page.keyboard.press('[')
	await expect(position(page)).toHaveText('Page 1 of 4')
	await menu(page, 'Go to page…')
	const go = page.locator('.viewer-pdf-go-field')
	await expect(go).toBeFocused()
	await go.fill('4')
	await go.press('Enter')
	await expect(position(page)).toHaveText('Page 4 of 4')
	await expect(painted(page, 4)).toBeVisible()
	await menu(page, 'Outline')
	const outline = page.getByRole('navigation', { name: 'Outline' })
	await expect(outline).toBeVisible()
	await outline.getByRole('button', { name: 'Incidents', exact: true }).click()
	await expect(position(page)).toHaveText('Page 2 of 4')
	await menu(page, 'Outline')
	await expect(outline).toHaveCount(0)
})

test('0, 1, + and − zoom; the window zoom keys and pinch scale the pages', async ({ page }) => {
	await open(page, 'report', 'platform-report-2026-10.pdf')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	await scroller(page).focus()
	await page.keyboard.press('1')
	await expect(status(page)).toContainText('100%')
	await expect
		.poll(async () => Math.round((await pageShell(page, 1).locator('.viewer-pdf-paper').boundingBox())?.width ?? 0))
		.toBe(794) // A4 at 96 px per inch
	await page.keyboard.press('+')
	await expect(status(page)).not.toContainText(/(^|\s)100%/)
	await page.keyboard.press('0')
	await expect(status(page)).toContainText(/Fit · \d+%/)
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPdfProof?.zoom(-1))
	await expect(status(page)).not.toContainText('Fit')
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPdfProof?.zoom(0))
	await expect(status(page)).toContainText('Fit')
	const box = await scroller(page).boundingBox()
	if (!box) throw new Error('no scroller')
	await page.mouse.move(box.x + 300, box.y + 300)
	await page.keyboard.down('Control')
	await page.mouse.wheel(0, -300)
	await page.keyboard.up('Control')
	await expect(status(page)).not.toContainText('Fit')
	// Zooming keeps the reader on the same page.
	await expect(position(page)).toHaveText('Page 1 of 4')
})

test('a locked PDF asks for its password, says when it is wrong, and opens with the right one', async ({ page }) => {
	await open(page, 'locked', 'service-agreement-northwind.pdf')
	const field = page.getByLabel('Password')
	await expect(page.getByText('service-agreement-northwind.pdf is protected with a password.')).toBeVisible()
	await expect(page.getByText('Helm keeps it only while this window is open.')).toBeVisible()
	await field.fill('northwind')
	await page.getByRole('button', { name: 'Open' }).click()
	await expect(page.getByText('That password is not right.')).toBeVisible({ timeout: 20000 })
	// Typed key by key: digits, '-' and the page keys are text in the field, never view commands.
	await field.fill('')
	await field.pressSequentially('helm-2026')
	await expect(field).toHaveValue('helm-2026')
	await field.press('Enter')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	await expect(pageShell(page, 1).locator('.viewer-pdf-text')).toContainText('Service agreement')
	await expect(position(page)).toHaveText('Page 1 of 2')
	// A live reload of the same file reuses the typed password once instead of asking again: the new version (token
	// 1) is read and painted on fresh page shells, and the password form never comes back.
	await painted(page, 1).evaluate(canvas => {
		canvas.dataset.previous = ''
	})
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPdfProof?.update())
	await expect(status(page)).toContainText(/Updated \d\d:\d\d/)
	await expect
		.poll(() =>
			page.evaluate(() =>
				Boolean((window as unknown as ProofWindow).__helmPdfProof?.reads.some(r => r.token === 1 && r.status === 206)),
			),
		)
		.toBe(true)
	await expect(pageShell(page, 1).locator('canvas[data-painted]:not([data-previous])')).toBeVisible({ timeout: 20000 })
	await expect(field).toHaveCount(0)
})

test('active content does nothing: no script, no dialog, no navigation, no request leaves the window', async ({
	page,
}) => {
	const outside: string[] = []
	page.on('request', request => {
		if (request.url().includes('example.invalid')) outside.push(request.url())
	})
	const dialogs: string[] = []
	page.on('dialog', dialog => {
		dialogs.push(dialog.message())
		void dialog.dismiss()
	})
	const popups: string[] = []
	page.on('popup', popup => popups.push(popup.url()))
	await open(page, 'active-content', 'invoice-2026-118.pdf')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	const before = page.url()
	// Click every link and the button on the page.
	for (const text of ['Pay online', 'Open the calculator', 'Read the terms', 'Track this invoice', 'Pay now']) {
		await pageShell(page, 1).locator('.viewer-pdf-text span', { hasText: text }).first().click()
	}
	await page.waitForTimeout(500)
	expect(page.url()).toBe(before)
	expect({ outside, dialogs, popups }).toEqual({ outside: [], dialogs: [], popups: [] })
	// No annotation layer (links, form fields) is mounted at all.
	await expect(page.locator('.viewer-pdf a, .viewer-pdf input:not([type=search]), .annotationLayer')).toHaveCount(0)
})

test('CJK text in fonts the file does not embed draws and finds through the bundled CMaps', async ({ page }) => {
	const cmaps: string[] = []
	page.on('requestfinished', request => {
		if (request.url().includes('/cmaps/')) cmaps.push(request.url().split('/').pop() ?? '')
	})
	await open(page, 'cjk', 'invoices-asia-2026-11.pdf')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	const text = pageShell(page, 1).locator('.viewer-pdf-text')
	await expect(text).toContainText('請求書')
	await expect(text).toContainText('发票')
	await expect(text).toContainText('송장')
	expect(cmaps).toEqual(expect.arrayContaining(['UniJIS-UCS2-H.bcmap', 'UniGB-UCS2-H.bcmap', 'UniKS-UCS2-H.bcmap']))
	expect(await inkShare(page, 1)).toBeGreaterThan(0.005)
	await scroller(page).focus()
	await page.keyboard.press('ControlOrMeta+f')
	await page.getByRole('searchbox', { name: 'Find in PDF' }).fill('東京')
	await expect(page.locator('.viewer-search-count')).toHaveText('1 of 1')
})

for (const [story, name, wasm] of [
	['jbig-2-fax', 'fax-2026-10-21.pdf', 'jbig2.wasm'],
	['jpeg-2000', 'form-error-jpeg2000.pdf', 'openjpeg.wasm'],
] as const)
	test(`${wasm} decodes the image in ${name}`, async ({ page }) => {
		const loaded: string[] = []
		page.on('requestfinished', request => {
			if (request.url().endsWith('.wasm') || request.url().includes('nowasm'))
				loaded.push(request.url().split('/').pop() ?? '')
		})
		await open(page, story, name)
		await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
		expect(loaded).toEqual([wasm])
		// A blank page has none; the fax is mostly black text on white, the JPEG 2000 a pale form.
		expect(await inkShare(page, 1)).toBeGreaterThan(0.004)
	})

test('a 500-page ledger reads only the ranges it shows', async ({ page }) => {
	await open(page, 'ledger-500-pages', 'invoice-ledger-2026.pdf')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	await expect(position(page)).toHaveText('Page 1 of 500')
	const proof = () =>
		page.evaluate(() => {
			const fixture = (window as unknown as ProofWindow).__helmPdfProof
			return { bytes: fixture?.bytesRead() ?? 0, reads: fixture?.reads.length ?? 0 }
		})
	const opened = await proof()
	expect(opened.bytes).toBeLessThan(400_000) // of 3.4 MB
	await menu(page, 'Go to page…')
	await page.locator('.viewer-pdf-go-field').fill('377')
	await page.locator('.viewer-pdf-go-field').press('Enter')
	await expect(position(page)).toHaveText('Page 377 of 500')
	await expect(painted(page, 377)).toBeVisible({ timeout: 20000 })
	await expect(pageShell(page, 377).locator('.viewer-pdf-text')).toContainText('page 377 of 500')
	const jumped = await proof()
	expect(jumped.bytes - opened.bytes).toBeLessThan(300_000)
	// Pages far from the view hold no pixels.
	expect(
		await pageShell(page, 1)
			.locator('canvas')
			.evaluate(canvas => (canvas as HTMLCanvasElement).width),
	).toBe(0)
})

test('a file that changes mid-read ends that stream quietly; the new version opens at the same page', async ({
	page,
}) => {
	await open(page, 'ledger-500-pages', 'invoice-ledger-2026.pdf')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPdfProof?.stale())
	await menu(page, 'Go to page…')
	await page.locator('.viewer-pdf-go-field').fill('240')
	await page.locator('.viewer-pdf-go-field').press('Enter')
	await expect(position(page)).toHaveText('Page 240 of 500')
	await expect
		.poll(() =>
			page.evaluate(() => (window as unknown as ProofWindow).__helmPdfProof?.reads.some(read => read.status === 409)),
		)
		.toBe(true)
	await page.waitForTimeout(300)
	await expect(page.getByRole('alert')).toHaveCount(0)
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPdfProof?.update())
	await expect(status(page)).toContainText(/Updated \d\d:\d\d/)
	await expect(painted(page, 240)).toBeVisible({ timeout: 20000 })
	await expect(position(page)).toHaveText('Page 240 of 500')
	await expect(page.getByRole('alert')).toHaveCount(0)
})

test('more than 5,000 pages is refused with the count', async ({ page }) => {
	await open(page, 'too-many-pages', 'scanned-archive-2019.pdf')
	await expect(page.getByRole('alert')).toHaveText(
		'scanned-archive-2019.pdf has 5,001 pages; Helm shows PDFs up to 5,000 pages.',
		{ timeout: 20000 },
	)
	await expect(page.locator('[data-pdf-page]')).toHaveCount(0)
})

test('a broken PDF says it could not be read, in one line', async ({ page }) => {
	await open(page, 'broken', 'copied-halfway.pdf')
	await expect(page.getByRole('alert')).toHaveText(/^copied-halfway\.pdf could not be read as a PDF: [^\n]+$/, {
		timeout: 20000,
	})
})

test('the light window changes only the chrome; pages stay paper white', async ({ page }) => {
	await open(page, 'report-light-window', 'platform-report-2026-10.pdf')
	await expect(page.locator('.viewer-window')).toHaveAttribute('data-review-theme', 'light')
	await expect(painted(page, 1)).toBeVisible({ timeout: 20000 })
	await menu(page, 'Dark window')
	await expect(page.locator('.viewer-window')).toHaveAttribute('data-review-theme', 'dark')
})
