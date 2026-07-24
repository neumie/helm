import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BufferStore as BufferStoreType } from '../app/src/buffers'
import type { SessionRegistry as SessionRegistryType } from '../app/src/sessions'
import type { TerminalTransferJournalStore as JournalStoreType } from '../app/src/terminal-transfer'
import type { TerminalTransferMainAdapter as AdapterType } from '../app/src/terminal-transfer-main'

const buffersModule = (await import('../app/src/buffers')) as unknown as {
	BufferStore: typeof BufferStoreType
}
const sessionsModule = (await import('../app/src/sessions')) as unknown as {
	SessionRegistry: typeof SessionRegistryType
}
const transferModule = (await import('../app/src/terminal-transfer')) as unknown as {
	TerminalTransferJournalStore: typeof JournalStoreType
}
const adapterModule = (await import('../app/src/terminal-transfer-main')) as unknown as {
	TerminalTransferMainAdapter: typeof AdapterType
}
const { BufferStore } = buffersModule
const { SessionRegistry } = sessionsModule
const { TerminalTransferJournalStore } = transferModule
const { TerminalTransferMainAdapter } = adapterModule

const SESSION = 'term-1234'
const SOURCE = 'work'
const DESTINATION = 'profile-123456789abc'

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'helm-transfer-main-'))
	const sourceDir = join(root, SOURCE)
	const destinationDir = join(root, DESTINATION)
	const source = {
		registry: new SessionRegistry(join(sourceDir, 'sessions.json')),
		buffers: new BufferStore(join(sourceDir, 'buffers')),
	}
	const destination = {
		registry: new SessionRegistry(join(destinationDir, 'sessions.json')),
		buffers: new BufferStore(join(destinationDir, 'buffers')),
	}
	source.registry.add(SESSION)
	source.registry.flush()
	const calls: string[] = []
	let profile = SOURCE
	let token = 'work:0'
	const journal = new TerminalTransferJournalStore(join(root, 'journal.json'), true)
	const adapter = new TerminalTransferMainAdapter({
		userDataDir: root,
		journal,
		runtime: {
			storageForProfile(id) {
				const storage = id === SOURCE ? source : id === DESTINATION ? destination : null
				return storage
					? {
							...storage,
							registryPath: storage.registry.filePath,
							bufferDir: join(root, id, 'buffers'),
						}
					: null
			},
			currentProfile: () => ({ profileId: profile, token }),
		},
		detachAttachClient() {
			calls.push('detach-client')
			return true
		},
		attachSourceClient() {
			return false
		},
		async captureMaster(socket) {
			calls.push(`capture:${socket}`)
			return { pid: 44, processStartFingerprint: 'start-44' }
		},
		async attestMaster(socket) {
			calls.push(`attest:${socket}`)
			return 'verified'
		},
		async renameSocket(sourceSocket, destinationSocket) {
			calls.push(`rename:${sourceSocket}:${destinationSocket}`)
		},
		async probeSocket(socket) {
			return socket.includes(`/profiles/${DESTINATION}/`) ? 'live' : 'dead'
		},
	})
	return {
		root,
		source,
		destination,
		calls,
		journal,
		adapter,
		setCurrent(nextProfile: string, nextToken: string) {
			profile = nextProfile
			token = nextToken
		},
	}
}

test('preflight lists only valid destination profiles without capturing or detaching a terminal', () => {
	const value = fixture()
	try {
		assert.deepEqual(
			value.adapter.preflight({
				sourceProfileId: SOURCE,
				sessionId: SESSION,
				profileToken: 'work:0',
				destinationProfileIds: [SOURCE, DESTINATION, 'not-a-profile'],
			}),
			{ status: 'available', targetProfileIds: [DESTINATION] },
		)
		assert.deepEqual(value.calls, [])
	} finally {
		rmSync(value.root, { recursive: true, force: true })
	}
})

test('preflight fails closed for a stale token without capturing a master', () => {
	const value = fixture()
	try {
		assert.deepEqual(
			value.adapter.preflight({
				sourceProfileId: SOURCE,
				sessionId: SESSION,
				profileToken: 'work:stale',
				destinationProfileIds: [DESTINATION],
			}),
			{ status: 'unavailable', reason: 'stale-profile' },
		)
		assert.deepEqual(value.calls, [])
	} finally {
		rmSync(value.root, { recursive: true, force: true })
	}
})

test('fails closed for missing capability and never captures or detaches a terminal', async () => {
	const value = fixture()
	try {
		const result = await value.adapter.move({
			sourceProfileId: SOURCE,
			destinationProfileId: DESTINATION,
			sessionId: SESSION,
			profileToken: 'work:0',
		})
		assert.deepEqual(result, {
			status: 'rejected',
			reason: 'admission-unavailable',
		})
		assert.deepEqual(value.calls, [])
		assert.equal(value.journal.load(), null)
	} finally {
		rmSync(value.root, { recursive: true, force: true })
	}
})

