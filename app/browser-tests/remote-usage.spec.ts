import { expect, test } from '@playwright/test'

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 844 }

for (const [name, viewport] of [
	['phone', PHONE],
	['desktop', DESKTOP],
] as const) {
	test(`navigation offers exactly Sessions and Usage, and only Usage reads provider limits (${name})`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport)
		await page.goto('/iframe.html?id=views-helm-remote--usage&viewMode=story')

		const tabs = page.getByRole('navigation', { name: 'Remote sections' })
		await expect(tabs.getByRole('button')).toHaveText(['Sessions', 'Usage'])
		const sessions = tabs.getByRole('button', { name: 'Sessions', exact: true })
		const usage = tabs.getByRole('button', { name: 'Usage', exact: true })
		await expect(sessions).toHaveAttribute('aria-current', 'page')
		await expect(page.getByPlaceholder('Search live conversations')).toBeVisible()
		await expect(page.getByRole('region', { name: 'Usage' })).toBeHidden()

		// Both destinations must stay comfortably tappable, not just visible.
		for (const target of [sessions, usage]) {
			const box = await target.boundingBox()
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
		}
		// The bar belongs at the foot of the viewport, not stacked under the last row.
		const bar = await tabs.boundingBox()
		expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeGreaterThan(viewport.height - 48)

		await usage.click()
		await expect(usage).toHaveAttribute('aria-current', 'page')
		await expect(sessions).not.toHaveAttribute('aria-current', 'page')
		const panel = page.getByRole('region', { name: 'Usage' })
		await expect(panel).toBeVisible()
		// The session list is a separate destination, not something layered underneath.
		await expect(page.getByPlaceholder('Search live conversations')).toBeHidden()
		await expect(page.getByRole('navigation', { name: 'Live sessions' })).toBeHidden()

		await expect(panel.getByRole('heading', { name: 'Claude Code' })).toBeVisible()
		await expect(panel.getByRole('heading', { name: 'Codex' })).toBeVisible()
		await expect(panel.getByText('Max', { exact: true })).toBeVisible()
		await expect(panel.getByText('Pro', { exact: true })).toBeVisible()
		await expect(panel.getByRole('img', { name: '5-hour: 23% used, resets in 2h 50m' })).toBeVisible()
		await expect(panel.getByRole('img', { name: 'Weekly: 14% used, resets in 4 days' })).toBeVisible()
		await expect(panel.getByRole('img', { name: 'Weekly: 91% used, resets in 3 days' })).toBeVisible()
		// A local snapshot must never be presented as a live reading.
		await expect(panel.getByText('From this Mac’s last Codex record · 5h ago')).toBeVisible()

		await sessions.click()
		await expect(page.getByPlaceholder('Search live conversations')).toBeVisible()
		await expect(page.getByRole('region', { name: 'Usage' })).toBeHidden()
	})
}

test('a spent window fills further than an untouched one and the pace mark tracks the window', async ({ page }) => {
	await page.setViewportSize(PHONE)
	await page.goto('/iframe.html?id=views-helm-remote--usage&viewMode=story')
	await page.getByRole('navigation', { name: 'Remote sections' }).getByRole('button', { name: 'Usage' }).click()

	const bars = page.getByRole('region', { name: 'Usage' }).locator('.remote-usage-bar')
	await expect(bars).toHaveCount(3)
	const width = async (index: number) => {
		const box = await bars.nth(index).locator('.remote-usage-fill').boundingBox()
		return box?.width ?? 0
	}
	expect(await width(2)).toBeGreaterThan(await width(0))
	expect(await width(0)).toBeGreaterThan(await width(1))
	await expect(bars.nth(0).locator('.remote-usage-pace')).toHaveCount(1)
})

test('a provider that cannot be read says so instead of showing a percentage', async ({ page }) => {
	await page.setViewportSize(PHONE)
	await page.goto('/iframe.html?id=views-helm-remote--usage-signed-out&viewMode=story')
	await page.getByRole('navigation', { name: 'Remote sections' }).getByRole('button', { name: 'Usage' }).click()

	const panel = page.getByRole('region', { name: 'Usage' })
	await expect(panel.getByText('Sign in to Claude Code on this Mac to show its limits.')).toBeVisible()
	await expect(panel.locator('.remote-usage-bar')).toHaveCount(0)
	await expect(panel.getByText('%')).toHaveCount(0)
})
