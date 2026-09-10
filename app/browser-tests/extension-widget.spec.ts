import { type Page, expect, test } from '@playwright/test'

declare global {
	interface Window {
		extensionWorkbench: {
			state: {
				tracked: boolean
				protocol: number
				rich: boolean
				running: boolean
				lifecycle: 'inbox' | 'ready' | 'active' | 'cancelled'
				planned: boolean
				revision: number
				text: string
				hold: string
				fail: string
				timeout: string
				origin: string
				profile: string
				generation: number
			}
			calls: Array<{ method: string; path: string; body: Record<string, unknown>; origin: string }>
			query: (selector: string) => HTMLElement | null
			require: (selector: string) => HTMLElement
			text: () => string
			closed: () => boolean
			switchSource: (source: string) => void
			release: () => void
			unmountWidget: () => void
		}
	}
}
async function text(page: Page) {
	return page.evaluate(() => window.extensionWorkbench.text())
}
async function click(page: Page, label: string) {
	const rect = await page.evaluate(label => {
		const root = window.extensionWorkbench.query('.vg-card') ?? window.extensionWorkbench.query('.vg-pill')
		const element = root?.matches('button')
			? root
			: Array.from(root?.querySelectorAll<HTMLElement>('button, summary') ?? []).find(
					button => button.textContent?.trim() === label,
				)
		if (!element) throw new Error(`Missing ${label}`)
		element.scrollIntoView({ block: 'nearest' })
		const box = element.getBoundingClientRect()
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
	}, label)
	await page.mouse.click(rect.x, rect.y)
}
async function open(page: Page) {
	await page.goto('/iframe.html?id=views-extension-widget--closed-shadow&viewMode=story')
	await expect.poll(() => page.evaluate(() => !!window.extensionWorkbench)).toBe(true)
	await expect.poll(() => text(page)).toContain('Inbox')
	expect(await page.evaluate(() => window.extensionWorkbench.closed())).toBe(true)
	await click(page, 'Inbox')
	await expect.poll(() => text(page)).toContain('Source narrative')
}
async function edit(page: Page, value: string, alreadyEditing = false) {
	if (!alreadyEditing) await click(page, 'Edit')
	await expect.poll(() => page.evaluate(() => !!window.extensionWorkbench.query('textarea'))).toBe(true)
	const box = await page.evaluate(() => {
		const element = window.extensionWorkbench.require('textarea')
		const rect = element.getBoundingClientRect()
		return { x: rect.x + 20, y: rect.y + 20 }
	})
	await page.mouse.click(box.x, box.y)
	await page.keyboard.press('ControlOrMeta+A')
	await page.keyboard.insertText(value)
}

test('closed-shadow dirty Start saves once with returned revision and frozen selection', async ({ page }) => {
	await open(page)
	await edit(page, 'Edited operator narrative')
	await page.evaluate(() => {
		window.extensionWorkbench.state.hold = '/run-context/plain'
	})
	await click(page, 'Start')
	await click(page, 'Start')
	await expect
		.poll(() =>
			page.evaluate(
				() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/run-context/plain')).length,
			),
		)
		.toBe(1)
	expect(
		await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/start')).length),
	).toBe(0)
	await page.evaluate(() => window.extensionWorkbench.release())
	await expect
		.poll(() =>
			page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/start')).length),
		)
		.toBe(1)
	const calls = await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.method !== 'GET'))
	expect(calls.map(call => call.path.split('/').at(-1))).toEqual(['plain', 'start'])
	expect(calls[0].body).toEqual({ revision: 2, text: 'Edited operator narrative' })
	expect(calls[1].body.expectedRunContextRevision).toBe(3)
	expect(new Set(calls.map(call => call.origin)).size).toBe(1)
	await page.screenshot({ path: '/tmp/helm-interface-redesign-20260910/finish/widget-running.png' })
})

