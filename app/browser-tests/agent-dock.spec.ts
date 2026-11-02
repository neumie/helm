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

async function emitScenario(
	page: Page,
	name: 'busy' | 'crowded' | 'empty' | 'down' | 'orphaned' | 'real-case' | 'overflow',
): Promise<void> {
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

/** The active terminal holder's scroll offset (it is overflow-hidden: anything but 0 clips the top row). */
const holderScroll = (page: Page) =>
	page.locator('.term-holder.active').evaluate(node => (node as HTMLElement).scrollTop)

/** Whether the footer key hints are painted. */
const hintsShown = (page: Page) =>
	page.locator('.agent-dock-pane .agent-dock-foot-hints').evaluate(node => getComputedStyle(node).visibility)

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
	await rail.locator('.agent-dock-entry[aria-label^="Question,"]').click()
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
	expect(openTerms.height).toBeLessThan(collapsedTerms.height - 40)
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
	await rail.locator('.agent-dock-entry[aria-label^="Question,"]').click()
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toBeVisible()
	await expect(input).toBeFocused()
	await expect(pane).toContainText('1/3')
	// The header carries no id or clock; the exact time is its tooltip.
	await expect(pane.locator('.agent-dock-title-text')).toHaveAttribute('title', /asked \d\d:\d\d/)
	await expect(pane.locator('.agent-dock-title')).not.toContainText(/#\d|asked/)
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
	await expect(pane.locator('.agent-dock-title-text')).toHaveAttribute('title', /finished \d\d:\d\d/)
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

test('at a 1100px window the queue is one row: names and waits whole, the rest behind "+N more"', async ({ page }) => {
	await page.setViewportSize({ width: 1100, height: 800 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(3)
	await expect(rail.locator('.agent-dock-more')).toHaveCount(0)
	const wholeNames = async () => {
		for (const name of await rail.locator('.agent-dock-entry-name').all())
			expect(await name.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
	}
	await wholeNames()
	await expect(rail.locator('.agent-dock-agents-entry')).toBeVisible()

	// Eight items: one row only — what fits shows, then one quiet "+N more" cell; nothing scrolls.
	await emitScenario(page, 'overflow')
	const shown = await rail.locator('.agent-dock-entry').count()
	expect(shown).toBeGreaterThan(0)
	expect(shown).toBeLessThan(8)
	await expect(rail.locator('.agent-dock-more')).toHaveText(`+${8 - shown} more`)
	await wholeNames()
	// Nothing busy: the Agents entry says only `agents 8`.
	await expect(rail.locator('.agent-dock-agents-entry')).toHaveText('agents 8')
	const railBox = await box(page, '.agent-dock-rail')
	for (const entry of await rail.locator('.agent-dock-entry, .agent-dock-more').all()) {
		const entryBox = await entry.boundingBox()
		if (!entryBox) throw new Error('entry not laid out')
		// One row: every cell inside the rail's single band.
		expect(entryBox.y).toBeGreaterThanOrEqual(railBox.y)
		expect(entryBox.y + entryBox.height).toBeLessThanOrEqual(railBox.y + railBox.height + 0.5)
		expect(entryBox.x + entryBox.width).toBeLessThanOrEqual(railBox.x + railBox.width + 0.5)
	}
	for (const age of await rail.locator('.agent-dock-entry-age').all()) {
		await expect(age).toBeVisible()
		expect(
			await age.evaluate(node => {
				const line = (node.parentElement as HTMLElement).getBoundingClientRect()
				const rect = node.getBoundingClientRect()
				return rect.right <= line.right + 0.5
			}),
		).toBe(true)
	}
	expect(await rail.locator('.agent-dock-queue').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
})

test('a wait is toned once, on its entry: the glyph keeps its kind color, the header age and the open strip stay quiet', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const strip = page.locator('.agent-dock-strip')
	await expect(strip).toContainText('oldest 2h')
	await page.locator('.agent-dock-toggle').click()
	// Open, the queue shows every wait: the strip drops "oldest" (its accessible name keeps it).
	await expect(strip).not.toContainText('oldest')
	await expect(page.locator('.agent-dock-toggle')).toHaveAttribute('aria-label', /oldest 2h/)
	const first = page.locator('.agent-dock-entry').first()
	await expect(first.locator('.agent-dock-entry-age')).toHaveAttribute('data-tone', 'danger')
	// Past 2h the age is red; the glyph still says "ask" in amber, never red beside it.
	await expect(first.locator('.agent-dock-glyph')).toHaveAttribute('data-tone', 'ask')
	const colors = await page.evaluate(() => {
		const root = getComputedStyle(document.querySelector('.agent-dock') as Element)
		const probe = (value: string) => {
			const node = document.createElement('span')
			node.style.color = value
			document.body.append(node)
			const color = getComputedStyle(node).color
			node.remove()
			return color
		}
		return {
			glyph: getComputedStyle(document.querySelector('.agent-dock-entry .agent-dock-glyph') as Element).color,
			warn: probe(root.getPropertyValue('--warn')),
		}
	})
	expect(colors.glyph).toBe(colors.warn)
	await first.click()
	const age = page.locator('.agent-dock-pane .agent-dock-title-age')
	await expect(age).toHaveText(/^waiting 2h/)
	await expect(age).not.toHaveAttribute('data-tone', /.+/)
})

test('"+N more" opens the next item past the row, which takes the last slot; ‹ › reach every item', async ({
	page,
}) => {
	await page.setViewportSize({ width: 900, height: 700 })
	await openHarness(page)
	await emitScenario(page, 'overflow')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.locator('.agent-dock-toggle').click()
	const rail = page.locator('.agent-dock-rail')
	const more = rail.locator('.agent-dock-more')
	await expect(more).toBeVisible()
	const shown = await rail.locator('.agent-dock-entry').count()
	await more.click()
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toContainText(`${shown + 1}/8`)
	await expectPaneBesideTerminal(page)
	await expect(input).toBeFocused()
	// The open item is never hidden behind "+N more": it takes the row's last slot, with the selected fill.
	const openEntry = rail.locator('.agent-dock-entry[data-open="true"]')
	const lastIsOpen = async () => {
		await expect(openEntry).toHaveCount(1)
		await expect(rail.locator('.agent-dock-entry').last()).toHaveAttribute('data-open', 'true')
		await expect(more).toHaveAttribute('data-open', 'false')
		expect(await rail.locator('.agent-dock-entry').count()).toBeLessThanOrEqual(shown)
	}
	await lastIsOpen()
	for (let at = shown + 1; at < 8; at++) {
		await pane.getByRole('button', { name: 'Next item' }).click()
		await lastIsOpen()
	}
	await expect(pane).toContainText('8/8')
	// Stepping back into the row: the queue's own order again, the selection on that entry.
	for (let at = 8; at > shown; at--) await pane.getByRole('button', { name: 'Previous item' }).click()
	await expect(pane).toContainText(`${shown}/8`)
	await expect(openEntry).toHaveCount(1)
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(shown)
	await expect(more).toHaveText(`+${8 - shown} more`)
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
	const entry = rail.locator('.agent-dock-entry[aria-label^="Question,"]')
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
	await expect(pane.getByRole('radio', { name: /Blue/ })).toHaveAttribute('aria-checked', 'true')
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
	// Handing focus back never scrolls the terminal holder (no clipped top row over a blank band).
	expect(await holderScroll(page)).toBe(0)
	expect(await terminalWrites(page)).toBe(0)
	await expect(pane.locator('.agent-dock-title-age')).toHaveText(/^answered \d\d:\d\d$/)
	// Resolved: the receipt is the footer; no decision button and no key hints that would do nothing.
	await expect(pane.getByRole('button', { name: 'Submit answers' })).toHaveCount(0)
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText('esc close')
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
	const itemId = Number(await rail.locator('.agent-dock-entry[aria-label^="Question,"]').getAttribute('data-item-id'))
	await pane.getByRole('radio', { name: /Other…/ }).click()
	const other = pane.getByRole('textbox', { name: 'Your answer to question 1' })
	await expect(other).toBeFocused()
	await other.pressSequentially('Zelená 2')
	await expect(other).toHaveValue('Zelená 2')
	await pane.getByRole('tab', { name: /Size/ }).click()
	await pane.getByRole('radio', { name: /^2/ }).click()
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
	const entry = rail.locator('.agent-dock-entry[aria-label^="Permission,"]')
	const itemId = Number(await entry.getAttribute('data-item-id'))
	// No single click allows anything: the footer button stays disabled (and says only "Send") until a choice is picked.
	await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
	await pane.getByRole('radio', { name: /Deny and tell the agent/ }).click()
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
	if (!(await pane.isVisible())) await rail.locator('.agent-dock-entry[aria-label^="Permission,"]').click()
	await expect(pane).toContainText('2/3')
	await expect(pane).toContainText('(this session)')
	await pane.getByRole('radio', { name: /Always allow Bash\(npm run deploy:stage\)/ }).click()
	await pane.getByRole('button', { name: 'Always allow', exact: true }).click()
	const allowed = rail.locator('.agent-dock-entry[aria-label^="Permission,"]')
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
	const entry = rail.locator('.agent-dock-entry[aria-label^="Question,"]')
	await pane.getByRole('radio', { name: /Red/ }).click()
	await pane.getByRole('tab', { name: /Size/ }).click()
	await pane.getByRole('radio', { name: /^1/ }).click()
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

/** A color token as the page computes it. */
const tokenColor = (page: Page, token: string) =>
	page.evaluate(name => {
		const probe = document.createElement('span')
		probe.style.color = `var(${name})`
		document.querySelector('.agent-dock-host')?.append(probe)
		const color = getComputedStyle(probe).color
		probe.remove()
		return color
	}, token)

const background = (page: Page, selector: string) =>
	page
		.locator(selector)
		.first()
		.evaluate(node => getComputedStyle(node).backgroundColor)

test('the dock is one --chrome surface, its edge the topbar border mirrored; no rule in the pane header', async ({
	page,
}) => {
	const { pane } = await openItem(page, 2)
	const dock = page.locator('#agent-dock')
	// Same surface and line as the topbar: the dock is the topbar, mirrored.
	expect(await background(page, '#agent-dock')).toBe(await background(page, '#topbar'))
	const topbarEdge = await page.locator('#topbar').evaluate(node => getComputedStyle(node).borderBottomColor)
	const edge = await dock.evaluate(node => {
		const style = getComputedStyle(node, '::before')
		return { color: style.backgroundColor, height: style.height }
	})
	expect(edge).toEqual({ color: topbarEdge, height: '1px' })
	// The pane, the queue and the strip sit on that one surface (no fills of their own).
	for (const part of ['.agent-dock-pane', '.agent-dock-rail', '.agent-dock-strip'])
		expect(await background(page, part)).toBe('rgba(0, 0, 0, 0)')
	// The header is a plain row: no box-drawing text, no drawn rule.
	const header = pane.locator('.agent-dock-title')
	await expect(header).not.toContainText(/[─━]/)
	expect(await header.evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('0px')
	// One hairline between the pane and the queue; the open entry is a selected fill, joined to nothing.
	expect(await pane.evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('1px')
	const open = page.locator('.agent-dock-entry[data-open="true"]')
	await expect(open).toHaveAttribute('aria-label', /^Permission,/)
	const raised = await tokenColor(page, '--fill-raised')
	await expect.poll(() => open.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(raised)
	// No bold anywhere in the dock.
	const bold = await page.evaluate(
		() =>
			[...document.querySelectorAll('#agent-dock *')].filter(
				node => Number(getComputedStyle(node).fontWeight) >= 600 && (node.textContent ?? '').trim() !== '',
			).length,
	)
	expect(bold).toBe(0)
})

test('an answered entry keeps its slot while the pane is open; the receipt shows in place', async ({ page }) => {
	const { rail, pane } = await openItem(page, 1)
	const question = rail.locator('.agent-dock-entry[aria-label^="Question,"]')
	const itemId = await question.getAttribute('data-item-id')
	const indexOf = () =>
		rail
			.locator('.agent-dock-entry')
			.evaluateAll((nodes, id) => nodes.findIndex(node => node.getAttribute('data-item-id') === id), itemId)
	expect(await indexOf()).toBe(0)
	const before = await question.boundingBox()
	await pane.getByRole('radio', { name: /Blue/ }).click()
	await pane.getByRole('radio', { name: /^1/ }).click()
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
			// Screen-reader-only text is clipped to nothing; it paints no pixel over the terminal.
			if (node.classList.contains('sr-only')) return false
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

/** Busy scenario, queue open by ⌘⇧J, the pane opened from the keyboard on item `index` (it has focus). */
async function openByKeyboard(page: Page, index: 1 | 2 | 3) {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	const rail = page.locator('.agent-dock-rail')
	await expect(rail.locator('[data-rail-stop]').first()).toBeFocused()
	for (let at = 1; at < index; at++) await page.keyboard.press('ArrowRight')
	await page.keyboard.press('Enter')
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toBeFocused()
	await expect(pane).toContainText(`${index}/3`)
	return { input, rail, pane }
}

test('handing focus back to the terminal never scrolls its holder', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 900 })
	await openHarness(page)
	await emitScenario(page, 'crowded')
	await page.evaluate(() => {
		const fixture = window.__helmWorkspaceFixture
		if (!fixture) throw new Error('Missing fixture')
		fixture.emitData('shell', Array.from({ length: 60 }, (_, at) => `line ${at + 1}`).join('\r\n'))
	})
	await page.locator('.term-holder.active .xterm-screen').click({ position: { x: 40, y: 40 } })
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await expect(input).toBeFocused()
	expect(await holderScroll(page)).toBe(0)
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(page.locator('.agent-dock-rail [data-rail-stop]').first()).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(input).toBeFocused()
	expect(await holderScroll(page)).toBe(0)
	// Through a pane and back again.
	await page.keyboard.press('Meta+Shift+KeyJ')
	await page.keyboard.press('Enter')
	await expect(page.locator('.agent-dock-pane')).toBeFocused()
	await page.keyboard.press('Escape')
	await page.keyboard.press('Escape')
	await expect(input).toBeFocused()
	expect(await holderScroll(page)).toBe(0)
})

test('footer key hints show only while the pane holds focus (pointer use leaves keys with the terminal)', async ({
	page,
}) => {
	const { input, pane } = await openItem(page, 1)
	await expect(input).toBeFocused()
	expect(await hintsShown(page)).toBe('hidden')
	// Esc here belongs to the terminal: the pane stays.
	await page.keyboard.press('Escape')
	await expect(pane).toBeVisible()
	await pane.focus()
	expect(await hintsShown(page)).toBe('visible')
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText(/^1–3 pick\s*⌘↵ submit\s*esc close$/)
	// Screen readers get the keys from aria-keyshortcuts, not the hint text.
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveAttribute('aria-hidden', 'true')
	await expect(pane.getByRole('button', { name: 'Submit answers' })).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter')
})

test('a stray typed key drops the pick, so a following Enter sends nothing', async ({ page }) => {
	const { pane } = await openByKeyboard(page, 2)
	await page.keyboard.press('2')
	await expect(pane.getByRole('radio', { name: /^2 Always allow/ })).toHaveAttribute('aria-checked', 'true')
	await page.keyboard.type('tail -n 1 log')
	await expect(pane.getByRole('radio', { checked: true })).toHaveCount(0)
	await page.keyboard.press('Enter')
	expect(await acts(page)).toEqual([])
	await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
	// Nothing armed: no note (the disabled Send and the `1–3 pick` hint say it).
	await expect(pane.locator('.agent-dock-foot-note')).toHaveText('')

	// A question: the picks stay, but Enter is disarmed until the next pick.
	await page.keyboard.press('ArrowLeft')
	await expect(pane).toContainText('1/3')
	await page.keyboard.press('2')
	await page.keyboard.press('1')
	await expect(pane).toContainText('Ready to submit')
	await page.keyboard.press('x')
	await expect(pane.locator('.agent-dock-foot-note')).toHaveText('')
	await page.keyboard.press('Enter')
	expect(await acts(page)).toEqual([])
	await page.keyboard.press('1')
	await page.keyboard.press('Enter')
	await expect.poll(async () => (await acts(page)).length).toBe(1)
})

test('the risky-word confirmation: repeating the send key never confirms, Esc cancels it and keeps the pane', async ({
	page,
}) => {
	const { pane } = await openItem(page, 3)
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await reply.click()
	await page.keyboard.type('please push it')
	await page.keyboard.press('Meta+Enter')
	await expect(pane.getByRole('alert')).toContainText('This reply mentions “push”')
	await expect(reply).toBeFocused()
	await page.keyboard.press('Meta+Enter')
	await page.keyboard.press('Meta+Enter')
	expect(await acts(page)).toEqual([])
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText('esc cancel')
	await page.keyboard.press('Escape')
	await expect(pane.getByRole('alert')).toHaveCount(0)
	await expect(pane).toBeVisible()
	await expect(reply).toHaveValue('please push it')
	// Only Send anyway sends.
	await page.keyboard.press('Meta+Enter')
	await pane.getByRole('button', { name: 'Send anyway' }).click()
	await expect.poll(async () => (await acts(page)).length).toBe(1)
	expect((await acts(page))[0]?.action).toEqual({ type: 'prompt', text: 'please push it', confirmed: true })
})

test('question picks and Other text survive stepping away and back', async ({ page }) => {
	const { pane } = await openByKeyboard(page, 1)
	await page.keyboard.press('1')
	await expect(pane.getByRole('tab', { name: /Size/ })).toHaveAttribute('aria-selected', 'true')
	await page.keyboard.press('3')
	const other = pane.getByRole('textbox', { name: 'Your answer to question 2' })
	await expect(other).toBeFocused()
	await other.fill('careful answer')
	await pane.getByRole('button', { name: 'Next item' }).click()
	await expect(pane).toContainText('2/3')
	await pane.getByRole('button', { name: 'Previous item' }).click()
	await expect(pane).toContainText('1/3')
	await expect(pane.getByRole('textbox', { name: 'Your answer to question 2' })).toHaveValue('careful answer')
	await expect(pane.getByRole('tab', { name: 'Color, answered' })).toBeVisible()
	await expect(pane.getByRole('tab', { name: 'Size, answered' })).toBeVisible()
})

test('choices: one tab stop, arrows move focus only; Enter on a choice picks and focus follows to the next question', async ({
	page,
}) => {
	const { pane } = await openByKeyboard(page, 1)
	const group = pane.getByRole('radiogroup', { name: 'Barva?' })
	await expect(group).toBeVisible()
	await expect(group.locator('[tabindex="0"]')).toHaveCount(1)
	await group.getByRole('radio', { name: /Red/ }).focus()
	await page.keyboard.press('ArrowDown')
	await expect(group.getByRole('radio', { name: /Blue/ })).toBeFocused()
	await expect(group.getByRole('radio', { checked: true })).toHaveCount(0)
	await page.keyboard.press('End')
	await expect(group.getByRole('radio', { name: /Other…/ })).toBeFocused()
	await page.keyboard.press('Home')
	await expect(group.getByRole('radio', { name: /Red/ })).toBeFocused()
	// Arrows never step items from a choice.
	await expect(pane).toContainText('1/3')
	await page.keyboard.press('Enter')
	// Picked, moved on: focus is on the new question's list, never on an option it has not shown.
	await expect(pane.getByRole('tab', { name: /Size/ })).toHaveAttribute('aria-selected', 'true')
	const sizes = pane.getByRole('radiogroup', { name: 'Velikost?' })
	await expect(sizes.getByRole('radio').first()).toBeFocused()
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('Space')
	await expect(sizes.getByRole('radio', { name: /^2/ })).toHaveAttribute('aria-checked', 'true')
	// ⌘Enter submits from a choice.
	await page.keyboard.press('Meta+Enter')
	await expect.poll(async () => (await acts(page)).length).toBe(1)
	expect((await acts(page))[0]?.action).toEqual({ type: 'answer', picks: [{ options: [0] }, { options: [1] }] })
})

test('deny: the field is one line, keeps the command in view, and its hint is the key that sends', async ({ page }) => {
	const { pane } = await openByKeyboard(page, 2)
	await page.keyboard.press('3')
	const message = pane.getByRole('textbox', { name: 'Message to the agent (optional)' })
	await expect(message).toBeFocused()
	await expect(pane.locator('.agent-dock-command')).toBeInViewport({ ratio: 1 })
	expect(await pane.locator('.agent-dock-pane-scroll').evaluate(node => node.scrollTop)).toBe(0)
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText(/^⌘↵ deny\s*esc close$/)
	await page.keyboard.type('stop here')
	await page.keyboard.press('Enter')
	expect(await acts(page)).toEqual([])
	await page.keyboard.press('Meta+Enter')
	await expect.poll(async () => (await acts(page)).length).toBe(1)
	expect((await acts(page))[0]?.action).toEqual({ type: 'deny', message: 'stop here' })
})

test('sending from a field keeps focus in the pane, so Esc and a retry still reach it', async ({ page }) => {
	const { pane } = await openByKeyboard(page, 2)
	await setActMode(page, 'error')
	await page.keyboard.press('3')
	const message = pane.getByRole('textbox', { name: 'Message to the agent (optional)' })
	await expect(message).toBeFocused()
	await page.keyboard.type('stop here')
	await page.keyboard.press('Meta+Enter')
	await expect(pane.locator('.agent-dock-receipt')).toContainText('failed (500): bridge unavailable')
	// The field was disabled while sending: focus moved to the pane instead of dropping to <body>.
	await expect(pane).toBeFocused()
	await setActMode(page, 'confirm')
	await page.keyboard.press('Meta+Enter')
	await expect.poll(async () => (await acts(page)).length).toBe(2)
	expect((await acts(page))[1]?.action).toEqual({ type: 'deny', message: 'stop here' })
})

test('typing at a keyboard-opened turn pane starts the reply', async ({ page }) => {
	const { pane } = await openByKeyboard(page, 3)
	await page.keyboard.type('Ok 2')
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await expect(reply).toBeFocused()
	await expect(reply).toHaveValue('Ok 2')
	expect(await terminalWrites(page)).toBe(0)
})

test('accessible names: strip, entries and pane say what they are; new asks are announced politely', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	const live = page.locator('#agent-dock .agent-dock-host > .sr-only[aria-live="polite"]')
	await expect(live).toHaveText('')
	// The first reachable snapshot is the baseline; what arrives after it is announced, a burst as one line.
	await emitScenario(page, 'busy')
	await expect(live).toHaveText('3 new requests', { timeout: 5_000 })
	const toggle = page.locator('.agent-dock-toggle')
	await expect(toggle).toHaveAttribute('aria-label', /^Agent dock, 3 need you, oldest 2h\d+m, Okena$/)
	await expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+J')
	await toggle.click()
	const question = page.locator('.agent-dock-entry[aria-label^="Question,"]')
	await expect(question).toHaveAttribute('aria-label', /^Question, \S+ in \S+, waiting \d/)
	await expect(question).toHaveAccessibleDescription(/Barva\?/)
	await expect(page.locator('.agent-dock-entry[data-kind="turn"]')).toHaveAttribute('aria-label', /, idle \d/)
	await question.click()
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toHaveAttribute('aria-label', /^Question, \S+, \S+$/)
	await expect(pane.getByRole('region', { name: 'Question' })).toBeVisible()
})

test('Enter on the open entry goes to its pane; a click on it closes; ⌘⇧J with a pane open focuses the pane', async ({
	page,
}) => {
	const { input, rail, pane } = await openItem(page, 1)
	await expect(input).toBeFocused()
	const entry = rail.locator('.agent-dock-entry[data-open="true"]')
	await entry.focus()
	await page.keyboard.press('Enter')
	await expect(pane).toBeFocused()
	// The pane took the keys: a digit picks (and moves on to the next question).
	await page.keyboard.press('2')
	await expect(pane.getByRole('tab', { name: 'Color, answered' })).toHaveCount(1)
	// From the terminal, ⌘⇧J lands in the open pane, not on its entry.
	await input.focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(pane).toBeFocused()
	await entry.click()
	await expect(pane).toHaveCount(0)
})

test('the active pane: focus turns the dock edge accent at 1px, never a ring box', async ({ page }) => {
	const { pane } = await openItem(page, 2)
	const accent = await tokenColor(page, '--accent')
	const edge = () => page.locator('#agent-dock').evaluate(node => getComputedStyle(node, '::before').backgroundColor)
	// Pointer-opened: the keys stay with the terminal, so the edge is the quiet hairline.
	await expect.poll(edge).not.toBe(accent)
	await pane.focus()
	await expect.poll(edge).toBe(accent)
	expect(await pane.evaluate(node => getComputedStyle(node).boxShadow)).toBe('none')
	expect(await page.locator('#agent-dock').evaluate(node => getComputedStyle(node, '::before').height)).toBe('1px')
})

test("entries sit on the strip's 16px text column and are separated by space, not rules", async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'crowded')
	await page.locator('.agent-dock-toggle').click()
	const dock = await box(page, '#agent-dock')
	const glyph = await box(page, '.agent-dock-queue .agent-dock-glyph')
	const chevron = await box(page, '.agent-dock-chevron')
	expect(Math.abs(glyph.x - dock.x - 16)).toBeLessThan(0.5)
	expect(Math.abs(chevron.x - glyph.x)).toBeLessThan(0.5)
	for (const slot of await page.locator('.agent-dock-queue > li').all())
		expect(
			await slot.evaluate(node => {
				const style = getComputedStyle(node)
				return [
					style.borderLeftWidth,
					style.borderRightWidth,
					getComputedStyle(node.firstElementChild as Element).borderRightWidth,
				]
			}),
		).toEqual(['0px', '0px', '0px'])
	// One hairline at most: before the Agents entry.
	const separator = await page.locator('.agent-dock-agents').evaluate(node => ({
		width: getComputedStyle(node, '::before').width,
		content: getComputedStyle(node, '::before').content,
	}))
	expect(separator.width).toBe('1px')
})

test('decisions: unarmed buttons are quiet keys, the note names the act, unanswerable items offer Ack only', async ({
	page,
}) => {
	const { pane } = await openByKeyboard(page, 2)
	const send = pane.getByRole('button', { name: 'Send', exact: true })
	await expect(send).toBeDisabled()
	expect(await send.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
	await page.keyboard.press('3')
	await expect(pane.locator('.agent-dock-foot-note')).toHaveText('Ready to deny')
	const deny = pane.getByRole('button', { name: 'Deny', exact: true })
	await expect(deny).toBeEnabled()
	expect(await deny.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
	// The body fits: it is no dead tab stop.
	await expect(pane.locator('.agent-dock-pane-scroll')).toHaveAttribute('tabindex', '-1')

	await emitScenario(page, 'orphaned')
	await page.locator('.agent-dock-entry[data-tone="orphaned"]').click()
	const foot = page.locator('.agent-dock-pane .agent-dock-foot-actions')
	await expect(foot.getByRole('button')).toHaveCount(1)
	await expect(foot.getByRole('button')).toHaveText('Ack')
})

test('the receipt says what was sent and the sent picks stay shown; a failure keeps them armed', async ({ page }) => {
	const { pane } = await openByKeyboard(page, 1)
	await setActMode(page, 'error')
	await page.keyboard.press('2')
	await page.keyboard.press('2')
	await page.keyboard.press('Enter')
	await expect(pane.locator('.agent-dock-receipt')).toContainText('failed (500)')
	await expect(pane.locator('.agent-dock-receipt')).not.toContainText('·')
	const submit = pane.getByRole('button', { name: 'Submit answers' })
	await expect(submit).toBeEnabled()
	await setActMode(page, 'confirm')
	await submit.click()
	await expect(pane.locator('.agent-dock-receipt')).toHaveText('✓ answered · Blue, M')
	// The answered pane still shows the sent picks, after stepping away and back too.
	await pane.getByRole('button', { name: 'Next item' }).click()
	await pane.getByRole('button', { name: 'Previous item' }).click()
	await expect(pane.locator('.agent-dock-receipt')).toHaveText('✓ answered · Blue, M')
	await expect(pane.getByRole('radio', { checked: true })).toHaveAccessibleName(/Blue|M/)
})

test('one short name everywhere: the branch without its type, numbered twins, the task title only as context', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 900 })
	await openHarness(page)
	await emitScenario(page, 'real-case')
	const strip = page.locator('.agent-dock-strip')
	// The strip names no item: the count, the oldest wait, Okena's dot, the shortcut.
	await expect(strip).toContainText('3 need you')
	await expect(strip).not.toContainText('company-create')
	await page.locator('.agent-dock-toggle').click()
	const names = page.locator('.agent-dock-entry-name')
	// Past 28 cells a name is cut in the middle in the queue; its label and tooltip keep it whole.
	await expect(names).toHaveText([
		'company-create-save-firm',
		'company-create-save-firm #2',
		/^repeated-android.*….*n$/,
	])
	await expect(page.locator('.agent-dock-entry[data-kind="turn"]')).toHaveAttribute(
		'aria-label',
		/^Turn ended, repeated-android-camera-permission in crm-mobile, idle /,
	)
	// No gist and no task title in the queue; two quiet lines per entry.
	const rail = page.locator('.agent-dock-rail')
	await expect(rail).not.toContainText('ClientCare')
	await expect(page.locator('.agent-dock-entry-meta').first()).toHaveText(/^question\s*·\s*\d/)
	await expect(page.locator('.agent-dock-agents-entry')).toHaveText(/agents 4\s*2 busy/)
	await expect(page.locator('.agent-dock-entry').first()).toHaveAttribute('title', /ClientCare #4182/)
	await expect(page.locator('.agent-dock-entry').nth(1)).toHaveAttribute(
		'aria-label',
		/^Permission, company-create-save-firm #2 in crm, waiting 12m$/,
	)
	await page.locator('.agent-dock-entry[data-kind="turn"]').click()
	const pane = page.locator('.agent-dock-pane')
	await expect(pane.locator('.agent-dock-title-name')).toHaveText('repeated-android-camera-permission')
	await expect(pane.locator('.agent-dock-context')).toContainText('(ClientCare #4153)')
	await expect(pane).toHaveAttribute('aria-label', 'Turn ended, repeated-android-camera-permission, crm-mobile')
	await page.locator('.agent-dock-agents-entry').click()
	// Busy first, then waiting; every agent by its short name.
	await expect(pane.locator('.agent-dock-td-name')).toHaveText([
		'isdoc-export',
		'repeated-android-camera-permission',
		'company-create-save-firm #2',
		'company-create-save-firm',
	])
})
