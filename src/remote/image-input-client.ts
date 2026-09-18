import { createHash } from 'node:crypto'
import { request } from 'node:http'
import type { RemoteAdmission, RemoteAdmissionTicket } from './admission.js'
import { inspectJpegForProcessed } from './image-input-bytes.js'
import { IMAGE_INPUT_HEADER, IMAGE_SUBMISSION_MAX_BYTES, type RemoteImageReference } from './image-input-protocol.js'
import type { RemoteEnrollmentFile } from './private-file.js'
import {
	REMOTE_PROTOCOL,
	type RemoteCommand,
	type RemoteReceipt,
	type RemoteTarget,
	sameRemoteTarget,
} from './protocol.js'

const RETRIEVAL_TTL_MS = 2_000
const RESPONSE_BYTES = 1_572_864
const MAX_QUEUED = 8

export interface RemotePreparedImage {
	type: 'image'
	data: string
	mimeType: 'image/jpeg'
}

interface PromptWork {
	command: Readonly<RemoteCommand>
	expiresAt: number
	ticket: RemoteAdmissionTicket
	generation: symbol
	controller: AbortController
	preparationDeadline?: number
	settled: boolean
}

export interface RemoteImageInputCallbacks {
	current(hostEpoch: string, generation: symbol, images: boolean): boolean
	invoke(command: Readonly<RemoteCommand>, images: readonly RemotePreparedImage[]): RemoteReceipt['status']
	receipt(receipt: RemoteReceipt): void
}

/** One bounded FIFO prompt preparation lane for one Pi observation. */
export class RemoteImageInputClient {
	private readonly queue: PromptWork[] = []
	private active?: PromptWork
	private disposed = false
	private hostEpoch: string | null = null
	private transport = false
	private generation = Symbol()

	constructor(
		private readonly enrollment: RemoteEnrollmentFile,
		private readonly target: RemoteTarget,
		private readonly admission: RemoteAdmission,
		private readonly callbacks: RemoteImageInputCallbacks,
		private readonly now: () => number = Date.now,
	) {}

	negotiate(hostEpoch: string, supported: boolean): void {
		if (this.hostEpoch && this.hostEpoch !== hostEpoch) this.cancelUninvoked()
		this.hostEpoch = hostEpoch
		this.transport = supported
		if (!supported) this.cancelUninvoked()
	}

	rotateSupport(): void {
		this.generation = Symbol()
		this.cancelUninvoked()
	}

	submit(command: RemoteCommand, expiresAt: number): RemoteReceipt {
		const prepared = this.admission.prepare(command, expiresAt)
		if (!prepared.ticket) return prepared.receipt
		const work: PromptWork = {
			command,
			expiresAt,
			ticket: prepared.ticket,
			generation: this.generation,
			controller: new AbortController(),
			settled: false,
		}
		if (this.active || this.queue.length) {
			if (this.queue.length >= MAX_QUEUED) return this.reject(work)
			this.queue.push(work)
		} else if (command.operation.kind === 'prompt' && !command.operation.images?.length) {
			return this.commit(work, [])
		} else {
			this.queue.push(work)
			this.pump()
		}
		return prepared.receipt
	}

	cancelUninvoked(): void {
		if (this.active) this.reject(this.active)
		for (const work of this.queue.splice(0)) this.reject(work)
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.transport = false
		this.cancelUninvoked()
	}

	private pump(): void {
		if (this.disposed || this.active || !this.queue.length) return
		const work = this.queue.shift()
		if (!work) return
		this.active = work
		if (work.command.operation.kind !== 'prompt' || !work.command.operation.images?.length) {
			this.commit(work, [])
			this.active = undefined
			this.pump()
			return
		}
		void this.prepareImages(work)
			.then(images => this.commit(work, images))
			.catch(() => this.reject(work))
			.finally(() => {
				if (this.active === work) this.active = undefined
				this.pump()
			})
	}

	private live(work: PromptWork): boolean {
		const images = work.command.operation.kind === 'prompt' && !!work.command.operation.images?.length
		const now = this.now()
		return (
			!this.disposed &&
			!work.controller.signal.aborted &&
			this.hostEpoch !== null &&
			now < work.expiresAt &&
			(work.preparationDeadline === undefined || now < work.preparationDeadline) &&
			(!images || (this.transport && work.generation === this.generation)) &&
			sameRemoteTarget(work.command.target, this.target) &&
			this.callbacks.current(this.hostEpoch, work.generation, images)
		)
	}

