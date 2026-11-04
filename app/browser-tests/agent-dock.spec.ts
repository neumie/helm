import { type Page, expect, test } from '@playwright/test'
import { RECEIPT_LINGER_MS } from '../src/renderer/agent-dock/presentation'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
	}
}

const harness = '/iframe.html?id=views-terminal-workspace--agent-dock-harness&viewMode=story'
const PREFERENCES = ['helm.agentDock.position']

async function openHarness(page: Page): Promise<void> {
	// Every test runs in a fresh browser context: storage starts empty, the dock at its default position.
	await page.goto(harness)
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#agent-dock .agent-dock-row')).toBeVisible()
}

/** The queue row: always shown, the dock's state in words as its name. */
const row = (page: Page) => page.locator('#agent-dock .agent-dock-row')

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
	name:
		| 'busy'
		| 'crowded'
		| 'empty'
		| 'down'
		| 'orphaned'
		| 'real-case'
		| 'overflow'
		| 'helm-terminals'
		| 'helm-add-directories'
		| 'single-turn'
		| 'agents-overview'
		| 'background-shell',
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
	const rail = row(page)
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(3)
	await rail.locator('.agent-dock-entry[aria-label^="Question,"]').click()
	const pane = page.locator('.agent-dock-pane')
	for (let at = 1; at < index; at++) await pane.getByRole('button', { name: 'Next item' }).click()
	await expect(pane).toContainText(`${index}/3`)
	return { input, rail, pane }
}

test('dock sits below the terminals by default: one 28px queue row, whatever arrives', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'bottom')
	const terms = await box(page, '#terms')
	const dock = await box(page, '#agent-dock')
	const right = await box(page, '#right')
	expect(dock.y).toBeGreaterThanOrEqual(terms.y + terms.height - 0.5)
	expect(Math.round(dock.y + dock.height)).toBe(Math.round(right.y + right.height))
	const rail = row(page)
	expect((await rail.boundingBox())?.height).toBe(28)
	expect(dock.height).toBe(28)
	// No summary row of its own: the row is the dock, and its name says the state in words.
	await expect(rail).toContainText('Nothing needs you')
	const rowsBefore = await xtermRows(page)

	await emitScenario(page, 'busy')
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(3)
	await expect(rail).toHaveAttribute('aria-label', /3 need you, oldest 2h/)
	await expect(rail).not.toContainText('need you')
	await expect(rail.locator('.agent-dock-entry-age').first()).toHaveAttribute('data-tone', 'danger')
	expect((await rail.boundingBox())?.height).toBe(28)
	// New items never open a pane or resize the terminal.
	await expect(page.locator('.agent-dock-pane')).toHaveCount(0)
	expect((await box(page, '#terms')).height).toBe(terms.height)
	expect(await xtermRows(page)).toBe(rowsBefore)

	// Arriving while the row shows: still nothing in the terminal changes.
	await emitScenario(page, 'crowded')
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(5)
	expect((await box(page, '#terms')).height).toBe(terms.height)
	expect(await xtermRows(page)).toBe(rowsBefore)

	// Never "all clear" while Okena is down.
	await emitScenario(page, 'down')
	await expect(rail).toContainText('Okena unreachable')
	// No health dot in the row (it lives in the Agents pane header); the outage stays in the row's words.
	await expect(rail.locator('.agent-dock-dot')).toHaveCount(0)
	await expect(rail).toHaveAttribute('aria-label', /Okena unreachable since/)
	await expect(rail).not.toContainText('Nothing needs you')
	await expect(rail).toHaveAttribute('aria-label', /State unknown|need you/)
	expect((await rail.boundingBox())?.height).toBe(28)
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.visible)).toEqual([true])
})

test('entries open a pane split off the terminal; ‹ › and arrows step; pointer use keeps xterm focus', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	const rail = row(page)
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(3)
	const rowsBefore = await xtermRows(page)

	// Clicking an entry in the row opens its pane; the terminal keeps focus.
	await rail.locator('.agent-dock-entry[aria-label^="Question,"]').click()
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toBeVisible()
	await expect(input).toBeFocused()
	await expect(pane).toContainText('1/3')
	// The header says what (kind + question context) with ‹ 1/3 ›, then whose terminal as the where link
	// (`Okena ↗`, ⌘O); the id and the clock are its tooltip.
	await expect(pane.locator('.agent-dock-title-text')).toHaveAttribute('title', /asked \d\d:\d\d · waiting /)
	await expect(pane.locator('.agent-dock-title-text')).toHaveText(/^\?\s*Question\s*2 questions\s*Okena ↗\s*⌘O$/)
	await expect(pane.locator('.agent-dock-title')).not.toContainText(/#\d|asked|waiting/)
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

	// Keyboard: ← / → step inside a focused pane; ↑ / ↓ step too where the body has no choices (the turn),
	// while on a decision ↓ goes to its answers and ← → there keep stepping.
	await pane.focus()
	await page.keyboard.press('ArrowRight')
	await expect(pane).toContainText('3/3')
	await page.keyboard.press('ArrowUp')
	await expect(pane).toContainText('2/3')
	await page.keyboard.press('ArrowDown')
	await expect(pane.getByRole('radio', { name: /Allow once/ })).toBeFocused()
	await expect(pane).toContainText('2/3')
	await page.keyboard.press('ArrowRight')
	await expect(pane).toContainText('3/3')
	await expect(pane.getByRole('button', { name: 'Next item' })).toBeDisabled()

	// Ack on the unchecked turn runs the reducer ack and shows the next item. A pointer Ack with the keys
	// in the terminal leaves them there (the pane shows the entry now in that slot).
	await expect(pane).toContainText('can you confirm the secret is set in stage?')
	await expect(pane.locator('.agent-dock-title-text')).toHaveAttribute('title', /finished \d\d:\d\d/)
	const turnId = Number(await rail.locator('.agent-dock-entry[data-kind="turn"]').getAttribute('data-item-id'))
	await input.focus()
	await pane.getByRole('button', { name: `Ack item ${turnId}` }).click()
	await expect(rail.locator('.agent-dock-entry[data-kind="turn"]')).toHaveCount(0)
	await expect(pane).toContainText('2/2')
	await expect(input).toBeFocused()
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.acks)).toEqual([turnId])
	await expect(rail).toHaveAttribute('aria-label', /^Agent dock, 2 need you/)

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

	// A click in the terminal keeps an open pane and gives the terminal the keys; a click elsewhere closes it.
	await rail.locator('.agent-dock-agents-entry').click()
	await expect(pane).toContainText('Agents')
	await expect(input).toBeFocused()
	const rowsWithPane = await xtermRows(page)
	await page.locator('.term-holder.active .xterm-screen').click({ position: { x: 40, y: 40 } })
	await expect(input).toBeFocused()
	await expect(pane).toContainText('Agents')
	expect(await xtermRows(page)).toBe(rowsWithPane)
	await page.locator('#topbar-drag-space').click()
	await expect(pane).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.calls.writes.length)).toBe(0)
})

