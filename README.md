# Helm

Helm is a local orchestration cockpit for software work. It turns provider tasks,
operator requests, plans, and captured context into durable **Items**, then keeps
the human checkpoint, agent execution, worktree, pull request, and deployment
state connected.

Helm consists of:

- an API-only Node.js daemon that owns persistence and execution;
- the **Helm desktop app**, which provides the Work sidebar and persistent
  terminals;
- an optional Chrome extension for acting on tasks from their source page; and
- a thin `helm` CLI for daemon control and scriptable Item creation.

There is no browser dashboard. The desktop app is the Helm UI.

> [!IMPORTANT]
> Helm is designed as a local operator tool. Its HTTP API can launch coding
> agents and perform repository operations. Keep it on a loopback interface and
> do not expose port `7474` to an untrusted network.

## What Helm does

- Polls a live task provider and files new work into **Inbox**.
- Accepts manual solve requests, Almanac loops, emails, notes, and attachments.
- Uses a human approval checkpoint before automatic/source-backed work runs.
- Keeps Queue ownership explicit: **Start agent** or **Work manually**.
- Opens interactive planning sessions without conflating planning with solving.
- Runs Claude Code or Codex in isolated worktrees or, when explicitly selected,
  the canonical checkout.
- Runs planned work through either a direct agent or an `almanac loop` queue.
- Preserves the exact solve prompt, lifecycle events, logs, result, branch, PR,
  merge, and deployment evidence.
- Supports unlimited named profiles while allowing runs in inactive profiles to
  finish safely.
- Provides persistent desktop terminal sessions, background terminals, buffer
  restoration, manual terminal naming, and protocol-owned agent activity state.
- Integrates with Okena as an optional visible execution and planning surface.

## System model

```text
Provider / CLI / API / extension
              │
              ▼
        ItemCommands
              │
       Inbox or Queue
              │
              ▼
     lane-aware Drainer
        ┌─────┴─────┐
        ▼           ▼
      Solver    Almanac loop
        │           │
        └─────┬─────┘
              ▼
   result → dispatch → PR/deploy observation
```

### Items

An Item is Helm's durable unit of work. It has a project, lifecycle status,
execution ownership, optional source, stable workspace identity, and run
evidence.

Two kinds exist:

- **solve** — execute a coding task through the configured `Solver`;
- **loop** — execute an Almanac PRD/spec queue through `almanac loop`.

A planned solve Item remains the same Item. Planning does not create a second
work record or change its kind; the operator chooses direct-agent or loop
execution when starting it.

### Lifecycle and ownership

| State | Meaning |
| --- | --- |
| Inbox | Source-backed work is waiting for human intent review. |
| Queue | Work is ready, but agent/manual ownership may still be undecided. |
| Active | A human owns the work or an interactive planning session. |
| Running | Helm owns an active agent or loop run. |
| Review | Work or a pull request needs human review. |
| Done | Work is complete. |
| Failed | The last execution failed and can be retried or reopened. |
| Cancelled | Work was cancelled and may be retried. |

Automatic and source-backed Items enter Inbox. Manually created Items enter
Queue. Queue Items are not silently claimed: choosing **Start agent** records
agent ownership, while **Work manually** moves the Item to human-owned Active.

## Requirements

- macOS for the supported desktop and launchd workflow;
- Node.js 20 or newer;
- npm for the daemon;
- Bun for the desktop app;
- Git;
- `gh`, authenticated for repositories where Helm creates or observes PRs;
- at least one supported agent CLI—`claude`, `codex`, or `pi`—installed and authenticated;
- `almanac`, including its CLI and agent plugin/commands;
- `dtach` for persistent desktop terminal sessions; and
- optionally, Okena with its remote server enabled.

The daemon can be run directly during development on other Unix-like systems,
but the primary installation path and desktop behavior are macOS-oriented.

## Quick start

### 1. Install daemon dependencies

```bash
npm install
cp helm.config.example.json helm.config.json
```

Edit `helm.config.json` with a provider token and the repositories Helm may
operate on.

### 2. Install and start the daemon

```bash
make install
helm status
```

`make install` builds the backend, links the `helm` CLI, and installs/starts the
`com.helm.daemon` launchd job. The API listens at
`http://localhost:7474/api` by default.

For foreground development instead:

```bash
npm run dev
```

Do not start a development daemon while the launchd daemon already owns port
`7474`; daemon initialization has side effects before the port bind fails.

### 3. Install and open the desktop app

