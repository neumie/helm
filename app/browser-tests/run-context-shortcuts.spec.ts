import { expect, test } from '@playwright/test'
import type { ShortcutChord } from '../src/shortcuts'

declare global {
	interface Window {
		__runContextSaveCalls?: number
		__emitRunContextSaveBindings?: (bindings: ShortcutChord[]) => void
	}
}

const story = '/iframe.html?id=views-run-context-editor--source-context&viewMode=story'

test('Run Context Save follows live remapped and disabled bindings', async ({ page }) => {
	await page.goto(story)
	await expect(
		page.getByRole('heading', { name: 'Correct the export behavior and remove the stale workaround' }),
	).toBeVisible()

	await page.evaluate(() => {
		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true, repeat: true, bubbles: true }),
		)
		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true, isComposing: true, bubbles: true }),
		)
	})
	await page.waitForTimeout(50)
	await expect.poll(() => page.evaluate(() => window.__runContextSaveCalls ?? 0)).toBe(0)
	await page.keyboard.press('Meta+s')
	await expect.poll(() => page.evaluate(() => window.__runContextSaveCalls ?? 0)).toBe(1)

	await page.evaluate(() => window.__emitRunContextSaveBindings?.([{ code: 'KeyK' }]))
	await page.keyboard.press('Meta+s')
	await page.waitForTimeout(50)
	await expect.poll(() => page.evaluate(() => window.__runContextSaveCalls ?? 0)).toBe(1)
	await page.keyboard.press('Meta+k')
	await expect.poll(() => page.evaluate(() => window.__runContextSaveCalls ?? 0)).toBe(2)

	await page.evaluate(() => window.__emitRunContextSaveBindings?.([]))
	await page.keyboard.press('Meta+k')
	await page.waitForTimeout(50)
	await expect.poll(() => page.evaluate(() => window.__runContextSaveCalls ?? 0)).toBe(2)
})
