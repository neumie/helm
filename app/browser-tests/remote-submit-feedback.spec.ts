import { type Page, expect, test } from '@playwright/test'
import type { RemoteCommand } from '../../src/remote/protocol.js'
import { openRemoteDestination } from './remote-navigation.js'

declare global {
	interface Window {
		__submitControl?: {
			commands: RemoteCommand[]
			finish(index: number, status: 'dispatched' | 'rejected' | 'pending' | 'unknown', fail?: boolean): void
			check(status: 'dispatched' | 'rejected' | 'unknown'): void
			releaseCheck(): void
		}
	}
}
const path = '/iframe.html?id=views-helm-remote--browser-harness&viewMode=story'
const editor = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true })
async function setup(page: Page) {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(editor(page)).toBeVisible()
	await page.evaluate(() => {
		const fixture = window.__remoteFixture
		if (!fixture) throw new Error('Missing fixture')
		const commands: RemoteCommand[] = []
		const pending: Array<(status: 'dispatched' | 'rejected' | 'pending' | 'unknown', fail?: boolean) => void> = []
		let checkStatus: 'dispatched' | 'rejected' | 'unknown' = 'unknown'
		let releaseCheck = () => {}
		fixture.transport.send = command =>
			new Promise((resolve, reject) => {
				commands.push(command)
				pending.push((status, fail) =>
					fail ? reject(new Error('ambiguous transport failure')) : resolve({ commandId: command.commandId, status }),
				)
			})
		fixture.transport.receipt = command =>
			new Promise(resolve => {
				const status = checkStatus
				releaseCheck = () => resolve({ commandId: command.commandId, status })
			})
		window.__submitControl = {
			commands,
			finish: (index, status, fail) => pending[index](status, fail),
			check: status => {
				checkStatus = status
			},
			releaseCheck: () => releaseCheck(),
		}
	})
}
async function finish(
	page: Page,
	index: number,
	status: 'dispatched' | 'rejected' | 'pending' | 'unknown',
	fail = false,
) {
	await page.evaluate(({ index, status, fail }) => window.__submitControl?.finish(index, status, fail), {
		index,
		status,
		fail,
	})
}
const count = (page: Page) => page.evaluate(() => window.__submitControl?.commands.length)
async function send(page: Page, text = '  Submitted raw text  ') {
	await editor(page).fill(text)
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect(editor(page)).toHaveValue('')
	await expect(page.locator('.remote-receipt')).toContainText('Sending…')
}

test('held production send clears in two frames, captures trimmed delivery once and preserves reading', async ({
	page,
}, info) => {
	await setup(page)
	await editor(page).focus()
	await page.getByRole('button', { name: /Message delivery:/ }).click()
	await page.getByRole('menuitemradio', { name: 'Follow up after current work' }).click()
	const transcript = page.getByLabel('Conversation messages', { exact: true })
	await transcript.evaluate(node => {
		node.scrollTop = node.scrollHeight / 2
	})
	await editor(page).fill('  Immediate feedback  ')
	const result = await page.evaluate(async () => {
		const button = document.querySelector<HTMLButtonElement>('.remote-send')
		const pane = document.querySelector('.remote-transcript')
		if (!button || !pane) throw new Error('Missing composer or transcript')
		const top = pane.scrollTop
		button.click()
		button.click()
		document
			.querySelector('#remote-prompt')
			?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
		return {
			text: document.querySelector<HTMLTextAreaElement>('#remote-prompt')?.value,
			copy: document.querySelector('.remote-receipt')?.textContent,
			commands: window.__submitControl?.commands,
			movement: pane.scrollTop - top,
		}
	})
	expect(result.text).toBe('')
	expect(result.copy).toContain('Sending…')
	expect(result.commands).toHaveLength(1)
	expect(result.commands[0].operation).toEqual({ kind: 'prompt', text: 'Immediate feedback', delivery: 'followUp' })
	expect(Math.abs(result.movement)).toBeLessThanOrEqual(1)
	await page.screenshot({ path: info.outputPath('held-send-390x844.png') })
	await finish(page, 0, 'dispatched')
	await expect(page.locator('.remote-receipt')).toHaveCount(0)
})
for (const newer of ['  Submitted raw text  ', 'Newer draft', ''])
	test(`success never clears newer ownership: ${JSON.stringify(newer)}`, async ({ page }) => {
		await setup(page)
		await send(page)
		await editor(page).fill('intermediate')
		await editor(page).fill(newer)
		await finish(page, 0, 'dispatched')
		await expect(page.locator('.remote-receipt')).toHaveCount(0)
		await expect(editor(page)).toHaveValue(newer)
	})
