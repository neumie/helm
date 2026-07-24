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
	isInlineSafeContentType,
	isOpenableAttachment,
	readAttachment,
	removeItemAttachments,
	sanitizeAttachmentName,
	saveAttachment,
} from '../../attachments/store.js'
import { verifyLocalControlToken } from '../../auth/local-control.js'
import { type ResidentLeaseManager, verifyScopedCapability } from '../../auth/scoped-capability.js'
import { buildConfigDocument, parseConfigUpdate, parseConfigWithFallback } from '../../config-document.js'
import type { HelmConfig } from '../../config.js'
import type { DB } from '../../db/client.js'
import { ensureItemAssessment } from '../../items/assess.js'
import { ItemCommands } from '../../items/commands.js'
import { buildItemTaskContext, resolveItemSourceContext } from '../../items/context.js'
import { canCreateSourceTask, toDashboardItemWithSiblings, toDashboardItems } from '../../items/contract.js'
import type { ItemEnricher } from '../../items/enricher.js'
import { resolveItemWorkspace } from '../../items/identity.js'
import { ensureItemDisplayName, ensureItemWorkspaceName } from '../../items/naming.js'
import { observeItemRun } from '../../items/observation.js'
import { RunContextConflictError, runContextDraftSchema } from '../../items/run-context.js'
import { itemStatusSchema, solverEffortSchema } from '../../items/schema.js'
import type { ItemRecord, SolverEffort } from '../../items/schema.js'
import { PlanningApplication, PlanningError } from '../../plan/application.js'
import { PlanWorkspace } from '../../plan/workspace.js'
import type { Poller } from '../../poller/poller.js'
import type { ProfileRuntime, ProfileStore } from '../../profiles/store.js'
import { DAEMON_BUILD_ID, DAEMON_PROTOCOL_VERSION } from '../../protocol.js'
import type { TaskContext, TaskProvider } from '../../providers/provider.js'
import type { Drainer } from '../../queue/drainer.js'
import { ScheduleCommands } from '../../scheduled-runs/commands.js'
import { toScheduledRunContract, toScheduledScheduleContract } from '../../scheduled-runs/contract.js'
import {
	SCHEDULED_REPORT_SUMMARY_MAX_BYTES,
	attentionAdoptionIdentitySchema,
	scheduleCreateSchema,
	scheduleUpdateSchema,
} from '../../scheduled-runs/schema.js'
import type { ScheduledRunService } from '../../scheduled-runs/service.js'
import { ScheduleRevisionConflictError } from '../../scheduled-runs/store.js'
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
import { sameFilesystemPath } from '../../util/path-identity.js'
import { defaultDaemonControl, scheduleDaemonRestart } from '../restart.js'
import type { DaemonControl } from '../restart.js'

// Generic task ingest (e.g. an email tied to a project): a self-contained task
// with its content captured up front (no live provider to re-poll). Attachments
// arrive base64-encoded; capped so a single request can't blow up memory/disk.
const MAX_INGEST_ATTACHMENT_BYTES = 25 * 1024 * 1024
// Hard request-body cap enforced by `bodyLimit` middleware BEFORE the body is
// buffered/parsed — the per-field/attachment caps below only run post-parse.
// Generous enough for ~25MB of attachments after base64 (+33%) + JSON overhead.
const MAX_INGEST_BODY_BYTES = 40 * 1024 * 1024
// Local editor JSON is bounded before parsing too; the document schema applies
// tighter Markdown/block-state limits after this coarse transport cap.
const MAX_RUN_CONTEXT_BODY_BYTES = 1_250_000

export interface ScheduledRouteDependencies {
	service: ScheduledRunService
	controlToken: string
	residentLeases: ResidentLeaseManager
	/** Snapshot registered profile IDs before any cross-tenant lookup. */
	profileIds: () => string[]
}

export interface ProfileContext {
	store: ProfileStore
	/** Function in production; object compatibility keeps route fixtures concise. */
	runtime: ProfileRuntime | (() => ProfileRuntime)
	applyRuntime?: (runtime: ProfileRuntime) => void
	/** Named optional transport dependencies; avoids extending apiRoutes positional arguments. */
	scheduled?: ScheduledRouteDependencies
}

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

interface OkenaOpenResult {
	worktreePath: string
	projectId: string
	terminalId: string
	createdWorkspace: boolean
	focused: boolean
	notified: boolean
	activated: boolean
}

interface OkenaWorkspacePreview {
	state: 'open' | 'main' | 'register' | 'local' | 'remote' | 'create' | 'standalone' | 'unavailable'
	label: string
	detail: string
	branchName: string
	worktreePath?: string
}

type OkenaWorkspaceParams = {
	projectConfig: HelmConfig['projects'][number]
	workspaceMode: SolverWorkspace
	baseRef: string
	branchName: string
	existingWorktreePath?: string
}

type OpenItemInOkena = (params: OkenaWorkspaceParams) => Promise<OkenaOpenResult>
type InspectItemOkenaWorkspace = (params: OkenaWorkspaceParams) => Promise<OkenaWorkspacePreview>

function okenaOpenHint(opened: OkenaOpenResult): string {
	if (!opened.focused) return 'Workspace opened in Okena; its terminal is still becoming ready'
	if (opened.activated) return 'Focused in Okena'
	return 'Focused in Okena — switch to the Okena app'
}

const defaultOpenItemInOkena: OpenItemInOkena = async params => {
	// Okena remains an optional extension: core route loading must not require it.
	const extension = await import('../../extensions/okena/item-opener.js')
	return extension.openItemInOkena(params)
}

