import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { ProjectConfig } from '../../config.js'
import type { SolverWorkspace } from '../../solver/workspace.js'
import { worktreePathForBranch } from '../../worktree/manager.js'
import { OkenaClient, type OkenaLayoutNode, type OkenaState } from './client.js'
import { OkenaWorktreeManager, inspectOkenaBranchSource } from './worktree.js'

const execFileAsync = promisify(execFile)
const FOCUS_RETRY_DELAYS_MS = [0, 100, 250]
const TERMINAL_READY_DELAYS_MS = [0, 100, 250, 500]

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
	focused: boolean
	notified: boolean
	activated: boolean
}

export type OkenaWorkspacePreviewState =
	| 'open'
	| 'main'
	| 'register'
	| 'local'
	| 'remote'
	| 'create'
	| 'standalone'
	| 'unavailable'

export interface OkenaWorkspacePreview {
	state: OkenaWorkspacePreviewState
	label: string
	detail: string
	branchName: string
	worktreePath?: string
}

interface OkenaItemOpenerDeps {
	client?: OkenaClient
	activateApp?: () => Promise<boolean>
	inspectBranchSource?: typeof inspectOkenaBranchSource
}

type OkenaProject = OkenaState['projects'][number]

function firstLayoutTerminalId(layout: OkenaLayoutNode | null | undefined): string | null {
	if (!layout) return null
	if (layout.type === 'terminal') return layout.detached ? null : layout.terminal_id
	if (layout.type === 'tabs') {
		const active = firstLayoutTerminalId(layout.children[layout.active_tab])
		if (active) return active
	}
	for (const child of layout.children) {
		const terminalId = firstLayoutTerminalId(child)
		if (terminalId) return terminalId
	}
	return null
}

/** Hook/service terminals also appear in terminal_names; only layout panes are focusable. */
function firstTerminalId(project: OkenaProject): string | null {
	return firstLayoutTerminalId(project.layout)
}

async function liveProject(client: OkenaClient, projectId: string): Promise<OkenaProject | null> {
	return (await client.getState()).projects.find(project => project.id === projectId) ?? null
}

async function waitForTerminal(client: OkenaClient, projectId: string): Promise<string | null> {
	for (const retryDelay of TERMINAL_READY_DELAYS_MS) {
		if (retryDelay > 0) await delay(retryDelay)
		const project = await liveProject(client, projectId)
		const terminalId = project ? firstTerminalId(project) : null
		if (terminalId) return terminalId
	}
	return null
}

async function focusTerminal(
	client: OkenaClient,
	projectId: string,
	initialTerminalId: string,
): Promise<{ terminalId: string; focused: boolean }> {
	let terminalId = initialTerminalId
	for (const retryDelay of FOCUS_RETRY_DELAYS_MS) {
		if (retryDelay > 0) {
			await delay(retryDelay)
			const project = await liveProject(client, projectId)
			terminalId = (project && firstTerminalId(project)) || terminalId
		}
		try {
			await client.action({ action: 'focus_terminal', project_id: projectId, terminal_id: terminalId, window: 'main' })
			return { terminalId, focused: true }
		} catch {
			// A newly-created terminal can be returned before its layout is visible.
		}
	}
	return { terminalId, focused: false }
}

