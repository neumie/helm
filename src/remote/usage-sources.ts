import { execFile } from 'node:child_process'
import { open, readFile, readdir } from 'node:fs/promises'
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
const CODEX_SESSION_TAIL_BYTES = 512 * 1024
const USAGE_RESPONSE_LIMIT = 64 * 1024
/** The filter in front of the endpoint is intermittent, so one immediate retry is worth it. */
const CODEX_ATTEMPTS = 2

export type UsageResult = { status: number; body: JsonObject | null }

export type UsageEnvironment = {
	home: string
	fetch: typeof globalThis.fetch
	now: () => number
	/** Injected so tests never touch the real Keychain. */
	keychain: (service: string) => Promise<string | null>
	/**
	 * Codex's usage endpoint sits behind a filter that rejects the bundled fetch client
	 * outright, while Node's core HTTPS client is admitted. Same request, same honest
	 * identification — only the client differs.
	 */
	request: (url: string, headers: Record<string, string>) => Promise<UsageResult | null>
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

function coreHttpsGet(url: string, headers: Record<string, string>): Promise<UsageResult | null> {
	return new Promise(resolve => {
		let target: URL
		try {
			target = new URL(url)
		} catch {
			resolve(null)
			return
		}
		const call = httpsRequest(
			{
				host: target.host,
				path: `${target.pathname}${target.search}`,
				method: 'GET',
				headers: { ...headers, Accept: 'application/json' },
				timeout: USAGE_REQUEST_TIMEOUT_MS,
			},
			response => {
				const status = response.statusCode ?? 0
				let text = ''
				response.setEncoding('utf8')
				response.on('data', chunk => {
					// A challenge page is HTML and unbounded; only a small JSON answer is useful.
					if (text.length < USAGE_RESPONSE_LIMIT) text += chunk
				})
				response.on('end', () => resolve({ status, body: parseJson(text) }))
				response.on('error', () => resolve(null))
			},
		)
		call.on('timeout', () => call.destroy())
		call.on('error', () => resolve(null))
		call.end()
	})
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
	const file = await readFile(join(env.home, '.claude', '.credentials.json'), 'utf8').catch(() => null)
	const parsed = file === null ? null : fromText(file)
	if (parsed) return parsed
	const secret = await env.keychain(CLAUDE_KEYCHAIN_SERVICE)
	return secret === null ? null : fromText(secret)
}

export async function readCodexAuth(env: UsageEnvironment): Promise<{ accessToken: string; accountId: string } | null> {
	const file = await readFile(join(env.home, '.codex', 'auth.json'), 'utf8').catch(() => null)
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
	try {
		const response = await env.fetch(url, {
			headers,
			redirect: 'error',
			signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
		})
		const text = await response.text()
		return { status: response.status, body: parseJson(text) }
	} catch {
		return null
	}
}

export async function readClaudeUsage(env: UsageEnvironment): Promise<UsageProvider> {
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
async function readCodexSessionTail(path: string, now: number): Promise<CodexLocal | null> {
	const handle = await open(path, 'r').catch(() => null)
	if (!handle) return null
	try {
		const { size } = await handle.stat()
		const start = Math.max(0, size - CODEX_SESSION_TAIL_BYTES)
		const { buffer, bytesRead } = await handle.read({
			position: start,
			length: Math.min(size, CODEX_SESSION_TAIL_BYTES),
			buffer: Buffer.alloc(Math.min(size, CODEX_SESSION_TAIL_BYTES)),
		})
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

/** Walk the date-partitioned session tree newest-first without listing every historical day. */
async function newestCodexSessions(root: string, budget: number): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
	const directories = entries
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort()
		.reverse()
	const files = entries
		.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
		.map(entry => entry.name)
		.sort()
		.reverse()
		.slice(0, budget)
		.map(name => join(root, name))
	const found = [...files]
	for (const directory of directories) {
		if (found.length >= budget) break
		found.push(...(await newestCodexSessions(join(root, directory), budget - found.length)))
	}
	return found.slice(0, budget)
}

export async function readCodexLocalUsage(env: UsageEnvironment): Promise<CodexLocal | null> {
	const paths = await newestCodexSessions(join(env.home, '.codex', 'sessions'), CODEX_SESSION_FILES)
	for (const path of paths) {
		const found = await readCodexSessionTail(path, env.now())
		if (found) return found
	}
	return null
}

export async function readCodexUsage(env: UsageEnvironment): Promise<UsageProvider> {
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
	for (let attempt = 0; attempt < CODEX_ATTEMPTS && response?.status !== 200; attempt += 1)
		response = await env.request(CODEX_USAGE_URL, {
			Authorization: `Bearer ${auth.accessToken}`,
			'chatgpt-account-id': auth.accountId,
			'User-Agent': CODEX_USER_AGENT,
		})
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
