import { type Page, expect, test } from '@playwright/test'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
		__helmDragChurn?: { stripRebuilds: number; rowClears: number; activeHolders: string[] }
	}
}

const story = '/iframe.html?id=views-tab-drag--collapsed-folders&viewMode=story'
const ALPHA = 'group-000000c1'
const BETA = 'group-000000c2'
const GAMMA = 'group-000000c3'
const DELTA = 'group-000000c4'

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 700 })
	await page.goto(story)
	await expect(page.locator('#tabs .tab-group-section')).toHaveCount(4)
})

/** Strip units in visual order: a folder by its group id, an ordinary tab by its label. */
const stripUnits = (page: Page) =>
	page.evaluate(() =>
		[...(document.querySelector('#tabs')?.children ?? [])].map(child =>
			child instanceof HTMLElement && child.classList.contains('tab-group-section')
				? `group:${child.dataset.groupId}`
				: (child.querySelector('.tab-label')?.textContent ?? '?'),
		),
	)

const members = (page: Page, groupId: string) =>
	page.locator(`#tabs .tab-group-section[data-group-id="${groupId}"] .tab .tab-label`).allTextContents()

const header = (page: Page, groupId: string) => page.locator(`#tabs .tab-group-header[data-group-id="${groupId}"]`)
const stripTab = (page: Page, name: string) =>
	page.locator('#tabs .tab', { has: page.locator('.tab-label', { hasText: new RegExp(`^${name}$`) }) })

async function box(page: Page, locator: ReturnType<Page['locator']>) {
	const rect = await locator.boundingBox()
	if (!rect) throw new Error('missing box')
	return rect
}

/** Lift `name` past the 5px threshold, then hover each point in turn. */
async function liftTab(page: Page, name: string) {
	const source = await box(page, stripTab(page, name))
	const y = source.y + source.height / 2
	await page.mouse.move(source.x + source.width / 2, y)
	await page.mouse.down()
	await page.mouse.move(source.x + source.width / 2 + 8, y, { steps: 2 })
	await expect(page.locator('body')).toHaveClass(/tab-dragging/)
	return y
}

async function dropAt(page: Page, x: number, y: number) {
	await page.mouse.move(x, y, { steps: 6 })
	await page.mouse.up()
	await expect(page.locator('body')).not.toHaveClass(/tab-dragging/)
	await expect(page.locator('.tab-drag-preview, .drag-placeholder')).toHaveCount(0)
}

test('a tab drops in front of a run of collapsed folders from the first folder’s leading edge', async ({ page }) => {
	const alpha = await box(page, header(page, ALPHA))
	const y = await liftTab(page, 'api')
	await dropAt(page, alpha.x + 3, y)
	await expect
		.poll(() => stripUnits(page))
		.toEqual(['api', `group:${ALPHA}`, `group:${BETA}`, `group:${GAMMA}`, 'active shell', `group:${DELTA}`])
	for (const group of [ALPHA, BETA, GAMMA]) await expect(header(page, group)).toHaveAttribute('aria-expanded', 'false')
	expect(await members(page, ALPHA)).toEqual(['lint', 'format'])
})

test('the leading strip gutter before collapsed folders is slot 0', async ({ page }) => {
	const alpha = await box(page, header(page, ALPHA))
	const y = await liftTab(page, 'api')
	await dropAt(page, alpha.x - 3, y)
	await expect
		.poll(() => stripUnits(page))
		.toEqual(['api', `group:${ALPHA}`, `group:${BETA}`, `group:${GAMMA}`, 'active shell', `group:${DELTA}`])
})

test('a tab drops between two collapsed folders without joining either', async ({ page }) => {
	const gamma = await box(page, header(page, GAMMA))
	const y = await liftTab(page, 'api')
	await dropAt(page, gamma.x + 3, y)
	await expect
		.poll(() => stripUnits(page))
		.toEqual([`group:${ALPHA}`, `group:${BETA}`, 'api', `group:${GAMMA}`, 'active shell', `group:${DELTA}`])
	expect(await members(page, BETA)).toEqual(['migrate'])
	expect(await members(page, GAMMA)).toEqual(['e2e', 'smoke'])
})

test('a tab drops in the gap between collapsed folders', async ({ page }) => {
	const alpha = await box(page, header(page, ALPHA))
	const y = await liftTab(page, 'api')
	await dropAt(page, alpha.x + alpha.width + 2, y)
	await expect
		.poll(() => stripUnits(page))
		.toEqual([`group:${ALPHA}`, 'api', `group:${BETA}`, `group:${GAMMA}`, 'active shell', `group:${DELTA}`])
})

