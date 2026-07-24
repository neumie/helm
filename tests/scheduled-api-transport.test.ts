import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import { ResidentLeaseManager, createScopedCapability, hashScopedCapability } from '../src/auth/scoped-capability.js'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ProfileStore } from '../src/profiles/store.js'
import { AttentionAdoptionGrantManager } from '../src/scheduled-runs/adoption-grants.js'
import { ScheduleCommands } from '../src/scheduled-runs/commands.js'
import { scheduledReporterCommand } from '../src/scheduled-runs/reporter-command.js'
import { parseScheduledReporterArgs, reportScheduledRun } from '../src/scheduled-runs/reporter.js'
import { SCHEDULED_REPORT_SUMMARY_MAX_BYTES } from '../src/scheduled-runs/schema.js'
import type { ScheduledRunService } from '../src/scheduled-runs/service.js'
import { apiRoutes } from '../src/server/routes/api.js'

const controlToken = 'a'.repeat(43)
const scheduleInput = {
	name: 'Nightly review',
	enabled: true,
	cron: '0 1 * * *',
	cadenceKind: 'daily',
	timezone: 'UTC',
	definition: {
		prompt: 'Review the repository.',
		target: { kind: 'project', projectSlug: 'helm' },
		agent: 'claude',
		maximumRuntimeMinutes: 120,
	},
}

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
		concurrency: 2,
		timeoutMinutes: 30,
		branchNaming: { enabled: false },
		displayName: { enabled: false },
		triage: { enabled: false },
		modelGuidance: {},
	},
	spawner: { name: 'default' },
	scheduledRuns: { enabled: true, systemTargetsEnabled: false },
	server: { port: 7474, host: 'localhost' },
	github: {
		createPrs: false,
		postComments: false,
		prPrefix: '[Helm]',
		trackDeployments: false,
		deployPollSeconds: 120,
	},
}

function requestHeaders(token = controlToken) {
	return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

function withScheduledApi(
	run: (ctx: {
		api: ReturnType<typeof apiRoutes>
		db: DB
		store: ProfileStore
		leaseClock: { now: number }
		reportCalls: string[]
	}) => Promise<void>,
) {
	const root = mkdtempSync(join(tmpdir(), 'helm-scheduled-api-'))
	const store = new ProfileStore(root, ['helm'])
	const db = new DB(store.activeRuntime().dbPath, () => store.activeProfile().id)
	const configPath = join(root, 'helm.config.json')
	writeFileSync(configPath, JSON.stringify(config), 'utf8')
	const leaseClock = { now: 1_000 }
	const leases = new ResidentLeaseManager(100, () => leaseClock.now)
	const reportCalls: string[] = []
	const adoptionGrants = new AttentionAdoptionGrantManager()
	const service = {
		tick: async () => ({ processed: 0, admitted: 0, skipped: 0 }),
		runNow: async (profileId: string, scheduleId: string) => {
			const run = db.forProfile(profileId).schedules.listRuns(scheduleId, 1)[0]
			if (!run) throw new Error('test run missing')
			return run
		},
		cancel: async (profileId: string, runId: string) => {
			const commands = new ScheduleCommands(db.forProfile(profileId).schedules)
			const run = db.forProfile(profileId).schedules.requireRun(runId)
			return commands.requestCancel(run.id, run.revision)
		},
		report: async (profileId: string, runId: string, status: 'quiet' | 'needs_attention', summary: string) => {
			reportCalls.push(`${profileId}:${runId}:${status}:${summary}`)
			const commands = new ScheduleCommands(db.forProfile(profileId).schedules)
			const current = db.forProfile(profileId).schedules.requireRun(runId)
			return commands.report(runId, current.revision, status, summary)
		},
		reserveAttentionAdoption: async (
			profileId: string,
			runId: string,
			revision: number,
			identity: { adoptionId: string; adopter: string },
		) => {
			const reserved = new ScheduleCommands(db.forProfile(profileId).schedules).reserveAttentionAdoption(
				runId,
				revision,
				identity,
			)
			return {
				run: reserved,
				grant: adoptionGrants.issue({ profileId, runId, revision: reserved.revision, ...identity }),
			}
		},
		attachAttentionDescriptor: async (
			profileId: string,
			runId: string,
			revision: number,
			identity: { adoptionId: string; adopter: string },
			capability: string,
		) => {
			if (!adoptionGrants.redeem({ profileId, runId, revision, ...identity }, capability)) throw new Error('replayed')
			return {
				socketPath: '/private/tmp/helm-sched-test/socket',
				mode: 'attach-existing' as const,
				redraw: 'winch' as const,
			}
		},
		completeAttentionAdoption: (
			profileId: string,
			runId: string,
			revision: number,
			identity: { adoptionId: string; adopter: string },
			ownershipRegistered: true,
		) =>
			new ScheduleCommands(db.forProfile(profileId).schedules).completeAttentionAdoption(
				runId,
				revision,
				identity,
				adoptionGrants,
				ownershipRegistered,
			),
		rollbackAttentionAdoption: (
			profileId: string,
			runId: string,
			revision: number,
			identity: { adoptionId: string; adopter: string },
		) =>
			new ScheduleCommands(db.forProfile(profileId).schedules).rollbackAttentionAdoption(
				runId,
				revision,
				identity,
				'client',
			),
	} as unknown as ScheduledRunService
	const queue = { getStatus: () => ({ active: 0 }), wake() {} }
	const api = apiRoutes(
		config,
		configPath,
		db,
		queue as never,
		{ pollOnce: async () => undefined } as never,
		{
			name: 'fake',
			pollNewTasks: async () => [],
			getTaskContext: async () => null,
			resolveTaskSummary: async () => null,
			postComment: async () => null,
		} as never,
		{ name: 'fake', startPlanningSession: async () => ({}) } as never,
		{ enqueue() {}, backfill() {} } as never,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			store,
			runtime: () => store.activeRuntime(),
			scheduled: { service, controlToken, residentLeases: leases, profileIds: () => store.registeredProfileIds() },
		},
	)
	return run({ api, db, store, leaseClock, reportCalls }).finally(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})
}

