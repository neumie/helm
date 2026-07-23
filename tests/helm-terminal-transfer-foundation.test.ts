import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import * as buffersModule from '../app/src/buffers.ts'
import * as sessionsModule from '../app/src/sessions.ts'
import * as transferModule from '../app/src/terminal-transfer.ts'

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
const { TerminalTransferJournalStore, decideTerminalTransferRecovery } = transfer

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
	store.complete(moved)
	assert.equal(store.load(), null)
})

test('journal recovery is state-aware and unknown probe always quarantines', () => {
	const base = {
		sourceSocket: 'live' as const,
		destinationSocket: 'dead' as const,
		sourceRegistryHasSession: true,
		destinationRegistryHasSession: false,
		sourceBufferPresent: true,
		destinationBufferPresent: false,
	}
	assert.equal(decideTerminalTransferRecovery(journal(), base).action, 'source-authoritative')
	assert.equal(
		decideTerminalTransferRecovery({ ...journal(), state: 'client-detached' }, base).action,
		'reattach-source',
	)
	assert.equal(
		decideTerminalTransferRecovery(
			{ ...journal(), state: 'socket-moved' },
			{ ...base, sourceSocket: 'dead', destinationSocket: 'live' },
		).action,
		'rollback-destination-socket',
	)
	assert.equal(
		decideTerminalTransferRecovery(
			{ ...journal(), state: 'registries-committed' },
			{
				...base,
				sourceSocket: 'dead',
				destinationSocket: 'live',
				sourceRegistryHasSession: false,
				destinationRegistryHasSession: true,
			},
		).action,
		'repair-destination',
	)
	assert.equal(decideTerminalTransferRecovery(journal(), { ...base, sourceSocket: 'unknown' }).action, 'quarantine')
	assert.equal(
		decideTerminalTransferRecovery({ ...journal(), state: 'completed' }, base).action,
		'remove-completed-journal',
	)
})
