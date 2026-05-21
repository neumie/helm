# CLAUDE.md

Pipeline: poll -> solve -> tier -> dispatch.

## Self-maintenance

When you discover an undocumented gotcha, abstraction, mandatory pattern, or a subsystem missing from this file, **update CLAUDE.md before finishing the task**. Stale instructions cost the next agent more than they cost you to fix now.

## Mandatory abstractions

Two discriminated unions / interfaces gate where code goes. Bypass them and the daemon silently desyncs.

- **`TaskProvider`** (`src/providers/provider.ts`) — every external task source goes through this. Never import `contember.ts` (or any provider impl) outside `src/providers/`.
  - Implement four methods: `pollNewTasks`, `getTaskContext`, `resolveTaskSummary`, `postComment`. `resolveTaskSummary` seeds a new task row when `vigil run <externalId>` is invoked.
  - Extend the discriminated union in `src/config.ts`, register in `src/providers/registry.ts`.
- **`Solver`** (`src/solver/solver.ts`) — every code-execution backend implements `solve(SolveParams) → SolveResult`. Never spawn `claude` (or any agent CLI) outside a `Solver` impl; reuse `src/solver/invoker.ts` (which wraps `spawn-claude.ts` / `chat-invoker.ts`) instead of re-implementing process spawning. Wired in `src/index.ts` from `config.solver.type` (`'default' | 'okena'`). To add a backend: implement `Solver`, extend the enum in `src/config.ts`, branch in `src/index.ts`.

Task-context + prompt assembly lives in `src/task-context.ts` (`formatTaskContext`, `buildTaskContext`) and `src/solver/prompt-builder.ts` (instruction templates). These are plain functions, not a pluggable seam — there was a per-project `TaskTransformer` registry but it was never used and got removed. If genuinely-different prompt shapes per project ever materialize, reintroduce a seam then.

## Where new code goes

| Adding…                                  | Goes in                              |
|------------------------------------------|--------------------------------------|
| Support for a new task source            | `src/providers/<name>.ts` + registry |
| Different code-execution backend         | `src/solver/` or `src/extensions/<x>/` + `src/index.ts` switch |
| Prompt content / task-context shape      | `src/solver/prompt-builder.ts` + `src/task-context.ts` |
| New tier-driven action (PR, comment, …)  | `src/actions/dispatcher.ts` (comment markdown → `src/actions/comment-format.ts`) |
| New chat/MCP tool exposed to the solver  | `src/mcp/server.ts` (register via `server.tool(...)`) |
| New dashboard endpoint                   | `src/server/routes/api.ts` (mounted from `app.ts`) |
| New `tasks` column                       | `src/db/task-schema.ts` (Zod field) + append a migration to `src/db/schema.ts`. Nothing else — type, column map, and read-validation all derive from the schema. |
| Other DB query                           | `src/db/client.ts` |
| New `solver-result.json` field           | `src/solver/result-schema.ts` (Zod) + align the JSON template in `prompt-builder.ts`. Type is `z.infer`. |
| Anything in `docs/plans/<planDirName>/`  | `src/plan/workspace.ts` (`PlanWorkspace`) — paths + IO. Never re-derive the path with `join(..., 'docs', 'plans', ...)` elsewhere. |
| Task→workspace identity (dir/branch)     | `src/plan/identity.ts` (`resolveTaskWorkspace`) |
| Throwing a phase-tagged / cancellation error | `src/util/errors.ts` (`phaseError(phase, msg)` / `taskCancelled()`). Never hand-build `Object.assign(new Error(...), { phase })` or `{ name: 'AbortError' }`. |
| A public chat link or a new chat session | `src/chat/links.ts` (`ChatLinks`): `urlForToken(token)` / `createSession(taskId)`. Never re-derive `baseUrl ?? localhost` or `${baseUrl}/chat/${token}`, and never call `signToken(randomUUID(), …)` + `createChatSession` by hand. |

## Pipeline (`src/queue/worker.ts`)

Five phases. Don't reorder, don't skip.