test('known rejection restores exact untouched text', async ({ page }) => {
	await setup(page)
	await send(page, '  Raw\n whitespace  ')
	await finish(page, 0, 'rejected')
	await expect(editor(page)).toHaveValue('  Raw\n whitespace  ')
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})
for (const newer of ['Newer draft', ''])
	for (const restore of [false, true])
		test(`recovery choice is local, exact and prompt-only: newer=${!!newer} restore=${restore}`, async ({ page }) => {
			await setup(page)
			await page.evaluate(() => window.__remoteFixture?.setActivity('working'))
			await send(page)
			await editor(page).fill('intermediate')
			await editor(page).fill(newer)
			await finish(page, 0, 'rejected')
			await expect(page.locator('.remote-receipt')).toContainText('Choose which draft to keep before sending.')
			await expect(editor(page)).toHaveValue(newer)
			await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
			await page.getByRole('button', { name: 'Interrupt', exact: true }).click()
			expect(await count(page)).toBe(2)
			await finish(page, 1, 'dispatched')
			await expect(page.locator('.remote-receipt')).toContainText('Submitted message saved locally.')
			const label = newer
				? restore
					? 'Replace current draft'
					: 'Keep current draft'
				: restore
					? 'Restore submitted message'
					: 'Discard submitted message'
			await page.getByRole('button', { name: label, exact: true }).click()
			await expect(editor(page)).toHaveValue(restore ? '  Submitted raw text  ' : newer)
			expect(await count(page)).toBe(2)
		})
