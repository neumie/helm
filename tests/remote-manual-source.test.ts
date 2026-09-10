import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import { REMOTE_CONTROL_RESPONSE_BYTES, remoteControlRequest } from '../src/remote/control-client.js'
import { RemoteHost } from '../src/remote/host.js'
import {
	REMOTE_MAX_OWNERS,
	REMOTE_PROTOCOL,
	REMOTE_STALE_MS,
	type RemoteSnapshot,
	remoteSourceCandidatesSchema,
} from '../src/remote/protocol.js'
import { startRemoteRuntime } from '../src/remote/runtime.js'

const origin = 'https://remote.example'

function snapshot(
	sessionId = randomUUID(),
	incarnation = randomUUID(),
	extra: Partial<RemoteSnapshot> = {},
): RemoteSnapshot {
	return {
		target: { sessionId, incarnation, scopeId: null, generation: 1 },
		revision: 1,
		label: 'Manual source test',
		workspace: 'workspace',
		model: 'test/model',
		activity: 'idle',
		capabilities: { prompt: true, interrupt: true, answer: true },
		question: null,
		messages: [],
		historyTruncated: false,
		...extra,
	}
}

function issue(host: RemoteHost, target?: RemoteSnapshot['target']) {
	const capability = createScopedCapability()
	const enrollment = { id: randomUUID(), capability }
	host.issueEnrollment({
		id: enrollment.id,
		capabilityHash: hashScopedCapability(capability),
		scopeId: target?.scopeId ?? null,
		generation: target?.generation ?? 1,
		sessionId: target?.sessionId,
	})
	return enrollment
}

