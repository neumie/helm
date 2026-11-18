// Signals HTTP surface (`/api/signals/*`): the snapshot the Signals column and `helm signal`
// read, per-thread state/owner/note/routing writes, agent asks (`helm signal add/done`) and
// Jakub's replies to them, a long-poll change feed for the dispatcher, and a coalesced manual
// poll trigger. Mounted from api.ts. Signals are global: the active Helm
// profile never changes what these routes read or write.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { DB } from '../../db/client.js'
import {
	SIGNAL_ASK_KEY,
	SIGNAL_OWNERS,
	SIGNAL_SOURCES,
	SIGNAL_STATES,
	type SignalCloser,
	type SignalEventsPage,
	type SignalIncludeResult,
	type SignalMuteResult,
	type SignalSlackMuteResult,
	type SignalThread,
	type SignalsSnapshot,
	signalAnsweredSchema,
	signalAskDoneSchema,
	signalAskSchema,
	signalDoneSchema,
	signalNoteSchema,
	signalReplySchema,
	signalRoutedSchema,
	signalSlackReplySchema,
	signalUpdateSchema,
} from '../../signals/contract.js'
import {
	type CanUnmuteSender,
	type IncludeSender,
	IncludeSenderError,
	type MuteSender,
} from '../../signals/include-sender.js'
import {
	SignalConflictError,
	SignalInvalidError,
	SignalLimitError,
	type SignalListFilter,
	SignalNotFoundError,
	type SignalStore,
} from '../../signals/store.js'
import type { SignalsWatcher } from '../../signals/watcher.js'

/** Named dependency carried on `ProfileContext.signals`; routes still serve the store without it. */
export interface SignalRouteDependencies {
	watcher: Pick<SignalsWatcher, 'requestPoll' | 'restartPoll' | 'health'>
	/** Shows a filtered sender again: unmutes it or adds it to the Mail include list (config file + live config). */
	includeSender?: IncludeSender
	/** Adds an exact address to the Mail exclude list (`x`; config file + live config). */
	muteSender?: MuteSender
	/** Whether only a mute keeps a filtered sender out (marks the entry `unmute`, so `i` says so). */
	canUnmuteSender?: CanUnmuteSender
	/** Test seam for the clock used by store writes. */
	now?: () => Date
	/** Long-poll re-check interval; tests shorten it. */
	eventPollMs?: number
	/**
	 * Whether a request carries the daemon's local control token (only Helm's main process holds
	 * it). Jakub's reply to an ask and its `replied` receipt need it, so no agent can answer another
	 * agent's ask in Jakub's name. Missing = refused. A thread closed through a request carrying it
	 * is recorded as closed by Jakub, any other close as closed by an agent (`helm signal`).
	 */
	controlAuthorized?: (c: Context) => boolean
	/** Posts Jakub's reply to a Slack thread/DM (Helm only), then the store closes it. */
	slackReply?: (thread: SignalThread, text: string) => Promise<{ ok: boolean; error?: string }>
	/** Adds a Slack user id to the exclude list (`x`; config file + live config). */
	muteSlackUser?: (userId: string) => { userId: string; added: boolean; unincluded: boolean }
	/** Shows a filtered Slack sender again: unmutes it or adds it to includeUsers. */
	includeSlackUser?: (userId: string, reason?: string) => { userId: string; added: boolean; unmuted?: boolean }
	/** Whether only a mute keeps a filtered Slack sender out (marks the entry `unmute`). */
	canUnmuteSlackUser?: (userId: string) => boolean
}

// An agent answer's body (4000 UTF-16 units, up to 12 KB of UTF-8) plus eight 2 KB links and a
// title must fit, with room for JSON escaping.
const MAX_SIGNAL_BODY_BYTES = 40 * 1024
/** Longest `wait` a client may ask `GET /signals/events` to hold the request open. */
export const SIGNAL_EVENTS_MAX_WAIT_SECONDS = 25
const DEFAULT_EVENT_POLL_MS = 500

