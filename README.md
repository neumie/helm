# Helm

Helm is my local workspace for software work: persistent terminals, an agent work
queue, planning, and document review in one macOS app. It connects tasks and
captured context to agent execution, worktrees, pull requests, and deployment
evidence, while keeping human ownership and review explicit.

It is also my personal testing ground. This repository contains the tools,
integrations, UI ideas, and workflows I'm testing, trying, and using day to day.
Some are established parts of my setup; others are experiments or incomplete
foundations. Expect it to evolve with how I work, not as a stable, general-purpose
product with every feature ready for everyone.

The project includes:

- the **Helm desktop app**, with a Work sidebar, persistent terminals, and native
  Markdown document review;
- an API-only Node.js daemon that owns Items, persistence, and execution;
- optional **Helm Remote**, a separate browser/PWA surface for enrolled live Pi
  conversations;
- a Chrome extension for acting on tasks from their source page; and
- a thin `helm` CLI for daemon control and scriptable Item creation.

The old browser Item dashboard is gone. The desktop app is the main Helm UI;
Remote is a conversation surface, not a browser replacement for the Work sidebar.

> [!IMPORTANT]
> Helm is designed as a local operator tool. Its HTTP API can launch coding
> agents and perform repository operations. Keep it on a loopback interface and
> do not expose port `7474` to an untrusted network.

## What Helm does

- Polls a live task provider and files new work into **Inbox**.
- Accepts manual solve requests, unassigned capture drafts, Almanac loops, emails,
  notes, and attachments.
- Uses a human approval checkpoint before automatic/source-backed work runs.
- Keeps Queue ownership explicit: **Start agent** or **Work manually**.
- Opens interactive planning sessions without conflating planning with solving.
- Runs Claude Code, Codex, or Pi in isolated worktrees or, when explicitly selected,
  the canonical checkout.
- Runs planned work through either a direct agent or an `almanac loop` queue.
- Preserves the exact solve prompt, lifecycle events, logs, result, branch, PR,
  merge, and deployment evidence.
- Preserves exact external project-knowledge evidence for each attempt and queues
  agent-learned candidates for Hold, which owns review and canonical writes.
- Supports unlimited named profiles while allowing runs in inactive profiles to
  finish safely.
- Provides persistent desktop terminal sessions, named tab groups, background
  terminals, buffer restoration, manual naming, and protocol-owned agent activity.
- Reviews real Markdown files beside a Claude Code, Codex, or Pi conversation,
  with passage-level feedback, local comments, and watched source changes.
- Supports opt-in scheduled agent runs, with native attention notifications and
  explicit terminal takeover.
- Offers paired-device access to enrolled Pi conversations through Remote,
  including prompts, images, supported questions, and bounded conversation history.
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

An Item is Helm's durable unit of work. It has a lifecycle status, execution
ownership, optional source, and run evidence. Assigned Items also have a project
and stable workspace identity. A source-less solve can start as an **Unassigned**
capture draft; it cannot run or plan until the operator finishes project setup.

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
- `almanac` and its agent skills/commands for the workflows that use them
  (Almanac loop execution supports Claude Code and Codex, not Pi);
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

The app registers `helm://item/<id>` and profile-qualified Item deep links. The
legacy `vigil://` scheme is accepted for compatibility.

