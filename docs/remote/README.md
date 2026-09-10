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
- `src/remote/runtime.ts`, `access.ts`, `catalog.ts`: the separate everyday runtime.
  It owns a private per-user singleton/control socket, one-time local pairing,
  hashed durable device credentials/revocation, explicit HTTPS origin enforcement,
  and a bounded read-only Pi JSONL metadata catalog. It binds loopback only and
  **does not install TLS, Tailscale Serve, a proxy, or global Pi settings**.
- **Pair from Helm:** open **Settings → Remote**, enter a device name, choose **Pair device**, and approve the native personal-access confirmation. Scan the QR on the other device, or open the displayed HTTPS origin there and enter the six-character code. Codes expire after two minutes. **Hide code** only hides the presentation (including any pending replacement); use **Revoke** on the paired-device row to remove access. If saving revocation fails, use **Retry revoke**. Revoked rows retain **Revoke again** because older hosts can report an in-memory block before it is durably saved; this recovery remains available after reopening the page and still requires confirmation. The page requires the already-configured running Remote host and never starts/deploys it or reloads Pi. A newly built native page becomes available after an operator-led Helm restart; do not restart a live desktop as a test.
- `app/src/remote-pairing.ts` + Settings → Remote: native Electron operator
  authorization for that existing private control socket. The main process alone
  validates the owner-private token/UDS responses and presents native Pair/Revoke
  confirmations; preload receives only a safe availability/device projection and
  an expiring QR/code presentation. This is intentionally the secret presentation
  boundary for local operators. The local TTY `remote/bun run pair` remains a
  fallback, not a requirement when the native app is available.

Architectural decisions, inspected Pi/HAPI sources and target release gates are
in [ADR-0004](../adr/0004-remote-session-ownership.md). The ADR includes future
requirements; this record is the source of truth for what has actually shipped
in the branch. HAPI was reference-only; no AGPL source was copied.

## Current behavior and limits

The directory contains explicitly enrolled sessions, including stale observations
marked disconnected. Search and scope filters are browser-local; they never
activate a native profile. Personal/unbound is a real scope. Opaque scope IDs in
the proof are not a claim that production profile-registry authorization is wired.

The browser opens directly to live conversations with one compact search field; the workspace has no separate History/App destinations or explanatory masthead. Browser installation remains available through the browser's native install/Add to Home Screen controls, and pairing remains in Helm's native Settings → Remote. The browser shows conversation text, incremental assistant output and supported
questionnaires. Consecutive same-speaker messages share one author label. Thinking,
tool results and whole tool-call activity messages are absent by default; opt in
through **Conversation options → Show activity**, then expand an individual preview. It supports prompts with an
explicit steer/follow-up choice and an interrupt request. Unsupported custom UI
says to use the original terminal. No keys, shell commands, arbitrary paths or
process operations are forwarded.

### Manual SOURCE LABEL repair

An operator can repair the source label of an already-enrolled session without
restarting Pi. The private runtime control socket exposes `GET
/source-candidates` and `POST /source-candidates/confirm`; both are authenticated
with the operator token, while the bridge registration token and browser listener
cannot use them. The inventory contains only the host epoch, complete session
target, one bounded human caption, connected freshness, native source, and
manual source. Confirmation or clear requires that exact epoch/target and a
fresh current owner; source is limited to `okena`, `helm`, or `null`.

The confirmation is an in-memory display fallback on the current `RemoteHost`
record. It is not native ownership or authentication attestation and does not
edit Pi environment/session files or change the Pi snapshot, revision, commands,
receipts, admission, or capabilities. It projects only source with all native
name/project/worktree/branch/group fields null while native metadata is absent.
Native metadata wins and clears the fallback, so a later native-metadata loss
cannot resurrect it. Owner retirement/replacement and host restart clear the
confirmation. The repair therefore lasts only for the current host/owner memory
lifetime and must be repeated after those boundaries.

