import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BufferStore as BufferStoreType } from '../app/src/buffers'
import type { SessionRegistry as SessionRegistryType } from '../app/src/sessions'
import type { TerminalTransferJournalStore as TerminalTransferJournalStoreType } from '../app/src/terminal-transfer'
import type {
	TerminalTransferAdmission,
	TerminalTransferCoordinatorDeps,
	TerminalTransferCoordinator as TerminalTransferCoordinatorType,
	TerminalTransferRequest,
} from '../app/src/terminal-transfer-coordinator'

const buffersModule = (await import('../app/src/buffers')) as unknown as { BufferStore: typeof BufferStoreType }
const sessionsModule = (await import('../app/src/sessions')) as unknown as {
	SessionRegistry: typeof SessionRegistryType
}
const transferModule = (await import('../app/src/terminal-transfer')) as unknown as {
	TerminalTransferJournalStore: typeof TerminalTransferJournalStoreType
}
const coordinatorModule = (await import('../app/src/terminal-transfer-coordinator')) as unknown as {
	TerminalTransferCoordinator: typeof TerminalTransferCoordinatorType
}
const { BufferStore } = buffersModule
const { SessionRegistry } = sessionsModule
const { TerminalTransferJournalStore } = transferModule
const { TerminalTransferCoordinator } = coordinatorModule

const SESSION_ID = 'term-1234'

interface Fixture {
	dir: string
	request: TerminalTransferRequest
	journal: InstanceType<typeof TerminalTransferJournalStore>
	deps: TerminalTransferCoordinatorDeps
	calls: string[]
	admission: TerminalTransferAdmission
}

function fixture(overrides: Partial<TerminalTransferCoordinatorDeps> = {}): Fixture {
	const dir = mkdtempSync(join(tmpdir(), 'helm-transfer-coordinator-'))
	const sourceRegistry = new SessionRegistry(join(dir, 'source-sessions.json'))
	const destinationRegistry = new SessionRegistry(join(dir, 'destination-sessions.json'))
	sourceRegistry.add(SESSION_ID)
	sourceRegistry.setTitle(SESSION_ID, 'deploy watch')
	sourceRegistry.setActivity(SESSION_ID, { agentRunning: true, agentAttention: false })
	sourceRegistry.flush()
	const sourceBuffers = new BufferStore(join(dir, 'source-buffers'))
	const destinationBuffers = new BufferStore(join(dir, 'destination-buffers'))
	sourceBuffers.save(SESSION_ID, 'snapshot')
	const journal = new TerminalTransferJournalStore(join(dir, 'journal.json'), true)
	const calls: string[] = []
	const admission: TerminalTransferAdmission = {
		async prepare() {
			calls.push('prepare')
			return { snapshotFlushed: true, activity: { agentRunning: true, agentAttention: false } }
		},
		async detachAttachClient() {
			calls.push('detach')
		},
		async checkpoint() {
			calls.push('checkpoint')
			return { snapshotFlushed: true, activity: { agentRunning: true, agentAttention: false } }
		},
		async commitSource() {
			calls.push('commit-source')
		},
		async rollbackSource() {
			calls.push('rollback-source')
		},
		async attachSourceClient() {
			calls.push('attach-source')
		},
		release({ quarantined }) {
			calls.push(`release:${quarantined}`)
		},
	}
	const request: TerminalTransferRequest = {
		sourceProfileId: 'work',
		destinationProfileId: 'profile-123456789abc',
		sessionId: SESSION_ID,
		sourceSocket: join(dir, 'source.sock'),
		destinationSocket: join(dir, 'destination.sock'),
		sourceRegistry,
		destinationRegistry,
		sourceBuffers,
		destinationBuffers,
		sourceBufferPath: join(dir, 'source-buffers', `${SESSION_ID}.bin`),
		destinationBufferPath: join(dir, 'destination-buffers', `${SESSION_ID}.bin`),
		master: {
			pid: 71,
			processStartFingerprint: 'started-71',
			originalSocketPath: join(dir, 'source.sock'),
			currentSocketPath: join(dir, 'source.sock'),
		},
	}
	const deps: TerminalTransferCoordinatorDeps = {
		journal,
		async runExclusive(operation) {
			return operation()
		},
		async beginAdmission() {
			calls.push('admit')
			return admission
		},
		async renameSocket(source, destination) {
			calls.push(`rename:${source === request.sourceSocket ? 'forward' : 'backward'}`)
			assert.ok(destination === request.destinationSocket || destination === request.sourceSocket)
		},
		async attestMaster(activeJournal) {
			return {
				state: 'present',
				pid: activeJournal.master.pid,
				processStartFingerprint: activeJournal.master.processStartFingerprint,
				originalSocketPath: activeJournal.master.originalSocketPath,
				currentSocketPath: activeJournal.master.currentSocketPath,
			}
		},
		async observeRecovery() {
			return {
				masterOwnership: 'verified',
				sourceSocket: 'dead',
				destinationSocket: 'live',
				sourceRegistryHasSession: false,
				destinationRegistryHasSession: true,
				sourceBufferPresent: false,
				destinationBufferPresent: true,
			}
		},
		async cleanupDeadSockets() {
			calls.push('cleanup-dead')
		},
		...overrides,
	}
	return { dir, request, journal, deps, calls, admission }
}