test('unknown status recovery is GET-only; dispatched preserves a newer editor', async ({ page }) => {
	await setup(page)
	await send(page)
	await finish(page, 0, 'unknown')
	await expect(editor(page)).toHaveValue('')
	await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeVisible()
	await editor(page).fill('Newer draft')
	await page.evaluate(() => window.__submitControl?.check('dispatched'))
	await page.getByRole('button', { name: 'Check status', exact: true }).click()
	await page.evaluate(() => window.__submitControl?.releaseCheck())
	await expect(page.locator('.remote-receipt')).toHaveCount(0)
	await expect(editor(page)).toHaveValue('Newer draft')
	expect(await count(page)).toBe(1)
})
test('acknowledgement retires exact operation; a late old check cannot overwrite a new send', async ({ page }) => {
	await setup(page)
	await send(page)
	await finish(page, 0, 'unknown')
	await page.getByRole('button', { name: 'Check status', exact: true }).click()
	await page.getByRole('button', { name: 'I’ve checked the conversation', exact: true }).click()
	await expect(editor(page)).toHaveValue('  Submitted raw text  ')
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await page.evaluate(() => window.__submitControl?.releaseCheck())
	await expect(page.locator('.remote-receipt')).toContainText('Sending…')
	expect(await count(page)).toBe(2)
	await finish(page, 1, 'dispatched')
	await expect(page.locator('.remote-receipt')).toHaveCount(0)
})
test('composition blocks pointer and keyboard; question detach resets only textarea composition', async ({ page }) => {
	await setup(page)
	await editor(page).fill('IME draft')
	await editor(page).dispatchEvent('compositionstart')
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await editor(page).press('Control+Enter')
	expect(await count(page)).toBe(0)
	await expect(editor(page)).toHaveValue('IME draft')
	await page.evaluate(() => window.__remoteFixture?.ask())
	await expect(page.getByRole('button', { name: 'Edit draft', exact: true })).toBeVisible()
	await page.evaluate(() => window.__remoteFixture?.showTerminalDialog())
	await expect(editor(page)).toHaveValue('IME draft')
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect(editor(page)).toHaveValue('')
	expect(await count(page)).toBe(1)
})
test('blank, read-only and disconnected rejected admission never clears', async ({ page }) => {
	await setup(page)
	await editor(page).fill('   ')
	await editor(page).press('Control+Enter')
	expect(await count(page)).toBe(0)
	await expect(editor(page)).toHaveValue('   ')
	for (const gate of ['readOnly', 'disconnected'] as const) {
		await editor(page).fill('Preserve refused draft')
		await page.evaluate(gate => {
			const f = window.__remoteFixture
			if (!f) throw new Error('Missing fixture')
			f.setReadOnly(gate === 'readOnly')
			f.setConnected(gate !== 'disconnected')
			document.dispatchEvent(new Event('visibilitychange'))
		}, gate)
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
		await editor(page).press('Control+Enter')
		await expect(editor(page)).toHaveValue('Preserve refused draft')
		expect(await count(page)).toBe(0)
	}
})
test('same-owner Back/Forward preserves recovery; full-owner replacement drops it', async ({ page }) => {
	await setup(page)
	await send(page)
	await editor(page).fill('Newer owner-local draft')
	await finish(page, 0, 'unknown', true)
	await openRemoteDestination(page, 'Sessions')
	await page.goForward()
	await expect(editor(page)).toHaveValue('Newer owner-local draft')
	await page.getByRole('button', { name: 'I’ve checked the conversation', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Replace current draft', exact: true })).toBeVisible()
	await page.evaluate(() => window.__remoteFixture?.replaceOwner())
	await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(editor(page)).toHaveValue('')
	await expect(page.locator('.remote-receipt')).toHaveCount(0)
})

for (const acknowledge of [false, true])
	test(`passive prompt recovery survives an answer after ${acknowledge ? 'unknown acknowledgement' : 'known rejection'}`, async ({
		page,
	}) => {
		await setup(page)
		await send(page)
		await editor(page).fill('Newer draft')
		await finish(page, 0, acknowledge ? 'unknown' : 'rejected')
		if (acknowledge) await page.getByRole('button', { name: 'I’ve checked the conversation', exact: true }).click()
		await page.evaluate(() => window.__remoteFixture?.ask())
		await page.getByRole('radio', { name: /Keep the owner/ }).check()
		await page.getByRole('checkbox', { name: /Desktop/ }).check()
		await page.getByLabel('Custom answer: Custom').fill('Ready')
		await page.getByRole('button', { name: 'Submit answers', exact: true }).click()
		expect(await count(page)).toBe(2)
		expect(await page.evaluate(() => window.__submitControl?.commands[1].operation.kind)).toBe('answer')
		await expect(page.locator('.remote-receipt')).toContainText('Submitted message saved locally.')
		await page.getByRole('button', { name: 'Keep current draft', exact: true }).click()
		await expect(page.locator('.remote-receipt')).toContainText('Sending…')
		await page.getByRole('button', { name: 'Edit draft', exact: true }).click()
		await expect(editor(page)).toHaveValue('Newer draft')
		expect(await count(page)).toBe(2)
	})

test('abort catch from old remount cannot replace a later status-settled operation', async ({ page }) => {
	await setup(page)
	await send(page)
	await openRemoteDestination(page, 'Sessions')
	// The original transport ignores abort deliberately. Reopening retains its unresolved operation.
	await page.goForward()
	await expect(page.locator('.remote-receipt')).toContainText('Sending…')
	await finish(page, 0, 'unknown', true)
	await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'I’ve checked the conversation', exact: true }).click()
	await expect(editor(page)).toHaveValue('  Submitted raw text  ')
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect(page.locator('.remote-receipt')).toContainText('Sending…')
	expect(await count(page)).toBe(2)
})