```bash
cd app
bun install
bun run start
```

Bun's install runs the Electron/native-module setup declared in
`trustedDependencies`. The app build also rebuilds the root backend so the
renderer and daemon protocol cannot drift silently.

The app registers `helm://item/<id>` deep links. The legacy `vigil://` scheme is
accepted for compatibility.

## Configuration

`src/config.ts` is the canonical schema. Helm loads configuration in this order:

1. an explicit path supplied by code;
2. `$HELM_CONFIG`;
3. legacy `$VIGIL_CONFIG`;
4. `./helm.config.json`; then
5. legacy `./vigil.config.json`, with a rename warning.

A minimal configuration:

```json
{
  "provider": {
    "type": "contember",
    "apiBaseUrl": "https://api-clientcare.eu.contember.cloud",
    "projectSlug": "clientcare",
    "apiToken": "YOUR_CONTEMBER_API_TOKEN"
  },
  "projects": [
    {
      "slug": "my-project",
      "repoPath": "/Users/you/code/my-project",
      "baseBranch": "main"
    }
  ],
  "solver": {
    "type": "default",
    "agent": "claude",
    "workspace": "worktree",
    "concurrency": 2,
    "timeoutMinutes": 30
  },
  "spawner": {
    "name": "default"
  },
  "server": {
    "host": "localhost",
    "port": 7474
  }
}
```

Important fields:

| Field | Purpose |
| --- | --- |
| `provider` | The single live, re-pollable task source. The current built-in provider is Contember. |
| `projects[]` | Allowed repositories: `slug`, `repoPath`, `baseBranch`, optional `worktreeDir` and UI `color`. |
| `polling.intervalSeconds` | Provider polling interval; minimum 5 seconds, default 60. |
| `polling.since` | Optional ISO lower bound for provider discovery. |
| `solver.type` | `default` for direct headless execution or `okena` for Okena execution. |
| `solver.agent` | Default CLI: `claude`, `codex`, or `pi`. |
| `solver.workspace` | Default execution location: `worktree` or `main`. |
| `solver.concurrency` | Shared direct-solve capacity, from 1 to 10; default 2. |
| `solver.model` | Optional default model passed to the selected agent CLI. Pi accepts provider-qualified IDs such as `anthropic/claude-sonnet-5` or `openai-codex/gpt-5.6-luna`. |
| `solver.timeoutMinutes` | Direct-agent wall-clock timeout; Okena uses it as an idle timeout. |
| `solver.branchNaming` | Optional AI-generated conventional branch names; disabled by default. |
| `solver.displayName` | Short AI-generated Item labels; enabled by default. |
| `solver.triage` | Advisory intent assessment for Inbox work; enabled by default. |
| `solver.modelGuidance` | Per-model execution guidance overrides keyed by model ID. |
| `spawner.name` | Default interactive planning adapter, such as `default` or `okena`. |
| `github.createPrs` | Allow fallback PR creation; default true. |
| `github.postComments` | Post provider comments for eligible source tasks; default true. |
| `github.trackDeployments` | Observe merge and GitHub Deployment state; default true. |
| `server.host` / `port` | Local API listener; defaults to `localhost:7474`. |

To use Pi, install it globally (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`), run `pi` and `/login`, then choose **Pi** in Settings or an Item's Execution setup. Helm does not read Pi credentials; the daemon process uses Pi's own authentication under its HOME. Ensure `pi` is on the launchd daemon's PATH. Pi model choices are provider-qualified because one Pi installation can use several providers.

The desktop Settings UI edits the same validated Config Document. Secret values
are redacted on reads and preserved when unrelated settings are saved. A
launchd-managed idle daemon restarts itself after a successful save; active runs
defer restart.

### Execution selection

Solve Items may override the daemon defaults for:

- Agent — Claude Code or Codex;
- Model;
- Effort; and
- Workspace — Worktree or Main.

The same selection is honored by direct-agent and planned-loop execution.
Selecting Main gives the agent access to the canonical checkout. Helm does not
reset, detach, or clean that checkout; the prompt tells the agent to preserve
pre-existing work and create its own branch before editing.

## Core workflows

### Provider tasks

The Poller discovers new source tasks and creates Inbox Items. Helm enriches them
in the background with a short display name and advisory intent assessment. The
operator can then:

- approve into Queue;
- start immediately;
- plan interactively;
- reject; or
- mark already-completed work Done.

Assessment is advisory. It never changes lifecycle state automatically.

### Manual solve work

```bash
helm add solve \
  --project my-project \
  --title "Fix the empty state" \
  --prompt "Correct the empty-state copy and add regression coverage." \
  --base-ref main
```

This creates a Queue Item through the running daemon. Track and start it in the
Helm app.

Equivalent API request:

```bash
curl -sS http://localhost:7474/api/items \
  -H 'content-type: application/json' \
  -d '{
    "kind": "solve",
    "projectSlug": "my-project",
    "title": "Fix the empty state",
    "prompt": "Correct the empty-state copy and add regression coverage.",
    "baseRef": "main"
  }'
