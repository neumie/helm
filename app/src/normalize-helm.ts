import type { DashboardItem, HelmResult } from './shared-helm'

/**
 * Mixed-version guard for a newly built app talking to a daemon that has not
 * restarted through the inbox migration yet. Without this, legacy triage rows
 * fall into Archive and opening one crashes the exhaustive detail-state switch.
 */
export function normalizeDashboardItem(item: DashboardItem): DashboardItem {
	const legacyTriage = (item.status as string) === 'triage'
	const workMode = item.workMode ?? (item.startedAt ? 'agent' : null)
	const executionMode = item.executionMode ?? (item.kind === 'loop' ? 'loop' : 'solve')
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
		item.workMode === workMode &&
		item.executionMode === executionMode &&
		item.planStatus === planStatus
	)
		return item
	return {
		...item,
		status: legacyTriage ? 'inbox' : item.status,
		workMode,
		executionMode,
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
