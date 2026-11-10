import { type Page, expect, test } from '@playwright/test'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
	}
}

// The Agents overview (design §3.24 Agents) on the `agents-overview` day: every agent's state
// relative to Jakub, where it runs, the first line of what it said, grouped by state (default) or
// project (header switch, G, stored); each source's health in the header; rows open the agent's
// item or its detail (full last message, reply).

const harness = '/iframe.html?id=views-terminal-workspace--agent-dock-harness&viewMode=story'

async function openOverview(page: Page) {
	await page.setViewportSize({ width: 1400, height: 820 })
	await page.goto(harness)
	await expect(page.locator('.term-holder.active .xterm-screen')).toBeVisible()
	await expect(page.locator('#agent-dock .agent-dock-row')).toBeVisible()
	await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.emitScenario('agents-overview'))
	const input = page.locator('.term-holder.active .xterm-helper-textarea')
	const rail = page.locator('#agent-dock .agent-dock-row')
	const pane = page.locator('.agent-dock-pane')
	const agents = pane.locator('.agent-dock-agent')
	const agent = (name: string) => agents.filter({ has: page.locator('.agent-dock-agent-name', { hasText: name }) })
	return { input, rail, pane, agents, agent }
}

/** From the terminal by keys: ⌘⇧J, End onto the Agents entry, Enter. */
async function openOverviewByKeys(page: Page) {
	const view = await openOverview(page)
	await view.input.focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await page.keyboard.press('End')
	await expect(view.rail.locator('.agent-dock-agents-entry')).toBeFocused()
	await page.keyboard.press('Enter')
	await expect(view.agents.first()).toBeFocused()
	return view
}

const fixtureCalls = (page: Page) =>
	page.evaluate(() => {
		const calls = window.__helmWorkspaceFixture?.agentDock?.calls
		return { prompts: calls?.prompts ?? [], reads: calls?.reads ?? [], acts: calls?.acts ?? [] }
	})
const terminalWrites = (page: Page) => page.evaluate(() => window.__helmWorkspaceFixture?.calls.writes.length)

test('every agent, where it stands with Jakub: grouped by state first, then by project, where it runs, its last line', async ({
	page,
}) => {
	const { input, rail, pane, agents } = await openOverview(page)
	await input.focus()
	await rail.locator('.agent-dock-agents-entry').click()
	// A pointer opens the overview without taking the keys from the terminal.
	await expect(input).toBeFocused()
	await expect(pane.locator('.agent-dock-title-project').first()).toHaveText('9 agents · 4 need you · 2 busy')
	// Default: by state, what needs Jakub first.
	const options = pane.getByRole('group', { name: 'Group agents by' }).getByRole('button')
	await expect(options).toHaveText(['state', 'project'])
	await expect(options.first()).toHaveAttribute('aria-pressed', 'true')
	await expect(pane.locator('.agent-dock-agent-list')).toHaveAttribute('data-layout', 'by-state')
	await expect(pane.getByRole('heading', { level: 3 })).toHaveText([
		'Needs you',
		'Reply waiting',
		'Working',
		'Background',
		'Read',
		'Unknown',
	])
	await expect(pane.getByRole('list', { name: 'Needs you', exact: true }).getByRole('listitem')).toHaveCount(3)

	// The switch (a pointer): by project, the most urgent agent leading each repository.
	await options.nth(1).click()
	await expect(input).toBeFocused()
	await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true')
	await expect(options.first()).toHaveAttribute('aria-pressed', 'false')
	await expect(pane.getByRole('heading', { level: 3 })).toHaveText(['Psyon', 'JVS', 'vault'])
	// Each row's name: who, the state in words and its age, then where.
	await expect(agents).toHaveCount(9)
	const labels = await agents.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
	expect(labels).toEqual([
		'contact-import, needs you: plan 25m, Okena, worktree',
		'invoice-pdf-export, needs you: question 12m, Okena, worktree',
		'Psyon, working 4m, Okena, detached d1aee9df, 4 subagents',
		'stage-deploy, needs you: permission 3m, Okena, worktree',
		'repair-done-still-out-of-service, reply waiting 45m, Okena, worktree, PR #956, PR #484',
		'service-protocol-image-link, read 25m, Okena, worktree, PR #953',
		'rental-calendar-overlap, unknown, Okena, worktree, stale 2m',
		'inbox-triage, background 9m, Helm terminal, main, 1 shell',
		'notes, not connected, Okena, main',
	])
	// One tab stop: the first row.
	await expect(pane.locator('.agent-dock-agent[tabindex="0"]')).toHaveCount(1)
	await expect(agents.first()).toHaveAttribute('tabindex', '0')
	// The excerpt: the open ask's gist while it asks, else the first line of the last message, plain.
	const excerpts = pane.locator('.agent-dock-agent-excerpt')
	await expect(excerpts.nth(1)).toHaveText('Má být logo firmy v PDF vpravo nahoře, nebo v patičce?')
	await expect(excerpts.nth(5)).toHaveText('PR #953 je otevřený: odkaz na obrázek je v protokolu i v e-mailu.')
	await expect(agents.nth(5)).toHaveAttribute('aria-describedby', /.+/)
	// Waiting on Jakub ages like the queue: a turn 45m old is amber.
	await expect(agents.nth(4)).toHaveAttribute('data-tone', 'warn')

	// The grouping is stored: a fresh dock (reload) opens by project.
	await page.reload()
	const again = await openOverview(page)
	await again.rail.locator('.agent-dock-agents-entry').click()
	await expect(again.pane.locator('.agent-dock-agent-list')).toHaveAttribute('data-layout', 'by-project')

	expect(await terminalWrites(page)).toBe(0)
})

