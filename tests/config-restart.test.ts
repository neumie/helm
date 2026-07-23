import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Hono } from 'hono'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import type { DaemonControl } from '../src/server/restart.js'
import { apiRoutes } from '../src/server/routes/api.js'

// Config saves apply themselves: PUT /api/config schedules a clean daemon exit
// (launchd KeepAlive respawns with fresh config) when that's safe — queue idle
// AND launchd-managed — and POST /api/daemon/restart triggers the deferred
// restart under the same guards. These tests prove the decision logic through
// an injected DaemonControl so the exit path never kills the test runner.

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
		timeoutMinutes: 30,
		branchNaming: { enabled: false },
		displayName: { enabled: false },
		triage: { enabled: false },
	},
	spawner: { name: 'default' },
	server: { port: 7474, host: 'localhost' },
	github: {
		createPrs: false,
		postComments: true,
		prPrefix: '[Helm]',
		trackDeployments: false,
		deployPollSeconds: 120,
	},
}

const poller = { pollOnce: async () => undefined }
const provider = {
	name: 'fake',
	pollNewTasks: async () => [],
	getTaskContext: async () => null,
	resolveTaskSummary: async () => null,
	postComment: async () => undefined,
}
const spawner = {
	name: 'fake',
	startPlanningSession: async () => {
		throw new Error('not implemented')
	},
}
const fakeEnricher = { enqueue() {} }

function queueWithActive(active: number) {
	return {
		getStatus: () => ({ paused: false, pending: 0, active, maxConcurrency: 2, activeTasks: [] }),
		wake: () => undefined,
		quiesce: () => active === 0,
		unquiesce: () => undefined,
		isQuiescing: () => false,
	}
}

interface Ctx {
	api: Hono
	configPath: string
	exitCount: () => number
}

function withApi(opts: { active: number; managed: boolean }, fn: (ctx: Ctx) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), 'helm-config-restart-'))
	const db = new DB(join(dir, 'helm.db'))
	const configPath = join(dir, 'helm.config.json')
	writeFileSync(configPath, JSON.stringify(config, null, '\t'), 'utf-8')
	let exits = 0
	const control: DaemonControl = {
		isManaged: () => opts.managed,
		exit: () => {
			exits += 1
		},
		restartDelayMs: 0,
	}
	const api = apiRoutes(
		config,
		configPath,
		db,
		queueWithActive(opts.active) as never,
		poller as never,
		provider as never,
		spawner as never,
		fakeEnricher as never,
		undefined,
		undefined,
		control,
	)
	return fn({ api, configPath, exitCount: () => exits }).finally(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})
}

function readPollingConfig(path: string): { polling: { intervalSeconds: number } } {
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as { polling: { intervalSeconds: number } }
	} catch (err) {
		assert.fail(`Could not parse test config: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/** PUT the on-disk config back with one observable change. */
async function putConfig(ctx: Ctx) {
	const body = readPollingConfig(ctx.configPath)
	body.polling.intervalSeconds = 120
	return ctx.api.request('/config', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

type SaveBody = { data: { message: string; applied: boolean; pendingRuns?: number } }

test('config save while idle under launchd applies itself via a scheduled exit', async () => {
	await withApi({ active: 0, managed: true }, async ctx => {
		const res = await putConfig(ctx)
		assert.equal(res.status, 200)
		const body = (await res.json()) as SaveBody
		assert.equal(body.data.applied, true)
		assert.equal(body.data.message, 'Saved — restarting to apply…')
		assert.equal(body.data.pendingRuns, undefined)
		// The save hit disk before the restart was scheduled.
		const saved = readPollingConfig(ctx.configPath)
		assert.equal(saved.polling.intervalSeconds, 120)
		// Exit is scheduled AFTER the response (injected delay 0) — prove it fires.
		assert.equal(ctx.exitCount(), 0)
		await sleep(20)
		assert.equal(ctx.exitCount(), 1)
	})
})

test('config save while runs are active defers with the run count and never exits', async () => {
	await withApi({ active: 2, managed: true }, async ctx => {
		const res = await putConfig(ctx)
		assert.equal(res.status, 200)
		const body = (await res.json()) as SaveBody
		assert.equal(body.data.applied, false)
		assert.equal(body.data.pendingRuns, 2)
		assert.equal(body.data.message, 'Saved. Restart the daemon to apply — 2 runs active.')
		// Still written to disk — only the apply is deferred.
		const saved = readPollingConfig(ctx.configPath)
		assert.equal(saved.polling.intervalSeconds, 120)
		await sleep(20)
		assert.equal(ctx.exitCount(), 0)
	})
})

test('config save outside launchd defers and never exits the dev process', async () => {
	await withApi({ active: 0, managed: false }, async ctx => {
		const res = await putConfig(ctx)
		assert.equal(res.status, 200)
		const body = (await res.json()) as SaveBody
		assert.equal(body.data.applied, false)
		assert.equal(body.data.pendingRuns, undefined)
		assert.equal(body.data.message, 'Saved. Restart the daemon to apply.')
		await sleep(20)
		assert.equal(ctx.exitCount(), 0)
	})
})

test('POST /daemon/restart returns 409 with the count while runs are active', async () => {
	await withApi({ active: 1, managed: true }, async ctx => {
		const res = await ctx.api.request('/daemon/restart', { method: 'POST' })
		assert.equal(res.status, 409)
		const body = (await res.json()) as { error: string; pendingRuns: number }
		assert.equal(body.error, '1 run active — wait for it to finish.')
		assert.equal(body.pendingRuns, 1)
		await sleep(20)
		assert.equal(ctx.exitCount(), 0)
	})
})

test('POST /daemon/restart returns 400 outside launchd', async () => {
	await withApi({ active: 0, managed: false }, async ctx => {
		const res = await ctx.api.request('/daemon/restart', { method: 'POST' })
		assert.equal(res.status, 400)
		const body = (await res.json()) as { error: string }
		assert.match(body.error, /launchd/)
		await sleep(20)
		assert.equal(ctx.exitCount(), 0)
	})
})

test('POST /daemon/restart restarts an idle launchd-managed daemon', async () => {
	await withApi({ active: 0, managed: true }, async ctx => {
		const res = await ctx.api.request('/daemon/restart', { method: 'POST' })
		assert.equal(res.status, 200)
		const body = (await res.json()) as { data: { message: string; applied: boolean } }
		assert.equal(body.data.applied, true)
		assert.equal(body.data.message, 'Restarting…')
		await sleep(20)
		assert.equal(ctx.exitCount(), 1)
	})
})
