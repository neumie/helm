import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
const evidence = process.env.HELM_DOCUMENT_CANVAS_EVIDENCE ?? '/tmp/helm-document-canvas-browser'
async function open(page: Page, story: string, canvas = false) {
	await page.goto(`/iframe.html?id=views-document-review--${story}&viewMode=story`)
	await expect(page.getByRole('heading', { name: canvas ? 'proposal.jsx' : 'proposal.md', exact: true })).toBeVisible({
		timeout: 20000,
	})
}
async function view(page: Page, name: string) {
	await page.getByRole('button', { name: 'Document options', exact: true }).click()
	await page
		.getByRole('menuitemradio', { name: name === 'Comments' ? /^Comments(?: \d+)?$/ : name, exact: true })
		.click()
}
async function conversation(page: Page) {
	const button = page.getByRole('button', { name: 'Conversation', exact: true })
	if (await button.isVisible()) await button.click()
}

test('actual React worker interaction is local; Send carries only current explicit public fields', async ({ page }) => {
	await page.setViewportSize({ width: 1180, height: 800 })
	await open(page, 'interactive-canvas', true)
	await expect(page.getByLabel('Public workshop name', { exact: true })).toHaveValue('Workshop')
	await page.getByRole('button', { name: 'Add a seat', exact: true }).click()
	await expect(page.getByText('Seats: 3', { exact: true })).toBeVisible()
	await expect.poll(() => page.evaluate(() => window.__helmCanvasReviewProof?.stats().sends)).toBe(0)
	await page.getByLabel('Local scratch text', { exact: true }).fill('Never include this local scratch text.')
	await page.getByLabel('Local colors', { exact: true }).selectOption(['red', 'blue'])
	await expect(page.getByText('Colors: red, blue', { exact: true })).toBeVisible()
	await expect(page.getByText('Local only · values not included in feedback', { exact: true })).toHaveCount(2)
	await page.getByLabel('Public workshop name', { exact: true }).fill('Morning workshop')
	await expect(page.getByLabel('Public workshop name', { exact: true })).toHaveValue('Morning workshop')
	await page.evaluate(() => window.__helmCanvasReviewProof?.metadataChange())
	await expect(page.getByLabel('Public workshop name', { exact: true })).toHaveValue('Morning workshop')
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Discuss the public values.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect.poll(() => page.evaluate(() => window.__helmCanvasReviewProof?.requests.length)).toBe(1)
	const request = await page.evaluate(() => window.__helmCanvasReviewProof?.requests[0])
	expect(request?.canvasFields).toEqual([
		{ id: 'name', value: 'Morning workshop' },
		{ id: 'count', value: '3' },
	])
	expect(request?.passage).toBeNull()
	await expect(page.getByRole('region', { name: 'Saved review history' })).toHaveCount(0)
})

test('same-task local event cannot send an old public field projection', async ({ page }) => {
	await page.setViewportSize({ width: 1180, height: 800 })
	await open(page, 'interactive-canvas', true)
	await expect(page.getByLabel('Public seats', { exact: true })).toHaveValue('2')
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Read the current seats.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
	await page.evaluate(() => {
		const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]
		buttons.find(button => button.textContent === 'Add a seat')?.click()
		const editor = document.querySelector<HTMLTextAreaElement>('.review-writing-surface textarea')
		editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
	})
	await expect(page.getByText('Seats: 3', { exact: true })).toBeVisible()
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.stats().sends)).toBe(0)
	await page.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect
		.poll(() =>
			page.evaluate(
				() => window.__helmCanvasReviewProof?.requests[0]?.canvasFields?.find(value => value.id === 'count')?.value,
			),
		)
		.toBe('3')
})

