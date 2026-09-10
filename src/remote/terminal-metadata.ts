import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { RemoteTerminalMetadata } from './protocol.js'

const execFileAsync = promisify(execFile)
const safeId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const profilesSchema = z.object({ profiles: z.array(z.object({ id: safeId })).max(16) })
const workspaceSchema = z.object({
	projects: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				path: z.string().optional(),
				layout: z.unknown(),
				terminal_names: z.record(z.string()).optional(),
				connection_id: z.string().nullable().optional(),
				worktree_info: z.object({ parent_project_id: z.string() }).nullable().optional(),
			}),
		)
		.max(1024),
	folders: z
		.array(z.object({ name: z.string(), project_ids: z.array(z.string()).max(1024) }))
		.max(1024)
		.optional(),
})
const MAX_FILE_BYTES = 2 * 1024 * 1024

function label(value: unknown): string | null {
	if (typeof value !== 'string') return null
	// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately remove terminal control characters from display labels.
	const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim()
	// Preserve a complete Unicode prefix within the wire's UTF-16 bound.
	return clean.slice(0, 160).replace(/[\uD800-\uDBFF]$/, '') || null
}
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Read-only display metadata, not a credential reader or an ownership attestation. */
async function readDocument(file: string, limit = MAX_FILE_BYTES): Promise<unknown | null> {
	try {
		if (!isAbsolute(file) || (await realpath(dirname(file))) !== dirname(file)) throw new Error('metadata_directory')
		const parent = await lstat(dirname(file))
		if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0)
			throw new Error('metadata_directory')
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		try {
			const before = await handle.stat()
			if (
				!before.isFile() ||
				before.nlink !== 1 ||
				before.uid !== process.getuid?.() ||
				(before.mode & 0o022) !== 0 ||
				before.size > limit
			)
				throw new Error('metadata_file')
			const buffer = Buffer.alloc(limit + 1)
			let size = 0
			while (size < buffer.length) {
				const { bytesRead } = await handle.read(buffer, size, Math.min(65536, buffer.length - size), size)
				if (!bytesRead) break
				size += bytesRead
			}
			const after = await handle.stat()
			if (
				size > limit ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			)
				throw new Error('metadata_changed')
			return JSON.parse(buffer.subarray(0, size).toString('utf8'))
		} finally {
			await handle.close()
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}

function containsTerminal(layout: unknown, terminalId: string): boolean {
	const pending = [layout]
	let found = false
	for (let visits = 0; pending.length; visits++) {
		if (visits >= 4096) throw new Error('metadata_layout_limit')
		const node = record(pending.pop())
		if (node.type === 'terminal' && node.terminal_id === terminalId && node.detached !== true) found = true
		if (node.type === 'split' || node.type === 'tabs') {
			if (!Array.isArray(node.children) || node.children.length > 4096) throw new Error('metadata_layout')
			pending.push(...node.children)
		}
	}
	return found
}

type BranchReader = (path: string) => Promise<string | null>

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		// Git repository/config/tracing variables are process context, not metadata input.
		// In particular, an inherited GIT_DIR can make `git -C` inspect another repository.
		if (/^GIT_/i.test(key) || value === undefined) continue
		env[key] = value
	}
	// Keep this read strictly non-interactive and prevent Git from taking optional locks.
	env.GIT_CONFIG_NOSYSTEM = '1'
	env.GIT_OPTIONAL_LOCKS = '0'
	env.GIT_TERMINAL_PROMPT = '0'
	return env
}

async function readGitBranch(path: string): Promise<string | null> {
	if (!isAbsolute(path) || path.length > 4096) return null
	try {
		const directory = await lstat(path)
		if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) return null
		const canonical = await realpath(path)
		if (canonical !== path) return null
		const { stdout } = await execFileAsync(
			'git',
			['--no-optional-locks', '-C', canonical, 'branch', '--show-current'],
			{
				env: isolatedGitEnvironment(),
				maxBuffer: 4096,
				timeout: 2000,
			},
		)
		return label(stdout)
	} catch {
		return null
	}
}

