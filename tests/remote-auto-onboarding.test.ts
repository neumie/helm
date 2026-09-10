import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { prepareRemotePiInstall } from '../src/remote/installer.js'
import type { RemoteCommand, RemoteSnapshot } from '../src/remote/protocol.js'
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

/** The disposable two-TUI B1 proof uses ordinary extension discovery only: no enrollment env or commands. */
test(
	'automatic registration starts after ordinary Pi TUIs, recovers a restarted host, routes independently and answers a real questionnaire',
	{ skip: !process.env.HELM_REMOTE_PROOF_PI, timeout: 120_000 },
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
		const driver = spawn(
			'python3',
			[join(repo, 'tests/fixtures/remote-terminal-driver.py'), root, process.execPath, selectedPi, repo, 'automatic'],
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
			throw new Error(`timed out waiting for ${description}; ${errors}`)
		}
		let runtime: RemoteRuntime | undefined
		t.after(async () => {
			await runtime?.stop()
			driver.stdin.end()
			await exited
			rmSync(root, { recursive: true, force: true })
		})

		const original = await Promise.all(
			['a', 'b'].map(slot => until(() => ready(slot as 'a' | 'b'), Boolean, `Pi ${slot} startup`)),
		)
		for (const slot of ['a', 'b'] as const) {
			await drive(slot, 'input', `local-before-host-${slot}\r`)
			await until(
				() => drive(slot, 'screen'),
				value => String(value.screen).includes('Proof reply:'),
				`local ${slot} response`,
			)
		}
		// The disposable Pi global settings selected bridge + questionnaire before startup;
		// no enrollment env or manual command is present. Host startup must trigger discovery.
		for (const owner of original) {
			assert.ok(owner)
			assert.equal(owner.tools.length, 1, 'Pi exposes exactly one actual questionnaire registration')
			assert.equal(owner.tools[0]?.name, 'ask_user_question')
			assert.equal(owner.tools[0]?.sourceInfo.path, join(repo, 'packages/helm-ask-user-question/index.ts'))
			assert.equal(owner.tools[0]?.sourceInfo.origin, 'package')
			assert.equal(owner.tools[0]?.sourceInfo.scope, 'user')
			const bridge = owner.commands.filter(command => command.name === 'helm-remote-connect')
			assert.equal(bridge.length, 1)
			assert.equal(bridge[0]?.sourceInfo.path, join(repo, 'packages/helm-remote-bridge/index.ts'))
			assert.equal(bridge[0]?.sourceInfo.origin, 'package')
		}

		await drive('a', 'input', 'single question before host\r')
		await until(
			() => drive('a', 'screen'),
			value => String(value.screen).includes('Pick one?'),
			'question opened before host',
		)

		runtime = await startRemoteRuntime({
			root: join(root, '.helm', 'remote'),
			origin: 'https://remote.example',
			assetsDirectory: assets,
			port: 0,
			piSessionRoots: [],
		})
		assert.equal(runtime.reused, false)
		const operator = readFileSync(join(runtime.root, 'operator-token'), 'utf8').trim()
		const pairing = (await controlRequest(join(runtime.root, 'control.sock'), operator, '/pair', {
			label: 'Proof browser',
		})) as { code: string }
		const port = runtime.port
		assert.ok(port)
		const headers = (credential: string) => ({
			Host: 'remote.example',
			Origin: 'https://remote.example',
			'Content-Type': 'application/json',
			'X-Helm-Remote': '1',
			Cookie: `__Host-helm-remote=${credential}`,
		})
		const pairResponse = await httpJson(
			port,
			'/v1/pair',
			{
				Host: 'remote.example',
				Origin: 'https://remote.example',
				'Content-Type': 'application/json',
				'X-Helm-Remote': '1',
			},
			{ code: pairing.code },
		)
		assert.equal(pairResponse.status, 201)
		const cookie = pairResponse.headers['set-cookie']
		const credential = /__Host-helm-remote=([\w-]{43})/.exec(
			Array.isArray(cookie) ? (cookie[0] ?? '') : (cookie ?? ''),
		)?.[1]
		assert.ok(credential)
		const api = async (path: string, body?: unknown) => {
			const response = await httpJson(port, path, headers(credential), body)
			assert.ok([200, 201, 202].includes(response.status), `${path} returned ${response.status}`)
			return response.value
		}
		const sessions = await until(
			() => api('/v1/sessions'),
			value => Array.isArray(value.sessions) && value.sessions.length === 2,
			'automatic two-TUI registration',
		)
		const summaries = sessions.sessions as Array<{ target: RemoteSnapshot['target'] }>
		const detail = async (sessionId: string) => (await api(`/v1/sessions/${sessionId}`)).snapshot as RemoteSnapshot
		const send = async (target: RemoteSnapshot['target'], text: string) => {
			const command: RemoteCommand = {
				protocol: 1,
				hostEpoch: (await api('/v1/access')).hostEpoch as string,
				commandId: randomUUID(),
				target,
				operation: { kind: 'prompt', text, delivery: 'steer' },
			}
			await api('/v1/commands', command)
			return command
		}
		const first = await detail(original[0]?.sessionId ?? '')
		const second = await detail(original[1]?.sessionId ?? '')
		assert.ok(first.question, 'question opened before discovery must survive first enrollment')
		assert.equal(first.activity, 'waiting')
		assert.deepEqual(first.capabilities, { prompt: false, interrupt: true, answer: true })
		await api('/v1/commands', {
			protocol: 1,
			hostEpoch: (await api('/v1/access')).hostEpoch,
			commandId: randomUUID(),
			target: first.target,
			operation: { kind: 'answer', requestId: first.question.requestId, answers: [{ option: 0 }] },
		})
		await until(
			() => detail(first.target.sessionId),
			value => value.question === null && value.activity === 'idle',
			'pre-host question completed',
		)
		assert.match(
			(await detail(first.target.sessionId)).messages.filter(message => message.role === 'toolResult').at(-1)?.text ??
				'',
			/First/,
		)
		await send(first.target, 'automatic-A')
		await send(second.target, 'automatic-B')
		await until(
			() => detail(first.target.sessionId),
			value => value.messages.some(message => message.text.includes('automatic-A')),
			'A routing',
		)
		await until(
			() => detail(second.target.sessionId),
			value => value.messages.some(message => message.text.includes('automatic-B')),
			'B routing',
		)
		assert.ok(!(await detail(second.target.sessionId)).messages.some(message => message.text.includes('automatic-A')))

		await send(first.target, 'question')
		const question = await until(
			() => detail(first.target.sessionId),
			value => value.question !== null,
			'real fork questionnaire',
		)
		assert.ok(question.question)
		const answer: RemoteCommand = {
			protocol: 1,
			hostEpoch: (await api('/v1/access')).hostEpoch as string,
			commandId: randomUUID(),
			target: question.target,
			operation: {
				kind: 'answer',
				requestId: question.question.requestId,
				answers: [{ option: 0 }, { options: [0, 1] }, { text: 'Auto proof answer' }],
			},
		}
		await api('/v1/commands', answer)
		await until(
			() => detail(first.target.sessionId),
			value => value.messages.some(message => message.text.includes('Auto proof answer')),
			'actual questionnaire result',
		)

		// Local TUI wins a separate real questionnaire; a late browser answer cannot complete it again.
		await until(
			() => detail(first.target.sessionId),
			value => value.activity === 'idle',
			'idle after browser answer',
		)
		await send(first.target, 'single question')
		const localQuestion = await until(
			() => detail(first.target.sessionId),
			value => value.question !== null,
			'local single question',
		)
		assert.ok(localQuestion.question)
		await drive('a', 'input', '\r')
		await until(
			() => detail(first.target.sessionId),
			value => value.question === null && value.activity === 'idle',
			'local first-winner answer',
		)
		const losing = await httpJson(port, '/v1/commands', headers(credential), {
			...answer,
			commandId: randomUUID(),
			operation: { kind: 'answer', requestId: localQuestion.question.requestId, answers: [{ option: 1 }] },
		})
		assert.equal(losing.status, 409)
		const localResult = (await detail(first.target.sessionId)).messages
			.filter(message => message.role === 'toolResult')
			.at(-1)
		assert.ok(localResult)
		assert.match(localResult.text, /First/)

		// This uses Pi 0.85.1's public navigateTree command context. It emits the
		// documented before-tree/tree lifecycle pair without replacing the TUI.
		const beforeTree = await detail(first.target.sessionId)
		await drive('a', 'input', '/remote-proof-tree\r')
		const afterTree = await until(
			() => detail(first.target.sessionId),
			value => value.target.incarnation !== beforeTree.target.incarnation,
			'normal tree lifecycle rebind in the same host',
		)
		assert.equal(afterTree.target.sessionId, beforeTree.target.sessionId)
		assert.equal(afterTree.target.generation, 1)
		assert.equal((await detail(second.target.sessionId)).target.incarnation, second.target.incarnation)

		await send(afterTree.target, 'single question across restart')
		const restartQuestion = await until(
			() => detail(first.target.sessionId),
			value => value.question !== null,
			'question before restart',
		)
		assert.ok(restartQuestion.question)
		const oldEpoch = (await api('/v1/access')).hostEpoch as string
		await runtime.stop()
		runtime = await startRemoteRuntime({
			root: join(root, '.helm', 'remote'),
			origin: 'https://remote.example',
			assetsDirectory: assets,
			port: 0,
			piSessionRoots: [],
		})
		const newPort = runtime.port
		assert.ok(newPort)
		// The persisted browser credential is intentionally host-independent; the old grants are not.
		const restartedApi = async (path: string) => {
			const response = await httpJson(newPort, path, headers(credential))
			assert.equal(response.status, 200)
			return response.value
		}
		const rebound = await until(
			() => restartedApi('/v1/sessions'),
			value => Array.isArray(value.sessions) && value.sessions.length === 2,
			'fresh registration after host restart',
		)
		assert.notEqual((await restartedApi('/v1/access')).hostEpoch, oldEpoch)
		const reboundBySession = new Map(
			(rebound.sessions as Array<{ target: RemoteSnapshot['target'] }>).map(entry => [entry.target.sessionId, entry]),
		)
		assert.deepEqual([...reboundBySession.keys()].sort(), original.map(entry => entry?.sessionId).sort())
		for (const [index, prior] of original.entries()) {
			const entry = reboundBySession.get(prior?.sessionId ?? '')
			assert.ok(entry)
			const old = summaries.find(summary => summary.target.sessionId === prior?.sessionId)
			assert.ok(old)
			assert.notEqual(entry.target.incarnation, old.target.incarnation)
			assert.equal(ready(index === 0 ? 'a' : 'b')?.pid, prior?.pid)
		}
		const recovered = (await restartedApi(`/v1/sessions/${first.target.sessionId}`)).snapshot as RemoteSnapshot
		assert.equal(recovered.question?.requestId, restartQuestion.question.requestId)
		assert.equal(recovered.activity, 'waiting')
		assert.deepEqual(recovered.capabilities, { prompt: false, interrupt: true, answer: true })
		const recoveredAnswer = {
			protocol: 1,
			hostEpoch: (await restartedApi('/v1/access')).hostEpoch,
			commandId: randomUUID(),
			target: recovered.target,
			operation: { kind: 'answer', requestId: restartQuestion.question.requestId, answers: [{ option: 1 }] },
		}
		assert.equal((await httpJson(newPort, '/v1/commands', headers(credential), recoveredAnswer)).status, 202)
		const completed = await until(
			async () => (await restartedApi(`/v1/sessions/${first.target.sessionId}`)).snapshot as RemoteSnapshot,
			value => value.question === null && value.activity === 'idle',
			'recovered real question completion',
		)
		assert.match(completed.messages.filter(message => message.role === 'toolResult').at(-1)?.text ?? '', /Second/)
		assert.equal(
			(await httpJson(newPort, '/v1/commands', headers(credential), { ...recoveredAnswer, commandId: randomUUID() }))
				.status,
			409,
		)
		t.diagnostic(
			'Two isolated ordinary Pi 0.85.1 TUIs automatically discovered a registration-only runtime after startup, received fresh grants after restart, routed separately, and completed the real questionnaire fork. Native navigation cancellation/overlap remains a separately fail-closed compatibility boundary.',
		)
	},
)
