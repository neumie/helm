import { request } from 'node:http'
import type { InformationClientValue } from './information-client.js'
import {
	INFORMATION_HEADER,
	INFORMATION_PUBLISH_BYTES,
	INFORMATION_RESPONSE_RESERVE,
	informationEnvelopeSchema,
} from './information-protocol.js'
import type { RemoteEnrollmentFile } from './private-file.js'
import type { RemoteTarget } from './protocol.js'

/** One connection's independent publisher. The source client is lifecycle-owned. */
export class RemoteInformationPublisher {
	private sequence = 0
	private nextAt = 0
	private active: AbortController | undefined
	private disposed = false
	private support = false
	private epoch: string | undefined

	constructor(
		private readonly enrollment: RemoteEnrollmentFile,
		private readonly target: RemoteTarget,
		private readonly read: () => InformationClientValue | null,
		private readonly current: () => boolean,
	) {}

	negotiate(epoch: string, supported: boolean): void {
		if (this.disposed) return
		if (this.epoch !== epoch || this.support !== supported) this.active?.abort()
		this.epoch = epoch
		this.support = supported
	}

	/** Called by the live observer, but never awaited by its exchange loop. */
	publish(): void {
		const epoch = this.epoch
		if (
			this.disposed ||
			!this.support ||
			!epoch ||
			this.active ||
			!this.current() ||
			Date.now() < this.nextAt ||
			this.sequence === Number.MAX_SAFE_INTEGER
		)
			return
		this.nextAt = Date.now() + 1000
		const controller = new AbortController()
		this.active = controller
		const valid = () =>
			!this.disposed &&
			this.support &&
			this.epoch === epoch &&
			this.active === controller &&
			!controller.signal.aborted &&
			this.current()
		try {
			const value = this.read()
			if (!value || !valid()) {
				this.active = undefined
				return
			}
			const envelope = informationEnvelopeSchema.parse({
				version: 1,
				hostEpoch: epoch,
				target: this.target,
				sequence: ++this.sequence,
				footer: value.footer,
				sidebar: value.sidebar,
			})
			if (!valid()) {
				this.active = undefined
				return
			}
			void postInformation(this.enrollment, JSON.stringify(envelope), controller.signal)
				.then(() => {
					if (!valid()) return
				})
				.catch(() => {})
				.finally(() => {
					if (this.active === controller) this.active = undefined
				})
		} catch {
			if (this.active === controller) this.active = undefined
		}
	}

	dispose(): void {
		this.disposed = true
		this.active?.abort()
		this.active = undefined
	}
}

/** No retry or liveness effect; absolute deadline includes trickled responses. */
export function postInformation(enrollment: RemoteEnrollmentFile, body: string, signal: AbortSignal): Promise<void> {
	if (Buffer.byteLength(body) > INFORMATION_PUBLISH_BYTES) return Promise.reject(new Error('information_limit'))
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath: enrollment.socketPath,
				path: '/extension-information',
				method: 'POST',
				signal,
				headers: {
					Authorization: `Bearer ${enrollment.capability}`,
					'X-Helm-Enrollment': enrollment.enrollmentId,
					[INFORMATION_HEADER]: '1',
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body),
				},
			},
			res => {
				let bytes = 0
				res.on('data', (chunk: Buffer) => {
					bytes += chunk.length
					if (bytes > INFORMATION_RESPONSE_RESERVE) res.destroy(new Error('information_ack_limit'))
				})
				res.on('error', reject)
				res.on('aborted', () => reject(new Error('information_ack_aborted')))
				res.on('end', () => {
					if (res.complete && res.statusCode === 200 && res.headers[INFORMATION_HEADER.toLowerCase()] === '1') resolve()
					else reject(new Error('information_ack_refused'))
				})
			},
		)
		const deadline = setTimeout(() => req.destroy(new Error('information_timeout')), 2000)
		deadline.unref()
		req.on('close', () => clearTimeout(deadline))
		req.on('error', reject)
		req.end(body)
	})
}
