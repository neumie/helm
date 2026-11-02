// Per-terminal credentials and environment for Helm's Claude hub.
//
// HELM_CLAUDE_REMOTE_TOKEN = `v1.<profileId>.<dtachSessionId>.<HMAC-SHA256(secret, "profileId:dtachSessionId")>`.
// The secret lives in <userData>/claude-remote/secret (0600), so the token a dtach
// shell got at creation stays valid across Helm restarts (a restored tab only
// re-attaches; its environment is fixed). The hub maps a valid token back to the
// terminal; nothing else about the caller is trusted.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
	constants,
	chmodSync,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { CLAUDE_REMOTE_ENV, parseClaudeHubToken } from '../../../src/agent-dock/claude-hub-wire'
import type { TerminalRef } from './hub-core'

const SECRET_BYTES = 32

function mac(secret: Buffer, profileId: string, terminalId: string): string {
	return createHmac('sha256', secret).update(`${profileId}:${terminalId}`).digest('base64url')
}

export interface ClaudeHubTokens {
	mint(ref: TerminalRef): string
	verify(token: unknown): TerminalRef | null
}

export function claudeHubTokens(secret: Buffer): ClaudeHubTokens {
	if (secret.length < 16) throw new Error('Claude hub secret too short')
	return {
		mint: ref => `v1.${ref.profileId}.${ref.terminalId}.${mac(secret, ref.profileId, ref.terminalId)}`,
		verify: token => {
			const parts = parseClaudeHubToken(token)
			if (!parts) return null
			const expected = Buffer.from(mac(secret, parts.profileId, parts.terminalId))
			const given = Buffer.from(parts.mac)
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
			return { profileId: parts.profileId, terminalId: parts.terminalId }
		},
	}
}

/** Loads or creates the 0600 secret file (its directory 0700). */
export function loadOrCreateClaudeHubSecret(file: string): Buffer {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	chmodSync(dirname(file), 0o700)
	try {
		const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
		try {
			const info = fstatSync(fd)
			const secret = readFileSync(fd)
			if (info.isFile() && (info.mode & 0o077) === 0 && secret.length === SECRET_BYTES) return secret
		} finally {
			closeSync(fd)
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	const secret = randomBytes(SECRET_BYTES)
	const temp = join(dirname(file), `.secret-${process.pid}-${randomBytes(4).toString('hex')}`)
	writeFileSync(temp, secret, { mode: 0o600, flag: 'wx' })
	renameSync(temp, file)
	return secret
}

export interface ClaudeRemoteRuntime {
	socketPath: string
	preloadPath: string
	hookPath: string
	nodePath: string
	tokens: ClaudeHubTokens
}

/** Bun splits BUN_OPTIONS on whitespace without quoting: such a preload path cannot be passed. */
export const bunOptionPathOk = (path: string): boolean => path.length > 0 && !/\s/.test(path)

/**
 * The Helm Claude hub variables for one new terminal (both spawn sites call this
 * after remoteTerminalEnvironment). Inherited HELM_CLAUDE_REMOTE_* are always
 * dropped; with `runtime` null (hub off, no dtach identity) nothing is added.
 * `env` already lacks Helm's own inherited BUN_* (shellEnv strips them), so the
 * preload BUN_OPTIONS is Helm's alone; a user's rc file that sets BUN_OPTIONS
 * later wins, which only turns the feature off for that shell.
 */
export function claudeRemoteTerminalEnvironment(
	env: Record<string, string>,
	ref: TerminalRef | null,
	runtime: ClaudeRemoteRuntime | null,
): Record<string, string> {
	const result = { ...env }
	for (const key of Object.values(CLAUDE_REMOTE_ENV)) delete result[key]
	if (!ref || !runtime || !bunOptionPathOk(runtime.preloadPath)) return result
	result.BUN_OPTIONS = `--preload=${runtime.preloadPath}`
	result[CLAUDE_REMOTE_ENV.socket] = runtime.socketPath
	result[CLAUDE_REMOTE_ENV.token] = runtime.tokens.mint(ref)
	result[CLAUDE_REMOTE_ENV.hook] = runtime.hookPath
	result[CLAUDE_REMOTE_ENV.node] = runtime.nodePath
	return result
}
