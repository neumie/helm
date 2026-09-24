import { type Page, expect, test } from '@playwright/test'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
		__entryProof?: { reads: number; release?: () => void }
	}
}
const entryName = 'Load earlier messages'
async function setup(
	page: Page,
	content: 'long' | 'short' | 'empty' | 'pending' = 'long',
	question = false,
	progress = true,
	count = 440,
) {
	await page.goto(`/iframe.html?id=views-helm-remote--${question ? 'questions' : 'history-reader'}&viewMode=story`)
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await page.evaluate(
		({ content, progress, count }) => {
			const f = window.__remoteFixture
			if (!f) throw new Error('Missing fixture')
			f.enableHistory(count, false, progress ? 'progress' : undefined)
			const proof: NonNullable<Window['__entryProof']> = { reads: 0 }
			window.__entryProof = proof
			const history = f.transport.history?.bind(f.transport)
			if (!history) throw new Error('Missing history transport')
			f.transport.history = async (...args) => {
				if (args[0].action.kind !== 'close') {
					proof.reads++
					await new Promise<void>(resolve => {
						proof.release = resolve
					})
				}
				return history(...args)
			}
			const detail = f.transport.detail.bind(f.transport)
			f.transport.detail = async (...args) => {
				if (content === 'pending')
					await new Promise<void>(resolve => {
						proof.release = resolve
					})
				const result = await detail(...args)
				if (content === 'empty') result.snapshot.messages = []
				if (content === 'short')
					result.snapshot.messages = [{ ...result.snapshot.messages[0], text: 'Short conversation', thinking: '' }]
				return result
			}
		},
		{ content, question, progress, count },
	)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByLabel('Conversation messages')).toBeVisible()
	if (content !== 'pending') await expect(page.getByRole('button', { name: entryName, exact: true })).toHaveCount(1)
}
async function reads(page: Page, count: number) {
	await expect.poll(() => page.evaluate(() => window.__entryProof?.reads)).toBe(count)
}
async function top(page: Page) {
	const pane = page.getByLabel('Conversation messages')
	await pane.evaluate(e => {
		e.scrollTop = 0
	})
	await expect.poll(() => pane.evaluate(e => e.scrollTop)).toBe(0)
	await expect(page.getByRole('button', { name: entryName, exact: true })).toBeInViewport({ ratio: 1 })
}
async function pollConnection(page: Page, connected: boolean) {
	await page.evaluate(value => {
		window.__remoteFixture?.setConnected(value)
		document.dispatchEvent(new Event('visibilitychange'))
	}, connected)
}
for (const width of [320, 390, 1280]) {
	test(`upward wheel loads history once without a mount or programmatic-scroll read ${width}`, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 })
		await setup(page)
		const pane = page.getByLabel('Conversation messages')
		const entry = page.getByRole('button', { name: entryName, exact: true })
		await expect(entry).not.toBeInViewport()
		await expect(page.locator('.remote-history')).toHaveCount(0)
		await reads(page, 0)
		await pane.evaluate(e => {
			e.scrollTop = 300
		})
		await pane.hover()
		await page.mouse.wheel(0, -1)
		// Playwright dispatch is asynchronous; settle the far-from-edge wheel before changing scrollTop.
		await page.evaluate(
			() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
		)
		await expect.poll(() => pane.evaluate(e => e.scrollTop)).toBeGreaterThan(24)
		await top(page)
		await reads(page, 0)
		await pane.focus()
		await pane.hover()
		await page.mouse.wheel(0, -100)
		await reads(page, 1)
		await expect(entry).toHaveCount(0)
		await page.mouse.wheel(0, -100)
		await reads(page, 1)
		await expect(pane).toBeFocused()
		await expect(page.getByRole('button', { name: 'Cancel search' })).toBeVisible()
	})
}
test('automatic page transitions land at the newer edge and require another upward gesture', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await setup(page, 'long', false, false)
	const pane = page.getByLabel('Conversation messages')
	await top(page)
	await pane.focus()
	await pane.hover()
	await page.mouse.wheel(0, -100)
	await reads(page, 1)
	await page.mouse.wheel(0, -100)
	await reads(page, 1)
	await page.evaluate(() => window.__entryProof?.release?.())
	await expect(pane.locator('[data-message-id]').first()).toHaveAttribute('data-message-id', '00000169')
	await expect.poll(() => pane.evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThanOrEqual(1)
	await page.mouse.wheel(0, -100000)
	await reads(page, 2)
	await page.evaluate(() => window.__entryProof?.release?.())
	await expect(pane.locator('[data-message-id]').first()).toHaveAttribute('data-message-id', '00000141')
	await expect.poll(() => pane.evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThanOrEqual(1)
})

test('the root does not retry on upward scroll and Jump to latest permits a new read', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await setup(page, 'long', false, false, 80)
	const pane = page.getByLabel('Conversation messages')
	await top(page)
	await pane.hover()
	await page.mouse.wheel(0, -100)
	await reads(page, 1)
	await page.evaluate(() => window.__entryProof?.release?.())
	await expect(pane.getByText('Beginning of this conversation.')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Older', exact: true })).toBeDisabled()
	await pane.evaluate(e => {
		e.scrollTop = 0
	})
	await pane.hover()
	await page.mouse.wheel(0, -100)
	await reads(page, 1)
	await page.getByRole('button', { name: 'Jump to latest' }).click()
	await top(page)
	await pane.hover()
	await page.mouse.wheel(0, -100)
	await reads(page, 2)
})

test('keyboard and touch upward gestures admit a short conversation without an initial read', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await setup(page, 'short')
	const pane = page.getByLabel('Conversation messages')
	await reads(page, 0)
	await pane.focus()
	await page.keyboard.press('ArrowUp')
	await reads(page, 1)
	await expect(pane).toBeFocused()
	await page.evaluate(() => window.__entryProof?.release?.())
	await expect(page.getByRole('button', { name: 'Continue search' })).toBeVisible()
	await page.getByRole('button', { name: 'Cancel search' }).click()
	await page.getByRole('button', { name: 'Jump to latest' }).click()
	await pane.evaluate(node => {
		const touch = (y: number) => new Touch({ identifier: 1, target: node, clientX: 100, clientY: y })
		node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(100)] }))
		node.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(130)] }))
	})
	await reads(page, 2)
})

