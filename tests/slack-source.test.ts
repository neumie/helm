import assert from 'node:assert/strict'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import { createSlackSignalReader } from '../src/signals/slack-source.js'
import type { SlackSession, SlackSessionStore } from '../src/slack/session.js'
import type { SlackClient } from '../src/slack/web-api.js'

const session: SlackSession = {
	teamId: 'T1',
	token: 'xoxc-x',
	cookie: 'xoxd-x',
	name: 'Contember',
	domain: 'cntmbr',
	userId: 'UME',
}

function fakeStore(sessions: SlackSession[]): SlackSessionStore {
	return {
		list: async () => sessions.map(s => s.teamId),
		get: async (id: string) => sessions.find(s => s.teamId === id) ?? null,
		save: async () => undefined,
		remove: async () => undefined,
	} as unknown as SlackSessionStore
}

/** A client whose `call` returns canned responses by method. */
function fakeClient(responses: Record<string, unknown>): SlackClient {
	return {
		call: async (method: string) => responses[method] ?? {},
		rateLimitRemaining: () => 0,
	} as unknown as SlackClient
}

function config() {
	return configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
		projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
		signals: { slack: { enabled: true, threads: false, mentions: false } },
	})
}

test('slack-source: disabled when nothing connected', async () => {
	const reader = createSlackSignalReader(config(), { store: fakeStore([]) })
	const { result, health } = await reader.read(new AbortController().signal)
	assert.equal(result, null)
	assert.equal(health.status, 'disabled')
})

test('slack-source: a foreign unread DM becomes an observation', async () => {
	const ts = `${Math.floor(Date.now() / 1000)}.000100`
	const reader = createSlackSignalReader(config(), {
		store: fakeStore([session]),
		clientFor: () =>
			fakeClient({
				'auth.test': { ok: true, user_id: 'UME', url: 'https://cntmbr.slack.com/' },
				'users.conversations': { channels: [{ id: 'D1', is_im: true, user: 'UBOB', last_read: '1.0' }] },
				'conversations.info': {
					channel: {
						id: 'D1',
						is_im: true,
						user: 'UBOB',
						last_read: '1.0',
						latest: { user: 'UBOB', text: 'ping', ts },
					},
				},
				'users.info': { user: { id: 'UBOB', real_name: 'Bob' } },
			}),
		now: () => new Date(),
	})
	const { result, health } = await reader.read(new AbortController().signal)
	assert.equal(health.status, 'ok')
	assert.equal(result?.source, 'slack')
	assert.equal(result?.observations.length, 1)
	assert.equal(result?.observations[0].kind, 'dm')
	assert.equal(result?.observations[0].actor, 'Bob')
	assert.equal(result?.complete, true)
})

test('slack-source: auth error maps to needs_permission', async () => {
	const reader = createSlackSignalReader(config(), {
		store: fakeStore([session]),
		clientFor: () =>
			({
				call: async () => {
					const { SlackApiError } = await import('../src/slack/web-api.js')
					throw new SlackApiError('invalid_auth', 'auth.test')
				},
				rateLimitRemaining: () => 0,
			}) as unknown as SlackClient,
	})
	const { health } = await reader.read(new AbortController().signal)
	assert.equal(health.status, 'needs_permission')
})