| Boundary | Implemented bound / meaning |
| --- | --- |
| Identity | Session UUID + incarnation + scope + generation + host epoch |
| Enrollment | Shared wire/host bound of 64 unused grants plus live/stale owners; pressure reclaims only stale observations; development entry creates two |
| Observation | Up to 40 ordered projections, protecting ten conversation messages against activity bursts; at most 200 branch-entry visits on initial enrollment; byte limits still take precedence |
| Message preview | 8192 characters each for text/thinking/tool names; 160KiB total message JSON including escaping |
| Questionnaire | Up to four questions/four options, 64KiB serialized; oversized or unsupported UI stays local |
| Exchange | 256KiB pre-parse body/response limit; local settled polling every 500ms |
| Browser reads | Directory every 2s; selected detail every 1s, no overlap; visibility wake requests a fresh snapshot |
| Freshness | Five seconds without exchange becomes disconnected/unknown |
| Commands | Eight pending per session; 4096 non-evicted command IDs per owner; SHA-256 fingerprints, not retained prompt copies |
| Command lifetime | Ten-second host deadline, checked again by Pi before first effect. Expired undelivered = rejected; delivered with lost acknowledgement = unknown |
| Browser requests | HTTPS runtime uses a persistent host-only Secure/HttpOnly/Strict device cookie; development uses an explicit in-memory bearer; exact Host, exact Origin for writes and any supplied Origin on reads; 4096 authenticated requests/minute globally, 300/device and a separate 120 unauthenticated allowance |
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

Explicit development re-enrollment requires an **unused same-scope/generation grant**
and a stale prior owner. Automatic registration is different: its short-lived grant is
bound to the exact validated Pi session UUID and carries the stable personal null-scope
generation `1`; the bridge's lifecycle counter is only a local closure fence. That
bound grant may replace only a stale prior owner after an observed successful normal
tree lifecycle. UUID binding never proves continuity of a live owner. The host burns the old grant, drops its transcript and retains only
final/unknown receipts. It never transfers pending commands to the replacement. A
reused enrollment file is deliberately refused. A host restart changes the epoch and
requires fresh registration for automatic owners; browser credentials persist by design.
Open questionnaire/outermost UI waiting observation survives discovery and transport
replacement within one Pi lifecycle (eight questions/64KiB aggregate), not navigation.
Manual scope never becomes personal automatic authority: a successful manual selection
or explicit disconnect sets a refusal-only process-lifetime latch, including across
`/reload`/session replacement. It stores no grant/scope/path, writes no session or settings,
and is not an inherited environment flag. A fresh explicit manual grant is required after
lost authority or settled navigation; no automatic-enable action is added. A newly started
Pi process uses its own configured startup policy. Environment auto-disable is independent. Seamless command
replay and exactly-once crash recovery are not implemented.

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
and an offline deterministic provider under a short canonical `/tmp` root. The
automatic proof selects the bridge and questionnaire through a disposable Pi global
settings document before either TUI starts; the retained manual proof starts without
the bridge and genuinely hot-loads it later. Neither is a new RPC owner. Only the
test's own processes/state are cleaned up. The browser flag is opt-in and fails if
its built assets or Chromium dependency are unavailable; it is not silently replaced
by an HTTP-only proof. Default root tests skip the expensive Pi proof.

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

### Stage 3 integration repair (latest)

- The first executed gate found a real installer defect: Pi 0.85.1 package
  **selection filters** match `index.ts`, not the `./index.ts` used in package
  **manifests**. The installer now emits working filters. Successful realistic
  npm/versioned/object/direct-entrypoint fixtures remain present at apply time;
  colliding unrelated names/options and the settings pointer survive, with exact
  backup/rollback bytes. These are disposable settings only.
