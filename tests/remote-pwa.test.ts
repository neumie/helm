import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { createRemoteAssets, startRemoteDevelopment } from '../src/remote/development.js'

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
	assert.deepEqual([manifest.background_color, manifest.theme_color], ['#0d0d0d', '#0d0d0d'])
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
