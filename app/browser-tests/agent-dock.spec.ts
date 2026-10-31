import { type Page, expect, test } from '@playwright/test'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
	}
}

const harness = '/iframe.html?id=views-terminal-workspace--agent-dock-harness&viewMode=story'
const PREFERENCES = ['helm.agentDock.expanded', 'helm.agentDock.position']

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

/** The pane is in-flow: it sits outside the terminal row and never over its text. */
async function expectPaneBesideTerminal(page: Page, position: 'top' | 'bottom' = 'bottom'): Promise<void> {
	const pane = page.locator('.agent-dock-pane')
	expect(await pane.evaluate(node => getComputedStyle(node).position)).toBe('static')
	const paneBox = await box(page, '.agent-dock-pane')
	const terms = await box(page, '#terms')
	const screen = await box(page, '.term-holder.active .xterm-screen')
	if (position === 'bottom') {
		expect(paneBox.y).toBeGreaterThanOrEqual(terms.y + terms.height - 0.5)
		expect(screen.y + screen.height).toBeLessThanOrEqual(paneBox.y + 0.5)
	} else {
		expect(paneBox.y + paneBox.height).toBeLessThanOrEqual(terms.y + 0.5)
		expect(screen.y).toBeGreaterThanOrEqual(paneBox.y + paneBox.height - 0.5)
	}
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

/** Busy scenario, queue open, pane on item `index` (1 = question, 2 = permission, 3 = turn). */
async function openItem(page: Page, index: 1 | 2 | 3) {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(3)
	await rail.locator('.agent-dock-entry[aria-label*=" Question,"]').click()
	const pane = page.locator('.agent-dock-pane')
	for (let at = 1; at < index; at++) await pane.getByRole('button', { name: 'Next item' }).click()
	await expect(pane).toContainText(`${index}/3`)
	return { input, rail, pane }
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
	expect(openTerms.height).toBeLessThan(collapsedTerms.height - 60)
	await expect.poll(() => xtermRows(page)).toBeLessThan(collapsedRows)
	const openRows = await xtermRows(page)
	await expect(rail).toContainText('Nothing needs you')

	// The rail has one fixed height: items arriving while it is open change nothing in the terminal.
	await emitScenario(page, 'crowded')
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(5)
	expect((await box(page, '#terms')).height).toBe(openTerms.height)
	expect(await xtermRows(page)).toBe(openRows)
	expect((await box(page, '.agent-dock-strip')).height).toBe(28)

	await page.locator('.agent-dock-toggle').click()
	await expect(rail).toBeHidden()
	await expect(input).toBeFocused()
	await expect.poll(() => xtermRows(page)).toBe(collapsedRows)
	expect((await box(page, '#terms')).height).toBe(collapsedTerms.height)
})