test('G switches the grouping from the keys and keeps them on the same agent', async ({ page }) => {
	const { pane, agents, agent } = await openOverviewByKeys(page)
	await expect(pane.locator('.agent-dock-foot-hints')).toContainText('g group by project')
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('ArrowDown')
	await expect(agent('repair-done-still-out-of-service')).toBeFocused()
	const paneHeight = async () => (await pane.boundingBox())?.height
	const before = await paneHeight()
	await page.keyboard.press('g')
	await expect(pane.locator('.agent-dock-agent-list')).toHaveAttribute('data-layout', 'by-project')
	await expect(agent('repair-done-still-out-of-service')).toBeFocused()
	// Regrouping keeps the pane's height: the terminal never refits for it.
	expect(await paneHeight()).toBe(before)
	await expect(pane.locator('.agent-dock-foot-hints')).toContainText('g group by state')
	await page.keyboard.press('ArrowDown')
	await expect(agent('service-protocol-image-link')).toBeFocused()
	await page.keyboard.press('Shift+G')
	await expect(pane.locator('.agent-dock-agent-list')).toHaveAttribute('data-layout', 'by-project')
	await page.keyboard.press('g')
	await expect(pane.locator('.agent-dock-agent-list')).toHaveAttribute('data-layout', 'by-state')
	await expect(agent('service-protocol-image-link')).toBeFocused()
	await expect(agents).toHaveCount(9)
	// The switch is reachable by Tab too: pressed buttons in a named group.
	const project = pane.getByRole('button', { name: 'project' })
	await project.focus()
	await page.keyboard.press('Enter')
	await expect(project).toHaveAttribute('aria-pressed', 'true')
	await expect(project).toBeFocused()
	expect(await terminalWrites(page)).toBe(0)
})

