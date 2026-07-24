import type { RestoredSession } from './shared'

/** Durable, non-secret ownership evidence retained in the profile SessionRegistry. */
export interface ScheduledSessionOwnership {
	profileId: string
	runId: string
	/** The durable reservation revision; complete retries and restore attest it exactly. */
	revision: number
	adoptionId: string
	adopter: string
}

export interface ScheduledAttachDescriptor {
	socketPath: string
	mode: 'attach-existing'
	redraw: 'winch'
}

export interface ScheduledAdoptionDaemon {
	reserve(input: ScheduledSessionOwnership): Promise<{ revision: number; capability: string }>
	descriptor(input: ScheduledSessionOwnership & { capability: string }): Promise<ScheduledAttachDescriptor>
	complete(input: ScheduledSessionOwnership): Promise<void>
	rollback(input: ScheduledSessionOwnership): Promise<void>
	/** Re-attests a completed durable owner; this privileged response never crosses preload. */
	restoreDescriptor(input: ScheduledSessionOwnership): Promise<ScheduledAttachDescriptor>
}

export interface ScheduledAdoptionAttach {
	attach(input: {
		sessionId: string
		ownership: ScheduledSessionOwnership
		descriptor: ScheduledAttachDescriptor
	}): Promise<{ ptyId: number }>
	detach(ptyId: number): void
}

export interface ScheduledAdoptionRegistry {
	registerRunOwned(sessionId: string, ownership: ScheduledSessionOwnership): boolean
	removeRunOwned(sessionId: string): void
	listRunOwned(): Array<{ sessionId: string; ownership: ScheduledSessionOwnership; restored: RestoredSession }>
}

export interface ScheduledAdoptionRenderer {
	/** Opens only an opaque PTY/session pair under the current captured profile token. */
	open(restored: RestoredSession & { ptyId: number }): Promise<boolean>
}

export interface ScheduledAdoptionOptions {
	daemon: ScheduledAdoptionDaemon
	attach: ScheduledAdoptionAttach
	registry: ScheduledAdoptionRegistry
	renderer: ScheduledAdoptionRenderer
	newSessionId(): string
	/** Current-profile/current-renderer admission fence. */ isCurrent(profileId: string, profileToken: string): boolean
}

export type ScheduledAdoptionResult =
	| { status: 'completed'; sessionId: string; ptyId: number }
	| { status: 'ambiguous'; sessionId: string; ptyId: number }
	| { status: 'rejected' | 'rolled-back' }

/**
 * Electron-main-only attention handoff. Raw descriptors live only between the
 * injected daemon adapter and node-pty adapter; the renderer gets an opaque
 * restored-session-shaped record after the registry flush succeeds.
 */
export class ScheduledAttentionAdoptionCoordinator {
	constructor(private readonly options: ScheduledAdoptionOptions) {}

	async adopt(input: ScheduledSessionOwnership & { profileToken: string }): Promise<ScheduledAdoptionResult> {
		const ownership = this.ownership(input)
		if (!this.current(ownership, input.profileToken)) return { status: 'rejected' }
		let registered = false
		let ptyId: number | null = null
		let sessionId: string | null = null
		try {
			const reservation = await this.options.daemon.reserve(ownership)
			const reserved = { ...ownership, revision: reservation.revision }
			if (!this.current(reserved, input.profileToken)) return this.rollback(reserved, null, null, false)
			const descriptor = await this.options.daemon.descriptor({ ...reserved, capability: reservation.capability })
			if (!this.validDescriptor(descriptor) || !this.current(reserved, input.profileToken))
				return this.rollback(reserved, null, null, false)
			sessionId = this.options.newSessionId()
			const attached = await this.options.attach.attach({ sessionId, ownership: reserved, descriptor })
			ptyId = attached.ptyId
			if (!this.current(reserved, input.profileToken)) return this.rollback(reserved, sessionId, ptyId, false)
			registered = this.options.registry.registerRunOwned(sessionId, reserved)
			if (!registered) return this.rollback(reserved, sessionId, ptyId, false)
			const opened = await this.options.renderer.open({ ...restored(sessionId), ptyId })
			if (!opened || !this.current(reserved, input.profileToken)) return this.rollback(reserved, sessionId, ptyId, true)
			try {
				await this.options.daemon.complete(reserved)
				return { status: 'completed', sessionId, ptyId }
			} catch {
				// Registry is durable and the client is attached. Completion may have
				// reached the daemon, so retain both and retry idempotently on startup.
				return { status: 'ambiguous', sessionId, ptyId }
			}
		} catch {
			return this.rollback(ownership, sessionId, ptyId, registered)
		}
	}

	/** Reattach completed durable ownership after an Electron restart. */
	async restore(profileToken: string): Promise<void> {
		for (const entry of this.options.registry.listRunOwned()) {
			const { ownership, sessionId, restored: safe } = entry
			if (!this.current(ownership, profileToken)) return
			try {
				const descriptor = await this.options.daemon.restoreDescriptor(ownership)
				if (!this.validDescriptor(descriptor) || !this.current(ownership, profileToken)) continue
				const { ptyId } = await this.options.attach.attach({ sessionId, ownership, descriptor })
				if (!(await this.options.renderer.open({ ...safe, ptyId }))) this.options.attach.detach(ptyId)
			} catch {
				// Ownership evidence is intentionally retained: a failed re-attest or
				// network response must not erase a completed handoff.
			}
		}
	}

	/** Retry a retained post-complete ambiguity without reattaching or deleting evidence. */
	async recoverAmbiguous(): Promise<void> {
		for (const { ownership } of this.options.registry.listRunOwned()) {
			try {
				await this.options.daemon.complete(ownership)
			} catch {
				// The daemon may be down; exact durable evidence remains for next start.
			}
		}
	}

	private ownership(input: ScheduledSessionOwnership): ScheduledSessionOwnership {
		return {
			profileId: input.profileId,
			runId: input.runId,
			revision: input.revision,
			adoptionId: input.adoptionId,
			adopter: input.adopter,
		}
	}

	private current(ownership: ScheduledSessionOwnership, token: string): boolean {
		return this.options.isCurrent(ownership.profileId, token)
	}

	private validDescriptor(value: ScheduledAttachDescriptor): boolean {
		return (
			value.mode === 'attach-existing' &&
			value.redraw === 'winch' &&
			typeof value.socketPath === 'string' &&
			value.socketPath !== ''
		)
	}

	private async rollback(
		ownership: ScheduledSessionOwnership,
		sessionId: string | null,
		ptyId: number | null,
		registered: boolean,
	): Promise<ScheduledAdoptionResult> {
		if (ptyId !== null) this.options.attach.detach(ptyId)
		if (registered && sessionId !== null) this.options.registry.removeRunOwned(sessionId)
		try {
			await this.options.daemon.rollback(ownership)
		} catch {
			// Do not report ownership success, but never touch the attested master.
		}
		return { status: 'rolled-back' }
	}
}

function restored(sessionId: string): RestoredSession {
	return {
		sessionId,
		title: null,
		customName: null,
		parked: false,
		groupId: null,
		agentRunning: false,
		agentAttention: false,
	}
}
