// Review only: calmer dock looks Jakub compares in Storybook (Views / Agent dock calm) before one
// replaces the shipped design. Production always renders 'current'; the others are reachable from
// stories alone (mountAgentDock's `look`), over the same data, components and keyboard behaviour.

import { createContext, useContext } from 'react'

/**
 * - `current`: the shipped dock (§3.24).
 * - `one-typeface`: the same structure in the UI face throughout (mono only for literal commands and
 *   code); header glyph + name + dim age; no task-title line; choices as label + dim description on one line.
 * - `two-bands`: one-typeface, plus the strip merged into a one-line queue row (agents, Okena dot and
 *   ⌘⇧J on its right; collapsed is that same row with the summary); the pane header names the kind
 *   and question context only (the queue's selected fill says whose).
 * - `focus`: one-typeface; while a pane is open the queue row is hidden (the header carries
 *   name · age and ‹ 1/3 ›); closed, the same single quiet row as two-bands.
 */
export type AgentDockLook = 'current' | 'one-typeface' | 'two-bands' | 'focus'

export const AgentDockLookContext = createContext<AgentDockLook>('current')

export const useDockLook = (): AgentDockLook => useContext(AgentDockLookContext)

/** Looks set in the UI face throughout. */
export const isCalmLook = (look: AgentDockLook): boolean => look !== 'current'

/** Looks whose queue is one line-high row that absorbs the strip. */
export const isRowLook = (look: AgentDockLook): boolean => look === 'two-bands' || look === 'focus'
