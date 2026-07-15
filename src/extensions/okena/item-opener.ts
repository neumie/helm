import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { ProjectConfig } from '../../config.js'
import type { SolverWorkspace } from '../../solver/workspace.js'
import { OkenaClient, type OkenaState } from './client.js'
import { OkenaWorktreeManager } from './worktree.js'

const execFileAsync = promisify(execFile)

export interface OpenItemInOkenaParams {
	projectConfig: ProjectConfig
	workspaceMode: SolverWorkspace
	baseRef: string
	branchName: string
	existingWorktreePath?: string
}

export interface OpenItemInOkenaResult {
	worktreePath: string
	projectId: string
	terminalId: string
	createdWorkspace: boolean
	activated: boolean
}

interface OkenaItemOpenerDeps {
	client?: OkenaClient
	activateApp?: () => Promise<boolean>
}

type OkenaProject = OkenaState['projects'][number]

function firstTerminalId(project: OkenaProject): string | null {
	return Object.keys(project.terminal_names ?? {})[0] ?? null
}

async function activateOkenaApp(): Promise<boolean> {
	if (process.platform !== 'darwin') return false
	try {
		await execFileAsync(
			'osascript',
			['-e', 'tell application "System Events" to set frontmost of first process whose name is "okena" to true'],
			{ timeout: 500 },
		)
		return true
	} catch {
		return false
	}
}

/**
 * Resolve an Item workspace into Okena, focus a terminal, and best-effort raise
 * the native app. Existing terminals are never sent input or interrupted.
 */
export async function openItemInOkena(
	params: OpenItemInOkenaParams,
	deps: OkenaItemOpenerDeps = {},
): Promise<OpenItemInOkenaResult> {
	const client = deps.client ?? new OkenaClient()
	if (!(await client.isAvailable())) throw new Error('Okena is not running or configured')
	const worktrees = new OkenaWorktreeManager(client)
	let projectId: string
	let terminalId: string | null = null
	let worktreePath: string
	let createdWorkspace = false

	if (params.existingWorktreePath) {
		if (!existsSync(params.existingWorktreePath)) {
			throw new Error(`Item worktree does not exist: ${params.existingWorktreePath}`)
		}
		worktreePath = params.existingWorktreePath
		const state = await client.getState()
		const existing = state.projects.find(project => project.path === worktreePath)
		if (existing) {
			projectId = existing.id
			terminalId = firstTerminalId(existing)
		} else {
			const added = await client.action<{ project_id?: string; terminal_ids?: string[] }>({
				action: 'add_project',
				name: params.branchName,
				path: worktreePath,
			})
			if (!added.project_id) throw new Error('Okena did not return the registered project ID')
			projectId = added.project_id
			terminalId = added.terminal_ids?.[0] ?? null
		}
	} else if (params.workspaceMode === 'main') {
		const ensured = await worktrees.ensureMainRepoProject(params.projectConfig.repoPath)
		worktreePath = ensured.worktreePath
		projectId = ensured.wtProjectId
		terminalId = ensured.autoTerminalId
		const state = await client.getState()
		const project = state.projects.find(candidate => candidate.id === projectId)
		terminalId ??= project ? firstTerminalId(project) : null
	} else {
		const ensured = await worktrees.ensureWorktreeProject(
			params.projectConfig.repoPath,
			params.baseRef,
			params.branchName,
			undefined,
		)
		worktreePath = ensured.worktreePath
		projectId = ensured.wtProjectId
		terminalId = ensured.autoTerminalId
		createdWorkspace = true
		if (!terminalId) {
			const state = await client.getState()
			const project = state.projects.find(candidate => candidate.id === projectId)
			terminalId = project ? firstTerminalId(project) : null
		}
	}

	terminalId ??= await worktrees.createTerminal(projectId)
	if (!terminalId) throw new Error('Okena could not create or resolve a terminal for this Item')
	await client.action({ action: 'focus_terminal', project_id: projectId, terminal_id: terminalId, window: 'main' })
	const activated = await (deps.activateApp ?? activateOkenaApp)()
	return { worktreePath, projectId, terminalId, createdWorkspace, activated }
}
