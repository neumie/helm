import { type Page, expect, test } from '@playwright/test'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
	}
}

const harness = '/iframe.html?id=views-terminal-workspace--agent-dock-harness&viewMode=story'
const PREFERENCES = ['helm.agentDock.expanded', 'helm.agentDock.position']
/** Terminal rows the detail popover must always leave visible (design §3.24). */
const KEEP_ROWS = 4

async function openHarness(page: Page): Promise<void> {
	await page.goto(harness)
	await page.evaluate(keys => {
		for (const key of keys) localStorage.removeItem(key)
	}, PREFERENCES)
	await page.reload()
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#agent-dock .agent-dock-strip')).toBeVisible()
}

const box = async (page: Page, selector: string) => {
	const value = await page.locator(selector).first().boundingBox()
	if (!value) throw new Error(`Missing ${selector}`)
	return value
}

const xtermRows = (page: Page) => page.locator('.term-holder.active .xterm-rows > div').count()

/** The active xterm's row grid: where its first and last rows sit and how tall one row is. */
async function terminalRows(page: Page): Promise<{ top: number; bottom: number; rowHeight: number }> {
	const screen = await box(page, '.term-holder.active .xterm-screen')
	const rows = await xtermRows(page)
	return { top: screen.y, bottom: screen.y + screen.height, rowHeight: screen.height / rows }
}

async function emitScenario(page: Page, name: 'busy' | 'crowded' | 'empty' | 'down' | 'orphaned'): Promise<void> {
	await page.evaluate(scenario => {
		const dock = window.__helmWorkspaceFixture?.agentDock
		if (!dock) throw new Error('Missing agent-dock fixture')
		dock.emitScenario(scenario)
	}, name)
}

type ActMode = 'confirm' | 'unconfirmed' | 'refused' | 'error'

async function setActMode(page: Page, mode: ActMode): Promise<void> {
	await page.evaluate(next => {
		const dock = window.__helmWorkspaceFixture?.agentDock
		if (!dock) throw new Error('Missing agent-dock fixture')
		dock.setActMode(next)
	}, mode)
}

const acts = (page: Page) => page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.acts ?? [])
const terminalWrites = (page: Page) => page.evaluate(() => window.__helmWorkspaceFixture?.calls.writes.length)

/** Busy scenario, rail open, popover on item `index` (1 = question, 2 = permission, 3 = turn). */
async function openItem(page: Page, index: 1 | 2 | 3) {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('.agent-dock-card')).toHaveCount(3)
	await rail.locator('.agent-dock-card[aria-label*=" Question,"]').click()
	const popover = page.locator('.agent-dock-popover')
	for (let at = 1; at < index; at++) await popover.getByRole('button', { name: 'Next item' }).click()
	await expect(popover).toContainText(`${index} of 3`)
	return { input, rail, popover }
}

test.afterEach(async ({ page }) => {
	await page.evaluate(keys => {
		for (const key of keys) localStorage.removeItem(key)
	}, PREFERENCES)
})

test('dock sits below the terminals by default and new items never change the collapsed strip height', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'bottom')
	const terms = await box(page, '#terms')
	const dock = await box(page, '#agent-dock')
	const right = await box(page, '#right')
	expect(dock.y).toBeGreaterThanOrEqual(terms.y + terms.height - 0.5)
	expect(Math.round(dock.y + dock.height)).toBe(Math.round(right.y + right.height))
	const strip = page.locator('.agent-dock-strip')
	expect((await strip.boundingBox())?.height).toBe(28)
	await expect(page.locator('.agent-dock-rail')).toBeHidden()
	await expect(strip).toContainText('Nothing needs you')
	const rowsBefore = await xtermRows(page)

	await emitScenario(page, 'busy')
	await expect(strip).toContainText('3 need you')
	await expect(strip).toContainText('oldest 2h')
	await expect(strip.locator('.agent-dock-age')).toHaveAttribute('data-tone', 'danger')
	expect((await strip.boundingBox())?.height).toBe(28)
	// New items never open the rail or resize the terminal.
	await expect(page.locator('.agent-dock-rail')).toBeHidden()
	expect((await box(page, '#terms')).height).toBe(terms.height)
	expect(await xtermRows(page)).toBe(rowsBefore)

	// Never "all clear" while Okena is down.
	await emitScenario(page, 'down')
	await expect(strip).toContainText('Okena unreachable since')
	await expect(strip).not.toContainText('Nothing needs you')
	expect((await strip.boundingBox())?.height).toBe(28)
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.visible)).toEqual([true])
})

