import { randomUUID } from 'node:crypto'
import { type Page, expect, test } from '@playwright/test'
import type { HistoryEntry } from '../../src/remote/history-projection.js'
import { historyRequestSchema } from '../../src/remote/history-protocol.js'
import { RemoteHistoryReader } from '../../src/remote/history-reader.js'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'
import { openRemoteDestination } from './remote-navigation.js'
declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
	}
}
const story = '/iframe.html?id=views-helm-remote--history-reader&viewMode=story'
const id = (n: number) => n.toString(16).padStart(8, '0')
async function fixture(page: Page, count = 440, thinkingBoundary = false) {
	let now = 1
	let head = count
	let backend: RemoteHistoryReader | undefined
	let delay = 0
	let status = 200
	let lost = false
	const actions: string[] = []
	const entries = new Map<string, HistoryEntry>(
		Array.from({ length: count }, (_, index) => {
			const n = index + 1
			return [
				id(n),
				{
					id: id(n),
					parentId: n > 1 ? id(n - 1) : null,
					type: 'message',
					message: { role: 'user', content: `Repeated text\n${'Readable earlier conversation. '.repeat(12)}` },
				},
			]
		}),
	)
	await page.route('**/v1/history/read', async route => {
		const request = historyRequestSchema.parse(route.request().postDataJSON())
		actions.push(request.action.kind)
		backend ??= new RemoteHistoryReader(
			request.target,
			request.hostEpoch,
			() => ({ getLeafId: () => id(head), getEntry: key => entries.get(key) }),
			() => now,
		)
		const result = backend.execute({
			requestId: randomUUID(),
			principalKey: 'fixture-device',
			expiresAt: now + 4000,
			request,
		})
		const responseStatus = status
		if (delay && request.action.kind !== 'close') await new Promise(resolve => setTimeout(resolve, delay))
		if (lost) {
			lost = false
			await route.abort()
			return
		}
		await route
			.fulfill({
				status: responseStatus,
				contentType: 'application/json',
				body: JSON.stringify(
					responseStatus === 200 ? result : { error: responseStatus === 404 ? 'unsupported' : 'unauthorized' },
				),
			})
			.catch(() => {})
	})
	await page.goto(story)
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await page.evaluate(
		({ count, thinkingBoundary }) => window.__remoteFixture?.enableHistory(count, true, undefined, thinkingBoundary),
		{ count, thinkingBoundary },
	)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.locator('.remote-message')).toHaveCount(40)
	return {
		actions,
		entries,
		expire: () => {
			now += 60_001
		},
		delay: (ms: number) => {
			delay = ms
		},
		status: (value: number) => {
			status = value
		},
		lose: () => {
			lost = true
		},
		append: () => {
			head++
			entries.set(id(head), { id: id(head), parentId: id(head - 1), type: 'compaction' })
		},
	}
}
for (const includeTool of [false, true]) {
	test(`historical thinking preserves canonical boundaries and anchors with tools=${includeTool}`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		const f = await fixture(page, 80, true)
		await page.evaluate(() => {
			const f = window.__remoteFixture
			if (!f) throw new Error('Missing fixture')
			const detail = f.transport.detail.bind(f.transport)
			f.transport.detail = async (...args) => {
				const result = await detail(...args)
				const first = result.snapshot.messages[0]
				if (first) first.thinking = '**Thinking:** ***Live boundary thinking***'
				return result
			}
		})
		const thinkingRequests: string[] = []
		page.on('request', request => {
			if (request.url().startsWith('https://example.invalid/')) thinkingRequests.push(request.url())
		})
		await expect(page.locator(`[data-message-id="${id(41)}"] .remote-thinking-text`)).toHaveText(
			'Live boundary thinking',
		)
		const thought = (n: number) =>
			`Historical thought ${n}\n  <img src="https://example.invalid/thinking" onerror="alert(1)">\n${'Literal thinking line\n'.repeat(14)}`
		for (let n = 1; n <= 40; n++) {
			f.entries.set(id(n), {
				id: id(n),
				parentId: n > 1 ? id(n - 1) : null,
				type: 'message',
				message:
					includeTool && n === 10
						? { role: 'toolResult', content: [{ type: 'text', text: 'Historical tool output' }] }
						: {
								role: 'assistant',
								content: [
									{
										type: 'thinking',
										thinking:
											n === 30
												? '**Thinking:**'
												: `\u001b[38;5;245m**Thinking:** **Historical *thought* ${n}**${thought(n).slice(`Historical thought ${n}`.length)}\u001b[39m`,
									},
									...(n === 20 ? [{ type: 'toolCall', id: 'fixture-call', name: 'read', arguments: {} }] : []),
								],
							},
			})
		}
		await page.getByLabel('Message', { exact: true }).fill('Keep the history draft')
		await older(page)
		const pane = page.getByLabel('Conversation messages', { exact: true })
		const ids = Array.from({ length: 40 }, (_, i) => i + 1)
			.filter(n => n !== 30 && (!includeTool || n !== 10))
			.map(id)
		// The thinking-only live boundary41 must be used: skipping it would return2..41 instead.
		await expect
			.poll(() =>
				pane.locator('[data-message-id]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-message-id'))),
			)
			.toEqual(ids)
		await expect(page.getByText(/No visible conversation messages/)).toHaveCount(0)
		await expect(pane.getByRole('heading', { name: 'Pi', exact: true })).toHaveCount(1)
		await expect(pane.getByRole('button', { name: 'Thinking', exact: true })).toHaveCount(0)
		await expect(pane.locator('.remote-thinking-text').first()).toHaveText(thought(1), { useInnerText: false })
		await expect(pane.getByRole('group', { name: 'Thinking', exact: true }).first()).toHaveText(thought(1), {
			useInnerText: false,
		})
		await expect(pane.locator('[data-message-id="0000001e"]')).toHaveCount(0)
		await expect(pane.locator('.remote-thinking-label')).toHaveCount(0)
		await expect(
			pane.locator(
				'.remote-thinking-text img, .remote-thinking-text script, .remote-thinking-text a, .remote-thinking-text strong, .remote-thinking-text em',
			),
		).toHaveCount(0)
		const textBounds = await pane
			.locator('.remote-thinking-text')
			.first()
			.evaluate(node => ({
				height: node.getBoundingClientRect().height,
				scroll: node.scrollHeight,
				client: node.clientHeight,
				whiteSpace: getComputedStyle(node).whiteSpace,
				overflow: getComputedStyle(node).overflowY,
			}))
		expect(textBounds.height).toBeGreaterThan(240)
		expect(textBounds.scroll).toBeLessThanOrEqual(textBounds.client + 1)
		expect(textBounds).toMatchObject({ whiteSpace: 'pre-wrap', overflow: 'visible' })
		const anchor = pane.locator(`[data-message-id="${id(20)}"]`)
		await anchor.evaluate(node => {
			const pane = node.closest('.remote-transcript')
			if (!pane) throw new Error('Missing reading owner')
			pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top + 4
			return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
		})
		const offset = () =>
			anchor.evaluate(node => {
				const owner = node.closest('.remote-transcript')
				if (!owner) throw new Error('Missing reading owner')
				return node.getBoundingClientRect().top - owner.getBoundingClientRect().top
			})
		const before = await offset()
		expect(Math.abs(before + 4)).toBeLessThanOrEqual(1)
		const toggle = async () => {
			await page.getByRole('button', { name: 'More', exact: true }).click()
			await page.getByRole('menuitemcheckbox', { name: 'Show tool activity', exact: true }).click()
		}
		await toggle()
		await expect(pane.getByRole('button', { name: 'Tool calls', exact: true })).toBeVisible()
		await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThanOrEqual(1)
		await toggle()
		await expect(pane.getByRole('button', { name: 'Tool calls', exact: true })).toHaveCount(0)
		await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThanOrEqual(1)
		if (includeTool) {
			await toggle()
			await pane.locator(`[data-message-id="${id(10)}"]`).evaluate(node => {
				const pane = node.closest('.remote-transcript')
				if (!pane) throw new Error('Missing reading owner')
				pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top + 4
				return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
			})
			await toggle()
			await expect(pane.locator(`[data-message-id="${id(10)}"]`)).toHaveCount(0)
			await expect(page.getByText(/Your reading position needs attention/)).toHaveCount(0)
			await expect(page.getByRole('button', { name: 'Newer', exact: true })).toBeVisible()
		}
		await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep the history draft')
		expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
		expect(f.actions).toContain('open')
		expect(thinkingRequests).toEqual([])
	})
}

