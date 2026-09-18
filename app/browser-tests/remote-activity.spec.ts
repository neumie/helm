import { type Page, expect, test } from '@playwright/test'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
	}
}

for (const width of [320, 390, 1280]) {
	test(`observed Working is at the live chat tail, not just the header at ${width}px`, async ({ page }, info) => {
		await page.setViewportSize({ width, height: width < 800 ? 420 : 844 })
		await page.goto('/iframe.html?id=views-helm-remote--history-reader&viewMode=story')
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const transcript = page.getByLabel('Conversation messages', { exact: true })
		const working = transcript.getByRole('status', { name: 'Pi is working', exact: true })
		const readout = transcript.locator('.remote-working')
		await expectCurrentStatus(page, width, 'Main Pi idle', 'toBeVisible')
		await expect(working).toHaveCount(0)
		// This changes only observed activity, not revision, messages, or a local operation.
		await page.evaluate(() => window.__remoteFixture?.setActivity('working'))
		await expect(working).toBeInViewport()
		await expect(transcript.getByText('Working…', { exact: true })).toBeInViewport()
		await expect(working).toHaveAttribute('data-variant', 'progress')
		await expect(working.locator('.activity-indicator-dot')).toHaveCount(6)
		const geometry = await transcript.evaluate(element => {
			const last = element.querySelectorAll('[data-message-id]')
			const row = element.querySelector('.remote-working')
			if (!last.length || !row) throw new Error('Missing chat tail')
			const message = last[last.length - 1]?.getBoundingClientRect()
			const marker = row.getBoundingClientRect()
			const pane = element.getBoundingClientRect()
			return {
				messageBottom: message?.bottom ?? 0,
				markerTop: marker.top,
				markerBottom: marker.bottom,
				paneTop: pane.top,
				paneBottom: pane.bottom,
				height: pane.height,
			}
		})
		expect(geometry.markerTop).toBeGreaterThanOrEqual(geometry.messageBottom - 1)
		expect(geometry.markerTop).toBeGreaterThanOrEqual(geometry.paneTop - 1)
		expect(geometry.markerBottom).toBeLessThanOrEqual(geometry.paneBottom + 1)
		expect(geometry.height).toBeGreaterThanOrEqual(96)
		await expect
			.poll(() =>
				working
					.locator('.activity-indicator-dot')
					.first()
					.evaluate(element => getComputedStyle(element).animationName),
			)
			.not.toBe('none')
		if (width >= 800)
			await expect(
				page
					.locator('.remote-session-row')
					.filter({ hasText: 'Helm conversation' })
					.getByText('Working', { exact: true }),
			).toBeVisible()
		await page.screenshot({ path: info.outputPath(`working-chat-tail-${width}.png`) })

		// Activity-only changes must not pull a live-window reader down to the new tail row.
		await transcript.evaluate(element => {
			element.scrollTop = element.scrollHeight / 2
		})
		await expect(working).not.toBeInViewport()
		const liveTop = await transcript.evaluate(element => element.scrollTop)
		await page.evaluate(() => window.__remoteFixture?.setActivity('idle'))
		await expectCurrentStatus(page, width, 'Main Pi idle', 'toBeVisible')
		await page.evaluate(() => window.__remoteFixture?.setActivity('working'))
		await expectCurrentStatus(page, width, 'Working', 'toBeVisible')
		expect(Math.abs((await transcript.evaluate(element => element.scrollTop)) - liveTop)).toBeLessThanOrEqual(1)
		await expect(working).not.toBeInViewport()

		// History retains current status, but must not pretend an old page is receiving a live reply.
		await transcript.evaluate(element => {
			element.scrollTop = 0
		})
		await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
		await expect(page.getByRole('button', { name: 'Newer', exact: true })).toBeVisible()
		await expect(working).toHaveCount(0)
		await expectCurrentStatus(page, width, 'Working', 'toBeInViewport')
		await transcript.evaluate(element => {
			element.scrollTop = element.scrollHeight / 2
		})
		const before = await transcript.evaluate(element => ({ top: element.scrollTop, text: element.textContent }))
		await page.evaluate(() => window.__remoteFixture?.setActivity('waiting'))
		await expectCurrentStatus(page, width, 'Needs you', 'toBeInViewport')
		await expect(working).toHaveCount(0)
		await page.evaluate(() => window.__remoteFixture?.setActivity('working'))
		await expectCurrentStatus(page, width, 'Working', 'toBeInViewport')
		await expect.poll(() => transcript.evaluate(element => element.textContent)).toBe(before.text)
		expect(Math.abs((await transcript.evaluate(element => element.scrollTop)) - before.top)).toBeLessThanOrEqual(1)
		await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
		await expect(working).toBeInViewport()
		await expect(readout).toBeInViewport()

		await page.evaluate(() => window.__remoteFixture?.setActivity('idle'))
		await expectCurrentStatus(page, width, 'Main Pi idle', 'toBeInViewport')
		await expect(working).toHaveCount(0)
		await page.evaluate(() => window.__remoteFixture?.setActivity('unknown'))
		await expectCurrentStatus(page, width, 'State unknown', 'toBeVisible')
		await expect(working).toHaveCount(0)
		await page.evaluate(() => {
			window.__remoteFixture?.setActivity('working')
			window.__remoteFixture?.setConnected(false)
		})
		await expectCurrentStatus(page, width, 'Disconnected', 'toBeInViewport')
		await expect(working).toHaveCount(0)
	})
}

test('sending is not observed work; reduced motion and read-only retain the live tail status', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.goto('/iframe.html?id=views-helm-remote--browser-harness&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const transcript = page.getByLabel('Conversation messages', { exact: true })
	const working = transcript.getByRole('status', { name: 'Pi is working', exact: true })
	await page.getByPlaceholder('Message Pi…').fill('A send must not invent observed activity')
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect.poll(() => page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(1)
	await expect(working).toHaveCount(0)
	await page.evaluate(() => window.__remoteFixture?.setActivity('working'))
	await expect(working).toBeInViewport()
	await expect(transcript.getByText('Working…', { exact: true })).toBeInViewport()
	const motion = await working
		.locator('.activity-indicator-dot')
		.first()
		.evaluate(element => {
			const style = getComputedStyle(element)
			return { duration: Number.parseFloat(style.animationDuration), iterations: style.animationIterationCount }
		})
	expect(motion.duration).toBeLessThanOrEqual(0.001)
	expect(motion.iterations).toBe('1')
	await page.evaluate(() => window.__remoteFixture?.setReadOnly(true))
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
	await expect(working).toBeInViewport()
})

async function expectCurrentStatus(
	page: Page,
	width: number,
	text: string,
	assertion: 'toBeVisible' | 'toBeInViewport',
) {
	if (width < 1200) {
		await page.getByRole('button', { name: 'Conversation options', exact: true }).click()
		await page.getByRole('menuitem', { name: 'Info', exact: true }).click()
	}
	const status = page.locator('.remote-current-conversation .chip').filter({ hasText: new RegExp(`^${text}$`) })
	if (assertion === 'toBeVisible') await expect(status).toBeVisible()
	else {
		await status.scrollIntoViewIfNeeded()
		await expect(status).toBeInViewport()
	}
	if (width < 1200) await page.getByRole('button', { name: 'Back to conversation', exact: true }).click()
}
