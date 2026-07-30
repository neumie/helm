import { expect, test } from '@playwright/test'

test('new item page accepts Title, Prompt, or both while rejecting an empty draft', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--new-item&viewMode=story')
	const capture = page.locator('.new-item-page')
	await expect(capture).toBeVisible({ timeout: 15_000 })
	await expect(capture.getByRole('heading', { name: 'New item' })).toBeVisible()
	await expect(capture.getByText('Title, prompt, or both.')).toBeVisible()
	await expect(capture.getByText('Project setup comes later.')).toBeVisible()
	await expect(capture.getByRole('dialog')).toHaveCount(0)

	const title = capture.getByLabel('Title')
	const prompt = capture.getByLabel('Prompt')
	await expect(title).toBeVisible()
	await expect(prompt).not.toHaveAttribute('required', '')
	await expect(capture.locator('.new-item-editor .input').nth(0)).toHaveAttribute('id', 'new-item-title')
	await expect(capture.locator('.new-item-editor .input').nth(1)).toHaveAttribute('id', 'new-item-prompt')
	await expect(capture.getByRole('combobox')).toHaveCount(0)
	await expect(capture.getByText('Base ref', { exact: true })).toHaveCount(0)

	const create = capture.getByRole('button', { name: 'Add to Queue' })
	await expect(create).toBeDisabled()

	await title.fill('Title-only draft')
	await expect(create).toBeEnabled()
	await create.click()
	await expect
		.poll(() => page.evaluate(() => (window as Window & { __createdItemBody?: unknown }).__createdItemBody))
		.toEqual({ kind: 'solve', title: 'Title-only draft' })

	await title.fill('')
	await expect(create).toBeDisabled()
	await prompt.fill('Prompt-only draft')
	await create.click()
	await expect
		.poll(() => page.evaluate(() => (window as Window & { __createdItemBody?: unknown }).__createdItemBody))
		.toEqual({ kind: 'solve', prompt: 'Prompt-only draft' })

	await title.fill('Combined draft')
	await create.click()
	await expect
		.poll(() => page.evaluate(() => (window as Window & { __createdItemBody?: unknown }).__createdItemBody))
		.toEqual({ kind: 'solve', title: 'Combined draft', prompt: 'Prompt-only draft' })
})

test('new item push navigation restores focus and fences an in-flight create', async ({ page }) => {
	await page.goto('/iframe.html?id=views-sidebar--new-item-navigation&viewMode=story')
	const opener = page.getByRole('button', { name: 'New item', exact: true })
	await expect(opener).toBeVisible({ timeout: 15_000 })
	await opener.click()

	const capture = page.locator('.new-item-page')
	const title = capture.getByLabel('Title')
	const prompt = capture.getByLabel('Prompt')
	await expect(title).toBeFocused()
	await title.fill('Transient draft')
	await prompt.fill('Keep this visible throughout the pop animation.')
	await expect
		.poll(() =>
			prompt.evaluate(
				element => getComputedStyle(element.closest('.new-item-prompt-field') as Element, '::before').backgroundColor,
			),
		)
		.not.toBe('rgba(0, 0, 0, 0)')
	await prompt.press('Escape')
	await expect(capture).toHaveCount(0)
	await expect(opener).toBeFocused()

	await opener.click()
	await expect(capture.getByLabel('Title')).toHaveValue('')
	await expect(capture.getByLabel('Prompt')).toHaveValue('')
	await capture.getByLabel('Prompt').fill('Create exactly one queued draft.')
	await page.evaluate(() => {
		const storyWindow = window as Window & { __deferCreateItem?: boolean }
		storyWindow.__deferCreateItem = true
	})
	await capture.getByRole('button', { name: 'Add to Queue' }).click()
	await expect(capture.getByRole('button', { name: 'Back' })).toBeDisabled()
	await page.keyboard.press('Escape')
	const mouseBackPrevented = await page.evaluate(() => {
		const event = new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true })
		window.dispatchEvent(event)
		return event.defaultPrevented
	})
	expect(mouseBackPrevented).toBe(true)
	await expect(capture).toBeVisible()
	await expect
		.poll(() => page.evaluate(() => (window as Window & { __createItemCalls?: number }).__createItemCalls))
		.toBe(1)
	await page.evaluate(() => (window as Window & { __resolveCreateItem?: () => void }).__resolveCreateItem?.())
	await expect(capture).toHaveCount(0)

	const detailBack = page.getByRole('button', { name: 'Back' })
	await expect(detailBack).toBeVisible()
	await detailBack.click()
	await expect(opener).toBeVisible()
	await expect(capture).toHaveCount(0)
})

test('finish setup defers project selection and optional title to the draft detail', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'helm', {
			configurable: true,
			value: {
				daemon: {
					assignItem: async (id: string, body: unknown) => {
						;(window as Window & { __assignedItemBody?: unknown }).__assignedItemBody = { id, body }
						return { data: { id } }
					},
				},
			},
		})
	})
	await page.goto('/iframe.html?id=compositions-menu-and-navigation--finish-item-setup-sheet&viewMode=story')
	const sheet = page.getByRole('dialog', { name: 'Finish item setup' })
	await expect(sheet).toBeVisible()
	const project = sheet.getByLabel('Project')
	await expect(project).toBeFocused()
	await expect(project).toHaveValue('')
	await expect(project).toHaveAttribute('required', '')
	await expect(sheet.getByLabel('Title (optional)')).toHaveValue('')
	await expect(sheet.getByLabel('Prompt')).toHaveCount(0)
	const save = sheet.getByRole('button', { name: 'Save' })
	await expect(save).toBeDisabled()
	await project.selectOption('helm')
	await expect(save).toBeEnabled()
	await save.click()
	await expect
		.poll(() => page.evaluate(() => (window as Window & { __assignedItemBody?: unknown }).__assignedItemBody))
		.toEqual({ id: 'unassigned-story', body: { projectSlug: 'helm' } })
})
