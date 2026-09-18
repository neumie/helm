import { createHash } from 'node:crypto'
import { type Page, type Route, expect, test } from '@playwright/test'
import { inspectJpegForProcessed } from '../../src/remote/image-input-bytes.js'
import type { RemoteCommand } from '../../src/remote/protocol.js'
import type { RemoteFixture } from '../src/renderer/remote/remote-fixtures.js'

interface ImageInputFixtureControl extends RemoteFixture {
	useProductionTransport(): void
	useProductionReads(): void
	setImageAvailable(value: boolean): void
	prunePublishedSessions(): void
	setWorkspaceMounted(value: boolean): void
}

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
	}
}

const path = '/iframe.html?id=views-helm-remote--image-input&viewMode=story'

async function imageFile(
	page: Page,
	name: string,
	type: 'image/png' | 'image/jpeg',
	color: string,
	width: number,
	height: number,
) {
	const base64 = await page.evaluate(
		async ({ type, color, width, height }) => {
			const canvas = document.createElement('canvas')
			canvas.width = width
			canvas.height = height
			const context = canvas.getContext('2d')
			if (!context) throw new Error('Missing canvas')
			context.fillStyle = color
			context.fillRect(0, 0, width, height)
			context.fillStyle = '#ffffff'
			context.fillRect(2, 2, Math.max(1, width / 3), Math.max(1, height / 3))
			const blob = await new Promise<Blob>((resolve, reject) =>
				canvas.toBlob(value => (value ? resolve(value) : reject(new Error('encode failed'))), type, 0.95),
			)
			return new Promise<string>((resolve, reject) => {
				const reader = new FileReader()
				reader.onerror = () => reject(reader.error)
				reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
				reader.readAsDataURL(blob)
			})
		},
		{ type, color, width, height },
	)
	return { name, mimeType: type, buffer: Buffer.from(base64, 'base64') }
}

async function open(page: Page) {
	await page.goto(path)
	await expect(page.getByRole('button', { name: 'Add images', exact: true })).toBeEnabled()
}

async function useProduction(page: Page) {
	await page.evaluate(() => {
		;(window.__remoteFixture as ImageInputFixtureControl | undefined)?.useProductionTransport()
	})
}

function installTransportRoutes(page: Page, state: { uploads: Buffer[]; commands: RemoteCommand[] }) {
	let handle = 0
	return Promise.all([
		page.route('**/v1/sessions/*/images?*', async route => {
			const request = route.request()
			expect(request.headers()['x-helm-image-input']).toBe('1')
			const bytes = request.postDataBuffer() ?? Buffer.alloc(0)
			const dimensions = inspectJpegForProcessed(bytes)
			state.uploads.push(bytes)
			handle++
			await route.fulfill({
				status: 201,
				headers: { 'Content-Type': 'application/json', 'X-Helm-Image-Input': '1' },
				body: JSON.stringify({
					protocol: 1,
					hostEpoch: '10000000-0000-4000-8000-000000000000',
					image: {
						handle: `30000000-0000-4000-8000-${handle.toString().padStart(12, '0')}`,
						sha256: createHash('sha256').update(bytes).digest('hex'),
						mimeType: 'image/jpeg',
						bytes: bytes.length,
						...dimensions,
					},
				}),
			})
		}),
		page.route('**/v1/commands', async route => {
			const command = route.request().postDataJSON() as RemoteCommand
			state.commands.push(command)
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ commandId: command.commandId, status: 'dispatched' }),
			})
		}),
	])
}

async function previewBytes(page: Page) {
	return page
		.locator('.remote-image-preview img')
		.evaluateAll(async images =>
			Promise.all(
				images.map(async image =>
					Array.from(new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())),
				),
			),
		)
}

