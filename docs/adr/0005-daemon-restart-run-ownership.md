# ADR-0005: Recover run ownership across a daemon restart

## Status

Architecture direction approved by the operator on 2026-09-23: a private per-run supervisor may own direct CLI and Almanac loop processes independently of the daemon. **Design only.** No active-run restart is enabled by this document; the existing restart guard remains mandatory until every run class and transition below is implemented and verified.

## Problem and current evidence

- `src/server/routes/api.ts` saves configuration but refuses to restart while the Drainer or scheduled service reports active work. `Drainer.quiesce()` refuses active solve/loop Items; `ScheduledRunService.restartBlockingRunCount()` counts durable active/quarantined runs.
- `src/solver/spawn-claude.ts` and `src/queue/loop-runner.ts` own child stdout/stderr pipes, log writes, exit handling, and aborts inside the daemon. Killing that owner can strand a live agent, close its pipes, or lose the exit/result. `Drainer.start()` currently moves stale `running` Items to `ready`, which may permit a duplicate launch.
- Okena owns the agent terminal, but `OkenaSolver.solve()` keeps terminal ID, idle/hard deadlines, and result polling in memory. Re-running `solve()` after restart would create a second terminal and clear the old `solver-result.json`.
- Scheduled agents already have persisted dtach ownership and restoration in `ScheduledRunService`; their lifecycle includes report, teardown intent, quarantine, adoption, and shared solve-capacity reservations. This does not by itself make a restart during an admitted tick, teardown, or adoption safe.
- `processSolveItem` marks the Item `review` before `dispatchSolveItem`. A process exit in this interval can lose PR/comment dispatch; blindly retrying it can duplicate an external effect. Knowledge-candidate enqueue and planned-loop completion have their own attempt-scoped boundaries.

## Contract

A graceful *daemon* restart while active work exists must keep each admitted run under exactly one recoverable owner. The new daemon must either restore its capacity and finish the same attempt through the ordinary `ItemCommands`/dispatch path or report a bounded explicit **unknown/quarantined** state that forbids duplicate start and unsafe effects. It must never infer completion from PID existence, log tail, terminal title, a stale result file, or a success-looking exit alone. A host crash/reboot may leave an unknown state; it must fail closed rather than claim seamless completion. Restart is not permission to interrupt, reissue a prompt, recreate a workspace, relaunch a loop, or run a second Item attempt.

Identity for an Item attempt includes immutable profile ID, Item ID, attempt ID and execution lane, plus a private owner generation. Capture the effective solver/config, workspace and knowledge binding at admission, not from the mutable active profile or config after restart. Guard all state writes against the current attempt. A completed/failed/aborted attempt cannot be revived by a late callback from its predecessor. Existing explicit Cancel must still reach the exact attested owner; an uncertain owner is quarantined, not signalled by a guessed PID or pathname.

### Direct Claude/Codex/Pi and Almanac loops

A small private runner, **not the daemon or Electron**, owns the child, stdin, stdout/stderr, bounded logging and the actual exit. The daemon prepares one attempt with an owner-private, no-follow descriptor-backed directory and passes an immutable invocation to the runner; the runner durably acknowledges ownership before launch is considered recoverable. Store an atomic, bounded, versioned final status separately from logs, with exit and failure classification but no DB writes, PR/knowledge effects, or profile activation. On daemon replacement, attest the exact runner/child identity and status; reconnect to observation or consume the sealed result. Never spawn a replacement merely because the original owner is unreachable. Lost/ambiguous acknowledgment and invalid/corrupt records quarantine the Item and continue to reserve capacity until deliberately reconciled.

The loop runner additionally preserves the first emitted Almanac run ID, log flush ordering, the exact `.loop-stop` cancellation semantics, and the attempt's prepared prompt/knowledge context. A restart must not run `prompt.sh`, clear attempt-local knowledge artifacts, or invoke `almanac loop` again for an existing attempt. A runner must not inherit Helm control or provider credentials merely to keep a CLI alive.

