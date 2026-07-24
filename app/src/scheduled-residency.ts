import { readLocalControlToken } from '../../src/auth/local-control'
import type { HelmResult } from './shared-helm'

/** The desktop renews before the daemon's 45s resident lease expires. */
export const RESIDENT_HEARTBEAT_MS = 15_000
/** A stalled local daemon must not keep Electron's quit path waiting. */
export const RESIDENT_REQUEST_TIMEOUT_MS = 5_000

export type ResidentLeaseOperation = 'issue' | 'heartbeat' | 'tick' | 'revoke'

export interface ResidentLease {
	capability: string
	expiresAt: number
}

export type ResidentLeaseRequest = <T>(
	operation: ResidentLeaseOperation,
	capability: string,
	timeoutMs: number,
) => Promise<HelmResult<T>>

export interface ElectronResidencyControllerOptions {
	/** Main-only bridge adapter; no renderer/preload surface is permitted. */
	request: ResidentLeaseRequest
	/** Uses the daemon's root auth abstraction in production. */
	loadControlToken?: () => Promise<string>
	setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
	heartbeatMs?: number
	requestTimeoutMs?: number
}

/**
 * Electron-owned admission heartbeat for scheduled recurrence.
 *
 * The daemon owns no autonomous recurrence timer: this controller issues one
 * short-lived lease and serializes each heartbeat+tick cycle. Its only daemon
 * transport is the injected HelmBridge adapter. Any ambiguous network failure
 * stops future ticks and lets the memory-only lease expire safely.
 */
export class ElectronResidencyController {
	private readonly loadControlToken: () => Promise<string>
	private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
	private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
	private readonly heartbeatMs: number
	private readonly requestTimeoutMs: number
	private active = false
	private capability: string | null = null
	/** False after any ambiguous/expired operation; stale capability is revoke-only. */
	private leaseUsable = false
	private timer: ReturnType<typeof setTimeout> | null = null
	private currentCycle: Promise<void> | null = null
	private startPromise: Promise<void> | null = null
	private stopPromise: Promise<void> | null = null

	constructor(private readonly options: ElectronResidencyControllerOptions) {
		this.loadControlToken = options.loadControlToken ?? readLocalControlToken
		this.setTimer = options.setTimer ?? setTimeout
		this.clearTimer = options.clearTimer ?? clearTimeout
		this.heartbeatMs = options.heartbeatMs ?? RESIDENT_HEARTBEAT_MS
		this.requestTimeoutMs = options.requestTimeoutMs ?? RESIDENT_REQUEST_TIMEOUT_MS
	}

	/** Idempotently load control auth, issue one lease, and immediately tick it. */
	start(): Promise<void> {
		if (this.active) return this.startPromise ?? Promise.resolve()
		this.active = true
		const startPromise = this.run(() => this.acquireAndTick()).finally(() => {
			if (this.startPromise === startPromise) this.startPromise = null
		})
		this.startPromise = startPromise
		return startPromise
	}

	/**
	 * Stop future cycles, wait for an admitted cycle, then best-effort revoke.
	 * Revoke/network ambiguity is deliberately not retried; lease expiry fences
	 * the daemon if Electron is already leaving.
	 */
	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise
		this.active = false
		if (this.timer) this.clearTimer(this.timer)
		this.timer = null
		this.stopPromise = (async () => {
			await this.currentCycle
			const capability = this.capability
			this.capability = null
			this.leaseUsable = false
			if (!capability) return
			await this.options.request('revoke', capability, this.requestTimeoutMs).catch(() => undefined)
		})().finally(() => {
			this.stopPromise = null
		})
		return this.stopPromise
	}

	private run(operation: () => Promise<void>): Promise<void> {
		const cycle = operation().finally(() => {
			if (this.currentCycle === cycle) this.currentCycle = null
		})
		this.currentCycle = cycle
		return cycle
	}

	private schedule(): void {
		if (!this.active || this.timer) return
		this.timer = this.setTimer(() => {
			this.timer = null
			if (!this.active) return
			if (this.currentCycle) {
				this.schedule()
				return
			}
			void this.run(() => (this.leaseUsable ? this.heartbeatAndTick() : this.acquireAndTick()))
		}, this.heartbeatMs)
		this.timer.unref?.()
	}

	private async acquireAndTick(reissue = false): Promise<void> {
		let controlToken: string
		try {
			controlToken = await this.loadControlToken()
		} catch {
			this.leaseUsable = false
			this.schedule()
			return
		}
		if (!this.active) return
		const issued = await this.options.request<ResidentLease>('issue', controlToken, this.requestTimeoutMs)
		if (!this.active) {
			if (issued.data)
				await this.options.request('revoke', issued.data.capability, this.requestTimeoutMs).catch(() => undefined)
			return
		}
		if (!issued.data) {
			this.leaseUsable = false
			this.schedule()
			return
		}
		this.capability = issued.data.capability
		this.leaseUsable = true
		await this.tick(reissue)
	}

	private async heartbeatAndTick(): Promise<void> {
		const capability = this.capability
		if (!this.active || !capability) return
		const heartbeat = await this.options.request<ResidentLease>('heartbeat', capability, this.requestTimeoutMs)
		if (!this.active) return
		if (heartbeat.status === 401) {
			await this.acquireAndTick(true)
			return
		}
		if (!heartbeat.data) return this.retryLater()
		this.capability = heartbeat.data.capability
		this.leaseUsable = true
		await this.tick(false)
	}

	private async tick(reissued: boolean): Promise<void> {
		const capability = this.capability
		if (!this.active || !capability) return
		const result = await this.options.request('tick', capability, this.requestTimeoutMs)
		if (!this.active) return
		if (result.status === 401 && !reissued) {
			await this.acquireAndTick(true)
			return
		}
		if (!result.data) return this.retryLater()
		this.leaseUsable = true
		this.schedule()
	}

	private retryLater(): void {
		// Stop using the ambiguous lease immediately. Keep its value only so an
		// explicit quit can still attempt revoke; the next timer issues a fresh
		// lease with control auth and never ticks this stale capability again.
		this.leaseUsable = false
		this.schedule()
	}
}

export default { ElectronResidencyController }