test('the rail toggle refits the terminal; items arriving in an open rail never resize it', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	const collapsedTerms = await box(page, '#terms')
	const collapsedRows = await xtermRows(page)

	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail).toBeVisible()
	await expect(input).toBeFocused()
	expect(await page.evaluate(() => localStorage.getItem('helm.agentDock.expanded'))).toBe('true')
	const openTerms = await box(page, '#terms')
	expect(openTerms.height).toBeLessThan(collapsedTerms.height - 80)
	await expect.poll(() => xtermRows(page)).toBeLessThan(collapsedRows)
	const openRows = await xtermRows(page)
	await expect(rail).toContainText('Nothing needs you')

	// The rail has one fixed height: items arriving while it is open change nothing in the terminal.
	await emitScenario(page, 'crowded')
	await expect(rail.locator('.agent-dock-card')).toHaveCount(5)
	expect((await box(page, '#terms')).height).toBe(openTerms.height)
	expect(await xtermRows(page)).toBe(openRows)
	expect((await box(page, '.agent-dock-strip')).height).toBe(28)

	await page.locator('.agent-dock-toggle').click()
	await expect(rail).toBeHidden()
	await expect(input).toBeFocused()
	await expect.poll(() => xtermRows(page)).toBe(collapsedRows)
	expect((await box(page, '#terms')).height).toBe(collapsedTerms.height)
})

test('cards open a popover clear of the last terminal rows; ‹ › and arrows step; pointer use keeps xterm focus', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('.agent-dock-card')).toHaveCount(3)

	// Clicking a card opens its popover; the terminal keeps focus.
	await rail.locator('.agent-dock-card[aria-label*=" Question,"]').click()
	const popover = page.locator('.agent-dock-popover')
	await expect(popover).toBeVisible()
	await expect(input).toBeFocused()
	await expect(popover).toContainText('1 of 3')
	await expect(popover).toContainText(/Asked \d\d:\d\d/)
	// Verbatim AskUserQuestion content, plain text; previews in monospace; nothing submits until every question has an answer.
	await expect(popover).toContainText('Barva?')
	await expect(popover.locator('.agent-dock-preview-text')).toHaveText('▇▇ blue')
	await popover.getByRole('tab', { name: /Size/ }).click()
	await expect(popover).toContainText('Velikost?')
	await expect(popover.getByRole('button', { name: 'Submit answers' })).toBeDisabled()
	await expect(popover).toContainText('Answer every question, then submit')
	await expect(popover.getByRole('button', { name: /Ack/ })).toHaveCount(0)
	await expect(input).toBeFocused()

	// Never over the terminal's last rows (the input line), and its edge sits on a row boundary.
	const rows = await terminalRows(page)
	const placed = await box(page, '.agent-dock-popover')
	expect(placed.y + placed.height).toBeLessThanOrEqual(rows.bottom - KEEP_ROWS * rows.rowHeight + 0.5)
	const rowsBelow = (rows.bottom - placed.y - placed.height) / rows.rowHeight
	expect(Math.abs(rowsBelow - Math.round(rowsBelow))).toBeLessThan(0.05)
	expect(placed.y).toBeGreaterThanOrEqual((await box(page, '#terms')).y)

	// › steps to the next item without moving the popover sideways.
	const next = popover.getByRole('button', { name: 'Next item' })
	await next.click()
	await expect(popover).toContainText('2 of 3')
	await expect(popover).toContainText('npm run deploy:stage')
	// "Always allow" wording comes from Claude's permission_suggestions.
	await expect(popover).toContainText('Always allow Bash(npm run deploy:stage)')
	expect((await box(page, '.agent-dock-popover')).x).toBe(placed.x)
	await expect(input).toBeFocused()
	// Stepping never shrinks the popover, so ‹ › stay under the pointer (a shorter item never drops them away).
	const nextAt = await next.boundingBox()
	await popover.getByRole('button', { name: 'Previous item' }).click()
	await expect(popover).toContainText('1 of 3')
	expect(await next.boundingBox()).toEqual(nextAt)
	await next.click()
	await expect(popover).toContainText('2 of 3')
	expect(await next.boundingBox()).toEqual(nextAt)

	// Clicking popover text returns focus to the terminal (nothing selected).
	await popover.locator('.agent-dock-pop-label').click()
	await expect(input).toBeFocused()

	// Keyboard: ← / → / ↑ / ↓ step inside a focused popover.
	await popover.focus()
	await page.keyboard.press('ArrowRight')
	await expect(popover).toContainText('3 of 3')
	await page.keyboard.press('ArrowUp')
	await expect(popover).toContainText('2 of 3')
	await page.keyboard.press('ArrowDown')
	await expect(popover).toContainText('3 of 3')
	await expect(popover.getByRole('button', { name: 'Next item' })).toBeDisabled()

	// Ack on the unchecked turn runs the reducer ack and shows the next item.
	await expect(popover).toContainText('can you confirm the secret is set in stage?')
	await expect(popover).toContainText(/Finished \d\d:\d\d/)
	const turnId = Number(await rail.locator('.agent-dock-card[data-kind="turn"]').getAttribute('data-item-id'))
	await popover.getByRole('button', { name: `Ack item ${turnId}` }).click()
	await expect(rail.locator('.agent-dock-card[data-kind="turn"]')).toHaveCount(0)
	await expect(popover).toContainText('2 of 2')
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.acks)).toEqual([turnId])
	await expect(page.locator('.agent-dock-strip')).toContainText('2 need you')

	// Esc closes the popover back to its card; a second Esc returns to the terminal; the rail stays.
	const shownId = await rail.locator('.agent-dock-card[data-open="true"]').getAttribute('data-item-id')
	await popover.focus()
	await page.keyboard.press('Escape')
	await expect(popover).toHaveCount(0)
	await expect(rail.locator(`.agent-dock-card[data-item-id="${shownId}"]`)).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(input).toBeFocused()
	await expect(rail).toBeVisible()

	// A click in the terminal closes an open popover.
	await rail.locator('.agent-dock-agents-button').click()
	await expect(popover).toContainText('Agents')
	await expect(input).toBeFocused()
	await page.locator('.term-holder.active .xterm-screen').click({ position: { x: 40, y: 40 } })
	await expect(popover).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.calls.writes.length)).toBe(0)
})

