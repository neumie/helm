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

/** Words for a source in dock/CLI text. */
export const DOCK_SOURCE_LABEL: Record<DockSourceId, string> = { okena: 'Okena', helm: 'Helm terminals' }

/** A source's reachability. `pending` = never polled yet; the UI must not show "all clear" for it. */
export const DOCK_SOURCE_HEALTH_STATES = ['pending', 'ok', 'down'] as const

/**
 * working: busy. background: not busy but subagents still running. idle: not busy.
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
] as const

/** How Okena (or Helm's hub) delivered a reply to the agent. */
export const DOCK_PROMPT_DELIVERIES = ['channel', 'pty', 'queued'] as const

/** Free text to the agent (replies, deny messages, Other answers) that mentions these needs a second, explicit confirmation (renderer) and `confirmed` (main). */
export const DOCK_RISKY_PROMPT = /deploy|prod|secret|push|merge/i
