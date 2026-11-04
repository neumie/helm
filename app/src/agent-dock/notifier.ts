// Agent dock → macOS: a native notification when an item newly needs Jakub while Helm is in the
// background, and the Dock badge (count of items that need him). Pure policy: no Electron import;
// main injects `show` (Electron Notification), `setBadge` (app.dock), `isForeground` and `openItem`
// (agent-dock-notify-main.ts), so it runs under node --test.
//
// Policy (design §3.24 "Background notifications"):
//   - trigger: an `item.opened` the watcher saw in a live observation, never one replayed by a
//     source's seed tick or a pane's restart adoption (watcher `replayed`), never twice per item,
//     nothing while Helm is the focused app (the strip's arrival pulse covers that) or the setting is off;
//   - one live notification per agent: a newer one for the same session closes the older;
//   - burst: NOTIFY_BURST_MIN agents or more within NOTIFY_BURST_MS share one summary
//     ("3 agents need you") that replaces their own notifications;
//   - turns: at most one per agent per NOTIFY_TURN_COOLDOWN_MS, and silent (Claude Code's own Stop
//     hook already plays a sound); asks are never cooled down and play the default sound;
//   - an item that no longer waits (answered, acked, closed) closes its notification;
//   - click: focus Helm and open the dock on the item, else on the next one waiting, else nothing;
//   - the badge counts what the queue row shows (every item not resolved), on every update;
//     `idleBadge` ('dev' for side-by-side instances) stands in for 0.

import { agentWho, askQuestions, itemKindLabel, plainAgentLine } from '../renderer/agent-dock/presentation'
import type { AgentDockSnapshot, DockItem } from './model'

/** Opens closer together than this count as one burst. */
export const NOTIFY_BURST_MS = 2_000
/** This many distinct agents in one burst get one summary notification instead of their own. */
export const NOTIFY_BURST_MIN = 3
/** A turn notifies at most once per agent in this window (asks are never cooled down). */
export const NOTIFY_TURN_COOLDOWN_MS = 30_000
/** Body bound (characters, one line). */
export const NOTIFY_BODY_MAX = 140
/** Item ids remembered as notified (or deliberately skipped); oldest dropped beyond this. */
const NOTIFIED_MAX = 500

/** What macOS shows: title = the agent's short name, subtitle = kind · project, body = the gist's first line. */
export interface AgentDockNotice {
	title: string
	subtitle: string
	body: string
	/** Turns are silent; asks play the default notification sound. */
	silent: boolean
}

export interface AgentDockNoticeHandle {
	close(): void
}

/** What the watcher reports after every reduction (watcher.ts `observe`). */
export interface AgentDockUpdate {
	snapshot: AgentDockSnapshot
	/** Items this update opened in a live observation. */
	opened: number[]
	/** Items opened by a seed/restart replay: known before, or finished while Helm was closed. Never notified. */
	replayed: number[]
}

export interface AgentDockNotifierOptions {
	/** Shows one native notification; null when the OS cannot (unsupported). `onClick` runs on a click. */
	show(notice: AgentDockNotice, onClick: () => void): AgentDockNoticeHandle | null
	/** app.dock.setBadge; called only when the text changes. */
	setBadge(text: string): void
	/** Helm is the focused app (main window focused, shown, not minimized). */
	isForeground(): boolean
	/** Focus Helm and open the dock pane on this item (null: just focus Helm). */
	openItem(itemId: number | null): void
	/** The badge with nothing waiting ('' clears it; side-by-side keeps 'dev'). */
	idleBadge?: string
	now?: () => number
	log?: (message: string) => void
}

/** One shown notification: an agent's (its one item) or a burst summary (every item in it). */
interface LiveNotice {
	handle: AgentDockNoticeHandle
	items: number[]
}

const SUMMARY = '\0summary'

