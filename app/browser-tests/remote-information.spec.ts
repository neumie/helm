import { type Locator, type Page, expect, test } from '@playwright/test'
import { informationFixture } from '../src/renderer/remote/information-fixture.js'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'
import { openRemoteDestination } from './remote-navigation.js'
declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
		__workspaceDedupState?: { currentWorkspace: string; footerWorkspace: string | null }
	}
}

function infoValue(panel: Locator, label: string) {
	return panel.locator('dt').filter({ hasText: label }).locator('..').locator('dd')
}

async function simulateSafeAreas(page: Page) {
	await page.evaluate(() => {
		for (const sheet of document.styleSheets) {
			try {
				const rewrite = (rules: CSSRuleList) => {
					for (const rule of rules) {
						if (rule instanceof CSSStyleRule && rule.cssText.includes('safe-area-inset'))
							rule.style.cssText = rule.style.cssText
								.replace(/env\(safe-area-inset-top(?:,\s*0px)?\)/g, '36px')
								.replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g, '24px')
						if (rule instanceof CSSGroupingRule) rewrite(rule.cssRules)
					}
				}
				rewrite(sheet.cssRules)
			} catch {
				/* Cross-origin workbench sheets do not own Remote geometry. */
			}
		}
	})
}

async function safeGeometry(page: Page, action: string) {
	const geometry = await page.evaluate(name => {
		const header = document.querySelector('.remote-chat > .remote-header')
		const composer = document.querySelector('.remote-composer')
		const reading = document.querySelector('.remote-reading-area')
		const surface = composer?.querySelector('.remote-compose-surface, .remote-question-actions')
		if (!header || !composer || !reading || !surface) throw new Error('Missing conversation geometry owner')
		const button = [...composer.querySelectorAll('button')].find(
			e => e.getAttribute('aria-label') === name || e.textContent?.trim() === name,
		)
		if (!button) throw new Error(`Missing ${name} action`)
		const rect = button.getBoundingClientRect()
		const controls = [...header.querySelectorAll('button')]
			.map(e => {
				const r = e.getBoundingClientRect()
				return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
			})
			.filter(control => control.width > 0 && control.height > 0)
		return {
			top: getComputedStyle(header).paddingTop,
			bottom: getComputedStyle(composer).paddingBottom,
			headerTop: header.getBoundingClientRect().top,
			controls,
			viewportWidth: innerWidth,
			viewportHeight: innerHeight,
			controlsTop: Math.min(...controls.map(control => control.top)),
			actionTop: rect.top,
			actionBottom: rect.bottom,
			actionHeight: rect.height,
			footerBottom: composer.getBoundingClientRect().bottom,
			surfaceBottom: surface.getBoundingClientRect().bottom,
			reading: reading.getBoundingClientRect().height,
		}
	}, action)
	expect(geometry.top).toBe('36px')
	// The composer occupies the upper safe area like a native floating bottom bar:
	// 24px inset − 16px overhang, clamped to the 12px visual floor.
	expect(geometry.bottom).toBe('12px')
	expect(geometry.headerTop).toBe(0)
	expect(geometry.controlsTop).toBeGreaterThanOrEqual(36)
	for (const control of geometry.controls) {
		expect(control.width).toBeGreaterThanOrEqual(44)
		expect(control.height).toBeGreaterThanOrEqual(44)
		expect(control.left).toBeGreaterThanOrEqual(0)
		expect(control.right).toBeLessThanOrEqual(geometry.viewportWidth)
		expect(control.bottom).toBeLessThanOrEqual(396)
	}
	expect(geometry.actionHeight).toBeGreaterThanOrEqual(44)
	expect(geometry.actionTop).toBeGreaterThanOrEqual(36)
	expect(geometry.actionBottom).toBeLessThanOrEqual(geometry.viewportHeight - 12)
	expect(geometry.footerBottom).toBe(geometry.viewportHeight)
	// The full compose surface must hug the intended 12px floor. An oversized
	// workspace clips it; a growing compact footer leaves an excessive gap.
	expect(geometry.surfaceBottom).toBeCloseTo(geometry.viewportHeight - 12, 0)
	expect(geometry.reading).toBeGreaterThanOrEqual(96)
	await test
		.info()
		.attach(`safe-geometry-${action}`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })
}

async function fullyInsideReading(page: Page, selector: string) {
	const bounds = await page
		.locator(selector)
		.first()
		.evaluate(e => {
			const rect = e.getBoundingClientRect()
			const owner = document.querySelector('.remote-reading-area')
			if (!owner) throw new Error('Missing reading owner')
			const reading = owner.getBoundingClientRect()
			return {
				top: rect.top,
				bottom: rect.bottom,
				left: rect.left,
				right: rect.right,
				readingTop: reading.top,
				readingBottom: reading.bottom,
				width: innerWidth,
			}
		})
	expect(bounds.top).toBeGreaterThanOrEqual(bounds.readingTop)
	expect(bounds.bottom).toBeLessThanOrEqual(bounds.readingBottom)
	expect(bounds.left).toBeGreaterThanOrEqual(0)
	expect(bounds.right).toBeLessThanOrEqual(bounds.width)
}

