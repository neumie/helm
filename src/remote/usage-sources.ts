import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, opendir, readFile, realpath } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseClaudeWindows, parseCodexWindows, readCodexPlan } from './provider-usage.js'
import { USAGE_REQUEST_TIMEOUT_MS, type UsageProvider } from './usage-protocol.js'

const run = promisify(execFile)

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20'
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage'
/** The endpoint sits behind a filter that rejects a default client string; identify Helm honestly. */
const CODEX_USER_AGENT = 'helm-remote/1.0 (+https://github.com/neumie/helm)'
/** Only the newest sessions can hold the newest limit snapshot; older ones are never worth the read. */
const CODEX_SESSION_FILES = 24
const CODEX_SESSION_ENTRIES = 1024
const CODEX_SESSION_DEPTH = 16
const CODEX_SESSION_TAIL_BYTES = 512 * 1024
const USAGE_RESPONSE_LIMIT = 64 * 1024
/** The filter in front of the endpoint is intermittent, so one immediate retry is worth it. */
const CODEX_ATTEMPTS = 2

export type UsageResult = { status: number; body: JsonObject | null }

export type UsageEnvironment = {
	home: string
	signal?: AbortSignal
	/** Test seam; production uses the fixed absolute provider deadline. */
	timeoutMs?: number
	fetch: typeof globalThis.fetch
	now: () => number
	/** Injected so tests never touch the real Keychain. */
	keychain: (service: string) => Promise<string | null>
	/**
	 * Codex's usage endpoint sits behind a filter that rejects the bundled fetch client
	 * outright, while Node's core HTTPS client is admitted. Same request, same honest
	 * identification — only the client differs.
	 */
	request: (url: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<UsageResult | null>
}

export function defaultUsageEnvironment(): UsageEnvironment {
	return {
		home: homedir(),
		fetch: (...args) => globalThis.fetch(...args),
		now: Date.now,
		keychain: readKeychainSecret,
		request: coreHttpsGet,
	}
}

/** Settles even when an injected dependency ignores cancellation; late work sees an aborted signal. */
export async function withUsageDeadline<T>(
	read: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
	timeoutMs = USAGE_REQUEST_TIMEOUT_MS,
): Promise<T> {
	const controller = new AbortController()
	const abort = () => controller.abort()
	signal?.addEventListener('abort', abort, { once: true })
	if (signal?.aborted) abort()
	const timer = setTimeout(abort, timeoutMs)
	let rejectAbort: () => void = () => {}
	try {
		return await Promise.race([
			new Promise<never>((_resolve, reject) => {
				rejectAbort = () => reject(new Error('Usage read unavailable'))
				controller.signal.addEventListener('abort', rejectAbort, { once: true })
				if (controller.signal.aborted) rejectAbort()
			}),
			Promise.resolve().then(() => {
				controller.signal.throwIfAborted()
				return read(controller.signal)
			}),
		])
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener('abort', abort)
		controller.signal.removeEventListener('abort', rejectAbort)
		controller.abort()
	}
}

function coreHttpsGet(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<UsageResult | null> {
	return withUsageDeadline(
		active =>
			new Promise<UsageResult | null>(resolve => {
				const target = new URL(url)
				let settled = false
				const finish = (value: UsageResult | null) => {
					if (settled) return
					settled = true
					active.removeEventListener('abort', cancel)
					resolve(value)
				}
				const call = httpsRequest(
					{
						host: target.host,
						path: `${target.pathname}${target.search}`,
						method: 'GET',
						headers: { ...headers, Accept: 'application/json' },
					},
					response => {
						const chunks: Buffer[] = []
						let bytes = 0
						response.on('data', (chunk: Buffer) => {
							bytes += chunk.length
							if (bytes > USAGE_RESPONSE_LIMIT) {
								finish(null)
								response.destroy()
								call.destroy()
							} else if (!settled) chunks.push(chunk)
						})
						response.on('end', () => {
							if (!response.complete) cancel()
							else finish({ status: response.statusCode ?? 0, body: parseJson(Buffer.concat(chunks).toString('utf8')) })
						})
						response.on('error', cancel)
						response.on('close', () => {
							if (!settled) cancel()
						})
					},
				)
				const cancel = () => {
					finish(null)
					call.destroy()
				}
				active.addEventListener('abort', cancel, { once: true })
				call.on('error', () => finish(null))
				call.end()
			}),
		signal,
	).catch(() => null)
}

async function readKeychainSecret(service: string): Promise<string | null> {
	if (process.platform !== 'darwin') return null
	const user = process.env.USER
	if (!user) return null
	try {
		const { stdout } = await run('security', ['find-generic-password', '-s', service, '-a', user, '-w'], {
			timeout: 5_000,
			maxBuffer: 256 * 1024,
		})
		const value = stdout.trim()
		return value || null
	} catch {
		return null
	}
}

type JsonObject = Record<string, unknown>

function record(value: unknown): JsonObject | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null
}

/** Provider payloads are always objects; anything else is treated as absent. */
function parseJson(text: string): JsonObject | null {
	try {
		return record(JSON.parse(text))
	} catch {
		return null
	}
}

/**
 * Claude Code keeps its OAuth material in a private credentials file, or on macOS in
 * the login Keychain under a per-config-directory service name. Read-only either way.
 */
export async function readClaudeCredentials(
	env: UsageEnvironment,
): Promise<{ accessToken: string; plan: string | null } | null> {
	const fromText = (text: string): { accessToken: string; plan: string | null } | null => {
		const oauth = record(parseJson(text)?.claudeAiOauth)
		const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : ''
		if (!token) return null
		const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null
		if (expiresAt !== null && expiresAt <= env.now()) return null
		const plan = typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType.trim() : ''
		return { accessToken: token, plan: plan || null }
	}
	env.signal?.throwIfAborted()
	const file = await readFile(join(env.home, '.claude', '.credentials.json'), 'utf8').catch(() => null)
	env.signal?.throwIfAborted()
	const parsed = file === null ? null : fromText(file)
	if (parsed) return parsed
	const secret = await env.keychain(CLAUDE_KEYCHAIN_SERVICE)
	env.signal?.throwIfAborted()
	return secret === null ? null : fromText(secret)
}

export async function readCodexAuth(env: UsageEnvironment): Promise<{ accessToken: string; accountId: string } | null> {
	env.signal?.throwIfAborted()
	const file = await readFile(join(env.home, '.codex', 'auth.json'), 'utf8').catch(() => null)
	env.signal?.throwIfAborted()
	const tokens = file === null ? null : record(parseJson(file)?.tokens)
	const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : ''
	const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id.trim() : ''
	return accessToken && accountId ? { accessToken, accountId } : null
}

async function fetchJson(
	env: UsageEnvironment,
	url: string,
	headers: Record<string, string>,
): Promise<{ status: number; body: JsonObject | null } | null> {
	return withUsageDeadline(
		async signal => {
			const response = await env.fetch(url, { headers, redirect: 'error', signal })
			if (signal.aborted) {
				void response.body?.cancel().catch(() => {})
				signal.throwIfAborted()
			}
			const reader = response.body?.getReader()
			if (!reader) return { status: response.status, body: null }
			const cancel = () => {
				void reader.cancel().catch(() => {})
			}
			signal.addEventListener('abort', cancel, { once: true })
			try {
				const chunks: Uint8Array[] = []
				let bytes = 0
				for (;;) {
					const next = await reader.read()
					signal.throwIfAborted()
					if (next.done) break
					bytes += next.value.byteLength
					if (bytes > USAGE_RESPONSE_LIMIT) return null
					chunks.push(next.value)
				}
				return { status: response.status, body: parseJson(Buffer.concat(chunks).toString('utf8')) }
			} finally {
				signal.removeEventListener('abort', cancel)
				cancel()
			}
		},
		env.signal,
		env.timeoutMs,
	).catch(() => null)
}

export async function readClaudeUsage(env: UsageEnvironment): Promise<UsageProvider> {
	return withUsageDeadline(
		signal => readClaudeUsageWithinDeadline({ ...env, signal }),
		env.signal,
		env.timeoutMs,
	).catch(
		(): UsageProvider => ({
			id: 'claude',
			name: 'Claude Code',
			plan: null,
			windows: [],
			source: null,
			observedAt: null,
			message: 'Usage read unavailable.',
		}),
	)
}

async function readClaudeUsageWithinDeadline(env: UsageEnvironment): Promise<UsageProvider> {
	const base = { id: 'claude' as const, name: 'Claude Code' }
	const credentials = await readClaudeCredentials(env)
	if (!credentials)
		return {
			...base,
			plan: null,
			windows: [],
			source: null,
			observedAt: null,
			message: 'Sign in to Claude Code on this Mac to show its limits.',
		}
	const response = await fetchJson(env, CLAUDE_USAGE_URL, {
		Authorization: `Bearer ${credentials.accessToken}`,
		'anthropic-beta': CLAUDE_OAUTH_BETA,
	})
	if (!response || response.status !== 200)
		return {
			...base,
			plan: credentials.plan,
			windows: [],
			source: null,
			observedAt: null,
			message: response ? `Anthropic returned ${response.status}.` : 'Could not reach Anthropic.',
		}
	const now = env.now()
	const windows = parseClaudeWindows(response.body, now)
	return {
		...base,
		plan: credentials.plan,
		windows,
		source: windows.length ? 'live' : null,
		observedAt: windows.length ? now : null,
		message: windows.length ? null : 'Anthropic reported no limit windows.',
	}
}

type CodexLocal = { windows: ReturnType<typeof parseCodexWindows>; plan: string | null; observedAt: number | null }

/** Read the tail of a rollout file and return its last `token_count` rate-limit snapshot. */
async function readCodexSessionTail(path: string, now: number, signal?: AbortSignal): Promise<CodexLocal | null> {
	signal?.throwIfAborted()
	if ((await realpath(path).catch(() => null)) !== path) return null
	signal?.throwIfAborted()
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null)
	if (!handle) return null
	try {
		signal?.throwIfAborted()
		const before = await handle.stat()
		signal?.throwIfAborted()
		if (!before.isFile() || before.nlink !== 1) return null
		const { size } = before
		const start = Math.max(0, size - CODEX_SESSION_TAIL_BYTES)
		const { buffer, bytesRead } = await handle.read({
			position: start,
			length: Math.min(size, CODEX_SESSION_TAIL_BYTES),
			buffer: Buffer.alloc(Math.min(size, CODEX_SESSION_TAIL_BYTES)),
		})
		signal?.throwIfAborted()
		const after = await handle.stat()
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null
		const text = buffer.subarray(0, bytesRead).toString('utf8')
		const lines = text.split('\n')
		// A tail can begin mid-line; that fragment is never valid JSON anyway.
		if (start > 0) lines.shift()
		let latest: CodexLocal | null = null
		for (const line of lines) {
			if (!line.includes('rate_limits')) continue
			const parsed = parseJson(line)
			const payload = record(parsed?.payload)
			if (parsed?.type !== 'event_msg' || payload?.type !== 'token_count') continue
			const windows = parseCodexWindows(payload.rate_limits, now)
			if (!windows.length) continue
			const timestamp = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN
			latest = {
				windows,
				plan: readCodexPlan(payload.rate_limits),
				observedAt: Number.isFinite(timestamp) ? timestamp : null,
			}
		}
		return latest
	} catch {
		return null
	} finally {
		await handle.close().catch(() => {})
	}
}

