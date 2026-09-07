# ADR-0004: Remote connects to Pi's owner; it does not take over its session file

## Status

Architecture direction accepted by the operator on 2026-09-07: independent local
host, and a fork of the installed question extension for remote answers.
Implementation/acceptance progress lives in `docs/remote/README.md`. This ADR does
not declare the complete Remote product shipped or authorize deployment.

## Evidence

Inspection baseline: Helm `50bc7a6` (clean checkout); implementation is isolated on
`feat/helm-remote` in the sibling `helm-remote` worktree. Native sessions, installed
extensions, daemon configuration and launchd/Tailscale state are not modified.

- `src/server/app.ts` exposes local Item/config routes; CORS is not bearer auth.
  `src/server/routes/api.ts` binds ordinary work to global activation. Publishing
  7474 or proxying arbitrary requests would expose local authority and wrong-tenant
  writes. Electron fencing in `app/src/helm-bridge.ts` is not a browser contract.
- `app/src/sessions.ts` owns native terminal identities, not Pi conversations.
  Neither dtach attachment nor `terminal-workspace.ts` provides semantic Pi control.
  Scheduled run adoption/close ownership remains untouched.
- Installed Pi is `@earendil-works/pi-coding-agent` **0.85.1**. Its installed
  `docs/extensions.md`, `docs/sdk.md`, `docs/rpc.md`, `docs/session-format.md`,
  `docs/tui.md` and `examples/extensions/send-user-message.ts` distinguish in-process
  observation/injection from launching a different RPC session. Reload shuts down
  old extension resources and starts a fresh runtime without replacing Pi itself.
  `dist/core/agent-session.js`'s `bindCore` catches asynchronous `sendUserMessage`
  failures; the extension API returns void. Thus dispatch is NOT proof of prompt
  acceptance, queueing, persistence, or agent execution.
- Installed `@juicesharp/rpiv-ask-user-question` **2.9.0**, MIT: `events.ts` has
  notification-only prompt/blocked events, no answer channel or request identity.
  `ask-user-question.ts` owns the TUI `done` callback; `docs/hosts.md` describes a
  different RPC dialog walker (multi-select is comma-separated text). A fork must
  add a narrow answer seam to the actual TUI, not register a look-alike tool.
- Installed local `pi-subagents` **0.50.0**, `src/runs/shared/pi-args.ts` owns
  child/run/parent identity and independently scoped steering capabilities. Root
  env `PI_SUBAGENT_PARENT_SESSION` alone is not proof of child status. Require
  `PI_SUBAGENT_CHILD=1` and owner provenance; do not let Remote bypass child ceilings.
- Installed local `pi-agent-status` **0.1.0** remains a status-only OSC integration.
  Its presence or a PID is not a control capability. Remote never changes its wire.
- HAPI inspected at **3873e58496b01ade66271ad70f2cf4c24d55d90f**. `cli/src/pi/runPi.ts`
  explicitly states that Pi uses piped `--mode rpc`, without a local TUI input
  path. Its generic handoff is not our required Pi handoff. `web/src/hooks/
  useReconnectingState.ts` separates transient reconnect from a persistent warning;
  `web/src/lib/scrollStorageGuard.ts` bounds restoration state and tolerates quota
  failure. Those are useful principles, not proof of phone suspension support.
  HAPI's root license is **AGPL-3.0**; no HAPI code is reused.

## Decision

Pi remains the sole live conversation/JSONL writer. An explicitly enrolled
in-process extension observes the active branch and admits a small command union.
A separate, opt-in **Helm Remote host** owns authenticated browser delivery and a
bounded soft-state directory, not Pi's lifecycle. It works independently of
Electron; host/browser exit only disconnects observation. It never kills Pi,
opens another writer, or adopts ordinary/scheduled dtach processes.

Seams: (1) extension-owned observation and command admission, (2) host-owned
registration, authorization and bounded client delivery, (3) browser workspace.
Do not introduce a generic RPC gateway. Item integration, when added, crosses
profile-bound ItemCommands/Drainer routes with server-side fencing, never global
activation or direct DB writes.

Identity is `(Pi session ID, extension incarnation, scope generation)` plus a
host epoch. Incarnation changes on reload/session switch/fork; tree navigation
invalidates conversation commands. Host restart changes the host epoch. Stale
commands fail closed, even if the conversation UUID is unchanged. A display label
is not a storage path. Workspace basename is display metadata only.

