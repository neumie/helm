import { createHash } from 'node:crypto'
import { type RemoteCommand, type RemoteReceipt, type RemoteTarget, sameRemoteTarget } from './protocol.js'

export function commandFingerprint(command: RemoteCommand): string {
	return createHash('sha256').update(JSON.stringify(command)).digest('hex')
}

/** Pi-side ledger: reserve before invoking Pi; never evict a command into re-executability. */
export class RemoteAdmission {
	private readonly commands = new Map<string, { fingerprint: string; receipt: RemoteReceipt }>()
	private closed = false

	constructor(
		private readonly target: RemoteTarget,
		private readonly limit = 4096,
	) {}

	dispose(): void {
		this.closed = true
	}

	dispatch(command: RemoteCommand, invoke: () => RemoteReceipt['status']): RemoteReceipt {
		const rejected: RemoteReceipt = { commandId: command.commandId, status: 'rejected' }
		if (this.closed || !sameRemoteTarget(this.target, command.target)) return rejected
		const fingerprint = commandFingerprint(command)
		const prior = this.commands.get(command.commandId)
		if (prior) return prior.fingerprint === fingerprint ? { ...prior.receipt } : rejected
		if (this.commands.size >= this.limit) return rejected
		const receipt: RemoteReceipt = { commandId: command.commandId, status: 'unknown' }
		this.commands.set(command.commandId, { fingerprint, receipt })
		try {
			receipt.status = invoke()
		} catch {
			/* Effect may already have happened: never retry it. */
		}
		return { ...receipt }
	}
}
