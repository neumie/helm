# Context

Project vocabulary for naming seams. Architecture terms (Module, Interface, Depth,
Seam, Adapter, Leverage, Locality) follow the codebase-improve skill's LANGUAGE.md.

**Status:** target design for the AFK-list rework. The pre-rework code spoke a
Contember/clientcare vocabulary (`Task`, `Tier`, polling pipeline, tier-routed
dispatch); this doc speaks the post-rework vocabulary. Where current `src/`
disagrees, drive the rework toward the doc — not the other way round.

## Domain terms

**Item** — a unit on the AFK list. Has a `kind` (discriminator), an envelope, and
a kind-specific payload. Replaces the pre-rework `Task`.

**Kind** — `solve | ralph | harden`. Top-level discriminator on an Item.
- `solve` — one Claude invocation in a worktree → `/almanac:ship` → PR. Payload: `prompt`.
- `ralph` / `harden` — delegated to almanac's loop engine. Payload mirrors almanac
  flags 1:1: ralph `{ prdPath, iterations?, oversee? }`; harden
  `{ targetPath, rounds?, lenses? }`.

**Source** — optional `{ provider, externalId }` on the envelope. Populated by the
clientcare poller for poller-discovered items; null for hand-added ones. The
provider abstraction lives on as a context source, never as a kind.

**BaseRef** — the git ref a new worktree branches off. Per-Item field on the
envelope; defaults to `projects[].baseBranch`. Can be any ref the project repo
resolves: a branch, a tag, a commit, or **another Item's branch** (`vigil/<kind>-<itemId>`).
The last enables worktree-off-worktree: forking N parallel attempts off an
existing in-flight Item. Always carried explicitly on the Item — never re-derived
from `projects[].baseBranch` at run time, so a config change can't move a queued
Item's base under it.

**GroupId** — fan-out binding. When the operator queues N parallel attempts of
the same Item shape (same `prompt`, `baseRef`, etc.), vigil writes N Items sharing
one `groupId`. Each Item keeps its own worktree, status, retry — `groupId` is
only a rendering + comparison hint, not a lifecycle join. Failure or cancellation
of one Item doesn't touch its siblings. The dashboard renders a group as one card
with N children.

**Spawner** — the seam over interactive-surface launchers used for the planning
phase. Adapters auto-discovered at `src/spawners/<name>.ts` (mirrors almanac's
loop-adapter pattern at `lib/loops/<name>.sh`); the spawner list IS the files
present. Each adapter answers a fixed contract: open an interactive session in
its environment (okena terminal, iTerm tab, tmux window, …), seeded with the
planning prompt + worktree cwd. Independent of `Solver` — planning spawn and
autonomous-run solver are two axes. Per-Item override on the add form; global
default in `vigil.config.json` (`spawn.default`).

**Triage** — the verification step between a poller-sourced Item and the queue.
Statuses: poller writes `unverified`; the operator approves → `queued` or rejects
→ `skipped`. Hand-added items skip triage and land directly in `queued`. Triage is
where ambiguity gets resolved at queue time — it replaces the pre-rework solver
clarification-chat round.

**Lane** — a per-kind concurrency slot. `solveConcurrency: N`, `loopConcurrency: M`.
Solve and loop items never share a slot, so a long ralph can't starve a queue of
short solves.

**Drainer** — vigil's worker pool. Always-on daemon (launchd-managed); selects
queued items respecting lane caps and `queuedAt ASC` per lane.

**Provider** — the seam over external Item sources. `ContemberProvider` today;
its sole responsibility post-rework is producing `unverified` Items for triage.

**Solver** — the seam over code-execution backends for **`solve`-kind Items only**.
`DefaultSolver` (claude CLI) and `OkenaSolver` (Okena terminal). Two adapters → a
real seam. Loop Items do NOT go through Solver — they shell out to almanac.

**Solver registry** (`createSolver`, `src/solver/registry.ts`) — the single
construction site for the active `solve`-kind Solver, mirroring `providers/registry.ts`.
Optional/extension solvers (okena) load via dynamic `import()` so a missing optional
dep can't crash module load. The configured `solver.type` is the active type — no
fallback (an unreachable okena surfaces errors per-Item, not by silently swapping
in `DefaultSolver`).

