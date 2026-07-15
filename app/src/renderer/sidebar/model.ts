// Sidebar domain helpers: work-bucket partitioning (mirrors
// web/src/components/TaskList.tsx partitionWorkEntries — the bucketing rules
// survive web/'s deletion here), status→tone mapping (design-system.md §2.1,
// fixed, never remapped per surface), verdict display metadata (mirrors
// web/src/verdict.ts), and relative-time formatting (§5: relative under 24h,
// absolute after, tabular numerals).

import { useEffect, useState } from 'react'
import type { AssessmentVerdict, DashboardItem, DashboardTone, ItemStatus } from '../../shared-helm'

// ---------------------------------------------------------------------------
// Navigation routes (push stack, §3.10)

export type Route =
	| { kind: 'list' }
	| { kind: 'archive' }
	| { kind: 'detail'; id: string }
	| { kind: 'plan'; id: string }
	| { kind: 'task'; id: string }
	| { kind: 'run'; id: string }
	| { kind: 'run-setup'; id: string }
	| { kind: 'settings' }
	| { kind: 'settings-section'; sectionId: string }
	| { kind: 'appearance' }

// ---------------------------------------------------------------------------
// Work buckets

export type BucketKey = 'needs' | 'active' | 'queue' | 'inbox'

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

/** DashboardTone → chip tone class suffix (shared tone vocabulary, §3.4). */
export const CHIP_CLASS: Record<DashboardTone, string> = {
	gray: 'chip-gray',
	blue: 'chip-blue',
	green: 'chip-green',
	amber: 'chip-amber',
	red: 'chip-red',
}

/** Verdict display metadata — same mapping as web/src/verdict.ts (§3.4). */
export const VERDICT_META: Record<AssessmentVerdict, { label: string; tone: DashboardTone; icon: string }> = {
	clear: { label: 'Clear', tone: 'green', icon: '✓' },
	needs_clarification: { label: 'Needs info', tone: 'amber', icon: '?' },
	human_decision: { label: 'Decision', tone: 'blue', icon: '◆' },
	not_code: { label: 'Not code', tone: 'gray', icon: '–' },
	security: { label: 'Security', tone: 'red', icon: '⚠' },
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
