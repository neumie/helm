import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { signToken } from '../../chat/token.js'
import { configSchema } from '../../config.js'
import type { VigilConfig } from '../../config.js'
import type { DB } from '../../db/client.js'
import type { Poller } from '../../poller/poller.js'
import type { TaskProvider } from '../../providers/provider.js'
import type { TaskQueue } from '../../queue/queue.js'
import type { Solver } from '../../solver/solver.js'
import { slugify } from '../../util/slug.js'

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

	// Daemon status
	api.get('/status', c => {
		const queueStatus = queue.getStatus()
		return c.json({
			data: {
				uptime: process.uptime(),
				queue: queueStatus,
				projects: config.projects.map(p => p.slug),
				pollInterval: config.polling.intervalSeconds,
				chatEnabled: config.chat?.enabled ?? false,
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

	// Look up task by clientcare ID
	api.get('/tasks/by-clientcare-id/:id', c => {
		const task = db.getTaskByClientcareId(c.req.param('id'))
		if (!task) return c.json({ data: null })
		return c.json({ data: task })
	})

	// Create task by clientcare ID — server resolves projectSlug and title from the provider
	api.post('/tasks', async c => {
		const body = await c.req.json<{ clientcareId: string }>()
		if (!body.clientcareId) {
			return c.json({ error: 'Missing required field: clientcareId' }, 400)
		}
		const existing = db.getTaskByClientcareId(body.clientcareId)
		if (existing) {
			return c.json({ data: existing })
		}

		const summary = await provider.resolveTaskSummary(body.clientcareId)
		if (!summary) {
			return c.json({ error: `Task ${body.clientcareId} not found in ${provider.name}` }, 404)
		}
		if (!config.projects.some(p => p.slug === summary.projectSlug)) {
			return c.json(
				{ error: `Project '${summary.projectSlug}' is not configured in vigil.config.json` },
				400,
			)
		}

		const id = randomUUID()
		db.insertTask({
			id,
			clientcareId: body.clientcareId,
			projectSlug: summary.projectSlug,
			title: summary.title,
		})
		db.insertEvent(id, 'task_discovered', { source: 'extension' })
		queue.enqueue(id)
		const task = db.getTask(id)!
		return c.json({ data: task }, 201)
	})

	// Single task detail
	api.get('/tasks/:id', c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		return c.json({ data: task })
	})

	// Task events (activity timeline)
	api.get('/tasks/:id/events', c => {
		const events = db.getEvents(c.req.param('id'))
		return c.json({ data: events })
	})

	// Queue state
	api.get('/queue', c => {
		return c.json({ data: queue.getStatus() })
	})

	// Config (sanitized, read from disk to pick up changes)
	api.get('/config', c => {
		try {
			const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
			return c.json({
				data: {
					projects: (raw.projects ?? []).map((p: Record<string, unknown>) => ({
						slug: p.slug,
						repoPath: p.repoPath,
						baseBranch: p.baseBranch ?? 'main',
						color: p.color,
					})),
					polling: raw.polling ?? config.polling,
					solver: {
						concurrency: raw.solver?.concurrency ?? config.solver.concurrency,
						model: raw.solver?.model ?? config.solver.model,
						timeoutMinutes: raw.solver?.timeoutMinutes ?? config.solver.timeoutMinutes,
					},
					taskBaseUrl: raw.provider?.taskBaseUrl,
				},
			})
		} catch {
			// Fallback to in-memory config if file read fails
			return c.json({
				data: {
					projects: config.projects.map(p => ({
						slug: p.slug,
						repoPath: p.repoPath,
						baseBranch: p.baseBranch,
						color: p.color,
					})),
					polling: config.polling,
					solver: {
						concurrency: config.solver.concurrency,
						model: config.solver.model,
						timeoutMinutes: config.solver.timeoutMinutes,
					},
					taskBaseUrl: config.provider.type === 'contember' ? config.provider.taskBaseUrl : undefined,
				},
			})
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

	// Stats
	api.get('/stats', c => {
		return c.json({ data: db.getStats() })
	})

	// Prepare a worktree for interactive planning BEFORE the autonomous solve.
	// User opens the worktree (Okena terminal for okena solver, their own CC
	// for default), runs /grill-me/<externalId> or /grill-plan/<externalId>,
	// commits the resulting docs/plans/<externalId>/ artifacts. When the task
	// later runs autonomously, the solver reuses this worktree and the
	// transformer prepends the artifacts to the prompt.
	api.post('/tasks/:id/plan', async c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)

		const projectConfig = config.projects.find(p => p.slug === task.projectSlug)
		if (!projectConfig) return c.json({ error: `Unknown project slug: ${task.projectSlug}` }, 400)

		const externalId = task.clientcareId
		const branchName = task.branchName ?? `vigil/${slugify(task.title)}`

		// Idempotent: if a worktree already exists on disk for this task, reuse it.
		let worktreePath: string
		if (task.worktreePath && existsSync(task.worktreePath)) {
			worktreePath = task.worktreePath
		} else {
			try {
				const result = await solver.prepareWorktree({
					projectConfig,
					branchName,
					taskTitle: task.title,
				})
				worktreePath = result.worktreePath
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				return c.json({ error: `Worktree preparation failed: ${msg}` }, 500)
			}
		}

		// Write a per-task README the user lands on. Records task identity +
		// suggested next step. Overwritten on subsequent calls to keep it fresh.
		const taskDir = join(worktreePath, 'docs', 'plans', externalId)
		mkdirSync(taskDir, { recursive: true })
		const readmePath = join(taskDir, 'README.md')
		const readmeBody = [
			`# Task ${externalId}`,
			'',
			`**Title:** ${task.title}`,
			`**Status:** ${task.status}`,
			`**Branch:** ${branchName}`,
			'',
			'## Plan this task',
			'',
			'Run one of the planning skills in this directory:',
			'',
			`- \`/grill-me ${externalId}\` — stress-test decisions interactively. Writes \`brief.md\`.`,
			`- \`/grill-plan ${externalId}\` — challenge the plan against the domain model.`,
			`- \`/prd-create\` — once you have a brief, synthesize into \`prd.md\`.`,
			'',
			'Anything you commit under this directory will be loaded into the autonomous solver prompt when the task runs.',
			'',
		].join('\n')
		writeFileSync(readmePath, readmeBody, 'utf-8')

		db.updateTask(task.id, { worktreePath, branchName })
		db.insertEvent(task.id, 'plan_prepared', { worktreePath, branchName })

		return c.json({
			data: {
				worktreePath,
				branchName,
				externalId,
				readmePath,
				solverType: config.solver.type,
			},
		})
	})

	// Process a single task immediately (bypasses pause)
	api.post('/tasks/:id/start', c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
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
		const started = queue.processOne(task.id)
		if (!started) return c.json({ error: 'Could not start task' }, 500)
		return c.json({ data: { message: 'Task started' } })
	})

	// Re-queue a task (reset and put back in queue)
	api.post('/tasks/:id/retry', c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		if (task.status === 'processing' || task.status === 'queued') return c.json({ error: 'Task is already active or queued' }, 400)
		db.updateTask(task.id, {
			status: 'queued',
			errorMessage: null,
			errorPhase: null,
			startedAt: null,
			completedAt: null,
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
		const validStatuses = ['completed', 'review', 'failed', 'cancelled', 'skipped']
		if (!validStatuses.includes(body.status)) {
			return c.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, 400)
		}
		db.updateTask(task.id, {
			status: body.status,
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

		const logPath = resolve(process.cwd(), 'logs', `${c.req.param('id')}.log`)
		const offset = Number(c.req.query('offset') ?? 0)

		try {
			const fd = openSync(logPath, 'r')
			const stat = fstatSync(fd)
			const size = stat.size

			if (offset >= size) {
				closeSync(fd)
				return c.json({ data: { content: '', offset: size, done: task.status !== 'processing' } })
			}

			const buf = Buffer.alloc(size - offset)
			readSync(fd, buf, 0, buf.length, offset)
			closeSync(fd)

			return c.json({
				data: { content: buf.toString('utf-8'), offset: size, done: task.status !== 'processing' },
			})
		} catch {
			return c.json({ data: { content: '', offset: 0, done: task.status !== 'processing' } })
		}
	})

	// Chat sessions for a task
	api.get('/tasks/:id/chat', c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)

		const sessions = db.getChatSessionsByTaskId(task.id)
		const baseUrl = config.chat?.baseUrl ?? `http://localhost:${config.server.port}`
		const result = sessions.map(s => ({
			...s,
			messages: db.getChatMessages(s.id),
			chatUrl: config.chat?.enabled ? `${baseUrl}/chat/${s.token}` : null,
		}))
		return c.json({ data: result })
	})

	// Create manual chat session
	api.post('/tasks/:id/chat', async c => {
		const task = db.getTask(c.req.param('id'))
		if (!task) return c.json({ error: 'Not found' }, 404)
		if (!config.chat?.enabled) return c.json({ error: 'Chat is not enabled in config' }, 400)

		const body = await c.req.json<{ message?: string }>().catch(() => ({ message: undefined }))
		const token = signToken(randomUUID(), config.chat.secret, config.chat.expiryDays)
		const session = db.createChatSession(task.id, token)
		const baseUrl = config.chat.baseUrl ?? `http://localhost:${config.server.port}`
		const chatUrl = `${baseUrl}/chat/${token}`

		if (body.message?.trim()) {
			db.addChatMessage(session.id, 'assistant', body.message.trim())
		}

		db.insertEvent(task.id, 'chat_created', { sessionId: session.id, manual: true })

		return c.json({ data: { session, chatUrl } }, 201)
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
