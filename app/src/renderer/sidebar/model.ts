// Sidebar domain helpers: work-bucket partitioning (mirrors
// web/src/components/TaskList.tsx partitionWorkEntries — the bucketing rules
// survive web/'s deletion here), status→tone mapping (design-system.md §2.1,
// fixed, never remapped per surface), verdict display metadata (mirrors
// web/src/verdict.ts), and relative-time formatting (§5: relative under 24h,
// absolute after, tabular numerals).

import { useEffect, useState } from 'react'
import type { AppConfig, AssessmentVerdict, DashboardItem, DashboardTone, ItemStatus } from '../../shared-helm'

// ---------------------------------------------------------------------------
// Navigation routes (push stack, §3.10)

export type Route =
	| { kind: 'list' }
	| { kind: 'archive' }
	| { kind: 'detail'; id: string }
	| { kind: 'plan'; id: string }
	| { kind: 'task'; id: string }
	| { kind: 'settings' }
	| { kind: 'settings-section'; sectionId: string }
	| { kind: 'profiles' }
	| { kind: 'profile'; profileId: string }
	| { kind: 'appearance' }

export function colorForProject(config: AppConfig | null | undefined, slug: string): string | null {
	return config?.projects?.find(project => project.slug === slug)?.color ?? config?.projectColors?.[slug] ?? null
}

// ---------------------------------------------------------------------------
// Work buckets

export type BucketKey = 'needs' | 'active' | 'queue' | 'inbox'

/** The one local+GitHub ticket aggregation — list labels and the detail
 *  identity header must never sum the buckets independently. */
export function planTicketCounts(status: NonNullable<DashboardItem['planStatus']>): {
	total: number
	open: number
	agent: number
	human: number
} {
	return {
		total: status.localTickets.total + status.githubTickets.total,
		open: status.localTickets.open + status.githubTickets.open,
		agent: status.localTickets.readyForAgent + status.githubTickets.readyForAgent,
		human: status.localTickets.readyForHuman + status.githubTickets.readyForHuman,
	}
}

export function planTicketTotal(item: DashboardItem): number {
	return item.planStatus ? planTicketCounts(item.planStatus).total : 0
}

/** Compact verb phrase for the Item's external workspace action. The server
 *  owns the preview state; the client turns it into button copy rather than a
 *  generic button plus an explanatory caption. */
export function okenaActionLabel(
	preview: DashboardItem['okenaWorkspace'],
	workspace: 'main' | 'worktree' | undefined,
): string {
	if (!preview) return workspace === 'main' ? 'Open main checkout in Okena' : 'Open workspace in Okena'
	switch (preview.state) {
		case 'open':
			return 'Focus in Okena'
		case 'main':
			return 'Focus main checkout in Okena'
		case 'register':
			return 'Register worktree in Okena'
		case 'local':
			return 'Create Okena workspace from local branch'
		case 'remote':
			return 'Fetch branch and create Okena workspace'
		case 'create':
			return 'Create branch and Okena workspace'
		case 'standalone':
			return 'Open worktree in Okena'
		case 'unavailable':
			return preview.label
	}
}

export function planStatusLabel(item: DashboardItem): string | null {
	const status = item.planStatus
	if (!status) return null
	if (status.stage === 'planning') return 'Planning'
	if (status.stage === 'plan_ready') return 'Plan ready'
	const { total, open } = planTicketCounts(status)
	const completed = Math.max(0, total - open)
	return `${completed} of ${total} ${total === 1 ? 'ticket' : 'tickets'} complete`
}

export function planStatusDetail(item: DashboardItem): string | null {
	const status = item.planStatus
	if (!status) return null
	if (status.stage === 'planning') return 'The planning workspace is open. No runnable spec has been detected yet.'
	if (status.stage === 'plan_ready') {
		return status.githubAvailable
			? `${status.specName ?? 'A runnable spec'} is ready. No local or GitHub ticket queue was found.`
			: `${status.specName ?? 'A runnable spec'} is ready. Local tickets were checked; GitHub is unavailable.`
	}
	const { total, open, agent, human } = planTicketCounts(status)
	const completed = Math.max(0, total - open)
	const sources = [status.localTickets.total > 0 ? 'local' : null, status.githubTickets.total > 0 ? 'GitHub' : null]
		.filter(Boolean)
		.join(' + ')
	return `${completed} of ${total} ${total === 1 ? 'ticket' : 'tickets'} complete in ${sources}. ${open} open; ${agent} agent-ready, ${human} human-ready.`
}

/** `review` + `failed` are the "needs you" pile (same rule as the web dashboard). */
const NEEDS_YOU = new Set<ItemStatus>(['review', 'failed'])

export interface WorkBuckets {
	needs: DashboardItem[]
	active: DashboardItem[]
	queue: DashboardItem[]
	inbox: DashboardItem[]
	archived: DashboardItem[]
}

export function partitionWork(items: DashboardItem[]): WorkBuckets {
	return {
		needs: items.filter(i => NEEDS_YOU.has(i.status)),
		active: items.filter(i => i.status === 'active' || i.status === 'running'),
		queue: items.filter(i => i.status === 'ready'),
		inbox: items.filter(i => i.status === 'inbox'),
		archived: items.filter(
			i =>
				!NEEDS_YOU.has(i.status) &&
				i.status !== 'active' &&
				i.status !== 'running' &&
				i.status !== 'ready' &&
				i.status !== 'inbox',
		),
	}
}

