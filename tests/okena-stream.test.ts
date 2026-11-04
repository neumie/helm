// Okena `/v1/stream` client (src/extensions/okena/stream.ts) against a fake
// server: frame parsing on frames captured live, unix vs TCP auth, malformed and
// oversized frames, 404 (no route), silence detection and clean close.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OkenaClient } from '../src/extensions/okena/client.js'
import {
	type OkenaStreamEnd,
	type OkenaStreamFrame,
	type OkenaStreamSocket,
	decodeServerFrame,
	openOkenaStream,
	parseOkenaStreamFrame,
} from '../src/extensions/okena/stream.js'
import { until } from './helpers/agent-dock'
import { FakeOkenaStreamServer, streamFrameFixture } from './helpers/fake-okena-stream'

function socketDir(): { dir: string; path: string; cleanup(): void } {
	const dir = mkdtempSync(join(tmpdir(), 'oks-'))
	return { dir, path: join(dir, 's.sock'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

interface Recorder {
	opened: number
	frames: OkenaStreamFrame[]
	ends: OkenaStreamEnd[]
	socket: OkenaStreamSocket
}

function connect(
	target: Parameters<typeof openOkenaStream>[0],
	options?: Parameters<typeof openOkenaStream>[2],
): Recorder {
	const recorder = { opened: 0, frames: [], ends: [] } as unknown as Recorder
	recorder.socket = openOkenaStream(
		target,
		{
			onOpen: () => {
				recorder.opened += 1
			},
			onFrame: frame => recorder.frames.push(frame),
			onClose: end => recorder.ends.push(end),
		},
		options,
	)
	return recorder
}

test('frames: the live capture parses; only state_changed carries a version; malformed is null', () => {
	const parsed = streamFrameFixture().map(parseOkenaStreamFrame)
	assert.deepEqual(parsed, [
		{ type: 'auth_ok' },
		{ type: 'other', name: 'usage_changed' },
		{ type: 'other', name: 'system_stats_changed' },
		{ type: 'state_changed', stateVersion: 3358 },
		{ type: 'other', name: 'system_stats_changed' },
	])
	for (const bad of [
		'not json',
		'[]',
		'null',
		'{"type":1}',
		'{"type":""}',
		'{"type":"state_changed"}',
		'{"type":"state_changed","state_version":"7"}',
		'{"type":"state_changed","state_version":-1}',
		'{"type":"state_changed","state_version":1.5}',
	])
		assert.equal(parseOkenaStreamFrame(bad), null, bad)
	assert.deepEqual(parseOkenaStreamFrame('{"type":"auth_failed","error":"authentication required"}'), {
		type: 'auth_failed',
		error: 'authentication required',
	})
})

test('decoder: masked, reserved-bit and oversized server frames are protocol errors; partial is incomplete', () => {
	assert.equal(decodeServerFrame(Buffer.from([0x81]), 100), 'incomplete')
	assert.equal(decodeServerFrame(Buffer.from([0x81, 0x05, 0x61]), 100), 'incomplete')
	assert.deepEqual(decodeServerFrame(Buffer.from([0x81, 0x85, 0, 0, 0, 0, 0]), 100), {
		error: 'masked server frame',
		code: 1002,
	})
	assert.deepEqual(decodeServerFrame(Buffer.from([0xc1, 0x00]), 100), { error: 'reserved bits set', code: 1002 })
	assert.deepEqual(decodeServerFrame(Buffer.from([0x81, 126, 0x01, 0x00]), 100), {
		error: 'message too large',
		code: 1009,
	})
	const big = Buffer.from([0x82, 127, 0xff, 0, 0, 0, 0, 0, 0, 0])
	assert.deepEqual(decodeServerFrame(big, 100), { error: 'message too large', code: 1009 })
})

test('unix socket: auth_ok without a token, state_changed passes (also fragmented), the rest is dropped', async () => {
	const where = socketDir()
	const server = await FakeOkenaStreamServer.listen(where.path)
	try {
		const stream = connect({ endpoint: { kind: 'unixSocket', socketPath: where.path }, token: 'never-sent' })
		await until(() => stream.opened === 1, 'open')
		const connection = server.last
		assert.ok(connection)
		for (const line of streamFrameFixture().slice(1)) connection.sendText(line)
		connection.sendText('garbage {')
		connection.sendText('{"type":"state_changed","state_version":"x"}')
		connection.sendFrame(0x2, Buffer.from([1, 2, 3]))
		const whole = Buffer.from('{"type":"state_changed","state_version":3359}')
		connection.sendFrame(0x1, whole.subarray(0, 10), false)
		connection.sendFrame(0x9, Buffer.from('hi'))
		connection.sendFrame(0x0, whole.subarray(10), true)
		await until(() => stream.frames.filter(frame => frame.type === 'state_changed').length === 2, 'state_changed ×2')
		assert.deepEqual(
			stream.frames.filter(frame => frame.type === 'state_changed'),
			[
				{ type: 'state_changed', stateVersion: 3358 },
				{ type: 'state_changed', stateVersion: 3359 },
			],
		)
		assert.ok(stream.frames.every(frame => frame.type === 'state_changed' || frame.type === 'other'))
		await until(() => connection.received.some(frame => frame.opcode === 0xa), 'pong')
		assert.deepEqual(
			connection.received.map(frame => frame.opcode),
			[0xa],
			'no auth message over the unix socket; only the pong',
		)
		assert.equal(stream.ends.length, 0)
		stream.socket.close()
		await until(() => stream.ends.length === 1, 'closed')
		assert.equal(stream.ends[0]?.opened, true)
		assert.equal(stream.ends[0]?.reason, 'closed')
		assert.ok(
			connection.received.some(frame => frame.opcode === 0x8),
			'a clean close frame',
		)
		stream.socket.close()
		await new Promise(resolve => setTimeout(resolve, 20))
		assert.equal(stream.ends.length, 1, 'onClose exactly once')
	} finally {
		await server.close()
		where.cleanup()
	}
})

test('TCP: the token goes in a first auth message; auth_failed ends the stream as authFailed', async () => {
	const server = await FakeOkenaStreamServer.listen(undefined, { token: 'good' })
	try {
		const baseUrl = `http://127.0.0.1:${server.port}`
		const good = connect({ endpoint: { kind: 'http', baseUrl }, token: 'good' })
		await until(() => good.opened === 1, 'open')
		const auth = JSON.parse(server.last?.received[0]?.payload.toString('utf8') ?? '{}')
		assert.deepEqual(auth, { type: 'auth', token: 'good' })
		good.socket.close()
		await until(() => good.ends.length === 1, 'closed')

		const bad = connect({ endpoint: { kind: 'http', baseUrl }, token: 'stale' })
		await until(() => bad.ends.length === 1, 'auth failed')
		assert.equal(bad.opened, 0)
		assert.equal(bad.ends[0]?.authFailed, true)
		assert.equal(bad.ends[0]?.opened, false)
	} finally {
		await server.close()
	}
})

test('no route: an Okena answering 404 ends with httpStatus 404, never opened', async () => {
	const where = socketDir()
	const server = await FakeOkenaStreamServer.listen(where.path, { notFound: true })
	try {
		const stream = connect({ endpoint: { kind: 'unixSocket', socketPath: where.path } })
		await until(() => stream.ends.length === 1, 'refused')
		assert.equal(stream.ends[0]?.httpStatus, 404)
		assert.equal(stream.ends[0]?.opened, false)
		assert.equal(stream.opened, 0)
	} finally {
		await server.close()
		where.cleanup()
	}
})

test('nothing listening: connect failed, onClose once', async () => {
	const where = socketDir()
	try {
		const stream = connect({ endpoint: { kind: 'unixSocket', socketPath: where.path } })
		await until(() => stream.ends.length === 1, 'failed')
		assert.match(stream.ends[0]?.reason ?? '', /^connect failed/)
	} finally {
		where.cleanup()
	}
})

test('an oversized message closes the stream', async () => {
	const where = socketDir()
	const server = await FakeOkenaStreamServer.listen(where.path)
	try {
		const stream = connect({ endpoint: { kind: 'unixSocket', socketPath: where.path } }, { maxFrameBytes: 64 })
		await until(() => stream.opened === 1, 'open')
		server.last?.sendText(JSON.stringify({ type: 'usage_changed', pad: 'x'.repeat(200) }))
		await until(() => stream.ends.length === 1, 'closed')
		assert.equal(stream.ends[0]?.reason, 'message too large')
	} finally {
		await server.close()
		where.cleanup()
	}
})

test('silence: a quiet stream is pinged; one that answers stays, one that never does is closed', async () => {
	const where = socketDir()
	const server = await FakeOkenaStreamServer.listen(where.path)
	try {
		const alive = connect({ endpoint: { kind: 'unixSocket', socketPath: where.path } }, { silenceMs: 120 })
		await until(() => alive.opened === 1, 'open')
		await new Promise(resolve => setTimeout(resolve, 400))
		assert.equal(alive.ends.length, 0, 'pongs keep it alive')
		assert.ok(
			server.last?.received.some(frame => frame.opcode === 0x9),
			'pinged',
		)
		alive.socket.close()
		await until(() => alive.ends.length === 1, 'closed')

		server.options.answerPings = false
		const dead = connect({ endpoint: { kind: 'unixSocket', socketPath: where.path } }, { silenceMs: 120 })
		await until(() => dead.ends.length === 1, 'silent close', 2_000)
		assert.equal(dead.ends[0]?.reason, 'stream silent')
		assert.equal(dead.ends[0]?.opened, true)
	} finally {
		await server.close()
		where.cleanup()
	}
})

test('silence: a suspension (sleep) is not silence; a stream still dead after it is closed', async () => {
	const where = socketDir()
	const server = await FakeOkenaStreamServer.listen(where.path)
	let offset = 0
	const now = () => Date.now() + offset
	try {
		const alive = connect({ endpoint: { kind: 'unixSocket', socketPath: where.path } }, { silenceMs: 120, now })
		await until(() => alive.opened === 1, 'open')
		// The Mac slept 10 minutes: the next watchdog check comes that late, Okena slept too.
		offset += 600_000
		await new Promise(resolve => setTimeout(resolve, 400))
		assert.deepEqual(alive.ends, [], 'a healthy stream survives the wake (pings answered)')
		alive.socket.close()
		await until(() => alive.ends.length === 1, 'closed')

		server.options.answerPings = false
		const dead = connect({ endpoint: { kind: 'unixSocket', socketPath: where.path } }, { silenceMs: 120, now })
		await until(() => dead.opened === 1, 'open')
		offset += 600_000
		await until(() => dead.ends.length === 1, 'silent close after a fresh window', 2_000)
		assert.equal(dead.ends[0]?.reason, 'stream silent')
	} finally {
		await server.close()
		where.cleanup()
	}
})

test('a daemon that dies mid-stream ends it as closed by Okena', async () => {
	const where = socketDir()
	const server = await FakeOkenaStreamServer.listen(where.path)
	try {
		const stream = connect({ endpoint: { kind: 'unixSocket', socketPath: where.path } })
		await until(() => stream.opened === 1, 'open')
		server.last?.kill()
		await until(() => stream.ends.length === 1, 'closed')
		assert.equal(stream.ends[0]?.reason, 'connection closed by Okena')
	} finally {
		await server.close()
		where.cleanup()
	}
})

test('OkenaClient.streamTarget: endpoint, token, pid and ui_owned from remote.json; null when the daemon is gone', () => {
	const root = mkdtempSync(join(tmpdir(), 'okst-'))
	try {
		const baseDir = join(root, 'config')
		const profileDir = join(baseDir, 'profiles', 'default')
		mkdirSync(profileDir, { recursive: true })
		writeFileSync(join(baseDir, 'profiles.json'), JSON.stringify({ last_used: 'default' }))
		writeFileSync(join(profileDir, 'cli.json'), JSON.stringify({ token: 'tok', token_id: 'id' }))
		const remote = (body: Record<string, unknown>) =>
			writeFileSync(join(profileDir, 'remote.json'), JSON.stringify(body))
		remote({
			port: 19100,
			pid: process.pid,
			ui_owned: true,
			local_endpoint: { kind: 'unix_socket', path: '/tmp/o.sock' },
		})
		assert.deepEqual(new OkenaClient(baseDir).streamTarget(), {
			endpoint: { kind: 'unixSocket', socketPath: '/tmp/o.sock' },
			token: 'tok',
			pid: process.pid,
			uiOwned: true,
		})
		remote({ port: 19101, pid: process.pid })
		assert.deepEqual(new OkenaClient(baseDir, undefined).streamTarget(), {
			endpoint: { kind: 'http', baseUrl: 'http://127.0.0.1:19101' },
			token: 'tok',
			pid: process.pid,
			uiOwned: false,
		})
		remote({ port: 19101, pid: 2 ** 22 + 12_345 })
		assert.equal(new OkenaClient(baseDir).streamTarget(), null, 'dead daemon pid')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
