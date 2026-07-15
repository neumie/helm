import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
	attachmentMimeType,
	attachmentPath,
	copyAttachmentsToWorktree,
	isInlineSafeContentType,
	isOpenableAttachment,
	readAttachment,
	removeItemAttachments,
	sanitizeAttachmentName,
	saveAttachment,
} from '../../attachments/store.js'
import { buildConfigDocument, parseConfigUpdate, parseConfigWithFallback } from '../../config-document.js'
import type { HelmConfig } from '../../config.js'
import type { DB } from '../../db/client.js'
import { ensureItemAssessment } from '../../items/assess.js'
import { ItemCommands } from '../../items/commands.js'
import { buildItemTaskContext, localizeCapturedAttachments, resolveItemSourceContext } from '../../items/context.js'
import { canCreateSourceTask, toDashboardItemWithSiblings, toDashboardItems } from '../../items/contract.js'
import type { ItemEnricher } from '../../items/enricher.js'
import { resolveItemWorkspace } from '../../items/identity.js'
import { ensureItemDisplayName, ensureItemWorkspaceName } from '../../items/naming.js'
import { observeItemRun } from '../../items/observation.js'
import { itemStatusSchema } from '../../items/schema.js'
import type { ItemRecord } from '../../items/schema.js'
import { PlanWorkspace } from '../../plan/workspace.js'
import type { Poller } from '../../poller/poller.js'
import { DAEMON_BUILD_ID, DAEMON_PROTOCOL_VERSION } from '../../protocol.js'
import type { TaskContext, TaskProvider } from '../../providers/provider.js'
import type { Drainer } from '../../queue/drainer.js'
import { solverAgentSchema } from '../../solver/agent.js'
import type { SolverAgent } from '../../solver/agent.js'
import type { OneShotOptions } from '../../solver/one-shot.js'
import { solverWorkspaceSchema } from '../../solver/workspace.js'
import type { SolverWorkspace } from '../../solver/workspace.js'
import { createSpawner, listSpawnerAdapters, spawnerNameSchema } from '../../spawner/registry.js'
import type { SpawnerName } from '../../spawner/registry.js'
import type { Spawner } from '../../spawner/spawner.js'
import { isCancellation } from '../../util/errors.js'
import { log } from '../../util/logger.js'
import { defaultDaemonControl, scheduleDaemonRestart } from '../restart.js'
import type { DaemonControl } from '../restart.js'

function buildItemPlanReadmeBody(item: ItemRecord, branchName: string | null, planDirName: string): string {
	return [
		`# ${item.title}`,
		'',
		`**Kind:** ${item.kind}`,
		`**Status:** ${item.status}`,
		`**BaseRef:** ${item.baseRef}`,
		`**Branch:** ${branchName ?? '(main checkout — the agent creates the branch at run time)'}`,
		`**Item ID:** ${item.id}`,
		'',
		'## Plan this Item',
		'',
		'Planning agent started in this worktree. Tell it what you want to do, or invoke one of:',
		'',
		`- \`/almanac:grill-me ${planDirName}\` — stress-test decisions interactively (in-conversation, no file).`,
		`- \`/almanac:grill-with-docs ${planDirName}\` — challenge the plan against the domain model.`,
		'- `/almanac:prd-create` — synthesize the decisions into `prd.md`.',
		'',
		'Anything committed under this directory is loaded into the autonomous run when the Item executes.',
		'',
	].join('\n')
}

// Generic task ingest (e.g. an email tied to a project): a self-contained task
// with its content captured up front (no live provider to re-poll). Attachments
// arrive base64-encoded; capped so a single request can't blow up memory/disk.
const MAX_INGEST_ATTACHMENT_BYTES = 25 * 1024 * 1024
// Hard request-body cap enforced by `bodyLimit` middleware BEFORE the body is
// buffered/parsed — the per-field/attachment caps below only run post-parse.
// Generous enough for ~25MB of attachments after base64 (+33%) + JSON overhead.
const MAX_INGEST_BODY_BYTES = 40 * 1024 * 1024

const ingestSchema = z
	.object({
		projectSlug: z.string().min(1),
		title: z.string().min(1).max(2000),
		body: z.string().max(500_000).optional(),
		metadata: z.record(z.string().max(10_000)).optional(),
		source: z
			.object({
				label: z.string().min(1).max(200).optional(),
				externalId: z.string().min(1).max(1000).optional(),
				url: z.string().max(2000).optional(),
			})
			.strict()
			.optional(),
		attachments: z
			.array(
				z
					.object({
						name: z.string().min(1).max(255),
						contentType: z.string().max(255).optional(),
						dataBase64: z.string().min(1),
					})
					.strict(),
			)
			.max(20)
			.optional(),
	})
	.strict()
	.superRefine((val, ctx) => {
		if (val.metadata && Object.keys(val.metadata).length > 50) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'metadata has too many entries (max 50)' })
		}
		const total = (val.attachments ?? []).reduce((n, a) => n + Math.floor((a.dataBase64.length * 3) / 4), 0)
		if (total > MAX_INGEST_ATTACHMENT_BYTES) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Attachments exceed 25MB total' })
		}
	})

