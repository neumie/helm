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
	await expect(page.getByRole('button', { name: 'Send passage discussion', exact: true })).toBeDisabled()
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
	await page.getByRole('button', { name: 'Send change request', exact: true }).click()
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
	await expect(page.getByRole('button', { name: 'Send change request', exact: true })).toBeDisabled()
	await expect(page.locator('.review-writing-surface')).toContainText('This selection is stale.')
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

test('one companion editor preserves scope, draft, focus and reading anchor across resize', async ({ page }) => {
	await page.setViewportSize({ width: 800, height: 620 })
	await open(page)
	const review = page.getByRole('button', { name: 'Review passage Dispatch guarantees', exact: true })
	await review.focus()
	const scroll = await page.locator('.review-reading').evaluate(element => element.scrollTop)
	await page.keyboard.press('Enter')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await expect(input).toBeFocused()
	await expect(page.locator('textarea')).toHaveCount(1)
	await expect(page.locator('.review-companion .review-writing-surface')).toHaveCount(1)
	await expect(page.getByRole('button', { name: 'Discuss', exact: true })).toHaveAttribute('aria-pressed', 'true')
	await page.getByRole('button', { name: 'Change', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Change', exact: true })).toHaveAttribute('aria-pressed', 'true')
	await input.fill('Keep this scope and draft across layouts.')
	await page.getByRole('button', { name: 'Document', exact: true }).click()
	await expect(page.locator('.review-block[data-selected="true"]')).toHaveCount(1)
	await page.getByRole('button', { name: 'Conversation', exact: true }).click()
	await expect(input).toHaveValue('Keep this scope and draft across layouts.')
	await input.focus()
	await page.setViewportSize({ width: 1280, height: 900 })
	await expect(input).toBeFocused()
	await expect(input).toHaveValue('Keep this scope and draft across layouts.')
	await page.setViewportSize({ width: 640, height: 520 })
	await expect(input).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(review).toBeFocused()
	expect(await page.locator('.review-reading').evaluate(element => element.scrollTop)).toBe(scroll)
	await review.click()
	await page.getByRole('button', { name: 'Back', exact: true }).click()
	await expect(review).toBeFocused()
})

for (const story of ['reading', 'light'])
	test(`${story}: passage at exact sizes and bounded long quote/draft/receipt`, async ({ page }) => {
		for (const [width, height] of [
			[1280, 900],
			[800, 620],
			[640, 520],
		] as const) {
			await page.setViewportSize({ width, height })
			await open(page, story)
			await selectPassage(page)
			await page
				.getByRole('group', { name: 'Selected passage actions' })
				.getByRole('button', { name: 'Discuss', exact: true })
				.click()
			const input = page.getByRole('textbox', { name: 'Passage instruction' })
			await expect(input).toBeFocused()
			await input.fill('Explain this guarantee precisely, keeping the original conversation and source block.')
			await expect(page.locator('textarea')).toHaveCount(1)
			const bounds = await page.getByRole('button', { name: 'Send passage discussion', exact: true }).boundingBox()
			expect(bounds && bounds.y + bounds.height <= height).toBe(true)
			await page.screenshot({ path: `${evidence}/${story}-${width}x${height}-passage.png` })
		}
		await page.getByRole('button', { name: 'Back', exact: true }).click()
		await page.evaluate(() =>
			window.__helmDocumentReviewProof?.edit('Preserve the original session and exact source block. '.repeat(100)),
		)
		await page.getByRole('button', { name: 'Document', exact: true }).click()
		await page.locator('.review-block-action button').last().click()
		const input = page.getByRole('textbox', { name: 'Passage instruction' })
		await input.fill('A request with an uncertain receipt.')
		await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
		await proof(page, 'settle', true)
		await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible()
		await input.fill('A long unsent local draft.\n'.repeat(100))
		await expect(page.getByRole('button', { name: 'Send passage discussion', exact: true })).toHaveText('Send')
		await expect(page.locator('.review-receipt')).toBeVisible()
		const bounds = await page.getByRole('button', { name: 'Send passage discussion', exact: true }).boundingBox()
		expect(bounds && bounds.y + bounds.height <= 520).toBe(true)
		await page.screenshot({ path: `${evidence}/${story}-640x520-long-passage-draft-receipt.png` })
	})

test('paused/disconnected listeners retain passage drafts and local comments without sends', async ({ page }) => {
	await page.setViewportSize({ width: 800, height: 620 })
	await open(page, 'listener-paused')
	await selectPassage(page)
	await page
		.getByRole('group', { name: 'Selected passage actions' })
		.getByRole('button', { name: 'Discuss', exact: true })
		.click()
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('Local comment while the listener is paused.')
	await expect(page.getByRole('button', { name: 'Send passage discussion', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Keep comment', exact: true })).toBeEnabled()
	await page.evaluate(() => window.__helmDocumentReviewProof?.disconnect())
	await expect(input).toHaveValue('Local comment while the listener is paused.')
	await expect(page.getByRole('button', { name: 'Send passage discussion', exact: true })).toBeDisabled()
	await page.getByRole('button', { name: 'Keep comment', exact: true }).click()
	await expect(page.locator('.review-comment')).toContainText('Local comment while the listener is paused.')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
})

test('dispatch settlement preserves a newer draft and the selected passage', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	await page.getByRole('button', { name: 'Review passage Dispatch guarantees', exact: true }).click()
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('The admitted request.')
	await page.getByRole('button', { name: 'Send passage discussion', exact: true }).click()
	await input.fill('A newer unsent draft.')
	await proof(page, 'settle')
	await expect(input).toHaveValue('A newer unsent draft.')
	await expect(page.locator('.review-block[data-selected="true"]')).toHaveCount(1)
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
})

async function compactBounds(page: Page) {
	return page.evaluate(() => {
		const bounds = (selector: string) => {
			const element = document.querySelector<HTMLElement>(selector)
			if (!element) throw new Error(`Missing ${selector}`)
			const r = element.getBoundingClientRect()
			let fullyInside = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
			for (let parent = element.parentElement; parent; parent = parent.parentElement) {
				const css = getComputedStyle(parent)
				const p = parent.getBoundingClientRect()
				if (css.overflowY !== 'visible') fullyInside &&= r.top >= p.top && r.bottom <= p.bottom
				if (css.overflowX !== 'visible') fullyInside &&= r.left >= p.left && r.right <= p.right
			}
			return {
				selector,
				top: r.top,
				bottom: r.bottom,
				height: r.height,
				fullyInside,
				overflowY: getComputedStyle(element).overflowY,
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
			}
		}
		return {
			controls: [
				'.review-scope-heading',
				'.review-writing-surface textarea',
				'.review-intents',
				'.review-compose-actions',
				'.review-compose-actions .btn-primary',
			].map(bounds),
			receipt: bounds('.review-feedback-status'),
			chat: bounds('.review-chat'),
			context: bounds('.review-passage-context'),
			bottom: bounds('.review-companion-bottom'),
		}
	})
}

for (const story of ['reading', 'light'])
	test(`${story}: compact expanded passage details and stale warning protect full controls and scrollable recovery`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width: 640, height: 520 })
		await open(page, story)
		await page.evaluate(() =>
			window.__helmDocumentReviewProof?.edit('Preserve the original session and exact source block. '.repeat(100)),
		)
		await page.locator('.review-block-action button').last().click()
		const input = page.getByRole('textbox', { name: 'Passage instruction' })
		await input.fill('An uncertain request.')
		const send = page.getByRole('button', { name: 'Send passage discussion', exact: true })
		await send.click()
		await expect(page.getByText('Dispatched', { exact: true })).toBeVisible()
		await proof(page, 'settle', true)
		await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible()
		await input.fill('Long retained local draft.\n'.repeat(100))
		await expect(send).toHaveText('Send')
		const context = page.getByRole('region', { name: 'Passage context' })
		await context.locator('summary').click()
		for (const state of ['expanded-details-unknown', 'expanded-details-stale-unknown']) {
			if (state.includes('stale')) {
				await proof(page, 'edit')
				await expect(context.getByRole('alert')).toContainText('This selection is stale.')
				await expect(send).toBeDisabled()
			}
			const measured = await compactBounds(page)
			for (const control of measured.controls) expect(control.fullyInside, JSON.stringify(control)).toBe(true)
			expect(measured.controls[1]?.height).toBeGreaterThanOrEqual(40)
			expect(measured.receipt.height).toBeGreaterThanOrEqual(32)
			expect(measured.chat.height).toBeGreaterThanOrEqual(96)
			expect(measured.receipt.fullyInside).toBe(true)
			expect(measured.chat.fullyInside).toBe(true)
			expect(measured.context.overflowY).toBe('auto')
			expect(measured.context.scrollHeight).toBeGreaterThan(measured.context.clientHeight)
			await testInfo.attach(`${story}-${state}-computed-bounds`, {
				body: JSON.stringify(measured, null, 2),
				contentType: 'application/json',
			})
			await context.locator('summary').focus()
			await expect(context.locator('summary')).toBeInViewport()
			await context.focus()
			await page.keyboard.press('End')
			await expect
				.poll(() =>
					context.evaluate(element => Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight))),
				)
				.toBeLessThanOrEqual(1)
			if (state.includes('stale')) await expect(context.getByRole('alert')).toBeInViewport()
			else await expect(context.locator('.review-scope-details p')).toBeInViewport()
			const recovery = page.getByRole('region', { name: 'Delivery and recovery' })
			await recovery.focus()
			await page.keyboard.press('Home')
			await expect.poll(() => recovery.evaluate(element => element.scrollTop)).toBe(0)
			await page.screenshot({ path: `${evidence}/${story}-640x520-${state}.png` })
			await page.keyboard.press('End')
			await expect
				.poll(() =>
					recovery.evaluate(element => Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight))),
				)
				.toBeLessThanOrEqual(1)
			await expect(recovery.getByRole('button', { name: 'Discard text', exact: true })).toBeInViewport()
			await expect(input).toHaveValue('Long retained local draft.\n'.repeat(100))
		}
		expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(1)
	})

