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
	type SignalEventsPage,
	type SignalIncludeResult,
	type SignalsSnapshot,
	signalAskDoneSchema,
	signalAskSchema,
	signalDoneSchema,
	signalNoteSchema,
	signalReplySchema,
	signalRoutedSchema,
	signalUpdateSchema,
} from '../../signals/contract.js'
import { type IncludeSender, IncludeSenderError } from '../../signals/include-sender.js'
import {
	SignalInvalidError,
	SignalLimitError,
	type SignalListFilter,
	SignalNotFoundError,
	type SignalStore,
} from '../../signals/store.js'
import type { SignalsWatcher } from '../../signals/watcher.js'

/** Named dependency carried on `ProfileContext.signals`; routes still serve the store without it. */
export interface SignalRouteDependencies {
	watcher: Pick<SignalsWatcher, 'requestPoll' | 'health'>
	/** Adds an exact address to the Mail include list (config file + live config). */
	includeSender?: IncludeSender
	/** Test seam for the clock used by store writes. */
	now?: () => Date
	/** Long-poll re-check interval; tests shorten it. */
	eventPollMs?: number
	/**
	 * Whether a request carries the daemon's local control token (only Helm's main process holds
	 * it). Jakub's reply to an ask and its `replied` receipt need it, so no agent can answer another
	 * agent's ask in Jakub's name. Missing = refused.
	 */
	controlAuthorized?: (c: Context) => boolean
}

const MAX_SIGNAL_BODY_BYTES = 16 * 1024
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
	const jakubOnly = (c: Context) =>
		deps?.controlAuthorized?.(c) ? null : c.json({ error: 'Only Helm can record Jakub’s reply' }, 401)

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
	routes.get('/filtered', c => c.json({ data: storeFor().listFiltered(now()) }))

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
			result = deps.includeSender(entry.senderIdentity)
		} catch (err) {
			if (err instanceof IncludeSenderError) return c.json({ error: err.message }, 400)
			return c.json({ error: `Failed to save the include list: ${err instanceof Error ? err.message : err}` }, 500)
		}
		store.forgetFilteredSender(result.address)
		deps.watcher.requestPoll()
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
			return c.json({ data: store.done(thread.id, body.data.note, now()) })
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
			return c.json({ data: storeFor().update(id, body.data, now()) })
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
			return c.json({ data: storeFor().done(id, body.data.note, now()) })
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
