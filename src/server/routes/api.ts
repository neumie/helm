import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { buildConfigDocument, parseConfigUpdate, parseConfigWithFallback } from '../../config-document.js'
import type { VigilConfig } from '../../config.js'
import type { DB } from '../../db/client.js'
import { manualStatusSchema } from '../../db/task-schema.js'
import type { TaskRecord } from '../../db/task-schema.js'
import { ItemCommands } from '../../items/commands.js'
import { buildItemTaskContext } from '../../items/context.js'
import { toDashboardItemWithSiblings, toDashboardItems } from '../../items/contract.js'
import { resolveItemWorkspace } from '../../items/identity.js'
import { ensureItemWorkspaceName } from '../../items/naming.js'
import { observeItemRun } from '../../items/observation.js'
import { itemStatusSchema } from '../../items/schema.js'
import type { ItemRecord } from '../../items/schema.js'
import { resolveTaskWorkspace } from '../../plan/identity.js'
import { PlanWorkspace } from '../../plan/workspace.js'
import type { Poller } from '../../poller/poller.js'
import type { TaskContext, TaskProvider } from '../../providers/provider.js'
import type { Drainer } from '../../queue/drainer.js'
import { solverAgentSchema } from '../../solver/agent.js'
import type { SolverAgent } from '../../solver/agent.js'
import { createSpawner, listSpawnerAdapters, spawnerNameSchema } from '../../spawner/registry.js'
import type { SpawnerName } from '../../spawner/registry.js'
import type { Spawner } from '../../spawner/spawner.js'
import { isCancellation } from '../../util/errors.js'

/** Read a task's log file from `offset`. cwd is the daemon's startup dir (it
 *  never chdirs), so `logs/` resolves correctly. Returns empty on any error. */
function readLogTail(taskId: string, offset: number): { content: string; offset: number } {
	const logPath = resolve(process.cwd(), 'logs', `${taskId}.log`)
	try {
		const fd = openSync(logPath, 'r')
		try {
			const size = fstatSync(fd).size
			if (offset >= size) return { content: '', offset: size }
			const buf = Buffer.alloc(size - offset)
			readSync(fd, buf, 0, buf.length, offset)
			return { content: buf.toString('utf-8'), offset: size }
		} finally {
			closeSync(fd)
		}
	} catch {
		return { content: '', offset: 0 }
	}
}

/** The README the user lands on in a freshly-prepared plan worktree. */
function buildTaskPlanReadmeBody(task: TaskRecord, branchName: string, planDirName: string): string {
	return [
		`# ${task.title}`,
		'',
		`**Status:** ${task.status}`,
		`**Branch:** ${branchName}`,
		`**Task ID:** ${task.externalId}`,
		'',
		'## Plan this task',
		'',
		'A planning agent has been started in this worktree. Tell it what you want to do, or invoke one of:',
		'',
		`- \`/grill-me ${planDirName}\` — stress-test decisions interactively. Writes \`brief.md\`.`,
		`- \`/grill-plan ${planDirName}\` — challenge the plan against the domain model.`,
		'- `/prd-create` — once you have a brief, synthesize into `prd.md`.',
		'',
		'Anything committed under this directory is loaded into the autonomous solver prompt when the task runs.',
		'',
	].join('\n')
}

function buildItemPlanReadmeBody(item: ItemRecord, branchName: string, planDirName: string): string {
	return [
		`# ${item.title}`,
		'',
		`**Kind:** ${item.kind}`,
		`**Status:** ${item.status}`,
		`**BaseRef:** ${item.baseRef}`,
		`**Branch:** ${branchName}`,
		`**Item ID:** ${item.id}`,
		'',
		'## Plan this Item',
		'',
		'Planning agent started in this worktree. Tell it what you want to do, or invoke one of:',
		'',
		`- \`/grill-me ${planDirName}\` — stress-test decisions interactively. Writes \`brief.md\`.`,
		`- \`/grill-plan ${planDirName}\` — challenge the plan against the domain model.`,
		'- `/prd-create` — once you have a brief, synthesize into `prd.md`.',
		'',
		'Anything committed under this directory is loaded into the autonomous run when the Item executes.',
		'',
	].join('\n')
}

