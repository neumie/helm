import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface CliConfig {
	token: string
	token_id: string
}

interface RemoteConfig {
	port: number
	pid: number
	local_endpoint?: {
		kind?: string
		path?: string
	}
}

interface ProfilesConfig {
	last_used?: string
	default_profile?: string
	profiles?: Array<{ id: string }>
}

type OkenaEndpoint = { kind: 'unixSocket'; socketPath: string } | { kind: 'http'; baseUrl: string }

interface OkenaCredentials {
	token: string
	endpoint: OkenaEndpoint
}

const EXPIRED_TOKEN_HINT =
	'Okena CLI token expired or invalid. Re-register with the Okena binary’s `state` command, then retry this action; Helm reloads the token automatically.'

export class OkenaClient {
	private baseDir: string

	constructor(
		baseDir?: string,
		private readonly profileId?: string,
	) {
		this.baseDir =
			baseDir ??
			(process.platform === 'darwin'
				? join(homedir(), 'Library', 'Application Support', 'okena')
				: join(homedir(), '.config', 'okena'))
	}

	/**
	 * Pin subsequent requests to the profile whose workspace owns `repoPath`.
	 * Multiple Okena profile windows can remain live at once; `last_used` only
	 * describes the most recently launched one and can disagree with the window
	 * the operator is using.
	 */
	forProject(repoPath: string): OkenaClient {
		const profilesPath = join(this.baseDir, 'profiles.json')
		try {
			const profiles: ProfilesConfig = JSON.parse(readFileSync(profilesPath, 'utf-8'))
			const ids = [
				this.profileId,
				profiles.last_used,
				profiles.default_profile,
				...(profiles.profiles ?? []).map(p => p.id),
			]
			for (const id of new Set(ids.filter((value): value is string => Boolean(value)))) {
				const workspacePath = join(this.baseDir, 'profiles', id, 'workspace.json')
				if (!existsSync(workspacePath)) continue
				const workspace: { projects?: Array<{ path?: string }> } = JSON.parse(readFileSync(workspacePath, 'utf-8'))
				if (workspace.projects?.some(project => project.path === repoPath)) {
					return new OkenaClient(this.baseDir, id)
				}
			}
		} catch {
			// Preserve the existing active-profile behavior when registry inspection
			// is unavailable or malformed.
		}
		return this
	}

	/**
	 * Resolve the directory holding cli.json / remote.json.
	 *
	 * Okena keeps credentials under `profiles/<id>/`. The active profile comes
	 * from profiles.json (`last_used` → `default_profile`). Resolved per call —
	 * the active profile can change at runtime.
	 */
	private resolveConfigDir(): string | null {
		const profilesPath = join(this.baseDir, 'profiles.json')
		if (!existsSync(profilesPath)) return null
		try {
			const profiles: ProfilesConfig = JSON.parse(readFileSync(profilesPath, 'utf-8'))
			const id = this.profileId ?? profiles.last_used ?? profiles.default_profile
			if (!id) return null
			const dir = join(this.baseDir, 'profiles', id)
			return existsSync(dir) ? dir : null
		} catch {
			return null
		}
	}

	private loadCredentials(): OkenaCredentials | null {
		const configDir = this.resolveConfigDir()
		if (!configDir) return null
		const cliPath = join(configDir, 'cli.json')
		if (!existsSync(cliPath)) return null

		let token: string
		try {
			const cli: CliConfig = JSON.parse(readFileSync(cliPath, 'utf-8'))
			token = cli.token
		} catch {
			return null
		}

		const remotePath = join(configDir, 'remote.json')
		if (!existsSync(remotePath)) return null

		try {
			const remote: RemoteConfig = JSON.parse(readFileSync(remotePath, 'utf-8'))
			if (remote.pid && !this.isProcessAlive(remote.pid)) return null
			const localEndpoint = remote.local_endpoint
			const endpoint: OkenaEndpoint =
				localEndpoint?.kind === 'unix_socket' && localEndpoint.path
					? { kind: 'unixSocket', socketPath: localEndpoint.path }
					: { kind: 'http', baseUrl: `http://127.0.0.1:${remote.port}` }
			return { token, endpoint }
		} catch {
			return null
		}
	}

