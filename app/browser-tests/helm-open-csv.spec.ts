// helm open S5: CSV/TSV files in the production DocumentReview window (Views/Document review/CSV). Bytes come from
// blob: URLs standing in for main's helm-viewer: tokens (Chromium answers their Range requests with 206 and the
// exact Content-Range); the CSV worker, its strict decoder and parser, the virtual grid, selection, copy and find
// are real.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Mirrors window.__helmCsvProof from CsvViewer.stories.tsx (Storybook's own Window declaration).
type CsvProof = { started: number; append(text: string): void }
type ProofWindow = { __helmCsvProof?: CsvProof }

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

async function open(page: Page, story: string, name: string) {
	await page.setViewportSize({ width: 1180, height: 800 })
	await page.goto(`/iframe.html?id=views-document-review-csv--${story}&viewMode=story`)
	await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 20000 })
}
const grid = (page: Page) => page.getByRole('application')
const status = (page: Page) => page.locator('.viewer-status')
const position = (page: Page) => page.locator('.viewer-status-position')
const ref = (page: Page) => page.getByLabel('Selected range')
const value = (page: Page) => page.getByRole('status', { name: 'Value' }).or(page.locator('.viewer-grid-value'))
/** The body cell showing `text` (first match). */
const cell = (page: Page, text: string) =>
	page
		.locator('.viewer-grid-cells .viewer-grid-cell')
		.filter({ hasText: new RegExp(`^${text}$`) })
		.first()
const band = (page: Page) => page.locator('.viewer-grid-band .viewer-grid-cell')
const done = (page: Page) => expect(status(page)).not.toContainText('Reading…', { timeout: 60000 })
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())
const menu = async (page: Page, item: string | RegExp) => {
	await page.getByRole('button', { name: 'Document options' }).click()
	await page
		.getByRole('menuitem', { name: item })
		.or(page.getByRole('menuitemcheckbox', { name: item }))
		.click()
}

test('an invoice export: header kept on top, values, selection, Count and Sum, copy as TSV, find', async ({ page }) => {
	await open(page, 'invoices', 'clientcare-invoices-2026-10.csv')
	await done(page)
	await expect(status(page)).toContainText('1,801 rows')
	await expect(status(page)).toContainText('8 columns')
	await expect(status(page)).toContainText('Comma-separated')
	await expect(status(page)).toContainText('UTF-8')
	await expect(band(page).first()).toHaveText('Invoice')
	await expect(grid(page)).toHaveAccessibleName('clientcare-invoices-2026-10.csv, 1,801 rows, 8 columns')

	// Amounts align right; names do not.
	const amount = page.locator('.viewer-grid-cells .viewer-grid-cell.is-number').first()
	await expect(amount).toHaveCSS('text-align', 'right')
	await expect(cell(page, '2026-0001')).not.toHaveClass(/is-number/)

	// A cell: the value bar and the status line name it with its header.
	await cell(page, '2026-0003').click()
	await expect(ref(page)).toHaveText('A4')
	await expect(position(page)).toHaveText('A4 · Invoice')
	await expect(value(page)).toHaveText('2026-0003')

	// Arrows move; ⇧ extends; amounts of a range sum.
	await page.keyboard.press('ArrowRight')
	await page.keyboard.press('ArrowRight')
	await page.keyboard.press('ArrowRight')
	await page.keyboard.press('ArrowRight')
	await expect(ref(page)).toHaveText('E4')
	await page.keyboard.press('Shift+ArrowDown')
	await page.keyboard.press('Shift+ArrowDown')
	await expect(ref(page)).toHaveText('E4:E6')
	await expect(status(page)).toContainText('Count 3')
	await expect(status(page)).toContainText(/Sum [\d,]+\.\d+/)

	// ⌘C copies the range as TSV.
	await page.keyboard.press('Shift+ArrowLeft')
	await page.keyboard.press('ControlOrMeta+c')
	await expect(status(page)).toContainText('Copied 6 cells as TSV')
	const copied = await clipboard(page)
	const lines = copied.split('\n')
	expect(lines).toHaveLength(3)
	for (const line of lines) expect(line).toMatch(/^2026-11-\d\d\t\d+\.\d\d$/)

	// Find: ⌘F, matches counted, Enter steps and selects.
	await page.keyboard.press('ControlOrMeta+f')
	await page.getByRole('searchbox', { name: 'Find in cells' }).fill('psyon')
	await expect(page.locator('.viewer-search-count')).toHaveText(/^1 of \d+$/)
	await expect(ref(page)).toHaveText(/^B\d+$/)
	const first = await ref(page).innerText()
	await page.keyboard.press('Enter')
	await expect(page.locator('.viewer-search-count')).toHaveText(/^2 of \d+$/)
	await expect(ref(page)).not.toHaveText(first)
	await expect(value(page)).toHaveText('Psyon s.r.o.')
	await page.keyboard.press('Escape')
	await expect(page.getByRole('searchbox', { name: 'Find in cells' })).toHaveCount(0)

	// ⌘↓ goes to the last row; ⌘A selects everything.
	await grid(page).focus()
	await page.keyboard.press('ControlOrMeta+ArrowDown')
	await expect(ref(page)).toHaveText(/^B1801$/)
	await expect(page.locator('.viewer-grid-number').filter({ hasText: /^1,801$/ })).toBeVisible()
	await page.keyboard.press('ControlOrMeta+a')
	await expect(ref(page)).toHaveText('A1:H1801')
	await expect(status(page)).toContainText('Count')
})

