import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

const PROFILE_STATE_VERSION = 1 as const
const DEFAULT_PROFILE_ID = 'work'
const MAX_PROFILE_NAME_LENGTH = 48
const PROFILE_ID_RE = /^(?:work|profile-[a-f0-9]{12})$/

export interface HelmProfile {
	id: string
	name: string
	createdAt: string
	enabledProjects: string[]
	archivedAt: string | null
}

export interface ProfilesState {
	version: typeof PROFILE_STATE_VERSION
	generation: number
	activeProfileId: string
	profiles: HelmProfile[]
}

export interface ProfileRuntime {
	profile: HelmProfile
	generation: number
	rootDir: string
	/** Shared daemon database; profile files remain under rootDir. */
	dbPath: string
	attachmentsDir: string
	logsDir: string
}

function normalizedName(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Profile name must be text')
	const name = value.normalize('NFC').trim()
	const hasControlCharacter = [...name].some(character => {
		const codePoint = character.codePointAt(0) ?? 0
		return codePoint <= 0x1f || codePoint === 0x7f
	})
	if (name.length === 0 || name.length > MAX_PROFILE_NAME_LENGTH || hasControlCharacter) {
		throw new Error(`Profile name must be 1-${MAX_PROFILE_NAME_LENGTH} visible characters`)
	}
	return name
}

