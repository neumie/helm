import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DB } from '../src/db/client.js'
import { type SignalRouteDependencies, signalRoutes } from '../src/server/routes/signals.js'
import type { SignalObservation, SignalSlackMuteResult, SignalThread } from '../src/signals/contract.js'

const NOW = new Date('2026-11-10T12:00:00.000Z')
const CONTROL = 'C'.repeat(43)

function slackObs(channel: string, user: string, threadTs?: string): SignalObservation {
	const key = threadTs ? `slack:T1:${channel}:${threadTs}` : `slack:T1:${channel}`
	return {
		threadKey: key,
		source: 'slack',
		kind: threadTs ? 'thread' : 'dm',
		reasons: [threadTs ? 'thread' : 'dm'],
		ref: 'Bob',
		fullRef: 'DM · Bob',
		title: 'ping',
		head: 'Bob: ping',
		actor: 'Bob',
		url: `https://cntmbr.slack.com/archives/${channel}/p123`,
		repo: null,
		number: null,
		branch: null,
		activityKey: '1699617600.000100',
		lastActivityAt: NOW.toISOString(),
		sender: user,
		senderAddress: user,
	}
}

async function withRoutes(
	deps: Partial<SignalRouteDependencies>,
	run: (ctx: {
		app: ReturnType<typeof signalRoutes>
		db: DB
		post: (p: string, body?: unknown, jakub?: boolean) => Promise<Response>
	}) => Promise<void>,
) {
	const root = mkdtempSync(join(tmpdir(), 'helm-slack-routes-'))
	const db = new DB(join(root, 'helm.db'))
	const base: SignalRouteDependencies = {
		watcher: { requestPoll: () => {}, restartPoll: () => {}, health: s => s },
		controlAuthorized: c => c.req.header('authorization') === `Bearer ${CONTROL}`,
		now: () => NOW,
		...deps,
	}
	const app = signalRoutes(db, base)
	const post = (p: string, body?: unknown, jakub = false) =>
		Promise.resolve(
			app.request(p, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...(jakub ? { authorization: `Bearer ${CONTROL}` } : {}) },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		)
	try {
		await run({ app, db, post })
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
}

test('slack-reply: Helm posts and the thread closes "answered in Slack"', async () => {
	let posted: { text: string } | null = null
	await withRoutes(
		{ slackReply: async (_thread, text) => ((posted = { text }), { ok: true }) },
		async ({ db, post }) => {
			db.signals.applyPoll(
				{ source: 'slack', observations: [slackObs('D1', 'ubob')], complete: true, goneReason: 'gone' },
				NOW,
			)
			const id = db.signals.list({}, NOW)[0].id
			// An agent (no control token) is refused.
			assert.equal((await post(`/${id}/slack-reply`, { text: 'hi' })).status, 401)
			const res = await post(`/${id}/slack-reply`, { text: 'on it' }, true)
			assert.equal(res.status, 200)
			const thread = ((await res.json()) as { data: SignalThread }).data
			assert.equal(thread.state, 'done')
			assert.equal(thread.closedReason, 'answered in Slack')
			assert.equal(posted?.text, 'on it')
		},
	)
})

test('slack-reply: a Slack post failure is a 502 and the thread stays open', async () => {
	await withRoutes({ slackReply: async () => ({ ok: false, error: 'channel_not_found' }) }, async ({ db, post }) => {
		db.signals.applyPoll(
			{ source: 'slack', observations: [slackObs('D1', 'ubob')], complete: true, goneReason: 'gone' },
			NOW,
		)
		const id = db.signals.list({}, NOW)[0].id
		const res = await post(`/${id}/slack-reply`, { text: 'x' }, true)
		assert.equal(res.status, 502)
		assert.equal(db.signals.get(id)?.state, 'new')
	})
})

test('slack-mute: closes the sender threads and excludes the user', async () => {
	let excluded: string | null = null
	await withRoutes(
		{ muteSlackUser: userId => ((excluded = userId), { userId, added: true, unincluded: false }) },
		async ({ db, post }) => {
			db.signals.applyPoll(
				{
					source: 'slack',
					observations: [slackObs('D1', 'ubob'), slackObs('D2', 'ubob')],
					complete: true,
					goneReason: 'gone',
				},
				NOW,
			)
			const id = db.signals.list({}, NOW)[0].id
			const res = await post(`/${id}/slack-mute`, {}, true)
			assert.equal(res.status, 200)
			const result = ((await res.json()) as { data: SignalSlackMuteResult }).data
			assert.equal(excluded, 'ubob')
			assert.equal(result.threadIds.length, 2)
			// Both threads are now done.
			assert.equal(db.signals.list({}, NOW).filter(t => t.state !== 'done').length, 0)
		},
	)
})

test('slack-mute: an agent is refused without the control token', async () => {
	await withRoutes({ muteSlackUser: userId => ({ userId, added: true, unincluded: false }) }, async ({ db, post }) => {
		db.signals.applyPoll(
			{ source: 'slack', observations: [slackObs('D1', 'ubob')], complete: true, goneReason: 'gone' },
			NOW,
		)
		const id = db.signals.list({}, NOW)[0].id
		assert.equal((await post(`/${id}/slack-mute`, {})).status, 401)
	})
})