test('Add images opens the system picker directly on every activation, without an intermediate menu', async ({
	page,
}) => {
	await open(page)
	const add = page.getByRole('button', { name: 'Add images', exact: true })
	const touch = await page.evaluate(() => navigator.maxTouchPoints > 0)
	for (let attempt = 0; attempt < 6; attempt++) {
		const [picker] = await Promise.all([
			page.waitForEvent('filechooser', { timeout: 5000 }),
			touch ? add.tap() : add.click(),
		])
		await expect(page.getByRole('menu', { name: 'Add images', exact: true })).toHaveCount(0)
		await picker.setFiles([])
	}
	await page.getByRole('button', { name: /^Message delivery:/ }).click()
	await expect(page.getByRole('menu', { name: /^Message delivery:/ })).toBeVisible()
})

test('Add images opens directly with Enter and Space and preserves its disabled gate', async ({ page }) => {
	await open(page)
	const add = page.getByRole('button', { name: 'Add images', exact: true })
	await expect(add).toHaveCount(1)
	await page.getByRole('textbox', { name: 'Message', exact: true }).focus()
	await page.keyboard.press('Tab')
	await expect(add).toBeFocused()
	for (const key of ['Enter', 'Space']) {
		const [picker] = await Promise.all([page.waitForEvent('filechooser'), add.press(key)])
		await picker.setFiles([])
		await expect(add).toBeFocused()
	}
	await page.keyboard.press('Tab')
	await expect(page.getByRole('button', { name: /^Message delivery:/ })).toBeFocused()
	await page.evaluate(() => (window.__remoteFixture as ImageInputFixtureControl | undefined)?.setImageAvailable(false))
	await expect(add).toBeDisabled()
	await expect(page.locator('input[type=file]')).toBeDisabled()
})

test('Add images prepares selected files directly and permits same-file reselection after removal', async ({
	page,
}) => {
	await open(page)
	const file = await imageFile(page, 'direct.png', 'image/png', '#228844', 40, 30)
	for (let attempt = 0; attempt < 2; attempt++) {
		const [picker] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.getByRole('button', { name: 'Add images', exact: true }).click(),
		])
		await picker.setFiles(file)
		await expect(page.locator('.remote-image-preview')).toHaveCount(1)
		await page.getByRole('button', { name: 'Remove attached image 1' }).click()
		await expect(page.locator('.remote-image-preview')).toHaveCount(0)
	}
})

test('production upload/send keeps distinct ordered exact processed previews and supports image-only send', async ({
	page,
}) => {
	await open(page)
	const first = await imageFile(page, 'first.png', 'image/png', '#cc2244', 48, 32)
	const second = await imageFile(page, 'second.jpg', 'image/jpeg', '#2266cc', 32, 48)
	await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles([first, second])
	await expect(page.locator('.remote-image-preview')).toHaveCount(2)
	await expect(page.locator('.remote-image-preview img').first()).toHaveCSS('width', '64px')
	const removeBounds = await page.getByRole('button', { name: 'Remove attached image 1' }).evaluate(control => {
		const bounds = control.getBoundingClientRect()
		return { width: bounds.width, height: bounds.height }
	})
	expect(removeBounds).toEqual({ width: 44, height: 44 })
	const previews = await previewBytes(page)
	expect(Buffer.from(previews[0] ?? [])).not.toEqual(Buffer.from(previews[1] ?? []))
	const state = { uploads: [] as Buffer[], commands: [] as RemoteCommand[] }
	await installTransportRoutes(page, state)
	await useProduction(page)
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect.poll(() => state.commands.length).toBe(1)
	expect(state.uploads).toHaveLength(2)
	expect(state.uploads[0]).toEqual(Buffer.from(previews[0] ?? []))
	expect(state.uploads[1]).toEqual(Buffer.from(previews[1] ?? []))
	expect(state.uploads[0]).not.toEqual(state.uploads[1])
	const operation = state.commands[0]?.operation
	expect(operation?.kind).toBe('prompt')
	if (operation?.kind !== 'prompt') throw new Error('Expected prompt')
	expect(operation.text).toBe('')
	expect(operation.images?.map(image => image.sha256)).toEqual(
		state.uploads.map(bytes => createHash('sha256').update(bytes).digest('hex')),
	)
})