`cd app && bun run start` opens only the desktop app. Root `bun run start` builds
and launches the desktop plus the separate Remote runtime, or reuses a compatible
authenticated Remote host. Read the [Remote onboarding guide](docs/remote/onboarding.md)
before using that combined path; it does not configure HTTPS or enroll Pi for you.

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
      "repoPath": "/path/to/code/my-project",
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
| `projects[]` | Allowed repositories: `slug`, `repoPath`, `baseBranch`, optional `worktreeDir`, and UI `color`. |
| `knowledge.providers[]` | Optional external knowledge instances by safe ID and adapter type; Hold uses private Unix-socket and capability-file paths. Project bindings live with profiles. |
| `polling.intervalSeconds` | Provider polling interval; minimum 5 seconds, default 60. |
| `polling.since` | Optional ISO lower bound for provider discovery. |
| `solver.type` | `default` for direct headless execution or `okena` for Okena execution. |
| `solver.agent` | Default CLI: `claude`, `codex`, or `pi`. |
| `solver.workspace` | Default execution location: `worktree` or `main`. |
| `solver.concurrency` | Daemon-global direct-solve and scheduled-agent capacity: a positive safe integer or `null` for Unlimited; default 2. |
| `solver.loopConcurrency` | Separate daemon-global loop capacity: a positive safe integer or `null` for Unlimited; default 1. |
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
| `scheduledRuns.enabled` | Opt into scheduled runs; default false, requires a loopback listener and an active desktop resident lease. |
| `scheduledRuns.systemTargetsEnabled` | Separately opt into system-target schedules; default false. |