const listQuerySchema = z.object({
	owner: z.enum(SIGNAL_OWNERS).optional(),
	states: z.array(z.enum(SIGNAL_STATES)).max(SIGNAL_STATES.length * 2),
	source: z.enum(SIGNAL_SOURCES).optional(),
	all: z.boolean(),
})

const eventsQuerySchema = z.object({
	after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
	wait: z.coerce.number().int().min(0).max(SIGNAL_EVENTS_MAX_WAIT_SECONDS).default(0),
})

function signalId(raw: string): number | null {
	if (!/^[1-9]\d{0,15}$/.test(raw)) return null
	const id = Number(raw)
	return Number.isSafeInteger(id) ? id : null
}

/** Resolves after `ms` or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		if (signal.aborted) {
			resolve()
			return
		}
		const done = () => {
			clearTimeout(timer)
			signal.removeEventListener('abort', done)
			resolve()
		}
		const timer = setTimeout(done, ms)
		signal.addEventListener('abort', done, { once: true })
	})
}

export function signalRoutes(db: DB, deps?: SignalRouteDependencies): Hono {
	const routes = new Hono()
	const signalsBody = bodyLimit({ maxSize: MAX_SIGNAL_BODY_BYTES })
	const now = deps?.now ?? (() => new Date())
	const eventPollMs = deps?.eventPollMs ?? DEFAULT_EVENT_POLL_MS
	const storeFor = (): SignalStore => db.signals
	const jakubOnly = (c: Context, what = 'record Jakub’s reply') =>
		deps?.controlAuthorized?.(c) ? null : c.json({ error: `Only Helm can ${what}` }, 401)
	/** Who a close through this request is recorded as (display only, never an authorization). */
	const closer = (c: Context): SignalCloser => (deps?.controlAuthorized?.(c) ? 'jakub' : 'agent')

	const parseBody = async <T>(c: Context, schema: z.ZodType<T>): Promise<{ data: T } | { error: Response }> => {
		try {
			const parsed = schema.safeParse(await c.req.json())
			return parsed.success
				? { data: parsed.data }
				: { error: c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400) }
		} catch {
			return { error: c.json({ error: 'Invalid JSON body' }, 400) }
		}
	}

	const failure = (c: Context, err: unknown) => {
		if (err instanceof SignalNotFoundError) return c.json({ error: 'Signal not found' }, 404)
		if (err instanceof SignalInvalidError) return c.json({ error: err.message }, 400)
		if (err instanceof SignalLimitError) return c.json({ error: err.message }, 429)
		if (err instanceof SignalConflictError) return c.json({ error: err.message }, 409)
		throw err
	}

	routes.get('/', c => {
		const stateParam = c.req.query('state')
		const parsed = listQuerySchema.safeParse({
			owner: c.req.query('owner') || undefined,
			states: stateParam ? stateParam.split(',').map(state => state.trim()) : [],
			source: c.req.query('source') || undefined,
			all: c.req.query('all') === '1' || c.req.query('all') === 'true',
		})
		if (!parsed.success) {
			return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400)
		}
		const store = storeFor()
		const at = now()
		store.wakeSnoozed(at)
		const filter: SignalListFilter = {
			owner: parsed.data.owner,
			states: parsed.data.states.length > 0 ? [...new Set(parsed.data.states)] : undefined,
			source: parsed.data.source,
			includeAllDone: parsed.data.all,
		}
		const seq = store.latestSeq()
		const stored = store.sources()
		const snapshot: SignalsSnapshot = {
			threads: store.list(filter, at),
			sources: deps ? deps.watcher.health(stored) : stored,
			seq,
			generatedAt: at.toISOString(),
			filteredCount: store.filteredCount(at),
		}
		return c.json({ data: snapshot })
	})

	// Static paths come before `/:id` so they never parse as an id.
	routes.get('/events', async c => {
		const parsed = eventsQuerySchema.safeParse({
			after: c.req.query('after') || undefined,
			wait: c.req.query('wait') || undefined,
		})
		if (!parsed.success) {
			return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400)
		}
		const { after, wait } = parsed.data
		const store = storeFor()
		const abort = c.req.raw.signal
		const deadline = Date.now() + wait * 1000
		for (;;) {
			const events = store.events(after)
			if (events.length > 0 || Date.now() >= deadline || abort.aborted) {
				const page: SignalEventsPage = { events, seq: events.at(-1)?.seq ?? Math.max(after, store.latestSeq()) }
				return c.json({ data: page })
			}
			await pause(Math.min(eventPollMs, Math.max(0, deadline - Date.now())), abort)
		}
	})

	// Mail the rules kept out of Needs you, heads only (the audit log behind `N filtered`).
	routes.get('/filtered', c => {
		const page = storeFor().listFiltered(now())
		const canUnmute = deps?.canUnmuteSender
		const canUnmuteSlack = deps?.canUnmuteSlackUser
		if (!canUnmute && !canUnmuteSlack) return c.json({ data: page })
		const entries = page.entries.map(entry => {
			if (entry.reason !== 'excluded') return entry
			const unmute =
				entry.source === 'slack'
					? canUnmuteSlack?.(entry.senderIdentity)
					: canUnmute?.(entry.senderIdentity, entry.senderAddress)
			return unmute ? { ...entry, unmute: true as const } : entry
		})
		return c.json({ data: { ...page, entries } })
	})

	// One key from the filtered log: always show this sender. Only an id from the log is accepted,
	// never a free-form glob.
	routes.post('/filtered/:id/include', signalsBody, c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid filtered mail id' }, 400)
		if (!deps?.includeSender) return c.json({ error: 'This daemon cannot change the include list' }, 503)
		const store = storeFor()
		const entry = store.getFiltered(id, now())
		if (!entry) return c.json({ error: 'Filtered mail not found' }, 404)
		let result: SignalIncludeResult
		try {
			result = deps.includeSender(entry.senderIdentity, { raw: entry.senderAddress, reason: entry.reason })
		} catch (err) {
			if (err instanceof IncludeSenderError) return c.json({ error: err.message }, 400)
			return c.json({ error: `Failed to save the include list: ${err instanceof Error ? err.message : err}` }, 500)
		}
		store.forgetFilteredSender(result.address)
		deps.watcher.restartPoll('mail')
		return c.json({ data: result })
	})

	// `x` on a mail row: never show its sender (exclude list), and close Jakub's open mail threads
	// from it at once; their mail is listed as filtered (`excluded`), where `i` shows it again.
	// Helm only: hiding Jakub's mail is his call, never an agent's.
	routes.post('/:id/mute', signalsBody, c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const refused = jakubOnly(c, 'mute a sender')
		if (refused) return refused
		if (!deps?.muteSender) return c.json({ error: 'This daemon cannot change the exclude list' }, 503)
		const store = storeFor()
		const thread = store.get(id)
		if (!thread) return c.json({ error: 'Signal not found' }, 404)
		if (thread.source !== 'mail' || thread.kind !== 'mail')
			return c.json(
				{ error: thread.kind === 'sentry' ? 'Sentry alerts always show' : 'Only mail senders can be muted' },
				400,
			)
		// A managed thread stays with its agent: muting would hide its sender but close nothing.
		if (thread.owner !== 'jakub') return c.json({ error: 'An agent is handling this thread; take it back first' }, 409)
		const sender = store.threadSender(id)
		if (sender === null)
			return c.json({ error: 'The sender is not known yet; try again after the next Mail poll' }, 409)
		let muted: ReturnType<MuteSender>
		try {
			muted = deps.muteSender(sender.identity, { raw: sender.raw })
		} catch (err) {
			if (err instanceof IncludeSenderError) return c.json({ error: err.message }, 400)
			return c.json({ error: `Failed to save the exclude list: ${err instanceof Error ? err.message : err}` }, 500)
		}
		const result: SignalMuteResult = { ...muted, threadIds: store.muteSender(muted.address, now(), sender.raw) }
		deps.watcher.restartPoll('mail')
		return c.json({ data: result })
	})

	routes.post('/poll', c => {
		if (!deps) return c.json({ error: 'Signals polling is not running' }, 503)
		deps.watcher.requestPoll()
		return c.json({ data: { requested: true } })
	})

	routes.post('/asks', signalsBody, async c => {
		const body = await parseBody(c, signalAskSchema)
		if ('error' in body) return body.error
		try {
			return c.json({ data: storeFor().upsertAsk(body.data, now()) })
		} catch (err) {
			return failure(c, err)
		}
	})

	routes.get('/asks', c => {
		const key = c.req.query('key') ?? ''
		if (!SIGNAL_ASK_KEY.test(key)) return c.json({ error: 'Invalid ask key' }, 400)
		const thread = storeFor().getAskByKey(key)
		return thread ? c.json({ data: thread }) : c.json({ error: 'Signal not found' }, 404)
	})

	routes.post('/asks/done', signalsBody, async c => {
		const body = await parseBody(c, signalAskDoneSchema)
		if ('error' in body) return body.error
		const store = storeFor()
		// No await between lookup and close, so the key cannot move to another thread meanwhile.
		const thread = store.getAskByKey(body.data.key)
		if (!thread) return c.json({ error: 'Signal not found' }, 404)
		try {
			return c.json({ data: store.done(thread.id, body.data.note, now(), closer(c)) })
		} catch (err) {
			return failure(c, err)
		}
	})

	routes.get('/:id', c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const thread = storeFor().get(id)
		return thread ? c.json({ data: thread }) : c.json({ error: 'Signal not found' }, 404)
	})

	routes.post('/:id', signalsBody, async c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const body = await parseBody(c, signalUpdateSchema)
		if ('error' in body) return body.error
		try {
			return c.json({ data: storeFor().update(id, body.data, now(), closer(c)) })
		} catch (err) {
			return failure(c, err)
		}
	})

	routes.post('/:id/note', signalsBody, async c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const body = await parseBody(c, signalNoteSchema)
		if ('error' in body) return body.error
		try {
			return c.json({ data: storeFor().setNote(id, body.data.note, now()) })
		} catch (err) {
			return failure(c, err)
		}
	})

	routes.post('/:id/routed', signalsBody, async c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const body = await parseBody(c, signalRoutedSchema)
		if ('error' in body) return body.error
		if (body.data.how === 'replied') {
			const refused = jakubOnly(c)
			if (refused) return refused
		}
		try {
			return c.json({ data: storeFor().setRouted(id, body.data, now()) })
		} catch (err) {
			return failure(c, err)
		}
	})

	routes.post('/:id/done', signalsBody, async c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const body = await parseBody(c, signalDoneSchema)
		if ('error' in body) return body.error
		try {
			return c.json({ data: storeFor().done(id, body.data.note, now(), closer(c)) })
		} catch (err) {
			return failure(c, err)
		}
	})

	routes.post('/:id/reply', signalsBody, async c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const refused = jakubOnly(c)
		if (refused) return refused
		const body = await parseBody(c, signalReplySchema)
		if ('error' in body) return body.error
		try {
			return c.json({ data: storeFor().reply(id, body.data.text, now()) })
		} catch (err) {
			return failure(c, err)
		}
	})

	// Helm's ask resolver: Jakub prompted the ask's terminal. Helm only, like the reply: no agent may
	// close another agent's ask in Jakub's name.
	routes.post('/:id/answered', signalsBody, async c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const refused = jakubOnly(c, 'record an answer in the terminal')
		if (refused) return refused
		const body = await parseBody(c, signalAnsweredSchema)
		if ('error' in body) return body.error
		try {
			return c.json({ data: storeFor().answered(id, body.data, now()) })
		} catch (err) {
			return failure(c, err)
		}
	})

	// `r` on a Slack row: post Jakub's reply to Slack, then close the thread. Helm only, like the ask
	// reply: no agent may post to Slack in Jakub's name.
	routes.post('/:id/slack-reply', signalsBody, async c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const refused = jakubOnly(c, 'reply to Slack')
		if (refused) return refused
		if (!deps?.slackReply) return c.json({ error: 'This daemon cannot post to Slack' }, 503)
		const store = storeFor()
		const thread = store.get(id)
		if (!thread) return c.json({ error: 'Signal not found' }, 404)
		if (thread.source !== 'slack') return c.json({ error: 'Only Slack threads can be replied to here' }, 400)
		const body = await parseBody(c, signalSlackReplySchema)
		if ('error' in body) return body.error
		const posted = await deps.slackReply(thread, body.data.text)
		if (!posted.ok) return c.json({ error: `Could not post to Slack: ${posted.error ?? 'failed'}` }, 502)
		try {
			return c.json({ data: store.markSlackAnswered(id, now()) })
		} catch (err) {
			return failure(c, err)
		}
	})

	// `x` on a Slack row: never show its sender (exclude list) and close Jakub's open Slack threads
	// from that user. Helm only.
	routes.post('/:id/slack-mute', signalsBody, c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		const refused = jakubOnly(c, 'mute a Slack sender')
		if (refused) return refused
		if (!deps?.muteSlackUser) return c.json({ error: 'This daemon cannot change the Slack exclude list' }, 503)
		const store = storeFor()
		const thread = store.get(id)
		if (!thread) return c.json({ error: 'Signal not found' }, 404)
		if (thread.source !== 'slack') return c.json({ error: 'Only Slack senders can be muted here' }, 400)
		if (thread.owner !== 'jakub') return c.json({ error: 'An agent is handling this thread; take it back first' }, 409)
		const sender = store.threadSlackSender(id)
		if (sender === null) return c.json({ error: 'The sender is not known yet; try again after the next poll' }, 409)
		let muted: ReturnType<NonNullable<SignalRouteDependencies['muteSlackUser']>>
		try {
			muted = deps.muteSlackUser(sender.userId)
		} catch (err) {
			if (err instanceof IncludeSenderError) return c.json({ error: err.message }, 400)
			return c.json({ error: `Failed to save the exclude list: ${err instanceof Error ? err.message : err}` }, 500)
		}
		const result: SignalSlackMuteResult = { ...muted, threadIds: store.muteSlackUser(muted.userId, now()) }
		deps.watcher.restartPoll('slack')
		return c.json({ data: result })
	})

	// `i` on a filtered Slack entry: show its sender again (unmute, or add to the include list). Helm
	// only, like slack-mute: it can reverse a mute Jakub made, so no agent may change it in his name.
	routes.post('/filtered/:id/slack-include', signalsBody, c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid filtered id' }, 400)
		const refused = jakubOnly(c, 'change the Slack include list')
		if (refused) return refused
		if (!deps?.includeSlackUser) return c.json({ error: 'This daemon cannot change the Slack include list' }, 503)
		const store = storeFor()
		const entry = store.getFiltered(id, now())
		if (!entry || entry.source !== 'slack') return c.json({ error: 'Filtered Slack message not found' }, 404)
		let result: ReturnType<NonNullable<SignalRouteDependencies['includeSlackUser']>>
		try {
			result = deps.includeSlackUser(entry.senderIdentity, entry.reason)
		} catch (err) {
			if (err instanceof IncludeSenderError) return c.json({ error: err.message }, 400)
			return c.json({ error: `Failed to save the include list: ${err instanceof Error ? err.message : err}` }, 500)
		}
		store.forgetFilteredSender(result.userId)
		deps.watcher.restartPoll('slack')
		return c.json({ data: result })
	})

	routes.post('/:id/seen', signalsBody, c => {
		const id = signalId(c.req.param('id'))
		if (id === null) return c.json({ error: 'Invalid signal id' }, 400)
		try {
			return c.json({ data: storeFor().markSeen(id, now()) })
		} catch (err) {
			return failure(c, err)
		}
	})

	return routes
}
