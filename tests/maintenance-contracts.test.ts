import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import helmBridgeModule from '../app/src/helm-bridge.ts'
import { configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { toDashboardItem } from '../src/items/contract.js'
import { AlmanacLoopRunner } from '../src/queue/loop-runner.js'
import { assertAgentBudget, createAgentAdapter } from '../src/solver/agent-adapter.js'

const { HelmBridge } = helmBridgeModule
const config = configSchema.parse({
	provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'fixture', apiToken: 'fixture' },
	projects: [{ slug: 'fixture', repoPath: '/unused', baseBranch: 'main' }],
})

test('Claude print mode enforces the exact dollar budget, not a turn-count proxy', () => {
	const adapter = createAgentAdapter({ ...config.solver, maxBudgetUsd: 1.25 })
	const args = adapter.buildHeadlessInvocation().args
	assert.equal(args[args.indexOf('--max-budget-usd') + 1], '1.25')
	assert.equal(args.includes('--max-turns'), false)
	assert.throws(() => adapter.buildInteractiveInvocation(), /only.*Claude print-mode/)
	assert.throws(() => adapter.buildInteractiveCommand('prompt', '/unused'), /only.*Claude print-mode/)
	for (const agent of ['codex', 'pi'] as const)
		assert.throws(() => createAgentAdapter({ ...config.solver, agent, maxBudgetUsd: 1.25 }), /only.*Claude print-mode/)
	for (const maxBudgetUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
		assert.throws(() => createAgentAdapter({ ...config.solver, maxBudgetUsd }), /positive finite/)
	assert.doesNotThrow(() => assertAgentBudget(config.solver, 'loop'))
})

test('loop budget refusal happens before filesystem or process effects', async () => {
	await assert.rejects(
		new AlmanacLoopRunner().runLoop({
			projectConfig: config.projects[0],
			solverConfig: { ...config.solver, maxBudgetUsd: 1 },
			itemId: 'fixture',
			itemTitle: 'fixture',
			payload: { kind: 'loop', prdPath: 'prd.md' },
			worktreePath: '/unused',
			branchName: 'fixture',
			planDirName: 'fixture',
			outputLogPath: '/unused/log',
			onRunId: () => assert.fail('No process admission'),
		}),
		/only.*Claude print-mode/,
	)
})

test('branchless Main planning keeps the authoritative artifact identity', () => {
	const root = mkdtempSync('/tmp/hm-dto-')
	const db = new DB(join(root, 'test.db'))
	try {
		const commands = new ItemCommands(db.items, config)
		const item = commands.createSolveItem({ title: 'Main plan', projectSlug: 'fixture' })
		commands.beginPlanning(item.id)
		commands.recordPlanPrepared(item.id, {
			worktreePath: '/unused',
			branchName: null,
			planDirName: 'fixture',
			spawner: 'default',
		})
		const prepared = commands.getItem(item.id)
		assert.ok(prepared)
		const plan = toDashboardItem(prepared).plan
		assert.equal(plan?.branchName, null)
		assert.equal(plan?.worktreePath, '/unused')
		assert.equal(plan?.planDirName, 'fixture')
	} finally {
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

for (const evidence of [true, false, 'true', 1, null]) {
	test(`bridge preserves only strict planning uncertainty: ${JSON.stringify(evidence)}`, async () => {
		const server = createServer((_req, res) => {
			res.writeHead(503, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ error: 'Request aborted', sessionMayExist: evidence, secret: 'not projected' }))
		})
		await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
		try {
			const address = server.address()
			assert.ok(address && typeof address !== 'string')
			const bridge = new HelmBridge(`http://127.0.0.1:${address.port}`)
			// Exercise the real HTTP decoder without Electron IPC or a live daemon.
			const request = Reflect.get(bridge, 'request')
			const result = await request.call(bridge, 'POST', '/items/fixture/plan', {})
			assert.deepEqual(result, {
				error: 'Request aborted',
				status: 503,
				...(evidence === true ? { sessionMayExist: true } : {}),
			})
		} finally {
			await new Promise<void>((done, reject) => server.close(error => (error ? reject(error) : done())))
		}
	})
}
