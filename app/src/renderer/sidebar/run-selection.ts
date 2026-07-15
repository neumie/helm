import type { AppConfig, DashboardItem, SolverAgentBody, SolverWorkspace } from '../../shared-helm'

export type SolverAgent = 'claude' | 'codex'
export interface RunSelectionDraft {
	agent?: SolverAgent
	model?: string | null
	workspace?: SolverWorkspace | null
}

export interface EffectiveRunSelection {
	agent: SolverAgent
	model: string | null
	workspace: SolverWorkspace
	agentSource: 'Item override' | 'Default'
	modelSource: 'Item override' | 'Default'
	workspaceSource: 'Item override' | 'Default'
}

export function effectiveRunSelection(
	item: DashboardItem,
	config: AppConfig | null,
	draft: RunSelectionDraft = {},
): EffectiveRunSelection {
	const agentValue = draft.agent ?? item.solverAgent ?? config?.solver?.agent ?? 'claude'
	const modelValue = (draft.model !== undefined ? draft.model : item.solverModel) ?? config?.solver?.model ?? null
	const workspaceValue =
		(draft.workspace !== undefined ? draft.workspace : item.solverWorkspace) ?? config?.solver?.workspace ?? 'worktree'
	return {
		agent: agentValue,
		model: modelValue,
		workspace: workspaceValue,
		agentSource: draft.agent !== undefined || item.solverAgent !== null ? 'Item override' : 'Default',
		modelSource: draft.model !== undefined || item.solverModel !== null ? 'Item override' : 'Default',
		workspaceSource: draft.workspace !== undefined || item.solverWorkspace !== null ? 'Item override' : 'Default',
	}
}

/** Run actions send only user-touched fields; null deliberately clears model/workspace overrides. */
export function buildRunBody(draft: RunSelectionDraft): SolverAgentBody | undefined {
	const body: SolverAgentBody = {}
	if (draft.agent !== undefined) body.solverAgent = draft.agent
	if (draft.model !== undefined) body.solverModel = draft.model
	if (draft.workspace !== undefined) body.solverWorkspace = draft.workspace
	return Object.keys(body).length ? body : undefined
}

/** Planning also needs the stored selections when no draft field was touched. */
export function buildPlanBody(item: DashboardItem, draft: RunSelectionDraft): SolverAgentBody | undefined {
	const body = buildRunBody(draft) ?? {}
	if (draft.agent === undefined && item.solverAgent) body.solverAgent = item.solverAgent
	if (draft.model === undefined && item.solverModel) body.solverModel = item.solverModel
	if (draft.workspace === undefined && item.solverWorkspace) body.solverWorkspace = item.solverWorkspace
	return Object.keys(body).length ? body : undefined
}

export function selectAgent(draft: RunSelectionDraft, agent: SolverAgent, config: AppConfig | null): RunSelectionDraft {
	const catalog = config?.modelCatalog?.[agent] ?? []
	const model = draft.model
	return {
		...draft,
		agent,
		...(model && !catalog.some(option => option.id === model) ? { model: null } : {}),
	}
}

export function selectionSummary(selection: EffectiveRunSelection): string {
	return `${selection.agent === 'claude' ? 'Claude' : 'Codex'} · ${selection.model ?? 'Default'} · ${selection.workspace === 'main' ? 'Main' : 'Worktree'}`
}

export default { effectiveRunSelection, buildRunBody, buildPlanBody, selectAgent, selectionSummary }
