# Helm question fork — not installed or published

Source: `@juicesharp/rpiv-ask-user-question@2.9.0` from the operator's installed
npm package, inspected 2026-09-07. Upstream repository:
https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question

The complete shipped source and original MIT `LICENSE`/attribution are retained.
Original `ask-user-question.ts` SHA-256:
`19baceab96004070111e87c35985ebeea1a376e414e9b90b92708ed822ffddd6`.
The original README describes upstream behavior. This file owns fork differences.

Changes: private package identity `@neumie/helm-ask-user-question@2.9.0-helm.1`,
`remote-answers.ts`, and integration of its first-winner gate into the actual TUI
`makeSessionFactory`. Original select/multi/custom input, notes, preview rendering,
result envelope, RPC fallback and notification events remain upstream-owned.
The optional i18n imports in `index.ts` and `state/i18n-bridge.ts` use runtime
module specifiers, preserving the existing try/catch English fallback while
allowing standalone typechecking without installing the optional SDK. Local
casts still own the consumed SDK shape. Only the English fallback is verified
in this environment; no i18n compatibility claim is made.

New in-process JSON-only channels:

- `helm:question:open.v1`: `{ requestId, questions }` after real TUI construction.
- `helm:question:answer.v1`: `{ requestId, commandId, answers }`, one selection per
  question (`{option: zeroBasedIndex}`, `{options: indices}`, or `{text: string}`).
- `helm:question:receipt.v1`: `{requestId, commandId, status: answered|rejected}`.
- `helm:question:closed.v1`: `{requestId}` on local/remote completion or disposal.

The answer module maps indices to original labels and selected preview bytes. A
browser never supplies QuestionAnswer/result envelopes. Local and remote completion
share one synchronous one-shot callback. Malformed/current-question answers reject
without closing the TUI; wrong/closed question IDs have no listener. The host/bridge
owns authentication, command deduplication, and a stale-question rejection receipt.
These events are a trusted same-process seam, not a network authentication boundary.
Remote notes, remote cancellation, RPC remote-event control and arbitrary custom
UI are NOT implemented. The local upstream behavior for these remains unchanged.

Testing imports only `remote-answers.ts` for focused contracts. The terminal proof
loads the FULL fork with Pi, not a replacement question renderer/tool. Do not load
the upstream and fork together (duplicate `ask_user_question` registration).

No installed package is replaced. Rollout is a separate operator action. For a
controlled disposable Pi, use `--no-extensions -e <fork>/index.ts` and explicitly
load any other test extensions. A running user session needs an idle, operator-led
package-selection change and `/reload`, never kill/relaunch or a second JSONL writer.
