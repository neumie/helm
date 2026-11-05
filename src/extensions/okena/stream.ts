// Okena's push channel, read-only: a minimal WebSocket client (RFC 6455) for
// `GET /v1/stream`, over the same local endpoint OkenaClient uses (the daemon's
// unix socket, else loopback TCP). Helm reads it as a change signal only:
// `state_changed {state_version}` says "something in /v1/state moved, read it".
//
// The stream sits outside Okena's bearer middleware: a unix-socket peer is
// trusted without a token (okena-remote-server routes/stream.rs), a TCP peer
// authenticates with a first `{"type":"auth","token":…}` message. Helm never
// subscribes to terminals and sends nothing else: no auth on the socket, pong
// for ping, a protocol ping when the stream goes quiet, close for close. Server
// frames are text JSON tagged by `type` (okena-core ws.rs `WsOutbound`,
// snake_case); see parseOkenaStreamFrame. Captured frames:
// tests/fixtures/okena-claude/stream-frames.ndjson.
//
// No dependency: node:http upgrade + a bounded frame parser. Every frame is
// size-capped; a masked or oversized server frame closes the connection.

import { createHash, randomBytes } from 'node:crypto'
import { type ClientRequest, request } from 'node:http'
import type { Socket } from 'node:net'
import type { OkenaEndpoint } from './client.js'

/** Larger frames close the stream (Helm never subscribes to PTY output; JSON frames are small). */
export const OKENA_STREAM_MAX_FRAME_BYTES = 1024 * 1024
/** Upgrade + `auth_ok` must land within this. */
export const OKENA_STREAM_CONNECT_TIMEOUT_MS = 5_000
/**
 * Okena pushes `system_stats_changed` every 2 s on every connection, so a stream
 * quiet for half of this gets a protocol ping, and one silent this long is dead
 * (half-open after sleep, a wedged daemon): close it.
 */
export const OKENA_STREAM_SILENCE_MS = 10_000
/** A close Okena never answers is dropped after this. */
const CLOSE_GRACE_MS = 1_000

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface OkenaStreamEndpoint {
	endpoint: OkenaEndpoint
	/** Sent as the first message on TCP only (a unix-socket peer needs none). */
	token?: string
}

/** A server frame Helm acts on; everything else is `other` (ignored) or null (malformed). */
export type OkenaStreamFrame =
	| { type: 'auth_ok' }
	| { type: 'auth_failed'; error: string }
	| { type: 'state_changed'; stateVersion: number }
	| { type: 'other'; name: string }

/** Parse one text frame. Null = not JSON, no string `type`, or a `state_changed` without a valid version. */
export function parseOkenaStreamFrame(text: string): OkenaStreamFrame | null {
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		return null
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const type = record.type
	if (typeof type !== 'string' || type.length === 0 || type.length > 64) return null
	if (type === 'auth_ok') return { type }
	if (type === 'auth_failed') return { type, error: typeof record.error === 'string' ? record.error.slice(0, 200) : '' }
	if (type === 'state_changed') {
		const version = record.state_version
		if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return null
		return { type, stateVersion: version }
	}
	return { type: 'other', name: type }
}

/** How a stream ended (onClose). */
export interface OkenaStreamEnd {
	/** Short, token-free words for a log line. */
	reason: string
	/** `auth_ok` had arrived (the stream was live). */
	opened: boolean
	/** The server answered the upgrade with this HTTP status instead of 101 (404: an Okena without the route). */
	httpStatus?: number
	/** Okena sent `auth_failed` (TCP with a stale token). */
	authFailed?: boolean
}

export interface OkenaStreamHandlers {
	/** `auth_ok` arrived: the stream is live. */
	onOpen(): void
	/** Every parsed text frame after `auth_ok` (malformed ones are dropped). */
	onFrame(frame: OkenaStreamFrame): void
	/** Exactly once, for any end (including close() and a failed connect). */
	onClose(end: OkenaStreamEnd): void
}

export interface OkenaStreamOptions {
	connectTimeoutMs?: number
	silenceMs?: number
	maxFrameBytes?: number
	/** Clock for the silence watchdog (tests). */
	now?: () => number
}

export interface OkenaStreamSocket {
	/** Close cleanly (close frame, then end). Idempotent; onClose follows. */
	close(): void
}