test('selection is atomic, failure latches Send, same-file reselection works and removal rotates the bundle', async ({
	page,
}) => {
	await open(page)
	const valid = await imageFile(page, 'same.png', 'image/png', '#228844', 40, 30)
	const input = page.locator('input[type=file][accept="image/png,image/jpeg"]')
	await input.setInputFiles(valid)
	await expect(page.locator('.remote-image-preview')).toHaveCount(1)
	await input.setInputFiles({ name: 'unsupported.webp', mimeType: 'image/webp', buffer: Buffer.from([1, 2, 3]) })
	await expect(page.getByRole('alert')).toContainText('PNG or JPEG')
	await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
	await page.getByRole('button', { name: 'Discard failed selection' }).click()
	await expect(page.locator('.remote-image-preview')).toHaveCount(1)
	await input.setInputFiles(valid)
	await expect(page.locator('.remote-image-preview')).toHaveCount(2)
	await page.getByRole('button', { name: 'Remove attached image 1' }).click()
	await expect(page.locator('.remote-image-preview')).toHaveCount(1)
})

test('Send remains fenced while cancelled native preparation is still settling', async ({ page }) => {
	await open(page)
	await page.evaluate(() => {
		const owner = window as typeof window & {
			__imageDecode?: { original: typeof createImageBitmap; release(): void }
		}
		const original = window.createImageBitmap
		let release: (value: ImageBitmap) => void = () => {}
		window.createImageBitmap = (() =>
			new Promise<ImageBitmap>(resolve => {
				release = resolve
			})) as typeof createImageBitmap
		owner.__imageDecode = {
			original,
			release: () => release({ width: 40, height: 30, close() {} } as ImageBitmap),
		}
	})
	const valid = await imageFile(page, 'preparing.png', 'image/png', '#335577', 40, 30)
	await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles(valid)
	await expect(page.getByText('Preparing images… Existing attachments are unchanged.')).toBeVisible()
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill('must not send')
	await page.getByRole('textbox', { name: 'Message', exact: true }).press('Control+Enter')
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await page.evaluate(() => {
		const owner = window as typeof window & {
			__imageDecode?: { original: typeof createImageBitmap; release(): void }
		}
		owner.__imageDecode?.release()
		if (owner.__imageDecode) window.createImageBitmap = owner.__imageDecode.original
	})
})

test('pending Interrupt cannot be overwritten by restored image keyboard Send', async ({ page }) => {
	await open(page)
	const valid = await imageFile(page, 'held.png', 'image/png', '#663399', 44, 28)
	await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles(valid)
	await page.evaluate(() => window.__remoteFixture?.setActivity('working'))
	let uploads = 0
	const commands: RemoteCommand[] = []
	const heldUploads: Route[] = []
	const heldControls: Route[] = []
	await page.route('**/v1/sessions/*/images?*', route => {
		uploads++
		heldUploads.push(route)
	})
	await page.route('**/v1/commands', route => {
		commands.push(route.request().postDataJSON() as RemoteCommand)
		heldControls.push(route)
	})
	await useProduction(page)
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect.poll(() => uploads).toBe(1)
	await page.getByRole('button', { name: 'Interrupt', exact: true }).click()
	await expect.poll(() => commands.length).toBe(1)
	expect(commands[0]?.operation.kind).toBe('interrupt')
	await expect(page.locator('.remote-image-preview')).toHaveCount(1)
	await page.getByRole('textbox', { name: 'Message', exact: true }).press('Control+Enter')
	await page.evaluate(
		() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	)
	expect(uploads).toBe(1)
	expect(commands.filter(command => command.operation.kind === 'prompt')).toHaveLength(0)
	for (const route of [...heldUploads, ...heldControls]) await route.abort().catch(() => {})
})

