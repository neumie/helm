// What every agent dock pane body gets (PanelProps), and the per-item drafts that survive
// stepping and closing the pane (renderer memory only).
import { type MutableRefObject, type ReactNode, useState } from 'react'
import type { DockAction, DockItem } from '../../agent-dock/model'
import type { DetailKeys, DockModKey } from './pane-keys'

/** Per-item drafts that survive stepping and closing the pane (renderer memory only): reply/deny text, question picks. */
export type DockDrafts = Map<string, string>

/** Draft keys of one item, cleared once an act for it succeeds. */
export const draftKeys = (itemId: number): string[] => [`ask:${itemId}`, `deny:${itemId}`, `reply:${itemId}`]

export function useDraft(drafts: DockDrafts, key: string, fallback = ''): [string, (value: string) => void] {
	const [value, setValue] = useState(() => drafts.get(key) ?? fallback)
	return [
		value,
		next => {
			setValue(next)
			if (next) drafts.set(key, next)
			else drafts.delete(key)
		},
	]
}

export interface PanelProps {
	item: DockItem
	/** Controls are live: the item is open, Okena is reachable, nothing is being sent. */
	live: boolean
	/** The item can be answered here at all (open, Okena reachable); unlike `live`, steady while sending. */
	answerable: boolean
	/** The decision button belongs in the footer: answerable, or an answer is on its way (it shows busy). */
	decidable: boolean
	/** What was last sent from the dock for this item: shown while sending and after, restored after a failure. */
	sent: DockAction | null
	mod: DockModKey
	/** Why controls are off, when they are and no receipt explains it. */
	blockedNote: string | null
	receipt: ReactNode
	ack: ReactNode
	/** The `⌘⌫ ack` key hint, or null where Ack is not offered; it goes before `esc close`. */
	ackHint: ReactNode
	warnings: ReactNode
	keys: MutableRefObject<DetailKeys | null>
	drafts: DockDrafts
	submitting: boolean
	onAct(action: DockAction): void
}
