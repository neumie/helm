import assert from 'node:assert/strict'
import { test } from 'node:test'
import identityModule from '../app/src/renderer/remote/remote-identity.js'
import equalityModule from '../app/src/renderer/remote/remote-poll-equality.js'
import type { RemoteDetail, RemoteDirectory, RemoteSnapshot } from '../src/remote/protocol.js'

const { reuseRemoteMessages, sameRemoteCatalogPage, sameRemoteDetail } = equalityModule
const { pruneAbsentRemoteDrafts, remoteSessionIdentity } = identityModule

type Message = RemoteSnapshot['messages'][number]

function message(id: string, text = id): Message {
	return { id, role: 'assistant', text, thinking: '', truncated: false }
}

function detail(terminalSource: 'okena' | 'helm', connected = true): RemoteDetail {
	return {
		protocol: 1,
		hostEpoch: '10000000-0000-4000-8000-000000000000',
		resync: true,
		snapshot: {
			target: {
				sessionId: '10000000-0000-4000-8000-000000000001',
				incarnation: '20000000-0000-4000-8000-000000000001',
				scopeId: null,
				generation: 1,
			},
			revision: 1,
			label: 'Pi session',
			workspace: 'helm',
			terminal: { source: terminalSource, project: null, name: null, group: null },
			model: null,
			activity: 'idle',
			connected,
			capabilities: { prompt: true, interrupt: true, answer: false },
			question: null,
			messages: [message('one'), message('two')],
			historyTruncated: false,
		},
	}
}

test('bounded message structural sharing preserves unchanged rendered nodes', () => {
	const previous = [message('one'), message('two')]
	const cloned = previous.map(value => ({ ...value }))
	assert.strictEqual(reuseRemoteMessages(previous, cloned), previous)

	const changed = [message('one'), message('two', 'changed')]
	const next = reuseRemoteMessages(previous, changed)
	assert.notStrictEqual(next, previous)
	assert.ok(next)
	assert.strictEqual(next[0], previous[0])
	assert.notStrictEqual(next[1], previous[1])

	const reordered = reuseRemoteMessages(previous, [message('two'), message('one')])
	assert.deepEqual(
		reordered?.map(value => value.id),
		['two', 'one'],
	)
	assert.strictEqual(reordered?.[0], previous[1])
	assert.strictEqual(reordered?.[1], previous[0])
})

test('complete detail view equality includes both connected transitions and source overlays', () => {
	assert.equal(sameRemoteDetail(detail('okena'), detail('okena')), true)
	assert.equal(sameRemoteDetail(detail('okena'), detail('helm')), false)
	assert.equal(sameRemoteDetail(detail('okena', true), detail('okena', false)), false)
	assert.equal(sameRemoteDetail(detail('okena', false), detail('okena', true)), false)
})

test('catalog equality includes host epoch as well as its overlay identity', () => {
	const first = {
		protocol: 1 as const,
		hostEpoch: '10000000-0000-4000-8000-000000000000',
		state: 'ready' as const,
		rows: [],
		omissions: { malformed: 0, unsupported: 0 },
		pageCursor: '0',
		previousCursor: null,
		nextCursor: null,
		overlayStamp: 'same-overlay',
		reason: null,
	}
	assert.equal(sameRemoteCatalogPage(first, { ...first }), true)
	assert.equal(sameRemoteCatalogPage(first, { ...first, hostEpoch: '10000000-0000-4000-8000-000000000099' }), false)
})

test('drafts retire only when a complete directory omits their complete identity', () => {
	const current = detail('okena').snapshot.target
	const unselected = {
		...current,
		sessionId: '10000000-0000-4000-8000-000000000002',
		incarnation: '20000000-0000-4000-8000-000000000002',
	}
	const replaced = { ...current, incarnation: '20000000-0000-4000-8000-000000000099' }
	const oldEpoch = remoteSessionIdentity('10000000-0000-4000-8000-000000000099', current)
	const drafts = new Map([
		[remoteSessionIdentity('10000000-0000-4000-8000-000000000000', current), 'current'],
		[remoteSessionIdentity('10000000-0000-4000-8000-000000000000', unselected), 'filtered'],
		[remoteSessionIdentity('10000000-0000-4000-8000-000000000000', replaced), 'replaced'],
		[oldEpoch, 'old-epoch'],
	])
	const directory: RemoteDirectory = {
		protocol: 1,
		hostEpoch: '10000000-0000-4000-8000-000000000000',
		overlayStamp: 'published',
		sessions: [
			{ ...detail('okena').snapshot, connected: true },
			{ ...detail('okena').snapshot, target: unselected, connected: true },
		],
	}
	pruneAbsentRemoteDrafts(drafts, directory)
	assert.deepEqual([...drafts.values()].sort(), ['current', 'filtered'])
})
