import { type Page, expect, test } from '@playwright/test'

// Story-only send receipt variants (docs/plans/helm-open/spec.md D14, open until Jakub picks). Every frame
// runs the real DocumentReview send path against the staged host; nothing here ships. Today stays the
// production control: no receipt markup at all.

const story = (id: string, frame: string) =>
	`/iframe.html?id=views-helm-open-e-send-receipt--${id}&viewMode=story&args=frame:${frame}`
const VARIANTS = ['a-composer-line', 'b-under-message', 'c-header-steps', 'd-send-button'] as const
const RECEIPT = '.rcpt-line, .rcpt-under, .rcpt-steps, .rcpt-button'

async function open(page: Page, id: string, frame: string) {
	const errors: string[] = []
	page.on('pageerror', error => errors.push(error.message))
	await page.goto(story(id, frame))
	await expect(page.locator('.document-review')).toBeVisible()
	return errors
}

for (const width of [900, 1400]) {
	test.describe(`at ${width}px`, () => {
		test.use({ viewport: { width, height: 860 } })
		for (const id of VARIANTS)
			for (const frame of ['sending', 'received', 'working', 'replied', 'not-sent', 'unconfirmed', 'passage'])
				test(`${id} ${frame} shows a receipt`, async ({ page }, info) => {
					const errors = await open(page, id, frame)
					if (frame === 'unconfirmed') {
						// Every variant keeps today's acknowledgement panel; nothing replays the request.
						await expect(page.locator('.review-receipt')).toBeVisible({ timeout: 8000 })
						await expect(page.getByRole('button', { name: 'I checked the outcome' })).toBeVisible()
					} else if (id === 'd-send-button' && frame === 'sending') {
						await expect(page.getByRole('button', { name: 'Send message' })).toHaveText(/Sending/, { timeout: 8000 })
					} else if (frame === 'replied' && id !== 'a-composer-line' && id !== 'c-header-steps') {
						await expect(page.locator('.review-message-assistant').last()).toBeVisible({ timeout: 8000 })
					} else await expect(page.locator(RECEIPT).first()).toBeVisible({ timeout: 8000 })
					await page.waitForTimeout(400)
					const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
					expect(overflow).toBeLessThanOrEqual(0)
					await page.screenshot({ path: info.outputPath(`${id}-${frame}-${width}.png`) })
					expect(errors).toEqual([])
				})
	})
}

test.use({ viewport: { width: 1400, height: 860 } })

test('today renders no receipt and keeps the production Send label', async ({ page }) => {
	await open(page, 'today', 'received')
	await expect(page.locator('.review-message-user')).toBeVisible({ timeout: 8000 })
	await page.waitForTimeout(400)
	await expect(page.locator(RECEIPT)).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Send message' })).toHaveText('Send')
})

for (const id of VARIANTS)
	test(`${id} not sent keeps the draft in the editor`, async ({ page }) => {
		await open(page, id, 'not-sent')
		await expect(page.getByLabel('Whole-document message')).toHaveValue(/tighten the second section/, {
			timeout: 8000,
		})
		await expect(page.getByText('Not sent').first()).toBeVisible()
		await expect(page.locator('.review-banner')).toHaveCount(0)
	})

test('a tool-return caller never shows a Working step', async ({ page }) => {
	await open(page, 'c-header-steps', 'received')
	await expect(page.locator('.rcpt-steps .rcpt-step')).toHaveCount(3, { timeout: 8000 })
	await expect(page.locator('.rcpt-step[data-state="now"]')).toHaveText('Replied')
})

test.describe('E5 activity line', () => {
	test.use({ viewport: { width: 1400, height: 860 } })
	const frame = async (page: Page, label: string) => {
		await page.getByRole('button', { name: label, exact: true }).click()
		await expect(page.locator('.document-review')).toBeVisible()
	}
	test('shows verb, elapsed and tokens only where a source exists', async ({ page }) => {
		const errors: string[] = []
		page.on('pageerror', error => errors.push(error.message))
		await page.goto('/iframe.html?id=views-helm-open-e-send-receipt--e-5-activity-line&viewMode=story')
		// Visible text plus the screen-reader word: "↓ 16.3k tokens" reads as "16.3k output tokens".
		const line = page.locator('.act-line .act-text')
		await expect(line).toHaveText(/Editing… \(2m 5\ds · ↓ 16\.3k output tokens\)/, { timeout: 8000 })
		// Seen working: the shared §3.21 indicator, grayscale progress. One status, mounted in every phase,
		// carries the verb for screen readers, never the clock.
		const indicator = page.locator('.act-line .activity-indicator')
		const status = page.locator('.act-line output.sr-only')
		await expect(indicator).toHaveAttribute('data-variant', 'progress')
		await expect(status).toHaveText('Claude Code: Editing')
		await frame(page, 'Working · Codex')
		await expect(line).toHaveText(/Editing… \(2m 5\ds · ↓ 11\.8k output tokens\)/, { timeout: 8000 })
		await frame(page, 'Tokens unknown')
		// Nothing bound: elapsed only, and never a claim that the agent is working.
		await expect(line).toHaveText(/With Claude Code… \(2m 5\ds\)/, { timeout: 8000 })
		await expect(line).not.toContainText('tokens')
		await expect(indicator).toHaveCount(0)
		await expect(status).toHaveText('With Claude Code')
		await frame(page, 'Replied')
		await expect(line).toHaveText(/Worked for 3m \ds · ↓ 16\.3k output tokens/, { timeout: 8000 })
		await expect(indicator).toHaveCount(0)
		await expect(status).toHaveText('Claude Code replied')
		await frame(page, 'Not confirmed')
		await expect(page.getByRole('button', { name: 'I checked the outcome' })).toBeVisible({ timeout: 8000 })
		await expect(line).toHaveCount(0)
		expect(errors).toEqual([])
	})
})
