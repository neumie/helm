import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

const PROFILE_STATE_VERSION = 2 as const
const DEFAULT_PROFILE_ID = 'work'
const MAX_PROFILE_NAME_LENGTH = 48
const PROFILE_ID_RE = /^(?:work|profile-[a-f0-9]{12})$/
const KNOWLEDGE_PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/

export interface ProfileKnowledgeBinding {
	projectSlug: string
	providerId: string
	providerProjectId: string
	characterBudget: number
	allowSharedProject: boolean
}

export interface HelmProfile {
	id: string
	name: string
	createdAt: string
	enabledProjects: string[]
	knowledgeBindings: ProfileKnowledgeBinding[]
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

function normalizeKnowledgeBindings(
	values: readonly ProfileKnowledgeBinding[],
	enabledProjects: readonly string[],
): ProfileKnowledgeBinding[] {
	const enabled = new Set(enabledProjects)
	const seenProjects = new Set<string>()
	const normalized = values.map(value => {
		if (!value || typeof value !== 'object') throw new Error('Invalid profile knowledge binding')
		const projectSlug = value.projectSlug.trim()
		const providerId = value.providerId.trim()
		const providerProjectId = value.providerProjectId.trim()
		const hasControl = [...providerProjectId].some(character => {
			const point = character.codePointAt(0) ?? 0
			return point <= 0x1f || point === 0x7f
		})
		if (!enabled.has(projectSlug)) throw new Error('Knowledge bindings require an enabled Helm project')
		if (seenProjects.has(projectSlug)) throw new Error('A profile may bind each project only once')
		if (!KNOWLEDGE_PROVIDER_ID_RE.test(providerId)) throw new Error('Knowledge binding provider id is invalid')
		if (providerProjectId.length < 1 || providerProjectId.length > 200 || hasControl) {
			throw new Error('Knowledge provider project id must contain 1-200 visible characters')
		}
		if (!Number.isInteger(value.characterBudget) || value.characterBudget < 100 || value.characterBudget > 200_000) {
			throw new Error('Knowledge character budget must be an integer from 100 to 200000')
		}
		if (typeof value.allowSharedProject !== 'boolean') throw new Error('Knowledge sharing acknowledgement is invalid')
		seenProjects.add(projectSlug)
		return {
			projectSlug,
			providerId,
			providerProjectId,
			characterBudget: value.characterBudget,
			allowSharedProject: value.allowSharedProject,
		}
	})
	return normalized.sort((left, right) => left.projectSlug.localeCompare(right.projectSlug))
}

function validateSharedKnowledgeProjects(profiles: readonly HelmProfile[]): void {
	const owners = new Map<string, Array<{ profileId: string; allowed: boolean }>>()
	for (const profile of profiles) {
		for (const binding of profile.knowledgeBindings) {
			const key = `${binding.providerId}\0${binding.providerProjectId}`
			const entries = owners.get(key) ?? []
			entries.push({ profileId: profile.id, allowed: binding.allowSharedProject })
			owners.set(key, entries)
		}
	}
	for (const entries of owners.values()) {
		if (new Set(entries.map(entry => entry.profileId)).size > 1 && entries.some(entry => !entry.allowed)) {
			throw new Error('Sharing one provider project across profiles requires explicit acknowledgement in every profile')
		}
	}
}

function isProfile(value: unknown): value is Omit<HelmProfile, 'knowledgeBindings'> & {
	knowledgeBindings?: unknown
} {
	if (!value || typeof value !== 'object') return false
	const profile = value as Record<string, unknown>
	return (
		typeof profile.id === 'string' &&
		PROFILE_ID_RE.test(profile.id) &&
		typeof profile.name === 'string' &&
		typeof profile.createdAt === 'string' &&
		Array.isArray(profile.enabledProjects) &&
		profile.enabledProjects.every(project => typeof project === 'string') &&
		(profile.knowledgeBindings === undefined || Array.isArray(profile.knowledgeBindings)) &&
		(profile.archivedAt === null || typeof profile.archivedAt === 'string')
	)
}

function parseState(raw: unknown): ProfilesState {
	if (!raw || typeof raw !== 'object') throw new Error('Invalid profiles registry')
	const state = raw as Record<string, unknown>
	if (
		(state.version !== 1 && state.version !== PROFILE_STATE_VERSION) ||
		typeof state.generation !== 'number' ||
		!Number.isInteger(state.generation) ||
		state.generation < 1 ||
		typeof state.activeProfileId !== 'string' ||
		!Array.isArray(state.profiles) ||
		!state.profiles.every(isProfile)
	) {
		throw new Error('Invalid profiles registry')
	}
	const profiles: HelmProfile[] = state.profiles.map(profile => {
		const enabledProjects = uniqueProjects(profile.enabledProjects)
		return {
			id: profile.id,
			name: normalizedName(profile.name),
			createdAt: profile.createdAt,
			enabledProjects,
			knowledgeBindings: normalizeKnowledgeBindings(
				Array.isArray(profile.knowledgeBindings)
					? (profile.knowledgeBindings as ProfileKnowledgeBinding[])
					: [],
				enabledProjects,
			),
			archivedAt: profile.archivedAt,
		}
	})
	validateSharedKnowledgeProjects(profiles)
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

	/** Every registered tenant, including archived profiles, for background observers. */
	registeredProfileIds(): string[] {
		return this.state.profiles.map(profile => profile.id)
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

	create(
		nameInput: unknown,
		enabledProjects: readonly string[] = [],
		knowledgeBindings: readonly ProfileKnowledgeBinding[] = [],
	): HelmProfile {
		const name = normalizedName(nameInput)
		this.assertUniqueName(name)
		const projects = uniqueProjects(enabledProjects)
		const profile: HelmProfile = {
			id: `profile-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
			name,
			createdAt: new Date().toISOString(),
			enabledProjects: projects,
			knowledgeBindings: normalizeKnowledgeBindings(knowledgeBindings, projects),
			archivedAt: null,
		}
		mkdirSync(this.profileDir(profile.id), { recursive: true })
		return this.commitMutation(() => {
			this.state.profiles.push(profile)
			return structuredClone(profile)
		})
	}

	update(
		id: string,
		input: {
			name?: unknown
			enabledProjects?: readonly string[]
			knowledgeBindings?: readonly ProfileKnowledgeBinding[]
		},
	): HelmProfile {
		if (input.name !== undefined) {
			const name = normalizedName(input.name)
			this.assertUniqueName(name, id)
		}
		this.requireProfile(id)
		return this.commitMutation(() => {
			const profile = this.requireProfile(id)
			const enabledProjects =
				input.enabledProjects === undefined ? profile.enabledProjects : uniqueProjects(input.enabledProjects)
			const bindings =
				input.knowledgeBindings === undefined
					? profile.knowledgeBindings.filter(binding => enabledProjects.includes(binding.projectSlug))
					: input.knowledgeBindings
			if (input.name !== undefined) profile.name = normalizedName(input.name)
			profile.enabledProjects = enabledProjects
			profile.knowledgeBindings = normalizeKnowledgeBindings(bindings, enabledProjects)
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
				const stat = lstatSync(this.statePath)
				const uid = process.getuid?.()
				if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || uid === undefined || stat.uid !== uid) {
					throw new Error('Profile registry must be an owned, single-link regular file')
				}
				chmodSync(this.statePath, 0o600)
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
					knowledgeBindings: [],
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
			validateSharedKnowledgeProjects(this.state.profiles)
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