for (const width of [320, 390, 1280, 1440])
	test(`information semantics and editor geometry at ${width}`, async ({ page }, info) => {
		await page.setViewportSize({ width, height: width < 800 ? 420 : 844 })
		await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const prompt = page.getByRole('textbox', { name: 'Message', exact: true })
		await prompt.fill('Draft preserved across information')
		const transcript = page.getByLabel('Conversation messages', { exact: true })
		await transcript.evaluate(element => {
			element.scrollTop = element.scrollHeight / 2
		})
		const anchor = await transcript.evaluate(element => element.scrollTop)
		if (width < 1200) {
			await expect(page.getByRole('complementary', { name: 'Conversation information' })).toHaveCount(0)
			await openInfo(page)
		}
		const panel = page.getByRole('complementary', { name: 'Conversation information' })
		await expect(panel).toHaveCount(1)
		await expect(panel.getByRole('heading', { name: 'Information', exact: true })).toBeInViewport()
		await expect(panel.getByText('Make available extension information readable', { exact: true })).toBeAttached()
		await expect(panel.getByText('Limited coverage — not a complete observation.')).toHaveCount(2)
		await expect(panel.getByText('Process-wide', { exact: true })).toHaveCount(1)
		await expect(panel.getByText('No entries in this observation.', { exact: true })).toHaveCount(1)
		await expect(panel.getByText('2 entries omitted.', { exact: true })).toHaveCount(1)
		await expect(panel.getByText('Unsupported', { exact: true })).toHaveCount(1)
		await expect(infoValue(panel, 'Source')).toHaveText('Source unavailable')
		await expect(infoValue(panel, 'Reported tokens spent')).not.toHaveText('Unavailable')
		await expect(infoValue(panel, 'Context used')).not.toHaveText('Unavailable')
		await expect(
			panel
				.locator('dt')
				.filter({ hasText: /^Trusted workspace$/ })
				.locator('..')
				.locator('dd'),
		).toHaveText('No')
		await expect(
			panel
				.locator('dt')
				.filter({ hasText: /^Input tokens$/ })
				.locator('..')
				.locator('dd'),
		).toHaveText('0')
		await expect(
			panel
				.locator('dt')
				.filter({ hasText: /^Goal$/ })
				.locator('..')
				.locator('dd'),
		).toHaveText('Unavailable')
		await expect(prompt).toHaveValue('Draft preserved across information')
		await expect(prompt).toBeInViewport()
		expect(await transcript.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		if (width >= 1200)
			expect(await panel.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(320, 2)
		await page.screenshot({ path: info.outputPath(`information-${width}.png`) })
		if (width < 1200) {
			await page.keyboard.press('Escape')
			await expect(panel).toHaveCount(0)
			await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused()
			expect(Math.abs((await transcript.evaluate(element => element.scrollTop)) - anchor)).toBeLessThanOrEqual(1)
		}
	})

test('information token counts and reported totals live in Info, not the composer', async ({ page }) => {
	await page.route('**/v1/sessions/*/information?*', async route => {
		const url = new URL(route.request().url())
		const result = informationFixture({
			hostEpoch: url.searchParams.get('hostEpoch') ?? '',
			target: {
				sessionId: url.pathname.split('/')[3] ?? '',
				incarnation: url.searchParams.get('incarnation') ?? '',
				scopeId: url.searchParams.get('scopeId') || null,
				generation: Number(url.searchParams.get('generation')),
			},
		})
		const fields = result.information.footer.fields
		if (!fields) throw new Error('Missing fixture footer fields')
		result.information.footer.fields = {
			...fields,
			inputTokens: 999,
			outputTokens: 1000,
			contextTokens: 1200,
			contextWindow: 12500,
			contextPercent: 42,
		}
		await route.fulfill({ json: result, headers: { 'X-Helm-Information': '1' } })
	})
	await page.setViewportSize({ width: 1440, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await page.evaluate(() => window.__remoteFixture?.useProductionInformationTransport())
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const panel = page.getByRole('complementary', { name: 'Conversation information' })
	for (const [label, value] of [
		['Input tokens', '999'],
		['Output tokens', '1k'],
		['Context tokens', '1.2k'],
		['Context window', '12.5k'],
		['Reported tokens spent', '2k'],
		['Context used', '42%'],
	]) {
		await expect(
			panel
				.locator('dt')
				.filter({ hasText: new RegExp(`^${label}$`) })
				.locator('..')
				.locator('dd'),
		).toHaveText(value)
	}
	await expect(panel.locator('dt').filter({ hasText: /^(Model|Thinking)$/ })).toHaveCount(0)
	await expect(
		panel
			.locator('dt')
			.filter({ hasText: /^Trusted workspace$/ })
			.locator('..')
			.locator('dd'),
	).toHaveText('No')
	await expect(page.locator('.remote-information-footer')).toHaveCount(0)
	await expect(
		panel
			.locator('dt')
			.filter({ hasText: /^Source$/ })
			.locator('..')
			.locator('dd'),
	).toHaveText('Source unavailable')
})

for (const [tokens, expected, width] of [
	[1000000, '1m', 1440],
	[12500000, '12.5m', 390],
	[1000000000, '1b', 1440],
	[1250000000000, '1.3t', 390],
	[999950, '1m', 1440],
] as const)
	test(`information token counts scale ${tokens} to ${expected} and preserve unavailable values`, async ({ page }) => {
		await page.route('**/v1/sessions/*/information?*', async route => {
			const url = new URL(route.request().url())
			const result = informationFixture({
				hostEpoch: url.searchParams.get('hostEpoch') ?? '',
				target: {
					sessionId: url.pathname.split('/')[3] ?? '',
					incarnation: url.searchParams.get('incarnation') ?? '',
					scopeId: url.searchParams.get('scopeId') || null,
					generation: Number(url.searchParams.get('generation')),
				},
			})
			const fields = result.information.footer.fields
			if (!fields) throw new Error('Missing fixture footer fields')
			result.information.footer.fields = { ...fields, inputTokens: null, outputTokens: tokens }
			await route.fulfill({ json: result, headers: { 'X-Helm-Information': '1' } })
		})
		await page.setViewportSize({ width, height: 844 })
		await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
		await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
		await page.evaluate(() => window.__remoteFixture?.useProductionInformationTransport())
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		if (width < 1200) await openInfo(page)
		const panel = page.getByRole('complementary', { name: 'Conversation information' })
		await expect(
			panel
				.locator('dt')
				.filter({ hasText: /^Input tokens$/ })
				.locator('..')
				.locator('dd'),
		).toHaveText('Unavailable')
		await expect(
			panel
				.locator('dt')
				.filter({ hasText: /^Output tokens$/ })
				.locator('..')
				.locator('dd'),
		).toHaveText(expected)
		await expect(
			panel
				.locator('dt')
				.filter({ hasText: /^Reported tokens spent$/ })
				.locator('..')
				.locator('dd'),
		).toHaveText('Unavailable')
		await expect(page.locator('.remote-information-footer')).toHaveCount(0)
	})

test('reported totals and context meter cover safe, missing, unsafe, promotion and exact ARIA cases', async ({
	page,
}) => {
	let variant: { input: number | null; output: number | null; percent: number | null; model?: string | null } = {
		input: 0,
		output: 0,
		percent: 0,
	}
	await page.route('**/v1/sessions/*/information?*', async route => {
		const url = new URL(route.request().url())
		const result = informationFixture({
			hostEpoch: url.searchParams.get('hostEpoch') ?? '',
			target: {
				sessionId: url.pathname.split('/')[3] ?? '',
				incarnation: url.searchParams.get('incarnation') ?? '',
				scopeId: url.searchParams.get('scopeId') || null,
				generation: Number(url.searchParams.get('generation')),
			},
		})
		const fields = result.information.footer.fields
		if (!fields) throw new Error('Missing fixture footer fields')
		result.information.footer.fields = {
			...fields,
			inputTokens: variant.input,
			outputTokens: variant.output,
			contextPercent: variant.percent,
			model: variant.model === undefined ? fields.model : variant.model,
		}
		await route.fulfill({ json: result, headers: { 'X-Helm-Information': '1' } })
	})
	await page.setViewportSize({ width: 1440, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await page.evaluate(() => window.__remoteFixture?.useProductionInformationTransport())
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	for (const next of [
		{ input: 0, output: 0, percent: 0, spent: '0' },
		{ input: null, output: 10, percent: 12.5, spent: 'Unavailable' },
		{ input: 10, output: null, percent: null, spent: 'Unavailable' },
		{ input: Number.MAX_SAFE_INTEGER, output: 2, percent: 100, spent: 'Unavailable' },
		{ input: 999950, output: 0, percent: 42, spent: '1m' },
		{ input: 1000000000, output: 0, percent: 0.1, spent: '1b' },
		{ input: 1250000000000, output: 0, percent: 99.9, spent: '1.3t' },
	] as const) {
		variant = next
		await page.reload()
		await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
		await page.evaluate(() => window.__remoteFixture?.useProductionInformationTransport())
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const panel = page.getByRole('complementary', { name: 'Conversation information' })
		await expect(infoValue(panel, 'Reported tokens spent')).toHaveText(next.spent)
		await expect(infoValue(panel, 'Context used')).toHaveText(
			next.percent === null ? 'Unavailable' : `${Math.round(next.percent)}%`,
		)
		await expect(panel.locator('dt').filter({ hasText: /^(Model|Thinking)$/ })).toHaveCount(0)
		await expect(
			panel.locator('dt').filter({ hasText: /^(Input tokens|Output tokens|Context tokens|Context window)$/ }),
		).toHaveCount(4)
		await expect(page.locator('.remote-information-footer')).toHaveCount(0)
	}
	const panel = page.getByRole('complementary', { name: 'Conversation information' })
	await expect(
		panel.getByText(
			'Reported tokens spent counts input plus output on this conversation branch; cached and separate-agent usage is excluded.',
		),
	).toBeVisible()
})

test('source overlay changes independently of unchanged information fields', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const panel = page.getByRole('complementary', { name: 'Conversation information' })
	const source = infoValue(panel, 'Source')
	const spent = infoValue(panel, 'Reported tokens spent')
	const before = await spent.textContent()
	await expect(source).toHaveText('Source unavailable')
	await page.evaluate(() => window.__remoteFixture?.setTerminalMetadata(true))
	await expect(source).toHaveText('Okena')
	await expect(spent).toHaveText(before ?? '')
	await page.evaluate(() => window.__remoteFixture?.changeTerminalSource('helm'))
	await expect(source).toHaveText('Helm')
	await expect(spent).toHaveText(before ?? '')
	await page.evaluate(() => window.__remoteFixture?.changeTerminalSource(null))
	await expect(source).toHaveText('Source unavailable')
	await expect(spent).toHaveText(before ?? '')
})

for (const known of [false, true])
	test(`transparent composer and Info facts at every width with ${known ? 'known' : 'unavailable'} values`, async ({
		page,
	}) => {
		await page.route('**/v1/sessions/*/information?*', async route => {
			const url = new URL(route.request().url())
			const result = informationFixture({
				hostEpoch: url.searchParams.get('hostEpoch') ?? '',
				target: {
					sessionId: url.pathname.split('/')[3] ?? '',
					incarnation: url.searchParams.get('incarnation') ?? '',
					scopeId: url.searchParams.get('scopeId') || null,
					generation: Number(url.searchParams.get('generation')),
				},
			})
			const fields = result.information.footer.fields
			if (!fields) throw new Error('Missing fixture fields')
			Object.assign(
				fields,
				known
					? { inputTokens: 1250000000000, outputTokens: 0, contextPercent: 100 }
					: { inputTokens: null, outputTokens: null, contextPercent: null },
			)
			await route.fulfill({ json: result, headers: { 'X-Helm-Information': '1' } })
		})
		await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
		await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
		await page.evaluate(() => window.__remoteFixture?.useProductionInformationTransport())
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		for (const height of [420, 844])
			for (const width of [320, 390, 1200, 1280, 1440]) {
				await page.setViewportSize({ width, height })
				if (height === 420 && width < 800) {
					await simulateSafeAreas(page)
					await safeGeometry(page, 'Send')
				}
				const composer = page.locator('.remote-composer')
				await expect(composer).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
				await expect(page.locator('.remote-information-footer')).toHaveCount(0)
				const capsule = page.locator('.remote-compose-surface')
				await expect(capsule).toHaveCSS('backdrop-filter', 'none')
				expect(await capsule.evaluate(node => getComputedStyle(node, '::before').backdropFilter)).toBe('blur(12px)')
				if (width < 1200 && (await page.getByRole('complementary', { name: 'Conversation information' }).count()) === 0)
					await openInfo(page)
				const panel = page.getByRole('complementary', { name: 'Conversation information' })
				await expect(infoValue(panel, 'Source')).toHaveText('Source unavailable')
				await expect(infoValue(panel, 'Reported tokens spent')).toHaveText(known ? '1.3t' : 'Unavailable')
				await expect(infoValue(panel, 'Context used')).toHaveText(known ? '100%' : 'Unavailable')
				await expect(panel.locator('dt').filter({ hasText: /^Model$/ })).toHaveCount(0)
				await page.screenshot({ path: test.info().outputPath(`information-${width}x${height}.png`) })
			}
	})

for (const status of [401, 403])
	test(`information ${status} clears Info values without replay`, async ({ page }) => {
		let refuse = false
		await page.route('**/v1/sessions/*/information?*', async route => {
			if (refuse) {
				await route.fulfill({ status, json: { error: 'unauthorized' } })
				return
			}
			const url = new URL(route.request().url())
			const result = informationFixture({
				hostEpoch: url.searchParams.get('hostEpoch') ?? '',
				target: {
					sessionId: url.pathname.split('/')[3] ?? '',
					incarnation: url.searchParams.get('incarnation') ?? '',
					scopeId: url.searchParams.get('scopeId') || null,
					generation: Number(url.searchParams.get('generation')),
				},
			})
			await route.fulfill({ json: result, headers: { 'X-Helm-Information': '1' } })
		})
		await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
		await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
		await page.evaluate(() => window.__remoteFixture?.useProductionInformationTransport())
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const panel = page.getByRole('complementary', { name: 'Conversation information' })
		await expect(infoValue(panel, 'Reported tokens spent')).not.toHaveText('Unavailable')
		refuse = true
		await expect(
			panel.getByText('Information access ended. Waiting for a fresh authorized observation.', { exact: true }),
		).toBeVisible()
		await expect(infoValue(panel, 'Reported tokens spent')).toHaveCount(0)
		await expect(page.locator('.remote-information-footer')).toHaveCount(0)
		expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	})

test('responsive information retains draft, IME safety and one panel', async ({ page }) => {
	await page.setViewportSize({ width: 1199, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const prompt = page.getByRole('textbox', { name: 'Message', exact: true })
	await prompt.fill('Composition draft')
	await prompt.evaluate(element => {
		element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
		element.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }),
		)
	})
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	await openInfo(page)
	await expect(page.locator('.remote-information-view')).toHaveCSS('animation-name', 'remote-reading-view-in')
	await page.setViewportSize({ width: 1200, height: 844 })
	await expect(page.getByRole('complementary', { name: 'Conversation information' })).toHaveCount(1)
	await prompt.focus()
	await page.setViewportSize({ width: 1199, height: 844 })
	await expect(prompt).toBeFocused()
	await expect(prompt).toHaveValue('Composition draft')
	await expect(page.getByRole('complementary', { name: 'Conversation information' })).toHaveCount(1)
	await page.keyboard.press('Escape')
	await expect(prompt).toBeFocused()
	await expect(page.getByRole('complementary', { name: 'Conversation information' })).toHaveCount(0)
	await openInfo(page)
	await page.getByRole('button', { name: 'Back to conversation', exact: true }).click()
	await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused()
	await expect(prompt).toHaveValue('Composition draft')
})

test('production HTTP decoder drives the real panel and independently expires stale data', async ({ page }) => {
	let calls = 0
	await page.route('**/v1/sessions/*/information?*', async route => {
		calls++
		const url = new URL(route.request().url())
		expect(route.request().headers()['x-helm-information']).toBe('1')
		const result = informationFixture({
			hostEpoch: url.searchParams.get('hostEpoch') ?? '',
			target: {
				sessionId: url.pathname.split('/')[3] ?? '',
				incarnation: url.searchParams.get('incarnation') ?? '',
				scopeId: url.searchParams.get('scopeId') || null,
				generation: Number(url.searchParams.get('generation')),
			},
		})
		result.freshForMs = 500
		await route.fulfill({ json: calls === 1 ? result : { bad: true }, headers: { 'X-Helm-Information': '1' } })
	})
	await page.setViewportSize({ width: 1440, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await page.evaluate(() => window.__remoteFixture?.useProductionInformationTransport())
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const panel = page.getByRole('complementary', { name: 'Conversation information' })
	await expect(panel.getByText('Make available extension information readable')).toHaveCount(1)
	await expect(panel.getByText('Make available extension information readable')).toHaveCount(0)
	await expect(panel.getByText(/Information unavailable/)).toHaveCount(1)
	await expect(infoValue(panel, 'Reported tokens spent')).toHaveCount(0)
	await expect(page.locator('.remote-information-footer')).toHaveCount(0)
	await expect.poll(() => calls).toBeGreaterThanOrEqual(2)
})

test('question fields and draft survive information viewing', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 420 })
	await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft')
	await openInfo(page)
	await page.evaluate(() => window.__remoteFixture?.ask())
	const localBack = page.locator('.remote-composer').getByRole('button', { name: 'Back to conversation', exact: true })
	await expect(localBack).toBeInViewport()
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toHaveCount(0)
	await localBack.click()
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	await expect(page.locator('.remote-question legend').first()).toBeInViewport()
	await page.getByRole('button', { name: 'Edit draft', exact: true }).click()
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Keep this draft')
	await page.evaluate(() => window.__remoteFixture?.setReadOnly(true))
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toBeDisabled()
	for (const field of await page.locator('.remote-question input').all()) await expect(field).toBeDisabled()
})

for (const width of [320, 390])
	test(`safe areas and browser Back retain this conversation at ${width}`, async ({ page }, info) => {
		await page.setViewportSize({ width, height: 420 })
		await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await simulateSafeAreas(page)
		const prompt = page.getByRole('textbox', { name: 'Message', exact: true })
		await prompt.fill('Safe-area draft')
		await safeGeometry(page, 'Send')
		await page.screenshot({ path: info.outputPath(`conversation-safe-area-${width}.png`) })
		const reading = page.getByLabel('Conversation messages', { exact: true })
		const anchor = await reading.evaluate(e => e.scrollTop)
		await prompt.evaluate(e => {
			e.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
			e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }))
		})
		await expect(prompt).toHaveCSS('font-size', '16px')
		await openInfo(page)
		await expect(page.getByRole('heading', { name: 'Information', exact: true })).toBeInViewport()
		await expect(prompt).toBeInViewport()
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport()
		expect(
			await page
				.getByLabel('Conversation messages', { exact: true })
				.evaluate(element => element.getBoundingClientRect().height),
		).toBeGreaterThanOrEqual(96)
		await safeGeometry(page, 'Send')
		await fullyInsideReading(page, '.remote-information h2')
		await page.screenshot({ path: info.outputPath(`information-safe-area-${width}.png`) })
		await page.goBack()
		await expect(page.getByRole('complementary', { name: 'Conversation information' })).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused()
		await expect(prompt).toHaveValue('Safe-area draft')
		expect(await reading.evaluate(e => e.scrollTop)).toBe(anchor)
		expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
		await prompt.evaluate(e => e.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
		await safeGeometry(page, 'Send')
		await openRemoteDestination(page, 'Sessions')
		await expect(page.getByRole('button', { name: /Helm conversation/ })).toBeInViewport()
		await page.goForward()
		await expect(prompt).toHaveValue('Safe-area draft')
	})

test('unchanged information polling does not rerender the transcript; replacement retires data', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByText('Make available extension information readable', { exact: true })).toHaveCount(1)
	await page.waitForTimeout(2100)
	await page.evaluate(() => {
		window.__remoteRenderDurations = []
	})
	await page.waitForTimeout(4100)
	expect(await page.evaluate(() => window.__remoteRenderDurations?.length)).toBe(0)
	await page.evaluate(() => window.__remoteFixture?.replaceOwner())
	await expect(page.getByRole('complementary', { name: 'Conversation information' })).toHaveCount(0)
	await expect(page.getByText('Make available extension information readable', { exact: true })).toHaveCount(0)
})

