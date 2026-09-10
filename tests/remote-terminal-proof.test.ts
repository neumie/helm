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
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import type * as Playwright from '../app/node_modules/@playwright/test/index.js'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { createRemoteAssets } from '../src/remote/development.js'
import { RemoteHost } from '../src/remote/host.js'
import type { RemoteCommand, RemoteSnapshot } from '../src/remote/protocol.js'

/** Real isolated terminal processes; never launches Electron or touches the operator's Pi home. */
test(
	'two pre-existing Pi TUIs: hot-load, authenticated routing, fork questions and reconnect',
	{ skip: !process.env.HELM_REMOTE_PROOF_PI, timeout: 120_000 },
	async t => {
		const piCli = process.env.HELM_REMOTE_PROOF_PI
		assert.ok(piCli)
		assert.equal(
			JSON.parse(readFileSync(join(dirname(dirname(piCli)), 'package.json'), 'utf8')).version,
			'0.85.1',
			'proof requires Pi 0.85.1',
		)
		const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
		const root = realpathSync(mkdtempSync('/tmp/hr-m-'))
		chmodSync(root, 0o700)
		const driver = spawn(
			'python3',
			[join(repo, 'tests/fixtures/remote-terminal-driver.py'), root, process.execPath, piCli, repo],
			{ stdio: ['pipe', 'pipe', 'pipe'] },
		)
		let driverErrors = ''
		let pending = ''
		const waiters = new Map<string, (data: Record<string, unknown>) => void>()
		driver.stderr.on('data', data => {
			driverErrors = (driverErrors + data).slice(-8192)
		})
		driver.stdout.setEncoding('utf8')
		driver.stdout.on('data', (chunk: string) => {
			pending += chunk
			let end = pending.indexOf('\n')
			while (end >= 0) {
				const value = JSON.parse(pending.slice(0, end))
				pending = pending.slice(end + 1)
				waiters.get(value.id)?.(value)
				waiters.delete(value.id)
				end = pending.indexOf('\n')
			}
		})
		const closed = new Promise<number | null>(resolve => driver.once('exit', resolve))
		const drive = (slot: string, action: string, text?: string) =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const id = randomUUID()
				const timer = setTimeout(() => {
					waiters.delete(id)
					reject(new Error('Terminal driver timed out'))
				}, 3000)
				waiters.set(id, value => {
					clearTimeout(timer)
					resolve(value)
				})
				driver.stdin.write(`${JSON.stringify({ id, slot, action, text })}\n`)
			})
		// biome-ignore lint/style/useConst: the listener can receive requests before async startup assigns the host.
		let host: RemoteHost | undefined
		const assets = process.env.HELM_REMOTE_PROOF_BROWSER ? createRemoteAssets(join(repo, 'app/remote-dist')) : undefined
		const web = createServer(
			getRequestListener(
				(request, env) =>
					assets?.(request) ?? (host ? host.browser.fetch(request, env) : new Response(null, { status: 503 })),
			),
		)
		const local = createServer(
			getRequestListener((request, env) =>
				host ? host.local.fetch(request, env) : new Response(null, { status: 503 }),
			),
		)
		for (const server of [web, local]) {
			server.on('upgrade', (_request, socket) => {
				socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
			})
			server.requestTimeout = 3000
			server.headersTimeout = 3000
			server.maxConnections = 16
		}
		t.after(async () => {
			host?.revoke()
			web.closeAllConnections()
			local.closeAllConnections()
			await Promise.all([web, local].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
			driver.stdin.end()
			await closed
			if (driverErrors) t.diagnostic(driverErrors)
			rmSync(root, { recursive: true, force: true })
		})
		async function until<T>(read: () => Promise<T> | T, check: (value: T) => boolean, description: string): Promise<T> {
			const deadline = Date.now() + 20_000
			while (Date.now() < deadline) {
				if (driver.exitCode !== null) throw new Error(`Terminal exited: ${driverErrors}`)
				const value = await read()
				if (check(value)) return value
				await new Promise(resolve => setTimeout(resolve, 200))
			}
			// Only deterministic disposable terminal output, never an operator session.
			for (const slot of ['a', 'b']) t.diagnostic(String((await drive(slot, 'screen')).screen).slice(-6000))
			throw new Error(`Timed out: ${description}`)
		}
		const readiness = (slot: string) =>
			existsSync(join(root, `ready-${slot}.json`))
				? JSON.parse(readFileSync(join(root, `ready-${slot}.json`), 'utf8'))
				: null
		const original: { pid: number; sessionId: string; reason: string }[] = []
		for (const slot of ['a', 'b']) {
			original.push(
				await until(
					() => readiness(slot),
					value => !!value,
					`Pi ${slot} startup`,
				),
			)
			await drive(slot, 'input', `local-before-host-${slot}\r`)
			await until(
				() => drive(slot, 'screen'),
				value => String(value.screen).includes('Proof reply:'),
				`local ${slot} response`,
			)
		}
		// Only now install the bridge into the disposable auto-discovery directories.
		// The manual driver started with questionnaire-only settings, so this is a real
		// hot load rather than fixture reuse.
		for (let index = 0; index < 2; index++) {
			const slot = ['a', 'b'][index]
			assert.equal(existsSync(join(root, slot, 'agent/extensions/remote.ts')), false)
			assert.equal(existsSync(join(root, `bridge-selected-${slot}.json`)), false)
			writeFileSync(
				join(root, slot, 'agent/extensions/remote.ts'),
				`export { default } from ${JSON.stringify(join(repo, 'packages/helm-remote-bridge/index.ts'))}\n`,
			)
			await drive(slot, 'input', '/reload\r')
			const reloaded = await until(
				() => readiness(slot),
				value => value?.reason === 'reload',
				`hot load ${slot}`,
			)
			assert.equal(reloaded.pid, original[index].pid)
			assert.equal(reloaded.sessionId, original[index].sessionId)
			await until(
				() => drive(slot, 'screen'),
				value => String(value.screen).includes('Reloaded keybindings'),
				`TUI ${slot} reload ready`,
			)
		}
		await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve))
		const address = web.address()
		assert.ok(address && typeof address !== 'string')
		const origin = `http://127.0.0.1:${address.port}`
		const token = createScopedCapability()
		const enrollTokens = [createScopedCapability(), createScopedCapability(), createScopedCapability()]
		const enrollments = enrollTokens.map(capability => ({
			id: randomUUID(),
			capabilityHash: hashScopedCapability(capability),
			scopeId: randomUUID(),
			generation: 1,
		}))
		enrollments[2].scopeId = enrollments[0].scopeId
		host = new RemoteHost({ origin, browserCapabilityHash: hashScopedCapability(token), enrollments })
		const hostEpoch = host.epoch
		const socketPath = join(root, 'host.sock')
		await new Promise<void>(resolve => local.listen(socketPath, resolve))
		chmodSync(socketPath, 0o600)
		for (let index = 0; index < 2; index++) {
			const path = join(root, `enroll-${index}.json`)
			writeFileSync(
				path,
				JSON.stringify({
					protocol: 1,
					enrollmentId: enrollments[index].id,
					capability: enrollTokens[index],
					scopeId: enrollments[index].scopeId,
					generation: 1,
					socketPath,
				}),
				{ mode: 0o600 },
			)
			await drive(['a', 'b'][index], 'input', `/helm-remote-connect ${path}\r`)
		}
		const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' }
		async function api(path: string) {
			const response = await fetch(`${origin}${path}`, { headers })
			assert.equal(response.status, 200)
			return response.json()
		}
		await until(
			() => api('/v1/sessions'),
			value => value.sessions.length === 2,
			'two enrolled sessions',
		)
		const detail = async (index: number): Promise<RemoteSnapshot> =>
			(await api(`/v1/sessions/${original[index].sessionId}`)).snapshot
		for (let index = 0; index < 2; index++)
			assert.ok(
				(await detail(index)).messages.some(message => message.text.includes(`local-before-host-${['a', 'b'][index]}`)),
			)
		const command = async (index: number, operation: RemoteCommand['operation']): Promise<RemoteCommand> => ({
			protocol: 1,
			hostEpoch,
			commandId: randomUUID(),
			target: (await detail(index)).target,
			operation,
		})
		const submit = async (value: RemoteCommand) => {
			const response = await fetch(`${origin}/v1/commands`, { method: 'POST', headers, body: JSON.stringify(value) })
			assert.ok([200, 202].includes(response.status), `Command returned ${response.status}`)
			return response.json()
		}
		const a = await command(0, { kind: 'prompt', delivery: 'steer', text: 'remote-only-A' })
		await submit(a)
		await submit(a)
		await until(
			() => detail(0),
			value => value.messages.some(message => message.role === 'assistant' && message.text.includes('remote-only-A')),
			'remote prompt effect',
		)
		assert.equal(
			(await detail(0)).messages.filter(message => message.role === 'user' && message.text === 'remote-only-A').length,
			1,
		)
		assert.ok(!(await detail(1)).messages.some(message => message.text.includes('remote-only-A')))
		const b = await command(1, { kind: 'prompt', delivery: 'followUp', text: 'remote-only-B' })
		await submit(b)
		await until(
			() => detail(1),
			value => value.messages.some(message => message.role === 'assistant' && message.text.includes('remote-only-B')),
			'second session routing',
		)
		const ask = await command(0, { kind: 'prompt', delivery: 'steer', text: 'question' })
		await submit(ask)
		const awaiting = await until(
			() => detail(0),
			value => value.question !== null,
			'real fork TUI questionnaire',
		)
		assert.ok(awaiting.question)
		assert.equal(awaiting.question.questions.length, 3)
		const answer = await command(0, {
			kind: 'answer',
			requestId: awaiting.question.requestId,
			answers: [{ option: 0 }, { options: [0, 1] }, { text: 'Phone custom answer' }],
		})
		await submit(answer)
		await submit(answer)
		await until(
			() => submit(answer),
			value => value.status === 'answered',
			'question answer acknowledgement',
		)
		const answered = await until(
			() => detail(0),
			value =>
				value.messages.some(message => message.role === 'toolResult' && message.text.includes('Phone custom answer')),
			'actual question tool result',
		)
		const result = answered.messages.find(
			message => message.role === 'toolResult' && message.text.includes('Phone custom answer'),
		)
		assert.ok(result)
		assert.match(result.text, /First/)
		assert.match(result.text, /Red/)
		assert.match(result.text, /Blue/)
		await until(
			() => detail(0),
			value => value.activity === 'idle',
			'question completes normally',
		)
		if (process.env.HELM_REMOTE_PROOF_BROWSER) {
			const { chromium } = createRequire(join(repo, 'app/package.json'))('@playwright/test') as typeof Playwright
			const browser = await chromium.launch({ headless: true })
			try {
				const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
				const errors: string[] = []
				page.on('pageerror', error => errors.push(error.message))
				await page.goto(origin)
				await page.getByLabel('Access token').fill(token)
				await page.getByRole('button', { name: 'Connect', exact: true }).click()
				await page.getByRole('button', { name: /Proof terminal a/ }).click()
				await page.getByLabel('Message', { exact: true }).fill('Rendered browser question')
				await page.getByRole('button', { name: 'Send', exact: true }).click()
				await page.getByRole('radio', { name: /First choice/ }).check()
				await page.getByRole('checkbox', { name: /Red choice/ }).check()
				await page.getByRole('checkbox', { name: /Blue choice/ }).check()
				await page.getByLabel('Custom answer: Custom').fill('Rendered browser answer')
				await page.getByRole('button', { name: 'Submit answers' }).click()
				await page.getByText('Answer submitted.', { exact: true }).waitFor()
				await until(
					() => detail(0),
					value =>
						value.activity === 'idle' &&
						value.messages.some(
							message => message.role === 'toolResult' && message.text.includes('Rendered browser answer'),
						),
					'rendered browser → actual fork result',
				)
				assert.ok(!(await detail(1)).messages.some(message => message.text.includes('Rendered browser answer')))
				assert.deepEqual(errors, [])
				t.diagnostic(
					'Rendered Chromium at 390×844 used the real same-origin bearer transport, sent a prompt to terminal A, and answered the full fork single/multi/custom questionnaire. Terminal B stayed untouched.',
				)
			} finally {
				await browser.close()
			}
		}
		await drive('a', 'input', 'back-at-original-terminal\r')
		await until(
			() => detail(0),
			value =>
				value.messages.some(
					message => message.role === 'assistant' && message.text.includes('back-at-original-terminal'),
				),
			'return to original terminal',
		)
		// Fresh HTTP connections, unchanged targets, and an old command retried after disconnection.
		assert.equal((await submit(a)).status, 'dispatched')
		assert.equal(
			(await detail(0)).messages.filter(message => message.role === 'user' && message.text === 'remote-only-A').length,
			1,
		)
		await until(
			() => detail(0),
			value => value.activity === 'idle',
			'idle before explicit bridge reconnect',
		)
		await drive('a', 'input', '/helm-remote-disconnect\r')
		await until(
			() => api(`/v1/sessions/${original[0].sessionId}`),
			value => !value.snapshot.connected,
			'old bridge becomes stale',
		)
		const freshPath = join(root, 'fresh-enrollment.json')
		writeFileSync(
			freshPath,
			JSON.stringify({
				protocol: 1,
				enrollmentId: enrollments[2].id,
				capability: enrollTokens[2],
				scopeId: enrollments[2].scopeId,
				generation: 1,
				socketPath,
			}),
			{ mode: 0o600 },
		)
		await drive('a', 'input', `/helm-remote-connect ${freshPath}\r`)
		await until(
			() => detail(0),
			value => value.target.incarnation !== a.target.incarnation,
			'fresh owner replaces stale incarnation',
		)
		assert.equal(
			(await fetch(`${origin}/v1/commands`, { method: 'POST', headers, body: JSON.stringify(a) })).status,
			409,
		)
		for (let index = 0; index < 2; index++) assert.equal(readiness(['a', 'b'][index]).pid, original[index].pid)
		assert.equal((await fetch(`${origin}/v1/sessions`)).status, 401)
		t.diagnostic(
			'Two real Pi TUI processes retained PID/session across hot reload, host connection, routed prompts, question answers and local return. Provider was deterministic/offline. The optional HELM_REMOTE_PROOF_BROWSER gate separately verifies rendered Chromium; real phone suspension is not tested.',
		)
	},
)