```

Use `parallelism` to create a sibling group through Item Commands rather than
issuing repeated create requests yourself.

### Captured tasks and attachments

Use `helm ingest` for a self-contained task that has no live provider API, such
as an email or note:

```bash
helm ingest \
  --project my-project \
  --title "Investigate customer export" \
  --body-file ./message.md \
  --attach ./example.xlsx \
  --meta From=customer@example.com \
  --external-id mail-123
```

Captured tasks enter Inbox with frozen source context. Attachments are stored by
Helm, rendered in the desktop detail, and copied into the execution workspace
under `.helm-attachments/`. The ingest route is size-bounded and treats all
external content as untrusted data.

If the active provider supports task creation, Helm can later promote a captured
Item into a real provider task without losing the original captured context.

### Interactive planning

Planning is a separate `Spawner` capability, not a Solver mode. Planning:

1. claims the Item as human-owned Active work;
2. creates or reuses the selected workspace;
3. writes context under `docs/plans/<planDirName>/`; and
4. opens or stages the configured planning surface.

Plan readiness is observed separately from Item lifecycle:

- **Planning** — a session exists but no runnable spec was found;
- **Plan ready** — a spec/PRD exists without an explicit ticket queue;
- **X of Y tickets complete** — local and associated GitHub tickets exist.

A planned solve can start the direct agent or the complete agent-ready Almanac
queue. It remains the same Item in both cases.

### Run Context

Each solve Item has an optional editable **Run Context** document. It is an
operator-owned, persisted override for the description and comments used by
future plans/runs.

Run Context does not mutate:

- the provider's live task;
- captured ingest evidence;
- the manual Item's canonical prompt; or
- the immutable solve-input snapshot from a previous attempt.

It uses optimistic revisions, survives retries and recovery, and cannot be
edited while the Item is running. Reset fetches the latest source context before
clearing the override.

### Solve and dispatch

A solve run proceeds through five phases:

1. resolve provider, captured, or manual context;
2. create/reuse the workspace and invoke the configured Solver;
3. persist the solver-produced event timeline;
4. read `docs/plans/<planDirName>/solver-result.json`; and
5. dispatch the result.

The agent may ship a PR itself. If `solver-result.json` includes `prUrl`, Helm
records it and does not create another PR. Otherwise Helm can push the branch,
open a PR, and post a provider comment according to configuration.

A failed solve that still left committed, shippable work or a PR can reconcile
to Review instead of presenting a false failure.

### Loop execution

Create a standalone loop Item with:

```bash
helm add loop \
  --project my-project \
  --title "Run the export PRD" \
  --prd-path docs/plans/export/prd.md \
  --mode afk \
  --iterations 10