test('late Save cannot publish or Start after source identity changes', async ({ page }) => {
	await open(page)
	await edit(page, 'Private A draft')
	await page.evaluate(() => {
		window.extensionWorkbench.state.hold = '/run-context/plain'
	})
	await click(page, 'Start')
	await expect
		.poll(() =>
			page.evaluate(() => window.extensionWorkbench.calls.some(call => call.path.endsWith('/run-context/plain'))),
		)
		.toBe(true)
	await page.evaluate(() => window.extensionWorkbench.switchSource('task-b'))
	await page.evaluate(() => window.extensionWorkbench.release())
	await expect.poll(() => text(page)).toContain('Other owner narrative')
	expect(
		await page.evaluate(
			() =>
				(window.extensionWorkbench.query('textarea') as HTMLTextAreaElement | null)?.value ??
				window.extensionWorkbench.query('.vg-run-context__text')?.textContent,
		),
	).not.toContain('Private A draft')
	expect(
		await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/start')).length),
	).toBe(0)
})

test('explicit untracked preparation seeds text blocks and comments without Start', async ({ page }) => {
	await open(page)
	await page.evaluate(() => {
		window.extensionWorkbench.state.tracked = false
		window.extensionWorkbench.switchSource('untracked')
	})
	await expect.poll(() => text(page)).toContain('Edit prompt')
	expect(await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.method !== 'GET').length)).toBe(
		0,
	)
	await click(page, 'Edit prompt')
	await expect
		.poll(() => page.evaluate(() => (window.extensionWorkbench.query('textarea') as HTMLTextAreaElement | null)?.value))
		.toContain('Important comment')
	const value = await page.evaluate(() => (window.extensionWorkbench.query('textarea') as HTMLTextAreaElement).value)
	expect(value).toContain('Full source text')
	expect(value).not.toContain('provider-hash')
	expect(
		await page.evaluate(() =>
			window.extensionWorkbench.calls.filter(call => call.method !== 'GET').map(call => call.path),
		),
	).toEqual(['/items/source'])
	await expect.poll(() => text(page)).toContain('Evidence.png')
	await edit(page, 'Revision zero draft', true)
	await click(page, 'Save prompt')
	await expect
		.poll(() =>
			page.evaluate(
				() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/run-context/plain')).length,
			),
		)
		.toBe(1)
	const saved = await page.evaluate(() =>
		window.extensionWorkbench.calls.find(call => call.path.endsWith('/run-context/plain')),
	)
	expect(saved?.body).toEqual({ revision: 0, text: 'Revision zero draft' })
	expect(await page.evaluate(() => window.extensionWorkbench.calls.some(call => call.path.endsWith('/start')))).toBe(
		false,
	)
})

test('rich v1 remains preview-only and old protocol keeps non-editor Start', async ({ page }) => {
	await open(page)
	await page.evaluate(() => {
		window.extensionWorkbench.state.rich = true
		window.extensionWorkbench.switchSource('rich')
	})
	await expect.poll(() => text(page)).toContain('Rich saved narrative')
	expect(await page.evaluate(() => window.extensionWorkbench.query('textarea'))).toBeNull()
	await expect.poll(() => text(page)).toContain('Open Helm to edit')
	await page.evaluate(() => {
		window.extensionWorkbench.state.protocol = 48
		window.extensionWorkbench.switchSource('old')
	})
	await expect.poll(() => text(page)).not.toContain('Rich saved narrative')
	await click(page, 'Start')
	await expect
		.poll(() =>
			page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/start')).length),
		)
		.toBe(1)
	expect(
		await page.evaluate(() => window.extensionWorkbench.calls.find(call => call.path.endsWith('/start'))?.body),
	).not.toHaveProperty('expectedRunContextRevision')
})