function dispose(value: Fixture): void {
	rmSync(value.dir, { recursive: true, force: true })
}

test('moves an ordinary terminal through snapshot fence, attestation, destination-first metadata, and destination attach', async () => {
	const value = fixture()
	try {
		const result = await new TerminalTransferCoordinator(value.deps).move(value.request)
		assert.equal(result.status, 'moved')
		assert.deepEqual(value.calls, [
			'admit',
			'prepare',
			'detach',
			'checkpoint',
			'rename:forward',
			'commit-source',
			'release:false',
		])
		assert.equal(value.request.sourceRegistry.get(SESSION_ID), undefined)
		const moved = value.request.destinationRegistry.get(SESSION_ID)
		assert.ok(moved)
		assert.equal(moved.parked, true)
		assert.equal(moved.groupId, null)
		assert.equal(value.request.sourceBuffers.read(SESSION_ID), null)
		assert.equal(value.request.destinationBuffers.read(SESSION_ID), 'snapshot')
		assert.equal(value.journal.load(), null)
	} finally {
		dispose(value)
	}
})

test('quarantines without detaching when prepare acknowledgement does not confirm the flushed snapshot', async () => {
	const value = fixture({
		async beginAdmission() {
			return {
				...value.admission,
				async prepare() {
					value.calls.push('prepare')
					return { snapshotFlushed: false, activity: { agentRunning: true, agentAttention: false } }
				},
			}
		},
	})
	try {
		const result = await new TerminalTransferCoordinator(value.deps).move(value.request)
		assert.equal(result.status, 'quarantined')
		assert.deepEqual(value.calls, ['prepare', 'release:true'])
		assert.equal(value.journal.load()?.state, 'rollback-needed')
	} finally {
		dispose(value)
	}
})

test('quarantines before rename when the stable post-detach snapshot is not acknowledged', async () => {
	const value = fixture({
		async beginAdmission() {
			return {
				...value.admission,
				async checkpoint() {
					value.calls.push('checkpoint')
					return { snapshotFlushed: false, activity: { agentRunning: true, agentAttention: false } }
				},
			}
		},
	})
	try {
		const result = await new TerminalTransferCoordinator(value.deps).move(value.request)
		assert.equal(result.status, 'quarantined')
		assert.deepEqual(value.calls, ['prepare', 'detach', 'checkpoint', 'release:true'])
		assert.equal(value.journal.load()?.state, 'rollback-needed')
	} finally {
		dispose(value)
	}
})

test('quarantines before rename when the captured master cannot be attested', async () => {
	const value = fixture({
		async attestMaster() {
			return { state: 'unknown' }
		},
	})
	try {
		const result = await new TerminalTransferCoordinator(value.deps).move(value.request)
		assert.equal(result.status, 'quarantined')
		assert.equal(value.calls.includes('detach'), true)
		assert.equal(
			value.calls.some(call => call.startsWith('rename:')),
			false,
		)
		assert.equal(value.journal.load()?.state, 'rollback-needed')
	} finally {
		dispose(value)
	}
})

