import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import themePresetsModule from '../app/src/theme-presets.ts'
import { createRemoteAssets, startRemoteDevelopment } from '../src/remote/development.js'

const { THEME_PRESETS } = themePresetsModule as typeof import('../app/src/theme-presets.ts')
const HELM_TOKENS = THEME_PRESETS.helm?.tokens ?? {}
/** The UI family as the generated app :root defines it (tokens.css). */
const FONT_UI = /--font-ui: ([^;]+);/.exec(readFileSync(resolve('app/src/renderer/tokens.css'), 'utf8'))?.[1]

const assetsPath = resolve('app/remote-dist')
test('PWA assets have exact routes, restrictive headers and credential-free launch metadata', async t => {
	const fixture = mkdtempSync(join(tmpdir(), 'hr-pwa-assets-'))
	t.after(() => rmSync(fixture, { recursive: true, force: true }))
	for (const name of ['manifest.webmanifest', 'remote-sw.js', 'icon-180.png', 'icon-192.png', 'icon-512.png'])
		copyFileSync(resolve('app/assets/remote', name), join(fixture, name))
	writeFileSync(join(fixture, 'index.html'), '<link rel="manifest" href="/manifest.webmanifest">')
	writeFileSync(join(fixture, 'remote.js'), '')
	writeFileSync(join(fixture, 'remote.css'), '')
	const assets = createRemoteAssets(fixture)
	const response = assets(new Request('https://helm.example/manifest.webmanifest'))
	assert.ok(response)
	assert.equal(response.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
	assert.equal(response.headers.get('cache-control'), 'no-store')
	const manifest = (await response.json()) as {
		id: string
		start_url: string
		scope: string
		display: string
		background_color: string
		theme_color: string
		icons: Array<{ src: string; sizes: string }>
	}
	assert.deepEqual([manifest.id, manifest.start_url, manifest.scope, manifest.display], ['/', '/', '/', 'standalone'])
	assert.deepEqual([manifest.background_color, manifest.theme_color], [HELM_TOKENS['--pane'], HELM_TOKENS['--pane']])
	assert.deepEqual(
		manifest.icons.map(icon => icon.sizes),
		['192x192', '512x512'],
	)
	for (const size of [180, 192, 512]) {
		const icon = assets(new Request(`https://helm.example/icon-${size}.png`))
		assert.ok(icon)
		assert.equal(icon.headers.get('content-type'), 'image/png')
		const png = Buffer.from(await icon.arrayBuffer())
		assert.equal(png.readUInt32BE(16), size)
		assert.equal(png.readUInt32BE(20), size)
	}
	assert.equal(assets(new Request('https://helm.example/remote-sw.js', { method: 'POST' })), null)
	assert.equal(assets(new Request('https://helm.example/operator-token')), null)
	assert.equal(assets(new Request('https://helm.example/anything.js')), null)
	const worker = assets(new Request('https://helm.example/remote-sw.js'))
	assert.ok(worker)
	assert.equal(worker.headers.get('cache-control'), 'no-store')
	const html = assets(new Request('https://helm.example/'))
	assert.ok(html)
	assert.match(
		html.headers.get('content-security-policy') ?? '',
		/worker-src 'self'; manifest-src 'self'; img-src 'self' blob:/,
	)
})

test('Remote launch colours and the offline page copy the app palette (§9 ruling 96)', () => {
	const pane = HELM_TOKENS['--pane']
	assert.ok(pane)
	const manifest = JSON.parse(readFileSync(resolve('app/assets/remote/manifest.webmanifest'), 'utf8')) as {
		background_color: string
		theme_color: string
	}
	assert.deepEqual([manifest.background_color, manifest.theme_color], [pane, pane])
	const shell = readFileSync(resolve('app/scripts/build-remote.mjs'), 'utf8')
	assert.match(shell, new RegExp(`<meta name="theme-color" content="${pane}">`))
	// The offline page is served without tokens.css, so it carries a copy of the Helm values it uses.
	const worker = readFileSync(resolve('app/assets/remote/remote-sw.js'), 'utf8')
	const offline = /:root\{([^}]*)\}/.exec(worker)?.[1] ?? ''
	const declared = Object.fromEntries(
		offline.split(';').map(declaration => declaration.split(':').map(part => part.trim()) as [string, string]),
	)
	assert.deepEqual(Object.keys(declared).sort(), ['--accent', '--font-ui', '--pane', '--text-0', '--text-1'])
	for (const [token, value] of Object.entries(declared))
		assert.equal(value, token === '--font-ui' ? FONT_UI : HELM_TOKENS[token], token)
	// Its type and spacing are Remote's own steps (§9 ruling 117): reading 16, heading 21 at 600, padding 32 24.
	assert.match(
		worker,
		/body\{margin:0;padding:32px 24px;[^}]*font:16px\/1\.6 var\(--font-ui\);letter-spacing:-0\.01em\}/,
	)
	assert.match(worker, /h1\{font-size:21px;font-weight:600;line-height:1\.3\}/)
	// Remote re-binds none of the app surface tokens (only its own bubble grey).
	const css = readFileSync(resolve('app/src/renderer/remote/remote.css'), 'utf8')
	for (const token of [
		'--pane',
		'--chrome',
		'--well',
		'--hairline',
		'--hairline-strong',
		'--fill-subtle',
		'--fill-raised',
	])
		assert.doesNotMatch(css, new RegExp(`(^|[^-\\w])${token}\\s*:`, 'm'), token)
})

test(
	'built PWA installs its network-only worker and never substitutes offline HTML for API commands',
	{ skip: process.env.HELM_REMOTE_PROOF_BROWSER !== '1' },
	async () => {
		const runtime = await startRemoteDevelopment(assetsPath)
		const browser = await chromium.launch({ headless: true }).catch(async error => {
			await runtime.stop()
			throw error
		})
		try {
			const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
			const page = await context.newPage()
			const errors: string[] = []
			page.on('pageerror', error => errors.push(error.message))
			await page.goto(runtime.origin)
			await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 10000 })
			const cdp = await context.newCDPSession(page)
			const metadata = await cdp.send('Page.getAppManifest')
			assert.equal(metadata.errors.length, 0)
			assert.ok(metadata.url.endsWith('/manifest.webmanifest'))
			const installability = await cdp.send('Page.getInstallabilityErrors')
			assert.deepEqual(installability.installabilityErrors, [])
			assert.deepEqual(await page.evaluate(() => caches.keys()), [])
			assert.equal(await page.evaluate(async () => (await fetch('/v1/access')).status), 401)
			await context.setOffline(true)
			assert.equal(
				await page.evaluate(async () => {
					try {
						await fetch('/v1/commands', { method: 'POST', body: '{}' })
						return false
					} catch {
						return true
					}
				}),
				true,
			)
			const offline = await page.goto(runtime.origin)
			assert.equal(offline?.status(), 503)
			await page.getByRole('heading', { name: 'Helm Remote unavailable', exact: true }).waitFor()
			await context.setOffline(false)
			await page.getByRole('link', { name: 'Try again' }).click()
			await page.getByRole('heading', { name: 'Helm Remote · development preview', exact: true }).waitFor()
			assert.deepEqual(await page.evaluate(() => caches.keys()), [])
			assert.deepEqual(errors, [])
			// The generated shell is independent of runtime credentials and enrollment paths.
			assert.ok(!readFileSync(resolve(assetsPath, 'manifest.webmanifest'), 'utf8').includes(runtime.root))
		} finally {
			await browser.close()
			await runtime.stop()
		}
	},
)
