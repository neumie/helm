import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { prepareRemotePiInstall } from '../src/remote/installer.js'
import type { RemoteSnapshot } from '../src/remote/protocol.js'
import { type RemoteRuntime, controlRequest, startRemoteRuntime } from '../src/remote/runtime.js'

const piCli = process.env.HELM_REMOTE_PROOF_PI

function assertSelectedPi() {
	assert.ok(piCli, 'set HELM_REMOTE_PROOF_PI to an installed Pi dist/cli.js')
	const version = JSON.parse(readFileSync(join(dirname(dirname(piCli)), 'package.json'), 'utf8')).version
	assert.equal(version, '0.85.1', 'proof requires Pi 0.85.1')
	return piCli
}

function httpJson(
	port: number,
	path: string,
	headers: Record<string, string>,
	body?: unknown,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; value: Record<string, unknown> }> {
	return new Promise((resolvePromise, reject) => {
		const encoded = body === undefined ? undefined : JSON.stringify(body)
		const req = request(
			{
				host: '127.0.0.1',
				port,
				path,
				method: encoded ? 'POST' : 'GET',
				headers: { ...headers, ...(encoded ? { 'Content-Length': Buffer.byteLength(encoded) } : {}) },
			},
			response => {
				const chunks: Buffer[] = []
				response.on('data', (chunk: Buffer) => chunks.push(chunk))
				response.on('error', reject)
				response.on('end', () => {
					try {
						resolvePromise({
							status: response.statusCode ?? 0,
							headers: response.headers,
							value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
						})
					} catch (error) {
						reject(error)
					}
				})
			},
		)
		req.on('error', reject)
		req.end(encoded)
	})
}

