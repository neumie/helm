# ADR-0002: Desktop profile activation is a committed daemon transaction

## Status

Accepted

## Decision

Helm profile activation keeps the existing BrowserWindow and its dtach masters.
The daemon profile document (`activeProfileId` plus `generation`) is the
activation authority. The desktop app treats the activation HTTP response as
non-authoritative until a coherent status/items/profiles observation confirms
that document.

An Electron-free `ProfileSwitchCoordinator` owns one operation at a time.
Before activation it obtains the Slice 3A Run Context drain, flushes buffers,
starts an epoch-owned bridge fence, and advances the local renderer token.
Only an activation error followed by an observation of the operation's exact
old `{ profileId, generation }` may restore that local token. Target, changed
old-generation, or third-profile observations reconcile forward.

An inconclusive observation remains fenced. A same-target request coalesces;
a profile-qualified deep link waits. Only an explicit later menu/Settings
request can supersede an unknown operation with a fresh epoch.

After a forward observation, terminal/session/buffer IPC remains closed until
the target namespace is installed. Detaching PTY clients deliberately preserves
dtach masters. Namespace installation and renderer reload retry forward while
closed; cache persistence, registry flush, menu rebuilding, and immediate Item
delivery are best effort. Item delivery is epoch-qualified and remains queued
until its matching renderer can accept it.

## Consequences

A daemon outage can leave Helm visibly fenced rather than guessing that the
old profile is safe. This is intentional: it prevents stale renderers and
session paths from crossing tenant boundaries. Switching neither quits nor
relaunches Helm and never kills a dtach master.
