import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import jsQR from 'jsqr'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAccess, type RemoteDeviceGrant } from '../src/remote/access.js'
import { PiSessionCatalog } from '../src/remote/catalog.js'
import { RemoteHost } from '../src/remote/host.js'
import { prepareRemotePiInstall } from '../src/remote/installer.js'
import { REMOTE_PROTOCOL, type RemoteCommand, type RemoteSnapshot } from '../src/remote/protocol.js'
import {
	configureRemoteRuntime,
	controlRequest,
	readRemoteRuntimeSetup,
	renderPairingQr,
	startRemoteRuntime,
} from '../src/remote/runtime.js'

const grant: RemoteDeviceGrant = {
	personalCurrentAndFuture: true,
	scopeIds: [],
	operations: { read: true, prompt: true, interrupt: true, answer: true },
}
function privateRoot(prefix: string) {
	const root = mkdtempSync(join(tmpdir(), prefix))
	chmodSync(root, 0o700)
	return realpathSync(root)
}
function pair(access: RemoteAccess, label = 'Phone', deviceGrant = grant) {
	const challenge = access.createPairing(label, deviceGrant)
	const paired = access.redeem({ code: challenge.code })
	assert.ok(paired)
	return paired
}
function browserHeaders(credential: string) {
	return {
		Host: 'remote.example',
		Origin: 'https://remote.example',
		'Content-Type': 'application/json',
		'X-Helm-Remote': '1',
		Cookie: `__Host-helm-remote=${credential}`,
	}
}

