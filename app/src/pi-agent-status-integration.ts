import { lstat, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FILE_NAME = 'helm-agent-status.ts'
const MAX_SETTINGS_BYTES = 512 * 1024

export type PiAgentStatusIntegrationStatus = 'external' | 'not-installed' | 'conflict' | 'unavailable'

export interface PiAgentStatusIntegrationSnapshot {
	status: PiAgentStatusIntegrationStatus
	path: string
	message: string
}

export interface PiAgentStatusIntegrationOptions {
	home?: string
	env?: NodeJS.ProcessEnv
}

function integrationPath(options: PiAgentStatusIntegrationOptions = {}): {
	agentDir: string
	legacyFile: string
	settings: string
} {
	const env = options.env ?? process.env
	const agentDir = env.PI_CODING_AGENT_DIR || join(options.home ?? homedir(), '.pi', 'agent')
	return {
		agentDir,
		legacyFile: join(agentDir, 'extensions', FILE_NAME),
		settings: join(agentDir, 'settings.json'),
	}
}

async function safeDirectory(path: string): Promise<'directory' | 'missing' | 'unsafe'> {
	try {
		const metadata = await lstat(path)
		return metadata.isDirectory() && !metadata.isSymbolicLink() ? 'directory' : 'unsafe'
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'
	}
}

function isAgentStatusPackage(value: unknown): boolean {
	if (typeof value !== 'string') return false
	const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
	return (
		normalized === 'git:github.com/neumie/pi-agent-status' ||
		normalized === 'npm:@neumie/pi-agent-status' ||
		normalized.endsWith('/pi-agent-status') ||
		normalized.endsWith('/pi-agent-status.git')
	)
}

async function hasAgentStatusPackage(settingsPath: string): Promise<boolean> {
	try {
		const metadata = await stat(settingsPath)
		if (!metadata.isFile() || metadata.size > MAX_SETTINGS_BYTES) return false
		const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as { packages?: unknown }
		return Array.isArray(parsed.packages) && parsed.packages.some(isAgentStatusPackage)
	} catch {
		return false
	}
}

async function inspect(options: PiAgentStatusIntegrationOptions = {}): Promise<PiAgentStatusIntegrationSnapshot> {
	const paths = integrationPath(options)
	if ((await safeDirectory(paths.agentDir)) !== 'directory') {
		return {
			status: 'unavailable',
			path: paths.legacyFile,
			message: 'Pi agent directory is unavailable. Install or run Pi first.',
		}
	}

	try {
		await lstat(paths.legacyFile)
		return {
			status: 'conflict',
			path: paths.legacyFile,
			message: 'A legacy direct Pi status extension exists. Remove it and configure the pi-agent-status package.',
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			return {
				status: 'unavailable',
				path: paths.legacyFile,
				message: 'Could not inspect the Pi status integration.',
			}
		}
	}

	if (await hasAgentStatusPackage(paths.settings)) {
		return {
			status: 'external',
			path: paths.legacyFile,
			message: 'Precise Pi terminal status is managed by the pi-agent-status package.',
		}
	}

	return {
		status: 'not-installed',
		path: paths.legacyFile,
		message: 'Configure the pi-agent-status package for precise terminal status.',
	}
}

export class PiAgentStatusIntegration {
	readonly #options: PiAgentStatusIntegrationOptions

	constructor(options: PiAgentStatusIntegrationOptions = {}) {
		this.#options = options
	}

	status(): Promise<PiAgentStatusIntegrationSnapshot> {
		return inspect(this.#options)
	}
}

export default { PiAgentStatusIntegration }