test('⌘⇧J goes to the dock: opens the rail and focuses a card, Esc returns, pressed inside it closes', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	const rail = page.locator('.agent-dock-rail')
	const firstCard = rail.locator('[data-rail-stop]').first()

	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(rail).toBeVisible()
	await expect(firstCard).toBeFocused()
	// ←/→ rove across the cards and the Agents button.
	await page.keyboard.press('End')
	await expect(rail.locator('.agent-dock-agents-button')).toBeFocused()
	await page.keyboard.press('Home')
	await expect(firstCard).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(input).toBeFocused()
	await expect(rail).toBeVisible()
	const openTerms = await box(page, '#terms')
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(firstCard).toBeFocused()
	expect((await box(page, '#terms')).height).toBe(openTerms.height)
	// Enter on a card opens and focuses the popover.
	await page.keyboard.press('Enter')
	await expect(page.locator('.agent-dock-popover')).toBeFocused()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(rail).toBeHidden()
	await expect(page.locator('.agent-dock-popover')).toHaveCount(0)
	await expect(input).toBeFocused()
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.calls.writes.length)).toBe(0)
})

test('keyboard stepping keeps focus in the popover; question tabs keep their own arrows; a resolved item closes it', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await page.locator('.term-holder.active .xterm-helper-textarea').focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	const rail = page.locator('.agent-dock-rail')
	const popover = page.locator('.agent-dock-popover')
	await expect(rail.locator('[data-rail-stop]').first()).toBeFocused()
	await page.keyboard.press('Enter')
	await expect(popover).toBeFocused()
	await expect(popover).toContainText('1 of 3')

	// Enter on a focused › steps and focus stays on ›.
	const next = popover.getByRole('button', { name: 'Next item' })
	await next.focus()
	await page.keyboard.press('Enter')
	await expect(popover).toContainText('2 of 3')
	await expect(next).toBeFocused()
	// At the last item › disables: focus falls back to the popover, never to <body>.
	await page.keyboard.press('Enter')
	await expect(popover).toContainText('3 of 3')
	await expect(next).toBeDisabled()
	await expect(popover).toBeFocused()
	await page.keyboard.press('ArrowLeft')
	await page.keyboard.press('ArrowLeft')
	await expect(popover).toContainText('1 of 3')

	// ← → on the question tabs switch tabs (ARIA tabs), never items.
	const sizeTab = popover.getByRole('tab', { name: /Size/ })
	await popover.getByRole('tab', { name: /Color/ }).focus()
	await page.keyboard.press('ArrowRight')
	await expect(sizeTab).toBeFocused()
	await expect(sizeTab).toHaveAttribute('aria-selected', 'true')
	await expect(popover).toContainText('Velikost?')
	await expect(popover).toContainText('1 of 3')

	// The open item is answered in the terminal: the popover closes and focus stays in the dock.
	await emitScenario(page, 'empty')
	await expect(popover).toHaveCount(0)
	expect(await page.evaluate(() => !!document.activeElement?.closest('#agent-dock'))).toBe(true)
})