test('rolls source socket and snapshot back when destination buffer ownership cannot be established', async () => {
	const value = fixture()
	value.request.destinationBuffers.save(SESSION_ID, 'occupied')
	try {
		const result = await new TerminalTransferCoordinator(value.deps).move(value.request)
		assert.equal(result.status, 'quarantined')
		assert.match(result.reason, /buffer move collision; source transfer rolled back/)
		assert.equal(value.calls.includes('rename:backward'), true)
		assert.equal(value.calls.includes('attach-source'), true)
		assert.equal(value.request.sourceRegistry.get(SESSION_ID)?.lastTitle, 'deploy watch')
		assert.equal(value.request.destinationRegistry.get(SESSION_ID), undefined)
		assert.equal(value.journal.load(), null)
	} finally {
		dispose(value)
	}
})

test('rejects run-owned and destination-collision sessions before claiming a journal', async () => {
	const runOwned = fixture()
	try {
		runOwned.request.sourceRegistry.setBacking(SESSION_ID, 'run-owned')
		runOwned.request.sourceRegistry.flush()
		const runOwnedResult = await new TerminalTransferCoordinator(runOwned.deps).move(runOwned.request)
		assert.deepEqual(runOwnedResult, { status: 'rejected', reason: 'run-owned' })
		assert.equal(runOwned.journal.load(), null)
	} finally {
		dispose(runOwned)
	}

	const collision = fixture()
	try {
		collision.request.destinationRegistry.add(SESSION_ID)
		collision.request.destinationRegistry.flush()
		const collisionResult = await new TerminalTransferCoordinator(collision.deps).move(collision.request)
		assert.deepEqual(collisionResult, { status: 'rejected', reason: 'collision' })
		assert.equal(collision.journal.load(), null)
	} finally {
		dispose(collision)
	}
})

test('startup recovery leaves a repairable destination claim fenced until live session adapters are wired', async () => {
	const value = fixture()
	try {
		const claimed = value.journal.claim({
			sourceProfileId: value.request.sourceProfileId,
			destinationProfileId: value.request.destinationProfileId,
			sessionId: SESSION_ID,
			sourceSocket: value.request.sourceSocket,
			destinationSocket: value.request.destinationSocket,
			sourceRegistryPath: value.request.sourceRegistry.filePath,
			destinationRegistryPath: value.request.destinationRegistry.filePath,
			sourceBufferPath: value.request.sourceBufferPath,
			destinationBufferPath: value.request.destinationBufferPath,
			sourceMeta: value.request.sourceRegistry.get(SESSION_ID) ?? { createdAt: '' },
			master: value.request.master,
		})
		assert.ok(claimed)
		const completed = value.journal.update(claimed, 'registries-committed')
		const recovery = await new TerminalTransferCoordinator(value.deps).recoverStartup()
		assert.deepEqual(recovery, {
			status: 'quarantined',
			reason: 'destination socket and registry are authoritative; buffer is destination-owned',
		})
		assert.equal(value.journal.load()?.transferId, completed.transferId)
	} finally {
		dispose(value)
	}
})

test('busy interlock refuses a concurrent move while the global exclusive transaction is occupied', async () => {
	const gate: { release: (() => void) | null } = { release: null }
	const value = fixture({
		async runExclusive(operation) {
			await new Promise<void>(resolve => {
				gate.release = resolve
			})
			return operation()
		},
	})
	try {
		const coordinator = new TerminalTransferCoordinator(value.deps)
		const first = coordinator.move(value.request)
		await new Promise(resolve => setImmediate(resolve))
		const second = await coordinator.move(value.request)
		assert.deepEqual(second, { status: 'busy' })
		const releaseFirst = gate.release
		if (releaseFirst === null) throw new Error('exclusive transaction did not begin')
		releaseFirst()
		const firstResult = await first
		assert.equal(firstResult.status, 'moved')
	} finally {
		dispose(value)
	}
})
