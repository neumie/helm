import { expect, test } from '@playwright/test'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
	}
}

const story = '/iframe.html?id=views-terminal-workspace--browser-harness&viewMode=story'

test.beforeEach(async ({ page }) => {
	await page.goto(story)
	await expect(page.getByRole('button', { name: 'Background terminals' })).toBeVisible()
	await expect(page.getByRole('dialog', { name: 'Background terminals' })).toBeVisible()
})

test('Open keeps a Background terminal parked while Restore moves it into the strip', async ({ page }) => {
	const open = page.getByRole('button', { name: /Open tests and keep in background/i })
	await open.click()
	await expect(page.locator('.term-holder.active')).toBeVisible()
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false))
		.toBe(true)
	// Opening focuses the live holder and closes the transient dialog; reopening proves ownership stayed Background.
	await page.locator('#bg-toggle').click()
	await expect(page.getByRole('dialog', { name: 'Background terminals' }).getByText('tests')).toBeVisible()
	await expect(page.locator('#bg-toggle')).toContainText('2')
	await expect.poll(() => page.evaluate(() => window.__helmWorkspaceFixture?.calls.placement.length ?? -1)).toBe(0)

	await page.getByRole('button', { name: /Move tests to tabs and open/i }).click()
	await expect(page.getByRole('tab', { name: /tests/i })).toBeVisible()
	await expect(page.getByRole('dialog', { name: 'Background terminals' }).getByText('tests')).toHaveCount(0)
	await expect.poll(() => page.evaluate(() => window.__helmWorkspaceFixture?.calls.placement.at(-1)?.type)).toBe('move')
})

test('collapse and restore-all use production group controls without duplicate ids', async ({ page }) => {
	await page.getByRole('button', { name: 'Review 2' }).click()
	await expect(page.locator('.bg-group-members[hidden] .bg-row')).toHaveCount(2)
	await page.getByRole('button', { name: 'Review 2' }).click()
	await page.getByRole('button', { name: 'Restore Review group to tabs' }).click()
	await expect(page.getByRole('tab', { name: /tests/i })).toBeVisible()
	await expect(page.getByRole('tab', { name: /release logs/i })).toBeVisible()
	const duplicateIds = await page.locator('[id]').evaluateAll(nodes => {
		const ids = nodes.map(node => node.id)
		return ids.filter((id, index) => ids.indexOf(id) !== index)
	})
	expect(duplicateIds).toEqual([])
})

test('a terminal drag projects into trailing strip whitespace then Escape cancels without persistence', async ({
	page,
}) => {
	const source = page.getByRole('button', { name: /Open release logs and keep in background/i })
	const target = page.locator('#tab-strip-region')
	const sourceBox = await source.boundingBox()
	const targetBox = await target.boundingBox()
	expect(sourceBox).not.toBeNull()
	expect(targetBox).not.toBeNull()
	if (!sourceBox || !targetBox) return
	await page.mouse.move(sourceBox.x + 8, sourceBox.y + 8)
	await page.mouse.down()
	await page.mouse.move(targetBox.x + targetBox.width - 4, targetBox.y + 18, { steps: 4 })
	await expect(target).toHaveClass(/background-restore-ready/)
	await expect(target).toHaveClass(/background-restore-over/)
	await expect(page.locator('body')).toHaveClass(/tab-dragging/)
	await expect(page.locator('.background-tab-drag-preview')).toHaveCount(1)
	await page.keyboard.press('Escape')
	await expect(target).not.toHaveClass(/background-restore-ready/)
	await expect(target).not.toHaveClass(/background-restore-over/)
	await expect(page.locator('body')).not.toHaveClass(/tab-dragging/)
	await expect(page.locator('.background-tab-drag-preview')).toHaveCount(0)
	await expect(page.locator('#topbar-drag-space')).not.toHaveClass(/popover-catcher/)
	await page.locator('#bg-toggle').click()
	await expect(page.getByRole('dialog', { name: 'Background terminals' }).getByText('release logs')).toBeVisible()
	await expect.poll(() => page.evaluate(() => window.__helmWorkspaceFixture?.calls.placement.length ?? -1)).toBe(0)
})

test('a whole Background group drag reaches trailing strip whitespace and Escape removes production drag chrome', async ({
	page,
}) => {
	const header = page.getByRole('button', { name: 'Review 2' })
	const target = page.locator('#tab-strip-region')
	const sourceBox = await header.boundingBox()
	const targetBox = await target.boundingBox()
	expect(sourceBox).not.toBeNull()
	expect(targetBox).not.toBeNull()
	if (!sourceBox || !targetBox) return
	await page.mouse.move(sourceBox.x + 8, sourceBox.y + 8)
	await page.mouse.down()
	await page.mouse.move(targetBox.x + targetBox.width - 4, targetBox.y + 18, { steps: 4 })
	await expect(target).toHaveClass(/background-restore-ready/)
	await expect(target).toHaveClass(/background-restore-over/)
	await expect(page.locator('body')).toHaveClass(/group-dragging/)
	await expect(page.locator('.tab-group-drag-preview')).toHaveCount(1)
	await page.keyboard.press('Escape')
	await expect(target).not.toHaveClass(/background-restore-ready/)
	await expect(target).not.toHaveClass(/background-restore-over/)
	await expect(page.locator('body')).not.toHaveClass(/group-dragging/)
	await expect(page.locator('.tab-group-drag-preview')).toHaveCount(0)
	await expect(page.locator('#topbar-drag-space')).not.toHaveClass(/popover-catcher/)
	await page.locator('#bg-toggle').click()
	await expect(page.getByRole('dialog', { name: 'Background terminals' }).getByText('release logs')).toBeVisible()
})

