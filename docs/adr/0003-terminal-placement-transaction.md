# ADR-0003: Terminal placement is an ID-based transaction module

## Status

Accepted

## Context

Terminal placement currently spans the desktop renderer's mutable `tabs` and
`parked` arrays, manual groups, selected terminal, transient drag projections,
DOM rendering, FLIP animation, session authorization, persistence, and async
rollback. Repeated Background and group-drag fixes showed that placement policy
cannot safely share mutable truth with xterm/PTY runtime objects. Source-regex
tests and parallel Storybook fixtures also cross different seams from production.

## Decision

Terminal placement becomes a profile-generation-scoped, ID-based deep module.
It owns the canonical immutable placement snapshot: foreground and Background
order, manual group membership and collapse state, selected terminal, transient
drag projection, and a monotonically increasing revision. xterm/PTY/dtach/DOM
runtime remains an ID-keyed adapter outside this module; placement never creates,
kills, or transfers a process.

The module owns every placement mutation and the ordering of remote-but-owned
session authorization/persistence. Low-frequency actions execute through the
module. A drag begins a one-shot transaction whose projection and cancellation
are synchronous while commit is asynchronous. One user placement transaction is
admitted at a time; versioned terminal inventory events may still merge during an
await. A stale failure removes only its projected identities rather than replacing
concurrent inventory with an old snapshot.

The placement instance hydrates once from the profile generation's durable
session registry, then consumes versioned add/remove/ownership events. It
publishes complete immutable snapshots with revisions. A thin mountable Terminal
Workspace facade maps DOM/pointer events to placement operations and snapshots to
production DOM. The Electron app, Playwright browser harness, and Storybook use
that same production mount with production or in-memory runtime/session adapters.

Placement and terminal/group interaction behavior is covered through direct tests
at the placement interface and browser interactions through the production mount.
Existing source-level assertions remain only where they protect static/native
invariants (for example Electron wiring or output-order guards), not renderer
placement policy or parallel terminal DOM.

## Considered options

- Keep canonical placement on `Tab` references: rejected because DOM/xterm/PTY
  state leaks across the seam and event semantics can change during projection.
- Use one generic async intent dispatcher: rejected because synchronous
  high-frequency projection and asynchronous commit have materially different
  temporal semantics.
- Expose only a mountable workspace facade: rejected because every placement
  edge case would require an expensive browser test and placement policy would
  lose a focused interface.
- Let the renderer orchestrate session awaits around a pure reducer: rejected
  because admission, commit ordering, and merge-safe rollback would remain caller
  obligations, leaving a shallow module.
- Move placement into Electron main: rejected because transient projection and
  rendered-unit geometry belong in the renderer and would leak through IPC.
- Reconcile arbitrary full registry snapshots after mount: rejected because a
  late snapshot could overwrite a newer local transaction. Hydration is
  generation-bound; later changes are versioned events.

## Consequences

- Terminal placement and selected-terminal rules gain one interface and one
  direct test surface; the renderer becomes an adapter rather than a second
  placement authority.
- Session persistence remains in `app/src/sessions.ts`; the placement module uses
  an injected production adapter and in-memory test adapter.
- Storybook gains production behavior through a lightweight terminal runtime
  adapter rather than a parallel terminal/group DOM implementation.
- A real Chromium interaction layer covers pointer receiver geometry, projected
  membership, async rejection, cancellation cleanup, Background/strip ownership,
  and focus behavior through the production mount. Existing Electron attestations
  remain for dtach and macOS-native behavior.
- Migration uses ID-based vertical slices; no temporary `Tab`-reference interface,
  storage reset, `sessions.json` schema reset, or second canonical placement truth
  is introduced.
- ADR-0002 remains authoritative for profile activation and renderer-token
  fencing. A placement instance is bound to one observed profile generation and
  rejects late results after disposal or generation change.
