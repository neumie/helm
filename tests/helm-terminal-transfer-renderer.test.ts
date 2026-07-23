import assert from 'node:assert/strict'
import test from 'node:test'
import type {
	TerminalTransferRendererController as ControllerType,
	TerminalTransferRendererControllerDeps,
	TerminalTransferRendererMetadata,
} from '../app/src/terminal-transfer-renderer'

const rendererModule = (await import('../app/src/terminal-transfer-renderer')) as unknown as {
	TerminalTransferRendererController: typeof ControllerType
}
const { TerminalTransferRendererController } = rendererModule

const SESSION = 'term-1234'
const TOKEN = 'work:7'

function fixture(overrides: Partial<TerminalTransferRendererControllerDeps> = {}) {
	const calls: string[] = []
	let currentToken = TOKEN
	const metadata: TerminalTransferRendererMetadata = {
		title: 'deploy watch',
		titleRaw: 'jakub@host:~/code/deploy-watch',
		oscTitle: 'deploy-watch',
		oscRaw: 'jakub@host:~/code/deploy-watch',
		customName: 'Ship dashboard',
		agentRunning: true,
		agentAttention: false,
	}
	const deps: TerminalTransferRendererControllerDeps = {
		currentProfileToken: () => currentToken,
		freeze(sessionId) {
			calls.push(`freeze:${sessionId}`)
		},
		saveSnapshot(sessionId) {
			calls.push(`snapshot:${sessionId}`)
			return { snapshotFlushed: true }
		},
		metadata(sessionId) {
			calls.push(`metadata:${sessionId}`)
			return metadata
		},
		dispose(sessionId) {
			calls.push(`dispose:${sessionId}`)
		},
		unfreeze(sessionId) {
			calls.push(`unfreeze:${sessionId}`)
		},
		...overrides,
	}
	return {
		calls,
		metadata,
		controller: new TerminalTransferRendererController(deps),
		setCurrentToken(value: string) {
			currentToken = value
		},
	}
}

function request(transactionId = 'move-1') {
	return { transactionId, sessionId: SESSION, profileToken: TOKEN }
}

test('prepares then commits only the source terminal while preserving exact title, pin, OSC, and activity metadata', async () => {
	const value = fixture()
	const prepared = await value.controller.prepare(request())
	assert.equal(prepared.status, 'prepared')
	if (prepared.status !== 'prepared') return
	assert.deepEqual(prepared.prepared.metadata, value.metadata)
	assert.notEqual(prepared.prepared.metadata, value.metadata)

	// The hand-off receives a point-in-time copy, not a mutable tab object.
	value.metadata.title = 'mutated after prepare'
	value.metadata.customName = null
	value.metadata.oscRaw = 'other raw title'
	value.metadata.agentRunning = false
	value.metadata.agentAttention = true
	assert.deepEqual(prepared.prepared.metadata, {
		title: 'deploy watch',
		titleRaw: 'jakub@host:~/code/deploy-watch',
		oscTitle: 'deploy-watch',
		oscRaw: 'jakub@host:~/code/deploy-watch',
		customName: 'Ship dashboard',
		agentRunning: true,
		agentAttention: false,
	})

	const committed = await value.controller.commit(request())
	assert.equal(committed.status, 'committed')
	assert.deepEqual(value.calls, [
		`freeze:${SESSION}`,
		`snapshot:${SESSION}`,
		`metadata:${SESSION}`,
		`dispose:${SESSION}`,
	])
})

test('rollback reopens the same prepared source terminal without disposing it', async () => {
	const value = fixture()
	assert.equal((await value.controller.prepare(request())).status, 'prepared')
	const rolledBack = await value.controller.rollback(request())
	assert.equal(rolledBack.status, 'rolled-back')
	assert.deepEqual(value.calls, [
		`freeze:${SESSION}`,
		`snapshot:${SESSION}`,
		`metadata:${SESSION}`,
		`unfreeze:${SESSION}`,
	])
})

test('rejects stale profile tokens before freezing and rolls a prepared terminal back when the profile changes', async () => {
	const value = fixture()
	const stale = await value.controller.prepare({ ...request(), profileToken: 'work:6' })
	assert.deepEqual(stale, { status: 'rejected', reason: 'stale-profile-token' })
	assert.deepEqual(value.calls, [])

	assert.equal((await value.controller.prepare(request())).status, 'prepared')
	value.setCurrentToken('profile:8')
	const committed = await value.controller.commit(request())
	assert.deepEqual(committed, { status: 'rejected', reason: 'stale-profile-token' })
	assert.deepEqual(value.calls.slice(-1), [`unfreeze:${SESSION}`])
})

test('reserves the transaction and session before awaiting adapters', async () => {
	let releaseSnapshot: (() => void) | undefined
	const value = fixture({
		saveSnapshot(sessionId) {
			value.calls.push(`snapshot:${sessionId}`)
			return new Promise(resolve => {
				releaseSnapshot = () => resolve({ snapshotFlushed: true })
			})
		},
	})
	const first = value.controller.prepare(request('move-1'))
	await new Promise(resolve => setImmediate(resolve))
	assert.deepEqual(await value.controller.prepare(request('move-1')), {
		status: 'rejected',
		reason: 'duplicate-transaction',
	})
	assert.deepEqual(await value.controller.prepare(request('move-2')), {
		status: 'rejected',
		reason: 'duplicate-session',
	})
	assert.ok(releaseSnapshot)
	releaseSnapshot()
	assert.equal((await first).status, 'prepared')
})

test('allows zero remaining tabs by treating a missing source terminal as a rollback, never creating a replacement', async () => {
	const value = fixture({
		metadata(sessionId) {
			value.calls.push(`metadata:${sessionId}`)
			return null
		},
	})
	assert.deepEqual(await value.controller.prepare(request()), {
		status: 'rejected',
		reason: 'missing-terminal',
	})
	assert.deepEqual(value.calls, [
		`freeze:${SESSION}`,
		`snapshot:${SESSION}`,
		`metadata:${SESSION}`,
		`unfreeze:${SESSION}`,
	])
})

test('failed snapshot acknowledgement rolls back and releases the session reservation', async () => {
	let snapshotFlushed = false
	const value = fixture({
		saveSnapshot(sessionId) {
			value.calls.push(`snapshot:${sessionId}`)
			return { snapshotFlushed }
		},
	})
	assert.deepEqual(await value.controller.prepare(request()), {
		status: 'rejected',
		reason: 'snapshot-not-flushed',
	})
	assert.deepEqual(value.calls, [`freeze:${SESSION}`, `snapshot:${SESSION}`, `unfreeze:${SESSION}`])
	snapshotFlushed = true
	assert.equal((await value.controller.prepare(request('move-2'))).status, 'prepared')
})
