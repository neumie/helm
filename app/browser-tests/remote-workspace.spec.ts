import { expect, test } from '@playwright/test'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
		__remoteRenderDurations?: number[]
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
		await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
		await page.getByRole('button', { name: /Planning conversation/ }).click()
		await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
		await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my unsent draft')
		await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({ path: testInfo.outputPath(`remote-${width}.png`) })
	})
}

for (const width of [320, 390, 799, 800]) {
	test(`responsive conversation ownership at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 844 })
		await page.goto(path)
		const workspace = page.locator('.remote-workspace')
		const directory = page.locator('.remote-directory')
		const conversation = page.locator('.remote-conversation')
		await expect(workspace).toBeVisible()
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await expect(conversation).toBeVisible()
		const selected = await Promise.all([
			conversation.boundingBox(),
			directory.boundingBox(),
			page.getByRole('button', { name: 'Back to live conversations', exact: true }).boundingBox(),
			page.getByLabel('Message', { exact: true }).boundingBox(),
			page.getByLabel('Conversation messages').boundingBox(),
		])
		const [conversationBox, directoryBox, backBox, messageBox, readingBox] = selected
		if (!conversationBox || !backBox || !messageBox || !readingBox) throw new Error('Missing detail geometry')
		if (width <= 799) {
			expect(conversationBox.x).toBe(0)
			expect(conversationBox.width).toBe(width)
		} else {
			expect(conversationBox.x).toBe(320)
			expect(conversationBox.width).toBe(width - 320)
		}
		expect(backBox.x).toBeGreaterThanOrEqual(0)
		expect(backBox.x + backBox.width).toBeLessThanOrEqual(width)
		expect(messageBox.x).toBeGreaterThanOrEqual(0)
		expect(messageBox.x + messageBox.width).toBeLessThanOrEqual(width)
		expect(readingBox.height).toBeGreaterThanOrEqual(96)
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		if (width <= 799) {
			expect(directoryBox).toBeNull()
		} else {
			if (!directoryBox) throw new Error('Missing desktop directory geometry')
			expect(directoryBox.width).toBe(320)
		}
		if (width === 320 || width === 390) await page.screenshot({ path: testInfo.outputPath(`responsive-${width}.png`) })
		await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
		await expect(directory).toBeVisible()
		await expect(conversation).toBeHidden()
		const directoryAfterBack = await directory.boundingBox()
		if (!directoryAfterBack) throw new Error('Missing list geometry after Back')
		expect(directoryAfterBack.width).toBe(width <= 799 ? width : 320)
	})
}

test('scrolling within one reading state does not commit the conversation tree per event', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const transcript = page.getByLabel('Conversation messages')
	await expect(transcript.locator('.remote-message')).toHaveCount(40)
	const message = page.getByLabel('Message', { exact: true })
	const samplesBeforeInteraction = await page.evaluate(() => window.__remoteRenderDurations?.length ?? 0)
	await message.fill('Profiler attestation')
	await expect(message).toHaveValue('Profiler attestation')
	await expect
		.poll(() => page.evaluate(() => window.__remoteRenderDurations?.length ?? 0))
		.toBeGreaterThan(samplesBeforeInteraction)
	await message.fill('')
	await expect(message).toHaveValue('')
	await page.evaluate(() => {
		window.__remoteRenderDurations = []
	})
	const result = await transcript.evaluate(async node => {
		if (!(node instanceof HTMLElement)) throw new Error('Missing transcript')
		const events: number[] = []
		for (let index = 1; index <= 10; index++) {
			await new Promise(resolve => requestAnimationFrame(resolve))
			const top = Math.round((node.scrollHeight - node.clientHeight) * (index / 11))
			node.scrollTop = top
			node.dispatchEvent(new Event('scroll', { bubbles: true }))
			events.push(node.scrollTop)
		}
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		return { events, renders: window.__remoteRenderDurations ?? [] }
	})
	expect(result.events).toHaveLength(10)
	expect(result.renders.length).toBeLessThanOrEqual(2)
})

test('metadata-only source changes update the detail without changing the conversation revision', async ({ page }) => {
	await page.goto(path)
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await page.evaluate(() => {
		window.__remoteFixture?.showTerminalMetadataExample()
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' })).toBeVisible()
	await page.locator('.remote-session-row').filter({ hasText: 'Source: Okena' }).first().click()
	await expect(page.locator('.remote-meta .remote-session-source')).toHaveText('Source: Okena')
	await page.evaluate(() => {
		window.__remoteFixture?.changeTerminalSource('helm')
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.locator('.remote-meta .remote-session-source')).toHaveText('Source: Helm')
	await expect(page.locator('.remote-message')).toHaveCount(40)
})

test('connected-only detail transitions fence and restore production controls', async ({ page }) => {
	await page.goto('/iframe.html?id=views-helm-remote--questions&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.getByRole('radio', { name: /Keep the owner/ }).check()
	await page.getByRole('checkbox', { name: /Desktop/ }).check()
	await page.getByLabel('Custom answer: Custom').fill('Ready')
	const submit = page.getByRole('button', { name: 'Submit answers' })
	await expect(submit).toBeEnabled()
	await page.evaluate(() => {
		window.__remoteFixture?.setConnected(false)
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(submit).toBeDisabled()
	await expect(page.getByRole('radio', { name: /Keep the owner/ })).toBeDisabled()
	await page.evaluate(() => {
		window.__remoteFixture?.setConnected(true)
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(submit).toBeEnabled()
	await expect(page.getByRole('radio', { name: /Keep the owner/ })).toBeEnabled()
})

test('tail-follow restores after capability and terminal-only notices without message changes', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const transcript = page.getByLabel('Conversation messages')
	await expect(transcript.locator('.remote-message')).toHaveCount(40)
	const atTail = () => transcript.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight <= 1)
	await expect.poll(atTail).toBe(true)
	await page.evaluate(() => {
		window.__remoteFixture?.setReadOnly(true)
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(transcript.getByText('Sending messages is read-only for this device.', { exact: true })).toBeVisible()
	await expect.poll(atTail).toBe(true)
	await page.evaluate(() => {
		window.__remoteFixture?.setReadOnly(false)
		window.__remoteFixture?.showTerminalDialog()
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(
		transcript.getByText('This dialog needs the original terminal. Remote does not support this custom UI.', {
			exact: true,
		}),
	).toBeVisible()
	await expect.poll(atTail).toBe(true)
})

test('metadata and model presentation changes preserve tail and anchored reading', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const transcript = page.getByLabel('Conversation messages')
	await expect(transcript.locator('.remote-message')).toHaveCount(40)
	const tailGap = () => transcript.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)
	await expect.poll(tailGap).toBeLessThanOrEqual(1)

	await page.evaluate(() => {
		window.__remoteFixture?.setTerminalMetadata(true)
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.locator('.remote-meta .remote-session-branch')).toBeVisible()
	await expect.poll(tailGap).toBeLessThanOrEqual(1)

	await page.evaluate(() => {
		window.__remoteFixture?.setModel('expanded-model-'.repeat(10))
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.locator('.remote-meta .remote-session-model')).toContainText('expanded-model-')
	await expect.poll(tailGap).toBeLessThanOrEqual(1)

	await page.evaluate(() => {
		window.__remoteFixture?.setTerminalMetadata(false)
		window.__remoteFixture?.setModel('openai-codex/gpt-model')
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.locator('.remote-meta .remote-session-branch')).toHaveCount(0)
	await expect(page.locator('.remote-meta .remote-session-model')).toContainText('openai-codex/gpt-model')
	await expect.poll(tailGap).toBeLessThanOrEqual(1)

	await transcript.evaluate(node => {
		node.scrollTop = node.scrollHeight / 2
		node.dispatchEvent(new Event('scroll', { bubbles: true }))
	})
	await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
	const anchor = await transcript.evaluate(node => {
		const paneTop = node.getBoundingClientRect().top
		const element = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(
			child => child.getBoundingClientRect().bottom > paneTop,
		)
		if (!element) throw new Error('Missing metadata anchor')
		return { id: element.dataset.messageId ?? '', offset: element.getBoundingClientRect().top - paneTop }
	})
	const anchorOffset = () =>
		transcript.evaluate((node, id) => {
			const element = node.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
			if (!element) throw new Error('Metadata anchor disappeared')
			return element.getBoundingClientRect().top - node.getBoundingClientRect().top
		}, anchor.id)
	const expectAnchor = async () => {
		const offset = await anchorOffset()
		expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(1)
	}

	await page.evaluate(() => {
		window.__remoteFixture?.setTerminalMetadata(true)
		window.__remoteFixture?.setModel('expanded-model-'.repeat(10))
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.locator('.remote-meta .remote-session-branch')).toBeVisible()
	await expect(page.locator('.remote-meta .remote-session-model')).toContainText('expanded-model-')
	await expectAnchor()

	await page.evaluate(() => {
		window.__remoteFixture?.setTerminalMetadata(false)
		window.__remoteFixture?.setModel('openai-codex/gpt-model')
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.locator('.remote-meta .remote-session-branch')).toHaveCount(0)
	await expect(page.locator('.remote-meta .remote-session-model')).toContainText('openai-codex/gpt-model')
	await expectAnchor()
})

test('real wheel scrolling stays anchored while streaming and immediate Back reopens the same reading state', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const transcript = page.getByLabel('Conversation messages')
	await expect(transcript.locator('.remote-message')).toHaveCount(40)
	const box = await transcript.boundingBox()
	if (!box) throw new Error('Missing transcript bounds')
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	const beforeWheel = await transcript.evaluate(node => node.scrollTop)
	await page.mouse.wheel(0, -320)
	await expect.poll(() => transcript.evaluate(node => node.scrollTop)).not.toBe(beforeWheel)
	const anchor = await transcript.evaluate(node => {
		const top = node.getBoundingClientRect().top
		const element = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(
			child => child.getBoundingClientRect().bottom > top,
		)
		if (!element) throw new Error('Missing wheel anchor')
		return { id: element.dataset.messageId, top: element.getBoundingClientRect().top }
	})
	await page.evaluate(() => {
		window.__remoteFixture?.append('A real-wheel streamed update')
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(transcript.getByText('A real-wheel streamed update', { exact: true })).toBeVisible()
	const afterStream = await transcript.locator(`[data-message-id="${anchor.id}"]`).boundingBox()
	if (!afterStream) throw new Error('Stream anchor disappeared')
	expect(Math.abs(afterStream.y - anchor.top)).toBeLessThanOrEqual(1)
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const reopened = await transcript.locator(`[data-message-id="${anchor.id}"]`).boundingBox()
	if (!reopened) throw new Error('Reopened anchor disappeared')
	expect(Math.abs(reopened.y - anchor.top)).toBeLessThanOrEqual(1)
})

test('questions open at the first decision and retain answers only for the same request and identity', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--questions&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByText('Choose an implementation?', { exact: true })).toBeInViewport()
	await expect(page.getByRole('button', { name: 'Submit answers' })).toBeDisabled()
	await page.getByRole('radio', { name: /Keep the owner/ }).check()
	await page.getByRole('checkbox', { name: /Desktop/ }).check()
	await page.getByLabel('Custom answer: Custom').fill('Keep this answer while I browse')
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await page.getByRole('button', { name: /Planning conversation/ }).click()
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByRole('radio', { name: /Keep the owner/ })).toBeChecked()
	await expect(page.getByRole('checkbox', { name: /Desktop/ })).toBeChecked()
	await expect(page.getByLabel('Custom answer: Custom')).toHaveValue('Keep this answer while I browse')
	await page.evaluate(() => {
		window.__remoteFixture?.replaceQuestion()
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.getByRole('radio', { name: /Keep the owner/ })).not.toBeChecked()
	await expect(page.getByRole('checkbox', { name: /Desktop/ })).not.toBeChecked()
	await expect(page.getByLabel('Custom answer: Custom')).toHaveValue('')
})

test('a question arriving while reading older messages waits for deliberate navigation', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const transcript = page.getByLabel('Conversation messages')
	await transcript.evaluate(node => {
		node.scrollTop = node.scrollHeight / 2
	})
	const before = await transcript.evaluate(node => node.scrollTop)
	await page.evaluate(() => {
		window.__remoteFixture?.ask()
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.getByRole('button', { name: 'Answer question', exact: true })).toBeVisible()
	const after = await transcript.evaluate(node => node.scrollTop)
	expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
	await page.getByRole('button', { name: 'Answer question', exact: true }).click()
	await expect(page.getByText('Choose an implementation?', { exact: true })).toBeInViewport()
})

test('the directory uses one scroll owner and labels scope as live-only', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 420 })
	await page.goto(path)
	await expect(page.getByRole('navigation', { name: 'Live sessions' })).toBeVisible()
	await expect.poll(() => page.evaluate(() => !!window.__remoteFixture)).toBe(true)
	await expect(page.getByLabel('Live session scope')).toHaveCount(0)
	await page.evaluate(() => {
		const fixture = window.__remoteFixture
		if (!fixture) throw new Error('Missing mounted Remote fixture')
		fixture.addScopedSession()
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.locator('#remote-scope')).toBeVisible()
	await page.locator('#remote-scope').selectOption('personal')
	await expect(page.locator('.remote-session-row')).toHaveCount(1)
	await expect(page.getByText('Continue a live conversation in Pi.', { exact: true })).toHaveCount(0)
	await expect(page.getByLabel('Find a session', { exact: true })).toHaveCount(0)
	await expect(page.getByPlaceholder('Search live conversations')).toBeVisible()
	await expect(page.getByRole('navigation', { name: 'App navigation' })).toHaveCount(0)
	await expect(page.getByRole('heading', { name: 'Live sessions', exact: true })).toBeVisible()
	expect(await page.locator('.remote-directory-body').evaluate(node => getComputedStyle(node).overflowY)).toBe('auto')
	expect(await page.locator('.remote-session-list').evaluate(node => getComputedStyle(node).overflowY)).toBe('visible')
})

test('keyboard submit is IME-safe and rapid activation sends once', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const message = page.getByLabel('Message', { exact: true })
	await message.fill('line one')
	await message.press('End')
	await message.press('Enter')
	await message.type('line two')
	await expect(message).toHaveValue('line one\nline two')
	await page.evaluate(() => {
		const input = document.querySelector<HTMLTextAreaElement>('#remote-prompt')
		if (!input) throw new Error('Missing message editor')
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, isComposing: true }))
	})
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	await message.press('Control+Enter')
	await message.press('Control+Enter')
	await expect.poll(() => page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(1)
})

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
	const transcriptHeight = await page
		.getByLabel('Conversation messages')
		.evaluate(node => node.getBoundingClientRect().height)
	expect(transcriptHeight).toBeGreaterThan(80)
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await expect(page.getByRole('button', { name: /Helm conversation/ })).toBeFocused()
})

test('a 320px directory and compact conversation keep content and actions reachable', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 420 })
	await page.goto(path)
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const transcript = page.getByLabel('Conversation messages')
	await expect(transcript).toBeVisible()
	expect(await transcript.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(80)
	const send = page.getByRole('button', { name: 'Send', exact: true })
	await expect(send).toBeInViewport()
	expect(await send.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
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
	await expect(page.getByRole('heading', { name: 'Live sessions', exact: true })).toBeFocused()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
})

test('Escape and page-owned browser Back return to the directory without changing its URL', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	const url = page.url()
	await page.getByRole('heading', { name: 'Helm conversation', exact: true }).press('Escape')
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	await expect(page.getByRole('button', { name: /Helm conversation/ })).toBeFocused()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.goBack()
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	await expect(page).toHaveURL(url)
	await expect(page.getByRole('button', { name: /Helm conversation/ })).toBeFocused()
})

test('an answered questionnaire stays fenced until observation catches up', async ({ page }) => {
	await page.goto('/iframe.html?id=views-helm-remote--questions&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.evaluate(() => window.__remoteFixture?.holdQuestionRefresh())
	await page.getByRole('radio', { name: /Keep the owner/ }).check()
	await page.getByRole('checkbox', { name: /Desktop/ }).check()
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
		await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
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

test('real pairing stories show code and QR states, single flight, supersession and disposed late responses', async ({
	page,
}) => {
	await page.goto('/iframe.html?id=views-helm-remote--pairing-entry&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Pair this device' })).toBeVisible()
	await expect(page.getByLabel('One-time code')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Pair device' })).toBeDisabled()
	await page.goto('/iframe.html?id=views-helm-remote--pairing-from-qr&viewMode=story')
	await expect(page.getByText(/A one-time QR pairing code is ready/)).toBeVisible()
	await page.getByLabel('One-time code').fill('ABC-DEF')
	await expect(page.getByText(/A one-time QR pairing code is ready/)).toHaveCount(0)
	await page.getByLabel('One-time code').press('Enter')
	await page.getByLabel('One-time code').press('Enter')
	await expect(page.getByRole('button', { name: 'Pairing…' })).toBeDisabled()
	await expect(page.getByLabel('One-time code')).toBeDisabled()
	expect(await page.evaluate(() => window.__remoteEntryFixture?.requests.map(request => request.input))).toEqual([
		{ code: 'ABC-DEF' },
	])
	await page.evaluate(() => window.__remoteEntryFixture?.requests[0]?.reject())
	await expect(page.getByRole('alert')).toBeVisible()
	await expect(page.getByLabel('One-time code')).toBeFocused()
	await page.getByLabel('One-time code').fill('GHI-JKL')
	await page.getByRole('button', { name: 'Pair device' }).click()
	const creates = await page.evaluate(() => window.__remoteEntryFixture?.transportCreations())
	await page.evaluate(() => window.__remoteEntryFixture?.dispose())
	await expect(page.getByText('Entry disposed')).toBeVisible()
	expect(await page.evaluate(() => window.__remoteEntryFixture?.requests[1]?.signal.aborted)).toBe(true)
	await page.evaluate(async () => {
		window.__remoteEntryFixture?.requests[1]?.resolve()
		await Promise.resolve()
	})
	expect(await page.evaluate(() => window.__remoteEntryFixture?.transportCreations())).toBe(creates)
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toHaveCount(0)
})

test('production entry recovery story returns from mounted Access ended through fresh pairing', async ({ page }) => {
	await page.goto('/iframe.html?id=views-helm-remote--pairing-recovery&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	await page.evaluate(() => {
		window.__remoteEntryFixture?.workspace.revoke()
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.getByRole('heading', { name: 'Access ended' })).toBeVisible()
	await page.getByRole('button', { name: 'Pair again' }).click()
	await page.getByLabel('One-time code').fill('ABC-DEF')
	await page.getByRole('button', { name: 'Pair device' }).click()
	await page.evaluate(() => window.__remoteEntryFixture?.requests[0]?.resolve())
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
})

test('current authority masks questionnaire controls without hiding unchanged evidence', async ({ page }) => {
	await page.goto('/iframe.html?id=views-helm-remote--questions&viewMode=story')
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.getByRole('radio', { name: /Keep the owner/ }).check()
	await page.evaluate(() => {
		window.__remoteFixture?.setReadOnly(true)
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.getByRole('radio', { name: /Keep the owner/ })).toBeDisabled()
	await expect(page.getByRole('checkbox', { name: /Desktop/ })).toBeDisabled()
	await expect(page.getByLabel('Custom answer: Custom')).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Submit answers' })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toBeDisabled()
	await expect(page.getByText('Pi → local host → browser', { exact: true })).toBeVisible()
	await expect(page.locator('.remote-message')).toHaveCount(40)
	await page.evaluate(() => {
		window.__remoteFixture?.setReadOnly(false)
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await expect(page.getByRole('radio', { name: /Keep the owner/ })).toBeEnabled()
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
})

test('production entry retries unavailable access without pairing or remounting', async ({ page }) => {
	await page.goto('/iframe.html?id=views-helm-remote--access-unavailable&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Helm Remote unavailable' })).toBeVisible()
	await expect(page.getByRole('heading', { name: 'Pair this device' })).toHaveCount(0)
	await page.evaluate(() => window.__remoteEntryFixture?.setAccessUnavailable(false))
	await page.getByRole('button', { name: 'Retry connection' }).click()
	await expect(page.getByRole('heading', { name: 'Choose a session' })).toBeVisible()
	expect(await page.evaluate(() => window.__remoteEntryFixture?.requests.length)).toBe(0)
	expect(await page.evaluate(() => window.__remoteEntryFixture?.transportCreations())).toBe(2)
})

for (const width of [320, 390])
	test(`directory safe-area protects search and final row at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 240 })
		const cdp = await page.context().newCDPSession(page)
		let method = 'Chromium CDP Emulation.setSafeAreaInsets'
		try {
			await cdp.send('Emulation.setSafeAreaInsets', { insets: { top: 36, bottom: 24, left: 0, right: 0 } })
		} catch {
			method = 'stylesheet-only env substitution (CDP unsupported)'
		}
		await page.goto(path)
		const directory = page.locator('.remote-directory')
		await expect(directory).toBeVisible()
		if (method.startsWith('stylesheet')) {
			const css = await page.evaluate(() => {
				for (const sheet of Array.from(document.styleSheets)) {
					for (const rule of Array.from(sheet.cssRules)) {
						if (
							rule instanceof CSSStyleRule &&
							rule.selectorText === '.remote-directory' &&
							rule.cssText.includes('safe-area-inset-top')
						)
							return rule.cssText
								.replace(/env\(safe-area-inset-top,\s*0px\)/g, '36px')
								.replace(/env\(safe-area-inset-bottom,\s*0px\)/g, '24px')
					}
				}
				throw new Error('Production directory must own both env insets')
			})
			await page.addStyleTag({ content: css })
		}
		expect(await directory.evaluate(node => getComputedStyle(node).paddingTop)).toBe('36px')
		expect(await directory.evaluate(node => getComputedStyle(node).paddingBottom)).toBe('24px')
		const search = await page.getByPlaceholder('Search live conversations').boundingBox()
		if (!search) throw new Error('Missing search geometry')
		expect(search.y).toBeGreaterThanOrEqual(36)
		const body = page.locator('.remote-directory-body')
		await body.evaluate(node => {
			node.scrollTop = node.scrollHeight
		})
		const last = await page.locator('.remote-session-row').last().boundingBox()
		if (!last) throw new Error('Missing final row geometry')
		expect(last.height).toBeGreaterThanOrEqual(44)
		expect(last.y + last.height).toBeLessThanOrEqual(240 - 24)
		expect(await body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
		await page.screenshot({ path: `/tmp/helm-interface-redesign-20260910/finish/remote-safe-area-${width}.png` })
		console.log(JSON.stringify({ width, method, top: 36, bottom: 24, lastRowBottom: last.y + last.height }))
		await page.setViewportSize({ width, height: 420 })
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		const reading = await page.getByLabel('Conversation messages').boundingBox()
		if (!reading) throw new Error('Missing reading geometry')
		expect(reading.height).toBeGreaterThanOrEqual(96)
		const conversation = await page.locator('.remote-conversation').boundingBox()
		if (!conversation) throw new Error('Missing conversation geometry')
		expect(conversation.width).toBe(width)
		await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
		await expect(directory).toBeVisible()
	})
