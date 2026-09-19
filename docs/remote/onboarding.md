# Remote onboarding and everyday startup

Status: implementation in progress after the verified development slice (`9c577eb`).

## Confirmed operator decisions

- Work in the canonical Helm checkout on `feat/helm-remote`; no new worktrees.
- `app/bun run start` launches only the desktop. `remote/bun run start` launches
  only Remote. Root `bun run start` launches both. Retain the daemon entry as
  `bun run start:daemon`; launchd's existing direct Node entry is unchanged.
- Normal desktop exit does not stop Remote. The owning foreground start terminal
  stays active; Ctrl+C stops its owned runtime(s). No process discovery/kill or Pi
  process ownership.
- The operator later approved a user-level launch agent, `com.helm.remote`, so
  Remote survives a crash, a logout and a reboot instead of living only as long as
  whoever started it. It runs `dist/remote/runtime.js` with `KeepAlive`, logging to
  `~/Library/Logs/helm/remote.*.log`. Uninstall with `launchctl bootout
  gui/$(id -u)/com.helm.remote` and remove the plist.
- Supervision alone was not enough: a killed runtime left its lock and sockets
  behind and every relaunch then failed. The runtime now reclaims those artifacts
  on startup, but only once and only when both sockets refuse a connection and the
  files are owner-owned `0600`. A live runtime always wins, and reclaimed artifacts
  are preserved under `recovery-<stamp>-reclaimed/` rather than deleted.
- Replace manual long-token copying with one-time QR / `XXX-XXX` pairing and
  durable per-device authentication when served over HTTPS.
- Show all known Pi conversations from the operator's enabled session roots,
  including historical/unconnected records. Files never establish live authority.
- The user approved backed-up global bridge + questionnaire-fork configuration
  **after implementation and verification**. Preserve all unrelated resources and
  installed package bytes. Never load both questionnaire implementations.
- New ordinary Pi TUIs should connect automatically. Existing processes without
  the bridge need an operator-led idle `/reload`; no injection/restart workaround.
- Tailscale is installed on Mac and phone. Serve/ACL/Funnel changes and actual
  network deployment still require approval of the exact configuration.

## Seams and decisions

1. **Startup:** a small CLI launcher owns only its new Remote and Electron child
   handles. Readiness precedes desktop launch; startup failure cleans up its own
   host. Normal exit/failure of either runtime does not kill the other. No forced
   Electron shutdown. The independent runtime must reuse/refuse one attested
   per-user host, never silently replace a running incompatible instance.
2. **Access:** separate local operator control, browser device credentials, and
   Pi registration authority. Pending pairing is memory-only, expires after 120s,
   and admits five failed attempts total. Six random Crockford-base32 symbols and
   a separate 32-byte QR capability redeem the same single-use challenge; either
   burns both before any persistence await. No automatic regeneration on failure.
   Device records store hashes, identity, expiry, explicit personal-session grant
   (including future enrolled sessions), and revocation in an owner-private atomic
   document. The pairing presentation states this access clearly.
3. **Cookies and transport:** production pairing issues Secure/HttpOnly/SameSite
   Strict host-only cookies on the explicitly configured HTTPS origin. Preserve
   exact Host/Origin, JSON/custom-header/Fetch-Metadata guards, bounded bodies and
   per-device plus global budgets. No credentials in URLs/logs/localStorage. The
   deliberate exception is a one-time QR fragment, removed before requests. Plain
   loopback HTTP is explicitly a development mode with ephemeral auth, not a
   downgrade of persistent HTTPS credentials. Keep `development.ts` as the isolated
   proof fixture; add a distinct everyday runtime.
4. **Revocation:** attribute command reservations and receipts to the authenticated
   device. Recheck authority before delivery. Revoke stops undelivered work and
   future delivery; already-delivered ambiguity is unknown, never recalled or
   reported cancelled. Other devices and Pi processes remain alive.
