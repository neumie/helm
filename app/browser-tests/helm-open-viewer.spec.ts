// helm open S2: plain code, text and data files in the production DocumentReview window (Views/Document review/Plain
// files). Bytes come from blob: URLs standing in for main's helm-viewer: tokens; the views, worker and keys are real.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function open(page: Page, story: string, name: string) {
	await page.setViewportSize({ width: 1180, height: 800 })
	await page.goto(`/iframe.html?id=views-document-review-plain-files--${story}&viewMode=story`)
	await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 20000 })
}
const status = (page: Page) => page.locator('.viewer-status')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('code opens read-only with highlighting, line numbers and the file facts in the status line', async ({ page }) => {
	await open(page, 'code', 'refusal.ts')
	const editor = page.locator('.viewer-code .cm-content')
	await expect(editor).toHaveAttribute('aria-readonly', 'true')
	await expect(page.locator('.viewer-code .cm-lineNumbers .cm-gutterElement').filter({ hasText: /^1$/ })).toBeVisible()
	// Highlighting arrives with the lazily loaded TypeScript grammar: the keyword `export` gets a syntax color.
	await expect
		.poll(() =>
			page
				.locator('.viewer-code .cm-line span', { hasText: /^export$/ })
				.first()
				.evaluate(span => getComputedStyle(span).color),
		)
		.not.toBe(await editor.evaluate(element => getComputedStyle(element).color))
	await expect(status(page)).toContainText('TypeScript')
	await expect(status(page)).toContainText('UTF-8')
	await expect(status(page)).toContainText('LF')
	await expect(status(page)).toContainText(/\d+ lines/)
	await editor.click()
	await page.keyboard.type('xyz')
	await expect(editor).not.toContainText('xyz')
	await expect(status(page)).toContainText(/Ln \d+, Col \d+/)
	await expect(page.locator('.review-companion')).toHaveCount(0)
})

test('⌘F finds in code from anywhere, ⌘G steps, Esc closes', async ({ page }) => {
	await open(page, 'code', 'refusal.ts')
	// The code view is a lazy chunk: wait for the editor before pressing keys at the window.
	await expect(page.locator('.viewer-code .cm-content')).toBeVisible()
	await page.locator('.review-header h1').click()
	await page.keyboard.press(`${mod}+f`)
	const field = page.getByRole('textbox', { name: 'Find in file' })
	await expect(field).toBeFocused()
	await field.fill('refuse')
	await page.keyboard.press('Enter')
	await expect(page.locator('.viewer-code .cm-searchMatch').first()).toBeVisible()
	const first = await status(page).locator('.viewer-status-position').textContent()
	await page.keyboard.press('Enter')
	await expect(status(page).locator('.viewer-status-position')).not.toHaveText(first ?? '')
	await page.keyboard.press('Escape')
	await expect(field).toHaveCount(0)
})