- The automatic two ordinary Pi 0.85.1 TUI proof now consumes those installer-produced
  settings without direct bridge/questionnaire `--extension` paths. Pi's actual
  tool/command `sourceInfo` attests the selected package entrypoints and one
  questionnaire tool. The original PIDs/session UUIDs keep local-before-host
  conversation, independent routing, a browser-origin answer, a local TUI winning
  answer with a rejected late browser answer, normal public tree rebind and host
  restart. Only the offline deterministic model provider is a direct test extension.
  The separate manual-hot-load proof still starts without the bridge and exercises
  the real built Chromium workspace against its existing TUI.
- The production HTTPS entry uses actual TLS/runtime requests for mounted
  revocation → Access ended → Pair again → fresh challenge → workspace, without
  reload. Fetch-boundary instrumentation observes an empty fragment before even
  `/v1/access`; double synchronous submission produces one request. Real Chromium
  cookie inspection verifies Secure/HttpOnly/Strict, host-only, root path and
  approximately 90 days, plus no script visibility. QR decoding remains a separate
  independent decoder proof.
- PairingEntry, PairingFromQr and PairingRecovery mount the production controller
  with explicit **mock services**, never HTTP development auth. Controlled promises
  verify manual supersession, single-flight admission, disposal abort and ignored
  late success. Workspace fixtures change authority without a Pi revision change;
  all question fields and submission disable while authorized evidence remains.
- Runtime host tests replace 32 independent session owners in three clock-stepped
  batches: count pressure happens before any 60-second retirement expiry. Separate
  checks establish 64 incarnations, 32 receipts per incarnation and 512 receipts
  globally, device isolation and delivered-unknown/undelivered-rejected semantics.
  A separate-process first-start race authenticates the actual winning listener
  with its surviving private token and rejects missing/wrong tokens.
- Executed second gate: 12/12 actual-Pi/onboarding Node tests, lint/backend build,
  complete app build (no desktop launch), Storybook typecheck/static build, and
  14/14 Chromium workbench tests passed with no skips. Workbench measurements:
  22.6ms open-to-paint, 9.3ms p95 React render (24 samples), 1,029,016 bytes heap
  growth. The only build warning was existing Storybook chunks above 500kB.

These layers are complementary: automatic Pi routing uses authenticated Node HTTP;
TLS auth uses the built browser with an isolated runtime; the manual Pi proof uses
built Chromium with development bearer. They do **not** establish one automatic
installer-selected HTTPS browser-to-Pi/phone deployment. The full Remote gate is
recorded in the Stage 3 acceptance artifact; earlier numeric results below remain
historical checkpoint evidence, not a new rollout certification.

- **B1 registration repair (current):** serial focused tests cover session-bound
  automatic grants, final-binding expiry, same-host normal-tree rebind, guarded
  current-owner refusal, and question-listener lifecycle cleanup. The actual Pi
  0.85.1 automatic two-TUI proof
  starts both ordinary TUIs before the host, routes independently, completes the real
  questionnaire, performs a public normal-tree lifecycle rebind, and recovers a host
  restart. The retained manual proof verifies the bridge was absent before `/reload`.
  Native cancelled/aborted/overlapping navigation remains a fail-closed compatibility
  limit; the SDK exposes no settlement event, so it is not claimed as recovered.