/** Charge all entries, not only matches. Incomplete discovery must not claim a newest snapshot. */
async function newestCodexSessions(root: string, signal?: AbortSignal): Promise<string[] | null> {
	let visited = 0
	const walk = async (directory: string, depth: number): Promise<string[] | null> => {
		signal?.throwIfAborted()
		if (depth > CODEX_SESSION_DEPTH || (await realpath(directory).catch(() => null)) !== directory) return null
		signal?.throwIfAborted()
		const before = await lstat(directory).catch(() => null)
		if (!before?.isDirectory() || before.isSymbolicLink()) return null
		signal?.throwIfAborted()
		const dir = await opendir(directory, { bufferSize: 1 }).catch(() => null)
		if (!dir) return null
		const directories: string[] = []
		const files: string[] = []
		try {
			signal?.throwIfAborted()
			const after = await lstat(directory)
			if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()) return null
			for (;;) {
				signal?.throwIfAborted()
				if (visited >= CODEX_SESSION_ENTRIES) return null
				const entry = await dir.read()
				if (!entry) break
				visited += 1
				if (entry.isDirectory()) directories.push(entry.name)
				else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(directory, entry.name))
			}
		} finally {
			await dir.close()
		}
		files.sort().reverse()
		const found = files.slice(0, CODEX_SESSION_FILES)
		for (const name of directories.sort().reverse()) {
			if (found.length >= CODEX_SESSION_FILES) break
			const children = await walk(join(directory, name), depth + 1)
			if (children === null) return null
			found.push(...children.slice(0, CODEX_SESSION_FILES - found.length))
		}
		return found
	}
	return walk(root, 0).catch(() => null)
}