for (const size of [
	{ width: 640, height: 520 },
	{ width: 900, height: 600 },
	{ width: 1180, height: 800 },
]) {
	test(`light canvas and one composer retain control bounds at ${size.width}x${size.height}`, async ({ page }) => {
		await page.setViewportSize(size)
		await open(page, 'interactive-canvas-light', true)
		await expect(page.getByRole('button', { name: 'Add a seat', exact: true })).toBeVisible()
		await page.getByRole('button', { name: 'Add a seat', exact: true }).focus()
		await page.keyboard.press('Enter')
		await expect(page.getByText('Seats: 3', { exact: true })).toBeVisible()
		await conversation(page)
		const editor = page.getByRole('textbox', { name: 'Whole-document message' })
		await expect(editor).toBeVisible()
		await editor.fill('A compact reading question.')
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
		for (const label of ['Writing options', 'Feedback intent: Ask', 'Send message']) {
			const box = await page.getByRole('button', { name: label, exact: true }).boundingBox()
			expect(box).not.toBeNull()
			expect(box?.x).toBeGreaterThanOrEqual(0)
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width)
			expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(size.height)
		}
		await page.screenshot({ path: `${evidence}/canvas-light-${size.width}x${size.height}.png` })
	})
}

test('saved replies, passage paint and bubbles remain readable without any caller or replay', async ({ page }) => {
	await page.setViewportSize({ width: 1180, height: 800 })
	await open(page, 'saved-review-history')
	const history = page.getByRole('region', { name: 'Saved review history' })
	await expect(history).toBeVisible()
	await expect(
		history.getByText('The prose stays primary; the companion supports a precise question.', { exact: true }),
	).toBeVisible()
	await expect(page.getByRole('button', { name: 'Show passage conversation' })).toBeVisible()
	await expect.poll(() => page.evaluate(() => CSS.highlights.get('helm-review-saved-annotations')?.size ?? 0)).toBe(1)
	await expect
		.poll(() =>
			page.evaluate(() =>
				[...(CSS.highlights.get('helm-review-saved-annotations') ?? [])].map(range => range.toString()),
			),
		)
		.toEqual(['Keep the reading surface calm'])
	await page.getByRole('button', { name: 'Show passage conversation' }).click()
	await expect(page.getByRole('dialog', { name: 'Passage conversation' })).toBeVisible()
	await expect(
		page
			.getByRole('dialog', { name: 'Passage conversation' })
			.getByText('Why keep this reading surface calm?', { exact: true }),
	).toBeVisible()
	await expect(
		page
			.getByRole('dialog', { name: 'Passage conversation' })
			.getByLabel('Passage messages', { exact: true })
			.getByText('The prose stays primary; the companion supports a precise question.', { exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Close passage conversation' }).click()
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Retain my unsent thought.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.stats().sends)).toBe(0)
	await page.screenshot({ path: `${evidence}/saved-history-1180x800.png` })
})

for (const [story, text] of [
	['saved-review-stale', 'Passage changed; not relocated'],
	['saved-review-unconfirmed', 'Outcome not confirmed'],
	['saved-review-rejected', 'Not sent'],
] as const) {
	test(`${story} is honest read-only evidence`, async ({ page }) => {
		await page.setViewportSize({ width: 640, height: 520 })
		await open(page, story)
		if (story === 'saved-review-stale') {
			await expect(page.getByRole('button', { name: 'Show passage conversation' })).toHaveCount(0)
			expect(await page.evaluate(() => CSS.highlights.get('helm-review-saved-annotations')?.size ?? 0)).toBe(0)
		}
		await conversation(page)
		await expect(page.getByRole('region', { name: 'Saved review history' }).getByText(new RegExp(text))).toBeVisible()
		await page.getByRole('textbox', { name: 'Whole-document message' }).fill('No replay.')
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
		expect(await page.evaluate(() => window.__helmCanvasReviewProof?.stats().sends)).toBe(0)
	})
}

test('compiler refusal offers literal Source and never creates a caller', async ({ page }) => {
	await open(page, 'canvas-compile-error', true)
	await expect(page.getByRole('alert').filter({ hasText: 'Only React imports' })).toBeVisible()
	await view(page, 'Source')
	await expect(page.locator('.review-full-source')).toContainText('export default function Proposal()')
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Cannot send stale fields.')
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.stats().sends)).toBe(0)
})

