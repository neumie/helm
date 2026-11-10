// Agent dock vocabulary: the closed word lists and the few constants that main
// (app/src/agent-dock/model.ts types), the spool schemas (spool.ts zod enums),
// the CLI and the renderer all share. Import-free and zod-free, so the renderer
// bundle can value-import it and root `src/` (rootDir) can too.

/**
 * Where a dock session is observed: Okena Claude Remote (`okena`) or Helm's own
 * Claude hub for Claude Code in Helm terminals (`helm`; profile `helm:<profileId>`,
 * so its keys are `helm:<profileId>:<dtach session id>`). Both speak the same
 * Okena-shaped wire. Display order.
 */
export const DOCK_SOURCE_IDS = ['okena', 'helm'] as const
export type DockSourceId = (typeof DOCK_SOURCE_IDS)[number]

/** How a source names itself in dock, act and CLI text (the only place these words are written). */
export const DOCK_SOURCE_TEXT: Record<
	DockSourceId,
	{
		/** "Okena" / "Helm terminals": health lines, act failures, source lists. */
		label: string
		/** Act refusal when the item's session is no longer listed. */
		notListed: string
		/** Act refusal while the source is down. */
		sourceDown: string
		/** Poll error while the source has no active profile / is not listening. */
		notRunning: string
		/**
		 * Reply refusal when the fresh read cannot say whether the agent is free (busy unknown): the
		 * source lost the agent's state (Okena forgets idle panes across a daemon restart until their
		 * next hook) and would not type into the pane either.
		 */
		untracked: string
	}
> = {
	okena: {
		label: 'Okena',
		notListed: 'The agent is no longer listed by Okena.',
		sourceDown: 'Okena is unreachable; answer in the terminal',
		notRunning: 'Okena not configured or not running',
		untracked: 'Okena lost track of this agent (Okena restarted?); reply in its terminal',
	},
	helm: {
		label: 'Helm terminals',
		notListed: 'The agent is no longer listed in Helm terminals.',
		sourceDown: 'Helm terminals are unreachable; answer in the terminal',
		notRunning: "Helm's Claude hub is not listening",
		untracked: "Helm's Claude hub lost track of this agent; reply in its terminal",
	},
}

/** A source's reachability. `pending` = never polled yet; the UI must not show "all clear" for it. */
export const DOCK_SOURCE_HEALTH_STATES = ['pending', 'ok', 'down'] as const

/**
 * working: busy. background: not busy but subagents or background tasks (shells, workflows,
 * monitors) still running. idle: not busy.
 * waiting: a dialog is open. unknown: busy missing or detail unparseable/unfetched.
 * unreachable: the source itself is down (frozen row).
 */
export const DOCK_SESSION_STATUSES = ['working', 'background', 'idle', 'waiting', 'unknown', 'unreachable'] as const

export const DOCK_ITEM_KINDS = ['ask', 'turn'] as const

/**
 * open: owes Jakub. sending: Jakub answered from the dock; Helm is sending it or
 * waiting to see it land. unconfirmed: the source took it but Helm has not seen the
 * dialog close / a user entry within ACT_CONFIRM_MS (amber; stays until observed
 * or acked). orphaned: sticky until transcript activity or ack.
 */
export const DOCK_ITEM_STATES = ['open', 'sending', 'unconfirmed', 'orphaned', 'resolved'] as const

/** `dock`: Jakub's dock answer, observed taking effect. */
export const DOCK_RESOLUTION_BY = ['outside', 'replied', 'superseded', 'session_ended', 'acked', 'dock'] as const

export const DOCK_ACTION_KINDS = ['answer', 'allow', 'deny', 'prompt'] as const

export const DOCK_RECEIPT_STATUSES = ['sending', 'sent', 'unconfirmed', 'confirmed', 'refused', 'failed'] as const

/**
 * gone: the dialog/turn is no longer there (answered elsewhere). changed: the
 * question, its options or the turn changed since it was shown. busy: the agent is
 * working again; a reply would be queued behind work Jakub has not seen. not_open:
 * not answerable from the dock now (sending, unconfirmed, orphaned, resolved).
 * untracked: the source cannot tell whether the agent is free (busy unknown, e.g. Okena
 * restarted while the agent idled); never typed into, and never called "working".
 */
export const DOCK_REFUSAL_REASONS = [
	'gone',
	'changed',
	'busy',
	'not_open',
	'unknown_item',
	'invalid',
	'source_down',
	'in_flight',
	'untracked',
] as const

/** Bound for an agent's last-message excerpt (`DockSession.lastMessage.text`): one line. */
export const DOCK_EXCERPT_MAX = 160
/** Bound for the full last message the agent detail reads live (memory/IPC only). */
export const DOCK_LIVE_MESSAGE_MAX = 8_192

/** How Okena (or Helm's hub) delivered a reply to the agent. */
export const DOCK_PROMPT_DELIVERIES = ['channel', 'pty', 'queued'] as const

/**
 * Deliveries the source holds for after the agent's turn (Okena's queue or its MCP channel, Helm's
 * hub queue): typed in once the agent stops, so they land at its next prompt, not sooner.
 */
export const isHeldDelivery = (delivery: string | undefined): boolean => delivery === 'queued' || delivery === 'channel'