for (const width of [320, 390])
	test(`hidden question refuses stale submission and local Back restores answers at ${width}`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width, height: 420 })
		await page.goto('/iframe.html?id=views-helm-remote--information-question&viewMode=story')
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await simulateSafeAreas(page)
		await page.getByRole('radio', { name: /Keep the owner/ }).check()
		await page.getByRole('checkbox', { name: /Desktop/ }).check()
		await page.getByRole('radio', { name: /Continue/ }).check()
		const submit = page.getByRole('button', { name: 'Submit answers', exact: true })
		await expect(submit).toBeEnabled()
		await submit.evaluate(element => {
			// Retain the real old React event closure to exercise the synchronous dispatch fence,
			// not a detached DOM click (which would never reach React's delegated listener).
			const key = Object.keys(element).find(value => value.startsWith('__reactProps$'))
			if (!key) throw new Error('Missing production React handler')
			const props = (element as unknown as Record<string, { onClick(event: { preventDefault(): void }): void }>)[key]
			if (!props) throw new Error('Missing Submit handler')
			;(window as unknown as { __informationStaleSubmit: () => void }).__informationStaleSubmit = () =>
				props.onClick({ preventDefault() {} })
		})
		const reading = page.getByLabel('Conversation messages', { exact: true })
		await reading.evaluate(element => {
			const legend = element.querySelector('legend')
			if (!legend) throw new Error('Missing question heading')
			element.scrollTop += legend.getBoundingClientRect().top - element.getBoundingClientRect().top - 8
		})
		await expect(page.locator('.remote-question legend').first()).toBeInViewport()
		const top = await reading.evaluate(element => element.scrollTop)
		await openInfo(page)
		await expect(submit).toHaveCount(0)
		await page.evaluate(() =>
			(window as unknown as { __informationStaleSubmit: () => void }).__informationStaleSubmit(),
		)
		await page.keyboard.press('Control+Enter')
		expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
		const localBack = page
			.locator('.remote-composer')
			.getByRole('button', { name: 'Back to conversation', exact: true })
		await safeGeometry(page, 'Back to conversation')
		await fullyInsideReading(page, '.remote-information h2')
		await expect(page.getByRole('heading', { name: 'Information', exact: true })).toBeInViewport()
		expect(await reading.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96)
		await page.screenshot({ path: info.outputPath(`information-covered-question-${width}.png`) })
		await localBack.click()
		expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
		await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused()
		await expect(page.locator('.remote-question legend').first()).toBeInViewport()
		await fullyInsideReading(page, '.remote-question legend')
		await fullyInsideReading(page, '.remote-question input')
		await safeGeometry(page, 'Submit answers')
		await page.screenshot({ path: info.outputPath(`question-return-safe-area-${width}.png`) })
		await expect(page.getByRole('radio', { name: /Keep the owner/ })).toBeChecked()
		expect(Math.abs((await reading.evaluate(element => element.scrollTop)) - top)).toBeLessThanOrEqual(1)
		await expect(submit).toBeEnabled()
		// Replacement cannot resurrect the retained old answer callback after Info closes.
		await openInfo(page)
		const oldRequest = await page.locator('[data-question-request]').getAttribute('data-question-request')
		await page.evaluate(() => window.__remoteFixture?.replaceQuestion())
		await expect(page.locator('[data-question-request]')).not.toHaveAttribute('data-question-request', oldRequest ?? '')
		await localBack.click()
		await page.evaluate(() =>
			(window as unknown as { __informationStaleSubmit: () => void }).__informationStaleSubmit(),
		)
		expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
		await expect(submit).toBeDisabled()
	})

