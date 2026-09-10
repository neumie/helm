import { expect, test } from '@playwright/test'

const evidence = '/tmp/helm-interface-redesign-20260910/finish'
const imageUrl = 'https://example.test/source-image.png'
const narrative = 'Operator narrative with preserved source image.'

test('v2 Run Context preserves text and images through real v1 Save and reopen', async ({ page }) => {
	await page.route(imageUrl, route =>
		route.fulfill({
			contentType: 'image/png',
			body: Buffer.from(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=',
				'base64',
			),
		}),
	)
	await page.goto('/iframe.html?id=views-run-context-editor--v-2-plain-context&viewMode=story')
	await expect(page.getByText('Saved custom context')).toBeVisible()
	const editor = page.locator('[contenteditable="true"]').first()
	await expect(editor).toContainText(narrative)
	await expect(page.locator(`img[src="${imageUrl}"]`)).toBeVisible()
	await editor.click()
	await page.keyboard.press('ControlOrMeta+Home')
	await page.keyboard.press('End')
	await page.keyboard.type(' Edited')
	await page.getByRole('button', { name: 'Save context', exact: true }).click()
	await expect(page.getByText('Saved', { exact: true })).toBeVisible()
	const saved = await page.evaluate(() => window.__runContextLastDocument)
	expect(saved?.version).toBe(1)
	expect(saved?.markdown).toContain(narrative)
	expect(saved?.markdown).toContain('Edited')
	expect(saved?.markdown).toContain(imageUrl)
	expect(saved?.markdown).toContain('source-image.png')
	expect(JSON.stringify(saved?.blocks)).toContain(narrative)
	expect(JSON.stringify(saved?.blocks)).toContain('Edited')
	expect(saved?.blocks.filter(block => block.type === 'image')).toEqual([
		expect.objectContaining({
			props: expect.objectContaining({
				url: imageUrl,
				name: 'source-image.png',
				caption: 'source-image.png',
			}),
		}),
	])
	await page.screenshot({ path: `${evidence}/native-v1-saved.png`, fullPage: true })
	await page.evaluate(() => window.__reopenRunContext?.())
	await expect(page.getByText('Saved custom context')).toBeVisible()
	await expect(page.locator('[contenteditable="true"]').first()).toContainText(narrative)
	await expect(page.locator('[contenteditable="true"]').first()).toContainText('Edited')
	await expect(page.locator(`img[src="${imageUrl}"]`)).toBeVisible()
	await page.screenshot({ path: `${evidence}/native-v1-reopened.png`, fullPage: true })
	// Reserialize the reopened real BlockNote document, not a fabricated Markdown projection.
	await page.locator('[contenteditable="true"]').first().click()
	await page.keyboard.press('ControlOrMeta+Home')
	await page.keyboard.type('[Reopened marker]')
	await page.getByRole('button', { name: 'Save context', exact: true }).click()
	await expect(page.getByText('Saved', { exact: true })).toBeVisible()
	const reopened = await page.evaluate(() => window.__runContextLastDocument)
	expect(reopened?.markdown).toContain(narrative)
	expect(reopened?.markdown).toContain('[Reopened marker]')
	expect(reopened?.markdown).toContain(imageUrl)
	expect(reopened?.blocks.filter(block => block.type === 'image')).toEqual(
		saved?.blocks.filter(block => block.type === 'image'),
	)
})

test('an intentionally empty v2 opens empty instead of reintroducing source narrative', async ({ page }) => {
	await page.goto('/iframe.html?id=views-run-context-editor--v-2-empty-context&viewMode=story')
	await expect(page.getByText('Saved custom context')).toBeVisible()
	const editor = page.locator('[contenteditable="true"]').first()
	await expect(editor).toBeVisible()
	await expect(editor).not.toContainText('The export should preserve')
	await expect(editor).not.toContainText('alphabetical ordering')
	expect((await editor.textContent())?.trim()).toBe('')
})
