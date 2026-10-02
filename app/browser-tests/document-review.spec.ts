import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
const evidence = process.env.HELM_DOCUMENT_REVIEW_EVIDENCE ?? '/tmp/helm-document-review-browser'
async function open(page: Page, story = 'reading') {
	await page.goto(`/iframe.html?id=views-document-review--${story}&viewMode=story`)
	await expect(page.getByRole('heading', { name: 'spec.md', exact: true })).toBeVisible({ timeout: 20000 })
}
async function selectPassage(page: Page) {
	const paragraph = page
		.locator('.review-block-text p')
		.filter({ hasText: 'The selected owner must remain exact.' })
		.first()
	await paragraph.evaluate(element => {
		const range = document.createRange()
		range.selectNodeContents(element)
		const selection = window.getSelection()
		selection?.removeAllRanges()
		selection?.addRange(range)
	})
	await page.locator('.review-reading').dispatchEvent('pointerup')
	await expect(page.getByRole('group', { name: 'Selected passage actions' })).toBeVisible()
}
async function proof(page: Page, command: 'settle' | 'edit' | 'replaceOwner', value?: boolean) {
	await page.evaluate(
		({ command, value }) => {
			const fixture = window.__helmDocumentReviewProof
			if (!fixture) throw new Error('Missing production UI fixture')
			if (command === 'settle') fixture.settle(value)
			else fixture[command]()
		},
		{ command, value },
	)
}

test('complete large Markdown, safe content, outline, and wide dark layout', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	let remoteRequests = 0
	page.on('request', request => {
		if (request.url().includes('never-fetch.invalid')) remoteRequests++
	})
	await open(page)
	await expect(page.locator('.review-prose h3')).toHaveCount(500)
	await expect(page.locator('.review-prose table')).toHaveCount(1)
	await expect(page.locator('.review-prose pre')).toContainText('sameConversation')
	await expect(page.locator('.review-prose img')).toHaveCount(0)
	expect(remoteRequests).toBe(0)
	await page.getByRole('button', { name: 'Outline', exact: true }).click()
	await expect(page.getByRole('navigation', { name: 'Section outline' })).toBeVisible()
	await page
		.getByRole('navigation', { name: 'Section outline' })
		.getByRole('button', { name: 'Final acceptance', exact: true })
		.click()
	await expect(page.getByText('Final acceptance sentinel: nothing truncated.', { exact: true })).toBeVisible()
	await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible()
	const divider = page.getByRole('separator', { name: 'Resize conversation pane' })
	await divider.focus()
	await page.keyboard.press('ArrowLeft')
	await expect(divider).toHaveAttribute('aria-valuenow', '400')
	await page.keyboard.press('ArrowRight')
	await expect(divider).toHaveAttribute('aria-valuenow', '380')
	await page.screenshot({ path: `${evidence}/wide-dark-outline-tail.png` })
})

test('selection preserves source block, chosen owner, and same-task double-submit is single-flight', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await selectPassage(page)
	await page
		.getByRole('group', { name: 'Selected passage actions' })
		.getByRole('button', { name: 'Discuss', exact: true })
		.click()
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await expect(input).toBeFocused()
	await input.fill('Explain this guarantee precisely.')
	await page.screenshot({ path: `${evidence}/wide-dark-anchored-discuss.png` })
	await input.evaluate(element => {
		for (let i = 0; i < 2; i++)
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
	})
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
	const request = await page.evaluate(() => window.__helmDocumentReviewProof?.requests[0])
	expect(request?.intent).toBe('discuss')
	expect(request?.sessionId).toBe('review:11111111-1111-4111-8111-111111111111')
	expect(request?.passage?.source).toContain('**rendered quote**')
	expect(request?.passage?.quote).toContain('rendered quote')
	expect(request?.passage?.kind).toBe('block')
	await expect(page.getByRole('button', { name: 'Discuss passage', exact: true })).toBeDisabled()
	await proof(page, 'settle')
	await expect(input).toHaveValue('')
	await page.getByRole('button', { name: 'Back', exact: true }).click()
	const chat = page.getByRole('textbox', { name: 'Whole-document message' })
	await chat.fill('Continue the wider discussion.')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(2)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests[1]?.sessionId)).toBe(request?.sessionId)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests[1]?.passage)).toBeNull()
})

