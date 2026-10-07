# Document review

Helm’s native review window is a surface of an **already-running Claude Code, Codex, or Pi conversation**. The agent opens the Markdown, receives your selections and instructions in that same conversation, and edits with its existing context, tools, and permissions. Helm never launches, resumes, or replaces an agent for review, types into terminals, or reads/writes provider session files.

The actual repository Markdown is the source of truth. Helm renders and watches it; it does not convert it into Run Context or rewrite it to display it.

## Agent-driven CLI

Start the updated Helm desktop normally. Inside your existing agent conversation, ask it to use the following workflow:

```sh
helm review open docs/plans/example/spec.md --agent claude --wait --json
# Use --agent codex or --agent pi for those running callers.
```

This enrolls the caller, opens the native window, and **keeps this tool call waiting**. Select a passage, type immediately, then explicitly send; Ask is the default and Request change is available in the companion intent menu. Whole-document messages use the same editor. The tool returns JSON containing a private `connection` file handle and `feedback` with the original typed request, bounded prompt, and relative file path. The agent reads `feedback.prompt` in its original context, handles it there, and reports back:

```sh
helm review reply REQUEST_UUID --connection CONNECTION_FILE --text "My answer / what changed"
helm review wait --connection CONNECTION_FILE --timeout 600 --json
```

Continue the wait → handle → reply loop for ongoing review. A foreground tool call must actually consume the result: a detached shell listener is not live agent injection. The agent may need its shell tool’s timeout increased for a long wait. Timeout returns `feedback: null` without fabricating delivery. A waiting CLI process is transport, not a second agent or a daemon.

The complete command surface is:

| Command | Effect |
| --- | --- |
| `connect --agent NAME [--workspace DIR] [--label TEXT]` | Enroll the original caller, without opening a document or sending a prompt. |
| `open FILE [--connection FILE] [--wait]` | Open Markdown for this connection. Without a handle, requires `--agent`. |
| `wait` / `next --connection FILE [--timeout SECONDS]` | Return one selection/comment/message to the same waiting tool call; repeat deliberately. |
| `reply UUID --connection FILE` | Report `--text`, bounded `--text-file FILE`, or `--stdin`; exactly one source. |
| `status [--connection FILE]` | Show desktop availability or connection metadata. |
| `list --connection FILE` | Show repository-scoped connection metadata; transcript omission is explicit. |
| `receipt UUID --connection FILE` | Inspect delivery without replaying it. Foreign receipts are unavailable. |
| `disconnect --connection FILE` | Retire the connection and remove its private handle; never stop the original agent. |
| `help` / `--help` | Agent-readable usage and limitations. |

All operation output is JSON; `--json` is accepted explicitly. For streamed reports, use `--state working --sequence 0`, then increase `--sequence` for every replacement snapshot, including `--state complete` or `error`. A single final reply defaults to sequence 0. An exact completed-report retry is idempotent; changing its contents under the same sequence is refused. Lost/ambiguous feedback is never fetched again or resent automatically.

The connection handle is an owner-private credential **file**, outside the repository. Do not copy its contents, commit it, or log its token. Preserve the handle printed on stderr if opening fails so you can explicitly disconnect. Connections require a canonical Git workspace and the currently active Helm profile. A file already bound to another caller cannot silently switch: choose the new connected agent explicitly in its window, or close the old window before opening it again.

## Native live Pi connector

For ordinary Pi 0.99.1 terminal sessions, the opt-in local package `packages/helm-document-review/` registers the `helm_review` tool and `/helm-review` command. Installing is a separate operator step; this feature does **not** change the user’s Pi settings:

```sh
pi install /absolute/path/to/helm/packages/helm-document-review
# In the existing Pi session, use /reload, then:
/helm-review docs/plans/example/spec.md
```

The agent can instead call `helm_review` with `{ "action": "open", "file": "docs/plans/example/spec.md" }`. It opens the document and retains one private listener. Selection feedback is dispatched through the existing runtime’s `sendUserMessage(..., { deliverAs: 'followUp' })`, with prompt-template expansion disabled. It keeps the original session, tools, permissions, and context; no replacement writer or copied transcript is created. Observed assistant text is projected only after the **exact review prompt** starts, and ends at observed settlement. Unrelated original turns and tool arguments/results are not mirrored.

Use `/helm-review disconnect`, or the tool’s `disconnect` action, to close only the surface. Non-TUI Pi callers use the universal CLI wait path. The factory performs no IO or automatic enrollment. Before switch/fork/tree navigation, admission fences synchronously; cancelled/failed navigation cannot be cleared by idle state, unchanged UUID, timers, or manual reconnect. Only a genuine settled lifecycle event permits a fresh connection. As with Pi Remote, Pi’s public dispatch API does not provide generation-bound atomic admission at later input hooks: closing the connection cannot retract a follow-up already handed to Pi. Dispatch is not acceptance or completion.