const defaultInspectItemOkenaWorkspace: InspectItemOkenaWorkspace = async params => {
	const extension = await import('../../extensions/okena/item-opener.js')
	return extension.inspectItemOkenaWorkspace(params)
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
	// Keeps the optional Okena extension dynamically loaded and route-testable.
	openItemInOkena: OpenItemInOkena = defaultOpenItemInOkena,
	inspectItemOkenaWorkspace: InspectItemOkenaWorkspace = defaultInspectItemOkenaWorkspace,
	profileContext?: ProfileContext,
	// Scheduled runs have durable processes outside the Drainer. This is a
	// read-only guard only; scheduled routes/admission remain out of this API.
	scheduledRestartBlocker?: { restartBlockingRunCount(): number },
) {
	const api = new Hono()
	if (profileContext) {
		api.use('*', (_c, next) => db.runInProfile(profileContext.store.activeProfile().id, next))
	}
	const itemCommands = new ItemCommands(db.items, config)
	const currentProfileRuntime = () => {
		const runtime = profileContext?.runtime
		return typeof runtime === 'function' ? runtime() : runtime
	}
	const aiDeps = aiOneShot ? { runOneShot: aiOneShot } : undefined
	const planning = new PlanningApplication(
		config,
		itemCommands,
		provider,
		spawner,
		createPlanningSpawner,
		aiDeps,
		// Planning is a long-lived saga. Bind the Item's tenant before the first
		// mutation/await so activation cannot redirect later lifecycle writes.
		profileId => new ItemCommands(db.forProfile(profileId).items, config),
	)
	const dashboardItem = async (item: ItemRecord) => ({
		...toDashboardItemWithSiblings(
			item,
			item.groupId ? itemCommands.listGroupItems(item.groupId) : [],
			await observeItemRun(item, { store: db.items }),
		),
		canCreateSourceTask: canCreateSourceTask(item, provider),
	})
	const resolveRunContextSource = async (item: ItemRecord): Promise<TaskContext> => {
		if (item.kind !== 'solve' || item.payload.kind !== 'solve') {
			throw new Error('Only solve Items have editable run context')
		}
		const expectsSource = item.capturedContext !== null || item.source !== null
		const source = expectsSource ? await resolveItemSourceContext(item, provider) : null
		if (expectsSource && !source) throw new Error('Item source not found in source system')
		return buildItemTaskContext(item, source)
	}
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
		solverEffort: SolverEffort | null | undefined
		solverEffortInvalid: boolean
		solverWorkspace: SolverWorkspace | null | undefined
		solverWorkspaceInvalid: boolean
	}

	async function readSolveSelection(bodyPromise: Promise<unknown>): Promise<SolveSelection> {
		const body = (await bodyPromise.catch(() => ({}))) as {
			solverAgent?: unknown
			solverModel?: unknown
			solverEffort?: unknown
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
		let solverEffort: SolveSelection['solverEffort']
		let solverEffortInvalid = false
		if (body.solverEffort === null) {
			solverEffort = null
		} else if (body.solverEffort !== undefined) {
			const parsed = solverEffortSchema.safeParse(body.solverEffort)
			if (parsed.success) solverEffort = parsed.data
			else solverEffortInvalid = true
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
		return {
			solverAgent,
			solverAgentInvalid,
			solverModel,
			solverModelInvalid,
			solverEffort,
			solverEffortInvalid,
			solverWorkspace,
			solverWorkspaceInvalid,
		}
	}

	function invalidSelection(c: Context, selection: SolveSelection) {
		if (selection.solverAgentInvalid) {
			return c.json({ error: `Invalid solverAgent. Must be one of: ${solverAgentSchema.options.join(', ')}` }, 400)
		}
		if (selection.solverModelInvalid) {
			return c.json({ error: 'Invalid solverModel. Must be a non-empty string (max 100 chars) or null.' }, 400)
		}
		if (selection.solverEffortInvalid) {
			return c.json(
				{ error: `Invalid solverEffort. Must be one of: ${solverEffortSchema.options.join(', ')} — or null.` },
				400,
			)
		}
		if (selection.solverWorkspaceInvalid) {
			return c.json(
				{ error: `Invalid solverWorkspace. Must be one of: ${solverWorkspaceSchema.options.join(', ')} — or null.` },
				400,
			)
		}
		return null
	}

	/** Pure projection used by Start validation; never write before Plan conflict exclusion. */
	function projectSolveSelection(item: ItemRecord, selection: SolveSelection): ItemRecord {
		if (item.kind !== 'solve' || item.payload.kind !== 'solve') return item
		const payload = { ...item.payload }
		if (selection.solverAgent) payload.solverAgent = selection.solverAgent
		if (selection.solverModel !== undefined) {
			if (selection.solverModel === null) payload.solverModel = undefined
			else payload.solverModel = selection.solverModel
		}
		if (selection.solverEffort !== undefined) {
			if (selection.solverEffort === null) payload.solverEffort = undefined
			else payload.solverEffort = selection.solverEffort
		}
		if (selection.solverWorkspace !== undefined) {
			if (selection.solverWorkspace === null) payload.solverWorkspace = undefined
			else payload.solverWorkspace = selection.solverWorkspace
		}
		return { ...item, payload }
	}

	function recordSolveSelection(item: ItemRecord, selection: SolveSelection): ItemRecord {
		if (item.kind !== 'solve') return item
		let updated = item
		if (selection.solverAgent) updated = itemCommands.setSolveItemAgent(item.id, selection.solverAgent)
		if (selection.solverModel !== undefined) updated = itemCommands.setSolveItemModel(item.id, selection.solverModel)
		if (selection.solverEffort !== undefined) updated = itemCommands.setSolveItemEffort(item.id, selection.solverEffort)
		if (selection.solverWorkspace !== undefined) {
			updated = itemCommands.setSolveItemWorkspace(item.id, selection.solverWorkspace)
		}
		return updated
	}

	function admissionFailure(c: Context, admission: ReturnType<Drainer['canProcessOneItem']>) {
		if (admission.ok) return null
		const lifecycleFailure = admission.reason === 'not_startable' || admission.reason === 'not_retryable'
		const message =
			admission.reason === 'stopped'
				? 'Drainer is stopped — new runs are temporarily unavailable'
				: admission.reason === 'quiescing'
					? 'Daemon is restarting — new runs are temporarily unavailable'
					: admission.reason === 'startup_fenced'
						? 'Daemon is restoring scheduled capacity — new runs are temporarily unavailable'
						: admission.reason === 'capacity'
							? 'The execution lane is at capacity — try again when a run finishes'
							: admission.reason === 'already_active'
								? 'Item is already running'
								: admission.reason === 'not_retryable'
									? 'Only failed, cancelled, done, or review Items can be retried'
									: 'Item is not ready to start'
		return c.json({ error: message }, lifecycleFailure ? 400 : 409)
	}

	/** Effective execution workspace for an Item: request override ?? stored payload ?? config. */
	function effectiveSolverWorkspace(item: ItemRecord, selected: SolverWorkspace | null | undefined): SolverWorkspace {
		const stored = item.payload.kind === 'solve' ? item.payload.solverWorkspace : undefined
		return selected ?? stored ?? config.solver.workspace ?? 'worktree'
	}

	function spawnerInstalled(name: string): boolean {
		return listSpawnerAdapters().some(adapter => adapter.available && adapter.name === name)
	}

	// Daemon status
	api.get('/status', c => {
		const queueStatus = queue.getStatus()
		const runtime = currentProfileRuntime()
		const activeProfile = runtime?.profile ?? {
			id: 'work',
			name: 'Work',
			enabledProjects: config.projects.map(project => project.slug),
			createdAt: '',
			archivedAt: null,
		}
		return c.json({
			data: {
				protocolVersion: DAEMON_PROTOCOL_VERSION,
				buildId: DAEMON_BUILD_ID,
				uptime: process.uptime(),
				queue: queueStatus,
				projects: config.projects.map(p => p.slug),
				pollInterval: config.polling.intervalSeconds,
				profile: activeProfile,
				profileGeneration: runtime?.generation ?? 1,
			},
		})
	})

	// Named profiles are daemon-global metadata. Items share one SQLite database;
	// activation changes only the tenant used for UI, polling, and new admission.
	// Already-running jobs retain their captured Item/profile scope.
	if (profileContext) {
		const configuredProjects = new Set(config.projects.map(project => project.slug))
		const profileInputSchema = z
			.object({
				name: z.string().optional(),
				enabledProjects: z.array(z.string()).optional(),
			})
			.strict()
		const parseProfileInput = async (c: Context) => {
			const parsed = profileInputSchema.safeParse(await c.req.json().catch(() => null))
			if (!parsed.success) return { error: c.json({ error: 'Invalid profile input' }, 400) }
			if (parsed.data.enabledProjects?.some(project => !configuredProjects.has(project))) {
				return { error: c.json({ error: 'Profile references an unknown configured project' }, 400) }
			}
			return { data: parsed.data }
		}

		api.get('/profiles', c =>
			c.json({
				data: {
					...profileContext.store.getState(),
					configuredProjects: config.projects.map(project => project.slug),
				},
			}),
		)

		api.post('/profiles', async c => {
			const input = await parseProfileInput(c)
			if ('error' in input) return input.error
			if (!input.data.name) return c.json({ error: 'Profile name is required' }, 400)
			try {
				const profile = profileContext.store.create(input.data.name, input.data.enabledProjects ?? [])
				return c.json({ data: { profile, state: profileContext.store.getState() } }, 201)
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
			}
		})

		api.put('/profiles/:id', async c => {
			const input = await parseProfileInput(c)
			if ('error' in input) return input.error
			const profileId = c.req.param('id')
			try {
				const profile = profileContext.store.update(profileId, input.data)
				if (profileId === profileContext.store.getState().activeProfileId) {
					profileContext.applyRuntime?.(profileContext.store.activeRuntime())
					poller.profileChanged()
				}
				return c.json({ data: { profile, state: profileContext.store.getState() } })
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
			}
		})

		api.post('/profiles/:id/archive', c => {
			try {
				const profile = profileContext.store.archive(c.req.param('id'))
				return c.json({ data: { profile, state: profileContext.store.getState() } })
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
			}
		})

		api.post('/profiles/:id/restore', c => {
			try {
				const profile = profileContext.store.restore(c.req.param('id'))
				return c.json({ data: { profile, state: profileContext.store.getState() } })
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
			}
		})

		api.post('/profiles/:id/activate', c => {
			const id = c.req.param('id')
			const current = profileContext.store.getState()
			if (id === current.activeProfileId) return c.json({ data: { state: current, applied: true } })
			try {
				const state = profileContext.store.activate(id)
				profileContext.applyRuntime?.(profileContext.store.activeRuntime())
				db.runInProfile(id, () => {
					queue.profileChanged()
					enricher.backfill()
				})
				poller.profileChanged()
				return c.json({ data: { state, applied: true } })
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
			}
		})
	}

	// Scheduled runs are intentionally a separately authenticated transport: extension
	// Item routes remain unauthenticated, while local control and scoped capabilities
	// gate every schedule mutation, resident lease, and reporter operation.
	const scheduled = profileContext?.scheduled
	if (scheduled) {
		const profileIdSchema = z.string().min(1).max(100)
		const revisionSchema = z.object({ revision: z.number().int().nonnegative() }).strict()
		const createScheduleRequestSchema = scheduleCreateSchema.extend({ profileId: profileIdSchema }).strict()
		const updateScheduleRequestSchema = scheduleUpdateSchema.extend({ profileId: profileIdSchema }).strict()
		const profileRequestSchema = z.object({ profileId: profileIdSchema }).strict()
		const leaseCapabilitySchema = z.object({ capability: z.string().min(1).max(200) }).strict()
		const adoptionRequestSchema = z
			.object({ profileId: profileIdSchema, revision: z.number().int().nonnegative() })
			.merge(attentionAdoptionIdentitySchema)
			.strict()
		const attachDescriptorRequestSchema = adoptionRequestSchema
			.extend({ capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
			.strict()
		const completeAdoptionRequestSchema = adoptionRequestSchema
			.extend({ ownershipRegistered: z.literal(true) })
			.strict()
		const reportRequestSchema = z
			.object({
				status: z.enum(['quiet', 'needs_attention']),
				summary: z
					.string()
					.min(1)
					.refine(
						value => Buffer.byteLength(value, 'utf8') <= SCHEDULED_REPORT_SUMMARY_MAX_BYTES,
						`must be at most ${SCHEDULED_REPORT_SUMMARY_MAX_BYTES} UTF-8 bytes`,
					),
			})
			.strict()
		const scheduledBody = bodyLimit({ maxSize: 96 * 1024 })
		const reportBody = bodyLimit({ maxSize: 8 * 1024 })
		const registeredProfile = (profileId: string) => scheduled.profileIds().includes(profileId)
		const storeFor = (profileId: string) => db.forProfile(profileId).schedules
		const commandsFor = (profileId: string) =>
			new ScheduleCommands(storeFor(profileId), config.scheduledRuns.systemTargetsEnabled)
		const controlAuthorized = (c: Context) => {
			const authorization = c.req.header('Authorization') ?? ''
			const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
			return !!match && verifyLocalControlToken(match[1], scheduled.controlToken)
		}
		const leaseAuthorized = (capability: string) => {
			if (!leaseCapabilitySchema.safeParse({ capability }).success) return false
			return scheduled.residentLeases.isHeld(capability)
		}
		const requireControl = (c: Context): Response | null =>
			controlAuthorized(c) ? null : c.json({ error: 'Scheduled control authorization required' }, 401)
		const parseBody = async <T>(c: Context, schema: z.ZodType<T>): Promise<{ data: T } | { error: Response }> => {
			try {
				const parsed = schema.safeParse(await c.req.json())
				return parsed.success
					? { data: parsed.data }
					: { error: c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400) }
			} catch {
				return { error: c.json({ error: 'Invalid JSON body' }, 400) }
			}
		}
		const queryProfile = (c: Context): { profileId: string } | { error: Response } => {
			const parsed = profileIdSchema.safeParse(c.req.query('profileId'))
			if (!parsed.success) return { error: c.json({ error: 'A valid profileId is required' }, 400) }
			if (!registeredProfile(parsed.data)) return { error: c.json({ error: 'Scheduled profile not found' }, 404) }
			return { profileId: parsed.data }
		}
		const scheduledError = (c: Context, error: unknown, status: 400 | 409 = 400): Response => {
			if (error instanceof ScheduleRevisionConflictError) return c.json({ error: 'Scheduled revision conflict' }, 409)
			return c.json({ error: error instanceof Error ? error.message : String(error) }, status)
		}

		api.get('/scheduled-runs', c => {
			const denied = requireControl(c)
			if (denied) return denied
			const target = queryProfile(c)
			if ('error' in target) return target.error
			return c.json({ data: storeFor(target.profileId).list().map(toScheduledScheduleContract) })
		})
		api.post('/scheduled-runs', scheduledBody, async c => {
			const denied = requireControl(c)
			if (denied) return denied
			const input = await parseBody(c, createScheduleRequestSchema)
			if ('error' in input) return input.error
			if (!registeredProfile(input.data.profileId)) return c.json({ error: 'Scheduled profile not found' }, 404)
			try {
				const { profileId, ...definition } = input.data
				return c.json({ data: toScheduledScheduleContract(commandsFor(profileId).create(definition)) }, 201)
			} catch (error) {
				return scheduledError(c, error)
			}
		})
		api.get('/scheduled-runs/runs/:runId', c => {
			const denied = requireControl(c)
			if (denied) return denied
			const target = queryProfile(c)
			if ('error' in target) return target.error
			const run = storeFor(target.profileId).getRun(c.req.param('runId'))
			return run ? c.json({ data: toScheduledRunContract(run) }) : c.json({ error: 'Scheduled run not found' }, 404)
		})
		const adoptionUnavailable = (c: Context) => c.json({ error: 'Scheduled attention adoption unavailable' }, 409)
		const adoptionProfile = (profileId: string): boolean => registeredProfile(profileId)
		for (const [action, schema] of [
			['reserve', adoptionRequestSchema],
			['attach-descriptor', attachDescriptorRequestSchema],
			['complete', completeAdoptionRequestSchema],
			['rollback', adoptionRequestSchema],
		] as const) {
			api.post(`/scheduled-runs/runs/:runId/attention-adoption/${action}`, scheduledBody, async c => {
				c.header('Cache-Control', 'no-store')
				const denied = requireControl(c)
				if (denied) return denied
				const input = await parseBody(c, schema)
				if ('error' in input) return input.error
				if (!adoptionProfile(input.data.profileId)) return adoptionUnavailable(c)
				try {
					const identity = { adoptionId: input.data.adoptionId, adopter: input.data.adopter }
					if (action === 'reserve') {
						const result = await scheduled.service.reserveAttentionAdoption(
							input.data.profileId,
							c.req.param('runId'),
							input.data.revision,
							identity,
						)
						return c.json({ data: toScheduledRunContract(result.run), adoption: result.grant })
					}
					if (action === 'attach-descriptor') {
						const attach = input.data as z.infer<typeof attachDescriptorRequestSchema>
						const result = await scheduled.service.attachAttentionDescriptor(
							attach.profileId,
							c.req.param('runId'),
							attach.revision,
							{ adoptionId: attach.adoptionId, adopter: attach.adopter },
							attach.capability,
						)
						return c.json({ data: result })
					}
					const result =
						action === 'complete'
							? (() => {
									const complete = input.data as z.infer<typeof completeAdoptionRequestSchema>
									return scheduled.service.completeAttentionAdoption(
										complete.profileId,
										c.req.param('runId'),
										complete.revision,
										{ adoptionId: complete.adoptionId, adopter: complete.adopter },
										complete.ownershipRegistered,
									)
								})()
							: scheduled.service.rollbackAttentionAdoption(
									input.data.profileId,
									c.req.param('runId'),
									input.data.revision,
									identity,
								)
					return c.json({ data: toScheduledRunContract(result) })
				} catch {
					return adoptionUnavailable(c)
				}
			})
		}
		api.post('/scheduled-runs/runs/:runId/cancel', scheduledBody, async c => {
			const denied = requireControl(c)
			if (denied) return denied
			const input = await parseBody(c, profileRequestSchema)
			if ('error' in input) return input.error
			if (!registeredProfile(input.data.profileId)) return c.json({ error: 'Scheduled profile not found' }, 404)
			if (!storeFor(input.data.profileId).getRun(c.req.param('runId')))
				return c.json({ error: 'Scheduled run not found' }, 404)
			try {
				return c.json({
					data: toScheduledRunContract(await scheduled.service.cancel(input.data.profileId, c.req.param('runId'))),
				})
			} catch (error) {
				return scheduledError(c, error, 409)
			}
		})
		api.get('/scheduled-runs/:id/history', c => {
			const denied = requireControl(c)
			if (denied) return denied
			const target = queryProfile(c)
			if ('error' in target) return target.error
			const parsedLimit = z.coerce
				.number()
				.int()
				.min(1)
				.max(100)
				.safeParse(c.req.query('limit') ?? '50')
			if (!parsedLimit.success) return c.json({ error: 'limit must be an integer from 1 to 100' }, 400)
			if (!storeFor(target.profileId).get(c.req.param('id')))
				return c.json({ error: 'Scheduled definition not found' }, 404)
			return c.json({
				data: storeFor(target.profileId).listRuns(c.req.param('id'), parsedLimit.data).map(toScheduledRunContract),
			})
		})
		api.get('/scheduled-runs/:id', c => {
			const denied = requireControl(c)
			if (denied) return denied
			const target = queryProfile(c)
			if ('error' in target) return target.error
			const schedule = storeFor(target.profileId).get(c.req.param('id'))
			return schedule
				? c.json({ data: toScheduledScheduleContract(schedule) })
				: c.json({ error: 'Scheduled definition not found' }, 404)
		})
		api.put('/scheduled-runs/:id', scheduledBody, async c => {
			const denied = requireControl(c)
			if (denied) return denied
			const input = await parseBody(c, updateScheduleRequestSchema)
			if ('error' in input) return input.error
			if (!registeredProfile(input.data.profileId)) return c.json({ error: 'Scheduled profile not found' }, 404)
			try {
				const { profileId, revision, ...definition } = input.data
				return c.json({
					data: toScheduledScheduleContract(commandsFor(profileId).update(c.req.param('id'), revision, definition)),
				})
			} catch (error) {
				return scheduledError(c, error)
			}
		})
		for (const action of ['archive', 'enable', 'disable'] as const) {
			api.post(`/scheduled-runs/:id/${action}`, scheduledBody, async c => {
				const denied = requireControl(c)
				if (denied) return denied
				const input = await parseBody(c, revisionSchema.extend({ profileId: profileIdSchema }).strict())
				if ('error' in input) return input.error
				if (!registeredProfile(input.data.profileId)) return c.json({ error: 'Scheduled profile not found' }, 404)
				try {
					const commands = commandsFor(input.data.profileId)
					const result =
						action === 'archive'
							? commands.archive(c.req.param('id'), input.data.revision)
							: action === 'enable'
								? commands.enable(c.req.param('id'), input.data.revision)
								: commands.disable(c.req.param('id'), input.data.revision)
					return c.json({ data: toScheduledScheduleContract(result) })
				} catch (error) {
					return scheduledError(c, error)
				}
			})
		}
		api.post('/scheduled-runs/:id/run', scheduledBody, async c => {
			const denied = requireControl(c)
			if (denied) return denied
			const input = await parseBody(c, profileRequestSchema)
			if ('error' in input) return input.error
			if (!registeredProfile(input.data.profileId)) return c.json({ error: 'Scheduled profile not found' }, 404)
			if (!storeFor(input.data.profileId).get(c.req.param('id')))
				return c.json({ error: 'Scheduled definition not found' }, 404)
			try {
				return c.json({
					data: toScheduledRunContract(await scheduled.service.runNow(input.data.profileId, c.req.param('id'))),
				})
			} catch (error) {
				return scheduledError(c, error, 409)
			}
		})
		api.post('/scheduled-runs/lease', c => {
			const denied = requireControl(c)
			if (denied) return denied
			return c.json({ data: scheduled.residentLeases.issue() })
		})
		api.post('/scheduled-runs/lease/heartbeat', scheduledBody, async c => {
			const input = await parseBody(c, leaseCapabilitySchema)
			if ('error' in input) return input.error
			const lease = scheduled.residentLeases.heartbeat(input.data.capability)
			return lease ? c.json({ data: lease }) : c.json({ error: 'Resident lease is invalid or expired' }, 401)
		})
		api.post('/scheduled-runs/lease/tick', scheduledBody, async c => {
			const input = await parseBody(c, leaseCapabilitySchema)
			if ('error' in input) return input.error
			if (!leaseAuthorized(input.data.capability)) return c.json({ error: 'Resident lease is invalid or expired' }, 401)
			return c.json({ data: await scheduled.service.tick() })
		})
		api.post('/scheduled-runs/lease/revoke', scheduledBody, async c => {
			const input = await parseBody(c, leaseCapabilitySchema)
			if ('error' in input) return input.error
			return scheduled.residentLeases.revoke(input.data.capability)
				? c.json({ data: { revoked: true } })
				: c.json({ error: 'Resident lease is invalid or expired' }, 401)
		})
		api.post('/scheduled-runs/:runId/report', reportBody, async c => {
			const authorization = c.req.header('Authorization') ?? ''
			const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
			if (!match) return c.json({ error: 'Scheduled report authorization required' }, 401)
			const input = await parseBody(c, reportRequestSchema)
			if ('error' in input) return input.error
			const candidates = scheduled.profileIds().flatMap(profileId => {
				const run = db.forProfile(profileId).schedules.getRun(c.req.param('runId'))
				return run?.reportTokenHash && verifyScopedCapability(match[1], run.reportTokenHash) ? [{ profileId, run }] : []
			})
			if (candidates.length !== 1) return c.json({ error: 'Scheduled report authorization required' }, 401)
			try {
				return c.json({
					data: toScheduledRunContract(
						await scheduled.service.report(
							candidates[0].profileId,
							candidates[0].run.id,
							input.data.status,
							input.data.summary,
						),
					),
				})
			} catch (error) {
				return scheduledError(c, error, 409)
			}
		})
	}

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
		const ingestProfileId = db.currentProfileId()
		try {
			// Relative, same-origin URL: the dashboard renders it regardless of the
			// host it reached the daemon on; the worker/plan route rewrite it to a
			// worktree-local path at run time.
			const savedAttachments = (input.attachments ?? []).map(a => {
				const finalName = saveAttachment(id, a.name, Buffer.from(a.dataBase64, 'base64'), ingestProfileId)
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
			removeItemAttachments(id, ingestProfileId)
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
		const bytes = readAttachment(item.id, name, item.profileId)
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
		const path = attachmentPath(item.id, name, item.profileId)
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

		// Okena preview is detail-only and read-only: it may inspect local/remote
		// refs and the Okena registry, but never creates/focuses a workspace. The
		// POST recomputes at click time, so this advisory value can safely go stale.
		let okenaWorkspace: OkenaWorkspacePreview | null = null
		const projectConfig = config.projects.find(project => project.slug === item.projectSlug)
		if (projectConfig) {
			const identity = resolveItemWorkspace(item)
			const workspaceMode = item.payload.kind === 'solve' ? effectiveSolverWorkspace(item, undefined) : 'worktree'
			try {
				okenaWorkspace = await inspectItemOkenaWorkspace({
					projectConfig,
					workspaceMode,
					baseRef: identity.baseRef,
					branchName: identity.branchName,
					existingWorktreePath: workspaceMode === 'main' ? undefined : identity.existingWorktreePath,
				})
			} catch (err) {
				log.warn(
					'api',
					`Failed to inspect Okena workspace for Item ${item.id}: ${err instanceof Error ? err.message : err}`,
				)
			}
		}
		return c.json({ data: { ...(await dashboardItem(item)), sourceTask, planArtifacts, okenaWorkspace } })
	})

	api.get('/items/:id/run-context', async c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		if (item.kind !== 'solve') return c.json({ error: 'Only solve Items have editable run context' }, 400)
		try {
			const source = await resolveRunContextSource(item)
			return c.json({
				data: {
					item: { id: item.id, title: item.title, projectSlug: item.projectSlug, status: item.status },
					source,
					document: item.runContext,
					revision: item.runContextRevision,
				},
			})
		} catch (err) {
			// A saved Helm-owned override remains useful when its live provider is
			// temporarily unavailable. Return a minimal source shell so the editor
			// can open the persisted document; an unsaved Item still needs the live
			// source to seed its first draft. Reset intentionally keeps requiring it.
			if (item.runContext) {
				log.warn(
					'api',
					`Live source unavailable for saved run context ${item.id}: ${err instanceof Error ? err.message : err}`,
				)
				return c.json({
					data: {
						item: { id: item.id, title: item.title, projectSlug: item.projectSlug, status: item.status },
						source: { title: item.title },
						document: item.runContext,
						revision: item.runContextRevision,
					},
				})
			}
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
		}
	})

	api.put('/items/:id/run-context', bodyLimit({ maxSize: MAX_RUN_CONTEXT_BODY_BYTES }), async c => {
		const parsed = z
			.object({ revision: z.number().int().nonnegative(), document: runContextDraftSchema })
			.strict()
			.safeParse(await c.req.json().catch(() => null))
		if (!parsed.success) return c.json({ error: 'Invalid run context', details: parsed.error.flatten() }, 400)
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		try {
			const updated = itemCommands.setRunContext(item.id, parsed.data.document, parsed.data.revision)
			return c.json({ data: { document: updated.runContext, revision: updated.runContextRevision } })
		} catch (err) {
			if (err instanceof RunContextConflictError) {
				const latest = itemCommands.getItem(item.id)
				return c.json(
					{ error: err.message, revision: latest?.runContextRevision, document: latest?.runContext ?? null },
					409,
				)
			}
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
		}
	})

	api.post('/items/:id/run-context/reset', bodyLimit({ maxSize: 4 * 1024 }), async c => {
		const parsed = z
			.object({ revision: z.number().int().nonnegative() })
			.strict()
			.safeParse(await c.req.json().catch(() => null))
		if (!parsed.success) return c.json({ error: 'Invalid run context reset', details: parsed.error.flatten() }, 400)
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Not found' }, 404)
		if (item.kind !== 'solve') return c.json({ error: 'Only solve Items have editable run context' }, 400)
		if (item.runContextRevision !== parsed.data.revision) {
			return c.json({ error: 'Run context changed in another editor' }, 409)
		}
		let source: TaskContext
		try {
			// Fetch first: a provider outage must leave the saved document untouched.
			source = await resolveRunContextSource(item)
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
		}
		try {
			const updated = itemCommands.setRunContext(item.id, null, parsed.data.revision)
			return c.json({ data: { source, document: null, revision: updated.runContextRevision } })
		} catch (err) {
			if (err instanceof RunContextConflictError) return c.json({ error: err.message }, 409)
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
		}
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
			enricher.enqueue(items)
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
		if (item.kind !== 'solve' && item.kind !== 'loop')
			return c.json({ error: 'Only solve or loop Items can be started by this drainer' }, 400)
		const projectedItem = projectSolveSelection(item, selection)
		const projectedSolvePayload = projectedItem.payload.kind === 'solve' ? projectedItem.payload : undefined
		const plannedActive = item.status === 'active' && item.workMode === 'manual' && item.plannedAt != null
		if (item.status !== 'ready' && item.status !== 'inbox' && !plannedActive)
			return c.json({ error: 'Item is not ready to start' }, 400)
		const requested = (body as { executionMode?: unknown }).executionMode
		let plannedLoop: { prdPath: string; iterations: number } | undefined
		if (plannedActive && projectedSolvePayload) {
			if (requested !== 'agent' && requested !== 'loop')
				return c.json({ error: 'Planned Items require executionMode: agent or loop' }, 400)
			if (requested === 'loop') {
				const workspaceMode = effectiveSolverWorkspace(projectedItem, undefined)
				const projectConfig = config.projects.find(project => project.slug === item.projectSlug)
				if (!projectConfig) return c.json({ error: `Unknown project slug: ${item.projectSlug}` }, 400)
				if (!item.planDirName || !item.worktreePath || !existsSync(item.worktreePath))
					return c.json({ error: 'Planned workspace is missing. Re-plan the Item before starting a loop.' }, 400)
				if (workspaceMode === 'main' && !sameFilesystemPath(item.worktreePath, projectConfig.repoPath))
					return c.json(
						{
							error:
								'This plan was prepared in a Worktree. Re-plan with Workspace set to Main before starting a loop in Main.',
						},
						400,
					)
				try {
					const loopWorkspacePath = workspaceMode === 'main' ? projectConfig.repoPath : item.worktreePath
					const prdPath = new PlanWorkspace(loopWorkspacePath, item.planDirName).loopArtifactPath()
					const localTickets = item.planStatus?.localTickets
					const githubTickets = item.planStatus?.githubTickets
					const ticketTotal = (localTickets?.total ?? 0) + (githubTickets?.total ?? 0)
					const agentReadyTickets = (localTickets?.readyForAgent ?? 0) + (githubTickets?.readyForAgent ?? 0)
					if (ticketTotal > 0 && agentReadyTickets === 0)
						return c.json({ error: 'This plan has tickets, but none are ready for an agent.' }, 400)
					plannedLoop = { prdPath, iterations: agentReadyTickets > 0 ? agentReadyTickets : 10 }
				} catch (err) {
					return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
				}
			}
		}
		try {
			planning.assertStartAllowed(item.id)
			// Selection and execution writes must follow admission in the same
			// synchronous turn. A rejected Start therefore cannot alter a future run.
			const requestedLane =
				plannedActive && projectedSolvePayload ? (requested === 'loop' ? 'loop' : 'solve') : undefined
			const admission = queue.canProcessOneItem(item.id, requestedLane)
			const rejected = admissionFailure(c, admission)
			if (rejected) return rejected
			recordSolveSelection(item, selection)
			const selectedItem = itemCommands.getItem(item.id) ?? item
			if (plannedActive && selectedItem.payload.kind === 'solve') {
				if (plannedLoop)
					itemCommands.setSolveExecution(item.id, {
						mode: 'loop',
						prdPath: plannedLoop.prdPath,
						options: {
							mode: 'afk',
							iterations: plannedLoop.iterations,
							provider: projectedSolvePayload?.solverAgent ?? config.solver.agent,
							model: projectedSolvePayload?.solverModel ?? config.solver.model,
							effort: projectedSolvePayload?.solverEffort,
						},
					})
				else itemCommands.setSolveExecution(item.id, { mode: 'solver' })
			}
			const started = queue.processOneItem(item.id)
			if (!started) return c.json({ error: 'Could not start Item' }, 500)
			return c.json({ data: await dashboardItem(itemCommands.getItem(item.id) ?? item) })
		} catch (err) {
			if (err instanceof PlanningError && err.code === 'planning_conflict') return c.json({ error: err.message }, 409)
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
		}
	})

	api.post('/items/:id/retry', async c => {
		const selection = await readSolveSelection(c.req.json())
		const invalid = invalidSelection(c, selection)
		if (invalid) return invalid
		try {
			const current = itemCommands.getItem(c.req.param('id'))
			if (!current) return c.json({ error: 'Item not found' }, 404)
			// Retry lifecycle validation is admission-only until this point; do not
			// persist a new selection on a status the command would reject.
			const admission = queue.canRetryItem(current.id)
			const rejected = admissionFailure(c, admission)
			if (rejected) return rejected
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

	api.post('/items/:id/open-okena', async c => {
		const item = itemCommands.getItem(c.req.param('id'))
		if (!item) return c.json({ error: 'Item not found' }, 404)
		const projectConfig = config.projects.find(project => project.slug === item.projectSlug)
		if (!projectConfig) return c.json({ error: `Unknown project slug: ${item.projectSlug}` }, 400)

		const identity = resolveItemWorkspace(item)
		const workspaceMode = item.payload.kind === 'solve' ? effectiveSolverWorkspace(item, undefined) : 'worktree'
		if (item.status === 'running' && workspaceMode !== 'main' && !identity.existingWorktreePath) {
			return c.json({ error: 'The running Item has not prepared its worktree yet. Try again shortly.' }, 409)
		}

		try {
			const opened = await openItemInOkena({
				projectConfig,
				workspaceMode,
				baseRef: identity.baseRef,
				branchName: identity.branchName,
				existingWorktreePath: workspaceMode === 'main' ? undefined : identity.existingWorktreePath,
			})
			if (opened.createdWorkspace && workspaceMode !== 'main') {
				itemCommands.recordOkenaWorkspaceIdentity(item.id, {
					worktreePath: opened.worktreePath,
					branchName: identity.branchName,
					planDirName: identity.planDirName,
				})
			}
			return c.json({
				data: {
					...opened,
					hint: okenaOpenHint(opened),
				},
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			log.error('okena', `Could not open Item ${item.id} in Okena`, err)
			return c.json({ error: `Could not open in Okena: ${message}` }, message.includes('not running') ? 503 : 500)
		}
	})

	api.post('/items/:id/plan', async c => {
		const selection = await readSolveSelection(c.req.json())
		const invalid = invalidSelection(c, selection)
		if (invalid) return invalid
		try {
			const prepared = await planning.prepare({
				itemId: c.req.param('id'),
				solverAgent: selection.solverAgent,
				solverModel: selection.solverModel,
				solverWorkspace: selection.solverWorkspace,
				signal: c.req.raw.signal,
			})
			return c.json({ data: prepared })
		} catch (err) {
			if (!(err instanceof PlanningError)) throw err
			const status =
				err.code === 'not_found'
					? 404
					: err.code === 'planning_conflict'
						? 409
						: err.code === 'source_unavailable'
							? 502
							: err.code === 'cancelled'
								? 503
								: err.code === 'launch_failed' || err.code === 'finalization_failed'
									? 500
									: 400
			return c.json({ error: err.message, ...(err.sessionMayExist ? { sessionMayExist: true } : {}) }, status)
		}
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
	const pendingRunCount = () => queue.getStatus().active + (scheduledRestartBlocker?.restartBlockingRunCount() ?? 0)

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
		const activeRuns = pendingRunCount()
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
		if (!queue.quiesce()) {
			if (queue.isQuiescing()) {
				return c.json({ data: { message: 'Saved — restart already pending…', applied: true } })
			}
			const pendingRuns = pendingRunCount()
			return c.json({
				data: {
					message: `Saved. Restart the daemon to apply — ${activeRunsPhrase(pendingRuns)} active.`,
					applied: false,
					pendingRuns,
				},
			})
		}
		scheduleDaemonRestart(daemonControl)
		return c.json({ data: { message: 'Saved — restarting to apply…', applied: true } })
	})

	// Explicit deferred restart (same guards as the config-save self-restart):
	// clients call this when a save answered { applied: false }.
	api.post('/daemon/restart', c => {
		const activeRuns = pendingRunCount()
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
		if (!queue.quiesce()) {
			if (queue.isQuiescing()) return c.json({ data: { message: 'Restarting…', applied: true } })
			const pendingRuns = pendingRunCount()
			const pronoun = pendingRuns === 1 ? 'it' : 'them'
			return c.json(
				{ error: `${activeRunsPhrase(pendingRuns)} active — wait for ${pronoun} to finish.`, pendingRuns },
				409,
			)
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