test('keyboard block affordance, Escape focus restoration, and explicit change intent', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	const review = page.getByRole('button', { name: 'Review passage Dispatch guarantees', exact: true })
	await review.focus()
	await page.keyboard.press('Enter')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await expect(input).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(review).toBeFocused()
	await selectPassage(page)
	await page
		.getByRole('group', { name: 'Selected passage actions' })
		.getByRole('button', { name: 'Change', exact: true })
		.click()
	await input.fill('Clarify this paragraph without changing its meaning.')
	await page.getByRole('button', { name: 'Request change', exact: true }).click()
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.requests[0]?.intent)).toBe('change')
})

test('comments edit, resolve, orphan, explicitly re-anchor, and delete without provider sends', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await selectPassage(page)
	await page
		.getByRole('group', { name: 'Selected passage actions' })
		.getByRole('button', { name: 'Discuss', exact: true })
		.click()
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('A saved annotation note.')
	await page.getByRole('button', { name: 'Keep comment', exact: true }).click()
	await expect(page.locator('.review-comment')).toContainText('A saved annotation note.')
	await page.getByRole('button', { name: 'Edit / send feedback', exact: true }).click()
	await page.getByRole('textbox', { name: 'Passage instruction' }).fill('Edited annotation note.')
	await page.getByRole('button', { name: 'Save comment', exact: true }).click()
	await page.getByRole('button', { name: 'Resolve', exact: true }).click()
	await expect(page.locator('.review-comment-meta')).toContainText('Resolved')
	await proof(page, 'edit')
	await expect(page.locator('.review-comment-meta')).toContainText('Anchor changed')
	await page.getByRole('button', { name: 'Re-anchor', exact: true }).click()
	await expect(page.getByText('Choose a current passage to re-anchor your comment.', { exact: false })).toBeVisible()
	await selectPassage(page)
	await page
		.getByRole('group', { name: 'Selected passage actions' })
		.getByRole('button', { name: 'Discuss', exact: true })
		.click()
	await page.getByRole('button', { name: 'Save comment', exact: true }).click()
	await expect(page.locator('.review-comment-meta')).toContainText('Current source')
	await page.screenshot({ path: `${evidence}/wide-dark-comment-lifecycle.png` })
	await page.getByRole('button', { name: 'Delete', exact: true }).click()
	await expect(page.locator('.review-comment')).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('external edit keeps focus/draft, fences stale selection, and exposes change review', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await selectPassage(page)
	await page
		.getByRole('group', { name: 'Selected passage actions' })
		.getByRole('button', { name: 'Change', exact: true })
		.click()
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('Keep my in-progress note.')
	await proof(page, 'edit')
	await expect(input).toHaveValue('Keep my in-progress note.')
	await expect(input).toBeFocused()
	await expect(page.getByRole('button', { name: 'Request change', exact: true })).toBeDisabled()
	await expect(page.locator('.review-passage-composer')).toContainText('This selection is stale.')
	await page.getByRole('button', { name: 'Back', exact: true }).click()
	await page.getByRole('button', { name: 'Changes', exact: true }).click()
	await expect(page.getByRole('heading', { name: 'What changed', exact: true })).toBeVisible()
	await expect(page.locator('.review-change-view')).toContainText('External edit sentinel.')
	await page.screenshot({ path: `${evidence}/wide-dark-change-review.png` })
})

test('unknown outcomes retain text, require explicit acknowledgement, and never replay', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Retain this request text.')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await proof(page, 'settle', true)
	await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await page.getByRole('button', { name: 'Restore request text', exact: true }).click()
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue('Retain this request text.')
	await page.getByRole('button', { name: 'I checked the outcome', exact: true }).click()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
	await page.screenshot({ path: `${evidence}/wide-dark-unknown-recovery.png` })
})