5. **Catalog:** keep `RemoteHost` a filesystem-free domain component. A separate,
   consent-bound read-only adapter in the runtime may inventory the configured Pi
   session roots even with no Pi process running. This is deliberate: requiring a
   running Pi to list historical files would defeat the requested directory. The
   user explicitly requested all personal Pi conversations, not native profile
   inference; cwd labels never grant a profile. Do not call `SessionManager.open`
   (may migrate files) or `listAll` (reads full transcripts). Scan incrementally with
   no-follow/regular-file/root checks, byte/line/concurrency limits, cached metadata,
   and paginated responses. No file path crosses the browser contract. Historical
   rows have no fabricated live target; current liveness is unknown. The catalog
   advances on bounded attempted directory-entry/file slices (invalid files count),
   refreshes periodically and drains on runtime stop. It retains only bounded cache
   and identity metadata, derives labels from Pi `session_info` entries, suppresses
   an authorized live UUID overlay internally, and reports partial scans/stale cursors.
   A bounded historical preview must disclose branch/window limitations and stay read-only.
6. **Automatic bridge:** begin only at `session_start`, close admission before
   switch/fork/tree/shutdown, and rebind to the new context. The bridge discovers
   only an owner-private, registration-only descriptor and obtains a fresh,
   short-lived per-context grant over the private control socket; it never reads
   the operator token and no `HELM_REMOTE_AUTO_ENROLLMENT` file or manual command
   is part of ordinary startup. Host absence uses bounded retry, while a restarted
   host requires a fresh grant and never replays old work. Private registration
   uses fresh grants/incarnations and host epochs; no queued command transfer or
   automatic replay. An explicitly disconnected extension stays disabled. An
   observed native navigation remains paused until genuine fresh lifecycle evidence;
   retry, idle time, unchanged identity, or manual enrollment cannot clear that
   fence, and ambiguous overlapping navigation remains paused. Respect explicit
   extension opt-outs and child/non-TUI control restrictions. Same-user processes
   are not a hostile-user isolation boundary.
7. **Installation:** a tested, bounded, backed-up, concurrency-aware settings
   transaction changes only relevant resource selection. Keep the upstream package
   installed but not loaded; enable the repo-owned fork and bridge. Preserve other
   extensions and do not install through package dependency symlinks. The actual
   operator settings path is an intentional symlink into the separate `pi-config`
   repository. Preserve that link: operator installation must attest the link and
   canonical owner-owned target, coordinate with Pi's settings writer, back up the
   target and refuse a concurrent pointer/target change. This narrow operator
   exception does not relax no-follow rules for Remote credentials or catalog
   inputs. Parent performs the actual approved configuration change only after
   all gates pass; never commit or reset the separate configuration repository.

## Pass A authority evidence (runtime and installer)

Pass A covers only durable authority, runtime singleton ownership, installer coordination,
and launcher completion shape. Its focused disposable tests exercise: bounded owner-private
ledger reads (including FIFO rejection), count and serialized-byte admission limits across
reload, in-memory revocation fencing plus durable retry, three authenticated polling devices
under unauthenticated spam, configuration-attested singleton reuse, bad-ledger/missing-asset
retry cleanup, competing first-start processes, real `proper-lockfile` contention against the
Pi settings pointer, real `npm:`/versioned/object questionnaire selection, and reused-host
launcher completion. These tests do **not** establish automatic bridge enrollment, catalog
continuation, rendered pairing/QR behavior, browser TLS-cookie behavior, or actual Pi/Electron
or network rollout; those remain Pass B/rollout gates.