1. **Poll** — `provider.getTaskContext(externalId)`
2. **Worktree + Solve** — delegated to the active `Solver`. Returns `{ worktreePath, branchName, outcome }` where `outcome: { events, exitCode, rawOutput? }` is solver-produced.
3. **Persist timeline** — write `outcome.events` to DB events for the dashboard. Each `Solver` owns how it produces events (DefaultSolver parses CLI JSON via `parseClaudeOutput`; okena returns `[]`). The worker does NOT parse solver stdout.
4. **Parse result** — `new PlanWorkspace(worktreePath, planDirName).readResult()` reads `docs/plans/<planDirName>/solver-result.json`. No fallback: a missing/invalid file fails the task. Shape is one Zod source (`src/solver/result-schema.ts`); keep the JSON template in `prompt-builder.ts` in sync with it.
5. **Dispatch** — `dispatch()` routes by tier: trivial→ready PR, simple→draft PR, complex→push branch, unclear→post questions / open chat.

## Subsystems

- **`src/chat/`** — clarification chat. Signed tokens gate every route; never expose `session.id` over the wire, only the token. The chat *orchestration* (create invite + provider comment + webhook, the 24h wait loop, transcript assembly) lives in `ClarificationChat` (`src/chat/clarification.ts`); link identity lives in `ChatLinks` (`src/chat/links.ts`). Put new clarification behavior in the module, not in the MCP tool closures.
- **`src/mcp/server.ts`** — MCP server the running solver talks to. New solver capabilities go here as tools, not on the dispatcher. The chat tools (`vigil_create_chat`/`vigil_send_message`/`vigil_end_chat`) are a thin adapter over `ClarificationChat`: they translate args ↔ MCP content and own none of the orchestration. Don't re-inline session/wait/transcript logic into a tool closure — that's what got extracted.
- **`src/cli/`** — `vigil` binary wrapping launchd: `start` / `stop` / `status` / `logs` / `run`. **`vigil run <id>` executes one task and exits** — use it to debug a single task without re-polling or restarting the daemon.
- **`src/extensions/okena/`** — alternative `Solver` (local Okena daemon instead of `claude` CLI). Loaded via dynamic `import()` in `src/index.ts` with `DefaultSolver` fallback. Don't hard-import it.
- **Planning artifacts (`docs/plans/<planDirName>/` inside the worktree)** — interactive plan phase happens before the autonomous solve. `POST /api/tasks/:id/plan` calls `solver.startPlanningSession(...)` (one call — ensures worktree, writes `context.md`, spawns the agent with an interactive planning prompt: okena runs claude in a `plan: <title>` Okena terminal; default stages `docs/plans/<planDirName>/.planning-prompt.txt` for the user to run themselves). Persists `worktreePath`/`branchName`/`planDirName` on the task row and writes `docs/plans/<planDirName>/README.md`. The user talks to the planning agent, runs `/grill-me <planDirName>` / `/grill-plan <planDirName>` / `/prd-create` (almanac) — those write `docs/plans/<planDirName>/brief.md`, `prd.md`, etc. The autonomous run reuses the same worktree; `buildTaskContext` (`src/task-context.ts`) calls `PlanWorkspace.readArtifacts()`, which reads every `*.md` in that dir, sorts by mtime, and wraps each in a `<plan_artifact>` block prepended before the task context. The on-disk layout (paths + IO for `context.md` / `.planning-prompt.txt` / `solver-result.json` / `README.md`) is owned by `PlanWorkspace` (`src/plan/workspace.ts`) — go through it, don't re-derive the path. `planDirName` is `<YYYY-MM-DD>-<slug>` computed once via `computePlanDirName(task.title)` in `src/util/slug.ts` — stable per task; both the plan endpoint and the worker resolve it (and branch/worktree) through `resolveTaskWorkspace(task)` (`src/plan/identity.ts`), computing+persisting if not already on the row.

### Directory rules

- **`extension/`** — host permissions: `http://localhost:*/*` only. Never add tunnel/public URLs (manifest is canonical: `extension/manifest.json`).
- **`web/`** — React 19 only. Never downgrade; code uses 19-only features (Actions, `use`, ref-as-prop).

## Gotchas