async function readOkena(
	base: string,
	terminalId: string,
	readBranch: BranchReader,
): Promise<RemoteTerminalMetadata | null> {
	const registry = await readDocument(join(base, 'profiles.json'), 65536)
	const paths =
		registry === null
			? [join(base, 'workspace.json')]
			: [...new Set(profilesSchema.parse(registry).profiles.map(profile => profile.id))].map(id =>
					join(base, 'profiles', id, 'workspace.json'),
				)
	const matches: Array<{ metadata: RemoteTerminalMetadata; projectPath: string | null }> = []
	for (const path of paths) {
		const raw = await readDocument(path)
		if (raw === null) continue
		const workspace = workspaceSchema.parse(raw)
		for (const project of workspace.projects) {
			// A cached remote project or stale terminal_names entry is not this local pane.
			if (project.connection_id || !containsTerminal(project.layout, terminalId)) continue
			const parents = workspace.projects.filter(
				candidate => candidate.id === project.worktree_info?.parent_project_id && !candidate.connection_id,
			)
			const isWorktree = project.worktree_info !== null && project.worktree_info !== undefined
			const folderProjectId = parents.length === 1 ? (parents[0]?.id ?? project.id) : project.id
			const folders = workspace.folders?.filter(folder => folder.project_ids.includes(folderProjectId)) ?? []
			matches.push({
				metadata: {
					source: 'okena',
					name: label(project.terminal_names?.[terminalId]),
					project: isWorktree ? label(parents.length === 1 ? parents[0]?.name : null) : label(project.name),
					worktree: isWorktree ? label(project.name) : null,
					branch: null,
					group: folders.length === 1 ? label(folders[0]?.name) : null,
				},
				projectPath: project.path ?? null,
			})
		}
	}
	// Copied/stale profile documents may repeat a terminal ID. Never pick last_used or the first match.
	if (matches.length !== 1) return null
	const match = matches[0]
	if (!match) return null
	let branch: string | null = null
	if (match.projectPath) {
		try {
			branch = label(await readBranch(match.projectPath))
		} catch {
			branch = null
		}
	}
	return { ...match.metadata, branch }
}

async function readHelm(file: string, terminalId: string): Promise<RemoteTerminalMetadata | null> {
	if (!isAbsolute(file) || basename(file) !== 'sessions.json') return null
	const document = record(await readDocument(file))
	if (!Object.hasOwn(document, terminalId)) return null
	const session = record(document[terminalId])
	const groups = record(document._tabGroups)
	const group =
		typeof session.groupId === 'string' && Object.hasOwn(groups, session.groupId) ? record(groups[session.groupId]) : {}
	return {
		source: 'helm',
		name: label(session.customName) ?? label(session.lastTitle),
		project: null,
		worktree: null,
		branch: null,
		group: label(group.name),
	}
}

/** Main-owned launch metadata. Never accept these fields from renderer spawn arguments. */
export function remoteTerminalEnvironment(
	env: Record<string, string>,
	identity: { sessionId: string; registryFile: string } | null,
): Record<string, string> {
	const result = { ...env }
	for (const key of ['OKENA_TERMINAL_ID', 'HELM_REMOTE_TERMINAL_ID', 'HELM_REMOTE_TERMINAL_REGISTRY'])
		delete result[key]
	if (
		identity &&
		safeId.safeParse(identity.sessionId).success &&
		isAbsolute(identity.registryFile) &&
		basename(identity.registryFile) === 'sessions.json'
	) {
		result.HELM_REMOTE_TERMINAL_ID = identity.sessionId
		result.HELM_REMOTE_TERMINAL_REGISTRY = identity.registryFile
	}
	return result
}

/** Capture identity once per existing Pi owner. Paths/IDs stay local; only bounded labels leave this seam. */
export function createTerminalMetadataReader(
	options: { env?: NodeJS.ProcessEnv; home?: string; platform?: string; readBranch?: BranchReader } = {},
): () => Promise<RemoteTerminalMetadata | null> {
	const env = options.env ?? process.env
	const helmId = env.HELM_REMOTE_TERMINAL_ID
	const registry = env.HELM_REMOTE_TERMINAL_REGISTRY
	const okenaId = env.OKENA_TERMINAL_ID
	const home = options.home ?? homedir()
	const base =
		(options.platform ?? process.platform) === 'darwin'
			? join(home, 'Library', 'Application Support', 'okena')
			: join(home, '.config', 'okena')
	// Helm launched from an Okena shell can inherit its ID. Older Helm shells must not claim that outer pane.
	if (env.HELM_TERMINAL_AGENT_STATUS === '1' || helmId || registry) {
		if (okenaId) return async () => null // Both launchers are present; do not guess which one owns the pane.
		return helmId && registry && safeId.safeParse(helmId).success ? () => readHelm(registry, helmId) : async () => null
	}
	return okenaId && safeId.safeParse(okenaId).success
		? () => readOkena(base, okenaId, options.readBranch ?? readGitBranch)
		: async () => null
}

/** Refresh off the exchange hot path; one bounded read at a time, no timer or filesystem writes. */
export class TerminalMetadataObserver {
	value: RemoteTerminalMetadata | null = null
	private nextRead = 0
	private pending = false
	private disposed = false
	constructor(
		private readonly read: () => Promise<RemoteTerminalMetadata | null>,
		private readonly changed: () => void,
		private readonly now = Date.now,
	) {}
	refresh(): void {
		if (this.disposed || this.pending || this.now() < this.nextRead) return
		this.pending = true
		void this.read()
			.catch(() => null)
			.then(value => {
				if (!this.disposed && JSON.stringify(value) !== JSON.stringify(this.value)) {
					this.value = value
					this.changed()
				}
			})
			.finally(() => {
				this.pending = false
				this.nextRead = this.now() + 10000
			})
	}
	stop(): void {
		this.disposed = true
		this.value = null
	}
}