	private isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0)
			return true
		} catch {
			return false
		}
	}

	async isAvailable(): Promise<boolean> {
		const creds = this.loadCredentials()
		if (!creds) return false
		try {
			const res = await requestEndpoint(creds.endpoint, '/health', { signal: AbortSignal.timeout(2000) })
			return res.ok
		} catch {
			return false
		}
	}

	private async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
		const creds = this.loadCredentials()
		if (!creds) throw new Error('Okena not configured')

		const send = (c: OkenaCredentials) => {
			const headers = new Headers(init.headers)
			headers.set('Authorization', `Bearer ${c.token}`)
			return requestEndpoint(c.endpoint, path, { ...init, headers })
		}

		const res = await send(creds)
		if (res.status !== 401) return res

		// Token may have been refreshed externally between read and send — re-read and retry once.
		const fresh = this.loadCredentials()
		if (!fresh || fresh.token === creds.token) return res
		return send(fresh)
	}

	async action<T = unknown>(payload: Record<string, unknown>): Promise<T> {
		const res = await this.authorizedFetch('/v1/actions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})

		if (!res.ok) {
			if (res.status === 401) throw new Error(`Okena action failed (401): ${EXPIRED_TOKEN_HINT}`)
			const body = await res.text()
			throw new Error(`Okena action failed (${res.status}): ${body}`)
		}

		return res.json() as Promise<T>
	}

	/**
	 * Run a command in a terminal, defended against a freshly-created/auto terminal
	 * that is still initializing or carrying leftover text on its prompt line —
	 * which otherwise merges into our command (e.g. `<dir> in kcd '...'` →
	 * `command not found: in`). When `freshTerminal`, wait for the shell to settle
	 * and clear the input line with ctrl_c before running. Never pass
	 * `freshTerminal` for a REUSED terminal that may have a running agent — ctrl_c
	 * would abort it.
	 */
	async runCommand(terminalId: string, command: string, opts?: { freshTerminal?: boolean }): Promise<void> {
		if (opts?.freshTerminal) {
			await delay(FRESH_TERMINAL_SETTLE_MS)
			try {
				await this.action({ action: 'send_special_key', terminal_id: terminalId, key: 'ctrl_c' })
				await delay(200)
			} catch {
				// best-effort line clear
			}
		}
		await this.action({ action: 'run_command', terminal_id: terminalId, command })
	}

	async getState(): Promise<OkenaState> {
		const res = await this.authorizedFetch('/v1/state')
		if (!res.ok) {
			if (res.status === 401) throw new Error(`Okena state failed (401): ${EXPIRED_TOKEN_HINT}`)
			throw new Error(`Okena state failed (${res.status})`)
		}
		return res.json() as Promise<OkenaState>
	}
}

/** Compatibility wrapper for injected test/client doubles created before profile routing. */
export function okenaClientForProject(client: OkenaClient, repoPath: string): OkenaClient {
	const select = (client as { forProject?: (path: string) => OkenaClient }).forProject
	return typeof select === 'function' ? select.call(client, repoPath) : client
}

export type OkenaLayoutNode =
	| { type: 'terminal'; terminal_id: string | null; detached?: boolean }
	| { type: 'split'; children: OkenaLayoutNode[] }
	| { type: 'tabs'; children: OkenaLayoutNode[]; active_tab: number }

export interface OkenaState {
	projects: Array<{
		id: string
		name: string
		path: string
		layout?: OkenaLayoutNode | null
		terminal_names?: Record<string, string>
		git_status?: { branch?: string | null } | null
		worktree_info?: { parent_project_id: string } | null
	}>
}

function requestEndpoint(endpoint: OkenaEndpoint, path: string, init: RequestInit = {}): Promise<Response> {
	if (endpoint.kind === 'http') return fetch(`${endpoint.baseUrl}${path}`, init)
	if (init.body !== null && init.body !== undefined && typeof init.body !== 'string') {
		return Promise.reject(new Error('Okena Unix-socket requests require a string body'))
	}

	return new Promise((resolve, reject) => {
		let settled = false
		const fail = (error: Error) => {
			if (settled) return
			settled = true
			reject(error)
		}
		const headers = Object.fromEntries(new Headers(init.headers).entries())
		const req = request(
			{
				socketPath: endpoint.socketPath,
				path,
				method: init.method ?? 'GET',
				headers,
				signal: init.signal ?? undefined,
			},
			res => {
				const chunks: Buffer[] = []
				res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
				res.once('aborted', () => fail(new Error('Okena Unix-socket response aborted')))
				res.once('error', fail)
				res.on('end', () => {
					if (settled) return
					settled = true
					const body = Buffer.concat(chunks)
					resolve(
						new Response(body.length > 0 ? body : null, {
							status: res.statusCode ?? 500,
							statusText: res.statusMessage,
						}),
					)
				})
			},
		)
		req.once('error', fail)
		if (init.body) req.write(init.body)
		req.end()
	})
}

// How long to let a freshly-created/auto okena terminal settle before typing the
// command. okena has no readiness API, so this is a fixed best-effort guard
// (paired with the ctrl_c line-clear); not worth a config knob.
const FRESH_TERMINAL_SETTLE_MS = 1500

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}
