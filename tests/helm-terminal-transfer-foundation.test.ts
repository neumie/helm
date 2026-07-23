import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import * as buffersModule from '../app/src/buffers.ts'
import * as sessionsModule from '../app/src/sessions.ts'
import * as transferModule from '../app/src/terminal-transfer.ts'
import type { TerminalTransferRecoveryObservation } from '../app/src/terminal-transfer.ts'

type BuffersModule = typeof import('../app/src/buffers.ts')
type SessionsModule = typeof import('../app/src/sessions.ts')
type TransferModule = typeof import('../app/src/terminal-transfer.ts')
// tsx loads app modules through a CommonJS interop default in this Node test
// runner, while TypeScript correctly exposes named ESM exports.
const buffers = ((buffersModule as { default?: BuffersModule }).default ?? buffersModule) as BuffersModule
const sessions = ((sessionsModule as { default?: SessionsModule }).default ?? sessionsModule) as SessionsModule
const transfer = ((transferModule as { default?: TransferModule }).default ?? transferModule) as TransferModule
const { BufferStore } = buffers
const { SessionRegistry, socketDirForProfile, socketPathForProfile, socketPathUsable } = sessions
const { TerminalTransferJournalStore, attestTerminalTransferMaster, decideTerminalTransferRecovery } = transfer

function recoveryObservation(
	observation: Omit<TerminalTransferRecoveryObservation, 'masterOwnership'>,
): TerminalTransferRecoveryObservation {
	return { masterOwnership: 'verified', ...observation }
}

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'helm-transfer-'))
}

function journal() {
	return {
		version: 1 as const,
		transferId: 'transfer-1',
		state: 'claimed' as const,
		sourceProfileId: 'work',
		destinationProfileId: 'profile-0123456789ab',
		sessionId: 'aaaa1111',
		sourceSocket: '/tmp/source.sock',
		destinationSocket: '/tmp/destination.sock',
		sourceRegistryPath: '/tmp/source-sessions.json',
		destinationRegistryPath: '/tmp/destination-sessions.json',
		sourceBufferPath: '/tmp/source.bin',
		destinationBufferPath: '/tmp/destination.bin',
		sourceMeta: { createdAt: '2026-07-23T00:00:00.000Z', customName: 'deploy watch', agentRunning: true },
		master: {
			pid: 123,
			processStartFingerprint: '123:456',
			originalSocketPath: '/tmp/source.sock',
			currentSocketPath: '/tmp/source.sock',
		},
		startedAt: '2026-07-23T00:00:00.000Z',
	}
}

test('profile-explicit paths preserve Work legacy root and bound the actual socket path', () => {
	const root = '/tmp/helm-test'
	assert.equal(socketDirForProfile('work', root), root)
	assert.equal(socketDirForProfile('profile-0123456789ab', root), `${root}/profiles/profile-0123456789ab`)
	assert.equal(socketPathForProfile('work', 'aaaa1111', root), `${root}/aaaa1111.sock`)
	assert.equal(socketPathUsable('/x'.repeat(60)), false)
	assert.throws(() => socketDirForProfile('../evil', root))
})

test('registry transfer preserves identity metadata and forces parked ungrouped destination', () => {
	const root = tempDir()
	const source = new SessionRegistry(path.join(root, 'source', 'sessions.json'))
	const destination = new SessionRegistry(path.join(root, 'destination', 'sessions.json'))
	source.add('aaaa1111')
	source.setTitle('aaaa1111', 'vim')
	source.setCustomName('aaaa1111', 'deploy watch')
	source.setOrder(['aaaa1111'])
	source.setActivity('aaaa1111', { agentRunning: true, agentAttention: true })
	source.flush()
	const before = source.get('aaaa1111')?.createdAt
	assert.equal(source.transferTo(destination, 'aaaa1111').status, 'moved')
	assert.equal(source.get('aaaa1111'), undefined)
	assert.deepEqual(destination.get('aaaa1111'), {
		createdAt: before,
		lastTitle: 'vim',
		customName: 'deploy watch',
		order: 0,
		agentRunning: true,
		agentAttention: true,
		parked: true,
		groupId: null,
	})
	const reloaded = new SessionRegistry(path.join(root, 'destination', 'sessions.json'))
	assert.equal(reloaded.get('aaaa1111')?.customName, 'deploy watch')
	assert.equal(reloaded.get('aaaa1111')?.parked, true)
	assert.equal(reloaded.get('aaaa1111')?.groupId, null)
})