test('⌘⇧J goes to the dock: focuses an entry, Esc returns, pressed inside it closes the pane and returns', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	const rail = row(page)
	const firstEntry = rail.locator('[data-row-stop]').first()
	const terms = await box(page, '#terms')

	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(firstEntry).toBeFocused()
	// Going to the dock changes no layout (no PTY resize under a TUI being typed into).
	expect((await box(page, '#terms')).height).toBe(terms.height)
	// ←/→ rove across the entries and the Agents entry.
	await page.keyboard.press('End')
	await expect(rail.locator('.agent-dock-agents-entry')).toBeFocused()
	await page.keyboard.press('Home')
	await expect(firstEntry).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(input).toBeFocused()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(firstEntry).toBeFocused()
	// Pressed inside the dock with nothing open: back to the terminal.
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(input).toBeFocused()
	await page.keyboard.press('Meta+Shift+KeyJ')
	// Enter on an entry opens and focuses the pane.
	await page.keyboard.press('Enter')
	await expect(page.locator('.agent-dock-pane')).toBeFocused()
	// Pressed inside with a pane open: the pane closes and the keys go back to the terminal; the row stays.
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(page.locator('.agent-dock-pane')).toHaveCount(0)
	await expect(input).toBeFocused()
	await expect(rail).toBeVisible()
	await expect.poll(async () => (await box(page, '#terms')).height).toBe(terms.height)
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
	const rail = row(page)
	const pane = page.locator('.agent-dock-pane')
	await expect(rail.locator('[data-row-stop]').first()).toBeFocused()
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

test('at a 1100px window the queue is one row: names and waits whole, each fill ending at its wait, the rest behind "+N more"', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1100, height: 800 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const rail = row(page)
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(3)
	await expect(rail.locator('.agent-dock-more')).toHaveCount(0)
	const wholeNames = async () => {
		for (const name of await rail.locator('.agent-dock-entry-name').all())
			expect(await name.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
	}
	await wholeNames()
	await expect(rail.locator('.agent-dock-agents-entry')).toBeVisible()
	// Measured, not estimated: the selected fill ends right after the wait (its 16px padding, no gap).
	const tailRoom = () =>
		rail.locator('.agent-dock-entry').evaluateAll(nodes =>
			nodes.map(node => {
				const tail = node.querySelector('.agent-dock-entry-age, .agent-dock-entry-receipt') as Element
				return node.getBoundingClientRect().right - tail.getBoundingClientRect().right
			}),
		)
	for (const room of await tailRoom()) {
		expect(room).toBeGreaterThanOrEqual(15.5)
		expect(room).toBeLessThanOrEqual(18)
	}

	// Eight items: one row only — what fits shows, then one quiet "+N more" cell; nothing scrolls.
	await emitScenario(page, 'overflow')
	const shown = await rail.locator('.agent-dock-entry').count()
	expect(shown).toBeGreaterThan(0)
	expect(shown).toBeLessThan(8)
	await expect(rail.locator('.agent-dock-more')).toHaveText(`+${8 - shown} more`)
	await wholeNames()
	for (const room of await tailRoom()) expect(room).toBeLessThanOrEqual(18)
	// The Agents entry: the count, then one bar segment per agent.
	await expect(rail.locator('.agent-dock-agents-entry')).toHaveText('8 agents')
	await expect(rail.locator('.agent-dock-agents-seg')).toHaveCount(8)
	const railBox = await box(page, '.agent-dock-row')
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

test('a wait is toned once, on its entry: the glyph keeps its kind color, the pane header shows no age', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	// The oldest wait is in the row's name (no summary text): each entry shows its own.
	await expect(row(page)).toHaveAttribute('aria-label', /oldest 2h/)
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
	const header = page.locator('.agent-dock-pane .agent-dock-title-text')
	await expect(header).not.toContainText(/\d+[hm]/)
	await expect(header).toHaveAttribute('title', /waiting 2h/)
})

test('"+N more" opens the next item past the row, which takes the last slot; ‹ › reach every item', async ({
	page,
}) => {
	await page.setViewportSize({ width: 900, height: 700 })
	await openHarness(page)
	await emitScenario(page, 'overflow')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	const rail = row(page)
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

/** The write Settings → Appearance makes; the row itself carries no position control. */
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

test('the row has no position control; a settings change re-lays out the dock live', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	// Only the entries and the Agents entry are buttons in the row.
	await expect(row(page).locator('button')).toHaveCount(4)
	await expect(row(page).getByRole('button', { name: /top|bottom|position/i })).toHaveCount(0)
	const rowsBefore = await xtermRows(page)
	await choosePosition(page, 'top')
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
	await expect(row(page)).toBeVisible()
	// Same row height either way, so xterm refits to the same row count.
	expect(await xtermRows(page)).toBe(rowsBefore)
	await choosePosition(page, 'bottom')
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'bottom')
})

test('position persists; on top the queue row leads, then the pane above the terminal', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await choosePosition(page, 'top')
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
	let dock = await box(page, '#agent-dock')
	let terms = await box(page, '#terms')
	expect(dock.y + dock.height).toBeLessThanOrEqual(terms.y + 0.5)
	expect((await box(page, '.agent-dock-row')).y).toBe(dock.y)

	await page.locator('.agent-dock-entry').first().click()
	await expect(page.locator('.agent-dock-pane')).toBeVisible()
	const rail = await box(page, '.agent-dock-row')
	const pane = await box(page, '.agent-dock-pane')
	expect(pane.y).toBeGreaterThanOrEqual(rail.y + rail.height - 0.5)
	await expectPaneBesideTerminal(page, 'top')

	await page.reload()
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
	await expect(page.locator('.agent-dock-row')).toBeVisible()
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
	await expect(row(page)).toBeVisible()
	await choosePosition(page, 'top')
	await expect(page.locator('#right')).toHaveAttribute('data-agent-dock-position', 'top')
})

test('answering a question from the pane: 1-9 pick, Enter submits, Sending… then ✓ answered, the pane moves on', async ({
	page,
}) => {
	// A fake clock that keeps flowing, so the receipt's linger can be run past without sleeping.
	await page.clock.install()
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	const rail = row(page)
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
		{ itemId, action: { type: 'answer', picks: [{ options: [1] }, { options: [0] }] } },
	])
	await expect(rail).toHaveAttribute('aria-label', /^Agent dock, 2 need you/)
	// The answer went: the pane opened the next waiting item (the permission) with the keys in it.
	await expect(pane).toContainText('2/3')
	await expect(pane).toContainText('npm run deploy:stage')
	await expect(pane).toBeFocused()
	expect(await terminalWrites(page)).toBe(0)
	// Back on the answered question (← steps, as ever).
	await page.keyboard.press('ArrowLeft')
	await expect(pane).toContainText('1/3')
	await expect(pane.locator('.agent-dock-title-text')).toHaveAttribute('title', /· answered \d\d:\d\d$/)
	// Resolved: the receipt is the footer; no decision button and no key hints that would do nothing.
	await expect(pane.getByRole('button', { name: 'Submit answers' })).toHaveCount(0)
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText('esc close')
	// While the pane is open the answer keeps its slot and the pane stays, past the receipt's linger:
	// nothing Jakub did would explain the terminal resizing under his typing.
	const rows = await xtermRows(page)
	await page.clock.runFor(RECEIPT_LINGER_MS + 1_000)
	await expect(pane).toBeVisible()
	await expect(entry).toContainText('✓ answered')
	expect(await xtermRows(page)).toBe(rows)
	// Closing the pane lets it go.
	await pane.getByRole('button', { name: 'Close details' }).click()
	await expect(pane).toHaveCount(0)
	await expect(entry).toHaveCount(0)
})