test('replacement owner fences late send results and cannot silently receive another request', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('A held send.')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await proof(page, 'replaceOwner')
	await expect(
		page.getByText('The conversation owner changed. Choose a conversation explicitly before continuing.', {
			exact: true,
		}),
	).toBeVisible()
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Never route to a replacement implicitly.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
})

for (const story of ['reading', 'light'])
	test(`${story}: wide/narrow visual, accessible reading owners and reduced motion`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' })
		for (const [width, height] of [
			[1280, 900],
			[800, 620],
			[640, 520],
		] as const) {
			await page.setViewportSize({ width, height })
			await open(page, story)
			await expect(page.getByLabel('Document reading area', { exact: true })).toHaveAttribute('tabindex', '0')
			expect(
				await page
					.locator('.review-block-action')
					.first()
					.evaluate(element => getComputedStyle(element).transitionDuration),
			).toBe('0s')
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			if (width < 960) {
				await page.getByRole('button', { name: 'Conversation', exact: true }).click()
				await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
				const button = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
				expect(button && button.y + button.height <= height).toBe(true)
				await page.screenshot({ path: `${evidence}/${story}-${width}x${height}-conversation.png` })
				await page.getByRole('button', { name: 'Document', exact: true }).click()
			}
			await page.screenshot({ path: `${evidence}/${story}-${width}x${height}-document.png` })
		}
	})

test('external callers enroll explicitly and choosing them restores scoped unsent drafts', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	const input = page.getByRole('textbox', { name: 'Whole-document message' })
	await input.fill('Draft for the original conversation.')
	await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toHaveCount(0)
	const connected = await page.evaluate(() => window.__helmDocumentReviewProof?.connect('codex'))
	expect(connected).toBeTruthy()
	await page.getByRole('combobox', { name: 'Choose review conversation' }).selectOption(connected as string)
	await expect(input).toHaveValue('')
	await input.fill('Draft for Codex.')
	await page
		.getByRole('combobox', { name: 'Choose review conversation' })
		.selectOption('review:11111111-1111-4111-8111-111111111111')
	await expect(input).toHaveValue('Draft for the original conversation.')
	const codex = await page
		.getByRole('combobox', { name: 'Choose review conversation' })
		.locator('option')
		.evaluateAll(options => options.find(option => option.textContent?.includes('codex'))?.getAttribute('value'))
	expect(codex).toBeTruthy()
	await page.getByRole('combobox', { name: 'Choose review conversation' }).selectOption(codex as string)
	await expect(input).toHaveValue('Draft for Codex.')
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect.poll(() => page.evaluate(() => window.__helmDocumentReviewProof?.requests[0]?.sessionId)).toBe(codex)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
})

test('absent/paused callers keep drafts not sent and no UI action launches an agent', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	for (const story of ['no-connected-agent', 'listener-paused']) {
		await open(page, story)
		const input = page.getByRole('textbox', { name: 'Whole-document message' })
		await input.fill('Keep this feedback in the current review.')
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
		await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toHaveCount(0)
		const id = await page.evaluate(() => window.__helmDocumentReviewProof?.connect('pi'))
		await page.getByRole('combobox', { name: 'Choose review conversation' }).selectOption(id as string)
		await input.fill('Feedback for the explicitly connected Pi.')
		await page.evaluate(() => window.__helmDocumentReviewProof?.disconnect())
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
		await expect(input).toHaveValue('Feedback for the explicitly connected Pi.')
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	}
})

test('failed draft saves offer explicit local discard without provider delivery', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page, 'save-failure')
	const input = page.getByRole('textbox', { name: 'Whole-document message' })
	await input.fill('This unsaved local change may be discarded.')
	await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Discard unsaved changes', exact: true }).click()
	await expect(input).toHaveValue('')
	await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('missing file preserves readable bytes and blocks sends until explicit successful retry', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page, 'missing-file')
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Cannot send against an unavailable file.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await expect(page.locator('.review-prose h1')).toContainText('Collaborative specification')
	await page.screenshot({ path: `${evidence}/wide-dark-missing-file.png` })
	await page.getByRole('button', { name: 'Retry read', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
})