test('registry transfer assigns a destination-owned order after existing parked entries', () => {
	const root = tempDir()
	const source = new SessionRegistry(path.join(root, 'source', 'sessions.json'))
	const destination = new SessionRegistry(path.join(root, 'destination', 'sessions.json'))
	source.add('aaaa1111')
	source.setOrder(['aaaa1111'])
	destination.add('bbbb2222')
	destination.add('cccc3333')
	destination.add('dddd4444')
	destination.setParked('bbbb2222', true)
	destination.setParked('cccc3333', true)
	destination.setOrder(['bbbb2222', 'cccc3333', 'dddd4444'])
	source.flush()
	destination.flush()

	assert.equal(source.transferTo(destination, 'aaaa1111').status, 'moved')
	assert.equal(destination.get('bbbb2222')?.order, 0)
	assert.equal(destination.get('cccc3333')?.order, 1)
	assert.equal(destination.get('dddd4444')?.order, 2)
	assert.equal(destination.get('aaaa1111')?.order, 3, 'source order must not leak into destination')
	assert.equal(destination.get('aaaa1111')?.parked, true)
	assert.equal(destination.get('aaaa1111')?.groupId, null)
})

test('registry transfer rejects destination collision and run-owned sessions without writes', () => {
	const root = tempDir()
	const source = new SessionRegistry(path.join(root, 'source.json'))
	const destination = new SessionRegistry(path.join(root, 'destination.json'))
	source.add('aaaa1111')
	destination.add('aaaa1111')
	source.flush()
	destination.flush()
	const before = fs.readFileSync(path.join(root, 'source.json'), 'utf8')
	assert.equal(source.transferTo(destination, 'aaaa1111').status, 'collision')
	assert.equal(fs.readFileSync(path.join(root, 'source.json'), 'utf8'), before)
	destination.remove('aaaa1111')
	destination.flush()
	source.setBacking('aaaa1111', 'run-owned')
	source.flush()
	assert.equal(source.transferTo(destination, 'aaaa1111').status, 'run-owned')
})

test('buffer transfer is same-filesystem rename only and rejects collisions', () => {
	const root = tempDir()
	const sourceDir = path.join(root, 'source')
	const destinationDir = path.join(root, 'destination')
	const source = new BufferStore(sourceDir)
	const destination = new BufferStore(destinationDir)
	assert.equal(source.save('aaaa1111', 'snapshot'), true)
	const before = fs.statSync(path.join(sourceDir, 'aaaa1111.bin'))
	assert.equal(source.moveTo(destination, 'aaaa1111'), 'moved')
	const after = fs.statSync(path.join(destinationDir, 'aaaa1111.bin'))
	assert.equal(fs.existsSync(path.join(sourceDir, 'aaaa1111.bin')), false)
	assert.equal(destination.read('aaaa1111'), 'snapshot')
	assert.equal(after.dev, before.dev)
	assert.equal(after.ino, before.ino, 'rename must retain inode rather than byte-copy')
	assert.equal(source.save('bbbb2222', 'source'), true)
	assert.equal(destination.save('bbbb2222', 'destination'), true)
	assert.equal(source.moveTo(destination, 'bbbb2222'), 'collision')
	assert.equal(source.read('bbbb2222'), 'source')
})

test('global journal claims exclusively and updates atomically', () => {
	const file = path.join(tempDir(), 'terminal-transfer-journal.json')
	const store = new TerminalTransferJournalStore(file, true)
	const input = journal()
	const claimed = store.claim(input)
	assert.ok(claimed)
	assert.equal(store.claim(input), null)
	const moved = store.update(claimed, 'socket-moved')
	assert.equal(store.load()?.state, 'socket-moved')
	assert.equal(moved.master.currentSocketPath, moved.destinationSocket, 'journal records the moved socket identity')
	store.complete(moved)
	assert.equal(store.load(), null)
})