test('the header says each source on its own; the row keeps no dot', async ({ page }) => {
	const { rail, pane } = await openOverview(page)
	await rail.locator('.agent-dock-agents-entry').click()
	const sources = pane.getByRole('group', { name: 'Sources' }).getByRole('img')
	await expect(sources).toHaveCount(2)
	await expect(sources.nth(0)).toHaveAccessibleName('Okena connected')
	await expect(sources.nth(1)).toHaveAccessibleName('Helm terminals connected')
	await expect(sources.nth(0)).toHaveAttribute('data-tone', 'success')
	await expect(pane.locator('.agent-dock-sources')).toHaveText(/Okena\s*·?\s*Helm terminals/)
	await expect(rail.locator('.agent-dock-dot')).toHaveCount(0)

	// Okena down: its dot red with since when; Helm's stays green; the row keeps its note.
	await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.emitScenario('agents-okena-down'))
	await expect(sources.nth(0)).toHaveAttribute('data-tone', 'danger')
	await expect(sources.nth(0)).toHaveAccessibleName(/^Okena unreachable since \d\d:\d\d$/)
	await expect(sources.nth(0)).toHaveAttribute('title', /^Okena unreachable since /)
	await expect(sources.nth(1)).toHaveAttribute('data-tone', 'success')
	await expect(rail).toContainText('Okena unreachable')

	// Helm's hub not answered yet: neutral, "connecting…"; Okena's agents stay.
	await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.emitScenario('agents-helm-connecting'))
	await expect(sources.nth(1)).toHaveAccessibleName('Helm terminals connecting…')
	await expect(sources.nth(1)).toHaveAttribute('data-tone', 'neutral')
	await expect(sources.nth(0)).toHaveAccessibleName('Okena connected')

	// Narrow: only the dots, their words still their names.
	await page.setViewportSize({ width: 600, height: 820 })
	await expect(pane.locator('.agent-dock-source-name').first()).toBeHidden()
	await expect(pane.locator('.agent-dock-source .agent-dock-dot')).toHaveCount(2)
	await expect(pane.locator('.agent-dock-source .agent-dock-dot').first()).toBeVisible()
	await expect(sources.nth(1)).toHaveAccessibleName('Helm terminals connecting…')
})

test('an agent whose background shell still runs reads background with "1 shell" and opens its turn', async ({
	page,
}) => {
	const { rail, pane, agent } = await openOverview(page)
	await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.emitScenario('background-shell'))
	await rail.locator('.agent-dock-agents-entry').click()
	const row = agent('service-protocol-image-link')
	await expect(row).toHaveAttribute('data-standing', 'background')
	await expect(row).toHaveAttribute('aria-label', /^service-protocol-image-link, background 2m, Okena, .*1 shell/)
	await expect(pane.getByRole('heading', { level: 3 })).toHaveText(['Background'])
	await row.click()
	await expect(pane).toHaveAttribute('aria-label', /^Turn ended, service-protocol-image-link/)
	await expect(pane.locator('.agent-dock-facts')).toContainText('Background work was still running.')
})

