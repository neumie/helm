// The Slack session Helm uses: a per-workspace web-client token (`xoxc-`) plus the shared `d`
// cookie (`xoxd-`), read once from Slack.app's own storage with the user's macOS consent and then
// kept in Helm's own Keychain. No token or cookie is ever logged, printed, written to a file,
// placed on an argv or put in an error string.

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSlackCookie } from './cookies.js'
import {
	HELM_SLACK_INDEX_ACCOUNT,
	HELM_SLACK_SERVICE,
	type KeychainAccess,
	macKeychain,
	readSafeStoragePassword,
} from './keychain.js'
import { decodeLocalStorageValue, localStorageKeyMatcher, readNewestValue } from './leveldb/reader.js'

/** One workspace's session. `cookie` is the shared `d` value; `token` is per workspace. */
export interface SlackSession {
	teamId: string
	token: string
	cookie: string
	name: string
	domain: string
	userId: string
}

/** A session with its secrets removed, for display/logging. */
export interface SlackSessionInfo {
	teamId: string
	name: string
	domain: string
	userId: string
}

export function sessionInfo(session: SlackSession): SlackSessionInfo {
	return { teamId: session.teamId, name: session.name, domain: session.domain, userId: session.userId }
}

export class SlackSessionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SlackSessionError'
	}
}

export interface SlackAppPaths {
	/** Slack.app's Local Storage LevelDB directory. */
	leveldbDir: string
	/** Slack.app's Chromium cookie SQLite file. */
	cookiesPath: string
}

/** Where Slack.app keeps its storage on macOS (overridable via $HELM_SLACK_APP_DIR for tests). */
export function defaultSlackAppPaths(env: NodeJS.ProcessEnv = process.env): SlackAppPaths {
	const base =
		env.HELM_SLACK_APP_DIR ??
		join(homedir(), 'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack')
	return {
		leveldbDir: join(base, 'Local Storage', 'leveldb'),
		cookiesPath: join(base, 'Cookies'),
	}
}

interface TeamConfig {
	id?: unknown
	name?: unknown
	domain?: unknown
	token?: unknown
	user_id?: unknown
}

/** Parse the `teams` map out of a decoded `localConfig_v2` value into sessions (minus the cookie). */
export function parseTeamsFromLocalConfig(text: string): Omit<SlackSession, 'cookie'>[] {
	let config: { teams?: Record<string, TeamConfig> }
	try {
		config = JSON.parse(text)
	} catch {
		throw new SlackSessionError('Slack.app config is not valid JSON (format changed?)')
	}
	const teams = config.teams
	if (!teams || typeof teams !== 'object') throw new SlackSessionError('Slack.app config has no teams')
	const sessions: Omit<SlackSession, 'cookie'>[] = []
	for (const [key, team] of Object.entries(teams)) {
		const token = typeof team.token === 'string' ? team.token : ''
		if (!token.startsWith('xoxc-')) continue
		const teamId = typeof team.id === 'string' && team.id ? team.id : key
		sessions.push({
			teamId,
			token,
			name: typeof team.name === 'string' ? team.name : teamId,
			domain: typeof team.domain === 'string' ? team.domain : '',
			userId: typeof team.user_id === 'string' ? team.user_id : '',
		})
	}
	return sessions
}

export interface ReadSlackAppOptions {
	paths?: SlackAppPaths
	keychain?: KeychainAccess
	/** Test seam: copy a directory tree (defaults to fs.cpSync). */
	copyDir?: (from: string, to: string) => void
	/** Test seam: copy a single file if it exists (defaults to fs.cpSync). */
	copyFile?: (from: string, to: string) => void
}

/**
 * Read every workspace Slack.app is signed into, with the shared cookie attached. Copies the
 * LevelDB dir and the cookie store to a private temp dir first (so a live Slack writing them is
 * never read half-way), reads, then deletes the copy. Reading the Safe Storage password prompts the
 * user — that is their consent, never bypassed.
 */