test('a rejected drag retains concurrently created runtime inventory', async ({ page }) => {
	await page.evaluate(() => window.__helmWorkspaceFixture?.deferNextPlacement())
	const source = page.getByRole('button', { name: /Open release logs and keep in background/i })
	const target = page.locator('#tab-strip-region')
	const sourceBox = await source.boundingBox()
	const targetBox = await target.boundingBox()
	expect(sourceBox).not.toBeNull()
	expect(targetBox).not.toBeNull()
	if (!sourceBox || !targetBox) return
	await page.mouse.move(sourceBox.x + 8, sourceBox.y + 8)
	await page.mouse.down()
	await page.mouse.move(targetBox.x + targetBox.width - 4, targetBox.y + 18, { steps: 4 })
	await page.mouse.up()
	await expect
		.poll(() => page.evaluate(() => window.__helmWorkspaceFixture?.calls.placement.length ?? 0))
		.toBeGreaterThan(0)
	await page.getByRole('button', { name: 'New terminal' }).click()
	await page.evaluate(() => window.__helmWorkspaceFixture?.rejectDeferredPlacement())
	await expect(page.getByRole('tab', { name: 'zsh' })).toBeVisible()
	await page.locator('#bg-toggle').click()
	await expect(page.getByRole('dialog', { name: 'Background terminals' }).getByText('release logs')).toBeVisible()
})

test('a parked exit remains a visible exited row and foreground focus remains usable', async ({ page }) => {
	await page.evaluate(() => window.__helmWorkspaceFixture?.emitExit('logs', 0))
	await expect(page.getByRole('dialog', { name: 'Background terminals' }).getByText('Exited (0)')).toBeVisible()
	await page.getByRole('button', { name: /Open release logs and keep in background/i }).click()
	await expect(page.locator('.term-holder.active')).toBeVisible()
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false))
		.toBe(true)
	await expect(page.locator('#tab-strip-region.background-restore-ready')).toHaveCount(0)
})

test('strip drag joins a group through one atomic membership commit', async ({ page }) => {
	const source = page.getByRole('tab', { name: /active shell/i })
	const target = page.getByRole('tab', { name: /compile/i })
	const sourceBox = await source.boundingBox()
	const targetBox = await target.boundingBox()
	expect(sourceBox).not.toBeNull()
	expect(targetBox).not.toBeNull()
	if (!sourceBox || !targetBox) return
	await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
	await page.mouse.down()
	await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 4 })
	await page.mouse.up()
	await expect
		.poll(() => page.evaluate(() => window.__helmWorkspaceFixture?.calls.placement.at(-1)?.type))
		.toBe('set-membership')
	await expect(page.locator('.tab-group-section[data-group-id="group-000000a1"] [role="tab"]')).toHaveCount(2)
})

test('context-menu Escape restores focus to its production tab trigger', async ({ page }) => {
	const trigger = page.getByRole('tab', { name: /active shell/i })
	await trigger.click({ button: 'right' })
	await expect(page.getByRole('menu')).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(trigger).toBeFocused()
})

test('strip group drag to Background persists ownership and leaves no native drag chrome', async ({ page }) => {
	const source = page.getByRole('button', { name: 'Build' })
	const target = page.locator('#bg-toggle')
	const sourceBox = await source.boundingBox()
	const targetBox = await target.boundingBox()
	expect(sourceBox).not.toBeNull()
	expect(targetBox).not.toBeNull()
	if (!sourceBox || !targetBox) return
	await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
	await page.mouse.down()
	await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 4 })
	await expect(target).toHaveClass(/drag-over/)
	await page.mouse.up()
	await expect.poll(() => page.evaluate(() => window.__helmWorkspaceFixture?.calls.placement.at(-1)?.type)).toBe('move')
	await expect(page.locator('body')).not.toHaveClass(/tab-dragging/)
	await expect(page.locator('.tab-drag-preview')).toHaveCount(0)
	await expect(page.locator('#topbar-drag-space')).not.toHaveClass(/popover-catcher/)
	await page.locator('#bg-toggle').click()
	await expect(page.getByRole('dialog', { name: 'Background terminals' }).getByText('compile')).toBeVisible()
})

test('disposing during a live drag synchronously removes previews and leaves queued frames inert', async ({ page }) => {
	const pageErrors: string[] = []
	page.on('pageerror', error => pageErrors.push(error.message))
	const source = page.getByRole('button', { name: /Open release logs and keep in background/i })
	const target = page.locator('#tab-strip-region')
	const sourceBox = await source.boundingBox()
	const targetBox = await target.boundingBox()
	expect(sourceBox).not.toBeNull()
	expect(targetBox).not.toBeNull()
	if (!sourceBox || !targetBox) return
	await page.mouse.move(sourceBox.x + 8, sourceBox.y + 8)
	await page.mouse.down()
	await page.mouse.move(targetBox.x + targetBox.width - 4, targetBox.y + 18, { steps: 4 })
	await expect(page.locator('.background-tab-drag-preview')).toHaveCount(1)
	await page.evaluate(() => window.__helmWorkspaceFixture?.dispose())
	await expect(page.locator('.background-tab-drag-preview, .tab-drag-preview, .tab-group-drag-preview')).toHaveCount(0)
	await expect(page.locator('body')).not.toHaveClass(/tab-dragging|group-dragging/)
	await expect(page.locator('#topbar-drag-space')).not.toHaveClass(/popover-catcher/)
	await page.waitForTimeout(250)
	expect(pageErrors).toEqual([])
})
