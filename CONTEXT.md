# Helm architecture context

Project vocabulary for naming seams. Architecture terms (Module, Interface, Depth,
Seam, Adapter, Leverage, Locality) follow the codebase-improve skill's LANGUAGE.md.

**Status:** current Helm architecture authority. This document describes behavior
that exists now; it is not a reset-era target design. Proposed observer,
planning-transaction, and desktop profile-switch changes belong to their owning
release slices and must not be inferred as already implemented from this document.

## Profiles and persistence

Helm supports unlimited user-named profiles with one daemon-global active profile.
Profile IDs are opaque safe identifiers; display names never determine paths.
`profiles.json` is atomically rewritten and owns the active-profile pointer and
its generation.

All profiles share the root `helm.db`. Every Item and Item event has immutable
`profileId` ownership, and provider poll watermarks are profile-scoped.
`DB.forProfile(profileId)` is the tenant boundary: lifecycle reads and writes use
the bound Item store, and an asynchronous run captures its profile-bound database
and profile filesystem paths before it starts. Switching the active profile changes
UI, polling, and new-admission scope without moving a running Item into another
profile.

`profiles/<id>/helm.db` files retained after the legacy migration are rollback
backups, not current storage truth. Profile-local runtime files such as attachments
and logs remain under `profiles/<id>/`; they do not imply a per-profile live
database. Do not discard, reset, or replace Helm data as an architecture change.

## Domain terms

**Item** — Helm's unit of work. It has `kind: solve | loop`, an immutable
`profileId`, lifecycle fields, and a kind-specific validated payload.

**Lifecycle status** — `inbox`, `ready`, `active`, `running`, `review`, `done`,
`failed`, or `cancelled`.

- Source-backed/provider-discovered Items begin in `inbox`; source-less manual
  Items begin in `ready`.
- `ready` is Queue work whose execution ownership is not yet decided. `active` is
  human-owned work and is never pulled by the Drainer. `running` is agent-owned
  execution.
- `review` is work awaiting verification or merge; `done`, `failed`, and
  `cancelled` are terminal lifecycle states. A reconciled agent error can remain
  in `review` when a shippable branch or PR exists.

**Work mode** — a separate ownership axis: `agent`, `manual`, or null while a
Queue Item is undecided. It must not be inferred from lifecycle status.

**Run outcome** — a separate best-effort agent-run axis: `ok`, `errored`,
`no_result`, or `cancelled`. It records execution evidence without masquerading
as lifecycle truth; for example, a reconciled Item can be in `review` with an
`errored` or `no_result` outcome.

**Planning and deployment axes** — `plannedAt` means an interactive planning
session was prepared, not that a runnable spec or tickets exist. `planStatus` is
a cached advisory readiness observation. `deployState` records GitHub-observed
merge and deployment state. Neither axis is a substitute for lifecycle status.

**Source** — optional provider identity and external ID. A provider-less captured
Item carries frozen `capturedContext`; it is not a fake provider. Source context
resolves captured-first, then through the active provider when live access is
required.

**BaseRef** — the explicit ref from which a worktree starts. It is captured on the
Item, may be a branch, tag, SHA, or another Item branch, and is never re-derived
from mutable project configuration at execution time.

**GroupId** — a fan-out rendering and comparison binding. Siblings keep separate
lifecycle, workspace, and retry state; one sibling's failure or cancellation does
not change another's.

**Terminal placement** — profile-scoped desktop arrangement of terminal identities
across the foreground strip and Background, including order, manual group
membership, the selected terminal, and transient drag projection. It is separate
from xterm/PTY/dtach runtime and from run ownership: changing placement never
creates, kills, or transfers the underlying process; the runtime only applies the
selected identity as focus/fit.

## Core modules and ownership

**ItemStore and ItemCommands** — all Item persistence and event queries go through
`ItemStore`; all lifecycle writes go through `ItemCommands`. Routes, pollers, UI,
queue code, and CLI clients do not write Item status or lifecycle events directly.
Commands keep status, timestamps, and events coherent.

**Drainer** — the daemon scheduler. It admits only the active profile's
agent-owned `ready` Items, oldest first within its solve and loop lanes. It keeps
a shared capacity budget, never pulls human-owned `active` work, and recovers
stale `running` rows through `ItemCommands` on startup.

**TaskProvider** — the seam for live, re-pollable external task sources. Providers
implement polling, context resolution, source summary resolution, and comments.
Captured-context tasks use the Item context seam instead; they do not add a
provider implementation.

