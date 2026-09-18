# Subagent activity v1

Helm Remote exposes an optional, negotiated boolean projection of activity observed in the current Pi session. Coverage is deliberately limited to the producer's observed foreground and built-in asynchronous work; retained or separate external work may be omitted. `available` values carry `active: true|false`; unsupported and unavailable values carry no positive claim.

The bridge retains one client for the Pi observation lifecycle, across enrollment and exchange reconnects. Genuine lifecycle replacement or shutdown retires it. Source capabilities are captured from own data descriptors only, invoked detached, fenced against reentrancy/navigation, and bound to UUID session/provider identities. Retired providers are bounded to sixteen IDs; malformed or conflicting sources remain unavailable.

Exchange support is opt-in and acknowledged by `X-Helm-Subagent-Activity: 1`. The bridge emits the field only after acknowledgement in the current host epoch. Browser directory/detail reads independently opt in; legacy reads omit both activity and freshness fields. Host freshness is a bounded remaining lease and GET does not renew liveness. Browser freshness binds host epoch, complete target, revision, activity, and request-start deadline; it does not borrow directory evidence for detail.

This is an in-memory observation and display projection, not process/work-group accounting, authorization, command admission, completion proof, or deployment/installation evidence.

Only connected `available` evidence (both true and false) receives a host TTL. Unsupported, unavailable and absent evidence never owns a lease. The browser retains bounded per-owner revision high-water independently of leases: a higher missing/unavailable/aged response still rejects older replay; same-revision recovery must match any prior available signature. Duplicate owners clear effective evidence. Expiry and replacement publish atomically; TTL-only renewal does not publish a freshness-store change.

Receipt-backed polling retires on hide and fences pre-hide results, old errors and reentrant acceptance callbacks. Ordinary no-receipt polling retains its existing hidden-page behavior. Native browser timer functions are called through arrow wrappers. Source status never authorizes Stop, Send or answers. The opt-in Subagents story is fixture evidence, not an installed exporter or physical-phone certification; the default performance fixture remains unchanged.

Freshness replacement must publish expired-to-fresh recovery even for equal revision/activity when an overdue timer was suspended and an unrelated render already resolved unavailable. Still-fresh TTL-only renewal remains publication-free; expiry/replacement is one transaction.