test('at a 1100px window three items keep full cards with two-line gists', async ({ page }) => {
	await page.setViewportSize({ width: 1100, height: 800 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('.agent-dock-card')).toHaveCount(3)
	await expect(rail.locator('.agent-dock-cards')).toHaveAttribute('data-density', 'full')
	await expect(rail.locator('.agent-dock-card-gist').first()).toBeVisible()
	for (const name of await rail.locator('.agent-dock-card-name').all())
		expect(await name.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
	await expect(rail.locator('.agent-dock-agents-button')).toBeVisible()
})

test('at a 900px window all five items stay visible as compact cards', async ({ page }) => {
	await page.setViewportSize({ width: 900, height: 700 })
	await openHarness(page)
	await emitScenario(page, 'crowded')
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	const cards = rail.locator('.agent-dock-card')
	await expect(cards).toHaveCount(5)
	await expect(rail.locator('.agent-dock-cards')).toHaveAttribute('data-density', 'compact')
	const railBox = await box(page, '.agent-dock-rail')
	for (const card of await cards.all()) {
		const cardBox = await card.boundingBox()
		if (!cardBox) throw new Error('card not laid out')
		expect(cardBox.x).toBeGreaterThanOrEqual(railBox.x)
		expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(railBox.x + railBox.width + 0.5)
		expect(cardBox.y).toBeGreaterThanOrEqual(railBox.y)
		expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(railBox.y + railBox.height + 0.5)
		// The agent name is never ellipsized away.
		const name = card.locator('.agent-dock-card-name')
		expect(await name.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
	}
	await expect(rail.locator('.agent-dock-agents-button')).toBeVisible()
	// Nothing is paged or scrolled out of sight.
	expect(await rail.locator('.agent-dock-cards').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)

	// The question popover still keeps the input line visible.
	await rail.locator('.agent-dock-card[aria-label*=" Question,"]').click()
	const rows = await terminalRows(page)
	const placed = await box(page, '.agent-dock-popover')
	expect(placed.y + placed.height).toBeLessThanOrEqual(rows.bottom - KEEP_ROWS * rows.rowHeight + 0.5)
})

test('position persists; on top the rail and popover open downward clear of the terminal rows', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await page.locator('.agent-dock-toggle').click()
	await page.getByRole('button', { name: 'Move agent dock above terminals' }).click()
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
	let dock = await box(page, '#agent-dock')
	let terms = await box(page, '#terms')
	expect(dock.y + dock.height).toBeLessThanOrEqual(terms.y + 0.5)
	// The strip leads and the rail sits between it and the terminals.
	expect((await box(page, '.agent-dock-strip')).y).toBeLessThan((await box(page, '.agent-dock-rail')).y)

	await page.locator('.agent-dock-card').first().click()
	const rows = await terminalRows(page)
	const placed = await box(page, '.agent-dock-popover')
	expect(placed.y).toBeGreaterThanOrEqual(rows.top + KEEP_ROWS * rows.rowHeight - 0.5)
	expect(placed.y + placed.height).toBeLessThanOrEqual(rows.bottom - KEEP_ROWS * rows.rowHeight + 0.5)

	await page.reload()
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
	await expect(page.locator('.agent-dock-rail')).toBeVisible()
	dock = await box(page, '#agent-dock')
	terms = await box(page, '#terms')
	expect(dock.y + dock.height).toBeLessThanOrEqual(terms.y + 0.5)
})

test('the dock works when its layout preferences cannot be read or written', async ({ page }) => {
	await page.addInitScript(() => {
		const read = Storage.prototype.getItem
		const write = Storage.prototype.setItem
		Storage.prototype.getItem = function (key: string) {
			if (key.startsWith('helm.agentDock.')) throw new DOMException('Storage unavailable', 'SecurityError')
			return read.call(this, key)
		}
		Storage.prototype.setItem = function (key: string, value: string) {
			if (key.startsWith('helm.agentDock.')) throw new DOMException('Storage unavailable', 'SecurityError')
			return write.call(this, key, value)
		}
	})
	await page.goto(harness)
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'bottom')
	await page.locator('.agent-dock-toggle').click()
	await expect(page.locator('.agent-dock-rail')).toBeVisible()
	await page.getByRole('button', { name: 'Move agent dock above terminals' }).click()
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
})

test('answering a question from the popover: 1-9 pick, Enter submits, Sending… then ✓ answered, focus back in xterm', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	const rail = page.locator('.agent-dock-rail')
	const popover = page.locator('.agent-dock-popover')
	await page.keyboard.press('Enter')
	await expect(popover).toBeFocused()
	await expect(popover).toContainText('1 of 3')
	const card = rail.locator('.agent-dock-card[aria-label*=" Question,"]')
	const itemId = Number(await card.getAttribute('data-item-id'))
	const submit = popover.getByRole('button', { name: 'Submit answers' })

	// Enter with an unanswered question submits nothing; "2" picks Blue and moves to the next question.
	await page.keyboard.press('Enter')
	expect(await acts(page)).toEqual([])
	await page.keyboard.press('2')
	await expect(popover.getByRole('tab', { name: /Size/ })).toHaveAttribute('aria-selected', 'true')
	await expect(submit).toBeDisabled()
	await page.keyboard.press('1')
	await expect(submit).toBeEnabled()
	await expect(popover).toContainText('Ready to submit')
	// Back on the first tab the pick shows as pressed.
	await popover.getByRole('tab', { name: /Color/ }).click()
	await expect(popover.getByRole('button', { name: /Blue/ })).toHaveAttribute('aria-pressed', 'true')
	await popover.focus()
	await page.keyboard.press('Enter')

	// The receipt: Sending… on the card first, then ✓ answered once the dialog is seen closed.
	await expect(card).toHaveAttribute('aria-label', /Sending…/)
	await expect(card).toContainText('✓ answered')
	await expect(card).toHaveAttribute('data-receipt', 'success')
	expect(await acts(page)).toEqual([
		{ itemId, rev: 1, action: { type: 'answer', picks: [{ options: [1] }, { options: [0] }] } },
	])
	await expect(page.locator('.agent-dock-strip')).toContainText('2 need you')
	await expect(input).toBeFocused()
	expect(await terminalWrites(page)).toBe(0)
	// The answered card leaves the rail after a moment.
	await expect(card).toHaveCount(0, { timeout: 10_000 })
})

