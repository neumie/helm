import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { build } from 'esbuild'
import { VIEWER_CSP } from '../src/document-review/viewer-csp'
import { assetMime } from '../src/document-review/viewer-protocol'
import type { createReviewFixture } from '../src/renderer/document-review/fixtures'
import { buildCzechExport } from '../src/renderer/viewer/csv-fixture-builder'
import { buildCjkPdf, buildJbig2Pdf, buildJpxPdf } from '../src/renderer/viewer/pdf-fixture-builder'

declare global {
	interface Window {
		__helmNativeReviewScenario?: 'normal' | 'not-listening' | 'working'
		__helmNativeReviewProof?: ReturnType<typeof createReviewFixture>
		__helmNativeViewerFile?: { name: string; format: 'code' | 'data'; language: string; size: number; lines: number }
		__helmNativeViewerPicture?: { name: string; type: 'jpeg' | 'svg'; mime: string; size: number }
		__helmNativeViewerPdf?: { name: string; size: number }
		__helmNativeViewerCsv?: { name: string; size: number }
	}
}

let assets: Map<string, { body: Buffer; contentType: string }>
test.beforeAll(async () => {
	const fixturePath = resolve(__dirname, '../src/renderer/document-review/fixtures.ts')
	const fixture = await build({
		stdin: {
			resolveDir: resolve(__dirname, '..'),
			contents: `import {createReviewFixture} from ${JSON.stringify(fixturePath)};
const viewer = window.__helmNativeViewerFile;
const picture = window.__helmNativeViewerPicture;
const pdf = window.__helmNativeViewerPdf;
const csv = window.__helmNativeViewerCsv;
const fixture = createReviewFixture(viewer || picture || pdf || csv ? 'plain' : window.__helmNativeReviewScenario);
if (csv) fixture.replaceDocument({ name: csv.name, format: 'csv', text: '', previous: null, revision: '1'.repeat(64), csv: { url: 'file/' + csv.name, size: csv.size, kind: 'csv', encoding: 'utf-8-bom' } });
if (pdf) fixture.replaceDocument({ name: pdf.name, format: 'pdf', text: '', previous: null, revision: '1'.repeat(64), pdf: { url: 'file/' + pdf.name, size: pdf.size } });
if (picture) fixture.replaceDocument({ name: picture.name, format: 'image', text: '', previous: null, revision: '1'.repeat(64), picture: { url: 'file/' + picture.name, type: picture.type, mime: picture.mime, size: picture.size, fileSize: picture.size } });
if (viewer) fixture.replaceDocument({ name: viewer.name, format: viewer.format, text: '', previous: null, revision: '1'.repeat(64), viewer: { url: 'file/' + viewer.name, language: viewer.language, size: viewer.size, encoding: 'utf-8', lines: viewer.lines, ending: 'LF' } });
window.documentReview = fixture.api; window.__helmNativeReviewProof = fixture;`,
			loader: 'ts',
		},
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'iife',
	})
	const output = fixture.outputFiles[0]
	if (!output) throw new Error('Missing compiled fixture preload')
	// The split ESM build (helm open S2): the page, its module entry and every lazy chunk/worker under dist/viewer,
	// each served with the MIME type and CSP response header helm-viewer:// gives it in the app.
	const root = resolve(__dirname, '../dist/viewer')
	const html = await readFile(join(root, 'index.html'), 'utf8')
	const entryScript = '<script type="module" src="assets/document-review.js"></script>'
	if (!html.includes(entryScript)) throw new Error('The built viewer page no longer loads its module entry')
	if (!html.includes(VIEWER_CSP)) throw new Error('The built viewer page CSP differs from VIEWER_CSP')
	// Keep the built entry, its StrictMode boundary and native CSP. Only preload IO
	// is substituted with the explicit display fixture on this loopback route.
	assets = new Map([
		[
			'',
			{
				body: Buffer.from(html.replace(entryScript, `<script src="fixture.js"></script>${entryScript}`)),
				contentType: 'text/html; charset=utf-8',
			},
		],
		['fixture.js', { body: Buffer.from(output.contents), contentType: 'text/javascript' }],
	])
	for (const name of await readdir(join(root, 'assets'), { recursive: true })) {
		const contentType = assetMime(name)
		if (!contentType) continue
		assets.set(`assets/${name}`, { body: await readFile(join(root, 'assets', name)), contentType })
	}
	if (![...assets.keys()].some(name => /^assets\/chunk-.*\.js$/.test(name)))
		throw new Error('No split chunks were built')
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
			await route.fulfill({
				status: 200,
				body: asset.body,
				headers: {
					'Content-Type': asset.contentType,
					'Content-Security-Policy': VIEWER_CSP,
					'X-Content-Type-Options': 'nosniff',
				},
			})
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

// The same built entry showing plain code and data files: the code view, its lazily loaded grammar and the data
// worker all load as split chunks from 'self' under the viewer CSP, and the file bytes come from a same-origin URL
// standing in for helm-viewer://app/file/<token> (blob: and other origins are outside connect-src).
const VIEWER_FILES = {
	'issue.json': {
		format: 'data',
		language: 'json',
		text: '{\n  "id": 1,\n  "culprit": "saveFirm",\n  "tags": [{ "key": "release" }]\n}\n',
	},
	'main.go': { format: 'code', language: 'go', text: 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n' },
} as const
for (const [name, file] of Object.entries(VIEWER_FILES))
	test(`built native entry shows ${name} through split chunks under the viewer CSP`, async ({ page, baseURL }) => {
		if (!baseURL) throw new Error('Use the owned loopback workbench baseURL')
		const entry = new URL('/__helm-native-review/', baseURL)
		const served: string[] = []
		await page.route(`${entry.href}**`, async route => {
			const path = new URL(route.request().url()).pathname.slice(entry.pathname.length)
			served.push(path)
			if (path === `file/${name}`)
				return route.fulfill({
					status: 200,
					body: file.text,
					headers: {
						'Content-Type': 'application/octet-stream',
						'Content-Security-Policy': "sandbox; default-src 'none'",
					},
				})
			const asset = assets.get(path)
			if (!asset) return route.fulfill({ status: 404, body: '' })
			await route.fulfill({
				status: 200,
				body: asset.body,
				headers: {
					'Content-Type': asset.contentType,
					'Content-Security-Policy': VIEWER_CSP,
					'X-Content-Type-Options': 'nosniff',
				},
			})
		})
		await page.addInitScript(
			value => {
				window.__helmNativeViewerFile = value
			},
			{
				name,
				format: file.format,
				language: file.language,
				size: Buffer.byteLength(file.text),
				lines: file.text.split('\n').length,
			},
		)
		const errors: string[] = []
		const violations: string[] = []
		page.on('pageerror', error => errors.push(error.message))
		page.on('console', message => {
			if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
		})
		await page.setViewportSize({ width: 1100, height: 760 })
		await page.goto(entry.href)
		await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
		if (file.format === 'data') {
			const tree = page.getByRole('tree', { name: 'Data tree' })
			await expect(tree.getByRole('treeitem', { name: /^culprit/ })).toContainText('"saveFirm"')
			expect(served).toContain('assets/data-worker.js')
		} else {
			await expect(page.locator('.viewer-code .cm-content')).toContainText('println("hi")')
			// The Go grammar is its own chunk; highlighting proves it loaded and ran.
			await expect
				.poll(() => page.locator('.viewer-code .cm-line span', { hasText: /^package$/ }).count())
				.toBeGreaterThan(0)
			expect(served.some(path => /^assets\/go-.*\.js$/.test(path))).toBe(true)
		}
		expect(served.filter(path => path.startsWith('assets/chunk-')).length).toBeGreaterThan(0)
		expect(errors).toEqual([])
		expect(violations).toEqual([])
	})

// Pictures through the same built entry: the image worker chunk checks the header from 'self', the bytes become a
// blob: image (img-src allows blob:), and an SVG's script and external images stay inert under the real CSP.
const PICTURES = {
	'phone-photo-rotated.jpg': { type: 'jpeg', mime: 'image/jpeg', size: '520 × 760' },
	'release-badge.svg': { type: 'svg', mime: 'image/svg+xml', size: '480 × 320' },
} as const
for (const [name, picture] of Object.entries(PICTURES))
	test(`built native entry shows the picture ${name} under the viewer CSP`, async ({ page, baseURL }) => {
		if (!baseURL) throw new Error('Use the owned loopback workbench baseURL')
		const bytes = await readFile(resolve(__dirname, '../src/renderer/viewer/fixtures/images', name))
		const entry = new URL('/__helm-native-review/', baseURL)
		const served: string[] = []
		const outside: string[] = []
		page.on('request', request => {
			if (!request.url().startsWith(entry.origin) && !request.url().startsWith('blob:')) outside.push(request.url())
		})
		await page.route(`${entry.href}**`, async route => {
			const path = new URL(route.request().url()).pathname.slice(entry.pathname.length)
			served.push(path)
			if (path === `file/${name}`)
				return route.fulfill({
					status: 200,
					body: bytes,
					headers: {
						'Content-Type': 'application/octet-stream',
						'X-Content-Type-Options': 'nosniff',
						'Content-Security-Policy': "sandbox; default-src 'none'",
					},
				})
			const asset = assets.get(path)
			if (!asset) return route.fulfill({ status: 404, body: '' })
			await route.fulfill({
				status: 200,
				body: asset.body,
				headers: {
					'Content-Type': asset.contentType,
					'Content-Security-Policy': VIEWER_CSP,
					'X-Content-Type-Options': 'nosniff',
				},
			})
		})
		await page.addInitScript(
			value => {
				window.__helmNativeViewerPicture = value
			},
			{ name, type: picture.type, mime: picture.mime, size: bytes.length },
		)
		const errors: string[] = []
		const violations: string[] = []
		page.on('pageerror', error => errors.push(error.message))
		page.on('console', message => {
			if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
		})
		await page.setViewportSize({ width: 1100, height: 760 })
		await page.goto(entry.href)
		await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
		const image = page.locator('.viewer-picture-image')
		await expect(image).toBeVisible()
		await expect(image).toHaveAttribute('src', /^blob:/)
		await expect(page.locator('.viewer-status')).toContainText(picture.size)
		// Raster headers are checked in the image worker; an SVG has no pixel header and goes straight to <img>.
		if (picture.type === 'svg') expect(served).not.toContain('assets/image-worker.js')
		else expect(served).toContain('assets/image-worker.js')
		await page.waitForTimeout(300)
		expect(outside).toEqual([])
		expect(await page.title()).not.toBe('svg-script-ran')
		expect(errors).toEqual([])
		expect(violations).toEqual([])
	})

// PDFs through the same built entry: pdf.js's own module worker, CMaps and wasm decoders come from assets/pdfjs/
// under the real CSP ('wasm-unsafe-eval', no eval), and the file is read by Range like a helm-viewer: token.
const fax = (() => {
	const width = 320
	const height = 200
	const pixels = Uint8Array.from({ length: width * height }, (_, index) => {
		const x = index % width
		const y = Math.floor(index / width)
		return x < 6 || y < 6 || x >= width - 6 || y >= height - 6 || (x > 40 && x < 140 && y > 40 && y < 120) ? 1 : 0
	})
	return { width, height, pixels }
})()
const PDFS = {
	'platform-report-2026-10.pdf': {
		text: 'Platform report, October 2026',
		asset: /^assets\/pdfjs\/build\/pdf\.worker\.min\.mjs$/,
	},
	'invoices-asia-2026-11.pdf': { text: '請求書', asset: /^assets\/pdfjs\/cmaps\/UniJIS-UCS2-H\.bcmap$/ },
	'fax-2026-10-21.pdf': { text: null, asset: /^assets\/pdfjs\/wasm\/jbig2\.wasm$/ },
	'form-error-jpeg2000.pdf': { text: null, asset: /^assets\/pdfjs\/wasm\/openjpeg\.wasm$/ },
} as const
const pdfBytes = async (name: keyof typeof PDFS) =>
	name === 'invoices-asia-2026-11.pdf'
		? Buffer.from(buildCjkPdf())
		: name === 'fax-2026-10-21.pdf'
			? Buffer.from(buildJbig2Pdf(fax))
			: name === 'form-error-jpeg2000.pdf'
				? readFile(resolve(__dirname, '../src/renderer/viewer/fixtures/pdf/form-error.jp2')).then(jp2 =>
						Buffer.from(buildJpxPdf(new Uint8Array(jp2), 760, 520)),
					)
				: readFile(resolve(__dirname, '../src/renderer/viewer/fixtures/pdf', name))
for (const [name, expected] of Object.entries(PDFS) as [keyof typeof PDFS, (typeof PDFS)[keyof typeof PDFS]][])
	test(`built native entry shows the PDF ${name} under the viewer CSP`, async ({ page, baseURL }) => {
		if (!baseURL) throw new Error('Use the owned loopback workbench baseURL')
		const bytes = await pdfBytes(name)
		const entry = new URL('/__helm-native-review/', baseURL)
		const served: string[] = []
		const ranges: string[] = []
		const outside: string[] = []
		page.on('request', request => {
			if (!request.url().startsWith(entry.origin) && !request.url().startsWith('blob:')) outside.push(request.url())
		})
		await page.route(`${entry.href}**`, async route => {
			const path = new URL(route.request().url()).pathname.slice(entry.pathname.length)
			served.push(path)
			if (path === `file/${name}`) {
				const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? '')
				if (!range) return route.fulfill({ status: 400, body: '' })
				const start = Number(range[1])
				const end = Math.min(Number(range[2]), bytes.length - 1)
				ranges.push(`${start}-${end}`)
				return route.fulfill({
					status: 206,
					body: bytes.subarray(start, end + 1),
					headers: {
						'Content-Type': 'application/octet-stream',
						'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
						'X-Content-Type-Options': 'nosniff',
						'Content-Security-Policy': "sandbox; default-src 'none'",
					},
				})
			}
			const asset = assets.get(path)
			if (!asset) return route.fulfill({ status: 404, body: '' })
			await route.fulfill({
				status: 200,
				body: asset.body,
				headers: {
					'Content-Type': asset.contentType,
					'Content-Security-Policy': VIEWER_CSP,
					'X-Content-Type-Options': 'nosniff',
				},
			})
		})
		await page.addInitScript(
			value => {
				window.__helmNativeViewerPdf = value
			},
			{ name, size: bytes.length },
		)
		const errors: string[] = []
		const violations: string[] = []
		page.on('pageerror', error => errors.push(error.message))
		page.on('console', message => {
			if (/Content Security Policy|unsafe-eval/i.test(message.text())) violations.push(message.text())
		})
		await page.setViewportSize({ width: 1100, height: 760 })
		await page.goto(entry.href)
		await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
		await expect(page.locator('[data-pdf-page="1"] canvas[data-painted]')).toBeVisible({ timeout: 20000 })
		if (expected.text) await expect(page.locator('[data-pdf-page="1"] .viewer-pdf-text')).toContainText(expected.text)
		await expect(page.locator('.viewer-status-position')).toHaveText(/^Page 1 of \d+$/)
		expect(served.some(path => expected.asset.test(path))).toBe(true)
		// pdf.js and the view are their own lazy chunks, loaded only for a PDF.
		expect(served.some(path => /^assets\/PdfView-.*\.js$/.test(path))).toBe(true)
		expect(ranges.length).toBeGreaterThan(0)
		expect(served).not.toContain('assets/pdfjs/wasm/jbig2_nowasm_fallback.js')
		await page.waitForTimeout(300)
		expect(outside).toEqual([])
		expect(errors).toEqual([])
		expect(violations).toEqual([])
	})

// A CSV through the same built entry: the grid's own module worker (assets/csv-worker.js, CSP from its response)
// reads the file by Range like a helm-viewer: token, decodes it strictly and parses it; the grid is a lazy chunk.
test('built native entry shows a CSV grid under the viewer CSP', async ({ page, baseURL }) => {
	if (!baseURL) throw new Error('Use the owned loopback workbench baseURL')
	const name = 'faktury-2026-10.csv'
	const bytes = Buffer.from(buildCzechExport(), 'utf8')
	const entry = new URL('/__helm-native-review/', baseURL)
	const served: string[] = []
	const ranges: string[] = []
	const outside: string[] = []
	page.on('request', request => {
		if (!request.url().startsWith(entry.origin) && !request.url().startsWith('blob:')) outside.push(request.url())
	})
	await page.route(`${entry.href}**`, async route => {
		const path = new URL(route.request().url()).pathname.slice(entry.pathname.length)
		served.push(path)
		if (path === `file/${name}`) {
			const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? '')
			if (!range) return route.fulfill({ status: 400, body: '' })
			const start = Number(range[1])
			const end = Math.min(Number(range[2]), bytes.length - 1)
			ranges.push(`${start}-${end}`)
			return route.fulfill({
				status: 206,
				body: bytes.subarray(start, end + 1),
				headers: {
					'Content-Type': 'application/octet-stream',
					'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
					'X-Content-Type-Options': 'nosniff',
					'Content-Security-Policy': "sandbox; default-src 'none'",
				},
			})
		}
		const asset = assets.get(path)
		if (!asset) return route.fulfill({ status: 404, body: '' })
		await route.fulfill({
			status: 200,
			body: asset.body,
			headers: {
				'Content-Type': asset.contentType,
				'Content-Security-Policy': VIEWER_CSP,
				'X-Content-Type-Options': 'nosniff',
			},
		})
	})
	await page.addInitScript(
		value => {
			window.__helmNativeViewerCsv = value
		},
		{ name, size: bytes.length },
	)
	const errors: string[] = []
	const violations: string[] = []
	page.on('pageerror', error => errors.push(error.message))
	page.on('console', message => {
		if (/Content Security Policy|unsafe-eval/i.test(message.text())) violations.push(message.text())
	})
	await page.setViewportSize({ width: 1100, height: 760 })
	await page.goto(entry.href)
	await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
	await expect(page.locator('.viewer-grid-band .viewer-grid-cell').first()).toHaveText('Číslo faktury', {
		timeout: 20000,
	})
	await expect(page.locator('.viewer-status')).toContainText('241 rows')
	await expect(page.locator('.viewer-status')).toContainText('Semicolon-separated')
	expect(served).toContain('assets/csv-worker.js')
	expect(served.some(path => /^assets\/CsvGrid-.*\.js$/.test(path))).toBe(true)
	expect(ranges.length).toBeGreaterThan(0)
	await page.waitForTimeout(300)
	expect(outside).toEqual([])
	expect(errors).toEqual([])
	expect(violations).toEqual([])
})