```

Helm runs loop work through `almanac loop`, not through the Solver. It prepares a
missing loop prompt, records the Almanac run ID, observes the run registry, and
uses `.loop-stop` for cancellation.

## Profiles

Helm supports unlimited named profiles with one globally active profile.
Profiles select which configured projects are visible, polled, and eligible for
new ordinary work.

Important behavior:

- all profiles share one tenant-scoped SQLite database;
- every Item and event remains bound to its profile;
- running work captures immutable profile ownership before asynchronous work;
- switching profiles does not restart or quiesce the daemon;
- runs in inactive profiles continue and remain observable;
- inactive queued work waits for its profile to become active;
- attachments, logs, terminal sessions, and terminal buffers remain
  profile-namespaced; and
- a dirty Run Context editor blocks switching rather than discarding edits.

Switch profiles from the Work toolbar's **…** menu or the native Helm menu.
Manage, archive, and restore profiles in **Settings → Profiles**.

## Desktop terminals

The right side of the Helm app is a real xterm.js terminal backed by `node-pty`.
When `dtach` is available, sessions survive app quit or crash and reattach on the
next launch.

Desktop terminal features include:

- persistent tabs and restored screen snapshots;
- manual rename pins that are not overwritten by OSC titles;
- custom pointer tab reordering;
- **Background terminals**, which stay attached while leaving the tab strip;
- Open versus Restore as separate operations;
- a visible Background control that names the currently viewed parked terminal;
- grace-close with Undo;
- protocol-owned agent activity and needs-attention indicators, with optional precise Pi lifecycle and tool-name tooltips;
- explicit **Settings → Agent integrations** installation for Helm's privacy-bounded Pi reporter;
- a global **Settings → Terminal** starting folder for new ordinary terminals, with Home fallback; and
- a Helm-owned overlay scrollbar and synchronized-output guard for large redraws.

Helm never infers agent activity from output, process names, shell prompts,
silence, or PTY liveness. OSC 9;4 remains the compatibility signal. When the
operator installs Helm's managed Pi extension, its versioned heartbeat becomes
the precise source for idle/working/blocked state and bounded safe phase labels;
missed heartbeats degrade to unknown rather than leaving stale confidence.

## Okena integration

Set `solver.type` to `okena` to execute solve runs in visible Okena terminals.
Set `spawner.name` to `okena` independently to use Okena for interactive
planning.

Okena must have its remote server enabled. Helm follows Okena's advertised local
Unix-socket endpoint and falls back to TCP only for older configurations.
Configured Okena execution fails visibly when Okena is unavailable; Helm never
silently substitutes the default Solver.

Every Item can also be opened in Okena. Helm focuses an existing pane, registers
an existing worktree, or creates the required workspace according to a
server-computed preview. Focus is control-plane only: Helm sends no input to a
running terminal.

## CLI

```text
helm start        Start/install the launchd daemon job
helm stop         Stop the daemon
helm status       Show daemon status
helm logs         Follow stdout logs
helm logs --err   Follow stderr logs
helm add          Create queued solve or loop Items
helm ingest       File captured work with optional attachments
helm help         Show command help
```

`helm add` and `helm ingest` are thin HTTP clients. They do not open the database
or load `helm.config.json`. Their daemon URL is resolved as:

1. `--url`;
2. `$HELM_URL`;
3. legacy `$VIGIL_URL`; then
4. `http://localhost:7474`.

This allows another agent or repository to file work into the one running Helm
daemon safely.

## HTTP API

The daemon is API-only:

- `GET /` returns a small identity document;
- `/api/status` reports protocol/build/queue state;
- `/api/items` lists or creates Items;
- `/api/items/:id` returns expensive single-Item detail;
- `/api/items/:id/{approve,start,cancel,retry,reject,reopen,plan}` performs
  guarded commands;
- `/api/items/:id/run-context` reads or saves editable Run Context;
- `/api/items/ingest` creates captured work atomically;
- `/api/config` exposes the redacted Config Document; and
- profile routes switch or manage the active tenant.

Example checks:

```bash
curl -sS http://localhost:7474/api/status
curl -sS http://localhost:7474/api/items
```

Lifecycle writes go through `ItemCommands`; clients must not write SQLite rows or
Item events directly.

## Storage and recovery

The daemon stores its shared database as `helm.db` relative to its startup
working directory. A legacy `vigil.db` is renamed automatically only when doing
so is unambiguous. If both files exist, Helm warns instead of guessing.

Profile-owned filesystem data includes attachments, logs, terminal session
metadata, and terminal buffer snapshots. Database migrations are append-only and
run at startup.

Back up or restore profile data with the documented runbook:

- [`docs/runbooks/profile-data-backup-restore.md`](docs/runbooks/profile-data-backup-restore.md)

Do not patch lifecycle state directly in SQLite. Use the app or guarded Item
commands so timestamps and events remain consistent.

## Architecture

```text
src/
  actions/          PR creation, dispatch, provider comments
  attachments/      captured attachment storage and worktree copies
  auth/             local scoped capabilities for guarded control surfaces
  db/               SQLite schema, migrations, profile-bound access
  extensions/       optional Solver/Spawner integrations such as Okena
  github/           PR/deployment observation
  items/            Item schema, store, commands, context, contract, observation
  plan/             PlanWorkspace paths, artifacts, and readiness
  poller/           provider discovery into Inbox
  profiles/         profile runtime and active-profile state
  providers/        live TaskProvider implementations and registry
  queue/            Drainer, solve worker, loop runner
  scheduled-runs/   disabled-by-default scheduling foundations
  server/           Hono API and guarded daemon restart
  solver/           Solver seam, agent adapters, prompt/result handling
  spawner/          interactive planning seam
  worktree/         asynchronous, repo-locked Git worktree management

app/
  src/main.ts       Electron main process and restricted IPC adapters
  src/helm-bridge.ts
                    daemon polling and command proxy
  src/sessions.ts   persistent dtach terminal registry
  src/renderer/     xterm workspace and React Work sidebar

extension/
  src/              SolidJS task widget and daemon client
```

