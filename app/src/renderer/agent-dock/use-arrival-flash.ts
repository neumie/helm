import { useEffect, useRef, useState } from 'react'
import type { AgentDockSnapshot, DockItem } from '../../agent-dock/model'
import { useArrivals } from './use-arrival-announcement'

/** How long an arriving entry carries its flash (the CSS animation runs once over the same span). */
export const ARRIVAL_FLASH_MS = 1_400

export type ArrivalKind = 'question' | 'permission' | 'plan' | 'turn'

/** Most urgent first: an ask blocks the agent (a question most of all), a finished turn does not. */
const ARRIVAL_URGENCY: readonly ArrivalKind[] = ['question', 'permission', 'plan', 'turn']

export function arrivalKind(item: DockItem): ArrivalKind {
	if (item.fact.kind === 'turn') return 'turn'
	if (item.fact.tool === 'AskUserQuestion') return 'question'
	if (item.fact.tool === 'ExitPlanMode') return 'plan'
	return 'permission'
}

/** The most urgent of `kinds`, or undefined when there is none. */
export function mostUrgent(kinds: ReadonlyArray<ArrivalKind | undefined>): ArrivalKind | undefined {
	return ARRIVAL_URGENCY.find(kind => kinds.includes(kind))
}

/**
 * Items that just arrived (the same ones `useArrivalAnnouncement` speaks), by id, each with its kind,
 * for ARRIVAL_FLASH_MS: their entries flash once in their kind's color. Nothing on first load or
 * reload, nothing for a re-render; several arrivals each keep their own kind and timer.
 */
export function useArrivalFlash(snapshot: AgentDockSnapshot | null): ReadonlyMap<number, ArrivalKind> {
	const [flashing, setFlashing] = useState<ReadonlyMap<number, ArrivalKind>>(new Map())
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
	useArrivals(snapshot, fresh => {
		setFlashing(current => {
			const next = new Map(current)
			for (const item of fresh) next.set(item.id, arrivalKind(item))
			return next
		})
		const timer = setTimeout(() => {
			timers.current.delete(timer)
			setFlashing(current => {
				const next = new Map(current)
				for (const item of fresh) next.delete(item.id)
				return next
			})
		}, ARRIVAL_FLASH_MS)
		timers.current.add(timer)
	})
	useEffect(() => {
		const pending = timers.current
		return () => {
			for (const timer of pending) clearTimeout(timer)
		}
	}, [])
	return flashing
}