// Count and serialized-byte capacity are both enforced before persistence, so a restart remains readable.
test('device ledger refuses count and serialized-byte capacity without poisoning reload', () => {
	const root = privateRoot('helm-remote-capacity-')
	try {
		const countPath = join(root, 'count.json')
		const count = new RemoteAccess(countPath)
		for (let index = 0; index < 128; index++) pair(count, `Device ${index}`)
		assert.equal(count.redeem({ code: count.createPairing('Overflow', grant).code }), null)
		assert.equal(new RemoteAccess(countPath).list().length, 128)

		const bytePath = join(root, 'bytes.json')
		const byteGrant: RemoteDeviceGrant = { ...grant, scopeIds: Array.from({ length: 64 }, () => randomUUID()) }
		const bytes = new RemoteAccess(bytePath)
		let paired = 0
		while (true) {
			const challenge = bytes.createPairing(`Large ${paired}`, byteGrant)
			if (!bytes.redeem({ code: challenge.code })) break
			paired++
		}
		assert.ok(paired > 0 && paired < 128)
		assert.equal(new RemoteAccess(bytePath).list().length, paired)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('persistence failure fences revocation in memory, rejects queued work, and permits idempotent retry', async () => {
	const root = privateRoot('helm-remote-revoke-retry-')
	try {
		let fail = false
		const access = new RemoteAccess(join(root, 'devices.json'), Date.now, {
			persist(path, content) {
				if (fail) throw new Error('disk full')
				writeFileSync(path, content, { mode: 0o600, flag: 'wx' })
			},
		})
		const paired = pair(access)
		const localCapability = createScopedCapability()
		const enrollment = {
			id: randomUUID(),
			capabilityHash: hashScopedCapability(localCapability),
			scopeId: null,
			generation: 1,
		}
		const host = new RemoteHost({ origin: 'https://remote.example', access, enrollments: [enrollment] })
		const snapshot: RemoteSnapshot = {
			target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: null, generation: 1 },
			revision: 1,
			label: 'Pi',
			workspace: 'workspace',
			model: null,
			activity: 'idle',
			capabilities: { prompt: true, interrupt: true, answer: false },
			question: null,
			messages: [],
			historyTruncated: false,
		}
		const exchange = () =>
			host.local.request('/exchange', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${localCapability}`,
					'X-Helm-Enrollment': enrollment.id,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ protocol: REMOTE_PROTOCOL, enrollmentId: enrollment.id, snapshot, receipts: [] }),
			})
		assert.equal((await exchange()).status, 200)
		const command: RemoteCommand = {
			protocol: REMOTE_PROTOCOL,
			hostEpoch: host.epoch,
			commandId: randomUUID(),
			target: snapshot.target,
			operation: { kind: 'prompt', text: 'Do not deliver', delivery: 'steer' },
		}
		assert.equal(
			(
				await host.browser.request('/v1/commands', {
					method: 'POST',
					headers: browserHeaders(paired.credential),
					body: JSON.stringify(command),
				})
			).status,
			202,
		)
		fail = true
		assert.equal(access.revoke(paired.principal.deviceId), false)
		assert.equal(access.authenticate(paired.credential), null)
		assert.deepEqual((await (await exchange()).json()).commands, [])
		fail = false
		assert.equal(access.revoke(paired.principal.deviceId), true)
		assert.equal(new RemoteAccess(join(root, 'devices.json')).authenticate(paired.credential), null)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('private device documents reject FIFOs and invalid owner-private identities without blocking', () => {
	const root = privateRoot('helm-remote-private-file-')
	try {
		const fifo = join(root, 'devices.json')
		execFileSync('mkfifo', ['-m', '600', fifo])
		assert.throws(() => new RemoteAccess(fifo), /Invalid Remote device ledger/)
		rmSync(fifo)
		writeFileSync(fifo, JSON.stringify({ version: 1, devices: [] }), { mode: 0o644 })
		assert.throws(() => new RemoteAccess(fifo), /Invalid Remote device ledger/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('three authenticated devices retain polling budget despite unauthenticated spam', async () => {
	const root = privateRoot('helm-remote-fairness-')
	try {
		const access = new RemoteAccess(join(root, 'devices.json'))
		const devices = [pair(access, 'One'), pair(access, 'Two'), pair(access, 'Three')]
		const host = new RemoteHost({ origin: 'https://remote.example', access })
		// Exceed even the shared authenticated ceiling; rejected requests must
		// remain confined to the separate unauthenticated budget.
		for (let index = 0; index < 5000; index++)
			assert.notEqual((await host.browser.request('/v1/sessions', { headers: { Host: 'remote.example' } })).status, 200)
		for (const device of devices)
			for (let index = 0; index < 80; index++)
				assert.equal(
					(await host.browser.request('/v1/sessions', { headers: browserHeaders(device.credential) })).status,
					200,
				)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('catalog incrementally scans beyond old directory/file cutoffs, labels real session_info rows, filters live overlays and bounds unsafe attempts', async () => {
	const root = privateRoot('helm-remote-catalog-')
	let catalog: PiSessionCatalog | undefined
	try {
		const sessions = join(root, 'sessions')
		const project = join(sessions, '--project--')
		const sessionIds: string[] = []
		for (let projectIndex = 0; projectIndex < 140; projectIndex++) {
			const directory = projectIndex === 0 ? project : join(sessions, `--project-${projectIndex}--`)
			mkdirSync(directory, { recursive: true, mode: 0o700 })
			for (let fileIndex = 0; fileIndex < 4; fileIndex++) {
				const id = randomUUID()
				sessionIds.push(id)
				writeFileSync(
					join(directory, `${fileIndex}.jsonl`),
					`${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/private/path' })}\n${JSON.stringify({ type: 'session_info', name: `Project ${projectIndex} conversation ${fileIndex}` })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'message payload is never retained' } })}\n`,
				)
			}
		}
		// Invalid candidates consume the same file-attempt budget and cannot make a slice unbounded.
		for (let index = 0; index < 600; index++) writeFileSync(join(project, `bad-${index}.jsonl`), 'not json\n')
		writeFileSync(join(project, 'huge.jsonl'), 'x'.repeat(9000))
		symlinkSync(join(project, '0.jsonl'), join(project, 'linked.jsonl'))
		catalog = new PiSessionCatalog([sessions])
		const currentCatalog = catalog
		const catalogEpoch = randomUUID()
		const request = { viewId: 'onboarding-catalog', principalId: 'onboarding', sequence: 1, overlayStamp: 'onboarding' }
		const settle = async (cursor?: string, query = '', overlay = new Set<string>()) => {
			request.sequence++
			request.overlayStamp = JSON.stringify([...overlay].sort())
			for (let tick = 0; tick < 20_000; tick++) {
				const value = currentCatalog.page(catalogEpoch, cursor, query, overlay, request)
				if (value.state !== 'pending') return value
				await new Promise(resolve => setTimeout(resolve, 0))
			}
			throw new Error('Catalog did not settle')
		}
		const first = await settle()
		assert.equal(first.state, 'ready')
		assert.equal(first.rows.length, 50)
		assert.ok(first.nextCursor)
		assert.equal(first.rows[0]?.label.startsWith('Project '), true)
		assert.ok(
			first.rows.every(
				row => row.readOnly && row.liveness === 'unknown' && !JSON.stringify(row).includes('/private/path'),
			),
		)
		if (!first.nextCursor) throw new Error('Expected catalog continuation')
		const second = await settle(first.nextCursor)
		assert.equal(second.state, 'ready')
		assert.equal(second.rows.length, 50)
		assert.equal((await settle('obsolete')).state, 'invalidated')
		assert.equal((await settle(undefined, 'project 139')).rows.length, 4)
		assert.equal((await settle(undefined, '', new Set([sessionIds[0] ?? '']))).rows.length, 50)
		// A fresh cycle discovers additions rather than freezing at a startup snapshot.
		const added = randomUUID()
		writeFileSync(
			join(project, 'refresh.jsonl'),
			`${JSON.stringify({ type: 'session', id: added, timestamp: '2026-02-01T00:00:00.000Z' })}\n${JSON.stringify({ type: 'session_info', name: 'Refresh proof' })}\n`,
		)
		assert.equal((await settle(undefined, 'refresh proof')).rows.length, 1)
		await catalog.stop()
	} finally {
		await catalog?.stop()
		rmSync(root, { recursive: true, force: true })
	}
})

test('terminal pairing QR is independently decodable as the same one-time fragment URL', () => {
	const url = `https://remote.example/#pair=${createScopedCapability()}`
	const lines = renderPairingQr(url).split('\n')
	assert.ok(lines.length > 20)
	const modules = lines.map(line =>
		Array.from({ length: line.length / 2 }, (_, index) => line.slice(index * 2, index * 2 + 2) === '██'),
	)
	const scale = 8
	const width = (modules[0]?.length ?? 0) * scale
	const pixels = new Uint8ClampedArray(width * width * 4)
	for (let y = 0; y < modules.length; y++)
		for (let x = 0; x < (modules[y]?.length ?? 0); x++)
			for (let dy = 0; dy < scale; dy++)
				for (let dx = 0; dx < scale; dx++) {
					const offset = ((y * scale + dy) * width + x * scale + dx) * 4
					const value = modules[y]?.[x] ? 0 : 255
					pixels.set([value, value, value, 255], offset)
				}
	assert.equal(jsQR(pixels, width, width)?.data, url)
})

test('installer coordinates with concurrent Pi writers and refuses stale apply', async () => {
	const root = privateRoot('helm-remote-installer-')
	try {
		const target = join(root, 'settings-target.json')
		const pointer = join(root, 'settings.json')
		const original = {
			packages: [
				'unrelated',
				'npm:@juicesharp/rpiv-ask-user-question@1.2.3',
				{ source: 'npm:@juicesharp/rpiv-ask-user-question@^1.0', extensions: ['./x.ts'] },
			],
			extensions: ['./keep.ts', '/old/rpiv-ask-user-question/index.ts'],
			other: { retained: true },
		}
		writeFileSync(target, JSON.stringify(original), { mode: 0o600 })
		symlinkSync(target, pointer)
		const prepared = prepareRemotePiInstall({
			settingsPath: pointer,
			bridgeSource: '/repo/packages/helm-remote-bridge',
			questionForkSource: '/repo/packages/helm-ask-user-question',
		})
		const child = await lockWriter(pointer, JSON.stringify({ writer: true }))
		assert.throws(() => prepared.apply(), /already being held/)
		child.send('release')
		await once(child, 'exit')
		assert.throws(() => prepared.apply(), /changed while Remote installation was prepared/)
		assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { writer: true })
		const second = prepareRemotePiInstall({
			settingsPath: pointer,
			bridgeSource: '/repo/packages/helm-remote-bridge',
			questionForkSource: '/repo/packages/helm-ask-user-question',
		})
		second.apply()
		const installed = readFileSync(pointer, 'utf8')
		assert.equal(installed.includes('rpiv-ask-user-question'), false)
		assert.equal(installed.includes('/repo/packages/helm-remote-bridge'), true)
		assert.equal(readlinkSync(pointer), target)
		second.rollback()
		assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { writer: true })
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('successful installer normalizes real selections, preserves colliding resources/options and byte-exact rollback', () => {
	const root = privateRoot('hr-installer-selection-')
	try {
		const target = join(root, 'canonical.json')
		const pointer = join(root, 'settings.json')
		const retained = {
			source: 'npm:@juicesharp/rpiv-ask-user-question-audit@1.0',
			extensions: ['./audit.ts'],
			skills: [],
			autoload: false,
		}
		const extensions = [
			'./keep.ts',
			'/tools/rpiv-ask-user-question-audit/index.ts',
			'/tools/helm-ask-user-question-report/index.ts',
			'/tools/rpiv-ask-user-question/audit.ts',
		]
		const original = `${JSON.stringify(
			{
				packages: [
					'npm:@juicesharp/rpiv-ask-user-question@2.9.0',
					{ source: 'npm:@juicesharp/rpiv-ask-user-question@^2', extensions: ['./index.ts'] },
					{ source: '/old/rpiv-ask-user-question/./index.ts' },
					{ source: '/repo/packages/helm-remote-bridge/.' },
					retained,
				],
				extensions: [...extensions, '/old/rpiv-ask-user-question/index.ts', '/old/helm-ask-user-question/./index.ts'],
				other: { retained: true },
			},
			null,
			4,
		)}\n`
		writeFileSync(target, original, { mode: 0o600 })
		symlinkSync(target, pointer)
		const plan = {
			settingsPath: pointer,
			bridgeSource: '/repo/packages/helm-remote-bridge',
			questionForkSource: '/repo/packages/helm-ask-user-question',
		}
		const prepared = prepareRemotePiInstall(plan)
		assert.equal(readFileSync(prepared.backupPath, 'utf8'), original)
		prepared.apply()
		assert.equal(readlinkSync(pointer), target)
		assert.equal(prepared.canonicalTarget, target)
		assert.deepEqual(JSON.parse(readFileSync(pointer, 'utf8')), {
			packages: [
				retained,
				{ source: plan.questionForkSource, extensions: ['index.ts'] },
				{ source: plan.bridgeSource, extensions: ['index.ts'] },
			],
			extensions,
			other: { retained: true },
		})
		prepared.rollback()
		assert.equal(readFileSync(pointer, 'utf8'), original)
		assert.equal(readFileSync(prepared.backupPath, 'utf8'), original)
		assert.equal(readlinkSync(pointer), target)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('one-time owner-private runtime setup persists the approved HTTPS origin and Pi roots without a deployment action', () => {
	const root = privateRoot('helm-remote-setup-')
	try {
		const sessionRoot = join(root, 'pi-sessions')
		const configured = configureRemoteRuntime({ root, origin: 'https://remote.example', piSessionRoots: [sessionRoot] })
		assert.deepEqual(configured.piSessionRoots, [resolve(sessionRoot)])
		assert.deepEqual(readRemoteRuntimeSetup(root), {
			origin: 'https://remote.example',
			piSessionRoots: [resolve(sessionRoot)],
		})
		assert.equal(statSync(join(root, 'runtime-setup.json')).mode & 0o777, 0o600)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('persistent runtime attests reuse configuration and clears owned locks after bad assets or ledger failures', async () => {
	const root = privateRoot('helm-remote-runtime-')
	const assets = privateRoot('helm-remote-assets-')
	try {
		for (const [name, content] of [
			['index.html', '<!doctype html>'],
			['remote.js', ''],
			['remote.css', ''],
		] as const)
			writeFileSync(join(assets, name), content)
		await assert.rejects(
			startRemoteRuntime({
				root,
				origin: 'https://remote.example',
				assetsDirectory: join(assets, 'missing'),
				port: 0,
				piSessionRoots: [],
			}),
		)
		assert.equal(readableLock(root), false)
		writeFileSync(join(root, 'operator-token'), 'unsafe', { mode: 0o600 })
		await assert.rejects(
			startRemoteRuntime({
				root,
				origin: 'https://remote.example',
				assetsDirectory: assets,
				port: 0,
				piSessionRoots: [],
			}),
			/token is invalid/,
		)
		assert.equal(readableLock(root), false)
		rmSync(join(root, 'operator-token'))
		writeFileSync(join(root, 'devices.json'), '{bad', { mode: 0o600 })
		await assert.rejects(
			startRemoteRuntime({
				root,
				origin: 'https://remote.example',
				assetsDirectory: assets,
				port: 0,
				piSessionRoots: [],
			}),
		)
		assert.equal(readableLock(root), false)
		rmSync(join(root, 'devices.json'))
		const runtime = await startRemoteRuntime({
			root,
			origin: 'https://remote.example',
			assetsDirectory: assets,
			port: 0,
			piSessionRoots: [root],
		})
		try {
			const token = readFileSync(join(root, 'operator-token'), 'utf8').trim()
			assert.equal(
				((await controlRequest(join(root, 'control.sock'), token, '/status')) as { protocol: number }).protocol,
				1,
			)
			await assert.rejects(
				startRemoteRuntime({
					root,
					origin: 'https://other.example',
					assetsDirectory: assets,
					port: 0,
					piSessionRoots: [root],
				}),
				/compatible/,
			)
			await assert.rejects(
				startRemoteRuntime({
					root,
					origin: 'https://remote.example',
					assetsDirectory: assets,
					port: 0,
					piSessionRoots: [],
				}),
				/compatible/,
			)
		} finally {
			await runtime.stop()
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
		rmSync(assets, { recursive: true, force: true })
	}
})

test('two disposable runtime processes cannot replace the first operator token', async () => {
	const root = privateRoot('helm-remote-runtime-race-')
	const assets = privateRoot('helm-remote-race-assets-')
	const children: ReturnType<typeof runtimeChild>[] = []
	try {
		for (const name of ['index.html', 'remote.js', 'remote.css']) writeFileSync(join(assets, name), '')
		children.push(runtimeChild(root, assets), runtimeChild(root, assets))
		const results = await Promise.all(children.map(child => childOutcome(child)))
		assert.ok(results.some(result => result?.type === 'ready'))
		const token = readFileSync(join(root, 'operator-token'), 'utf8').trim()
		assert.match(token, /^[\w-]{43}$/)
		const socket = join(root, 'control.sock')
		const status = (await controlRequest(socket, token, '/status')) as {
			protocol: number
			hostEpoch: string
			listeningPort: number
		}
		assert.equal(status.protocol, 1)
		assert.ok(status.hostEpoch)
		assert.equal(
			results.find(result => result?.type === 'ready' && result.reused === false)?.port,
			status.listeningPort,
		)
		const rejectedStatus = (token?: string) =>
			new Promise<number | undefined>((resolvePromise, reject) => {
				const req = request(
					{ socketPath: socket, path: '/status', headers: token ? { Authorization: `Bearer ${token}` } : {} },
					response => {
						response.resume()
						response.on('end', () => resolvePromise(response.statusCode))
					},
				)
				req.on('error', reject)
				req.end()
			})
		assert.equal(await rejectedStatus(createScopedCapability()), 401)
		assert.equal(await rejectedStatus(), 401)
		const pairing = (await controlRequest(socket, token, '/pair', { label: 'Winning child auth proof' })) as {
			code: string
		}
		assert.match(pairing.code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/)
	} finally {
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
		await Promise.all(children.map(waitForExit))
		rmSync(root, { recursive: true, force: true })
		rmSync(assets, { recursive: true, force: true })
	}
})

function readableLock(root: string) {
	try {
		readFileSync(join(root, 'runtime.lock'))
		return true
	} catch {
		return false
	}
}
function once(child: ReturnType<typeof fork>, event: 'message' | 'exit'): Promise<unknown[]> {
	return new Promise(resolvePromise => child.once(event, (...args: unknown[]) => resolvePromise(args)))
}
function runtimeChild(root: string, assets: string) {
	const script = join(root, `runtime-race-${randomUUID()}.mjs`)
	writeFileSync(
		script,
		`import { startRemoteRuntime } from ${JSON.stringify(new URL('../dist/remote/runtime.js', import.meta.url).href)}; const runtime = await startRemoteRuntime({root: process.env.ROOT, origin: 'https://remote.example', assetsDirectory: process.env.ASSETS, port: 0, piSessionRoots: []}); process.send?.({type:'ready', reused:runtime.reused, port:runtime.port}); process.on('SIGTERM', () => void runtime.stop().then(() => process.exit(0)));`,
	)
	return fork(script, [], {
		cwd: resolve('.'),
		env: { ...process.env, ROOT: root, ASSETS: assets },
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
	})
}
function waitForExit(child: ReturnType<typeof fork>): Promise<unknown[]> {
	return child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve([])
}
function childOutcome(
	child: ReturnType<typeof fork>,
): Promise<{ type?: string; reused?: boolean; port?: number } | null> {
	return new Promise(resolvePromise => {
		child.once('message', message =>
			resolvePromise(
				message && typeof message === 'object' ? (message as { type?: string; reused?: boolean; port?: number }) : null,
			),
		)
		child.once('exit', () => resolvePromise(null))
	})
}
function lockWriter(pointer: string, content: string): Promise<ReturnType<typeof fork>> {
	const script = join(dirname(pointer), `lock-writer-${randomUUID()}.cjs`)
	writeFileSync(
		script,
		`const lock=require(${JSON.stringify(resolve('node_modules/proper-lockfile'))}); const fs=require('node:fs'); const release=lock.lockSync(process.argv[2], {realpath:false}); fs.writeFileSync(process.argv[3], process.argv[4]); process.send('locked'); process.on('message', () => { release(); process.exit(0) });`,
	)
	const child = fork(script, [pointer, resolve(readlinkSync(pointer)), content], {
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
	})
	return once(child, 'message').then(() => child)
}