test('409 retains dirty text and blocks automatic or double retries', async ({ page }) => {
	await open(page)
	await edit(page, 'Keep this draft')
	await page.evaluate(() => {
		window.extensionWorkbench.state.fail = '/run-context/plain'
	})
	await click(page, 'Start')
	await expect.poll(() => text(page)).toContain('nothing is retried automatically')
	expect(await page.evaluate(() => (window.extensionWorkbench.query('textarea') as HTMLTextAreaElement).value)).toBe(
		'Keep this draft',
	)
	await click(page, 'Start')
	expect(await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.method !== 'GET').length)).toBe(
		1,
	)
})

test('narrow three-agent controls, custom model, More keyboard and IME admission', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 740 })
	await open(page)
	const summary = await page.evaluate(() => window.extensionWorkbench.query('summary')?.textContent ?? '')
	await click(page, summary)
	for (const agent of ['Claude', 'Codex', 'Pi']) {
		await click(page, agent)
		await expect.poll(() => text(page)).toContain(`Run with ${agent}`)
	}
	const geometry = await page.evaluate(() => {
		const card = window.extensionWorkbench.require('.vg-card').getBoundingClientRect()
		const buttons = Array.from(window.extensionWorkbench.require('.vg-agent__seg').querySelectorAll('button')).map(
			button => button.getBoundingClientRect(),
		)
		return {
			right: card.right,
			left: card.left,
			tops: buttons.map(box => box.top),
			widths: buttons.map(box => box.width),
		}
	})
	expect(geometry.left).toBeGreaterThanOrEqual(0)
	expect(geometry.right).toBeLessThanOrEqual(320)
	expect(new Set(geometry.tops).size).toBe(1)
	expect(Math.min(...geometry.widths)).toBeGreaterThan(24)
	await click(page, 'More')
	await page.keyboard.press('ArrowDown')
	await page.keyboard.press('Escape')
	expect(await page.evaluate(() => window.extensionWorkbench.query('[role="menu"]'))).toBeNull()
	await edit(page, 'Multiline draft')
	await page.evaluate(() =>
		window.extensionWorkbench
			.require('textarea')
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })),
	)
	expect(await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.method !== 'GET').length)).toBe(
		0,
	)
	await page.screenshot({ path: '/tmp/helm-interface-redesign-20260910/finish/widget-narrow.png' })
})

for (const boundary of ['origin', 'profile'] as const)
	test(`pending Save never starts across ${boundary} change`, async ({ page }) => {
		await open(page)
		await edit(page, 'Bound draft')
		await page.evaluate(() => {
			window.extensionWorkbench.state.hold = '/run-context/plain'
		})
		await click(page, 'Start')
		await expect
			.poll(() =>
				page.evaluate(() => window.extensionWorkbench.calls.some(call => call.path.endsWith('/run-context/plain'))),
			)
			.toBe(true)
		await page.evaluate(boundary => {
			const state = window.extensionWorkbench.state
			if (boundary === 'origin') state.origin = 'https://other.helm-workbench.invalid'
			else {
				state.profile = 'another-profile'
				state.generation++
			}
			window.extensionWorkbench.release()
		}, boundary)
		await expect.poll(() => text(page)).toContain('No further action was sent')
		expect(
			await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/start')).length),
		).toBe(0)
		expect(
			await page.evaluate(() =>
				window.extensionWorkbench.calls.filter(call => call.method !== 'GET').map(call => call.origin),
			),
		).toEqual(['https://helm-workbench.invalid'])
	})

test('same-ID polls do not strand pending prompt load or replace dirty draft', async ({ page }) => {
	await page.clock.install()
	await open(page)
	await page.evaluate(() => {
		window.extensionWorkbench.state.hold = '/run-context'
		window.extensionWorkbench.switchSource('slow')
	})
	await expect.poll(() => text(page)).toContain('Loading prompt')
	await page.clock.runFor(5100)
	await expect
		.poll(() =>
			page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path === '/items/by-source/slow').length),
		)
		.toBeGreaterThanOrEqual(2)
	expect(
		await page.evaluate(
			() => window.extensionWorkbench.calls.filter(call => call.path === '/items/item-slow/run-context').length,
		),
	).toBe(1)
	await page.evaluate(() => window.extensionWorkbench.release())
	await expect.poll(() => text(page)).toContain('Other owner narrative')
	await edit(page, 'Unpublished draft')
	await page.evaluate(() => {
		window.extensionWorkbench.state.text = 'Externally changed'
		window.extensionWorkbench.state.revision++
	})
	await page.clock.runFor(5100)
	expect(await page.evaluate(() => (window.extensionWorkbench.query('textarea') as HTMLTextAreaElement).value)).toBe(
		'Unpublished draft',
	)
})