test('compact recovery remains in the bounded receipt well with full controls and reading floor', async ({
	page,
}, info) => {
	await setup(page)
	await page.setViewportSize({ width: 320, height: 420 })
	await page.evaluate(() => {
		for (const sheet of document.styleSheets) {
			try {
				const rewrite = (rules: CSSRuleList) => {
					for (const rule of rules) {
						if (rule instanceof CSSStyleRule)
							rule.style.cssText = rule.style.cssText
								.replace(/env\(safe-area-inset-top(?:,\s*0px)?\)/g, '36px')
								.replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g, '24px')
						if (rule instanceof CSSGroupingRule) rewrite(rule.cssRules)
					}
				}
				rewrite(sheet.cssRules)
			} catch {
				/* Other workbench styles do not own Remote layout. */
			}
		}
	})
	await send(page)
	await editor(page).fill('Newer draft')
	await finish(page, 0, 'rejected')
	await expect(page.getByRole('button', { name: 'Replace current draft', exact: true })).toBeAttached()
	const geometry = await page.evaluate(() => {
		const header = document.querySelector('.remote-chat > .remote-header')
		const composer = document.querySelector('.remote-composer')
		if (!header || !composer) throw new Error('Missing layout owners')
		const bounds = (selector: string) => {
			const rect = document.querySelector(selector)?.getBoundingClientRect()
			return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null
		}
		return {
			top: getComputedStyle(header).paddingTop,
			bottom: getComputedStyle(composer).paddingBottom,
			reading: document.querySelector('.remote-reading-area')?.getBoundingClientRect().height,
			composer: bounds('.remote-composer'),
			receipt: bounds('.remote-receipt'),
			surface: bounds('.remote-compose-surface'),
			field: bounds('.remote-prompt-field'),
			footer: document.querySelector('.remote-information-footer'),
			controls: [...document.querySelectorAll('.remote-composer-actions button')].map(e => {
				const b = e.getBoundingClientRect()
				return { top: b.top, bottom: b.bottom, width: b.width, height: b.height }
			}),
		}
	})
	await info.attach('compact-recovery-geometry', {
		body: JSON.stringify(geometry, null, 2),
		contentType: 'application/json',
	})
	expect(geometry.top).toBe('36px')
	expect(geometry.bottom).toBe('12px')
	expect(geometry.reading).toBeGreaterThanOrEqual(96)
	expect(geometry.footer).toBeNull()
	// The capsule keeps its full editor/action height; the receipt scrolls instead.
	expect(geometry.surface?.height).toBeGreaterThanOrEqual(100)
	expect(geometry.receipt?.height).toBeLessThan(96)
	for (const c of geometry.controls) {
		expect(c.width).toBe(44)
		expect(c.height).toBe(44)
		// The 12px capsule floor and 6px inner inset keep actions 18px above the visible bottom.
		expect(c.bottom).toBeLessThanOrEqual(402)
	}
	await page.screenshot({ path: info.outputPath('recovery-320x420-safe-area.png') })
	await page.getByRole('button', { name: 'Replace current draft', exact: true }).click()
	await expect(editor(page)).toHaveValue('  Submitted raw text  ')
	expect(await count(page)).toBe(1)
})

for (const outcome of ['dispatched', 'rejected', 'catch'] as const)
	test(`late ${outcome} from the old component publishes only to its retained same-owner draft`, async ({ page }) => {
		await setup(page)
		await send(page)
		await openRemoteDestination(page, 'Sessions')
		await page.goForward()
		await editor(page).fill('Newer reopened draft')
		const result = await page.evaluate(async outcome => {
			window.__submitControl?.finish(0, outcome === 'catch' ? 'unknown' : outcome, outcome === 'catch')
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
			return {
				text: document.querySelector<HTMLTextAreaElement>('#remote-prompt')?.value,
				receipt: document.querySelector('.remote-receipt')?.textContent ?? '',
			}
		}, outcome)
		expect(result.text).toBe('Newer reopened draft')
		if (outcome === 'dispatched') expect(result.receipt).toBe('')
		else if (outcome === 'rejected') expect(result.receipt).toContain('Choose which draft to keep before sending.')
		else expect(result.receipt).toContain('Check status')
	})

for (const outcome of ['dispatched', 'catch'] as const)
	test(`pruned-owner late ${outcome} cannot alter replacement editor or receipt`, async ({ page }) => {
		await setup(page)
		await send(page)
		await page.evaluate(() => window.__remoteFixture?.replaceOwner())
		await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toHaveCount(0)
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await editor(page).fill('Replacement owner draft')
		await page.getByRole('button', { name: 'Send', exact: true }).click()
		await editor(page).fill('Replacement newer edit')
		await finish(page, 0, outcome === 'catch' ? 'unknown' : 'dispatched', outcome === 'catch')
		await expect(editor(page)).toHaveValue('Replacement newer edit')
		await expect(page.locator('.remote-receipt')).toContainText('Sending…')
		expect(await count(page)).toBe(2)
		await finish(page, 1, 'dispatched')
		await expect(page.locator('.remote-receipt')).toHaveCount(0)
		await expect(editor(page)).toHaveValue('Replacement newer edit')
	})

test('known access rejection restores raw text through the real RemoteAccessError classification', async ({ page }) => {
	await page.goto(path)
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await page.evaluate(() => {
		const f = window.__remoteFixture
		if (!f) throw new Error('Missing fixture')
		const send = f.transport.send.bind(f.transport)
		f.transport.send = async (...args) => {
			f.revoke()
			try {
				return await send(...args)
			} finally {
				f.restoreAccess()
			}
		}
	})
	await editor(page).fill('  Preserve rejected text  ')
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect(editor(page)).toHaveValue('  Preserve rejected text  ')
	await expect(page.locator('.remote-receipt')).toContainText(
		'Not sent. Check the current session before trying again.',
	)
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
})
