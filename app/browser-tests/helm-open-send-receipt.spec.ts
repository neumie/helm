import { type Page, expect, test } from '@playwright/test'

// The send activity line (docs/plans/helm-open/spec.md D14: E5). Every frame runs the PRODUCTION DocumentReview
// send path and line against the story-only staged host that replays the measured native timings. Frames with a
// verb and tokens use the staged host's display-only `activity` (what S12 reads from session files).

const STORY = '/iframe.html?id=views-helm-open-e-send-receipt--e-5-activity-line&viewMode=story'
const story = (frame: string) => `${STORY}&args=frame:${frame}`

async function open(page: Page, frame: string) {
	const errors: string[] = []
	page.on('pageerror', error => errors.push(error.message))
	await page.goto(story(frame))
	await expect(page.locator('.document-review')).toBeVisible()
	return errors
}
const line = (page: Page) => page.locator('.review-activity .review-activity-text')
const indicator = (page: Page) => page.locator('.review-activity .activity-indicator')
const status = (page: Page) => page.locator('.review-activity output.sr-only')

for (const width of [900, 1400]) {
	test.describe(`at ${width}px`, () => {
		test.use({ viewport: { width, height: 860 } })
		for (const frame of ['received', 'claude', 'pi-today', 'replied', 'not-sent', 'unconfirmed', 'passage'])
			test(`${frame} fits without overflow`, async ({ page }, info) => {
				const errors = await open(page, frame)
				if (frame === 'unconfirmed')
					await expect(page.getByRole('button', { name: 'I checked the outcome' })).toBeVisible({ timeout: 8000 })
				else if (frame === 'not-sent') await expect(page.locator('.review-send-refused')).toBeVisible({ timeout: 8000 })
				else await expect(line(page)).toBeVisible({ timeout: 8000 })
				await page.waitForTimeout(400)
				const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
				expect(overflow).toBeLessThanOrEqual(0)
				await page.screenshot({ path: info.outputPath(`${frame}-${width}.png`) })
				expect(errors).toEqual([])
			})
	})
}

test.describe('E5 activity line', () => {
	test.use({ viewport: { width: 1400, height: 860 } })

	test('working with bound activity: indicator, verb, elapsed and output tokens', async ({ page }) => {
		const errors = await open(page, 'claude')
		// Visible text plus the screen-reader word: "↓ 16.3k tokens" reads as "16.3k output tokens".
		await expect(line(page)).toHaveText(/Editing… \([23]m \d+s · ↓ 16\.3k output tokens\)/, { timeout: 8000 })
		// Seen working: the shared §3.21 indicator, grayscale progress, and the verb breathes (§3.21 label).
		await expect(indicator(page)).toHaveAttribute('data-variant', 'progress')
		await expect(page.locator('.review-activity .activity-indicator-label')).toHaveText('Editing…')
		// One status, mounted in every phase, carries the verb for screen readers, never the clock.
		await expect(status(page)).toHaveText('Claude Code: Editing')
		expect(errors).toEqual([])
	})

	test('Codex reads the same way', async ({ page }) => {
		await open(page, 'codex')
		await expect(line(page)).toHaveText(/Editing… \([23]m \d+s · ↓ 11\.8k output tokens\)/, { timeout: 8000 })
		await expect(status(page)).toHaveText('Codex: Editing')
	})

	test('Pi today: its own working report shows Thinking with elapsed time and no tokens', async ({ page }) => {
		await open(page, 'pi-today')
		await expect(line(page)).toHaveText(/^Thinking… \(4\ds\)$/, { timeout: 8000 })
		await expect(indicator(page)).toHaveCount(1)
		await expect(status(page)).toHaveText('Pi: Thinking')
	})

	test('received and nothing bound: elapsed only, never a claim of work', async ({ page }) => {
		await open(page, 'unknown')
		await expect(line(page)).toHaveText(/^With Claude Code… \([23]m \d+s\)$/, { timeout: 8000 })
		await expect(line(page)).not.toContainText('tokens')
		await expect(indicator(page)).toHaveCount(0)
		await expect(status(page)).toHaveText('With Claude Code')
		// The clock runs, the status does not.
		const before = await line(page).textContent()
		await expect.poll(() => line(page).textContent(), { timeout: 3000 }).not.toBe(before)
		await expect(status(page)).toHaveText('With Claude Code')
	})

	test('replied: dim, host-timed, kept under the reply', async ({ page }) => {
		await open(page, 'replied')
		await expect(line(page)).toHaveText(/^Worked for 3m \ds · ↓ 16\.3k output tokens$/, { timeout: 8000 })
		await expect(page.locator('.review-activity')).toHaveClass(/review-activity-done/)
		await expect(indicator(page)).toHaveCount(0)
		await expect(status(page)).toHaveText('Claude Code replied')
		await page.waitForTimeout(1200)
		await expect(line(page)).toHaveText(/^Worked for 3m \ds · ↓ 16\.3k output tokens$/)
	})

	test('not sent: the reason next to the composer, the draft back in the editor, no top banner', async ({ page }) => {
		await open(page, 'not-sent')
		const note = page.locator('.review-companion-bottom .review-send-refused')
		await expect(note).toContainText('Not sent · The agent is not listening.', { timeout: 8000 })
		await expect(note).toContainText('Your message is back in the editor.')
		await expect(page.getByLabel('Whole-document message')).toHaveValue(/tighten the second section/)
		await expect(page.locator('.review-banner')).toHaveCount(0)
		await expect(page.locator('.review-activity')).toHaveCount(0)
		// The host refreshes after the refusal; the note stays until the restored text is edited.
		await page.waitForTimeout(1500)
		await expect(note).toBeVisible()
		await page.getByLabel('Whole-document message').press('End')
		await page.getByLabel('Whole-document message').pressSequentially(' Also')
		await expect(note).toHaveCount(0)
	})

	test('not confirmed keeps the acknowledgement panel and no activity line', async ({ page }) => {
		await open(page, 'unconfirmed')
		await expect(page.getByRole('button', { name: 'I checked the outcome' })).toBeVisible({ timeout: 8000 })
		await expect(page.locator('.review-activity')).toHaveCount(0)
	})

	test('a passage send speaks in its own bubble', async ({ page }) => {
		await open(page, 'passage')
		const bubble = page.getByRole('dialog', { name: 'Passage conversation' })
		await expect(bubble.locator('.review-activity')).toContainText('With Claude Code…', { timeout: 8000 })
		await expect(page.locator('.review-companion .review-activity')).toHaveCount(0)
	})
})

test.describe('reduced motion', () => {
	test.use({ viewport: { width: 1400, height: 860 } })
	test('keeps the words and clamps the indicator animation', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' })
		await open(page, 'claude')
		await expect(line(page)).toContainText('Editing…', { timeout: 8000 })
		const durations = await page
			.locator('.review-activity .activity-indicator *, .review-activity .activity-indicator-label')
			.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationDuration))
		expect(durations.length).toBeGreaterThan(0)
		for (const duration of durations) expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.01)
	})
})
