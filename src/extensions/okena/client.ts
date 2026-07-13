import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface CliConfig {
	token: string
	token_id: string
}

interface RemoteConfig {
	port: number
	pid: number
}

interface ProfilesConfig {
	last_used?: string
	default_profile?: string
}

interface OkenaCredentials {
	token: string
	baseUrl: string
}

const EXPIRED_TOKEN_HINT =
	'Okena CLI token expired or invalid. Re-register by running the okena binary (e.g. `okena state`), then restart helm.'

export class OkenaClient {
	private baseDir: string

	constructor() {
		this.baseDir =
			process.platform === 'darwin'
				? join(homedir(), 'Library', 'Application Support', 'okena')
				: join(homedir(), '.config', 'okena')
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
			const id = profiles.last_used ?? profiles.default_profile
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
			return { token, baseUrl: `http://127.0.0.1:${remote.port}` }
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
			const res = await fetch(`${creds.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
			return res.ok
		} catch {
			return false
		}
	}

	private async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
		const creds = this.loadCredentials()
		if (!creds) throw new Error('Okena not configured')

		const send = (c: OkenaCredentials) =>
			fetch(`${c.baseUrl}${path}`, {
				...init,
				headers: {
					...(init.headers as Record<string, string> | undefined),
					Authorization: `Bearer ${c.token}`,
				},
			})

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

export interface OkenaState {
	projects: Array<{
		id: string
		name: string
		path: string
		terminal_names?: Record<string, string>
	}>
}

// How long to let a freshly-created/auto okena terminal settle before typing the
// command. okena has no readiness API, so this is a fixed best-effort guard
// (paired with the ctrl_c line-clear); not worth a config knob.
const FRESH_TERMINAL_SETTLE_MS = 1500

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}