/** An item still owes Jakub something a notification would point at (not answered, acked or closed). */
const waiting = (item: DockItem | undefined): item is DockItem =>
	item !== undefined && (item.state === 'open' || item.state === 'orphaned')

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** The first non-empty line of agent text, Markdown heading marks dropped, bounded to NOTIFY_BODY_MAX. */
function firstLine(text: unknown): string {
	if (typeof text !== 'string') return ''
	const line = text.split('\n').find(part => part.trim() !== '') ?? ''
	return plainAgentLine(line.replace(/^\s*#+\s*/, ''), NOTIFY_BODY_MAX)
}

/** The body: the question, the command, the plan's title or the turn's message — its first line. */
export function noticeBody(item: DockItem): string {
	if (item.fact.kind === 'turn') return firstLine(item.fact.text) || 'Agent finished its turn'
	const { tool, input } = item.fact
	if (tool === 'AskUserQuestion') return firstLine(askQuestions(input)?.[0]?.question) || 'Question'
	if (tool === 'ExitPlanMode') return (isRecord(input) && firstLine(input.plan)) || 'Plan ready for approval'
	const command = isRecord(input) ? firstLine(input.command) : ''
	return command || plainAgentLine(`Allow ${plainAgentLine(tool, 64)}?`, NOTIFY_BODY_MAX)
}

/** One item's notification: who (as the queue row names the agent), what kind and where, and the gist. */
export function itemNotice(snapshot: AgentDockSnapshot, item: DockItem): AgentDockNotice {
	const who = agentWho(snapshot, item.session)
	return {
		title: who.name,
		subtitle: who.project ? `${itemKindLabel(item)} · ${who.project}` : itemKindLabel(item),
		body: noticeBody(item),
		silent: item.kind === 'turn',
	}
}

/** A burst's notification: how many agents, and their names. Sounds when an ask is new in it. */
export function summaryNotice(
	snapshot: AgentDockSnapshot,
	items: readonly DockItem[],
	sound: boolean,
): AgentDockNotice {
	const sessions = [...new Set(items.map(item => item.session))]
	const asks = items.filter(item => item.kind === 'ask').length
	const turns = items.length - asks
	const kinds = [
		asks > 0 ? `${asks} ${asks === 1 ? 'ask' : 'asks'}` : '',
		turns > 0 ? `${turns} ${turns === 1 ? 'turn ended' : 'turns ended'}` : '',
	].filter(Boolean)
	return {
		title: `${sessions.length} ${sessions.length === 1 ? 'agent needs' : 'agents need'} you`,
		subtitle: kinds.join(' · '),
		body: plainAgentLine(sessions.map(key => agentWho(snapshot, key).name).join(', '), NOTIFY_BODY_MAX),
		silent: !sound,
	}
}

export class AgentDockNotifier {
	private enabled = true
	private snapshot: AgentDockSnapshot | null = null
	private badge: string
	/** By session key (one per agent), plus SUMMARY for a burst. */
	private readonly live = new Map<string, LiveNotice>()
	/** Items already notified or deliberately skipped (insertion order = age). */
	private readonly handled = new Set<number>()
	/** Last turn notification per session (cooldown). */
	private readonly lastTurnAt = new Map<string, number>()
	/** Notified opens inside the current burst window. */
	private recent: Array<{ at: number; session: string; id: number }> = []
	private readonly now: () => number
	private readonly idleBadge: string

	constructor(private readonly options: AgentDockNotifierOptions) {
		this.now = options.now ?? Date.now
		this.idleBadge = options.idleBadge ?? ''
		// main set the idle badge itself at launch (or none): only a change is written.
		this.badge = this.idleBadge
	}

	/** Settings → Appearance → Agent dock → "Notify when Helm is in the background". Off closes what is shown. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled
		if (!enabled) for (const key of [...this.live.keys()]) this.close(key)
	}

	isEnabled(): boolean {
		return this.enabled
	}

	update(update: AgentDockUpdate): void {
		const { snapshot } = update
		this.snapshot = snapshot
		const byId = new Map(snapshot.items.map(item => [item.id, item]))
		this.setBadge(snapshot.items.filter(item => item.state !== 'resolved').length)
		// Close what no longer waits: an agent's notice with its item, a summary once all of its items.
		for (const [key, notice] of [...this.live]) {
			const still = notice.items.filter(id => waiting(byId.get(id)))
			if (still.length === 0) this.close(key)
			else notice.items = still
		}
		for (const id of update.replayed) this.remember(id)
		const fresh = update.opened
			.filter(id => !this.handled.has(id))
			.map(id => byId.get(id))
			.filter((item): item is DockItem => item?.state === 'open')
		for (const item of fresh) this.remember(item.id)
		if (fresh.length === 0 || !this.enabled || this.foreground()) return
		const now = this.now()
		const due = fresh.filter(item => {
			if (item.kind !== 'turn') return true
			const last = this.lastTurnAt.get(item.session)
			if (last !== undefined && now - last >= 0 && now - last < NOTIFY_TURN_COOLDOWN_MS) return false
			this.lastTurnAt.set(item.session, now)
			return true
		})
		if (due.length === 0) return
		this.recent = this.recent.filter(entry => now - entry.at >= 0 && now - entry.at < NOTIFY_BURST_MS)
		for (const item of due) this.recent.push({ at: now, session: item.session, id: item.id })
		const burstSessions = new Set(this.recent.map(entry => entry.session))
		if (burstSessions.size >= NOTIFY_BURST_MIN) {
			this.showSummary(
				snapshot,
				byId,
				due.some(item => item.kind === 'ask'),
			)
			return
		}
		// One per agent: the newest item of each session in this update.
		const newest = new Map<string, DockItem>()
		for (const item of due) newest.set(item.session, item)
		for (const item of newest.values()) this.showItem(snapshot, item)
	}

	/** Closes every shown notification (Helm quits). */
	dispose(): void {
		for (const key of [...this.live.keys()]) this.close(key)
	}

	private showItem(snapshot: AgentDockSnapshot, item: DockItem): void {
		this.close(item.session)
		const handle = this.display(itemNotice(snapshot, item), () => this.clicked(item.session, [item.id]))
		if (handle) this.live.set(item.session, { handle, items: [item.id] })
	}

	/** The burst's items (and a summary's still waiting) in one notification; their own ones close. */
	private showSummary(snapshot: AgentDockSnapshot, byId: Map<number, DockItem>, sound: boolean): void {
		const ids = new Set([...(this.live.get(SUMMARY)?.items ?? []), ...this.recent.map(entry => entry.id)])
		for (const entry of this.recent) {
			const own = this.live.get(entry.session)
			if (own) {
				for (const id of own.items) ids.add(id)
				this.close(entry.session)
			}
		}
		const items = [...ids].map(id => byId.get(id)).filter(waiting)
		this.close(SUMMARY)
		if (items.length === 0) return
		// Queue order (the snapshot's): a click opens the most urgent one first.
		const ordered = snapshot.items.filter(item => items.includes(item))
		const orderedIds = ordered.map(item => item.id)
		const handle = this.display(summaryNotice(snapshot, ordered, sound), () => this.clicked(SUMMARY, orderedIds))
		if (handle) this.live.set(SUMMARY, { handle, items: orderedIds })
	}

	/**
	 * A click: the notice is gone; Helm opens the dock on the first of its items still waiting, else on
	 * the next item waiting at all, else just comes forward.
	 */
	private clicked(key: string, items: readonly number[]): void {
		const notice = this.live.get(key)
		if (notice?.items.every(id => items.includes(id))) this.live.delete(key)
		const queue = (this.snapshot?.items ?? []).filter(waiting)
		const target = items.map(id => queue.find(item => item.id === id)).find(item => item !== undefined) ?? queue[0]
		try {
			this.options.openItem(target?.id ?? null)
		} catch (error) {
			this.warn(`open failed: ${errorMessage(error)}`)
		}
	}

	private display(notice: AgentDockNotice, onClick: () => void): AgentDockNoticeHandle | null {
		try {
			return this.options.show(notice, onClick)
		} catch (error) {
			this.warn(`notification failed: ${errorMessage(error)}`)
			return null
		}
	}

	private close(key: string): void {
		const notice = this.live.get(key)
		if (!notice) return
		this.live.delete(key)
		try {
			notice.handle.close()
		} catch {
			// Already gone (dismissed in Notification Center).
		}
	}

	private foreground(): boolean {
		try {
			return this.options.isForeground()
		} catch {
			return false
		}
	}

	private setBadge(count: number): void {
		const text = count > 0 ? String(count) : this.idleBadge
		if (text === this.badge) return
		this.badge = text
		try {
			this.options.setBadge(text)
		} catch (error) {
			this.warn(`badge failed: ${errorMessage(error)}`)
		}
	}

	private remember(id: number): void {
		this.handled.add(id)
		if (this.handled.size <= NOTIFIED_MAX) return
		const oldest = this.handled.values().next().value
		if (oldest !== undefined) this.handled.delete(oldest)
	}

	private warn(message: string): void {
		;(this.options.log ?? (text => console.warn(`[helm] agent dock notifications: ${text}`)))(message)
	}
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300)
