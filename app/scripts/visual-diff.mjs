#!/usr/bin/env node
// Pixel-identity proof for design-system refactors (docs/plans/design-system/spec.md § Stages).
// Not a regression gate: the author of a CSS/TSX refactor captures every story before and after and shows 0
// differing pixels.
//
//   node app/scripts/visual-diff.mjs capture <storybook-url> <out-dir> [--filter <substring>] [--exclude <substring>]…
//   node app/scripts/visual-diff.mjs compare <before-dir> <after-dir> [--report <file.json>]
//
// Capture is deterministic: fixed clock, reduced motion, animations/transitions/carets stopped, fixed viewport.
// Compare decodes PNGs in Chromium (no image dependency) and counts differing pixels per story.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const FIXED_TIME = new Date('2026-11-12T12:00:00.000Z')
const VIEWPORT = { width: 1280, height: 900 }
const FREEZE = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;
transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}`

function options(argv) {
	const filters = []
	const excludes = []
	let report
	const rest = []
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index]
		if (value === '--filter') filters.push(argv[++index])
		else if (value === '--exclude') excludes.push(argv[++index])
		else if (value === '--report') report = argv[++index]
		else rest.push(value)
	}
	return { filters, excludes, report, rest }
}

const safeName = id => id.replace(/[^a-z0-9-]+/gi, '_')

async function capture(base, out, filters, excludes) {
	const index = await (await fetch(new URL('index.json', base.endsWith('/') ? base : `${base}/`))).json()
	const stories = Object.values(index.entries)
		.filter(entry => entry.type === 'story')
		.filter(entry => filters.length === 0 || filters.some(filter => `${entry.title} ${entry.id}`.includes(filter)))
		.filter(entry => !excludes.some(exclude => `${entry.title} ${entry.id}`.includes(exclude)))
	await mkdir(out, { recursive: true })
	const browser = await chromium.launch()
	const failures = []
	try {
		const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce', deviceScaleFactor: 1 })
		for (const story of stories) {
			const page = await context.newPage()
			await page.clock.setFixedTime(FIXED_TIME)
			const errors = []
			page.on('pageerror', error => errors.push(String(error)))
			try {
				const url = new URL(
					`iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`,
					base.endsWith('/') ? base : `${base}/`,
				)
				await page.goto(url.href, { waitUntil: 'load' })
				await page.addStyleTag({ content: FREEZE })
				await page.waitForFunction(() => document.querySelector('#storybook-root')?.childElementCount !== 0, null, {
					timeout: 15_000,
				})
				await page.evaluate(() => document.fonts.ready)
				await page.waitForTimeout(250)
				await page.screenshot({ path: join(out, `${safeName(story.id)}.png`), animations: 'disabled', caret: 'hide' })
				if (errors.length > 0) failures.push({ id: story.id, errors })
			} catch (error) {
				failures.push({ id: story.id, errors: [...errors, String(error)] })
			} finally {
				await page.close()
			}
		}
	} finally {
		await browser.close()
	}
	await writeFile(
		join(out, 'capture.json'),
		`${JSON.stringify({ stories: stories.map(s => s.id), failures }, null, 2)}\n`,
	)
	console.log(`captured ${stories.length - failures.length}/${stories.length} stories into ${out}`)
	for (const failure of failures) console.log(`  failed ${failure.id}: ${failure.errors.join(' | ')}`)
}

async function compare(before, after, report) {
	const names = new Set([...(await readdir(before)), ...(await readdir(after))].filter(name => name.endsWith('.png')))
	const browser = await chromium.launch()
	const results = []
	try {
		const page = await browser.newPage()
		for (const name of [...names].sort()) {
			const read = async dir => {
				try {
					return (await readFile(join(dir, name))).toString('base64')
				} catch {
					return null
				}
			}
			const [a, b] = await Promise.all([read(before), read(after)])
			if (a === null || b === null) {
				results.push({ name, status: a === null ? 'added' : 'removed' })
				continue
			}
			if (a === b) {
				results.push({ name, status: 'identical', pixels: 0 })
				continue
			}
			const diff = await page.evaluate(
				async ([left, right]) => {
					const load = async data => {
						const image = new Image()
						image.src = `data:image/png;base64,${data}`
						await image.decode()
						const canvas = new OffscreenCanvas(image.width, image.height)
						const context = canvas.getContext('2d')
						context.drawImage(image, 0, 0)
						return {
							width: image.width,
							height: image.height,
							data: context.getImageData(0, 0, image.width, image.height).data,
						}
					}
					const x = await load(left)
					const y = await load(right)
					if (x.width !== y.width || x.height !== y.height) return { size: [x.width, x.height, y.width, y.height] }
					let pixels = 0
					for (let index = 0; index < x.data.length; index += 4) {
						if (
							x.data[index] !== y.data[index] ||
							x.data[index + 1] !== y.data[index + 1] ||
							x.data[index + 2] !== y.data[index + 2] ||
							x.data[index + 3] !== y.data[index + 3]
						)
							pixels += 1
					}
					return { pixels }
				},
				[a, b],
			)
			results.push({ name, status: diff.size !== undefined || diff.pixels > 0 ? 'different' : 'identical', ...diff })
		}
	} finally {
		await browser.close()
	}
	const different = results.filter(result => result.status !== 'identical')
	if (report !== undefined) await writeFile(report, `${JSON.stringify(results, null, 2)}\n`)
	console.log(`${results.length - different.length}/${results.length} identical`)
	for (const result of different)
		console.log(`  ${result.status} ${result.name}${result.pixels ? ` (${result.pixels} px)` : ''}`)
	process.exitCode = different.length === 0 ? 0 : 1
}

const [mode, ...argv] = process.argv.slice(2)
const { filters, excludes, report, rest } = options(argv)
if (mode === 'capture' && rest.length === 2) await capture(rest[0], resolve(rest[1]), filters, excludes)
else if (mode === 'compare' && rest.length === 2) await compare(resolve(rest[0]), resolve(rest[1]), report)
else {
	console.error(
		'usage: visual-diff.mjs capture <storybook-url> <out-dir> [--filter s] [--exclude s] | compare <a> <b> [--report f]',
	)
	process.exitCode = 2
}
