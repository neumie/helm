import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { historyBytes } from '../src/remote/history-projection.js'
import { HISTORY_PAGE_BYTES, type HistoryRequest, type HistoryResult } from '../src/remote/history-protocol.js'
import { type HistoryManager, RemoteHistoryReader } from '../src/remote/history-reader.js'
import { RemoteLiveMessageObservation, readRemoteLiveMessages } from '../src/remote/live-messages.js'

const cli = process.env.HELM_REMOTE_PROOF_PI

// Explicit selected installation only. Never instantiate AgentSession, discover resources,
// load settings/credentials, or open a session file. The sole writer below is inMemory().
test(
	'selected Pi 0.85.1 in-memory IDs, compaction, sparse live reserve and fixed-head ranges',
	{ skip: !cli },
	async () => {
		assert.ok(cli)
		const root = resolve(dirname(cli), '..')
		assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.85.1')
		const { SessionManager } = await import(pathToFileURL(join(root, 'dist/core/session-manager.js')).href)
		assert.equal(typeof SessionManager.inMemory, 'function')
		const manager = SessionManager.inMemory('/tmp')
		assert.equal(manager.isPersisted(), false)
		assert.equal(manager.getSessionFile(), undefined)
		const ids: string[] = []
		for (let n = 0; n < 350; n++)
			ids.push(manager.appendMessage({ role: 'user', content: 'Repeated identical text', timestamp: 1 }))
		const compaction = manager.appendCompaction('Private summary', required(ids[300]), 12345, { private: 'never' })
		for (let n = 0; n < 100; n++)
			ids.push(
				manager.appendMessage({
					role: 'toolResult',
					toolName: 'read',
					toolCallId: `tool-${n}`,
					content: [{ type: 'text', text: 'Activity' }],
					isError: false,
					timestamp: 1,
				}),
			)
		assert.equal(new Set(ids).size, 450)
		const target = { sessionId: manager.getSessionId(), incarnation: randomUUID(), scopeId: null, generation: 1 }
		const epoch = randomUUID()
		const viewId = randomUUID()
		let sequence = 0
		let attempts = 0
		const observed: HistoryManager = {
			getLeafId: () => manager.getLeafId(),
			getEntry: id => {
				attempts++
				return manager.getEntry(id)
			},
		}
		const reader = new RemoteHistoryReader(
			target,
			epoch,
			() => observed,
			() => 1000,
		)
		const read = (action: HistoryRequest['action']): HistoryResult => {
			const before = attempts
			const result = reader.execute({
				requestId: randomUUID(),
				principalKey: 'read-only',
				expiresAt: 5000,
				request: { version: 1, hostEpoch: epoch, target, viewId, sequence: sequence++, action },
			})
			assert.equal(result.attempts, attempts - before)
			assert.ok(result.attempts <= 128)
			assert.ok(reader.storage.searchRows <= 128)
			assert.ok(reader.storage.searchBytes <= HISTORY_PAGE_BYTES)
			assert.ok(reader.storage.retryBytes <= 96 * 1024)
			return result
		}
		const finish = (initial: HistoryResult) => {
			let result = initial
			for (let n = 0; result.state === 'progress' && n < 20; n++)
				result = read({ kind: 'continue', cursor: required(result.continuation) })
			assert.equal(result.state, 'page')
			return required(result.page)
		}
		const live = readRemoteLiveMessages(observed)
		assert.equal(live.messages.length, 40)
		assert.equal(live.messages.filter(message => message.role === 'user').length, 10)
		assert.equal(live.historyTruncated, true)
		assert.deepEqual(
			live.messages.filter(message => message.role === 'user').map(message => message.id),
			ids.slice(340, 350),
		)
		assert.deepEqual(
			live.messages.filter(message => message.role === 'toolResult').map(message => message.id),
			ids.slice(-30),
		)
		let page = finish(read({ kind: 'open' }))
		const originalHead = page.newest
		const appended = manager.appendMessage({ role: 'user', content: 'Appended after capture', timestamp: 2 })
		const all: string[] = []
		const ranges = []
		while (true) {
			ranges.push(page)
			all.push(...page.records.map(row => (row.kind === 'message' ? row.message.id : row.id)))
			if (!page.older) break
			page = finish(read({ kind: 'page', cursor: page.older }))
		}
		assert.equal(all.length, 451)
		assert.equal(new Set(all).size, 451)
		assert.ok(all.includes(compaction))
		assert.ok(!all.includes(appended))
		assert.equal(page.stopped, 'root')
		assert.doesNotMatch(JSON.stringify(ranges), /Private summary|never/)
		// Discard prior projected pages; Newer receives only the sealed boundary.
		ranges.length = 0
		const newer = read({ kind: 'newer', cursor: required(page.newer) })
		assert.equal(newer.state, 'progress')
		manager.appendCompaction('Another private summary', required(ids[0]), 12345)
		page = finish(newer)
		while (page.newer) page = finish(read({ kind: 'newer', cursor: page.newer }))
		assert.equal(page.newest, originalHead)
		assert.equal(readRemoteLiveMessages(observed).messages.at(-1)?.id, appended)
		reader.dispose()
		assert.equal(reader.storage.views, 0)
		assert.equal(manager.isPersisted(), false)
		assert.equal(manager.getSessionFile(), undefined)
	},
)