export async function readCodexLocalUsage(env: UsageEnvironment): Promise<CodexLocal | null> {
	const paths = await newestCodexSessions(join(env.home, '.codex', 'sessions'), env.signal)
	if (paths === null) return null
	for (const path of paths) {
		env.signal?.throwIfAborted()
		const found = await readCodexSessionTail(path, env.now(), env.signal)
		if (found) return found
	}
	return null
}

export async function readCodexUsage(env: UsageEnvironment): Promise<UsageProvider> {
	return withUsageDeadline(signal => readCodexUsageWithinDeadline({ ...env, signal }), env.signal, env.timeoutMs).catch(
		(): UsageProvider => ({
			id: 'codex',
			name: 'Codex',
			plan: null,
			windows: [],
			source: null,
			observedAt: null,
			message: 'Usage read unavailable.',
		}),
	)
}

async function readCodexUsageWithinDeadline(env: UsageEnvironment): Promise<UsageProvider> {
	const base = { id: 'codex' as const, name: 'Codex' }
	const auth = await readCodexAuth(env)
	if (!auth)
		return {
			...base,
			plan: null,
			windows: [],
			source: null,
			observedAt: null,
			message: 'Sign in to Codex on this Mac to show its limits.',
		}
	let response: UsageResult | null = null
	for (let attempt = 0; attempt < CODEX_ATTEMPTS && response?.status !== 200; attempt += 1) {
		env.signal?.throwIfAborted()
		response = await env.request(
			CODEX_USAGE_URL,
			{
				Authorization: `Bearer ${auth.accessToken}`,
				'chatgpt-account-id': auth.accountId,
				'User-Agent': CODEX_USER_AGENT,
			},
			env.signal,
		)
	}
	env.signal?.throwIfAborted()
	const now = env.now()
	if (response?.status === 200) {
		const body = response.body
		const windows = parseCodexWindows(body?.rate_limit ?? body?.rate_limits ?? body, now)
		if (windows.length)
			return {
				...base,
				plan: readCodexPlan(body) ?? readCodexPlan(body?.rate_limits),
				windows,
				source: 'live',
				observedAt: now,
				message: null,
			}
	}
	// The cached Codex token is refreshed by Codex itself; rather than rotate it here
	// and risk invalidating that sign-in, fall back to what Codex last recorded locally.
	const local = await readCodexLocalUsage(env)
	if (local)
		return {
			...base,
			plan: local.plan,
			windows: local.windows,
			source: 'local',
			observedAt: local.observedAt,
			message: null,
		}
	return {
		...base,
		plan: null,
		windows: [],
		source: null,
		observedAt: null,
		message: response ? `Codex returned ${response.status}.` : 'Could not reach Codex.',
	}
}

export async function readProviderUsage(env: UsageEnvironment): Promise<UsageProvider[]> {
	return await Promise.all([readClaudeUsage(env), readCodexUsage(env)])
}
