# CLAUDE.md

Pipeline: poll -> solve -> tier -> dispatch.

## Self-maintenance

When you discover an undocumented gotcha, abstraction, mandatory pattern, or a subsystem missing from this file, **update CLAUDE.md before finishing the task**. Stale instructions cost the next agent more than they cost you to fix now.

## Mandatory abstractions

Three discriminated unions / interfaces gate where code goes. Bypass them and the daemon silently desyncs.

- **`TaskProvider`** (`src/providers/provider.ts`) — every external task source goes through this. Never import `contember.ts` (or any provider impl) outside `src/providers/`.
  - Implement four methods: `pollNewTasks`, `getTaskContext`, `resolveTaskSummary`, `postComment`. `resolveTaskSummary` seeds a new task row when `vigil run <externalId>` is invoked.
  - Extend the discriminated union in `src/config.ts`, register in `src/providers/registry.ts`.
- **`Solver`** (`src/solver/solver.ts`) — every code-execution backend implements `solve(SolveParams) → SolveResult`. Never spawn `claude` (or any agent CLI) outside a `Solver` impl; reuse `src/solver/invoker.ts` (which wraps `spawn-claude.ts` / `chat-invoker.ts`) instead of re-implementing process spawning. Wired in `src/index.ts` from `config.solver.type` (`'default' | 'okena'`). To add a backend: implement `Solver`, extend the enum in `src/config.ts`, branch in `src/index.ts`.
- **`TaskTransformer`** (`src/transformers/transformer.ts`) — every prompt-shape change goes through a transformer. Never inline prompt strings in `worker.ts`, `prompt-builder.ts`, or solver code. To change prompt content: edit the existing transformer or add a new one and register it in the `transformers` map.

## Where new code goes

| Adding…                                  | Goes in                              |
|------------------------------------------|--------------------------------------|
| Support for a new task source            | `src/providers/<name>.ts` + registry |
| Different code-execution backend         | `src/solver/` or `src/extensions/<x>/` + `src/index.ts` switch |
| Different prompt shape per project       | `src/transformers/<name>.ts` + map   |
| New tier-driven action (PR, comment, …)  | `src/actions/dispatcher.ts`          |
| New chat/MCP tool exposed to the solver  | `src/mcp/server.ts` (register via `server.tool(...)`) |
| New dashboard endpoint                   | `src/server/routes/api.ts` (mounted from `app.ts`) |
| DB column or query                       | `src/db/schema.ts` (append to `MIGRATIONS`) + `src/db/client.ts` |
| New bundled skill                        | `vendor/<bundle>/vigil-<name>/` + update `vendor/UPSTREAM.md` |

## Pipeline (`src/queue/worker.ts`)

Five phases. Don't reorder, don't skip.

1. **Poll** — `provider.getTaskContext(externalId)`
2. **Worktree + Solve** — delegated to the active `Solver`. Returns `{ worktreePath, branchName, invokeResult }`.
3. **Parse output** — `parseClaudeOutput(stdout)` → DB events for the dashboard timeline.
4. **Parse result** — `parseResultFile(worktreePath)` reads `.solver-result.json`. Falls back to `parseTierFromOutput(stdout)`. **Both paths must keep working** — agents who change the JSON contract must update both, or the dispatcher silently misroutes tiers.
5. **Dispatch** — `dispatch()` routes by tier: trivial→ready PR, simple→draft PR, complex→push branch, unclear→post questions / open chat.

## Subsystems

- **`src/chat/`** — clarification chat. Signed tokens gate every route; never expose `session.id` over the wire, only the token.
- **`src/mcp/server.ts`** — MCP server the running solver talks to. New solver capabilities go here as tools, not on the dispatcher.
- **`src/cli/`** — `vigil` binary wrapping launchd: `start` / `stop` / `status` / `logs` / `run` / `install-skills`. **`vigil run <id>` executes one task and exits** — use it to debug a single task without re-polling or restarting the daemon. **`vigil install-skills`** copies bundled skills into `~/.claude/skills/vigil/` (and `~/.agents/skills/vigil/`) for planner-side workflows.
- **`src/extensions/okena/`** — alternative `Solver` (local Okena daemon instead of `claude` CLI). Loaded via dynamic `import()` in `src/index.ts` with `DefaultSolver` fallback. Don't hard-import it.
- **Bundled skills (`vendor/` + `src/skills/installer.ts`)** — vendored SKILL.md skills (all sourced from almanac) prefixed `vigil-`. Source of truth is `vendor/almanac/`. Both `Solver` impls call `installSkillsIntoWorktree(worktreePath, 'claude')` after worktree creation, which copies every `vendor/*/<skill>/` dir into `<worktree>/.claude/skills/`. The `codex` target writes to `.agents/skills/` instead (reserved for a future CodexSolver). The `vigil install-skills` CLI subcommand calls `installSkillsGlobally(target)` to land the same bundle under `~/.claude/skills/vigil/` (or `~/.agents/skills/vigil/`) for the user's own planner-side sessions. Re-sync procedure and upstream provenance live in `vendor/UPSTREAM.md`.