test(
	'selected Pi message_end replacement remains provisional until canonical manager observation',
	{ skip: !cli },
	async () => {
		assert.ok(cli)
		const root = resolve(dirname(cli), '..')
		assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.85.1')
		const { SessionManager } = await import(pathToFileURL(join(root, 'dist/core/session-manager.js')).href)
		const { ExtensionRunner } = await import(pathToFileURL(join(root, 'dist/core/extensions/runner.js')).href)
		const manager = SessionManager.inMemory('/tmp')
		const first = manager.appendMessage({ role: 'user', content: 'same text', timestamp: 1 })
		let active: HistoryManager | null = manager
		const observation = new RemoteLiveMessageObservation(() => active)
		assert.equal(observation.snapshot().messages[0]?.id, first)
		const eventMessage = { role: 'user', content: 'same text', timestamp: 1 }
		observation.publish(eventMessage, true)
		assert.equal(observation.snapshot().messages.at(-1)?.id, 'current')
		const gate = Promise.withResolvers<void>()
		const entered = Promise.withResolvers<void>()
		// Use the actual installed replacement-handler chain, but no AgentSession/model.
		// appendMessage below represents AgentSession's source-attested post-hook persistence seam.
		const runner = new ExtensionRunner(
			[
				{
					path: 'fixture:bridge',
					handlers: new Map([['message_end', [(event: { message: unknown }) => observation.publish(event.message)]]]),
				},
				{
					path: 'fixture:replacement',
					handlers: new Map([
						[
							'message_end',
							[
								async () => {
									entered.resolve()
									await gate.promise
									return { message: { ...eventMessage, content: 'Stored replacement' } }
								},
							],
						],
					]),
				},
			],
			{},
			'/tmp',
			manager,
			undefined,
		)
		const errors: unknown[] = []
		runner.onError((error: unknown) => errors.push(error))
		const pending = runner.emitMessageEnd({ type: 'message_end', message: eventMessage })
		await entered.promise
		assert.deepEqual(
			observation.snapshot().messages.map(message => message.id),
			[first],
		)
		assert.equal(manager.getLeafId(), first)
		gate.resolve()
		const replacement = await pending
		assert.ok(replacement)
		const second = manager.appendMessage(replacement)
		assert.notEqual(first, second)
		const snapshot = observation.snapshot()
		assert.deepEqual(
			snapshot.messages.map(message => message.id),
			[first, second],
		)
		assert.equal(snapshot.messages.at(-1)?.text, 'Stored replacement')
		assert.ok(!snapshot.messages.some(message => message.id === 'current'))
		const revision = observation.revision
		assert.deepEqual(observation.snapshot(), snapshot)
		assert.equal(observation.revision, revision)
		assert.deepEqual(errors, [])
		active = null
		assert.deepEqual(observation.snapshot().messages, [])
		const next = SessionManager.inMemory('/tmp')
		const nextId = next.appendMessage({ role: 'user', content: 'Replacement owner', timestamp: 2 })
		active = next
		assert.deepEqual(
			observation.snapshot().messages.map(message => message.id),
			[nextId],
		)
		observation.dispose()
		assert.equal(manager.getSessionFile(), undefined)
		assert.equal(next.getSessionFile(), undefined)
	},
)

test('live observation refuses malformed and cyclic edges without duplicate canonical IDs', () => {
	for (const parentId of ['00000001', '../private']) {
		let calls = 0
		const result = readRemoteLiveMessages({
			getLeafId: () => '00000001',
			getEntry: id => {
				calls++
				return { id, parentId, type: 'message', message: { role: 'user', content: 'Text' } }
			},
		})
		assert.equal(result.historyTruncated, true)
		assert.ok(calls <= 1)
		assert.ok(result.messages.length <= 1)
	}
})

test('provisional byte pressure cannot mutate completed canonical rows or reread identity', () => {
	const manager = {
		getLeafId: () => '00000001',
		getEntry: (id: string) => ({
			id,
			parentId: null,
			type: 'message',
			message: { role: 'user', content: 'Canonical' },
		}),
	}
	const observation = new RemoteLiveMessageObservation(() => manager)
	const before = observation.snapshot()
	observation.publish({ role: 'assistant', content: '\0'.repeat(100_000) }, true)
	const during = observation.snapshot()
	assert.ok(historyBytes(during.messages) <= 160 * 1024)
	assert.equal(during.messages[0]?.id, '00000001')
	observation.publish({ role: 'assistant', content: 'Not stored' })
	assert.deepEqual(observation.snapshot(), before)
})

function required<T>(value: T | null | undefined): T {
	assert.ok(value !== null && value !== undefined, 'Expected fixture value')
	return value
}