- **B2 catalog and pairing entry (current):** the runtime catalog advances admitted keyset-page rescans through asynchronous bounded directory/file/byte slices (including malformed candidates), drains admitted IO on stop, uses a 128-entry cache plus 51-record selection rather than an inventory cache, and filters the authorized live UUID overlay before expensive name traversal. Authenticated cursors preserve unchanged pages; actual witnesses invalidate explicitly and restart the preserved search. It streams to the latest `session_info`, including clear semantics, and rows expose no paths, transcript text, or controls. The local TTY pairing command renders a scannable one-time QR and states personal current/future conversation authority, operations, expiry and device lifetime. The actual built entry is covered through a disposable self-signed TLS terminator with Chromium’s test-only HTTPS exception: QR/code redemption, fragment scrubbing, Secure cookie reload persistence, expiry-to-fresh-code recovery, revocation-to-pair-again and request guards. This remains local TLS evidence, not Tailscale/phone/deployment proof.
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
| Browser/host reconnect | Fresh HTTP snapshots, bounded preview and command dedup; no retained replay cursor; automatic re-registration preserves lifecycle dialogs, manual requires fresh authority |
| Real phone suspension / soft keyboard | Not tested on hardware. Chromium viewport/resized-height tests are not hardware evidence |
| Native workflows | Native pairing adds main-owned IPC and a production renderer page; controller/disposable-runtime and Storybook checks are distinct from actual Electron dialog or phone verification. Existing terminal/process ownership is unchanged. |

## Persistent runtime onboarding (implemented, not deployment)

Run `remote/bun run setup -- --origin https://approved.example --pi-root ~/.pi/agent/sessions`
once to record the exact eventual browser origin and explicit Pi roots in an owner-private
runtime setup document. It does **not** create TLS, route a phone, install Tailscale, or
edit Pi settings. Afterwards `remote/bun run start` builds and starts only the persistent
Remote runtime without repeated origin/root environment chores; one-shot environment
overrides remain available for isolated tests. `remote/bun run pair [device label]`
intentionally prints a one-time `XXX-XXX` code and scannable QR only on a local TTY. The
Secure/HttpOnly/SameSite=Strict cookie is issued only by the HTTPS runtime contract;
loopback development continues to use ephemeral in-memory bearer auth.

The runtime's owner-private `~/.helm/remote/` directory carries its singleton lock,
operator control capability and hashed device ledger. A second start reuses only an
authenticated compatible control socket; an unknown/stale lock is refused rather than
stolen. Ctrl+C stops only the runtime it owns. A normal Electron exit does not stop it.

**A healthy older build also refuses reuse.** Root `bun run start` rebuilds first;
compatibility requires the exact build fingerprint, not only the protocol. Even a
documentation edit changes the dirty-checkout fingerprint. The generic “runtime lock
exists but no compatible authenticated host answered” error can therefore mean a
healthy, authenticated older host—not a stale lock. Do not delete the lock. Either
launch only the desktop with `cd app && bun run start`, or explicitly approve a
Remote-only update: finish edits/builds, gracefully stop the owned Remote process,
verify its listener and owned lock were released, then start
`node dist/remote/runtime.js` from the root. Never discover-and-kill arbitrary Pi,
Electron or daemon processes. Browser connections briefly drop and the host epoch
changes; persisted device credentials survive, but pending commands are not replayed.
No Tailscale or global Pi settings change is needed.

The catalog scans only the setup-configured (or explicit test-override) Pi roots with
one asynchronous filesystem chain, no-follow regular-file checks, bounded attempt/byte
slices and 50-row keyset pages. It retains at most 128 completed metadata entries and each
admitted view retains only its current 50-row page plus a 51-record selector; it never builds
a persistent or inventory-sized index. Authenticated cursors bind principal, query, host epoch and the
current authorized-live overlay. Unchanged scans preserve a page cursor; a changed witness
returns an explicit invalidation and the browser restarts the same search from page one.
Previous is inverse keyset selection, not browser history. The metadata selector streams to
file end so the latest `session_info` wins, including empty/absent-name clears, without
retaining message payloads or imposing a cumulative valid-file-size cutoff. It exposes no
file paths, cwd, transcript, PID, socket or command target. Its historical rows are liveness
`unknown` and read-only.

Directory and selected-file identities are bracketed before reads and reattested before page
publication. Detected replacement fails closed. Public Node pathname APIs do not provide an
atomic directory snapshot on Darwin: same-user ABA/in-place mutation between checks and a
continually changing inventory remain explicit limits, not security claims. The separate
public `Dir` iterator cannot be proved descriptor-identical to its attestation handle on
Darwin; no private Node fields or `/dev/fd/<dir>/<child>` assumption is used.

