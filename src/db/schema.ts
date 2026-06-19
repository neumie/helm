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
]
