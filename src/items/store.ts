import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { itemRecordSchema } from './schema.js'
import type { DeployState, ItemKind, ItemPayload, ItemRecord, ItemSource, ItemStatus } from './schema.js'

export interface CreateItemInput {
	id?: string
	kind: ItemKind
	status: ItemStatus
	projectSlug: string
	title: string
	source?: ItemSource | null
	baseRef: string
	spawner?: string | null
	groupId?: string | null
	payload: unknown
}

export interface ItemEvent {
	id: number
	itemId: string
	eventType: string
	payload: string | null
	createdAt: string
}

type ItemUpdateInput = Partial<
	Pick<
		ItemRecord,
		| 'status'
		| 'queuedAt'
		| 'startedAt'
		| 'completedAt'
		| 'worktreePath'
		| 'branchName'
		| 'planDirName'
		| 'almanacRunId'
		| 'errorMessage'
		| 'errorPhase'
		| 'resultSummary'
		| 'solveInputSnapshot'
		| 'prUrl'
		| 'runOutcome'
	>
>

const ITEM_UPDATE_COLUMNS = {
	status: 'status',
	queuedAt: 'queued_at',
	startedAt: 'started_at',
	completedAt: 'completed_at',
	worktreePath: 'worktree_path',
	branchName: 'branch_name',
	planDirName: 'plan_dir_name',
	almanacRunId: 'almanac_run_id',
	errorMessage: 'error_message',
	errorPhase: 'error_phase',
	resultSummary: 'result_summary',
	solveInputSnapshot: 'solve_input_snapshot',
	prUrl: 'pr_url',
	runOutcome: 'run_outcome',
} satisfies Record<keyof ItemUpdateInput, string>

function readJson(value: unknown, field: string): unknown {
	if (value === null || value === undefined) return null
	if (typeof value !== 'string') throw new Error(`Item row ${field} is not a JSON string`)
	try {
		return JSON.parse(value)
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		throw new Error(`Item row ${field} is invalid JSON: ${msg}`)
	}
}

function validateItem(candidate: unknown): ItemRecord {
	const parsed = itemRecordSchema.safeParse(candidate)
	if (!parsed.success) {
		throw new Error(`Item validation failed: ${parsed.error.message}`)
	}
	if (parsed.data.payload.kind !== parsed.data.kind) {
		throw new Error(`Item payload kind "${parsed.data.payload.kind}" does not match item kind "${parsed.data.kind}"`)
	}
	return parsed.data
}

export class ItemStore {
	constructor(private readonly db: Database.Database) {}

	create(input: CreateItemInput): ItemRecord {
		const now = new Date().toISOString()
		const item = validateItem({
			id: input.id ?? randomUUID(),
			kind: input.kind,
			status: input.status,
			projectSlug: input.projectSlug,
			title: input.title,
			displayName: null,
			source: input.source ?? null,
			baseRef: input.baseRef,
			spawner: input.spawner ?? null,
			groupId: input.groupId ?? null,
			payload: input.payload,
			worktreePath: null,
			branchName: null,
			planDirName: null,
			almanacRunId: null,
			createdAt: now,
			queuedAt: input.status === 'queued' ? now : null,
			startedAt: null,
			completedAt: null,
			updatedAt: now,
			errorMessage: null,
			errorPhase: null,
			resultSummary: null,
			solveInputSnapshot: null,
			prUrl: null,
			runOutcome: null,
			deployState: null,
		})

		this.db
			.prepare(
				`INSERT INTO items (
					id, kind, status, project_slug, title, display_name, source, base_ref, spawner, group_id, payload,
					worktree_path, branch_name, plan_dir_name, almanac_run_id,
					created_at, queued_at, started_at, completed_at, updated_at,
					error_message, error_phase, result_summary, solve_input_snapshot, pr_url, run_outcome, deploy_state
				) VALUES (
					@id, @kind, @status, @projectSlug, @title, @displayName, @source, @baseRef, @spawner, @groupId, @payload,
					@worktreePath, @branchName, @planDirName, @almanacRunId,
					@createdAt, @queuedAt, @startedAt, @completedAt, @updatedAt,
					@errorMessage, @errorPhase, @resultSummary, @solveInputSnapshot, @prUrl, @runOutcome, @deployState
				)`,
			)
			.run(this.toDbParams(item))

		const created = this.get(item.id)
		if (!created) throw new Error('Item not found after insert')
		return created
	}

	get(id: string): ItemRecord | null {
		const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown> | undefined
		return row ? this.rowToItem(row) : null
	}

	findBySourceExternalId(externalId: string): ItemRecord | null {
		const rows = this.db
			.prepare('SELECT * FROM items WHERE source IS NOT NULL ORDER BY created_at DESC')
			.all() as Record<string, unknown>[]
		for (const row of rows) {
			const item = this.rowToItem(row)
			if (item.source?.externalId === externalId) return item
		}
		return null
	}