test('a million rows: first rows quickly, read within budget, and the last row reachable', async ({ page }) => {
	test.setTimeout(120000)
	await page.setViewportSize({ width: 1180, height: 800 })
	await page.goto('/iframe.html?id=views-document-review-csv--million-rows&viewMode=story')
	await expect(cell(page, '1')).toBeVisible({ timeout: 30000 })
	const firstRows = await page.evaluate(
		() => performance.now() - ((window as ProofWindow).__helmCsvProof?.started ?? 0),
	)
	await done(page)
	const all = await page.evaluate(() => performance.now() - ((window as ProofWindow).__helmCsvProof?.started ?? 0))
	test.info().annotations.push({
		type: 'timing',
		description: `first rows ${Math.round(firstRows)} ms, all ${Math.round(all)} ms`,
	})
	console.log(`million rows: first rows ${Math.round(firstRows)} ms, all ${Math.round(all)} ms`)
	// Budgets for 55 MB on a shared machine (Storybook dev build): first rows within 3 s, the whole file within 20 s.
	expect(firstRows).toBeLessThan(3000)
	expect(all).toBeLessThan(20000)
	await expect(status(page)).toContainText('1,000,000 rows')
	await expect(status(page)).toContainText('53.8 MiB')

	await cell(page, '1').click()
	await page.keyboard.press('ControlOrMeta+ArrowDown')
	await expect(ref(page)).toHaveText('A1000000')
	await expect(value(page)).toHaveText('999999')
	const last = page.locator('.viewer-grid-number').filter({ hasText: /^1,000,000$/ })
	await expect(last).toBeVisible()
	// The last row is fully inside the scroller, not under its edge.
	const scroll = await grid(page).boundingBox()
	const row = await last.boundingBox()
	expect(scroll && row && row.y + row.height <= scroll.y + scroll.height + 1).toBe(true)
	// Holding a column letter selects the column and never scrolls the rows by itself.
	const before = await grid(page).evaluate(element => element.scrollTop)
	const letter = await page.locator('.viewer-grid-letter').filter({ hasText: /^C$/ }).boundingBox()
	if (!letter) throw new Error('no letter C')
	await page.mouse.move(letter.x + letter.width / 2, letter.y + letter.height / 2)
	await page.mouse.down()
	await page.waitForTimeout(400)
	await page.mouse.up()
	await expect(ref(page)).toHaveText('C1:C1000000')
	expect(await grid(page).evaluate(element => element.scrollTop)).toBe(before)
	// Going to the header row shows the top of the data under it.
	await page.keyboard.press('ControlOrMeta+ArrowUp')
	await expect(ref(page)).toHaveText('C1')
	await expect(page.locator('.viewer-grid-number').filter({ hasText: /^2$/ })).toBeVisible()
	expect(await grid(page).evaluate(element => element.scrollTop)).toBe(0)
})