export function apiRoutes(
	config: VigilConfig,
	configPath: string,
	db: DB,
	queue: Drainer,
	poller: Poller,
	provider: TaskProvider,
	spawner: Spawner,
	createPlanningSpawner: (config: VigilConfig, name: SpawnerName) => Promise<Spawner> = createSpawner,
) {
	const api = new Hono()
	const itemCommands = new ItemCommands(db.items, config)
	const dashboardItem = (item: ItemRecord) =>
		toDashboardItemWithSiblings(
			item,
			item.groupId ? itemCommands.listGroupItems(item.groupId) : [],
			observeItemRun(item, { store: db.items }),
		)
	const expandGroupedItems = (items: ItemRecord[]) => {
		const expanded: ItemRecord[] = []
		const seenItems = new Set<string>()
		const seenGroups = new Set<string>()
		const append = (item: ItemRecord) => {
			if (seenItems.has(item.id)) return
			seenItems.add(item.id)
			expanded.push(item)
		}

		for (const item of items) {
			if (seenItems.has(item.id)) continue
			if (item.groupId && !seenGroups.has(item.groupId)) {
				seenGroups.add(item.groupId)
				const siblings = itemCommands.listGroupItems(item.groupId)
				for (const sibling of siblings.length > 1 ? siblings : [item]) append(sibling)
				continue
			}
			append(item)
		}
		return expanded
	}
	const dashboardItems = (items: ItemRecord[]) =>
		toDashboardItems(expandGroupedItems(items), item => observeItemRun(item, { store: db.items }))

	async function readSolverAgent(
		bodyPromise: Promise<{ solverAgent?: unknown }>,
	): Promise<SolverAgent | null | undefined> {
		const body = (await bodyPromise.catch(() => ({}))) as { solverAgent?: unknown }
		if (body.solverAgent === undefined || body.solverAgent === null) return undefined
		const parsed = solverAgentSchema.safeParse(body.solverAgent)
		return parsed.success ? parsed.data : null
	}

	function recordSelectedSolveAgent(item: ItemRecord, solverAgent: SolverAgent | undefined): ItemRecord {
		if (!solverAgent || item.kind !== 'solve') return item
		return itemCommands.setSolveItemAgent(item.id, solverAgent)
	}

	async function planningSpawnerForItem(item: ItemRecord): Promise<Spawner> {
		if (!item.spawner || item.spawner === spawner.name) return spawner
		const parsed = spawnerNameSchema.safeParse(item.spawner)
		if (!parsed.success) throw new Error(`Invalid Item spawner: ${item.spawner}`)
		return createPlanningSpawner(config, parsed.data)
	}

	function spawnerInstalled(name: string): boolean {
		return listSpawnerAdapters().some(adapter => adapter.available && adapter.name === name)
	}

	// Daemon status
	api.get('/status', c => {
		const queueStatus = queue.getStatus()
		return c.json({
			data: {
				uptime: process.uptime(),
				queue: queueStatus,
				projects: config.projects.map(p => p.slug),
				pollInterval: config.polling.intervalSeconds,
			},
		})
	})

	// Minimal Item dashboard contract. This is the new AFK read/write path;
	// legacy Task routes below remain during the transition.
	api.get('/items', c => {
		const status = c.req.query('status')
		const parsedStatus = status ? itemStatusSchema.safeParse(status) : null
		if (status && !parsedStatus?.success) {
			return c.json({ error: `Invalid status. Must be one of: ${itemStatusSchema.options.join(', ')}` }, 400)
		}
		const items = itemCommands.listItems({
			status: parsedStatus?.success ? parsedStatus.data : undefined,
			projectSlug: c.req.query('project') || undefined,
			limit: Number(c.req.query('limit') ?? 50),
			offset: Number(c.req.query('offset') ?? 0),
		})
		return c.json({ data: dashboardItems(items) })
	})

	api.get('/items/by-source/:externalId', c => {
		const item = itemCommands.getItemBySourceExternalId(c.req.param('externalId'))
		return c.json({ data: item ? dashboardItem(item) : null })
	})

	api.post('/items/source', async c => {
		const body = await c.req.json()
		const parsed = z
			.object({
				externalId: z.string().min(1),
			})
			.strict()
			.safeParse(body)
		if (!parsed.success) {
			const hasSolverAgent = typeof body === 'object' && body !== null && 'solverAgent' in body
			return c.json(
				{
					error: hasSolverAgent
						? 'solverAgent is only accepted by planning and Item action routes'
						: 'Missing or invalid externalId',
				},
				400,
			)
		}

		const existing = itemCommands.getItemBySourceExternalId(parsed.data.externalId)
		if (existing) return c.json({ data: dashboardItem(existing) })

		const summary = await provider.resolveTaskSummary(parsed.data.externalId)
		if (!summary) return c.json({ error: `Task ${parsed.data.externalId} not found in ${provider.name}` }, 404)
		if (!config.projects.some(p => p.slug === summary.projectSlug)) {
			return c.json({ error: `Project '${summary.projectSlug}' is not configured in vigil.config.json` }, 400)
		}

		const item = itemCommands.createSolveItem({
			projectSlug: summary.projectSlug,
			title: summary.title,
			prompt: summary.title,
			source: {
				provider: provider.name,
				externalId: parsed.data.externalId,
				url: config.provider.taskBaseUrl ? `${config.provider.taskBaseUrl}${parsed.data.externalId}` : undefined,
			},
		})
		return c.json({ data: dashboardItem(item) }, 201)
	})

	api.get('/items/:id', c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		return c.json({ data: dashboardItem(item) })
	})

	api.post('/items', async c => {
		const body = await c.req.json()
		const createIntentSchema = z.enum(['queue', 'plan'])
		const parsed = z
			.discriminatedUnion('kind', [
				z
					.object({
						kind: z.literal('solve'),
						title: z.string().min(1),
						projectSlug: z.string().min(1),
						prompt: z.string().min(1),
						baseRef: z.string().min(1).optional(),
						baseItemId: z.string().min(1).optional(),
						spawner: spawnerNameSchema.optional(),
						parallelism: z.number().int().positive().optional(),
						intent: createIntentSchema.optional(),
					})
					.strict(),
				z
					.object({
						kind: z.literal('ralph'),
						title: z.string().min(1),
						projectSlug: z.string().min(1),
						prdPath: z.string().min(1),
						baseRef: z.string().min(1).optional(),
						baseItemId: z.string().min(1).optional(),
						spawner: spawnerNameSchema.optional(),
						mode: z.enum(['once', 'afk']).optional(),
						provider: z.enum(['claude', 'codex']).optional(),
						model: z.string().min(1).optional(),
						effort: z.string().min(1).optional(),
						iterations: z.number().int().positive().optional(),
						noOversee: z.boolean().optional(),
						parallelism: z.number().int().positive().optional(),
						intent: createIntentSchema.optional(),
					})
					.strict(),
				z
					.object({
						kind: z.literal('harden'),
						title: z.string().min(1),
						projectSlug: z.string().min(1),
						target: z.string().min(1),
						baseRef: z.string().min(1).optional(),
						baseItemId: z.string().min(1).optional(),
						spawner: spawnerNameSchema.optional(),
						rounds: z.number().int().positive().optional(),
						parallelism: z.number().int().positive().optional(),
						intent: createIntentSchema.optional(),
					})
					.strict(),
			])
			.safeParse(body)
		if (!parsed.success) return c.json({ error: 'Only valid solve, ralph, or harden Item creation is supported' }, 400)
		if (parsed.data.spawner && !spawnerInstalled(parsed.data.spawner)) {
			return c.json({ error: `Spawner adapter not installed: ${parsed.data.spawner}` }, 400)
		}
		try {
			const items = (() => {
				switch (parsed.data.kind) {
					case 'solve':
						return itemCommands.createSolveItems({
							title: parsed.data.title,
							projectSlug: parsed.data.projectSlug,
							prompt: parsed.data.prompt,
							baseRef: parsed.data.baseRef,
							baseItemId: parsed.data.baseItemId,
							spawner: parsed.data.spawner,
							initialStatus: parsed.data.intent === 'plan' ? 'planned' : undefined,
							parallelism: parsed.data.parallelism,
						})
					case 'ralph':
						return itemCommands.createRalphItems({
							title: parsed.data.title,
							projectSlug: parsed.data.projectSlug,
							prdPath: parsed.data.prdPath,
							baseRef: parsed.data.baseRef,
							baseItemId: parsed.data.baseItemId,
							spawner: parsed.data.spawner,
							mode: parsed.data.mode,
							provider: parsed.data.provider,
							model: parsed.data.model,
							effort: parsed.data.effort,
							iterations: parsed.data.iterations,
							noOversee: parsed.data.noOversee,
							initialStatus: parsed.data.intent === 'plan' ? 'planned' : undefined,
							parallelism: parsed.data.parallelism,
						})
					case 'harden':
						return itemCommands.createHardenItems({
							title: parsed.data.title,
							projectSlug: parsed.data.projectSlug,
							target: parsed.data.target,
							baseRef: parsed.data.baseRef,
							baseItemId: parsed.data.baseItemId,
							spawner: parsed.data.spawner,
							rounds: parsed.data.rounds,
							initialStatus: parsed.data.intent === 'plan' ? 'planned' : undefined,
							parallelism: parsed.data.parallelism,
						})
				}
			})()
			if (items.some(item => item.status === 'queued')) queue.wake()
			return c.json({ data: items.length === 1 ? dashboardItem(items[0]) : dashboardItems(items) }, 201)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, 400)
		}
	})

	api.post('/items/:id/approve', async c => {
		const solverAgent = await readSolverAgent(c.req.json<{ solverAgent?: unknown }>())
		if (solverAgent === null) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		const current = itemCommands.getItem(c.req.param('id'))
		if (!current) return c.json({ error: 'Item not found' }, 404)
		if (current.status !== 'unverified') return c.json({ error: 'Only unverified Items can be approved' }, 400)
		try {
			recordSelectedSolveAgent(current, solverAgent)
			const item = itemCommands.approveItem(current.id)
			queue.wake()
			return c.json({ data: dashboardItem(item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, msg.startsWith('Item not found') ? 404 : 400)
		}
	})

	api.post('/items/:id/reject', c => {
		try {
			const item = itemCommands.rejectItem(c.req.param('id'))
			return c.json({ data: dashboardItem(item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, msg.startsWith('Item not found') ? 404 : 400)
		}
	})

	api.post('/items/:id/start', async c => {
		const solverAgent = await readSolverAgent(c.req.json<{ solverAgent?: unknown }>())
		if (solverAgent === null) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		if (item.kind !== 'solve' && item.kind !== 'ralph' && item.kind !== 'harden') {
			return c.json({ error: 'Only solve, ralph, or harden Items can be started by this drainer' }, 400)
		}
		if (item.status !== 'queued' && item.status !== 'planned')
			return c.json({ error: 'Item is not ready to start' }, 400)
		recordSelectedSolveAgent(item, solverAgent)
		const started = queue.processOneItem(item.id)
		if (!started) return c.json({ error: 'Could not start Item' }, 500)
		return c.json({ data: dashboardItem(itemCommands.getItem(item.id) ?? item) })
	})

	api.post('/items/:id/retry', async c => {
		const solverAgent = await readSolverAgent(c.req.json<{ solverAgent?: unknown }>())
		if (solverAgent === null) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		try {
			const current = itemCommands.getItem(c.req.param('id'))
			if (!current) return c.json({ error: 'Item not found' }, 404)
			recordSelectedSolveAgent(current, solverAgent)
			const item = queue.retryItem(current.id)
			return c.json({ data: dashboardItem(item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, msg.startsWith('Item not found') ? 404 : 400)
		}
	})

	api.post('/items/:id/cancel', c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		if (item.status !== 'processing' && item.status !== 'queued' && item.status !== 'planned') {
			return c.json({ error: 'Item is not active' }, 400)
		}
		try {
			queue.cancelItem(item.id)
			return c.json({ data: dashboardItem(itemCommands.getItem(item.id) ?? item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, 400)
		}
	})

	api.post('/items/:id/plan', async c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		if (item.status === 'processing') return c.json({ error: 'Processing Items cannot be planned' }, 400)
		const solverAgent = await readSolverAgent(c.req.json<{ solverAgent?: unknown }>())
		if (solverAgent === null) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		const effectiveSolverAgent = solverAgent ?? config.solver.agent

		const projectConfig = config.projects.find(p => p.slug === item.projectSlug)
		if (!projectConfig) return c.json({ error: `Unknown project slug: ${item.projectSlug}` }, 400)

		let sourceContext: TaskContext | null = null
		if (item.payload.kind === 'solve' && item.source) {
			try {
				sourceContext = await provider.getTaskContext(item.source.externalId)
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				return c.json({ error: `Item source context failed to load: ${msg}` }, 502)
			}
			if (!sourceContext) return c.json({ error: 'Item source not found in source system' }, 502)
		}
		const taskContext = buildItemTaskContext(item, sourceContext)

		// Derive a conventional branch name before resolving identity, so planning
		// writes its worktree under the AI-chosen name (no-op unless enabled). Wire
		// the request's abort signal so the model call dies if the client gives up
		// instead of blocking the handler for the full one-shot timeout.
		let named: ItemRecord
		try {
			named = await ensureItemWorkspaceName({
				commands: itemCommands,
				store: db.items,
				item,
				taskContext,
				config,
				repoPath: projectConfig.repoPath,
				agent: effectiveSolverAgent,
				signal: c.req.raw.signal,
			})
		} catch (err) {
			if (isCancellation(err)) return c.json({ error: 'Request aborted' }, 503)
			throw err
		}
		const { baseRef, planDirName, branchName, existingWorktreePath } = resolveItemWorkspace(named)

		let itemSpawner: Spawner
		try {
			itemSpawner = await planningSpawnerForItem(item)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, 400)
		}

		let worktreePath: string
		let hint: string
		try {
			const session = await itemSpawner.startPlanningSession({
				projectConfig: { ...projectConfig, baseBranch: baseRef },
				branchName,
				planDirName,
				taskTitle: item.title,
				taskContext,
				solverConfig: { ...config.solver, agent: effectiveSolverAgent },
				existingWorktreePath,
			})
			worktreePath = session.worktreePath
			hint = session.hint
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: `Planning session failed to start: ${msg}` }, 500)
		}

		const workspace = new PlanWorkspace(worktreePath, planDirName)
		workspace.writeReadme(buildItemPlanReadmeBody(item, branchName, planDirName))
		itemCommands.recordPlanPrepared(item.id, {
			worktreePath,
			branchName,
			planDirName,
			spawner: itemSpawner.name,
		})

		return c.json({
			data: {
				worktreePath,
				branchName,
				planDirName,
				readmePath: workspace.readmePath,
				spawner: itemSpawner.name,
				solverAgent: effectiveSolverAgent,
				hint,
			},
		})
	})

	// List tasks
	api.get('/tasks', c => {
		const status = c.req.query('status')
		const project = c.req.query('project')
		const limit = Number(c.req.query('limit') ?? 50)
		const offset = Number(c.req.query('offset') ?? 0)
		const tasks = db.listTasks({
			status: status || undefined,
			projectSlug: project || undefined,
			limit,
			offset,
		})
		return c.json({ data: tasks })
	})

	// Look up task by external ID
	api.get('/tasks/by-external-id/:id', c => {
		const task = db.getTaskByExternalId(c.req.param('id'))
		if (!task) return c.json({ data: null })
		return c.json({ data: task })
	})

	// Create task by external ID — server resolves projectSlug and title from the provider
	api.post('/tasks', async c => {
		const body = await c.req.json<{ externalId: string; solverAgent?: unknown }>()
		const solverAgent = await readSolverAgent(Promise.resolve(body))
		if (solverAgent === null) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		if (!body.externalId) {
			return c.json({ error: 'Missing required field: externalId' }, 400)
		}
		const existing = db.getTaskByExternalId(body.externalId)
		if (existing) {
			if (solverAgent) {
				db.updateTask(existing.id, { solverAgent })
				return c.json({ data: db.getTask(existing.id) ?? existing })
			}
			return c.json({ data: existing })
		}

		const summary = await provider.resolveTaskSummary(body.externalId)
		if (!summary) {
			return c.json({ error: `Task ${body.externalId} not found in ${provider.name}` }, 404)
		}
		if (!config.projects.some(p => p.slug === summary.projectSlug)) {
			return c.json({ error: `Project '${summary.projectSlug}' is not configured in vigil.config.json` }, 400)
		}

		const id = randomUUID()
		db.insertTask({
			id,
			externalId: body.externalId,
			projectSlug: summary.projectSlug,
			title: summary.title,
			solverAgent: solverAgent ?? undefined,
		})
		db.insertEvent(id, 'task_discovered', { source: 'extension' })
		queue.enqueue(id)
		const task = db.getTask(id)
		if (!task) return c.json({ error: 'Task not found after insert' }, 500)
		return c.json({ data: task }, 201)
	})

	// Task events (activity timeline)
	api.get('/tasks/:id/events', c => {
		const events = db.getEvents(c.req.param('id'))
		return c.json({ data: events })
	})

	// Config Document owns dashboard-safe shape and settings metadata.
	api.get('/config', c => {
		try {
			const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
			return c.json({ data: buildConfigDocument(raw, config).dashboard })
		} catch {
			return c.json({ data: buildConfigDocument(config, config).dashboard })
		}
	})

	// Full Config Document (for settings page)
	api.get('/config/full', c => {
		try {
			const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
			return c.json({ data: buildConfigDocument(raw, config) })
		} catch (err) {
			return c.json({ error: 'Failed to read config file' }, 500)
		}
	})

	// Update config (validates and writes to disk)
	api.put('/config', async c => {
		const body = await c.req.json()
		const currentConfig = (() => {
			try {
				const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
				return parseConfigWithFallback(raw, config)
			} catch {
				return config
			}
		})()
		const result = parseConfigUpdate(body, currentConfig)
		if (!result.success) {
			return c.json({ error: 'Validation failed', details: result.error.flatten() }, 400)
		}
		try {
			writeFileSync(configPath, JSON.stringify(result.data, null, '\t'), 'utf-8')
			return c.json({ data: { message: 'Config saved. Restart Vigil for changes to take effect.' } })
		} catch (err) {
			return c.json({ error: `Failed to write config: ${err instanceof Error ? err.message : err}` }, 500)
		}
	})

	// Prepare a worktree for interactive planning BEFORE the autonomous solve.
	// Creates the worktree, writes a per-task README at docs/plans/<planDirName>/,
	// and KICKS OFF the planning agent (inside Okena's terminal for the Okena
	// spawner, or stages a prompt file the user runs themselves for the default
	// spawner). The autonomous run later reuses the same worktree and the
	// task-context assembly prepends docs/plans/<planDirName>/*.md to the solver prompt.
	api.post('/tasks/:id/plan', async c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		const solverAgent = await readSolverAgent(c.req.json<{ solverAgent?: unknown }>())
		if (solverAgent === null) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		const effectiveSolverAgent = solverAgent ?? task.solverAgent ?? config.solver.agent
		if (solverAgent) db.updateTask(task.id, { solverAgent })

		const projectConfig = config.projects.find(p => p.slug === task.projectSlug)
		if (!projectConfig) return c.json({ error: `Unknown project slug: ${task.projectSlug}` }, 400)

		const { planDirName, branchName, existingWorktreePath } = resolveTaskWorkspace(task)

		// Fetch task context so the planning agent (and context.md) is informed.
		const taskContext = await provider.getTaskContext(task.externalId)
		if (!taskContext) {
			return c.json({ error: 'Task not found in source system' }, 502)
		}

		// One call — spawner creates/reuses the worktree, writes context.md from
		// the raw task context, creates/reuses a single planning terminal, and
		// spawns the planning agent in it.
		let worktreePath: string
		let hint: string
		try {
			const session = await spawner.startPlanningSession({
				projectConfig,
				branchName,
				planDirName,
				taskTitle: task.title,
				taskContext,
				solverConfig: { ...config.solver, agent: effectiveSolverAgent },
				existingWorktreePath,
			})
			worktreePath = session.worktreePath
			hint = session.hint
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: `Planning session failed to start: ${msg}` }, 500)
		}

		// Write a per-task README the user lands on. Records task identity +
		// suggested next step. Overwritten on subsequent calls to keep it fresh.
		const workspace = new PlanWorkspace(worktreePath, planDirName)
		workspace.writeReadme(buildTaskPlanReadmeBody(task, branchName, planDirName))
		const readmePath = workspace.readmePath

		db.updateTask(task.id, { worktreePath, branchName, planDirName })
		db.insertEvent(task.id, 'plan_prepared', { worktreePath, branchName, planDirName })

		return c.json({
			data: {
				worktreePath,
				branchName,
				planDirName,
				readmePath,
				solverType: config.solver.type,
				spawner: spawner.name,
				solverAgent: effectiveSolverAgent,
				hint,
			},
		})
	})

	// Process a single task immediately (bypasses pause)
	api.post('/tasks/:id/start', async c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		const solverAgent = await readSolverAgent(c.req.json<{ solverAgent?: unknown }>())
		if (solverAgent === null) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		if (task.status === 'processing') return c.json({ error: 'Task is already processing' }, 400)
		if (task.status !== 'queued') {
			db.updateTask(task.id, {
				status: 'queued',
				errorMessage: null,
				errorPhase: null,
				startedAt: null,
				completedAt: null,
			})
		}
		if (solverAgent) db.updateTask(task.id, { solverAgent })
		const started = queue.processOne(task.id)
		if (!started) return c.json({ error: 'Could not start task' }, 500)
		return c.json({ data: { message: 'Task started' } })
	})

	// Re-queue a task (reset and put back in queue)
	api.post('/tasks/:id/retry', async c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		const solverAgent = await readSolverAgent(c.req.json<{ solverAgent?: unknown }>())
		if (solverAgent === null) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		if (task.status === 'processing' || task.status === 'queued')
			return c.json({ error: 'Task is already active or queued' }, 400)
		db.updateTask(task.id, {
			status: 'queued',
			errorMessage: null,
			errorPhase: null,
			startedAt: null,
			completedAt: null,
			solverAgent: solverAgent ?? task.solverAgent,
		})
		queue.enqueue(task.id)
		return c.json({ data: { message: 'Task re-enqueued' } })
	})

	// Delete a task entirely
	api.delete('/tasks/:id', c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		if (task.status === 'processing') {
			queue.cancel(task.id)
		}
		db.deleteTask(task.id)
		return c.json({ data: { message: 'Task deleted' } })
	})

	// Cancel a running/queued task
	api.post('/tasks/:id/cancel', c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		if (task.status !== 'processing' && task.status !== 'queued') {
			return c.json({ error: 'Task is not active' }, 400)
		}
		const cancelled = queue.cancel(task.id)
		if (!cancelled && task.status === 'queued') {
			db.updateTask(task.id, {
				status: 'cancelled',
				errorMessage: 'Cancelled by user',
				completedAt: new Date().toISOString(),
			})
			db.insertEvent(task.id, 'task_cancelled')
		}
		return c.json({ data: { message: 'Cancellation requested' } })
	})

	// Update task status manually
	api.post('/tasks/:id/status', async c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		const body = await c.req.json<{ status: string }>()
		const manualStatus = manualStatusSchema.safeParse(body.status)
		if (!manualStatus.success) {
			return c.json({ error: `Invalid status. Must be one of: ${manualStatusSchema.options.join(', ')}` }, 400)
		}
		db.updateTask(task.id, {
			status: manualStatus.data,
			completedAt: new Date().toISOString(),
		})
		db.insertEvent(task.id, 'status_changed', { status: body.status, manual: true })
		return c.json({ data: { message: `Status set to ${body.status}` } })
	})

	// Check PR status via gh CLI
	api.get('/tasks/:id/pr-status', c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		if (!task.prUrl) return c.json({ data: { state: null } })

		try {
			const json = execSync(`gh pr view "${task.prUrl}" --json state,merged,mergedAt,url`, {
				encoding: 'utf-8',
				timeout: 10000,
				stdio: ['pipe', 'pipe', 'pipe'],
			})
			return c.json({ data: JSON.parse(json) })
		} catch {
			return c.json({ data: { state: 'unknown' } })
		}
	})

	// Stream task output (incremental via offset)
	api.get('/tasks/:id/output', c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)

		const offset = Number(c.req.query('offset') ?? 0)
		const tail = readLogTail(c.req.param('id'), offset)
		return c.json({ data: { ...tail, done: task.status !== 'processing' } })
	})

	// Pause/resume queue
	api.post('/queue/pause', c => {
		queue.pause()
		return c.json({ data: { paused: true } })
	})

	api.post('/queue/resume', c => {
		queue.resume()
		return c.json({ data: { paused: false } })
	})

	// Force poll
	api.post('/poll/trigger', async c => {
		await poller.pollOnce()
		return c.json({ data: { message: 'Poll triggered' } })
	})

	return api
}
