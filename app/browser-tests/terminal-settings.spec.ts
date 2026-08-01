import { expect, test } from '@playwright/test'
import type { HelmApi } from '../src/shared'

test('terminal settings show the selected folder and reset new terminals to Home', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--terminal-settings&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible()
	await expect(page.getByText('/Users/you/Developer')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Choose folder' })).toBeVisible()

	await page.getByRole('button', { name: 'Use Home folder' }).click()
	await expect(page.getByText('/Users/you', { exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Use Home folder' })).toHaveCount(0)
})

test('terminal keyboard preferences toggle, disable, and reset through the production page', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--terminal-settings&viewMode=story')
	const optionAsMeta = page.getByRole('switch', { name: 'Option acts as Meta' })
	await expect(optionAsMeta).toBeChecked()
	await optionAsMeta.click()
	await expect(optionAsMeta).not.toBeChecked()

	const newTerminal = page.getByRole('group', { name: 'New terminal' })
	await newTerminal.getByRole('button', { name: /Remove .* from New terminal/ }).click()
	await expect(newTerminal.getByText('Not set', { exact: true })).toBeVisible()
	await newTerminal.getByRole('button', { name: 'Reset New terminal shortcut' }).click()
	await expect(newTerminal.getByRole('button', { name: /Change .* for New terminal/ })).toBeVisible()
})

test('terminal shortcut recorder rejects native conflicts and explicitly moves Helm conflicts', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--terminal-settings&viewMode=story')
	const newTerminal = page.getByRole('group', { name: 'New terminal' })
	const close = page.getByRole('group', { name: 'Close focused Helm surface' })

	await page.evaluate(() => {
		;(window as Window & { __shortcutRecordings?: Array<{ code: string }> }).__shortcutRecordings = [{ code: 'KeyK' }]
	})
	const original = newTerminal.getByRole('button', { name: /Change .* for New terminal/ })
	await original.click()
	await expect(newTerminal.getByRole('button', { name: /Change ⌘K for New terminal/ })).toBeFocused()

	await page.evaluate(() => {
		;(window as Window & { __shortcutRecordings?: Array<{ code: string }> }).__shortcutRecordings = [{ code: 'KeyV' }]
	})
	await newTerminal.getByRole('button', { name: /Change .* for New terminal/ }).click()
	await expect(page.getByText(/belongs to Edit > Paste/)).toBeVisible()
	await expect(newTerminal.getByRole('button', { name: /Change ⌘K for New terminal/ })).toBeVisible()

	await page.evaluate(() => {
		;(window as Window & { __shortcutRecordings?: Array<{ code: string }> }).__shortcutRecordings = [{ code: 'KeyW' }]
	})
	await newTerminal.getByRole('button', { name: /Change .* for New terminal/ }).click()
	await expect(page.getByText(/belongs to Close focused Helm surface/)).toBeVisible()

	// A conflict candidate cannot overwrite an unrelated update received while
	// its warning is open.
	await page.evaluate(async () => {
		const terminalPreferences = (window as unknown as Window & { helm: Pick<HelmApi, 'terminalPreferences'> }).helm
			.terminalPreferences
		const current = await terminalPreferences.get()
		await terminalPreferences.update({ revision: current.revision, optionAsMeta: false })
	})
	await expect(page.getByRole('switch', { name: 'Option acts as Meta' })).not.toBeChecked()
	await page.getByRole('button', { name: 'Move shortcut' }).click()
	await expect(page.getByText('Terminal settings changed elsewhere. Record the shortcut again.')).toBeVisible()
	await expect(newTerminal.getByRole('button', { name: /Change ⌘K for New terminal/ })).toBeVisible()
	await expect(close.getByRole('button', { name: /Change ⌘W for Close focused Helm surface/ })).toBeVisible()

	await page.evaluate(() => {
		;(window as Window & { __shortcutRecordings?: Array<{ code: string }> }).__shortcutRecordings = [{ code: 'KeyW' }]
	})
	await newTerminal.getByRole('button', { name: /Change .* for New terminal/ }).click()
	await page.getByRole('button', { name: 'Move shortcut' }).click()
	await expect(newTerminal.getByRole('button', { name: /Change ⌘W for New terminal/ })).toBeVisible()
	await expect(close.getByText('Not set', { exact: true })).toBeVisible()

	await page.getByRole('button', { name: 'Reset all' }).click()
	await expect(newTerminal.getByRole('button', { name: /Change ⌘T for New terminal/ })).toBeVisible()
	await expect(close.getByRole('button', { name: /Change ⌘W for Close focused Helm surface/ })).toBeVisible()
})

test('agent integrations direct package setup without installing files', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--agent-integrations&viewMode=story')
	await expect(page.getByRole('heading', { name: 'Agent integrations', exact: true })).toBeVisible()
	await expect(page.getByText('Not configured', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'View setup' }).click()
	await expect
		.poll(() =>
			page.evaluate(() => (window as typeof window & { __openedExternalUrls?: string[] }).__openedExternalUrls),
		)
		.toEqual(['https://github.com/neumie/pi-agent-status#install'])
	await expect(page.getByRole('button', { name: 'Install' })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Remove integration' })).toHaveCount(0)
})

test('externally managed Pi status packages expose no Helm mutation controls', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--agent-integrations-external&viewMode=story')
	await expect(page.getByText('Managed by Pi', { exact: true })).toBeVisible()
	await expect(page.getByText('Precise Pi terminal status is managed by a Pi package.')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Install' })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Remove integration' })).toHaveCount(0)
})