/** Helm-terminals scenario (the crowded day in Helm's own terminals), the plan's pane open. */
async function openHelmPlan(page: Page) {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'helm-terminals')
	const entry = row(page).locator('.agent-dock-entry[aria-label^="Plan,"]')
	await expect(entry).toHaveCount(1)
	const itemId = Number(await entry.getAttribute('data-item-id'))
	await entry.click()
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toBeVisible()
	return { entry, itemId, pane }
}

test('approving a plan in a Helm terminal: the choice says it switches to accept edits; allow, then ✓ approved', async ({
	page,
}) => {
	const { entry, itemId, pane } = await openHelmPlan(page)
	const approve = pane.getByRole('radio', { name: /Approve the plan/ })
	await expect(approve).toContainText('and switch to accept edits')
	await approve.click()
	await expect(pane).toContainText('Ready to approve')
	await pane.getByRole('button', { name: 'Approve', exact: true }).click()
	await expect(entry).toContainText('✓ approved')
	await expect(pane.locator('.agent-dock-receipt')).toHaveText('✓ approved · accept edits on')
	expect(await acts(page)).toEqual([{ itemId, action: { type: 'allow' } }])
})

test('keep planning sends the plan back with the message: deny, then ✓ sent back to planning', async ({ page }) => {
	const { entry, itemId, pane } = await openHelmPlan(page)
	await pane.getByRole('radio', { name: /Keep planning/ }).click()
	await pane.getByRole('textbox', { name: 'What should change? (optional)' }).fill('split the migration first')
	await pane.getByRole('button', { name: 'Keep planning', exact: true }).click()
	await expect(entry).toContainText('✓ sent back to planning')
	// Sent with the keys in the pane (its message field): the pane moved on to the next waiting item.
	await expect(entry).toHaveAttribute('data-open', 'false')
	await entry.click()
	await expect(pane.locator('.agent-dock-receipt')).toHaveText('✓ sent back to planning · split the migration first')
	expect(await acts(page)).toEqual([{ itemId, action: { type: 'deny', message: 'split the migration first' } }])
})

test('a Helm-terminal permission suggesting addDirectories offers no Always allow (its hub applies rules only)', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'helm-add-directories')
	const entry = row(page).locator('.agent-dock-entry[aria-label^="Permission,"]')
	await expect(entry).toHaveCount(1)
	await entry.click()
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toBeVisible()
	await expect(pane.getByRole('radio')).toHaveCount(2)
	await expect(pane.getByRole('radio', { name: /Allow once/ })).toBeVisible()
	await expect(pane.getByRole('radio', { name: /Deny and tell the agent/ })).toBeVisible()
	await expect(pane).not.toContainText('Always allow')
	await expect(pane).not.toContainText('(this session)')
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
	await pane.getByRole('radio', { name: /^(2 )?M(\s|$)/ }).click()
	await pane.getByRole('button', { name: 'Submit answers' }).click()
	await expect(rail.locator(`.agent-dock-entry[data-item-id="${itemId}"]`)).toContainText('✓ answered')
	expect(await acts(page)).toEqual([
		{ itemId, action: { type: 'answer', picks: [{ options: [], other: 'Zelená 2' }, { options: [1] }] } },
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
	await pane.getByRole('button', { name: 'Deny', exact: true }).click()
	await expect(entry).toContainText('refused: already answered elsewhere')
	await expect(entry).toHaveAttribute('data-receipt', 'danger')
	expect((await acts(page)).at(-1)).toEqual({ itemId, action: { type: 'deny', message: 'use deploy:preview' } })

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

test('reply to a finished turn: unconfirmed turns amber and stays ackable', async ({ page }) => {
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
	await expect(entry).toContainText('Sending…')
	await expect(entry).toContainText('sent, unconfirmed')
	await expect(entry).toHaveAttribute('data-receipt', 'warn')
	expect(await acts(page)).toEqual([{ itemId, action: { type: 'prompt', text: 'Yes, push it 2' } }])
	// The 2xx came back: sent from the reply field, so the pane opened the next waiting item (round to
	// the question) with the keys in it; nothing was typed into the terminal by the dock itself.
	await expect(pane).toContainText('1/3')
	await expect(pane).toBeFocused()
	await expect(input).not.toBeFocused()
	expect(await terminalWrites(page)).toBe(0)
	// The turn keeps its slot with the receipt; back on it, ack it.
	await entry.click()
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
	await pane.getByRole('radio', { name: /^(1 )?S(\s|$)/ }).click()
	const submit = pane.getByRole('button', { name: 'Submit answers' })
	await submit.click()
	await expect(pane.locator('.agent-dock-receipt')).toContainText('failed (500): bridge unavailable')
	await expect(entry).toHaveAttribute('data-state', 'open')
	await expect(row(page)).toHaveAttribute('aria-label', /^Agent dock, 3 need you/)
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
	// The items just arrived: their edge pulse ends first (agent-dock-arrival.spec.ts), then the edge is the line.
	await expect(page.locator('#agent-dock [data-arrival]')).toHaveCount(0)
	const edge = () =>
		dock.evaluate(node => {
			const style = getComputedStyle(node, '::before')
			return { color: style.backgroundColor, height: style.height }
		})
	await expect.poll(edge).toEqual({ color: topbarEdge, height: '1px' })
	// The pane and the queue row sit on that one surface (no fills of their own).
	for (const part of ['.agent-dock-pane', '.agent-dock-row'])
		expect(await background(page, part)).toBe('rgba(0, 0, 0, 0)')
	// One typeface: the UI face for the row, the header and the choices; mono only for the literal command.
	const face = (selector: string) =>
		page
			.locator(selector)
			.first()
			.evaluate(node => getComputedStyle(node).fontFamily)
	const ui = await face('.agent-dock-host')
	expect(ui).not.toMatch(/Menlo|SF Mono/)
	for (const part of [
		'.agent-dock-entry-name',
		'.agent-dock-title-kind',
		'.agent-dock-choice-label',
		'.agent-dock-key',
	])
		expect(await face(part)).toBe(ui)
	expect(await face('.agent-dock-command')).toMatch(/SF Mono/)
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
	await pane.getByRole('radio', { name: /^(1 )?S(\s|$)/ }).click()
	await pane.getByRole('button', { name: 'Submit answers' }).click()
	await expect(question).toContainText('✓ answered')
	// The snapshot now lists it after the open items; the queue keeps it where it was.
	expect(await indexOf()).toBe(0)
	// Same place; the cell fits the receipt in place of the wait (it is as wide as its text).
	const after = await question.boundingBox()
	expect({ x: after?.x, y: after?.y }).toEqual({ x: before?.x, y: before?.y })
	for (const part of ['.agent-dock-entry-name', '.agent-dock-entry-receipt'])
		expect(await question.locator(part).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
	await expect(pane).toContainText('1/3')
	await expect(pane.locator('.agent-dock-receipt')).toContainText('✓ answered')
	// Closing the pane lets the order follow the snapshot again: the answer lingers last.
	await question.click()
	await expect(pane).toHaveCount(0)
	await expect.poll(indexOf).toBe(2)
})

async function answerInTerminal(page: Page, itemId: number): Promise<void> {
	await page.evaluate(id => {
		const dock = window.__helmWorkspaceFixture?.agentDock
		if (!dock) throw new Error('Missing agent-dock fixture')
		dock.emitAnsweredInTerminal(id)
	}, itemId)
}

test('what Jakub answered in the terminal leaves the row while the pane is open; the open entry stays until he moves off it', async ({
	page,
}) => {
	const { rail, pane } = await openItem(page, 1)
	const entries = rail.locator('.agent-dock-entry')
	const question = rail.locator('.agent-dock-entry[aria-label^="Question,"]')
	const permission = rail.locator('.agent-dock-entry[aria-label^="Permission,"]')
	const turn = rail.locator('.agent-dock-entry[data-kind="turn"]')
	const idOf = async (entry: typeof question) => Number(await entry.getAttribute('data-item-id'))
	const [questionId, turnId] = [await idOf(question), await idOf(turn)]
	await expect(entries).toHaveCount(3)
	const rows = await xtermRows(page)

	// The turn is replied to in its terminal: it leaves the row at once, the pane stays on the question.
	await answerInTerminal(page, turnId)
	await expect(turn).toHaveCount(0)
	await expect(entries).toHaveCount(2)
	await expect(pane).toContainText('1/2')
	await expect(rail).toHaveAttribute('aria-label', /^Agent dock, 2 need you/)

	// The open question is answered in its terminal: not yanked mid-read, it keeps its slot and the pane says how it closed.
	await answerInTerminal(page, questionId)
	await expect(question).toHaveAttribute('data-state', 'resolved')
	await expect(pane.locator('.agent-dock-receipt')).toContainText('answered in terminal')
	await expect(pane).toContainText('1/2')
	await expect(rail).toHaveAttribute('aria-label', /^Agent dock, 1 needs you/)

	// Moving on to the permission lets it go; the pane stayed open throughout and never refit the terminal.
	await pane.getByRole('button', { name: 'Next item' }).click()
	await expect(question).toHaveCount(0)
	await expect(entries).toHaveCount(1)
	await expect(permission).toHaveAttribute('data-open', 'true')
	await expect(pane).toContainText('1/1')
	expect(await xtermRows(page)).toBe(rows)
	await pane.getByRole('button', { name: 'Close details' }).click()
	await expect(pane).toHaveCount(0)
	await expect(entries).toHaveCount(1)
})

test('the pane never floats over terminal rows: in-flow, one refit on open and one on close', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'crowded')
	const rail = row(page)
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
			// The pane's resize edge: a transparent hit zone, 3px into the well's padding (checked below).
			if (node.classList.contains('agent-dock-resize')) return false
			const rect = node.getBoundingClientRect()
			return rect.width > 0 && rect.height > 0 && rect.bottom > terms.top + 0.5 && rect.top < terms.bottom - 0.5
		}).length
	})
	expect(overlays).toBe(0)
	const edge = await page.locator('.agent-dock-resize').evaluate(node => ({
		paint: getComputedStyle(node).backgroundColor,
		into: Math.max(
			0,
			(document.querySelector('#terms') as HTMLElement).getBoundingClientRect().bottom -
				node.getBoundingClientRect().top,
		),
	}))
	expect(edge).toEqual({ paint: 'rgba(0, 0, 0, 0)', into: 3 })
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

