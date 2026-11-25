import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import type { OkenaClient, OkenaLayoutNode } from '../src/extensions/okena/client.js'
import { openItemInOkena } from '../src/extensions/okena/item-opener.js'
import { OkenaSolver } from '../src/extensions/okena/solver.js'
import { OkenaSpawner } from '../src/extensions/okena/spawner.js'
import {
	PLAN_TERMINAL_MARK,
	TERMINAL_NAME_MAX_CHARS,
	okenaTerminalName,
	shortName,
} from '../src/extensions/okena/terminal-name.js'
import { OkenaWorktreeManager } from '../src/extensions/okena/worktree.js'
import { ItemCommands } from '../src/items/commands.js'
import type { ItemOkenaTerminals } from '../src/items/okena-terminals.js'
import type { PlanningSessionParams } from '../src/spawner/spawner.js'

const config = configSchema.parse({
	provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'token' },
	projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
	solver: { type: 'okena', agent: 'claude' },
})

function withDb(fn: (db: DB) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'helm-okena-terminals-'))
	const db = new DB(join(dir, 'helm.db'), 'work')
	return Promise.resolve(fn(db)).finally(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})
}

function createItem(db: DB, title = 'Inventura úpravy skladu a reklamací'): string {
	return new ItemCommands(db.items, config).createSolveItem({ title, projectSlug: 'helm', prompt: title }).id
}

/**
 * A stand-in for one Okena daemon: one worktree project whose layout is a flat
 * split of panes. Renames, closes and splits mutate it like Okena would.
 */
class FakeOkena {
	panes: string[] = []
	names: Record<string, string> = {}
	readonly actions: Record<string, unknown>[] = []
	readonly commands: Array<{ terminalId: string; command: string }> = []
	private next = 1

	constructor(
		readonly projectId: string,
		readonly path: string,
		private readonly okenaProfile: string | null = 'okena-default',
	) {}

	newPane(name?: string): string {
		const id = `terminal-${this.next++}`
		this.panes.push(id)
		if (name !== undefined) this.names[id] = name
		return id
	}

	/** The user closes a pane in Okena; Okena keeps a stale name, like it keeps hook terminals. */
	closeInOkena(id: string): void {
		this.panes = this.panes.filter(pane => pane !== id)
	}

	get client(): OkenaClient {
		const layout = (): OkenaLayoutNode => ({
			type: 'split',
			children: this.panes.map(id => ({ type: 'terminal' as const, terminal_id: id })),
		})
		return {
			activeProfileId: () => this.okenaProfile,
			isAvailable: async () => true,
			getState: async () => ({
				projects: [
					{ id: 'parent', name: 'helm', path: '/repo' },
					{
						id: this.projectId,
						name: 'wt',
						path: this.path,
						layout: layout(),
						terminal_names: { ...this.names },
						worktree_info: { parent_project_id: 'parent' },
					},
				],
			}),
			action: async (payload: Record<string, unknown>) => {
				this.actions.push(payload)
				if (payload.action === 'rename_terminal') this.names[payload.terminal_id as string] = payload.name as string
				if (payload.action === 'close_terminal') this.closeInOkena(payload.terminal_id as string)
				if (payload.action === 'split_terminal' || payload.action === 'create_terminal') {
					return { terminal_ids: [this.newPane()] }
				}
				if (payload.action === 'read_content') return { content: '' }
				return {}
			},
			runCommand: async (terminalId: string, command: string) => {
				this.commands.push({ terminalId, command })
			},
		} as unknown as OkenaClient
	}
}

function planParams(
	okena: FakeOkena,
	itemId: string,
	okenaTerminals: ItemOkenaTerminals,
	extra: Partial<PlanningSessionParams> = {},
): PlanningSessionParams {
	return {
		projectConfig: config.projects[0],
		itemId,
		branchName: 'feat/inventura',
		planDirName: '2026-11-09-inventura',
		taskTitle: 'Inventura úpravy skladu a reklamací',
		canonicalContext: { title: 'Inventura' },
		onWorktreeReady: () => ({ title: 'Inventura' }),
		solverConfig: config.solver,
		existingWorktreePath: okena.path,
		okenaTerminals,
		...extra,
	}
}