test('"Other…" takes free text per question; typing digits in it types, never picks', async ({ page }) => {
	const { popover, rail } = await openItem(page, 1)
	const itemId = Number(await rail.locator('.agent-dock-card[aria-label*=" Question,"]').getAttribute('data-item-id'))
	await popover.getByRole('button', { name: /Other…/ }).click()
	const other = popover.getByRole('textbox', { name: 'Your answer to question 1' })
	await expect(other).toBeFocused()
	await other.pressSequentially('Zelená 2')
	await expect(other).toHaveValue('Zelená 2')
	await popover.getByRole('tab', { name: /Size/ }).click()
	await popover.getByRole('button', { name: /^2/ }).click()
	await popover.getByRole('button', { name: 'Submit answers' }).click()
	await expect(rail.locator(`.agent-dock-card[data-item-id="${itemId}"]`)).toContainText('✓ answered')
	expect(await acts(page)).toEqual([
		{ itemId, rev: 1, action: { type: 'answer', picks: [{ options: [], other: 'Zelená 2' }, { options: [1] }] } },
	])
	expect(await terminalWrites(page)).toBe(0)
})

test('permission: Deny with a message, refused when it was answered elsewhere; Always allow only from suggestions', async ({
	page,
}) => {
	const { popover, rail } = await openItem(page, 2)
	await setActMode(page, 'refused')
	const card = rail.locator('.agent-dock-card[aria-label*=" Permission,"]')
	const itemId = Number(await card.getAttribute('data-item-id'))
	// No single click allows anything: the footer button stays disabled until a choice is picked.
	await expect(popover.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
	await popover.getByRole('button', { name: /Deny and tell the agent/ }).click()
	const message = popover.getByRole('textbox', { name: 'Message to the agent (optional)' })
	await expect(message).toBeFocused()
	await message.fill('use deploy:preview')
	const before = (await acts(page)).length
	await popover.getByRole('button', { name: 'Deny', exact: true }).click()
	// A deny message goes to the agent: risky words ask first, like a reply.
	await expect(popover.getByRole('alert')).toContainText('This message mentions “deploy”')
	expect((await acts(page)).length).toBe(before)
	await popover.getByRole('button', { name: 'Send anyway' }).click()
	await expect(card).toContainText('refused: already answered elsewhere')
	await expect(card).toHaveAttribute('data-receipt', 'danger')
	expect((await acts(page)).at(-1)).toEqual({
		itemId,
		rev: 1,
		action: { type: 'deny', message: 'use deploy:preview', confirmed: true },
	})

	// Fresh scenario, Always allow: the rule comes from Claude's permission_suggestions.
	await emitScenario(page, 'busy')
	await setActMode(page, 'confirm')
	// The popover stayed on the (same id) permission item; clicking its card again would close it.
	if (!(await popover.isVisible())) await rail.locator('.agent-dock-card[aria-label*=" Permission,"]').click()
	await expect(popover).toContainText('2 of 3')
	await expect(popover).toContainText('(this session)')
	await popover.getByRole('button', { name: /Always allow Bash\(npm run deploy:stage\)/ }).click()
	await popover.getByRole('button', { name: 'Always allow', exact: true }).click()
	const allowed = rail.locator('.agent-dock-card[aria-label*=" Permission,"]')
	await expect(allowed).toContainText('✓ always allowed')
	expect((await acts(page)).at(-1)?.action).toEqual({ type: 'allow', always: true })
})

test('reply to a finished turn: risky words ask first; unconfirmed turns amber and stays ackable', async ({ page }) => {
	const { popover, rail, input } = await openItem(page, 3)
	await setActMode(page, 'unconfirmed')
	const card = rail.locator('.agent-dock-card[data-kind="turn"]')
	const itemId = Number(await card.getAttribute('data-item-id'))
	const reply = popover.getByRole('textbox', { name: 'Reply' })
	await reply.click()
	await expect(reply).toBeFocused()
	await page.keyboard.type('Yes, push it 2')
	await expect(reply).toHaveValue('Yes, push it 2')
	await popover.getByRole('button', { name: 'Send', exact: true }).click()
	await expect(popover.getByRole('alert')).toContainText('This reply mentions “push”')
	expect(await acts(page)).toEqual([])
	await popover.getByRole('button', { name: 'Send anyway' }).click()
	await expect(card).toContainText('Sending…')
	await expect(card).toContainText('sent, unconfirmed')
	await expect(card).toHaveAttribute('data-receipt', 'warn')
	expect(await acts(page)).toEqual([
		{ itemId, rev: 1, action: { type: 'prompt', text: 'Yes, push it 2', confirmed: true } },
	])
	// The 2xx came back: focus goes back to the terminal; nothing was typed there by the dock itself.
	await expect(input).toBeFocused()
	expect(await terminalWrites(page)).toBe(0)
	// The popover stays on the item after sending; ack from it.
	await expect(popover).toContainText('sent, unconfirmed')
	await popover.getByRole('button', { name: `Ack item ${itemId}` }).click()
	await expect(card).toHaveCount(0)
})

test('an Okena error shows verbatim, the item stays open and can be answered again', async ({ page }) => {
	const { popover, rail } = await openItem(page, 1)
	await setActMode(page, 'error')
	const card = rail.locator('.agent-dock-card[aria-label*=" Question,"]')
	await popover.getByRole('button', { name: /Red/ }).click()
	await popover.getByRole('tab', { name: /Size/ }).click()
	await popover.getByRole('button', { name: /^1/ }).click()
	const submit = popover.getByRole('button', { name: 'Submit answers' })
	await submit.click()
	await expect(popover.locator('.agent-dock-receipt')).toContainText('failed (500): bridge unavailable')
	await expect(card).toHaveAttribute('data-state', 'open')
	await expect(page.locator('.agent-dock-strip')).toContainText('3 need you')
	await expect(submit).toBeEnabled()
	await setActMode(page, 'confirm')
	await submit.click()
	await expect(card).toContainText('✓ answered')
	expect((await acts(page)).length).toBe(2)
})
