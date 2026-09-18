import { type InformationResponse, informationResponseSchema } from '../../../../src/remote/information-protocol.js'
import { sameRemoteTarget } from '../../../../src/remote/protocol.js'
import { type InformationTarget, RemoteAccessError, type RemoteTransport } from './transport.js'

export interface InformationState {
	status: 'available' | 'unavailable' | 'unsupported' | 'access-ended'
	information: InformationResponse['information']
}
const unavailable: InformationState = { status: 'unavailable', information: null }
export interface InformationClock {
	now(): number
	set(callback: () => void, ms: number): ReturnType<typeof setTimeout>
	clear(timer: ReturnType<typeof setTimeout>): void
}
const clock: InformationClock = {
	now: () => performance.now(),
	set: (fn, ms) => setTimeout(fn, ms),
	clear: timer => clearTimeout(timer),
}

/** One selected owner; no receipt, history, liveness, or persistence side effects. */
export class RemoteInformationController {
	private state = unavailable
	private signature = JSON.stringify(unavailable)
	private listeners = new Set<() => void>()
	private available = false
	private visible = true
	private disposed = false
	private refused = false
	private generation = 0
	private request: AbortController | null = null
	private next: ReturnType<typeof setTimeout> | undefined
	private expiry: ReturnType<typeof setTimeout> | undefined
	private deadline = 0
	private lastStart = Number.NEGATIVE_INFINITY
	constructor(
		private transport: RemoteTransport,
		private owner: InformationTarget,
		private time = clock,
	) {}
	getSnapshot = (): InformationState => this.state
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	setAvailable(value: boolean): void {
		if (this.available === value || this.disposed) return
		this.available = value
		this.retire()
		this.publish(this.refused ? { status: 'access-ended', information: null } : unavailable)
		this.schedule(0)
	}
	setVisible(value: boolean): void {
		if (this.visible === value || this.disposed) return
		this.visible = value
		this.retire()
		// Hidden pages retain no payload. Returning never extends an old receipt.
		this.publish(this.refused ? { status: 'access-ended', information: null } : unavailable)
		this.schedule(0)
	}
	dispose(): void {
		this.disposed = true
		this.retire()
		this.publish(unavailable)
		this.listeners.clear()
	}
	private active(): boolean {
		return !this.disposed && !this.refused && this.available && this.visible
	}
	private retire(): void {
		this.generation++
		this.request?.abort()
		if (this.next !== undefined) this.time.clear(this.next)
		if (this.expiry !== undefined) this.time.clear(this.expiry)
		this.next = this.expiry = undefined
		this.deadline = 0
	}
	private publish(state: InformationState): void {
		const signature = JSON.stringify({
			status: state.status,
			footer: state.information?.footer,
			sidebar: state.information?.sidebar,
		})
		if (signature === this.signature) return
		this.signature = signature
		this.state = state
		for (const listener of this.listeners) listener()
	}
	private schedule(delay: number): void {
		if (!this.active() || this.request || this.next !== undefined) return
		this.next = this.time.set(
			() => {
				this.next = undefined
				void this.read()
			},
			Math.max(delay, 1000 - (this.time.now() - this.lastStart)),
		)
	}
	private async read(): Promise<void> {
		if (!this.active() || this.request) return
		const generation = this.generation
		const request = new AbortController()
		this.request = request
		const started = this.time.now()
		this.lastStart = started
		const current = () => this.active() && this.generation === generation && !request.signal.aborted
		try {
			if (!this.transport.information) throw new Error('Information unavailable')
			const result = informationResponseSchema.parse(await this.transport.information(this.owner, request.signal))
			if (!current()) return
			if (result.hostEpoch !== this.owner.hostEpoch || !sameRemoteTarget(result.target, this.owner.target))
				throw new Error('Information owner changed')
			if (this.expiry !== undefined) this.time.clear(this.expiry)
			this.deadline = started + result.freshForMs
			if (result.status === 'available' && this.deadline <= this.time.now()) {
				this.publish(unavailable)
				return
			}
			this.publish({ status: result.status, information: result.information })
			if (result.status === 'available')
				this.expiry = this.time.set(
					() => {
						this.expiry = undefined
						if (current() && this.time.now() >= this.deadline) this.publish(unavailable)
					},
					Math.max(0, this.deadline - this.time.now()),
				)
		} catch (error) {
			if (!current()) return
			if (error instanceof RemoteAccessError && (error.status === 401 || error.status === 403)) {
				this.refused = true
				this.retire()
				this.publish({ status: 'access-ended', information: null })
			} else this.publish(unavailable)
		} finally {
			if (this.request === request) this.request = null
			this.schedule(2000)
		}
	}
}
