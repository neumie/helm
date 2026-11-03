// The Agents entry's candidate looks (E1–E6), story-only until Jakub picks one: `data-agents-entry` on
// #agent-dock selects a variant; without it the row keeps the current entry. Every variant shows the same
// data (how many agents, which are working, in background, waiting on Jakub, idle, unknown) and carries the
// same accessible name, the states in words. Only what DockSession observed: never invented activity.
import type { DockSession } from '../../agent-dock/model'
import { busyCount, statusGlyph } from './presentation'

export const AGENTS_ENTRY_VARIANTS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'] as const
export type AgentsEntryVariant = (typeof AGENTS_ENTRY_VARIANTS)[number]

export const agentsEntryVariant = (value: string | undefined | null): AgentsEntryVariant | null =>
	AGENTS_ENTRY_VARIANTS.find(variant => variant === value) ?? null

type Status = DockSession['status']

/** States in the pane's order: busy first, then waiting on Jakub, idle, unknown, frozen. */
const STATES: readonly Status[] = ['working', 'background', 'waiting', 'idle', 'unknown', 'unreachable']

const STATE_WORDS: Record<Status, string> = {
	working: 'working',
	background: 'in background',
	waiting: 'waiting on you',
	idle: 'idle',
	unknown: 'unknown',
	unreachable: 'frozen',
}

/** Per-agent marks the glyph tally (E2) and the bar (E6) show before folding the rest into "+N". */
export const AGENTS_MARKS_MAX = 8
/** Segments the bar (E6) draws one per agent; past this it keeps its width and thins its gaps. */
export const AGENTS_BAR_MAX = 10

export interface AgentsTally {
	total: number
	/** Working or with background work only (the current entry's "busy"). */
	busy: number
	/** Non-empty states only, in the pane's order. */
	states: Array<{ status: Status; count: number; glyph: string }>
	/** One status per agent in the pane's order (the sessions arrive ordered). */
	marks: Status[]
	/** The accessible name, states in words: `3 agents: 2 working, 1 idle. Show agents`. */
	label: string
}

/** The Agents entry's data for the variants. `none` is the no-session sentence (noSessionText). */
export function agentsTally(sessions: readonly DockSession[], none: string): AgentsTally {
	const marks = sessions.map(session => session.status)
	const states = STATES.flatMap(status => {
		const count = marks.filter(mark => mark === status).length
		return count > 0 ? [{ status, count, glyph: statusGlyph(status) }] : []
	})
	const total = sessions.length
	const label =
		total === 0
			? `${none}. Show agents`
			: `${total} agent${total === 1 ? '' : 's'}: ${states.map(state => `${state.count} ${STATE_WORDS[state.status]}`).join(', ')}. Show agents`
	return { total, busy: busyCount(sessions), states, marks, label }
}

/** E2: the marks the cluster shows (all up to AGENTS_MARKS_MAX, else one fewer and "+N" for the rest). */
export function shownMarks(marks: readonly Status[]): { shown: Status[]; rest: Status[] } {
	if (marks.length <= AGENTS_MARKS_MAX) return { shown: [...marks], rest: [] }
	return { shown: marks.slice(0, AGENTS_MARKS_MAX - 1), rest: marks.slice(AGENTS_MARKS_MAX - 1) }
}

/** States that ask for Jakub's attention keep their warn tone, even folded into "+N". */
export const isWarnState = (status: Status): boolean => status === 'waiting' || status === 'unknown'
