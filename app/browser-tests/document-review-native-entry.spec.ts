import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { build } from 'esbuild'
import type { createReviewFixture } from '../src/renderer/document-review/fixtures'

declare global {
	interface Window {
		__helmNativeReviewScenario?: 'normal' | 'not-listening' | 'working'
		__helmNativeReviewProof?: ReturnType<typeof createReviewFixture>
	}
}

let assets: Map<string, { body: Buffer; contentType: string }>
test.beforeAll(async () => {
	const fixturePath = resolve(__dirname, '../src/renderer/document-review/fixtures.ts')
	const fixture = await build({
		stdin: {
			resolveDir: resolve(__dirname, '..'),
			contents: `import {createReviewFixture} from ${JSON.stringify(fixturePath)}; const fixture=createReviewFixture(window.__helmNativeReviewScenario); window.documentReview=fixture.api; window.__helmNativeReviewProof=fixture;`,
			loader: 'ts',
		},
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'iife',
	})
	const output = fixture.outputFiles[0]
	if (!output) throw new Error('Missing compiled fixture preload')
	const html = await readFile(resolve(__dirname, '../dist/document-review.html'), 'utf8')
	// Keep the built entry, its StrictMode boundary and native CSP. Only preload IO
	// is substituted with the explicit display fixture on this loopback route.
	assets = new Map([
		[
			'',
			{
				body: Buffer.from(
					html.replace(
						'<script src="document-review.js">',
						'<script src="fixture.js"></script><script src="document-review.js">',
					),
				),
				contentType: 'text/html',
			},
		],
		['fixture.js', { body: Buffer.from(output.contents), contentType: 'text/javascript' }],
		[
			'document-review.js',
			{ body: await readFile(resolve(__dirname, '../dist/document-review.js')), contentType: 'text/javascript' },
		],
		[
			'document-review.css',
			{ body: await readFile(resolve(__dirname, '../dist/document-review.css')), contentType: 'text/css' },
		],
	])
})

async function selectIntro(page: Page) {
	const paragraph = page.locator('.review-block-text p').first()
	await expect(paragraph).toBeVisible()
	const points = await paragraph.evaluate(element => {
		const node = element.firstChild
		if (!node?.textContent) throw new Error('Missing fixture paragraph')
		const range = document.createRange()
		range.setStart(node, 0)
		range.setEnd(node, node.textContent.length)
		const rects = [...range.getClientRects()]
		const first = rects[0]
		const last = rects.at(-1)
		if (!first || !last) throw new Error('Missing selection geometry')
		return { first: first.toJSON(), last: last.toJSON() }
	})
	await page.mouse.move(points.first.x + 1, points.first.y + points.first.height / 2)
	await page.mouse.down()
	await page.mouse.move(points.last.x + points.last.width - 1, points.last.y + points.last.height / 2, { steps: 12 })
	await page.mouse.up()
	await expect(page.locator('.review-passage-editor')).toBeVisible()
	await expect(page.getByRole('textbox', { name: 'Passage instruction' })).toBeFocused()
}

for (const scenario of ['normal', 'not-listening', 'working'] as const)
	test(`built native entry retains passage writing through StrictMode cleanup (${scenario})`, async ({
		page,
		baseURL,
	}, info) => {
		if (!baseURL) throw new Error('Use the owned loopback workbench baseURL')
		const entry = new URL('/__helm-native-review/', baseURL)
		await page.route(`${entry.href}**`, async route => {
			const name = new URL(route.request().url()).pathname.slice(entry.pathname.length)
			const asset = assets.get(name)
			if (!asset) return route.fulfill({ status: 404, body: '' })
			await route.fulfill({ status: 200, ...asset })
		})
		await page.addInitScript(value => {
			window.__helmNativeReviewScenario = value
		}, scenario)
		const errors: string[] = []
		page.on('pageerror', error => errors.push(error.message))
		await page.setViewportSize({ width: 1197, height: 807 })
		await page.goto(entry.href)
		await expect(page.getByRole('textbox', { name: 'Whole-document message' })).toBeVisible()
		await selectIntro(page)
		const editor = page.getByRole('textbox', { name: 'Passage instruction' })
		await editor.fill('Keep this passage draft')
		const send = page.getByRole('button', { name: 'Send passage discussion' })
		if (scenario === 'normal') await expect(send).toBeEnabled()
		else await expect(send).toBeDisabled()
		await page.screenshot({ path: info.outputPath('native-entry-selection.png') })
		// Genuine native closure must still retire the DOM; only effect-owned
		// teardown is suppressed, not browser dismissal or Escape/Close.
		await page.evaluate(() => {
			const panel = document.querySelector<HTMLElement>('.review-passage-editor')
			if (!panel) throw new Error('Missing open bubble')
			panel.hidePopover()
		})
		await expect(page.locator('.review-passage-editor')).toHaveCount(0)
		await selectIntro(page)
		await expect(editor).toHaveValue('Keep this passage draft')
		await page.keyboard.press('Escape')
		await expect(page.locator('.review-passage-editor')).toHaveCount(0)
		await expect(page.locator('.review-reading')).toBeFocused()
		expect(await page.evaluate(() => window.__helmNativeReviewProof?.stats().sends)).toBe(0)
		expect(errors).toEqual([])
	})
