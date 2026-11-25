import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isAllowed, parseAllow, readAgentSendTo } from '../src/cli/slack.js'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { apiRoutes } from '../src/server/routes/api.js'

// `helm slack send` reads its allowlist (signals.slack.agentSendTo) from the running daemon.
// It once read the dashboard-safe GET /api/config, which has no `signals`, so every saved
// target was ignored. These tests serve the real API routes over a real config file, so the
// guard reads exactly what the daemon answers.

const config: HelmConfig = {
	provider: {
		type: 'contember',
		apiBaseUrl: 'https://example.test',
		projectSlug: 'helm',
		apiToken: 'token',
		statuses: ['new'],
	},
	projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
	polling: { intervalSeconds: 60 },
	solver: {
		type: 'default',
		agent: 'claude',
		workspace: 'worktree',
		modelGuidance: {},
		concurrency: 2,
		loopConcurrency: 1,
		timeoutMinutes: 30,
		branchNaming: { enabled: false },
		displayName: { enabled: false },
		triage: { enabled: false },
	},
	spawner: { name: 'default' },
	server: { port: 7474, host: 'localhost' },
	github: {
		issues: false,
		createPrs: false,
		postComments: true,
		prPrefix: '[Helm]',
		trackDeployments: false,
		deployPollSeconds: 120,
	},
	scheduledRuns: { enabled: false, systemTargetsEnabled: false },
}

/** A fetch that answers from the real API routes, with `raw` written as the config file. */
async function withDaemon(raw: unknown, fn: (fetch: typeof globalThis.fetch) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), 'helm-slack-allow-'))
	const db = new DB(join(dir, 'helm.db'))
	const configPath = join(dir, 'helm.config.json')
	writeFileSync(configPath, JSON.stringify(raw, null, '\t'), 'utf-8')
	const api = apiRoutes({
		config,
		configPath,
		db,
		queue: {} as never,
		poller: {} as never,
		provider: {} as never,
		spawner: {} as never,
		enricher: { enqueue() {} } as never,
	})
	const fetch = (async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		assert.equal(url.origin, 'http://localhost:7474')
		assert.ok(url.pathname.startsWith('/api/'), url.pathname)
		return api.request(url.pathname.slice('/api'.length))
	}) as typeof globalThis.fetch
	try {
		await fn(fetch)
	} finally {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	}
}

test('the send guard reads agentSendTo saved in the daemon config', async () => {
	const raw = { ...config, signals: { slack: { agentSendTo: 'C0B4QNLFVQS\n@bob' } } }
	await withDaemon(raw, async fetch => {
		const value = await readAgentSendTo('http://localhost:7474', { fetch })
		assert.equal(value, 'C0B4QNLFVQS\n@bob')
		const allow = parseAllow(value)
		assert.equal(isAllowed({ channel: 'C0B4QNLFVQS' }, undefined, allow), true)
		assert.equal(isAllowed({ channel: 'C0OTHER' }, undefined, allow), false)
	})
})

test('no saved allowlist reads as empty (self-only)', async () => {
	await withDaemon(config, async fetch => {
		assert.deepEqual(parseAllow(await readAgentSendTo('http://localhost:7474', { fetch })), [])
	})
})

test('an unreachable or failing daemon reads as no allowlist', async () => {
	const down = (async () => {
		throw new Error('ECONNREFUSED')
	}) as typeof globalThis.fetch
	assert.equal(await readAgentSendTo('http://localhost:7474', { fetch: down }), undefined)

	const failing = (async () =>
		new Response(JSON.stringify({ error: 'Failed to read config file' }), {
			status: 500,
		})) as typeof globalThis.fetch
	assert.equal(await readAgentSendTo('http://localhost:7474', { fetch: failing }), undefined)

	const odd = (async () =>
		new Response(JSON.stringify({ data: { config: { signals: { slack: { agentSendTo: ['*'] } } } } }), {
			status: 200,
		})) as typeof globalThis.fetch
	assert.equal(await readAgentSendTo('http://localhost:7474', { fetch: odd }), undefined)
})