/** Only http(s) urls are usable as a source link; anything else (mailto:, message:) is dropped. */
function httpSourceUrl(url: string | undefined): string | undefined {
	if (!url) return undefined
	try {
		const parsed = new URL(url)
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined
	} catch {
		return undefined
	}
}

export function apiRoutes(
	config: HelmConfig,
	configPath: string,
	db: DB,
	queue: Drainer,
	poller: Poller,
	provider: TaskProvider,
	spawner: Spawner,
	enricher: ItemEnricher,
	createPlanningSpawner: (config: HelmConfig, name: SpawnerName) => Promise<Spawner> = createSpawner,
	// Injected only by tests so the manual AI-pass route can run without a real
	// model; production leaves it undefined and the passes use the real one-shot.
	aiOneShot?: (opts: OneShotOptions) => Promise<string | null>,
	// Injected only by tests so config-save/restart routes can prove the exit
	// path without killing the test runner; production uses the launchd control.
	daemonControl: DaemonControl = defaultDaemonControl,
) {
	const api = new Hono()
	const itemCommands = new ItemCommands(db.items, config)
	const aiDeps = aiOneShot ? { runOneShot: aiOneShot } : undefined
	const dashboardItem = async (item: ItemRecord) => ({
		...toDashboardItemWithSiblings(
			item,
			item.groupId ? itemCommands.listGroupItems(item.groupId) : [],
			await observeItemRun(item, { store: db.items }),
		),
		canCreateSourceTask: canCreateSourceTask(item, provider),
	})
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
	// List uses the cheap DB-only observation: the card/status/links/actions all
	// derive from the Item row, and the list doesn't render run details. Full
	// observeItemRun (log reads + a `gh pr view` network call per item) is reserved
	// for the single-Item detail route, so the list stays fast as PRs accumulate.
	const dashboardItems = (items: ItemRecord[]) => toDashboardItems(expandGroupedItems(items))

	// solverAgent: absent/null → undefined (untouched). solverModel and
	// solverWorkspace: absent → undefined (untouched), explicit JSON null → null
	// (CLEAR the stored override — how the extension's "Auto" chip drops a
	// previously-picked model), valid value → set. Invalid values flag a 400
	// instead.
	interface SolveSelection {
		solverAgent: SolverAgent | undefined
		solverAgentInvalid: boolean
		solverModel: string | null | undefined
		solverModelInvalid: boolean
		solverWorkspace: SolverWorkspace | null | undefined
		solverWorkspaceInvalid: boolean
	}

	async function readSolveSelection(bodyPromise: Promise<unknown>): Promise<SolveSelection> {
		const body = (await bodyPromise.catch(() => ({}))) as {
			solverAgent?: unknown
			solverModel?: unknown
			solverWorkspace?: unknown
		}
		let solverAgent: SolveSelection['solverAgent']
		let solverAgentInvalid = false
		if (body.solverAgent !== undefined && body.solverAgent !== null) {
			const parsed = solverAgentSchema.safeParse(body.solverAgent)
			if (parsed.success) solverAgent = parsed.data
			else solverAgentInvalid = true
		}
		let solverModel: SolveSelection['solverModel']
		let solverModelInvalid = false
		if (body.solverModel === null) {
			solverModel = null
		} else if (body.solverModel !== undefined) {
			if (typeof body.solverModel === 'string' && body.solverModel.length >= 1 && body.solverModel.length <= 100) {
				solverModel = body.solverModel
			} else {
				solverModelInvalid = true
			}
		}
		let solverWorkspace: SolveSelection['solverWorkspace']
		let solverWorkspaceInvalid = false
		if (body.solverWorkspace === null) {
			solverWorkspace = null
		} else if (body.solverWorkspace !== undefined) {
			const parsed = solverWorkspaceSchema.safeParse(body.solverWorkspace)
			if (parsed.success) solverWorkspace = parsed.data
			else solverWorkspaceInvalid = true
		}
		return { solverAgent, solverAgentInvalid, solverModel, solverModelInvalid, solverWorkspace, solverWorkspaceInvalid }
	}

	function invalidSelection(c: Context, selection: SolveSelection) {
		if (selection.solverAgentInvalid) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		if (selection.solverModelInvalid) {
			return c.json({ error: 'Invalid solverModel. Must be a non-empty string (max 100 chars) or null.' }, 400)
		}
		if (selection.solverWorkspaceInvalid) {
			return c.json(
				{ error: `Invalid solverWorkspace. Must be one of: ${solverWorkspaceSchema.options.join(', ')} — or null.` },
				400,
			)
		}
		return null
	}

	function recordSolveSelection(item: ItemRecord, selection: SolveSelection): ItemRecord {
		if (item.kind !== 'solve') return item
		let updated = item
		if (selection.solverAgent) updated = itemCommands.setSolveItemAgent(item.id, selection.solverAgent)
		if (selection.solverModel !== undefined) updated = itemCommands.setSolveItemModel(item.id, selection.solverModel)
		if (selection.solverWorkspace !== undefined) {
			updated = itemCommands.setSolveItemWorkspace(item.id, selection.solverWorkspace)
		}
		return updated
	}

	/** Effective execution workspace for an Item: request override ?? stored payload ?? config. */
	function effectiveSolverWorkspace(item: ItemRecord, selected: SolverWorkspace | null | undefined): SolverWorkspace {
		const stored = item.payload.kind === 'solve' ? item.payload.solverWorkspace : undefined
		return selected ?? stored ?? config.solver.workspace ?? 'worktree'
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
				protocolVersion: DAEMON_PROTOCOL_VERSION,
				buildId: DAEMON_BUILD_ID,
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
		const projectSlug = c.req.query('project') || undefined
		const limit = c.req.query('limit')
		const offset = c.req.query('offset')
		const parsedStatus = status ? itemStatusSchema.safeParse(status) : null
		if (status && !parsedStatus?.success) {
			return c.json({ error: `Invalid status. Must be one of: ${itemStatusSchema.options.join(', ')}` }, 400)
		}
		// Bare /items is the native dashboard snapshot: all actionable work plus
		// a bounded archive. Explicit filters/pagination retain list semantics.
		const items =
			status === undefined && projectSlug === undefined && limit === undefined && offset === undefined
				? itemCommands.listDashboardItems()
				: itemCommands.listItems({
						status: parsedStatus?.success ? parsedStatus.data : undefined,
						projectSlug,
						limit: Number(limit ?? 50),
						offset: Number(offset ?? 0),
					})
		return c.json({ data: dashboardItems(items) })
	})

	api.get('/items/by-source/:externalId', async c => {
		const item = itemCommands.getItemBySourceExternalId(c.req.param('externalId'))
		return c.json({ data: item ? await dashboardItem(item) : null })
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
		if (existing) return c.json({ data: await dashboardItem(existing) })

		const summary = await provider.resolveTaskSummary(parsed.data.externalId)
		if (!summary) return c.json({ error: `Task ${parsed.data.externalId} not found in ${provider.name}` }, 404)
		if (!config.projects.some(p => p.slug === summary.projectSlug)) {
			return c.json({ error: `Project '${summary.projectSlug}' is not configured in helm.config.json` }, 400)
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
		return c.json({ data: await dashboardItem(item) }, 201)
	})

	// Ingest a self-contained task (e.g. an email tied to a project): title, body,
	// metadata, and base64 attachments captured up front. Creates a source-backed
	// `inbox` solve Item carrying a frozen capturedContext (no live provider to
	// re-poll) and enqueues it for AI enrichment (display name + the security-aware
	// intent assessment — this is untrusted external content). Idempotent by
	// source.externalId, so re-ingesting the same message returns the existing Item.
	api.post('/items/ingest', bodyLimit({ maxSize: MAX_INGEST_BODY_BYTES }), async c => {
		const body = await c.req.json().catch(() => null)
		const parsed = ingestSchema.safeParse(body)
		if (!parsed.success) {
			return c.json({ error: 'Invalid ingest payload', details: parsed.error.flatten() }, 400)
		}
		const input = parsed.data
		if (!config.projects.some(p => p.slug === input.projectSlug)) {
			return c.json({ error: `Project '${input.projectSlug}' is not configured in helm.config.json` }, 400)
		}

		const externalId = input.source?.externalId ?? `email:${randomUUID()}`
		const existing = itemCommands.getItemBySourceExternalId(externalId)
		if (existing) return c.json({ data: await dashboardItem(existing) })

		// Atomic: pre-generate the id, save attachments + build the frozen context,
		// then ONE create carrying source + capturedContext together — so a failure
		// can never leave a source-backed Item without its capturedContext (which
		// would mis-route the solve to the live provider). On any error, the
		// already-written attachment files are cleaned up.
		const id = randomUUID()
		try {
			// Relative, same-origin URL: the dashboard renders it regardless of the
			// host it reached the daemon on; the worker/plan route rewrite it to a
			// worktree-local path at run time.
			const savedAttachments = (input.attachments ?? []).map(a => {
				const finalName = saveAttachment(id, a.name, Buffer.from(a.dataBase64, 'base64'))
				return {
					name: a.name,
					url: `/api/items/${id}/attachments/${finalName}`,
					...(a.contentType ? { contentType: a.contentType } : {}),
				}
			})

			const trimmedBody = input.body?.trim() ?? ''
			const hasBody = trimmedBody.length > 0
			const capturedContext: TaskContext = {
				title: input.title,
				...(hasBody ? { description: input.body } : {}),
				...(input.metadata && Object.keys(input.metadata).length > 0 ? { metadata: input.metadata } : {}),
				...(savedAttachments.length > 0 ? { attachments: savedAttachments } : {}),
			}

			const item = itemCommands.createSolveItem({
				id,
				projectSlug: input.projectSlug,
				title: input.title,
				prompt: hasBody ? trimmedBody : input.title,
				source: {
					provider: input.source?.label ?? 'Email',
					externalId,
					...(httpSourceUrl(input.source?.url) ? { url: httpSourceUrl(input.source?.url) } : {}),
				},
				capturedContext,
			})
			enricher.enqueue([item])
			return c.json({ data: await dashboardItem(item) }, 201)
		} catch (err) {
			removeItemAttachments(id)
			const msg = err instanceof Error ? err.message : String(err)
			log.error('api', `Ingest failed for ${externalId}: ${msg}`)
			return c.json({ error: `Ingest failed: ${msg}` }, 500)
		}
	})

	// Serve an ingested-task attachment's bytes (dashboard <img src>, links).
	// Hardened against stored XSS: ingested content is untrusted, so the served
	// Content-Type is derived server-side from the filename extension ONLY (never
	// the caller-declared type — an attacker can't smuggle text/html or
	// image/svg+xml), unknown types fall back to octet-stream, `nosniff` blocks
	// MIME-sniffing, non-image/pdf types are forced to download, and a sandbox CSP
	// neutralizes script even if a browser renders the response directly.
	api.get('/items/:id/attachments/:name', c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		const name = c.req.param('name')
		const bytes = readAttachment(item.id, name)
		if (!bytes) return c.json({ error: 'Attachment not found' }, 404)
		const contentType = attachmentMimeType(name)
		const disposition = isInlineSafeContentType(contentType) ? 'inline' : 'attachment'
		return c.body(new Uint8Array(bytes), 200, {
			'Content-Type': contentType,
			'Content-Disposition': `${disposition}; filename="${sanitizeAttachmentName(name)}"`,
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; sandbox",
			'Cache-Control': 'private, max-age=300',
		})
	})

	// Open an ingested attachment in the host's native app (the daemon is local, so
	// "open" = open on the user's machine). Lets the dashboard preview an .xlsx etc.
	// in Excel/Numbers instead of downloading. Gated to a document/media extension
	// allowlist so a crafted attachment can't be turned into code execution, and the
	// path is resolved under the Item's attachment dir (sanitized name → no traversal).
	api.post('/items/:id/attachments/:name/open', c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		const name = c.req.param('name')
		if (!isOpenableAttachment(name)) return c.json({ error: 'This attachment type cannot be opened' }, 400)
		const path = attachmentPath(item.id, name)
		if (!path) return c.json({ error: 'Attachment not found' }, 404)
		const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null
		if (!opener) return c.json({ error: 'Opening attachments is only supported on macOS and Linux' }, 501)
		// execFile (no shell) with a resolved, allowlisted path — fire-and-forget; the
		// opener detaches. A spawn error is logged, not surfaced (the app launches async).
		execFile(opener, [path], err => {
			if (err) log.warn('api', `Failed to open attachment ${name}: ${err.message}`)
		})
		return c.json({ data: { opened: true } })
	})

	api.get('/items/:id', async c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		// Surface the source-task content in the detail view: the frozen captured
		// context (ingested email) wins, else a live provider fetch. Best-effort:
		// a provider failure degrades to no task body, never a 500.
		let sourceTask: TaskContext | null = null
		try {
			sourceTask = await resolveItemSourceContext(item, provider)
		} catch (err) {
			log.warn('api', `Failed to load source task for Item ${item.id}: ${err instanceof Error ? err.message : err}`)
		}
		// Plan preview: the *.md the user wrote while planning (prd/…), read
		// from the worktree's plan dir. Only for interactively-planned Items, and
		// best-effort — a cleaned-up worktree degrades to []. Per-item IO (detail only).
		let planArtifacts: Array<{ name: string; content: string }> = []
		if (item.plannedAt && item.worktreePath && item.planDirName) {
			try {
				planArtifacts = new PlanWorkspace(item.worktreePath, item.planDirName).listArtifacts()
			} catch (err) {
				log.warn(
					'api',
					`Failed to read plan artifacts for Item ${item.id}: ${err instanceof Error ? err.message : err}`,
				)
			}
		}
		return c.json({ data: { ...(await dashboardItem(item)), sourceTask, planArtifacts } })
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
						kind: z.literal('loop'),
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
			])
			.safeParse(body)
		if (!parsed.success) return c.json({ error: 'Only valid solve or loop Item creation is supported' }, 400)
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
							parallelism: parsed.data.parallelism,
						})
					case 'loop':
						return itemCommands.createLoopItems({
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
							parallelism: parsed.data.parallelism,
						})
				}
			})()
			if (items.some(item => item.status === 'ready')) queue.wake()
			return c.json({ data: items.length === 1 ? await dashboardItem(items[0]) : dashboardItems(items) }, 201)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, 400)
		}
	})

	api.post('/items/:id/approve', async c => {
		const selection = await readSolveSelection(c.req.json())
		const invalid = invalidSelection(c, selection)
		if (invalid) return invalid
		const current = itemCommands.getItem(c.req.param('id'))
		if (!current) return c.json({ error: 'Item not found' }, 404)
		if (current.status !== 'inbox') return c.json({ error: 'Only Inbox Items can be approved' }, 400)
		try {
			recordSolveSelection(current, selection)
			const item = itemCommands.approveItem(current.id)
			queue.wake()
			return c.json({ data: await dashboardItem(item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, msg.startsWith('Item not found') ? 404 : 400)
		}
	})

	// Promote a captured (ingested) Item — e.g. an email — into a real task in
	// the source system: the provider creates the task, and the Item's `source`
	// is re-pointed at it (so the poller's externalId dedup will skip it and the
	// dashboard links to the live task). The frozen capturedContext stays — it
	// carries the email body + local attachments the solve runs against.
	api.post('/items/:id/source-task', async c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Item not found' }, 404)
		if (!item.capturedContext) {
			return c.json({ error: 'Only captured (ingested) Items can create a source task' }, 400)
		}
		if (item.source?.provider === provider.name) {
			return c.json({ error: `Item is already linked to a ${provider.name} task` }, 400)
		}
		if (typeof provider.createTask !== 'function') {
			return c.json({ error: `The ${provider.name} provider does not support task creation` }, 400)
		}
		try {
			const created = await provider.createTask({
				projectSlug: item.projectSlug,
				title: item.title,
				description: item.capturedContext.description,
			})
			const linked = itemCommands.linkSourceTask(item.id, {
				provider: provider.name,
				externalId: created.externalId,
				...(created.url ? { url: created.url } : {}),
			})
			log.success('items', `Created source task ${created.externalId} for Item ${item.id}`)
			return c.json({ data: await dashboardItem(linked) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.error('items', `Source-task creation failed for Item ${item.id}`, err)
			return c.json({ error: `Source task creation failed: ${msg}` }, 502)
		}
	})

	api.post('/items/:id/reject', async c => {
		try {
			const item = itemCommands.rejectItem(c.req.param('id'))
			return c.json({ data: await dashboardItem(item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, msg.startsWith('Item not found') ? 404 : 400)
		}
	})

	api.post('/items/:id/start', async c => {
		const body = await c.req.json().catch(() => ({}))
		const selection = await readSolveSelection(Promise.resolve(body))
		const invalid = invalidSelection(c, selection)
		if (invalid) return invalid
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		if (item.kind !== 'solve' && item.kind !== 'loop') {
			return c.json({ error: 'Only solve or loop Items can be started by this drainer' }, 400)
		}
		const plannedActive = item.status === 'active' && item.workMode === 'manual' && item.plannedAt != null
		if (item.status !== 'ready' && item.status !== 'inbox' && !plannedActive) {
			return c.json({ error: 'Item is not ready to start' }, 400)
		}
		recordSolveSelection(item, selection)
		const selectedItem = itemCommands.getItem(item.id) ?? item
		if (plannedActive && selectedItem.payload.kind === 'solve') {
			const requested = (body as { executionMode?: unknown }).executionMode
			if (requested !== 'agent' && requested !== 'loop') {
				return c.json({ error: 'Planned Items require executionMode: agent or loop' }, 400)
			}
			if (requested === 'loop') {
				if ((selectedItem.payload.solverWorkspace ?? config.solver.workspace) === 'main') {
					return c.json({ error: 'Loops require an isolated worktree; switch Workspace to Worktree.' }, 400)
				}
				if (!selectedItem.worktreePath || !selectedItem.planDirName || !existsSync(selectedItem.worktreePath)) {
					return c.json({ error: 'Planned worktree is missing. Re-plan the Item before starting a loop.' }, 400)
				}
				let prdPath: string
				try {
					prdPath = new PlanWorkspace(selectedItem.worktreePath, selectedItem.planDirName).loopArtifactPath()
				} catch (err) {
					return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
				}
				const localTickets = selectedItem.planStatus?.localTickets
				const githubTickets = selectedItem.planStatus?.githubTickets
				const ticketTotal = (localTickets?.total ?? 0) + (githubTickets?.total ?? 0)
				const agentReadyTickets = (localTickets?.readyForAgent ?? 0) + (githubTickets?.readyForAgent ?? 0)
				if (ticketTotal > 0 && agentReadyTickets === 0) {
					return c.json({ error: 'This plan has tickets, but none are ready for an agent.' }, 400)
				}
				itemCommands.setSolveExecution(item.id, {
					mode: 'loop',
					prdPath,
					options: {
						// Start loop means finish the autonomous queue, not run one ticket.
						// An explicit queue gets one iteration per currently agent-ready
						// ticket; a spec with no queue gets Almanac's bounded decomposition run.
						mode: 'afk',
						iterations: agentReadyTickets > 0 ? agentReadyTickets : 10,
						provider: selectedItem.payload.solverAgent ?? config.solver.agent,
						model: selectedItem.payload.solverModel ?? config.solver.model,
					},
				})
			} else {
				itemCommands.setSolveExecution(item.id, { mode: 'solver' })
			}
		}
		const started = queue.processOneItem(item.id)
		if (!started) return c.json({ error: 'Could not start Item' }, 500)
		return c.json({ data: await dashboardItem(itemCommands.getItem(item.id) ?? item) })
	})

	api.post('/items/:id/retry', async c => {
		const selection = await readSolveSelection(c.req.json())
		const invalid = invalidSelection(c, selection)
		if (invalid) return invalid
		try {
			const current = itemCommands.getItem(c.req.param('id'))
			if (!current) return c.json({ error: 'Item not found' }, 404)
			recordSolveSelection(current, selection)
			const item = queue.retryItem(current.id)
			return c.json({ data: await dashboardItem(item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, msg.startsWith('Item not found') ? 404 : 400)
		}
	})

	api.post('/items/:id/status', async c => {
		const body = (await c.req.json().catch(() => ({}))) as { status?: unknown }
		const parsed = itemStatusSchema.safeParse(body.status)
		if (!parsed.success) {
			return c.json({ error: `Invalid status. Must be one of: ${itemStatusSchema.options.join(', ')}` }, 400)
		}
		try {
			const item = itemCommands.setItemStatus(c.req.param('id'), parsed.data)
			if (item.status === 'ready') queue.wake()
			return c.json({ data: await dashboardItem(item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, msg.startsWith('Item not found') ? 404 : 400)
		}
	})

	api.post('/items/:id/reopen', async c => {
		try {
			const item = itemCommands.reopenItem(c.req.param('id'))
			return c.json({ data: await dashboardItem(item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, msg.startsWith('Item not found') ? 404 : 400)
		}
	})

	api.post('/items/:id/cancel', async c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		if (item.status !== 'running' && item.status !== 'ready' && item.status !== 'inbox') {
			return c.json({ error: 'Item is not active' }, 400)
		}
		try {
			queue.cancelItem(item.id)
			return c.json({ data: await dashboardItem(itemCommands.getItem(item.id) ?? item) })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: msg }, 400)
		}
	})

	api.post('/items/:id/plan', async c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		if (item.status === 'running') return c.json({ error: 'Running Items cannot be planned' }, 400)
		const selection = await readSolveSelection(c.req.json())
		const invalid = invalidSelection(c, selection)
		if (invalid) return invalid
		const effectiveSolverAgent = selection.solverAgent ?? config.solver.agent
		const effectiveSolverModel = selection.solverModel ?? config.solver.model
		// Like solverAgent, the request's solverWorkspace shapes THIS planning
		// session only and is never persisted by planning; unlike solverAgent it
		// also falls back to the Item's stored payload override so planning
		// artifacts land where the eventual run will read them.
		const effectiveWorkspace = effectiveSolverWorkspace(item, selection.solverWorkspace)
		const planningInMain = effectiveWorkspace === 'main'

		const projectConfig = config.projects.find(p => p.slug === item.projectSlug)
		if (!projectConfig) return c.json({ error: `Unknown project slug: ${item.projectSlug}` }, 400)
		if (planningInMain && !existsSync(projectConfig.repoPath)) {
			return c.json({ error: `Project checkout does not exist: ${projectConfig.repoPath}` }, 400)
		}

		const planningPrevious = item
		try {
			itemCommands.beginPlanning(item.id)
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
		}
		const abortPlanning = () => {
			itemCommands.abortPlanning(item.id, planningPrevious)
		}

		let sourceContext: TaskContext | null = null
		if (item.payload.kind === 'solve' && (item.capturedContext || item.source)) {
			try {
				sourceContext = await resolveItemSourceContext(item, provider)
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				abortPlanning()
				return c.json({ error: `Item source context failed to load: ${msg}` }, 502)
			}
			if (!sourceContext) {
				abortPlanning()
				return c.json({ error: 'Item source not found in source system' }, 502)
			}
		}
		// For a captured (email) Item, rewrite attachment URLs to worktree-local
		// paths so the planning agent's context.md points at the local copies (placed
		// below after the worktree exists) — symmetric with the solve path.
		const taskContext = item.capturedContext
			? localizeCapturedAttachments(buildItemTaskContext(item, sourceContext))
			: buildItemTaskContext(item, sourceContext)

		// Derive a conventional branch name before resolving identity, so planning
		// writes its worktree under the AI-chosen name (no-op unless enabled). Wire
		// the request's abort signal so the model call dies if the client gives up
		// instead of blocking the handler for the full one-shot timeout.
		// Main-workspace planning skips naming entirely: no branch is pre-created —
		// the session runs in the canonical checkout and the agent branches itself.
		let named: ItemRecord
		if (planningInMain) {
			named = item
		} else {
			try {
				named = await ensureItemWorkspaceName({
					commands: itemCommands,
					item,
					taskContext,
					config,
					repoPath: projectConfig.repoPath,
					agent: effectiveSolverAgent,
					signal: c.req.raw.signal,
					deps: aiDeps,
				})
			} catch (err) {
				abortPlanning()
				// Pass the request signal so an error coinciding with a client abort is
				// classified as cancellation (matching how ensureItemWorkspaceName re-throws),
				// not mis-reported as a 500.
				if (isCancellation(err, c.req.raw.signal)) return c.json({ error: 'Request aborted' }, 503)
				throw err
			}
		}
		const { baseRef, planDirName, branchName, existingWorktreePath } = resolveItemWorkspace(named)

		let itemSpawner: Spawner
		try {
			itemSpawner = await planningSpawnerForItem(item)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			abortPlanning()
			return c.json({ error: msg }, 400)
		}

		let worktreePath: string
		let hint: string
		try {
			// Main-workspace planning hands the spawner the canonical checkout as the
			// "existing worktree": both spawners reuse it as-is (no worktree creation,
			// no checkout mutation; okena reuses the repo's existing project window),
			// and planning artifacts land in the main repo's docs/plans.
			const session = await itemSpawner.startPlanningSession({
				projectConfig: { ...projectConfig, baseBranch: baseRef },
				branchName,
				planDirName,
				taskTitle: item.title,
				taskContext,
				solverConfig: {
					...config.solver,
					agent: effectiveSolverAgent,
					model: effectiveSolverModel,
					workspace: effectiveWorkspace,
				},
				existingWorktreePath: planningInMain ? projectConfig.repoPath : existingWorktreePath,
			})
			worktreePath = session.worktreePath
			hint = session.hint
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			abortPlanning()
			return c.json({ error: `Planning session failed to start: ${msg}` }, 500)
		}

		// Drop ingested attachments into the planning worktree (gitignored
		// .helm-attachments/) so the planning agent can open the local files the
		// localized context.md references. No-op for provider-backed Items.
		if (item.capturedContext) copyAttachmentsToWorktree(item.id, worktreePath)

		// Main mode: the Item's branchName stays NULL (no pre-created branch to
		// record); worktreePath/planDirName still persist so the run and the plan
		// preview find the artifacts in the canonical checkout.
		const recordedBranchName = planningInMain ? null : branchName
		const workspace = new PlanWorkspace(worktreePath, planDirName)
		workspace.writeReadme(buildItemPlanReadmeBody(item, recordedBranchName, planDirName))
		itemCommands.recordPlanPrepared(item.id, {
			worktreePath,
			branchName: recordedBranchName,
			planDirName,
			spawner: itemSpawner.name,
		})

		return c.json({
			data: {
				worktreePath,
				branchName: recordedBranchName,
				planDirName,
				readmePath: workspace.readmePath,
				spawner: itemSpawner.name,
				solverAgent: effectiveSolverAgent,
				hint,
			},
		})
	})

	// Manual AI passes — (re)run the cheap agent helpers on demand from the item
	// detail instead of waiting for the automatic enricher / pre-solve pass. Each
	// FORCES a fresh run (bypasses the "skip if already set" gates) and surfaces
	// failures as an error. `display-name` needs only the title; `branch-name`
	// (solve Items only, before a worktree exists) and `assess` resolve the task
	// context (captured/provider) first. The request abort signal is wired so a
	// client that gives up kills the one-shot model call.
	api.post('/items/:id/ai/:pass', async c => {
		const pass = c.req.param('pass')
		if (pass !== 'display-name' && pass !== 'branch-name' && pass !== 'assess') {
			return c.json({ error: `Unknown AI pass: ${pass}. Expected display-name, branch-name, or assess.` }, 400)
		}
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)

		const selection = await readSolveSelection(c.req.json())
		const invalid = invalidSelection(c, selection)
		if (invalid) return invalid
		const agent = selection.solverAgent ?? config.solver.agent
		const signal = c.req.raw.signal

		// branch-name has structural guards: solve-only, not running, and only before
		// a worktree exists — renaming the branch afterward would orphan the worktree.
		// Main-workspace Items never carry a pre-created branch (the agent branches
		// itself in the checkout), so there is nothing to name.
		if (pass === 'branch-name') {
			if (item.kind !== 'solve') return c.json({ error: 'Branch naming applies to solve Items only' }, 400)
			if (item.status === 'running') return c.json({ error: 'Cannot rename a running Item' }, 400)
			if (item.worktreePath) {
				return c.json({ error: 'Cannot rename the branch once a worktree exists — re-plan instead' }, 400)
			}
			if (effectiveSolverWorkspace(item, undefined) === 'main') {
				return c.json(
					{ error: 'Branch naming does not apply to main-workspace Items — the agent branches itself' },
					400,
				)
			}
		}

		const buildContext = async (): Promise<TaskContext> => {
			const sourceContext = item.capturedContext || item.source ? await resolveItemSourceContext(item, provider) : null
			return buildItemTaskContext(item, sourceContext)
		}

		try {
			let updated: ItemRecord
			if (pass === 'display-name') {
				updated = await ensureItemDisplayName({
					commands: itemCommands,
					item,
					config,
					agent,
					signal,
					deps: aiDeps,
					force: true,
				})
			} else if (pass === 'branch-name') {
				const projectConfig = config.projects.find(p => p.slug === item.projectSlug)
				if (!projectConfig) return c.json({ error: `Unknown project slug: ${item.projectSlug}` }, 400)
				updated = await ensureItemWorkspaceName({
					commands: itemCommands,
					item,
					taskContext: await buildContext(),
					config,
					repoPath: projectConfig.repoPath,
					agent,
					signal,
					deps: aiDeps,
					force: true,
				})
			} else {
				updated = await ensureItemAssessment({
					commands: itemCommands,
					item,
					taskContext: await buildContext(),
					config,
					agent,
					signal,
					deps: aiDeps,
					force: true,
				})
			}
			return c.json({ data: await dashboardItem(updated) })
		} catch (err) {
			if (isCancellation(err, signal)) return c.json({ error: 'Request aborted' }, 503)
			const msg = err instanceof Error ? err.message : String(err)
			return c.json({ error: `${pass} failed: ${msg}` }, 500)
		}
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

	/** "2 runs" / "1 run" — active-run phrasing shared by save + restart copy. */
	const activeRunsPhrase = (count: number) => (count === 1 ? '1 run' : `${count} runs`)

	// Update config (validates and writes to disk). The daemon only loads config
	// at startup, so a bare save would silently not apply: when it's safe (no
	// active runs, launchd-managed — KeepAlive respawns a clean exit with fresh
	// config), the daemon restarts itself right after the response flushes.
	// Killing run tracking mid-solve is worse than a stale config, so active
	// runs always defer; dev runs (npm run dev, no launchd) never self-exit.
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
		} catch (err) {
			return c.json({ error: `Failed to write config: ${err instanceof Error ? err.message : err}` }, 500)
		}
		const activeRuns = queue.getStatus().active
		if (activeRuns > 0) {
			return c.json({
				data: {
					message: `Saved. Restart the daemon to apply — ${activeRunsPhrase(activeRuns)} active.`,
					applied: false,
					pendingRuns: activeRuns,
				},
			})
		}
		if (!daemonControl.isManaged()) {
			return c.json({ data: { message: 'Saved. Restart the daemon to apply.', applied: false } })
		}
		scheduleDaemonRestart(daemonControl)
		return c.json({ data: { message: 'Saved — restarting to apply…', applied: true } })
	})

	// Explicit deferred restart (same guards as the config-save self-restart):
	// clients call this when a save answered { applied: false }.
	api.post('/daemon/restart', c => {
		const activeRuns = queue.getStatus().active
		if (activeRuns > 0) {
			const pronoun = activeRuns === 1 ? 'it' : 'them'
			return c.json(
				{ error: `${activeRunsPhrase(activeRuns)} active — wait for ${pronoun} to finish.`, pendingRuns: activeRuns },
				409,
			)
		}
		if (!daemonControl.isManaged()) {
			return c.json({ error: 'Daemon is not running under launchd — restart it manually.' }, 400)
		}
		scheduleDaemonRestart(daemonControl)
		return c.json({ data: { message: 'Restarting…', applied: true } })
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