test('the footer note wraps: a verbatim Okena error reads whole at a 1100px window', async ({ page }) => {
	await page.setViewportSize({ width: 1100, height: 800 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	await setActMode(page, 'error')
	await page.locator('.agent-dock-entry[data-kind="turn"]').click()
	const pane = page.locator('.agent-dock-pane')
	await pane.getByRole('textbox', { name: 'Reply' }).fill('please continue')
	await pane.getByRole('button', { name: 'Send', exact: true }).click()
	const note = pane.locator('.agent-dock-foot-note')
	await expect(note).toContainText('failed (500): bridge unavailable')
	expect(
		await note.evaluate(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight),
	).toBe(true)
})

/** Busy scenario, queue open by ⌘⇧J, the pane opened from the keyboard on item `index` (it has focus). */
async function openByKeyboard(page: Page, index: 1 | 2 | 3) {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'busy')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	const rail = row(page)
	await expect(rail.locator('[data-row-stop]').first()).toBeFocused()
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
	await expect(page.locator('.agent-dock-row [data-row-stop]').first()).toBeFocused()
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

test('a reply that mentions "deploy to production" sends on the first submit, no second step', async ({ page }) => {
	const { pane } = await openItem(page, 3)
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await reply.click()
	await page.keyboard.type('ok, deploy to production')
	await page.keyboard.press('Meta+Enter')
	await expect.poll(async () => (await acts(page)).length).toBe(1)
	expect((await acts(page))[0]?.action).toEqual({ type: 'prompt', text: 'ok, deploy to production' })
	await expect(pane.getByRole('alert')).toHaveCount(0)
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

/** The pane's focused element, read as the choice it is (its label), or null when focus is not on a choice. */
const focusedChoice = (page: Page) =>
	page.evaluate(() => {
		const active = document.activeElement
		return active?.classList.contains('agent-dock-choice')
			? (active.querySelector('.agent-dock-choice-label')?.textContent ?? '')
			: null
	})

/** The preview's label (`2 Blue`), as the preview aside shows it. */
const previewLabel = (page: Page) =>
	page
		.locator('.agent-dock-pane .agent-dock-preview-label')
		.evaluate(node => (node.textContent ?? '').replace(/^preview\s*/, '').trim())

test('arrows reach the answers from a keyboard-opened question: ↓ ↑ enter the choices at their stop, the preview follows', async ({
	page,
}) => {
	const { pane } = await openByKeyboard(page, 1)
	await expect(pane).toBeFocused()
	// ↓ from the pane enters the choices at their stop (nothing picked: the first) and never steps items.
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Red')
	await expect(pane).toContainText('1/3')
	await expect.poll(() => previewLabel(page)).toBe('1 Red')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Blue')
	await expect.poll(() => previewLabel(page)).toBe('2 Blue')
	await expect(pane.locator('.agent-dock-preview-text')).toHaveText('▇▇ blue')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Other…')
	await page.keyboard.press('ArrowUp')
	await expect.poll(() => focusedChoice(page)).toBe('Blue')
	// Arrows only move focus: nothing is picked, the pane stays on the item.
	await expect(pane.getByRole('radio', { checked: true })).toHaveCount(0)
	await expect(pane).toContainText('1/3')
	// Back on the pane, ↑ also returns to the choices' stop (the last one focused), never steps items.
	await pane.focus()
	await page.keyboard.press('ArrowUp')
	await expect.poll(() => focusedChoice(page)).toBe('Blue')
	await expect(pane).toContainText('1/3')
	// Digits and Enter keep their meaning from the pane: 2 picks Blue (moving on to Size), 1 picks S, Enter submits.
	await pane.focus()
	await page.keyboard.press('2')
	await page.keyboard.press('1')
	await page.keyboard.press('Enter')
	await expect.poll(async () => (await acts(page)).length).toBe(1)
	expect((await acts(page))[0]?.action).toEqual({ type: 'answer', picks: [{ options: [1] }, { options: [0] }] })
})

test('a lone question opened with Enter (1/1): ↓ ↑ move through its answers', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'empty')
	await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.emitArrival('question'))
	const rail = row(page)
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(1)
	await page.locator('.term-holder.active .xterm-helper-textarea').focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await expect(rail.locator('[data-row-stop]').first()).toBeFocused()
	await page.keyboard.press('Enter')
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toBeFocused()
	await expect(pane).toContainText('1/1')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Den po splatnosti')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Týden po splatnosti')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Other…')
	await page.keyboard.press('ArrowUp')
	await page.keyboard.press('ArrowUp')
	await expect.poll(() => focusedChoice(page)).toBe('Den po splatnosti')
	await expect(pane.getByRole('radio', { checked: true })).toHaveCount(0)
	await expect(pane).toContainText('1/1')
})