test('clean external revisions refresh, GET failure has explicit retry, mutation timeout is not replayed', async ({
	page,
}) => {
	await page.clock.install()
	await open(page)
	const initialReads = await page.evaluate(
		() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/run-context')).length,
	)
	await page.evaluate(() => {
		window.extensionWorkbench.state.text = 'New authoritative text'
		window.extensionWorkbench.state.revision++
	})
	await page.clock.runFor(5100)
	await expect
		.poll(() =>
			page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/run-context')).length),
		)
		.toBeGreaterThan(initialReads)
	await expect.poll(() => text(page)).toContain('New authoritative text')
	await page.evaluate(() => {
		window.extensionWorkbench.state.fail = '/run-context'
		window.extensionWorkbench.switchSource('retry')
	})
	await expect.poll(() => text(page)).toContain('Retry prompt load')
	await page.evaluate(() => {
		window.extensionWorkbench.state.fail = ''
	})
	await click(page, 'Retry prompt load')
	await expect.poll(() => text(page)).toContain('Other owner narrative')
	await edit(page, 'Timeout draft')
	await page.evaluate(() => {
		window.extensionWorkbench.state.timeout = '/run-context/plain'
	})
	await click(page, 'Start')
	await expect.poll(() => text(page)).toContain('Controlled timeout after dispatch')
	await page.clock.runFor(5100)
	expect(
		await page.evaluate(
			() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/run-context/plain')).length,
		),
	).toBe(1)
	expect(
		await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/start')).length),
	).toBe(0)
})

test('Enter inserts a newline, collapse retains draft, and same-task shortcuts start only once', async ({ page }) => {
	await open(page)
	await edit(page, 'First line')
	await page.keyboard.press('Enter')
	await page.keyboard.insertText('Second line')
	expect(await page.evaluate(() => (window.extensionWorkbench.query('textarea') as HTMLTextAreaElement).value)).toBe(
		'First line\nSecond line',
	)
	await click(page, '×')
	await click(page, 'Inbox')
	expect(await page.evaluate(() => (window.extensionWorkbench.query('textarea') as HTMLTextAreaElement).value)).toBe(
		'First line\nSecond line',
	)
	await page.evaluate(() => {
		const textarea = window.extensionWorkbench.require('textarea')
		for (let i = 0; i < 2; i++)
			textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
	})
	await expect
		.poll(() =>
			page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/start')).length),
		)
		.toBe(1)
	expect(
		await page.evaluate(
			() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/run-context/plain')).length,
		),
	).toBe(1)
})

test('custom model and default workspace are sent exactly; late configuration preserves touched agent', async ({
	page,
}) => {
	await open(page)
	await page.evaluate(() => {
		window.extensionWorkbench.state.hold = '/config'
		window.extensionWorkbench.switchSource('late-config')
	})
	await expect.poll(() => text(page)).toContain('Other owner narrative')
	const summary = await page.evaluate(() => window.extensionWorkbench.require('summary').textContent ?? '')
	await click(page, summary)
	await click(page, 'Pi')
	const rect = await page.evaluate(() => {
		const rect = window.extensionWorkbench.require('input[aria-label="Custom model"]').getBoundingClientRect()
		return { x: rect.x + 20, y: rect.y + 10 }
	})
	await page.mouse.click(rect.x, rect.y)
	await page.keyboard.insertText('provider/custom-model')
	await click(page, 'Main')
	await click(page, 'Main')
	await page.evaluate(() => window.extensionWorkbench.release())
	await expect.poll(() => text(page)).toContain('Run with Pi · provider/custom-model · Default')
	await click(page, 'Start')
	await expect
		.poll(() => page.evaluate(() => window.extensionWorkbench.calls.some(call => call.path.endsWith('/start'))))
		.toBe(true)
	const body = await page.evaluate(
		() => window.extensionWorkbench.calls.find(call => call.path.endsWith('/start'))?.body,
	)
	expect(body?.solverAgent).toBe('pi')
	expect(body?.solverModel).toBe('provider/custom-model')
	expect(body?.solverWorkspace).toBeNull()
	expect(body?.expectedRunContextRevision).toBe(2)
})

