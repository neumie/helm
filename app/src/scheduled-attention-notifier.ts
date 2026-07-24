import { randomUUID } from 'node:crypto'
import type { ScheduledSessionOwnership } from './scheduled-adoption-main'

/** Safe daemon projection; no descriptor, capability, prompt, path, PID, or adoption record is present. */
export interface ScheduledAttentionNotification {
	profileId: string
	runId: string
	revision: number
	scheduleName: string
	reportSummary: string
	notificationClaimedAt: string | null
	notificationDeliveredAt: string | null
}

export interface NativeAttentionNotification {
	show(): boolean | undefined
	onClick(listener: () => void): void
}

export interface ScheduledAttentionNotifierOptions {
	list(): Promise<ScheduledAttentionNotification[]>
	claim(input: ScheduledAttentionNotification): Promise<ScheduledAttentionNotification | null>
	markDelivered(input: ScheduledAttentionNotification): Promise<boolean>
	notification(content: { title: string; body: string }): NativeAttentionNotification
	focusAndRestore(): void | Promise<void>
	/** Resolves true only after the existing switch coordinator has committed a current window. */
	activateProfile(profileId: string): Promise<boolean>
	/** Returns a current renderer token only for the presently committed profile/window. */
	currentProfileToken(profileId: string): string | null
	adopt(input: ScheduledSessionOwnership & { profileToken: string }): Promise<unknown>
	newUuid?: () => string
	setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
	pollMs?: number
}

export const SCHEDULED_ATTENTION_POLL_MS = 15_000

export function scheduledAttentionNotificationCopy(
	input: Pick<ScheduledAttentionNotification, 'scheduleName' | 'reportSummary'>,
): {
	title: string
	body: string
} {
	// reportSummary is canonicalized + byte-capped by the daemon report protocol.
	return { title: 'Scheduled run needs attention', body: `${input.scheduleName}\n${input.reportSummary}` }
}

/**
 * Electron-main-only native-notification coordinator. It has no preload or
 * renderer transport: all polling, control auth, click admission, and adoption
 * stay in the main process. A delivered native notification is deduped for the
 * app lifetime; a crash before delivery is retried through the daemon lease.
 */
export class ScheduledAttentionNotifier {
	private readonly newUuid: () => string
	private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
	private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
	private readonly pollMs: number
	private readonly adopter: string
	private active = false
	private timer: ReturnType<typeof setTimeout> | null = null
	private polling: Promise<void> | null = null
	private readonly operations = new Set<Promise<unknown>>()
	private readonly shown = new Set<string>()
	private readonly clicking = new Set<string>()

	constructor(private readonly options: ScheduledAttentionNotifierOptions) {
		this.newUuid = options.newUuid ?? randomUUID
		this.setTimer = options.setTimer ?? setTimeout
		this.clearTimer = options.clearTimer ?? clearTimeout
		this.pollMs = options.pollMs ?? SCHEDULED_ATTENTION_POLL_MS
		this.adopter = this.newUuid()
	}

	start(): void {
		if (this.active) return
		this.active = true
		void this.poll()
	}

	/** Stop new polling/click admission and drain the already-admitted work. */
	async stop(): Promise<void> {
		this.active = false
		if (this.timer) this.clearTimer(this.timer)
		this.timer = null
		await this.polling
		await Promise.allSettled([...this.operations])
	}

	private poll(): Promise<void> {
		if (!this.active) return Promise.resolve()
		if (this.polling) return this.polling
		const poll = this.pollOnce().finally(() => {
			if (this.polling === poll) this.polling = null
			if (this.active) this.schedule()
		})
		this.polling = poll
		return poll
	}

	private schedule(): void {
		if (!this.active || this.timer) return
		this.timer = this.setTimer(() => {
			this.timer = null
			void this.poll()
		}, this.pollMs)
		this.timer.unref?.()
	}

	private async pollOnce(): Promise<void> {
		let candidates: ScheduledAttentionNotification[]
		try {
			candidates = await this.options.list()
		} catch {
			return
		}
		for (const candidate of candidates) {
			if (!this.active) return
			const key = this.key(candidate)
			if (candidate.notificationDeliveredAt || this.shown.has(key)) continue
			let claimed: ScheduledAttentionNotification | null
			try {
				claimed = await this.options.claim(candidate)
			} catch {
				continue
			}
			if (!claimed || !this.active) continue
			try {
				const native = this.options.notification(scheduledAttentionNotificationCopy(claimed))
				native.onClick(() => this.admitClick(claimed))
				if (native.show() === false) continue
				this.shown.add(key)
				// A delivery-write failure is deliberately not retried in-process: the
				// native alert already exists, and a later process may retry after lease.
				await this.options.markDelivered(claimed)
			} catch {
				// No delivered marker is written unless show() completed successfully.
			}
		}
	}

	private admitClick(candidate: ScheduledAttentionNotification): void {
		const key = this.key(candidate)
		if (!this.active || this.clicking.has(key)) return
		this.clicking.add(key)
		this.track(
			this.handleClick(candidate).finally(() => {
				this.clicking.delete(key)
			}),
		)
	}

	private async handleClick(candidate: ScheduledAttentionNotification): Promise<void> {
		try {
			await this.options.focusAndRestore()
			if (!this.active || !(await this.options.activateProfile(candidate.profileId)) || !this.active) return
			const profileToken = this.options.currentProfileToken(candidate.profileId)
			if (!profileToken) return
			await this.options.adopt({
				profileId: candidate.profileId,
				runId: candidate.runId,
				revision: candidate.revision,
				adoptionId: this.newUuid(),
				adopter: this.adopter,
				profileToken,
			})
		} catch {
			// The daemon attention row remains unresolved. Notification clicks must
			// never synthesize a successful adoption after a switch/attach failure.
		}
	}

	private track(operation: Promise<unknown>): void {
		this.operations.add(operation)
		void operation.finally(() => this.operations.delete(operation)).catch(() => undefined)
	}

	private key(candidate: Pick<ScheduledAttentionNotification, 'profileId' | 'runId'>): string {
		return `${candidate.profileId}:${candidate.runId}`
	}
}
