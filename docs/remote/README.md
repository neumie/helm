# Helm Remote — implementation and verification record

Remote is part of **Helm**, on `feat/helm-remote`. The sibling `helm-remote/`
checkout is an isolated Git worktree of the same repository, not a new product
or repository. Baseline: `50bc7a6`, inspected 2026-09-07.

**Status: an isolated development vertical slice, not a production release.**
The operator accepted an independent host and a fork of the installed question
extension. Neither that approval nor these tests authorize deployment, package
replacement, Tailscale changes, or restarting existing Helm/Pi processes.

## Ownership and implemented seams

```text
existing Pi TUI — owns process, tools, conversation and JSONL
    opt-in in-process bridge + actual questionnaire fork
                 │ private UDS, per-enrollment bearer
                 ▼
independent Helm Remote host — bounded directory, command admission and receipts
                 │ same-origin HTTP, separate browser bearer
                 ▼
Helm Remote browser workspace — no Electron preload, PTY or daemon authority
```

- `src/remote/protocol.ts`: one strict schema for the browser and local wire.
- `src/remote/host.ts`: scoped registration, authentication, bounded queue/receipts,
  freshness and explicit stale-owner replacement. No DB, daemon, Item or terminal imports.
- `src/remote/admission.ts`: Pi-side reserve-before-effect command deduplication.
- `src/remote/private-file.ts`: bounded, owner-private, no-follow enrollment reader.
- `packages/helm-remote-bridge/`: ordinary TUI opt-in only; reads the active branch,
  projects message events, dispatches explicit prompt/interrupt/answer operations.
- `packages/helm-ask-user-question/`: the complete published 2.9.0 question tool
  fork, with one local/remote completion gate in the real TUI. See `FORK.md` and
  the retained MIT `LICENSE`; it is not installed or published.
- `app/src/renderer/remote/`: the production browser components, narrow fetch
  adapter, Storybook fixtures and separate preview entry. Reuses Helm's actual
  CSS, `Btn` and `Disclosure`, not `window.helm` or a look-alike terminal workspace.
- `src/remote/development.ts`: explicit development entry, fresh private scratch,
  two personal-scope enrollment files, an ephemeral **127.0.0.1** listener and
  exact static asset allowlist. It never launches Pi or connects to 7474.

Architectural decisions, inspected Pi/HAPI sources and target release gates are
in [ADR-0004](../adr/0004-remote-session-ownership.md). The ADR includes future
requirements; this record is the source of truth for what has actually shipped
in the branch. HAPI was reference-only; no AGPL source was copied.

## Current behavior and limits

The directory contains explicitly enrolled sessions, including stale observations
marked disconnected. Search and scope filters are browser-local; they never
activate a native profile. Personal/unbound is a real scope. Opaque scope IDs in
the proof are not a claim that production profile-registry authorization is wired.

The browser shows conversation text, incremental assistant output, collapsed
thinking/tool previews and supported questionnaires. It supports prompts with an
explicit steer/follow-up choice and an interrupt request. Unsupported custom UI
says to use the original terminal. No keys, shell commands, arbitrary paths or
process operations are forwarded.

| Boundary | Implemented bound / meaning |
| --- | --- |
| Identity | Session UUID + incarnation + scope + generation + host epoch |
| Enrollment | At most 16 initial grants per host; development entry creates two |
| Observation | Last 40 message projections, up to 200 branch-entry visits on initial enrollment |
| Message preview | 8192 characters each for text/thinking; 160KiB total message JSON including escaping |
| Questionnaire | Up to four questions/four options, 64KiB serialized; oversized or unsupported UI stays local |
| Exchange | 256KiB pre-parse body/response limit; local settled polling every 500ms |
| Browser reads | Directory every 2s; selected detail every 1s, no overlap; visibility wake requests a fresh snapshot |
| Freshness | Five seconds without exchange becomes disconnected/unknown |
| Commands | Eight pending per session; 4096 non-evicted command IDs per owner; SHA-256 fingerprints, not retained prompt copies |
| Command lifetime | Ten-second host deadline, checked again by Pi before first effect. Expired undelivered = rejected; delivered with lost acknowledgement = unknown |
| Browser requests | One explicit bearer; exact Host, exact Origin for writes and any supplied Origin on reads; 240 requests/minute per host |
| Rendering | Bounded current window, literal text; no active HTML, external-image fetch, conversation logging or whole-history mount |