test('hovering a collapsed folder holds a visible slot in it and stays put; dropping joins it collapsed', async ({
	page,
}) => {
	const beta = await box(page, header(page, BETA))
	const y = await liftTab(page, 'api')
	const x = beta.x + beta.width / 2
	await page.mouse.move(x, y, { steps: 6 })
	const placeholder = page.locator(`#tabs .tab-group-section[data-group-id="${BETA}"] .tab.drag-placeholder`)
	await expect(placeholder).toHaveCount(1)
	// The slot is real, so the folder does not shrink under the pointer and hand the tab to its neighbor.
	expect((await box(page, placeholder)).width).toBeGreaterThan(20)
	for (const dx of [2, -2, 3, -3, 1]) await page.mouse.move(x + dx, y)
	await expect(placeholder).toHaveCount(1)
	expect(await members(page, GAMMA)).toEqual(['e2e', 'smoke'])
	await page.mouse.up()
	await expect(page.locator('.tab-drag-preview, .drag-placeholder')).toHaveCount(0)
	await expect.poll(() => members(page, BETA)).toEqual(['migrate', 'api'])
	await expect(header(page, BETA)).toHaveAttribute('aria-expanded', 'false')
	await expect(stripTab(page, 'api')).toBeHidden()
	expect(await stripUnits(page)).toEqual([
		`group:${ALPHA}`,
		`group:${BETA}`,
		`group:${GAMMA}`,
		'active shell',
		`group:${DELTA}`,
	])
})

test('a tab hovered into a collapsed folder can still be carried out in front of the folders', async ({ page }) => {
	const beta = await box(page, header(page, BETA))
	const y = await liftTab(page, 'api')
	await page.mouse.move(beta.x + beta.width / 2, y, { steps: 6 })
	await expect(page.locator(`#tabs .tab-group-section[data-group-id="${BETA}"] .tab.drag-placeholder`)).toHaveCount(1)
	const alpha = await box(page, header(page, ALPHA))
	await dropAt(page, alpha.x + 3, y)
	await expect
		.poll(() => stripUnits(page))
		.toEqual(['api', `group:${ALPHA}`, `group:${BETA}`, `group:${GAMMA}`, 'active shell', `group:${DELTA}`])
	expect(await members(page, BETA)).toEqual(['migrate'])
})

test('an expanded folder still takes a tab at its member midpoints, and its header edge drops before it', async ({
	page,
}) => {
	const web = await box(page, stripTab(page, 'web'))
	let y = await liftTab(page, 'api')
	await dropAt(page, web.x + web.width - 4, y)
	await expect.poll(() => members(page, DELTA)).toEqual(['web', 'api', 'worker'])

	const delta = await box(page, header(page, DELTA))
	y = await liftTab(page, 'api')
	await dropAt(page, delta.x + 3, y)
	await expect.poll(() => members(page, DELTA)).toEqual(['web', 'worker'])
	await expect
		.poll(() => stripUnits(page))
		.toEqual([`group:${ALPHA}`, `group:${BETA}`, `group:${GAMMA}`, 'active shell', 'api', `group:${DELTA}`])
})

