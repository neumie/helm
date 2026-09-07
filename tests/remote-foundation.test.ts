import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
	QUESTION_ANSWER,
	QUESTION_CLOSED,
	QUESTION_OPEN,
	QUESTION_RECEIPT,
	openRemoteQuestion,
	resolveRemoteAnswers,
} from '../packages/helm-ask-user-question/remote-answers.js'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { RemoteAdmission } from '../src/remote/admission.js'
import { RemoteHost } from '../src/remote/host.js'
import { readRemoteEnrollment } from '../src/remote/private-file.js'
import { REMOTE_PROTOCOL, type RemoteCommand, type RemoteSnapshot } from '../src/remote/protocol.js'

const origin = 'http://127.0.0.1:8448'
function fixture() {
	let now = 1000
	const browserToken = createScopedCapability()
	const localToken = createScopedCapability()
	const enrollment = {
		id: randomUUID(),
		capabilityHash: hashScopedCapability(localToken),
		scopeId: randomUUID(),
		generation: 1,
	}
	const freshToken = createScopedCapability()
	const freshEnrollment = { ...enrollment, id: randomUUID(), capabilityHash: hashScopedCapability(freshToken) }
	const host = new RemoteHost({
		origin,
		browserCapabilityHash: hashScopedCapability(browserToken),
		enrollments: [enrollment, freshEnrollment],
		now: () => now,
	})
	const snapshot: RemoteSnapshot = {
		target: { sessionId: randomUUID(), incarnation: randomUUID(), scopeId: enrollment.scopeId, generation: 1 },
		revision: 1,
		label: 'Terminal A',
		workspace: 'helm',
		model: 'test/model',
		activity: 'idle',
		capabilities: { prompt: true, answer: false, interrupt: true },
		question: null,
		messages: [{ id: 'one', role: 'user', text: '<script>alert(1)</script>', thinking: '', truncated: false }],
		historyTruncated: false,
	}
	const headers = {
		Authorization: `Bearer ${browserToken}`,
		Origin: origin,
		Host: new URL(origin).host,
		'Content-Type': 'application/json',
	}
	const exchange = (value = snapshot, receipts: unknown[] = [], fresh = false) =>
		host.local.request('/exchange', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${fresh ? freshToken : localToken}`,
				'X-Helm-Enrollment': fresh ? freshEnrollment.id : enrollment.id,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				protocol: REMOTE_PROTOCOL,
				enrollmentId: fresh ? freshEnrollment.id : enrollment.id,
				snapshot: value,
				receipts,
			}),
		})
	const command = (): RemoteCommand => ({
		protocol: REMOTE_PROTOCOL,
		commandId: randomUUID(),
		hostEpoch: host.epoch,
		target: snapshot.target,
		operation: { kind: 'prompt', delivery: 'steer', text: 'Hello' },
	})
	const send = (value: unknown) =>
		host.browser.request('/v1/commands', { method: 'POST', headers, body: JSON.stringify(value) })
	return {
		host,
		snapshot,
		headers,
		exchange,
		exchangeFresh: (value: RemoteSnapshot) => exchange(value, [], true),
		command,
		send,
		advance: () => {
			now += 6000
		},
	}
}

test('Remote denies unauthenticated, wrong-Origin, wrong-Host and upgrade requests', async () => {
	for (const invalid of ['not-a-url', 'https://example.invalid/path', 'http://192.0.2.1']) {
		assert.throws(
			() =>
				new RemoteHost({
					origin: invalid,
					browserCapabilityHash: hashScopedCapability(createScopedCapability()),
					enrollments: [],
				}),
			/Invalid Remote origin|Remote requires HTTPS/,
		)
	}
	const f = fixture()
	assert.equal((await f.host.browser.request('/v1/sessions')).status, 401)
	for (const patch of [
		{ Origin: 'https://evil.test' },
		{ Origin: 'null' },
		{ Origin: '' },
		{ Host: 'evil.test' },
		{ Upgrade: 'websocket' },
		{ Authorization: 'Bearer incorrect' },
	]) {
		const response = await f.host.browser.request('/v1/sessions', { headers: { ...f.headers, ...patch } })
		assert.ok([401, 403].includes(response.status))
	}
	assert.equal((await f.host.browser.request('/api/config', { headers: f.headers })).status, 404)
	assert.equal((await f.host.local.request('/exchange', { method: 'POST' })).status, 401)
})

test('enrollment scope and incarnation fence observation and mutations independently of desktop activation', async () => {
	const f = fixture()
	assert.equal((await f.exchange()).status, 200)
	assert.equal(
		(await f.exchange({ ...f.snapshot, target: { ...f.snapshot.target, scopeId: randomUUID() } })).status,
		403,
	)
	assert.equal(
		(await f.exchange({ ...f.snapshot, target: { ...f.snapshot.target, incarnation: randomUUID() } })).status,
		409,
	)
	for (const target of [
		{ ...f.snapshot.target, scopeId: randomUUID() },
		{ ...f.snapshot.target, incarnation: randomUUID() },
		{ ...f.snapshot.target, generation: 2 },
	])
		assert.equal((await f.send({ ...f.command(), target })).status, 409)
	assert.equal((await f.send({ ...f.command(), hostEpoch: randomUUID() })).status, 409)
	assert.equal((await f.host.browser.request(`/v1/sessions/${randomUUID()}`, { headers: f.headers })).status, 404)
})

test('ambiguous HTTP retry returns receipt and never duplicates queued command', async () => {
	const f = fixture()
	await f.exchange()
	const command = f.command()
	assert.equal((await f.send(command)).status, 202)
	assert.equal((await f.send(command)).status, 200)
	assert.equal((await f.send({ ...command, operation: { kind: 'interrupt' } })).status, 409)
	assert.deepEqual((await (await f.exchange()).json()).commands, [{ command, expiresAt: 11_000 }])
	await f.exchange(f.snapshot, [{ commandId: command.commandId, status: 'dispatched' }])
	assert.deepEqual(await (await f.send(command)).json(), { commandId: command.commandId, status: 'dispatched' })
	assert.deepEqual((await (await f.exchange()).json()).commands, [])
})

test('same-origin GET omits Origin, but mutations require it; receipts are read-only and fenced', async () => {
	const f = fixture()
	await f.exchange()
	const { Origin: _origin, ...headers } = f.headers
	assert.equal((await f.host.browser.request('/v1/sessions', { headers })).status, 200)
	assert.equal(
		(await f.host.browser.request('/v1/commands', { method: 'POST', headers, body: JSON.stringify(f.command()) }))
			.status,
		403,
	)
	const command = f.command()
	await f.send(command)
	const query = new URLSearchParams({
		hostEpoch: command.hostEpoch,
		sessionId: command.target.sessionId,
		incarnation: command.target.incarnation,
	})
	const response = await f.host.browser.request(`/v1/commands/${command.commandId}?${query}`, { headers })
	assert.equal(response.status, 200)
	assert.deepEqual(await response.json(), { commandId: command.commandId, status: 'pending' })
	assert.equal(
		(
			await f.host.browser.request(`/v1/commands/${command.commandId}?${query}&unused=1`, {
				headers: { ...headers, Authorization: 'Bearer wrong' },
			})
		).status,
		401,
	)
})

test('expired undelivered commands reject; lost final receipts become unknown, not endless pending', async () => {
	for (const delivered of [false, true]) {
		const f = fixture()
		await f.exchange()
		const command = f.command()
		await f.send(command)
		if (delivered) await f.exchange()
		f.advance()
		f.advance()
		assert.equal((await (await f.send(command)).json()).status, delivered ? 'unknown' : 'rejected')
		assert.deepEqual((await (await f.exchange()).json()).commands, [])
		if (delivered) {
			await f.exchange(f.snapshot, [{ commandId: command.commandId, status: 'dispatched' }])
			assert.equal((await (await f.send(command)).json()).status, 'dispatched')
		}
	}
})

test('fresh explicit enrollment can replace only a stale same-scope owner and burns the old grant', async () => {
	const f = fixture()
	await f.exchange()
	const command = f.command()
	await f.send(command)
	await f.exchange()
	const next = { ...f.snapshot, target: { ...f.snapshot.target, incarnation: randomUUID() } }
	assert.equal((await f.exchangeFresh(next)).status, 409)
	f.advance()
	assert.equal((await f.exchangeFresh(next)).status, 200)
	assert.equal((await f.exchange()).status, 401)
	assert.equal((await f.send(command)).status, 409)
	const query = new URLSearchParams({
		hostEpoch: command.hostEpoch,
		sessionId: command.target.sessionId,
		incarnation: command.target.incarnation,
	})
	assert.equal(
		(await (await f.host.browser.request(`/v1/commands/${command.commandId}?${query}`, { headers: f.headers })).json())
			.status,
		'unknown',
	)
	const sessions = await (await f.host.browser.request('/v1/sessions', { headers: f.headers })).json()
	assert.equal(sessions.sessions.length, 1)
	assert.equal(sessions.sessions[0].target.incarnation, next.target.incarnation)
	assert.equal((await f.send({ ...f.command(), target: next.target })).status, 202)
})

test('client disconnect does not dispose session; stale observation becomes unknown and refuses new work', async () => {
	const f = fixture()
	await f.exchange()
	f.advance()
	const detail = await f.host.browser.request(`/v1/sessions/${f.snapshot.target.sessionId}`, { headers: f.headers })
	assert.equal(detail.headers.get('Cache-Control'), 'no-store')
	const data = await detail.json()
	assert.equal(data.snapshot.connected, false)
	assert.equal(data.snapshot.activity, 'unknown')
	assert.equal(data.snapshot.messages[0].text, '<script>alert(1)</script>')
	assert.equal((await f.send(f.command())).status, 409)
	assert.equal((await f.exchange()).status, 200)
	assert.equal((await f.send(f.command())).status, 202)
	f.host.revoke()
	assert.equal((await f.host.browser.request('/v1/sessions', { headers: f.headers })).status, 401)
	assert.equal((await f.exchange()).status, 403)
})

test('payload/schema/rate bounds fail closed; browser metadata omits private fields', async () => {
	const f = fixture()
	await f.exchange()
	assert.equal((await f.send({ ...f.command(), arbitraryPath: '/etc/passwd' })).status, 400)
	assert.equal((await f.send({ oversized: 'a'.repeat(25 * 1024) })).status, 413)
	assert.equal((await f.exchange({ ...f.snapshot, label: 'a'.repeat(REMOTE_BODY_LIMIT) })).status, 413)
	const response = await f.host.browser.request('/v1/sessions', { headers: f.headers })
	const summary = (await response.json()).sessions[0]
	assert.ok(!('messages' in summary))
	assert.ok(!('question' in summary))
	assert.ok(!('enrollment' in summary))
	for (let count = 0; count < 240; count++) await f.host.browser.request('/v1/sessions', { headers: f.headers })
	assert.equal((await f.host.browser.request('/v1/sessions', { headers: f.headers })).status, 429)
})

const REMOTE_BODY_LIMIT = 256 * 1024

test('Pi admission reserves before effects, rejects conflicting IDs and never evicts into duplicate execution', () => {
	const f = fixture()
	const command = f.command()
	const admission = new RemoteAdmission(f.snapshot.target, 1)
	let calls = 0
	assert.equal(
		admission.dispatch(command, () => {
			calls++
			throw new Error('after effect')
		}).status,
		'unknown',
	)
	assert.equal(
		admission.dispatch(command, () => {
			calls++
			return 'dispatched'
		}).status,
		'unknown',
	)
	assert.equal(
		admission.dispatch(f.command(), () => {
			calls++
			return 'dispatched'
		}).status,
		'rejected',
	)
	assert.equal(calls, 1)
	admission.dispose()
	assert.equal(admission.dispatch(command, () => 'dispatched').status, 'rejected')
})

function busFixture() {
	const emitter = new EventEmitter()
	return {
		on: (channel: string, callback: (value: unknown) => void) => {
			emitter.on(channel, callback)
			return () => {
				emitter.off(channel, callback)
			}
		},
		emit: (channel: string, value: unknown) => {
			emitter.emit(channel, value)
		},
	}
}
const questions = {
	questions: [
		{
			question: 'Choose one?',
			header: 'One',
			options: [
				{ label: 'A', description: 'first', preview: '**A**' },
				{ label: 'B', description: 'second' },
			],
		},
		{
			question: 'Choose several?',
			header: 'Several',
			multiSelect: true,
			options: [
				{ label: 'C', description: 'third' },
				{ label: 'D', description: 'fourth' },
			],
		},
		{
			question: 'Custom answer?',
			header: 'Text',
			options: [
				{ label: 'E', description: 'fifth' },
				{ label: 'F', description: 'sixth' },
			],
		},
	],
}

test('fork resolves single/multi/custom against original labels and preserves selected preview', () => {
	const result = resolveRemoteAnswers(questions, [{ option: 0 }, { options: [1, 0] }, { text: 'My answer' }])
	assert.equal(result?.answers[0].answer, 'A')
	assert.equal(result?.answers[0].preview, '**A**')
	assert.deepEqual(result?.answers[1].selected, ['D', 'C'])
	assert.equal(result?.answers[2].answer, 'My answer')
	for (const invalid of [
		[{ option: -1 }, { options: [] }, { text: 'ok' }],
		[{ option: 0 }, { options: [0, 0] }, { text: 'ok' }],
		[{ option: 0 }, { option: 0 }, { text: 'ok' }],
		[{ option: 0 }, { options: [] }, { text: ' ' }],
	])
		assert.equal(resolveRemoteAnswers(questions, invalid), null)
})

test('fork local/browser answer races settle the real completion callback once', () => {
	for (const localWins of [true, false]) {
		const bus = busFixture()
		let requestId = ''
		let completions = 0
		let closed = 0
		bus.on(QUESTION_OPEN, value => {
			requestId = (value as { requestId: string }).requestId
		})
		bus.on(QUESTION_CLOSED, () => {
			closed++
		})
		const question = openRemoteQuestion(bus, questions, () => {
			completions++
		})
		question.publish()
		if (localWins) question.complete({ answers: [], cancelled: true })
		bus.emit(QUESTION_ANSWER, {
			requestId,
			commandId: randomUUID(),
			answers: [{ option: 0 }, { options: [1] }, { text: 'custom' }],
		})
		question.complete({ answers: [], cancelled: true })
		question.dispose()
		assert.equal(completions, 1)
		assert.equal(closed, 1)
	}
})

test('fork invalid answer receives rejection while local TUI remains available', () => {
	const bus = busFixture()
	let requestId = ''
	let receipt: unknown
	let completions = 0
	bus.on(QUESTION_OPEN, value => {
		requestId = (value as { requestId: string }).requestId
	})
	bus.on(QUESTION_RECEIPT, value => {
		receipt = value
	})
	const question = openRemoteQuestion(bus, questions, () => {
		completions++
	})
	question.publish()
	const commandId = randomUUID()
	bus.emit(QUESTION_ANSWER, { requestId, commandId, answers: [] })
	assert.deepEqual(receipt, { requestId, commandId, status: 'rejected' })
	assert.equal(completions, 0)
	question.complete({ answers: [], cancelled: true })
	assert.equal(completions, 1)
})

test('enrollment refuses symlinks, hard links, world-readable files and wrong socket directories', () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'hr-')))
	chmodSync(root, 0o700)
	try {
		const path = join(root, 'enroll.json')
		const value = {
			protocol: 1,
			enrollmentId: randomUUID(),
			capability: createScopedCapability(),
			scopeId: null,
			generation: 1,
			socketPath: join(root, 'host.sock'),
		}
		writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
		assert.deepEqual(readRemoteEnrollment(path), value)
		symlinkSync(path, join(root, 'link.json'))
		assert.throws(() => readRemoteEnrollment(join(root, 'link.json')))
		linkSync(path, join(root, 'hard.json'))
		assert.throws(() => readRemoteEnrollment(path))
		rmSync(join(root, 'hard.json'))
		chmodSync(path, 0o644)
		assert.throws(() => readRemoteEnrollment(path))
		chmodSync(path, 0o600)
		writeFileSync(path, JSON.stringify({ ...value, socketPath: '/tmp/wrong.sock' }))
		assert.throws(() => readRemoteEnrollment(path))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