test('← → on a choice step items like the pane; focus lands on the next item’s choices (or the pane)', async ({
	page,
}) => {
	const { pane } = await openByKeyboard(page, 1)
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Blue')
	await page.keyboard.press('ArrowRight')
	await expect(pane).toContainText('2/3')
	await expect.poll(() => focusedChoice(page)).toBe('Allow once')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Always allow')
	await page.keyboard.press('ArrowLeft')
	await expect(pane).toContainText('1/3')
	await expect.poll(() => focusedChoice(page)).toBe('Red')
	// The turn has no choices: stepping there leaves the keys on the pane, where ↑ ↓ step as before.
	await page.keyboard.press('ArrowRight')
	await page.keyboard.press('ArrowRight')
	await expect(pane).toContainText('3/3')
	await expect(pane).toBeFocused()
	await page.keyboard.press('ArrowUp')
	await expect(pane).toContainText('2/3')
	// The question tabs keep ← → for switching questions.
	await page.keyboard.press('ArrowLeft')
	await expect(pane).toContainText('1/3')
	await pane.getByRole('tab', { name: /Color/ }).focus()
	await page.keyboard.press('ArrowRight')
	await expect(pane.getByRole('tab', { name: /Size/ })).toHaveAttribute('aria-selected', 'true')
	await expect(pane).toContainText('1/3')
})

test('permission and plan panes opened with Enter: ↓ ↑ move through their choices, never pick', async ({ page }) => {
	const { pane } = await openByKeyboard(page, 2)
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Allow once')
	await expect(pane).toContainText('2/3')
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Deny')
	// Focus only: no pick, so the deny message does not open and the submit stays disabled.
	await expect(pane.getByRole('textbox')).toHaveCount(0)
	await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
	await pane.focus()
	await page.keyboard.press('ArrowUp')
	await expect.poll(() => focusedChoice(page)).toBe('Deny')
	await expect(pane).toContainText('2/3')

	await emitScenario(page, 'helm-terminals')
	const plan = row(page).locator('.agent-dock-entry[aria-label^="Plan,"]')
	await expect(plan).toHaveCount(1)
	await plan.focus()
	await page.keyboard.press('Enter')
	await expect(pane).toBeFocused()
	await expect(pane.locator('.agent-dock-title-kind')).toContainText('Plan')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Approve the plan')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Keep planning')
	await page.keyboard.press('ArrowUp')
	await expect.poll(() => focusedChoice(page)).toBe('Approve the plan')
	await expect(pane.getByRole('radio', { checked: true })).toHaveCount(0)
})

test('moving on keeps the arrows: after ⌘⌫ or an answer the next pane takes ↓ ↑ into its choices', async ({ page }) => {
	const { pane } = await openByKeyboard(page, 3)
	await page.keyboard.press('Meta+Backspace')
	// The turn was last: the pane moved on to the question with the keys.
	await expect(pane).toContainText('1/2')
	await expect(pane).toBeFocused()
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Red')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Blue')
	// Answer it from the choices (Enter picks, focus follows to Size; ⌘Enter submits): the pane moves on to the permission.
	await page.keyboard.press('Enter')
	await expect.poll(() => focusedChoice(page)).toBe('S')
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('Enter')
	await page.keyboard.press('Meta+Enter')
	await expect(pane.locator('.agent-dock-title-kind')).toContainText('Permission')
	await expect(pane).toBeFocused()
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Allow once')
	await page.keyboard.press('ArrowDown')
	await expect.poll(() => focusedChoice(page)).toBe('Always allow')
})

test('typing at a keyboard-opened turn pane starts the reply', async ({ page }) => {
	const { pane } = await openByKeyboard(page, 3)
	await page.keyboard.type('Ok 2')
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await expect(reply).toBeFocused()
	await expect(reply).toHaveValue('Ok 2')
	expect(await terminalWrites(page)).toBe(0)
})

test('⌘⌫ acks a turn from the pane: the hint shows, the pane opens the next waiting item with the keys', async ({
	page,
}) => {
	const { pane, rail } = await openByKeyboard(page, 3)
	const turn = rail.locator('.agent-dock-entry[data-kind="turn"]')
	const turnId = Number(await turn.getAttribute('data-item-id'))
	await expect(pane.locator('.agent-dock-foot-hints')).toHaveText(/^⌘↵ send\s*⌘⌫ ack\s*esc close$/)
	const ackButton = pane.getByRole('button', { name: `Ack item ${turnId}` })
	await expect(ackButton).toHaveAttribute('aria-keyshortcuts', 'Meta+Backspace')
	await expect(ackButton).toHaveAttribute('title', 'Ack (⌘⌫)')
	// Moving on keeps the pane mounted (never a close and reopen); it may only grow once to the next item.
	const rows = await xtermRows(page)
	const placed = await box(page, '.agent-dock-pane')
	await page.evaluate(() => {
		const seen = { removed: 0 }
		;(window as unknown as { __paneRemovals: typeof seen }).__paneRemovals = seen
		new MutationObserver(records => {
			for (const record of records)
				for (const node of record.removedNodes)
					if (node instanceof Element && node.classList.contains('agent-dock-pane')) seen.removed++
		}).observe(document.querySelector('#agent-dock') as Element, { childList: true, subtree: true })
	})
	await page.keyboard.press('Meta+Backspace')
	await expect(turn).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.acks)).toEqual([turnId])
	// The turn was last: round to the first waiting item, the question, keys in its pane.
	await expect(pane).toContainText('1/2')
	await expect(pane.locator('.agent-dock-title-kind')).toContainText('Question')
	await expect(pane).toBeFocused()
	await expect(rail.locator('.agent-dock-entry[data-open="true"]')).toHaveAttribute('aria-label', /^Question,/)
	expect(
		await page.evaluate(() => (window as unknown as { __paneRemovals: { removed: number } }).__paneRemovals.removed),
	).toBe(0)
	// The question is taller than the turn: the pane grew to it (never shrinks), at most one refit.
	const moved = await box(page, '.agent-dock-pane')
	expect(moved.height).toBeGreaterThanOrEqual(placed.height)
	expect(moved.y + moved.height).toBe(placed.y + placed.height)
	expect(await xtermRows(page)).toBeLessThanOrEqual(rows)
	// ‹ › from here keep that height.
	await pane.getByRole('button', { name: 'Next item' }).click()
	await expect(pane).toContainText('2/2')
	expect(await box(page, '.agent-dock-pane')).toEqual(moved)
})

test('⌘⌫ in a reply with text deletes it; in the empty reply it acks', async ({ page }) => {
	const { pane, rail } = await openByKeyboard(page, 3)
	const turn = rail.locator('.agent-dock-entry[data-kind="turn"]')
	const turnId = Number(await turn.getAttribute('data-item-id'))
	await page.keyboard.type('Ok then')
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await expect(reply).toBeFocused()
	await expect(reply).toHaveValue('Ok then')
	// The field keeps its native meaning (delete to line start); nothing is acked.
	await page.keyboard.press('Meta+Backspace')
	await expect(reply).toHaveValue('')
	await expect(reply).toBeFocused()
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.acks)).toEqual([])
	await expect(turn).toHaveCount(1)
	// Now empty: ⌘⌫ acks, and the pane moves on to the next waiting item with the keys.
	await page.keyboard.press('Meta+Backspace')
	await expect(turn).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.acks)).toEqual([turnId])
	await expect(pane).toContainText('1/2')
	await expect(pane).toBeFocused()
})