## Native UI and document behavior

You can also open **File → Open Markdown file…** or **Plan documents → Review document**. These actions open only the reading surface. Choose a connected agent; there is no New conversation or provider-spawning control.

- Read first: the titlebar shows the actual filename. Compact **Contents** and document-options dots sit beside the filename; no redundant wide reading toolbar. The dots menu contains Read, Source, Changes, Comments, Document details (full path and revision), and scoped light/dark preference. Nondefault views retain Back to reading; narrow windows retain Document/Conversation. Contents uses a 240px hierarchical rail only when the measured document pane leaves a 480px prose floor plus gutters, otherwise a normal-flow section above reading (at most 240px or 40% of pane height), never covering document text. Long labels show at most two lines with full accessible names/title; current section is quietly marked. Close/Escape restore owned opener focus, clicking outside Contents keeps it open and does not steal newer focus; empty documents get a plain no-headings state. Section navigation targets exact block IDs and fences deferred scroll/focus to source, API, owner and lifecycle.
- The companion shows just the conversation name and observed provider/status. A chooser appears only when multiple conversations exist, an available caller is unbound, or an owner change requires explicit reselection. There are no nested details/help blocks or repeated empty-chat instructions. Permission limits remain under **More → Document details**; internal IDs and CLI instructions are not shown. Ready means the selected caller is listening and not busy, not that a request has completed. **Feedback paused** means its connection still exists but no listener is available; Send remains disabled. A wait timeout or completed reply is not a disconnection.
- Scrollbars stay visible and usable, with the same slim rounded thumb and transparent track as Helm's other reading surfaces; keyboard and pointer scrolling are unchanged.
- Complete a trusted pointer selection and type immediately in the existing companion editor. Routine re-selection updates the passage even with existing text, preserving your words and chosen intent without Use selection. Keyboard selections stay extendable/copyable until Alt+Enter explicitly accepts them; no per-block Review controls interrupt prose. Rendered selection uses its complete containing source block; Source view permits exact Markdown ranges. Saved comment associations and re-anchor remain protected by explicit acceptance. Pending/control/unknown work and local-save flight block scope changes synchronously; a blocked selection never auto-applies after settlement. Selection alone never sends, saves a comment, acknowledges or disconnects.
- Selected text stays visually highlighted as the actual captured DOM range, including after Use selection, editor typing, observation, return or resize. Raw DOM text is validated against its own captured snapshot, separately from the selected quote's rendered line breaks. This display range does not invent Markdown offsets: rendered requests still use the validated containing source block and exact selected quote. Revision, caller/owner/API change, explicit clear or DOM replacement removes range paint without highlighting a replacement paragraph or searching repeated text. Saved annotations retain their truthful source-block indication.
- Ask asks the original agent not to edit. It does not impose a new tool allowlist or sandbox. Request change permits the original session’s ordinary tools. Wire intents remain `discuss`/`change`. Permissions and questions remain in that agent’s original terminal; they are not answered in the review window.
- Whole-document and passage feedback share one stable companion editor. The document highlight supplies passage context: no Selected passage heading, duplicate quote card, Show full quote or replacement label. The exact selected quote remains attached internally to sends and saved comments. Stale guidance stays visible beside writing. Both scopes use the same 128px writing minimum and visibly defined 64px editor floor, including while either menu is open; guidance keeps its 32px floor and chat its 96px floor. One checked Ask / Request change menu, Writing options and Send form the quiet action row. Writing options opens 8px above its dots trigger and may overlap the editor while open; the intent menu stays above the well. Both stay within the viewport. A nonempty draft with disabled Send gets one nearby reason; an empty draft stays quiet.
- Selection/opening focus is fenced to current document/revision and caller/owner. Mount, polling, refresh and resize never move focus; newer control focus wins. Cmd/Ctrl+Enter submits once. Writing options → Return to document, or Escape, restores reading without clearing scope, text, intent or comment identity; from Comments it returns to rendered Markdown, while Source remains Source. Returning to Conversation resumes that same passage draft. Only explicit Writing options → Clear passage switches to whole-document scope, retaining text/intent and refusing admitted work. Resizing/destination changes preserve scope/draft without focus calls.
- Writing options → Save local comment saves without delivery and stays in the editor; repeat Save comment changes updates the same comment. Saved locally · not sent appears only after persistence succeeds, including a successful Retry save, never during failure or for a newer draft/owner/API. Pending saves are single-flight; failures remain retryable. Edit on a saved stale comment retains original quote, intent and comment identity; Send and local save remain disabled until explicit re-anchor. A refused opening leaves current draft/scope intact. Resolve/Delete/Re-anchor are explicit; revisions never silently relocate comments.
- File edits preserve unsent drafts, fence stale selections, and expose Changes against the last observed revision—not full edit history. Helm never writes Markdown.
- Resize the conversation companion with pointer or arrow keys. Narrow windows push Document/Conversation destinations. The scoped Light/Dark reading preference does not change Helm’s app-wide appearance.
- The filename header has no redundant Close button. Native window controls and Cmd/Ctrl+W close the review window, never a terminal; existing close/persistence callbacks remain intact. Failed draft saves offer Retry save or local Discard unsaved changes. Closing a window does not kill the caller; quitting/profile switching disconnects review authority while original agents remain running.

