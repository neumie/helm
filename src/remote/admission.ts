import { createHash } from 'node:crypto'
import {
	type RemoteCommand,
	type RemoteReceipt,
	type RemoteTarget,
	remoteCommandSchema,
	sameRemoteTarget,
} from './protocol.js'

export function commandFingerprint(command: RemoteCommand): string {
	return createHash('sha256').update(JSON.stringify(command)).digest('hex')
}

export interface RemotePreparation {
	readonly receipt: RemoteReceipt
	readonly ticket?: RemoteAdmissionTicket
}

export interface RemoteAdmissionTicket {
	readonly __remoteAdmissionTicket: unique symbol
}

type TicketState = {
	command: Readonly<RemoteCommand> | null
	fingerprint: string
	receipt: RemoteReceipt
	expiresAt: number
	status: 'prepared' | 'checking' | 'settled'
}

type LedgerEntry = {
	fingerprint: string
	receipt: RemoteReceipt
}

function freezeDeep<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
	}
	return value
}

function copyReceipt(receipt: RemoteReceipt): RemoteReceipt {
	return { commandId: receipt.commandId, status: receipt.status }
}

function capturedCommand(command: RemoteCommand): Readonly<RemoteCommand> {
	return freezeDeep(remoteCommandSchema.parse(structuredClone(command)))
}

/** Pi-side ledger: reserve before invoking Pi; never evict a command into re-executability. */
export class RemoteAdmission {
	private readonly commands = new Map<string, LedgerEntry>()
	private readonly tickets = new WeakMap<object, TicketState>()
	private readonly active = new Set<TicketState>()
	private readonly target: Readonly<RemoteTarget>
	private closed = false

	constructor(
		target: RemoteTarget,
		private readonly limit = 4096,
		private readonly now: () => number = Date.now,
	) {
		this.target = freezeDeep(structuredClone(target))
	}

	dispose(): void {
		this.closed = true
		for (const state of this.active) {
			if (state.status !== 'settled') this.finishKnown(state, 'rejected')
		}
	}

	private reapExpired(): void {
		const now = this.now()
		for (const state of [...this.active]) {
			if (state.status !== 'settled' && now >= state.expiresAt) this.finishKnown(state, 'rejected')
		}
	}

	private finishKnown(state: TicketState, status: RemoteReceipt['status']): void {
		state.receipt.status = status
		state.command = null
		state.status = 'settled'
		this.active.delete(state)
	}

	private existing(command: RemoteCommand): RemotePreparation | undefined {
		const entry = this.commands.get(command.commandId)
		if (!entry) return undefined
		return {
			receipt:
				entry.fingerprint === commandFingerprint(command)
					? copyReceipt(entry.receipt)
					: { commandId: command.commandId, status: 'rejected' },
		}
	}

	prepare(command: RemoteCommand, expiresAt: number): RemotePreparation {
		if (this.closed) return { receipt: { commandId: command.commandId, status: 'rejected' } }
		this.reapExpired()
		const existing = this.existing(command)
		if (existing) return existing
		const rejected = { commandId: command.commandId, status: 'rejected' as const }
		if (this.closed || !sameRemoteTarget(this.target, command.target) || command.operation.kind !== 'prompt')
			return { receipt: rejected }
		const now = this.now()
		if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 10_000) return { receipt: rejected }
		if (this.commands.size >= this.limit || this.active.size >= 9) return { receipt: rejected }
		let captured: Readonly<RemoteCommand>
		try {
			captured = capturedCommand(command)
		} catch {
			return { receipt: rejected }
		}
		const receipt: RemoteReceipt = { commandId: command.commandId, status: 'pending' }
		const state: TicketState = {
			command: captured,
			fingerprint: commandFingerprint(command),
			receipt,
			expiresAt,
			status: 'prepared',
		}
		const ticket = {} as RemoteAdmissionTicket
		this.tickets.set(ticket, state)
		this.commands.set(command.commandId, { fingerprint: state.fingerprint, receipt })
		this.active.add(state)
		return { receipt: copyReceipt(receipt), ticket }
	}

	commit(
		ticket: RemoteAdmissionTicket,
		guard: (command: Readonly<RemoteCommand>) => boolean,
		invoke: (command: Readonly<RemoteCommand>) => RemoteReceipt['status'],
	): RemoteReceipt | null {
		const state = this.tickets.get(ticket as object)
		if (!state) return null
		if (state.status === 'settled') return copyReceipt(state.receipt)
		if (state.status === 'checking') return copyReceipt(state.receipt)
		if (this.closed || this.now() >= state.expiresAt || !state.command) {
			this.finishKnown(state, 'rejected')
			return copyReceipt(state.receipt)
		}
		state.status = 'checking'
		let allowed = false
		try {
			allowed = guard(state.command)
		} catch {
			allowed = false
		}
		if (!allowed || this.closed || this.now() >= state.expiresAt || !state.command) {
			this.finishKnown(state, 'rejected')
			return copyReceipt(state.receipt)
		}
		const command = state.command
		this.active.delete(state)
		state.command = null
		state.status = 'settled'
		state.receipt.status = 'unknown'
		try {
			state.receipt.status = invoke(command)
		} catch {
			state.receipt.status = 'unknown'
		}
		return copyReceipt(state.receipt)
	}

	reject(ticket: RemoteAdmissionTicket): RemoteReceipt | null {
		const state = this.tickets.get(ticket as object)
		if (!state) return null
		if (state.status !== 'settled') this.finishKnown(state, 'rejected')
		return copyReceipt(state.receipt)
	}

	dispatch(command: RemoteCommand, invoke: () => RemoteReceipt['status']): RemoteReceipt {
		const rejected: RemoteReceipt = { commandId: command.commandId, status: 'rejected' }
		if (this.closed || !sameRemoteTarget(this.target, command.target)) return rejected
		this.reapExpired()
		const fingerprint = commandFingerprint(command)
		const prior = this.commands.get(command.commandId)
		if (prior) return prior.fingerprint === fingerprint ? copyReceipt(prior.receipt) : rejected
		if (this.commands.size >= this.limit) return rejected
		const receipt: RemoteReceipt = { commandId: command.commandId, status: 'unknown' }
		this.commands.set(command.commandId, { fingerprint, receipt })
		try {
			receipt.status = invoke()
		} catch {
			/* Effect may already have happened: never retry it. */
		}
		return copyReceipt(receipt)
	}
}