test('entries open a pane split off the terminal; ‹ › and arrows step; pointer use keeps xterm focus', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(3)
	const rowsBefore = await xtermRows(page)

	// Clicking an entry opens its pane; the terminal keeps focus.
	await rail.locator('.agent-dock-entry[aria-label*=" Question,"]').click()
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toBeVisible()
	await expect(input).toBeFocused()
	await expect(pane).toContainText('1/3')
	await expect(pane).toContainText(/asked \d\d:\d\d/)
	// Verbatim AskUserQuestion content, plain text; previews in monospace; nothing submits until every question has an answer.
	await expect(pane).toContainText('Barva?')
	await expect(pane.locator('.agent-dock-preview-text')).toHaveText('▇▇ blue')
	await pane.getByRole('tab', { name: /Size/ }).click()
	await expect(pane).toContainText('Velikost?')
	await expect(pane.getByRole('button', { name: 'Submit answers' })).toBeDisabled()
	await expect(pane).toContainText('Answer every question, then submit')
	await expect(pane.getByRole('button', { name: /Ack/ })).toHaveCount(0)
	await expect(input).toBeFocused()

	// In-flow: the terminal row shrank and refit; the pane never covers its rows.
	await expectPaneBesideTerminal(page)
	await expect.poll(() => xtermRows(page)).toBeLessThan(rowsBefore)
	const rowsOpen = await xtermRows(page)
	const placed = await box(page, '.agent-dock-pane')

	// › steps to the next item without moving the pane or refitting the terminal.
	const next = pane.getByRole('button', { name: 'Next item' })
	await next.click()
	await expect(pane).toContainText('2/3')
	await expect(pane).toContainText('npm run deploy:stage')
	// "Always allow" wording comes from Claude's permission_suggestions.
	await expect(pane).toContainText('Always allow Bash(npm run deploy:stage)')
	expect(await box(page, '.agent-dock-pane')).toEqual(placed)
	expect(await xtermRows(page)).toBe(rowsOpen)
	await expect(input).toBeFocused()
	// The pane keeps its height while open, so ‹ › stay under the pointer (a shorter item never drops them away).
	const nextAt = await next.boundingBox()
	await pane.getByRole('button', { name: 'Previous item' }).click()
	await expect(pane).toContainText('1/3')
	expect(await next.boundingBox()).toEqual(nextAt)
	await next.click()
	await expect(pane).toContainText('2/3')
	expect(await next.boundingBox()).toEqual(nextAt)

	// Clicking pane text returns focus to the terminal (nothing selected).
	await pane.locator('.agent-dock-pane-lead').click()
	await expect(input).toBeFocused()

	// Keyboard: ← / → / ↑ / ↓ step inside a focused pane.
	await pane.focus()
	await page.keyboard.press('ArrowRight')
	await expect(pane).toContainText('3/3')
	await page.keyboard.press('ArrowUp')
	await expect(pane).toContainText('2/3')
	await page.keyboard.press('ArrowDown')
	await expect(pane).toContainText('3/3')
	await expect(pane.getByRole('button', { name: 'Next item' })).toBeDisabled()

	// Ack on the unchecked turn runs the reducer ack and shows the next item.
	await expect(pane).toContainText('can you confirm the secret is set in stage?')
	await expect(pane).toContainText(/finished \d\d:\d\d/)
	const turnId = Number(await rail.locator('.agent-dock-entry[data-kind="turn"]').getAttribute('data-item-id'))
	await pane.getByRole('button', { name: `Ack item ${turnId}` }).click()
	await expect(rail.locator('.agent-dock-entry[data-kind="turn"]')).toHaveCount(0)
	await expect(pane).toContainText('2/2')
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.acks)).toEqual([turnId])
	await expect(page.locator('.agent-dock-strip')).toContainText('2 need you')

	// Esc closes the pane back to its entry (the terminal refits to its old height); a second Esc returns to the terminal; the queue stays.
	const shownId = await rail.locator('.agent-dock-entry[data-open="true"]').getAttribute('data-item-id')
	await pane.focus()
	await page.keyboard.press('Escape')
	await expect(pane).toHaveCount(0)
	await expect.poll(() => xtermRows(page)).toBe(rowsBefore)
	await expect(rail.locator(`.agent-dock-entry[data-item-id="${shownId}"]`)).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(input).toBeFocused()
	await expect(rail).toBeVisible()

	// A click in the terminal closes an open pane.
	await rail.locator('.agent-dock-agents-entry').click()
	await expect(pane).toContainText('Agents')
	await expect(input).toBeFocused()
	await page.locator('.term-holder.active .xterm-screen').click({ position: { x: 40, y: 40 } })
	await expect(pane).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.calls.writes.length)).toBe(0)
})

test('⌘⇧J goes to the dock: opens the queue and focuses an entry, Esc returns, pressed inside it closes', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	const rail = page.locator('.agent-dock-rail')
	const firstEntry = rail.locator('[data-rail-stop]').first()

	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(rail).toBeVisible()
	await expect(firstEntry).toBeFocused()
	// ←/→ rove across the entries and the Agents entry.
	await page.keyboard.press('End')
	await expect(rail.locator('.agent-dock-agents-entry')).toBeFocused()
	await page.keyboard.press('Home')
	await expect(firstEntry).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(input).toBeFocused()
	await expect(rail).toBeVisible()
	const openTerms = await box(page, '#terms')
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(firstEntry).toBeFocused()
	expect((await box(page, '#terms')).height).toBe(openTerms.height)
	// Enter on an entry opens and focuses the pane.
	await page.keyboard.press('Enter')
	await expect(page.locator('.agent-dock-pane')).toBeFocused()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(rail).toBeHidden()
	await expect(page.locator('.agent-dock-pane')).toHaveCount(0)
	await expect(input).toBeFocused()
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.calls.writes.length)).toBe(0)
})