test(
	'actual Pi scoped manual authority survives host loss and successful tree without personal migration',
	{ skip: !piCli, timeout: 120_000 },
	async t => {
		const selectedPi = assertSelectedPi()
		const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
		const root = realpathSync(mkdtempSync('/tmp/hr-a-'))
		chmodSync(root, 0o700)
		const assets = join(root, 'assets')
		await import('node:fs/promises').then(({ mkdir }) => mkdir(assets, { mode: 0o700 }))
		for (const name of ['index.html', 'remote.js', 'remote.css']) writeFileSync(join(assets, name), '', { mode: 0o600 })
		for (const slot of ['a', 'b']) {
			const agent = join(root, slot, 'agent')
			mkdirSync(agent, { recursive: true, mode: 0o700 })
			const settingsPath = join(agent, 'settings.json')
			writeFileSync(settingsPath, JSON.stringify({ packages: ['npm:@juicesharp/rpiv-ask-user-question@2.9.0'] }), {
				mode: 0o600,
			})
			prepareRemotePiInstall({
				settingsPath,
				bridgeSource: join(repo, 'packages/helm-remote-bridge'),
				questionForkSource: join(repo, 'packages/helm-ask-user-question'),
			}).apply()
			const selected = JSON.parse(readFileSync(settingsPath, 'utf8'))
			assert.equal(selected.extensions, undefined, 'no direct extension bypass for installed resources')
			assert.equal(selected.packages.length, 2)
		}
		let runtime: RemoteRuntime = await startRemoteRuntime({
			root: join(root, '.helm', 'remote'),
			origin: 'https://remote.example',
			assetsDirectory: assets,
			port: 0,
			piSessionRoots: [],
		})
		const discovery = join(runtime.root, 'bridge-registration.json')
		const hiddenDiscovery = join(runtime.root, 'registration-held.json')
		renameSync(discovery, hiddenDiscovery)
		let globalRegistrations = 0
		const requests = channel('http.server.request.start')
		const observed = (value: unknown) => {
			if ((value as { request: { url: string } }).request.url === '/bridge-register') globalRegistrations++
		}
		requests.subscribe(observed)
		t.after(() => requests.unsubscribe(observed))
		const driver = spawn(
			'python3',
			[join(repo, 'tests/fixtures/remote-terminal-driver.py'), root, process.execPath, selectedPi, repo, 'scoped'],
			{
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		)
		let errors = ''
		let pending = ''
		const waiters = new Map<string, (value: Record<string, unknown>) => void>()
		driver.stderr.on('data', chunk => {
			errors = `${errors}${chunk}`.slice(-8192)
		})
		driver.stdout.setEncoding('utf8')
		driver.stdout.on('data', (chunk: string) => {
			pending += chunk
			for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
				const value = JSON.parse(pending.slice(0, end)) as Record<string, unknown>
				pending = pending.slice(end + 1)
				if (typeof value.id === 'string') {
					waiters.get(value.id)?.(value)
					waiters.delete(value.id)
				}
			}
		})
		const exited = new Promise<void>(resolvePromise => driver.once('exit', () => resolvePromise()))
		const drive = (slot: 'a' | 'b', action: 'input' | 'screen', text?: string) =>
			new Promise<Record<string, unknown>>((resolvePromise, reject) => {
				const id = randomUUID()
				const timer = setTimeout(() => reject(new Error('terminal driver timeout')), 4000)
				waiters.set(id, value => {
					clearTimeout(timer)
					resolvePromise(value)
				})
				driver.stdin.write(`${JSON.stringify({ id, slot, action, text })}\n`)
			})
		const ready = (slot: 'a' | 'b') => {
			const path = join(root, `ready-${slot}.json`)
			return existsSync(path)
				? (JSON.parse(readFileSync(path, 'utf8')) as {
						pid: number
						reason: string
						sessionId: string
						tools: Array<{ name: string; sourceInfo: { path: string; origin: string; scope: string } }>
						commands: Array<{ name: string; sourceInfo: { path: string; origin: string; scope: string } }>
					})
				: null
		}
		async function until<T>(read: () => Promise<T> | T, check: (value: T) => boolean, description: string): Promise<T> {
			const deadline = Date.now() + 20_000
			while (Date.now() < deadline) {
				if (driver.exitCode !== null) throw new Error(`Pi driver exited: ${errors}`)
				const value = await read()
				if (check(value)) return value
				await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
			}
			const evidence = await Promise.all(
				(['a', 'b'] as const).map(async slot => {
					const path = join(root, `tree-${slot}.json`)
					return {
						slot,
						navigation: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null,
						screen: String((await drive(slot, 'screen')).screen).slice(-12000),
					}
				}),
			)
			throw new Error(`timed out waiting for ${description}; ${errors}; ${JSON.stringify(evidence)}`)
		}
		t.after(async () => {
			await runtime?.stop()
			driver.stdin.end()
			await exited
			rmSync(root, { recursive: true, force: true })
		})

		const original = await Promise.all(
			['a', 'b'].map(slot => until(() => ready(slot as 'a' | 'b'), Boolean, `Pi ${slot} startup`)),
		)
		for (const owner of original) {
			assert.ok(owner)
			assert.equal(owner.tools.length, 1)
			assert.equal(owner.tools[0]?.sourceInfo.path, join(repo, 'packages/helm-ask-user-question/index.ts'))
			assert.equal(owner.tools[0]?.sourceInfo.origin, 'package')
			assert.equal(
				owner.commands.find(command => command.name === 'helm-remote-connect')?.sourceInfo.path,
				join(repo, 'packages/helm-remote-bridge/index.ts'),
			)
			assert.equal(owner.commands.find(command => command.name === 'helm-remote-connect')?.sourceInfo.origin, 'package')
		}
		const scopeId = randomUUID()
		const operator = readFileSync(join(runtime.root, 'operator-token'), 'utf8').trim()
		const control = (path: string, body?: unknown) =>
			controlRequest(join(runtime.root, 'control.sock'), operator, path, body)
		const headers = (credential: string) => ({
			Host: 'remote.example',
			Origin: 'https://remote.example',
			'Content-Type': 'application/json',
			'X-Helm-Remote': '1',
			Cookie: `__Host-helm-remote=${credential}`,
		})
		const port = () => {
			const value = runtime.port
			assert.ok(value)
			return value
		}
		const pair = async (scoped: boolean) => {
			const grant = {
				personalCurrentAndFuture: !scoped,
				scopeIds: scoped ? [scopeId] : [],
				operations: { read: true, prompt: true, interrupt: true, answer: true },
			}
			const challenge = (await control('/pair', { label: scoped ? 'Scoped' : 'Personal only', grant })) as {
				code: string
			}
			const response = await httpJson(port(), '/v1/pair', headers(''), { code: challenge.code })
			assert.equal(response.status, 201)
			const cookies = response.headers['set-cookie']
			const credential = /__Host-helm-remote=([\w-]{43})/.exec(
				Array.isArray(cookies) ? cookies[0] : (cookies ?? ''),
			)?.[1]
			assert.ok(credential)
			return credential
		}
		const personal = await pair(false)
		const scoped = await pair(true)
		const api = (credential: string, path: string, body?: unknown) => httpJson(port(), path, headers(credential), body)
		const enroll = async (slot: 'a' | 'b') => {
			const enrollment = (await control('/enrollments', { scopeId, generation: 7 })) as { enrollmentFile: string }
			await drive(slot, 'input', `\x15/helm-remote-connect ${enrollment.enrollmentFile}\r`)
		}
		for (const slot of ['a', 'b'] as const) await enroll(slot)
		const initial = await until(
			() => api(scoped, '/v1/sessions'),
			response => (response.value.sessions as unknown[]).length === 2,
			'two scoped manual owners',
		)
		const owners = initial.value.sessions as Array<{ target: RemoteSnapshot['target'] }>
		assert.ok(owners.every(owner => owner.target.scopeId === scopeId && owner.target.generation === 7))
		assert.equal(globalRegistrations, 0)
		renameSync(hiddenDiscovery, discovery)
		const denied = async () => {
			assert.deepEqual((await api(personal, '/v1/sessions')).value.sessions, [])
			for (const owner of owners) {
				assert.equal((await api(personal, `/v1/sessions/${owner.target.sessionId}`)).status, 404)
				const response = await api(personal, '/v1/commands', {
					protocol: 1,
					hostEpoch: (await api(personal, '/v1/access')).value.hostEpoch,
					commandId: randomUUID(),
					target: owner.target,
					operation: { kind: 'prompt', text: 'must not dispatch', delivery: 'steer' },
				})
				assert.ok([403, 409].includes(response.status))
			}
		}
		await denied()
		await runtime.stop()
		runtime = await startRemoteRuntime({
			root: join(root, '.helm', 'remote'),
			origin: 'https://remote.example',
			assetsDirectory: assets,
			port: 0,
			piSessionRoots: [],
		})
		// Beyond the longest 4s retry interval: old grants have really been rejected.
		await new Promise(resolvePromise => setTimeout(resolvePromise, 5500))
		await denied()
		assert.equal(
			globalRegistrations,
			0,
			'neither auto-disabled nor explicitly manual auto-enabled context may attempt global registration',
		)
		// Fresh explicit manual authority is required and stays scoped after recovery.
		for (const slot of ['a', 'b'] as const) await enroll(slot)
		await until(
			() => api(scoped, '/v1/sessions'),
			response => (response.value.sessions as unknown[]).length === 2,
			'fresh manual enrollment after restart',
		)
		for (const slot of ['a', 'b'] as const) {
			await drive(slot, 'input', `local-navigation-${slot}\r`)
			await until(
				async () => (await api(scoped, `/v1/sessions/${ready(slot)?.sessionId}`)).value.snapshot as RemoteSnapshot,
				value =>
					value.activity === 'idle' &&
					value.messages.some(
						message =>
							message.role === 'assistant' &&
							message.text === `Proof reply: ${JSON.stringify([{ type: 'text', text: `local-navigation-${slot}` }])}`,
					),
				`exact local ${slot} reply settled before public tree`,
			)
			await drive(slot, 'input', '/remote-proof-tree\r')
			await until(
				() => {
					const path = join(root, `tree-${slot}.json`)
					return existsSync(path)
						? (JSON.parse(readFileSync(path, 'utf8')) as { changed: boolean; status: string; cancelled: boolean })
						: null
				},
				value => value?.status === 'returned' && value.changed && !value.cancelled,
				'actual successful public tree navigation',
			)
		}
		await new Promise(resolvePromise => setTimeout(resolvePromise, 5500))
		await denied()
		assert.equal(globalRegistrations, 0, 'successful public tree navigation must not migrate manual scope')
		for (const slot of ['a', 'b'] as const) {
			await enroll(slot)
			await until(
				async () => (await api(scoped, `/v1/sessions/${ready(slot)?.sessionId}`)).value.snapshot as RemoteSnapshot,
				value => value?.target.scopeId === scopeId && value.target.generation === 7 && value.activity === 'idle',
				'fresh scoped manual enrollment after tree',
			)
			rmSync(join(root, `ready-${slot}.json`))
			await drive(slot, 'input', '/reload\r')
			await until(
				() => ready(slot),
				value => value?.reason === 'reload',
				'real replacement extension reload readiness',
			)
		}
		await new Promise(resolvePromise => setTimeout(resolvePromise, 5500))
		await denied()
		assert.equal(globalRegistrations, 0, 'reload must retain process-local refusal, not personal auto authority')
		for (const slot of ['a', 'b'] as const) await enroll(slot)
		await until(
			() => api(scoped, '/v1/sessions'),
			response => {
				const sessions = response.value.sessions as Array<{ target: RemoteSnapshot['target']; connected: boolean }>
				return (
					sessions.length === 2 &&
					sessions.every(value => value.connected && value.target.scopeId === scopeId && value.target.generation === 7)
				)
			},
			'explicit manual enrollment remains available after reload',
		)
		await denied()
		for (const [index, prior] of original.entries()) {
			assert.equal(ready(index === 0 ? 'a' : 'b')?.pid, prior?.pid)
			assert.equal(ready(index === 0 ? 'a' : 'b')?.sessionId, prior?.sessionId)
		}
		t.diagnostic(
			'Actual installer-selected ordinary Pi owners: slot A auto disabled; slot B auto enabled but manually scoped. Authenticated runtime restart/tree observations never broaden personal-only read/prompt authority. Offline provider only is mocked.',
		)
	},
)