	listByGroupId(groupId: string): ItemRecord[] {
		const rows = this.db
			.prepare('SELECT * FROM items WHERE group_id = ? ORDER BY created_at ASC, rowid ASC')
			.all(groupId) as Record<string, unknown>[]
		return rows.map(row => this.rowToItem(row))
	}

	update(id: string, fields: ItemUpdateInput): ItemRecord {
		const sets: string[] = []
		const values: unknown[] = []
		for (const [key, value] of Object.entries(fields) as [keyof ItemUpdateInput, unknown][]) {
			const col = ITEM_UPDATE_COLUMNS[key]
			if (!col) throw new Error(`updateItem: unknown item field "${key}"`)
			sets.push(`${col} = ?`)
			values.push(value)
		}

		if (sets.length > 0) {
			const current = this.get(id)
			if (!current) throw new Error(`Item not found: ${id}`)
			const updatedAt = new Date().toISOString()
			validateItem({ ...current, ...fields, updatedAt })
			sets.push('updated_at = ?')
			values.push(updatedAt, id)
			const result = this.db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...values)
			if (result.changes === 0) throw new Error(`Item not found: ${id}`)
		}

		const updated = this.get(id)
		if (!updated) throw new Error(`Item not found: ${id}`)
		return updated
	}

	// deployState is a JSON object column (like source/payload), so it gets a
	// dedicated serializing writer rather than the scalar generic `update`.
	updateDeployState(id: string, deployState: DeployState | null): ItemRecord {
		const current = this.get(id)
		if (!current) throw new Error(`Item not found: ${id}`)
		const updatedAt = new Date().toISOString()
		validateItem({ ...current, deployState, updatedAt })
		const result = this.db
			.prepare('UPDATE items SET deploy_state = ?, updated_at = ? WHERE id = ?')
			.run(deployState ? JSON.stringify(deployState) : null, updatedAt, id)
		if (result.changes === 0) throw new Error(`Item not found: ${id}`)
		const updated = this.get(id)
		if (!updated) throw new Error(`Item not found: ${id}`)
		return updated
	}

	// Cosmetic short label; dedicated writer keeps it off the lifecycle update surface.
	updateDisplayName(id: string, displayName: string | null): ItemRecord {
		const current = this.get(id)
		if (!current) throw new Error(`Item not found: ${id}`)
		const updatedAt = new Date().toISOString()
		validateItem({ ...current, displayName, updatedAt })
		const result = this.db
			.prepare('UPDATE items SET display_name = ?, updated_at = ? WHERE id = ?')
			.run(displayName, updatedAt, id)
		if (result.changes === 0) throw new Error(`Item not found: ${id}`)
		const updated = this.get(id)
		if (!updated) throw new Error(`Item not found: ${id}`)
		return updated
	}

	// Source items still awaiting an AI display name — work-list for the backfill namer.
	listSourceItemsMissingDisplayName(): ItemRecord[] {
		const rows = this.db
			.prepare('SELECT * FROM items WHERE source IS NOT NULL AND display_name IS NULL ORDER BY created_at DESC')
			.all() as Record<string, unknown>[]
		return rows.map(row => this.rowToItem(row))
	}

	updatePayload(id: string, payload: ItemPayload): ItemRecord {
		const current = this.get(id)
		if (!current) throw new Error(`Item not found: ${id}`)
		const updatedAt = new Date().toISOString()
		validateItem({ ...current, payload, updatedAt })
		const result = this.db
			.prepare('UPDATE items SET payload = ?, updated_at = ? WHERE id = ?')
			.run(JSON.stringify(payload), updatedAt, id)
		if (result.changes === 0) throw new Error(`Item not found: ${id}`)
		const updated = this.get(id)
		if (!updated) throw new Error(`Item not found: ${id}`)
		return updated
	}

	insertEvent(itemId: string, eventType: string, payload?: unknown): void {
		// Store an explicit ISO-8601 UTC timestamp (with `Z`). The column DEFAULT is
		// SQLite `datetime('now')`, which writes "YYYY-MM-DD HH:MM:SS" with NO
		// timezone marker — the dashboard then `new Date()`-parses it as LOCAL and
		// shows times off by the UTC offset.
		this.db
			.prepare('INSERT INTO item_events (item_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)')
			.run(itemId, eventType, payload ? JSON.stringify(payload) : null, new Date().toISOString())
	}

	countEvents(itemId: string, eventType: string): number {
		const row = this.db
			.prepare('SELECT COUNT(*) AS count FROM item_events WHERE item_id = ? AND event_type = ?')
			.get(itemId, eventType) as { count: number }
		return row.count
	}

	getEvents(itemId: string, limit = 100): ItemEvent[] {
		const rows = this.db
			.prepare('SELECT * FROM item_events WHERE item_id = ? ORDER BY created_at ASC, id ASC LIMIT ?')
			.all(itemId, limit) as Record<string, unknown>[]
		return rows.map(row => ({
			id: row.id as number,
			itemId: row.item_id as string,
			eventType: row.event_type as string,
			payload: (row.payload as string) ?? null,
			createdAt: row.created_at as string,
		}))
	}

	listQueuedByKind(kind: ItemKind, limit = 50): ItemRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM items
				 WHERE status = 'queued' AND kind = ?
				 ORDER BY queued_at ASC, created_at ASC
				 LIMIT ?`,
			)
			.all(kind, limit) as Record<string, unknown>[]
		return rows.map(row => this.rowToItem(row))
	}

	listProcessingByKind(kind: ItemKind, limit = 50): ItemRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM items
				 WHERE status = 'processing' AND kind = ?
				 ORDER BY started_at ASC, created_at ASC
				 LIMIT ?`,
			)
			.all(kind, limit) as Record<string, unknown>[]
		return rows.map(row => this.rowToItem(row))
	}

	// Solve Items that have shipped a PR and may still be merging/deploying — the
	// DeployWatcher's work-list. review + completed (not failed/cancelled).
	listDeployWatchable(limit = 100): ItemRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM items
				 WHERE kind = 'solve' AND pr_url IS NOT NULL AND status IN ('review', 'completed')
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(limit) as Record<string, unknown>[]
		return rows.map(row => this.rowToItem(row))
	}

	branchNameExists(branchName: string, exceptId?: string): boolean {
		const row = exceptId
			? this.db
					.prepare('SELECT COUNT(*) AS count FROM items WHERE branch_name = ? AND id != ?')
					.get(branchName, exceptId)
			: this.db.prepare('SELECT COUNT(*) AS count FROM items WHERE branch_name = ?').get(branchName)
		return (row as { count: number }).count > 0
	}

	countQueuedByKind(kind: ItemKind): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS count FROM items WHERE status = 'queued' AND kind = ?")
			.get(kind) as { count: number }
		return row.count
	}

	list(opts?: { status?: ItemStatus; projectSlug?: string; limit?: number; offset?: number }): ItemRecord[] {
		const conditions: string[] = []
		const params: unknown[] = []
		if (opts?.status) {
			conditions.push('status = ?')
			params.push(opts.status)
		}
		if (opts?.projectSlug) {
			conditions.push('project_slug = ?')
			params.push(opts.projectSlug)
		}
		const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
		const limit = opts?.limit ?? 50
		const offset = opts?.offset ?? 0
		params.push(limit, offset)
		const rows = this.db
			.prepare(`SELECT * FROM items ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
			.all(...params) as Record<string, unknown>[]
		return rows.map(row => this.rowToItem(row))
	}

	private toDbParams(item: ItemRecord) {
		return {
			id: item.id,
			kind: item.kind,
			status: item.status,
			projectSlug: item.projectSlug,
			title: item.title,
			displayName: item.displayName,
			source: item.source ? JSON.stringify(item.source) : null,
			baseRef: item.baseRef,
			spawner: item.spawner,
			groupId: item.groupId,
			payload: JSON.stringify(item.payload satisfies ItemPayload),
			worktreePath: item.worktreePath,
			branchName: item.branchName,
			planDirName: item.planDirName,
			almanacRunId: item.almanacRunId,
			createdAt: item.createdAt,
			queuedAt: item.queuedAt,
			startedAt: item.startedAt,
			completedAt: item.completedAt,
			updatedAt: item.updatedAt,
			errorMessage: item.errorMessage,
			errorPhase: item.errorPhase,
			resultSummary: item.resultSummary,
			solveInputSnapshot: item.solveInputSnapshot,
			prUrl: item.prUrl,
			runOutcome: item.runOutcome,
			deployState: item.deployState ? JSON.stringify(item.deployState) : null,
		}
	}

	private rowToItem(row: Record<string, unknown>): ItemRecord {
		return validateItem({
			id: row.id,
			kind: row.kind,
			status: row.status,
			projectSlug: row.project_slug,
			title: row.title,
			displayName: row.display_name ?? null,
			source: readJson(row.source, 'source'),
			baseRef: row.base_ref,
			spawner: row.spawner ?? null,
			groupId: row.group_id ?? null,
			payload: readJson(row.payload, 'payload'),
			worktreePath: row.worktree_path ?? null,
			branchName: row.branch_name ?? null,
			planDirName: row.plan_dir_name ?? null,
			almanacRunId: row.almanac_run_id ?? null,
			createdAt: row.created_at,
			queuedAt: row.queued_at ?? null,
			startedAt: row.started_at ?? null,
			completedAt: row.completed_at ?? null,
			updatedAt: row.updated_at,
			errorMessage: row.error_message ?? null,
			errorPhase: row.error_phase ?? null,
			resultSummary: row.result_summary ?? null,
			solveInputSnapshot: row.solve_input_snapshot ?? null,
			prUrl: row.pr_url ?? null,
			runOutcome: row.run_outcome ?? null,
			deployState: readJson(row.deploy_state, 'deployState'),
		})
	}
}
