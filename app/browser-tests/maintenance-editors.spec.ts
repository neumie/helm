import { expect, test } from '@playwright/test'

type FixtureWindow = Window & {
	__editors: {
		pending: number
		back: number
		requests: Array<{ kind: string; body: Record<string, unknown> }>
		release: (fail?: boolean, index?: number) => void
	}
}

test('Settings save acknowledges only the submitted draft and keeps the restart notice', async ({ page }) => {
	await page.goto('/iframe.html?id=views-editors-maintenance--settings-save&viewMode=story')
	const field = page.getByLabel('Agent runs', { exact: true })
	await expect(field).toHaveValue('2')
	await field.fill('3')
	await page.getByRole('button', { name: 'Save changes', exact: true }).click()
	await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__editors.pending)).toBe(1)
	await field.fill('4')
	await page.evaluate(() => (window as FixtureWindow).__editors.release())
	await expect(field).toHaveValue('4')
	await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled()
	await expect(page.getByText('Fixture restart required')).toBeVisible()
	await page.getByRole('button', { name: 'Save changes', exact: true }).click()
	expect(await page.evaluate(() => (window as FixtureWindow).__editors.requests.map(request => request.body))).toEqual([
		{ solver: { concurrency: 3 } },
		{ solver: { concurrency: 4 } },
	])
	await page.evaluate(() => (window as FixtureWindow).__editors.release())
	await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0)
})

test('an older restart completion cannot clear a later save restart notice', async ({ page }) => {
	await page.goto('/iframe.html?id=views-editors-maintenance--settings-save&viewMode=story')
	const field = page.getByLabel('Agent runs', { exact: true })
	await expect(field).toHaveValue('2')
	await field.fill('3')
	await page.getByRole('button', { name: 'Save changes', exact: true }).click()
	await page.evaluate(() => (window as FixtureWindow).__editors.release())
	await page.getByRole('button', { name: 'Restart', exact: true }).click()
	await field.fill('4')
	await page.getByRole('button', { name: 'Save changes', exact: true }).click()
	await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__editors.pending)).toBe(2)
	await page.evaluate(() => (window as FixtureWindow).__editors.release(false, 1))
	await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0)
	await page.evaluate(() => (window as FixtureWindow).__editors.release())
	await expect(page.getByText('Fixture restart required')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled()
})

test('profile reload updates the baseline without replacing later name/project edits', async ({ page }) => {
	await page.goto('/iframe.html?id=views-editors-maintenance--profile-save&viewMode=story')
	const name = page.getByLabel('Name', { exact: true })
	await expect(name).toHaveValue('Work')
	await name.fill('Submitted')
	await page.getByRole('button', { name: 'Save profile' }).click()
	await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__editors.pending)).toBe(1)
	await name.fill('Later')
	await page.getByRole('switch', { name: 'Enable helm' }).click()
	await page.evaluate(() => (window as FixtureWindow).__editors.release())
	await expect(name).toHaveValue('Later')
	await expect(page.getByRole('switch', { name: 'Enable helm' })).toHaveAttribute('aria-checked', 'false')
	await expect(page.getByRole('button', { name: 'Save profile' })).toBeEnabled()
	await page.getByRole('button', { name: 'Save profile' }).click()
	expect(await page.evaluate(() => (window as FixtureWindow).__editors.requests.at(-1)?.body)).toMatchObject({
		name: 'Later',
		enabledProjects: [],
	})
	await page.evaluate(() => (window as FixtureWindow).__editors.release())
	await expect(page.getByRole('button', { name: 'Save profile' })).toBeDisabled()
})

for (const create of [false, true]) {
	test(`${create ? 'new' : 'existing'} schedule preserves later prompt/name and saves against returned revision`, async ({
		page,
	}) => {
		await page.goto(`/iframe.html?id=views-editors-maintenance--schedule-${create ? 'create' : 'save'}&viewMode=story`)
		const name = page.getByLabel('Name', { exact: true })
		const prompt = page.getByLabel('Prompt', { exact: true })
		await expect(name).toBeVisible()
		await name.fill('Submitted schedule')
		await prompt.fill('Submitted prompt')
		await page.getByRole('button', { name: create ? 'Create schedule' : 'Save changes', exact: true }).click()
		await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__editors.pending)).toBe(1)
		await name.fill('Later schedule')
		await prompt.fill('Later prompt')
		await page.evaluate(() => (window as FixtureWindow).__editors.release())
		await expect(name).toHaveValue('Later schedule')
		await expect(prompt).toHaveValue('Later prompt')
		expect(await page.evaluate(() => (window as FixtureWindow).__editors.back)).toBe(0)
		await page.getByRole('button', { name: 'Save changes', exact: true }).click()
		expect(await page.evaluate(() => (window as FixtureWindow).__editors.requests.at(-1))).toMatchObject({
			kind: 'schedule-update',
			body: { name: 'Later schedule', revision: create ? 1 : 2, definition: { prompt: 'Later prompt' } },
		})
	})
}

for (const kind of ['settings', 'profile', 'schedule'] as const) {
	test(`${kind} rejected save keeps the later draft retryable`, async ({ page }) => {
		await page.goto(`/iframe.html?id=views-editors-maintenance--${kind}-save&viewMode=story`)
		const field = page.getByLabel(kind === 'settings' ? 'Agent runs' : 'Name', { exact: true })
		await expect(field).toBeVisible()
		await field.fill(kind === 'settings' ? '3' : 'Submitted')
		const save = page.getByRole('button', { name: kind === 'profile' ? 'Save profile' : 'Save changes', exact: true })
		await save.click()
		await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__editors.pending)).toBe(1)
		await field.fill(kind === 'settings' ? '4' : 'Later')
		await page.evaluate(() => (window as FixtureWindow).__editors.release(true))
		await expect(field).toHaveValue(kind === 'settings' ? '4' : 'Later')
		await expect(save).toBeEnabled()
	})

	test(`${kind} retired API completion cannot mark the replacement editor clean`, async ({ page }) => {
		await page.goto(`/iframe.html?id=views-editors-maintenance--${kind}-save&viewMode=story`)
		const field = page.getByLabel(kind === 'settings' ? 'Agent runs' : 'Name', { exact: true })
		await expect(field).toBeVisible()
		await field.fill(kind === 'settings' ? '3' : 'Submitted')
		const save = page.getByRole('button', { name: kind === 'profile' ? 'Save profile' : 'Save changes', exact: true })
		await save.click()
		await expect.poll(() => page.evaluate(() => (window as FixtureWindow).__editors.pending)).toBe(1)
		await page.getByRole('button', { name: 'Replace fixture API' }).click()
		await expect(field).toHaveValue(kind === 'settings' ? '2' : kind === 'profile' ? 'Work' : 'Daily review')
		await field.fill(kind === 'settings' ? '5' : 'Replacement draft')
		await page.evaluate(() => (window as FixtureWindow).__editors.release())
		await expect(field).toHaveValue(kind === 'settings' ? '5' : 'Replacement draft')
		await expect(save).toBeEnabled()
	})
}