function uniqueProjects(values: readonly string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function isProfile(value: unknown): value is HelmProfile {
	if (!value || typeof value !== 'object') return false
	const profile = value as Record<string, unknown>
	return (
		typeof profile.id === 'string' &&
		PROFILE_ID_RE.test(profile.id) &&
		typeof profile.name === 'string' &&
		typeof profile.createdAt === 'string' &&
		Array.isArray(profile.enabledProjects) &&
		profile.enabledProjects.every(project => typeof project === 'string') &&
		(profile.archivedAt === null || typeof profile.archivedAt === 'string')
	)
}

function parseState(raw: unknown): ProfilesState {
	if (!raw || typeof raw !== 'object') throw new Error('Invalid profiles registry')
	const state = raw as Record<string, unknown>
	if (
		state.version !== PROFILE_STATE_VERSION ||
		typeof state.generation !== 'number' ||
		!Number.isInteger(state.generation) ||
		state.generation < 1 ||
		typeof state.activeProfileId !== 'string' ||
		!Array.isArray(state.profiles) ||
		!state.profiles.every(isProfile)
	) {
		throw new Error('Invalid profiles registry')
	}
	const profiles = state.profiles.map(profile => ({
		...profile,
		name: normalizedName(profile.name),
		enabledProjects: uniqueProjects(profile.enabledProjects),
	}))
	if (!profiles.some(profile => profile.id === state.activeProfileId && profile.archivedAt === null)) {
		throw new Error('Profiles registry active profile is missing or archived')
	}
	return {
		version: PROFILE_STATE_VERSION,
		generation: state.generation,
		activeProfileId: state.activeProfileId,
		profiles,
	}
}

function moveIfPresent(source: string, destination: string): void {
	if (!existsSync(source)) return
	if (existsSync(destination)) {
		throw new Error(`Profile migration collision: both ${source} and ${destination} exist`)
	}
	mkdirSync(dirname(destination), { recursive: true })
	renameSync(source, destination)
}

export class ProfileStore {
	readonly rootDir: string
	readonly profilesDir: string
	readonly statePath: string
	private state: ProfilesState

	constructor(rootDir = process.cwd(), initialProjectSlugs: readonly string[] = []) {
		this.rootDir = resolve(rootDir)
		this.profilesDir = join(this.rootDir, 'profiles')
		this.statePath = join(this.rootDir, 'profiles.json')
		this.state = this.loadOrInitialize(initialProjectSlugs)
	}

	getState(): ProfilesState {
		return structuredClone(this.state)
	}

	activeProfile(): HelmProfile {
		return structuredClone(this.requireProfile(this.state.activeProfileId))
	}

	activeRuntime(): ProfileRuntime {
		return this.runtimeFor(this.state.activeProfileId)
	}

	runtimeFor(id: string): ProfileRuntime {
		const profile = this.requireProfile(id)
		const rootDir = this.profileDir(id)
		return {
			profile: structuredClone(profile),
			generation: this.state.generation,
			rootDir,
			dbPath: join(this.rootDir, 'helm.db'),
			attachmentsDir: join(rootDir, 'attachments'),
			logsDir: join(rootDir, 'logs'),
		}
	}

	create(nameInput: unknown, enabledProjects: readonly string[] = []): HelmProfile {
		const name = normalizedName(nameInput)
		this.assertUniqueName(name)
		const profile: HelmProfile = {
			id: `profile-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
			name,
			createdAt: new Date().toISOString(),
			enabledProjects: uniqueProjects(enabledProjects),
			archivedAt: null,
		}
		mkdirSync(this.profileDir(profile.id), { recursive: true })
		return this.commitMutation(() => {
			this.state.profiles.push(profile)
			return structuredClone(profile)
		})
	}

	update(id: string, input: { name?: unknown; enabledProjects?: readonly string[] }): HelmProfile {
		if (input.name !== undefined) {
			const name = normalizedName(input.name)
			this.assertUniqueName(name, id)
		}
		this.requireProfile(id)
		return this.commitMutation(() => {
			const profile = this.requireProfile(id)
			if (input.name !== undefined) profile.name = normalizedName(input.name)
			if (input.enabledProjects !== undefined) profile.enabledProjects = uniqueProjects(input.enabledProjects)
			return structuredClone(profile)
		})
	}

	archive(id: string): HelmProfile {
		if (id === this.state.activeProfileId) throw new Error('The active profile cannot be archived')
		this.requireProfile(id)
		return this.commitMutation(() => {
			const profile = this.requireProfile(id)
			profile.archivedAt ??= new Date().toISOString()
			return structuredClone(profile)
		})
	}

	restore(id: string): HelmProfile {
		this.requireProfile(id)
		return this.commitMutation(() => {
			const profile = this.requireProfile(id)
			profile.archivedAt = null
			return structuredClone(profile)
		})
	}

	activate(id: string): ProfilesState {
		const profile = this.requireProfile(id)
		if (profile.archivedAt) throw new Error('Archived profiles must be restored before switching')
		if (id === this.state.activeProfileId) return this.getState()
		mkdirSync(this.profileDir(id), { recursive: true })
		return this.commitMutation(() => {
			this.state.activeProfileId = id
			this.state.generation += 1
			return this.getState()
		})
	}

	private loadOrInitialize(initialProjectSlugs: readonly string[]): ProfilesState {
		if (existsSync(this.statePath)) {
			try {
				return parseState(JSON.parse(readFileSync(this.statePath, 'utf8')))
			} catch (err) {
				throw new Error(
					`Could not load profile registry ${this.statePath}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}
		mkdirSync(this.profilesDir, { recursive: true })
		const workDir = this.profileDir(DEFAULT_PROFILE_ID)
		mkdirSync(workDir, { recursive: true })
		this.migrateLegacyRuntime(workDir)
		const state: ProfilesState = {
			version: PROFILE_STATE_VERSION,
			generation: 1,
			activeProfileId: DEFAULT_PROFILE_ID,
			profiles: [
				{
					id: DEFAULT_PROFILE_ID,
					name: 'Work',
					createdAt: new Date().toISOString(),
					enabledProjects: uniqueProjects(initialProjectSlugs),
					archivedAt: null,
				},
			],
		}
		this.state = state
		this.writeState()
		return state
	}

	private migrateLegacyRuntime(workDir: string): void {
		// The database is daemon-global in the profile model. Preserve an existing
		// root helm.db; only apply the pre-rename vigil.db identity migration here.
		for (const suffix of ['', '-wal', '-shm']) {
			moveIfPresent(join(this.rootDir, `vigil.db${suffix}`), join(this.rootDir, `helm.db${suffix}`))
		}
		for (const directory of ['attachments', 'logs']) {
			const source = join(this.rootDir, directory)
			const destination = join(workDir, directory)
			if (existsSync(source) && statSync(source).isDirectory()) moveIfPresent(source, destination)
		}
	}

	private profileDir(id: string): string {
		if (!PROFILE_ID_RE.test(id)) throw new Error('Invalid profile id')
		const candidate = resolve(this.profilesDir, id)
		const prefix = `${resolve(this.profilesDir)}${sep}`
		if (!candidate.startsWith(prefix) || basename(candidate) !== id) throw new Error('Invalid profile path')
		return candidate
	}

	private requireProfile(id: string): HelmProfile {
		const profile = this.state.profiles.find(candidate => candidate.id === id)
		if (!profile) throw new Error(`Profile not found: ${id}`)
		return profile
	}

	private assertUniqueName(name: string, exceptId?: string): void {
		const key = name.normalize('NFC').toLocaleLowerCase('en-US')
		if (
			this.state.profiles.some(
				profile => profile.id !== exceptId && profile.name.normalize('NFC').toLocaleLowerCase('en-US') === key,
			)
		) {
			throw new Error(`A profile named “${name}” already exists`)
		}
	}

	private commitMutation<T>(mutate: () => T): T {
		const previous = this.getState()
		try {
			const result = mutate()
			this.writeState()
			return result
		} catch (err) {
			this.state = previous
			throw err
		}
	}

	private writeState(): void {
		mkdirSync(dirname(this.statePath), { recursive: true })
		const temp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
		try {
			writeFileSync(temp, `${JSON.stringify(this.state, null, '\t')}\n`, { encoding: 'utf8', mode: 0o600 })
			renameSync(temp, this.statePath)
		} finally {
			if (existsSync(temp)) rmSync(temp, { force: true })
		}
	}
}