test('mobile information Back preserves a historical range and its reading anchor', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 420 })
	await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.evaluate(() => window.__remoteFixture?.ask())
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible()
	await page.getByLabel('Conversation messages').evaluate(element => {
		element.scrollTop = 0
	})
	await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
	const history = page.locator('.remote-history')
	await expect(history.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible()
	const reading = page.getByLabel('Conversation messages', { exact: true })
	await reading.evaluate(element => {
		element.scrollTop = element.scrollHeight / 3
	})
	const before = await reading.evaluate(element => ({
		top: element.scrollTop,
		first: element.querySelector('[data-message-id]')?.getAttribute('data-message-id'),
	}))
	await openInfo(page)
	await page.locator('.remote-composer').getByRole('button', { name: 'Back to conversation', exact: true }).click()
	await expect(history.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible()
	const after = await reading.evaluate(element => ({
		top: element.scrollTop,
		first: element.querySelector('[data-message-id]')?.getAttribute('data-message-id'),
	}))
	expect(after.first).toBe(before.first)
	expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
})

for (const question of [false, true])
	test(`covered floating ${question ? 'Answer question' : 'Jump to latest'} cannot receive keyboard activation`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 420 })
		await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		if (question) {
			await page.evaluate(() => window.__remoteFixture?.ask())
			// Capture answer state only after the poll publishes the requested question.
			await expect(page.locator('.remote-question legend').first()).toBeAttached()
		}
		const reading = page.getByLabel('Conversation messages', { exact: true })
		await reading.evaluate(e => {
			e.scrollTop = 0
		})
		await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
		await reading.evaluate(e => {
			e.scrollTop = e.scrollHeight / 3
		})
		const state = () =>
			reading.evaluate(e => ({
				top: e.scrollTop,
				ids: [...e.querySelectorAll('[data-message-id]')].map(m => m.getAttribute('data-message-id')),
				answers: [...e.querySelectorAll('input')].map(m => ({ value: m.value, checked: m.checked })),
			}))
		const before = await state()
		const floating = page.locator('.remote-jump button')
		await expect(floating).toHaveCount(1)
		await openInfo(page)
		const panel = page.getByRole('complementary', { name: 'Conversation information' })
		await expect(panel).toBeVisible()
		// Real Tab traversal, including wraparound. If a covered button receives focus,
		// exercise its real keyboard activation before reporting the regression.
		let covered = false
		for (let i = 0; i < 18; i++) {
			await page.keyboard.press('Tab')
			if (await page.evaluate(() => !!document.activeElement?.closest('.remote-jump'))) {
				covered = true
				await page.keyboard.press('Enter')
			}
		}
		expect(covered).toBe(false)
		expect(await state()).toEqual(before)
		expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
		await page.keyboard.press('Escape')
		await expect(panel).toHaveCount(0)
		expect(await state()).toEqual(before)
		await expect(floating).toHaveCount(1)
		await floating.focus()
		await expect(floating).toBeFocused()
	})

