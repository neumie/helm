import { request } from 'node:http'
import { REMOTE_DEVICE_DOCUMENT_BYTES } from './access.js'

const MAX_RUNTIME_SETUP_BYTES = 8192
/** Matches the runtime's largest private control projection plus its envelope. */
export const REMOTE_CONTROL_RESPONSE_BYTES = Math.max(REMOTE_DEVICE_DOCUMENT_BYTES, MAX_RUNTIME_SETUP_BYTES) + 1024

export interface RemoteControlResponse {
	status: number
	body: unknown
}

/**
 * Bounded Node-only transport for the owner-private Remote control socket.
 * Callers own route selection and validate every response before projecting it.
 */
export function remoteControlRequest(
	socketPath: string,
	token: string,
	path: string,
	body?: unknown,
): Promise<RemoteControlResponse> {
	return new Promise((resolvePromise, reject) => {
		let data: string | undefined
		try {
			data = body === undefined ? undefined : JSON.stringify(body)
		} catch {
			reject(new Error('Invalid Remote control request'))
			return
		}
		if (data !== undefined && Buffer.byteLength(data) > 16 * 1024) {
			reject(new Error('Remote control request too large'))
			return
		}
		const req = request(
			{
				socketPath,
				path,
				method: data ? 'POST' : 'GET',
				headers: {
					Authorization: `Bearer ${token}`,
					...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
				},
			},
			response => {
				const parts: Buffer[] = []
				let length = 0
				response.on('data', (part: Buffer) => {
					length += part.length
					if (length > REMOTE_CONTROL_RESPONSE_BYTES) response.destroy(new Error('Remote control response too large'))
					else parts.push(part)
				})
				response.on('error', reject)
				response.on('aborted', () => reject(new Error('Remote control response aborted')))
				response.on('end', () => {
					if (!response.complete) return reject(new Error('Remote control response aborted'))
					try {
						resolvePromise({
							status: response.statusCode ?? 0,
							body: JSON.parse(Buffer.concat(parts).toString('utf8')),
						})
					} catch {
						reject(new Error('Invalid Remote control response'))
					}
				})
			},
		)
		req.on('error', reject)
		req.setTimeout(2000, () => req.destroy(new Error('Remote control timeout')))
		if (data) req.end(data)
		else req.end()
	})
}
