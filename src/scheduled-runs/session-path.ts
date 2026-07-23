import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import net from 'node:net'

const PROFILE_ID_RE = /^(?:work|profile-[a-f0-9]{12})$/
const SESSION_ID_RE = /^sr-[a-z2-7]{16,36}$/
const MAX_UNIX_SOCKET_PATH = 103
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export type ScheduledSocketProbe = 'live' | 'dead' | 'unknown'

export function isScheduledProfileId(value: unknown): value is string {
	return typeof value === 'string' && PROFILE_ID_RE.test(value)
}

/** Deterministic opaque id; no user-controlled definition values enter socket paths. */
export function scheduledSessionId(runId: string): string {
	if (typeof runId !== 'string' || !runId) throw new Error('Invalid scheduled run id')
	const bytes = createHash('sha256').update(runId).digest()
	let bits = 0
	let value = 0
	let encoded = ''
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5 && encoded.length < 32) {
			encoded += BASE32[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	return `sr-${encoded}`
}

export function isScheduledSessionId(value: unknown): value is string {
	return typeof value === 'string' && SESSION_ID_RE.test(value) && value.length <= 40
}

export function scheduledSocketRoot(root = process.env.HELM_SCHEDULED_SOCKET_DIR): string {
	const uid = typeof process.getuid === 'function' ? process.getuid() : 0
	return resolve(root ?? `/tmp/helm-sched-${uid}`)
}

export function scheduledSocketDir(profileId: string, root?: string): string {
	if (!isScheduledProfileId(profileId)) throw new Error('Invalid scheduled profile id')
	const base = scheduledSocketRoot(root)
	const dir = resolve(base, profileId)
	if (!dir.startsWith(`${base}${sep}`)) throw new Error('Invalid scheduled socket path')
	return dir
}

export function scheduledSocketPath(profileId: string, sessionId: string, root?: string): string {
	if (!isScheduledSessionId(sessionId)) throw new Error('Invalid scheduled session id')
	return join(scheduledSocketDir(profileId, root), `${sessionId}.sock`)
}

export function assertScheduledSocketPathUsable(path: string): void {
	if (path.length > MAX_UNIX_SOCKET_PATH) {
		throw new Error(`Scheduled socket path exceeds ${MAX_UNIX_SOCKET_PATH}-byte AF_UNIX limit`)
	}
}

export function ensureScheduledSocketDir(profileId: string, root?: string): string {
	const dir = scheduledSocketDir(profileId, root)
	assertScheduledSocketPathUsable(join(dir, `${'sr-a'.padEnd(35, 'a')}.sock`))
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	try {
		chmodSync(dir, 0o700)
	} catch {
		// Existing test/runtime directory may not permit chmod; the path is still safe.
	}
	return dir
}

/** Only definitive connection failures permit destructive cleanup. */
export function probeScheduledSocket(path: string, timeoutMs = 700): Promise<ScheduledSocketProbe> {
	return new Promise(resolveProbe => {
		let settled = false
		const connection = net.createConnection(path)
		const finish = (result: ScheduledSocketProbe) => {
			if (settled) return
			settled = true
			connection.destroy()
			resolveProbe(result)
		}
		connection.once('connect', () => finish('live'))
		connection.once('error', error => {
			const code = (error as NodeJS.ErrnoException).code
			finish(code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ENOTSOCK' ? 'dead' : 'unknown')
		})
		connection.setTimeout(timeoutMs, () => finish('unknown'))
	})
}
