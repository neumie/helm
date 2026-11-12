import { type Page, expect, test } from '@playwright/test'
import type { SignalsFixture } from '../src/renderer/signals/signals-fixtures'

declare global {
	interface Window {
		__signalsFixture?: SignalsFixture
	}
}

// Done threads in Signals (design §3.25): the list keeps one `Done today N` line (the filtered mail
// count after it); `D` or a click on the count opens Done today in place of the list, built like
// Filtered mail (`f`): j/k move, t reopens, o opens, Esc back. Each row says how it got done.

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`

async function open(page: Page, id: string, width = 1400) {
	await page.setViewportSize({ width, height: 820 })
	await page.goto(story(id))
	const signals = page.locator('section.signals')
	await expect(signals).toBeVisible()
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect.poll(() => page.evaluate(() => Boolean(window.__signalsFixture))).toBe(true)
	const list = signals.locator('.signals-flow-keys')
	return {
		signals,
		list,
		done: signals.locator('.signals-tr[data-section="done"]'),
		count: signals.locator('.signals-done'),
		selected: signals.locator('.signals-tr[data-selected="true"]'),
		note: signals.locator('.signals-note'),
	}
}

async function calls(page: Page) {
	return page.evaluate(() => window.__signalsFixture?.calls)
}

test('the list never lists done rows; D and the count open Done today, Esc goes back', async ({ page }) => {
	// The retired inline-expand preference is ignored.
	await page.addInitScript(() => localStorage.setItem('helm.signals.doneShown', 'shown'))
	const view = await open(page, 'views-signals-column--column')
	await expect(view.signals).toBeFocused()
	await expect(view.done).toHaveCount(0)
	await expect(view.count).toHaveText(/^Done today 2 · D$/)
	await expect(view.count).toHaveAttribute('aria-keyshortcuts', 'Shift+D')
	await expect(view.count).not.toHaveAttribute('aria-expanded')
	// The `D` hint shows only while Signals holds the keys.
	await expect(view.count.locator('.signals-list-key')).toBeVisible()

	// j/k never reach a done row.
	for (let step = 0; step < 12; step += 1) await page.keyboard.press('j')
	await expect(view.selected).not.toHaveAttribute('data-section', 'done')
	const kept = await view.selected.getAttribute('data-signal-id')

	await page.keyboard.press('Shift+D')
	await expect(view.list).toBeFocused()
	await expect(view.list.locator('.signals-title-kind')).toHaveText('✓Done today')
	await expect(view.list.locator('.signals-title-context')).toHaveText('2 in the last 24 hours')
	await expect(view.done).toHaveCount(2)
	await expect(view.list.locator('.signals-tr[data-selected="true"]')).toHaveCount(1)
	await expect(view.signals.locator('.signals-title-kind', { hasText: 'Signals' })).toHaveCount(0)

	await page.keyboard.press('Escape')
	await expect(view.signals.locator('.signals-title-kind')).toHaveText('Signals')
	await expect(view.signals).toBeFocused()
	await expect(view.done).toHaveCount(0)
	// The list's own selection is where it was.
	await expect(view.selected).toHaveAttribute('data-signal-id', kept ?? '')

	// The count opens it by pointer too, and the keys go to the opened list (not the terminal).
	await view.count.click()
	await expect(view.list).toBeFocused()
	await expect(view.done).toHaveCount(2)
	await page.keyboard.press('Escape')
	await expect(view.signals).toBeFocused()

	// Nothing kept per renderer: a reload shows the list again, never the done rows.
	await page.reload()
	await expect(page.locator('section.signals')).toBeVisible()
	await expect(page.locator('.signals-title-kind')).toHaveText('Signals')
	await expect(page.locator('.signals-tr[data-section="done"]')).toHaveCount(0)
})

test('Done today: each row says how it got done after its ref, the whole as tooltip, no layout spill', async ({
	page,
}) => {
	const view = await open(page, 'views-signals-done--list')
	await expect(view.list).toBeFocused()
	await expect(view.list.locator('.signals-title-context')).toHaveText('8 in the last 24 hours')
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
	// The footer: the selected row's keys, Esc back, and one quiet Reopen.
	await expect(view.list.locator('.signals-foot-hints')).toHaveText(/^t reopen.*esc back$/)
	await expect(view.list.getByRole('button', { name: 'Reopen' })).toBeVisible()
	const spill = await view.signals.evaluate(root => {
		const scroller = root.querySelector('.signals-scroll') as HTMLElement
		return scroller.scrollWidth - scroller.clientWidth
	})
	expect(spill).toBeLessThanOrEqual(0)
	await page.screenshot({ path: test.info().outputPath('signals-done-list.png') })
})

test('Done today: t reopens (the row leaves, the next is selected), o opens, Esc shows it back in Needs you', async ({
	page,
}) => {
	const view = await open(page, 'views-signals-done--list')
	const rows = view.done
	const ids = await rows.evaluateAll(list => list.map(row => (row as HTMLElement).dataset.signalId))
	const [first, second] = ids
	await expect(view.list.locator('.signals-tr[data-selected="true"]')).toHaveAttribute('data-signal-id', first ?? '')
	await page.keyboard.press('j')
	await expect(view.list.locator('.signals-tr[data-selected="true"]')).toHaveAttribute('data-signal-id', second ?? '')
	await page.keyboard.press('k')

	// okena#298 (GitHub, gone): o opens its PR, the list stays.
	await view.list.locator('.signals-tr[data-signal-id="298"]').click()
	await expect(view.list).toBeFocused()
	await page.keyboard.press('o')
	await expect(view.note).toHaveText('Opened okena#298')
	expect((await calls(page))?.opened).toEqual(['https://github.com/contember/okena/pull/298'])

	const index = ids.indexOf('298')
	const next = ids[index + 1] ?? ids[index - 1]
	await page.keyboard.press('t')
	await expect(view.list.locator('.signals-tr[data-signal-id="298"]')).toHaveCount(0)
	await expect(view.note).toHaveText('okena#298 is back in Needs you')
	await expect(view.list.locator('.signals-tr[data-selected="true"]')).toHaveAttribute('data-signal-id', next ?? '')
	await expect(view.list.locator('.signals-title-context')).toHaveText('7 in the last 24 hours')
	await expect(view.list).toBeFocused()
	expect((await calls(page))?.updates).toEqual([{ id: 298, patch: { owner: 'jakub', state: 'seen' } }])

	// The button does the same as `t`.
	await view.list.getByRole('button', { name: 'Reopen' }).click()
	await expect(view.done).toHaveCount(6)
	expect((await calls(page))?.updates).toHaveLength(2)

	await page.keyboard.press('Escape')
	await expect(view.signals).toBeFocused()
	await expect(view.signals.locator('.signals-tr[data-signal-id="298"]')).toHaveAttribute('data-section', 'needs')
	await expect(view.count).toHaveText(/^Done today 6/)
	// The note stays on the list after Esc.
	await expect(view.note).not.toBeEmpty()
})

test('Done today: Reopen on the last row keeps the keys in the list (Esc still goes back)', async ({ page }) => {
	const view = await open(page, 'views-signals-column--column')
	await page.keyboard.press('Shift+D')
	await expect(view.done).toHaveCount(2)
	const reopen = view.list.getByRole('button', { name: 'Reopen' })
	await reopen.click()
	await expect(view.done).toHaveCount(1)
	await reopen.click()
	await expect(view.done).toHaveCount(0)
	await expect(view.list.locator('.signals-placeholder')).toHaveText('Nothing was done in the last 24 hours')
	await expect(view.list).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(view.signals).toBeFocused()
	await expect(view.count).toHaveCount(0)
	await expect(view.signals.locator('[data-done-header]')).toHaveText(/^Done today 0/)
})

test('Done today: o on an ask with several links lists them; Esc goes back to Done today, same row', async ({
	page,
}) => {
	const view = await open(page, 'views-signals-done--list')
	await view.list.locator('.signals-tr[data-signal-id="505"]').click()
	await expect(view.list.locator('.signals-foot-hints')).toHaveText(/^t reopen.*o links.*esc back$/)
	await page.keyboard.press('o')
	const links = view.signals.locator('.signals-flow-keys')
	await expect(links.locator('.signals-title-kind')).toContainText('Open a link')
	await expect(links).toBeFocused()

	await page.keyboard.press('Escape')
	await expect(view.list.locator('.signals-title-kind')).toContainText('Done today')
	await expect(view.list.locator('.signals-tr[data-selected="true"]')).toHaveAttribute('data-signal-id', '505')
	await expect(view.list).toBeFocused()

	// Opening one goes back to Done today too, its note saying which link opened.
	await page.keyboard.press('o')
	await page.keyboard.press('2')
	await expect(view.list.locator('.signals-title-kind')).toContainText('Done today')
	await expect(view.note).toHaveText('Opened link 2 of Signals asks')
	await expect(view.list).toBeFocused()
	expect((await calls(page))?.openedLinks).toEqual([expect.objectContaining({ index: 1 })])
})

test('Line: Done today closes the list after the snoozed rows, the filtered count after it', async ({ page }) => {
	const view = await open(page, 'views-signals-done--line')
	await expect(view.signals).toBeFocused()
	await expect(view.done).toHaveCount(0)
	const header = view.signals.locator('[data-done-header]')
	await expect(header).toHaveText(/^Done today 8 · D · 5 filtered · f$/)
	// Snoozed keeps its own band, the done line closes the list after it.
	await expect(view.signals.locator('.signals-section[aria-label="Snoozed"] .signals-band-count')).toHaveText('1')
	expect(await header.evaluate(node => node.previousElementSibling?.getAttribute('aria-label') ?? null)).toBe('Snoozed')
	// Both counts look alike: dim text buttons, no fill, ≥24px tall.
	for (const button of [view.count, view.signals.locator('.signals-filtered')]) {
		const look = await button.evaluate(node => {
			const style = getComputedStyle(node)
			return { weight: Number.parseInt(style.fontWeight, 10), background: style.backgroundColor }
		})
		expect(look.weight).toBeLessThan(600)
		expect(look.background).toBe('rgba(0, 0, 0, 0)')
		expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(24)
	}
	await page.screenshot({ path: test.info().outputPath('signals-done-line.png') })

	await page.keyboard.press('f')
	await expect(view.signals.locator('.signals-tr[data-section="filtered"]')).toHaveCount(5)
	await page.keyboard.press('Escape')
	await expect(view.signals.locator('.signals-tr[data-section="filtered"]')).toHaveCount(0)
	await page.keyboard.press('Shift+D')
	await expect(view.done).toHaveCount(8)
	await expect(view.list.locator('.signals-title-kind')).toContainText('Done today')
})

test('narrow column (300px): the line and the Done today list fit without spill', async ({ page }) => {
	const view = await open(page, 'views-signals-done--line', 1200)
	// The column at its narrowest (sidebar-layout clamps to 300–420px).
	await page.evaluate(() => document.documentElement.style.setProperty('--left-width', '300px'))
	expect(Math.round((await page.locator('#left').boundingBox())?.width ?? 0)).toBe(300)
	const header = view.signals.locator('[data-done-header]')
	// Both buttons stay whole (the line may wrap between them, never inside one).
	for (const button of [view.count, view.signals.locator('.signals-filtered')]) {
		const box = await button.boundingBox()
		expect(box?.height ?? 0).toBeLessThan(30)
	}
	expect(await header.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0)
	await page.screenshot({ path: test.info().outputPath('signals-done-line-300.png') })

	await page.keyboard.press('Shift+D')
	await expect(view.done).toHaveCount(8)
	const spill = await view.list.evaluate(root => {
		const scroller = root.querySelector('.signals-scroll') as HTMLElement
		const foot = root.querySelector('.signals-foot') as HTMLElement
		return {
			scroll: scroller.scrollWidth - scroller.clientWidth,
			foot: foot.scrollWidth - foot.clientWidth,
			title: (root.querySelector('.signals-title') as HTMLElement).scrollWidth - root.clientWidth,
		}
	})
	expect(spill.scroll).toBeLessThanOrEqual(0)
	expect(spill.foot).toBeLessThanOrEqual(0)
	expect(spill.title).toBeLessThanOrEqual(0)
	// The header's context is not cut off at the narrowest column.
	const context = view.list.locator('.signals-title-context')
	expect(await context.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0)
	await expect(view.list.getByRole('button', { name: 'Reopen' })).toBeInViewport()
	await page.screenshot({ path: test.info().outputPath('signals-done-list-300.png') })
})

/** The done count's bottom edge to the column's, the footer's height, and whether the status line is still mounted. */
async function bottom(signals: ReturnType<Page['locator']>) {
	return signals.evaluate(root => {
		const line = root.querySelector('[data-done-header]') as HTMLElement
		const count = (line.querySelector('.signals-done') as HTMLElement | null) ?? line
		const foot = root.querySelector('.signals-foot') as HTMLElement
		const edge = root.getBoundingClientRect().bottom
		return {
			gap: Math.round(edge - count.getBoundingClientRect().bottom),
			// The done line to the footer's top: nothing in between.
			toFoot: Math.round(foot.getBoundingClientRect().top - line.getBoundingClientRect().bottom),
			foot: Math.round(foot.getBoundingClientRect().height),
			note: Boolean(foot.querySelector('output.signals-note')),
		}
	})
}

test('at rest the empty footer takes no room: the done line sits 8px over the bottom edge, focused or not', async ({
	page,
}) => {
	const view = await open(page, 'views-signals-column--empty')
	await expect(view.signals).toBeFocused()
	// Nothing selected, no note, every source answered: the footer has nothing to show.
	expect(await bottom(view.signals)).toEqual({ gap: 8, toFoot: 4, foot: 0, note: true })
	await view.signals.evaluate(node => (node as HTMLElement).blur())
	expect(await bottom(view.signals)).toEqual({ gap: 8, toFoot: 4, foot: 0, note: true })
	await page.screenshot({ path: test.info().outputPath('signals-done-at-rest.png') })

	// A source line is footer content: it takes its room under the done line, nothing else.
	const down = await open(page, 'views-signals-column--empty-source-down')
	const withHealth = await bottom(down.signals)
	expect(withHealth.foot).toBeGreaterThanOrEqual(40)
	expect(withHealth.toFoot).toBe(4)
	expect(withHealth.gap).toBe(withHealth.foot + 8)

	// The bare column at 260 and 420px, at rest: the same 8px.
	await page.goto(story('views-signals-column--widths'))
	const frames = page.locator('section.signals')
	await expect(frames).toHaveCount(4)
	for (const index of [0, 2]) expect((await bottom(frames.nth(index))).gap).toBe(8)
})

test('a busy column keeps the selected row keys under the done line', async ({ page }) => {
	const view = await open(page, 'views-signals-done--line')
	await expect(view.signals).toBeFocused()
	await expect(view.signals.locator('.signals-foot-hints')).toBeVisible()
	const busy = await bottom(view.signals)
	expect(busy.toFoot).toBe(4)
	expect(busy.foot).toBeGreaterThanOrEqual(40)
	expect(busy.gap).toBe(busy.foot + 8)
})