### Okena

Persist a private attempt checkpoint **before** sending the launch command, then bind the exact Okena profile/project/terminal ID after creation and before acknowledging dispatch. On restore, never invoke `OkenaSolver.solve()` as a new solve: inspect the exact terminal and workspace, resume result polling with captured elapsed/idle evidence, or quarantine when ownership cannot be proven. Preserve the prior attempt's result-file generation and do not clear its result or type into its terminal. Cancellation uses only the attested existing terminal. A non-existent terminal/workspace is a recoverable failure only with evidence that the attempt cannot still write a result.

### Scheduled runs

Reuse the existing dtach attestation, persistent teardown intent, report and adoption records. A restart barrier must stop new recurrence/manual admission and drain already-admitted preparation, launch, teardown and adoption operations to a durable checkpoint. The replacement must restore all profile reservations before opening Item admission. A quarantined or unresolved adoption remains a restart blocker until its exact owner is settled; never weaken the count to zero just because dtach survives.

### Finish and dispatch

Item finalization, knowledge-candidate enqueue and dispatch need a durable attempt phase marker. New process startup reconciles a sealed result to `ItemCommands` at most once. Before an external side effect, write an intent keyed by the attempt; after an acknowledged effect, write the receipt. An ambiguous PR creation or provider comment is **unknown**, not retried on a fresh owner without external idempotency evidence. Existing source-comment behavior and PR backfill cannot be treated as generic idempotency. Preserve the single-run event/status constraints and profile-local DB ownership.

## Restart ordering and rollout

1. Fence all new work (direct Start/Retry, automatic queue, scheduled admission, planning side effects that could collide); retain a restart lease so a failed preparation can reopen only its own fence.
2. Drain admitted operations to an explicit durable checkpoint. For each run class, attest ownership and account for its lane capacity. If one cannot be proved, refuse the restart and release only admission that this attempt fenced. Do not stop live agents to make the check pass.
3. Commit an epoch-bound handoff and schedule exit after the response flush. The outgoing daemon ceases DB/effect writers; private runners and Okena/dtach owners continue.
4. The replacement restores scheduled ownership and Item attempts for **all profiles** before queue or manual admission. Reconcile final statuses/dispatch intentions behind attempt guards, then reopen admission. A failure leaves startup fenced and surfaces recovery instructions, not `ready` Items.
5. Roll out behind an explicit default-off feature gate. Older daemons must refuse unknown attempt versions rather than performing legacy stale-running recovery. Bump the daemon/app protocol for changed status/config contracts; build both from the same fingerprint. Never test by restarting the operator's active daemon/desktop or using their socket namespace.

## Evidence gates before enabling active-run restart

- Isolated real process tests: restart before launch acknowledgment, during stdout streaming, after child exit but before log/status flush, after final status but before Item completion, and after Item completion but before each dispatch effect. Assert no duplicate child/prompt/PR/comment, no lost log/result and preserved cancellation. Exercise corrupt, substituted, symlink and PID-reuse evidence as quarantine cases.
- Okena fake + disposable terminal tests: restart on either side of command dispatch and result publication; verify no second terminal/command or clearing of the prior result. Test closed workspace, idle timeout, cancellation and profile changes.
- Almanac real-fake tests: first run ID, stop file, prompt preparation and log flush survive a restart without a second invocation.
- Scheduled dtach tests under short isolated `/tmp/` sockets: admission/launch/teardown/report/adoption interleavings, startup reservation restoration, quarantine and lease loss. No production socket or desktop canary beside a live Helm.
- Mixed-version and failure tests: rejected handoff leaves the old daemon serving; crashed owner retains fenced state; new daemon startup failure never wakes Queue; saved config is not reported applied until replacement attests the new build.

No success claim or permission to remove the active-run guard follows from a unit test of only one run type. Until these gates pass, config saves remain deferred while any run is active.