**No listener → not sent.** Unsent feedback stays local. Pending/Dispatched/Unknown receipts are not claims of provider acceptance or an applied file edit. The CLI confirms that it returned feedback to the caller; native Pi confirms only synchronous dispatch. Working derives from explicit caller reports/observations, never inferred terminal output or a send click.

For unknown delivery, inspect the original conversation and file first. Local text recovery and explicit outcome acknowledgement never replay. Disconnect/restart invalidates authority; reconnect explicitly from the original agent. Legacy review-managed identities are preserved but are **never** loaded, spawned, or resumed by the new mailbox. Connections are memory-only and cannot survive desktop restart as runnable targets.

## Bounds and authority

- Document: 512KiB UTF-8, canonical approved root/parents, no-follow regular single-link descriptor, identity/stat and byte checks. Preserve BOM and original CR/LF offsets.
- Instruction/passage: 8,000 UTF-16 units; generated prompt: 24,000. Never automatically copy a whole large spec into feedback.
- Eight native windows, eight globally admitted UI sends, 16 window operations; 32 mailbox owners per profile. Retired owners can be reclaimed, never automatically replayed.
- 256 dedup receipts per profile/process; exhaustion refuses new admission. Check outcomes before deliberately reopening Helm.
- Replies: 64,000 UTF-16 units; UI projection: 80 messages / 160,000 units, explicit omissions. The complete original conversation remains agent-owned.
- Private wire: strict one-frame JSON/UDS, 512KiB actual-byte bound, two operations per connection, eight pending connects and 64 sockets/descriptors. Reads are capped, owner-private, no-follow, single-link and TOCTOU-checked. Exclusive lock creation prevents competing hosts replacing a winner’s authority. Cleanup checks exact published inode identity and never kills unrelated processes.
- Response completion deadline: 15 minutes; a missing reply becomes unknown, not an automatic resend. CLI wait accepts 1–3600 seconds via bounded minute-long reads.
- Drafts: 256 entries / 1MiB private profile state, 64 annotations per draft. Drafts/preferences grant no command or file authority.
- Markdown: 10,000 blocks with bounded token/depth/table work. Inert HTML, safe credential-free absolute HTTP(S) links, no automatic image fetching; mapping failures expose complete literal Source rather than chat-sized truncation.

The sandboxed preload exposes no general filesystem, PTY, daemon or configuration interface. Main rechecks top frame, current window, profile token, document/revision and complete caller owner before/after awaits, including failures. Private control is desktop-owned, not the API-only daemon or Remote host. Browser display fixtures cannot enroll production callers.

## Verification and evidence

```sh
node --import tsx --test tests/document-review.test.ts tests/document-review-callers.test.ts
HELM_DOCUMENT_REVIEW_PI=/path/to/installed/Pi/CLI.js node scripts/check-document-review-pi.mjs
HELM_DOCUMENT_REVIEW_PI=/path/to/installed/Pi/CLI.js node --import tsx --test tests/document-review-callers.test.ts
HELM_DOCUMENT_REVIEW_CALLER_PROOF=1 node --import tsx --test tests/document-review-providers.test.ts
```

The optional Pi loader proof uses the actual installed loader/types and real private wire, but a fixture runtime—not installation or a physical TUI certification. The provider proof starts **new disposable original agents in its harness**, then has their real tools connect/wait/receive/edit/reply while recalling context known before enrollment. The production host never starts those agents. It never adopts/restarts the operator’s sessions. The old managed-conversation proof flag does not certify the revised integration.

**Views / Document review** and `app/browser-tests/document-review.spec.ts` exercise the production component through explicit display fixtures, including absent/paused callers, scoped drafts, single-flight delivery, and responsive light/dark reading. Run CPU-intensive verification through sysbudget, finish app/root builds before browser gates, use owned loopback Storybook and unique external report/screenshot directories. App build is `cd app && bun run build`; it builds the backend too. Do not restart the real desktop, daemon, Remote or Pi to pass a gate. An open desktop blocks native co-tenant proof. Component, wire, provider, installed-TUI, and native Electron proofs remain separate evidence categories.

Headless Chromium does not establish usable caret browsing from a collapsed caret in noneditable prose. Keyboard-selection fixtures seed one browser-selected character, then use genuine Shift+Arrow and Alt+Enter; seeding alone never admits passage scope or highlight. This does not certify native caret-browsing behavior.
