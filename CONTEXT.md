# Context

Project vocabulary for naming seams. Architecture terms (Module, Interface, Depth,
Seam, Adapter, Leverage, Locality) follow the codebase-improve skill's LANGUAGE.md.

## Domain terms

**Task** — a unit of work discovered from an external source (via a `TaskProvider`)
and driven through the pipeline `poll → solve → tier → dispatch`.

**Tier** — the solver's verdict on a finished task (`trivial | simple | complex |
unclear`). Routes the dispatch action.

**Solver** — the seam over code-execution backends (`DefaultSolver` spawns the
`claude` CLI; `OkenaSolver` drives a local Okena terminal). Two adapters → a real seam.

**Provider** — the seam over external task sources (`ContemberProvider` today).

## Deepened modules (this initiative)

**SolverResult** — the structured outcome the agent writes to `solver-result.json`
(tier, confidence, summary, filesChanged, prReady, prUrl, …). Single source of truth
is its Zod schema; the TS type is `z.infer` of it and the prompt's JSON contract must
match. Read from the result file only — there is no stdout fallback.

**PlanWorkspace** — the deep module owning the on-disk `docs/plans/<planDirName>/`
layout: the paths and IO for `context.md`, `.planning-prompt.txt`,
`solver-result.json`, and `README.md`, plus the *relative* result path the solver
prompt references. One owner so the prompt template, the result parser, and the okena
poll path can never disagree about where files live. Concerns on-disk layout only.

**Task workspace identity** (`resolveTaskWorkspace`) — resolves a task *row* to its
`{ planDirName, branchName, existingWorktreePath }`, computing+persisting defaults.
A DB-identity axis distinct from `PlanWorkspace` (on-disk layout); used by both the
worker and the `/plan` endpoint so the two entry points can't drift.

**Solve outcome** — the solver-owned timeline returned from `solve()`:
`{ events, exitCode, rawOutput? }`. Each adapter produces its own `events`
(`DefaultSolver` parses CLI output; `OkenaSolver` returns none today). The worker
persists what it's given rather than parsing solver-specific stdout — keeps
default-solver output shape out of the shared `Solver` interface.

**ChatLinks** (`src/chat/links.ts`) — the deep module owning chat-link identity:
where a clarification session lives on the wire and how it's addressed. Two
invariants concentrate here so no call site can get them wrong: (1) lazy `baseUrl`
resolution at call time, honoring the runtime tunnel mutation; (2) public URLs
address a session by its signed `token`, never the DB `id`. The single
construction site for `signToken(randomUUID(), …)` + `createChatSession`. Both the
MCP chat tools and the dashboard API route through it; previously the
`baseUrl ?? localhost` + `${baseUrl}/chat/${token}` derivation was copied across
four sites.

**ClarificationChat** (`src/chat/clarification.ts`) — the deep module owning the
clarification-chat *orchestration* (distinct from `ChatLinks`, which owns only
link identity). Three intention-revealing methods — `createInvite` (session create
+ provider comment + webhook), `sendAndAwaitReply` (the 24h block-and-poll wait
loop, returning a `ReplyOutcome` discriminated union), `end` (complete + assemble
transcript). Previously all of this was inlined inside the `vigil_create_chat` /
`vigil_send_message` / `vigil_end_chat` MCP tool closures in `src/mcp/server.ts`,
untestable without an MCP transport; the tools are now a thin adapter that only
translates args ↔ MCP content. The interface is the test surface. Two invariants
concentrate here: the wait state is keyed by `sessionId`/DB rows (never per-transport
closure) so it survives the MCP transport's 30-min rotation; `sessionId` is the
addressing key throughout while the signed `token` only ever appears inside the
`chatUrl` minted by `ChatLinks`. The live wait + the message writes go through
`ChatChannel`.

**ChatChannel** (`src/chat/channel.ts`) — the deep module owning a clarification
session's *live channel*: the in-memory listener registry AND the message-write
operations (`postUser` / `postAssistant`) that must wake those listeners. One
invariant concentrates here: *every chat-message write notifies every listener on
the session*. Previously that was split — `DB.addChatMessage` wrote the row, a
free-function bus in `routes.ts` did the notify, and three write sites (SSE POST,
the MCP send loop, the manual-chat API route) had to pair them by hand; the
manual-chat route already forgot, so a live viewer missed the seeded message.
Folding write+notify into one op makes the bus impossible to drive out of sync
with the table. Two real consumers cross the wait/subscribe seam: the SSE stream
(`subscribe`) and the MCP `vigil_send_message` 24h loop (`waitForEvent`). One
shared instance is constructed in `app.ts` (like `ChatLinks`) and threaded into
`chatRoutes`, `apiRoutes`, and `ClarificationChat`. State keyed by `sessionId`,
so it survives MCP transport rotation.