**AlmanacRunId** — the registry id at `.almanac/runs/<id>/` that vigil captures
from `run_id=<id>` (almanac's first-stdout-line emit on launch). Stored on the
Item row; the dashboard tails `.almanac/runs/<id>/status.tsv` directly for live
state. See *Cross-tool contracts* below.

## Deep modules (surviving the rework)

**SolverResult** — the structured outcome the agent writes to `solver-result.json`
(summary, filesChanged, prUrl). Single source of truth is its Zod schema; the TS
type is `z.infer` of it and the prompt's JSON contract must match. Read from the
result file only — there is no stdout fallback. Slimmer than pre-rework: `tier` /
`confidence` are gone with tiering.

**PlanWorkspace** — the deep module owning the on-disk `docs/plans/<planDirName>/`
layout: the paths and IO for `context.md`, `.planning-prompt.txt`,
`solver-result.json`, and `README.md`, plus the *relative* result path the solver
prompt references. One owner so the prompt template, the result parser, and the
okena poll path can never disagree about where files live. Concerns on-disk layout
only. **Used by `solve`-kind Items only** — loop Items have no plan workspace.

**Item workspace identity** (`resolveItemWorkspace`) — resolves an Item row to
its `{ planDirName, branchName, existingWorktreePath }`, computing+persisting
defaults. A DB-identity axis distinct from `PlanWorkspace` (on-disk layout); used
by the worker and the `/api/items/:id/plan` endpoint so the two entry points
can't drift.

**Solve outcome** — the solver-owned timeline returned from `solve()`:
`{ events, exitCode, rawOutput? }`. Each adapter produces its own `events`
(`DefaultSolver` parses CLI output; `OkenaSolver` returns none). The worker
persists what it's given rather than parsing solver-specific stdout — keeps
default-solver output shape out of the shared `Solver` interface. Loop Items have
no `Solve outcome` (they don't go through `Solver`); their analogue is the
almanac run record at `.almanac/runs/<id>/`.

## Gone with the rework

- **Tiering** (`trivial | simple | complex | unclear`) — verdict added value when
  Items came from clientcare uncurated. Triage now does that gating; the agent
  just ships.
- **`src/chat/` (clarification chat)** + **`ChatLinks`** + **`ClarificationChat`**
  + **`ChatChannel`** — solver-asks-user mid-run pattern. AFK = you're not there;
  triage absorbs the ambiguity-resolution job.
- **`src/mcp/`** — existed solely to expose chat tools to the solver. With chat
  gone, no remaining consumer.

If reintroduced later: do it through a new seam, not by reviving these modules
verbatim — the post-rework Item lifecycle has different state-machine joins.

## Entrypoint flows

Vigil is **the** entrypoint for tasks across projects — the dashboard is where
Items are created, not just observed. Three entrypoints write Items into the DB,
all via one shared `addItem()` lib (no parallel write paths):

1. **Dashboard add form** — per-project page, three tabs (solve/ralph/harden).
   Fields: title, payload (prompt or prdPath or targetPath), `baseRef` (autocomplete
   from `git for-each-ref` on the project repo), `spawn` (dropdown from discovered
   spawners; defaults to `spawn.default`), `parallelism: N` (defaults 1; N > 1 →
   fan-out group). [Plan] and [Queue] buttons: Plan creates the Item(s) + their
   worktrees + opens N spawner sessions; Queue creates the Item(s) and the
   drainer picks them up immediately.
2. **CLI `vigil add …`** — same payload as the form, scriptable.
3. **Clientcare poller** — produces `unverified` Items for triage (see *Triage*).

**Plan flow.** Click Plan on an `unverified` or `queued` solve Item (or in the
add-form). Vigil resolves the Item's workspace (`resolveItemWorkspace`), creates
the worktree off `baseRef`, writes `docs/plans/<dir>/context.md`, then invokes the
selected `Spawner` to open an interactive session with the planning prompt + that
worktree as cwd. The operator writes `docs/plans/<dir>/{brief,prd,…}.md` from
inside the spawned session (e.g. via almanac `/grill-me`, `/prd-create`). When
the Item later runs, the autonomous solver reuses the same worktree and
`buildTaskContext` reads every `*.md` in `docs/plans/<dir>/` so the agent has
full plan context.

**Fan-out flow.** Add form with `parallelism: N` writes N Items sharing one
`groupId`, all with identical payload + `baseRef`. The drainer schedules them
through the normal lane (subject to `solveConcurrency` / `loopConcurrency` —
fan-out doesn't get to bypass the cap, so N=10 with `solveConcurrency=3` still
runs three at a time). Each Item gets its own worktree off the shared `baseRef`,
its own branch `vigil/<kind>-<itemId>`, its own outcome. The dashboard renders
the group as one card; the operator compares branches (out-of-vigil via git tools
for v1; in-dashboard compare view later) and merges / cherry-picks / discards.

**Worktree-off-worktree.** A natural fallout of `baseRef` accepting any ref. From
an existing in-flight or completed Item's context menu, "Fork from here" pre-fills
the add form with `baseRef = <thisItem.branchName>` — three parallel attempts can
then branch off Item A's current state, sharing its commits up to that point and
diverging afterward.

## Cross-tool contracts

**Almanac handoff.** `almanac ralph` / `almanac harden` print `run_id=<id>` as the
first stdout line on launch. Vigil reads line 1, stores it on the Item
(`almanacRunId`), and tails `.almanac/runs/<id>/status.tsv` (almanac's canonical
per-run record) for live state. To cancel a loop, vigil writes the loop adapter's
between-round signal file (`.ralph-stop` / `.harden-stop`) in the worktree;
almanac exits cleanly between rounds and vigil marks the Item `cancelled`. The
worktree is preserved either way.