test('failed comment retry keeps its original payload/fence and never rebases on metadata refresh', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1180, height: 800 })
	await open(page, 'comment-persistence-failure')
	await view(page, 'Comments')
	await page.getByRole('button', { name: 'Resolve', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Retry comment save', exact: true })).toBeVisible()
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('New instruction after the failed comment.')
	await page.evaluate(() => window.__helmCanvasReviewProof?.metadataChange())
	// Settle the existing 300ms preference autosave: it must not retry a failed document append.
	await page.waitForTimeout(450)
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.savedDrafts.length)).toBe(1)
	await page.getByRole('button', { name: 'Retry comment save', exact: true }).click()
	await expect(page.getByRole('alert').filter({ hasText: 'Review metadata changed' })).toBeVisible()
	const payloads = await page.evaluate(() => window.__helmCanvasReviewProof?.savedDrafts)
	expect(payloads).toHaveLength(2)
	expect(payloads?.[1]).toEqual(payloads?.[0])
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.stats().sends)).toBe(0)
	page.once('dialog', dialog => {
		void dialog.accept()
	})
	await page.getByRole('button', { name: 'Discard unsaved changes', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Retry comment save', exact: true })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible()
})

test('final reply discard confirms default keep, preserves original conversation/local draft, and fences a replaced failure', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1180, height: 800 })
	await open(page, 'review-persistence-failure')
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Keep this unrelated local draft.')
	await page.getByRole('button', { name: 'Discard unsaved reply', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: 'Discard unsaved reply?', exact: true })
	await expect(dialog).toBeVisible()
	await expect(dialog.getByRole('button', { name: 'Keep unsaved reply', exact: true })).toBeFocused()
	await expect(dialog).toContainText('Your original conversation is unchanged, and your local draft is kept.')
	await dialog.getByRole('button', { name: 'Keep unsaved reply', exact: true }).click()
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.discarded())).toBe(0)
	await page.getByRole('button', { name: 'Discard unsaved reply', exact: true }).click()
	await page.evaluate(() => window.__helmCanvasReviewProof?.replaceFailure())
	await expect(dialog).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.discarded())).toBe(0)
	await page.getByRole('button', { name: 'Discard unsaved reply', exact: true }).click()
	await dialog.getByRole('button', { name: 'Discard unsaved reply', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Retry review save', exact: true })).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.discarded())).toBe(1)
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.stats().sends)).toBe(0)
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue(
		'Keep this unrelated local draft.',
	)
	await expect(
		page.getByText('This reply remains in the original conversation even if its document save is discarded.', {
			exact: true,
		}),
	).toBeVisible()
})

test('review persistence retry is explicit and does not redispatch feedback', async ({ page }) => {
	await page.setViewportSize({ width: 1180, height: 800 })
	await open(page, 'review-persistence-failure')
	await expect(page.getByRole('alert').filter({ hasText: 'completed reply is not saved' })).toBeVisible()
	await page.getByRole('button', { name: 'Retry review save', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Retry review save', exact: true })).toHaveCount(0)
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.retries())).toBe(1)
	expect(await page.evaluate(() => window.__helmCanvasReviewProof?.stats().sends)).toBe(0)
})

test('native-projected legacy notes survive repeated no-journal load and private autosave without migration', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1180, height: 800 })
	await page.goto('/iframe.html?id=views-document-review--legacy-projected-notes&viewMode=story')
	await expect(page.getByRole('heading', { name: 'spec.md', exact: true })).toBeVisible()
	const original = await page.evaluate(
		async () => (await window.__helmLegacyReviewProof?.api.load())?.data?.draft.annotations,
	)
	expect(original).toHaveLength(1)
	for (let i = 0; i < 3; i++) {
		const before = await page.evaluate(() => window.__helmLegacyReviewProof?.loads() ?? 0)
		await page.evaluate(() => window.__helmLegacyReviewProof?.changed())
		await expect.poll(() => page.evaluate(() => window.__helmLegacyReviewProof?.loads() ?? 0)).toBeGreaterThan(before)
	}
	await view(page, 'Comments')
	await expect(page.locator('.review-comment')).toHaveCount(1)
	await expect(page.locator('.review-comment blockquote')).toHaveText(original?.[0]?.passage.quote ?? '')
	await page
		.getByRole('textbox', { name: 'Whole-document message' })
		.fill('Private draft only; retain my exact legacy comment.')
	await expect
		.poll(() => page.evaluate(() => window.__helmLegacyReviewProof?.savedDrafts.at(-1)?.instruction))
		.toBe('Private draft only; retain my exact legacy comment.')
	const saved = await page.evaluate(() => window.__helmLegacyReviewProof?.savedDrafts)
	expect(saved?.at(-1)?.annotations).toEqual(original)
	expect(saved?.every(value => !Object.hasOwn(value, 'archiveRevision'))).toBe(true)
	expect(await page.evaluate(() => window.__helmLegacyReviewProof?.requests)).toEqual([])
	const state = await page.evaluate(async () => (await window.__helmLegacyReviewProof?.api.load())?.data)
	expect(state?.document.archive?.revision).toBe(state?.document.revision)
	expect(state?.document.archive?.annotations).toEqual([])
	expect(state?.draft.annotations).toEqual(original)
})