export function groupItemsByProject(items: DashboardItem[]): Array<[string, DashboardItem[]]> {
	const groups = new Map<string, DashboardItem[]>()
	for (const item of items) {
		const group = groups.get(item.projectSlug)
		if (group) group.push(item)
		else groups.set(item.projectSlug, [item])
	}
	return [...groups]
}

/** Most meaningful timestamp to age a row by, per state (mirrors the web list). */
export function rowTimestamp(item: DashboardItem): string {
	if (item.status === 'active' || item.status === 'running') return item.startedAt ?? item.queuedAt ?? item.createdAt
	if (NEEDS_YOU.has(item.status)) return item.completedAt ?? item.updatedAt
	if (item.status === 'ready') return item.queuedAt ?? item.createdAt
	return item.completedAt ?? item.updatedAt
}

// ---------------------------------------------------------------------------
// Tones

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'

/** Fixed status→tone mapping from design-system.md §2.1. Do not remap. */
export function statusTone(status: ItemStatus): StatusTone {
	switch (status) {
		case 'active':
		case 'running':
			return 'accent'
		case 'review':
			return 'warn'
		case 'done':
			return 'success'
		case 'failed':
			return 'danger'
		default: // inbox / ready / cancelled
			return 'neutral'
	}
}

/** List rows carry lifecycle in words only where a tab mixes statuses — Needs
 * (review/failed) and Archive (done/cancelled). Running uses the shared
 * ActivityIndicator beside the title, so tab-uniform statuses return null. */
export function statusWord(status: ItemStatus): { label: string; tone: StatusTone } | null {
	switch (status) {
		case 'review':
			return { label: 'Review', tone: 'warn' }
		case 'failed':
			return { label: 'Failed', tone: 'danger' }
		case 'done':
			return { label: 'Done', tone: 'success' }
		case 'cancelled':
			return { label: 'Cancelled', tone: 'neutral' }
		default: // inbox / ready / active / running — the tab, owner, or indicator says it
			return null
	}
}

/** DashboardTone → chip tone class suffix (shared tone vocabulary, §3.4). */
export const CHIP_CLASS: Record<DashboardTone, string> = {
	gray: 'chip-gray',
	blue: 'chip-blue',
	green: 'chip-green',
	amber: 'chip-amber',
	red: 'chip-red',
}

/** Verdict display metadata — the one verdict→label/tone mapping (§3.4).
 *  Labels are sentence case, text-only: chips carry no glyph prefixes. */
export const VERDICT_META: Record<AssessmentVerdict, { label: string; tone: DashboardTone }> = {
	clear: { label: 'Clear', tone: 'green' },
	needs_clarification: { label: 'Needs info', tone: 'amber' },
	human_decision: { label: 'Decision', tone: 'blue' },
	not_code: { label: 'Not code', tone: 'gray' },
	security: { label: 'Security', tone: 'red' },
}

// ---------------------------------------------------------------------------
// Time

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** "4m" / "2h" under 24h, "Jul 3" (or "Jul 3, 25") after — §5 copy voice. */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
	if (!iso) return ''
	const then = Date.parse(iso)
	if (Number.isNaN(then)) return ''
	const delta = nowMs - then
	if (delta < MIN) return 'now'
	if (delta < HOUR) return `${Math.floor(delta / MIN)}m`
	if (delta < DAY) return `${Math.floor(delta / HOUR)}h`
	const date = new Date(then)
	const sameYear = date.getFullYear() === new Date(nowMs).getFullYear()
	return date.toLocaleDateString(
		[],
		sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' },
	)
}

/** Re-render clock for relative times; one interval per consumer page. */
export function useNow(intervalMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs)
		return () => clearInterval(timer)
	}, [intervalMs])
	return now
}

// ---------------------------------------------------------------------------
// Misc

export function itemTitle(item: DashboardItem): string {
	return item.displayName ?? item.title
}

/** Raw run logs are append-only and oldest-first on disk; the decision surface
 * shows non-empty messages newest-first so current activity stays at the top. */
export function logMessagesNewestFirst(content: string): string[] {
	return content
		.split(/\r?\n/)
		.filter(line => line.trim().length > 0)
		.reverse()
}

export function executionLogLabel(mode: DashboardItem['executionMode']): 'Loop log' | 'Agent log' {
	return mode === 'loop' ? 'Loop log' : 'Agent log'
}

/** Resolve possibly-relative daemon URLs (ingested attachments) to absolute. */
export function absoluteUrl(url: string, daemonUrl: string): string | null {
	try {
		const u = new URL(url, daemonUrl)
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
	} catch {
		return null
	}
}

export function openExternalUrl(url: string, daemonUrl: string): void {
	const href = absoluteUrl(url, daemonUrl)
	if (!href) return
	const anchor = document.createElement('a')
	anchor.href = href
	anchor.target = '_blank'
	anchor.rel = 'noopener noreferrer'
	anchor.click()
}
