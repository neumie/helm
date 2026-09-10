import { type Page, expect, test } from '@playwright/test'

test('native Remote settings renders the paired-device projection and explicit revoke action', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--remote-available&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Remote', exact: true, level: 1 })).toBeVisible()
	await expect(page.getByText('https://remote.example.test')).toBeVisible()
	await expect(page.getByText('Maya’s phone')).toBeVisible()
	await expect(page.getByText('Expired — no active access')).toBeVisible()
	await expect(page.getByText('Revoked — no active access')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(1)
	await expect(page.getByRole('button', { name: 'Revoke again', exact: true })).toHaveCount(1)
})

test('native Remote pairing presentation hides its secret DOM without claiming revocation', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--remote-pairing-code&viewMode=story')
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
	await expect(page.getByLabel('Pairing code ABC-123')).toBeVisible()
	await page.getByRole('button', { name: 'Hide code' }).click()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(1)
	await expect(page.getByRole('button', { name: 'Pair device', exact: true })).toBeFocused()
})

test('native Remote unavailable state offers retry and never renders pairing presentation', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--remote-unavailable&viewMode=story')
	await expect(page.getByText('Helm Remote unavailable')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Retry connection' })).toBeVisible()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
})

declare global {
	interface Window {
		__nativeRemote?: {
			pairCalls: number
			statusCalls: number
			revokeCalls: number
			deferPair: boolean
			failRevoke: boolean
			resolvePair?: () => void
			addDevice: () => void
		}
	}
}

async function setNativeControl(page: Page, key: 'deferPair' | 'failRevoke', value: boolean) {
	await page.evaluate(
		({ key, value }) => {
			const state = window.__nativeRemote
			if (!state) throw new Error('Native fixture is missing')
			state[key] = value
		},
		{ key, value },
	)
}

async function completeNativePair(page: Page) {
	await page.evaluate(() => {
		const resolve = window.__nativeRemote?.resolvePair
		if (!resolve) throw new Error('No pending pairing request')
		resolve()
	})
}

async function openRemote(page: Page) {
	await page.goto('/iframe.html?id=views-sidebar--remote-navigation&viewMode=story')
	await page.locator('.list-toolbar').getByRole('button', { name: 'More' }).click()
	await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
	await page.getByRole('button', { name: /^Remote/ }).click()
	await expect(page.getByRole('heading', { name: 'Remote', level: 1 })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Pair device', exact: true })).toBeEnabled()
}

test('real Settings navigation issues once, refreshes devices without claiming success, and hides only presentation', async ({
	page,
}) => {
	await page.clock.install()
	await openRemote(page)
	await setNativeControl(page, 'deferPair', true)
	await page.getByRole('button', { name: 'Pair device', exact: true }).evaluate(button => {
		;(button as HTMLButtonElement).click()
		;(button as HTMLButtonElement).click()
	})
	expect(await page.evaluate(() => window.__nativeRemote?.pairCalls)).toBe(1)
	await completeNativePair(page)
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
	await page.evaluate(() => window.__nativeRemote?.addDevice())
	await page.clock.runFor(5_001)
	await expect(page.getByText('New tablet', { exact: true })).toBeVisible()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
	await page.getByRole('button', { name: 'Hide code' }).click()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
	expect(await page.evaluate(() => window.__nativeRemote?.revokeCalls)).toBe(0)
	await expect(page.getByRole('button', { name: 'Pair device', exact: true })).toBeFocused()
})

test('expiry removes secret DOM without issuing another pairing request', async ({ page }) => {
	await page.clock.install()
	await openRemote(page)
	await page.getByRole('button', { name: 'Pair device', exact: true }).click()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
	await page.clock.fastForward(120_001)
	await expect(page.getByText('Pairing code expired', { exact: true })).toBeVisible()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
	expect(await page.evaluate(() => window.__nativeRemote?.pairCalls)).toBe(1)
})

test('Back fences a pending presentation even when Remote is opened again before it completes', async ({ page }) => {
	await openRemote(page)
	await setNativeControl(page, 'deferPair', true)
	await page.getByRole('button', { name: 'Pair device', exact: true }).click()
	await page.getByRole('button', { name: 'Back', exact: true }).click()
	await page.getByRole('button', { name: /^Remote/ }).click()
	await expect(page.getByRole('heading', { name: 'Remote', level: 1 })).toBeVisible()
	await completeNativePair(page)
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Pair device', exact: true })).toBeEnabled()
	expect(await page.evaluate(() => window.__nativeRemote?.pairCalls)).toBe(1)
})

test('Back clears an already displayed code and returning never restores it', async ({ page }) => {
	await openRemote(page)
	await page.getByRole('button', { name: 'Pair device', exact: true }).click()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
	await page.getByRole('button', { name: /^Remote/ }).click()
	await expect(page.getByRole('button', { name: 'Pair device', exact: true })).toBeEnabled()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
	expect(await page.evaluate(() => window.__nativeRemote?.pairCalls)).toBe(1)
})

test('failed revoke retains retry after memory-only revoked polling and after reopening Remote', async ({ page }) => {
	await page.clock.install()
	await openRemote(page)
	await setNativeControl(page, 'failRevoke', true)
	const row = page.locator('.remote-device-row').filter({ hasText: 'Maya’s phone' })
	await row.getByRole('button', { name: 'Revoke', exact: true }).click()
	await expect(page.getByText('Revocation was not saved. Access may still be active.', { exact: true })).toBeVisible()
	await page.clock.runFor(5_001)
	await expect(row.getByText('Revocation not confirmed — retry', { exact: true })).toBeVisible()
	await expect(row.getByRole('button', { name: 'Retry revoke', exact: true })).toBeEnabled()
	await page.getByRole('button', { name: 'Back', exact: true }).click()
	await page.getByRole('button', { name: /^Remote/ }).click()
	await expect(row.getByRole('button', { name: 'Revoke again', exact: true })).toBeEnabled()
	await setNativeControl(page, 'failRevoke', false)
	await row.getByRole('button', { name: 'Revoke again', exact: true }).click()
	await expect(row.getByText('Revoked — no active access', { exact: true })).toBeVisible()
	expect(await page.evaluate(() => window.__nativeRemote?.revokeCalls)).toBe(2)
})

test('Hide fences a pending New code response without stranding mutation admission', async ({ page }) => {
	await openRemote(page)
	await page.getByRole('button', { name: 'Pair device', exact: true }).click()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toBeVisible()
	await setNativeControl(page, 'deferPair', true)
	await page.getByRole('button', { name: 'New code', exact: true }).click()
	await page.getByRole('button', { name: 'Hide code', exact: true }).click()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
	await completeNativePair(page)
	await expect(page.getByRole('button', { name: 'Pair device', exact: true })).toBeEnabled()
	await expect(page.getByRole('img', { name: 'Pairing QR code' })).toHaveCount(0)
	expect(await page.evaluate(() => window.__nativeRemote?.pairCalls)).toBe(2)
})