test('dragging over the strip never repaints, refits or switches the active terminal', async ({ page }) => {
	await stripTab(page, 'active shell').click()
	await expect(stripTab(page, 'active shell')).toHaveAttribute('aria-selected', 'true')
	await page.evaluate(() => window.__helmWorkspaceFixture?.emitData('shell', 'hello from the active shell\r\n'))
	await expect(page.locator('.term-holder.active .xterm-rows')).toContainText('hello from the active shell')
	const y = await liftTab(page, 'api')
	// Let drag-start frames (and any refit they schedule) settle before measuring.
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
	await page.evaluate(() => {
		const churn = { stripRebuilds: 0, rowClears: 0, activeHolders: [] as string[] }
		window.__helmDragChurn = churn
		const tabs = document.querySelector('#tabs') as HTMLElement
		const holders = [...document.querySelectorAll<HTMLElement>('.term-holder')]
		const rows = document.querySelector('.term-holder.active .xterm-rows') as HTMLElement
		const activeName = () => String(holders.findIndex(holder => holder.classList.contains('active')))
		churn.activeHolders.push(activeName())
		new MutationObserver(records => {
			for (const record of records) {
				if (record.target === tabs && record.removedNodes.length > 0) churn.stripRebuilds += 1
				// xterm's renderer clear() empties each row (replaceChildren with no nodes): a blank frame.
				if (rows.contains(record.target) && record.addedNodes.length === 0 && record.removedNodes.length > 0)
					churn.rowClears += [...record.removedNodes].some(node => node.textContent) ? 1 : 0
				if (record.type === 'attributes') {
					const name = activeName()
					if (churn.activeHolders.at(-1) !== name) churn.activeHolders.push(name)
				}
			}
		}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
	})
	const api = await box(page, stripTab(page, 'api'))
	// Jiggle inside the tab's own slot: no projection change, so nothing may re-render.
	for (const dx of [1, 2, 3, 2, 1, 0]) await page.mouse.move(api.x + api.width / 2 + dx, y)
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
	const jiggleRebuilds = await page.evaluate(() => window.__helmDragChurn?.stripRebuilds)
	// Crossing folders reorders live, but the terminal itself stays untouched.
	const alpha = await box(page, header(page, ALPHA))
	await page.mouse.move(alpha.x + 3, y, { steps: 8 })
	await page.mouse.move(api.x + api.width / 2, y, { steps: 8 })
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
	const churn = await page.evaluate(() => window.__helmDragChurn)
	expect({
		jiggleRebuilds,
		rowClears: churn?.rowClears,
		activeSwitches: (churn?.activeHolders.length ?? 0) - 1,
	}).toEqual({
		jiggleRebuilds: 0,
		rowClears: 0,
		activeSwitches: 0,
	})
	await page.keyboard.press('Escape')
	await expect(page.locator('.term-holder.active .xterm-rows')).toContainText('hello from the active shell')
})

test('a tab carried across collapsed folders shows exactly where a release at that point drops it', async ({
	page,
}) => {
	// Reduced motion removes the FLIP so geometry is final after every move.
	await page.emulateMedia({ reducedMotion: 'reduce' })
	const alpha = await box(page, header(page, ALPHA))
	const gamma = await box(page, header(page, GAMMA))
	const y = await liftTab(page, 'api')
	const mismatches: string[] = []
	const xs: number[] = []
	for (let x = alpha.x - 4; x <= gamma.x + gamma.width + 6; x += 2) xs.push(x)
	for (const x of [...xs, ...xs.toReversed()]) {
		await page.mouse.move(x, y)
		const shown = await stripUnits(page)
		const slot = await page.evaluate(() => {
			const folder = document.querySelector('#tabs .drag-placeholder')?.closest<HTMLElement>('.tab-group-section')
			return folder?.dataset.groupId ?? null
		})
		// A release re-resolves the target at the same point: it must not change what is shown.
		await page.evaluate(
			([clientX, clientY]) =>
				document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX, clientY, bubbles: true })),
			[x, y],
		)
		const again = await stripUnits(page)
		const slotAgain = await page.evaluate(() => {
			const folder = document.querySelector('#tabs .drag-placeholder')?.closest<HTMLElement>('.tab-group-section')
			return folder?.dataset.groupId ?? null
		})
		if (JSON.stringify([shown, slot]) !== JSON.stringify([again, slotAgain]))
			mismatches.push(`${Math.round(x - alpha.x)}: ${slot ?? shown.join(',')} -> ${slotAgain ?? again.join(',')}`)
	}
	await page.keyboard.press('Escape')
	await page.mouse.up()
	expect(mismatches).toEqual([])
})

test('a folder dragged in front of collapsed folders is visible after the drop', async ({ page }) => {
	const gamma = await box(page, header(page, GAMMA))
	const alpha = await box(page, header(page, ALPHA))
	const y = gamma.y + gamma.height / 2
	await page.mouse.move(gamma.x + gamma.width / 2, y)
	await page.mouse.down()
	await page.mouse.move(gamma.x + gamma.width / 2 - 10, y, { steps: 2 })
	await expect(page.locator('body')).toHaveClass(/group-dragging/)
	await page.mouse.move(alpha.x + 2, y, { steps: 8 })
	await page.mouse.up()
	await expect
		.poll(() => stripUnits(page))
		.toEqual([`group:${GAMMA}`, `group:${ALPHA}`, `group:${BETA}`, 'active shell', 'api', `group:${DELTA}`])
	await expect(page.locator('.tab-group-drag-preview')).toHaveCount(0)
	await expect(page.locator('#tabs .group-drag-placeholder, #tabs .group-drop-placeholder')).toHaveCount(0)
	await expect(header(page, GAMMA)).toBeVisible()
	expect(
		await page
			.locator(`#tabs .tab-group-section[data-group-id="${GAMMA}"]`)
			.evaluate(el => getComputedStyle(el).opacity),
	).toBe('1')
})