function exchange(host: RemoteHost, enrollment: { id: string; capability: string }, value: RemoteSnapshot) {
	return host.local.request('/exchange', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${enrollment.capability}`,
			'X-Helm-Enrollment': enrollment.id,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ protocol: REMOTE_PROTOCOL, enrollmentId: enrollment.id, snapshot: value, receipts: [] }),
	})
}

function browserHeaders(capability: string) {
	return { Host: 'remote.example', Authorization: `Bearer ${capability}` }
}

function socketJson(
	socketPath: string,
	token: string,
	path: string,
	body?: unknown,
	extraHeaders: Record<string, string> = {},
): Promise<{ status: number; value: unknown }> {
	return new Promise((resolvePromise, reject) => {
		const encoded = body === undefined ? undefined : JSON.stringify(body)
		const req = request(
			{
				socketPath,
				path,
				method: encoded === undefined ? 'GET' : 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					...extraHeaders,
					...(encoded === undefined
						? {}
						: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }),
				},
			},
			response => {
				const parts: Buffer[] = []
				response.on('data', part => parts.push(part))
				response.on('error', reject)
				response.on('end', () => {
					try {
						resolvePromise({
							status: response.statusCode ?? 0,
							value: JSON.parse(Buffer.concat(parts).toString('utf8')),
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

async function assetsRoot(root: string): Promise<string> {
	const assets = join(root, 'assets')
	mkdirSync(assets, { mode: 0o700 })
	for (const name of ['index.html', 'remote.js', 'remote.css']) writeFileSync(join(assets, name), '', { mode: 0o600 })
	return assets
}

async function runtimeFixture() {
	const root = mkdtempSync('/tmp/hr-ms-')
	chmodSync(root, 0o700)
	const assets = await assetsRoot(root)
	const runtime = await startRemoteRuntime({
		root: join(root, 'remote'),
		origin,
		assetsDirectory: assets,
		port: 0,
		piSessionRoots: [],
	})
	const operator = readFileSync(join(runtime.root, 'operator-token'), 'utf8').trim()
	const discovery = JSON.parse(readFileSync(join(runtime.root, 'bridge-registration.json'), 'utf8')) as {
		capability: string
	}
	const controlSocket = join(runtime.root, 'control.sock')
	return { root, runtime, operator, registration: discovery.capability, controlSocket }
}

test('operator captions fall back from generic Pi labels to the workspace, without replacing named sessions', async () => {
	const browser = createScopedCapability()
	const host = new RemoteHost({ origin, browserCapabilityHash: hashScopedCapability(browser) })
	for (const [label, workspace, expected] of [
		['Pi session', 'helm', 'helm'],
		['  pI SeSsIoN  ', 'cerstvy-tvarohac', 'cerstvy-tvarohac'],
		['', 'feat-add-consumable-components', 'feat-add-consumable-components'],
		['Evaluate Automatic Pi Session Naming', 'helm', 'Evaluate Automatic Pi Session Naming'],
		['Pi session', '', 'Pi session'],
	]) {
		const value = snapshot(undefined, undefined, { label, workspace })
		const enrollment = issue(host, value.target)
		assert.equal((await exchange(host, enrollment, value)).status, 200)
		const candidate = host.sourceCandidates().candidates.find(row => row.target.sessionId === value.target.sessionId)
		assert.equal(candidate?.caption, expected)
	}
})

test('source candidates are bounded, strict, and contain only operator-safe identity fields', async () => {
	const browser = createScopedCapability()
	const host = new RemoteHost({ origin, browserCapabilityHash: hashScopedCapability(browser) })
	for (let index = 0; index < REMOTE_MAX_OWNERS; index++) {
		const value = snapshot()
		const enrollment = issue(host, value.target)
		assert.equal((await exchange(host, enrollment, value)).status, 200)
	}
	const inventory = host.sourceCandidates()
	const parsed = remoteSourceCandidatesSchema.parse(inventory)
	assert.equal(parsed.candidates.length, REMOTE_MAX_OWNERS)
	assert.ok(Buffer.byteLength(JSON.stringify(parsed)) < REMOTE_CONTROL_RESPONSE_BYTES)
	assert.deepEqual(Object.keys(parsed.candidates[0] ?? {}).sort(), [
		'caption',
		'connected',
		'manualSource',
		'nativeSource',
		'target',
	])
	assert.ok(parsed.candidates.every(candidate => candidate.caption.length <= 160))
})

test('manual source projects in directory and detail without changing Pi revision, capabilities, or command admission', async () => {
	const browser = createScopedCapability()
	const host = new RemoteHost({ origin, browserCapabilityHash: hashScopedCapability(browser) })
	const value = snapshot()
	const enrollment = issue(host, value.target)
	assert.equal((await exchange(host, enrollment, value)).status, 200)
	const commandId = randomUUID()
	const command = {
		protocol: REMOTE_PROTOCOL,
		hostEpoch: host.epoch,
		commandId,
		target: value.target,
		operation: { kind: 'prompt' as const, text: 'pending command', delivery: 'steer' as const },
	}
	const commandResponse = await host.browser.request('/v1/commands', {
		method: 'POST',
		headers: { ...browserHeaders(browser), 'Content-Type': 'application/json', Origin: origin, 'X-Helm-Remote': '1' },
		body: JSON.stringify(command),
	})
	assert.equal(commandResponse.status, 202)
	const before = structuredClone(value)
	const confirmed = host.confirmSource({ hostEpoch: host.epoch, target: value.target, source: 'okena' })
	assert.equal(confirmed.ok, true)
	if (!confirmed.ok) return
	assert.equal(confirmed.candidate.manualSource, 'okena')
	assert.equal(confirmed.candidate.nativeSource, null)
	assert.deepEqual(confirmed.candidate.target, value.target)
	const directory = (await (
		await host.browser.request('/v1/sessions', { headers: browserHeaders(browser) })
	).json()) as {
		sessions: Array<Record<string, unknown>>
	}
	const summary = directory.sessions[0]
	assert.ok(summary)
	assert.deepEqual(summary.terminal, {
		source: 'okena',
		project: null,
		worktree: null,
		branch: null,
		name: null,
		group: null,
	})
	const detail = (await (
		await host.browser.request(`/v1/sessions/${value.target.sessionId}`, { headers: browserHeaders(browser) })
	).json()) as { snapshot: RemoteSnapshot }
	assert.deepEqual(detail.snapshot.terminal, summary.terminal)
	assert.equal(detail.snapshot.revision, before.revision)
	assert.equal(detail.snapshot.model, before.model)
	assert.deepEqual(detail.snapshot.capabilities, before.capabilities)
	assert.deepEqual(detail.snapshot.messages, before.messages)
	assert.deepEqual(detail.snapshot.question, before.question)
	assert.deepEqual(value, before)
	const stillPending = await exchange(host, enrollment, value)
	assert.equal(stillPending.status, 200)
	const exchangeValue = (await stillPending.json()) as { commands: Array<{ command: typeof command }> }
	assert.equal(exchangeValue.commands.length, 1)
	assert.deepEqual(exchangeValue.commands[0]?.command, command)
	const cleared = host.confirmSource({ hostEpoch: host.epoch, target: value.target, source: null })
	assert.equal(cleared.ok, true)
	const clearedDetail = (await (
		await host.browser.request(`/v1/sessions/${value.target.sessionId}`, { headers: browserHeaders(browser) })
	).json()) as { snapshot: RemoteSnapshot }
	assert.equal(clearedDetail.snapshot.terminal, undefined)
})

test('confirmation requires the active host, fresh current owner, and complete target identity', async () => {
	let now = 1_000
	const host = new RemoteHost({
		origin,
		browserCapabilityHash: hashScopedCapability(createScopedCapability()),
		now: () => now,
	})
	const value = snapshot()
	const enrollment = issue(host, value.target)
	assert.equal((await exchange(host, enrollment, value)).status, 200)
	const wrongTargets = [
		{ ...value.target, sessionId: randomUUID() },
		{ ...value.target, incarnation: randomUUID() },
		{ ...value.target, scopeId: randomUUID() },
		{ ...value.target, generation: 2 },
	]
	for (const target of wrongTargets)
		assert.deepEqual(host.confirmSource({ hostEpoch: host.epoch, target, source: 'helm' }), {
			ok: false,
			error: 'stale_target',
		})
	assert.deepEqual(host.confirmSource({ hostEpoch: randomUUID(), target: value.target, source: 'helm' }), {
		ok: false,
		error: 'stale_target',
	})
	now += REMOTE_STALE_MS + 1
	assert.deepEqual(host.confirmSource({ hostEpoch: host.epoch, target: value.target, source: 'helm' }), {
		ok: false,
		error: 'disconnected',
	})
	const replacement = snapshot(value.target.sessionId)
	const replacementEnrollment = issue(host, replacement.target)
	assert.equal((await exchange(host, replacementEnrollment, replacement)).status, 200)
	const inventory = host.sourceCandidates()
	assert.equal(inventory.candidates.length, 1)
	assert.deepEqual(inventory.candidates[0]?.target, replacement.target)
	assert.equal(inventory.candidates[0]?.manualSource, null)
	assert.deepEqual(host.confirmSource({ hostEpoch: host.epoch, target: value.target, source: 'okena' }), {
		ok: false,
		error: 'stale_target',
	})
	assert.equal(host.confirmSource({ hostEpoch: host.epoch, target: replacement.target, source: 'helm' }).ok, true)
	const restarted = new RemoteHost({ origin, browserCapabilityHash: hashScopedCapability(createScopedCapability()) })
	assert.deepEqual(restarted.sourceCandidates().candidates, [])
	host.revoke()
	assert.deepEqual(host.confirmSource({ hostEpoch: host.epoch, target: replacement.target, source: 'okena' }), {
		ok: false,
		error: 'inactive',
	})
})

test('native metadata wins and clears manual fallback before a later native loss', async () => {
	const browser = createScopedCapability()
	const host = new RemoteHost({ origin, browserCapabilityHash: hashScopedCapability(browser) })
	const first = snapshot()
	const enrollment = issue(host, first.target)
	assert.equal((await exchange(host, enrollment, first)).status, 200)
	assert.equal(host.confirmSource({ hostEpoch: host.epoch, target: first.target, source: 'okena' }).ok, true)
	const fallback = (await (
		await host.browser.request(`/v1/sessions/${first.target.sessionId}`, { headers: browserHeaders(browser) })
	).json()) as { snapshot: RemoteSnapshot }
	assert.equal(fallback.snapshot.terminal?.source, 'okena')
	const native = snapshot(first.target.sessionId, first.target.incarnation, {
		revision: 2,
		terminal: { source: 'helm', project: null, worktree: null, branch: null, name: 'Native shell', group: null },
	})
	assert.equal((await exchange(host, enrollment, native)).status, 200)
	const nativeCandidate = host.sourceCandidates().candidates[0]
	assert.equal(nativeCandidate?.nativeSource, 'helm')
	assert.equal(nativeCandidate?.manualSource, null)
	const nativeDetail = (await (
		await host.browser.request(`/v1/sessions/${first.target.sessionId}`, { headers: browserHeaders(browser) })
	).json()) as { snapshot: RemoteSnapshot }
	assert.equal(nativeDetail.snapshot.terminal?.name, 'Native shell')
	const lostNative = snapshot(first.target.sessionId, first.target.incarnation, { revision: 3 })
	assert.equal((await exchange(host, enrollment, lostNative)).status, 200)
	const afterLoss = host.sourceCandidates().candidates[0]
	assert.equal(afterLoss?.nativeSource, null)
	assert.equal(afterLoss?.manualSource, null)
	const afterLossDetail = (await (
		await host.browser.request(`/v1/sessions/${first.target.sessionId}`, { headers: browserHeaders(browser) })
	).json()) as { snapshot: RemoteSnapshot }
	assert.equal(afterLossDetail.snapshot.terminal, undefined)
})

test('source repair is control-authenticated, origin-free, registration-token-free, and schema/body bounded', async t => {
	const fixture = await runtimeFixture()
	t.after(async () => {
		await fixture.runtime.stop()
		rmSync(fixture.root, { recursive: true, force: true })
	})
	const control = (path: string, body?: unknown) =>
		remoteControlRequest(fixture.controlSocket, fixture.operator, path, body)
	const enrollmentDocument = (await control('/enrollments', { scopeId: null, generation: 1 })).body as {
		enrollmentFile: string
	}
	const enrollment = JSON.parse(readFileSync(enrollmentDocument.enrollmentFile, 'utf8')) as {
		enrollmentId: string
		capability: string
		socketPath: string
	}
	const value = snapshot()
	assert.equal(
		(
			await socketJson(
				enrollment.socketPath,
				enrollment.capability,
				'/exchange',
				{
					protocol: REMOTE_PROTOCOL,
					enrollmentId: enrollment.enrollmentId,
					snapshot: value,
					receipts: [],
				},
				{ 'X-Helm-Enrollment': enrollment.enrollmentId },
			)
		).status,
		200,
	)
	const unauthenticated = await socketJson(fixture.controlSocket, createScopedCapability(), '/source-candidates')
	assert.equal(unauthenticated.status, 401)
	const inventory = await control('/source-candidates')
	assert.equal(inventory.status, 200)
	assert.equal(remoteSourceCandidatesSchema.parse(inventory.body).candidates.length, 1)
	const confirmed = await control('/source-candidates/confirm', {
		hostEpoch: (inventory.body as { hostEpoch: string }).hostEpoch,
		target: value.target,
		source: 'okena',
	})
	assert.equal(confirmed.status, 200)
	assert.equal((confirmed.body as { manualSource: string }).manualSource, 'okena')
	const wrongSource = await control('/source-candidates/confirm', {
		hostEpoch: (inventory.body as { hostEpoch: string }).hostEpoch,
		target: value.target,
		source: 'other',
	})
	assert.equal(wrongSource.status, 400)
	const wrongTarget = await control('/source-candidates/confirm', {
		hostEpoch: (inventory.body as { hostEpoch: string }).hostEpoch,
		target: { ...value.target, incarnation: randomUUID() },
		source: 'helm',
	})
	assert.equal(wrongTarget.status, 409)
	const originDenied = await socketJson(fixture.controlSocket, fixture.operator, '/source-candidates', undefined, {
		Origin: origin,
	})
	assert.equal(originDenied.status, 401)
	const registrationDenied = await socketJson(fixture.controlSocket, fixture.registration, '/source-candidates')
	assert.equal(registrationDenied.status, 401)
	const oversized = await socketJson(fixture.controlSocket, fixture.operator, '/source-candidates/confirm', {
		hostEpoch: randomUUID(),
		target: value.target,
		source: null,
		padding: 'x'.repeat(20_000),
	})
	assert.equal(oversized.status, 413)
	const controlAgain = await control('/source-candidates')
	assert.equal(controlAgain.status, 200)
	assert.ok(Buffer.byteLength(JSON.stringify(controlAgain.body)) < REMOTE_CONTROL_RESPONSE_BYTES)
	const browserPort = fixture.runtime.port
	assert.ok(browserPort)
	const browserResponse = await fetch(`http://127.0.0.1:${browserPort}/source-candidates`, {
		headers: { Host: 'remote.example' },
	})
	assert.ok(
		[403, 404].includes(browserResponse.status),
		`browser must not reach control route: ${browserResponse.status}`,
	)
})