async function openInfo(page: Page) {
	await page.getByRole('button', { name: 'More', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Info', exact: true }).click()
}

for (const width of [320, 390, 1280])
	for (const long of [false, true]) {
		test(`single header row and native fallback remain available without exporters ${width} long=${long}`, async ({
			page,
		}, info) => {
			await page.setViewportSize({ width, height: width === 320 ? 420 : 844 })
			await page.goto('/iframe.html?id=views-helm-remote--browser-harness&viewMode=story')
			await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
			const title = long
				? 'Synthetic owner with a deliberately long conversation title and distinguishing suffix alpha'
				: 'Synthetic owner alpha'
			await page.evaluate(title => {
				const f = window.__remoteFixture
				if (!f) throw new Error('Missing fixture')
				const read = f.transport.directory.bind(f.transport)
				f.transport.directory = async signal => {
					const d = await read(signal)
					d.sessions[0].label = title
					return d
				}
				f.changeTerminalSource('helm')
			}, title)
			await page.getByRole('button', { name: new RegExp(title) }).click()
			const header = page.locator('.remote-chat > .remote-header')
			await expect(header.locator('button')).toHaveCount(1)
			await expect(header.locator('h2')).toHaveClass(/sr-only/)
			expect(await header.evaluate(e => e.getBoundingClientRect().height)).toBe(44)
			await expect(page.locator('.remote-information-footer')).toHaveCount(0)
			await page.locator('.remote-navigation-trigger:visible').click()
			const drawer = page.getByRole('dialog', { name: 'Navigation' })
			await expect(drawer.locator('.remote-navigation-conversation-title')).toHaveText(title)
			await expect(drawer.locator('.remote-navigation-conversation-title')).toHaveCSS('text-overflow', 'ellipsis')
			await expect(drawer.getByRole('button', { name: 'Model' })).toBeVisible()
			await drawer.getByRole('button', { name: 'Close navigation' }).click()
			await page.screenshot({ path: info.outputPath(`header-${width}-${long ? 'long' : 'short'}.png`) })
			await openInfo(page)
			await expect(page.getByRole('heading', { name: 'Information', exact: true })).toBeFocused()
			await expect(page.locator('.remote-current-title')).toHaveText(title)
			await expect(page.locator('.remote-current-conversation .chip')).toHaveText('Main Pi idle')
			await expect(page.locator('.remote-current-conversation')).not.toContainText('openai-codex/gpt-model')
			await expect(
				infoValue(page.getByRole('complementary', { name: 'Conversation information' }), 'Source'),
			).toHaveText('Helm')
			if (width < 1200) await page.keyboard.press('Escape')
			await simulateSafeAreas(page)
			// On desktop the directory owns the top inset and the conversation has no visible trigger.
			expect(await header.evaluate(e => e.getBoundingClientRect().height)).toBe(width >= 800 ? 44 : 80)
			await safeGeometry(page, 'Send')
		})
	}

test('Info focus is explicit for rail and open view, never a resize side effect', async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--information&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const prompt = page.getByRole('textbox', { name: 'Message', exact: true })
	const heading = page.getByRole('heading', { name: 'Information', exact: true })
	await openInfo(page)
	await expect(heading).toBeFocused()
	await prompt.fill('No focus stealing')
	await page.setViewportSize({ width: 1199, height: 844 })
	await expect(prompt).toBeFocused()
	await openInfo(page)
	await expect(heading).toBeFocused()
	await prompt.focus()
	await page.setViewportSize({ width: 1200, height: 844 })
	await expect(prompt).toBeFocused()
	await page.setViewportSize({ width: 1199, height: 844 })
	await expect(prompt).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(prompt).toBeFocused()
	await expect(page.getByRole('complementary', { name: 'Conversation information' })).toHaveCount(0)
	await openInfo(page)
	await page.goBack()
	await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused()
	await expect(prompt).toHaveValue('No focus stealing')
})

test('exporter model is not duplicated and dedup only removes exact title and actual workspace', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--browser-harness&viewMode=story')
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await page.evaluate(async () => {
		const f = window.__remoteFixture
		if (!f) throw new Error('Missing fixture')
		f.enableInformation()
		window.__workspaceDedupState = { currentWorkspace: 'Actual workspace', footerWorkspace: 'Coincident project' }
		const directory = f.transport.directory.bind(f.transport)
		f.transport.directory = async signal => {
			const d = await directory(signal)
			const s = d.sessions[0]
			s.label = 'Exact title'
			s.workspace = window.__workspaceDedupState?.currentWorkspace ?? ''
			s.terminal = {
				source: 'helm',
				name: 'Exact title',
				project: 'Coincident project',
				group: 'Coincident group',
				worktree: null,
				branch: null,
			}
			return d
		}
		if (!f.transport.information) throw new Error('Missing information transport')
		const read = f.transport.information.bind(f.transport)
		f.transport.information = async (...args) => {
			const d = await read(...args)
			if (d.information?.footer.fields)
				Object.assign(d.information.footer.fields, {
					model: null,
					sessionName: 'Exact title',
					cwd: window.__workspaceDedupState?.footerWorkspace ?? null,
				})
			return d
		}
	})
	await page.getByRole('button', { name: /Exact title/ }).click()
	await expect(page.locator('.remote-information-footer')).toHaveCount(0)
	await expect(page.locator('.remote-chat > .remote-header button')).toHaveCount(1)
	const panel = page.locator('.remote-information-body')
	await expect(panel.locator('dt').filter({ hasText: /^Session name$/ })).toHaveCount(0)
	await expect(panel.locator('dt').filter({ hasText: /^Workspace$/ })).toHaveCount(1)
	await expect(panel.locator('dd').filter({ hasText: /^Coincident project$/ })).toHaveCount(2)
	await page.evaluate(() => {
		if (!window.__workspaceDedupState) throw new Error('Missing workspace state')
		window.__workspaceDedupState.footerWorkspace = 'Actual workspace'
		const f = window.__remoteFixture
		if (!f) throw new Error('Missing fixture')
		if (!f.transport.information) throw new Error('Missing information transport')
		const read = f.transport.information.bind(f.transport)
		f.transport.information = async (...args) => {
			const d = await read(...args)
			if (d.information?.footer.fields)
				Object.assign(d.information.footer.fields, {
					sessionName: 'Distinct title',
					cwd: window.__workspaceDedupState?.footerWorkspace ?? null,
				})
			return d
		}
	})
	await expect(panel.locator('dt').filter({ hasText: /^Workspace$/ })).toHaveCount(0)
	await expect(panel.locator('dd').filter({ hasText: /^Distinct title$/ })).toHaveCount(1)

	await page.evaluate(() => {
		if (!window.__workspaceDedupState) throw new Error('Missing workspace state')
		window.__workspaceDedupState.currentWorkspace = '   '
		window.__workspaceDedupState.footerWorkspace = null
	})
	await openRemoteDestination(page, 'Sessions')
	await page.locator('.remote-session-row').filter({ hasText: 'Planning conversation' }).click()
	await page.getByRole('button', { name: /Exact title/ }).click()
	await expect(panel.locator('dt').filter({ hasText: /^Workspace$/ })).toHaveCount(1)
	await expect(
		panel
			.locator('dt')
			.filter({ hasText: /^Workspace$/ })
			.locator('..')
			.locator('dd'),
	).toHaveText('Unavailable')
})

