import { type Page, expect, test } from '@playwright/test'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
	}
}

// "Show terminal" (design §3.24): from an item's pane or an agent's detail, ⌘O or the header's where
// link (`Okena ↗`) brings up the agent's terminal. Okena agents go through main (agent-dock:reveal, here the fixture
// api); a Helm terminal's agent switches this window to its tab, focused, its frame pulsed. The pane
// stays open; a failure is a quiet footer line, never a dialog.

const harness = '/iframe.html?id=views-terminal-workspace--agent-dock-harness&viewMode=story'

async function openDay(page: Page, scenario: 'reveal-okena' | 'reveal-helm') {
	await page.setViewportSize({ width: 1280, height: 800 })
	await page.goto(harness)
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#agent-dock .agent-dock-row')).toBeVisible()
	await page.evaluate(name => window.__helmWorkspaceFixture?.agentDock?.emitScenario(name), scenario)
	const rail = page.locator('#agent-dock .agent-dock-row')
	const pane = page.locator('.agent-dock-pane')
	return {
		rail,
		pane,
		turn: rail.locator('.agent-dock-entry[data-kind="turn"]'),
		question: rail.locator('.agent-dock-entry[aria-label^="Question,"]'),
		note: pane.locator('.agent-dock-foot-note'),
	}
}

const reveals = (page: Page) => page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.calls.reveals ?? [])
const setRevealMode = (page: Page, mode: 'shown' | 'not-raised' | 'gone' | 'unreachable') =>
	page.evaluate(next => window.__helmWorkspaceFixture?.agentDock?.setRevealMode(next), mode)

test('Okena agent: the header link by pointer and ⌘O (pane, reply field) asks main for that pane; the pane stays', async ({
	page,
}) => {
	const { pane, turn, question, note } = await openDay(page, 'reveal-okena')
	await turn.click()
	// The where text after the kind, named for VoiceOver by the act and whose terminal.
	const show = pane.getByRole('button', { name: 'Show in Okena, service-date-and-people' })
	await expect(show).toBeVisible()
	await expect(show).toHaveText(/^Okena ↗$/)
	await expect(show).toHaveAttribute('aria-keyshortcuts', 'Meta+O')
	await expect(show).toHaveAttribute('title', 'Show in Okena (⌘O)')
	await expect(pane).toHaveAttribute('aria-keyshortcuts', 'Meta+O')
	await expect(pane.locator('.agent-dock-title-text')).toHaveText(/^\S*\s*Turn ended\s*Okena ↗\s*⌘O$/)
	// The footer stays as it was: no reveal key, no reveal hint.
	await expect(pane.locator('.agent-dock-foot-actions .agent-dock-key')).toHaveText(['Ack', 'Send'])
	// The `⌘O` hint shows only while the pane holds the keys, like the footer's.
	const hint = pane.locator('.agent-dock-title-hint')
	await expect(hint).toHaveAttribute('aria-hidden', 'true')
	await expect(hint).toHaveCSS('visibility', 'hidden')
	await show.click()
	await expect.poll(() => reveals(page)).toEqual(['storybook:term-crane-sdp'])
	await expect(pane).toBeVisible()
	await expect(note).toHaveText('')
	// One reveal at a time: the link is disabled until main answers.
	await expect(show).toBeEnabled()

	// ⌘O from the pane itself (the keys there): the hint shows, the footer row lists no ⌘O.
	await pane.focus()
	await expect(hint).toHaveCSS('visibility', 'visible')
	await expect(pane.locator('.agent-dock-foot-hints')).not.toContainText('⌘O')
	await page.keyboard.press('Meta+O')
	await expect.poll(() => reveals(page)).toEqual(['storybook:term-crane-sdp', 'storybook:term-crane-sdp'])
	await expect(show).toBeEnabled()
	// From the reply field too, with text in it: ⌘O types nothing.
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await reply.fill('ok')
	await page.keyboard.press('Meta+O')
	await expect.poll(() => reveals(page)).toHaveLength(3)
	await expect(reply).toHaveValue('ok')
	await expect(show).toBeEnabled()

	// The question pane: its own agent.
	await question.click()
	await pane.focus()
	await page.keyboard.press('Meta+O')
	await expect
		.poll(() => reveals(page))
		.toEqual([
			'storybook:term-crane-sdp',
			'storybook:term-crane-sdp',
			'storybook:term-crane-sdp',
			'storybook:term-crane-export',
		])
	await expect(pane).toBeVisible()
})