test('the light surface recolors code, and the menu toggles it', async ({ page }) => {
	await open(page, 'code-light', 'refusal.ts')
	await expect(page.locator('.viewer-window')).toHaveAttribute('data-review-theme', 'light')
	const background = await page
		.locator('.viewer-code .cm-editor')
		.evaluate(element => getComputedStyle(element).backgroundColor)
	expect(background).toBe('rgb(235, 234, 230)')
	await page.getByRole('button', { name: 'Document options', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Dark reading surface' }).click()
	await expect(page.locator('.viewer-window')).toHaveAttribute('data-review-theme', 'dark')
})

test('JSON opens as a keyboard tree with pointers, expansion and search that reveals the path', async ({ page }) => {
	await open(page, 'json-tree', 'sentry-issue.json')
	const tree = page.getByRole('tree', { name: 'Data tree' })
	await expect(tree.getByRole('treeitem').first()).toContainText('keys')
	await expect(tree.getByRole('treeitem', { name: /^shortId/ })).toContainText('"PSYON-API-3F"')
	await tree.focus()
	await expect(status(page).locator('.viewer-status-position')).toHaveText('Root')
	await page.keyboard.press('ArrowDown')
	await expect(status(page).locator('.viewer-status-position')).toHaveText('JSON Pointer /id')
	// Collapsed containers expand with →, and ← returns to the parent.
	const project = tree.getByRole('treeitem', { name: /^project/ })
	await expect(project).toHaveAttribute('aria-expanded', 'false')
	await project.click()
	await expect(project).toHaveAttribute('aria-expanded', 'true')
	await expect(tree.getByRole('treeitem', { name: /^slug/ })).toContainText('"psyon-api"')
	await page.keyboard.press('ArrowLeft')
	await expect(project).toHaveAttribute('aria-expanded', 'false')

	await page.keyboard.press(`${mod}+f`)
	const field = page.getByRole('searchbox', { name: 'Find keys and values' })
	await expect(field).toBeFocused()
	await field.fill('saveFirm')
	await expect(page.locator('.viewer-search-count')).toHaveText(/^1 of \d+$/)
	const current = tree.locator('[data-current-match]')
	await expect(current).toBeVisible()
	await expect(current).toContainText('saveFirm')
	await expect(status(page).locator('.viewer-status-position')).toContainText('JSON Pointer /')
	await page.keyboard.press('Escape')
	await expect(field).toHaveCount(0)
	await expect(tree).toBeFocused()
})

test('Raw source shows the JSON in the code view; a file that does not parse opens as source with the reason', async ({
	page,
}) => {
	await open(page, 'json-tree', 'sentry-issue.json')
	await page.getByRole('button', { name: 'Document options', exact: true }).click()
	await page.getByRole('menuitemradio', { name: 'Raw source' }).click()
	await expect(page.locator('.viewer-code .cm-content')).toContainText('"shortId": "PSYON-API-3F"')
	await expect(status(page)).toContainText('JSON')

	await open(page, 'parse-error', 'broken.json')
	await expect(page.getByRole('status').filter({ hasText: 'couldn’t parse this file' })).toBeVisible()
	await expect(page.locator('.viewer-code .cm-content')).toContainText('"missing quote')
	await page.getByRole('button', { name: 'Document options', exact: true }).click()
	await expect(page.getByRole('menuitemradio', { name: 'Tree' })).toBeDisabled()
})

test('YAML, TOML and JSON Lines trees show resolved aliases, exact big integers and invalid lines', async ({
	page,
}) => {
	await open(page, 'yaml', 'deploy.yml')
	const tree = page.getByRole('tree', { name: 'Data tree' })
	await tree.getByRole('treeitem', { name: /^jobs/ }).click()
	await tree.getByRole('treeitem', { name: /^test/ }).click()
	await expect(tree.getByRole('treeitem', { name: /^runs-on/ })).toContainText('"ubuntu-latest"')

	await open(page, 'toml', 'Cargo.toml')
	await page
		.getByRole('tree', { name: 'Data tree' })
		.getByRole('treeitem', { name: /^package/ })
		.click()
	await page.getByRole('treeitem', { name: /^metadata/ }).click()
	await page.getByRole('treeitem', { name: /^limits/ }).click()
	await expect(page.getByRole('treeitem', { name: /^max_sessions/ })).toContainText('18446744073709551615')

	await open(page, 'json-lines', 'deploy-events.ndjson')
	const invalid = page.locator('.viewer-tree-row[data-kind="invalid"]')
	await expect(invalid).toContainText('Line 4')
	await expect(invalid.locator('.viewer-tree-note')).not.toBeEmpty()
})

test('a large JSON is virtualised and caps children with an N more row', async ({ page }) => {
	await open(page, 'large-json', 'companies-export.json')
	const tree = page.getByRole('tree', { name: 'Data tree' })
	await tree.getByRole('treeitem', { name: /^companies/ }).click()
	// Rows come back from the worker asynchronously.
	await expect(tree.getByRole('treeitem', { name: /^9 6 keys/ })).toBeVisible()
	expect(await tree.getByRole('treeitem').count()).toBeLessThan(200)
	await tree.focus()
	await page.keyboard.press('End')
	await expect(tree.locator('.viewer-tree-more')).toContainText('2,500 more not shown')
})

test('⌘C copies the focused node as JSON', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write'])
	await open(page, 'json-tree', 'sentry-issue.json')
	const tree = page.getByRole('tree', { name: 'Data tree' })
	await tree.getByRole('treeitem', { name: /^project/ }).click()
	await page.keyboard.press(`${mod}+c`)
	await expect(status(page)).toContainText('Copied JSON Pointer /project as JSON')
	const text = await page.evaluate(() => navigator.clipboard.readText())
	expect(JSON.parse(text)).toEqual({ slug: 'psyon-api', platform: 'node' })
})

test('a live reload replaces the text and keeps the reading position', async ({ page }) => {
	await open(page, 'log', 'psyon-api.log')
	const scroller = page.locator('.viewer-code .cm-scroller')
	await scroller.evaluate(element => {
		element.scrollTop = 1200
	})
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(1200)
	await page.evaluate(() => {
		const proof = (window as unknown as { __helmViewerProof?: { append(text: string): void } }).__helmViewerProof
		if (!proof) throw new Error('Viewer fixture is not mounted')
		proof.append('2026-11-10 08:30:00.000 INFO  [deploy] finished\n')
	})
	await expect(page.locator('.viewer-status-note')).toHaveText(/^Updated \d\d:\d\d$/)
	await expect(status(page)).toContainText('241 lines')
	expect(await scroller.evaluate(element => element.scrollTop)).toBe(1200)
})

test('a live reload keeps the code cursor and the current data match', async ({ page }) => {
	await open(page, 'log', 'psyon-api.log')
	const editor = page.locator('.viewer-code .cm-content')
	await editor.locator('.cm-line').nth(5).click()
	const position = status(page).locator('.viewer-status-position')
	await expect(position).toHaveText(/^Ln 6, Col \d+$/)
	const before = await position.textContent()
	await page.evaluate(() => {
		const proof = (window as unknown as { __helmViewerProof?: { append(text: string): void } }).__helmViewerProof
		proof?.append('2026-11-10 08:30:00.000 INFO  [deploy] finished\n')
	})
	await expect(status(page)).toContainText('241 lines')
	await expect(position).toHaveText(before ?? '')

	await open(page, 'large-json', 'companies-export.json')
	const tree = page.getByRole('tree', { name: 'Data tree' })
	await expect(tree.getByRole('treeitem').first()).toBeVisible()
	await page.keyboard.press(`${mod}+f`)
	const field = page.getByRole('searchbox', { name: 'Find keys and values' })
	await field.fill('s.r.o.')
	await expect(page.locator('.viewer-search-count')).toHaveText(/^1 of /)
	await page.keyboard.press('Enter')
	await page.keyboard.press('Enter')
	await expect(page.locator('.viewer-search-count')).toHaveText(/^3 of /)
	await page.evaluate(() => {
		const proof = (window as unknown as { __helmViewerProof?: { update(text: string): void } }).__helmViewerProof
		const names = [0, 1, 2, 3].map(index => ({ name: `Firma ${index} s.r.o.` }))
		proof?.update(JSON.stringify({ companies: names }))
	})
	// The query reruns on the new parse; the third match is still current and nothing jumps back to the first.
	await expect(tree.locator('[data-current-match]')).toContainText('Firma 2 s.r.o.')
	await expect(page.locator('.viewer-search-count')).toHaveText('3 of 4')
})

test('Next scrolls to a far match whose parents are already open', async ({ page }) => {
	await open(page, 'large-json', 'companies-export.json')
	const tree = page.getByRole('tree', { name: 'Data tree' })
	await expect(tree.getByRole('treeitem').first()).toBeVisible()
	await page.keyboard.press(`${mod}+f`)
	await page.getByRole('searchbox', { name: 'Find keys and values' }).fill('s.r.o.')
	await expect(page.locator('.viewer-search-count')).toHaveText(/^1 of /)
	const current = tree.locator('[data-current-match]')
	await expect(current).toContainText('Firma 0 s.r.o.')
	// Previous wraps to the last match (far down), Next wraps back to the first, whose parents are already open.
	await page.keyboard.press('Shift+Enter')
	await expect(current).toBeInViewport()
	await page.keyboard.press('Enter')
	await expect(current).toContainText('Firma 0 s.r.o.')
	await expect(current).toBeInViewport()
})
