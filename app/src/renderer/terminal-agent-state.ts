const OSC_PREFIX = '\u001b]777;helm-agent-state;'
const BEL = '\u0007'
const ST = '\u001b\\'
const MAX_ENCODED_PAYLOAD = 2048
const DEFAULT_STALE_AFTER_MS = 6_000

export type ReportedAgentState = 'idle' | 'working' | 'blocked' | 'absent'
export type TerminalAgentPhase =
	| { kind: 'thinking' }
	| { kind: 'tool'; name: string; count: number }
	| { kind: 'waiting'; reason: 'question' | 'cooperative' }

export interface TerminalAgentReport {
	v: 1
	agent: 'pi'
	instance: string
	seq: number
	state: ReportedAgentState
	phase?: TerminalAgentPhase
}

export interface TerminalAgentStatus {
	agent: 'pi' | null
	state: Exclude<ReportedAgentState, 'absent'> | 'unknown'
	phase: TerminalAgentPhase | null
	label: string
	structured: boolean
}

export interface TerminalAgentStateTracker {
	feed(data: string): void
	tick(): void
	clear(): void
	status(): TerminalAgentStatus
}

const UNKNOWN_STATUS: TerminalAgentStatus = {
	agent: null,
	state: 'unknown',
	phase: null,
	label: 'Agent status unavailable',
	structured: false,
}

function decodeBase64Url(value: string): string | null {
	if (value.length === 0 || value.length > MAX_ENCODED_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(value)) return null
	try {
		const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
		const binary = atob(padded)
		const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return null
	}
}

function encodeBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function validPhase(value: unknown): value is TerminalAgentPhase {
	if (!value || typeof value !== 'object') return false
	const phase = value as Record<string, unknown>
	if (phase.kind === 'thinking') return Object.keys(phase).length === 1
	if (phase.kind === 'waiting')
		return (
			(phase.reason === 'question' || phase.reason === 'cooperative') &&
			Object.keys(phase).every(key => key === 'kind' || key === 'reason')
		)
	return (
		phase.kind === 'tool' &&
		typeof phase.name === 'string' &&
		/^[A-Za-z0-9_.:-]{1,40}$/.test(phase.name) &&
		Number.isSafeInteger(phase.count) &&
		Number(phase.count) >= 1 &&
		Number(phase.count) <= 16 &&
		Object.keys(phase).every(key => key === 'kind' || key === 'name' || key === 'count')
	)
}

function validReport(value: unknown): value is TerminalAgentReport {
	if (!value || typeof value !== 'object') return false
	const report = value as Record<string, unknown>
	if (
		report.v !== 1 ||
		report.agent !== 'pi' ||
		typeof report.instance !== 'string' ||
		!/^[A-Za-z0-9_-]{8,64}$/.test(report.instance) ||
		!Number.isSafeInteger(report.seq) ||
		Number(report.seq) < 1 ||
		!['idle', 'working', 'blocked', 'absent'].includes(String(report.state))
	)
		return false
	if (report.phase !== undefined && !validPhase(report.phase)) return false
	if ((report.state === 'idle' || report.state === 'absent') && report.phase !== undefined) return false
	if (report.state === 'blocked' && report.phase?.kind !== 'waiting') return false
	if (report.state === 'working' && report.phase?.kind === 'waiting') return false
	return Object.keys(report).every(key => ['v', 'agent', 'instance', 'seq', 'state', 'phase'].includes(key))
}

function decodeReport(encoded: string): TerminalAgentReport | null {
	const json = decodeBase64Url(encoded)
	if (json === null) return null
	try {
		const value: unknown = JSON.parse(json)
		return validReport(value) ? value : null
	} catch {
		return null
	}
}

function labelFor(report: TerminalAgentReport): string {
	if (report.state === 'idle') return 'Pi is idle'
	if (report.state === 'blocked')
		return report.phase?.kind === 'waiting' && report.phase.reason === 'question'
			? 'Pi is waiting for an answer'
			: 'Pi is waiting for input'
	if (report.phase?.kind === 'tool')
		return report.phase.count === 1 ? `Pi is using ${report.phase.name}` : `Pi is using ${report.phase.count} tools`
	return 'Pi is thinking'
}

function statusFor(report: TerminalAgentReport): TerminalAgentStatus {
	if (report.state === 'absent') return UNKNOWN_STATUS
	return {
		agent: report.agent,
		state: report.state,
		phase: report.phase ?? null,
		label: labelFor(report),
		structured: true,
	}
}

function sameStatus(left: TerminalAgentStatus, right: TerminalAgentStatus): boolean {
	return (
		left.agent === right.agent &&
		left.state === right.state &&
		left.label === right.label &&
		JSON.stringify(left.phase) === JSON.stringify(right.phase) &&
		left.structured === right.structured
	)
}

export function encodeTerminalAgentReport(report: TerminalAgentReport, terminator: 'bel' | 'st' = 'bel'): string {
	if (!validReport(report)) throw new Error('Invalid terminal agent report')
	return `${OSC_PREFIX}${encodeBase64Url(JSON.stringify(report))}${terminator === 'bel' ? BEL : ST}`
}

export function createTerminalAgentStateTracker(options: {
	onChange: (status: TerminalAgentStatus) => void
	now?: () => number
	staleAfterMs?: number
}): TerminalAgentStateTracker {
	const now = options.now ?? Date.now
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
	let buffer = ''
	let owner: { instance: string; seq: number; seenAt: number } | null = null
	let current = UNKNOWN_STATUS

	const publish = (next: TerminalAgentStatus): void => {
		if (sameStatus(current, next)) return
		current = next
		options.onChange(next)
	}

	const accept = (report: TerminalAgentReport): void => {
		const observedAt = now()
		if (owner && report.instance !== owner.instance && observedAt - owner.seenAt < staleAfterMs) return
		if (owner?.instance === report.instance && report.seq <= owner.seq) return
		if (report.state === 'absent') {
			if (owner?.instance === report.instance || owner === null) {
				owner = null
				publish(UNKNOWN_STATUS)
			}
			return
		}
		owner = { instance: report.instance, seq: report.seq, seenAt: observedAt }
		publish(statusFor(report))
	}

	const parse = (): void => {
		while (true) {
			const start = buffer.indexOf(OSC_PREFIX)
			if (start < 0) {
				buffer = buffer.slice(-Math.max(0, OSC_PREFIX.length - 1))
				return
			}
			if (start > 0) buffer = buffer.slice(start)
			const payloadStart = OSC_PREFIX.length
			const bel = buffer.indexOf(BEL, payloadStart)
			const st = buffer.indexOf(ST, payloadStart)
			const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st)
			if (end < 0) {
				if (buffer.length - payloadStart > MAX_ENCODED_PAYLOAD) buffer = buffer.slice(OSC_PREFIX.length)
				return
			}
			const report = decodeReport(buffer.slice(payloadStart, end))
			buffer = buffer.slice(end + (end === st ? ST.length : BEL.length))
			if (report) accept(report)
		}
	}

	return {
		feed(data): void {
			buffer += data
			parse()
		},
		tick(): void {
			if (!owner || now() - owner.seenAt < staleAfterMs) return
			owner = null
			publish(UNKNOWN_STATUS)
		},
		clear(): void {
			buffer = ''
			owner = null
			publish(UNKNOWN_STATUS)
		},
		status(): TerminalAgentStatus {
			return current
		},
	}
}

export default { createTerminalAgentStateTracker, encodeTerminalAgentReport }
