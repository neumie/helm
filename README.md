# Helm

AFK automation daemon for repo work. Helm polls external sources, creates or
accepts operator-created Items, drains them through solve and loop lanes, and
shows run state in one dashboard.

## How It Works

```
Source / Dashboard -> Item Commands -> Drainer lanes -> Solver / Almanac loop -> Dispatch / Run Observation
```

1. **Item** - one unit of work. Every Item has a Kind, status, project, title,
   BaseRef, payload, optional Source, optional GroupId, and run metadata.
2. **Kind** - `solve` or `loop`.
   - `solve` runs the configured agent through the Solver seam.
   - `loop` shells out to `almanac loop`.
3. **Source** - external origin for poller-created Items. Source is optional;
   dashboard/API-created Items are first-class without it.
4. **Inbox** - Automatic/source-backed solve Items start `inbox`; approve moves
   them to Queue (`ready`), reject cancels them. Every manually added Item,
   including Plan-intent creation, starts directly in Queue. A Queue Item is
   ownership-undecided: start an agent (`workMode: agent`) or take it manually
   (`status: active`, `workMode: manual`); manual Active work is never scheduled.
5. **Lane** - Drainer has separate solve and loop lanes. Solve capacity follows
   `solver.concurrency`; loop capacity is currently 1. Each lane runs oldest
   queued Item first.
6. **Spawner** - interactive planning seam. Plan creates or reuses an Item
   worktree, writes plan files under `docs/plans/<planDirName>/`, and execution
   later reuses that worktree.
7. **Dispatch** - solve Items record a pre-shipped PR when the agent already
   shipped one; otherwise Helm can push the branch, open a PR, and post a
   provider comment when config allows it.
8. **Run Observation** - dashboard state comes from the server contract:
   lifecycle events, solve logs, PR status, and almanac status files are
   normalized before clients render them.

API: **<http://localhost:7474/api>** — the daemon is API-only. The UI is the
**Helm app** (`app/`, native Electron sidebar + terminal) plus the Chrome
extension; both speak `/api`.

## Prerequisites

- Node.js 20+
- `claude` CLI or `codex` CLI installed and authenticated
- `gh` CLI for PR creation and PR status
- `almanac` CLI/plugin installed for solve prompts and loop Items
- Git

## Setup

```bash
npm install
cp helm.config.example.json helm.config.json
# Edit helm.config.json with provider credentials and project paths
```

## Configuration

`helm.config.json` is validated with Zod (a legacy `vigil.config.json` still
loads, with a startup warning asking for a rename; `HELM_CONFIG` is preferred
over the legacy `VIGIL_CONFIG` env var).

| Field | Description |
| ------- | ------------- |
| `provider` | External source config: `type`, credentials, optional `taskBaseUrl` for Source links |
| `projects` | Repos Helm can work on: `slug`, `repoPath`, `baseBranch`, optional `worktreeDir`, optional dashboard `color` |
| `polling.intervalSeconds` | Poll interval for external Source discovery (default: 60) |
| `polling.since` | ISO date to start polling from |
| `solver.type` | `"default"` for headless Solver, `"okena"` for visible Okena terminal execution |
| `solver.agent` | Default agent: `"claude"` or `"codex"` |
| `solver.concurrency` | Solve lane capacity (default: 2) |
| `solver.timeoutMinutes` | Per-solve timeout (default: 30) |
| `solver.model` | Agent model override (optional) |
| `spawner.name` | Default interactive planning surface, e.g. `"default"` or installed adapter `"okena"` |
| `github.createPrs` | Enable fallback PR creation for solve Items (default: true) |
| `github.postComments` | Enable provider comments for Source-backed solve Items (default: true) |
| `github.prPrefix` | PR title prefix (default: `[Helm]`) |

Settings in the Helm app use the same Config Document shape as the API. Secret
fields are redacted and preserved on save.

## Running

```bash
# Development (backend API)
npm run dev

# Helm app (native UI): see app/README.md
cd app && bun install && bun run start

# Production daemon (macOS launchd)
make install
helm status
helm logs
helm logs --err
helm stop
make restart
make uninstall
```

The backend listens on `:7474` (API-only; `GET /` is a tiny identity probe).

## Creating And Running Items

Create a solve Item:

```bash
curl -sS http://localhost:7474/api/items \
  -H 'content-type: application/json' \
  -d '{
    "kind": "solve",
    "title": "Fix dashboard empty state",
    "projectSlug": "my-project",
    "prompt": "Fix the empty state copy and verify the dashboard.",
    "baseRef": "main"
  }'
```

Create a loop Item:

```bash
curl -sS http://localhost:7474/api/items \
  -H 'content-type: application/json' \
  -d '{
    "kind": "loop",
    "title": "Run AFK PRD slice",
    "projectSlug": "my-project",
    "prdPath": "docs/plans/example/prd.md",
    "mode": "once"
  }'
```

Add `"intent": "plan"` to a create payload to express the client's planning
intent. Manual Items enter Queue immediately but stay ownership-undecided until
someone chooses Start agent or Work manually; call `/items/<id>/plan` first when
interactive planning is needed.

CLI equivalents write to the same Item Commands path:

```bash
helm add solve --project my-project --title "Fix dashboard empty state" \
  --prompt "Fix the empty state copy and verify the dashboard." --base-ref main

helm add loop --project my-project --title "Run AFK PRD slice" \
  --prd-path docs/plans/example/prd.md --mode once

```

Useful operator actions:

```bash
curl -sS -X POST http://localhost:7474/api/queue/resume
curl -sS -X POST http://localhost:7474/api/items/<id>/plan
curl -sS -X POST http://localhost:7474/api/items/<id>/start
curl -sS -X POST http://localhost:7474/api/items/<id>/cancel
curl -sS -X POST http://localhost:7474/api/items/<id>/retry
curl -sS -X POST http://localhost:7474/api/items/<id>/approve
curl -sS -X POST http://localhost:7474/api/items/<id>/reject
```

When creating an Item, optional `spawner` stores an installed planning surface
from `/api/config` `spawnerAdapters`. Without it, Helm uses the configured
`spawner.name` default.

Check queue + lanes:

```bash
curl -sS http://localhost:7474/api/status
curl -sS http://localhost:7474/api/items
```

Loop Items should record `almanacRunId` and show loop status from
`.almanac/runs/<runId>/status.tsv` when that file exists in the Item worktree.
Solve Items should show the prompt snapshot, timeline events, log tail, result
summary, branch, and PR link when available.

## Storage Reset

The AFK rework treats pre-rework local storage as disposable. Old `tasks`,
tiering, solver confidence, and chat state are not migrated into Items. The
default DB path is `./helm.db` (a legacy `./vigil.db` is renamed automatically
on startup); stop Helm and move or delete that file if an
old local DB confuses operator testing. A fresh DB will be initialized on next
start.

## Okena Integration

When `solver.type` is `"okena"`, Helm runs solve execution inside visible
[Okena](https://github.com/nickarora/okena) terminal panes. Set
`spawner.name` to `"okena"` to also open planning sessions in Okena. If Okena is
unavailable, configured Okena work fails loudly until Okena is reachable again.

Requires Okena remote server enabled (`remote_server_enabled: true` in Okena
settings).

## Solve Execution

The solve prompt builder (`src/solver/prompt-builder.ts`) delegates workflow to
Almanac skills such as `/almanac:task-start`, `/almanac:branch-name`,
`/almanac:ship`, and `/almanac:commit`. The agent must write
`docs/plans/<planDirName>/solver-result.json`; Helm reads that file only.

## Architecture

```
src/
  providers/       # External Source abstraction
  poller/          # Source discovery -> Inbox Items
  items/           # Item schema, store, commands, contract, observation
  queue/           # Drainer, solve lane, loop lane, almanac loop runner
  solver/          # Solve-only execution seam
  spawner/         # Interactive planning seam
  actions/         # Solve dispatch: PR recording/creation + provider comments
  worktree/        # Git worktree lifecycle
  plan/            # PlanWorkspace paths + IO
  db/              # SQLite persistence
  server/          # Hono API (API-only; no static UI)
app/               # Helm desktop app (Electron; React sidebar + terminal)
extension/         # Solid extension
```

## Adding A Provider

1. Implement `TaskProvider` in `src/providers/<name>.ts`.
2. Add provider config to the discriminated union in `src/config.ts`.
3. Register it in `src/providers/registry.ts`.
4. Emit Source-backed Items through Item Commands; do not write Item status or
   events directly from the provider.
