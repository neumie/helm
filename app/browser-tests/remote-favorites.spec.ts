import { randomUUID } from 'node:crypto'
import { type Page, expect, test } from '@playwright/test'
import { hashScopedCapability } from '../../src/auth/scoped-capability.js'
import { RemoteFavorites } from '../../src/remote/favorites.js'
import { RemoteHost } from '../../src/remote/host.js'
import type { RemoteSnapshot } from '../../src/remote/protocol.js'

const TOKEN = 'f'.repeat(43)
async function setup(page: Page, origin: string) {
	const favorites = new RemoteFavorites()
	const host = new RemoteHost({
		origin,
		browserCapabilityHash: hashScopedCapability(TOKEN),
		favorites,
		now: () => 1000,
	})
	const targets: RemoteSnapshot['target'][] = []
	for (const label of ['Alpha', 'Bravo', 'Charlie']) {
		const target = { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 }
		targets.push(target)
		const enrollmentId = randomUUID()
		host.issueEnrollment({
			id: enrollmentId,
			capabilityHash: hashScopedCapability(TOKEN),
			scopeId: null,
			generation: 1,
		})
		const snapshot: RemoteSnapshot = {
			target,
			revision: 1,
			label,
			workspace: 'favorite fixture',
			model: null,
			activity: 'idle',
			capabilities: { prompt: true, interrupt: true, answer: false },
			messages: [],
			question: null,
			historyTruncated: false,
		}
		const response = await host.local.request('/exchange', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				'X-Helm-Enrollment': enrollmentId,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ protocol: 1, enrollmentId, snapshot, receipts: [] }),
		})
		expect(response.status).toBe(200)
	}
	let posts = 0
	let reject = false
	let hold: Promise<void> | undefined
	const attach = async (target: Page) => {
		await target.route('**/v1/**', async route => {
			const request = route.request()
			if (request.method() === 'POST' && request.url().endsWith('/v1/favorites')) {
				posts++
				if (hold) await hold
				if (reject) {
					await route.fulfill({
						status: 503,
						contentType: 'application/json',
						body: '{"error":"favorite_save_failed"}',
					})
					return
				}
			}
			const response = await host.browser.request(request.url(), {
				method: request.method(),
				headers: { ...request.headers(), Host: new URL(origin).host },
				...(request.postData() === null ? {} : { body: request.postData() }),
			})
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: await response.text(),
			})
		})
		await target.goto('/iframe.html?id=views-helm-remote--favorites-wire&viewMode=story')
		await expect(target.getByRole('button', { name: 'Favorite Alpha', exact: true })).toBeVisible()
	}
	await attach(page)
	return {
		host,
		favorites,
		targets,
		attach,
		posts: () => posts,
		reject: () => {
			reject = true
		},
		hold: () => {
			let release!: () => void
			hold = new Promise<void>(resolve => {
				release = resolve
			})
			return () => {
				hold = undefined
				release()
			}
		},
	}
}
const titles = (page: Page) => page.locator('.remote-session-row .remote-session-title')

test('favorites pin stably, synchronize across browser clients, and keep selection/search separate', async ({
	page,
	browser,
	baseURL,
}, testInfo) => {
	if (!baseURL) throw new Error('Missing test base URL')
	const f = await setup(page, baseURL)
	const context = await browser.newContext({ baseURL, viewport: testInfo.project.use.viewport })
	const second = await context.newPage()
	try {
		await f.attach(second)
		await expect(titles(page)).toHaveText(['Alpha', 'Bravo', 'Charlie'])
		await page.getByRole('button', { name: 'Favorite Charlie', exact: true }).click()
		await expect(page.getByRole('button', { name: 'Unfavorite Charlie', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true',
		)
		await expect(titles(page)).toHaveText(['Charlie', 'Alpha', 'Bravo'])
		await expect(titles(second)).toHaveText(['Charlie', 'Alpha', 'Bravo'])
		await expect(page.locator('.remote-conversation')).toHaveCount(0)
		await page.getByRole('button', { name: 'Favorite Bravo', exact: true }).focus()
		await page.keyboard.press('Space')
		await expect(titles(page)).toHaveText(['Bravo', 'Charlie', 'Alpha'])
		await expect(page.getByRole('button', { name: 'Unfavorite Bravo', exact: true })).toBeFocused()
		await page.getByRole('searchbox', { name: 'Search live conversations' }).fill('alpha')
		await expect(titles(page)).toHaveText(['Alpha'])
		await page.getByRole('searchbox', { name: 'Search live conversations' }).fill('')
		await page.screenshot({ path: testInfo.outputPath('favorites.png') })
		await page.getByRole('button', { name: 'Unfavorite Charlie', exact: true }).click()
		await expect(titles(second)).toHaveText(['Bravo', 'Alpha', 'Charlie'])
		await page.reload()
		await expect(titles(page)).toHaveText(['Bravo', 'Alpha', 'Charlie'])
		expect(f.posts()).toBe(3)
		const button = page.getByRole('button', { name: 'Unfavorite Bravo', exact: true })
		const bounds = await button.boundingBox()
		expect(bounds?.width).toBeGreaterThanOrEqual(44)
		expect(bounds?.height).toBeGreaterThanOrEqual(44)
	} finally {
		await context.close()
		f.host.revoke()
	}
})

test('failed favorite save is visible and not replayed or optimistically pinned', async ({ page, baseURL }) => {
	if (!baseURL) throw new Error('Missing test base URL')
	const f = await setup(page, baseURL)
	try {
		f.reject()
		await page.getByRole('button', { name: 'Favorite Charlie', exact: true }).click()
		await expect(page.getByRole('status')).toContainText('Could not confirm the favorite change')
		await expect(titles(page)).toHaveText(['Alpha', 'Bravo', 'Charlie'])
		await expect(page.getByRole('button', { name: 'Favorite Charlie', exact: true })).toBeEnabled()
		expect(f.posts()).toBe(1)
	} finally {
		f.host.revoke()
	}
})

test('saving a favorite does not steal a newer search focus', async ({ page, baseURL }) => {
	if (!baseURL) throw new Error('Missing test base URL')
	const f = await setup(page, baseURL)
	const release = f.hold()
	try {
		const star = page.getByRole('button', { name: 'Favorite Charlie', exact: true })
		await star.focus()
		await page.keyboard.press('Enter')
		await expect(star).toBeDisabled()
		const search = page.getByRole('searchbox', { name: 'Search live conversations' })
		await search.fill('alpha')
		release()
		await expect(page.getByRole('button', { name: 'Favorite Alpha', exact: true })).toBeEnabled()
		await expect(search).toBeFocused()
		await expect(search).toHaveValue('alpha')
	} finally {
		release()
		f.host.revoke()
	}
})

test('read-only favorites are visible but cannot be changed', async ({ page }) => {
	await page.goto('/iframe.html?id=views-helm-remote--favorites-read-only&viewMode=story')
	await expect(page.getByRole('button', { name: 'Favorite Helm conversation', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Favorite Planning conversation', exact: true })).toBeDisabled()
})
