import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { configSchema } from '../../config.js'
import type { VigilConfig } from '../../config.js'
import type { DB } from '../../db/client.js'
import { manualStatusSchema } from '../../db/task-schema.js'
import type { TaskRecord } from '../../db/task-schema.js'
import { resolveTaskWorkspace } from '../../plan/identity.js'
import { PlanWorkspace } from '../../plan/workspace.js'
import type { Poller } from '../../poller/poller.js'
import type { TaskProvider } from '../../providers/provider.js'
import type { TaskQueue } from '../../queue/queue.js'
import { solverAgentSchema } from '../../solver/agent.js'
import type { SolverAgent } from '../../solver/agent.js'
import type { Solver } from '../../solver/solver.js'

/** Sanitized config shape for the dashboard. `src` is the on-disk JSON (to pick
 *  up edits) or the in-memory config; `fallback` fills any missing field. */
function sanitizeConfig(
	src: { projects?: unknown; polling?: unknown; solver?: unknown; provider?: unknown },
	fallback: VigilConfig,
) {
	const solver = (src.solver ?? {}) as Record<string, unknown>
	const projects = (src.projects ?? fallback.projects) as Array<Record<string, unknown>>
	const provider = src.provider as Record<string, unknown> | undefined
	return {
		projects: projects.map(p => ({
			slug: p.slug,
			repoPath: p.repoPath,
			baseBranch: p.baseBranch ?? 'main',
			color: p.color,
		})),
		polling: src.polling ?? fallback.polling,
		solver: {
			type: solver.type ?? fallback.solver.type,
			agent: solver.agent ?? fallback.solver.agent,
			concurrency: solver.concurrency ?? fallback.solver.concurrency,
			model: solver.model ?? fallback.solver.model,
			timeoutMinutes: solver.timeoutMinutes ?? fallback.solver.timeoutMinutes,
		},
		taskBaseUrl: provider?.taskBaseUrl ?? fallback.provider.taskBaseUrl,
	}
}

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
function buildPlanReadmeBody(task: TaskRecord, branchName: string, planDirName: string): string {
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

export function apiRoutes(
	config: VigilConfig,
	configPath: string,
	db: DB,
	queue: TaskQueue,
	poller: Poller,
	provider: TaskProvider,
	solver: Solver,
) {
	const api = new Hono()

	async function readSolverAgent(
		bodyPromise: Promise<{ solverAgent?: unknown }>,
	): Promise<SolverAgent | null | undefined> {
		const body = (await bodyPromise.catch(() => ({}))) as { solverAgent?: unknown }
		if (body.solverAgent === undefined || body.solverAgent === null) return undefined
		const parsed = solverAgentSchema.safeParse(body.solverAgent)
		return parsed.success ? parsed.data : null
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

	// Config (sanitized, read from disk to pick up changes; falls back to in-memory)
	api.get('/config', c => {
		try {
			const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
			return c.json({ data: sanitizeConfig(raw, config) })
		} catch {
			return c.json({ data: sanitizeConfig(config, config) })
		}
	})

	// Full config (for settings page)
	api.get('/config/full', c => {
		try {
			const raw = readFileSync(configPath, 'utf-8')
			return c.json({ data: JSON.parse(raw) })
		} catch (err) {
			return c.json({ error: 'Failed to read config file' }, 500)
		}
	})

	// Update config (validates and writes to disk)
	api.put('/config', async c => {
		const body = await c.req.json()
		const result = configSchema.safeParse(body)
		if (!result.success) {
			return c.json({ error: 'Validation failed', details: result.error.flatten() }, 400)
		}
		try {
			writeFileSync(configPath, JSON.stringify(body, null, '\t'), 'utf-8')
			return c.json({ data: { message: 'Config saved. Restart Vigil for changes to take effect.' } })
		} catch (err) {
			return c.json({ error: `Failed to write config: ${err instanceof Error ? err.message : err}` }, 500)
		}
	})

	// Prepare a worktree for interactive planning BEFORE the autonomous solve.
	// Creates the worktree, writes a per-task README at docs/plans/<planDirName>/,
	// and KICKS OFF the planning agent (inside Okena's terminal for the Okena
	// solver, or stages a prompt file the user runs themselves for the default
	// solver). The autonomous run later reuses the same worktree and the
	// transformer prepends docs/plans/<planDirName>/*.md to the solver prompt.
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

		// One call — solver creates/reuses the worktree, writes context.md from
		// the raw task context, creates/reuses a single planning terminal, and
		// spawns the planning agent in it.
		let worktreePath: string
		let hint: string
		try {
			const session = await solver.startPlanningSession({
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
		workspace.writeReadme(buildPlanReadmeBody(task, branchName, planDirName))
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
