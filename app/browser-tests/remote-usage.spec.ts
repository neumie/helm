import { expect, test } from '@playwright/test'
import { openRemoteDestination } from './remote-navigation.js'

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 844 }

for (const [name, viewport] of [
	['phone', PHONE],
	['desktop', DESKTOP],
] as const) {
	test(`navigation menu offers Sessions and Usage, and only Usage reads provider limits (${name})`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport)
		await page.goto('/iframe.html?id=views-helm-remote--usage&viewMode=story')

		await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
		const navigation = page.getByRole('dialog', { name: 'Navigation' })
		const items = navigation.getByRole('navigation', { name: 'Remote sections' })
		await expect(items.getByRole('button')).toHaveText(['Sessions', 'Usage'])
		const sessions = items.getByRole('button', { name: 'Sessions', exact: true })
		const usage = items.getByRole('button', { name: 'Usage', exact: true })
		await expect(sessions).toHaveAttribute('aria-current', 'page')
		for (const target of [sessions, usage]) {
			const box = await target.boundingBox()
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(48)
			expect(box?.width ?? 0).toBeGreaterThanOrEqual(Math.min(viewport.width * 0.84, 320) - 32)
		}
		await usage.click()

		const panel = page.getByRole('region', { name: 'Usage' })
		await expect(panel).toBeVisible()
		await expect(page.getByPlaceholder('Search live conversations')).toBeHidden()
		await expect(page.getByRole('navigation', { name: 'Live sessions' })).toBeHidden()
		await expect(panel.getByRole('heading', { name: 'Claude Code' })).toBeVisible()
		await expect(panel.getByRole('heading', { name: 'Codex' })).toBeVisible()
		await expect(panel.getByText('Max', { exact: true })).toBeVisible()
		await expect(panel.getByText('Pro', { exact: true })).toBeVisible()
		await expect(panel.getByRole('img', { name: '5-hour: 23% used, resets in 2h 50m' })).toBeVisible()
		await expect(panel.getByRole('img', { name: 'Weekly: 14% used, resets in 4 days' })).toBeVisible()
		await expect(panel.getByRole('img', { name: 'Weekly: 91% used, resets in 3 days' })).toBeVisible()
		await expect(panel.getByText('From this Mac’s last Codex record · 5h ago')).toBeVisible()

		await openRemoteDestination(page, 'Sessions')
		await expect(page.getByPlaceholder('Search live conversations')).toBeVisible()
		await expect(page.getByRole('region', { name: 'Usage' })).toBeHidden()
	})
}

test('the top-left menu replaces the bottom bar and remains reachable inside a conversation', async ({ page }) => {
	await page.setViewportSize(PHONE)
	await page.goto('/iframe.html?id=views-helm-remote--usage&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.locator('.remote-conversation')).toBeVisible()
	await expect(page.locator('.remote-tabs')).toHaveCount(0)
	const trigger = page.getByRole('button', { name: 'Open navigation', exact: true })
	await expect(trigger).toBeVisible()
	const composer = await page.locator('.remote-composer').boundingBox()
	expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual(PHONE.height)

	await openRemoteDestination(page, 'Usage')
	await expect(page.getByRole('region', { name: 'Usage' })).toBeVisible()
	await expect(page.locator('.remote-conversation')).toHaveCount(0)
	await openRemoteDestination(page, 'Sessions')
	await expect(page.getByRole('navigation', { name: 'Live sessions' })).toBeVisible()
})

test('a spent window fills further than an untouched one and the pace mark tracks the window', async ({ page }) => {
	await page.setViewportSize(PHONE)
	await page.goto('/iframe.html?id=views-helm-remote--usage&viewMode=story')
	await openRemoteDestination(page, 'Usage')

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
	await openRemoteDestination(page, 'Usage')

	const panel = page.getByRole('region', { name: 'Usage' })
	await expect(panel.getByText('Sign in to Claude Code on this Mac to show its limits.')).toBeVisible()
	await expect(panel.locator('.remote-usage-bar')).toHaveCount(0)
	await expect(panel.getByText('%')).toHaveCount(0)
})