test('journal-present native projection replaces clean notes, not pending or failed private saves', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1180, height: 800 })
	await page.goto('/iframe.html?id=views-document-review--legacy-projected-notes&viewMode=story')
	await expect(page.getByRole('heading', { name: 'spec.md', exact: true })).toBeVisible()
	await page.evaluate(async () => {
		const fixture = window.__helmLegacyReviewProof
		const note = (await fixture?.api.load())?.data?.draft.annotations[0]
		if (!fixture || !note) throw new Error('Missing legacy fixture')
		fixture.project([{ ...note, note: 'Authoritative journal projection' }], true)
	})
	await view(page, 'Comments')
	await expect(page.locator('.review-comment')).toContainText('Authoritative journal projection')
	await page.evaluate(() => {
		const fixture = window.__helmLegacyReviewProof
		if (!fixture) throw new Error('Missing legacy fixture')
		const save = fixture.api.save
		fixture.api.save = async value => {
			await new Promise<void>(resolve => Reflect.set(window, '__releaseLegacyPrivateSave', resolve))
			return save(value)
		}
	})
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Private save in flight')
	await expect
		.poll(() => page.evaluate(() => typeof Reflect.get(window, '__releaseLegacyPrivateSave')))
		.toBe('function')
	await page.evaluate(async () => {
		const fixture = window.__helmLegacyReviewProof
		const note = (await fixture?.api.load())?.data?.draft.annotations[0]
		if (!fixture || !note) throw new Error('Missing fixture')
		fixture.project([{ ...note, note: 'Later journal projection' }], true)
	})
	await expect(page.locator('.review-comment')).toContainText('Authoritative journal projection')
	await expect(page.locator('.review-comment')).not.toContainText('Later journal projection')
	await page.evaluate(() => (Reflect.get(window, '__releaseLegacyPrivateSave') as () => void)())
	await expect
		.poll(() => page.evaluate(() => window.__helmLegacyReviewProof?.savedDrafts.at(-1)?.instruction))
		.toBe('Private save in flight')
	await page.evaluate(() => window.__helmLegacyReviewProof?.changed())
	await expect(page.locator('.review-comment')).toContainText('Later journal projection')
	await page.evaluate(() => {
		const fixture = window.__helmLegacyReviewProof
		if (fixture) fixture.api.save = async () => ({ error: 'Private preference save refused' })
	})
	await page.getByRole('textbox', { name: 'Whole-document message' }).fill('Failed private draft still belongs here')
	await expect(page.getByRole('alert').filter({ hasText: 'Private preference save refused' })).toBeVisible()
	await page.evaluate(async () => {
		const fixture = window.__helmLegacyReviewProof
		const note = (await fixture?.api.load())?.data?.draft.annotations[0]
		if (!fixture || !note) throw new Error('Missing fixture')
		fixture.project([{ ...note, note: 'Must not overwrite failed private baseline' }], true)
	})
	await expect(page.locator('.review-comment')).toContainText('Later journal projection')
	await expect(page.locator('.review-comment')).not.toContainText('Must not overwrite failed private baseline')
	await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toHaveValue(
		'Failed private draft still belongs here',
	)
	expect(await page.evaluate(() => window.__helmLegacyReviewProof?.requests)).toEqual([])
})
