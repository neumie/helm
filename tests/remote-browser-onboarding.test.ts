import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { type RemoteRuntime, controlRequest, startRemoteRuntime } from '../src/remote/runtime.js'

const assets = resolve('app/remote-dist')

test(
	'built HTTPS pairing entry redeems QR/code once, persists Secure cookies, recovers expiry/revocation, and scrubs fragments',
	{ timeout: 60_000 },
	async t => {
		assert.ok(
			readFileSync(join(assets, 'index.html')).includes('remote.js'),
			'build the separate Remote preview before this gate',
		)
		const root = mkdtempSync(join(tmpdir(), 'hr-browser-'))
		chmodSync(root, 0o700)
		const cert = join(root, 'cert.pem')
		const key = join(root, 'key.pem')
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-keyout',
				key,
				'-out',
				cert,
				'-days',
				'1',
				'-subj',
				'/CN=127.0.0.1',
			],
			{
				stdio: 'ignore',
			},
		)
		let runtime: RemoteRuntime | undefined
		let now = Date.now()
		const tls = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (incoming, outgoing) => {
			if (!runtime?.port) return outgoing.writeHead(503).end()
			const upstream = httpRequest(
				{
					host: '127.0.0.1',
					port: runtime.port,
					path: incoming.url,
					method: incoming.method,
					headers: { ...incoming.headers, host: incoming.headers.host },
				},
				response => {
					outgoing.writeHead(response.statusCode ?? 502, response.headers)
					response.pipe(outgoing)
				},
			)
			upstream.on('error', () => outgoing.writeHead(502).end())
			incoming.pipe(upstream)
		})
		await new Promise<void>((resolvePromise, reject) => {
			tls.once('error', reject)
			tls.listen(0, '127.0.0.1', resolvePromise)
		})
		const address = tls.address()
		if (!address || typeof address === 'string') throw new Error('TLS listener has no TCP port')
		const origin = `https://127.0.0.1:${address.port}`
		try {
			runtime = await startRemoteRuntime({
				root,
				origin,
				assetsDirectory: assets,
				port: 0,
				piSessionRoots: [],
				now: () => now,
			})
			const token = readFileSync(join(root, 'operator-token'), 'utf8').trim()
			const control = (path: string, body?: unknown) => controlRequest(join(root, 'control.sock'), token, path, body)
			const issue = async () => {
				const pairing = (await control('/pair', { label: 'TLS browser' })) as {
					code: string
					qrCapability: string
				}
				return pairing
			}
			const browser = await chromium.launch({ headless: true })
			t.after(async () => browser.close())
			const context = await browser.newContext({ ignoreHTTPSErrors: true })
			await context.addInitScript(() => {
				const original = window.fetch
				const observations: Array<{ path: string; hash: string }> = []
				Object.assign(window, { remoteRequestObservations: observations })
				window.fetch = (...args) => {
					observations.push({ path: String(args[0]), hash: location.hash })
					return original(...args)
				}
			})
			const page = await context.newPage()
			const first = await issue()
			await page.goto(`${origin}/#pair=${encodeURIComponent(first.qrCapability)}`)
			let releasePair!: () => void
			let pairRequests = 0
			let pairStarted!: () => void
			const started = new Promise<void>(resolvePromise => {
				pairStarted = resolvePromise
			})
			const pairBarrier = new Promise<void>(resolvePromise => {
				releasePair = resolvePromise
			})
			await page.route('**/v1/pair', async route => {
				pairRequests++
				pairStarted()
				await pairBarrier
				await route.continue()
			})
			await page.getByRole('button', { name: 'Pair device' }).evaluate(button => {
				;(button as HTMLButtonElement).click()
				;(button as HTMLButtonElement).click()
			})
			await started
			assert.equal(pairRequests, 1)
			const pairedResponse = page.waitForResponse('**/v1/pair')
			releasePair()
			const setCookie = await (await pairedResponse).headerValue('set-cookie')
			assert.ok(setCookie)
			assert.doesNotMatch(setCookie, /(?:^|;)\s*Domain=/i)
			assert.match(setCookie, /(?:^|;)\s*Max-Age=7776000(?:;|$)/i)
			await page.getByRole('heading', { name: 'Choose a session' }).waitFor()
			assert.equal(await page.evaluate(() => location.hash), '')
			const observations = await page.evaluate(
				() =>
					(window as unknown as { remoteRequestObservations: Array<{ path: string; hash: string }> })
						.remoteRequestObservations,
			)
			assert.equal(observations[0]?.path, '/v1/access')
			assert.ok(observations.some(value => value.path === '/v1/pair'))
			assert.ok(
				observations.every(value => value.hash === ''),
				'fragment scrubbed before invoking any API fetch',
			)
			const cookies = await context.cookies(origin)
			const cookie = cookies.find(value => value.name === '__Host-helm-remote')
			assert.ok(cookie)
			assert.equal(cookie.secure, true)
			assert.equal(cookie.httpOnly, true)
			assert.equal(cookie.sameSite, 'Strict')
			assert.equal(cookie.domain, '127.0.0.1')
			assert.equal(cookie.path, '/')
			assert.ok(Math.abs(cookie.expires - Date.now() / 1000 - 90 * 86400) < 60)
			assert.equal(await page.evaluate(() => document.cookie.includes('__Host-helm-remote')), false)
			await page.unroute('**/v1/pair')
			await page.reload()
			await page.getByRole('heading', { name: 'Choose a session' }).waitFor()

			// Valid persistent auth survives startup availability errors in the SAME mounted entry.
			for (const failure of ['503', 'network', 'timeout']) {
				let attempts = 0
				let posts = 0
				await page.route('**/v1/access', async route => {
					attempts++
					if (attempts !== 1) return route.continue()
					if (failure === '503') return route.fulfill({ status: 503, body: '{}' })
					if (failure === 'network') return route.abort('failed')
					await new Promise(resolvePromise => setTimeout(resolvePromise, 6500))
					await route.abort('timedout').catch(() => {})
				})
				await page.route('**/v1/pair', route => {
					posts++
					return route.continue()
				})
				await page.reload()
				await page.getByRole('heading', { name: 'Helm Remote unavailable' }).waitFor()
				assert.equal(await page.getByRole('heading', { name: 'Pair this device' }).count(), 0)
				await page.evaluate(() => Object.assign(window, { accessRetrySentinel: true }))
				await page.getByRole('button', { name: 'Retry connection' }).click()
				await page.getByRole('heading', { name: 'Choose a session' }).waitFor()
				assert.equal(
					await page.evaluate(() => (window as unknown as { accessRetrySentinel: boolean }).accessRetrySentinel),
					true,
				)
				assert.equal(
					(await context.cookies(origin)).find(value => value.name === '__Host-helm-remote')?.value,
					cookie.value,
				)
				assert.equal(posts, 0, 'GET retry must never redeem pairing')
				await page.unroute('**/v1/access')
				await page.unroute('**/v1/pair')
			}

			// A failed QR is cleared locally, and typing a later code must choose that code instead.
			const expired = await issue()
			now += 6 * 60_000
			const expiredContext = await browser.newContext({ ignoreHTTPSErrors: true })
			const expiredPage = await expiredContext.newPage()
			await expiredPage.goto(`${origin}/#pair=${encodeURIComponent(expired.qrCapability)}`)
			await expiredPage.getByRole('button', { name: 'Pair device' }).click()
			await expiredPage.getByRole('alert').waitFor()
			const fresh = await issue()
			await expiredPage.getByLabel('One-time code').fill(fresh.code)
			await expiredPage.getByRole('button', { name: 'Pair device' }).click()
			await expiredPage.getByRole('heading', { name: 'Choose a session' }).waitFor()
			assert.equal(await expiredPage.evaluate(() => location.hash), '')
			await expiredContext.close()

			// A valid QR is superseded by deliberate code input, not consumed behind the operator's back.
			const superseded = await issue()
			const manual = await issue()
			const manualContext = await browser.newContext({ ignoreHTTPSErrors: true })
			const manualPage = await manualContext.newPage()
			await manualPage.goto(`${origin}/#pair=${superseded.qrCapability}`)
			await manualPage.getByLabel('One-time code').fill(manual.code)
			const submitted = manualPage.waitForRequest('**/v1/pair')
			await manualPage.getByRole('button', { name: 'Pair device' }).click()
			assert.deepEqual((await submitted).postDataJSON(), { code: manual.code })
			await manualPage.getByRole('heading', { name: 'Choose a session' }).waitFor()
			await manualContext.close()

			// Actual TLS redemption can commit before navigation disposes the document.
			// The route barrier delays response delivery, not the real server operation.
			// Chromium need not emit requestfailed for an intercepted request on navigation;
			// React cleanup's AbortSignal/late-success fence is separately tested in Storybook.
			// This is not server rollback: a new document cannot reuse the consumed challenge.
			const abandoned = await issue()
			const abandonedContext = await browser.newContext({ ignoreHTTPSErrors: true })
			const abandonedPage = await abandonedContext.newPage()
			let redeemed!: () => void
			const serverRedeemed = new Promise<void>(resolvePromise => {
				redeemed = resolvePromise
			})
			let releaseAbandoned!: () => void
			const abandonedBarrier = new Promise<void>(resolvePromise => {
				releaseAbandoned = resolvePromise
			})
			let settled!: () => void
			const abandonedSettled = new Promise<void>(resolvePromise => {
				settled = resolvePromise
			})
			await abandonedPage.route('**/v1/pair', async route => {
				const response = await route.fetch()
				assert.equal(response.status(), 201)
				redeemed()
				await abandonedBarrier
				try {
					await route.fulfill({ response })
				} catch {
					/* The document was intentionally disposed. */
				} finally {
					settled()
				}
			})
			await abandonedPage.goto(`${origin}/#pair=${abandoned.qrCapability}`)
			await abandonedPage.getByRole('button', { name: 'Pair device' }).click()
			await serverRedeemed
			await abandonedPage.goto('about:blank')
			releaseAbandoned()
			await abandonedSettled
			assert.equal(abandonedPage.url(), 'about:blank')
			assert.equal(await abandonedPage.locator('body').innerText(), '')
			await abandonedContext.close()
			const replayContext = await browser.newContext({ ignoreHTTPSErrors: true })
			const replayPage = await replayContext.newPage()
			await replayPage.goto(`${origin}/#pair=${abandoned.qrCapability}`)
			await replayPage.getByRole('button', { name: 'Pair device' }).click()
			await replayPage.getByRole('alert').waitFor()
			await replayContext.close()

			const devices = (await control('/devices')) as { devices: Array<{ id: string; label: string }> }
			const firstDevice = devices.devices.find(device => device.label === 'TLS browser')
			assert.ok(firstDevice)
			await page.evaluate(() => {
				Object.assign(window, { recoverySentinel: 'same-mounted-document' })
			})
			await control(`/devices/${firstDevice.id}/revoke`, {})
			await page.getByRole('heading', { name: 'Access ended' }).waitFor()
			await page.getByRole('button', { name: 'Pair again' }).click()
			await page.getByRole('heading', { name: 'Pair this device' }).waitFor()
			const replacement = await issue()
			await page.getByLabel('One-time code').fill(replacement.code)
			await page.getByRole('button', { name: 'Pair device' }).click()
			await page.getByRole('heading', { name: 'Choose a session' }).waitFor()
			assert.equal(
				await page.evaluate(() => (window as unknown as { recoverySentinel: string }).recoverySentinel),
				'same-mounted-document',
			)
			const denied = await page.evaluate(async () =>
				fetch('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(
					value => value.status,
				),
			)
			assert.equal(denied, 403)
			await context.close()
		} finally {
			if (runtime) await runtime.stop()
			tls.closeAllConnections()
			await new Promise<void>(resolvePromise => tls.close(() => resolvePromise()))
			rmSync(root, { recursive: true, force: true })
		}
	},
)
