// A fake Okena `/v1/stream` WebSocket server (RFC 6455, server side) on a unix
// socket or loopback TCP, for the stream client and dock push tests. Speaks only
// what Okena does: 101 upgrade, `auth_ok` (unix: at once; TCP: after a first
// `{"type":"auth","token"}` message), unmasked server frames, pong for ping.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Frames recorded live from Okena's stream (tests/fixtures/okena-claude/stream-frames.ndjson). */
export function streamFrameFixture(): string[] {
	return readFileSync(new URL('../fixtures/okena-claude/stream-frames.ndjson', import.meta.url), 'utf8')
		.split('\n')
		.filter(line => line.length > 0)
}

export interface ClientFrame {
	opcode: number
	payload: Buffer
}

export class FakeStreamConnection {
	readonly received: ClientFrame[] = []
	closed = false
	private buffer = Buffer.alloc(0)

	constructor(
		readonly socket: Socket,
		private readonly server: FakeOkenaStreamServer,
	) {
		socket.on('close', () => {
			this.closed = true
		})
	}

	sendText(text: string): void {
		this.sendFrame(0x1, Buffer.from(text))
	}

	sendFrame(opcode: number, payload: Buffer, fin = true): void {
		if (this.socket.destroyed) return
		const length = payload.length
		const header = length < 126 ? 2 : length < 65_536 ? 4 : 10
		const frame = Buffer.alloc(header + length)
		frame[0] = (fin ? 0x80 : 0) | opcode
		if (length < 126) frame[1] = length
		else if (length < 65_536) {
			frame[1] = 126
			frame.writeUInt16BE(length, 2)
		} else {
			frame[1] = 127
			frame.writeBigUInt64BE(BigInt(length), 2)
		}
		payload.copy(frame, header)
		this.socket.write(frame)
	}

	sendRaw(data: Buffer): void {
		this.socket.write(data)
	}

	/** Drop the connection without a close frame (a crashed daemon). */
	kill(): void {
		this.socket.destroy()
	}

	/** Client frames after the upgrade (unmasked). */
	feed(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk])
		while (this.buffer.length >= 2) {
			const first = this.buffer[0] as number
			const second = this.buffer[1] as number
			let length = second & 0x7f
			let offset = 2
			if (length === 126) {
				if (this.buffer.length < 4) return
				length = this.buffer.readUInt16BE(2)
				offset = 4
			} else if (length === 127) {
				if (this.buffer.length < 10) return
				length = Number(this.buffer.readBigUInt64BE(2))
				offset = 10
			}
			const masked = (second & 0x80) !== 0
			const total = offset + (masked ? 4 : 0) + length
			if (this.buffer.length < total) return
			const mask = masked ? this.buffer.subarray(offset, offset + 4) : null
			const payload = Buffer.from(this.buffer.subarray(total - length, total))
			if (mask) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number)
			this.buffer = this.buffer.subarray(total)
			const frame = { opcode: first & 0x0f, payload }
			this.received.push(frame)
			this.server.onClientFrame(this, frame)
		}
	}
}

export interface FakeStreamOptions {
	/** Answer the upgrade with 404 (an Okena without the route). */
	notFound?: boolean
	/** TCP: the token the first message must carry; otherwise `auth_ok` at once. */
	token?: string
	/** Reply to a protocol ping with a pong (default true). */
	answerPings?: boolean
}

export class FakeOkenaStreamServer {
	readonly connections: FakeStreamConnection[] = []
	upgrades = 0
	options: FakeStreamOptions
	private server: Server

	private constructor(options: FakeStreamOptions) {
		this.options = options
		this.server = createServer(socket => this.accept(socket))
	}

	/** Listen on a unix socket path, or on 127.0.0.1:<random> when `path` is omitted. */
	static async listen(path?: string, options: FakeStreamOptions = {}): Promise<FakeOkenaStreamServer> {
		const fake = new FakeOkenaStreamServer(options)
		await new Promise<void>((resolve, reject) => {
			fake.server.once('error', reject)
			if (path) fake.server.listen(path, resolve)
			else fake.server.listen(0, '127.0.0.1', resolve)
		})
		return fake
	}

	get port(): number {
		const address = this.server.address()
		return typeof address === 'object' && address ? address.port : 0
	}

	get last(): FakeStreamConnection | undefined {
		return this.connections.at(-1)
	}

	/** Connections still open. */
	live(): FakeStreamConnection[] {
		return this.connections.filter(connection => !connection.closed)
	}

	async close(): Promise<void> {
		for (const connection of this.connections) connection.socket.destroy()
		await new Promise<void>(resolve => this.server.close(() => resolve()))
	}

	onClientFrame(connection: FakeStreamConnection, frame: ClientFrame): void {
		if (frame.opcode === 0x9 && this.options.answerPings !== false) connection.sendFrame(0xa, frame.payload)
		if (frame.opcode === 0x8) {
			connection.sendFrame(0x8, frame.payload.subarray(0, 2))
			connection.socket.end()
		}
		if (frame.opcode === 0x1 && this.options.token !== undefined && connection.received.length === 1) {
			let token: unknown
			try {
				token = (JSON.parse(frame.payload.toString('utf8')) as { token?: unknown }).token
			} catch {}
			if (token === this.options.token) connection.sendText('{"type":"auth_ok"}')
			else {
				connection.sendText('{"type":"auth_failed","error":"authentication required"}')
				connection.socket.end()
			}
		}
	}

	private accept(socket: Socket): void {
		let head = Buffer.alloc(0)
		let connection: FakeStreamConnection | null = null
		socket.on('error', () => {})
		socket.on('data', chunk => {
			if (connection) {
				connection.feed(chunk)
				return
			}
			head = Buffer.concat([head, chunk])
			const end = head.indexOf('\r\n\r\n')
			if (end < 0) return
			const request = head.subarray(0, end).toString('latin1')
			const rest = head.subarray(end + 4)
			if (this.options.notFound || !request.startsWith('GET /v1/stream')) {
				socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
				return
			}
			const key = /sec-websocket-key:\s*(\S+)/i.exec(request)?.[1] ?? ''
			const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
			)
			this.upgrades += 1
			connection = new FakeStreamConnection(socket, this)
			this.connections.push(connection)
			if (this.options.token === undefined) connection.sendText('{"type":"auth_ok"}')
			if (rest.length > 0) connection.feed(rest)
		})
	}
}
