# Signals: Slack

Jakub, 2026-11-10 (via the dispatcher): Slack support in Signals, and the dispatcher agent able to
write to Slack through a CLI, **without creating a Slack app** — reuse the session the Slack desktop app
(`/Applications/Slack.app`) already holds, the same web-client session the app itself uses. No MCP.

Two parts:

1. **Slack as a fourth Signals source** (`slack`, next to `github`, `mail`, `agent`): one row per DM,
   group DM or thread where Jakub is the one who has to move.
2. **`helm slack`**: a CLI that sends to Slack and reads what an agent needs (resolve a user, read a DM or
   thread), straight to Slack's Web API with the reused session.

Workspace found on this Mac (Slack.app LevelDB, names only): **Contember** (`cntmbr`, `T054TV1LULE`).

## Reusing the Slack desktop session (no app, no manifest)

The Slack web/desktop client authenticates every Web API call with a **session token** (`xoxc-…`) plus a
**`d` cookie** (`xoxd-…`). Both live in Slack.app's own storage on this Mac. Helm reads them once, at
runtime, with Jakub's macOS consent, and keeps a copy in Helm's own Keychain.

- **Token (`xoxc-`) — per workspace.** In Slack.app's Local Storage LevelDB
  (`~/Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/Local Storage/leveldb`),
  under the `localConfig_v2` value: a JSON `teams` map, each team carrying `token`, `name`, `domain`,
  `user_id`. The big value spans LevelDB blocks (framing bytes are interleaved), and the `"token":"` key
  can land in a different block from its `xoxc-` value, so a raw byte-scan is unreliable and brittle
  against Slack updates. Helm uses a **small read-only LevelDB reader** (`src/slack/leveldb/`: MANIFEST +
  `.ldb` SSTable block decode + Snappy + `.log` replay) to get clean key→value pairs, parses the
  `localConfig_v2` JSON, and reads `teams[*].token`. The data files read fine while Slack runs (`LOCK` is
  an advisory lock on a separate file); Helm copies the dir to a private temp dir first so it never sees a
  half-written file, reads, then deletes the copy.
- **Cookie (`d` = `xoxd-`).** Slack.app's Chromium cookie store (`…/Slack/Cookies`, SQLite) holds the `d`
  cookie as `encrypted_value` (prefix `v10`). Decrypt with Chromium's macOS scheme: Keychain password
  `security find-generic-password -w -s "Slack Safe Storage"` (service present; account `Slack App Store
  Key`) → `PBKDF2-HMAC-SHA1(pw, "saltysalt", 1003, 16)` → AES-128-CBC, IV = 16×0x20; strip PKCS7 padding
  and, when present, the 32-byte SHA256(domain) prefix newer Chromium prepends. **Reading that Keychain
  password is the macOS consent prompt — Jakub approves it; Helm never bypasses or suppresses it.** The
  cookie SQLite is read with the project's existing `better-sqlite3` (copied to temp, opened read-only).

- **`helm slack connect`** does both reads once, verifies with `auth.test` per workspace, and stores the
  result in **Helm's own Keychain** (service `helm.slack`, one account per team id, value = JSON
  `{token, cookie, team, domain, userId}`; and `helm.slack.index` listing the connected team ids). The
  daemon and the CLI read from there, not from Slack.app. On `invalid_auth`/`token_revoked` Helm re-reads
  Slack.app (the user rotated or re-signed in) and refreshes its item; if Slack.app is signed out, the
  source goes `needs_permission` (`run helm slack connect`).

- **Secrets never leave memory or the Keychain.** No token or cookie is ever printed, logged, put on an
  argv, written to config/DB/a file, placed in an IPC payload, or in an error string or test fixture.
  `connect`/`status` print only team name, user name, and ok/error. Tests use crafted fixtures and a fake
  Slack server; no fixture contains a real credential.

- **Slack base URL** `https://slack.com/api/`. The loopback override is a **test-only explicit `apiUrl`
  option** (never read from the process environment — an agent-controlled env must not be able to redirect
  the token to a loopback server it binds); a token is never sent to any non-slack.com host. Calls are
  form POSTs: `token` in the body, `Cookie: d=<xoxd>`, a browser-like `User-Agent`, no Helm or Jakub
  identity in headers.

### Security boundary (same-uid trust)

Helm already trusts same-uid local processes to a degree: its local control token lives in an
owner-readable `~/.helm/local-api-token`. Slack inherits that boundary and does not widen it:

- Helm's stored Slack session (Keychain service `helm.slack`) is created non-interactively so the headless
  daemon can poll without a GUI prompt. A consequence is that **any same-uid process can read it** with
  `security find-generic-password -s helm.slack -a <acct> -w` — there is no code-signed ACL for an
  unpackaged dev build. So the Keychain protects the secrets from being written to logs/files/argv, **not**
  from a hostile process running as Jakub's own user. A hostile same-uid agent can therefore obtain the
  `xoxc`/`xoxd` session and talk to Slack directly, bypassing every CLI guard.