test('rows are one roving list: ↑ ↓ Home End move, Enter opens the item or the agent detail, Esc goes back to its row', async ({
	page,
}) => {
	const { pane, agents, agent } = await openOverviewByKeys(page)
	// By project (G): the order below is the project grouping's.
	await page.keyboard.press('g')
	await expect(pane.locator('.agent-dock-agent-list')).toHaveAttribute('data-layout', 'by-project')
	await expect(agents.first()).toBeFocused()
	await page.keyboard.press('ArrowDown')
	await expect(agents.nth(1)).toBeFocused()
	await expect(agents.nth(1)).toHaveAttribute('tabindex', '0')
	await expect(agents.first()).toHaveAttribute('tabindex', '-1')
	await page.keyboard.press('End')
	await expect(agents.last()).toBeFocused()
	await page.keyboard.press('Home')
	await expect(agents.first()).toBeFocused()

	// An agent that owes Jakub a reply opens its item (the turn pane).
	for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowDown')
	await expect(agent('repair-done-still-out-of-service')).toBeFocused()
	await page.keyboard.press('Enter')
	await expect(pane).toHaveAttribute('aria-label', /^Turn ended, repair-done-still-out-of-service/)
	await page.keyboard.press('Escape')
	await expect(agent('repair-done-still-out-of-service')).toBeFocused()

	// A read agent opens its detail: state and where in the header, the full message read live.
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('Enter')
	await expect(pane).toHaveAttribute('aria-label', 'Agent, service-protocol-image-link, JVS')
	await expect(pane).toBeFocused()
	await expect(pane.locator('.agent-dock-title-state')).toHaveText('read 25m')
	// Its source leads as the link to its terminal (⌘O; the key hint is aria-hidden).
	await expect(pane.locator('.agent-dock-title-project').first()).toHaveText(/^Okena ↗\s*⌘O · worktree · PR #953$/)
	await expect(pane.locator('.agent-dock-md')).toContainText('Testy prošly; čeká to na review.')
	await expect(pane.locator('.agent-dock-md strong, .agent-dock-md code').first()).toBeVisible()
	expect((await fixtureCalls(page)).reads).toEqual(['storybook:term-jvs-image'])
	await expect(pane.getByRole('textbox', { name: 'Reply' })).toBeEnabled()

	// ‹ › (arrows on the pane) step agents in list order; one that owes Jakub offers its item.
	await page.keyboard.press('ArrowLeft')
	await expect(pane).toHaveAttribute('aria-label', 'Agent, repair-done-still-out-of-service, JVS')
	await expect(pane.getByRole('button', { name: 'Open reply' })).toBeVisible()
	await expect(pane.getByRole('textbox', { name: 'Reply' })).toHaveCount(0)
	await page.keyboard.press('ArrowRight')
	await page.keyboard.press('ArrowRight')
	await expect(pane).toHaveAttribute('aria-label', 'Agent, rental-calendar-overlap, JVS')
	await expect(pane.getByRole('textbox', { name: 'Reply' })).toBeDisabled()
	await expect(pane.locator('.agent-dock-foot-note')).toContainText('State unknown: reply in the terminal')

	// Esc: back to the list, on the row of the agent shown.
	await page.keyboard.press('Escape')
	await expect(agent('rental-calendar-overlap')).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(pane).toHaveCount(0)
	expect(await terminalWrites(page)).toBe(0)
	expect((await fixtureCalls(page)).acts).toEqual([])
})

test('a reply from the agent detail: CAS on the message shown, Sending… then ✓ replied, the field clears', async ({
	page,
}) => {
	const { pane, agent } = await openOverviewByKeys(page)
	await agent('service-protocol-image-link').focus()
	await page.keyboard.press('Enter')
	await expect(pane.locator('.agent-dock-md')).toContainText('Testy prošly')
	// A key typed at the pane starts the reply.
	await page.keyboard.type('Díky, mergni to.')
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await expect(reply).toBeFocused()
	await expect(reply).toHaveValue('Díky, mergni to.')
	await page.keyboard.press('Meta+Enter')
	await expect(pane.locator('.agent-dock-foot-note')).toContainText(/Sending…|✓ replied/)
	await expect(pane.locator('.agent-dock-foot-note')).toContainText('✓ replied')
	await expect(reply).toHaveValue('')
	const { prompts } = await fixtureCalls(page)
	expect(prompts).toEqual([
		{
			session: 'storybook:term-jvs-image',
			text: 'Díky, mergni to.',
			sessionId: 'sess-jvs-image',
			assistantUuid: 'image-a1',
			queue: true,
		},
	])
	expect(await terminalWrites(page)).toBe(0)
})

test('a reply to a working agent from its detail is queued for after its turn and reads queued, never unconfirmed', async ({
	page,
}) => {
	const { pane, agent } = await openOverviewByKeys(page)
	await agent('Psyon').focus()
	await page.keyboard.press('Enter')
	await expect(pane).toHaveAttribute('aria-label', /^Agent, Psyon/)
	await expect(pane.locator('.agent-dock-title-state')).toHaveText(/^working/)
	const reply = pane.getByRole('textbox', { name: 'Reply' })
	await expect(reply).toBeEnabled()
	await expect(pane.locator('.agent-dock-foot-note')).toHaveText('Queued for Psyon: typed in once it stops working')
	await page.keyboard.type('Pak ještě spusť testy.')
	await page.keyboard.press('Meta+Enter')
	const note = pane.locator('.agent-dock-foot-note')
	await expect(note).toHaveText('Queued for Psyon')
	await expect(reply).toHaveValue('')
	// Past the confirmation window while the agent still works: still queued, not amber.
	await page.waitForTimeout(600)
	await expect(note).toHaveText('Queued for Psyon')
	await expect(note.locator('[data-tone="warn"]')).toHaveCount(0)
	// A held reply never blocks another: the source queues them in order.
	await expect(reply).toBeEnabled()
	await page.keyboard.type('A pak commitni.')
	await page.keyboard.press('Meta+Enter')
	await expect(note).toHaveText('Queued for Psyon')
	const { prompts } = await fixtureCalls(page)
	expect(prompts).toEqual([
		expect.objectContaining({ session: expect.any(String), text: 'Pak ještě spusť testy.', queue: true }),
		expect.objectContaining({ session: expect.any(String), text: 'A pak commitni.', queue: true }),
	])
	expect(await terminalWrites(page)).toBe(0)
})

test('a click on a row opens the agent without taking the keys from the terminal', async ({ page }) => {
	const { input, rail, pane, agent } = await openOverview(page)
	await input.focus()
	await rail.locator('.agent-dock-agents-entry').click()
	await agent('inbox-triage').click()
	await expect(pane).toHaveAttribute('aria-label', 'Agent, inbox-triage, vault')
	await expect(input).toBeFocused()
	await expect(pane.locator('.agent-dock-title-state')).toHaveText('background 9m')
	// A pointer on an asking agent opens its question.
	await rail.locator('.agent-dock-agents-entry').click()
	await agent('invoice-pdf-export').click()
	await expect(pane).toHaveAttribute('aria-label', /^Question, invoice-pdf-export/)
	await expect(input).toBeFocused()
	expect(await terminalWrites(page)).toBe(0)
})

test('a live update that moves the focused agent to another group keeps the keys on that agent', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 820 })
	await page.goto(harness)
	await expect(page.locator('#agent-dock .agent-dock-row')).toBeVisible()
	// By state (the default) re-mounts a row whose standing changes (a new group).
	await page.evaluate(() => window.__helmWorkspaceFixture?.agentDock?.emitScenario('agents-overview'))
	const pane = page.locator('.agent-dock-pane')
	const agent = (name: string) =>
		pane.locator('.agent-dock-agent').filter({ has: page.locator('.agent-dock-agent-name', { hasText: name }) })
	await page.locator('.term-holder.active .xterm-helper-textarea').focus()
	await page.keyboard.press('Meta+Shift+KeyJ')
	await page.keyboard.press('End')
	await page.keyboard.press('Enter')
	await agent('repair-done-still-out-of-service').focus()
	await expect(agent('repair-done-still-out-of-service')).toHaveAttribute('data-standing', 'reply-waiting')
	// Its turn is acked elsewhere: the agent moves from Reply waiting to Read.
	await page.evaluate(async () => {
		const fixture = window.__helmWorkspaceFixture?.agentDock
		if (!fixture) return
		let latest: import('../src/agent-dock/model').AgentDockSnapshot | null = null
		const off = fixture.api.onSnapshot(next => {
			latest = next
		})
		off()
		const snap = latest as import('../src/agent-dock/model').AgentDockSnapshot | null
		const turn = snap?.items.find(item => item.kind === 'turn' && item.state === 'open')
		if (turn) await fixture.api.ack(turn.id)
	})
	await expect(agent('repair-done-still-out-of-service')).toHaveAttribute('data-standing', 'read')
	await expect(agent('repair-done-still-out-of-service')).toBeFocused()
})

test('at 900px the agent detail still says where the agent runs', async ({ page }) => {
	await page.setViewportSize({ width: 900, height: 820 })
	await page.goto('/iframe.html?id=views-agent-dock-agents-pane--agent-detail-narrow&viewMode=story')
	const pane = page.locator('.agent-dock-pane')
	await expect(pane).toHaveAttribute('aria-label', 'Agent, service-protocol-image-link, JVS')
	await expect(pane.locator('.agent-dock-title-where')).toBeVisible()
	await expect(pane.locator('.agent-dock-title-where')).toHaveText(/^Okena ↗\s*⌘O · worktree · PR #953$/)
	await expect(pane.locator('.agent-dock-reveal-link')).toBeVisible()
})
