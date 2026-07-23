# ADR 0001: Helm Item and planning module shape

**Status:** accepted and implemented in the current Helm architecture. This ADR
records durable ownership boundaries; it does not authorize a storage reset or
claim later architecture-plan slices are already implemented.

## Context

Helm replaced the legacy Vigil Task/tiering/chat model with Items. The migration
preserves current Helm data: all profiles now share the root `helm.db`, while
Items and events have immutable `profileId` ownership and profile-local runtime
files remain beneath `profiles/<id>/`. Retained legacy `profiles/<id>/helm.db`
files are migration backups, not live per-profile databases.

An Item has queryable lifecycle fields and a Zod-validated JSON payload by
`kind`. Lifecycle truth uses `inbox`, `ready`, `active`, `running`, `review`,
`done`, `failed`, and `cancelled`; ownership, run outcome, planning readiness,
and deployment observation remain separate axes rather than replacement statuses.

## Decision

- `ItemStore` owns Item persistence and event queries. `ItemCommands` owns Item
  lifecycle transitions, timestamps, and lifecycle events. No route, client,
  poller, queue, or UI path writes lifecycle state directly.
- `DB.forProfile(profileId)` is the tenant boundary for Item and poll-state work.
  Display names never determine storage paths, and a running operation retains
  its profile-bound DB and filesystem paths across asynchronous work.
- Server routes, the extension, and CLI are adapters over daemon commands and
  Item APIs. Providers are adapters for live external task sources. They do not
  create parallel lifecycle or persistence paths.
- Planning is an independent Spawner axis, not a Solver capability and not a new
  Item kind. `createSpawner` selects a planning surface; `createSolver` selects
  solve execution. These seams remain distinct.
- `PlanWorkspace` exclusively owns `docs/plans/<planDirName>/` layout and file
  IO. `ItemCommands` remains the persistence owner for planning identity and
  lifecycle facts. Routes remain transport adapters around those owners.
- `PlanningApplication` is the implemented planning/context use-case
  orchestrator. It captures the Item's `DB.forProfile(profileId)` command seam
  before its first mutation/await, holds tenant-qualified claims, validates
  required exact-once readiness callbacks, and uses canonical existing-path
  identity with a missing-path fallback. It coordinates existing owners only: it
  does not merge Solver with Spawner, move persistence out of `ItemCommands`, or
  move planning-file ownership out of `PlanWorkspace`.

## Considered options

- Resetting or discarding pre-existing Helm/Vigil data: rejected. Current data is
  preserved through the root shared database and retained migration backups.
- Separate tables per Item kind: rejected until a kind-specific field needs
  indexed querying.
- Config-enum Spawners: rejected because installed adapters are discovered from
  adapter files while configuration selects the default.
- Folding interactive planning into Solver or a generic workflow framework:
  rejected. The focused Spawner and PlanWorkspace boundaries preserve locality
  without broadening the execution seam.

## Consequences

- Lifecycle behavior stays centralized and profile-scoped; status, work mode,
  run outcome, planning state, and deployment state cannot be conflated by an
  adapter.
- Data preservation and shared-DB ownership are compatibility constraints for
  future work, including profile switching and observer changes.
- UI clients render the server-owned Dashboard Contract rather than raw
  persistence rows.
- Planning orchestration is testable without changing the established
  persistence, workspace-layout, Solver, or Spawner authorities. Its lifecycle
  row/event pairs are transactional; workspace, filesystem, and terminal effects
  remain an explicitly reported application saga rather than a distributed
  transaction.