test('quoted line breaks, quotes and commas stay inside their values', async ({ page }) => {
	await open(page, 'quoted-line-breaks', 'support-tickets.csv')
	await done(page)
	await expect(status(page)).toContainText('6 rows')
	await expect(status(page)).toContainText('6 columns')
	const message = page.locator('.viewer-grid-cells .viewer-grid-cell').filter({ hasText: /^Hi, ↵ the/ })
	await expect(message).toHaveCount(1)
	await message.click()
	await expect(ref(page)).toHaveText('E2')
	await expect(value(page)).toHaveText(
		'Hi, ↵ the "Create company" form forgets the IČO after Save. ↵ Tried twice, same result. ↵  ↵ Thanks, Petra',
	)
	await page.keyboard.press('ControlOrMeta+c')
	await expect(status(page)).toContainText('Copied a cell as TSV')
	expect(await clipboard(page)).toBe(
		'"Hi,\nthe ""Create company"" form forgets the IČO after Save.\nTried twice, same result.\n\nThanks, Petra"',
	)
	// A CRLF break inside quotes is one value too.
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('ArrowDown')
	await expect(value(page)).toHaveText('Could the export use semicolons; our Excel is Czech. ↵ Regards, ↵ Magnus')
	await expect(cell(page, 'Lumen Studio, z.s.')).toBeVisible()
	await expect(
		cell(page, 'Line 3 says "21 %" but we agreed 12 %, see the attached contract \\(page 2\\).'),
	).toHaveCount(1)
})

test('a Czech Excel export: BOM, semicolons and decimal commas', async ({ page }) => {
	await open(page, 'czech-excel-export', 'faktury-2026-10.csv')
	await done(page)
	await expect(status(page)).toContainText('Semicolon-separated')
	await expect(status(page)).toContainText('UTF-8 with BOM')
	await expect(status(page)).toContainText('241 rows')
	// The byte order mark is not part of the first header name.
	await expect(band(page).first()).toHaveText('Číslo faktury')
	const first = band(page).first()
	expect(await first.evaluate(node => node.textContent?.charCodeAt(0))).toBe('Č'.charCodeAt(0))
	// Decimal-comma amounts are numbers: right-aligned and summed.
	const amount = page
		.locator('.viewer-grid-cells .viewer-grid-cell.is-number')
		.filter({ hasText: /^\d+,\d\d$/ })
		.first()
	await expect(amount).toBeVisible()
	await amount.click()
	await page.keyboard.press('Shift+ArrowDown')
	await expect(status(page)).toContainText('Count 2')
	await expect(status(page)).toContainText(/Sum [\d,]+\.\d+|Sum [\d,]+/)
})

test('Excel’s sep= line sets the delimiter and is not a row', async ({ page }) => {
	await open(page, 'excel-sep-line', 'faktury-2026-10-excel.csv')
	await done(page)
	await expect(status(page)).toContainText('Semicolon-separated')
	await expect(status(page)).toContainText('41 rows')
	await expect(band(page).first()).toHaveText('Číslo faktury')
	await expect(page.locator('.viewer-grid-cell').filter({ hasText: /^sep=/ })).toHaveCount(0)
})

test('a TSV is split on tabs', async ({ page }) => {
	await open(page, 'sentry-tsv', 'sentry-events-2026-11-09.tsv')
	await done(page)
	await expect(status(page)).toContainText('Tab-separated')
	await expect(status(page)).toContainText('601 rows')
	await expect(status(page)).toContainText('6 columns')
	await expect(band(page).nth(3)).toHaveText('message')
})