test('same-task Interrupt activation admits only one control command', async ({ page }) => {
	await open(page)
	await page.evaluate(() => window.__remoteFixture?.setActivity('working'))
	const commands: RemoteCommand[] = []
	const held: Route[] = []
	await page.route('**/v1/commands', route => {
		commands.push(route.request().postDataJSON() as RemoteCommand)
		held.push(route)
	})
	await useProduction(page)
	await page.getByRole('button', { name: 'Interrupt', exact: true }).evaluate(button => {
		;(button as HTMLButtonElement).click()
		;(button as HTMLButtonElement).click()
	})
	await expect.poll(() => commands.length).toBe(1)
	expect(commands[0]?.operation.kind).toBe('interrupt')
	for (const route of held) await route.abort().catch(() => {})
})

test('failed pre-command upload restores the complete captioned bundle and never posts a command', async ({ page }) => {
	await open(page)
	const valid = await imageFile(page, 'recover.png', 'image/png', '#884422', 36, 24)
	await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles(valid)
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill('  Exact caption  ')
	let commands = 0
	await page.route('**/v1/sessions/*/images?*', route => route.fulfill({ status: 500, body: '{}' }))
	await page.route('**/v1/commands', route => {
		commands++
		return route.abort('failed')
	})
	await useProduction(page)
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('  Exact caption  ')
	await expect(page.locator('.remote-image-preview')).toHaveCount(1)
	await expect(page.locator('.remote-receipt')).toContainText('Message was not sent. Image upload failed.')
	expect(commands).toBe(0)
})

