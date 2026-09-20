import { type Page, expect, test } from '@playwright/test'

const STORY = '/iframe.html?id=views-helm-remote--usage&viewMode=story'
const SIZES = [
	{ name: 'phone', width: 390, height: 844 },
	{ name: 'desktop', width: 1280, height: 844 },
] as const

type Destination = 'list' | 'conversation' | 'usage'

async function show(page: Page, destination: Destination) {
	const tabs = page.getByRole('navigation', { name: 'Remote sections' })
	if (destination === 'usage') {
		await tabs.getByRole('button', { name: 'Usage', exact: true }).click()
		await expect(page.getByRole('region', { name: 'Usage' })).toBeVisible()
		return
	}
	await tabs.getByRole('button', { name: 'Sessions', exact: true }).click()
	if (destination === 'conversation') {
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await expect(page.locator('.remote-conversation')).toBeVisible()
	}
}

/** Structure, not styling: where the bar lives and what it is allowed to sit inside. */
async function structure(page: Page) {
	return await page.evaluate(() => {
		const bar = document.querySelector<HTMLElement>('.remote-tabs')
		if (!bar) throw new Error('Missing destination bar')
		// Only the product's own containers count; the workbench frame scrolls by design.
		const scrollableAncestors: string[] = []
		for (let node = bar.parentElement; node; node = node.parentElement) {
			const overflow = getComputedStyle(node)
			if (['auto', 'scroll'].includes(overflow.overflowY) || ['auto', 'scroll'].includes(overflow.overflowX))
				scrollableAncestors.push(node.className || node.tagName)
			if (node.classList.contains('remote-workspace')) break
		}
		const rect = bar.getBoundingClientRect()
		const contentRegions = ['.remote-directory', '.remote-conversation', '.remote-usage', '.remote-unselected']
			.map(selector => {
				const element = document.querySelector<HTMLElement>(selector)
				if (!element || getComputedStyle(element).display === 'none') return null
				const bounds = element.getBoundingClientRect()
				return { selector, top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right }
			})
			.filter(value => value !== null)
		return {
			parent: bar.parentElement?.className ?? null,
			scrollableAncestors,
			bar: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
			contentRegions,
			documentScrollWidth: document.documentElement.scrollWidth,
			viewport: { width: innerWidth, height: innerHeight },
		}
	})
}

for (const size of SIZES) {
	for (const destination of ['list', 'conversation', 'usage'] as const) {
		test(`the destination bar is a workspace-level row on ${destination} at ${size.name}`, async ({ page }) => {
			await page.setViewportSize({ width: size.width, height: size.height })
			await page.goto(STORY)
			await show(page, destination)
			const layout = await structure(page)

			// A pane cannot own the bar, or leaving that pane would take the bar with it.
			expect(layout.parent).toBe('remote-workspace')
			// Nothing above it may scroll it out of reach.
			expect(layout.scrollableAncestors).toEqual([])
			expect(layout.bar.left).toBe(0)
			expect(layout.bar.right).toBe(size.width)
			expect(layout.bar.bottom).toBeCloseTo(size.height, 0)
			expect(layout.documentScrollWidth).toBeLessThanOrEqual(size.width)

			// Exactly one destination fills the content row, and none of it runs under the bar.
			expect(layout.contentRegions.length).toBeGreaterThan(0)
			for (const region of layout.contentRegions) {
				expect(region.bottom).toBeLessThanOrEqual(layout.bar.top + 1)
				expect(region.left).toBeGreaterThanOrEqual(0)
				expect(region.right).toBeLessThanOrEqual(size.width)
			}
		})
	}
}

test('every destination is reachable from every other one at phone size', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(STORY)
	const tabs = page.getByRole('navigation', { name: 'Remote sections' })

	await show(page, 'conversation')
	await tabs.getByRole('button', { name: 'Usage', exact: true }).click()
	await expect(page.getByRole('region', { name: 'Usage' })).toBeVisible()
	// Leaving a conversation for Usage must not close the conversation.
	await tabs.getByRole('button', { name: 'Sessions', exact: true }).click()
	await expect(page.locator('.remote-conversation')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Back to live conversations' })).toBeVisible()
})

test('no hover styling can stick to a touch device', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(STORY)
	await expect(page.locator('.remote-session-row').first()).toBeVisible()

	// A phone applies :hover to whatever was last touched and leaves it there, so a
	// drag down the session list would light up the row the finger stopped over. Every
	// hover rule must therefore sit behind a hover-capable guard.
	const unguarded = await page.evaluate(() => {
		const found: string[] = []
		const walk = (rules: CSSRuleList, guarded: boolean) => {
			for (const rule of Array.from(rules)) {
				if (rule instanceof CSSMediaRule) {
					walk(rule.cssRules, guarded || rule.conditionText.includes('hover: hover'))
					continue
				}
				if (!(rule instanceof CSSStyleRule) || !rule.selectorText.includes(':hover') || guarded) continue
				// Only rules that can actually reach something here: the bundle also carries
				// desktop-only selectors that never render in Remote.
				const reaches = rule.selectorText
					.split(',')
					.map(selector => selector.replace(/:hover/g, '').trim())
					.some(selector => {
						try {
							return selector !== '' && document.querySelector(selector) !== null
						} catch {
							return false
						}
					})
				if (reaches) found.push(rule.selectorText)
			}
		}
		for (const sheet of Array.from(document.styleSheets)) {
			try {
				walk(sheet.cssRules, false)
			} catch {
				/* A cross-origin workbench sheet owns none of this. */
			}
		}
		return found
	})
	expect(unguarded).toEqual([])
})
