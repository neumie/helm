import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import jsQR from 'jsqr'
import { chromium } from 'playwright'
import remotePairingModule from '../app/src/remote-pairing.ts'
import { startRemoteRuntime } from '../src/remote/runtime.ts'

const { RemotePairingController } = remotePairingModule
const ORIGIN = 'https://fixture.remote.test'

function browserJson(
	port: number,
	path: string,
	body: unknown | undefined,
	cookie?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
	return new Promise((resolvePromise, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body)
		const req = request(
			{
				host: '127.0.0.1',
				port,
				path,
				method: data ? 'POST' : 'GET',
				headers: {
					Host: 'fixture.remote.test',
					Origin: ORIGIN,
					...(data
						? { 'Content-Type': 'application/json', 'X-Helm-Remote': '1', 'Content-Length': Buffer.byteLength(data) }
						: {}),
					...(cookie ? { Cookie: cookie } : {}),
				},
			},
			response => {
				response.resume()
				response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers }))
			},
		)
		req.on('error', reject)
		req.end(data)
	})
}

async function decodeNativeQr(dataUrl: string): Promise<string> {
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage()
		const pixels = await page.evaluate(async data => {
			const image = new Image()
			image.src = data
			await image.decode()
			const canvas = document.createElement('canvas')
			canvas.width = canvas.height = 160
			const context = canvas.getContext('2d')
			if (!context) throw new Error('Canvas unavailable')
			context.drawImage(image, 0, 0, 160, 160)
			return [...context.getImageData(0, 0, 160, 160).data]
		}, dataUrl)
		const decoded = jsQR(new Uint8ClampedArray(pixels), 160, 160)
		assert.ok(decoded, 'The actual native QR must decode at its rendered160px size')
		const url = new URL(decoded.data)
		assert.equal(url.origin, ORIGIN)
		assert.equal(url.pathname, '/')
		assert.match(url.hash, /^#pair=[\w-]{43}$/)
		return url.hash.slice('#pair='.length)
	} finally {
		await browser.close()
	}
}

test('native controller pairs and revokes through a disposable private runtime socket', async t => {
	const root = await realpath(await mkdtemp('/tmp/hr-np-'))
	let runtime: Awaited<ReturnType<typeof startRemoteRuntime>> | undefined
	try {
		const assetsDirectory = join(root, 'assets')
		await mkdir(assetsDirectory)
		await Promise.all(
			['index.html', 'remote.js', 'remote.css'].map(name => writeFile(join(assetsDirectory, name), 'fixture')),
		)
		runtime = await startRemoteRuntime({ root, origin: ORIGIN, assetsDirectory, piSessionRoots: [], port: 0 })
		assert.ok(runtime.port)
		const controller = new RemotePairingController({ root })
		const before = await controller.status(() => true)
		assert.equal(before.availability, 'available')
		if (before.availability === 'available') assert.deepEqual(before.devices, [])

		const created = await controller.pair(
			'Fixture phone',
			() => true,
			async () => true,
		)
		assert.equal(created.kind, 'created')
		if (created.kind !== 'created') return
		assert.match(created.presentation.qrDataUrl, /^data:image\/gif;base64,/)
		const claim =
			process.env.HELM_REMOTE_PROOF_BROWSER === '1'
				? { qrCapability: await decodeNativeQr(created.presentation.qrDataUrl) }
				: { code: created.presentation.code }
		if ('qrCapability' in claim)
			t.diagnostic(
				'Decoded the actual native QR from Chromium160px raster with jsQR; redemption uses Node HTTP, not TLS or a phone.',
			)
		const redeemed = await browserJson(runtime.port as number, '/v1/pair', claim)
		assert.equal(redeemed.status, 201)
		assert.equal(
			(await browserJson(runtime.port as number, '/v1/pair', { code: created.presentation.code })).status,
			403,
		)
		const setCookie = redeemed.headers['set-cookie']
		const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie
		assert.match(cookie ?? '', /^__Host-helm-remote=[\w-]{43}/)

		const listed = await controller.status(() => true)
		assert.equal(listed.availability, 'available')
		if (listed.availability !== 'available') return
		assert.equal(listed.devices.length, 1)
		const id = listed.devices[0]?.id
		assert.ok(id)
		const allowed = await browserJson(runtime.port as number, '/v1/access', undefined, cookie)
		assert.equal(allowed.status, 200)
		const ledger = join(root, 'devices.json')
		const savedBefore = await readFile(ledger)
		const originalRename = fs.renameSync
		let injected = false
		fs.renameSync = (from, to) => {
			if (to === ledger) {
				injected = true
				throw Object.assign(new Error('Injected fixture revocation save failure'), { code: 'EIO' })
			}
			return originalRename(from, to)
		}
		syncBuiltinESMExports()
		try {
			await assert.rejects(
				controller.revoke(
					id,
					() => true,
					async () => true,
				),
				/could not revoke/,
			)
			assert.equal(injected, true)
			assert.deepEqual(await readFile(ledger), savedBefore)
			const fenced = await controller.status(() => true)
			assert.equal(fenced.availability, 'available')
			if (fenced.availability === 'available') assert.equal(fenced.devices[0]?.state, 'revoked')
			assert.equal((await browserJson(runtime.port as number, '/v1/access', undefined, cookie)).status, 401)
		} finally {
			fs.renameSync = originalRename
			syncBuiltinESMExports()
		}
		t.diagnostic(
			'Injected actual fixture ledger rename failure: disk unchanged, GET revoked from memory, retry required.',
		)
		assert.deepEqual(
			await controller.revoke(
				id,
				() => true,
				async () => true,
			),
			{ kind: 'revoked' },
		)
		const persisted = JSON.parse(await readFile(ledger, 'utf8'))
		assert.ok(persisted.devices.find((device: { id: string }) => device.id === id)?.revokedAt)
		const denied = await browserJson(runtime.port as number, '/v1/access', undefined, cookie)
		assert.equal(denied.status, 401)
	} finally {
		await runtime?.stop()
		await rm(root, { recursive: true, force: true })
	}
})
