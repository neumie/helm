// When a dock item started owing Jakub. Zod-free (`import type` only), so the
// reducer (queue order) and the renderer (ages, aging tone) share one rule.

import type { DockItem } from './model'

/**
 * The dialog's own timestamp, else when the turn ended, else first observed.
 * Live items sort oldest-waiting first on this.
 */
export function itemWaitingSince(item: DockItem): number {
	if (item.fact.kind === 'ask' && item.fact.createdAtMs > 0) return Math.min(item.fact.createdAtMs, item.openedAt)
	if (item.fact.kind === 'turn') return item.fact.endedAt
	return item.openedAt
}
