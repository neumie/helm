import { useEffect, useRef, useState } from 'react'
import type { AgentDockSnapshot, DockItem } from '../../agent-dock/model'
import { agentWho, findSession, itemKindLabel, itemSourceHealth, needsYouItems, snapshotSources } from './presentation'

/** New asks arriving within this window are announced together ("3 new requests"). */
const ANNOUNCE_COALESCE_MS = 2_000

/**
 * Polite words for items that newly need Jakub (the queue never opens a pane by itself, so the row
 * changing is the only other signal). Only arrivals: never ticking ages or working counts. Per
 * source: its first reachable snapshot is its baseline, its items count only while it is reachable
 * (one source down never mutes another), and arrivals within ANNOUNCE_COALESCE_MS are one line.
 */
export function useArrivalAnnouncement(snapshot: AgentDockSnapshot | null): string {
	const seen = useRef(new Set<number>())
	const baselined = useRef(new Set<string>())
	const queued = useRef<DockItem[]>([])
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const latest = useRef(snapshot)
	latest.current = snapshot
	const [text, setText] = useState('')
	useEffect(() => {
		if (!snapshot) return
		const known = seen.current
		const sourceOf = (item: DockItem) => findSession(snapshot, item.session)?.source ?? 'okena'
		const fresh: DockItem[] = []
		for (const item of needsYouItems(snapshot)) {
			if (known.has(item.id) || itemSourceHealth(item, snapshot)?.state !== 'ok') continue
			known.add(item.id)
			if (baselined.current.has(sourceOf(item))) fresh.push(item)
		}
		for (const [id, health] of snapshotSources(snapshot)) if (health.state === 'ok') baselined.current.add(id)
		if (fresh.length === 0) return
		queued.current.push(...fresh)
		if (timer.current !== null) return
		timer.current = setTimeout(() => {
			timer.current = null
			const items = queued.current
			queued.current = []
			const [first] = items
			if (!first) return
			if (items.length > 1) {
				setText(`${items.length} new requests`)
				return
			}
			const who = agentWho(latest.current, first.session)
			setText(`${itemKindLabel(first)} from ${who.name}${who.project ? ` in ${who.project}` : ''}`)
		}, ANNOUNCE_COALESCE_MS)
	}, [snapshot])
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current)
		},
		[],
	)
	return text
}
