// Agent dock spool projections: the pure snapshot/item/event → spool shapes the
// watcher writes to <userData>/agent-dock (see src/agent-dock/spool.ts). No IO.
// Item heads and receipts here are what reaches disk, so they never carry dialog
// `tool_input`, turn text, answer text or source error words.

import { ITEM_HEAD_MAX, type SpoolItem, type SpoolSnapshot, formatEventLine } from '../../../src/agent-dock/spool'
import { oneLine } from '../../../src/agent-dock/text'
import type { AgentDockEvent, AgentDockSnapshot, DockItem, DockSession } from './model'
import { RESOLVED_RETENTION_MS } from './reduce'

/** Resolved items kept in state.json's ledger (24 h, newest first). */
export const LEDGER_MAX = 200

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * ≤120-char item label built only from non-agent facts (tool name, counts): this
 * string reaches state.json, snapshot.json and events.ndjson, so it must never
 * carry dialog `tool_input` (question text, permission descriptions) or turn
 * text. Full text stays in memory/IPC; `helm dock show` reads it live.
 */
export function dockItemHead(item: DockItem): string {
	const fact = item.fact
	if (fact.kind === 'turn') {
		const parts = ['Turn ended']
		if (fact.hadBackground) parts.push('background still running')
		return oneLine(parts.join(' · '), ITEM_HEAD_MAX)
	}
	const input = record(fact.input)
	if (fact.tool === 'AskUserQuestion') {
		const questions = Array.isArray(input?.questions) ? input.questions : []
		const first = record(questions[0])
		const parts = ['AskUserQuestion', `${questions.length} question${questions.length === 1 ? '' : 's'}`]
		if (Array.isArray(first?.options)) parts.push(`${first.options.length} opts`)
		return parts.join(' · ')
	}
	if (fact.tool === 'ExitPlanMode') return 'ExitPlanMode: plan ready for review'
	return oneLine(`Permission: ${fact.tool}`, ITEM_HEAD_MAX)
}

export function dockSpoolItem(item: DockItem): SpoolItem {
	const fact = item.fact
	const base: SpoolItem = {
		id: item.id,
		key: item.key,
		kind: item.kind,
		state: item.state,
		session: item.session,
		openedAt: item.openedAt,
		head: dockItemHead(item),
		...(item.orphanedAt !== undefined ? { orphanedAt: item.orphanedAt } : {}),
		...(item.resolution ? { resolution: { ...item.resolution } } : {}),
		// Kind and status only: never the answer, never Okena's error words (they reach disk).
		...(item.receipt
			? {
					receipt: {
						action: item.receipt.action,
						status: item.receipt.status,
						at: item.receipt.at,
						...(item.receipt.always ? { always: true } : {}),
						...(item.receipt.delivery ? { delivery: item.receipt.delivery } : {}),
						...(item.receipt.reason ? { reason: item.receipt.reason } : {}),
					},
				}
			: {}),
	}
	if (fact.kind === 'ask') return { ...base, tool: fact.tool, dialogId: fact.dialogId, createdAtMs: fact.createdAtMs }
	return {
		...base,
		assistantUuid: fact.assistantUuid,
		endedAt: fact.endedAt,
		hadBackground: fact.hadBackground,
		...(fact.sessionId ? { sessionId: fact.sessionId } : {}),
	}
}

export function dockSpoolSnapshot(
	snapshot: AgentDockSnapshot,
	ledger: readonly SpoolItem[],
	writtenAt: number,
	pid: number,
): SpoolSnapshot {
	const items = snapshot.items.map(dockSpoolItem)
	const live = new Set(items.map(item => item.id))
	const earlier = ledger
		.filter(item => !live.has(item.id))
		.map(item => ({ ...item, fromLedger: true }))
		.sort((a, b) => (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0))
	return {
		version: 1,
		pid,
		writtenAt,
		generatedAt: snapshot.generatedAt,
		source: { ...snapshot.source },
		sources: Object.fromEntries(Object.entries(snapshot.sources).map(([id, health]) => [id, { ...health }])),
		// `source` only for Helm sessions: an Okena-only spool stays byte-identical (absent = okena).
		// Background-task counts only while some run, for the same reason.
		sessions: snapshot.sessions.map(({ source, backgroundTasks, backgroundShells, ...session }) => ({
			...session,
			...(source === 'okena' ? {} : { source }),
			...(backgroundTasks > 0 ? { backgroundTasks, backgroundShells } : {}),
			prLinks: session.prLinks.map(link => ({ ...link })),
		})),
		items: [...items, ...earlier],
	}
}

const where = (session: DockSession | undefined): string | undefined =>
	session ? oneLine(`${session.project}/${session.name}`, 60) : undefined

/** One events.ndjson line (≤300 chars) for a reducer event. */
export function dockEventLine(
	event: AgentDockEvent,
	seq: number,
	items: readonly DockItem[],
	sessions: readonly DockSession[],
): string {
	if (event.t === 'item.opened') {
		const item = items.find(candidate => candidate.id === event.id)
		return formatEventLine({
			seq,
			t: event.t,
			at: event.at,
			id: event.id,
			kind: event.kind,
			where: where(sessions.find(session => session.key === event.session)),
			head: item ? dockItemHead(item) : undefined,
			session: event.session,
		})
	}
	if (event.t === 'source.health') {
		return formatEventLine({
			seq,
			t: event.t,
			at: event.at,
			state: event.state,
			...(event.source && event.source !== 'okena' ? { source: event.source } : {}),
			...(event.detail ? { detail: oneLine(event.detail, 160) } : {}),
		})
	}
	return formatEventLine({ seq, ...event })
}

export function pruneLedger(ledger: SpoolItem[], now: number): SpoolItem[] {
	return ledger
		.filter(item => item.resolution && now - item.resolution.at <= RESOLVED_RETENTION_MS)
		.sort((a, b) => (b.resolution?.at ?? 0) - (a.resolution?.at ?? 0))
		.slice(0, LEDGER_MAX)
}

/** Digest of what the CLI/renderer care about, ignoring per-tick freshness stamps. */
export function contentDigest(snapshot: AgentDockSnapshot): string {
	return JSON.stringify({
		source: { state: snapshot.source.state, detail: snapshot.source.detail },
		sources: Object.entries(snapshot.sources).map(([id, health]) => [id, health?.state, health?.detail]),
		sessions: snapshot.sessions.map(session => ({ ...session, observedAt: 0 })),
		items: snapshot.items.map(item => [
			item.id,
			item.state,
			item.resolution?.by,
			item.fact.kind,
			item.receipt?.status,
			item.receipt?.reason,
			item.receipt?.detail,
			item.receipt?.delivery,
		]),
	})
}