test('rejects a stale renderer token without registering a startable transfer capability', async () => {
	const value = fixture()
	try {
		assert.equal(
			value.adapter.registerRendererCapability({
				profileToken: 'work:0',
				sessionId: SESSION,
				async dispatch() {},
			}),
			true,
		)
		value.setCurrent(SOURCE, 'work:1')
		const result = await value.adapter.move({
			sourceProfileId: SOURCE,
			destinationProfileId: DESTINATION,
			sessionId: SESSION,
			profileToken: 'work:0',
		})
		assert.deepEqual(result, {
			status: 'rejected',
			reason: 'admission-unavailable',
		})
		assert.deepEqual(value.calls, [])
	} finally {
		rmSync(value.root, { recursive: true, force: true })
	}
})

test('uses only capability detach events and socket rename; it never calls a master-kill seam', async () => {
	const value = fixture()
	try {
		value.source.buffers.save(SESSION, 'snapshot')
		const events: string[] = []
		const transactionIds: string[] = []
		assert.equal(
			value.adapter.registerRendererCapability({
				profileToken: 'work:0',
				sessionId: SESSION,
				async dispatch(event) {
					events.push(event.type)
					transactionIds.push(event.transactionId)
					if (event.type === 'prepare') {
						return {
							status: 'prepared',
							prepared: { metadata: { agentRunning: false, agentAttention: false } },
						}
					}
					return { status: 'committed' }
				},
			}),
			true,
		)
		const result = await value.adapter.move({
			sourceProfileId: SOURCE,
			destinationProfileId: DESTINATION,
			sessionId: SESSION,
			profileToken: 'work:0',
		})
		assert.equal(result.status, 'moved')
		assert.deepEqual(events, ['prepare', 'commit'])
		assert.equal(new Set(transactionIds).size, 1, 'prepare and commit address one renderer transaction')
		assert.equal(value.calls.filter(call => call.startsWith('rename:')).length, 1)
		assert.equal(
			value.calls.some(call => /kill|signal/i.test(call)),
			false,
		)
		assert.equal(value.destination.registry.get(SESSION)?.parked, true)
	} finally {
		rmSync(value.root, { recursive: true, force: true })
	}
})

test('a rejected renderer commit quarantines durable destination ownership instead of reporting moved', async () => {
	const value = fixture()
	try {
		value.source.buffers.save(SESSION, 'snapshot')
		assert.equal(
			value.adapter.registerRendererCapability({
				profileToken: 'work:0',
				sessionId: SESSION,
				async dispatch(event) {
					return event.type === 'prepare'
						? {
								status: 'prepared',
								prepared: { metadata: { agentRunning: false, agentAttention: false } },
							}
						: { status: 'rejected', reason: 'unknown-transaction' }
				},
			}),
			true,
		)
		const result = await value.adapter.move({
			sourceProfileId: SOURCE,
			destinationProfileId: DESTINATION,
			sessionId: SESSION,
			profileToken: 'work:0',
		})
		assert.equal(result.status, 'quarantined')
		assert.equal(value.journal.load()?.state, 'rollback-needed')
		assert.equal(value.destination.registry.get(SESSION)?.parked, true)
	} finally {
		rmSync(value.root, { recursive: true, force: true })
	}
})

test('startup recovery observes a durable claim but leaves repairable ownership quarantined without attaching or killing', async () => {
	const value = fixture()
	try {
		value.destination.registry.add(SESSION)
		value.destination.registry.flush()
		value.destination.buffers.save(SESSION, 'snapshot')
		const claim = value.journal.claim({
			sourceProfileId: SOURCE,
			destinationProfileId: DESTINATION,
			sessionId: SESSION,
			sourceSocket: join('/tmp/helm-0', `${SESSION}.sock`),
			destinationSocket: join('/tmp/helm-0', 'profiles', DESTINATION, `${SESSION}.sock`),
			sourceRegistryPath: value.source.registry.filePath,
			destinationRegistryPath: value.destination.registry.filePath,
			sourceBufferPath: join(value.root, SOURCE, 'buffers', `${SESSION}.bin`),
			destinationBufferPath: join(value.root, DESTINATION, 'buffers', `${SESSION}.bin`),
			sourceMeta: value.source.registry.get(SESSION) ?? { createdAt: '' },
			master: {
				pid: 44,
				processStartFingerprint: 'start-44',
				originalSocketPath: join('/tmp/helm-0', `${SESSION}.sock`),
				currentSocketPath: join('/tmp/helm-0', `${SESSION}.sock`),
			},
		})
		assert.ok(claim)
		value.journal.update(claim, 'registries-committed')
		const recovery = await value.adapter.recoverStartup()
		assert.equal(recovery.status, 'quarantined')
		assert.equal(value.journal.load()?.state, 'registries-committed')
		assert.equal(
			value.calls.some(call => call.startsWith('rename:')),
			false,
		)
		assert.equal(
			value.calls.some(call => /kill|signal/i.test(call)),
			false,
		)
	} finally {
		rmSync(value.root, { recursive: true, force: true })
	}
})