export async function inspectItemOkenaWorkspace(
	params: OpenItemInOkenaParams,
	deps: Pick<OkenaItemOpenerDeps, 'client' | 'inspectBranchSource'> = {},
): Promise<OkenaWorkspacePreview> {
	const client = deps.client ?? new OkenaClient()
	const branchName = params.branchName
	if (!(await client.isAvailable())) {
		return { state: 'unavailable', label: 'Okena unavailable', detail: 'Okena is not running', branchName }
	}

	const state = await client.getState()
	const parent = state.projects.find(project => project.path === params.projectConfig.repoPath)
	if (params.workspaceMode === 'main') {
		return parent
			? {
					state: 'main',
					label: 'Focus main checkout',
					detail: parent.name,
					branchName,
					worktreePath: params.projectConfig.repoPath,
				}
			: {
					state: 'unavailable',
					label: 'Parent not open in Okena',
					detail: params.projectConfig.repoPath,
					branchName,
				}
	}
	if (!parent) {
		return {
			state: 'unavailable',
			label: 'Parent not open in Okena',
			detail: params.projectConfig.repoPath,
			branchName,
		}
	}

	const existingWorktreePath =
		params.existingWorktreePath && existsSync(params.existingWorktreePath)
			? params.existingWorktreePath
			: await worktreePathForBranch(params.projectConfig.repoPath, branchName)
	if (existingWorktreePath && existsSync(existingWorktreePath)) {
		const child = state.projects.find(
			project => project.path === existingWorktreePath && project.worktree_info?.parent_project_id === parent.id,
		)
		if (child) {
			return {
				state: 'open',
				label: 'Focus open workspace',
				detail: child.name,
				branchName,
				worktreePath: child.path,
			}
		}
		const standalone = state.projects.find(project => project.path === existingWorktreePath)
		if (standalone) {
			return {
				state: 'standalone',
				label: 'Standalone — remove in Okena first',
				detail: `${standalone.name} → ${parent.name}`,
				branchName,
				worktreePath: standalone.path,
			}
		}
		return {
			state: 'register',
			label: 'Register existing worktree',
			detail: `Under ${parent.name}`,
			branchName,
			worktreePath: existingWorktreePath,
		}
	}

	const safeBranch = branchName.replace(/\//g, '-')
	const openChild = state.projects.find(
		project =>
			project.worktree_info?.parent_project_id === parent.id &&
			(project.git_status?.branch === branchName || (project.name === branchName && project.path.includes(safeBranch))),
	)
	if (openChild) {
		return {
			state: 'open',
			label: 'Focus open workspace',
			detail: openChild.name,
			branchName,
			worktreePath: openChild.path,
		}
	}

	const branchSource = await (deps.inspectBranchSource ?? inspectOkenaBranchSource)(
		params.projectConfig.repoPath,
		branchName,
	)
	if (branchSource === 'local') {
		return { state: 'local', label: 'Open local branch', detail: branchName, branchName }
	}
	if (branchSource === 'remote') {
		return { state: 'remote', label: 'Fetch & open remote branch', detail: `origin/${branchName}`, branchName }
	}
	if (branchSource === 'unavailable') {
		return {
			state: 'unavailable',
			label: 'Remote branch check unavailable',
			detail: `Could not inspect origin/${branchName}`,
			branchName,
		}
	}
	return { state: 'create', label: 'Create branch & workspace', detail: branchName, branchName }
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
 * Resolve an Item workspace into Okena, focus its live layout pane, and
 * best-effort raise the native app. A pre-existing workspace also receives one
 * deliberate BEL attention character after focus so Okena paints its yellow
 * notification border; Helm never sends a command or ctrl_c to the terminal.
 */
export async function openItemInOkena(
	params: OpenItemInOkenaParams,
	deps: OkenaItemOpenerDeps = {},
): Promise<OpenItemInOkenaResult> {
	const client = deps.client ?? new OkenaClient()
	if (!(await client.isAvailable())) throw new Error('Okena is not running or configured')
	const worktrees = new OkenaWorktreeManager(client)
	const existingWorktreePath =
		params.workspaceMode === 'worktree'
			? params.existingWorktreePath && existsSync(params.existingWorktreePath)
				? params.existingWorktreePath
				: ((await worktreePathForBranch(params.projectConfig.repoPath, params.branchName)) ?? undefined)
			: undefined
	let projectId: string
	let terminalId: string | null = null
	let worktreePath: string
	let createdWorkspace = false
	let workspaceAlreadyOpen = false

	if (existingWorktreePath) {
		if (!existsSync(existingWorktreePath)) {
			throw new Error(`Item worktree does not exist: ${existingWorktreePath}`)
		}
		worktreePath = existingWorktreePath
		const state = await client.getState()
		const parent = state.projects.find(project => project.path === params.projectConfig.repoPath)
		if (!parent) throw new Error(`Parent project is not open in Okena: ${params.projectConfig.repoPath}`)
		const existing = state.projects.find(
			project => project.path === worktreePath && project.worktree_info?.parent_project_id === parent.id,
		)
		if (existing) {
			projectId = existing.id
			terminalId = firstTerminalId(existing)
			workspaceAlreadyOpen = true
		} else {
			const standalone = state.projects.find(project => project.path === worktreePath)
			if (standalone) {
				throw new Error(
					`Okena tracks this worktree as a standalone project (${standalone.name}); remove it before reopening under ${parent.name}`,
				)
			}
			const added = await client.action<{ project_id?: string; terminal_id?: string | null }>({
				action: 'add_discovered_worktree',
				parent_project_id: parent.id,
				worktree_path: worktreePath,
				branch: params.branchName,
			})
			if (!added.project_id) throw new Error('Okena did not return the registered worktree project ID')
			projectId = added.project_id
			terminalId = added.terminal_id ?? null
		}
	} else if (params.workspaceMode === 'main') {
		const ensured = await worktrees.ensureMainRepoProject(params.projectConfig.repoPath)
		worktreePath = ensured.worktreePath
		projectId = ensured.wtProjectId
		terminalId = ensured.autoTerminalId
		const project = await liveProject(client, projectId)
		terminalId ??= project ? firstTerminalId(project) : null
		workspaceAlreadyOpen = true
	} else {
		const before = await client.getState()
		const safeBranch = params.branchName.replace(/\//g, '-')
		workspaceAlreadyOpen = before.projects.some(
			project => project.name === params.branchName && project.path.includes(safeBranch),
		)
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
			const project = await liveProject(client, projectId)
			terminalId = project ? firstTerminalId(project) : null
		}
	}

	terminalId ??= await waitForTerminal(client, projectId)
	terminalId ??= await worktrees.createTerminal(projectId)
	terminalId ??= await waitForTerminal(client, projectId)
	if (!terminalId) throw new Error('Okena could not create or resolve a terminal for this Item')
	const focus = await focusTerminal(client, projectId, terminalId)
	terminalId = focus.terminalId

	let notified = false
	if (workspaceAlreadyOpen) {
		try {
			await client.action({ action: 'send_text', terminal_id: terminalId, text: '\u0007' })
			notified = true
		} catch {
			// Attention is best-effort; opening/focusing the workspace already succeeded.
		}
	}
	const activated = await (deps.activateApp ?? activateOkenaApp)()
	return { worktreePath, projectId, terminalId, createdWorkspace, focused: focus.focused, notified, activated }
}