test('⌘⌫ does nothing where Ack is not offered (an open question), and no ack hint shows there', async ({ page }) => {
	const { pane, rail } = await openByKeyboard(page, 1)
	await expect(pane.locator('.agent-dock-foot-hints')).not.toContainText('ack')
	await expect(pane.getByRole('button', { name: /^Ack/ })).toHaveCount(0)
	await page.keyboard.press('Meta+Backspace')
	await expect(pane).toContainText('1/3')
	await expect(pane).toBeFocused()
	await expect(rail.locator('.agent-dock-entry')).toHaveCount(3)
	expect(await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.acks)).toEqual([])
})

test('a reply sent from the pane opens the next waiting item, keys in its pane', async ({ page }) => {
	const { pane, rail } = await openByKeyboard(page, 3)
	const turn = rail.locator('.agent-dock-entry[data-kind="turn"]')
	await page.keyboard.type('Yes, push it')
	await page.keyboard.press('Meta+Enter')
	await expect(turn).toContainText('✓ replied')
	// The question waits first in the queue (the turn was last): the pane shows it and holds the keys.
	await expect(pane).toContainText('1/3')
	await expect(pane.locator('.agent-dock-title-kind')).toContainText('Question')
	await expect(pane).toBeFocused()
	expect((await acts(page)).at(-1)?.action).toEqual({ type: 'prompt', text: 'Yes, push it' })
	expect(await terminalWrites(page)).toBe(0)
})

test('stepping to another item while a reply sends: the answer coming back leaves the keys there', async ({ page }) => {
	const { input, pane, rail } = await openByKeyboard(page, 3)
	const turn = rail.locator('.agent-dock-entry[data-kind="turn"]')
	await page.keyboard.type('Yes, push it')
	await page.keyboard.press('Meta+Enter')
	await expect(turn).toContainText('Sending…')
	await expect(pane).toBeFocused()
	// Jakub moves on by himself before main answers: ← to the permission.
	await page.keyboard.press('ArrowLeft')
	await expect(pane).toContainText('2/3')
	await expect(turn).toContainText('✓ replied')
	// The answer came back: neither moved on again nor handed to the terminal; the keys stay in the pane.
	await expect(pane).toContainText('2/3')
	await expect(pane).toBeFocused()
	await expect(input).not.toBeFocused()
})

test('after the last waiting item, an ack or a reply closes the pane and the terminal has the keys', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'single-turn')
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	await input.focus()
	const rail = row(page)
	const pane = page.locator('.agent-dock-pane')
	const turn = rail.locator('.agent-dock-entry[data-kind="turn"]')
	await expect(turn).toHaveCount(1)
	const rowsBefore = await xtermRows(page)

	// A reply: sent, nothing else waits, so the pane closes (one refit) and xterm takes the keys.
	await page.keyboard.press('Meta+Shift+KeyJ')
	await page.keyboard.press('Enter')
	await expect(pane).toBeFocused()
	await page.keyboard.type('Push it')
	await page.keyboard.press('Meta+Enter')
	await expect(pane).toHaveCount(0)
	await expect(input).toBeFocused()
	expect(await holderScroll(page)).toBe(0)
	await expect.poll(() => xtermRows(page)).toBe(rowsBefore)
	expect(await terminalWrites(page)).toBe(0)

	// An ack: same hand-off.
	await emitScenario(page, 'single-turn')
	await expect(turn).toHaveCount(1)
	await expect(turn).not.toContainText('✓')
	await page.keyboard.press('Meta+Shift+KeyJ')
	await page.keyboard.press('Enter')
	await expect(pane).toBeFocused()
	await page.keyboard.press('Meta+Backspace')
	await expect(pane).toHaveCount(0)
	await expect(turn).toHaveCount(0)
	await expect(input).toBeFocused()
	expect(await holderScroll(page)).toBe(0)
})

test('accessible names: the row, entries and pane say what they are; new asks are announced politely', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	const live = page.locator('#agent-dock .agent-dock-host > .sr-only[aria-live="polite"]')
	await expect(live).toHaveText('')
	// The first reachable snapshot is the baseline; what arrives after it is announced, a burst as one line.
	await emitScenario(page, 'busy')
	await expect(live).toHaveText('3 new requests', { timeout: 5_000 })
	const rail = row(page)
	await expect(rail).toHaveAttribute('aria-label', /^Agent dock, 3 need you, oldest 2h\d+m, Okena$/)
	await expect(rail).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+J')
	await expect(page.locator('.agent-dock-agents-entry')).toHaveAttribute(
		'aria-label',
		/^\d+ agents?: \d+ [a-z ]+(, \d+ [a-z ]+)*\. Show agents$/,
	)
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

/** Where the row's first text starts, px from #agent-dock's left edge, and how far the row or queue is scrolled. */
interface TextColumn {
	text: string
	left: number
	scrolled: number
}

declare global {
	interface Window {
		__dockTextColumn?: () => TextColumn | null
		__dockFirstColumn?: TextColumn
	}
}

/**
 * Installs the in-page probe before the story loads: `__dockTextColumn()` reads the row's first painted text
 * (a kind glyph counts by its 12px box, which centers glyphs of any width; any other text by its own range)
 * and `__dockFirstColumn` keeps what the very first frame with a row showed.
 */
const installTextColumnProbe = () => {
	const column = (): TextColumn | null => {
		const dock = document.querySelector('#agent-dock')
		const row = dock?.querySelector('.agent-dock-row')
		if (!dock || !row) return null
		const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
			acceptNode: node =>
				node.parentElement?.closest('.agent-dock-measure, .sr-only') || !node.textContent?.trim()
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT,
		})
		const node = walker.nextNode()
		if (!node?.parentElement) return null
		const range = document.createRange()
		range.selectNodeContents(node)
		const glyph = node.parentElement.closest('.agent-dock-glyph')
		const left = (glyph ?? range).getBoundingClientRect().left - dock.getBoundingClientRect().left
		const queue = row.querySelector('.agent-dock-queue')
		return { text: node.textContent ?? '', left, scrolled: row.scrollLeft + (queue?.scrollLeft ?? 0) }
	}
	window.__dockTextColumn = column
	const first = () => {
		const at = column()
		if (at) window.__dockFirstColumn = at
		else requestAnimationFrame(first)
	}
	requestAnimationFrame(first)
}

/** The row's text column in the next frame, after `scenario` lands when one is given (its first paint). */
const textColumn = (page: Page, scenario?: string) =>
	page.evaluate(
		name =>
			new Promise<TextColumn | null>(resolve => {
				if (name) window.__helmWorkspaceFixture?.agentDock?.emitScenario(name as 'empty')
				requestAnimationFrame(() => resolve(window.__dockTextColumn?.() ?? null))
			}),
		scenario ?? null,
	)