for (const content of ['short', 'empty'] as const) {
	test(`loaded ${content} has a reachable entry without loading history`, async ({ page }) => {
		await setup(page, content)
		await expect(page.getByRole('button', { name: entryName })).toBeInViewport({ ratio: 1 })
		await expect(page.locator('.remote-history')).toHaveCount(0)
		await reads(page, 0)
	})
}
test('pending initial detail has no entry', async ({ page }) => {
	await setup(page, 'pending')
	await expect(page.getByText('Loading conversation…', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: entryName })).toHaveCount(0)
	await reads(page, 0)
})
test('disconnection blocks scroll admission and a fresh upward gesture recovers it', async ({ page }) => {
	await setup(page)
	await top(page)
	await page.getByLabel('Message', { exact: true }).fill('Same mounted draft')
	await pollConnection(page, false)
	await expect(page.getByRole('button', { name: entryName })).toHaveCount(0)
	await expect(page.getByText('History is unavailable while disconnected.', { exact: true })).toBeVisible()
	const pane = page.getByLabel('Conversation messages')
	await pane.hover()
	await page.mouse.wheel(0, -100)
	// mouse.wheel resolves before Chromium necessarily delivers the wheel/scroll events.
	// Settle the disconnected gesture before publishing a fresh connected observation.
	await page.evaluate(
		() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	)
	await expect(page.getByText('History is unavailable while disconnected.', { exact: true })).toBeVisible()
	await reads(page, 0)
	await pollConnection(page, true)
	await expect(page.getByRole('button', { name: entryName })).toHaveCount(1)
	await expect(page.locator('.remote-history')).toHaveCount(0)
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Same mounted draft')
	await top(page)
	await reads(page, 0)
	await pane.hover()
	await page.mouse.wheel(0, -100)
	await reads(page, 1)
})
test('keyboard discovers entry and transfers focus without scrolling the resulting reading owner', async ({ page }) => {
	await setup(page)
	await top(page)
	await page.getByLabel('Conversation messages').focus()
	await page.keyboard.press('Tab')
	await expect(page.getByRole('button', { name: entryName })).toBeFocused()
	await page.keyboard.press('Enter')
	await reads(page, 1)
	await expect(page.getByRole('button', { name: 'Cancel search' })).toBeFocused()
	await expect.poll(() => page.getByLabel('Conversation messages').evaluate(e => e.scrollTop)).toBe(0)
	await page.evaluate(() => window.__entryProof?.release?.())
	await expect(page.getByRole('button', { name: 'Continue search' })).toBeVisible()
	await reads(page, 1)
})
for (const newer of ['composer', 'question', 'info'] as const) {
	test(`disappearing entry never steals newer ${newer} focus`, async ({ page }) => {
		await page.setViewportSize({ width: newer === 'info' ? 1280 : 390, height: 844 })
		await setup(page, 'long', newer === 'question')
		await top(page)
		if (newer === 'info') {
			await page.getByRole('button', { name: 'More', exact: true }).click()
			await page.getByRole('menuitem', { name: 'Info', exact: true }).click()
		}
		const selector =
			newer === 'composer' ? 'textarea' : newer === 'question' ? '.remote-question input' : '.remote-information h2'
		await page.evaluate(selector => {
			const entry = document.querySelector<HTMLButtonElement>('.remote-history-entry button')
			const destination = document.querySelector<HTMLElement>(selector)
			if (!entry || !destination) throw new Error('Missing focus owners')
			entry.focus({ preventScroll: true })
			entry.addEventListener('click', () => destination.focus({ preventScroll: true }), { once: true })
			entry.click()
		}, selector)
		await reads(page, 1)
		await expect(page.locator(selector).first()).toBeFocused()
		await page.evaluate(() => window.__entryProof?.release?.())
		await expect(page.getByRole('button', { name: 'Continue search' })).toBeVisible()
		await expect(page.locator(selector).first()).toBeFocused()
	})
}
test('mobile Info makes the live entry inert to focus, keyboard and pointer; Back restores reading', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await setup(page)
	await top(page)
	const entry = page.getByRole('button', { name: entryName })
	const box = await entry.boundingBox()
	if (!box) throw new Error('Missing live entry')
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Info', exact: true }).click()
	await expect(page.getByLabel('Conversation messages')).toHaveAttribute('inert', '')
	await entry.evaluate(e => e.focus())
	await expect(entry).not.toBeFocused()
	await page.keyboard.press('Enter')
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
	await reads(page, 0)
	await page.getByRole('button', { name: 'Back to conversation', exact: true }).click()
	await expect(page.getByLabel('Conversation messages')).not.toHaveAttribute('inert', '')
	await expect(entry).toBeInViewport({ ratio: 1 })
	await expect.poll(() => page.getByLabel('Conversation messages').evaluate(e => e.scrollTop)).toBe(0)
	await entry.click()
	await reads(page, 1)
})
test('entry reading anchor survives streaming and Back Forward; latest hides entry again', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await setup(page)
	await top(page)
	const pane = page.getByLabel('Conversation messages')
	// Leave the first (evictable) live-window record above the reading anchor.
	await pane.hover()
	await page.mouse.wheel(0, 500)
	await expect.poll(() => pane.evaluate(e => e.scrollTop)).toBe(500)
	const anchor = await pane.evaluate(node => {
		const top = node.getBoundingClientRect().top
		const row = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(
			row => row.dataset.messageId !== 'current' && row.getBoundingClientRect().bottom > top,
		)
		if (!row || row.dataset.messageId === '00000191') throw new Error('Missing non-evictable reading anchor')
		return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top }
	})
	await test.info().attach('entry-anchor-before', { body: JSON.stringify(anchor), contentType: 'application/json' })
	await page.evaluate(() => window.__remoteFixture?.append('Entry anchor streaming proof'))
	await expect(pane.getByText('Entry anchor streaming proof', { exact: true })).toHaveCount(1)
	const assertAnchor = async () =>
		expect(
			Math.abs(
				(await pane.locator(`[data-message-id="${anchor.id}"]`).evaluate(e => {
					const owner = e.closest('.remote-transcript')
					if (!owner) throw new Error('Missing reading owner')
					return e.getBoundingClientRect().top - owner.getBoundingClientRect().top
				})) - anchor.offset,
			),
		).toBeLessThanOrEqual(1)
	await assertAnchor()
	await page.goBack()
	await expect(page.locator('.remote-directory')).toBeVisible()
	await page.goForward()
	await expect(pane).toBeVisible()
	await assertAnchor()
	await top(page)
	await reads(page, 0)
	await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
	await expect(page.getByRole('button', { name: entryName })).not.toBeInViewport()
	await reads(page, 0)
})
