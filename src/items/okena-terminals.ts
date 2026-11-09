import type Database from 'better-sqlite3'

/**
 * Which Okena terminal an Item owns, by Okena's terminal id.
 *
 * Helm used to recognise its planning terminal by a `[helm:<itemId>]` suffix in
 * the terminal NAME. Agents now give their terminals short names of their own,
 * so a name is display-only: identity is this binding plus a live check that the
 * terminal id is still in the Okena project's layout. A terminal whose binding
 * points at a closed pane is simply not reused; a later take in the same Okena
 * project overwrites it. One row per (Item, role, Okena project).
 */
export type OkenaTerminalRole = 'plan' | 'solve'

export interface OkenaTerminalBinding {
	itemId: string
	role: OkenaTerminalRole
	/** Okena profile whose daemon owns the terminal; null when the client could not say. */
	okenaProfileId: string | null
	/** Okena project (worktree child or main checkout) whose layout holds the terminal. */
	projectId: string
	terminalId: string
	/** When Helm first took this terminal for the role. */
	createdAt: string
	/** When Helm last recorded it (re-recording the same terminal keeps `createdAt`). */
	updatedAt: string
}

export interface OkenaTerminalTake {
	okenaProfileId: string | null
	projectId: string
	terminalId: string
}

/** One Item's terminal bindings inside one Helm profile, captured before any await. */
export interface ItemOkenaTerminals {
	readonly itemId: string
	/** The role's binding in one Okena project (an Item may own a planning terminal per project). */
	get(role: OkenaTerminalRole, projectId: string): OkenaTerminalBinding | null
	/** Every binding, newest first. */
	list(): OkenaTerminalBinding[]
	/** False when the Item does not belong to this profile (nothing is written). */
	record(role: OkenaTerminalRole, take: OkenaTerminalTake): boolean
}

interface BindingRow {
	item_id: string
	role: OkenaTerminalRole
	okena_profile_id: string | null
	project_id: string
	terminal_id: string
	created_at: string
	updated_at: string
}

function binding(row: BindingRow): OkenaTerminalBinding {
	return {
		itemId: row.item_id,
		role: row.role,
		okenaProfileId: row.okena_profile_id,
		projectId: row.project_id,
		terminalId: row.terminal_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

/** Profile-bound persistence for Item → Okena terminal ownership (`item_okena_terminals`). */
export class OkenaTerminalStore {
	constructor(
		private readonly db: Database.Database,
		private readonly profileId: () => string,
	) {}

	/** Bind the profile now: a job keeps its tenant even if activation changes later. */
	forItem(itemId: string): ItemOkenaTerminals {
		const profileId = this.profileId()
		const db = this.db
		const select = 'SELECT * FROM item_okena_terminals WHERE profile_id = ? AND item_id = ?'
		return {
			itemId,
			get(role, projectId) {
				const row = db.prepare(`${select} AND role = ? AND project_id = ?`).get(profileId, itemId, role, projectId) as
					| BindingRow
					| undefined
				return row ? binding(row) : null
			},
			list() {
				const rows = db
					.prepare(`${select} ORDER BY updated_at DESC, created_at DESC, role ASC`)
					.all(profileId, itemId) as BindingRow[]
				return rows.map(binding)
			},
			record(role, take) {
				const now = new Date().toISOString()
				// Insert only for an Item of THIS profile: Item ids are global, so a
				// binding must never be attached to another tenant's Item.
				const result = db
					.prepare(
						`INSERT INTO item_okena_terminals
						   (profile_id, item_id, role, okena_profile_id, project_id, terminal_id, created_at, updated_at)
						 SELECT ?, id, ?, ?, ?, ?, ?, ? FROM items WHERE id = ? AND profile_id = ?
						 ON CONFLICT (profile_id, item_id, role, project_id) DO UPDATE SET
						   created_at = CASE
						     WHEN item_okena_terminals.terminal_id = excluded.terminal_id
						     THEN item_okena_terminals.created_at ELSE excluded.created_at END,
						   okena_profile_id = excluded.okena_profile_id,
						   terminal_id = excluded.terminal_id,
						   updated_at = excluded.updated_at`,
					)
					.run(profileId, role, take.okenaProfileId, take.projectId, take.terminalId, now, now, itemId, profileId)
				return result.changes > 0
			},
		}
	}
}