test('master recovery attestation requires the journaled PID, start fingerprint, and both socket identities', () => {
	const record = journal()
	const evidence = {
		state: 'present' as const,
		pid: record.master.pid,
		processStartFingerprint: record.master.processStartFingerprint,
		originalSocketPath: record.master.originalSocketPath,
		currentSocketPath: record.master.currentSocketPath,
	}
	assert.equal(attestTerminalTransferMaster(record, evidence), 'verified')
	assert.equal(attestTerminalTransferMaster(record, { ...evidence, pid: evidence.pid + 1 }), 'mismatch')
	assert.equal(
		attestTerminalTransferMaster(record, { ...evidence, processStartFingerprint: 'reused-pid-start' }),
		'mismatch',
		'PID reuse never authorizes recovery',
	)
	assert.equal(
		attestTerminalTransferMaster(record, { ...evidence, currentSocketPath: record.destinationSocket }),
		'mismatch',
		'a replacement listener at the moved path never authorizes recovery before the move is journaled',
	)
	assert.equal(attestTerminalTransferMaster(record, { state: 'dead' }), 'dead')
	assert.equal(attestTerminalTransferMaster(record, { state: 'unknown' }), 'unknown')
	assert.equal(
		attestTerminalTransferMaster(
			{ ...record, master: { ...record.master, originalSocketPath: '/tmp/other.sock' } },
			evidence,
		),
		'mismatch',
		'incoherent journal socket identities never authorize recovery',
	)
})

test('journal recovery covers every registry, buffer, socket, and master ownership placement between commits', () => {
	const socketPairs = [
		['live', 'live'],
		['live', 'dead'],
		['dead', 'live'],
		['dead', 'dead'],
	] as const
	for (const sourceRegistryHasSession of [false, true]) {
		for (const destinationRegistryHasSession of [false, true]) {
			for (const sourceBufferPresent of [false, true]) {
				for (const destinationBufferPresent of [false, true]) {
					for (const [sourceSocket, destinationSocket] of socketPairs) {
						for (const masterOwnership of ['verified', 'dead', 'unknown', 'mismatch'] as const) {
							const observation = {
								masterOwnership,
								sourceSocket,
								destinationSocket,
								sourceRegistryHasSession,
								destinationRegistryHasSession,
								sourceBufferPresent,
								destinationBufferPresent,
							}
							const buffersConflict = sourceBufferPresent && destinationBufferPresent
							const movedExpected =
								masterOwnership === 'verified' &&
								sourceSocket === 'dead' &&
								destinationSocket === 'live' &&
								sourceRegistryHasSession &&
								!destinationRegistryHasSession &&
								!buffersConflict
							const committedExpected =
								masterOwnership === 'verified' &&
								sourceSocket === 'dead' &&
								destinationSocket === 'live' &&
								destinationRegistryHasSession &&
								!buffersConflict
							const deadCleanupExpected =
								masterOwnership === 'dead' && sourceSocket === 'dead' && destinationSocket === 'dead'
							assert.equal(
								decideTerminalTransferRecovery({ ...journal(), state: 'socket-moved' }, observation).action,
								deadCleanupExpected
									? 'cleanup-dead-sockets'
									: movedExpected
										? 'rollback-destination-transfer'
										: 'quarantine',
								`socket-moved ${JSON.stringify(observation)}`,
							)
							assert.equal(
								decideTerminalTransferRecovery({ ...journal(), state: 'registries-committed' }, observation).action,
								deadCleanupExpected ? 'cleanup-dead-sockets' : committedExpected ? 'repair-destination' : 'quarantine',
								`registries-committed ${JSON.stringify(observation)}`,
							)
						}
					}
				}
			}
		}
	}
})

