export const MIGRATIONS = [
	{
		version: 1,
		sql: `
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  clientcare_id TEXT NOT NULL UNIQUE,
  project_slug  TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  tier          TEXT,
  task_context  TEXT,
  solver_summary    TEXT,
  solver_confidence REAL,
  files_changed     TEXT,
  solver_raw_result TEXT,
  worktree_path TEXT,
  branch_name   TEXT,
  pr_url        TEXT,
  pr_draft      INTEGER,
  comment_id    TEXT,
  queued_at     TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  completed_at  TEXT,
  error_message TEXT,
  error_phase   TEXT,
  claude_exit_code INTEGER,
  claude_raw_output TEXT
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_project ON tasks(project_slug);
CREATE INDEX idx_tasks_clientcare_id ON tasks(clientcare_id);

CREATE TABLE poll_state (
  project_slug   TEXT PRIMARY KEY,
  last_poll_at   TEXT NOT NULL,
  last_task_seen TEXT
);

CREATE TABLE event_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_task ON event_log(task_id);
CREATE INDEX idx_events_type ON event_log(event_type);

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);
`,
	},
	{
		version: 2,
		sql: `
CREATE TABLE chat_sessions (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE chat_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id),
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_sessions_task ON chat_sessions(task_id);
CREATE INDEX idx_chat_sessions_token ON chat_sessions(token);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id);
`,
	},
	{
		version: 3,
		sql: `
ALTER TABLE tasks ADD COLUMN plan_dir_name TEXT;
`,
	},
	{
		version: 4,
		sql: `
ALTER TABLE tasks ADD COLUMN solver_agent TEXT;
`,
	},
	{
		version: 5,
		sql: `
ALTER TABLE tasks RENAME COLUMN clientcare_id TO external_id;
DROP INDEX idx_tasks_clientcare_id;
CREATE INDEX idx_tasks_external_id ON tasks(external_id);
`,
	},
	{
		version: 6,
		sql: `
CREATE TABLE items (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  project_slug    TEXT NOT NULL,
  title           TEXT NOT NULL,
  source          TEXT,
  base_ref        TEXT NOT NULL,
  group_id        TEXT,
  payload         TEXT NOT NULL,
  worktree_path   TEXT,
  branch_name     TEXT,
  plan_dir_name   TEXT,
  almanac_run_id  TEXT,
  created_at      TEXT NOT NULL,
  queued_at       TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  updated_at      TEXT NOT NULL,
  error_message   TEXT,
  error_phase     TEXT,
  result_summary  TEXT,
  pr_url          TEXT
);

CREATE INDEX idx_items_status_queued_at ON items(status, queued_at);
CREATE INDEX idx_items_kind ON items(kind);
CREATE INDEX idx_items_project ON items(project_slug);
CREATE INDEX idx_items_group ON items(group_id);
`,
	},
	{
		version: 7,
		sql: `
CREATE TABLE item_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL REFERENCES items(id),
  event_type TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_item_events_item ON item_events(item_id);
CREATE INDEX idx_item_events_type ON item_events(event_type);
`,
	},
	{
		version: 8,
		sql: `
ALTER TABLE items ADD COLUMN solve_input_snapshot TEXT;
`,
	},
	{
		version: 9,
		sql: `
ALTER TABLE items ADD COLUMN spawner TEXT;
`,
	},
	{
		version: 10,
		sql: `
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_sessions;
ALTER TABLE tasks DROP COLUMN tier;
ALTER TABLE tasks DROP COLUMN solver_confidence;
`,
	},
	{
		// Legacy Task model removed — Items are the only work model. poll_state
		// (the provider watermark) stays. Existing rows were exported to a backup
		// before this dropped them; the GitHub PRs/branches are unaffected.
		version: 11,
		sql: `
DROP INDEX IF EXISTS idx_events_task;
DROP INDEX IF EXISTS idx_events_type;
DROP TABLE IF EXISTS event_log;
DROP INDEX IF EXISTS idx_tasks_status;
DROP INDEX IF EXISTS idx_tasks_project;
DROP INDEX IF EXISTS idx_tasks_external_id;
DROP TABLE IF EXISTS tasks;
`,
	},
	{
		// Small key/value store for daemon state that must survive restarts
		// (e.g. the Drainer's paused flag).
		version: 12,
		sql: `
CREATE TABLE app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
	},
	{
		// run_outcome records what the agent RUN did (ok/errored/no_result/cancelled),
		// kept separate from the lifecycle `status`. This lets a solve run that errored
		// (or wrote no result file) but committed shippable work land in `review` with
		// an `errored`/`no_result` outcome flag, instead of a false `failed`.
		version: 13,
		sql: `
ALTER TABLE items ADD COLUMN run_outcome TEXT;
`,
	},
	{
		// deploy_state (JSON) tracks the post-ship lifecycle observed from GitHub:
		// PR merge + per-environment GitHub Deployments (staging/production/…). It's
		// a separate axis from `status` (which stays the work-handling lifecycle),
		// updated by the DeployWatcher poller, not the solve pipeline.
		version: 14,
		sql: `
ALTER TABLE items ADD COLUMN deploy_state TEXT;
`,
	},
	{
		// display_name is a short, AI-derived human label for the row, compressed
		// from the raw provider `title` by a cheap one-shot model call at creation.
		// Cosmetic only (the dashboard shows display_name ?? title); `title` stays
		// the source of truth and is never overwritten. Null until named / on failure.
		version: 15,
		sql: `
ALTER TABLE items ADD COLUMN display_name TEXT;
`,
	},
	{
		// assessment (JSON) is the pre-solve intent triage of a source task: restated
		// intent, a verdict (clear / needs_clarification /
		// human_decision / not_code / security), clarifying questions, and a security
		// note. It moves the human checkpoint from "test the finished PR" to "approve
		// the intent". Advisory only — it does NOT change status; the user still
		// approves/rejects. Null until assessed / on failure.
		version: 16,
		sql: `
ALTER TABLE items ADD COLUMN assessment TEXT;
`,
	},
	{
		// Status vocabulary restructure (9 → 7): unverified+planned → triage,
		// queued → ready, processing → running, completed → done, skipped+cancelled
		// → cancelled. review/failed/cancelled keep their names. The "why" of a
		// cancellation (rejected at triage vs run stopped) lives in item_events.
		version: 17,
		sql: `
UPDATE items SET status = 'triage'    WHERE status IN ('unverified', 'planned');
UPDATE items SET status = 'ready'     WHERE status = 'queued';
UPDATE items SET status = 'running'   WHERE status = 'processing';
UPDATE items SET status = 'done'      WHERE status = 'completed';
UPDATE items SET status = 'cancelled' WHERE status = 'skipped';
`,
	},
	{
		// captured_context (JSON) freezes a TaskContext onto an Item that has no
		// live, re-pollable provider — an ingested email (subject → title, body →
		// description, sender/date → metadata, files → attachments served from the
		// daemon's attachments/ dir). It is resolved IN PLACE OF
		// provider.getTaskContext for these Items (worker, detail/plan routes,
		// enricher), so a non-provider source ('Email') never round-trips Contember.
		// Null for provider-polled Items, which always re-fetch live context.
		version: 18,
		sql: `
ALTER TABLE items ADD COLUMN captured_context TEXT;
`,
	},
	{
		// `planned_at` — set once when an interactive planning session is prepared
		// (`recordPlanPrepared`). This is the UNAMBIGUOUS "the user planned this"
		// signal: worktreePath/branchName/planDirName are ALSO set by a normal solve
		// run, so `plan != null` can't distinguish planned-by-hand from has-run.
		// Free to read in the list (a row column), so the dashboard can show a
		// "Planned" chip without a per-row event query.
		version: 19,
		sql: `
ALTER TABLE items ADD COLUMN planned_at TEXT;
UPDATE items SET planned_at = (
  SELECT MIN(created_at) FROM item_events
  WHERE item_events.item_id = items.id AND item_events.event_type = 'plan_prepared'
)
WHERE id IN (SELECT item_id FROM item_events WHERE event_type = 'plan_prepared');
`,
	},
	{
		// Rename the legacy loop kind and remove obsolete harden Items before the
		// narrower ItemKind schema reads them; item_events has no ON DELETE cascade.
		version: 20,
		sql: `
UPDATE items
SET kind = 'loop', payload = json_set(payload, '$.kind', 'loop')
WHERE kind = 'ralph';
DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE kind = 'harden');
DELETE FROM items WHERE kind = 'harden';
`,
	},
	{
		// Lifecycle vocabulary: automatic/source work waits in Inbox; legacy
		// source-less plan-first work joins Queue under the new manual-create rule.
		// Rewrite structured status snapshots before changing the Item rows so the
		// source distinction is still available for the old value.
		version: 21,
		sql: `
UPDATE item_events
SET payload = json_set(
  payload,
  '$.from',
  CASE WHEN EXISTS (
    SELECT 1 FROM items WHERE items.id = item_events.item_id AND items.source IS NOT NULL
  ) THEN 'inbox' ELSE 'ready' END
)
WHERE json_valid(payload) AND json_extract(payload, '$.from') = 'triage';
UPDATE item_events
SET payload = json_set(
  payload,
  '$.to',
  CASE WHEN EXISTS (
    SELECT 1 FROM items WHERE items.id = item_events.item_id AND items.source IS NOT NULL
  ) THEN 'inbox' ELSE 'ready' END
)
WHERE json_valid(payload) AND json_extract(payload, '$.to') = 'triage';
UPDATE item_events
SET payload = json_set(
  payload,
  '$.status',
  CASE WHEN EXISTS (
    SELECT 1 FROM items WHERE items.id = item_events.item_id AND items.source IS NOT NULL
  ) THEN 'inbox' ELSE 'ready' END
)
WHERE json_valid(payload) AND json_extract(payload, '$.status') = 'triage';
UPDATE items SET status = 'inbox' WHERE status = 'triage' AND source IS NOT NULL;
UPDATE items
SET status = 'ready', queued_at = COALESCE(queued_at, created_at)
WHERE status = 'triage';
`,
	},
	{
		// Work ownership is independent of lifecycle: Queue can be undecided,
		// running work is agent-owned, and Active is reserved for human work.
		version: 22,
		sql: `
ALTER TABLE items ADD COLUMN work_mode TEXT;
UPDATE items SET work_mode = 'agent' WHERE started_at IS NOT NULL;
`,
	},
	{
		// Interactive planning is human-owned active work. Backfill plans prepared
		// before this lifecycle rule so they become visible in Active immediately.
		version: 23,
		sql: `
UPDATE items
SET status = 'active',
    work_mode = 'manual',
    started_at = COALESCE(started_at, planned_at)
WHERE planned_at IS NOT NULL
  AND worktree_path IS NOT NULL
  AND status IN ('inbox', 'ready');
`,
	},
	{
		// Cached advisory readiness from plan artifacts and local/GitHub ticket
		// queues. Dedicated JSON column, separate from Item lifecycle.
		version: 24,
		sql: 'ALTER TABLE items ADD COLUMN plan_status TEXT;',
	},
]