test('Queue and More Plan/Re-plan/Reject never accidentally Start', async ({ page }) => {
	await page.clock.install()
	await open(page)
	await click(page, 'Queue')
	await expect
		.poll(() =>
			page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/approve')).length),
		)
		.toBe(1)
	await expect
		.poll(() => page.evaluate(() => window.extensionWorkbench.query('.vg-card__status')?.textContent))
		.toBe('Ready')
	await click(page, 'More')
	expect(await text(page)).not.toContain('Reject')
	await click(page, 'Plan')
	await expect
		.poll(() => page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/plan')).length))
		.toBe(1)
	await page.clock.runFor(5100)
	await expect
		.poll(() => page.evaluate(() => window.extensionWorkbench.query('.vg-card__status')?.textContent))
		.toBe('Active')
	await click(page, 'More')
	await expect.poll(() => text(page)).toContain('Re-plan')
	await click(page, 'Re-plan')
	await expect
		.poll(() => page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/plan')).length))
		.toBe(2)
	// Reject is an Inbox operation, never a continuation of the active plan.
	await page.evaluate(() => {
		window.extensionWorkbench.state.lifecycle = 'inbox'
		window.extensionWorkbench.state.planned = false
		window.extensionWorkbench.switchSource('reject-inbox')
	})
	await expect
		.poll(() => page.evaluate(() => window.extensionWorkbench.query('.vg-card__status')?.textContent))
		.toBe('Inbox')
	await click(page, 'More')
	await click(page, 'Reject')
	await expect
		.poll(() =>
			page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/reject')).length),
		)
		.toBe(1)
	await expect
		.poll(() => page.evaluate(() => window.extensionWorkbench.query('.vg-card__status')?.textContent))
		.toBe('Cancelled')
	expect(
		await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/start')).length),
	).toBe(0)
})

test('model menu keeps nonfavorites available and restores trigger focus', async ({ page }) => {
	await open(page)
	const summary = await page.evaluate(() => window.extensionWorkbench.require('summary').textContent ?? '')
	await click(page, summary)
	await click(page, 'Auto')
	await expect.poll(() => text(page)).toContain('Other Claude model')
	await click(page, 'Other Claude model')
	expect(
		await page.evaluate(() => {
			const trigger = window.extensionWorkbench.require('[aria-label="Solver model"]')
			return (trigger.getRootNode() as ShadowRoot).activeElement === trigger
		}),
	).toBe(true)
	await click(page, 'Other Claude model')
	await page.keyboard.press('Home')
	await page.keyboard.press('Enter')
	await expect.poll(() => text(page)).toContain('Default model')
	expect(await page.evaluate(() => window.extensionWorkbench.query('select'))).toBeNull()
})

test('disposing the widget fences a pending Save from issuing Start', async ({ page }) => {
	await open(page)
	await edit(page, 'Do not start after disposal')
	await page.evaluate(() => {
		window.extensionWorkbench.state.hold = '/run-context/plain'
	})
	await click(page, 'Start')
	await expect
		.poll(() =>
			page.evaluate(() => window.extensionWorkbench.calls.some(call => call.path.endsWith('/run-context/plain'))),
		)
		.toBe(true)
	await page.evaluate(() => {
		window.extensionWorkbench.unmountWidget()
		window.extensionWorkbench.release()
	})
	await expect.poll(() => page.evaluate(() => window.extensionWorkbench.state.revision)).toBe(3)
	await page.evaluate(
		() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	)
	expect(
		await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path.endsWith('/start')).length),
	).toBe(0)
})

