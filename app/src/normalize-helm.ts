import type {
	DashboardItem,
	HelmProfile,
	HelmResult,
	ProfileActivationResult,
	ProfileMutationResult,
	ProfilesDocument,
	ProfilesState,
} from './shared-helm'

/**
 * Mixed-version guard for a newly built app talking to a daemon that has not
 * restarted through the inbox migration yet. Without this, legacy triage rows
 * fall into Archive and opening one crashes the exhaustive detail-state switch.
 */
export function normalizeDashboardItem(item: DashboardItem): DashboardItem {
	const legacyTriage = (item.status as string) === 'triage'
	const profileId = item.profileId ?? 'work'
	const workMode = item.workMode ?? (item.startedAt ? 'agent' : null)
	const executionMode = item.executionMode ?? (item.kind === 'loop' ? 'loop' : 'solve')
	const solverEffort = item.solverEffort ?? null
	const runContextEdited = item.runContextEdited ?? false
	const canAssignProject = item.canAssignProject ?? false
	const emptyTickets = { total: 0, open: 0, readyForAgent: 0, readyForHuman: 0 }
	const planStatus =
		item.planStatus ??
		(item.plannedAt
			? {
					stage: 'planning' as const,
					specName: null,
					localTickets: emptyTickets,
					githubTickets: emptyTickets,
					githubAvailable: false,
					checkedAt: item.plannedAt,
				}
			: null)
	if (
		!legacyTriage &&
		item.profileId === profileId &&
		item.workMode === workMode &&
		item.executionMode === executionMode &&
		item.solverEffort === solverEffort &&
		item.runContextEdited === runContextEdited &&
		item.canAssignProject === canAssignProject &&
		item.planStatus === planStatus
	)
		return item
	return {
		...item,
		profileId,
		status: legacyTriage ? 'inbox' : item.status,
		workMode,
		executionMode,
		solverEffort,
		runContextEdited,
		canAssignProject,
		planStatus,
		card: legacyTriage
			? {
					...item.card,
					state: 'inbox',
					statusLabel: 'Inbox',
					statusTone: 'gray',
				}
			: item.card,
	}
}

export function normalizeDashboardItems(items: DashboardItem[]): DashboardItem[] {
	return items.map(normalizeDashboardItem)
}

export function normalizeDashboardItemResult(result: HelmResult<DashboardItem>): HelmResult<DashboardItem> {
	return result.data === undefined ? result : { ...result, data: normalizeDashboardItem(result.data) }
}

function normalizeProfile(profile: HelmProfile): HelmProfile {
	return {
		...profile,
		knowledgeBindings: Array.isArray(profile.knowledgeBindings) ? profile.knowledgeBindings : [],
	}
}

/** Protocol-40/41 profile documents predate profile-owned knowledge bindings. */
export function normalizeProfilesState(state: ProfilesState): ProfilesState {
	return {
		...state,
		version: 2,
		profiles: Array.isArray(state.profiles) ? state.profiles.map(normalizeProfile) : [],
	}
}

export function normalizeProfilesDocument(document: ProfilesDocument): ProfilesDocument {
	return {
		...normalizeProfilesState(document),
		configuredProjects: Array.isArray(document.configuredProjects) ? document.configuredProjects : [],
		configuredKnowledgeProviders: Array.isArray(document.configuredKnowledgeProviders)
			? document.configuredKnowledgeProviders
			: [],
	}
}

export function normalizeProfilesDocumentResult(result: HelmResult<ProfilesDocument>): HelmResult<ProfilesDocument> {
	return result.data === undefined ? result : { ...result, data: normalizeProfilesDocument(result.data) }
}

export function normalizeProfileMutationResult(
	result: HelmResult<ProfileMutationResult>,
): HelmResult<ProfileMutationResult> {
	if (result.data === undefined) return result
	return {
		...result,
		data: {
			profile: normalizeProfile(result.data.profile),
			state: normalizeProfilesState(result.data.state),
		},
	}
}

export function normalizeProfileActivationResult(
	result: HelmResult<ProfileActivationResult>,
): HelmResult<ProfileActivationResult> {
	return result.data === undefined
		? result
		: { ...result, data: { ...result.data, state: normalizeProfilesState(result.data.state) } }
}
