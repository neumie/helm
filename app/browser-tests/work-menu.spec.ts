import { expect, test } from '@playwright/test'

test('Work keeps organization choices in the structured More menu', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--work-list&viewMode=story')

	const toolbar = page.locator('.list-toolbar')
	await expect(toolbar).toBeVisible({ timeout: 15_000 })
	await expect(toolbar.getByRole('button', { name: 'New item' })).toBeVisible()
	await expect(toolbar.getByRole('button', { name: /Organize items/ })).toHaveCount(0)

	const more = toolbar.getByRole('button', { name: 'More' })
	await more.click()
	let menu = page.getByRole('menu', { name: 'More' })
	await expect(menu).toBeVisible()
	await expect(menu.locator('.menu-item-active')).toHaveCount(0)
	await expect(menu.locator('.menu-section-label')).toHaveText(['Work', 'View', 'Profiles'])
	await expect(menu.locator('.menu-separator')).toHaveCount(1)
	expect(await menu.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true)

	const schedules = menu.getByRole('menuitem', { name: 'Scheduled runs' })
	const archive = menu.getByRole('menuitem', { name: /^Archive/ })
	const poll = menu.getByRole('menuitem', { name: 'Poll now' })
	const grouped = menu.getByRole('menuitemcheckbox', { name: 'Group by project' })
	const settings = menu.getByRole('menuitem', { name: 'Settings' })
	await expect(schedules).toBeVisible()
	await expect(archive).toBeVisible()
	await expect(poll).toBeVisible()
	await expect(grouped).toHaveAttribute('aria-checked', 'false')
	await expect(menu.getByRole('menuitem', { name: 'Flat list' })).toHaveCount(0)
	await expect(settings).toBeVisible()

	const entryOrder = await menu.locator('.menu-item-label').allTextContents()
	expect(entryOrder.slice(0, 5)).toEqual(['Scheduled runs', 'Archive', 'Poll now', 'Pause queue', 'Group by project'])
	expect(entryOrder.at(-1)).toBe('Settings')
	const labelLeftEdges = await menu
		.locator('.menu-item-label')
		.evaluateAll(labels => labels.map(label => label.getBoundingClientRect().left))
	expect(Math.max(...labelLeftEdges) - Math.min(...labelLeftEdges)).toBeLessThan(0.5)

	await grouped.click()
	await expect(menu).toHaveCount(0)
	await expect(page.locator('.item-project-group-head').first()).toBeVisible()
	await expect.poll(() => page.evaluate(() => localStorage.getItem('helm.sidebar.organization'))).toBe('project')

	await more.click()
	menu = page.getByRole('menu', { name: 'More' })
	await expect(menu.getByRole('menuitemcheckbox', { name: 'Group by project' })).toHaveAttribute('aria-checked', 'true')
})

test('Work More reports active scheduled runs without permanent chrome', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--work-list-scheduled-running&viewMode=story')

	const more = page.locator('.list-toolbar').getByRole('button', { name: 'More, 1 scheduled run running' })
	await expect(more).toBeVisible({ timeout: 15_000 })
	await expect(more.locator('.menu-trigger-badge')).toHaveText('1')
	await more.click()
	const schedules = page.getByRole('menu', { name: /More/ }).getByRole('menuitem', { name: /Scheduled runs/ })
	await expect(schedules.locator('.menu-item-meta')).toHaveText('1 running')
})

test('Work More opens Scheduled runs for the active profile', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--new-item-navigation&viewMode=story')

	const more = page.locator('.list-toolbar').getByRole('button', { name: 'More' })
	await expect(more).toBeVisible({ timeout: 15_000 })
	await more.click()
	await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Scheduled runs' }).click()

	await expect(page.getByRole('heading', { name: 'Scheduled runs' })).toBeVisible()
	await expect(page.getByText('Runs belong to')).toBeVisible()
	await expect(page.getByText('Work', { exact: true })).toBeVisible()
	const running = page.locator('.scheduled-running-row')
	await expect(running).toHaveCount(1)
	await expect(running).toContainText('Morning checks')
	await expect(running).toContainText('Running')
})

test('Scheduled runs refreshes an active state while its count stays unchanged', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--scheduled-runs&viewMode=story')
	const running = page.locator('.scheduled-running-row')
	await expect(running).toContainText('Running', { timeout: 15_000 })
	await page.evaluate(() => {
		;(window as typeof window & { __activeScheduledState?: string }).__activeScheduledState = 'launching'
	})
	await expect(running).toContainText('Starting', { timeout: 8_000 })
})

test('scheduling can be enabled from the Scheduled runs page', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--new-item-navigation&viewMode=story')

	const more = page.locator('.list-toolbar').getByRole('button', { name: 'More' })
	await expect(more).toBeVisible({ timeout: 15_000 })
	await more.click()
	await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Scheduled runs' }).click()

	await page.getByRole('button', { name: 'Enable', exact: true }).click()
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as typeof window & { __updatedConfigBody?: { scheduledRuns?: { enabled?: boolean } } })
						.__updatedConfigBody?.scheduledRuns?.enabled ?? false,
			),
		)
		.toBe(true)
	await page.getByRole('button', { name: 'Restart now' }).click()
	await expect
		.poll(() =>
			page.evaluate(() => (window as typeof window & { __restartDaemonCalls?: number }).__restartDaemonCalls ?? 0),
		)
		.toBe(1)
})

test('a successful manual schedule action clears a prior error and reports overlap truthfully', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--new-item-navigation&viewMode=story')
	const more = page.locator('.list-toolbar').getByRole('button', { name: 'More' })
	await expect(more).toBeVisible({ timeout: 15_000 })
	await more.click()
	await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Scheduled runs' }).click()
	await page
		.locator('.scheduled-definition-row:not(.scheduled-running-row)')
		.filter({ hasText: 'Morning checks' })
		.click()
	await page.evaluate(() => {
		;(window as typeof window & { __failNextScheduledAction?: boolean }).__failNextScheduledAction = true
	})

	await page.getByRole('button', { name: 'Run now' }).click()
	await expect(page.getByText('Validation failed', { exact: true })).toBeVisible()

	await page.getByRole('button', { name: 'Run now' }).click()
	await expect(page.getByText('Validation failed', { exact: true })).toBeHidden()
	await expect(page.getByText('skipped overlap', { exact: true })).toBeVisible()
	await expect(page.getByText('Run not started', { exact: true })).toBeVisible()
})

test('a created schedule appears when the editor returns to definitions', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--new-item-navigation&viewMode=story')

	const more = page.locator('.list-toolbar').getByRole('button', { name: 'More' })
	await expect(more).toBeVisible({ timeout: 15_000 })
	await more.click()
	await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Scheduled runs' }).click()
	await page.getByRole('button', { name: 'New', exact: true }).click()

	await page.getByLabel('Name').fill('Weekly stewardship')
	await page.getByLabel('Prompt').fill('Review open maintenance work and resolve the highest-priority safe item.')
	await page.getByRole('button', { name: 'Create schedule' }).click()

	await expect(page.getByRole('heading', { name: 'Scheduled runs' })).toBeVisible()
	await expect(page.getByRole('button', { name: /Weekly stewardship/ })).toBeVisible()
})