To use Pi, install it globally (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`), run `pi` and `/login`, then choose **Pi** in Settings or an Item's Execution setup. Helm does not read Pi credentials; the daemon process uses Pi's own authentication under its HOME. Ensure `pi` is on the launchd daemon's PATH. Pi model choices are provider-qualified because one Pi installation can use several providers.

The desktop Settings UI edits the same validated Config Document. Secret values
are redacted on reads and preserved when unrelated settings are saved. A
launchd-managed idle daemon restarts itself after a successful save; active runs
defer restart.

### Execution selection

Solve Items may override the daemon defaults for:

- Agent — Claude Code, Codex, or Pi;
- Model;
- Effort; and
- Workspace — Worktree or Main.

Direct-agent runs honor all four fields. Planned loops honor the same selection
for Claude Code or Codex; Pi-selected loops are explicitly refused. Run limits
live in **Settings → Execution → Run limits**, with separate Agent and Loop
budgets and an explicit Unlimited option.

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
Helm app. Automatic Queue admission starts paused; choose **Resume queue** from
Work's More menu to opt into background pulling. An explicit **Start agent**
still starts that Item while automatic admission is paused.

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

The native **New item** page also accepts a title, prompt, or both without a
project. These drafts remain Unassigned in Queue until **Finish setup** assigns a
configured project; they cannot accidentally launch in the first repository.

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

### Document review

Open **File → Open Markdown file…**, or choose **Review document** on an Item's
Plan document. The native review window renders the real repository Markdown
beside your **already-running** Claude Code, Codex, or Pi conversation. The agent
can open it itself with `helm review open spec.md --agent pi --wait --json`
(use `claude` or `codex` for those callers).

Select a passage to **Discuss** it or request a **Change**, keep local comments,
use the outline for long documents, and inspect externally observed changes.
The Markdown file stays the source of truth; Helm does not rewrite it for display.
Rendered selections use their containing source block, while Source view permits
exact ranges.

Helm never starts or resumes another review agent. The universal CLI returns
feedback through a waiting tool call in the original conversation; its full
connect/open/wait/reply/status/list/receipt/disconnect surface preserves that
session's context and permissions. The opt-in local Pi connector also provides
native live follow-ups through `helm_review` and `/helm-review`. Without a
listener, feedback stays not sent. Receipts do not guarantee an edit, and unknown
outcomes are never automatically replayed. See
[Document review](docs/document-review.md) for permissions, recovery, and limits.

### Scheduled runs

Open **Scheduled runs** from Work's More menu or Settings to create and edit
profile-owned schedules, inspect run history and running occurrences, cancel
eligible runs, or open a needs-attention terminal. Scheduling is off by default;
the page offers the existing guarded enable/restart flow.

The daemon admits due work only while the desktop supplies a valid resident
lease; it is not a headless cron service. Native notifications can take you to
the owning profile and adopt an existing scheduled terminal. Scheduled agents
share the direct-agent capacity budget without becoming Items. System targets
require a separate opt-in and are not a sandbox.

### Project knowledge

Helm does not scan, index, curate, review, or write a Markdown knowledge library.
Those responsibilities belong to an external provider. **Hold** is the first
production adapter, but Helm's `KnowledgeIntegration` seam, profile bindings,
evidence, and outbox remain provider-neutral.

Configure one or more Hold instances in `helm.config.json` by safe provider ID,
absolute private Unix-socket path, and an absolute private capability-file path.
The capability value never belongs in Helm config:

```json
{
  "knowledge": {
    "providers": [{
      "id": "local-hold",
      "type": "hold",
      "socketPath": "/path/to/private-hold-state/hold.sock",
      "capabilityFile": "/path/to/private-helm-state/hold.capability"
    }]
  }
}
```

Pair a dedicated Hold client with only `brief:prepare,candidates:submit` and the
explicit opaque Hold project IDs. Store its raw token in the configured file
beneath an owner-private directory with mode `0600`. Then use **Settings →
Profiles → Project knowledge** to map each enabled Helm project to a provider and
opaque provider project ID. No mapping means knowledge is disabled for that one
profile/project. Sharing one provider project across profiles requires an
explicit acknowledgement in every participating profile.

A configured mapping is required context: Plan, direct solve, and solve-through-loop execution obtain one bounded brief,
validate its hashes and UTF-16 manifest ranges, and persist the exact context,
selection identity, revision, provider timestamp, safe manifest, and frozen
provider target before launching an adapter. Unavailability or invalid evidence
fails the knowledge phase; Helm never silently launches without configured
context. Profile switching or later mapping edits cannot redirect stored evidence
or already-queued delivery.

Helm permanently owns only run evidence. Native Helm's main process uses the
daemon-local control capability to show the immutable snapshot under collapsed
**Knowledge used**. Lists omit run input; ordinary unauthenticated Item reads omit
knowledge evidence and redact knowledge-backed run input. Planning keeps canonical task/source data in auto-generated
`context.md` and writes exact provider bytes only to gitignored `.helm-knowledge-context.md`; both are fenced as untrusted reference data, and hidden files never enter plan previews or later prompt artifact feeds. Auto-generated `context.md` and `README.md` files do not cross the detail API.

For an admitted mapping, an agent may return at most five typed learned candidates in the gitignored
`.helm-knowledge-candidates.json` attempt sidecar. Helm reads it through a bounded no-follow descriptor and never reviews or applies
them. It freezes their provider destination and stores them in a leased,
idempotent delivery outbox. Event wakeups provide low latency; periodic
all-profile sweeps recover missed events, crashes, ambiguous responses, and
provider downtime. Delivery failure never changes a completed Item's lifecycle or
run outcome. Permanent authorization, scope, protocol, or validation failures are
`blocked`; after fixing the cause, operators can use **Retry delivery** in the
Item's **Knowledge used** disclosure. If the initial SQLite enqueue itself failed,
the private sidecar remains and the same disclosure offers **Recover delivery**;
a new solve attempt is refused until those candidates are durably recovered. The
frozen attempt destination and idempotency key remain unchanged. Hold alone owns
candidate compilation, review, and canonical writes.

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
- dirty Run Context and Document Review drafts protect profile switching rather
  than silently discarding edits.

Switch profiles from the Work toolbar's **…** menu or the native Helm menu.
Manage, archive, and restore profiles in **Settings → Profiles**. Profile metadata
and mutations use Electron main's local-control capability; the renderer never
receives that bearer.

## Desktop terminals

The right side of the Helm app is a real xterm.js terminal backed by `node-pty`.
When `dtach` is available, sessions survive app quit or crash and reattach on the
next launch. A full machine reboot necessarily ends their processes, but Helm
recreates fresh shells under the same durable tab identities, preserving names,
order, groups, background placement, and the last saved terminal buffer. Process
state and per-process working directories cannot survive a reboot.

Desktop terminal features include:

- persistent tabs and restored screen snapshots;
- manual rename pins that are not overwritten by OSC titles;
- custom pointer tab reordering and named, colored groups with independent strip
  and Background collapse state;
- **Background terminals**, which stay attached while leaving the tab strip;
- Open versus Restore as separate operations;
- a Background control with a count and explicit Open, Restore, and Close actions;
- grace-close with Undo;
- protocol-owned agent activity and needs-attention indicators, with optional precise Pi lifecycle and tool-name tooltips;
- standalone [`pi-agent-status`](https://github.com/neumie/pi-agent-status) package support with read-only detection and setup guidance in **Settings → Agent integrations**;
- a global **Settings → Terminal** starting folder for new ordinary terminals, with Home fallback; and
- a Helm-owned overlay scrollbar and synchronized-output guard for large redraws.

Helm never infers agent activity from output, process names, shell prompts,
silence, or PTY liveness. OSC 9;4 remains the compatibility signal. When the
operator configures `pi-agent-status`, its versioned heartbeat becomes
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

## Helm Remote

Remote is an optional, separate host and browser/PWA workspace for **existing
Pi conversations**. Pi remains the conversation writer and process owner;
Remote does not own terminals, launch agent sessions, or proxy the daemon on
port `7474`.

Its browser opens to live enrolled conversations. It supports text and image
prompts, steer/follow-up delivery, interrupt requests, supported questionnaires,
read-only current-conversation history, shared favorites, and available extension
information. Other custom terminal UI stays in Pi. Drafts are memory-only, and
uncertain commands are not replayed automatically.

Pair devices through **Settings → Remote** after configuring the separate host
and HTTPS origin. The browser can be installed where PWA support is available,
but this is not offline conversation support. Remote remains opt-in and under
active development; fixture or wire tests do not certify every installed Pi
integration or physical phone.

Read the [implementation record](docs/remote/README.md) and
[onboarding guide](docs/remote/onboarding.md) for setup, ownership, security,
and verification limits. Never expose the daemon to make Remote work.

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
  knowledge/        external integration seam, immutable evidence, delivery outbox
  plan/             PlanWorkspace paths, artifacts, and readiness
  poller/           provider discovery into Inbox
  profiles/         profile runtime and active-profile state
  providers/        live TaskProvider implementations and registry
  queue/            Drainer, solve worker, loop runner
  remote/           separate opt-in Pi conversation host and protocol
  scheduled-runs/   opt-in schedules, admission, supervision, and adoption
  server/           Hono API and guarded daemon restart
  solver/           Solver seam, agent adapters, prompt/result handling
  spawner/          interactive planning seam
  worktree/         asynchronous, repo-locked Git worktree management

app/
  src/main.ts       Electron main process and restricted IPC adapters
  src/helm-bridge.ts
                    daemon polling and command proxy
  src/sessions.ts   persistent dtach terminal registry and legacy review metadata
  src/document-review/
                    native document grants, drafts, caller mailbox, and IPC
  src/renderer/     xterm workspace, React Work sidebar, review and Remote views

packages/
  helm-remote-bridge/
                    opt-in connection from an existing ordinary Pi TUI
  helm-ask-user-question/
                    private questionnaire fork with local/remote completion

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

See `AGENTS.md` and [`docs/adr/`](docs/adr/) for the detailed engineering contract.

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

## Experiments and current limits

This is a working personal project, including the things I'm testing and trying,
not a promise that every subsystem is complete or deployed. Implemented native
features such as scheduled runs and tab groups sit alongside opt-in Remote work
and deliberately incomplete foundations:

- **Moving live terminals between profiles** has journal, recovery, ownership,
  and persistence foundations, but no complete production move command or
  mutation IPC.
- **Daemon restart ownership** remains unfinished. A surviving solver can outlive
  the daemon; active-run restart guards must stay in place. Recovery must not
  blindly launch a duplicate or replay dispatch effects.
- **Remote** has explicit integration, deployment, and physical-device proof
  boundaries. Unsupported custom UI remains terminal-only; complete extension
  fleet reporting is unfinished.
- **Document Review** connects existing agents through foreground CLI tools or
  the optional native Pi connector; the universal CLI is not idle injection.
  Original permission/question dialogs and interruption stay in the terminal.
  Browser, private-wire, real-provider and native Electron proofs are separate.

Use the subsystem docs and tests to check a feature's actual scope. A config flag,
prototype, or passing fixture is not evidence of a complete operator workflow.

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