const expectOnColumn = (column: TextColumn | null | undefined, what: string) => {
	expect(column, what).toBeTruthy()
	expect(Math.abs((column?.left ?? 0) - 16), `${what}: "${column?.text}" starts at ${column?.left}px`).toBeLessThan(0.5)
	expect(column?.scrolled, `${what}: the row is scrolled`).toBe(0)
}

test('every row text starts on the 16px column; entries one line each, separated by space, not rules', async ({
	page,
}) => {
	await page.addInitScript(installTextColumnProbe)
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	// The very first paint, before anything measured has settled.
	expectOnColumn(await page.evaluate(() => window.__dockFirstColumn), 'first paint')
	await emitScenario(page, 'crowded')
	const dock = await box(page, '#agent-dock')
	const glyph = await box(page, '.agent-dock-queue .agent-dock-glyph')
	expect(Math.abs(glyph.x - dock.x - 16)).toBeLessThan(0.5)
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
	// No rule before the Agents entry either.
	expect(await page.locator('.agent-dock-agents').evaluate(node => getComputedStyle(node, '::before').content)).toBe(
		'none',
	)
	// The row ends in ⌘⇧J on the 16px column.
	const kbd = await box(page, '.agent-dock-kbd')
	expect(Math.abs(dock.x + dock.width - (kbd.x + kbd.width) - 16)).toBeLessThan(1)

	// Whatever the row holds — a note, the empty line, one entry, "+N more" — its first text is on the
	// column: in the first frame after a snapshot lands (items arriving and leaving, widths not yet
	// re-measured) and once settled, with the first entry open or focused by ⌘⇧J, at any window width.
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	const states = ['connecting', 'empty', 'down', 'single-turn', 'busy', 'crowded', 'overflow', 'real-case', 'empty']
	for (const width of [900, 1280, 1600]) {
		await page.setViewportSize({ width, height: 820 })
		for (const scenario of states) {
			expectOnColumn(await textColumn(page, scenario), `${width}px ${scenario}, first frame`)
			await page.waitForTimeout(50)
			expectOnColumn(await textColumn(page), `${width}px ${scenario}`)
		}
		await emitScenario(page, 'overflow')
		const first = row(page).locator('.agent-dock-entry').first()
		await first.click()
		await expect(page.locator('.agent-dock-pane')).toBeVisible()
		expectOnColumn(await textColumn(page), `${width}px first entry open`)
		await first.click()
		await expect(page.locator('.agent-dock-pane')).toHaveCount(0)
		await input.focus()
		await page.keyboard.press('Meta+Shift+KeyJ')
		await expect(first).toBeFocused()
		expectOnColumn(await textColumn(page), `${width}px first entry focused`)
		await page.keyboard.press('Escape')
		await expect(input).toBeFocused()
	}
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
	// Sent with the keys in the pane: it moves on to the next waiting item; step back to the answer.
	await expect(pane).toContainText('2/3')
	await pane.getByRole('button', { name: 'Previous item' }).click()
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
	// No gist and no task title in the queue; one quiet line per entry: glyph, name, wait.
	const rail = row(page)
	await expect(rail).not.toContainText('ClientCare')
	await expect(page.locator('.agent-dock-entry').first()).toHaveText(/^\?\s*company-create-save-firm\s*\d+m/)
	await expect(page.locator('.agent-dock-agents-entry')).toHaveText('4 agents')
	await expect(page.locator('.agent-dock-agents-entry')).toHaveAttribute(
		'aria-label',
		'4 agents: 1 working, 1 in background, 2 waiting on you. Show agents',
	)
	// One segment per agent in the pane's order; the two waiting on Jakub amber.
	await expect(page.locator('.agent-dock-agents-seg')).toHaveCount(4)
	await expect(page.locator('.agent-dock-agents-seg[data-status="waiting"]')).toHaveCount(2)
	await expect(page.locator('.agent-dock-entry').first()).toHaveAttribute('title', /ClientCare #4182/)
	await expect(page.locator('.agent-dock-entry').nth(1)).toHaveAttribute(
		'aria-label',
		/^Permission, company-create-save-firm #2 in crm, waiting 12m$/,
	)
	await page.locator('.agent-dock-entry[data-kind="turn"]').click()
	const pane = page.locator('.agent-dock-pane')
	// The selected fill says whose; the header's tooltip carries the full task title.
	await expect(pane.locator('.agent-dock-title-text')).toHaveAttribute('title', /\(ClientCare #4153\)/)
	await expect(pane.locator('.agent-dock-title-text')).not.toContainText('ClientCare')
	await expect(pane).toHaveAttribute('aria-label', 'Turn ended, repeated-android-camera-permission, crm-mobile')
	await page.locator('.agent-dock-agents-entry').click()
	// Needs you first (the longest wait leads), then working, then background (its turn ended with
	// subagents still running); every agent by its short name.
	await expect(pane.locator('.agent-dock-agent-name')).toHaveText([
		'company-create-save-firm',
		'company-create-save-firm #2',
		'isdoc-export',
		'repeated-android-camera-permission',
	])
	// Grouped by project, groups in the order of their most urgent agent; each heading names its agents' list.
	await pane.getByRole('button', { name: 'project' }).click()
	await expect(pane.getByRole('heading', { level: 3 })).toHaveText(['crm', 'crm-billing', 'crm-mobile'])
	await expect(pane.getByRole('list', { name: 'crm', exact: true }).getByRole('listitem')).toHaveText([
		/company-create-save-firm(?! #)/,
		/company-create-save-firm #2/,
	])
})

const dockEdge = (page: Page) =>
	page.locator('#agent-dock').evaluate(node => getComputedStyle(node, '::before').backgroundColor)

test('⌘⇧J lands in the dock from the terminal whatever the row holds: empty, connecting, Okena down', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 })
	await openHarness(page)
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	const accent = await tokenColor(page, '--accent')
	const hairline = await tokenColor(page, '--hairline')
	const expected = {
		empty: '.agent-dock-agents-entry',
		down: '.agent-dock-entry',
		// No snapshot yet: nothing to rove to, so the row itself holds the keys.
		connecting: '.agent-dock-row',
	} as const
	for (const [scenario, selector] of Object.entries(expected)) {
		await page.evaluate(name => window.__helmWorkspaceFixture?.agentDock?.emitScenario(name as 'empty'), scenario)
		await input.focus()
		await page.keyboard.press('Meta+Shift+KeyJ')
		await expect(page.locator(`#agent-dock ${selector}`).first(), scenario).toBeFocused()
		// Even a bare row holding the keys is visible: the edge toward the terminal lights.
		await expect.poll(() => dockEdge(page), scenario).toBe(accent)
		await page.keyboard.press('Meta+Shift+KeyJ')
		await expect(input, scenario).toBeFocused()
		await expect.poll(() => dockEdge(page), scenario).toBe(hairline)
	}
})

/** Views / Agent dock focus: the production mount, ⌘⇧J pressed from the focused xterm on load. */
const focusStory = (empty = false) =>
	`/iframe.html?id=views-agent-dock-focus--${empty ? 'focused-empty' : 'focused'}&viewMode=story`

test('keys in the dock light its edge accent at 1px; the focused entry is the selected fill, never a ring', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 })
	await page.goto(focusStory())
	const rail = row(page)
	const first = rail.locator('[data-row-stop]').first()
	await expect(first).toBeFocused()
	const accent = await tokenColor(page, '--accent')
	const raised = await tokenColor(page, '--fill-raised')
	const fill = (target = rail) => target.evaluate(node => getComputedStyle(node).backgroundColor)
	await expect.poll(() => dockEdge(page)).toBe(accent)
	expect(await page.locator('#agent-dock').evaluate(node => getComputedStyle(node, '::before').height)).toBe('1px')
	expect(await first.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none')
	await expect.poll(() => fill(first)).toBe(raised)
	// Square cells: no highlight is rounded, and nothing between the row and the window rounds or clips it,
	// so the one rounded corner a fill can meet is the window's own (docked at the bottom with the sidebar
	// hidden, macOS masks the first cell with the window radius — the fill follows it exactly).
	for (const stop of await rail.locator('[data-row-stop]').all())
		expect(await stop.evaluate(node => getComputedStyle(node).borderRadius)).toBe('0px')
	expect(
		await rail.evaluate(node => {
			const shaped: string[] = []
			for (let at: Element | null = node; at; at = at.parentElement) {
				const style = getComputedStyle(at)
				if (style.borderRadius !== '0px' || style.clipPath !== 'none') shaped.push(at.id || at.className)
			}
			return shaped
		}),
	).toEqual([])
	// Nothing else changes: the row keeps the one surface, ⌘⇧J stays dim.
	expect(await fill()).toBe('rgba(0, 0, 0, 0)')
	const dim = await tokenColor(page, '--dock-dim')
	expect(await rail.locator('.agent-dock-kbd').evaluate(node => getComputedStyle(node).color)).toBe(dim)
	// Roving moves the selected look with the keys.
	await page.keyboard.press('ArrowRight')
	await expect.poll(() => fill(first)).toBe('rgba(0, 0, 0, 0)')
	await expect.poll(() => fill(rail.locator('[data-row-stop]').nth(1))).toBe(raised)
	// Esc hands the keys back: the quiet hairline, no fills.
	await page.keyboard.press('Escape')
	await expect(page.locator('.term-holder.active .xterm-helper-textarea')).toBeFocused()
	await expect.poll(() => dockEdge(page)).toBe(await tokenColor(page, '--hairline'))
	await expect.poll(() => fill(rail.locator('[data-row-stop]').nth(1))).toBe('rgba(0, 0, 0, 0)')
	// Empty queue: the Agents entry holds the keys, and the edge still says so.
	await page.goto(focusStory(true))
	await expect(row(page).locator('.agent-dock-agents-entry')).toBeFocused()
	await expect.poll(() => dockEdge(page)).toBe(await tokenColor(page, '--accent'))
})

