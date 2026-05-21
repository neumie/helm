import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { ChatMessage, ChatSession, EventLogEntry, PollState, TaskRecord } from '../types.js'
import { MIGRATIONS } from './schema.js'
import { TASK_COLUMNS, rowToTaskRecord } from './task-schema.js'

export class DB {
	private db: Database.Database

	constructor(dbPath?: string) {
		const path = dbPath ?? resolve(process.cwd(), 'vigil.db')
		this.db = new Database(path)
		this.db.pragma('journal_mode = WAL')
		this.db.pragma('foreign_keys = ON')
		this.migrate()
	}

	private migrate() {
		const currentVersion = this.getCurrentVersion()
		for (const migration of MIGRATIONS) {
			if (migration.version > currentVersion) {
				this.db.exec(migration.sql)
				this.db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(migration.version)
			}
		}
	}

	private getCurrentVersion(): number {
		try {
			const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number } | undefined
			return row?.v ?? 0
		} catch {
			return 0
		}
	}

	// Tasks
	insertTask(task: { id: string; clientcareId: string; projectSlug: string; title: string }): void {
		this.db
			.prepare('INSERT OR IGNORE INTO tasks (id, clientcare_id, project_slug, title) VALUES (?, ?, ?, ?)')
			.run(task.id, task.clientcareId, task.projectSlug, task.title)
	}

	deleteTask(id: string): void {
		this.db.prepare('DELETE FROM event_log WHERE task_id = ?').run(id)
		this.db
			.prepare('DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE task_id = ?)')
			.run(id)
		this.db.prepare('DELETE FROM chat_sessions WHERE task_id = ?').run(id)
		this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
	}

	taskExistsByClientcareId(clientcareId: string): boolean {
		const row = this.db.prepare('SELECT 1 FROM tasks WHERE clientcare_id = ?').get(clientcareId)
		return !!row
	}

	getTask(id: string): TaskRecord | null {
		const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
		return row ? this.mapTaskRow(row) : null
	}

	getTaskByClientcareId(clientcareId: string): TaskRecord | null {
		const row = this.db.prepare('SELECT * FROM tasks WHERE clientcare_id = ?').get(clientcareId) as
			| Record<string, unknown>
			| undefined
		return row ? this.mapTaskRow(row) : null
	}

	updateTask(id: string, fields: Partial<TaskRecord>): void {
		const sets: string[] = []
		const values: unknown[] = []
		for (const [key, value] of Object.entries(fields)) {
			const col = TASK_COLUMNS[key as keyof TaskRecord]
			// Throw on unknown field rather than silently dropping the update —
			// a typo'd column name should fail loudly, not vanish.
			if (!col) throw new Error(`updateTask: unknown task field "${key}"`)
			sets.push(`${col} = ?`)
			values.push(value)
		}
		if (sets.length === 0) return
		values.push(id)
		this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
	}

	listTasks(opts?: { status?: string; projectSlug?: string; limit?: number; offset?: number }): TaskRecord[] {
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
			.prepare(`SELECT * FROM tasks ${where} ORDER BY queued_at DESC LIMIT ? OFFSET ?`)
			.all(...params) as Record<string, unknown>[]
		return rows.map(r => this.mapTaskRow(r))
	}

	getQueuedTaskIds(): string[] {
		const rows = this.db.prepare("SELECT id FROM tasks WHERE status = 'queued' ORDER BY queued_at ASC").all() as {
			id: string
		}[]
		return rows.map(r => r.id)
	}

	getProcessingTaskIds(): string[] {
		const rows = this.db.prepare("SELECT id FROM tasks WHERE status = 'processing' ORDER BY started_at ASC").all() as {
			id: string
		}[]
		return rows.map(r => r.id)
	}

	private mapTaskRow(row: Record<string, unknown>): TaskRecord {
		return rowToTaskRecord(row)
	}

	// Poll state
	getPollState(projectSlug: string): PollState | null {
		const row = this.db.prepare('SELECT * FROM poll_state WHERE project_slug = ?').get(projectSlug) as
			| Record<string, unknown>
			| undefined
		if (!row) return null
		return {
			projectSlug: row.project_slug as string,
			lastPollAt: row.last_poll_at as string,
			lastTaskSeen: (row.last_task_seen as string) ?? null,
		}
	}

	updatePollState(projectSlug: string, lastPollAt: string, lastTaskSeen: string | null): void {
		this.db
			.prepare('INSERT OR REPLACE INTO poll_state (project_slug, last_poll_at, last_task_seen) VALUES (?, ?, ?)')
			.run(projectSlug, lastPollAt, lastTaskSeen)
	}

	// Event log
	insertEvent(taskId: string | null, eventType: string, payload?: unknown): void {
		this.db
			.prepare('INSERT INTO event_log (task_id, event_type, payload) VALUES (?, ?, ?)')
			.run(taskId, eventType, payload ? JSON.stringify(payload) : null)
	}

	getEvents(taskId: string, limit = 100): EventLogEntry[] {
		const rows = this.db
			.prepare('SELECT * FROM event_log WHERE task_id = ? ORDER BY created_at ASC LIMIT ?')
			.all(taskId, limit) as Record<string, unknown>[]
		return rows.map(r => ({
			id: r.id as number,
			taskId: (r.task_id as string) ?? null,
			eventType: r.event_type as string,
			payload: (r.payload as string) ?? null,
			createdAt: r.created_at as string,
		}))
	}

	// Stats
	getStats(): Record<string, number> {
		const rows = this.db.prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status').all() as {
			status: string
			count: number
		}[]
		const stats: Record<string, number> = {}
		for (const r of rows) stats[r.status] = r.count
		return stats
	}

	// Chat sessions
	createChatSession(taskId: string, token: string): ChatSession {
		const id = randomUUID()
		const now = new Date().toISOString()
		this.db.prepare('INSERT INTO chat_sessions (id, task_id, token) VALUES (?, ?, ?)').run(id, taskId, token)
		return { id, taskId, token, status: 'active', createdAt: now, completedAt: null }
	}

	getChatSession(sessionId: string): ChatSession | null {
		const row = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId) as
			| Record<string, unknown>
			| undefined
		return row ? this.mapChatSessionRow(row) : null
	}

	getChatSessionByToken(token: string): ChatSession | null {
		const row = this.db.prepare('SELECT * FROM chat_sessions WHERE token = ?').get(token) as
			| Record<string, unknown>
			| undefined
		return row ? this.mapChatSessionRow(row) : null
	}

	getChatSessionsByTaskId(taskId: string): ChatSession[] {
		const rows = this.db
			.prepare('SELECT * FROM chat_sessions WHERE task_id = ? ORDER BY created_at DESC')
			.all(taskId) as Record<string, unknown>[]
		return rows.map(r => this.mapChatSessionRow(r))
	}

	completeChatSession(sessionId: string): void {
		this.db
			.prepare("UPDATE chat_sessions SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
			.run(sessionId)
	}

	private mapChatSessionRow(row: Record<string, unknown>): ChatSession {
		return {
			id: row.id as string,
			taskId: row.task_id as string,
			token: row.token as string,
			status: row.status as ChatSession['status'],
			createdAt: row.created_at as string,
			completedAt: (row.completed_at as string) ?? null,
		}
	}

	// Chat messages
	addChatMessage(sessionId: string, role: 'assistant' | 'user', content: string): string {
		const id = randomUUID()
		this.db
			.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
			.run(id, sessionId, role, content)
		return id
	}

	getChatMessages(sessionId: string): ChatMessage[] {
		const rows = this.db
			.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC')
			.all(sessionId) as Record<string, unknown>[]
		return rows.map(r => this.mapChatMessageRow(r))
	}

	getNewUserMessages(sessionId: string, afterId: string | null): ChatMessage[] {
		const rows = afterId
			? (this.db
					.prepare(
						`SELECT * FROM chat_messages
					 WHERE session_id = ? AND role = 'user' AND created_at > (
					   SELECT created_at FROM chat_messages WHERE id = ?
					 )
					 ORDER BY created_at ASC`,
					)
					.all(sessionId, afterId) as Record<string, unknown>[])
			: (this.db
					.prepare("SELECT * FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC")
					.all(sessionId) as Record<string, unknown>[])
		return rows.map(r => this.mapChatMessageRow(r))
	}

	private mapChatMessageRow(row: Record<string, unknown>): ChatMessage {
		return {
			id: row.id as string,
			sessionId: row.session_id as string,
			role: row.role as ChatMessage['role'],
			content: row.content as string,
			createdAt: row.created_at as string,
		}
	}

	close(): void {
		this.db.close()
	}
}