for (const width of [320, 390]) {
	test(`compact empty live entry, long draft, progress and recovery preserve safe-area bounds ${width}`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 420 })
		await page.goto('/iframe.html?id=views-helm-remote--history-reader&viewMode=story')
		await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
		await page.evaluate(() => {
			const f = window.__remoteFixture
			if (!f) throw new Error('Missing fixture')
			f.enableHistory(440, false, 'progress')
			const detail = f.transport.detail.bind(f.transport)
			f.transport.detail = async (...args) => {
				const result = await detail(...args)
				result.snapshot.messages = []
				return result
			}
		})
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await simulateSafeAreas(page)
		const entry = page.getByRole('button', { name: 'Load earlier messages', exact: true })
		await expect(entry).toBeInViewport({ ratio: 1 })
		await safeGeometry(page, 'Send')
		await page.getByLabel('Message', { exact: true }).fill('A long line in the compact editor\n'.repeat(20))
		await safeGeometry(page, 'Send')
		await entry.click()
		await expect(page.getByRole('button', { name: 'Continue search' })).toBeVisible()
		await safeGeometry(page, 'Send')
		await page.getByRole('button', { name: 'Cancel search' }).click()
		await expect(page.getByRole('button', { name: 'Retry history' })).toBeVisible()
		await safeGeometry(page, 'Send')
	})
}