export async function readSlackAppSessions(options: ReadSlackAppOptions = {}): Promise<SlackSession[]> {
	const paths = options.paths ?? defaultSlackAppPaths()
	const keychain = options.keychain ?? macKeychain
	const copyDir = options.copyDir ?? ((from, to) => cpSync(from, to, { recursive: true }))
	const copyFile = options.copyFile ?? ((from, to) => cpSync(from, to))
	if (!existsSync(paths.leveldbDir)) throw new SlackSessionError('Slack.app is not installed or has no local session')

	const temp = mkdtempSync(join(tmpdir(), 'helm-slack-'))
	try {
		const ldbCopy = join(temp, 'leveldb')
		copyDir(paths.leveldbDir, ldbCopy)
		const value = readNewestValue(ldbCopy, localStorageKeyMatcher('localConfig_v2'))
		if (!value) throw new SlackSessionError('No Slack session found (signed out?)')
		const teams = parseTeamsFromLocalConfig(decodeLocalStorageValue(value))
		if (teams.length === 0) throw new SlackSessionError('No Slack session found (signed out?)')

		const password = await readSafeStoragePassword(keychain)
		if (!password) throw new SlackSessionError('Could not read the Slack Safe Storage key from the Keychain')
		const cookiesCopy = join(temp, 'Cookies')
		if (existsSync(paths.cookiesPath)) copyFile(paths.cookiesPath, cookiesCopy)
		const cookie = readSlackCookie(cookiesCopy, password)
		return teams.map(team => ({ ...team, cookie }))
	} finally {
		rmSync(temp, { recursive: true, force: true })
	}
}

// ---------- Helm's own Keychain store ----------

/** Stored per team under HELM_SLACK_SERVICE; the index account lists connected team ids. */
export class SlackSessionStore {
	constructor(private readonly keychain: KeychainAccess = macKeychain) {}

	async list(): Promise<string[]> {
		const raw = await this.keychain.read(HELM_SLACK_SERVICE, HELM_SLACK_INDEX_ACCOUNT)
		if (!raw) return []
		try {
			const ids = JSON.parse(decode(raw))
			return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
		} catch {
			return []
		}
	}

	async get(teamId: string): Promise<SlackSession | null> {
		const raw = await this.keychain.read(HELM_SLACK_SERVICE, teamId)
		if (!raw) return null
		try {
			const parsed = JSON.parse(decode(raw)) as SlackSession
			return parsed && typeof parsed.token === 'string' && typeof parsed.cookie === 'string' ? parsed : null
		} catch {
			return null
		}
	}

	async save(sessions: SlackSession[]): Promise<void> {
		for (const session of sessions) {
			await this.keychain.write(HELM_SLACK_SERVICE, session.teamId, encode(JSON.stringify(session)))
		}
		const ids = [...new Set([...(await this.list()), ...sessions.map(s => s.teamId)])]
		await this.keychain.write(HELM_SLACK_SERVICE, HELM_SLACK_INDEX_ACCOUNT, encode(JSON.stringify(ids)))
	}

	async remove(teamId?: string): Promise<void> {
		const ids = await this.list()
		const targets = teamId ? ids.filter(id => id === teamId) : ids
		for (const id of targets) await this.keychain.remove(HELM_SLACK_SERVICE, id)
		const remaining = teamId ? ids.filter(id => id !== teamId) : []
		if (remaining.length > 0) {
			await this.keychain.write(HELM_SLACK_SERVICE, HELM_SLACK_INDEX_ACCOUNT, encode(JSON.stringify(remaining)))
		} else {
			await this.keychain.remove(HELM_SLACK_SERVICE, HELM_SLACK_INDEX_ACCOUNT)
		}
	}
}

const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
const decode = (value: string): string => Buffer.from(value, 'base64').toString('utf8')