test('wide-start passage remembers Conversation and narrowing preserves focused editor without resize focus calls', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 })
	await open(page)
	const review = page.getByRole('button', { name: 'Review passage Dispatch guarantees', exact: true })
	await review.focus()
	await page.keyboard.press('Enter')
	const input = page.getByRole('textbox', { name: 'Passage instruction' })
	await input.fill('Wide-start draft and passage.')
	await input.evaluate(element => {
		const original = element.focus.bind(element)
		Object.assign(window, { __reviewResizeFocusCalls: 0 })
		Object.defineProperty(element, 'focus', {
			configurable: true,
			value: (options?: FocusOptions) => {
				Object.assign(window, { __reviewResizeFocusCalls: Reflect.get(window, '__reviewResizeFocusCalls') + 1 })
				original(options)
			},
		})
	})
	await page.setViewportSize({ width: 640, height: 520 })
	await expect(input).toBeVisible()
	await expect(input).toBeFocused()
	await expect(input).toHaveValue('Wide-start draft and passage.')
	expect(await page.evaluate(() => Reflect.get(window, '__reviewResizeFocusCalls'))).toBe(0)
	await page.screenshot({ path: `${evidence}/reading-wide-to-640x520-focused-passage.png` })
	await page.getByRole('button', { name: 'Document', exact: true }).click()
	await page.setViewportSize({ width: 1280, height: 900 })
	await page.setViewportSize({ width: 640, height: 520 })
	await expect(page.getByLabel('Document reading area', { exact: true })).toBeVisible()
	await expect(input).not.toBeVisible()
	await page.setViewportSize({ width: 1280, height: 900 })
	await input.focus()
	const calls = await page.evaluate(() => Reflect.get(window, '__reviewResizeFocusCalls'))
	await page.setViewportSize({ width: 640, height: 520 })
	await expect(input).toBeFocused()
	await expect(input).toBeVisible()
	expect(await page.evaluate(() => Reflect.get(window, '__reviewResizeFocusCalls'))).toBe(calls)
	await expect(input).toHaveValue('Wide-start draft and passage.')
	expect(await page.evaluate(() => window.__helmDocumentReviewProof?.requests.length)).toBe(0)
	await page.keyboard.press('Escape')
	await expect(review).toBeFocused()
})
