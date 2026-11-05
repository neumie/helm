// Signals HTTP surface (`/api/signals/*`): the snapshot the Signals column and `helm signal`
// read, per-thread state/owner/note/routing writes, a long-poll change feed for the dispatcher,
// and a coalesced manual poll trigger. Mounted from api.ts; the request-scoped profile is the
// active one (api.ts wraps every request in `db.runInProfile`).

import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { DB } from '../../db/client.js'
import {
	SIGNAL_OWNERS,
	SIGNAL_SOURCES,
	SIGNAL_STATES,
	type SignalEventsPage,
	type SignalsSnapshot,
	signalNoteSchema,
	signalRoutedSchema,
	signalUpdateSchema,
} from '../../signals/contract.js'
import {
	SignalInvalidError,
	type SignalListFilter,
	SignalNotFoundError,
	type SignalStore,
} from '../../signals/store.js'
import type { SignalsWatcher } from '../../signals/watcher.js'

/** Named dependency carried on `ProfileContext.signals`; routes still serve the store without it. */
export interface SignalRouteDependencies {
	watcher: Pick<SignalsWatcher, 'requestPoll' | 'health'>
	/** Test seam for the clock used by store writes. */
	now?: () => Date
	/** Long-poll re-check interval; tests shorten it. */
	eventPollMs?: number
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
	// Bind the request's tenant once, so a profile switch during a long poll cannot redirect it.
	const storeFor = (): SignalStore => db.forProfile(db.currentProfileId()).signals

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
				const page: SignalEventsPage = { events, seq: events.at(-1)?.seq ?? after }
				return c.json({ data: page })
			}
			await pause(Math.min(eventPollMs, Math.max(0, deadline - Date.now())), abort)
		}
	})

	routes.post('/poll', c => {
		if (!deps) return c.json({ error: 'Signals polling is not running' }, 503)
		deps.watcher.requestPoll()
		return c.json({ data: { requested: true } })
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
		try {
			return c.json({ data: storeFor().setRouted(id, body.data, now()) })
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