A host acknowledgement is `pending`. **Dispatched means only that Pi's API was
invoked.** `sendUserMessage()` returns void; conversation events prove subsequent
acceptance/effects. Interrupt requests an abort but does not promise to clear Pi's
independent follow-up queue. Unknown delivery is never automatically resubmitted:
the browser offers a read-only receipt check. An explicit “I've checked the
conversation” action permits a new command; it does not retry the old one.

Local and remote question completion race through the same one-shot gate. Indices
resolve to original option labels and selected preview bytes, not browser-authored
model envelopes. After an answered receipt, browser controls stay fenced until
observation removes/replaces the old question. Closing a browser does not cancel it.

Each complete identity retains its draft and reading anchor across navigation and
network reconnects. A new incarnation/epoch requires fresh selection and does not
inherit the old branch's unsent draft. Streaming follows only while at the bottom;
otherwise a message-ID/offset anchor stays put and Jump to latest is explicit.
Displaced live-window content is disclosed. Drafts/receipts are **tab-memory only**:
page reload, revocation or browser process loss does not have durable draft recovery.
Text selection is not reconstructed across unmounts or expired message windows.

Pi reload/switch/fork/tree navigation disconnects the bridge without stopping Pi.
Pi 0.85.1 uses `session_before_switch`/`session_before_fork` and `session_start`,
not post-switch/fork event names. Waiting events are already depth-coalesced by
Pi's runner; the bridge does not infer waiting from terminal output.

Explicit re-enrollment requires an **unused same-scope/generation grant** and a
stale prior owner. The host burns the old grant, drops its transcript and retains
only final/unknown receipts. It never transfers pending commands to the replacement.
A reused enrollment file is deliberately refused. A host restart changes the epoch
and requires new enrollment/browser credentials; seamless host-restart replay and
exactly-once crash recovery are not implemented.

## Setup in the isolated checkout

The current proof worktree reuses existing root/app/package dependencies through
**worktree-only `node_modules` symlinks**. Do not run installs through those links:
that would mutate the original checkout/installed packages. Reproducible clean
package installation and standalone distribution remain a separate packaging gate.
The bridge currently imports its sibling Helm source; keep the repository checkout
present rather than copying just its package directory elsewhere.

Requirements used here: Node 25.6.0, selected Pi CLI 0.85.1, Python 3, existing
root/app dependencies and Playwright Chromium. The installed npm extension tree
also contains older Pi 0.84.4 declarations; `check-remote-pi.mjs` deliberately
resolves the selected CLI's **0.85.1** declarations for the full fork and bridge.
The optional i18n SDK is absent; the real English fallback is exercised.

From the implementation checkout:

```sh
# CPU-heavy commands use the shared macOS sysbudget allocation.
sysbudget run --class background -n 2 --label 'Remote preview build' -- \
  node app/scripts/build-remote.mjs

# Supply the real installed CLI file, not a launcher shim or a live session path.
export HELM_REMOTE_PROOF_PI=/absolute/path/to/pi-coding-agent/dist/cli.js
sysbudget run --class background -n 1 --label 'Remote Pi types' -- \
  node scripts/check-remote-pi.mjs

HELM_REMOTE_PROOF_BROWSER=1 sysbudget run --class background -n 2 \
  --label 'Remote two-terminal proof' -- node --import tsx --test \
  --test-concurrency=1 tests/remote-foundation.test.ts \
  tests/remote-development.test.ts tests/remote-terminal-proof.test.ts

cd app
sysbudget run --class background -n 2 --label 'Remote Chromium workbench' -- \
  node_modules/.bin/playwright test browser-tests/remote-workspace.spec.ts --workers=1
```

The Pi proof owns two disposable pseudo-terminals, isolated HOME/Pi configuration
and an offline deterministic provider. They first converse locally, then hot-load
the bridge into the *already running* processes. It is not a new RPC owner. Only
the test's own processes/state are cleaned up. The browser flag is opt-in and fails
if its built assets or Chromium dependency are unavailable; it is not silently
replaced by an HTTP-only proof. Default root tests skip the expensive Pi proof.

To inspect the development UI manually after building it:

```sh
# This is a service, not a CPU batch: do not wrap it in sysbudget.
node --import tsx src/remote/development.ts
```

