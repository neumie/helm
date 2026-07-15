import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { ProjectConfig } from '../../config.js'
import type { SolverWorkspace } from '../../solver/workspace.js'
import { OkenaClient, type OkenaLayoutNode, type OkenaState } from './client.js'
import { OkenaWorktreeManager } from './worktree.js'

const execFileAsync = promisify(execFile)
const FOCUS_RETRY_DELAYS_MS = [0, 100, 250]

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

interface OkenaItemOpenerDeps {
	client?: OkenaClient
	activateApp?: () => Promise<boolean>
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
	let projectId: string
	let terminalId: string | null = null
	let worktreePath: string
	let createdWorkspace = false
	let workspaceAlreadyOpen = false

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
			workspaceAlreadyOpen = true
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

	terminalId ??= await worktrees.createTerminal(projectId)
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
