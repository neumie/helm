import { type Page, expect, test } from '@playwright/test'

// Done threads in Signals (design §3.25): collapsed under `Snoozed · done today N` by default, `D`
// or a click on the count lists them, the choice survives a reload (renderer storage), and each
// listed row knows how it got done (`data-done-reason`), shown where the story's look puts it.

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
	await expect(view.toggle).toHaveText(/^done today 2/)
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

test('each done row knows how it got done', async ({ page }) => {
	const view = await open(page, 'views-signals-done-reason--reason-current')
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
	// Today's look: the time only, no reason text on the row.
	await expect(view.signals.locator('.signals-done-reason')).toHaveCount(0)
	await page.screenshot({ path: test.info().outputPath('signals-done-current.png') })
})

for (const [look, check] of [
	['age', '.signals-tr[data-signal-id="298"] .signals-td-age'],
	['ref', '.signals-tr[data-signal-id="298"] .signals-done-reason'],
	['line', '.signals-tr[data-signal-id="298"] .signals-td-detail'],
] as const) {
	test(`reason look ${look}: shown in its cell, the whole as tooltip, no layout spill`, async ({ page }) => {
		const view = await open(page, `views-signals-done-reason--reason-${look}`)
		const cell = view.signals.locator(check)
		await expect(cell).toContainText(look === 'age' ? 'gone' : 'gone from GitHub')
		await expect(cell).toHaveAttribute('title', /no longer open or requested · closed \d+:\d\d$/)
		// Every row stays inside the column (nothing wraps or overflows sideways).
		const spill = await view.signals.evaluate(root => {
			const scroller = root.querySelector('.signals-scroll') as HTMLElement
			return scroller.scrollWidth - scroller.clientWidth
		})
		expect(spill).toBeLessThanOrEqual(0)
		await page.screenshot({ path: test.info().outputPath(`signals-done-${look}.png`) })
	})
}

for (const look of ['count', 'word', 'split'] as const) {
	test(`header look ${look}: collapsed count as a toggle`, async ({ page }) => {
		const view = await open(page, `views-signals-done-reason--header-${look}`)
		await expect(view.done).toHaveCount(0)
		await expect(view.toggle).toHaveText(
			look === 'count'
				? /^done today 8 · D$/
				: look === 'word'
					? /^done today 8 · show · D$/
					: /^Done today 8 · show · D$/,
		)
		await page.keyboard.press('Shift+D')
		await expect(view.done).toHaveCount(8)
		if (look !== 'count') await expect(view.toggle).toContainText('hide')
	})
}

test('filtered indicator looks: the count rests where the look puts it, f always opens the list', async ({ page }) => {
	const places = {
		footer: '.signals-foot-filtered .signals-filtered',
		closed: '[data-done-header] .signals-filtered',
		header: '.signals-title-filtered .signals-filtered',
	} as const
	for (const look of ['footer', 'closed', 'key', 'header'] as const) {
		const view = await open(page, `views-signals-filtered-indicator--${look}`)
		const buttons = view.signals.locator('.signals-filtered')
		if (look === 'key') {
			await expect(buttons).toHaveCount(0)
			const hint = view.signals.locator('.signals-foot-hints .signals-hint', { hasText: '5 filtered' })
			await expect(hint).toBeVisible()
			// No resting text: the hint goes with the other key hints once Signals lets go of the keys.
			await page.locator('.term-holder.active .xterm-screen').click()
			await expect(hint).toBeHidden()
			await view.signals.focus()
		} else {
			await expect(buttons).toHaveCount(1)
			await expect(view.signals.locator(places[look])).toContainText('5 filtered')
		}
		await page.screenshot({ path: test.info().outputPath(`signals-filtered-${look}.png`) })
		await page.keyboard.press('f')
		await expect(view.signals.locator('.signals-tr[data-section="filtered"]')).toHaveCount(5)
		await page.keyboard.press('Escape')
		await expect(view.signals.locator('.signals-tr[data-section="filtered"]')).toHaveCount(0)
	}
})