It prints only its ephemeral loopback URL and private scratch directory. Paste the
private `browser-token` file's contents into the page locally; never put the token
in a URL, command argument, screenshot or diagnostic log. Credentials are kept in
memory, not cookies/localStorage. An invalid/revoked token offers Connect again.

In an **operator-approved, disposable** Pi TUI with the full fork and bridge
explicitly loaded (never upstream + fork together), run:

```text
/helm-remote-connect /canonical/private/hr-…/enroll-1.json
```

A second TUI uses `enroll-2.json`. Already-running user sessions would need an idle,
operator-led extension selection change and `/reload`; that production action was
**not performed**. Use the automated isolated driver as the reproducible onboarding
proof. The development host has no dynamic enrollment UI; consumed grants are not
reusable, and restarting only that host creates a fresh pair.

## Verification record

- **15/15** focused Node tests passed: foundation contracts, private loopback/UDS
  listener, real unauthenticated/authenticated WebSocket-upgrade rejection, two
  pre-existing Pi TUIs, browser prompt/question round-trip, fresh-incarnation
  re-enrollment, stale-command rejection and return to the original terminal.
  The optional Chromium gate **was enabled**; it rendered the actual bundle at
  390×844 and used the actual browser transport, not a mock HTTP client.
- Full questionnaire fork + bridge typechecked against **Pi 0.85.1**.
- Backend build, complete native app build (including its native addon), Storybook
  TypeScript check and separate Remote browser bundle: **passed**.
- **10/10 Chromium workbench tests passed**: 1280px/390px navigation, draft and
  anchored reading retention, unknown-delivery recovery without resending,
  single/multi/custom forms, disconnect/revocation, keyboard focus/reduced motion,
  a 390×420 keyboard-height viewport, replacement-owner fences, post-answer fences,
  inactive untrusted markup, and bounded render/memory budgets. Screenshot layouts
  were inspected at both widths. Fractional anchor rounding is bounded to one pixel.
- Full serial Helm regression: **870 passed, 0 failed, 1 skipped** (871 total).
  The skipped test is the opt-in real Pi proof, which passed separately with its
  browser gate. Repository lint passed (371 files); no native lifecycle source changed.
- The first broad run failed because a fresh worktree lacked generated build IDs
  and extension dependencies, plus an existing scheduled-test cleanup assigns
  `undefined` into `process.env` (Node stores the literal string), creating an
  overlong relative socket path in this checkout. A source-archive comparison and
  unchanged-source inspection separated setup from Remote behavior. The successful
  rerun used built identities, the existing extension dependency tree and a fresh
  short **HELM_SCHEDULED_SOCKET_DIR**. No scheduled production code was changed.
- Read-only independent review identified stale-owner replacement, incomplete browser
  identity keys, missing final-receipt recovery, stale answered-question controls and
  streaming-window truncation. All five received targeted fixes and regressions.

### Measured browser budget

Chromium headless, macOS arm64, Storybook development build, 40 rendered messages;
12 long live-window updates and ten navigation cycles. React Profiler measures
render duration (not layout/paint); CDP forces GC before heap comparisons. The
fixture labels its retained tail as messages 9960–9999 but does **not** load a
10,000-message history. These are bounded-preview measurements only.

| Metric | Observed | Budget |
| --- | --- | --- |
| Row click → two animation frames | 22.2ms | <100ms |
| p95 React render (24 samples) | 3.5ms | <16ms |
| Retained JS heap growth | 1,081,768 bytes (~1.03MiB) | <8MiB |
| Mounted message count throughout | 40 | ≤40 |

Reproduce with the workbench test `bounded live-window render and memory budgets`.
Its JSON attachment and screenshots land in ignored `app/test-results/`. No real
phone/large-history/service RSS measurement is implied.

To repeat the broad suite safely **after the app/root build and with extension
dependencies available**, provide a new private short socket root:

```sh
HELM_SCHEDULED_SOCKET_DIR=$(mktemp -d /tmp/hr-sched-reg-XXXXXX) \
  sysbudget run --class background -n 1 --label 'Helm isolated regression' -- \
  node --import tsx --test --test-concurrency=1 tests/*.test.ts
```

### Compatibility and remaining acceptance gates