Catalog boundary details:

- Views have a 60-second idle lease renewed only by current/newer polling; abandoned
  work drains before reclaiming its slot. An actively polled scan has no cumulative
  size/time ceiling. One desired replacement per view supersedes only its own scan.
- Every filesystem call, including publication pin/stat/path checks and ordinary closes,
  yields through the one global chain. The 128-operation, 512-entry, 128-file-attempt and
  1MiB byte budgets charge before awaiting; test barriers also consume operation slots.
  Exceptional/stop cleanup closes at most the owned handle bound and is drain work,
  not a new scan. An issued syscall may stall; stop promises drain, not a short deadline.
- Diagnostics count all admitted jobs' selections/candidates/previous pages, desired
  requests, actual handle/iterator opens and closes (five per scanning job, three during
  publication), parser high-water fields/depth and actual bytes read. Root locators are
  limited to eight, root paths to 4096 bytes; child locators add only two filesystem names.
  Cache + record slots remain bounded by `C + Q*(2P+2)`; request descriptors by `2Q`.
- `catalog-selector.ts` validates the JSONL grammar while skipping payload values:
  fixed depth 64 (sampled on every stack allocation), recognized scalar buffers at most
  130 UTF-16 units, an incrementally normalized name capped at 160 UTF-16 units without
  splitting surrogate pairs, UTF-8 decoder carry, one transient decoded read chunk
  (at most 64Ki characters), and no transcript tree/string accumulation. File identity
  plus nanosecond mtime/ctime and captured size must still match after parsing.
- Ready means all supported candidates were scanned. Definite malformed/unsupported
  files are explicitly omitted with separate counters saturating at 1,000,000 (meaning
  at least that many), no path/error lists, and a visible warning. Their versions enter
  the witness, so omission changes invalidate old cursors too. Incomplete/truncated
  reads, observed version changes and substitutions stay unavailable; only the exact
  same request may retain stale evidence. Errors retry on polling after a one-second
  backoff, or through runtime refresh. Limits never turn valid large files into omissions.
- `tests/remote-catalog-pages.test.ts` walks all IDs of 2,305 on-disk sessions, traverses
  a 75,062,066-byte valid file with a >64MiB message and late name, and repeatedly appends
  an authorized-live file while historical metadata becomes ready. The regression suite
  adds tiny concurrent bounds, grammar/escape/clear cases, leases, errors/substitution,
  stop barriers, actual authenticated host HTTP through the production transport, and
  the built production workspace in headless Chromium. These are local disposable
  filesystem/HTTP/browser tests, not installed-Pi, TLS rollout, phone or deployment proof.

## Recognizable terminal names

Live sessions can show the existing terminal name, project and folder/group instead
of a generic Pi label. These are display annotations only: they never identify a
command target, change a grant, switch a profile, or replace a draft's full owner key.

- **Okena:** after publishing the updated Remote host, refresh the Remote browser, then use Pi's `/reload` when convenient.
  The bridge matches the shell's existing `OKENA_TERMINAL_ID` against the saved local
  layout across Okena profiles. For a worktree match it reports the parent project,
  worktree/project label, and a best-effort read-only Git branch from that exact project
  path; it does not choose `last_used`, infer ownership from cwd, or use stale name-map
  entries.
- **Helm:** the updated desktop passes its exact terminal ID and profile-local registry
  locator into newly created ordinary shells. Custom tab names win over saved titles;
  groups remain visible. Already-running dtach shells keep their existing environment,
  so restarting/reattaching the desktop does **not** retrofit this handoff. Use a new
  terminal after updating Helm; do not kill ongoing Pi work for metadata.
- Names refresh best-effort every ten seconds without delaying Remote commands.
  Missing, unreadable, oversized or ambiguous metadata falls back to Pi's own label
  and workspace. Older Helm shells never inherit the outer Okena terminal's identity.