test('scheduled control routes authenticate, revision-guard CRUD, and reject disabled system targets', async () => {
	await withScheduledApi(async ({ api, store }) => {
		const profileId = store.activeProfile().id
		assert.equal((await api.request(`/scheduled-runs?profileId=${profileId}`)).status, 401)
		const created = await api.request('/scheduled-runs', {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({ profileId, ...scheduleInput }),
		})
		assert.equal(created.status, 201)
		const schedule = (await created.json()) as { data: { id: string; revision: number } }
		const stale = await api.request(`/scheduled-runs/${schedule.data.id}/disable`, {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({ profileId, revision: schedule.data.revision + 1 }),
		})
		assert.equal(stale.status, 409)
		const disabled = await api.request(`/scheduled-runs/${schedule.data.id}/disable`, {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({ profileId, revision: schedule.data.revision }),
		})
		assert.equal(disabled.status, 200)
		const disabledSchedule = (await disabled.json()) as { data: { id: string; revision: number } }
		const updated = await api.request(`/scheduled-runs/${schedule.data.id}`, {
			method: 'PUT',
			headers: requestHeaders(),
			body: JSON.stringify({
				profileId,
				revision: disabledSchedule.data.revision,
				...scheduleInput,
				name: 'Updated review',
				enabled: false,
			}),
		})
		assert.equal(updated.status, 200)
		const updatedSchedule = (await updated.json()) as { data: { revision: number; name: string } }
		assert.equal(updatedSchedule.data.name, 'Updated review')
		const detail = await api.request(`/scheduled-runs/${schedule.data.id}?profileId=${profileId}`, {
			headers: requestHeaders(),
		})
		assert.equal(detail.status, 200)
		const list = await api.request(`/scheduled-runs?profileId=${profileId}`, { headers: requestHeaders() })
		assert.equal(((await list.json()) as { data: unknown[] }).data.length, 1)
		const history = await api.request(`/scheduled-runs/${schedule.data.id}/history?profileId=${profileId}`, {
			headers: requestHeaders(),
		})
		assert.deepEqual((await history.json()) as { data: unknown[] }, { data: [] })
		const archived = await api.request(`/scheduled-runs/${schedule.data.id}/archive`, {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({ profileId, revision: updatedSchedule.data.revision }),
		})
		assert.equal(archived.status, 200)
		const system = await api.request('/scheduled-runs', {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({
				profileId,
				...scheduleInput,
				name: 'System review',
				definition: {
					...scheduleInput.definition,
					target: { kind: 'system', riskAcknowledgement: 'broad-host-access' },
				},
			}),
		})
		assert.equal(system.status, 400)
	})
})