| Surface / behavior | Evidence and scope |
| --- | --- |
| Pi 0.85.1 ordinary TUI | Real disposable processes, not mocked ExtensionAPI; same PID/session through hot reload and control |
| Full fork 2.9.0-helm.1 | Actual TUI tool, single/multi/custom + selected preview; local/remote first-winner unit races |
| Local notes / RPC / i18n | Upstream implementation retained; remote notes/cancel/RPC-event control not implemented; non-English SDK not tested |
| Generic Pi dialogs / custom TUI | Honest terminal-only notice; no universal custom-UI or terminal-input fallback |
| Two authorized scopes | Grant/target mismatch and old-owner rejection tested; no production ProfileStore/desktop activation integration |
| Helm / Okena / ordinary terminal launch origins | Terminal-agnostic extension design; only disposable pseudo-terminals tested, not the user's actual launcher workflows |
| Electron closed | Host imports/launches no Electron and has independent lifetime; existing desktop was deliberately not closed for acceptance |
| Subagents / daemon solves | Child TUI enrollment refused; discovery/parentage and headless solve conversation capabilities not implemented |
| Browser/host reconnect | Fresh HTTP snapshots, bounded preview and command dedup; no retained replay cursor or transparent host restart |
| Real phone suspension / soft keyboard | Not tested on hardware. Chromium viewport/resized-height tests are not hardware evidence |
| Native workflows | No native lifecycle source changed; broader regression results must retain any baseline failures/skips |

## Next slices (not silently dropped from the vision)

1. Durable local enrollment/onboarding and per-device pairing/revocation with explicit
   profile/session/operation grants; package distribution and independent supervision.
2. All-authorized-session discovery: live-unconnected, historical/resumable and
   provenance-attested subagents, without hot filesystem scans or another JSONL writer.
3. Separate history pagination and retained bounded replay; slow-client/backpressure
   and long-session memory tests beyond the current 40-message preview. Durable draft
   recovery needs a deliberate privacy/storage policy.
4. Explicit new/resume ownership, model/thinking selection, image input and optional
   profile-bound Item links. These must not be inferred from a PID or a JSONL file.
5. Approved loopback + Tailscale Serve deployment, real phone keyboard/suspension
   acceptance, then PWA installation/Web Push. Never Funnel; never expose 7474.

## Hardware/manual checklist before production approval

- Use approved isolated Helm, Okena and ordinary terminals; record each Pi UUID/PID.
  Verify local output → browser, prompts/steering/follow-up, and return to each terminal.
- Compare two browser tabs/devices and local TUI answers to the same questionnaire;
  exactly one tool completion, truthful losing receipt, no duplicated prompt.
- On iPhone Safari and Android Chrome: rotate, open/close the actual software keyboard,
  select/copy long text, navigate while editing, verify touch targets/safe areas/no overflow.
- While reading history, stream long output; preserve the anchor. Change tree/fork and
  prove old controls/drafts cannot target the new owner without explicit selection.
- Lock the phone, background/terminate the browser, change Wi-Fi/cellular, sleep/wake
  the Mac and restart only the Remote host. No automatic resend. Distinguish lost drafts,
  expired live windows, epoch reset and reconnect; test restored auth separately.
- Close Electron only with approval; do not stop Pi/dtach masters. Verify Remote continues
  and reopening the same original terminal retains its conversation and ownership.
- Revoke a device, attempt unauthorized reads/writes/upgrades, inspect diagnostic output
  for credentials/transcripts, and verify another profile is never activated or leaked.
- Do not claim suspended-phone notifications until a real PWA/Web Push path is implemented
  and observed; an open/hidden tab notification is a different behavior.

## Stop and rollback

Close the browser to detach that client; Pi continues. Stop the development host
with Ctrl+C to revoke its admission and close only its listeners. Private scratch
is retained intentionally for inspection; remove only the printed, verified test
directory after its host stops—no recursive agent-workspace cleaner is installed.

`/helm-remote-disconnect` stops the bridge, not Pi. Removing the opt-in bridge/fork
from an approved idle session is an operator-controlled selection change + reload,
never a process kill, terminal migration or concurrent JSONL resume. Restore the
upstream questionnaire package selection if it was changed during an approved test.
No production package/configuration, native session registry, dtach ownership,
launchd job or Tailscale policy was changed by this work.