- **Worktree cwd.** Solver code runs with the worktree as `cwd`. Reading `process.cwd()` from anywhere outside `Solver` impls or the worker hits the wrong tree (or the daemon's tree). Prefer paths derived from `worktreePath` / `projectConfig.repoPath`. Exception: module-load-time daemon paths (config, DB, logs) capture the daemon's startup cwd — that's intended. Note: `src/server/routes/api.ts:291` resolves `process.cwd()` per request to read the log path — that works only because the daemon never `chdir`s, so don't copy the pattern into code that might run after a `cwd` change.
- **Optional solver imports.** Extension solvers (e.g. `src/extensions/okena/`) load via dynamic `import()` in `src/index.ts` with a `DefaultSolver` fallback on failure. Never add a top-level static import for an optional/extension solver — an unavailable optional dep would crash startup. Mirror the okena pattern.
- **Claude can pre-ship.** If `docs/plans/<planDirName>/solver-result.json` carries `prUrl`, `dispatcher.ts` records it and skips tier routing entirely (Claude shipped via `/almanac:ship`). Don't add tier-only side effects assuming dispatch always runs the tier branch.
- **Okena token rotation.** Okena rotates the CLI token; `OkenaClient` reloads `cli.json` per call. Never cache the token in memory — long-running daemons will start returning HTTP 401 silently. Newly registered tokens activate only after Okena itself restarts.
- **Okena profile layout.** Okena keeps `cli.json`/`remote.json` under `profiles/<id>/`. `OkenaClient.resolveConfigDir()` reads `profiles.json` (`last_used` → `default_profile`) per call to find the active profile. Symptom of okena changing this layout again: `Error: Okena not configured` even though okena is running — re-check `resolveConfigDir()` against the new on-disk layout.
- **Silent solver fallback.** If `config.solver.type === 'okena'` but Okena is unavailable, `src/index.ts` logs a warning and falls back to `DefaultSolver`. Don't assume the configured type is the active type — read the startup log or `solver.constructor.name`.
- **Pipeline error protocol.** How solve-path code signals *which phase* failed and how cancellation is recognised lives in one module: `src/util/errors.ts`. Throw `phaseError(phase, msg)` (phase typed as `ErrorPhase` — a typo'd phase is a compile error, not a silent fall-through to the worker's default) and `taskCancelled()` (sets `name: 'AbortError'`). The worker's catch block classifies via `isCancellation(err, signal)` and `errorPhase(err)` (defaults to `'solve'` for an untagged throw). The constructors and the classifiers are two halves of one interface — never hand-build `Object.assign(new Error(...), { phase })` or `{ name: 'AbortError' }` again, or the typed seam leaks. A throw with no `phase` is recorded as `'solve'`.
- **Solver result: one source, one read path.** Phase 4 reads `docs/plans/<planDirName>/solver-result.json` via `PlanWorkspace.readResult()` only — there is NO stdout fallback (deleted; okena produces no stdout anyway). A missing/invalid file is a hard failure (`phase: 'solve'`). The shape is a single Zod source in `src/solver/result-schema.ts` (`SolverResult = z.infer<typeof solverResultSchema>`, re-exported via `types.ts`); `z.object` strips unknown keys, so any field the agent writes (e.g. `prUrl`) MUST be declared there or it's silently dropped — and the JSON template in `prompt-builder.ts` must stay in sync with the schema. `tier` reuses the DB's `tierSchema`, so result and `tasks.tier` can't diverge. The result *path* is owned by `PlanWorkspace` (`src/plan/workspace.ts`): `prompt-builder.ts` references it via `planPaths()`, so the prompt, the reader, and the okena poll path can't disagree.
- **MCP transports rotate every 30 min.** `src/mcp/server.ts` keeps a per-session transport map with a 30-min TTL. Tools that block longer than that (e.g. `vigil_send_message`'s 24h wait) must key their state by `sessionId` / DB rows, not by transport closure or in-memory state on the transport — otherwise they lose context across rotation. The 24h wait now lives in `ClarificationChat.sendAndAwaitReply` (`src/chat/clarification.ts`), driven by the `sessionId`-keyed event bus + DB reads — it holds no per-transport state, so the constraint is satisfied there; keep it that way.
- **`config.chat.baseUrl` is mutated at runtime.** When `config.chat.tunnel === true`, `tunnel.ts` overwrites `config.chat.baseUrl` after Cloudflare assigns a URL. Code that reads `baseUrl` before tunnel start gets the config-file value; after start gets the tunnel URL. Read it lazily, not at module load. **`ChatLinks` (`src/chat/links.ts`) is the single owner of this lazy read** — it resolves `baseUrl` at call time inside `urlForToken` / `createSession`. Build chat links through it, never inline; that's the one place the mutation gotcha is handled.
- **Chat token vs session id.** `chat_sessions` rows have both `id` (DB primary key) and `token` (signed, expiring). HTTP/URLs/logs: token only — `id` is not signature-verified, leaking it bypasses the gate. MCP tools: `sessionId` is the addressing key — don't "fix" them to take the token. The token/id split is enforced in one place: `ChatLinks.createSession` mints the token + row, `ChatLinks.urlForToken` only ever interpolates a token.
- **Stale processing tasks.** `src/index.ts` re-enqueues anything stuck in `processing` on startup. Don't write code that assumes "processing" means "currently running" — it might be a recovered task from a prior crash.
- **Legacy `clientcareId`.** The DB column is named `clientcare_id` (`clientcareId` in TS) but holds the provider-agnostic external ID (predates the provider abstraction). Don't read it as Contember-specific; don't rename without a migration.
- **`tasks` columns derive from one Zod schema.** `src/db/task-schema.ts` is the single source: `TaskRecord` type (`z.infer`), the camelCase↔snake_case map (`TASK_COLUMNS` via `camelToSnake`), and read-validation (`rowToTaskRecord`) all derive from it. snake_case is computed, never hand-maintained — so column names MUST be a clean `camelToSnake` of the TS key (no acronym quirks). `updateTask` throws on an unknown field (no more silent drops); `rowToTaskRecord` throws on a row that violates the schema (signals corruption, not silently coerced). A new task status/phase value must be added to the relevant enum or reads/writes will reject it.
- **Solvers assemble their own prompts.** `solve()` / `startPlanningSession()` receive the raw `taskContext` (not a pre-built string or thunk) and call `buildPrompt` / `buildPlanningPrompt` / `buildChatPrompt` themselves AFTER worktree creation — so `buildTaskContext` can read worktree-resident `docs/plans/<planDirName>/*.md`. Don't move prompt assembly back into `worker.ts` / `api.ts`: they'd build prompts before the worktree exists and miss plan artifacts.
- **Solve outcome is solver-owned.** `solve()` returns `outcome: { events, exitCode, rawOutput? }` (`src/solver/solver.ts`); the worker persists it verbatim and never parses solver stdout. `OkenaSolver` returns `events: []` and no `rawOutput` (it runs claude in its own terminal), so okena tasks have no granular dashboard timeline and a null `claudeRawOutput` — don't write worker/dashboard code that assumes those are populated.
- **Clarification chat is DefaultSolver-only.** It lives entirely inside `DefaultSolver.solve()` (gated on `config.chat.enabled`), not in the shared `Solver` interface. `OkenaSolver` has no chat. Don't add a chat field to `SolveParams` — if okena ever needs chat, give it its own implementation.
- **Plan endpoint creates worktree, autonomous run reuses it.** `POST /api/tasks/:id/plan` runs `startPlanningSession`, persists `worktreePath`/`branchName`/`planDirName`. The worker reads them back and passes `existingWorktreePath` to `solve()`. Solvers MUST honor `existingWorktreePath` (skip worktree creation) — otherwise the autonomous run wipes planning state the user wrote in `docs/plans/<planDirName>/`. For okena: `solve()` always spawns a fresh terminal (never the user's `plan:` terminal); `startPlanningSession()` reuses an existing `plan:` terminal so repeated Plan clicks don't pile up windows.

## Build & run

- **Ports.** Backend `:7474`, frontend dev server `:7475` proxying `/api` to backend.
- **Verification.** No test framework — don't claim a fix is verified by tests. Run `npm run dev` and exercise the affected path end-to-end (poll → solve → dispatch, or whatever phase you touched).
- **Config.** Loads from `VIGIL_CONFIG` env or `./vigil.config.json`. **`src/config.ts` is the canonical schema** — read it instead of duplicating fields here.
- **Runtime dep: almanac.** The solver prompt (`src/solver/prompt-builder.ts`) references `/almanac:task-start`, `/almanac:branch-name`, `/almanac:ship`, `/almanac:commit`. These resolve via the user's globally-installed `almanac` plugin — vigil does NOT vendor or install its own copies. If the daemon host is missing almanac, the spawned agent will silently fail to load those skills. Install via almanac's own setup (`bash install.sh && almanac install claude-code` in the almanac repo).