- Consequently the `helm slack send` self-only guard and the Helm-only write routes are a **safety rail**
  (against naive/accidental agent misuse, and against the daemon/renderer being tricked) — not a hard
  boundary against a hostile same-uid agent, who could skip the CLI entirely. `HELM_SLACK_SEND_SELF_ONLY=1`
  is the hard self-only guard for the supervised live test.
- The CLI reads the send allowlist from the fixed default loopback daemon over an unauthenticated GET; a
  port-squatter answering `:7474` while the real daemon is down could serve a permissive list. This adds
  nothing beyond the same-uid capability above (such an agent already has the token), so it is accepted
  rather than papered over with request auth that cannot verify the responder.

- **Risks (report to Jakub).** This is undocumented, unofficial use of the web-client session: Slack may
  change the storage format or the API, or flag automated use (ToS). Helm keeps the footprint small
  (modest polling, honour `Retry-After`/`ratelimited`, no bursts) and fails gracefully to a Signals health
  row rather than hammering. A Slack update can break token/cookie reading; the health row says so.

### Multiple workspaces

`connect` lists every signed-in workspace (names only) and stores each. `signals.slack.teams` (Settings,
one team id or domain per line; empty = all connected) chooses which the Signals source covers. The CLI
`--team <id|domain>` selects one; default = the only connected team, else required.

## "Needs you" rules

Only foreign, human activity counts, after Jakub's own latest message and after his read marker. Low
noise like Mail/GitHub: no bots (`bot_id`/`subtype:bot_message`/Slackbot) unless included, no muted
conversations, no join/leave/topic/channel-event subtypes, no `@here`/`@channel`/user-group pings.

| Row | Kind (glyph) | Shown while | Thread key |
|---|---|---|---|
| DM, group DM | `dm` (`@`, warn) | latest msg is foreign, newer than `last_read`, within `maxAgeDays` | `slack:<team>:<channel>` |
| @mention of Jakub in a channel/thread | `mention` (`»`, accent) | the mention is unread and newer than his latest message there | `slack:<team>:<channel>:<thread_ts>` |
| Thread Jakub is in (`subscribed`, or he wrote in it) with new replies | `thread` (`○`, accent) | latest foreign reply newer than his last message in it and than `last_read` | `slack:<team>:<channel>:<thread_ts>` |

A thread can carry both `mention` and `thread`. Activity key = latest counted foreign message ts;
`lastActivityAt` = its time. Jakub's own replies/reactions/edits never re-notify.

**Auto-close.** A row that stops qualifying (read/answered in Slack, older than the window) is missing
from the next complete polls and closes after two misses, reason `read or answered in Slack`. `r` from
Helm closes it at once (`answered in Slack`). Managed threads never auto-close.

## Polling design (no events)

One `SignalReader` (`src/signals/slack-source.ts`), default 60 s, single-flight like the others, one
pass per enabled workspace. The web-client client (`src/slack/web-api.ts`) keeps per-method `blockedUntil`
from `Retry-After`/`ratelimited`; blocked calls are skipped and the poll is incomplete;
`invalid_auth`/`token_revoked`/`account_inactive` → `needs_permission`; `missing_scope` is not expected
(web-client session has full user scope) but is surfaced; network → `unavailable`. Not connected →
`disabled` (`Not connected (helm slack connect)`).

Per poll, bounded (each method keeps a budget well under Tier 3 ~50/min):

1. `auth.test` (cached 1 h; re-run after an auth error) → team, Jakub's user id.
2. `users.conversations types=im,mpim exclude_archived` (≤10×200), cached 10 min → the DM directory.
3. **DMs**: `conversations.info` for ≤30 convs/poll, ordered: DMs with a non-done Slack row; DMs active in
   the last 30 d; the rest round-robin. `latest`, `last_read`, `unread_count_display` decide "needs you".
4. **Candidates**: `search.messages query="<@ME> after:<date>"` (mentions) and
   `query="from:<@ME> is:thread after:<date>"` (threads Jakub wrote in), `sort=timestamp`, ≤50 each.