The Pi installer coordinates with Pi's `proper-lockfile.lockSync(settingsPointer,
{ realpath: false })` protocol at every prepare/read/backup/apply/rollback boundary. It permits
one attested logical settings symlink only when its resolved target is a canonical, owner-owned,
regular file; intermediate target links are refused. It removes only the upstream/fork
questionnaire resource identities (`npm:` and versioned/object forms included), preserving
unrelated settings resources.

## Open Pi API limitation

Source inspection of the selected Pi 0.85.1 found no public observer settlement event
for cancelled, aborted or failed navigation. Successful replacement invalidates the
old extension/API; tree navigation mutates the same session manager. Reconnection
must not infer completion from a timer, idle state or unchanged identity. A prompt
already dispatched through the void API can also remain in asynchronous preflight
while tree navigation changes the branch. These findings limit claims of Pi-side
atomic effect admission; they do **not** establish that in-process browser control
is infeasible (the original two-TUI proof already demonstrates that). The user rejected
a premature choice between modifying Pi and reducing Remote to read-only. Compare the
actual in-process Web Pi implementation and distinguish required wrong-session/profile
rejection from stronger post-dispatch branch semantics before expanding scope. Neither
a read-only downgrade nor a Pi modification is approved. No installed Pi code has been
patched; ordinary rollout verification gates still apply.

Implementation decision: continue the existing in-process architecture. Treat unresolved
native navigation as a per-enrollment compatibility limitation, not a blanket release
blocker. Keep eligibility separate from connectivity: operator-disabled, navigation-fenced,
eligible/retrying, connected and disposed. Fresh network registration cannot clear a
navigation fence; only supported fresh lifecycle evidence can. Ambiguous overlapping
navigation stays fenced. Browser directory selection does not navigate Pi and remains
unaffected, as do other connected owners. Revalidate the guarded live owner and admission
token synchronously immediately before invoking Pi; report invocation as `dispatched`,
never as Pi-side branch-pinned acceptance. Do not migrate or replay old commands. Tests
must prove this scoped behavior, not claim seamless cancelled-navigation recovery.

Parent regressions additionally cover failed pairing after an unpersisted revocation
and admission that would leave insufficient byte capacity to revoke existing devices.
These cases failed before the corrections; they are separate from the worker's original
13-test report. Failed pairing must retain in-memory revocations, and admission must
reserve space for their persisted timestamps/revision changes.

## Acceptance gates

- Launcher tests use disposable stand-ins, never a second real branded desktop.
  Prove desktop-only/Remote-only/combined entry semantics, readiness/failure,
  normal desktop quit with Remote alive, cancellation and owned cleanup.
- Pairing: expiry, guess exhaustion, concurrent code/QR redemption, persistence
  failure, durable device/revocation reload, cookie attributes, origin/CSRF denial,
  no secret logs/referrers, per-device receipt isolation, revoke before/after delivery.
- Catalog: more than 16 records, explicit partial scans/pagination, malformed/huge/
  linked/appending files, no canonical writes, no path leakage, no live controls
  from file discovery, correct live overlay and replacement identity fencing.
- Automatic bridge: host absent/present/restarted, Pi startup/reload/context change,
  no duplicate questionnaire, no parent/child authority confusion, no replay.
- Browser: real components and Storybook stories for code/QR/access-ended/catalog
  states, mobile and desktop behavior, existing draft/anchor/unknown receipt tests.
  The actual built entry needs isolated TLS browser coverage for QR/code redemption,
  fragment scrubbing, reload-persistent Secure cookie, expiry-to-fresh-code and
  revoked-device Pair again; a self-signed test terminator changes no OS trust.
- Repeat isolated actual two-TUI plus rendered-browser proof, full fork/bridge
  typecheck against selected Pi 0.85.1, lint/build and relevant broad regressions.
- Inspect/read-only Tailscale configuration before proposing any actual change.
  Local TLS tests are not evidence of phone reachability or actual suspension.

Advisory inputs: `/tmp/helm-remote-next-pi-design.md` and
`/tmp/helm-remote-next-pairing-design.md`. Recommendations were reconciled above:
foreground lifetime follows the user's explicit choice; catalog IO stays outside
pure RemoteHost and does not require a running Pi; personal-all visibility is an
explicit user request, not an inferred native profile grant.