test('keyboard stepping keeps focus in the pane; question tabs keep their own arrows; a resolved item closes it', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await page.locator('.term-holder.active .xterm-helper-textarea').focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	const rail = page.locator('.agent-dock-rail')
	const pane = page.locator('.agent-dock-pane')
	await expect(rail.locator('[data-rail-stop]').first()).toBeFocused()
	await page.keyboard.press('Enter')
	await expect(pane).toBeFocused()
	await expect(pane).toContainText('1/3')

	// Enter on a focused › steps and focus stays on ›.
	const next = pane.getByRole('button', { name: 'Next item' })
	await next.focus()
	await page.keyboard.press('Enter')
	await expect(pane).toContainText('2/3')
	await expect(next).toBeFocused()
	// At the last item › disables: focus falls back to the pane, never to <body>.
	await page.keyboard.press('Enter')
	await expect(pane).toContainText('3/3')
	await expect(next).toBeDisabled()
	await expect(pane).toBeFocused()
	await page.keyboard.press('ArrowLeft')
	await page.keyboard.press('ArrowLeft')
	await expect(pane).toContainText('1/3')

	// ← → on the question tabs switch tabs (ARIA tabs), never items.
	const sizeTab = pane.getByRole('tab', { name: /Size/ })
	await pane.getByRole('tab', { name: /Color/ }).focus()
	await page.keyboard.press('ArrowRight')
	await expect(sizeTab).toBeFocused()
	await expect(sizeTab).toHaveAttribute('aria-selected', 'true')
	await expect(pane).toContainText('Velikost?')
	await expect(pane).toContainText('1/3')

	// The open item is answered in the terminal: the pane closes and focus stays in the dock.
	await emitScenario(page, 'empty')
	await expect(pane).toHaveCount(0)
	expect(await page.evaluate(() => !!document.activeElement?.closest('#agent-dock'))).toBe(true)
})

