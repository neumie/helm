// Wire contract of Helm's Claude hub (the in-process hub in Helm main that the
// Claude Code hooks of Helm terminals report to; app/src/claude-remote/). Lives
// in root `src/` so the Electron main bundle and the `helm` CLI share it.
//
// One newline-terminated JSON request per connection on the hub's private Unix
// socket (`<socket namespace root>/claude-remote.sock`, root dir 0700, socket 0600):
//   {"v":1,"t":"event"|"permission","token","pid","at","input"}  hook client (token = the terminal)
//   {"v":1,"t":"degraded","token","pid","reason","cwd"}          preload: the user's own --settings won
//   {"v":1,"t":"dispatcher","token","session_id"}                `helm dock watch` in a Helm terminal
//                                                                   (only that terminal's own primary session)
//   {"v":1,"t":"attach","token","pid"}                             preload lifeline: held open for claude's life
//   {"v":1,"t":"read","owner","op":"session"|"transcript","profile","terminal"}  `helm dock show`
// Replies: permission → {"output":{…}}; read → {"ok":true,"body":…} | {"ok":false,"status","error"}.
// Nothing else is answered; the hub closes the connection (attach: never; its close means claude exited).
// A connection that sends no full line within 5 s is dropped.

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'

export const CLAUDE_HUB_SOCKET_NAME = 'claude-remote.sock'
/** Runtime copies of the preload and hook client (no whitespace: Bun splits BUN_OPTIONS on it). */
export const CLAUDE_HUB_RUNTIME_DIR = 'claude-remote'
/** In the agent-dock spool dir (0700): `{socket, owner}` for `helm dock show`. 0600. */
export const CLAUDE_HUB_OWNER_FILE = 'claude-remote.json'

export const CLAUDE_REMOTE_ENV = {
	socket: 'HELM_CLAUDE_REMOTE_SOCKET',
	token: 'HELM_CLAUDE_REMOTE_TOKEN',
	hook: 'HELM_CLAUDE_REMOTE_HOOK',
	node: 'HELM_CLAUDE_REMOTE_NODE',
} as const

/** Request line bound (a hook's stdin may carry a large Write `content`). */
export const CLAUDE_HUB_MAX_LINE_BYTES = 24 * 1024 * 1024

const safeId = /^[A-Za-z0-9_-]{1,100}$/

/** `v1.<profileId>.<dtachSessionId>.<mac>`: the terminal a hook reports for (main checks the mac). */
export interface ClaudeHubTokenParts {
	profileId: string
	terminalId: string
	mac: string
}

export function parseClaudeHubToken(token: unknown): ClaudeHubTokenParts | null {
	if (typeof token !== 'string' || token.length > 400) return null
	const parts = token.split('.')
	if (parts.length !== 4 || parts[0] !== 'v1') return null
	const [, profileId, terminalId, mac] = parts as [string, string, string, string]
	if (!safeId.test(profileId) || !safeId.test(terminalId) || !/^[A-Za-z0-9_-]{16,128}$/.test(mac)) return null
	return { profileId, terminalId, mac }
}

export const claudeHubOwnerFileSchema = z.object({
	version: z.literal(1),
	socket: z.string().min(1),
	owner: z.string().min(16),
})
export type ClaudeHubOwnerFile = z.infer<typeof claudeHubOwnerFileSchema>

export const claudeHubReadReplySchema = z.union([
	z.object({ ok: z.literal(true), body: z.unknown() }),
	z.object({ ok: z.literal(false), status: z.number().int(), error: z.string() }),
])

/** Profile part of a Helm dock profile (`helm:<profileId>`), or null for an Okena profile. */
export function helmDockProfileId(profile: string): string | null {
	if (!profile.startsWith('helm:')) return null
	const id = profile.slice('helm:'.length)
	return safeId.test(id) ? id : null
}

export const helmDockProfile = (profileId: string): string => `helm:${profileId}`

/** Sends one request line and resolves the first reply line (or null when the hub closed without one). */
export function claudeHubRequest(
	socketPath: string,
	request: Record<string, unknown>,
	timeoutMs = 3_000,
	maxReplyBytes = 8 * 1024 * 1024,
): Promise<unknown | null> {
	return new Promise((resolve, reject) => {
		const chunks: string[] = []
		let size = 0
		let settled = false
		const socket = createConnection(socketPath)
		const finish = (error: Error | null, value: unknown | null = null) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			socket.destroy()
			if (error) reject(error)
			else resolve(value)
		}
		const timer = setTimeout(() => finish(new Error('Helm Claude hub did not answer in time')), timeoutMs)
		socket.setEncoding('utf8')
		socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
		socket.on('data', (chunk: string) => {
			// Only the new chunk is searched: a large reply stays linear.
			const cut = chunk.indexOf('\n')
			size += cut === -1 ? chunk.length : cut
			if (size > maxReplyBytes) return finish(new Error('Helm Claude hub reply too large'))
			if (cut === -1) {
				chunks.push(chunk)
				return
			}
			chunks.push(chunk.slice(0, cut))
			try {
				finish(null, JSON.parse(chunks.join('')))
			} catch {
				finish(new Error('Helm Claude hub sent invalid JSON'))
			}
		})
		socket.on('error', error => finish(error))
		socket.on('close', () => finish(null, null))
	})
}

/** Reads `<dir>/claude-remote.json` (owner-private, no symlinks). Null when absent or invalid. */
export async function readClaudeHubOwnerFile(dir: string): Promise<ClaudeHubOwnerFile | null> {
	let handle: Awaited<ReturnType<typeof open>> | null = null
	try {
		handle = await open(join(dir, CLAUDE_HUB_OWNER_FILE), constants.O_RDONLY | constants.O_NOFOLLOW)
		const info = await handle.stat()
		if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0) return null
		if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null
		const parsed = claudeHubOwnerFileSchema.safeParse(JSON.parse(await handle.readFile('utf8')))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	} finally {
		await handle?.close().catch(() => {})
	}
}