test('scheduled lease and report capabilities are scoped and extension routes remain control-token free', async () => {
	await withScheduledApi(async ({ api, db, store, leaseClock, reportCalls }) => {
		const profileId = store.activeProfile().id
		const issue = await api.request('/scheduled-runs/lease', { method: 'POST', headers: requestHeaders() })
		assert.equal(issue.status, 200)
		const lease = (await issue.json()) as { data: { capability: string } }
		assert.equal(
			(
				await api.request('/scheduled-runs/lease/tick', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ capability: 'x'.repeat(43) }),
				})
			).status,
			401,
		)
		assert.equal(
			(
				await api.request('/scheduled-runs/lease/tick', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ capability: lease.data.capability }),
				})
			).status,
			200,
		)
		const replacementResponse = await api.request('/scheduled-runs/lease', {
			method: 'POST',
			headers: requestHeaders(),
		})
		const replacement = (await replacementResponse.json()) as { data: { capability: string } }
		for (const [path, capability, expected] of [
			['heartbeat', lease.data.capability, 401],
			['heartbeat', replacement.data.capability, 200],
			['revoke', replacement.data.capability, 200],
			['tick', replacement.data.capability, 401],
		] as const) {
			assert.equal(
				(
					await api.request(`/scheduled-runs/lease/${path}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ capability }),
					})
				).status,
				expected,
			)
		}
		const expiringResponse = await api.request('/scheduled-runs/lease', {
			method: 'POST',
			headers: requestHeaders(),
		})
		const expiring = (await expiringResponse.json()) as { data: { capability: string } }
		leaseClock.now += 100
		assert.equal(
			(
				await api.request('/scheduled-runs/lease/heartbeat', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ capability: expiring.data.capability }),
				})
			).status,
			401,
		)

		const commands = new ScheduleCommands(db.forProfile(profileId).schedules)
		const schedule = commands.create(scheduleInput)
		const capability = createScopedCapability()
		let run = commands.claimOccurrence(schedule.id, schedule.revision, '2030-01-02T01:00:00.000Z', {
			id: 'report-run',
			scheduleId: schedule.id,
			scheduleRevision: schedule.revision,
			scheduledFor: '2030-01-01T01:00:00.000Z',
			localCivilSlot: '2030-01-01 01:00',
			utcOffsetMinutes: 0,
			slotKey: 'report-slot',
			definitionSnapshot: schedule.definition,
			sessionId: 'sr-report',
			reportTokenHash: hashScopedCapability(capability),
		})
		run = commands.beginPreparing(run.id, run.revision)
		run = commands.beginLaunching(run.id, run.revision)
		commands.markRunning(run.id, run.revision)
		assert.equal(
			(
				await api.request('/scheduled-runs/report-run/report', {
					method: 'POST',
					headers: { Authorization: `Bearer ${createScopedCapability()}`, 'Content-Type': 'application/json' },
					body: JSON.stringify({ status: 'needs_attention', summary: 'check deployment' }),
				})
			).status,
			401,
		)
		const reported = await api.request('/scheduled-runs/report-run/report', {
			method: 'POST',
			headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'needs_attention', summary: 'check deployment' }),
		})
		assert.equal(reported.status, 200)
		const reportedBody = (await reported.json()) as { data: Record<string, unknown> }
		for (const sensitive of ['reportTokenHash', 'socketDescriptor', 'processFingerprint', 'cwd', 'runDir']) {
			assert.equal(sensitive in reportedBody.data, false)
		}
		assert.equal(reportCalls.length, 1)
		assert.equal(
			(
				await api.request('/items/source', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ externalId: 'untracked' }),
				})
			).status,
			404,
		)
	})
})

test('scheduled transport enforces strict bodies, UTF-8 report bounds, and unambiguous cross-profile capability scope', async () => {
	await withScheduledApi(async ({ api, db, store, reportCalls }) => {
		const profileIds = [store.activeProfile().id, store.create('Second', ['helm']).id]
		const createRunning = (profileId: string, id: string, reportCapability: string) => {
			const commands = new ScheduleCommands(db.forProfile(profileId).schedules)
			const schedule = commands.create({ ...scheduleInput, name: `Schedule ${profileId} ${id}` })
			let run = commands.claimOccurrence(schedule.id, schedule.revision, null, {
				id,
				scheduleId: schedule.id,
				scheduleRevision: schedule.revision,
				scheduledFor: '2030-01-01T01:00:00.000Z',
				localCivilSlot: `2030-01-01 ${id}`,
				utcOffsetMinutes: 0,
				slotKey: id,
				definitionSnapshot: schedule.definition,
				sessionId: `sr-${id}`,
				reportTokenHash: hashScopedCapability(reportCapability),
			})
			run = commands.beginPreparing(run.id, run.revision)
			run = commands.beginLaunching(run.id, run.revision)
			commands.markRunning(run.id, run.revision)
			return schedule.id
		}
		const workCapability = createScopedCapability()
		const betaCapability = createScopedCapability()
		const workScheduleId = createRunning(profileIds[0], 'work-only', workCapability)
		createRunning(profileIds[1], 'beta-only', betaCapability)
		const crossRun = await api.request('/scheduled-runs/beta-only/report', {
			method: 'POST',
			headers: { Authorization: `Bearer ${workCapability}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'needs_attention', summary: 'wrong run' }),
		})
		assert.equal(crossRun.status, 401)
		assert.equal(reportCalls.length, 0)
		const beta = await api.request('/scheduled-runs/beta-only/report', {
			method: 'POST',
			headers: { Authorization: `Bearer ${betaCapability}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'needs_attention', summary: 'β'.repeat(500) }),
		})
		assert.equal(beta.status, 200)
		assert.equal(reportCalls[0].startsWith(`${profileIds[1]}:beta-only:`), true)

		const tooLarge = await api.request('/scheduled-runs/work-only/report', {
			method: 'POST',
			headers: { Authorization: `Bearer ${workCapability}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'quiet', summary: 'é'.repeat(501) }),
		})
		assert.equal(tooLarge.status, 400)
		const runNow = await api.request(`/scheduled-runs/${workScheduleId}/run`, {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({ profileId: profileIds[0] }),
		})
		assert.equal(runNow.status, 200)
		const cancelled = await api.request('/scheduled-runs/runs/work-only/cancel', {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({ profileId: profileIds[0] }),
		})
		assert.equal(cancelled.status, 200)
		assert.equal(((await cancelled.json()) as { data: { state: string } }).data.state, 'cancel_requested')
		const unknownField = await api.request('/scheduled-runs', {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({ profileId: profileIds[0], ...scheduleInput, unexpected: true }),
		})
		assert.equal(unknownField.status, 400)
		const oversizedBody = JSON.stringify({
			profileId: profileIds[0],
			...scheduleInput,
			name: 'x'.repeat(100_000),
		})
		const oversized = await api.request('/scheduled-runs', {
			method: 'POST',
			headers: { ...requestHeaders(), 'Content-Length': String(Buffer.byteLength(oversizedBody)) },
			body: oversizedBody,
		})
		assert.equal(oversized.status, 413)
	})
})

