# helm open — a viewer for almost anything

Status: phase 1 (spec + design variants). No production code changes in this phase. D1–D11 and D13 decided by Jakub on 2026-11-09 (§ Decisions); D12 and D14 open until he picks from Storybook. The design exploration is story-only under `app/src/renderer/open-prototype/` (Storybook `Views/Helm open/…`); Jakub picks the design from there.

## Problem

Document Review (`helm edit`, `helm review`, the `helm_review` Pi tool) opens only repository Markdown, JSX and TSX, and only as a surface of a waiting agent. Two everyday needs fall outside it:

1. **Looking at a file.** A PDF in Downloads, the spreadsheet a client sent, a screenshot, a Sentry JSON dump, a CSV export. Today these leave Helm for Preview, Numbers, Quick Look or an editor, and an agent that wants Jakub to look at one has no way to put it in front of him.
2. **Pointing at a part of it for an agent.** "This row is wrong", "page 3, this paragraph", "this area of the screenshot". The existing passage chat only understands text offsets in Markdown/JSX/TSX.

`helm open` is the same native window, reworked into a calm, read-only viewer for most file types an engineer meets, with the existing agent feedback as an opt-in mode on top.

## Goals

- `helm open FILE…` shows any supported file in a native Helm window, from a terminal, an agent, Finder, the Dock, drag and drop, or a recent-files list.
- Plain viewing never needs an agent, never writes the file, never loads anything from the network and never runs code from the file. (`.jsx/.tsx` therefore open as source in plain mode; the executing canvas stays feedback-mode only, inside a Git repository — decision D3.)
- Agent-bound feedback mode keeps every existing contract (`helm edit`, `helm review`, the `helm-review:v1` journal, the `cli` provider, the Pi package) byte-compatible, and extends anchoring to new formats without breaking an older CLI or Pi package.
- Formats arrive in thin slices, each shippable and tested on its own.

## Non-goals

- Editing any format. The viewer is read-only; agents edit with their own tools.
- Replacing Preview/Numbers/Word for heavy work (forms, signatures, formulas, track changes).
- A file manager, a browser, or a terminal file previewer.
- Non-macOS platforms in this phase (Helm desktop is macOS-first; nothing here should make Linux harder, but nothing is tested there).

## Today, in one page (what must keep working)

Understanding maps from the code are summarised here; details are in the code references.

| Surface | Contract that must not break |
| --- | --- |
| `helm edit FILE [--timeout] [--agent claude\|codex\|pi\|cli] [--workspace] [--label] [--connection]` | Opens, enrolls, waits up to 1 h, prints JSON `{connection, documentId, revision, relativePath, closed, feedback, timedOut, commands, instructions}`. Continuations `helm edit reply HANDLE TEXT`, `helm edit wait HANDLE`, `helm edit disconnect CONNECTION`. Handle grammar `CONN#REQ[#DOC]`. (`src/cli/edit.ts`) |
| `helm review connect\|open\|wait\|next\|reply\|status\|list\|receipt\|disconnect\|help` | Unchanged legacy surface, flags and stderr `Review connection: <file>`. (`src/cli/review.ts`) |
| Private wire `~/.helm/document-review/control.sock` | One newline frame ≤512 KiB, envelope `{epoch, token, id?, owner?, command}`, nine strict command variants, strict result schemas (`src/document-review/protocol.ts`). Every result schema is `.strict()`: an additive field breaks an old CLI. |
| `cli` provider | Displayed as **Agent**, never inferred from the environment. |
| `helm-review:v1` journal | Trailing `<!-- helm-review:v1 … -->` (Markdown) / `/* helm-review:v1 … */` (JSX/TSX) base64url records, strict `version: 1`, body vs archive revision, stale passages never relocated (`app/src/document-review/canvas-artifact.ts`). Any v2 record makes the file unopenable on an older Helm. |
| Pi package `packages/helm-document-review` | Tool `helm_review {action, file}`, command `/helm-review`, imports `src/document-review/{live-caller,screenshot-files}.js` by relative path, reads `helm-review-screenshot:1` lines from the prompt. |
| Window security | `sandbox: true`, `contextIsolation`, no `nodeIntegration`, CSP `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src blob:; connect-src 'none'; worker-src blob:`, opaque handles over preload, current-frame + profile authentication before and after every await. |
| File admission | `readReviewFile`: canonical Git root required, `/\.(md\|jsx\|tsx)$/i`, no hidden path segment, `O_NOFOLLOW`, single link, owner uid, not group/world-writable, ≤512 KiB, fatal UTF-8. |
| Bounds | 8 windows, 32 owners per profile, 80 messages, 64 KiB reply text, 15 min completion. |

Things found while reading that the spec has to account for:

- **The Plan documents → Review entry is dormant.** Production mounts the sidebar rooted at Settings, so `PlanPage.review` is unreachable outside stories. Live entries are File → Open document…, the CLI and the Pi tool.
- **Stale copy:** two places still say "Open Markdown file" (`DetailSubpages.tsx`, `docs/document-review.md`); the open dialogs in `window.ts` filter "Markdown or JSX" (md/jsx/tsx). The File menu already says "Open document…".
- **A retired owner is never cleared.** `selectedSession` changes only through `document-review:select` or reply recovery, and `openFile` refuses a new caller while any `selectedSession` is set ("This document already has a review owner or unsaved work…"). A second agent's `helm edit` on a window whose owner retired is refused today.
- **Version rejections look like any failure.** An unknown action or key fails `envelopeSchema.parse`; `describeReviewFailure` turns that ZodError into the generic `UNCERTAIN_REVIEW_FAILURE` text. Discovery and `status` are strict with `version: z.literal(1)`.
- **Menu shortcuts are global.** `dispatchShortcutInput` runs on every BrowserWindow and consumes ⌘W, ⌘=, ⌘-, ⌘0, ⌘[ (sending `font:step` to the cockpit); macOS has one application menu; ⌘O is the agent dock's show-terminal key; ⌘⇧R is View → Force Reload.
- **Helm runs unpackaged.** Its bundle is `node_modules/electron/dist/Electron.app`, id `com.github.Electron`, shared by every checkout and every Electron project. A LaunchServices launch of that bundle starts Electron's default app, not Helm.
- **Pi never sees `closed`.** `LiveReviewCaller.listen` uses unscoped `next`, so a closed window does not end a Pi listener.
- **`buildReviewInvocation` / `ReviewJsonLines`** (agent-adapter, review-output) are left over from the managed-conversation design and have no production caller.
- **Trailing newline after a journal** makes the whole file unopenable (`canvas-artifact.ts` treats whitespace-only text after a closed marker as invalid). Editors that "ensure final newline" will hit this.

## Command surface

### Two modes, one window

| | Plain viewing | Agent-bound feedback |
| --- | --- | --- |
| Started by | `helm open FILE…`, Finder, Dock, drag and drop, File → Open, recent files | `helm open --listen FILE`, `helm edit FILE` (alias), `helm review open`, Pi `helm_review` |
| CLI returns | as soon as the window shows (exit 0), prints nothing unless `--json` | waits for feedback exactly like `helm edit` today |
| Needs a Git repository | no | yes (unchanged) |
| Writes the file | never | only the existing in-file journal for Markdown/JSX/TSX; never for other formats |
| Companion / composer | hidden; an agent indicator is absent | shown; owner name + state, as today |
| Selection | copy only | copy, or open the anchored feedback bubble |

A plain window becomes bound when an agent opens **the same canonical file** with `--listen` while it is open (decision D2). Binding runs the full feedback admission (`readReviewFile` or its per-format equivalent, Git root equal to the connection workspace) on the window's canonical file and replaces its observation with a feedback-mode one; if that refuses, nothing is bound and the CLI gets the refusal. Only windows that never had an owner can be bound this way: a window whose owner disconnected or retired keeps its fenced owner and refuses rebinding, as today. Making retired-owner windows rebindable would be a deliberate behaviour change to `helm edit` with its own test, not part of this spec.

### `helm open`

```
helm open FILE…                 open each file read-only, return at once
helm open --listen FILE         agent-bound; same flags and JSON as `helm edit FILE`
helm open --json FILE…          print {opened:[{file, documentId, format}], refused:[{file, reason}]}
helm open --reveal FILE         open and select the file in Finder instead (no window)
helm open --default-app FILE    hand to the macOS default app (same rule as the UI action)
```

- `FILE` is resolved against the current directory; `-` is not supported (no stdin streaming in the first slices).
- Several files open per the chosen multi-file model (B). A refused file does not stop the others; exit code is 1 if any file was refused, and each refusal is one line on stderr naming the file and the fix. Per-file refusals come from the host's `refuse()` messages relayed in the `view` result, not from a thrown CLI error. `open` joins `edit`/`review` in `src/cli/helm.ts`'s error handler, keeping its ZodError/ENOENT/EACCES mapping.
- If the desktop is not running, the CLI prints today's messages unchanged: a missing discovery file gives "Document editing unavailable. Run helm edit help; an updated Helm desktop must be running.", a dead socket gives "Could not reach the review connection. Start an updated Helm desktop, then reconnect explicitly." Launching Helm from the CLI (D7) needs a packaged Helm.app with its own bundle id, or a launcher that runs `electron <app dir>`; it is not possible against today's shared `com.github.Electron` bundle.
- `--listen` takes exactly one FILE and is refused before any connect when given several. With `--listen`, `--json` is accepted and ignored (output is the `helm edit` JSON, which already is JSON). Output, continuations (`commands.reply/wait/disconnect` still start with `['helm','edit',…]` in v1), timeout and `closed` semantics are byte-identical to `helm edit`. Changing the continuation verb to `helm open reply` is a later, cosmetic change.
- `--reveal` and `--default-app` run inside the CLI process (`open -R FILE` / `open FILE`) under the caller's own authority, never as a wire action of the host; `--default-app` applies the same extension allowlist as the UI action.

### Aliases (kept forever)

- `helm edit FILE` = `helm open --listen FILE`. All `helm edit reply|wait|disconnect` verbs and the handle grammar stay.
- `helm review …` unchanged, including non-waiting `open` which keeps requiring a connection.
- Pi `helm_review` / `/helm-review` keep their names; only the skill description gains the new format list once feedback for those formats ships (S8).

### Desktop entry points

| Entry | Behaviour |
| --- | --- |
| File → Open… (⌘O only while a viewer window is focused; `registerAccelerator: false`, so the cockpit's ⌘O still reaches the agent dock) | native open panel, any supported type, multi-select |
| File → Open Recent | macOS recent documents (`app.addRecentDocument`, menu role `recentDocuments`) plus Helm's own list, paths only, stored under `<userData>` 0600, capped at 50, cleared from the menu |
| Finder "Open With → Helm" / drag onto Dock icon | `open-file` event → plain viewing. Requires `CFBundleDocumentTypes` with `LSHandlerRank = Alternate` (Helm is offered, never claims the default) — **only on a packaged Helm.app with a unique bundle id** (D8). The shared unpackaged `Electron.app` gets no document types: they would make every checkout and every Electron project an Open With candidate, and a cold launch would start Electron's default app. `app.on('open-file')` registers inside `will-finish-launching` and queues paths until windows can open. Side-by-side: `side-by-side.sh` removes `CFBundleDocumentTypes` from its clone (`plutil -remove`), `startupPolicy()` gains an `openFile` key that is off there, and main ignores `open-file` like it ignores `open-url` |
| Drag a file onto a viewer window | opens it (as a tab/window/sidebar entry per the multi-file pick). Dropping an image **onto the composer** keeps today's meaning: attach a screenshot |
| Cockpit (terminal) | ⌘-click on a file path in terminal output → `helm open` (later; uses the existing link handler seam, local paths only) |

## Formats

### Tiers

Sizes are min+gzip of the prototype's actual bundles where measured (see "Bundle cost"); every renderer is a lazily loaded chunk, so the base window pays nothing for a format it does not show.

| Tier | Formats | How | Library (license) | Bundle cost | Out of scope in the tier |
| --- | --- | --- | --- | --- | --- |
| 0 — exists | Markdown, JSX/TSX canvas | current Document Review renderers; the canvas executes the file, so it is feedback-mode only, inside a Git repository. Plain mode shows `.jsx/.tsx` in the code view | marked, React worker canvas | already shipped | — |
| 1 — MVP viewer | plain text, code (≈40 languages), logs | CodeMirror 6 read-only, line numbers, search | `@codemirror/*`, `@lezer/*` (MIT) | see table below | editing, LSP, minimap |
| 1 | JSON, JSONL, YAML, TOML | parse in a worker → collapsible tree + raw source toggle, JSON Pointer per node | native `JSON`, `yaml` (ISC), `smol-toml` (BSD-3) | see below | schema validation, JSON5 comments preserved in tree |
| 1 | PNG, JPEG, GIF, WebP, AVIF, BMP, ICO | width/height read from the file header first (PNG IHDR, JPEG SOF, GIF LSD, WebP VP8/VP8L/VP8X, AVIF `ispe`, BMP/ICO headers); missing or contradictory dimensions, or more than 150 MP, refuse with the numbers. Then Chromium decodes from bytes (`blob:`), fit/1:1/zoom/pan, pixel size + EXIF orientation | small own header reader (extends `screenshot-format.ts`) | ~2 KB | color management beyond Chromium, animated frame stepping |
| 1 | SVG | rendered **as an image** (`<img src=blob:>`), never inline DOM: scripts, foreign objects and external references cannot run or load | none | 0 | interactive SVG |
| 1 | HEIC/HEIF | converted **out of process**: copy the pinned descriptor's bytes to a private 0600 temp file, `execFile('/usr/bin/sips', ['-g','pixelWidth','-g','pixelHeight', copy])` to enforce the 150 MP cap, then `sips -s format png` in a time-limited child; PNG bytes go to the renderer. Never `nativeImage` on the original in main (Electron's `createFromPath` decodes only PNG/JPEG and would decode untrusted bytes in main). An empty result refuses | none (OS) | 0 | Live Photo motion |
| 1 | PDF | pdf.js in a worker, text layer for selection/search, outline, page thumbnails later | `pdfjs-dist` (Apache-2.0) | see below | forms, annotations editing, XFA, JavaScript, signatures, password PDFs (S4b) |
| 1 | CSV, TSV | streaming parse in a worker, virtualized grid, header detection, column widths from sample, sticky header + row numbers | `papaparse` (MIT), `@tanstack/react-virtual` (MIT) | small | editing, sorting that writes, charts |
| 2 | XLSX, XLSM (no macros), XLS, ODS, Numbers export | parse in a worker → same grid as CSV, sheet tabs, cached formula values shown, formula text in the status line | SheetJS CE `xlsx` 0.20.3 (Apache-2.0, from the vendor tarball, not npm 0.18.5) | see below | recalculation, macros, charts, pivot tables, conditional formats beyond number formats |
| 2 | DOCX | `docx-preview` renders OOXML to DOM, paged look, embedded images only | `docx-preview` (Apache-2.0) + `jszip` (MIT) | see below | tracked changes display, comments, fields refresh, `.doc` (Quick Look) |
| 2 | Audio, video (mp3, m4a, wav, flac, ogg, mp4, mov, webm) | native `<audio>/<video>` streamed through the viewer protocol with range requests | none | 0 | codecs Chromium lacks (HEVC in MKV, some ProRes) → Quick Look |
| 2 | `.eml` | parse in a worker: headers, plain text body by default, HTML body in the sandboxed HTML frame with remote content blocked, attachment list. An attachment opens as a virtual file through the same registry detection (extension and magic must agree) and family limits; it never reaches `openPath`, `previewFile`, Reveal or default-app and is never written to disk. Quick Look-only and refused types show the refusal | `postal-mime` (MIT-0) | see below | `.msg` (Outlook), S/MIME, reply/forward |
| 2 | HTML | sandboxed frame, no scripts, no network, rendered snapshot; source view toggle | none | 0 | interactive pages, forms, anything needing JS — that is a browser |
| 2 | MDX | Markdown renderer; JSX blocks shown as code, **never evaluated** (the JSX/TSX canvas stays the only executing renderer, for `.jsx/.tsx`) | existing marked | 0 | live MDX components |
| 3 — native fallback | an explicit extension allowlist: PPTX, KEY, PAGES, NUMBERS, DOC, RTF (more only by adding them to the registry) | "Show in Quick Look" (`BrowserWindow.previewFile`) on the identity-checked canonical path, plus Open in default app | none (OS) | 0 | everything Helm-native: theming, search, feedback anchors. Honest note in the window: *Helm can't render this format; Quick Look shows it.* |
| out | archives, disk images, executables, `.app` bundles, databases, fonts, 3D, CAD | refused with "Helm can't show <ext> files" + Reveal in Finder | — | — | — |

**PPTX, honestly.** No maintained JavaScript renderer reproduces PowerPoint layout well enough to point at a slide; the open-source options either ignore masters/themes or rasterise poorly. Converting through LibreOffice would mean bundling ~300 MB or depending on a user install. Quick Look renders PPTX/Keynote faithfully, so the tier-3 fallback is the honest answer; slide-level feedback stays out until a real renderer exists. A cheap middle step (later): extract slide titles and notes text from the OOXML with `jszip` so search and "slide N" anchors work, while the visual stays Quick Look.

### Format detection

1. The last extension decides the family (table above, lower-cased), so `foo.test.tsx`, `jquery.min.js` and `report.final.pdf` work. Only known compound archive suffixes (`.tar.gz`, `.tar.bz2`, `.tar.xz`, `.tgz`) are recognised, as archives, and refused.
2. Magic bytes confirm binary families (`%PDF-`, PNG/JPEG/GIF/WebP/AVIF/HEIC signatures, `PK\x03\x04` + `[Content_Types].xml` for OOXML, `D0 CF 11 E0` for XLS). A mismatch is refused, never guessed ("invoice.pdf is not a PDF").
3. Text families require valid UTF-8 (BOM allowed, kept for offsets); UTF-16 with BOM is decoded; other encodings are refused in S2 with a clear message.

### Size limits (per open file, plain mode)

| Family | Limit | Why |
| --- | --- | --- |
| Text/code | 16 MiB, 1 M lines | CodeMirror stays smooth; larger logs are a terminal job |
| JSON/YAML/TOML tree | 32 MiB parse in worker, tree shows first 10 000 children per node with "N more" | worker memory |
| CSV/TSV | 128 MiB streamed, 1 M rows | Chromium clamps layout height near 33.5 M px, so a 24 px fixed-row grid stops scrolling around 1.39 M rows; 2 M would need a scaled virtual scroll (map scrollTop to a row index in a bounded spacer, as CodeMirror does) |
| XLSX/ODS/XLS | 64 MiB file, 5 M cells | SheetJS loads the whole workbook |
| PDF | 256 MiB, 5 000 pages | range loading speeds up first paint but does not save memory: pdf.js's `ChunkedStream` allocates the whole file in the worker. `disableAutoFetch: true, disableStream: true` keep fetching lazy |
| Images | 256 MiB file, 150 MP decoded | decode memory |
| DOCX | 64 MiB | DOM size |
| Media | none (streamed) | — |
| `.eml` | 64 MiB | attachments in memory |
| Feedback mode with in-file journal (md/jsx/tsx) | 512 KiB, unchanged | journal contract |
| Feedback mode, other formats | the plain-mode limits above | nothing is written |

Limits refuse with the actual number ("platform-report.pdf is 412 MiB; Helm shows PDFs up to 256 MiB. Open in Preview?") and offer Open in default app when the type is on its allowlist, otherwise Reveal in Finder.

**Feedback-mode admission for formats without a journal.** Same owner/mode/hidden/symlink/link rules as today's feedback mode (the file is not written, but the agent learns about it). By default the file must be inside a Git repository equal to the connection workspace, so `relativePath` keeps its meaning; `helm open --listen` on a file outside the workspace refuses with a named fix. Feedback on a Downloads PDF outside any workspace stays refused for now (D13, decided: workspace only).

## Feedback anchoring per format

Every anchor carries `revision` = SHA-256 of the document body: for md/jsx/tsx the body without the trailing `helm-review:v1` journal (unchanged — otherwise every journal append would make every open anchor stale); for formats without a journal, the exact file bytes, computed once in a worker at open. If the file changes before Send, the anchor is stale: it stays visible as stale, Send is refused until the operator re-selects, and nothing is ever relocated (the existing rule, extended to all formats).

| Format | Anchor | Agent receives | MVP (S8) | Later |
| --- | --- | --- | --- | --- |
| Markdown, JSX/TSX | v1 `ReviewPassage` (exact UTF-16 range or block) | unchanged | unchanged | — |
| Text, code, logs | v1 `ReviewPassage` `kind: exact` over the file text + line range | unchanged prompt shape ("source lines", "UTF-16 source range") | **yes** — no wire change | multi-range |
| JSON/YAML/TOML | tree node → JSON Pointer (RFC 6901) + value preview ≤2 KiB; source view selection = text passage | `JSON pointer: /exception/values/0/stacktrace`, value preview, source line range when known | **yes** | YAML anchors/aliases shown resolved |
| CSV/TSV | cell range `A2:D9` (+ header names), preview ≤8×8 cells, 2 KiB | range, header row, TSV preview | **yes** | whole-column anchors, filters |
| XLSX/ODS | sheet + range, preview values, formula text for formula cells | `Invoicing 2026 › Summary!B2:C4`, values, formulas | **yes** | named ranges, comments |
| PDF | text selection → page + quote + occurrence index on that page + quad rects (normalized 0..1) | `page 3`, quote, nearby text; a 2× crop PNG of the selection box staged as a screenshot | **yes** | |
| PDF | region drag (for figures/scans) → page + normalized rect | page, rect, crop PNG | later (S8b) | |
| Images | region drag → rect in natural pixels + image size | rect, size, crop PNG staged as a screenshot | **yes** | point pins, multiple regions |
| DOCX | text selection → paragraph index + quote | quote, heading path | later | comments import |
| Media | time / time range | `01:23–01:31`, a still frame PNG | later | |
| `.eml`, HTML | text selection → quote + header context | quote | later | |
| Quick Look formats | none | — | never in Quick Look; whole-file feedback only | |

**Crops ride the existing screenshot pipeline, inside its limits.** Image and PDF anchors stage their crop through `screenshot-files.ts` and add a `helm-review-screenshot:1` line to the prompt. Claude/Codex are told to read it; the Pi package already passes it as `ImageContent`. The pipeline refuses a PNG/JPEG over 4 MB or 8192 px per side and allows 4 images / 8 MB per request (`inspectScreenshot`, `decodeScreenshots`, `appendScreenshotPrompt`, Pi's `readScreenshotImagesSync`). So a crop is downscaled to ≤8192 px per side and ≤4 MB (JPEG fallback), and counts inside the 4-image / 8 MB budget: with an anchor crop the composer accepts at most 3 pasted screenshots and says so. The prompt keeps the full-resolution rect as text.

**Degrading for older callers.** A new anchor kind never reaches a caller that did not declare it understands it:

- At connect, a new CLI sends `features: ['anchors-v2']` only after a successful `hello` (see Wire). The shared `connectReview` default stays without `features`; each call site passes it explicitly.
- For a v1 caller the host delivers `passage: null` and describes the anchor in `prompt` text. Today's `reviewPrompt` with `passage === null` writes "source lines: whole document. UTF-16 source range: none.", always mentions the trailing journal and needs `text` for lines and context, which PDF/image/xlsx do not have. S8 adds a prompt branch for non-passage anchors: it replaces those lines with the anchor description (page + quote; sheet!range + TSV preview; JSON pointer + preview; image rect + size), and emits the journal sentence only for journal formats.
- **Prompt budget.** `feedbackSchema` caps `prompt` at 24 000 UTF-16 units, shared with screenshot lines. The anchor description is capped at 4 000 and counted before admission; previews are cut before the quote, every cut is marked, and if instruction + anchor + screenshot lines would exceed 24 000, Send is refused with a visible count.
- For a v2 caller `request.anchor` carries the structured locator next to `passage`. Any widening of `feedbackSchema`/`reviewRequestSchema` is optional, and the host emits `anchor` only on a v2 binding.

**Where feedback history lives for formats without an in-file journal.** Appending a journal would corrupt JSON, CSV, PDF, images. Options (D5, decided: memory-only first):

- **memory-only** per window (decided for S8): threads live while the window is open, nothing written;
- private store `<userData>/profiles/<id>/open-history/<sha256(canonical path)>.json`, 0600, bounded like the journal, keyed by file revision (later);
- sidecar `FILE.helm-review.json` next to the file — rejected: litters repositories and Downloads, and gets committed by accident.

## Access and security

### Who may open what

| Rule | Plain viewing | Feedback mode |
| --- | --- | --- |
| Git repository | not required | required, canonical, connection's workspace (unchanged) |
| Hidden path segments (`.env`, `.git/…`) | allowed except `.helm-*` and the Helm private-path list below | refused (unchanged) |
| Symlinks | resolved to a canonical path, which is what the window shows and watches; the opened descriptor must match it (below) | refused (`O_NOFOLLOW`, unchanged) |
| Hard links (`nlink > 1`) | allowed only when the inode matches no protected file (below) | refused (unchanged) |
| Owner / mode | readable by this user; any owner | owner uid, not group/world-writable (unchanged) |
| Regular file | required (no FIFOs, devices, sockets, directories), checked before open | required |
| `.jsx/.tsx` | shown as source in the code view, never executed | canvas, inside the connection's repository |
| Writes | none, ever | in-file journal only for md/jsx/tsx |

**Helm private paths.** One shared `HelmPrivatePaths` list: `~/.helm`, `<userData>`, the daemon cwd's `helm.config.json`, `helm.db*` and `profiles/`, `HELM_AUTH_FILE`, `/tmp/helm-*-<uid>` (incl. scheduled prompt/descriptor files), `~/Library/Logs/helm`. Checked on the canonical path **and** by inode: the opened descriptor's `(dev, ino)` must match no file under those roots, so `ln ~/.helm/local-api-token ~/Downloads/notes.txt` is refused.

**One admission, one descriptor (`readViewerFile`).** `realpath` → deny check → `stat` refuses anything not a regular file → open the canonical path with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY` (a FIFO would otherwise block a libuv thread in main) → require `fstat(fd)` to be a regular file whose `dev/ino` equals `lstat(canonical)` and the parent's `realpath` to be unchanged → deny check again on the fd identity → read → re-`fstat`; a changed inode or size during the read refuses ("changed while reading, retry"). Every reload runs the full admission again. `previewFile`, `shell.openPath` and HEIC conversion take the canonical path only after the same identity check.

**Streamed files.** A file served by range (PDF, media) keeps one pinned descriptor per token, opened at admission and never re-resolved by path. Every Range request re-`fstat`s it (`dev/ino/size/mtime`); a mismatch ends the stream and triggers the normal reload, so pdf.js never mixes two versions. Range accepts one `bytes=a-b` or suffix range clamped to the size, answers 416 otherwise, and caps each response.

### Renderer isolation

- Viewer windows keep `sandbox: true`, `contextIsolation`, no Node, no `webviewTag`, `plugins: false` (Chromium's own PDF plugin stays off; pdf.js renders instead).
- **One in-memory session per viewer window** (`session.fromPartition('helm-open-<uuid>')`, never `persist:`). `protocol.handle` on the `protocol` module serves only the default session and its handler receives a bare `Request` with no `webContents`, so the `helm-viewer:` handler, the `webRequest` block and the permission handlers are installed on **that window's** `session.protocol` / `session.webRequest`, and removed when the window closes. A token is therefore reachable only from its own window.
- `webRequest.onBeforeRequest` cancels every `http:`, `https:`, `ws:`, `wss:`, `ftp:` and `file:` request. `setPermissionRequestHandler` and `setPermissionCheckHandler` deny everything (`openExternal`, media, notifications, clipboard-read, fullscreen, display-capture, fileSystem, …) — the app installs none today, and Electron's default approves, including `openExternal` launches that `webRequest` never sees.
- Links inside documents (PDF annotations, DOCX/HTML/eml anchors) never navigate: `will-navigate`, `will-frame-navigate` (subframes; only the initial `about:srcdoc` passes) and `setWindowOpenHandler` deny. Sanitized HTML/eml/DOCX output removes `<link>`, `<meta http-equiv=refresh>`, `<base>` and form elements, rewrites `<a href>` to inert text with the URL as a title, and adds `<meta http-equiv=x-dns-prefetch-control content=off>`. Opening an `http(s)` link is a separate, explicit chrome action ("Open link…") that goes through `parseExternalHttpUrl` — a sandboxed frame without scripts cannot report a click to the parent.
- **Viewer protocol.** A privileged scheme `helm-viewer:`, registered before `ready` with exactly `{standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false, allowServiceWorkers: false, corsEnabled: false}`. With `standard`, the first path component is the origin, so everything uses **one host**: `helm-viewer://app/index.html`, `helm-viewer://app/assets/…` (bundle chunks, pdf.js worker, cmaps, standard fonts, wasm — from `dist/viewer/` only) and `helm-viewer://app/file/<unguessable token>`. No path appears in a URL. The handler returns exact MIME types (`text/javascript` for modules, `application/wasm`).
- **File bytes are inert.** `…/file/<token>` responses carry `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and an inert `Content-Type` for text families, and the page CSP forbids loading them as script or worker (below).
- **CSP as a response header** on every `helm-viewer://app` response, workers included (a worker loaded from a URL takes its CSP from its own response, not the page's `<meta>`):
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; font-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`, with script/worker sources further restricted to the `/assets/` path in the handler (file tokens never carry a script MIME type). `'self'` also matches the loopback route of the built-entry browser test. `wasm-unsafe-eval` is needed by pdf.js image decoders (JBIG2/JPX); no `unsafe-eval`. A test reads the worker response's CSP.
- pdf.js (6.x) gets bytes or a viewer-protocol URL, never a remote URL, with `enableXfa: false` and no scripting sandbox, annotation or form layer. pdf.js 6 removed `isEvalSupported`; its builds contain no `eval`/`new Function`, which the S4 test asserts by grepping the pinned build. `cMapUrl`, `standardFontDataUrl` and `wasmUrl` point only at `helm-viewer://app/assets/pdfjs/…`. pdf.js's `isValidFetchUrl` accepts only http(s), so it uses its XHR stream for `helm-viewer:` — hence `supportFetchAPI`.
- DOCX renders with `renderAltChunks: false` (alt-chunks embed HTML in an `iframe srcdoc`), `useBase64URL: true` (embedded images become `data:` URLs instead of `blob:`), `renderComments`/`renderChanges` off, links stripped to tooltips and non-`data:` images dropped after render.
- YAML parses with an explicit `maxAliasCount` (alias "billion laughs"); SheetJS gets a byte limit and `sheetRows` cap before reading; JSON and TOML parse only plain values.
- **Sandboxed HTML** (HTML files, `.eml` HTML bodies, DOCX if its output ever needs isolation): `<iframe sandbox="" srcdoc>` — no `allow-scripts`, no `allow-same-origin` — with an injected `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'">`. Remote images show as blank boxes with one note: *Remote content isn't loaded.* No toggle in the first slices.
- SVG only as `<img>`. Never inline, never `<object>`.
- The JSX/TSX canvas Worker stays the **only** place file content executes, unchanged, and only in feedback mode inside a repository.
- Parsers that touch untrusted bytes (pdf.js, SheetJS, papaparse, yaml, smol-toml, postal-mime, JSON, image headers) run in dedicated workers; the window thread receives plain data. Nothing decodes untrusted bytes in main: HEIC goes through a `sips` child; copying an image means the renderer encodes PNG and main writes it with `clipboard.writeBuffer('public.png', bytes)` after checking PNG structure and size, without decoding it. A parser exception refuses the file with the parser's first line, never a stack.
- Agents opening files: `helm open` from an agent is a request to **show** a file to the operator, not to read it on the agent's behalf. Plain mode returns no content to the caller.
- **No focus stealing.** Windows opened by `view` over the wire appear with `showInactive()` and never take focus or activate the app (today's open path calls `show()` + `focus()`). Only Finder, Dock, drag and drop and File → Open focus a window. No effectful key (default app, reveal, print) works in a window that has not had a user gesture since it opened. `view` is rate-limited per connection (8 files per second) on top of the 32-file cap.

## Behaviour

| Area | Behaviour |
| --- | --- |
| Live reload | Watch the canonical path and its parent (atomic editor saves replace the inode). Reload on change after 150 ms debounce, keeping position (scroll offset, PDF page + offset, active cell, tree expansion, image zoom/pan). Status line says *Updated 14:32*. Deleted → keep the last render, status *File removed*. Feedback anchors become stale on any change (see above). |
| Several files | Decided by the B pick (tabs, a window per file, or a sidebar). Common rules: one view per canonical file (opening it again focuses it), ⌘W closes the view, closing the last view closes the window. Plain views live in their own container with a soft cap of 32; today's 8-window feedback cap counts only bound or feedback-capable windows, so eight plain views never make `helm edit` fail with "Eight review windows are open". |
| Search | ⌘F per format: text/code (CodeMirror search), PDF (pdf.js find, highlights + count), sheet (cell values, jumps to cell), JSON tree (keys and values, expands path), DOCX/HTML/eml (text). ⌘G / ⌘⇧G next/previous, Esc closes. Images have no search. |
| Zoom | ⌘= / ⌘- / ⌘0 go to the viewer's zoom when a viewer window is focused, and to the terminal font step in the cockpit (window-aware dispatcher, see Architecture): PDF/DOCX/image scale, text/code/sheet font size. Pinch on trackpad for PDF and images. |
| Copy | ⌘C copies the native selection; a sheet range copies as TSV; an image copies as PNG (renderer encodes, main writes the checked buffer); a JSON node copies its value as JSON; Copy path in the more menu. |
| Print | ⌘P renders a **non-virtualized** print document (capped at 5 000 lines/rows, with a note when truncated) into a hidden print container, then `webContents.print()`: CodeMirror and the virtualized grid/tree mount only visible rows, so printing the live DOM would print the visible slice. First slices: Markdown, DOCX, text/code. PDFs, sheets and Quick Look formats print through Open in default app until their print documents exist. |
| Reload | View → Reload / Force Reload are disabled (the dispatcher swallows ⌘R / ⌘⇧R) in viewer windows, so a reload never drops bound state or memory-only threads. |
| Open in default app | `shell.openPath` on the identity-checked canonical path, only for an **extension allowlist** derived from the format registry (same model as `isOpenableAttachment`). A denylist would miss `.fileloc`/`.webloc`/`.inetloc`, `.workflow`, `.scpt`, `.mobileconfig`, `.jar`, `.shortcut`, `.terminal`… Unknown or refused types get only Reveal in Finder (`shell.showItemInFolder`). |
| Keyboard-first | Every action has a key and a visible hint in its menu: ⌘O open, ⌘F find, ⌘= ⌘- ⌘0 zoom, ⌘P print, ⌥⌘R reveal in Finder (⌘⇧R is Force Reload), ⌘⇧D default app, Space page down, ⇧Space page up, J/K or ↑/↓ line, PageUp/PageDown, Home/End, ⌘↑/⌘↓ start/end, `[`/`]` previous/next page (PDF) or sheet (workbook). Multi-file keys depend on the B pick (⌘1–9 / ⌃Tab for tabs; ⌘⇧O for the go-to-file palette in B2). Feedback mode adds ⌘↵ send and Esc close bubble, as today. New keys go into `shortcuts.ts` reservations. |
| Theme | Follows Helm tokens; documents keep their own colors where they have them (PDF pages, images, DOCX pages render on paper white, the chrome around them stays Helm dark). The existing scoped light reading palette applies to text/Markdown/code. |

## Architecture

### Renderer registry

One shared description of every format, consumed by the CLI (early refusal), main (admission, limits, reading) and the renderer (lazy view choice):

```ts
// src/document-review/formats.ts (shared; name kept so the Pi package's relative imports stay valid)
type ViewerFormat = 'markdown' | 'canvas' | 'text' | 'code' | 'data' | 'image' | 'heic' | 'svg'
  | 'pdf' | 'csv' | 'sheet' | 'docx' | 'media' | 'email' | 'html' | 'mdx' | 'quicklook'

interface FormatEntry {
  format: ViewerFormat
  extensions: readonly string[]
  magic?: (head: Uint8Array) => boolean
  read: 'utf8-text' | 'bytes' | 'stream'       // stream = served by range through helm-viewer:
  maxBytes: number
  journal: 'in-file' | 'none'                   // only markdown + canvas are 'in-file'
  anchors: readonly AnchorKind[]                // empty = whole-file feedback only
  capabilities: { search: boolean; zoom: 'scale' | 'font' | 'none'; print: 'view' | 'default-app'; copy: 'text' | 'range' | 'image' }
}
```

The renderer side maps `format → () => import('./viewers/pdf')`; each viewer implements the prototype's `RendererProps { file, zoom, onStatus, feedback }` contract (see `open-prototype/types.ts`).

### Main process

- `readReviewFile` stays as is for feedback-mode md/jsx/tsx. A new `readViewerFile(path, mode)` applies the plain-mode rules above, returns `{canonicalPath, format, size, revision, bytes|text|streamToken}`.
- `DocumentReviewWindows` gains a view-only open path (no owner, no grant) with its own container and bound, and the multi-file container (B pick). Names stay `document-review` internally; user-facing copy becomes "Helm open" / the file name.
- Quick Look (`win.previewFile(path)`) and the HEIC `sips` child are started from main; no untrusted decode happens in main itself.
- The viewer protocol handler owns per-window tokens and pinned descriptors. The token table, Range parsing, revocation and the URL-blocking predicate are pure modules with injected Electron dependencies, so `node --test` covers them.
- **Window-aware shortcut dispatcher.** `dispatchShortcutInput` learns the window kind: in viewer windows fontBigger/Smaller/Reset go to the viewer's zoom, closeFocused closes the active view (the window only when it is the last view), ⌘O runs File → Open and ⌘R/⌘⇧R are swallowed; in the cockpit nothing changes, and ⌘O is never consumed by the menu, so the agent dock's ⌘O still works. Tests cover both window kinds.

### Renderer

- `app/src/renderer/document-review.tsx` becomes the viewer host: chrome (A pick), file container (B pick), the chosen format view (C), and in bound mode the existing companion/passage chat plus the new anchored feedback bubble (D).
- Markdown and the JSX/TSX canvas move behind the registry unchanged; `DocumentReview.tsx` keeps owning their passage chat.
- Build: the document-review entry switches from one IIFE to ESM with code splitting (`format: 'esm', splitting: true`) served by `helm-viewer:`; the base chunk must not grow by more than the chrome itself.

### Wire

- **Version is learned from `hello` only.** An old host answers an unknown action or key with the same generic `UNCERTAIN_REVIEW_FAILURE` text it uses for any failure, so nothing on the wire tells "old host" apart from other failures (and an old host logs one `[helm] review: unparsed failed` line per probe). Every new CLI path (plain `view`, `--listen` / `helm edit` connect) therefore sends an effect-free `{action: 'hello'}` first. The new host answers `{protocol: 2, features}` from a synchronous handler with no generic-error path, so a transient failure cannot quietly downgrade a v2 caller. A `hello` reply that is exactly `UNCERTAIN_REVIEW_FAILURE`, or malformed, means "old host": `--listen` / `helm edit` speak v1, and plain `helm open` prints "Update the Helm desktop to use helm open" without sending `view`. The version is never inferred from a failed `view` or `connect`.
- In the new host an unknown `action` or unknown connect key becomes a definite `refuse('Unknown review command …')`, so future versions can tell the cases apart.
- New command `{action: 'view', files: path[]}` for plain viewing, authenticated by the discovery token, **no** connection/owner, rate-limited and opening windows inactive (see Renderer isolation).
- New optional `features` on `connect` (`['anchors-v2']`), sent only after a successful `hello`.
- v1 requests get v1-shaped results byte for byte. `request.anchor` and any new result field appear only on a v2 connection.
- **The Pi package runs the checkout's own source** (it imports `src/document-review/live-caller.js` by relative path and is installed in place), so there is no "older Pi package version" as such. The real old-caller cases are Pi processes not yet `/reload`ed and Pi installed from another checkout or worktree. `live-caller.ts`'s connect command stays unchanged until S8b, when Pi declares `anchors-v2`; until then it is a v1 caller and receives prompt-text anchors + crop lines. The `HELM_DOCUMENT_REVIEW_PI` check covers Pi's host API, not the Helm wire version.

### Journal

- `helm-review:v1` is untouched. No v2 records are written by any slice here.
- New formats never get an in-file journal.
- Separately worth fixing (own small slice, not required by `helm open`): tolerate a single trailing newline after the journal marker, because editors add one.

### Migration and cleanup

- Fix the two "Open Markdown file" strings; the dialog filter lists all supported types.
- Decide the dormant Plan documents → Review entry (delete, or route through `helm open` when the task list returns).
- Delete `buildReviewInvocation` / `ReviewJsonLines` and their tests (no production caller).
- `docs/document-review.md` becomes `docs/helm-open.md` with a section on feedback mode; `README.md`, the Pi skill text and AGENTS.md updated in the slice that changes behaviour.
- Keep `document-review` names for modules, IPC channels, side-by-side policy key `documentReviewControl`, `HelmApi.documentReview`, sessions.json `review:<uuid>` rows: renaming them breaks tests and the Pi package for no user benefit.

## Bundle cost

Measured from the prototype viewers bundled on their own with esbuild (minified, ES2022), gzip in brackets. pdf.js's worker and assets are separate files loaded only when a PDF opens.

| Viewer chunk (what it bundles) | Minified | Gzip | Loaded when |
| --- | ---: | ---: | --- |
| Image (no library) | 9 KB | 4 KB | an image opens |
| Markdown (marked lexer → React) | 54 KB | 17 KB | Markdown opens (already shipped today in Document Review) |
| JSON/YAML/TOML tree (yaml, smol-toml, react-virtual) | 161 KB | 52 KB | a data file opens |
| DOCX (docx-preview, jszip, shared text-selection code) | 226 KB | 67 KB | a DOCX opens |
| Spreadsheet + CSV (SheetJS full, papaparse, react-virtual) | 440 KB | 146 KB | a sheet opens; SheetJS `mini` (280 KB raw) is enough for xlsx/csv/ods if XLS is dropped |
| PDF main thread (pdf.js display layer) | 443 KB | 133 KB | a PDF opens |
| PDF worker (`pdf.worker.min.mjs`) | 1 264 KB | 375 KB | a PDF opens, in its own worker |
| PDF optional assets (cmaps 1.6 MB, standard fonts 816 KB, wasm decoders 1.5 MB) | — | — | fetched from the app bundle only by PDFs that need them |
| Code (CodeMirror 6 view/state/language/search/commands + 6 language packs) | 595 KB | 208 KB | code or text opens; the core alone (view, state, language, search, commands) is 290 KB / 94 KB gzip, so language packs should be their own chunks |
| `.eml` (postal-mime parser only, no view built yet) | 91 KB | 29 KB | an email opens |

Total extra install size if everything ships: about 3.3 MB of JavaScript plus 3.9 MB of optional pdf.js assets, none of it on the path of a window that shows Markdown. Measured with esbuild 0.28 `--minify --format=esm --target=es2022`, React external, CSS excluded.

## Design exploration (phase 1, story-only)

All under Storybook `Views/Helm open/`, real renderers over realistic fixtures (a 3-page platform report PDF, an invoicing workbook with formulas, a 1 800-row CSV export, a failed-form screenshot, a Sentry issue JSON, a plan Markdown, a TypeScript module, a service agreement DOCX).

- **A Window chrome** — three chromes (A1–A3), plus three A1 × A3 hybrids after Jakub asked for "something between A3 and A1" (A4 path then name, A5 name then path, A6 collapsing path) and a long-path comparison; each plain and bound.
- **B Multiple files** — tabs, a window per file with a go-to-file palette, a file sidebar.
- **C Format views** — PDF, spreadsheet (XLSX + CSV), image, JSON, code, documents (Markdown, DOCX).
- **D Feedback anchors** — PDF text selection, spreadsheet range, image region (plus JSON node and code lines).
- **E Send receipt** — what the window says right after Send (D14, below): Today plus four variants, each with frames for sending, received, working, replied, not sent, not confirmed and a passage send.

Jakub picks A, B and E; C and D are proposals for the per-format behaviour and are expected to be adjusted rather than picked.

## Send receipt (D14, open until Jakub picks)

Jakub reported that after Send in the review window nothing confirms the feedback went anywhere. This is about the review composer and companion, not the agent dock.

### What happens today

Measured with the real IPC handlers, `ReviewSessions` and a real `helm review` CLI child (Electron mocked, one machine, 2026-11-09):

| Moment | When | What the window shows |
| --- | --- | --- |
| Click Send | 0 ms | Draft clears; the button reads "Send…" for about 10 ms. No echo of the message. |
| Host accepts | median 10 ms (max 23 ms) | Receipt `pending`, session `waiting`, the "You" message is in the transcript. Journal append (with fsync) happens before dispatch. |
| Agent's tool has it | about 1.5 ms after dispatch | The waiting CLI prints the feedback and acks; receipt becomes `dispatched`. The window learns it on its own refresh or the 80 ms coalesced push. |
| Waiting for the reply | until the reply | Header "<Agent> · Waiting" and a plain line "Waiting for the connected agent's reply…" in the companion only; a passage bubble shows nothing. |
| Agent working | Pi only | Pi reports `working` when its follow-up turn starts and streams text. `helm edit` callers (Claude Code, Codex) never report working: `edit reply` refuses `--state working`, so the window says Waiting until the final reply. |
| Reply | when the agent answers | Assistant message; state idle and listening. `helm edit reply` launch → report applied: 237 ms (dev tsx). |

So the agent has the feedback about 10 ms after the click; the problem is that nothing visible says so. `pending` and `dispatched` are never rendered: the design system (§ Document Review, "Normal pending/dispatched receipts stay internal with no success panel") and `document-review.spec.ts` lock that in.

Failures today:

- **Refused before any effect** (no listener, owner changed, stale revision; 0.03 ms for no listener): the draft goes back into the editor and the reason appears in the top banner, far from the composer. Copy: "The agent is not listening. Ask it to run helm review wait; your feedback was not sent."
- **No ack within 10 s, or no completion within 15 min**: receipt `unknown`, header "Needs attention", the existing panel with "I checked the outcome"; nothing is replayed.
- **Transport error in the preload** becomes "Helm could not confirm this operation. Do not automatically resend it." but the renderer treats it like a refusal and puts the draft back as if it was not sent (existing bug, see below).

### Variants (Storybook `Views/Helm open/E Send receipt`)

All four run the real `DocumentReview` send path through an opt-in `sendReceipt` prop (absent in production) against a staged host that replays the timings above. Each story has a frame switcher: Sending, Received · Claude Code, Working · Pi, Replied, Not sent, Not confirmed, Passage, and two live "Try it" frames.

| Variant | Where it speaks | Shape |
| --- | --- | --- |
| **Today** | — | Production now, the control. |
| **A Composer line** | one line right above the box you typed in (companion or passage bubble) | "Sending to Claude Code…" → "✓ Claude Code has it · no progress until it replies · 0:12" → (Pi) "Pi is working · 0:12" → "✓ Replied". |
| **B Under your message** | the transcript, under your own message | Your text appears at once as a local echo; under it "✓ Delivered · Claude Code replies when it is done · 0:12" or "Pi is working". A refusal strikes the echo through. |
| **C Header steps** | the conversation header (a compact track above the passage composer) | Sent · Received · Working · Replied, done steps ticked, the awaited one animated. Claude Code's track has no Working step because it never reports one. |
| **D Send button** | the Send button itself | "Sending…" → "✓ Delivered 0:12" / "Working 0:12" → back to "Send"; a quiet note above says the agent answers there. |

Shared rules in every variant: "received" means the agent's waiting tool has the text, never that the model read it or edited anything; progress uses the grayscale activity indicator, colour only on the `!` (danger) and `?` (warn) glyphs, never `--success`; a refusal says "Not sent", gives the reason next to the composer instead of the top banner, and the draft stays in the editor; "Not confirmed" keeps today's panel with "I checked the outcome" and replays nothing.

### What changes once Jakub picks

- The design-system rule that pending/dispatched stay internal and the `document-review.spec.ts` assertions that no success panel renders are rewritten for the picked variant.
- The opt-in seam (`send-receipt-view.ts`, the `sendReceipt` slots) either becomes the production path for that one variant or is replaced by a direct implementation; the story-only staged host stays in Storybook.
- Signals that do not exist yet and would make any variant more truthful: a `working` report from `helm edit` callers (e.g. `helm edit working HANDLE` and reply sequence ≥1), host timestamps on receipts and messages (today the window uses its own clock), and a preload result that tells "not sent" from "outcome unknown".

## Delivery slices

Each slice is shippable alone, keeps every existing test green, and does not change the in-file journal.

| # | Slice | Ships | Test plan |
| --- | --- | --- | --- |
| S1 | `helm open` for today's formats | `helm open FILE…` plain viewing of Markdown (no repo needed, rules per table) — plain `.jsx/.tsx` refuses with "Use helm edit to preview components" until S2's code view exists; `--listen` = `helm edit`; `hello` + `view` wire with definite unknown-command refusals; window-aware shortcut dispatcher; inactive `view` windows; separate plain-view bound; stale copy fixes | CLI unit tests (args, `--listen` with two files refused before connect, refusal lines, `--json`); wire tests: `hello` against a fake old host → v1 / update message, never inferred from `view`; v1 byte-compat fixtures for every existing result; admission tests: FIFO, `/dev` symlink, symlink swapped after realpath, hard link to a `~/.helm` file all refused; binding a plain-opened hidden or hard-linked `.md` with `--listen` is refused; 8 plain views do not refuse `helm open --listen`; dispatcher tests for both window kinds; existing `document-review*.test.ts` and `callers` suite unchanged |
| S2 | Viewer host + registry + protocol | registry, `helm-viewer:` protocol on per-window sessions, network/permission block, ESM split build, text/code view (CodeMirror, incl. plain `.jsx/.tsx` as source), JSON/YAML/TOML tree | format detection table tests (extension × magic × refusal, `foo.test.tsx` accepted, `.tar.gz` refused); size-limit tests; **pure-module** `node --test` for the token table, Range parsing (416, clamping, caps), revocation and the URL-blocking predicate; worker CSP header test. The existing `document-review-native-entry.spec.ts` changes: it serves every dist chunk with correct MIME types and matches `type="module"`. Real-session network block and per-window token isolation are a canary/manual proof that respects the no-co-tenant rule (no Electron e2e harness exists). Playwright story tests for code/JSON keys/search |
| S3 | Images | header-dimension check, raster, SVG-as-image, HEIC via `sips` child, zoom/pan/1:1, copy as PNG buffer | header reader fixtures per format (missing/contradictory dims refused, 151 MP refused with numbers); SVG with `<script>` and external `<image href=https>` renders without executing/loading (browser test); real `sips` HEIC fixture → PNG, empty result refused; EXIF orientation fixture |
| S4 | PDF | pdf.js viewer, text layer, find, page nav, outline; S4b password prompt | fixtures: text PDF, scanned image PDF, CJK (cmaps), JBIG2 (wasm), a PDF with JavaScript + launch action + remote link (nothing runs, nothing loads), 500-page lazy fetch asserting peak worker memory and the fetch pattern, file changed mid-stream ends the stream and reloads, find count |
| S5 | CSV/TSV grid | streaming parse, virtual grid, header detection, copy range as TSV | 1 M-row fixture timing budget and last row reachable, quoted newlines, BOM, semicolon CSV detection, wide (500 columns) layout |
| S6 | XLSX/XLS/ODS | sheet tabs, cached values, formula text, number formats, merged cells | workbook fixtures with formulas, dates, merged cells, hidden sheets; macro-enabled file opens without macros; corrupt zip refusal |
| S7 | Multiple files + desktop entry points | the B pick, File → Open/Recent, window drop. Finder Open With, Dock drop and launch-if-not-running only for a packaged Helm.app (D7/D8) | pure tests for `open-file` queueing (registered in `will-finish-launching`) and recent list bounds; `tests/helm-side-by-side.test.ts` covers the `openFile` policy key and that the clone has no `CFBundleDocumentTypes`; manual Finder check on a packaged build (`lsregister -f` after Info.plist changes) |
| S8 | Feedback v2 | anchors for text/code (v1 passage), JSON pointer, cells, PDF text, image region; non-passage prompt branch; crop staging within screenshot limits; prompt budget; `anchors-v2` negotiation; memory-only history | anchor → prompt golden tests per kind, including one at the 24 000 limit and one proving a v1 prompt never says "whole document" when an anchor exists; crop downscale to ≤8192 px / ≤4 MB and 4-image budget; v1 caller receives prompt-text anchor + crop line and strict-parses; v2 caller receives `request.anchor`; stale-on-change refusal per format; journal append does not stale an md anchor; disposable real CLI caller proof (existing harness) |
| S8b | Pi package v2 | Pi declares `anchors-v2`; `closed` delivery for Pi (scoped `next`) | `HELM_DOCUMENT_REVIEW_PI` check, installed-loader test |
| S9 | DOCX, media, `.eml`, HTML, MDX | tier-2 views, sandboxed frame, explicit "Open link…" | sandbox tests (script, remote image, form, meta refresh, `<base>`, `<link>`, `javascript:` link, subframe navigation all inert); DOCX embedded images render as `data:`; media range playback; eml with remote images + attachments (attachment opened virtually, never written, magic must agree) |
| S10 | Quick Look fallback + cleanup | `previewFile` tier, dormant code removal, docs rename, journal trailing-newline tolerance | QL opens for PPTX/KEY fixtures (manual), deletion keeps test suite green, journal parser tests for trailing newline |

Proposed order: S1 → S2 → S3 → S4 → S5 → S7 → S6 → S8 → S8b → S9 → S10. Plain viewing of the most common formats lands before the multi-file shell, and feedback v2 starts once the formats it anchors in exist.

## Decisions

D1–D11 and D13: Jakub agreed with the recommendations on 2026-11-09; they are decided. D12 and D14 stay open until he picks from the Storybook variants. No production slice starts before that.

| # | Decision | Options | Status |
| --- | --- | --- | --- |
| D1 | Command model | (a) `helm open` plain, `--listen` / `helm edit` bound; (b) `helm open` binds automatically when run by an agent; (c) separate binaries/verbs | **Decided: (a).** Plain `helm open`; an agent binds only via `--listen` / `helm edit`. Binding stays an explicit choice of the caller; (b) would need to infer the agent from the environment, which the existing design rejects. |
| D2 | Agent opens a file that is already open plain | bind that window (after full feedback admission); open a second, bound window | **Decided: bind the existing window** if it never had an owner and passes feedback admission (keeps scroll and context; the owner indicator appears). Retired-owner windows keep refusing, as today. |
| D3 | Plain-mode access | keep repo-only; allow anywhere readable with the plain-mode table | **Decided: anywhere readable** under the plain-mode access rules: one-descriptor admission, hidden allowed except Helm's private paths (by path and inode); `.jsx/.tsx` shown as source, never executed, outside feedback mode; feedback mode keeps every current rule. |
| D4 | MVP format set | tier 1 only; tier 1 + XLSX; everything up to tier 2 | **Decided: tier 1 first, then XLSX in S6**; tier 2 after feedback v2. |
| D5 | Feedback history for formats without a journal | memory-only; private profile store; sidecar | **Decided: memory-only** feedback history first; private store later if he misses it; no sidecars. |
| D6 | PPTX/Keynote/Pages | Quick Look fallback; text-only extraction; none | **Decided: Quick Look fallback**; text extraction only if slide-level feedback is wanted. |
| D7 | `helm open` when the desktop isn't running | refuse (today); package Helm as its own `.app` and launch it; a small launcher bundle that runs `electron <app dir>` | **Decided: refuse** when the desktop isn't running. Today's shared unpackaged `com.github.Electron` bundle would start Electron's default app; launching becomes possible with packaging, a project of its own. |
| D8 | Finder integration | Alternate handler for supported types on a packaged Helm.app; no registration | **Decided: Alternate handler on a packaged build only** — offered in Finder's Open With, never the default; never on the shared unpackaged `Electron.app`. |
| D9 | SheetJS source | vendor tarball pinned with integrity; `exceljs`; npm `xlsx@0.18.5` | **Decided: vendored SheetJS tarball**, pinned with integrity (npm 0.18.5 is stale with known advisories; exceljs lacks XLS/ODS). |
| D10 | Old-host / not-reloaded-Pi compatibility | negotiate per connection (`hello` then `features`); hard version bump | **Decided: negotiate per connection** (`hello` then `features`), so an old desktop, a Pi process not yet `/reload`ed or Pi from another worktree keep working with prompt-text anchors. |
| D11 | Dormant code | delete `buildReviewInvocation`/`ReviewJsonLines`; keep | **Decided: delete** `buildReviewInvocation`/`ReviewJsonLines` in S10. Still open: Plan documents → Review, decided with the task-list future. |
| D12 | Multi-file model and window chrome | B1/B2/B3, A1–A6 | **Open.** His pick from Storybook; no recommendation. |
| D13 | Feedback on non-journal files outside the agent's workspace (a Downloads PDF) | workspace only; any readable file, with `relativePath` replaced by the canonical path for those | **Decided: workspace only** (S8) for now; widen once he wants it, because it tells the agent where files outside its project live. |
| D14 | Send receipt in the review composer | Today; A composer line; B under your message; C header steps; D send button (see § Send receipt) | **Open.** His pick from Storybook; no recommendation. |

## Open questions

- Should plain viewing work in **inactive profiles' worktrees** too? Plain mode has no profile-bound state, so yes by default; the recent-files list could be per profile or global.
- Should agents be allowed to open files **outside** their workspace in plain mode? A plain open discloses nothing to the agent and its windows open inactive, so the spec allows it; Jakub may prefer a workspace limit for agent-initiated opens.
- Packaging Helm as its own `.app` (unique bundle id) unlocks D7 and Finder Open With; worth its own spec.
- Printing PDFs natively (pdf.js print rendering) vs always handing to Preview.
- Whether `helm open` in the cockpit should ever open inside the main window (a pane) rather than a separate window. Out of scope here.