**Solver and AgentAdapter** — `Solver` is the code-execution seam for solve Items.
`createSolver(config)` is its construction site; the configured solver has no
silent fallback. `AgentAdapter` owns Claude Code/Codex/Pi command and timeline variation.
Loop Items use the loop runner rather than Solver.

**Spawner and PlanWorkspace** — `Spawner` is the interactive planning-surface
seam, independent of Solver and Item kind. `createSpawner(config)` selects the
configured/default or installed adapter. `PlanWorkspace` exclusively owns the
`docs/plans/<planDirName>/` paths and IO for planning artifacts, prompts, results,
and README files. Planning is prepared through lifecycle commands and the active
Spawner; planning artifacts can later be consumed by execution in the same
workspace.

**Execution context** — provider/manual/captured context is assembled through the
Item context module. A saved Run Context is an operator-owned override for future
planning and solve attempts, distinct from live provider data, frozen captured
context, manual payload, and immutable solve-input snapshots.

**Run observation and Dashboard Contract** — run observation normalizes events,
logs, PR state, and loop state for a single Item. The server-owned Dashboard
Contract supplies status, allowed actions, grouping, and display data; list routes
remain cheap and do not perform per-Item remote observation.

## Entrypoints and flows

The Helm desktop app and extension are Item clients; the daemon is API-only. The
CLI is a thin HTTP client. Dashboard/API, extension, CLI, and provider ingestion
all enter lifecycle behavior through `ItemCommands` and wake the Drainer where
appropriate.

An interactive Plan request is orchestrated by `PlanningApplication`: it captures
the Item's profile-bound commands before its first mutation/await, takes a
tenant-qualified claim, and invokes the selected Spawner. Required exact-once
workspace readiness snapshots/materializes captured attachments before adapter
context use; canonical existing-path identity prevents Main/worktree aliases from
changing mode. A later autonomous run reuses the finalized workspace when
applicable. It remains a saga: external workspaces/sessions cannot be rolled back
with SQLite, so post-readiness failures truthfully report that a session may exist.
The orchestrator does not merge Solver and Spawner or move persistence from
`ItemCommands` or file ownership from `PlanWorkspace`.

Solve execution follows poll/context resolution, workspace plus solve, solver-owned
timeline persistence, result-file parsing, and dispatch. Dispatch records a
pre-shipped PR or creates one and may post a provider comment under its guarded
rules. Loop execution creates or reuses the Item workspace and delegates to
`almanac loop`.

## Current versus planned changes

Deploy and plan-status watchers are implemented all-profile advisory observers.
They snapshot registered (including archived) profile IDs, bind each candidate to
`DB.forProfile(profileId)` and `ItemCommands` before awaits, avoid overlapping
ticks, and use original `(updatedAt,id)` cursor keys. Deploy work is capped at 160
remote commands with four active processes; Plan work is capped at 400 Items, 25
project GitHub commands, and four active processes. Scheduling gives each ready
profile one first-wave candidate before continuation. A handled no-result or
permanent observer failure advances its stream cursor, while incomplete or
budget-deferred work retains retry priority. Deployment lists are paginated and
partial discovery/status state remains in memory until a complete `DeployState`
can be persisted.

Observer `stop()` closes manual and timer admission before aborting and awaits the
admitted tick; pre-aborted callers do no work. Daemon shutdown intentionally does
not call `db.close()` after observer drains: Poller, Enricher, Drainer/workers, and
HTTP lack a complete shared admission-and-drain barrier. Keeping SQLite open until
process termination prevents continuations from using a closed connection. Do not
reintroduce an early close until every DB owner can drain.

Planning/context preparation is implemented through `PlanningApplication`; its
lifecycle row/event pairs are transactional, but its external effects remain a
claimed saga. Desktop profile activation is implemented through the
`ProfileSwitchCoordinator` and namespace-installation fence recorded by ADR-0002;
inconclusive activation stays fenced rather than guessing. Preserve the current
shared-DB, profile-bound, lifecycle, persistence, Solver, Spawner, PlanWorkspace,
and profile-activation authorities while implementing later slices.

ADR-0003 is implemented through `TerminalPlacement` and the shared mountable
`TerminalWorkspace`: the placement module is the profile-generation-scoped
canonical authority for order, Background ownership, group membership/collapse,
selection, and drag projection. `renderer.ts` mounts it while runtime Tab/xterm
objects remain ID-keyed projection adapters. Main atomically persists narrow,
same-profile placement facts; run-owned sessions remain placement-eligible but
non-transferable/non-ordinary-close, and their ownership evidence stays hidden.
Storybook and Playwright mount the production workspace via its typed fixture.
