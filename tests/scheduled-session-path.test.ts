import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import {
	assertScheduledSocketPathUsable,
	ensureScheduledSocketDir,
	probeScheduledSocket,
	scheduledSessionId,
	scheduledSocketPath,
} from '../src/scheduled-runs/session-path.js'

test('scheduled socket path is deterministic, opaque, profile-scoped, and bounded', () => {
	const root = mkdtempSync('/tmp/hs-')
	try {
		const id = scheduledSessionId('run-quoted; $not-a-path')
		assert.match(id, /^sr-[a-z2-7]{32}$/)
		assert.equal(id, scheduledSessionId('run-quoted; $not-a-path'))
		const path = scheduledSocketPath('work', id, root)
		assert.match(path, /\/work\/sr-[a-z2-7]+\.sock$/)
		assert.equal(ensureScheduledSocketDir('work', root), join(root, 'work'))
		assert.throws(() => assertScheduledSocketPathUsable('x'.repeat(104)), /AF_UNIX/)
		assert.throws(() => assertScheduledSocketPathUsable('é'.repeat(52)), /AF_UNIX/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('a namespace symlink is rejected before chmod can change its target mode', () => {
	const root = mkdtempSync('/tmp/hs-link-')
	const target = mkdtempSync('/tmp/hs-target-')
	try {
		chmodSync(target, 0o755)
		const before = statSync(target).mode & 0o777
		symlinkSync(target, join(root, 'work'))
		assert.throws(() => ensureScheduledSocketDir('work', root), /real directory/)
		assert.equal(statSync(target).mode & 0o777, before)
	} finally {
		rmSync(root, { recursive: true, force: true })
		rmSync(target, { recursive: true, force: true })
	}
})

test('scheduled socket probe remains tri-state and only real listener is live', async () => {
	const root = mkdtempSync('/tmp/hp-')
	const socket = scheduledSocketPath('work', scheduledSessionId('run-one'), root)
	ensureScheduledSocketDir('work', root)
	const server = net.createServer()
	try {
		await new Promise<void>((resolve, reject) => server.listen(socket, () => resolve()).once('error', reject))
		assert.equal(await probeScheduledSocket(socket), 'live')
		await new Promise<void>(resolve => server.close(() => resolve()))
		assert.equal(await probeScheduledSocket(socket), 'dead')
	} finally {
		server.close()
		rmSync(root, { recursive: true, force: true })
	}
})