test('500 columns: virtualised sideways with letters and row numbers kept', async ({ page }) => {
	await open(page, 'wide-500-columns', 'sensor-readings-wide.csv')
	await done(page)
	await expect(status(page)).toContainText('500 columns')
	// Only the columns on screen are mounted.
	expect(await page.locator('.viewer-grid-letter').count()).toBeLessThan(40)
	await cell(page, '2026-11-09 00:10').click()
	await page.keyboard.press('ControlOrMeta+ArrowRight')
	await expect(ref(page)).toHaveText('SF3')
	await expect(position(page)).toHaveText('SF3 · sensor_499')
	const letter = page.locator('.viewer-grid-letter').filter({ hasText: /^SF$/ })
	await expect(letter).toBeVisible()
	// Row numbers stay at the left edge of the grid while it is scrolled sideways.
	const scroll = await grid(page).boundingBox()
	const number = await page.locator('.viewer-grid-number').filter({ hasText: /^3$/ }).boundingBox()
	expect(scroll && number && Math.abs(number.x - scroll.x) <= 1).toBe(true)
	const letterBox = await letter.boundingBox()
	expect(scroll && letterBox && letterBox.x + letterBox.width <= scroll.x + scroll.width + 1).toBe(true)
	await page.keyboard.press('Home')
	await expect(ref(page)).toHaveText('A3')
})

test('the header choice can be turned off', async ({ page }) => {
	await open(page, 'invoices', 'clientcare-invoices-2026-10.csv')
	await done(page)
	await expect(band(page).first()).toHaveText('Invoice')
	await menu(page, 'First row is a header')
	await expect(page.locator('.viewer-grid-band')).toHaveCount(0)
	await expect(cell(page, 'Invoice')).toBeVisible()
	await menu(page, 'First row is a header')
	await expect(band(page).first()).toHaveText('Invoice')
})

test('a cut-off quoted value is shown and named in the status line', async ({ page }) => {
	await open(page, 'unclosed-quote', 'notes-cut-off.csv')
	await done(page)
	await expect(status(page)).toContainText('Row 3 has an unclosed quote')
	await expect(cell(page, 'Ask Petra about the IČO ↵ and the address')).toBeVisible()
})

test('refusals: Windows-1250 text, more than a million rows; and an empty file', async ({ page }) => {
	await open(page, 'windows-1250', 'kontakty-1250.csv')
	await expect(page.getByRole('alert')).toHaveText(
		'Helm couldn’t show kontakty-1250.csv. This file is not valid UTF-8 text; Helm shows UTF-8 and UTF-16 (with a byte order mark) text.',
	)
	await expect(grid(page)).toHaveCount(0)
	// Retry read reads the same version again (and refuses it again).
	await page.getByRole('button', { name: 'Retry read' }).click()
	await expect(page.getByRole('alert')).toContainText('This file is not valid UTF-8 text')
	await expect(page.getByRole('button', { name: 'Retry read' })).toBeVisible()

	test.setTimeout(90000)
	await open(page, 'too-many-rows', 'numbers.csv')
	await expect(page.getByRole('alert')).toHaveText(
		'Helm couldn’t show numbers.csv. This file has more than 1,000,000 rows; Helm shows CSV files up to 1,000,000 rows.',
		{ timeout: 60000 },
	)
	await expect(grid(page)).toHaveCount(0)
	// Nothing read before the refusal is described as if it were the file.
	await expect(status(page)).not.toContainText('rows')
	await expect(status(page)).not.toContainText('Reading')

	await open(page, 'empty', 'empty.csv')
	await expect(page.locator('.viewer-note')).toHaveText('empty.csv is empty.')
})

test('a live update replaces the table and keeps the window', async ({ page }) => {
	await open(page, 'invoices', 'clientcare-invoices-2026-10.csv')
	await done(page)
	await expect(status(page)).toContainText('1,801 rows')
	await page.evaluate(() =>
		(window as ProofWindow).__helmCsvProof?.append('2026-1801,Psyon s.r.o.,2026-10-31,2026-11-30,999.00,21,Draft,\n'),
	)
	await expect(status(page)).toContainText('1,802 rows')
	await expect(status(page)).toContainText(/Updated \d\d:\d\d/)
	await grid(page).focus()
	await page.keyboard.press('ControlOrMeta+ArrowDown')
	await expect(value(page)).toHaveText('2026-1801')
})

test('the light window', async ({ page }) => {
	await open(page, 'invoices-light-window', 'clientcare-invoices-2026-10.csv')
	await done(page)
	await expect(page.locator('main.document-review')).toHaveAttribute('data-review-theme', 'light')
	await expect(band(page).first()).toHaveText('Invoice')
})
