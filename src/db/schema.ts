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
	{
		// Operator-authored rich run context. The lossless editor document is kept
		// separate from provider/captured source data and immutable solve evidence;
		// revision enables optimistic saves from the external editor window.
		version: 25,
		sql: `
ALTER TABLE items ADD COLUMN run_context TEXT;
ALTER TABLE items ADD COLUMN run_context_revision INTEGER NOT NULL DEFAULT 0;
`,
	},
	{
		// Profiles share one daemon database. Existing single-profile databases are
		// imported as Work; the startup importer rewrites this value for rows copied
		// from other legacy profile databases. Item/event identity stays globally
		// unique while every store operation is additionally tenant-scoped.
		version: 26,
		sql: `
ALTER TABLE items ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'work';
ALTER TABLE item_events ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'work';

ALTER TABLE poll_state RENAME TO poll_state_legacy;
CREATE TABLE poll_state (
  profile_id    TEXT NOT NULL,
  project_slug  TEXT NOT NULL,
  last_poll_at  TEXT NOT NULL,
  last_task_seen TEXT,
  PRIMARY KEY (profile_id, project_slug)
);
INSERT INTO poll_state (profile_id, project_slug, last_poll_at, last_task_seen)
SELECT 'work', project_slug, last_poll_at, last_task_seen FROM poll_state_legacy;
DROP TABLE poll_state_legacy;

CREATE INDEX idx_items_profile_status_updated ON items(profile_id, status, updated_at DESC);
CREATE INDEX idx_items_profile_queue ON items(profile_id, status, work_mode, queued_at, created_at);
CREATE INDEX idx_items_profile_group ON items(profile_id, group_id, created_at);
CREATE INDEX idx_item_events_profile_item ON item_events(profile_id, item_id, event_type, created_at);
`,
	},
	{
		// Scheduled interactive runs are a profile-owned domain, deliberately
		// separate from Items/Drainer/Solver lifecycle state.
		version: 27,
		sql: `
CREATE TABLE scheduled_schedules (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('project', 'system')),
  project_slug TEXT,
  definition TEXT NOT NULL,
  cron TEXT NOT NULL,
  cadence_kind TEXT NOT NULL CHECK (cadence_kind IN ('hourly', 'daily', 'weekly', 'cron')),
  timezone TEXT NOT NULL,
  overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_policy = 'skip'),
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_reason TEXT,
  archived_at TEXT,
  system_risk_acknowledged_at TEXT,
  CHECK ((target_kind = 'project' AND project_slug IS NOT NULL) OR (target_kind = 'system' AND project_slug IS NULL))
);
CREATE TABLE scheduled_runs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES scheduled_schedules(id),
  schedule_revision INTEGER NOT NULL,
  scheduled_for TEXT NOT NULL,
  local_civil_slot TEXT NOT NULL,
  utc_offset_minutes INTEGER NOT NULL,
  slot_key TEXT NOT NULL,
  definition_snapshot TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL,
  socket_descriptor TEXT,
  report_token_hash TEXT,
  report_token_version INTEGER NOT NULL DEFAULT 1,
  process_fingerprint TEXT,
  cwd TEXT,
  worktree_path TEXT,
  branch_name TEXT,
  run_dir TEXT,
  started_at TEXT,
  reported_at TEXT,
  closed_at TEXT,
  report_kind TEXT,
  report_summary TEXT,
  diagnostic_detail TEXT,
  notification_claimed_at TEXT,
  notification_delivered_at TEXT,
  missed_count INTEGER NOT NULL DEFAULT 0,
  missed_many INTEGER NOT NULL DEFAULT 0,
  cleanup_state TEXT,
  terminal_resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (schedule_id, slot_key),
  UNIQUE (profile_id, session_id)
);
CREATE INDEX idx_scheduled_schedules_due ON scheduled_schedules(profile_id, enabled, next_run_at);
CREATE INDEX idx_scheduled_runs_history ON scheduled_runs(profile_id, scheduled_for DESC, id DESC);
CREATE INDEX idx_scheduled_runs_session ON scheduled_runs(profile_id, session_id);
CREATE INDEX idx_scheduled_runs_active ON scheduled_runs(profile_id, schedule_id, state);
CREATE UNIQUE INDEX idx_scheduled_runs_one_active ON scheduled_runs(schedule_id)
  WHERE state IN ('admitted', 'preparing', 'launching', 'running', 'reported_quiet', 'closing', 'needs_attention', 'cancel_requested', 'quarantined');
`,
	},
	{
		// A timeout is claimed durably before teardown. It remains active so a
		// concurrent report/cancel cannot win after destructive process control.
		version: 28,
		sql: `
DROP INDEX IF EXISTS idx_scheduled_runs_one_active;
CREATE UNIQUE INDEX idx_scheduled_runs_one_active ON scheduled_runs(schedule_id)
  WHERE state IN ('admitted', 'preparing', 'launching', 'running', 'reported_quiet', 'closing', 'needs_attention', 'cancel_requested', 'timeout_requested', 'quarantined');
`,
	},
	{
		// Quarantine must not erase the terminal outcome already chosen before
		// ownership-sensitive teardown. Legacy rows deliberately start with null.
		version: 29,
		sql: `
ALTER TABLE scheduled_runs ADD COLUMN pending_terminal_intent TEXT
  CHECK (pending_terminal_intent IN ('quiet', 'cancel', 'timeout') OR pending_terminal_intent IS NULL);
`,
	},
	{
		// Electron ownership adoption is an internal, strict-validated JSON record.
		// Existing rows intentionally remain unadopted until an explicit reservation.
		version: 30,
		sql: `
ALTER TABLE scheduled_runs ADD COLUMN attention_adoption TEXT;
`,
	},
	{
		// Capture-only manual solve Items may wait in Queue without choosing a
		// repository. Project + BaseRef stay null together until the guarded
		// assignment command resolves the configured project's default branch.
		// SQLite cannot drop NOT NULL in place, so rebuild the parent table while
		// preserving item_events' stable FK target and every existing index.
		version: 31,
		sql: `
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE items_v31 (
  id                         TEXT PRIMARY KEY,
  kind                       TEXT NOT NULL,
  status                     TEXT NOT NULL,
  project_slug               TEXT,
  title                      TEXT NOT NULL,
  source                     TEXT,
  base_ref                   TEXT,
  group_id                   TEXT,
  payload                    TEXT NOT NULL,
  worktree_path              TEXT,
  branch_name                TEXT,
  plan_dir_name              TEXT,
  almanac_run_id             TEXT,
  created_at                 TEXT NOT NULL,
  queued_at                  TEXT,
  started_at                 TEXT,
  completed_at               TEXT,
  updated_at                 TEXT NOT NULL,
  error_message              TEXT,
  error_phase                TEXT,
  result_summary             TEXT,
  pr_url                     TEXT,
  solve_input_snapshot       TEXT,
  spawner                    TEXT,
  run_outcome                TEXT,
  deploy_state               TEXT,
  display_name               TEXT,
  assessment                 TEXT,
  captured_context           TEXT,
  planned_at                 TEXT,
  work_mode                  TEXT,
  plan_status                TEXT,
  run_context                TEXT,
  run_context_revision       INTEGER NOT NULL DEFAULT 0,
  profile_id                 TEXT NOT NULL DEFAULT 'work',
  CHECK ((project_slug IS NULL) = (base_ref IS NULL))
);
INSERT INTO items_v31 (
  id, kind, status, project_slug, title, source, base_ref, group_id, payload,
  worktree_path, branch_name, plan_dir_name, almanac_run_id, created_at,
  queued_at, started_at, completed_at, updated_at, error_message, error_phase,
  result_summary, pr_url, solve_input_snapshot, spawner, run_outcome,
  deploy_state, display_name, assessment, captured_context, planned_at,
  work_mode, plan_status, run_context, run_context_revision, profile_id
)
SELECT
  id, kind, status, project_slug, title, source, base_ref, group_id, payload,
  worktree_path, branch_name, plan_dir_name, almanac_run_id, created_at,
  queued_at, started_at, completed_at, updated_at, error_message, error_phase,
  result_summary, pr_url, solve_input_snapshot, spawner, run_outcome,
  deploy_state, display_name, assessment, captured_context, planned_at,
  work_mode, plan_status, run_context, run_context_revision, profile_id
FROM items;
DROP TABLE items;
ALTER TABLE items_v31 RENAME TO items;
CREATE INDEX idx_items_status_queued_at ON items(status, queued_at);
CREATE INDEX idx_items_kind ON items(kind);
CREATE INDEX idx_items_project ON items(project_slug);
CREATE INDEX idx_items_group ON items(group_id);
CREATE INDEX idx_items_profile_status_updated ON items(profile_id, status, updated_at DESC);
CREATE INDEX idx_items_profile_queue ON items(profile_id, status, work_mode, queued_at, created_at);
CREATE INDEX idx_items_profile_group ON items(profile_id, group_id, created_at);
COMMIT;
PRAGMA foreign_keys = ON;
`,
	},
	{
		// Historical migration: Helm briefly hosted a local Markdown index and
		// proposal review workflow alongside immutable run evidence. Migration 33
		// removes the Hold-owned parts while preserving evidence snapshots.
		version: 32,
		sql: `
CREATE TABLE knowledge_documents (
  id                TEXT PRIMARY KEY,
  profile_id        TEXT NOT NULL,
  project_slug      TEXT NOT NULL,
  relative_path     TEXT NOT NULL,
  title             TEXT NOT NULL,
  content           TEXT NOT NULL,
  frontmatter       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  source_mtime_ms   INTEGER NOT NULL,
  source_updated_at TEXT NOT NULL,
  indexed_at        TEXT NOT NULL,
  UNIQUE (profile_id, project_slug, relative_path)
);
CREATE INDEX idx_knowledge_documents_recent
  ON knowledge_documents(profile_id, project_slug, source_updated_at DESC, relative_path);

CREATE TABLE knowledge_chunks (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL,
  project_slug  TEXT NOT NULL,
  document_id   TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  heading       TEXT,
  content       TEXT NOT NULL,
  search_terms  TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  UNIQUE (document_id, ordinal)
);
CREATE INDEX idx_knowledge_chunks_project
  ON knowledge_chunks(profile_id, project_slug, document_id, ordinal);

CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  heading,
  content,
  search_terms,
  tokenize = 'unicode61'
);
CREATE TRIGGER knowledge_chunks_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
  INSERT INTO knowledge_chunks_fts(chunk_id, title, heading, content, search_terms)
  VALUES (new.id, new.title, COALESCE(new.heading, ''), new.content, new.search_terms);
END;
CREATE TRIGGER knowledge_chunks_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
  DELETE FROM knowledge_chunks_fts WHERE chunk_id = old.id;
END;
CREATE TRIGGER knowledge_chunks_fts_update AFTER UPDATE ON knowledge_chunks BEGIN
  DELETE FROM knowledge_chunks_fts WHERE chunk_id = old.id;
  INSERT INTO knowledge_chunks_fts(chunk_id, title, heading, content, search_terms)
  VALUES (new.id, new.title, COALESCE(new.heading, ''), new.content, new.search_terms);
END;

CREATE TABLE item_knowledge_snapshots (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  project_slug  TEXT NOT NULL,
  purpose       TEXT NOT NULL CHECK (purpose IN ('planning', 'solve')),
  sequence      INTEGER NOT NULL,
  query         TEXT NOT NULL,
  context       TEXT NOT NULL,
  manifest      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (profile_id, item_id, purpose, sequence)
);
CREATE INDEX idx_item_knowledge_snapshots_item
  ON item_knowledge_snapshots(profile_id, item_id, created_at DESC);

CREATE TABLE knowledge_write_proposals (
  id                    TEXT PRIMARY KEY,
  profile_id            TEXT NOT NULL,
  item_id               TEXT NOT NULL,
  snapshot_id           TEXT NOT NULL REFERENCES item_knowledge_snapshots(id),
  proposal_key          TEXT NOT NULL,
  title                 TEXT NOT NULL,
  content               TEXT NOT NULL,
  writeback_relative_path TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'accepted', 'rejected', 'failed')),
  revision              INTEGER NOT NULL DEFAULT 0,
  error_message         TEXT,
  created_at            TEXT NOT NULL,
  resolved_at           TEXT,
  UNIQUE (profile_id, proposal_key)
);
CREATE INDEX idx_knowledge_write_proposals_item
  ON knowledge_write_proposals(profile_id, item_id, created_at DESC);
`,
	},
	{
		// Hold owns indexing, review, and canonical Markdown writes. Helm retains
		// only exact run evidence plus a delivery-only outbox for learned facts.
		// Keep this forward migration because migration 32 reached local databases
		// before the feature was committed.
		version: 33,
		sql: `
CREATE TABLE knowledge_candidate_outbox (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  project_slug    TEXT NOT NULL,
  snapshot_id     TEXT REFERENCES item_knowledge_snapshots(id),
  idempotency_key TEXT NOT NULL,
  candidates      TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  receipt         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  delivered_at    TEXT,
  UNIQUE (profile_id, idempotency_key)
);
CREATE INDEX idx_knowledge_candidate_outbox_pending
  ON knowledge_candidate_outbox(profile_id, state, next_attempt_at, created_at);
CREATE INDEX idx_knowledge_candidate_outbox_item
  ON knowledge_candidate_outbox(profile_id, item_id, created_at DESC);

-- A protocol-41 daemon may finish a run after this source update but before its
-- restart. Preserve every unresolved proposal as a delivery-only Hold batch.
INSERT INTO knowledge_candidate_outbox (
  id, profile_id, item_id, project_slug, snapshot_id, idempotency_key,
  candidates, state, attempt_count, next_attempt_at, last_error,
  receipt, created_at, updated_at, delivered_at
)
SELECT
  'legacy-' || p.id,
  p.profile_id,
  p.item_id,
  s.project_slug,
  p.snapshot_id,
  'legacy:' || p.proposal_key,
  json_array(json_object('title', p.title, 'content', p.content)),
  'pending',
  0,
  NULL,
  CASE WHEN p.state = 'failed' THEN p.error_message ELSE NULL END,
  NULL,
  p.created_at,
  p.created_at,
  NULL
FROM knowledge_write_proposals p
JOIN item_knowledge_snapshots s
  ON s.profile_id = p.profile_id AND s.id = p.snapshot_id
WHERE p.state IN ('pending', 'applying', 'failed');

DROP TRIGGER IF EXISTS knowledge_chunks_fts_insert;
DROP TRIGGER IF EXISTS knowledge_chunks_fts_delete;
DROP TRIGGER IF EXISTS knowledge_chunks_fts_update;
DROP TABLE IF EXISTS knowledge_chunks_fts;
DROP TABLE IF EXISTS knowledge_write_proposals;
DROP TABLE IF EXISTS knowledge_chunks;
DROP TABLE IF EXISTS knowledge_documents;
`,
	},
	{
		// Freeze provider identity and preserve exact external brief attestation.
		// Historical rows remain readable but unresolved migration-33 deliveries
		// are blocked until an operator explicitly adopts a destination.
		version: 34,
		sql: `
ALTER TABLE item_knowledge_snapshots ADD COLUMN character_budget INTEGER;
ALTER TABLE item_knowledge_snapshots ADD COLUMN binding_id TEXT;
ALTER TABLE item_knowledge_snapshots ADD COLUMN provider_id TEXT;
ALTER TABLE item_knowledge_snapshots ADD COLUMN provider_type TEXT;
ALTER TABLE item_knowledge_snapshots ADD COLUMN provider_project_id TEXT;
ALTER TABLE item_knowledge_snapshots ADD COLUMN provider_brief_ref TEXT;
ALTER TABLE item_knowledge_snapshots ADD COLUMN provider_revision TEXT;
ALTER TABLE item_knowledge_snapshots ADD COLUMN provider_created_at TEXT;
ALTER TABLE item_knowledge_snapshots ADD COLUMN context_hash TEXT;
ALTER TABLE item_knowledge_snapshots ADD COLUMN provider_protocol_version INTEGER;

ALTER TABLE knowledge_candidate_outbox RENAME TO knowledge_candidate_outbox_v33;
DROP INDEX IF EXISTS idx_knowledge_candidate_outbox_pending;
DROP INDEX IF EXISTS idx_knowledge_candidate_outbox_item;

CREATE TABLE knowledge_candidate_outbox (
  id                  TEXT PRIMARY KEY,
  profile_id          TEXT NOT NULL,
  item_id             TEXT NOT NULL,
  project_slug        TEXT NOT NULL,
  snapshot_id         TEXT REFERENCES item_knowledge_snapshots(id),
  binding_id          TEXT,
  provider_id         TEXT,
  provider_project_id TEXT,
  idempotency_key     TEXT NOT NULL,
  candidates          TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'blocked')),
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  lease_owner         TEXT,
  lease_expires_at    TEXT,
  last_error_code     TEXT,
  last_error          TEXT,
  receipt             TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  delivered_at        TEXT,
  UNIQUE (profile_id, idempotency_key)
);
CREATE INDEX idx_knowledge_candidate_outbox_pending
  ON knowledge_candidate_outbox(profile_id, state, next_attempt_at, created_at);
CREATE INDEX idx_knowledge_candidate_outbox_item
  ON knowledge_candidate_outbox(profile_id, item_id, created_at DESC);

INSERT INTO knowledge_candidate_outbox (
  id, profile_id, item_id, project_slug, snapshot_id, binding_id,
  provider_id, provider_project_id, idempotency_key, candidates, state,
  attempt_count, next_attempt_at, lease_owner, lease_expires_at,
  last_error_code, last_error, receipt, created_at, updated_at, delivered_at
)
SELECT
  id,
  profile_id,
  item_id,
  project_slug,
  snapshot_id,
  NULL,
  NULL,
  NULL,
  idempotency_key,
  candidates,
  CASE WHEN state = 'delivered' THEN 'delivered' ELSE 'blocked' END,
  attempt_count,
  NULL,
  NULL,
  NULL,
  CASE WHEN state = 'delivered' THEN NULL ELSE 'legacy-target-unbound' END,
  CASE
    WHEN state = 'delivered' THEN last_error
    ELSE COALESCE(last_error, 'Legacy candidate delivery target requires explicit adoption')
  END,
  CASE WHEN receipt IS NULL THEN NULL ELSE json_object('legacyReceipt', receipt) END,
  created_at,
  updated_at,
  delivered_at
FROM knowledge_candidate_outbox_v33;

DROP TABLE knowledge_candidate_outbox_v33;
`,
	},
	{
		// Bind detail evidence to the exact current planning/solve attempt. The
		// snapshot table remains immutable; this nullable pointer is cleared when
		// a new attempt starts and set only after exact evidence is persisted.
		version: 35,
		sql: `
ALTER TABLE items ADD COLUMN knowledge_snapshot_id TEXT;
CREATE INDEX idx_items_profile_knowledge_snapshot
  ON items(profile_id, knowledge_snapshot_id);
`,
	},
	{
		// A completed attention adoption transfers terminal ownership to Electron.
		// It no longer blocks recurrence; explicit Electron close still transitions
		// the row through cancel_requested to a terminal lifecycle state.
		version: 36,
		sql: `
DROP INDEX IF EXISTS idx_scheduled_runs_one_active;
CREATE UNIQUE INDEX idx_scheduled_runs_one_active ON scheduled_runs(schedule_id)
  WHERE state IN ('admitted', 'preparing', 'launching', 'running', 'reported_quiet', 'closing', 'cancel_requested', 'timeout_requested', 'quarantined')
     OR (state = 'needs_attention' AND terminal_resolved_at IS NULL);
`,
	},
]
