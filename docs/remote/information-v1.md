# Extension information-v1 — wire and browser checkpoint

**Transport and scoped browser UI implemented; no deployment or current-session visibility claim.** The production Pi
bridge consumes `RemoteInformationClient`, negotiates a separate information
transport, and publishes through the private UDS. `RemoteHost` serves authenticated
information GETs. This is isolated wire proof, not installed-exporter or actual
current-conversation visibility. Full subagent fleet remains unsupported/unfinished;
LSP and old-class jobs may be unavailable. Existing live/history/command schemas
and the Working projection remain unchanged.

## Data boundary

The private publish shape is strict:

```text
{version:1, hostEpoch, target, sequence, footer, sidebar}
footer = {availability, fields: named-fields | null}
sidebar = {availability, sections, omittedProviders}
```

`target` is the complete Remote session/incarnation/scope/generation identity.
`sequence` is owner-scoped, nonnegative and safe-integer bounded. Provider IDs,
local session routing fields, callbacks and registration tokens never enter display
information. Footer reserves one section/thirteen entries: cwd **basename only**,
trusted, sessionName, model, thinking, inputTokens, outputTokens, contextTokens,
contextWindow, contextPercent, goalAvailable, goalPhase and omittedStatuses.
`omitted` is separate bounded metadata. Null, false and zero remain distinct.
Unavailable/unsupported clears fields; false goalAvailable cannot carry a phase.
No status maps, raw errors, costs, commands or path fallback are exported.

Sidebar sections retain title80 UTF-16 units, session/process scope, independent
availability, complete/limited/unavailable coverage, label80/value160 rows and
bounded omissions. Malformed sections become unavailable neutral Provider sections
without suppressing safe siblings. Whole-source failure clears all sections.
Limited zero does not mean no work. Unsupported fleet and unavailable providers
never manufacture a healthy complete-empty result.

Projection captures bounded own descriptors once. It never invokes accessors,
enumerates arbitrary objects, serializes producer objects/toJSON, or calls native
render/RPC/collector/branch/file work. Traps are isolated, but synchronous callbacks
are not CPU-sandboxed. Conservative sensitive-label filtering does not establish
complete semantic secrecy for arbitrary authored labels.

## One aggregate budget

- Eight sections/ninety-six entries total; footer reserves one/thirteen.
- Sidebar at most seven sections/eighty-three rows, twenty-four rows per section.
- Complete detached sidebar producer snapshot at most20KiB including local
  routing metadata and JSON escaping. The host independently enforces20KiB on
  stripped sidebar data; it cannot re-prove metadata already removed.
- Entire publish at most31KiB; fixed acknowledgement at most1024 bytes.
- Actual complete browser response at most32KiB, checked before serialization.
- UTF-8 and JSON escaping count. Omission counters saturate at10,000.

Reachable valid producer traffic remains below the defensive31/32KiB ceilings.
The wire test sends the largest accepted Unicode/escaping pressure fixture through
actual UDS and HTTP. Larger sidebar fixtures are adversarial, not valid producer
maxima. A31KiB+ actual UDS body is rejected; actual byte counting also rejects lying
Content-Length through the production request-body seam before parsing. The body
reader stops after two seconds or abort, retains at most the admitted byte budget,
and leaves Node adapter drain/connection cleanup to its existing bounded owner.
It must not cancel the Node request stream before sending a rejection: that can
race the adapter's response write.

## Negotiated wire

The canonical header is **`X-Helm-Information: 1`**. A bridge advertises it on
`/exchange`; the host acknowledges it only to an advertising peer. No new field
enters the strict legacy exchange response. A header-absent old host receives no
information publication; a header-absent old bridge remains unsupported. Support
loss clears host payloads immediately but retains that owner's replay high-water
mark. A support-incarnation token fences off→on changes while a body is pending.

`POST /extension-information` uses the enrollment bearer and existing private UDS,
not the operator token, registration endpoint, daemon or browser command channel.
The host captures the already-live enrollment/session/support before any body
await; after reading it rechecks capability, current owner, support, connectivity,
host epoch and exact target before commit. It cannot register an owner or change
seenAt, snapshots, revisions, activity, commands, receipts or history. Duplicate
and regressing sequences are409 and never renew the information receipt. Sequence
exhaustion never wraps. Replacement/revocation discards payloads with their owner.

The separate publisher is single-flight, at most1Hz, with an absolute two-second
UDS deadline and bounded/complete negotiated acknowledgement. It checks the current
Pi owner before source reads and immediately before sending, and fences late
completion. Support/epoch changes and disposal abort the publication. The live
exchange never awaits it. Failures never retry commands or affect Pi activity.

Browser GET:

```text
GET /v1/sessions/:sessionId/information
  ?hostEpoch=<uuid>&incarnation=<uuid>&scopeId=<scope-or-empty>&generation=<integer>
X-Helm-Information: 1

{version:1, hostEpoch, target, status, freshForMs, information: envelope | null}
```

The route uses existing device-cookie authentication (or explicit development
bearer), Origin/Host guards, principal grant-revision and read-scope projection.
Authentication refusal is401; missing/unauthorized session is404; stale complete
target/epoch is409. None is recast as unsupported. Only a current authorized target
can return unsupported. With supported transport, a fresh received envelope is
available even when its individual sources are unavailable/unsupported; those
independent source states remain explicit. No receipt or disconnected owner means
unavailable. GET is synchronous after middleware and rechecks current principal
before disclosure; it introduces no unfenced route await.