test('attention adoption transport is control-authenticated, no-store, replay-safe, and redacted outside its descriptor', async () => {
	await withScheduledApi(async ({ api, db, store }) => {
		const profileId = store.activeProfile().id
		const commands = new ScheduleCommands(db.forProfile(profileId).schedules)
		const schedule = commands.create(scheduleInput)
		let run = commands.claimOccurrence(schedule.id, schedule.revision, null, {
			id: 'adoption-api-run',
			scheduleId: schedule.id,
			scheduleRevision: schedule.revision,
			scheduledFor: '2030-01-01T01:00:00.000Z',
			localCivilSlot: '2030-01-01 adoption',
			utcOffsetMinutes: 0,
			slotKey: 'adoption-api',
			definitionSnapshot: schedule.definition,
			sessionId: 'sr-adoption-api',
		})
		run = commands.beginPreparing(run.id, run.revision)
		run = commands.beginLaunching(run.id, run.revision)
		run = commands.markRunning(run.id, run.revision)
		run = commands.report(run.id, run.revision, 'needs_attention', 'choose a target')
		const identity = { adoptionId: crypto.randomUUID(), adopter: crypto.randomUUID() }
		const reservePath = `/scheduled-runs/runs/${run.id}/attention-adoption/reserve`
		assert.equal((await api.request(reservePath, { method: 'POST', body: '{}' })).status, 401)
		const reserve = await api.request(reservePath, {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({ profileId, revision: run.revision, ...identity }),
		})
		assert.equal(reserve.status, 200)
		assert.equal(reserve.headers.get('cache-control'), 'no-store')
		const reserved = (await reserve.json()) as {
			data: Record<string, unknown>
			adoption: { capability: string; expiresAt: number }
		}
		assert.match(reserved.adoption.capability, /^[A-Za-z0-9_-]{43}$/)
		for (const sensitive of ['capability', 'socketPath', 'processFingerprint', 'attentionAdoption'])
			assert.equal(sensitive in reserved.data, false)
		const attachPath = `/scheduled-runs/runs/${run.id}/attention-adoption/attach-descriptor`
		assert.equal(
			(
				await api.request(attachPath, {
					method: 'POST',
					headers: requestHeaders(),
					body: JSON.stringify({
						profileId,
						revision: reserved.data.revision,
						...identity,
						capability: reserved.adoption.capability,
						extra: true,
					}),
				})
			).status,
			400,
		)
		const attached = await api.request(attachPath, {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({
				profileId,
				revision: reserved.data.revision,
				...identity,
				capability: reserved.adoption.capability,
			}),
		})
		assert.equal(attached.status, 200)
		assert.equal(attached.headers.get('cache-control'), 'no-store')
		assert.deepEqual((await attached.json()).data, {
			socketPath: '/private/tmp/helm-sched-test/socket',
			mode: 'attach-existing',
			redraw: 'winch',
		})
		assert.equal(
			(
				await api.request(attachPath, {
					method: 'POST',
					headers: requestHeaders(),
					body: JSON.stringify({
						profileId,
						revision: reserved.data.revision,
						...identity,
						capability: reserved.adoption.capability,
					}),
				})
			).status,
			409,
		)
		const completed = await api.request(`/scheduled-runs/runs/${run.id}/attention-adoption/complete`, {
			method: 'POST',
			headers: requestHeaders(),
			body: JSON.stringify({ profileId, revision: reserved.data.revision, ...identity, ownershipRegistered: true }),
		})
		assert.equal(completed.status, 200)
		const completion = (await completed.json()) as { data: Record<string, unknown> }
		for (const sensitive of ['socketPath', 'capability', 'processFingerprint', 'attentionAdoption'])
			assert.equal(sensitive in completion.data, false)
	})
})