- Only bounded source/name/project/worktree/branch/group labels cross the wire. The bridge reads
  existing owner-owned metadata that is not group/world-writable, using bounded no-follow descriptors;
  it never reads terminal output, opens the daemon DB, calls Okena actions, or writes
  either app's metadata. No raw paths, terminal IDs, hooks or credentials are published.
  These labels describe saved metadata, not a new process-ownership attestation.

The optional metadata and structured tool-call wire fields require this order: **update Remote host → refresh browser → Pi reload**. Older strict host and browser schemas reject newly emitted fields; refreshing only the browser cannot update the running Pi bridge.
The updated bridge separates tool names from assistant prose; older whole `Tool: name`
messages remain reversibly hidden by the browser, without stripping lines from ordinary prose/code.
The daemon API protocol is unchanged. Browser labels update without resetting selection
or drafts. The historical catalog still uses only its existing Pi metadata path.

## Installable Remote app

The browser client includes a standalone PWA manifest, 192/512px mask-safe launcher icons, an Apple touch icon and a network-only service worker. Use the browser’s native installation affordance: Chromium can offer **Install app**; iPhone uses Safari → Share → Add to Home Screen → Open as Web App; Safari on Mac uses Add to Dock. An installed app may need its own pairing. It still requires this Mac and its Tailscale connection.

The browser opens directly to live conversations, with no root History/App navigation or in-app installation destination. Opening a conversation uses the existing identity-fenced phone push/back path. The directory owns top/bottom safe-area insets around its single body scroller. The backend historical catalog remains read-only metadata, not a browser destination or resume operation. Assistant Markdown supports headings, emphasis, lists, fenced code and tables through pinned Marked lexical tokens rendered as React elements. HTML stays inert, images are labelled without fetching, and only explicit HTTP(S) links are active. Transcript thinking, tool calls and results stay absent until **Conversation options → Show activity** is enabled; then individual previews use compact disclosures rather than repeated bordered Sections.

No conversations, credentials, drafts or commands enter Cache Storage or offline queues. The worker passes through APIs and POSTs untouched. Only failed root navigation gets a fixed unavailable page; Try again is a new page navigation, never a command retry. Updates do not force reload or discard an open draft. The current build's exact asset allowlist adds only the manifest, worker and three PNGs; a partially built PWA shell fails host startup. Real runtime assets are held in memory, so publishing still requires a separately authorized Remote-only restart.

`HELM_REMOTE_PROOF_BROWSER=1 node --import tsx --test tests/remote-pwa.test.ts` checks the built shell against an isolated host, Chromium manifest/installability diagnostics, worker activation, offline API failure, unavailable navigation and online recovery without cache entries. Generate the bundle with `node app/scripts/build-remote.mjs` first. This is not physical iPhone/Safari installation, software-keyboard, phone-suspension or Web Push certification. Browser tests in `remote-reading.spec.ts` reproduce the original literal Markdown/border-stack defects and check navigation/draft continuity. Icons are checked in; `node app/scripts/write-remote-icons.mjs` is an optional authoring tool requiring Chromium, not part of normal builds.

## Next slices (not silently dropped from the vision)

1. Live-unconnected discovery, provenance-attested subagents, and bounded historical
   detail pages without a JSONL writer or fabricated resume authority.
2. Separate history pagination and retained bounded replay; slow-client/backpressure
   and long-session memory tests beyond the current 40-message preview. Durable draft
   recovery needs a deliberate privacy/storage policy.
3. Explicit new/resume ownership, model/thinking selection, image input and optional
   profile-bound Item links. These must not be inferred from a PID or a JSONL file.
4. Real phone installation/keyboard/suspension acceptance and Web Push. The installable
   shell and separately approved tailnet deployment do not prove suspended-phone delivery.
   Never Funnel; never expose 7474.

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
