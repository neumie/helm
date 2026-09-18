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
		// Favorite state is known once the rows themselves are listed.
		await expect(target.locator('.remote-session-row .remote-session-title')).toHaveText(['Alpha', 'Bravo', 'Charlie'])
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

const rowFor = (page: Page, title: string) =>
	page.locator('.remote-session-entry').filter({ has: page.locator('.remote-session-title', { hasText: title }) })
const menuFor = (page: Page, title: string) => page.getByRole('menu', { name: `${title} actions`, exact: true })

/** The interaction the product ships: hold the row itself. */
async function holdRow(page: Page, title: string) {
	const row = rowFor(page, title).locator('.remote-session-row')
	const box = await row.boundingBox()
	if (!box) throw new Error(`No row for ${title}`)
	const point = {
		pointerType: 'touch',
		isPrimary: true,
		clientX: box.x + box.width / 2,
		clientY: box.y + box.height / 2,
	}
	await row.dispatchEvent('pointerdown', point)
	await page.waitForTimeout(700)
	await row.dispatchEvent('pointerup', point)
	return menuFor(page, title)
}

/** Pointer devices and the keyboard menu key both arrive as contextmenu. */
async function openRowMenu(page: Page, title: string) {
	await rowFor(page, title).locator('.remote-session-row').click({ button: 'right' })
	return menuFor(page, title)
}

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

		const held = await holdRow(page, 'Charlie')
		await expect(held.getByRole('menuitem', { name: 'Pin to top' })).toBeFocused()
		await held.getByRole('menuitem', { name: 'Pin to top' }).click()
		// Holding a row reveals its actions; it must never also open the conversation.
		await expect(page.locator('.remote-conversation')).toHaveCount(0)
		await expect(menuFor(page, 'Charlie')).toHaveCount(0)
		await expect(titles(page)).toHaveText(['Charlie', 'Alpha', 'Bravo'])
		await expect(titles(second)).toHaveText(['Charlie', 'Alpha', 'Bravo'])
		await expect(rowFor(page, 'Charlie').locator('.remote-session-pinned')).toBeVisible()
		await expect(rowFor(page, 'Alpha').locator('.remote-session-pinned')).toHaveCount(0)
		await expect(rowFor(page, 'Charlie').locator('.remote-session-row')).toBeFocused()

		const bravo = await openRowMenu(page, 'Bravo')
		const item = bravo.getByRole('menuitem', { name: 'Pin to top' })
		const bounds = await item.boundingBox()
		expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44)
		await page.keyboard.press('Enter')
		await expect(titles(page)).toHaveText(['Bravo', 'Charlie', 'Alpha'])
		await expect(rowFor(page, 'Bravo').locator('.remote-session-row')).toBeFocused()

		await page.getByRole('searchbox', { name: 'Search live conversations' }).fill('alpha')
		await expect(titles(page)).toHaveText(['Alpha'])
		await page.getByRole('searchbox', { name: 'Search live conversations' }).fill('')
		await page.screenshot({ path: testInfo.outputPath('favorites.png') })

		const unpin = await openRowMenu(page, 'Charlie')
		await unpin.getByRole('menuitem', { name: 'Unpin from top' }).click()
		await expect(titles(second)).toHaveText(['Bravo', 'Alpha', 'Charlie'])
		await page.reload()
		await expect(titles(page)).toHaveText(['Bravo', 'Alpha', 'Charlie'])
		expect(f.posts()).toBe(3)
	} finally {
		await context.close()
		f.host.revoke()
	}
})

test('Escape dismisses the row menu and gives the row its focus back', async ({ page, baseURL }) => {
	if (!baseURL) throw new Error('Missing test base URL')
	const f = await setup(page, baseURL)
	try {
		const menu = await openRowMenu(page, 'Charlie')
		await expect(menu).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(menuFor(page, 'Charlie')).toHaveCount(0)
		await expect(rowFor(page, 'Charlie').locator('.remote-session-row')).toBeFocused()
		// Dismissing is not choosing: nothing was pinned and nothing was opened.
		await expect(titles(page)).toHaveText(['Alpha', 'Bravo', 'Charlie'])
		await expect(page.locator('.remote-conversation')).toHaveCount(0)
		expect(f.posts()).toBe(0)
	} finally {
		f.host.revoke()
	}
})

test('a plain tap still opens the conversation', async ({ page, baseURL }) => {
	if (!baseURL) throw new Error('Missing test base URL')
	const f = await setup(page, baseURL)
	try {
		await rowFor(page, 'Charlie').locator('.remote-session-row').click()
		await expect(page.locator('.remote-conversation')).toHaveCount(1)
		await expect(page.getByRole('menu')).toHaveCount(0)
	} finally {
		f.host.revoke()
	}
})

test('failed favorite save is visible and not replayed or optimistically pinned', async ({ page, baseURL }) => {
	if (!baseURL) throw new Error('Missing test base URL')
	const f = await setup(page, baseURL)
	try {
		f.reject()
		const menu = await openRowMenu(page, 'Charlie')
		await menu.getByRole('menuitem', { name: 'Pin to top' }).click()
		await expect(page.getByRole('status')).toContainText('Could not confirm the favorite change')
		await expect(titles(page)).toHaveText(['Alpha', 'Bravo', 'Charlie'])
		await expect(rowFor(page, 'Charlie').locator('.remote-session-pinned')).toHaveCount(0)
		const reopened = await openRowMenu(page, 'Charlie')
		await expect(reopened.getByRole('menuitem', { name: 'Pin to top' })).toBeEnabled()
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
		const menu = await openRowMenu(page, 'Charlie')
		await menu.getByRole('menuitem', { name: 'Pin to top' }).click()
		const pending = await openRowMenu(page, 'Alpha')
		await expect(pending.getByRole('menuitem', { name: 'Pin to top' })).toBeDisabled()
		await page.keyboard.press('Escape')
		const search = page.getByRole('searchbox', { name: 'Search live conversations' })
		await search.fill('alpha')
		release()
		await expect(titles(page)).toHaveText(['Alpha'])
		await expect(search).toBeFocused()
		await expect(search).toHaveValue('alpha')
	} finally {
		release()
		f.host.revoke()
	}
})

test('read-only favorites are visible but cannot be changed', async ({ page }) => {
	await page.goto('/iframe.html?id=views-helm-remote--favorites-read-only&viewMode=story')
	const menu = await openRowMenu(page, 'Helm conversation')
	await expect(menu.getByRole('menuitem', { name: 'Pin to top' })).toBeDisabled()
	await expect(menu.getByText('This device can read this conversation but not change it.')).toBeVisible()
})
