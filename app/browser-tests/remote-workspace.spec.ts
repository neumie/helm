import { expect, test } from '@playwright/test'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
	}
}
const path = '/iframe.html?id=views-helm-remote--browser-harness&viewMode=story'

for (const width of [1280, 390]) {
	test(`session navigation, drafts, and anchored reading at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 844 })
		await page.goto(path)
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const transcript = page.getByRole('region', { name: 'Conversation' }).getByLabel('Conversation messages')
		await expect(transcript.locator('.remote-message')).toHaveCount(40)
		await page.getByLabel('Message', { exact: true }).fill('Keep my unsent draft')
		await transcript.evaluate(node => {
			node.scrollTop = node.scrollHeight / 2
		})
		await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
		const anchor = await transcript.evaluate(node => {
			const element = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(
				child => child.getBoundingClientRect().bottom > node.getBoundingClientRect().top,
			)
			if (!element) throw new Error('Missing reading anchor')
			return { id: element.dataset.messageId, top: element.getBoundingClientRect().top }
		})
		await page.evaluate(() => window.__remoteFixture?.append('A streamed update at the bottom'))
		await expect(transcript.getByText('A streamed update at the bottom', { exact: true })).toHaveCount(1)
		const afterTop = await transcript
			.locator(`[data-message-id="${anchor.id}"]`)
			.evaluate(node => node.getBoundingClientRect().top)
		// Fractional text metrics + integer scrollTop can round by half a CSS pixel.
		expect(Math.abs(afterTop - anchor.top)).toBeLessThanOrEqual(1)
		await page.getByRole('button', { name: 'Sessions', exact: true }).click()
		await page.getByRole('button', { name: /Planning conversation/ }).click()
		await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
		await page.getByRole('button', { name: 'Sessions', exact: true }).click()
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my unsent draft')
		await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({ path: testInfo.outputPath(`remote-${width}.png`) })
	})
}

test('lost command response is recovered by a read, never a duplicate send', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.getByLabel('Message', { exact: true }).fill('Send exactly this once')
	await page.evaluate(() => window.__remoteFixture?.loseNextResponse())
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect(page.getByText(/Delivery unknown/)).toBeVisible()
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
	await page.getByRole('button', { name: 'Check status', exact: true }).click()
	await expect(page.getByText(/Dispatched to Pi/)).toBeVisible()
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(1)
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
})

test('single, multiple and custom answers use the real question presentation', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--questions&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.getByRole('radio', { name: /Keep the owner/ }).check()
	await expect(page.getByText('Pi → local host → browser', { exact: true })).toBeVisible()
	await page.getByRole('checkbox', { name: /Desktop/ }).check()
	await page.getByRole('checkbox', { name: /Mobile/ }).check()
	await page.getByLabel('Custom answer: Custom').fill('Please retain the original owner')
	await page.getByRole('button', { name: 'Submit answers' }).click()
	await expect(page.getByText('Answer submitted.', { exact: true })).toBeVisible()
	expect(await page.evaluate(() => window.__remoteFixture?.commands[0]?.operation)).toMatchObject({
		kind: 'answer',
		answers: [{ option: 0 }, { options: [0, 1] }, { text: 'Please retain the original owner' }],
	})
})

test('reconnect retains draft and selection, revocation removes the conversation', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.getByLabel('Message', { exact: true }).fill('Offline draft')
	await page.evaluate(() => window.__remoteFixture?.setOnline(false))
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Offline draft')
	await page.evaluate(() => window.__remoteFixture?.setOnline(true))
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
	await page.evaluate(() => window.__remoteFixture?.revoke())
	await expect(page.getByRole('heading', { name: 'Access ended' })).toBeVisible()
	await expect(page.locator('.remote-message')).toHaveCount(0)
})

test('reduced motion, keyboard focus, and a keyboard-height viewport remain usable', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.setViewportSize({ width: 390, height: 420 })
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByRole('heading', { name: 'Helm conversation', exact: true })).toBeFocused()
	await page.getByLabel('Message', { exact: true }).fill('Short viewport')
	const send = page.getByRole('button', { name: 'Send', exact: true })
	await expect(send).toBeInViewport()
	expect(await send.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
	await page.getByRole('button', { name: 'Sessions', exact: true }).click()
	await expect(page.getByRole('button', { name: /Helm conversation/ })).toBeFocused()
})

test('a replacement owner never inherits another incarnation’s draft or enabled controls', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.getByLabel('Message', { exact: true }).fill('Only for the old branch')
	await page.evaluate(() => {
		window.__remoteFixture?.replaceOwner()
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
})

test('an answered questionnaire stays fenced until observation catches up', async ({ page }) => {
	await page.goto('/iframe.html?id=views-helm-remote--questions&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.evaluate(() => window.__remoteFixture?.holdQuestionRefresh())
	await page.getByRole('radio', { name: /Keep the owner/ }).check()
	await page.getByLabel('Custom answer: Custom').fill('Ready')
	await page.getByRole('button', { name: 'Submit answers' }).click()
	await expect(page.getByText('Answer submitted.', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Submit answers' })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toBeDisabled()
	await page.evaluate(() => {
		window.__remoteFixture?.clearQuestion()
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.getByRole('button', { name: 'Submit answers' })).toHaveCount(0)
})

test('untrusted transcript text remains text, not active markup', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const text = '<img src="https://evil.invalid/x" onerror="alert(1)"><script>alert(2)</script>'
	await page.evaluate(value => {
		window.__remoteFixture?.append(value)
		document.dispatchEvent(new Event('visibilitychange'))
	}, text)
	await expect(page.getByText(text, { exact: true })).toBeVisible()
	await expect(page.locator('.remote-transcript img, .remote-transcript script')).toHaveCount(0)
})

test('bounded live-window render and memory budgets', async ({ page }, testInfo) => {
	await page.goto(path)
	await expect(page.getByRole('button', { name: /Helm conversation/ })).toBeVisible()
	const openPaintMs = await page.evaluate(async () => {
		const button = [...document.querySelectorAll<HTMLButtonElement>('.remote-session-row')].find(node =>
			node.textContent?.includes('Helm conversation'),
		)
		if (!button) throw new Error('Missing fixture session')
		const start = performance.now()
		button.click()
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		return performance.now() - start
	})
	await expect(page.locator('.remote-message')).toHaveCount(40)
	const cdp = await page.context().newCDPSession(page)
	await cdp.send('HeapProfiler.collectGarbage')
	const before = (await cdp.send('Runtime.getHeapUsage')).usedSize
	await page.evaluate(() => {
		window.__remoteRenderDurations = []
	})
	for (let index = 0; index < 12; index++) {
		const text = `Update ${index}: ${'Bounded long output. '.repeat(350)}`
		await page.evaluate(value => {
			window.__remoteFixture?.append(value)
			document.dispatchEvent(new Event('visibilitychange'))
		}, text)
		await expect(page.getByText(text, { exact: true })).toHaveCount(1)
		await expect(page.locator('.remote-message')).toHaveCount(40)
	}
	const renderMs = await page.evaluate(() => window.__remoteRenderDurations ?? [])
	for (let index = 0; index < 10; index++) {
		await page.getByRole('button', { name: 'Sessions', exact: true }).click()
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await expect(page.locator('.remote-message')).toHaveCount(40)
	}
	await cdp.send('HeapProfiler.collectGarbage')
	const growthBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize - before
	const sorted = renderMs.sort((a, b) => a - b)
	const p95RenderMs = sorted[Math.floor(sorted.length * 0.95)] ?? 0
	const report = {
		sourceWindow: '40 most recent messages; history paging not implemented',
		samples: sorted.length,
		openPaintMs,
		p95RenderMs,
		growthBytes,
	}
	await testInfo.attach('remote-performance.json', {
		body: Buffer.from(JSON.stringify(report)),
		contentType: 'application/json',
	})
	console.log('Remote browser measurements:', JSON.stringify(report))
	expect(sorted.length).toBeGreaterThan(0)
	expect(openPaintMs).toBeLessThan(100)
	expect(p95RenderMs).toBeLessThan(16)
	expect(growthBytes).toBeLessThan(8 * 1024 * 1024)
})