for (const action of ['Start', 'Queue'])
	test(`preparatory context origin fence refuses untracked ${action}`, async ({ page }) => {
		await page.clock.install()
		await open(page)
		await page.evaluate(() => {
			window.extensionWorkbench.state.tracked = false
			window.extensionWorkbench.switchSource('untracked-fence')
		})
		await expect.poll(() => text(page)).toContain('Edit prompt')
		await page.evaluate(() => {
			window.extensionWorkbench.state.hold = '/run-context'
		})
		await click(page, action)
		await expect
			.poll(() =>
				page.evaluate(() =>
					window.extensionWorkbench.calls.some(
						call => call.path.endsWith('/run-context') && call.path.includes('untracked-fence'),
					),
				),
			)
			.toBe(true)
		await page.evaluate(() => {
			window.extensionWorkbench.state.origin = 'https://replacement.helm-workbench.invalid'
			window.extensionWorkbench.release()
		})
		await page.evaluate(
			() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
		)
		const writes = await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.method !== 'GET'))
		expect(writes.map(call => call.path)).toEqual(['/items/source'])
		expect(writes.every(call => call.origin === 'https://helm-workbench.invalid')).toBe(true)
		await expect.poll(() => text(page)).toContain('No further action was sent')
	})

test('status-await origin fence refuses a tracked mutation', async ({ page }) => {
	await page.clock.install()
	await open(page)
	const count = await page.evaluate(
		() => window.extensionWorkbench.calls.filter(call => call.path === '/status').length,
	)
	await page.evaluate(() => {
		window.extensionWorkbench.state.hold = '/status'
	})
	await click(page, 'Queue')
	await expect
		.poll(() => page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.path === '/status').length))
		.toBe(count + 1)
	await page.evaluate(() => {
		window.extensionWorkbench.state.origin = 'https://replacement.helm-workbench.invalid'
		window.extensionWorkbench.release()
	})
	await page.evaluate(
		() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	)
	expect(await page.evaluate(() => window.extensionWorkbench.calls.filter(call => call.method !== 'GET'))).toEqual([])
	await expect.poll(() => text(page)).toContain('No further action was sent')
})

test('failed initial prompt load cannot admit an unsavable draft and explicit retry recovers', async ({ page }) => {
	await open(page)
	await page.evaluate(() => {
		window.extensionWorkbench.state.fail = '/run-context'
		window.extensionWorkbench.switchSource('initial-failure')
	})
	await expect.poll(() => text(page)).toContain('Retry prompt load')
	expect(
		await page.evaluate(() => {
			const button = Array.from(window.extensionWorkbench.require('.vg-card').querySelectorAll('button')).find(
				node => node.textContent?.trim() === 'Edit',
			)
			return !button || button.disabled
		}),
	).toBe(true)
	expect(await page.evaluate(() => window.extensionWorkbench.query('textarea'))).toBeNull()
	expect(await text(page)).not.toContain('Save prompt')
	await page.evaluate(() => {
		window.extensionWorkbench.state.fail = ''
	})
	await click(page, 'Retry prompt load')
	await expect.poll(() => text(page)).toContain('Other owner narrative')
	await edit(page, 'Recovered editable draft')
	await click(page, 'Save prompt')
	await expect.poll(() => page.evaluate(() => window.extensionWorkbench.state.text)).toBe('Recovered editable draft')
	const saves = await page.evaluate(() =>
		window.extensionWorkbench.calls.filter(call => call.path.endsWith('/run-context/plain')),
	)
	expect(saves).toHaveLength(1)
	expect(saves[0].body).toEqual({ revision: 2, text: 'Recovered editable draft' })
})
