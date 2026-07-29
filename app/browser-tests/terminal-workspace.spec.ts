import { expect, test } from '@playwright/test'
import type { TerminalWorkspaceFixture } from '../src/renderer/terminal-workspace-fixtures'

declare global {
	interface Window {
		__helmWorkspaceFixture?: TerminalWorkspaceFixture
		__helmFlushHeldFrames?: () => void
		__helmTabDragSettles?: Array<{
			duration: number
			from: string
			to: string
			targetConnected: boolean
			targetLeft: number
			targetTop: number
			targetWidth: number
			targetHeight: number
		}>
	}
}

const story = '/iframe.html?id=views-terminal-workspace--browser-harness&viewMode=story'

test.beforeEach(async ({ page }) => {
	await page.goto(story)
	await expect(page.getByRole('button', { name: 'Background terminals' })).toBeVisible()
	await expect(page.getByRole('dialog', { name: 'Background terminals' })).toBeVisible()
})

test('a synchronized redraw stays covered until xterm paints it through a resize', async ({ page }) => {
	const liveRows = page.locator('.term-holder.active .xterm-screen:not(.term-frame-freeze) .xterm-rows')
	await expect(liveRows).toBeVisible()
	await page.evaluate(() => window.__helmWorkspaceFixture?.emitData('shell', 'stable frame'))
	await expect(liveRows).toContainText('stable frame')

	await page.evaluate(() => {
		const originalRequest = window.requestAnimationFrame.bind(window)
		const originalCancel = window.cancelAnimationFrame.bind(window)
		const held = new Map<number, FrameRequestCallback>()
		let nextId = 1
		window.requestAnimationFrame = callback => {
			const id = nextId++
			held.set(id, callback)
			return id
		}
		window.cancelAnimationFrame = id => {
			held.delete(id)
		}
		window.__helmFlushHeldFrames = () => {
			window.requestAnimationFrame = originalRequest
			window.cancelAnimationFrame = originalCancel
			window.__helmFlushHeldFrames = undefined
			for (const callback of held.values()) originalRequest(callback)
			held.clear()
		}
		window.__helmWorkspaceFixture?.emitData('shell', '\u001b[?2026h\u001b[2J\u001b[Hreplacement frame\u001b[?2026l')
	})

	// Parsing completes on xterm's write queue while its DOM paint remains held.
	// Helm must keep the last complete frame over the live screen until that paint.
	await page.waitForTimeout(100)
	await expect(page.locator('.term-holder.active .term-frame-freeze')).toHaveCount(1)
	await expect(liveRows).toContainText('stable frame')

	// A resize before paint changes xterm's last row. The pending release must
	// follow the current viewport rather than wait forever for the old row bound.
	const viewport = page.viewportSize()
	if (!viewport) throw new Error('browser test requires a fixed viewport')
	await page.setViewportSize({ width: viewport.width, height: viewport.height - 120 })
	await page.waitForTimeout(100)
	await page.evaluate(() => window.__helmFlushHeldFrames?.())
	await expect(page.locator('.term-holder.active .term-frame-freeze')).toHaveCount(0)
	await expect(liveRows).toContainText('replacement frame')
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

test('strip drag keeps predicting after leaving and re-entering the strip', async ({ page }) => {
	const source = page.getByRole('tab', { name: /active shell/i })
	const target = page.getByRole('tab', { name: /compile/i })
	const terminal = page.locator('#right')
	const sourceBox = await source.boundingBox()
	const targetBox = await target.boundingBox()
	const terminalBox = await terminal.boundingBox()
	expect(sourceBox).not.toBeNull()
	expect(targetBox).not.toBeNull()
	expect(terminalBox).not.toBeNull()
	if (!sourceBox || !targetBox || !terminalBox) return
	await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
	await page.mouse.down()
	await page.mouse.move(terminalBox.x + terminalBox.width / 2, terminalBox.y + 80, { steps: 3 })
	await expect(page.locator('body')).toHaveClass(/tab-dragging/)
	await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 3 })
	await expect(page.locator('.tab-group-section[data-group-id="group-000000a1"] [role="tab"]')).toHaveCount(2)
	await page.keyboard.press('Escape')
})