test('scheduled reporter builds only the run-scoped request argv and transport', async () => {
	assert.deepEqual(parseScheduledReporterArgs(['quiet', 'all', 'done']), { status: 'quiet', summary: 'all done' })
	assert.throws(() => parseScheduledReporterArgs(['wrong', 'summary']))
	assert.equal(parseScheduledReporterArgs(['quiet', 'é'.repeat(500)]).summary.length, 500)
	assert.throws(() => parseScheduledReporterArgs(['quiet', 'é'.repeat(501)]), /1-1000 UTF-8 bytes/)
	assert.equal(SCHEDULED_REPORT_SUMMARY_MAX_BYTES, 1000)
	let request: Request | undefined
	await reportScheduledRun(
		{ status: 'needs_attention', summary: 'choose a target' },
		{ daemonUrl: 'http://127.0.0.1:7474', runId: 'run / one', reportCapability: createScopedCapability() },
		async (input, init) => {
			request = input instanceof Request ? new Request(input, init) : new Request(input, init)
			return new Response('{}', { status: 200 })
		},
	)
	assert.equal(request?.url, 'http://127.0.0.1:7474/api/scheduled-runs/run%20%2F%20one/report')
	assert.match(request?.headers.get('authorization') ?? '', /^Bearer [A-Za-z0-9_-]{43}$/)
})

test('scheduled reporter command uses absolute source and dist paths without PATH lookup', () => {
	const source = scheduledReporterCommand(
		new URL('../src/scheduled-runs/reporter-command.ts', import.meta.url).href,
		'/opt/node',
	)
	assert.equal(source.length, 3)
	assert.equal(source[0], '/opt/node')
	assert.match(source[1], /node_modules\/tsx\/dist\/cli\.mjs$/)
	assert.match(source[2], /src\/scheduled-runs\/reporter\.ts$/)
	assert.equal(source.every(isAbsolute), true)

	const dist = scheduledReporterCommand(
		new URL('../dist/scheduled-runs/reporter-command.js', import.meta.url).href,
		'/opt/node',
	)
	assert.deepEqual(dist, ['/opt/node', join(process.cwd(), 'dist/scheduled-runs/reporter.js')])
	assert.equal(dist.every(isAbsolute), true)
})