Freshness is five seconds from **information receipt**, independent of seenAt.
Available requires positive host-derived remaining TTL and matching inner/outer
complete identity. Others return null information and zero freshness. Expiry
releases payloads on read, retaining bounded replay evidence. The browser anchors expiry at **monotonic request start + remaining freshness**, never response
receipt + five seconds or an unsynchronized wall-clock comparison.

## Pi lifecycle and source admission

`RemoteInformationClient(pi.events, capturedSessionId, pureGuard)` subscribes once
to each ready channel before emitting exact frozen version/session requests.
Its `read()` returns detached safe footer/sidebar or permanently retired null.
It calls captured producer functions detached, never with internal state as `this`.

The bridge keeps ONE client per Pi observation across discovery, HTTP failures,
disconnection and re-enrollment. Manual transport admission does not reset source
replay/retirement evidence. Before native switch/fork/tree and shutdown it disposes
synchronously. Only session_start or the existing matched successful session_tree
settlement creates a replacement; idle/timers/manual input never settle ambiguous
navigation. Synchronous discovery callbacks also cannot reopen a navigation fence
while client construction is returning. Pi0.85.1 public extension/session docs are
the lifecycle authority; no new session-file/process owner exists.

First source admission retains sequence and canonical detached content signature.
Same-sequence unchanged and advancing-sequence unchanged content are allowed.
Regression/content conflict fences that source. Malformed/throwing reads clear
display but retain replay evidence; only exact null proves disposal. Same-ID getter
substitution or competing valid live sources latches ambiguity, not arrival-order
election. At most64 retired IDs per source prevent resurrection; exhaustion fails
closed. Reentrancy, guard loss and late callbacks remain fenced. Footer/sidebar
failures are independent; missing exporters are unsupported, observed failed
exporters unavailable.

## Proof and remaining work

- `remote-information-protocol.test.ts`: schemas, privacy projections, detached
  data, semantic/byte/row limits and complete response identity.
- `remote-information-client.test.ts`: source admission/replay/retirement,
  descriptor safety, reentrancy, ambiguity, disposal and source isolation.
- `remote-information-transport.test.ts`: actual isolated loopback HTTP/private
  UDS/auth/negotiation, receipt expiry/replay, replacement/support races, actual
  encoded response pressure and ACK limits; production bridge lifecycle/client,
  old-host compatibility and reconnect retention. Delayed body races use controlled
  Request streams through the same production host; they are not all socket races.
  Producer contexts are public test doubles, not installed/live exporters.
- Existing history transport and bridge lifecycle suites remain regression gates.
  The full bridge and questionnaire fork are typechecked against selected Pi0.85.1.

## Scoped browser presentation

`transport.ts` reads the real negotiated GET with an absolute two-second deadline,
counts actual UTF-8 bytes before JSON parsing (32KiB), and validates the canonical
schema plus the requested complete owner. Missing acknowledgement, malformed data,
404/409 and network failures remain unavailable, never proven unsupported.
`information-controller.ts` owns one selected-owner read, self-rescheduled two
seconds after settlement, capped at 1Hz even across visibility changes. Its separate
expiry timer clears visible bytes during a stalled next read. Hidden documents,
authority loss, transport/owner replacement and disposal abort/fence reads; 401/403
permanently retire that reader. Semantic equality excludes sequence/TTL, without
extending deadlines or updating transcript/liveness/history state.

`RemoteInformation.tsx` shows a persistent 320px rail at viewport widths >=1200.
Below that boundary, Info mounts one reading view inside the existing reading
area; closing unmounts its data DOM while the composing textarea stays mounted.
Back/Escape restores Info focus; browser Back closes Info before leaving the
conversation. A question covered by mobile Info replaces Submit answers with a
local-only Back to conversation action; the synchronous answer-dispatch guard
also rejects stale hidden-question callbacks. Previously admitted operations keep
their receipt lifecycle. The actual question heading returns on Back rather than
competing with Info inside the96px reading floor. Desktop rail keeps ordinary
visible-question submission. Existing history range, answer drafts and prompt drafts stay owned
by their original identity. A 20px ellipsized footer supplies quiet practical
context; all safe footer fields remain in the information view. Sections render
literal transported row labels/primitive values, explicit process-wide scope,
availability, limited coverage and positive omissions. False/zero/null remain
distinct; false goal availability never becomes 'No active goal'. Full fleet is
explicitly unsupported and unfinished, not an empty healthy panel.

`remote-information-browser.test.ts` exercises the production decoder/controller;
the wire suite additionally composes that decoder with the isolated actual HTTP
host and UDS publication. `remote-information.spec.ts` uses real Storybook
components plus fixture-only HTTP interception for browser delivery/expiry, four
viewport widths, compact keyboard-height geometry, simulated safe areas, focus,
drafts/IME, questions, replacement and semantic dedup. These are fixture proofs,
not installed/current-session exporters, physical iPhone/Safari certification, or
the original full Profiler benchmark. The parent owns cumulative/history/performance
and current-session acceptance. No local storage, native sampling, deployment,
live service/Pi reload, or current-conversation rollout is included.