async function finish(page: Page) {
	for (let n = 0; n < 40; n++) {
		await expect.poll(() => page.locator('.remote-history[aria-busy="true"]').count()).toBe(0)
		const next = page.getByRole('button', { name: 'Continue search', exact: true })
		if (!(await next.count())) break
		await next.click()
	}
	await expect(page.getByRole('button', { name: 'Cancel search', exact: true })).toHaveCount(0)
}
async function openEntry(page: Page) {
	const entry = page.getByRole('button', { name: 'Load earlier messages', exact: true })
	await page.getByLabel('Conversation messages').evaluate(node => {
		node.scrollTop = 0
	})
	await entry.click()
}
async function older(page: Page) {
	if (await page.getByRole('button', { name: 'Load earlier messages', exact: true }).count()) await openEntry(page)
	else await page.getByRole('button', { name: 'Older', exact: true }).click()
	await finish(page)
}
async function newer(page: Page) {
	await page.getByRole('button', { name: 'Newer', exact: true }).click()
	await finish(page)
}
for (const width of [1280, 390, 320]) {
	test(`real history ranges beyond cache, uncached Newer, reread and draft geometry at ${width}`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width, height: 844 })
		const f = await fixture(page)
		const input = page.getByLabel('Message', { exact: true })
		await input.fill('Unsent history draft')
		await older(page)
		await expect(page.locator('[data-message-id]').first()).toHaveAttribute('data-message-id', id(361))
		await expect(page.locator('[data-message-id]').last()).toHaveAttribute('data-message-id', id(400))
		for (let n = 0; n < 5; n++) {
			await older(page)
			await expect(page.locator('[data-message-id]')).toHaveCount(40)
		}
		for (let n = 0; n < 4; n++) await newer(page)
		expect(f.actions).toContain('newer')
		expect(f.actions).toContain('continue')
		const pane = page.getByLabel('Conversation messages')
		await pane.evaluate(node => {
			node.scrollTop = 250
		})
		const anchor = await pane.evaluate(node => {
			const top = node.getBoundingClientRect().top
			const row = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(
				value => value.getBoundingClientRect().bottom > top,
			)
			if (!row) throw new Error('missing anchor')
			return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top }
		})
		f.append()
		await page.evaluate(() => window.__remoteFixture?.append('A later live reply'))
		await page.getByRole('button', { name: 'More', exact: true }).click()
		await page.getByRole('menuitem', { name: 'Reread this range' }).click()
		await finish(page)
		const offset = await pane
			.locator(`[data-message-id="${anchor.id}"]`)
			.evaluate(node => node.getBoundingClientRect().top - (node.parentElement?.getBoundingClientRect().top ?? 0))
		expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(1)
		await expect(input).toHaveValue('Unsent history draft')
		await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true })
		expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
		await page.screenshot({ path: info.outputPath(`history-${width}.png`) })
		expect(await pane.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
		await expect(page.getByText('A later live reply', { exact: true })).toBeVisible()
		await expect(input).toHaveValue('Unsent history draft')
		await openRemoteDestination(page, 'Sessions')
		await page.goForward()
		await expect(input).toHaveValue('Unsent history draft')
	})
}
test('progress cancellation, late completion, expiry, exact retry and unsupported are visible', async ({
	page,
}, info) => {
	const f = await fixture(page, 1000)
	// Long initial comparison starts at the authorized head, not the supplied display anchor.
	await page.evaluate(() => window.__remoteFixture?.enableHistory(40, true))
	await page.waitForTimeout(1100)
	await openEntry(page)
	await expect(page.getByRole('button', { name: 'Continue search', exact: true })).toBeVisible()
	await page.screenshot({ path: info.outputPath('history-progress.png') })
	await page.getByRole('button', { name: 'Cancel search', exact: true }).click()
	await expect(page.getByText(/History search cancelled/)).toBeVisible()
	await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
	await page.evaluate(() => window.__remoteFixture?.enableHistory(1000, true))
	await page.waitForTimeout(1100)
	await older(page)
	f.expire()
	await older(page)
	await expect(page.getByText(/This reading view expired/)).toBeVisible()
	await page.getByRole('button', { name: 'Restart history', exact: true }).click()
	await finish(page)
	f.lose()
	await older(page)
	await expect(page.getByRole('button', { name: 'Retry history', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Retry history', exact: true }).click()
	await finish(page)
	await expect(page.getByText(/History could not be loaded/)).toHaveCount(0)
	f.delay(500)
	await page.getByRole('button', { name: 'Older', exact: true }).click()
	await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
	await page.waitForTimeout(600)
	await expect(page.getByRole('button', { name: 'Newer', exact: true })).toHaveCount(0)
	f.delay(0)
	f.status(404)
	await older(page)
	await expect(page.getByText(/history-compatible Remote host/)).toBeVisible()
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
})
test('sparse hidden activity, root, clipping and current question drafts remain independent', async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 320, height: 420 })
	const f = await fixture(page, 80)
	for (let n = 1; n <= 40; n++)
		f.entries.set(id(n), {
			id: id(n),
			parentId: n > 1 ? id(n - 1) : null,
			type: 'message',
			message: { role: 'toolResult', content: [{ type: 'text', text: 'Private tool output'.repeat(1000) }] },
		})
	await page.getByLabel('Message', { exact: true }).fill('Draft retained with question')
	await older(page)
	await expect(page.getByText(/No visible conversation messages/)).toBeVisible()
	await expect(page.getByText(/Some content was clipped/)).toBeVisible()
	for (
		let n = 0;
		n < 10 && (await page.getByRole('button', { name: 'Older', exact: true }).getAttribute('aria-disabled')) !== 'true';
		n++
	)
		await older(page)
	await expect(page.getByText(/Beginning of this conversation/)).toBeVisible()
	await page.evaluate(() => window.__remoteFixture?.ask())
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible()
	const heading = page.locator('.remote-question legend').first()
	const headingBounds = await heading.evaluate(node => {
		const owner = node.closest('.remote-transcript')
		if (!owner) throw new Error('Missing question reading owner')
		const pane = owner.getBoundingClientRect()
		const rect = node.getBoundingClientRect()
		return {
			inside: rect.top >= pane.top && rect.bottom <= pane.bottom,
			outside: rect.bottom <= pane.top || rect.top >= pane.bottom,
		}
	})
	const jump = page.getByRole('button', { name: 'Answer question', exact: true })
	if (headingBounds.outside) {
		await expect(jump).toBeVisible()
		await jump.click()
		await expect(heading).toBeInViewport({ ratio: 1 })
		await expect(page.getByRole('radio').first()).toBeInViewport({ ratio: 1 })
	} else {
		await expect(jump).toHaveCount(0)
		if (!headingBounds.inside) {
			// Partial heading intersection is not a fully readable decision: scroll the
			// existing owner deliberately before accessing its first answer.
			await heading.evaluate(node => {
				const owner = node.closest<HTMLElement>('.remote-transcript')
				if (!owner) throw new Error('Missing reading owner')
				owner.scrollTop += node.getBoundingClientRect().top - owner.getBoundingClientRect().top - 8
			})
		}
		await expect(heading).toBeInViewport({ ratio: 1 })
	}
	await page.getByRole('radio').first().check()
	await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
	await expect(page.getByRole('radio').first()).toBeChecked()
	await expect(page.getByText('Message draft saved locally', { exact: true })).toBeVisible()
	await page.screenshot({ path: info.outputPath('history-question-320.png') })
	expect(
		await page.getByLabel('Conversation messages').evaluate(node => node.getBoundingClientRect().height),
	).toBeGreaterThanOrEqual(96)
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
})
test('read revocation and owner replacement fence late history without restoring cached private text', async ({
	page,
}) => {
	const f = await fixture(page)
	await older(page)
	f.status(401)
	await older(page)
	await expect(page.getByText(/Access ended. Earlier messages have been cleared/)).toBeVisible()
	await expect(page.getByText('Repeated text', { exact: false })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
})

test('an evicted reading anchor is restored by sealed reread, not an absolute offset on another page', async ({
	page,
}) => {
	const f = await fixture(page)
	await older(page)
	const pane = page.getByLabel('Conversation messages')
	await pane.evaluate(node => {
		node.scrollTop = 800
	})
	const anchor = await pane.evaluate(node => {
		const top = node.getBoundingClientRect().top
		const row = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(
			value => value.getBoundingClientRect().bottom > top,
		)
		if (!row) throw new Error('missing anchor')
		return { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top }
	})
	for (let n = 0; n < 5; n++) await older(page)
	for (let n = 0; n < 5; n++) await newer(page)
	const actual = await pane
		.locator(`[data-message-id="${anchor.id}"]`)
		.evaluate(node => node.getBoundingClientRect().top - (node.parentElement?.getBoundingClientRect().top ?? 0))
	expect(Math.abs(actual - anchor.offset)).toBeLessThanOrEqual(1)
	expect(f.actions).toContain('newer')
})
test('visible-history question jump stays at the question through answers and read-only projection', async ({
	page,
}) => {
	await fixture(page)
	await older(page)
	const pane = page.getByLabel('Conversation messages')
	await pane.evaluate(node => {
		node.scrollTop = 400
	})
	await page.evaluate(() => window.__remoteFixture?.ask())
	await expect(page.locator('.remote-question legend').first()).toBeAttached()
	expect(
		await page
			.locator('.remote-question legend')
			.first()
			.evaluate(node => {
				const owner = node.closest('.remote-transcript')
				if (!owner) throw new Error('Missing reading owner')
				const rect = node.getBoundingClientRect()
				const bounds = owner.getBoundingClientRect()
				return rect.bottom <= bounds.top || rect.top >= bounds.bottom
			}),
	).toBe(true)
	await page.getByRole('button', { name: 'Answer question', exact: true }).click()
	const first = page.getByRole('radio').first()
	await expect(first).toBeInViewport()
	await first.check()
	await expect(first).toBeInViewport()
	await page.evaluate(() => window.__remoteFixture?.setReadOnly(true))
	await expect(first).toBeDisabled()
	await expect(first).toBeChecked()
	await expect(first).toBeInViewport()
})
test('empty root and metadata-only ranges keep a real Newer route; broken ancestry is not root', async ({ page }) => {
	const f = await fixture(page, 400)
	for (let n = 2; n < 360; n++) f.entries.set(id(n), { id: id(n), parentId: id(n - 1), type: 'session_info' })
	// Oldest displayed canonical entry is the root: open seeks beyond it to an empty sealed range.
	await page.evaluate(() => window.__remoteFixture?.enableHistory(40, true))
	await page.waitForTimeout(1100)
	await older(page)
	await expect(page.locator('[data-message-id]')).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Newer', exact: true })).toHaveAttribute('aria-disabled', 'false')
	await newer(page)
	await newer(page)
	await expect(page.getByText(/Beginning of this conversation/)).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Newer', exact: true })).toHaveAttribute('aria-disabled', 'false')
	await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
	f.entries.delete(id(380))
	await older(page)
	await expect(page.getByText(/This range could not be recovered/)).toBeVisible()
	await expect(page.getByRole('button', { name: 'Restart history', exact: true })).toBeVisible()
})
for (const change of ['replaceOwner', 'revoke'] as const) {
	test(`pending history is fenced by ${change} and browser navigation`, async ({ page }) => {
		const f = await fixture(page)
		await page.getByLabel('Message', { exact: true }).fill('Old owner draft')
		f.delay(2500)
		await older(page)
		await page.evaluate(change => window.__remoteFixture?.[change](), change)
		await expect(page.locator('.remote-conversation')).toHaveCount(0)
		await page.waitForTimeout(2700)
		await expect(page.locator('[data-message-id]')).toHaveCount(0)
		if (change === 'replaceOwner') {
			await page.goForward()
			await expect(page.locator('.remote-conversation')).toHaveCount(0)
			await page.getByRole('button', { name: /Helm conversation/ }).click()
			await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
		} else await expect(page.getByRole('heading', { name: 'Access ended' })).toBeVisible()
	})
}

for (const width of [1280, 390, 320])
	for (const question of [false, true]) {
		test(`repair2 reachable progress and recovery ${width} question=${question}`, async ({ page }, info) => {
			await page.setViewportSize({ width, height: 420 })
			const f = await fixture(page, 1000)
			await page.evaluate(() => window.__remoteFixture?.enableHistory(40, true))
			await page.waitForTimeout(1100)
			if (question) {
				await page.evaluate(() => window.__remoteFixture?.ask())
				await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible()
			}
			const pane = page.getByLabel('Conversation messages')
			await openEntry(page)
			await expect(page.getByRole('button', { name: 'Continue search', exact: true })).toHaveCount(1)
			await pane.evaluate(node => {
				node.scrollTop = node.scrollHeight / 2
			})
			async function hit(name: string) {
				const button = page.getByRole('button', { name, exact: true })
				const geometry = await button.evaluate(node => {
					const r = node.getBoundingClientRect()
					const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
					return {
						height: r.height,
						inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
						hit: !!at && node.contains(at),
					}
				})
				expect(geometry, name).toMatchObject({ inside: true, hit: true })
				expect(geometry.height).toBeGreaterThanOrEqual(44)
			}
			await page.screenshot({ path: info.outputPath('progress.png') })
			await hit('Continue search')
			await hit('Cancel search')
			if (question) {
				await hit('Jump to latest')
				await hit('Answer question')
				await page.getByRole('button', { name: 'Answer question', exact: true }).click()
				await expect(page.getByRole('radio').first()).toBeInViewport()
				await page.screenshot({ path: info.outputPath('question.png') })
				await hit('Continue search')
			}
			expect(await pane.evaluate(n => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96)
			await page.getByRole('button', { name: 'Continue search', exact: true }).click()
			await expect(page.getByRole('button', { name: 'Continue search', exact: true })).toHaveCount(1)
			await hit('Cancel search')
			await page.getByRole('button', { name: 'Cancel search', exact: true }).click()
			await hit('Retry history')
			await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
			await page.evaluate(() => window.__remoteFixture?.enableHistory(1000, true))
			await page.waitForTimeout(1100)
			await older(page)
			f.expire()
			await older(page)
			await pane.evaluate(node => {
				node.scrollTop = node.scrollHeight / 2
			})
			await page.screenshot({ path: info.outputPath('recovery.png') })
			await hit('Restart history')
			await page.getByRole('button', { name: 'Restart history', exact: true }).click()
			await finish(page)
			expect(await pane.evaluate(n => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96)
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
		})
	}

test('label-only live boundary is skipped while real-reader canonical ranges remain navigable', async ({ page }) => {
	const f = await fixture(page, 80, true)
	f.entries.set(id(41), {
		id: id(41),
		parentId: id(40),
		type: 'message',
		message: { role: 'assistant', content: [{ type: 'thinking', thinking: '**Thinking:**' }] },
	})
	await page.evaluate(() => {
		const f = window.__remoteFixture
		if (!f) throw new Error('Missing fixture')
		const detail = f.transport.detail.bind(f.transport)
		f.transport.detail = async (...args) => {
			const result = await detail(...args)
			const first = result.snapshot.messages[0]
			if (first) first.thinking = '**Thinking:**'
			return result
		}
	})
	await expect(page.locator('[data-message-id="00000029"]')).toHaveCount(0)
	await page.getByLabel('Message', { exact: true }).fill('Boundary draft')
	await older(page)
	await expect
		.poll(() =>
			page.locator('[data-message-id]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-message-id'))),
		)
		.toEqual(Array.from({ length: 39 }, (_, i) => id(i + 2)))
	await expect(page.getByRole('button', { name: 'Newer', exact: true })).toBeVisible()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Boundary draft')
	expect(await page.evaluate(() => window.__remoteFixture?.commands)).toEqual([])
	expect(f.actions).toContain('open')
})
