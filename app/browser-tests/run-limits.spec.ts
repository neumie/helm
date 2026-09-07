import { expect, test } from '@playwright/test'

test('Settings lists Run limits with a truthful lane summary', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--settings&viewMode=story')
	await expect(page.getByRole('button', { name: /Run limits/ })).toBeVisible()
	await expect(page.getByText('2 agents · 1 loop', { exact: true })).toBeVisible()
})

test('Run limits edit and save both budgets through the real Settings store', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--run-limits-settings&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Run limits', exact: true })).toBeVisible()
	const agents = page.getByRole('spinbutton', { name: 'Agent runs' })
	const loops = page.getByRole('spinbutton', { name: 'Loop runs' })
	await expect(agents).toHaveValue('2')
	await expect(loops).toHaveValue('1')
	await agents.fill('25')
	await page
		.getByRole('tablist', { name: 'Agent runs', exact: true })
		.getByRole('tab', { name: 'Limited', exact: true })
		.click()
	await expect(agents).toHaveValue('25')
	await loops.fill('3')
	await page.getByRole('button', { name: 'Save changes', exact: true }).click()
	await expect
		.poll(() =>
			page.evaluate(() => {
				const body = (window as Window & { __updatedConfigBody?: { solver?: object } }).__updatedConfigBody
				return body?.solver
			}),
		)
		.toMatchObject({ concurrency: 25, loopConcurrency: 3 })
	await expect(page.getByText('Restart required', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'Restart', exact: true }).click()
	await expect
		.poll(() => page.evaluate(() => (window as Window & { __restartDaemonCalls?: number }).__restartDaemonCalls))
		.toBe(1)
})

for (const lanes of [['Agent runs'], ['Loop runs'], ['Agent runs', 'Loop runs']]) {
	test(`Unlimited saves and reopens independently: ${lanes.join(', ')}`, async ({ page }, testInfo) => {
		await page.goto('/iframe.html?id=views-sidebar--run-limits-settings&viewMode=story')
		for (const lane of lanes) {
			await page.getByRole('tablist', { name: lane, exact: true }).getByRole('tab', { name: 'Unlimited' }).click()
			await expect(page.getByRole('spinbutton', { name: lane, exact: true })).toHaveCount(0)
		}
		const concurrency = lanes.includes('Agent runs') ? null : 2
		const loopConcurrency = lanes.includes('Loop runs') ? null : 1
		await page.getByRole('button', { name: 'Save changes', exact: true }).click()
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as Window & { __updatedConfigBody?: { solver?: object } }).__updatedConfigBody?.solver,
				),
			)
			.toMatchObject({ concurrency, loopConcurrency })
		await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0)
		await page.screenshot({ path: testInfo.outputPath('run-limits.png') })
		await page.getByRole('button', { name: 'Back', exact: true }).click()
		const summary = `${concurrency === null ? 'Unlimited' : concurrency} agents · ${loopConcurrency === null ? 'Unlimited loops' : '1 loop'}`
		await expect(page.getByText(summary, { exact: true })).toBeVisible()
		await page.getByRole('button', { name: /Run limits/ }).click()
		for (const lane of lanes) {
			const picker = page.getByRole('tablist', { name: lane, exact: true })
			await expect(picker.getByRole('tab', { name: 'Unlimited' })).toHaveAttribute('aria-selected', 'true')
			await picker.getByRole('tab', { name: 'Limited', exact: true }).click()
			await expect(page.getByRole('spinbutton', { name: lane, exact: true })).toHaveValue(
				lane === 'Agent runs' ? '2' : '1',
			)
		}
	})
}