5. **Threads**: `conversations.replies` for ≤15 threads/poll (non-done rows, then mention hits, then
   Jakub's own, newest first; ≤5×200). Parent `subscribed`/`last_read` decide follows/read.
6. Names: `users.info` cached 24 h (bounded); channel names from `conversations.info`, cached.

`complete` only when every non-done Slack row was checked and no list/search/replies call failed or was
rate-limited, so a row never closes because it was skipped. Unchecked DMs are latency, not loss.

Text: Slack mrkdwn → plain one-line text (`<@U…>`→`@name`, `<#C…|x>`→`#x`, `<url|label>`→`label`, entities
decoded), control/bidi stripped, bounded; links stay text. **No body in the DB for Slack rows** (heads
only, like Mail); `head` = the latest counted message, one line.

Open (`o`): the message's https permalink
`https://<domain>.slack.com/archives/<C>/p<ts>[?thread_ts=…&cid=…]`; main's opener accepts exactly
`https://<sub>.slack.com/archives/…` besides GitHub and Mail.

## Keys

- `r` reply → `POST /api/signals/:id/slack-reply {text}` (Helm only: local control token) →
  `chat.postMessage` in that DM or thread (`thread_ts`); text escaped (`& < >`), ≤4000. Row closes
  `answered in Slack`. Reply flow UI: heads only (see **Reply flow** below).
- `x` mute sender → latest sender's user id onto `signals.slack.excludeUsers`; Jakub's open Slack rows
  whose latest sender is that user close (`sender muted`) and list as filtered `excluded`.
- `i` on a filtered Slack entry → unmute (drop from `excludeUsers`) or, for a bot, add to `includeUsers`.
  Filtered reasons gain `bot`.
- `p`/`n` send/new agent: prompt fences Slack heads in `<external source="slack">` and tells the agent to
  read the thread with `helm slack read --signal <id>`.
- `m`, `s`, `d`, `t`, `o` as for every thread.

## CLI (`src/cli/slack.ts`, direct to Slack, never the DB)

```
helm slack connect [--json]          read Slack.app's session (Keychain consent), store in Helm's Keychain
helm slack disconnect [--team T]     remove Helm's stored session (one team or all)
helm slack status [--json]           connected workspaces, user, token presence (never the token)
helm slack user <@handle|U…|email|name> [--team T] [--json]
helm slack read <target> [--thread TS | --signal ID] [--limit N] [--team T] [--json]
       target: #channel | C…/G…/D… | @handle | U… | email | a Slack message link
helm slack send --to <target> (--text T | --text-file F|-) [--thread TS | --signal ID] [--team T] [--json]
```

Every message read prints as untrusted third-party text. `send` refuses any target but Jakub himself
unless `signals.slack.agentSendTo` (Settings; one per line: `@handle`, user/channel id, `#channel`, `*`)
allows it; the CLI reads that from the daemon's dashboard-safe config, and with the daemon down only `me`
is allowed. `HELM_SLACK_SEND_SELF_ONLY=1` is a hard guard (dev/live): only Jakub's own self-DM. Note: a
message sent with Jakub's own token to himself lands in his "You" DM and Slack won't notify him
(self-messages); notifying him via Slack would need a bot token (out of scope).

## Storage

- Session: Helm Keychain only (`helm.slack` / `helm.slack.index`). Poll state (directory, names,
  round-robin, `blockedUntil`): memory only.
- Rows: `signal_threads` `source='slack'`; `sender`/`sender_address` hold the latest sender's Slack user
  id (for `x`). Filtered: `signal_filtered` `source='slack'`, `message_key='slack:<channel>:<ts>'`,
  `sender_identity=<user id>`.
- **Migration 44** (latest on main is 43): rebuild `signal_threads` and `signal_filtered` to widen the
  `source` CHECKs to include `slack`, keeping ids, AUTOINCREMENT marks and every column.
- Config: `signals.slack { enabled(true), pollSeconds(60,≥30), maxAgeDays(7,1–60), mentions(true),
  threads(true), teams(''), includeUsers(''), excludeUsers(''), agentSendTo('') }`.
- **Protocol 64 → 65** (new source, kinds, filtered source/reason, reply route).

## Reply flow (resolved)

The reply flow (`r`) is **heads only** (Jakub's pick, 2026-11-11, reviewed on the port-6152 preview):
the flow header (`↩ Reply to <ref>` + the thread title), the latest line, and the answer field; ⌘↵
posts to Slack and closes the thread, Esc goes back. The alternative excerpt / live-thread layouts were
dropped. Story: **Views / Signals / Slack** (`Reply`).

## Slices

0. Session reading: `src/slack/leveldb/` (read-only reader), `src/slack/cookies.ts` (Chromium decrypt via
   better-sqlite3 + Keychain), `src/slack/session.ts` (`readSlackAppSession`), Helm Keychain store
   (`src/slack/keychain.ts`). Pure parsers with fixtures; Keychain/FS seams injected.
1. Web API client (`src/slack/web-api.ts`): form POST, rate limits, errors, loopback-only override; fake
   Slack server for tests.
2. Contract, migration 44, store (slack source, filtered source, reply-closing), config + Settings,
   watcher loop, protocol bump.
3. Pure Slack → Signals mapping (DMs, mentions, threads, mrkdwn→plain) with fixtures; the reader.
4. Routes: slack reply, mute/include for Slack.
5. `helm slack` CLI (connect/disconnect/status/user/read/send).
6. Desktop: main (reply IPC, opener), renderer rows/actions/prompts, Slack reply flow (heads only), stories.
7. Docs (AGENTS.md, design-system §3.25), adversarial review, checks, live test (two self-DM messages).

## Live testing

`helm slack connect` triggers Jakub's Keychain prompt — tell the dispatcher just before. The only live
send allowed is one or two short messages to Jakub's own DM (e.g. `Helm Slack test ✓`), guarded by
`HELM_SLACK_SEND_SELF_ONLY=1`.