Enrollment requires a local opt-in for each session and an explicit scope (opaque
profile ID or personal/unbound). Unbound is a real scope, not the active profile.
A browser filter never activates a profile. Grants are authorized for explicit
scopes/sessions/operations; ancestry links are visible only when both ends are
authorized. Profile reassignment/revocation invalidates outstanding commands.

### Delivery and command semantics

Snapshots are bounded projections, not entire JSONL files. Events carry incarnation
and cursor; retained replay is count/byte bounded. Cursor holes, newer tree branches,
unknown epochs or retention expiry require resynchronization. Clients preserve
drafts and reading anchors; a replay gap must be visible. Streaming cannot trigger
whole-history serialization/rendering on each token. Slow clients cannot accumulate
unbounded outgoing buffers. History paging is separate from live replay.

Commands have caller-generated IDs, target incarnation, scope generation and host
epoch. Host admission and Pi dispatch have separate receipts. Retries of the same
ID/body return the prior receipt; ID reuse with different content fails. Never
retry an ambiguous command against a new owner/epoch automatically. Receipt
retention is bounded; an exhausted dedup ledger refuses admission rather than
forgetting IDs and executing duplicates. Exactly-once execution across process
crashes is not promised. `dispatched` means only that the Pi API was invoked;
conversation events prove subsequent effects. Steering and follow-up are explicit;
interrupt does not promise to clear Pi's independent continuation queue.

Question answers use an opaque per-invocation identity owned by the fork. Its
actual local TUI completion and validated remote answers race through one
synchronous first-winner gate. Indices map to package-owned labels/preview data;
browsers cannot forge the model-facing answer envelope. Closing a remote client
never cancels a question. Unsupported custom UI remains terminal-only; no universal
`ctx.ui.custom()` compatibility claim. Notes/preview/RPC parity must be declared
per implemented capability.

### Security and operations

Separate private local extension ingress from browser ingress. Local enrollment
uses owner-only no-follow files and bounded payloads. Remote bearer capabilities
are distinct from Helm local-control/provider/subagent credentials; reuse only
the existing random/hash/constant-time crypto primitives. Browser access requires
authorization on every read/write, exact configured Origin/Host checks, no wildcard
CORS, bounded payloads and rates, no raw HTML/transcript scripts, no external image
fetch by default, no path/PID/socket/credential fields in browser metadata.

Initial tests use loopback ephemeral ports and private scratch. The eventual
production host binds loopback behind explicitly configured **Tailscale Serve**,
never Funnel. Deployment, pairing/revocation storage, HTTPS cookie/CSRF choices,
WebSocket upgrade auth (if WebSockets are adopted), supervision and rollout need
separate verified slices. A polling/HTTP proof may reject all WebSocket upgrades;
that is not a tested WebSocket implementation. Do not expose 7474.

Remote logs contain bounded reason codes/counts, never transcripts/prompts or
capabilities. Shutdown drains host requests, invalidates browser admission and
releases only host resources. On mismatch, expose upgrade-required read-only state;
never restart a live agent automatically. A rollback removes the opt-in bridge/fork
from an idle session through user-controlled reload and stops only the Remote host.

## Alternatives

- Managed RPC: useful later for explicitly new Remote-owned sessions. Cannot obtain
  control of an existing native TUI without replacing its owner; rejected as v1's
  primary path. Historical resume needs a separate exclusive-writer proof.
- PTY mirroring: potentially useful for arbitrary TUI fallback, but requires proven
  capture/input/resize ownership per launch origin. Not semantic conversation UX,
  not justified as a hidden fallback, and no scheduled terminal migration.
- JSONL scanning: historical discovery only. Never label a file as live/control-ready.
- Electron hosting: rejected by operator; unnecessary coupling to desktop lifetime.

## Phases and release gates

1. Prove bounded authenticated routing with two existing disposable TUI processes;
   forked question single/multi/custom answers, local races, reconnect, no restart.
2. Production enrollment and live/unconnected/historical/subagent directory; safe
   history pagination, durable device pairing/revocation, long-lived host packaging.
3. Conversation-first adaptive workspace using Helm tokens/components, real stories
   and browser fixtures, drafts/anchors, explicit receipt states and measured budgets.
4. Explicit new/resume/model/thinking/image capabilities; optional Item links.
5. PWA installation and Web Push after phone suspension tests; hidden-tab notices
   never substitute for suspended-phone push.

Broad UI and production rollout remain gated on phase 1 evidence. Real device
suspension, multiple launch origins, unintegrated-session discovery, large transcript
performance and native workflow regressions must be reported as unverified until
actually tested. This ADR's target design is not acceptance evidence.
