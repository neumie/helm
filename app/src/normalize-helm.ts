import type { DashboardItem, HelmResult } from './shared-helm'

/**
 * Mixed-version guard for a newly built app talking to a daemon that has not
 * restarted through the inbox migration yet. Without this, legacy triage rows
 * fall into Archive and opening one crashes the exhaustive detail-state switch.
 */
export function normalizeDashboardItem(item: DashboardItem): DashboardItem {
	const legacyTriage = (item.status as string) === 'triage'
	const workMode = item.workMode ?? (item.startedAt ? 'agent' : null)
	if (!legacyTriage && item.workMode === workMode) return item
	return {
		...item,
		status: legacyTriage ? 'inbox' : item.status,
		workMode,
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