test('upload failure preserves a newer edit and offers bounded bundle recovery without command POST', async ({
	page,
}) => {
	await open(page)
	const valid = await imageFile(page, 'newer.png', 'image/png', '#557733', 36, 24)
	await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles(valid)
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill('original caption')
	let held: Route | undefined
	let commands = 0
	await page.route('**/v1/sessions/*/images?*', route => {
		held = route
	})
	await page.route('**/v1/commands', route => {
		commands++
		return route.abort('failed')
	})
	await useProduction(page)
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect.poll(() => !!held).toBe(true)
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill('newer edit')
	await held?.fulfill({ status: 500, body: '{}' })
	await expect(page.locator('.remote-receipt')).toContainText('Message was not sent. Image upload failed.')
	await expect(page.locator('.remote-receipt')).not.toContainText('Your draft was restored')
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('newer edit')
	await expect(page.getByRole('button', { name: 'Replace current draft' })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Keep current draft' })).toBeVisible()
	expect(commands).toBe(0)
})

test('image-only draft remains discoverable through question and mobile Info while IME blocks Send', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 560 })
	await open(page)
	const valid = await imageFile(page, 'question.png', 'image/png', '#336699', 42, 26)
	await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles(valid)
	const editor = page.getByRole('textbox', { name: 'Message', exact: true })
	await editor.dispatchEvent('compositionstart')
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	expect(await page.evaluate(() => window.__remoteFixture?.commands.length)).toBe(0)
	await page.evaluate(() => window.__remoteFixture?.ask())
	await expect(page.getByRole('button', { name: 'Edit draft', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Edit draft', exact: true }).click()
	await expect(page.locator('.remote-image-preview')).toHaveCount(1)
	await page.getByRole('button', { name: 'Conversation options' }).click()
	await page.getByRole('menuitem', { name: 'Info', exact: true }).click()
	const composerActions = page.locator('.remote-composer-actions')
	await expect(composerActions.getByRole('button', { name: 'Back to conversation', exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toHaveCount(0)
	await composerActions.getByRole('button', { name: 'Back to conversation', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toBeVisible()
})

test('support loss during a held upload cancels transfer without fabricating an upload failure', async ({ page }) => {
	await open(page)
	const valid = await imageFile(page, 'support.png', 'image/png', '#775599', 42, 26)
	await page.locator('input[type=file]').setInputFiles(valid)
	let held: Route | undefined
	let commands = 0
	await page.route('**/v1/sessions/*/images?*', route => {
		held = route
	})
	await page.route('**/v1/commands', route => {
		commands++
		return route.abort('failed')
	})
	await useProduction(page)
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect.poll(() => !!held).toBe(true)
	await page.evaluate(() => (window.__remoteFixture as ImageInputFixtureControl | undefined)?.setImageAvailable(false))
	await expect(page.getByText('Image input unavailable. Remove images or wait for support.')).toBeVisible({
		timeout: 10_000,
	})
	await expect(page.locator('.remote-image-preview')).toHaveCount(1)
	await expect(page.locator('.remote-receipt')).toHaveCount(0)
	expect(commands).toBe(0)
	await held?.abort().catch(() => {})
})

test('owner replacement during held upload retires the old bundle and never posts it', async ({ page }) => {
	await open(page)
	const valid = await imageFile(page, 'owner.png', 'image/png', '#335599', 42, 26)
	await page.locator('input[type=file]').setInputFiles(valid)
	const objectUrl = await page.locator('.remote-image-preview img').getAttribute('src')
	let held: Route | undefined
	let commands = 0
	await page.route('**/v1/sessions/*/images?*', route => {
		held = route
	})
	await page.route('**/v1/commands', route => {
		commands++
		return route.abort('failed')
	})
	await useProduction(page)
	await page.getByRole('button', { name: 'Send', exact: true }).click()
	await expect.poll(() => !!held).toBe(true)
	await page.evaluate(() => window.__remoteFixture?.replaceOwner())
	await expect(page.locator('.remote-image-preview')).toHaveCount(0, { timeout: 10_000 })
	if (objectUrl)
		await expect
			.poll(() =>
				page.evaluate(async url => {
					try {
						await fetch(url)
						return true
					} catch {
						return false
					}
				}, objectUrl),
			)
			.toBe(false)
	expect(commands).toBe(0)
	await held?.abort().catch(() => {})
})

test('same-owner Back and Forward retain the exact processed draft resource', async ({ page }) => {
	await open(page)
	const valid = await imageFile(page, 'back.png', 'image/png', '#446622', 42, 26)
	await page.locator('input[type=file]').setInputFiles(valid)
	await expect(page.locator('.remote-image-preview img')).toHaveCount(1)
	const before = await previewBytes(page)
	expect(before).toHaveLength(1)
	const objectUrl = await page.locator('.remote-image-preview img').getAttribute('src')
	expect(objectUrl).toMatch(/^blob:/)
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await expect(page.getByRole('button', { name: /Helm conversation/ })).toBeVisible()
	await page.evaluate(() => history.forward())
	await expect(page.locator('.remote-image-preview')).toHaveCount(1)
	expect(await page.locator('.remote-image-preview img').getAttribute('src')).toBe(objectUrl)
	expect(await previewBytes(page)).toEqual(before)
	await page.getByRole('button', { name: 'Back to live conversations', exact: true }).click()
	await page.getByRole('button', { name: /Helm conversation/ }).click()
	await expect(page.locator('.remote-image-preview')).toHaveCount(1)
	expect(await previewBytes(page)).toEqual(before)
})

test('actual workspace root unmount revokes settled object URLs and remount starts clean', async ({ page }) => {
	await open(page)
	const valid = await imageFile(page, 'unmount.png', 'image/png', '#224466', 42, 26)
	await page.locator('input[type=file]').setInputFiles(valid)
	const objectUrl = await page.locator('.remote-image-preview img').getAttribute('src')
	await page.evaluate(() =>
		(window.__remoteFixture as ImageInputFixtureControl | undefined)?.setWorkspaceMounted(false),
	)
	await expect(page.getByTestId('remote-unmounted')).toBeAttached()
	await expect(page.locator('.remote-workspace')).toHaveCount(0)
	await page.evaluate(() => new Promise<void>(resolve => queueMicrotask(resolve)))
	if (objectUrl)
		expect(
			await page.evaluate(async url => {
				try {
					await fetch(url)
					return true
				} catch {
					return false
				}
			}, objectUrl),
		).toBe(false)
	await page.evaluate(() => (window.__remoteFixture as ImageInputFixtureControl | undefined)?.setWorkspaceMounted(true))
	await expect(page.getByRole('button', { name: 'Add images', exact: true })).toBeEnabled()
	await expect(page.locator('.remote-image-preview')).toHaveCount(0)
})

test('successful directory pruning disposes absent-owner draft resources', async ({ page }) => {
	await open(page)
	const valid = await imageFile(page, 'prune.png', 'image/png', '#662244', 42, 26)
	await page.locator('input[type=file]').setInputFiles(valid)
	const objectUrl = await page.locator('.remote-image-preview img').getAttribute('src')
	expect(objectUrl).toMatch(/^blob:/)
	await page.evaluate(() => (window.__remoteFixture as ImageInputFixtureControl | undefined)?.prunePublishedSessions())
	await expect(page.getByRole('complementary', { name: 'Session directory' })).toBeVisible({ timeout: 10_000 })
	await expect(page.locator('.remote-session-row')).toHaveCount(0)
	await expect(page.locator('.remote-image-preview')).toHaveCount(0)
	if (objectUrl)
		expect(
			await page.evaluate(async url => {
				try {
					await fetch(url)
					return true
				} catch {
					return false
				}
			}, objectUrl),
		).toBe(false)
})

test('production directory/detail image support requires response ACK', async ({ page }) => {
	await open(page)
	const payload = await page.evaluate(async () => {
		const fixture = window.__remoteFixture
		if (!fixture) throw new Error('Missing fixture')
		const signal = new AbortController().signal
		const directory = await fixture.transport.directory(signal)
		const id = directory.sessions[0]?.target.sessionId
		if (!id) throw new Error('Missing session')
		return { directory, detail: await fixture.transport.detail(id, signal) }
	})
	let acknowledged = true
	let directoryReads = 0
	await page.route('**/v1/sessions', async route => {
		directoryReads++
		expect(route.request().headers()['x-helm-image-input']).toBe('1')
		await route.fulfill({
			status: 200,
			headers: acknowledged ? { 'Content-Type': 'application/json', 'X-Helm-Image-Input': '1' } : {},
			body: JSON.stringify(payload.directory),
		})
	})
	await page.route('**/v1/sessions/*', async route => {
		expect(route.request().headers()['x-helm-image-input']).toBe('1')
		await route.fulfill({
			status: 200,
			headers: acknowledged ? { 'Content-Type': 'application/json', 'X-Helm-Image-Input': '1' } : {},
			body: JSON.stringify(payload.detail),
		})
	})
	await page.evaluate(() => (window.__remoteFixture as ImageInputFixtureControl | undefined)?.useProductionReads())
	await expect.poll(() => directoryReads, { timeout: 10_000 }).toBeGreaterThan(0)
	await expect(page.getByRole('button', { name: 'Add images', exact: true })).toBeEnabled()
	acknowledged = false
	const priorReads = directoryReads
	await expect.poll(() => directoryReads, { timeout: 10_000 }).toBeGreaterThan(priorReads)
	await expect(page.getByRole('button', { name: 'Add images', exact: true })).toBeDisabled({ timeout: 10_000 })
})

for (const width of [320, 390]) {
	test(`compact ${width}x420 safe-area layout keeps preview, controls and reading floor in bounds`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width, height: 420 })
		await open(page)
		await page.evaluate(() => {
			const rewrite = (rules: CSSRuleList) => {
				for (const rule of rules) {
					if (rule instanceof CSSStyleRule)
						rule.style.cssText = rule.style.cssText
							.replace(/env\(safe-area-inset-top(?:,\s*0px)?\)/g, '36px')
							.replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g, '24px')
					if (rule instanceof CSSGroupingRule) rewrite(rule.cssRules)
				}
			}
			for (const sheet of document.styleSheets) {
				try {
					rewrite(sheet.cssRules)
				} catch (error) {
					// Cross-origin sheets are inaccessible; computed inset checks below still apply.
					if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
				}
			}
		})
		const valid = await imageFile(page, 'compact.png', 'image/png', '#aa7722', 80, 42)
		await page.locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles(valid)
		await expect(page.locator('.remote-image-preview img')).toHaveCSS('width', '44px')
		await page.getByRole('button', { name: /Message delivery:/ }).click()
		const followUp = page.getByRole('menuitemradio', { name: 'Follow up after current work' })
		await expect(followUp).toBeInViewport()
		const menuBounds = await page.locator('.remote-composer-actions .menu-panel').evaluate(element => {
			const bounds = element.getBoundingClientRect()
			return { left: bounds.left, right: bounds.right }
		})
		expect(menuBounds.left).toBeGreaterThanOrEqual(0)
		expect(menuBounds.right).toBeLessThanOrEqual(width)
		await followUp.click()
		await expect(page.getByRole('button', { name: /Message delivery: Follow-up/ })).toBeVisible()
		const geometry = await page.evaluate(() => {
			const composer = document.querySelector('.remote-composer') as HTMLElement
			const composerBounds = composer.getBoundingClientRect()
			const previewBounds = (document.querySelector('.remote-image-preview img') as HTMLElement).getBoundingClientRect()
			const editorBounds = (
				document.querySelector('.remote-prompt-field textarea') as HTMLElement
			).getBoundingClientRect()
			return {
				top: getComputedStyle(document.querySelector('.remote-chat > .remote-header') as Element).paddingTop,
				bottom: getComputedStyle(composer).paddingBottom,
				reading: document.querySelector('.remote-reading-area')?.getBoundingClientRect().height ?? 0,
				composer: {
					top: composerBounds.top,
					bottom: composerBounds.bottom,
					left: composerBounds.left,
					right: composerBounds.right,
				},
				preview: { width: previewBounds.width, height: previewBounds.height },
				editor: { width: editorBounds.width, height: editorBounds.height },
				scroll: {
					x: window.scrollX,
					width: document.documentElement.scrollWidth,
					viewport: window.innerWidth,
					workspace: (document.querySelector('.remote-workspace') as HTMLElement).scrollLeft,
					conversation: (document.querySelector('.remote-conversation') as HTMLElement).scrollLeft,
				},
				overflowing: [...document.querySelectorAll<HTMLElement>('body *')]
					.map(element => {
						const bounds = element.getBoundingClientRect()
						return { tag: element.tagName, classes: element.className, left: bounds.left, right: bounds.right }
					})
					.filter(bounds => bounds.left < 0 || bounds.right > window.innerWidth)
					.slice(0, 16),
				controls: [
					...document.querySelectorAll<HTMLElement>('.remote-image-preview button, .remote-composer-actions button'),
				].map(control => {
					const bounds = control.getBoundingClientRect()
					return {
						width: bounds.width,
						height: bounds.height,
						top: bounds.top,
						bottom: bounds.bottom,
						left: bounds.left,
						right: bounds.right,
					}
				}),
			}
		})
		await info.attach('compact-geometry', {
			body: JSON.stringify(geometry, null, 2),
			contentType: 'application/json',
		})
		expect(geometry.top).toBe('36px')
		expect(geometry.bottom).toBe('24px')
		expect(geometry.reading).toBeGreaterThanOrEqual(96)
		expect(geometry.composer.bottom).toBe(420)
		expect(geometry.composer.left).toBeGreaterThanOrEqual(0)
		expect(geometry.composer.right).toBeLessThanOrEqual(width)
		expect(geometry.preview).toEqual({ width: 44, height: 44 })
		expect(geometry.editor.height).toBeGreaterThanOrEqual(40)
		for (const control of geometry.controls) {
			expect(control.width).toBe(44)
			expect(control.height).toBe(44)
			expect(control.top).toBeGreaterThanOrEqual(36)
			expect(control.bottom).toBeLessThanOrEqual(396)
			expect(control.left).toBeGreaterThanOrEqual(0)
			expect(control.right).toBeLessThanOrEqual(width)
		}
		await page.screenshot({ path: info.outputPath(`image-input-${width}x420-safe-area.png`) })
	})

	test(`expanded question with upload-failure status fits ${width}x420`, async ({ page }, info) => {
		await page.setViewportSize({ width, height: 420 })
		await open(page)
		await page.evaluate(() => {
			const rewrite = (rules: CSSRuleList) => {
				for (const rule of rules) {
					if (rule instanceof CSSStyleRule)
						rule.style.cssText = rule.style.cssText
							.replace(/env\(safe-area-inset-top(?:,\s*0px)?\)/g, '36px')
							.replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g, '24px')
					if (rule instanceof CSSGroupingRule) rewrite(rule.cssRules)
				}
			}
			for (const sheet of document.styleSheets) {
				try {
					rewrite(sheet.cssRules)
				} catch (error) {
					// Cross-origin sheets are inaccessible; computed inset checks below still apply.
					if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
				}
			}
		})
		const valid = await imageFile(page, 'question-failure.png', 'image/png', '#884466', 48, 32)
		await page.locator('input[type=file]').setInputFiles(valid)
		await page.route('**/v1/sessions/*/images?*', route => route.fulfill({ status: 500, body: '{}' }))
		await useProduction(page)
		await page.getByRole('button', { name: 'Send', exact: true }).click()
		await expect(page.locator('.remote-receipt')).toContainText('Message was not sent. Image upload failed.')
		await page.evaluate(() => window.__remoteFixture?.ask())
		await page.getByRole('button', { name: 'Edit draft', exact: true }).click()
		await expect(page.getByRole('button', { name: 'Hide draft', exact: true })).toBeVisible()
		await expect(page.locator('.remote-image-preview img')).toHaveCSS('width', '44px')
		const geometry = await page.evaluate(() => {
			const composer = document.querySelector('.remote-composer') as HTMLElement
			const reading = document.querySelector('.remote-reading-area') as HTMLElement
			const editor = document.querySelector('.remote-prompt-field textarea') as HTMLElement
			const preview = document.querySelector('.remote-image-preview img') as HTMLElement
			const bounds = composer.getBoundingClientRect()
			return {
				composer: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
				bottomInset: getComputedStyle(composer).paddingBottom,
				reading: reading.getBoundingClientRect().height,
				editor: editor.getBoundingClientRect().height,
				preview: preview.getBoundingClientRect().height,
				controls: [...composer.querySelectorAll('button')]
					.filter(button => button.getBoundingClientRect().height > 0)
					.map(button => {
						const control = button.getBoundingClientRect()
						return {
							name: button.getAttribute('aria-label') || button.textContent,
							top: control.top,
							bottom: control.bottom,
							left: control.left,
							right: control.right,
							width: control.width,
							height: control.height,
						}
					}),
			}
		})
		await info.attach('expanded-question-failure-geometry', {
			body: JSON.stringify(geometry, null, 2),
			contentType: 'application/json',
		})
		expect(geometry.composer.bottom).toBe(420)
		expect(geometry.composer.left).toBeGreaterThanOrEqual(0)
		expect(geometry.composer.right).toBeLessThanOrEqual(width)
		expect(geometry.bottomInset).toBe('24px')
		expect(geometry.reading).toBeGreaterThanOrEqual(96)
		expect(geometry.editor).toBeGreaterThanOrEqual(40)
		expect(geometry.preview).toBe(44)
		for (const control of geometry.controls) {
			expect(control.top, control.name ?? '').toBeGreaterThanOrEqual(36)
			expect(control.bottom, control.name ?? '').toBeLessThanOrEqual(396)
			expect(control.left, control.name ?? '').toBeGreaterThanOrEqual(0)
			expect(control.right, control.name ?? '').toBeLessThanOrEqual(width)
			expect(control.height, control.name ?? '').toBeGreaterThanOrEqual(44)
		}
		await page.screenshot({ path: info.outputPath(`expanded-question-failure-${width}x420.png`) })
		await page.getByRole('button', { name: 'Hide draft', exact: true }).click()
		await expect(page.getByRole('button', { name: 'Edit draft', exact: true })).toBeFocused()
	})
}