test('at a 1100px window entries keep every agent name and wait whole', async ({ page }) => {
	await page.setViewportSize({ width: 1100, height: 800 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(3)
	await expect(rail.locator('.agent-dock-queue')).toHaveAttribute('data-density', 'full')
	await expect(rail.locator('.agent-dock-entry-gist').first()).toBeVisible()
	for (const name of await rail.locator('.agent-dock-entry-name').all())
		expect(await name.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
	await expect(rail.locator('.agent-dock-agents-entry')).toBeVisible()

	// Five items take two rows rather than squeezing one: every name and every wait stays in view.
	await emitScenario(page, 'crowded')
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(5)
	await expect(rail.locator('.agent-dock-queue')).toHaveAttribute('data-density', 'compact')
	for (const name of await rail.locator('.agent-dock-entry-name').all())
		expect(await name.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
	for (const entry of await rail.locator('.agent-dock-entry').all()) {
		const age = entry.locator('.agent-dock-entry-age')
		await expect(age).toBeVisible()
		// On the entry's own line, not wrapped onto a clipped one.
		expect(
			await age.evaluate(node => {
				const line = (node.parentElement as HTMLElement).getBoundingClientRect()
				const rect = node.getBoundingClientRect()
				return rect.top >= line.top - 0.5 && rect.bottom <= line.bottom + 0.5 && rect.right <= line.right + 0.5
			}),
		).toBe(true)
	}
	expect(await rail.locator('.agent-dock-queue').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
})

test('at a 900px window all five items stay visible in two rows with whole names', async ({ page }) => {
	await page.setViewportSize({ width: 900, height: 700 })
	await openHarness(page)
	await emitScenario(page, 'crowded')
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	const entries = rail.locator('.agent-dock-entry')
	await expect(entries).toHaveCount(5)
	await expect(rail.locator('.agent-dock-queue')).toHaveAttribute('data-density', 'compact')
	const railBox = await box(page, '.agent-dock-rail')
	for (const entry of await entries.all()) {
		const entryBox = await entry.boundingBox()
		if (!entryBox) throw new Error('entry not laid out')
		expect(entryBox.x).toBeGreaterThanOrEqual(railBox.x)
		expect(entryBox.x + entryBox.width).toBeLessThanOrEqual(railBox.x + railBox.width + 0.5)
		expect(entryBox.y).toBeGreaterThanOrEqual(railBox.y)
		expect(entryBox.y + entryBox.height).toBeLessThanOrEqual(railBox.y + railBox.height + 0.5)
		// The agent name is never ellipsized away.
		const name = entry.locator('.agent-dock-entry-name')
		expect(await name.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
	}
	await expect(rail.locator('.agent-dock-agents-entry')).toBeVisible()
	// Nothing is paged or scrolled out of sight.
	expect(await rail.locator('.agent-dock-queue').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)

	// The question pane still splits off the terminal instead of covering it.
	await rail.locator('.agent-dock-entry[aria-label*=" Question,"]').click()
	await expect(page.locator('.agent-dock-pane')).toBeVisible()
	await expectPaneBesideTerminal(page)
})

/** The write Settings → Appearance makes; the strip itself carries no position control. */
async function choosePosition(page: Page, position: 'top' | 'bottom'): Promise<void> {
	await page.evaluate(next => {
		const choose = window.__helmWorkspaceFixture?.setAgentDockPosition
		if (!choose) throw new Error('Missing agent-dock fixture')
		choose(next)
	}, position)
}

test('Settings → Appearance picks the dock position and persists it', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--appearance&viewMode=story')
	await page.evaluate(keys => {
		for (const key of keys) localStorage.removeItem(key)
	}, PREFERENCES)
	await page.reload()
	const choice = page.getByRole('tablist', { name: 'Agent dock position' })
	await expect(choice.getByRole('tab', { name: 'Bottom' })).toHaveAttribute('aria-selected', 'true')
	await choice.getByRole('tab', { name: 'Top' }).click()
	await expect(choice.getByRole('tab', { name: 'Top' })).toHaveAttribute('aria-selected', 'true')
	expect(await page.evaluate(() => localStorage.getItem('helm.agentDock.position'))).toBe('top')
	await page.reload()
	await expect(
		page.getByRole('tablist', { name: 'Agent dock position' }).getByRole('tab', { name: 'Top' }),
	).toHaveAttribute('aria-selected', 'true')
})

test('the strip has no position control; a settings change re-lays out the open dock live', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await page.locator('.agent-dock-toggle').click()
	await expect(page.locator('.agent-dock-strip button')).toHaveCount(1)
	const rowsBefore = await xtermRows(page)
	await choosePosition(page, 'top')
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
	await expect(page.locator('.agent-dock-rail')).toBeVisible()
	// Same queue height either way, so xterm refits to the same row count.
	expect(await xtermRows(page)).toBe(rowsBefore)
	await choosePosition(page, 'bottom')
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'bottom')
})

test('position persists; on top the strip leads, then the queue, then the pane above the terminal', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await page.locator('.agent-dock-toggle').click()
	await choosePosition(page, 'top')
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
	let dock = await box(page, '#agent-dock')
	let terms = await box(page, '#terms')
	expect(dock.y + dock.height).toBeLessThanOrEqual(terms.y + 0.5)
	// The strip leads and the queue sits between it and the terminals.
	expect((await box(page, '.agent-dock-strip')).y).toBeLessThan((await box(page, '.agent-dock-rail')).y)

	await page.locator('.agent-dock-entry').first().click()
	await expect(page.locator('.agent-dock-pane')).toBeVisible()
	const rail = await box(page, '.agent-dock-rail')
	const pane = await box(page, '.agent-dock-pane')
	expect(pane.y).toBeGreaterThanOrEqual(rail.y + rail.height - 0.5)
	await expectPaneBesideTerminal(page, 'top')
	// The open entry opens downward into its pane.
	const entry = await box(page, '.agent-dock-queue > li[data-open="true"]')
	expect(Math.abs(entry.y + entry.height - pane.y)).toBeLessThan(0.5)

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
	await choosePosition(page, 'top')
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
})

test('answering a question from the pane: 1-9 pick, Enter submits, Sending… then ✓ answered, focus back in xterm', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	const rail = page.locator('.agent-dock-rail')
	const pane = page.locator('.agent-dock-pane')
	await page.keyboard.press('Enter')
	await expect(pane).toBeFocused()
	await expect(pane).toContainText('1/3')
	const entry = rail.locator('.agent-dock-entry[aria-label*=" Question,"]')
	const itemId = Number(await entry.getAttribute('data-item-id'))
	const submit = pane.getByRole('button', { name: 'Submit answers' })

	// Enter with an unanswered question submits nothing; "2" picks Blue and moves to the next question.
	await page.keyboard.press('Enter')
	expect(await acts(page)).toEqual([])
	await page.keyboard.press('2')
	await expect(pane.getByRole('tab', { name: /Size/ })).toHaveAttribute('aria-selected', 'true')
	await expect(submit).toBeDisabled()
	await page.keyboard.press('1')
	await expect(submit).toBeEnabled()
	await expect(pane).toContainText('Ready to submit')
	// Back on the first tab the pick shows as pressed.
	await pane.getByRole('tab', { name: /Color/ }).click()
	await expect(pane.getByRole('button', { name: /Blue/ })).toHaveAttribute('aria-pressed', 'true')
	await pane.focus()
	await page.keyboard.press('Enter')

	// The receipt: Sending… on the entry first, then ✓ answered once the dialog is seen closed.
	await expect(entry).toHaveAttribute('aria-label', /Sending…/)
	await expect(entry).toContainText('✓ answered')
	await expect(entry).toHaveAttribute('data-receipt', 'success')
	expect(await acts(page)).toEqual([
		{ itemId, rev: 1, action: { type: 'answer', picks: [{ options: [1] }, { options: [0] }] } },
	])
	await expect(page.locator('.agent-dock-strip')).toContainText('2 need you')
	await expect(input).toBeFocused()
	expect(await terminalWrites(page)).toBe(0)
	await expect(pane.locator('.agent-dock-rule-age')).toHaveText(/^answered \d\d:\d\d$/)
	// While the pane is open the answer keeps its slot and the pane stays, past the receipt's linger:
	// nothing Jakub did would explain the terminal resizing under his typing.
	const rows = await xtermRows(page)
	await page.waitForTimeout(7_000)
	await expect(pane).toBeVisible()
	await expect(entry).toContainText('✓ answered')
	expect(await xtermRows(page)).toBe(rows)
	// Closing the pane lets it go.
	await pane.getByRole('button', { name: 'Close details' }).click()
	await expect(pane).toHaveCount(0)
	await expect(entry).toHaveCount(0)
})

test('"Other…" takes free text per question; typing digits in it types, never picks', async ({ page }) => {
	const { pane, rail } = await openItem(page, 1)
	const itemId = Number(await rail.locator('.agent-dock-entry[aria-label*=" Question,"]').getAttribute('data-item-id'))
	await pane.getByRole('button', { name: /Other…/ }).click()
	const other = pane.getByRole('textbox', { name: 'Your answer to question 1' })
	await expect(other).toBeFocused()
	await other.pressSequentially('Zelená 2')
	await expect(other).toHaveValue('Zelená 2')
	await pane.getByRole('tab', { name: /Size/ }).click()
	await pane.getByRole('button', { name: /^2/ }).click()
	await pane.getByRole('button', { name: 'Submit answers' }).click()
	await expect(rail.locator(`.agent-dock-entry[data-item-id="${itemId}"]`)).toContainText('✓ answered')
	expect(await acts(page)).toEqual([
		{ itemId, rev: 1, action: { type: 'answer', picks: [{ options: [], other: 'Zelená 2' }, { options: [1] }] } },
	])
	expect(await terminalWrites(page)).toBe(0)
})

test('permission: Deny with a message, refused when it was answered elsewhere; Always allow only from suggestions', async ({
	page,
}) => {
	const { pane, rail } = await openItem(page, 2)
	await setActMode(page, 'refused')
	const entry = rail.locator('.agent-dock-entry[aria-label*=" Permission,"]')
	const itemId = Number(await entry.getAttribute('data-item-id'))
	// No single click allows anything: the footer button stays disabled until a choice is picked.
	await expect(pane.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
	await pane.getByRole('button', { name: /Deny and tell the agent/ }).click()
	const message = pane.getByRole('textbox', { name: 'Message to the agent (optional)' })
	await expect(message).toBeFocused()
	await message.fill('use deploy:preview')
	const before = (await acts(page)).length
	await pane.getByRole('button', { name: 'Deny', exact: true }).click()
	// A deny message goes to the agent: risky words ask first, like a reply.
	await expect(pane.getByRole('alert')).toContainText('This message mentions “deploy”')
	expect((await acts(page)).length).toBe(before)
	await pane.getByRole('button', { name: 'Send anyway' }).click()
	await expect(entry).toContainText('refused: already answered elsewhere')
	await expect(entry).toHaveAttribute('data-receipt', 'danger')
	expect((await acts(page)).at(-1)).toEqual({
		itemId,
		rev: 1,
		action: { type: 'deny', message: 'use deploy:preview', confirmed: true },
	})

	// Fresh scenario, Always allow: the rule comes from Claude's permission_suggestions.
	await emitScenario(page, 'busy')
	await setActMode(page, 'confirm')
	// The pane stayed on the (same id) permission item; clicking its entry again would close it.
	if (!(await pane.isVisible())) await rail.locator('.agent-dock-entry[aria-label*=" Permission,"]').click()
	await expect(pane).toContainText('2/3')
	await expect(pane).toContainText('(this session)')
	await pane.getByRole('button', { name: /Always allow Bash\(npm run deploy:stage\)/ }).click()
	await pane.getByRole('button', { name: 'Always allow', exact: true }).click()
	const allowed = rail.locator('.agent-dock-entry[aria-label*=" Permission,"]')
	await expect(allowed).toContainText('✓ always allowed')
	expect((await acts(page)).at(-1)?.action).toEqual({ type: 'allow', always: true })
})

test('reply to a finished turn: risky words ask first; unconfirmed turns amber and stays ackable', async ({ page }) => {
	const { pane, rail, input } = await openItem(page, 3)
	await setActMode(page, 'unconfirmed')
	const entry = rail.locator('.agent-dock-entry[data-kind="turn"]')
	const itemId = Number(await entry.getAttribute('data-item-id'))
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await reply.click()
	await expect(reply).toBeFocused()
	await page.keyboard.type('Yes, push it 2')
	await expect(reply).toHaveValue('Yes, push it 2')
	await pane.getByRole('button', { name: 'Send', exact: true }).click()
	await expect(pane.getByRole('alert')).toContainText('This reply mentions “push”')
	expect(await acts(page)).toEqual([])
	await pane.getByRole('button', { name: 'Send anyway' }).click()
	await expect(entry).toContainText('Sending…')
	await expect(entry).toContainText('sent, unconfirmed')
	await expect(entry).toHaveAttribute('data-receipt', 'warn')
	expect(await acts(page)).toEqual([
		{ itemId, rev: 1, action: { type: 'prompt', text: 'Yes, push it 2', confirmed: true } },
	])
	// The 2xx came back: focus goes back to the terminal; nothing was typed there by the dock itself.
	await expect(input).toBeFocused()
	expect(await terminalWrites(page)).toBe(0)
	// The pane stays on the item after sending; ack from it.
	await expect(pane).toContainText('sent, unconfirmed')
	await pane.getByRole('button', { name: `Ack item ${itemId}` }).click()
	await expect(entry).toHaveCount(0)
})

test('an Okena error shows verbatim, the item stays open and can be answered again', async ({ page }) => {
	const { pane, rail } = await openItem(page, 1)
	await setActMode(page, 'error')
	const entry = rail.locator('.agent-dock-entry[aria-label*=" Question,"]')
	await pane.getByRole('button', { name: /Red/ }).click()
	await pane.getByRole('tab', { name: /Size/ }).click()
	await pane.getByRole('button', { name: /^1/ }).click()
	const submit = pane.getByRole('button', { name: 'Submit answers' })
	await submit.click()
	await expect(pane.locator('.agent-dock-receipt')).toContainText('failed (500): bridge unavailable')
	await expect(entry).toHaveAttribute('data-state', 'open')
	await expect(page.locator('.agent-dock-strip')).toContainText('3 need you')
	await expect(submit).toBeEnabled()
	await setActMode(page, 'confirm')
	await submit.click()
	await expect(entry).toContainText('✓ answered')
	expect((await acts(page)).length).toBe(2)
})

/** Computed edge colours and surface of an element (the open entry's slot or the pane). */
const surface = (page: Page, selector: string) =>
	page
		.locator(selector)
		.first()
		.evaluate(node => {
			const style = getComputedStyle(node)
			return {
				background: style.backgroundColor,
				top: style.borderTopWidth === '0px' ? 'none' : style.borderTopColor,
				bottom: style.borderBottomWidth === '0px' ? 'none' : style.borderBottomColor,
			}
		})

const OPEN_EDGE = ['none', 'rgba(0, 0, 0, 0)']

test('the open entry and its pane are one shape: the pane edge opens over the entry', async ({ page }) => {
	const { rail, pane } = await openItem(page, 2)
	const slot = '.agent-dock-queue > li[data-open="true"]'
	await expect(rail.locator(`${slot} .agent-dock-entry`)).toHaveAttribute('aria-label', /Permission,/)
	const paneBox = await box(page, '.agent-dock-pane')
	const entry = await box(page, slot)
	// Shared edge: the entry starts exactly where the pane ends, inside the pane's width.
	expect(Math.abs(entry.y - (paneBox.y + paneBox.height))).toBeLessThan(0.5)
	expect(entry.x).toBeGreaterThanOrEqual(paneBox.x - 0.5)
	expect(entry.x + entry.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 0.5)
	// The pane has no bottom rule and the entry no top rule there; both share the pane's surface.
	const paneSurface = await surface(page, '.agent-dock-pane')
	const entrySurface = await surface(page, slot)
	expect(OPEN_EDGE).toContain(paneSurface.bottom)
	expect(OPEN_EDGE).toContain(entrySurface.top)
	expect(entrySurface.background).toBe(paneSurface.background)
	// Every other entry keeps the queue's edge toward the pane, on the queue's own surface.
	const closed = await surface(page, '.agent-dock-queue > li[data-open="false"]')
	expect(OPEN_EDGE).not.toContain(closed.top)
	expect(closed.background).not.toBe(paneSurface.background)
	// No footer rule between the pane's body and the entry.
	const foot = await pane.locator('.agent-dock-foot').evaluate(node => getComputedStyle(node).borderTopWidth)
	expect(foot).toBe('0px')
})

test('in two rows a far-row entry joins its pane through its column', async ({ page }) => {
	await page.setViewportSize({ width: 900, height: 700 })
	await openHarness(page)
	await emitScenario(page, 'crowded')
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('.agent-dock-queue')).toHaveAttribute('data-density', 'compact')
	await rail.locator('.agent-dock-entry[data-kind="turn"]').first().click()
	await expect(page.locator('.agent-dock-pane')).toBeVisible()
	const open = await box(page, '.agent-dock-queue > li[data-open="true"]')
	const between = await box(page, '.agent-dock-queue > li[data-link="between"]')
	const paneBox = await box(page, '.agent-dock-pane')
	// The cell above the open entry is the tab's upper half: same column, touching the pane.
	expect(Math.abs(between.x - open.x)).toBeLessThan(0.5)
	expect(Math.abs(between.y - (paneBox.y + paneBox.height))).toBeLessThan(0.5)
	expect(OPEN_EDGE).toContain((await surface(page, '.agent-dock-queue > li[data-link="between"]')).top)
	expect((await surface(page, '.agent-dock-queue > li[data-link="between"]')).background).toBe(
		(await surface(page, '.agent-dock-pane')).background,
	)
})

test('an answered entry keeps its slot while the pane is open; the receipt shows in place', async ({ page }) => {
	const { rail, pane } = await openItem(page, 1)
	const question = rail.locator('.agent-dock-entry[aria-label*=" Question,"]')
	const itemId = await question.getAttribute('data-item-id')
	const indexOf = () =>
		rail
			.locator('.agent-dock-entry')
			.evaluateAll((nodes, id) => nodes.findIndex(node => node.getAttribute('data-item-id') === id), itemId)
	expect(await indexOf()).toBe(0)
	const before = await question.boundingBox()
	await pane.getByRole('button', { name: /Blue/ }).click()
	await pane.getByRole('button', { name: /^1/ }).click()
	await pane.getByRole('button', { name: 'Submit answers' }).click()
	await expect(question).toContainText('✓ answered')
	// The snapshot now lists it after the open items; the queue keeps it where it was.
	expect(await indexOf()).toBe(0)
	expect(await question.boundingBox()).toEqual(before)
	await expect(pane).toContainText('1/3')
	await expect(pane.locator('.agent-dock-receipt')).toContainText('✓ answered')
	// Closing the pane lets the order follow the snapshot again: the answer lingers last.
	await question.click()
	await expect(pane).toHaveCount(0)
	await expect.poll(indexOf).toBe(2)
})

test('the pane never floats over terminal rows: in-flow, one refit on open and one on close', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'crowded')
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(5)
	await expect.poll(() => xtermRows(page)).toBeGreaterThan(0)
	const rowsBefore = await xtermRows(page)
	const termsBefore = await box(page, '#terms')
	// Count terminal row-height changes while the pane opens, steps through every item and closes.
	await page.evaluate(() => {
		const terms = document.querySelector('#terms') as HTMLElement
		const heights: number[] = []
		new ResizeObserver(() => heights.push(terms.getBoundingClientRect().height)).observe(terms)
		;(window as Window & { __termHeights?: number[] }).__termHeights = heights
	})
	const heights = () => page.evaluate(() => (window as Window & { __termHeights?: number[] }).__termHeights ?? [])
	await rail.locator('.agent-dock-entry').first().click()
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toBeVisible()
	await expectPaneBesideTerminal(page)
	await expect.poll(() => xtermRows(page)).toBeLessThan(rowsBefore)
	const rowsOpen = await xtermRows(page)
	// Nothing in the dock is positioned over the terminal.
	const overlays = await page.evaluate(() => {
		const terms = (document.querySelector('#terms') as HTMLElement).getBoundingClientRect()
		return [...document.querySelectorAll('#agent-dock *')].filter(node => {
			const style = getComputedStyle(node)
			if (style.position !== 'absolute' && style.position !== 'fixed') return false
			if (style.visibility === 'hidden') return false
			const rect = node.getBoundingClientRect()
			return rect.width > 0 && rect.height > 0 && rect.bottom > terms.top + 0.5 && rect.top < terms.bottom - 0.5
		}).length
	})
	expect(overlays).toBe(0)
	for (let at = 1; at < 5; at++) await pane.getByRole('button', { name: 'Next item' }).click()
	await expect(pane).toContainText('5/5')
	await pane.getByRole('button', { name: 'Previous item' }).click()
	expect(await xtermRows(page)).toBe(rowsOpen)
	await pane.getByRole('button', { name: 'Close details' }).click()
	await expect(pane).toHaveCount(0)
	await expect.poll(() => xtermRows(page)).toBe(rowsBefore)
	expect((await box(page, '#terms')).height).toBe(termsBefore.height)
	// The observer's first report, then exactly two changes: the split, then back.
	const seen = await heights()
	expect(seen).toHaveLength(3)
	expect(seen[0]).toBe(termsBefore.height)
	expect(seen[1]).toBeLessThan(termsBefore.height)
	expect(seen[2]).toBe(termsBefore.height)
})

test('the footer note wraps: the risky-word question reads whole at a 1100px window', async ({ page }) => {
	await page.setViewportSize({ width: 1100, height: 800 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await page.locator('.agent-dock-toggle').click()
	await page.locator('.agent-dock-entry[data-kind="turn"]').click()
	const pane = page.locator('.agent-dock-pane')
	await pane.getByRole('textbox', { name: 'Reply' }).fill('please deploy it')
	await pane.getByRole('button', { name: 'Send', exact: true }).click()
	const alert = pane.getByRole('alert')
	await expect(alert).toContainText('This reply mentions “deploy”. Send it to the agent anyway?')
	const note = pane.locator('.agent-dock-foot-note')
	expect(
		await note.evaluate(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight),
	).toBe(true)
	await expect(pane.getByRole('button', { name: 'Send anyway' })).toBeVisible()
	expect(await acts(page)).toEqual([])
})