test('Okena agent detail (Agents → an agent that owes nothing): `Okena ↗` leads its where line; ⌘O shows its pane', async ({
	page,
}) => {
	const { rail, pane } = await openDay(page, 'reveal-okena')
	await rail.locator('.agent-dock-agents-entry').click()
	await pane
		.locator('.agent-dock-agent')
		.filter({ has: page.locator('.agent-dock-agent-name', { hasText: 'rental-pricing' }) })
		.click()
	const show = pane.getByRole('button', { name: 'Show in Okena, rental-pricing' })
	await expect(show).toBeVisible()
	await expect(show).toHaveText(/^Okena ↗$/)
	await expect(pane.locator('.agent-dock-title-where')).toHaveText(/^Okena ↗\s*⌘O · /)
	await expect(pane.locator('.agent-dock-foot').getByRole('button', { name: /Okena/ })).toHaveCount(0)
	await pane.focus()
	await page.keyboard.press('Meta+O')
	await expect.poll(() => reveals(page)).toEqual(['storybook:term-crane-pricing'])
	// The Agents list itself offers nothing to show.
	await page.keyboard.press('Escape')
	await expect(pane.locator('.agent-dock-reveal-link')).toHaveCount(0)
	await pane.focus()
	await page.keyboard.press('Meta+O')
	await page.waitForTimeout(300)
	expect(await reveals(page)).toHaveLength(1)
})

test('Helm terminal agent: `Terminal ↗` switches to its tab, focuses it and pulses its frame once; main is not asked', async ({
	page,
}) => {
	const { pane, turn, question } = await openDay(page, 'reveal-helm')
	const compile = page.getByRole('tab', { name: /compile/i })
	await expect(compile).toHaveAttribute('aria-selected', 'false')
	await turn.click()
	const show = pane.getByRole('button', { name: /^Show terminal, / })
	await expect(show).toHaveText(/^Terminal ↗$/)
	await expect(show).toHaveAttribute('title', 'Show terminal (⌘O)')
	await show.click()
	await expect(compile).toHaveAttribute('aria-selected', 'true')
	const holder = page.locator('.term-holder.active')
	await expect(holder).toHaveAttribute('data-reveal', '')
	await expect(holder.locator('.xterm-helper-textarea')).toBeFocused()
	// The pane stays open beside the revealed terminal.
	await expect(pane).toBeVisible()
	// One pulse: the attribute goes after REVEAL_PULSE_MS (1.4s).
	await expect(holder).not.toHaveAttribute('data-reveal', '', { timeout: 3_000 })
	expect(await reveals(page)).toEqual([])

	// By keys, the question's agent runs in `tests`, a background terminal: it opens in place (still listed
	// in the background), focused and pulsed.
	await question.click()
	await pane.focus()
	await page.keyboard.press('Meta+O')
	await expect(page.locator('#bg-current')).toHaveText(/tests/)
	await expect(compile).toHaveAttribute('aria-selected', 'false')
	await expect(page.locator('.term-holder.active')).toHaveAttribute('data-reveal', '')
	expect(await reveals(page)).toEqual([])
})

test('a failed reveal leaves a quiet footer line, no dialog; a focused-but-not-raised one says so', async ({
	page,
}) => {
	const { pane, turn, question, note } = await openDay(page, 'reveal-okena')
	await setRevealMode(page, 'gone')
	await turn.click()
	await pane.focus()
	await page.keyboard.press('Meta+O')
	await expect(note).toHaveText("The agent's terminal is no longer open in Okena.")
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(page.getByRole('alertdialog')).toHaveCount(0)
	await expect(pane).toBeFocused()

	await setRevealMode(page, 'unreachable')
	await question.click()
	await pane.focus()
	await page.keyboard.press('Meta+O')
	await expect(note).toHaveText('Okena is unreachable: connect ECONNREFUSED 127.0.0.1:19100')
	// The note belongs to its agent: back on the turn, it does not follow.
	await turn.click()
	await expect(note).not.toContainText('unreachable')

	await setRevealMode(page, 'not-raised')
	await pane.locator('.agent-dock-reveal-link').click()
	await expect(note).toHaveText('Focused in Okena; Helm could not bring Okena to the front.')
})