### Directory rules

- **`extension/`** — host permissions: `http://localhost:*/*` only. Never add tunnel/public URLs (manifest is canonical: `extension/manifest.json`).
- **`web/`** — React 19 only. Never downgrade; code uses 19-only features (Actions, `use`, ref-as-prop).

## Gotchas

- **Worktree cwd.** Solver code runs with the worktree as `cwd`. Reading `process.cwd()` from anywhere outside `Solver` impls or the worker hits the wrong tree (or the daemon's tree). Prefer paths derived from `worktreePath` / `projectConfig.repoPath`. Exception: module-load-time daemon paths (config, DB, logs) capture the daemon's startup cwd — that's intended. Note: `src/server/routes/api.ts:291` resolves `process.cwd()` per request to read the log path — that works only because the daemon never `chdir`s, so don't copy the pattern into code that might run after a `cwd` change.
- **Optional solver imports.** Extension solvers (e.g. `src/extensions/okena/`) load via dynamic `import()` in `src/index.ts` with a `DefaultSolver` fallback on failure. Never add a top-level static import for an optional/extension solver — an unavailable optional dep would crash startup. Mirror the okena pattern.
- **Claude can pre-ship.** If `.solver-result.json` carries `prUrl`, `dispatcher.ts` records it and skips tier routing entirely (Claude shipped via `/vigil-ship`). Don't add tier-only side effects assuming dispatch always runs the tier branch.
- **Okena token rotation.** Okena rotates the CLI token; `OkenaClient` reloads `cli.json` per call. Never cache the token in memory — long-running daemons will start returning HTTP 401 silently. Newly registered tokens activate only after Okena itself restarts.
- **Okena profile layout.** Okena keeps `cli.json`/`remote.json` under `profiles/<id>/`. `OkenaClient.resolveConfigDir()` reads `profiles.json` (`last_used` → `default_profile`) per call to find the active profile. Symptom of okena changing this layout again: `Error: Okena not configured` even though okena is running — re-check `resolveConfigDir()` against the new on-disk layout.
- **Silent solver fallback.** If `config.solver.type === 'okena'` but Okena is unavailable, `src/index.ts` logs a warning and falls back to `DefaultSolver`. Don't assume the configured type is the active type — read the startup log or `solver.constructor.name`.
- **Result-file fallback is fragile.** Phase 4 reads `.solver-result.json` first, then falls back to `parseTierFromOutput` over stdout, which only matches a *flat* JSON object containing `"tier"` (no nested objects). If you change the `.solver-result.json` schema, update the Zod schema in `result-parser.ts` *and* the fallback parser, or tiers misroute under partial failures.
- **MCP transports rotate every 30 min.** `src/mcp/server.ts` keeps a per-session transport map with a 30-min TTL. Tools that block longer than that (e.g. `vigil_send_message`'s 24h wait) must key their state by `sessionId` / DB rows, not by transport closure or in-memory state on the transport — otherwise they lose context across rotation.
- **`config.chat.baseUrl` is mutated at runtime.** When `config.chat.tunnel === true`, `tunnel.ts` overwrites `config.chat.baseUrl` after Cloudflare assigns a URL. Code that reads `baseUrl` before tunnel start gets the config-file value; after start gets the tunnel URL. Read it lazily, not at module load.
- **Chat token vs session id.** `chat_sessions` rows have both `id` (DB primary key) and `token` (signed, expiring). HTTP/URLs/logs: token only — `id` is not signature-verified, leaking it bypasses the gate. MCP tools: `sessionId` is the addressing key — don't "fix" them to take the token.
- **Stale processing tasks.** `src/index.ts` re-enqueues anything stuck in `processing` on startup. Don't write code that assumes "processing" means "currently running" — it might be a recovered task from a prior crash.
- **Legacy `clientcareId`.** The DB column is named `clientcare_id` (`clientcareId` in TS) but holds the provider-agnostic external ID (predates the provider abstraction). Don't read it as Contember-specific; don't rename without a migration.
- **`vendor/` path resolution.** `src/skills/installer.ts` resolves `vendor/` via `import.meta.url` → `fileURLToPath` → walk two levels up. This works because both `src/skills/installer.ts` (tsx-dev) and `dist/skills/installer.js` (built) sit at the same depth relative to `vendor/` at the repo root. **Never `process.cwd()`** here — the installer runs inside per-task worktrees (see the "Worktree cwd" gotcha) where `cwd` is wrong. If you move the installer file or change `rootDir`/`outDir`, update the `resolve(here, '..', '..', 'vendor')` walk to match.

## Build & run

- **Ports.** Backend `:7474`, frontend dev server `:7475` proxying `/api` to backend.
- **Verification.** No test framework — don't claim a fix is verified by tests. Run `npm run dev` and exercise the affected path end-to-end (poll → solve → dispatch, or whatever phase you touched).
- **Config.** Loads from `VIGIL_CONFIG` env or `./vigil.config.json`. **`src/config.ts` is the canonical schema** — read it instead of duplicating fields here.