test('a turn message renders as quiet Markdown: nested lists, mono code, emphasis by tone, never weight', async ({
	page,
}) => {
	await page.goto('/iframe.html?id=views-agent-dock-turn-message--markdown&viewMode=story')
	const message = page.locator('.agent-dock-pane .agent-dock-md')
	await expect(message.locator(':scope > ul')).toHaveCount(2)
	await expect(message.locator('li > ul')).toHaveCount(2)
	await expect(message.locator('code').first()).toHaveText('jmeno@emailcz')
	// Markdown marks are gone; HTML-like text inside code stays literal.
	await expect(message).not.toContainText('**')
	await expect(message.locator('code', { hasText: '< >' })).toHaveCount(1)
	const style = (selector: string, property: string) =>
		message
			.locator(selector)
			.first()
			.evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property)
	expect(await style('code', 'font-family')).toMatch(/SF Mono/)
	expect(await style('p', 'font-family')).not.toMatch(/SF Mono|Menlo/)
	expect(await style('strong', 'font-weight')).toBe('400')
	expect(await style('strong', 'color')).toBe(await tokenColor(page, '--text-0'))
	expect(await style('p', 'color')).toBe(await tokenColor(page, '--text-1'))
	// One step of indent per list level.
	const left = (selector: string) =>
		message
			.locator(selector)
			.first()
			.evaluate(node => node.getBoundingClientRect().left)
	const step = (await left('li li')) - (await left(':scope > ul > li'))
	expect(step).toBeGreaterThan(12)
	expect(step).toBeLessThan(28)
})

test('a link in the turn message opens through the external bridge on click and Enter, never in the renderer', async ({
	page,
}) => {
	await page.goto('/iframe.html?id=views-agent-dock-turn-message--markdown&viewMode=story')
	const url = 'https://claude.ai/artifact/MC5AvBgNCPmVLe7UrHeQmy'
	const link = page.locator('.agent-dock-pane .agent-dock-md a')
	await expect(link).toHaveCount(1)
	await expect(link).toHaveText(url)
	await expect(link).toHaveAttribute('href', url)
	// The harness wires no window.helm; stand in the external bridge the production preload exposes.
	await page.evaluate(() => {
		const opened: string[] = []
		;(window as unknown as { __opened: string[] }).__opened = opened
		window.helm = {
			external: {
				open: async (href: string) => {
					opened.push(href)
					return true
				},
			},
		} as unknown as typeof window.helm
	})
	const opened = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
	const before = page.url()
	let popups = 0
	page.on('popup', () => popups++)
	await link.click()
	await link.click({ button: 'middle' })
	expect(await opened()).toEqual([url])
	await link.focus()
	await page.keyboard.press('Enter')
	expect(await opened()).toEqual([url, url])
	// A typed key on the link stays with it: the reply does not start.
	await page.keyboard.press('x')
	await expect(link).toBeFocused()
	await expect(page.locator('.agent-dock-pane textarea[aria-label="Reply"]')).toHaveValue('')
	expect(page.url()).toBe(before)
	expect(popups).toBe(0)
	// Helm's prose link, wrapping anywhere so a long URL never widens the pane.
	const style = (name: string) =>
		link.evaluate((node, property) => getComputedStyle(node).getPropertyValue(property), name)
	expect(await style('color')).toBe(await tokenColor(page, '--accent'))
	expect(await style('text-decoration-line')).toBe('underline')
	expect(await style('overflow-wrap')).toBe('anywhere')
	const pane = page.locator('.agent-dock-pane-scroll')
	expect(await pane.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
})

test('an agent waiting on its background shell reads background with "1 shell", and its turn stays readable', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await openHarness(page)
	await emitScenario(page, 'background-shell')
	// Okena says idle; the shell Claude started makes it busy in the background, never idle.
	await expect(page.locator('.agent-dock-agents-entry')).toHaveText('1 agent')
	await expect(page.locator('.agent-dock-agents-entry')).toHaveAttribute('aria-label', /1 in background/)
	const turn = page.locator('.agent-dock-entry[data-kind="turn"]')
	await expect(turn).toHaveAttribute('aria-label', /^Turn ended, service-protocol-image-link in JVS, /)
	await page.locator('.agent-dock-agents-entry').click()
	const pane = page.locator('.agent-dock-pane')
	const agent = pane.getByRole('listitem').filter({ hasText: 'service-protocol-image-link' })
	await expect(agent).toContainText(/background\s*2m/)
	await expect(agent).toContainText('1 shell')
	await expect(agent).not.toContainText('subagent')
	await expect(agent).not.toContainText('idle')
	// The turn: "I'll report back when it finishes", with the calm background note.
	await turn.click()
	await expect(pane).toContainText('Stage deploy běží, ozvu se, až doběhne.')
	await expect(pane.locator('.agent-dock-facts')).toContainText('Background work was still running.')
	await expect(pane).not.toContainText('Subagents were still running.')
})