test('reattach, rollback, repair, and completion require verified master ownership', () => {
	const sourceOwned = recoveryObservation({
		sourceSocket: 'live',
		destinationSocket: 'dead',
		sourceRegistryHasSession: true,
		destinationRegistryHasSession: false,
		sourceBufferPresent: true,
		destinationBufferPresent: false,
	})
	const destinationOwned = recoveryObservation({
		sourceSocket: 'dead',
		destinationSocket: 'live',
		sourceRegistryHasSession: false,
		destinationRegistryHasSession: true,
		sourceBufferPresent: false,
		destinationBufferPresent: true,
	})
	assert.equal(
		decideTerminalTransferRecovery({ ...journal(), state: 'client-detached' }, sourceOwned).action,
		'reattach-source',
	)
	assert.equal(
		decideTerminalTransferRecovery({ ...journal(), state: 'completed' }, destinationOwned).action,
		'remove-completed-journal',
	)
	for (const masterOwnership of ['dead', 'unknown', 'mismatch'] as const) {
		assert.equal(
			decideTerminalTransferRecovery({ ...journal(), state: 'client-detached' }, { ...sourceOwned, masterOwnership })
				.action,
			'quarantine',
			`${masterOwnership} never reattaches`,
		)
		assert.equal(
			decideTerminalTransferRecovery({ ...journal(), state: 'completed' }, { ...destinationOwned, masterOwnership })
				.action,
			'quarantine',
			`${masterOwnership} never removes a completed journal`,
		)
	}
	assert.equal(
		decideTerminalTransferRecovery(
			{ ...journal(), state: 'completed' },
			{ ...destinationOwned, masterOwnership: 'dead', sourceSocket: 'dead', destinationSocket: 'dead' },
		).action,
		'cleanup-dead-sockets',
		'dead ownership only permits explicitly scoped socket-entry cleanup',
	)
})

test('journal recovery repairs destination-first registry commit and quarantines every unknown probe', () => {
	const destinationFirst = recoveryObservation({
		sourceSocket: 'dead' as const,
		destinationSocket: 'live' as const,
		sourceRegistryHasSession: true,
		destinationRegistryHasSession: true,
		sourceBufferPresent: true,
		destinationBufferPresent: false,
	})
	assert.equal(
		decideTerminalTransferRecovery({ ...journal(), state: 'registries-committed' }, destinationFirst).action,
		'repair-destination',
		'destination registry commit before source removal moves the remaining source buffer by rename',
	)
	for (const sourceRegistryHasSession of [false, true]) {
		for (const destinationRegistryHasSession of [false, true]) {
			for (const sourceBufferPresent of [false, true]) {
				for (const destinationBufferPresent of [false, true]) {
					for (const [sourceSocket, destinationSocket] of [
						['unknown', 'live'],
						['unknown', 'dead'],
						['live', 'unknown'],
						['dead', 'unknown'],
					] as const) {
						assert.equal(
							decideTerminalTransferRecovery(
								{ ...journal(), state: 'registries-committed' },
								recoveryObservation({
									sourceSocket,
									destinationSocket,
									sourceRegistryHasSession,
									destinationRegistryHasSession,
									sourceBufferPresent,
									destinationBufferPresent,
								}),
							).action,
							'quarantine',
							'unknown never authorizes cleanup regardless of durable artifact placement',
						)
					}
				}
			}
		}
	}
})

test('journal cleanup requires proven final destination ownership', () => {
	const completed = { ...journal(), state: 'completed' as const }
	assert.equal(
		decideTerminalTransferRecovery(
			completed,
			recoveryObservation({
				sourceSocket: 'dead',
				destinationSocket: 'live',
				sourceRegistryHasSession: false,
				destinationRegistryHasSession: true,
				sourceBufferPresent: false,
				destinationBufferPresent: true,
			}),
		).action,
		'remove-completed-journal',
	)
	assert.equal(
		decideTerminalTransferRecovery(
			completed,
			recoveryObservation({
				sourceSocket: 'dead',
				destinationSocket: 'dead',
				sourceRegistryHasSession: false,
				destinationRegistryHasSession: true,
				sourceBufferPresent: false,
				destinationBufferPresent: true,
			}),
		).action,
		'quarantine',
	)
})
