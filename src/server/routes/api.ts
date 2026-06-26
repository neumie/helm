import { readFileSync, writeFileSync } from 'node:fs'
import { Hono } from 'hono'
import { z } from 'zod'
import { buildConfigDocument, parseConfigUpdate, parseConfigWithFallback } from '../../config-document.js'
import type { VigilConfig } from '../../config.js'
import type { DB } from '../../db/client.js'
import { ItemCommands } from '../../items/commands.js'
import { buildItemTaskContext } from '../../items/context.js'
import { toDashboardItemWithSiblings, toDashboardItems } from '../../items/contract.js'
import { resolveItemWorkspace } from '../../items/identity.js'
import { ensureItemWorkspaceName } from '../../items/naming.js'
import { observeItemRun } from '../../items/observation.js'
import { itemStatusSchema } from '../../items/schema.js'
import type { ItemRecord } from '../../items/schema.js'
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

	// Item dashboard contract — the read/write path for all work.
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
				item,
				taskContext,
				config,
				repoPath: projectConfig.repoPath,
				agent: effectiveSolverAgent,
				signal: c.req.raw.signal,
			})
		} catch (err) {
			// Pass the request signal so an error coinciding with a client abort is
			// classified as cancellation (matching how ensureItemWorkspaceName re-throws),
			// not mis-reported as a 500.
			if (isCancellation(err, c.req.raw.signal)) return c.json({ error: 'Request aborted' }, 503)
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