/** Open `/v1/stream` on `target`. Never throws: every failure ends in onClose. */
export function openOkenaStream(
	target: OkenaStreamEndpoint,
	handlers: OkenaStreamHandlers,
	options: OkenaStreamOptions = {},
): OkenaStreamSocket {
	const maxFrame = options.maxFrameBytes ?? OKENA_STREAM_MAX_FRAME_BYTES
	const silenceMs = options.silenceMs ?? OKENA_STREAM_SILENCE_MS
	const now = options.now ?? Date.now
	const key = randomBytes(16).toString('base64')
	let socket: Socket | null = null
	let ended = false
	let open = false
	/** Why we started closing (the socket's close event reports it). */
	let closing: string | null = null
	let buffer: Buffer = Buffer.alloc(0)
	let fragments: Buffer[] = []
	let fragmentBytes = 0
	let fragmentOpcode = 0
	let lastDataAt = now()
	let pinged = false
	let watchdog: ReturnType<typeof setInterval> | null = null
	let closeTimer: ReturnType<typeof setTimeout> | null = null
	/** Details of a close we started, reported once the socket is gone. */
	let pendingEnd: Partial<OkenaStreamEnd> = {}
	let req: ClientRequest | null = null

	const finish = (reason: string, extra: Partial<OkenaStreamEnd> = {}) => {
		if (ended) return
		ended = true
		clearTimeout(connectTimer)
		if (watchdog) clearInterval(watchdog)
		if (closeTimer) clearTimeout(closeTimer)
		socket?.destroy()
		req?.destroy()
		handlers.onClose({ reason, opened: open, ...extra })
	}
	const send = (opcode: number, payload: Buffer) => {
		if (!socket || socket.destroyed || closing !== null) return
		socket.write(encodeClientFrame(opcode, payload))
	}
	const closeWith = (code: number, reason: string, extra: Partial<OkenaStreamEnd> = {}) => {
		if (ended) return
		if (socket && closing === null && !socket.destroyed) {
			const body = Buffer.alloc(2)
			body.writeUInt16BE(code)
			socket.write(encodeClientFrame(0x8, body))
			closing = reason
			socket.end()
			// A peer that never answers the close: drop it.
			closeTimer = setTimeout(() => finish(reason, extra), CLOSE_GRACE_MS)
			closeTimer.unref?.()
			pendingEnd = extra
			return
		}
		finish(reason, extra)
	}

	const connectTimer = setTimeout(
		() => closeWith(1000, 'connect timeout'),
		options.connectTimeoutMs ?? OKENA_STREAM_CONNECT_TIMEOUT_MS,
	)
	connectTimer.unref?.()

	const endpoint = target.endpoint
	let base: { socketPath: string } | { host: string; port: number }
	try {
		base =
			endpoint.kind === 'unixSocket'
				? { socketPath: endpoint.socketPath }
				: (() => {
						const url = new URL(endpoint.baseUrl)
						return { host: url.hostname, port: Number(url.port) || 80 }
					})()
	} catch {
		base = { host: '127.0.0.1', port: 0 }
	}
	try {
		req = request({
			...base,
			path: '/v1/stream',
			method: 'GET',
			headers: {
				Connection: 'Upgrade',
				Upgrade: 'websocket',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Key': key,
			},
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		queueMicrotask(() => finish(`connect failed: ${message}`))
		return { close: () => finish('closed') }
	}
	req.once('error', error => finish(`connect failed: ${error.message}`))
	req.once('response', res => {
		res.resume()
		finish(`upgrade refused (HTTP ${res.statusCode ?? '?'})`, { httpStatus: res.statusCode ?? 0 })
	})
	req.once('upgrade', (res, upgraded, head) => {
		socket = upgraded
		if (ended) {
			upgraded.destroy()
			return
		}
		const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
		if (res.headers['sec-websocket-accept'] !== accept) {
			finish('bad upgrade (Sec-WebSocket-Accept)')
			return
		}
		upgraded.setNoDelay(true)
		upgraded.on('data', chunk => onData(chunk))
		upgraded.on('error', error => finish(`stream error: ${error.message}`, pendingEnd))
		upgraded.once('close', () => finish(closing ?? 'connection closed by Okena', pendingEnd))
		lastDataAt = now()
		// Quiet for half the silence window: a protocol ping (any reply is data); silent for all of it: dead.
		const checkMs = Math.max(10, Math.floor(silenceMs / 4))
		let checkedAt = lastDataAt
		watchdog = setInterval(() => {
			const at = now()
			const late = at - checkedAt
			checkedAt = at
			// A check this late means Helm (or the Mac) was suspended, Okena with it: the
			// silence is ours, not the stream's. Start a fresh window (ping, then close).
			if (late > silenceMs / 2 + checkMs) {
				lastDataAt = at
				pinged = false
				return
			}
			const quiet = at - lastDataAt
			if (quiet >= silenceMs) closeWith(1000, 'stream silent')
			else if (quiet >= silenceMs / 2 && !pinged) {
				pinged = true
				send(0x9, Buffer.alloc(0))
			}
		}, checkMs)
		watchdog.unref?.()
		if (endpoint.kind === 'http' && target.token)
			send(0x1, Buffer.from(JSON.stringify({ type: 'auth', token: target.token })))
		if (head.length > 0) onData(head)
	})
	req.end()

	function onData(chunk: Buffer): void {
		if (ended) return
		lastDataAt = now()
		pinged = false
		buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
		for (;;) {
			if (ended || closing !== null) return
			const frame = decodeServerFrame(buffer, maxFrame)
			if (frame === 'incomplete') return
			if ('error' in frame) {
				closeWith(frame.code, frame.error)
				return
			}
			buffer = buffer.subarray(frame.size)
			handle(frame.fin, frame.opcode, frame.payload)
		}
	}

	function handle(fin: boolean, opcode: number, payload: Buffer): void {
		if (opcode === 0x8) {
			closeWith(1000, 'closed by Okena')
			return
		}
		if (opcode === 0x9) {
			send(0xa, payload)
			return
		}
		if (opcode === 0xa) return
		if (opcode === 0x0 ? fragmentOpcode === 0 : fragmentOpcode !== 0) {
			closeWith(1002, opcode === 0x0 ? 'unexpected continuation frame' : 'interleaved data frame')
			return
		}
		if (opcode !== 0x0) fragmentOpcode = opcode
		fragmentBytes += payload.length
		if (fragmentBytes > maxFrame) {
			closeWith(1009, 'message too large')
			return
		}
		fragments.push(payload)
		if (!fin) return
		const whole = fragments.length === 1 ? (fragments[0] as Buffer) : Buffer.concat(fragments)
		const textMessage = fragmentOpcode === 0x1
		fragments = []
		fragmentBytes = 0
		fragmentOpcode = 0
		// Binary frames are PTY output for subscribed terminals; Helm subscribes to none.
		if (!textMessage) return
		const parsed = parseOkenaStreamFrame(whole.toString('utf8'))
		if (!parsed) return
		if (!open) {
			if (parsed.type === 'auth_ok') {
				open = true
				clearTimeout(connectTimer)
				handlers.onOpen()
			} else if (parsed.type === 'auth_failed') closeWith(1000, 'auth failed', { authFailed: true })
			return
		}
		handlers.onFrame(parsed)
	}

	return { close: () => closeWith(1000, 'closed') }
}

type DecodedFrame =
	| { fin: boolean; opcode: number; payload: Buffer; size: number }
	| { error: string; code: number }
	| 'incomplete'

/** One server frame from the front of `data` (servers never mask). Exported for tests. */
export function decodeServerFrame(data: Buffer, maxPayload: number): DecodedFrame {
	if (data.length < 2) return 'incomplete'
	const first = data[0] as number
	const second = data[1] as number
	if ((first & 0x70) !== 0) return { error: 'reserved bits set', code: 1002 }
	if ((second & 0x80) !== 0) return { error: 'masked server frame', code: 1002 }
	const opcode = first & 0x0f
	if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) return { error: `unknown opcode ${opcode}`, code: 1002 }
	let length = second & 0x7f
	let offset = 2
	if (length === 126) {
		if (data.length < 4) return 'incomplete'
		length = data.readUInt16BE(2)
		offset = 4
	} else if (length === 127) {
		if (data.length < 10) return 'incomplete'
		const big = data.readBigUInt64BE(2)
		if (big > BigInt(maxPayload)) return { error: 'message too large', code: 1009 }
		length = Number(big)
		offset = 10
	}
	if (length > maxPayload) return { error: 'message too large', code: 1009 }
	if (data.length < offset + length) return 'incomplete'
	return {
		fin: (first & 0x80) !== 0,
		opcode,
		payload: data.subarray(offset, offset + length),
		size: offset + length,
	}
}

/** One masked client frame (FIN set). */
function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
	const mask = randomBytes(4)
	const length = payload.length
	const header = length < 126 ? 2 : length < 65_536 ? 4 : 10
	const frame = Buffer.alloc(header + 4 + length)
	frame[0] = 0x80 | opcode
	if (length < 126) frame[1] = 0x80 | length
	else if (length < 65_536) {
		frame[1] = 0x80 | 126
		frame.writeUInt16BE(length, 2)
	} else {
		frame[1] = 0x80 | 127
		frame.writeBigUInt64BE(BigInt(length), 2)
	}
	mask.copy(frame, header)
	for (let i = 0; i < length; i++) frame[header + 4 + i] = (payload[i] as number) ^ (mask[i % 4] as number)
	return frame
}