	private async prepareImages(work: PromptWork): Promise<RemotePreparedImage[]> {
		if (work.command.operation.kind !== 'prompt' || !work.command.operation.images?.length)
			throw new Error('image_unavailable')
		work.preparationDeadline ??= Math.min(work.expiresAt, this.now() + RETRIEVAL_TTL_MS)
		if (!this.live(work)) throw new Error('image_unavailable')
		const refs = work.command.operation.images
		if (refs.reduce((sum, image) => sum + image.bytes, 0) > IMAGE_SUBMISSION_MAX_BYTES) throw new Error('image_limit')
		const deadline = work.preparationDeadline
		const output = new Array<RemotePreparedImage>(refs.length)
		let cursor = 0
		const worker = async () => {
			for (;;) {
				const index = cursor++
				if (index >= refs.length) return
				if (!this.live(work)) throw new Error('image_unavailable')
				const bytes = await this.retrieve(work, refs[index], deadline)
				if (!this.live(work)) throw new Error('image_unavailable')
				const dimensions = inspectJpegForProcessed(bytes)
				if (!this.live(work)) throw new Error('image_unavailable')
				const ref = refs[index]
				if (
					bytes.byteLength !== ref.bytes ||
					dimensions.width !== ref.width ||
					dimensions.height !== ref.height ||
					createHash('sha256').update(bytes).digest('hex') !== ref.sha256
				)
					throw new Error('image_mismatch')
				const data = Buffer.from(bytes).toString('base64')
				if (!this.live(work)) throw new Error('image_unavailable')
				output[index] = { type: 'image', data, mimeType: 'image/jpeg' }
			}
		}
		await Promise.all(Array.from({ length: Math.min(2, refs.length) }, () => worker()))
		if (!this.live(work)) throw new Error('image_unavailable')
		return output
	}

	private retrieve(work: PromptWork, image: RemoteImageReference, deadline: number): Promise<Uint8Array> {
		return new Promise((resolve, reject) => {
			if (!this.hostEpoch || !this.live(work)) return reject(new Error('image_unavailable'))
			const body = JSON.stringify({
				protocol: REMOTE_PROTOCOL,
				hostEpoch: this.hostEpoch,
				target: this.target,
				commandId: work.command.commandId,
				image,
			})
			const req = request(
				{
					socketPath: this.enrollment.socketPath,
					path: '/image-input',
					method: 'POST',
					headers: {
						Authorization: `Bearer ${this.enrollment.capability}`,
						'X-Helm-Enrollment': this.enrollment.enrollmentId,
						[IMAGE_INPUT_HEADER]: '1',
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(body),
					},
				},
				response => {
					const chunks: Buffer[] = []
					let size = 0
					response.on('data', (chunk: Buffer) => {
						size += chunk.length
						if (size > RESPONSE_BYTES || size > image.bytes) response.destroy(new Error('image_limit'))
						else chunks.push(chunk)
					})
					response.once('error', reject)
					response.once('aborted', () => reject(new Error('image_aborted')))
					response.once('end', () => {
						if (
							response.statusCode !== 200 ||
							response.headers[IMAGE_INPUT_HEADER.toLowerCase()] !== '1' ||
							response.headers['content-type'] !== 'image/jpeg' ||
							response.headers['content-length'] !== String(image.bytes) ||
							!response.complete ||
							size !== image.bytes
						)
							return reject(new Error('image_refused'))
						resolve(Buffer.concat(chunks))
					})
				},
			)
			const abort = () => req.destroy(new Error('image_cancelled'))
			work.controller.signal.addEventListener('abort', abort, { once: true })
			const timer = setTimeout(abort, Math.max(0, deadline - this.now()))
			timer.unref?.()
			const settle =
				<T>(callback: (value: T) => void) =>
				(value: T) => {
					clearTimeout(timer)
					work.controller.signal.removeEventListener('abort', abort)
					callback(value)
				}
			req.once('error', settle(reject))
			req.once('close', () => {
				clearTimeout(timer)
				work.controller.signal.removeEventListener('abort', abort)
			})
			req.end(body)
		})
	}

	private commit(work: PromptWork, images: readonly RemotePreparedImage[]): RemoteReceipt {
		if (work.settled) return { commandId: work.command.commandId, status: 'rejected' }
		work.settled = true
		const receipt = this.admission.commit(
			work.ticket,
			() => this.live(work),
			command => this.callbacks.invoke(command, images),
		) ?? { commandId: work.command.commandId, status: 'rejected' }
		this.callbacks.receipt(receipt)
		return receipt
	}

	private reject(work: PromptWork): RemoteReceipt {
		if (work.settled) return { commandId: work.command.commandId, status: 'rejected' }
		work.settled = true
		work.controller.abort()
		const receipt = this.admission.reject(work.ticket) ?? {
			commandId: work.command.commandId,
			status: 'rejected' as const,
		}
		this.callbacks.receipt(receipt)
		return receipt
	}
}
