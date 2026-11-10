import { type Page, expect, test } from '@playwright/test'

// Done threads in Signals (design §3.25): collapsed under their own `Done today N · show` line by
// default (the filtered mail count after it), `D` or a click on the count lists them, the choice
// survives a reload (renderer storage), and each listed row says how it got done after its ref.

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`

async function open(page: Page, id: string) {
	await page.setViewportSize({ width: 1400, height: 820 })
	await page.goto(story(id))
	const signals = page.locator('section.signals')
	await expect(signals).toBeVisible()
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(signals).toBeFocused()
	return {
		signals,
		done: signals.locator('.signals-tr[data-section="done"]'),
		toggle: signals.locator('.signals-done-toggle'),
		selected: signals.locator('.signals-tr[data-selected="true"]'),
	}
}

test('done rows start collapsed; D and the count list and hide them, and the choice is kept', async ({ page }) => {
	const view = await open(page, 'views-signals-column--column')
	await expect(view.done).toHaveCount(0)
	await expect(view.toggle).toHaveText(/^Done today 2 · show/)
	await expect(view.toggle).toHaveAttribute('aria-expanded', 'false')
	// The `D` hint shows only while Signals holds the keys.
	await expect(view.signals.locator('.signals-done-key')).toBeVisible()

	// j/k never walk into collapsed rows.
	for (let step = 0; step < 12; step += 1) await page.keyboard.press('j')
	await expect(view.selected).not.toHaveAttribute('data-section', 'done')

	await page.keyboard.press('Shift+D')
	await expect(view.done).toHaveCount(2)
	await expect(view.toggle).toHaveAttribute('aria-expanded', 'true')
	await page.keyboard.press('j')
	await page.keyboard.press('j')
	await expect(view.selected).toHaveAttribute('data-section', 'done')

	// Hiding the selected done row keeps the selection nearby (the last listed row), and the keys.
	await page.keyboard.press('Shift+D')
	await expect(view.done).toHaveCount(0)
	await expect(view.selected).toHaveAttribute('data-section', 'snoozed')
	await expect(view.signals).toBeFocused()

	// A click on the count lists them; the keys stay on the surface.
	await view.toggle.click()
	await expect(view.done).toHaveCount(2)
	await expect(view.signals).toBeFocused()

	// Kept per renderer: listed again after a reload.
	await page.reload()
	await expect(page.locator('section.signals')).toBeVisible()
	await expect(page.locator('.signals-tr[data-section="done"]')).toHaveCount(2)
	await page.locator('.signals-done-toggle').click()
	await expect(page.locator('.signals-tr[data-section="done"]')).toHaveCount(0)
	await page.reload()
	await expect(page.locator('section.signals')).toBeVisible()
	await expect(page.locator('.signals-done-toggle')).toHaveAttribute('aria-expanded', 'false')
	await expect(page.locator('.signals-tr[data-section="done"]')).toHaveCount(0)
})

test('each done row says how it got done after its ref, the whole as tooltip, no layout spill', async ({ page }) => {
	const view = await open(page, 'views-signals-done--listed')
	const reasons = await view.done.evaluateAll(rows =>
		rows.map(row => [(row as HTMLElement).dataset.signalId, (row as HTMLElement).dataset.doneReason]),
	)
	expect(Object.fromEntries(reasons)).toEqual({
		'46': 'read',
		'47': 'read',
		'48': 'agent',
		'49': 'unknown',
		'293': 'agent',
		'298': 'gone',
		'505': 'answered',
		'965': 'dismissed',
	})
	const gone = view.signals.locator('.signals-tr[data-signal-id="298"]')
	await expect(gone.locator('.signals-td-ref')).toHaveText('okena#298 · gone from GitHub')
	await expect(gone.locator('.signals-done-reason')).toHaveAttribute(
		'title',
		/^gone from GitHub · no longer open or requested · closed \d+:\d\d$/,
	)
	// The close time stays in the age cell.
	await expect(gone.locator('.signals-td-age')).toHaveText(/^\d+:\d\d$/)
	await expect(view.signals.locator('.signals-done-reason')).toHaveCount(8)
	// Every row stays inside the column (nothing wraps or overflows sideways).
	const spill = await view.signals.evaluate(root => {
		const scroller = root.querySelector('.signals-scroll') as HTMLElement
		return scroller.scrollWidth - scroller.clientWidth
	})
	expect(spill).toBeLessThanOrEqual(0)
	await expect(view.toggle).toHaveText(/^Done today 8 · hide/)
	await page.screenshot({ path: test.info().outputPath('signals-done-listed.png') })
})

test('collapsed: Done today has its own line after the snoozed rows, the filtered count after it', async ({ page }) => {
	const view = await open(page, 'views-signals-done--collapsed')
	await expect(view.done).toHaveCount(0)
	const header = view.signals.locator('[data-done-header]')
	await expect(header).toHaveText(/^Done today 8 · show · D · 5 filtered · f$/)
	// Snoozed keeps its own subhead, before the done line.
	const subheads = await view.signals.locator('.signals-subhead').allTextContents()
	expect(subheads.slice(-2)).toEqual(['Snoozed 1', expect.stringMatching(/^Done today 8/)])
	// Nothing filtered-related is left in the footer or the header.
	await expect(view.signals.locator('.signals-filtered')).toHaveCount(1)
	await expect(view.signals.locator('.signals-foot .signals-filtered, .signals-title .signals-filtered')).toHaveCount(0)
	await page.screenshot({ path: test.info().outputPath('signals-done-collapsed.png') })

	await page.keyboard.press('f')
	await expect(view.signals.locator('.signals-tr[data-section="filtered"]')).toHaveCount(5)
	await page.keyboard.press('Escape')
	await expect(view.signals.locator('.signals-tr[data-section="filtered"]')).toHaveCount(0)
	await page.keyboard.press('Shift+D')
	await expect(view.done).toHaveCount(8)
	await expect(view.toggle).toContainText('Done today 8 · hide')
})
