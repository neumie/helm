import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { HelmProfile, ProfileKnowledgeBinding, ProfilesState } from './shared-helm'

const APP_PROFILE_STATE_VERSION = 1 as const
const PROFILE_ID_RE = /^(?:work|profile-[a-f0-9]{12})$/

interface AppProfileState {
	version: typeof APP_PROFILE_STATE_VERSION
	activeProfileId: string
	profiles: HelmProfile[]
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function ensurePrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 })
	chmodSync(path, 0o700)
}

function defaultState(): AppProfileState {
	return {
		version: APP_PROFILE_STATE_VERSION,
		activeProfileId: 'work',
		profiles: [
			{
				id: 'work',
				name: 'Work',
				createdAt: '',
				enabledProjects: [],
				knowledgeBindings: [],
				archivedAt: null,
			},
		],
	}
}

function parseState(raw: unknown): AppProfileState {
	if (!raw || typeof raw !== 'object') throw new Error('Invalid app profile cache')
	const state = raw as Record<string, unknown>
	if (
		state.version !== APP_PROFILE_STATE_VERSION ||
		typeof state.activeProfileId !== 'string' ||
		!PROFILE_ID_RE.test(state.activeProfileId) ||
		!Array.isArray(state.profiles)
	) {
		throw new Error('Invalid app profile cache')
	}
	const profiles = state.profiles
		.filter(
			(
				profile,
			): profile is Omit<HelmProfile, 'knowledgeBindings'> & { knowledgeBindings?: ProfileKnowledgeBinding[] } => {
				if (!profile || typeof profile !== 'object') return false
				const candidate = profile as Record<string, unknown>
				return (
					typeof candidate.id === 'string' &&
					PROFILE_ID_RE.test(candidate.id) &&
					typeof candidate.name === 'string' &&
					Array.isArray(candidate.enabledProjects) &&
					(candidate.knowledgeBindings === undefined || Array.isArray(candidate.knowledgeBindings))
				)
			},
		)
		.map(profile => ({ ...profile, knowledgeBindings: profile.knowledgeBindings ?? [] }))
	if (!profiles.some(profile => profile.id === state.activeProfileId)) throw new Error('Active app profile is missing')
	return { version: APP_PROFILE_STATE_VERSION, activeProfileId: state.activeProfileId, profiles }
}

function moveIfPresent(source: string, destination: string): void {
	if (!existsSync(source)) return
	if (existsSync(destination)) {
		throw new Error(`Cannot migrate legacy profile data because both paths exist: ${source} and ${destination}`)
	}
	ensurePrivateDirectory(dirname(destination))
	renameSync(source, destination)
}

export class AppProfileStore {
	private state: AppProfileState
	readonly profilesDir: string
	readonly statePath: string

	constructor(private readonly userDataDir: string) {
		this.profilesDir = join(userDataDir, 'profiles')
		this.statePath = join(userDataDir, 'profile-cache.json')
		ensurePrivateDirectory(this.profilesDir)
		this.migrateLegacyWorkState()
		this.state = this.readState()
		this.writeState()
	}

	getState(): AppProfileState {
		return structuredClone(this.state)
	}

	activeProfileId(): string {
		return this.state.activeProfileId
	}

	activeProfile(): HelmProfile {
		const profile = this.state.profiles.find(candidate => candidate.id === this.state.activeProfileId)
		if (!profile) throw new Error('Active app profile is missing')
		return structuredClone(profile)
	}

	profileDir(id = this.state.activeProfileId): string {
		if (!PROFILE_ID_RE.test(id)) throw new Error('Invalid profile id')
		const candidate = resolve(this.profilesDir, id)
		if (!candidate.startsWith(`${resolve(this.profilesDir)}${sep}`)) throw new Error('Invalid profile path')
		return candidate
	}

	applyDaemonState(state: ProfilesState): void {
		const candidate = parseState({
			version: APP_PROFILE_STATE_VERSION,
			activeProfileId: state.activeProfileId,
			profiles: structuredClone(state.profiles),
		})
		// Daemon state is authoritative. Keep the confirmed identity in memory
		// even when the local cache write fails, so menus/routing cannot fall back
		// to the previous profile after the daemon already committed activation.
		this.state = candidate
		ensurePrivateDirectory(this.profileDir())
		this.writeState()
	}

	private readState(): AppProfileState {
		if (!existsSync(this.statePath)) return defaultState()
		try {
			const stat = lstatSync(this.statePath)
			const uid = process.getuid?.()
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) {
				throw new Error('Unsafe app profile cache')
			}
			chmodSync(this.statePath, 0o600)
			return parseState(JSON.parse(readFileSync(this.statePath, 'utf8')))
		} catch (err) {
			throw new Error(`Could not load app profile cache ${this.statePath}: ${errorMessage(err)}`)
		}
	}

	private migrateLegacyWorkState(): void {
		const workDir = this.profileDir('work')
		ensurePrivateDirectory(workDir)
		const moves = [
			[join(this.userDataDir, 'sessions.json'), join(workDir, 'sessions.json')],
			[join(this.userDataDir, 'buffers'), join(workDir, 'buffers')],
		] as const
		// Preflight the whole migration so a collision cannot leave only one of
		// registry/buffers moved. Missing sources make reruns idempotent.
		for (const [source, destination] of moves) {
			if (existsSync(source) && existsSync(destination)) {
				throw new Error(`Cannot migrate legacy profile data because both paths exist: ${source} and ${destination}`)
			}
		}
		for (const [source, destination] of moves) moveIfPresent(source, destination)
	}

	private writeState(): void {
		ensurePrivateDirectory(dirname(this.statePath))
		const temp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
		try {
			writeFileSync(temp, `${JSON.stringify(this.state, null, '\t')}\n`, {
				encoding: 'utf8',
				mode: 0o600,
				flag: 'wx',
			})
			renameSync(temp, this.statePath)
			chmodSync(this.statePath, 0o600)
		} finally {
			if (existsSync(temp)) rmSync(temp, { force: true })
		}
	}
}