test('an accepted collapsed-group drop settles into its visible committed group header', async ({ page }) => {
	await page.evaluate(() => {
		const animate = HTMLElement.prototype.animate
		window.__helmTabDragSettles = []
		HTMLElement.prototype.animate = function (keyframes, options) {
			const duration = typeof options === 'number' ? options : Number(options?.duration ?? 0)
			const frames = Array.isArray(keyframes) ? keyframes : []
			if (this.classList.contains('tab-drag-preview') && duration === 180) {
				const target = document.querySelector<HTMLElement>(
					'.tab-group-header[data-group-id="group-000000a1"][data-surface="strip"]',
				)
				const rect = target?.getBoundingClientRect()
				window.__helmTabDragSettles?.push({
					duration,
					from: String(frames[0]?.transform ?? ''),
					to: String(frames.at(-1)?.transform ?? ''),
					targetConnected: target?.isConnected === true,
					targetLeft: rect?.left ?? 0,
					targetTop: rect?.top ?? 0,
					targetWidth: rect?.width ?? 0,
					targetHeight: rect?.height ?? 0,
				})
			}
			return animate.call(this, keyframes, options)
		}
	})
	const target = page.locator('.tab-group-header[data-group-id="group-000000a1"]')
	await target.click()
	await expect(page.locator('.tab-group-section[data-group-id="group-000000a1"]')).toHaveClass(/collapsed/)
	await page.evaluate(() => window.__helmWorkspaceFixture?.deferNextPlacement())
	const source = page.getByRole('tab', { name: /active shell/i })
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
	await expect(page.locator('.tab-drag-preview')).toHaveCount(1)
	await expect(page.locator('.drag-placeholder')).toHaveCount(1)
	await page.evaluate(() => window.__helmWorkspaceFixture?.resolveDeferredPlacement())
	await expect
		.poll(() =>
			page.evaluate(() => {
				const settle = window.__helmTabDragSettles?.find(candidate => candidate.duration === 180)
				if (!settle) return false
				const destination = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\)/.exec(settle.to)
				return (
					settle.targetConnected &&
					settle.targetWidth > 0 &&
					settle.targetHeight > 0 &&
					settle.from !== settle.to &&
					destination !== null &&
					Math.abs(Number(destination[1]) - settle.targetLeft) < 1 &&
					Math.abs(Number(destination[2]) - settle.targetTop) < 1
				)
			}),
		)
		.toBe(true)
	await expect(page.locator('.tab-drag-preview, .drag-placeholder')).toHaveCount(0)
	await expect(page.locator('.tab-group-section[data-group-id="group-000000a1"] [role="tab"]')).toHaveCount(2)
})

test('a rejected group drop holds the clone through authorization then settles back without membership', async ({
	page,
}) => {
	await page.evaluate(() => {
		const animate = HTMLElement.prototype.animate
		window.__helmTabDragSettles = []
		HTMLElement.prototype.animate = function (keyframes, options) {
			const duration = typeof options === 'number' ? options : Number(options?.duration ?? 0)
			const frames = Array.isArray(keyframes) ? keyframes : []
			if (this.classList.contains('tab-drag-preview') && duration === 180) {
				const target = document.querySelector<HTMLElement>('[role="tab"][aria-label="active shell"]')
				const rect = target?.getBoundingClientRect()
				window.__helmTabDragSettles?.push({
					duration,
					from: String(frames[0]?.transform ?? ''),
					to: String(frames.at(-1)?.transform ?? ''),
					targetConnected: target?.isConnected === true,
					targetLeft: rect?.left ?? 0,
					targetTop: rect?.top ?? 0,
					targetWidth: rect?.width ?? 0,
					targetHeight: rect?.height ?? 0,
				})
			}
			return animate.call(this, keyframes, options)
		}
	})
	await page.evaluate(() => window.__helmWorkspaceFixture?.deferNextPlacement())
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
	await expect(page.locator('.tab-drag-preview')).toHaveCount(1)
	await expect(page.locator('.drag-placeholder')).toHaveCount(1)
	await page.evaluate(() => window.__helmWorkspaceFixture?.rejectDeferredPlacement())
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.__helmTabDragSettles?.some(
						settle => settle.duration === 180 && settle.targetConnected && settle.from !== settle.to,
					) ?? false,
			),
		)
		.toBe(true)
	await expect(page.locator('.tab-drag-preview, .drag-placeholder')).toHaveCount(0)
	await expect(page.locator('.tab-group-section[data-group-id="group-000000a1"] [role="tab"]')).toHaveCount(1)
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

test('Shell-menu terminal cycling wraps foreground tabs and excludes Background terminals', async ({ page }) => {
	await expect(page.getByRole('tab', { name: /active shell/i })).toHaveAttribute('aria-selected', 'true')
	await page.evaluate(() => window.__helmWorkspaceFixture?.emitTabPrevious())
	await expect(page.getByRole('tab', { name: /compile/i })).toHaveAttribute('aria-selected', 'true')
	await page.evaluate(() => window.__helmWorkspaceFixture?.emitTabNext())
	await expect(page.getByRole('tab', { name: /active shell/i })).toHaveAttribute('aria-selected', 'true')
	await page.evaluate(() => window.__helmWorkspaceFixture?.emitTabNext())
	await expect(page.getByRole('tab', { name: /compile/i })).toHaveAttribute('aria-selected', 'true')
	await expect(page.getByRole('dialog', { name: 'Background terminals' }).getByText('tests')).toBeVisible()
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