function spawnerFor(okena: FakeOkena): OkenaSpawner {
	const client = okena.client
	const finder = new OkenaWorktreeManager(client)
	const worktrees = {
		ensureWorktreeProject: async () => ({
			wtProjectId: okena.projectId,
			worktreePath: okena.path,
			autoTerminalId: null,
		}),
		findPlanTerminal: finder.findPlanTerminal.bind(finder),
		createTerminal: finder.createTerminal.bind(finder),
	} as unknown as OkenaWorktreeManager
	return new OkenaSpawner(client, worktrees)
}

function tempWorktree(): string {
	return mkdtempSync(join(tmpdir(), 'helm-okena-own-wt-'))
}

test('short terminal names: 1–4 words, ≤24 code points, ids and tags dropped, task language kept', () => {
	assert.equal(shortName('Inventura úpravy skladu a reklamací'), 'Inventura úpravy skladu')
	assert.equal(shortName('[Echo] #123 Fix login redirect on Safari'), 'Fix login redirect on')
	assert.equal(shortName('PSY-42: Opravit export faktur do Pohody'), 'Opravit export faktur do')
	assert.equal(shortName('Signals: mail filtr'), 'Signals: mail filtr')
	assert.equal(shortName('Superdlouhéslovokteréseurčitěnevejde'), 'Superdlouhéslovokterése…')
	assert.equal(shortName('  ‮skryté\u0007  '), 'skryté')
	assert.equal(
		okenaTerminalName('Inventura úpravy skladu a reklamací', 'plan'),
		`${PLAN_TERMINAL_MARK} Inventura úpravy`,
	)
	assert.equal(okenaTerminalName('Inventura úpravy skladu a reklamací', 'solve'), 'Inventura úpravy skladu')
	assert.equal(okenaTerminalName('#42', 'solve'), 'Helm task')
	// A display name with nothing left after filtering falls back to the title, not the generic name.
	assert.equal(okenaTerminalName(['#42', 'Opravit export faktur'], 'solve'), 'Opravit export faktur')
	for (const title of ['😀😀😀 emoji title that is quite long', 'a b c d e f', 'Ž'.repeat(80)]) {
		for (const role of ['plan', 'solve'] as const) {
			const name = okenaTerminalName(title, role)
			assert.ok(Array.from(name).length <= TERMINAL_NAME_MAX_CHARS, name)
			assert.ok(name.split(' ').filter(word => word !== PLAN_TERMINAL_MARK).length <= 4, name)
			assert.doesNotMatch(name, /\[helm:|plan:/)
		}
	}
})

test('terminal bindings are profile-isolated and keep createdAt for the same terminal', () =>
	withDb(db => {
		const itemId = createItem(db)
		const work = db.forProfile('work').okenaTerminals.forItem(itemId)
		const other = db.forProfile('other').okenaTerminals.forItem(itemId)

		// Item ids are global; a binding never attaches to another tenant's Item.
		assert.equal(other.record('plan', { okenaProfileId: 'p', projectId: 'project-1', terminalId: 'terminal-x' }), false)
		assert.equal(other.get('plan', 'project-1'), null)

		assert.equal(work.record('plan', { okenaProfileId: 'p', projectId: 'project-1', terminalId: 'terminal-1' }), true)
		const first = work.get('plan', 'project-1')
		assert.equal(first?.terminalId, 'terminal-1')
		assert.equal(other.get('plan', 'project-1'), null)
		assert.deepEqual(other.list(), [])

		assert.equal(work.record('plan', { okenaProfileId: 'p', projectId: 'project-1', terminalId: 'terminal-1' }), true)
		assert.equal(work.get('plan', 'project-1')?.createdAt, first?.createdAt)
		assert.equal(work.record('solve', { okenaProfileId: 'p', projectId: 'project-1', terminalId: 'terminal-2' }), true)
		assert.deepEqual(
			work
				.list()
				.map(binding => binding.role)
				.sort(),
			['plan', 'solve'],
		)
	}))

test('a renamed planning terminal is still reused by its id', () =>
	withDb(async db => {
		const path = tempWorktree()
		try {
			const okena = new FakeOkena('project-wt', path)
			okena.newPane('zsh')
			const itemId = createItem(db)
			const bindings = db.okenaTerminals.forItem(itemId)
			const spawner = spawnerFor(okena)

			await spawner.startPlanningSession(planParams(okena, itemId, bindings))
			const planTerminal = bindings.get('plan', 'project-wt')?.terminalId
			assert.ok(planTerminal)
			assert.equal(okena.names[planTerminal], `${PLAN_TERMINAL_MARK} Inventura úpravy`)
			assert.deepEqual(
				okena.commands.map(run => run.terminalId),
				[planTerminal],
			)

			// The agent gives its terminal a short name of its own.
			okena.names[planTerminal] = 'Inventura plán'
			okena.actions.length = 0
			const second = await spawner.startPlanningSession(planParams(okena, itemId, db.okenaTerminals.forItem(itemId)))

			assert.equal(okena.commands.length, 1, 'no second command into the running agent')
			assert.deepEqual(okena.actions, [], 'no new terminal and no rename of the agent-named terminal')
			assert.equal(okena.names[planTerminal], 'Inventura plán')
			assert.match(second.hint, /existing Claude Code planning session is open/)
		} finally {
			rmSync(path, { recursive: true, force: true })
		}
	}))

test('a planning terminal closed in Okena is not reused, even with a matching legacy name', () =>
	withDb(async db => {
		const path = tempWorktree()
		try {
			const okena = new FakeOkena('project-wt', path)
			okena.newPane('zsh')
			const itemId = createItem(db)
			const spawner = spawnerFor(okena)
			await spawner.startPlanningSession(planParams(okena, itemId, db.okenaTerminals.forItem(itemId)))
			const closed = db.okenaTerminals.forItem(itemId).get('plan', 'project-wt')?.terminalId
			assert.ok(closed)

			okena.closeInOkena(closed)
			// A stale name left behind must not resurrect it or win over the binding.
			okena.names[closed] = `plan: Old [helm:${itemId}]`
			await spawner.startPlanningSession(planParams(okena, itemId, db.okenaTerminals.forItem(itemId)))

			const replacement = db.okenaTerminals.forItem(itemId).get('plan', 'project-wt')?.terminalId
			assert.ok(replacement)
			assert.notEqual(replacement, closed)
			assert.deepEqual(
				okena.commands.map(run => run.terminalId),
				[closed, replacement],
			)
		} finally {
			rmSync(path, { recursive: true, force: true })
		}
	}))

test('a legacy `[helm:<id>]` terminal is adopted once; afterwards its name is never parsed', () =>
	withDb(async db => {
		const path = tempWorktree()
		try {
			const okena = new FakeOkena('project-wt', path)
			const itemId = createItem(db)
			const legacy = okena.newPane(`plan: Inventura úpravy skladu a reklamací [helm:${itemId}]`)
			const spawner = spawnerFor(okena)

			await spawner.startPlanningSession(planParams(okena, itemId, db.okenaTerminals.forItem(itemId)))
			assert.equal(db.okenaTerminals.forItem(itemId).get('plan', 'project-wt')?.terminalId, legacy)
			assert.equal(okena.commands.length, 0, 'the adopted terminal may hold a running agent')
			assert.equal(okena.names[legacy], `${PLAN_TERMINAL_MARK} Inventura úpravy`)

			// Now bound by id: another pane wearing the legacy suffix is ignored, and
			// the adopted pane survives any rename.
			okena.newPane(`plan: impostor [helm:${itemId}]`)
			okena.names[legacy] = 'Cokoli'
			okena.actions.length = 0
			await spawner.startPlanningSession(planParams(okena, itemId, db.okenaTerminals.forItem(itemId)))
			assert.equal(db.okenaTerminals.forItem(itemId).get('plan', 'project-wt')?.terminalId, legacy)
			assert.deepEqual(okena.actions, [])
			assert.equal(okena.commands.length, 0)
		} finally {
			rmSync(path, { recursive: true, force: true })
		}
	}))

test('a legacy suffix belonging to another Item, or a binding from another profile, is not reused', () =>
	withDb(async db => {
		const path = tempWorktree()
		try {
			const okena = new FakeOkena('project-wt', path)
			okena.newPane('zsh')
			const mine = createItem(db)
			const theirs = createItem(db, 'Something else')
			okena.newPane(`plan: Something else [helm:${theirs}]`)
			const spawner = spawnerFor(okena)

			await spawner.startPlanningSession(planParams(okena, mine, db.forProfile('work').okenaTerminals.forItem(mine)))
			const bound = db.forProfile('work').okenaTerminals.forItem(mine).get('plan', 'project-wt')?.terminalId
			assert.ok(bound)
			assert.equal(okena.commands.at(-1)?.terminalId, bound)
			assert.equal(db.okenaTerminals.forItem(theirs).get('plan', 'project-wt'), null)

			// The same Item id seen through another Helm profile has no binding there.
			assert.equal(
				await new OkenaWorktreeManager(okena.client).findPlanTerminal(
					'project-wt',
					db.forProfile('other').okenaTerminals.forItem(mine),
				),
				null,
			)
		} finally {
			rmSync(path, { recursive: true, force: true })
		}
	}))

test('a binding from another Okena profile is not this terminal', () =>
	withDb(async db => {
		const path = tempWorktree()
		try {
			const itemId = createItem(db)
			const okena = new FakeOkena('project-wt', path, 'okena-b')
			const pane = okena.newPane('zsh')
			db.okenaTerminals
				.forItem(itemId)
				.record('plan', { okenaProfileId: 'okena-a', projectId: 'project-wt', terminalId: pane })
			const found = await new OkenaWorktreeManager(okena.client).findPlanTerminal(
				'project-wt',
				db.okenaTerminals.forItem(itemId),
			)
			assert.equal(found, null)
		} finally {
			rmSync(path, { recursive: true, force: true })
		}
	}))

test('the solve path binds its terminal by id with a short name, and Open in Okena focuses it', () =>
	withDb(async db => {
		const path = tempWorktree()
		try {
			const okena = new FakeOkena('project-wt', path)
			const first = okena.newPane('zsh')
			const itemId = createItem(db)
			const bindings = db.okenaTerminals.forItem(itemId)
			const client = okena.client
			const real = new OkenaWorktreeManager(client)
			const worktrees = {
				ensureWorktreeProject: async () => ({ wtProjectId: okena.projectId, worktreePath: path, autoTerminalId: null }),
				createTerminal: real.createTerminal.bind(real),
			} as unknown as OkenaWorktreeManager
			const solving = new OkenaSolver(client, worktrees).solve({
				projectConfig: config.projects[0],
				branchName: 'feat/inventura',
				planDirName: '2026-11-09-inventura',
				resultPath: join(tmpdir(), `helm-run-result-${process.pid}`, 'solver-result.json'),
				canonicalContext: { title: 'Inventura' },
				onWorktreeReady: () => ({ title: 'Inventura' }),
				taskId: itemId,
				taskTitle: 'PSY-12 Inventura úpravy skladu a reklamací',
				taskDisplayName: 'Upravit inventuru skladu',
				okenaTerminals: bindings,
				solverConfig: config.solver,
				workspaceMode: 'worktree',
			})
			// The solve waits for solver-result.json; removing the workspace ends it.
			while (okena.commands.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
			rmSync(path, { recursive: true, force: true })
			await assert.rejects(solving, /workspace disappeared/)

			const solveTerminal = bindings.get('solve', 'project-wt')?.terminalId
			assert.ok(solveTerminal)
			assert.notEqual(solveTerminal, first)
			assert.equal(okena.names[solveTerminal], 'Upravit inventuru skladu')
			assert.equal(okena.commands[0]?.terminalId, solveTerminal)

			// The agent renames it; Open in Okena still focuses that pane, not the first one.
			okena.names[solveTerminal] = 'Inventura'
			okena.actions.length = 0
			mkdirSync(path, { recursive: true })
			const opened = await openItemInOkena(
				{
					projectConfig: config.projects[0],
					workspaceMode: 'worktree',
					baseRef: 'main',
					branchName: 'feat/inventura',
					existingWorktreePath: path,
					okenaTerminals: db.okenaTerminals.forItem(itemId),
				},
				{ client, activateApp: async () => true },
			)
			assert.equal(opened.terminalId, solveTerminal)
			assert.deepEqual(okena.actions, [
				{ action: 'focus_terminal', project_id: 'project-wt', terminal_id: solveTerminal, window: 'main' },
			])

			// Once the solve pane is closed, focus falls back to the first live pane.
			okena.closeInOkena(solveTerminal)
			const fallback = await openItemInOkena(
				{
					projectConfig: config.projects[0],
					workspaceMode: 'worktree',
					baseRef: 'main',
					branchName: 'feat/inventura',
					existingWorktreePath: path,
					okenaTerminals: db.okenaTerminals.forItem(itemId),
				},
				{ client, activateApp: async () => true },
			)
			assert.equal(fallback.terminalId, first)
		} finally {
			rmSync(path, { recursive: true, force: true })
		}
	}))

test('an Item planned in Main and then Worktree keeps both planning terminals, one per Okena project', () =>
	withDb(async db => {
		const path = tempWorktree()
		try {
			const main = new FakeOkena('project-main', path)
			const worktree = new FakeOkena('project-wt', path)
			main.newPane('zsh')
			worktree.newPane('zsh')
			const itemId = createItem(db)
			const bindings = () => db.okenaTerminals.forItem(itemId)

			await spawnerFor(main).startPlanningSession(planParams(main, itemId, bindings()))
			const mainPlan = bindings().get('plan', 'project-main')?.terminalId
			await spawnerFor(worktree).startPlanningSession(planParams(worktree, itemId, bindings()))
			assert.equal(bindings().get('plan', 'project-main')?.terminalId, mainPlan)
			assert.ok(bindings().get('plan', 'project-wt'))

			// Back to Main: the still-live Main planning agent is reused, not duplicated.
			main.actions.length = 0
			await spawnerFor(main).startPlanningSession(planParams(main, itemId, bindings()))
			assert.equal(main.commands.length, 1)
			assert.deepEqual(main.actions, [])
		} finally {
			rmSync(path, { recursive: true, force: true })
		}
	}))

test('Open in Okena adopts a legacy planning pane by id and renames it short', () =>
	withDb(async db => {
		const path = tempWorktree()
		try {
			const okena = new FakeOkena('project-wt', path)
			const first = okena.newPane('zsh')
			const itemId = createItem(db)
			const legacy = okena.newPane(`plan: Inventura úpravy skladu a reklamací [helm:${itemId}]`)
			const opened = await openItemInOkena(
				{
					projectConfig: config.projects[0],
					workspaceMode: 'worktree',
					baseRef: 'main',
					branchName: 'feat/inventura',
					existingWorktreePath: path,
					okenaTerminals: db.okenaTerminals.forItem(itemId),
					taskNames: [null, 'Inventura úpravy skladu a reklamací'],
				},
				{ client: okena.client, activateApp: async () => true },
			)
			assert.notEqual(opened.terminalId, first)
			assert.equal(opened.terminalId, legacy)
			assert.equal(db.okenaTerminals.forItem(itemId).get('plan', 'project-wt')?.terminalId, legacy)
			assert.equal(okena.names[legacy], `${PLAN_TERMINAL_MARK} Inventura úpravy`)
			assert.deepEqual(
				okena.actions.map(action => action.action),
				['rename_terminal', 'focus_terminal'],
			)
		} finally {
			rmSync(path, { recursive: true, force: true })
		}
	}))