Core boundaries:

- `TaskProvider` owns live external task access.
- `ItemCommands` owns lifecycle writes and events.
- `Drainer` owns queue admission and lane capacity.
- `Solver` owns autonomous solve execution.
- `Spawner` owns interactive planning.
- `PlanWorkspace` owns every `docs/plans/<planDirName>/` path.
- `HelmBridge` owns desktop-to-daemon HTTP.
- Profile-bound stores own every tenant-scoped database operation.

See [`AGENTS.md`](AGENTS.md) and [`docs/adr/`](docs/adr/) for the detailed
engineering contract.

## Extending Helm

### Add a live provider

1. Implement `TaskProvider` under `src/providers/`.
2. Extend the provider config schema in `src/config.ts`.
3. Register it in `src/providers/registry.ts`.
4. Create Items through `ItemCommands`.

A frozen email/note is not a provider. Use captured context through the ingest
route.

### Add a Solver

1. Implement `Solver` under `src/solver/` or `src/extensions/<name>/`.
2. Extend the `solver.type` schema.
3. Register construction in `src/solver/registry.ts`.

Do not instantiate Solvers at route or queue call sites.

### Add a planning surface

Implement `Spawner` under `src/extensions/<name>/spawner.ts` and export
`createSpawner(config)`. Spawner availability is discovered from installed
adapters; it is intentionally independent of the active Solver.

## Development

Backend checks:

```bash
npm run lint
npm run test
npm run build
# or
make test
make check
```

Desktop checks:

```bash
cd app
bun run build
bun run storybook
# static Storybook verification
bun run storybook:build
```

Extension build:

```bash
cd extension
node build.mjs
```

The root build does not build the desktop app or extension. Run the additional
checks whenever those surfaces change.

## Experimental foundations

The repository contains foundations for features that are **not yet available
as complete operator workflows**:

- **Scheduled interactive agent runs** — persistence, recurrence, scoped
  capabilities, workspace isolation, supervisor, and service foundations exist,
  but the Electron resident lease, authenticated control/report routes,
  notifications, adoption, and user interface are not complete. The current
  daemon intentionally supplies no resident lease, so enabling
  `scheduledRuns.enabled` does not admit occurrences.
- **Moving live terminals between profiles** — fail-closed journal, recovery,
  ownership attestation, and persistence foundations exist, but the complete
  main/renderer transaction and user command are not exposed.
- **Terminal tab groups** — profile-scoped group persistence exists, while the
  complete renderer interaction is still under development.

These boundaries are deliberate. Do not expose partial runtime controls or infer
success from the presence of a config flag.

## Troubleshooting

### The CLI cannot reach Helm

Confirm the daemon is running and the URL is correct:

```bash
helm status
helm logs --err
curl -sS http://localhost:7474/api/status
```

Use `--url` or `$HELM_URL` if the daemon uses a non-default loopback port.

### A config save did not apply

Launchd-managed idle daemons restart themselves after a save. A running Item or
recoverable scheduled-run state defers restart. The Settings notice or API
response reports that restart is pending.

### A run returned to Queue after a daemon restart

Helm recovers stale Running Items, but a previously spawned agent process may
still exist. Keep the Drainer paused until the workspace and surviving process
are inspected; do not start a duplicate blindly.

### Okena reports authentication or configuration errors

Helm reloads Okena's active profile and CLI token for each call and prefers the
advertised local socket. If Okena changes its profile layout, verify its
`profiles.json`, active profile, `cli.json`, and `remote.json` files.

### Desktop sessions do not restore

Confirm `dtach` is installed and that the configured socket directory is short
enough for macOS AF_UNIX path limits. Helm falls back to non-persistent terminals
when the namespace cannot be used safely.

## Legacy compatibility

The project was previously named Vigil. Compatibility remains for:

- the `vigil` CLI alias;
- `$VIGIL_CONFIG` and `$VIGIL_URL`;
- `vigil.config.json`;
- `vigil.db` migration; and
- `vigil://` deep links.

New integrations should use Helm names exclusively.
