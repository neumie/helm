# helm open — a viewer for almost anything

Status: phase 2 (production slices). Phase 1 (spec + design variants) is done. D1–D14 decided by Jakub on 2026-11-09 (§ Decisions), including D12a (window chrome: A6), D12b (multiple files: B4) and D14 (send receipt: E5 with the shared ActivityIndicator, and display-only reading of Claude Code transcripts and Codex rollouts). He gave the go on the slice order on 2026-11-10 (§ Delivery slices); slices land in that order. The design exploration is story-only under `app/src/renderer/open-prototype/` (Storybook `Views/Helm open/…`); Jakub picks the design from there.

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
- Several files open per B4 (D12b): each as its own window, or as tabs of the front window when Open Files as Tabs is on. A refused file does not stop the others; exit code is 1 if any file was refused, and each refusal is one line on stderr naming the file and the fix. Per-file refusals come from the host's `refuse()` messages relayed in the `view` result, not from a thrown CLI error. `open` joins `edit`/`review` in `src/cli/helm.ts`'s error handler, keeping its ZodError/ENOENT/EACCES mapping.
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
| File → Open… (⌘O only while a viewer window is focused, run by the shortcut dispatcher; the menu item carries no accelerator, because macOS ignores `registerAccelerator: false` and would fire it in the cockpit, where ⌘O belongs to the agent dock) | native open panel, any supported type, multi-select |
| File → Open Recent | macOS recent documents (`app.addRecentDocument`, menu role `recentDocuments`) plus Helm's own list, paths only, stored under `<userData>` 0600, capped at 50, cleared from the menu |
| Finder "Open With → Helm" / drag onto Dock icon | `open-file` event → plain viewing. Requires `CFBundleDocumentTypes` with `LSHandlerRank = Alternate` (Helm is offered, never claims the default) — **only on a packaged Helm.app with a unique bundle id** (D8). The shared unpackaged `Electron.app` gets no document types: they would make every checkout and every Electron project an Open With candidate, and a cold launch would start Electron's default app. `app.on('open-file')` registers inside `will-finish-launching` and queues paths until windows can open. Side-by-side: `side-by-side.sh` removes `CFBundleDocumentTypes` from its clone (`plutil -remove`), `startupPolicy()` gains an `openFile` key that is off there, and main ignores `open-file` like it ignores `open-url` |
| Drag a file onto a viewer window | opens it as a tab of that window when it already has tabs or Open Files as Tabs is on, otherwise as its own window (B4, D12b). Dropping an image **onto the composer** keeps today's meaning: attach a screenshot |
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

- **memory-only** per view (decided for S8): threads live while the view is open (a moved tab keeps them), nothing written;
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
- **One in-memory session per viewer view** (one view per window until S7a; § Per-view access keys) (`session.fromPartition('helm-open-<uuid>')`, never `persist:`). `protocol.handle` on the `protocol` module serves only the default session and its handler receives a bare `Request` with no `webContents`, so the `helm-viewer:` handler, the `webRequest` block and the permission handlers are installed on **that window's** `session.protocol` / `session.webRequest`, and removed when the view closes. A token is therefore reachable only from its own view.
- `webRequest.onBeforeRequest` cancels every `http:`, `https:`, `ws:`, `wss:`, `ftp:` and `file:` request. `setPermissionRequestHandler` and `setPermissionCheckHandler` deny everything (`openExternal`, media, notifications, clipboard-read, fullscreen, display-capture, fileSystem, …) — the app installs none today, and Electron's default approves, including `openExternal` launches that `webRequest` never sees.
- Links inside documents (PDF annotations, DOCX/HTML/eml anchors) never navigate: `will-navigate`, `will-frame-navigate` (subframes; only the initial `about:srcdoc` passes) and `setWindowOpenHandler` deny. Sanitized HTML/eml/DOCX output removes `<link>`, `<meta http-equiv=refresh>`, `<base>` and form elements, rewrites `<a href>` to inert text with the URL as a title, and adds `<meta http-equiv=x-dns-prefetch-control content=off>`. Opening an `http(s)` link is a separate, explicit chrome action ("Open link…") that goes through `parseExternalHttpUrl` — a sandboxed frame without scripts cannot report a click to the parent.
- **Viewer protocol.** A privileged scheme `helm-viewer:`, registered before `ready` with exactly `{standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false, allowServiceWorkers: false, corsEnabled: false}`. With `standard`, the first path component is the origin, so everything uses **one host**: `helm-viewer://app/index.html`, `helm-viewer://app/assets/…` (bundle chunks, pdf.js worker, cmaps, standard fonts, wasm — from `dist/viewer/` only) and `helm-viewer://app/file/<unguessable token>`. No path appears in a URL. The handler returns exact MIME types (`text/javascript` for modules, `application/wasm`).
- **File bytes are inert.** `…/file/<token>` responses carry `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and an inert `Content-Type` for text families, and the page CSP forbids loading them as script or worker (below).
- **CSP as a response header** on every `helm-viewer://app` response, workers included (a worker loaded from a URL takes its CSP from its own response, not the page's `<meta>`):
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; font-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'` (`worker-src blob:` added in S2: feedback windows load the same entry and the JSX/TSX canvas Worker is a `blob:` worker, as before), with script/worker sources further restricted to the `/assets/` path in the handler (file tokens never carry a script MIME type). `'self'` also matches the loopback route of the built-entry browser test. `wasm-unsafe-eval` is needed by pdf.js image decoders (JBIG2/JPX); no `unsafe-eval`. A test reads the worker response's CSP.
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
| Several files | B4 (D12b): a window per file, tabs drawn by Helm on demand (Merge All Windows, Open Files as Tabs), a tab dragged out or Move Tab to New Window becomes a window again, ⌘⇧O over tabs, windows and recents (§ Windows and tabs). Common rules: one view per canonical file (opening it again focuses it), ⌘W closes the view, closing the last view closes the window. Plain views have their own soft cap of 32; the 8-window cap, which today counts every review window (`windows.size >= 8`, recovery windows included), will count only bound or feedback-capable views (§ Per-view access keys), so eight plain views never make `helm edit` fail with "Eight review windows are open". |
| Search | ⌘F per format: text/code (CodeMirror search), PDF (pdf.js find, highlights + count), sheet (cell values, jumps to cell), JSON tree (keys and values, expands path), DOCX/HTML/eml (text). ⌘G / ⌘⇧G next/previous, Esc closes. Images have no search. |
| Zoom | ⌘= / ⌘- / ⌘0 go to the viewer's zoom when a viewer window is focused, and to the terminal font step in the cockpit (window-aware dispatcher, see Architecture): PDF/DOCX/image scale, text/code/sheet font size. Pinch on trackpad for PDF and images. |
| Copy | ⌘C copies the native selection; a sheet range copies as TSV; an image copies as PNG (renderer encodes, main writes the checked buffer); a JSON node copies its value as JSON; Copy path in the more menu. |
| Print | ⌘P renders a **non-virtualized** print document (capped at 5 000 lines/rows, with a note when truncated) into a hidden print container, then `webContents.print()`: CodeMirror and the virtualized grid/tree mount only visible rows, so printing the live DOM would print the visible slice. First slices: Markdown, DOCX, text/code. PDFs, sheets and Quick Look formats print through Open in default app until their print documents exist. |
| Reload | View → Reload / Force Reload are disabled (the dispatcher swallows ⌘R / ⌘⇧R) in viewer windows, so a reload never drops bound state or memory-only threads. |
| Open in default app | `shell.openPath` on the identity-checked canonical path, only for an **extension allowlist** derived from the format registry (same model as `isOpenableAttachment`). A denylist would miss `.fileloc`/`.webloc`/`.inetloc`, `.workflow`, `.scpt`, `.mobileconfig`, `.jar`, `.shortcut`, `.terminal`… Unknown or refused types get only Reveal in Finder (`shell.showItemInFolder`). |
| Keyboard-first | Every action has a key and a visible hint in its menu: ⌘O open, ⌘F find, ⌘= ⌘- ⌘0 zoom, ⌘P print, ⌥⌘R reveal in Finder (⌘⇧R is Force Reload), ⌘⇧D default app, Space page down, ⇧Space page up, J/K or ↑/↓ line, PageUp/PageDown, Home/End, ⌘↑/⌘↓ start/end, `[`/`]` previous/next page (PDF) or sheet (workbook). Multi-file keys (B4): ⌘1–9 and ⌃⇥ / ⌃⇧⇥ between tabs, ⌘⇧O go to file (↵ go there, ⌘↵ open in a new window). Feedback mode adds ⌘↵ send and Esc close bubble, as today. New keys go into `shortcuts.ts` reservations. |
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
- `DocumentReviewWindows` gains a view-only open path (no owner, no grant) with its own bound (soft cap 32), and the B4 multi-file container with per-view access keys (§ Per-view access keys). Names stay `document-review` internally; user-facing copy becomes "Helm open" / the file name.
- Quick Look (`win.previewFile(path)`) and the HEIC `sips` child are started from main; no untrusted decode happens in main itself.
- The viewer protocol handler owns per-view tokens and pinned descriptors. The token table, Range parsing, revocation and the URL-blocking predicate are pure modules with injected Electron dependencies, so `node --test` covers them.
- **Window-aware shortcut dispatcher.** `dispatchShortcutInput` learns the window kind: in viewer windows fontBigger/Smaller/Reset go to the viewer's zoom, closeFocused closes the active view (the window only when it is the last view), ⌘O runs File → Open and ⌘R/⌘⇧R are swallowed; in the cockpit nothing changes, and ⌘O is never consumed by the menu, so the agent dock's ⌘O still works. Tests cover both window kinds.

### Per-view access keys (D12b, slice S7a)

Today (`app/src/document-review/window.ts`) one review window is one `BrowserWindow`, and the renderer is identified by that window's single `webContents`:

- `DocumentReviewWindows.windows` is a `Map<webContents.id, WindowState>`; `WindowState.window` is the `BrowserWindow`.
- `require()` looks the state up by `event.sender.id` and calls `requireReviewAccess(state.window.webContents, event.sender, event.senderFrame, state.token, token, current)` (`access.ts`). `state.token` is the **profile token** (`deps.profileToken()`, the cockpit's `<profileId>:<generation>`), shared by every review window of the profile; `openFile` even matches an existing window by `state.token === token` and file. What separates two windows is the sender check: the sender must be that exact `webContents` and the frame its live main frame. `current()` also checks `state.window.isDestroyed()`; the sync `document-review:bootstrap` returns the token on the same check.
- Per window: the `webContents`, the observation (document UUID), the selected caller, the dirty / note-save / file-flight flags and the renderer's memory. Per profile: the draft store (`this.drafts`) and caller sessions (`this.sessions`); per file: the archive context (`this.archives`, reused by recovery).
- Window-level lifecycle: the cancellable `BrowserWindow` `close` guard (dirty draft, note save, file flights, guarded archive) and `document-review:close-requested`; the renderer-confirmed `document-review:close` (sets `allowClose`, then `state.window.close()`); ⌘W in `before-input-event`; `closed` → `sessions.closeDocument(observation.id)` (ends a waiting `helm edit` read with `closed: true`) and `onAllClosed`; `ready-to-show` (shows, or closes when no longer current); `loadFile` failure (`win.destroy()`); `show()` + `focus()` on reopen, `openForCaller` and archive recovery; `closeForProfileSwitch` and `requestCloseAll` (quit) set `allowClose` and close each window; `publish` sends `document-review:changed` to each window's `webContents`; the cap `windows.size >= 8` counts every window, recovery windows included.
- In main.ts the shortcut dispatcher is attached in `app.on('browser-window-created')`, and menu items and `closeFocused` target `BrowserWindow.getFocusedWindow() ?? mainWindow`; `activate` and other callers count `BrowserWindow.getAllWindows()`.

B4 splits the window from the document:

- **One view per document.** Each file is a `WebContentsView` in a `BaseWindow` container. The map becomes `Map<view webContents.id, ViewState>`. `ViewState.view` replaces `WindowState.window` for every access and lifecycle decision; `ViewState.container` is a mutable reference used only to show, focus, title and parent dialogs. What is per window today becomes per view; the profile's draft store and sessions and the file's archive context stay shared references.
- **Access isolation stays the sender check.** `requireReviewAccess` keeps its signature with the view's own `webContents` as the expected sender; the token stays the profile token, so it never distinguishes two views. An event from the container, the strip view or a sibling view is refused, whatever token it presents. `current()` checks the view's `webContents`. Background tabs keep their access (live reload, a waiting caller); focus-dependent actions act on the active view only.
- **Viewer session per view.** The in-memory `helm-viewer:` session, its protocol handler, network block, permission handlers, tokens and pinned descriptors (§ Renderer isolation) belong to the view, survive a move unchanged and are removed when that view closes.
- **Moving is not closing.** Merge All Windows, drag-out and Move Tab to New Window use `removeChildView` / `addChildView`; only `container` changes. A move never calls `closeDocument` and never sends `closed: true` to a waiting `helm edit`. That a reparented view keeps its `WebContents` without a reload is checked in the S7a canary before S7b builds on it.
- **Closing is per view.** `BaseWindow`, `WebContentsView` and `WebContents` have no `ready-to-show` and no cancellable per-view close, so: showing after load moves to `loadFile` resolution; the close guard becomes a main-side predicate checked before a view closes and in the container's `close` listener; `document-review:close`, ⌘W and a load failure close only that view; `closeDocument` and `onAllClosed` run from the view's own close path (or its `webContents` `destroyed`), never from the container's `closed`. Closing a container closes its views one by one: a dirty view cancels the container close and asks in its own tab, the clean views stay open until the user decides. The container's `closed` closes any remaining view's `webContents`, because a `BaseWindow` does not destroy its child views' `webContents` (Electron documentation; checked in the S7a canary).
- **Focus selects the tab.** Reopen, `openForCaller`, archive recovery and a ⌘⇧O pick select that view's tab in its container, then show and focus the container, so a bound or recovery view never stays hidden behind another tab. A wire `view` (`helm open`, an agent) never takes focus (§ Renderer isolation): with Open Files as Tabs on it joins the front window as a background tab, and the no-effectful-key-before-a-gesture rule is per view.
- **Profile switch and quit.** `closeForProfileSwitch` and `requestCloseAll` drain and set `allowClose` per view as today, close every view, then destroy the strip views and containers. `hasDirty`, draining and the caps iterate views.
- **Publish and caps count views.** `document-review:changed` goes to each view's own `webContents`, background tabs included, never to a strip view. The 8 feedback cap counts bound or feedback-capable views; plain views have their own soft cap of 32.
- **The cockpit's shortcut path learns containers.** The dispatcher attaches to each view's `webContents` when the view is created (a `BaseWindow` never fires `browser-window-created`). Menu items and `closeFocused` resolve a focused container through `BaseWindow.getFocusedWindow()` and its active view, and never fall back to `mainWindow` while a viewer container is focused; otherwise ⌘W or File → Close in a review window would close a cockpit terminal tab and the font keys would step the terminal font. `activate` and the other `BrowserWindow.getAllWindows()` callers are rechecked.
- **Tab strip is its own view** (S7b). A merged window draws its strip in the title row from a separate strip view with a narrow preload: names, kinds, order, select, close, reorder, drag-out. It gets no document bytes, tokens, drafts or feedback IPC, and main authenticates it as that container's strip (sender, main frame, container).
- **⌘⇧O** (S7b). Main builds the list (tabs of this window, other windows, recents) from its own state; it is display-only, never forwarded to an agent. A pick returns an opaque view id that main re-validates against the current container and profile before selecting it.

A mistake in any of these would let one document's renderer act on another's, end a caller's read on a move, or send a viewer shortcut to the cockpit. S7a lands this keying with one view per container and no visible change, before any tab exists.

### Renderer

- `app/src/renderer/document-review.tsx` becomes the viewer host: chrome (A6, D12a), file container (B4, D12b), the chosen format view (C), and in bound mode the existing companion/passage chat plus the new anchored feedback bubble (D).
- Markdown and the JSX/TSX canvas move behind the registry unchanged; `DocumentReview.tsx` keeps owning their passage chat.
- Build: the document-review entry switches from one IIFE to ESM with code splitting (`format: 'esm', splitting: true`) served by `helm-viewer:`; the base chunk must not grow by more than the chrome itself.

### Wire

- **Version is learned from `hello` only.** An old host answers an unknown action or key with the same generic `UNCERTAIN_REVIEW_FAILURE` text it uses for any failure, so nothing on the wire tells "old host" apart from other failures (and an old host logs one `[helm] review: unparsed failed` line per probe). Every new CLI path (plain `view`, `--listen` / `helm edit` connect) therefore sends an effect-free `{action: 'hello'}` first. The new host answers `{protocol: 2, features}` from a synchronous handler with no generic-error path, so a transient failure cannot quietly downgrade a v2 caller. A `hello` reply that is exactly `UNCERTAIN_REVIEW_FAILURE`, or malformed, means "old host": `--listen` / `helm edit` speak v1, and plain `helm open` prints "Update the Helm desktop to use helm open" without sending `view`. The version is never inferred from a failed `view` or `connect`.
- In the new host an unknown `action` or unknown connect key becomes a definite `refuse('Unknown review command …')`, so future versions can tell the cases apart.
- New command `{action: 'view', files: path[]}` for plain viewing, authenticated by the discovery token, **no** connection/owner, rate-limited and opening windows inactive (see Renderer isolation).
- New optional `features` on `connect` (`['session-hint']` from S12, `['anchors-v2']` from S8), sent only after a successful `hello`; `session-hint` adds the optional provider session id to the connection.
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

- **A Window chrome** — three chromes (A1–A3), plus three A1 × A3 hybrids after Jakub asked for "something between A3 and A1" (A4 path then name, A5 name then path, A6 collapsing path) and a long-path comparison; each plain and bound. **Picked: A6** (D12a).
- **B Multiple files** — tabs, a window per file with a go-to-file palette, a file sidebar, and B4: a window per file and tabs together, after Jakub said "I quite like B2, but it could be B1 too. Both." (see § Windows and tabs). **Picked: B4** (D12b).
- **C Format views** — PDF, spreadsheet (XLSX + CSV), image, JSON, code, documents (Markdown, DOCX).
- **D Feedback anchors** — PDF text selection, spreadsheet range, image region (plus JSON node and code lines).
- **E Send receipt** — what the window says right after Send (D14, below): Today plus four variants, each with frames for sending, received, working, replied, not sent, not confirmed and a passage send; and E5, an activity line in Claude Code's style, after Jakub said "probably neither of them". **Picked: E5**, drawn with Helm's ActivityIndicator (D14).

Jakub picked A (A6, D12a), B (B4, D12b) and E (E5, D14); C and D are proposals for the per-format behaviour and are expected to be adjusted rather than picked.

### Windows and tabs (D12b, B4)

macOS native window tabbing does not work for Helm's windows, so "both" means Helm draws its own tabs. Electron 43 (installed) gives a window a native title bar only when `frame` is true **and** `titleBarStyle` stays `'default'` (internally `TitleBarStyle::kNormal`, `shell/browser/native_window.cc`), and it sets `NSWindowTabbingModeDisallowed` on every window without one, and on transparent windows (`native_window_mac.mm`, "Create a tab only if tabbing identifier is specified and window has a native title bar"). The prototype title row assumes `titleBarStyle: 'hidden'`, like the review window (`app/src/document-review/window.ts:740`), so `tabbingIdentifier`, `mergeAllWindows()`, `moveTabToNewWindow()`, the tab menu roles and the user's "Prefer tabs when opening documents" setting all do nothing. Electron declined to change this (electron#10038, closed wontfix 2020); VS Code's `window.nativeTabs` likewise forces the native title bar. Native tabs would cost the custom 40px title row, the agent button in it and `trafficLightPosition` (applied only to frameless windows), and whether a file opens as a tab would depend on a system setting.

B4 (Storybook `Views/Helm open/B Multiple files → B4 Windows and tabs`, frames Windows / Merged into tabs / Window menu / Go to file ⌘⇧O):

- **Files open as windows** (B2) unless Open Files as Tabs is on. Each window is a real macOS window: ⌘\` cycles, Mission Control and the Window menu list it.
- **Tabs on demand** (B1): Window → Merge All Windows puts every viewer window into one window's tab strip, drawn in the title row; Window → Open Files as Tabs (off by default) makes new files open as tabs of the front window. A tab dragged out of the strip, or Move Tab to New Window, becomes a window again. ⌃⇥ / ⌃⇧⇥ and ⌘1–9 move between tabs.
- **⌘⇧O over both**: tabs of this window first, then other windows, then recent files; ↵ goes there, ⌘↵ opens in a new window.
- **Window menu**: `role: 'window'` with Helm's own submenu; both `'window'` and `'windowMenu'` make AppKit list the open windows, and `'windowMenu'` without a submenu also adds Zoom. Helm adds Go to File…, Open Files as Tabs, Show Previous/Next Tab, Move Tab to New Window, Merge All Windows.

Picked as D12b. Tabs mean one `BaseWindow` with one `WebContentsView` per file, moved between windows on merge/drag-out, so the access check and per-window state move to per-view keys (§ Per-view access keys, slices S7a and S7b). Plain and bound views may share a merged window. Plain views' own soft cap of 32 (§ Behaviour) is needed as well, since `DocumentReviewWindows` refuses a ninth window. Unverified until a side-by-side build: whether AppKit adds its own tab or full-screen items once the Window menu has `role: 'window'`.

## Send receipt (D14: E5)

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

### E5 activity line (Storybook `E Send receipt → E5 Activity line`) — picked

Claude Code's "Vibing… (2m 57s · ↓ 16.3k tokens)" idea, drawn the Helm way under the conversation that sent: the shared §3.21 `ActivityIndicator` (six-dot Braille matrix, grayscale progress variant, the global reduced-motion clamp) instead of Claude's orange ✻, then the verb, elapsed time and output tokens. No colour anywhere and no new token. The indicator shows only while the caller is seen working; other phases keep an empty 6px slot so the text stays on one edge. While working, the verb uses `.activity-indicator-label` (§3.21 breathing copy). One screen-reader status stays mounted through every phase, replied included, and its text changes only with the phase or the verb (`With Claude Code`, `Claude Code: Editing`, `Claude Code replied`), so a screen reader hears "Editing" once, never the clock; the indicator itself keeps a static label and the visible line stays readable. `↓` is hidden from assistive tech and read as "16.3k output tokens".

Frames: Received ("With Claude Code… (2s)", no indicator: the tool has the message, nothing says the agent works on it) → Working · Claude Code / Codex / Pi (indicator + "Editing… (2m 57s · ↓ 16.3k tokens)") → Replied (dim "Worked for 3m 5s · ↓ 16.3k tokens", or "Replied after 3m 5s" when nothing was bound; kept until the next send); Tokens unknown ("With Claude Code… (2m 57s)", elapsed only, never "working"); Not sent (variant A: the reason next to the composer, the message back in the editor) and Not confirmed (today's panel with "I checked the outcome") unchanged; two live "Try it" frames. The verb is a generic word from the last tool's name (Reading, Searching, Editing, Running a command), "Thinking" while a model request is in flight; never tool input, file names or text.

Where each field would really come from (checked 2026-11-09 against Claude Code 2.1.x and Codex 0.160.1):

| Field | Claude Code caller | Codex caller | Pi caller |
| --- | --- | --- | --- |
| Elapsed | Helm's own clock from the ack. Real for every caller today. | same | same |
| Working | Its transcript `~/.claude/projects/<launch-cwd>/<session>.jsonl`: an `api-request` record (~3.7 s before each response) or a new assistant record after delivery. | Its rollout `~/.codex/sessions/…/rollout-*.jsonl`: `task_started`, `task_complete`, `turn_aborted`. | Already reported (`working`), in process. |
| Tokens | Sum of `message.usage.output_tokens` over distinct `message.id` since delivery. Moves in steps: each response is written whole when it ends, so a single long response (up to ~2.5 min seen) shows no movement. Counts from your message, not from the turn start like Claude's own spinner, so the numbers differ. | `token_count` events (`output_tokens` minus the value at ack). Steps every ~12 s (p50) to ~38 s (p90). Whether it includes reasoning tokens is unverified. | `AssistantMessage.usage.output` per message end; needs one new optional field on the reply report. |
| Verb | Last `tool_use` name, mapped to a generic word (hide `mcp__server__` names). | Last function-call name, mapped the same way. | From Pi's tool events. |
| Binding | `helm edit` sends `CLAUDE_CODE_SESSION_ID` (documented, set for Bash children) as a hint; Helm binds only after a main-thread record **after** the ack contains the exact delivered request id. | `CODEX_THREAD_ID` (set for shell children) must equal the rollout file's UUID and `session_meta.payload.id` (not `session_id`, which subagent threads share), plus the request id in the tool output; later exactly via `CODEX_TOOL_CALL_ID` once Codex ships it. | Not needed. |
| Update latency | ~1 s Helm poll; the data itself moves per completed response (seconds to minutes). | ~1 s poll; data about every 12 s (p50), 38 s (p90). | Per message end. |

Alternatives weighed: an explicit `helm edit working HANDLE` (cheap, no tokens, but depends on the agent remembering an extra tool call each time, costs a model call); Claude Code hooks (Helm's hook hub covers only Claude in Helm terminals); Okena's Claude API (`busy`, transcript) for callers in Okena panes only; Codex `PostModelRequest` hook (not in installed 0.160.1, same cadence, needs a global config edit). Decided with E5: transcript/rollout reading is the main path; `helm edit working` (proposed, not built) stays an optional fallback.

### Policy change: provider session files, display only (decided with D14)

Jakub allowed Helm to read a bound caller's Claude Code transcript and Codex rollout file for the working state, verb and output tokens. Rules:

- **Display only, never trusted.** Under the same-user threat model any process of the user can append a forged record, so what Helm reads feeds the activity line and nothing else, with one exception: **deadline renewal**. Observed bound activity may move the completion deadline of the exact owner and request id that are still pending to min(last bound activity + 15 min, ack + 2 h) (numbers proposed, confirmed in S11). It never revives an expired or settled request, never hides "I checked the outcome", and a forged record can at most keep a request open until the 2 h cap. Reads never confirm delivery, settle a request, authorise a reply, change a receipt outcome or reach the journal, and are never forwarded to an agent.
- **Linked by session id, as proposed.** `helm edit` sends the provider's own session id as a hint (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`); Helm binds a file only after a main-thread record written **after** the ack contains the exact delivered request id (Codex: the file's UUID and `session_meta.payload.id` must match the thread id too). The request id is found by scanning, in memory, only the tool result of the bound `helm edit` call; nothing from it is kept or logged, only match or no match. No binding → the elapsed-only line.
- **Read-only and bounded.** Never write, rename, lock or delete a provider file; never read provider config, auth or any other session. Realpath under the provider's root (`~/.claude/projects` or `CLAUDE_CONFIG_DIR`; `~/.codex/sessions`), `O_NOFOLLOW`, own uid, regular single-link file, bounded appended reads, sharing the existing readers rather than adding parallel ones: the agent dock's `claude-transcript-tail.ts` for Claude Code, and Remote's `src/remote/usage-sources.ts` (which already reads `~/.codex/sessions` rollouts for the last `token_count`) for Codex; keep only record types, ids, timestamps, token counts, stop reasons and tool names, never text, tool input or results (except the request-id match above). The tailers live in Electron main next to `DocumentReviewWindows`, not in the control server.
- **Fail closed.** Unknown shapes, compressed or migrated storage, a lost file or a version change fall back to the elapsed-only line, never to a guess.
- **When working stops.** "Working" lasts only while bound evidence says so: a main-thread assistant record that ends its turn (`end_turn`, Codex `task_complete` / `turn_aborted`) without a reply drops the line to elapsed-only "With <agent>…" with no indicator, and so does a tool call with no newer record for 30 s, because a permission prompt or a question in the terminal cannot be told from a long tool run (§3.21: never infer waiting or progress from heuristics).
- **State is keyed by owner, request id and document UUID**, never by window or `webContents`, so the S7a re-keying and tab moves carry it unchanged.
- **Existing reads.** Helm's Remote usage page already reads Codex rollouts and the agent dock reads Claude transcripts; this policy adds Document Review's display-only reads under the same guards and does not change those.

Rule edits that go with it (made in the slices named; listed here so none is missed):

- `docs/document-review.md` line 5: "…types into terminals, or reads/writes provider session files." → never **writes** provider session files; it reads a bound caller's Claude Code transcript or Codex rollout only for the display-only activity line, under the rules above (S12).
- `docs/document-review.md` line 31: "No Pi installation, automatic reload, session-file access, or terminal input is involved." → the same display-only exception (S12).
- `docs/document-review.md` line 17: "An unspecified provider is honestly displayed as **Agent** (`provider: cli`), not inferred from the environment, process, or a retained terminal screen." → `helm edit` passes `--agent claude` or `--agent codex` when exactly one marker is in its environment (`CLAUDECODE`, `CODEX_THREAD_ID`), otherwise `cli`. The value is recorded like an explicit `--agent`, including the journal thread's `provider` (the enum old parsers already accept); it is a label, never authority (S11).
- `docs/document-review.md` line 101 ("Response completion deadline: 15 minutes; a missing reply becomes unknown…") and AGENTS.md ("Completion timeout is15min") → renewable by a `working` report (S11) or bound activity (S12) up to the cap above.
- The same provider rule elsewhere (S11): `src/cli/edit.ts:27` help text ("An unspecified provider is displayed honestly as Agent, never guessed."), `src/document-review/types.ts:5` comment, `packages/helm-document-review/README.md:13` and `skills/helm-document-review/SKILL.md:20`, and the `DocumentReview.stories.tsx:93` story description. `packages/helm-document-review/README.md:13` also says "no provider/session file access" (S12). `src/document-review/control-server.ts:42` ("No … session-file access") stays true because the tailers live in Electron main.
- `AGENTS.md`, Document Review bullet "Existing-session callers only": "never start/resume another agent, type into a terminal, or read/write provider sessions" → never write provider sessions; display-only reads per this section (S12). The same bullet's "honestly uses provider `cli`/display **Agent** when unspecified" gets the env-marker rule (S11).
- `AGENTS.md`, Document Review bullet with "Normal pending/dispatched receipts stay internal with no success panel", and `docs/design-system.md` § Native document review workspace (line 762, same rule) → the E5 activity line; unknown/rejected/recovery keep every existing fence. `docs/design-system.md` also gains the E5 line itself (placement, §3.21 indicator, copy), and `app/browser-tests/document-review.spec.ts`'s no-success-panel assertions change with it (S11).
- `AGENTS.md` Remote bullets that mention session files (`helm-remote-bridge`, history reader) belong to another subsystem and stay unchanged.

Prerequisites and risks:

- **15-minute deadline (prerequisite).** Today `ReviewSessions.confirm` arms a fixed 15-minute completion timer (`responseDeadlineMs`); when it fires the pending feedback is cleared as unknown, so the agent's later real `helm edit reply` is **rejected and lost**, and a `working` report does not renew it. Before the line can say "working" for longer than that, a `working` report (S11, Pi) or freshly observed bound activity (S12) renews the completion deadline, with an absolute cap so a forged or looping record cannot hold a request open forever. Renewal is the only effect activity has; it never settles anything.
- **Reply sequence clash (prerequisite for any `helm edit` working report).** `helm edit reply` always sends sequence 0, and `ReviewSessions.report` ignores a lower sequence and refuses a different report at the same one; a working report before it would make the final reply collide or be dropped. Session-file reading (S12) sends no report and does not need this; the optional `helm edit working` fallback is blocked until sequences are monotonic across CLI processes (for example a host-issued next sequence in each handle).
- **Telling Claude Code from Codex (prerequisite).** `helm edit` adds `--agent cli` ("Agent") unless `--agent` is given (`src/cli/edit.ts:148`), so the window cannot tell Claude Code from Codex. The CLI passes the existing `--agent claude|codex` itself when exactly one marker is in its environment (`CLAUDECODE`, `CODEX_THREAD_ID`), else `cli`; the provider value already exists on the wire, so no negotiation (S11). Both markers are inherited by child processes, so `helm edit` run by another tool started from a Claude Code shell is labelled Claude Code; the activity line shows provider-specific progress only after the S12 binding confirms the session. Only the new session hint needs negotiation: a `session-hint` feature in `features` on connect, sent after a successful `hello` (S1, D10), because the strict wire rejects unknown fields on older hosts.
- **Degraded callers.** A marker inherited from an outer shell (wrong label, no binding), subagents, a backgrounded `helm edit` (Claude's Bash timeout defaults to 2 min, max 10 min unless `BASH_MAX_TIMEOUT_MS` is raised, below the one hour `helm edit` asks for), `/clear`, a different `CLAUDE_CONFIG_DIR`, unknown record shapes → no binding → "With Claude Code… (2m 57s)", elapsed only, never "working".
- **Format drift and size.** Both file formats are undocumented and change between versions. Codex rollouts being plain `.jsonl` while live is unverified on 0.160.1; finished local sessions are `.jsonl.zst` and may move to paginated/SQLite storage; parsers fail closed to the degraded line. Transcripts can be tens of MB: bounded appended reads under the guards above.
- **Codex sandbox.** Sandboxed Codex modes may block the `helm edit` socket connect at all (unverified; Jakub runs full access).

### What changes for E5

- The design-system and AGENTS rule that pending/dispatched stay internal, and the `document-review.spec.ts` assertions that no success panel renders, are rewritten for the E5 line (rule edits above).
- The opt-in seam (`send-receipt-view.ts`, the `sendReceipt` slots) becomes the production path for E5 alone or is replaced by a direct implementation; variants A–D leave production code; the story-only staged host stays in Storybook.
- The existing preload bug is fixed: a transport error ("Helm could not confirm this operation…") is Not confirmed, never Not sent, so the draft is not put back as if nothing was sent.
- Host timestamps on receipts and messages replace the window's own clock for elapsed time. They stay out of the private wire: receipts reach CLIs unchanged through `control.ts` and the strict `receiptSchema`, so the control result projects `{id, outcome, detail}` only (v1 byte-compat test).
- Every working state in the viewer chrome (A6's agent button, B4, the thread "Working…" line) uses the same §3.21 indicator; no ✻ glyph and no accent (the A6/B4 stories were updated to match).

## Delivery slices

Each slice is shippable alone, keeps every existing test green, and does not change the in-file journal.

| # | Slice | Ships | Test plan |
| --- | --- | --- | --- |
| S1 | `helm open` for today's formats | `helm open FILE…` plain viewing of Markdown (no repo needed, rules per table) — plain `.jsx/.tsx` refuses with "Use helm edit to preview components" until S2's code view exists; `--listen` = `helm edit`; `hello` + `view` wire with definite unknown-command refusals; window-aware shortcut dispatcher; inactive `view` windows; separate plain-view bound; stale copy fixes | CLI unit tests (args, `--listen` with two files refused before connect, refusal lines, `--json`); wire tests: `hello` against a fake old host → v1 / update message, never inferred from `view`; v1 byte-compat fixtures for every existing result; admission tests: FIFO, `/dev` symlink, symlink swapped after realpath, hard link to a `~/.helm` file all refused; binding a plain-opened hidden or hard-linked `.md` with `--listen` is refused; 8 plain views do not refuse `helm open --listen`; dispatcher tests for both window kinds; existing `document-review*.test.ts` and `callers` suite unchanged |
| S2 | Viewer host + registry + protocol | registry, `helm-viewer:` protocol on per-view sessions (one view per window until S7a), network/permission block, ESM split build, text/code view (CodeMirror, incl. plain `.jsx/.tsx` as source), JSON/YAML/TOML tree | format detection table tests (extension × magic × refusal, `foo.test.tsx` accepted, `.tar.gz` refused); size-limit tests; **pure-module** `node --test` for the token table, Range parsing (416, clamping, caps), revocation and the URL-blocking predicate; worker CSP header test. The existing `document-review-native-entry.spec.ts` changes: it serves every dist chunk with correct MIME types and matches `type="module"`. Real-session network block and per-window token isolation are a canary/manual proof that respects the no-co-tenant rule (no Electron e2e harness exists). Playwright story tests for code/JSON keys/search |
| S3 | Images | header-dimension check, raster, SVG-as-image, HEIC via `sips` child, zoom/pan/1:1, copy as PNG buffer | header reader fixtures per format (missing/contradictory dims refused, 151 MP refused with numbers); SVG with `<script>` and external `<image href=https>` renders without executing/loading (browser test); real `sips` HEIC fixture → PNG, empty result refused; EXIF orientation fixture |
| S4 | PDF | pdf.js viewer, text layer, find, page nav, outline; S4b password prompt | fixtures: text PDF, scanned image PDF, CJK (cmaps), JBIG2 (wasm), a PDF with JavaScript + launch action + remote link (nothing runs, nothing loads), 500-page lazy fetch asserting peak worker memory and the fetch pattern, file changed mid-stream ends the stream and reloads, find count |
| S5 | CSV/TSV grid | streaming parse, virtual grid, header detection, copy range as TSV | 1 M-row fixture timing budget and last row reachable, quoted newlines, BOM, semicolon CSV detection, wide (500 columns) layout |
| S6 | XLSX/XLS/ODS | sheet tabs, cached values, formula text, number formats, merged cells | workbook fixtures with formulas, dates, merged cells, hidden sheets; macro-enabled file opens without macros; corrupt zip refusal |
| S7a | Per-view access keys (D12b) | review and viewer windows become a `BaseWindow` with one `WebContentsView` each; state, token, access check, close guard, `closeDocument` and caps keyed per view (§ Per-view access keys). No visible change | pure-module tests with fake views: an event from view A presenting the valid profile token refused against B's state, and from the container's `webContents` refused; `document-review:close` from one view of a container leaves the others open; a moved view keeps its viewer-session tokens and a sibling's tokens are refused from it; a moved view keeps key, token, document UUID and caller binding and sends no `closed`; closing a tab sends `closed: true` exactly once; a container close with one dirty view cancels and keeps the others; closing a container closes every view's `webContents` and sends `closed: true` once per bound document; profile switch and quit close every view; recovery of a background view selects it; `document-review:changed` and the E5 activity state reach background views and never a strip, and a moved view keeps its activity line; caps count views; ⌘W, File → Close and the font keys in a focused container never reach the cockpit. Every existing `document-review*.test.ts` and the `callers` suite stay green. Canary (side-by-side instance, no co-tenant): a view moved between two `BaseWindow`s keeps its `WebContents` without reload, and closing a container destroys its views only through Helm's close path |
| S7b | Multiple files (B4) + desktop entry points | Helm-drawn tab strip, Merge All Windows, Open Files as Tabs (off by default), drag a tab out, Move Tab to New Window, ⌃⇥ / ⌘1–9, ⌘⇧O over tabs, windows and recents, Window menu (`role: 'window'` plus Helm's items); File → Open/Recent, window drop. Finder Open With, Dock drop and launch-if-not-running only for a packaged Helm.app (D7/D8) | a strip sender refused for document IPC and a document sender for strip IPC; a palette pick for a view of another container or profile refused; a wire `view` with Open Files as Tabs on joins as a background tab without focus; tab and palette Storybook/Playwright tests over the production strip and palette; drag-out and merge keep a bound view's caller listening; pure tests for `open-file` queueing (registered in `will-finish-launching`) and recent list bounds; `tests/helm-side-by-side.test.ts` covers the `openFile` policy key and that the clone has no `CFBundleDocumentTypes`; manual check whether AppKit adds tab or full-screen items to the Window menu; manual Finder check on a packaged build (`lsregister -f` after Info.plist changes) |
| S8 | Feedback v2 | anchors for text/code (v1 passage), JSON pointer, cells, PDF text, image region; non-passage prompt branch; crop staging within screenshot limits; prompt budget; `anchors-v2` negotiation; memory-only history | anchor → prompt golden tests per kind, including one at the 24 000 limit and one proving a v1 prompt never says "whole document" when an anchor exists; crop downscale to ≤8192 px / ≤4 MB and 4-image budget; v1 caller receives prompt-text anchor + crop line and strict-parses; v2 caller receives `request.anchor`; stale-on-change refusal per format; journal append does not stale an md anchor; disposable real CLI caller proof (existing harness) |
| S8b | Pi package v2 | Pi declares `anchors-v2`; `closed` delivery for Pi (scoped `next`); Pi output tokens and tool verb for the E5 line as optional negotiated report fields (one package update, not two) | `HELM_DOCUMENT_REVIEW_PI` check, installed-loader test |
| S9 | DOCX, media, `.eml`, HTML, MDX | tier-2 views, sandboxed frame, explicit "Open link…" | sandbox tests (script, remote image, form, meta refresh, `<base>`, `<link>`, `javascript:` link, subframe navigation all inert); DOCX embedded images render as `data:`; media range playback; eml with remote images + attachments (attachment opened virtually, never written, magic must agree) |
| S11 | Send receipt E5, without session files | the E5 line in the companion and passage bubble (Sending → With <agent> + elapsed → Replied / Replied after); Pi working shows the indicator, "Thinking" and elapsed; `helm edit` passes `--agent claude\|codex` from exactly one env marker; a `working` report renews the completion deadline (absolute cap); host timestamps on receipts and messages; preload transport error shown as Not confirmed; Not sent reason next to the composer; variants A–D removed; the S11 rule edits (`docs/document-review.md` line 17, AGENTS.md, design system) and `document-review.spec.ts` updated | browser tests over the production line (phases, §3.21 indicator only while working, label changes only with the verb, reduced motion); `deriveSendActivity` pure tests; CLI tests for `--agent` from env (no marker, one, both, explicit `--agent` wins); sessions tests: a working report renews the deadline up to the cap, a reply within a renewed deadline is accepted, after the cap it is still unknown and never replayed; preload transport error → Not confirmed with the draft kept; the `receipt` control result stays byte-identical to v1; `tests/document-edit-cli.test.ts` and `tests/document-review-canvas-native.test.ts` delete `CLAUDECODE` / `CODEX_THREAD_ID` from the env they give the spawned `helm edit` (they run inside agents and assert `provider: cli`); every other existing `document-review*.test.ts` and `callers` test stays green |
| S12 | E5 progress from session files (Claude Code, Codex) | the `session-hint` feature on connect (D10); bounded read-only tailers in Electron main for Claude Code transcripts and Codex rollouts, sharing `claude-transcript-tail.ts` and `src/remote/usage-sources.ts`; binding by session id + exact request id after the ack; verb mapping, output-token sums and the stop conditions; observed bound activity renews the completion deadline (same cap); the S12 policy rule edits in `docs/document-review.md`, AGENTS.md and the Pi package README | recorded-fixture tests per provider (Claude 2.1.x transcript, Codex 0.160.1 rollout): binding only after the ack with the exact request id, a subagent / sidechain / other-session record never binds, token sums over distinct `message.id`, unknown shapes / `.zst` / a version change fail closed to elapsed only; file guards (symlink, hard link, other uid, outside the root, growth past the bound); a forged record cannot settle, confirm or renew past the cap; `end_turn` without a reply and a tool call silent for 30 s drop to elapsed only; an old host or old CLI keeps the S11 line; disposable real CLI caller proof (existing harness) shows working and tokens for Claude Code and Codex |
| S10 | Quick Look fallback + cleanup | `previewFile` tier, dormant code removal, docs rename, journal trailing-newline tolerance | QL opens for PPTX/KEY fixtures (manual), deletion keeps test suite green, journal parser tests for trailing newline |

Final order (D1–D14 decided; go given 2026-11-10): **S11 → S1 → S12 → S2 → S3 → S4 → S5 → S7a → S7b → S6 → S8 → S8b → S9 → S10.**

Progress:

- **S11 implemented** (2026-11-10). The line lives in `app/src/renderer/document-review/send-activity.ts` (pure phases, spelling) and `SendActivity.tsx`; the story-only `sendReceipt` seam, `send-receipt-view.ts` and variants A–D are gone, and the E story at the same URL now drives the production line through the staged host. `ReviewState.activity` (renderer-only, display-only, keyed by session + request id) is the seam S12 fills from bound session files; the host leaves it empty until then, so production Claude Code and Codex callers show elapsed time only. Deadline renewal is `armCompletion` in `ReviewSessions` (15 min after delivery or the latest accepted `working` report, capped at 2 h after delivery); the control wire projects receipts through `wireReceipt`.
- **S1 implemented** (2026-11-10). `src/cli/open.ts` (`helm open FILE…`, `--json`, `--listen` = `helm edit`), wire protocol 2 in `src/document-review/protocol.ts` (`hello` → `{protocol, features: []}`, `view`; unknown commands and command fields refused definitively), plain admission in `app/src/document-review/viewer-file.ts` (`readViewerFile`, deny by path and by inode within a bounded walk of Helm's private roots), plain windows in `DocumentReviewWindows.viewFile` (inactive `showInactive`, reused per file, 32-window bound separate from the 8 feedback windows; binding with `helm edit` reruns the feedback admission in `bindPlainWindow`) and the window-aware dispatcher in `app/src/window-shortcuts.ts`. Choices made here: plain Markdown is capped at the renderer's 512 KiB budget (not the formats table's larger figure) until a streaming reader exists; `--reveal` / `--default-app` refuse "not available yet"; the `connect` `features` field waits for S12, its first user; plain windows close on profile switch like feedback windows; reading zoom is font scaling of the reading area, also in feedback windows.

- S11 first: it fixes the problem Jakub reported (nothing confirms Send) on today's review window, with no wire change and no session-file reading.
- **S12 implemented** (2026-11-10). `session-hint` is the first connect feature (`REVIEW_FEATURES`; `features` + `session` on connect, unknown features and a session without the feature refused definitively); `helm edit` sends it only after `hello` lists it (`sessionHintFields` in `src/cli/review.ts`). The hint lives on the mailbox owner, never the snapshot or wire. Electron main's `ReviewActivityWatcher` (`app/src/document-review/activity-watcher.ts`) polls every second only while a hinted request is confirmed and pending; pure parsers in `activity.ts`; the strict reader `src/provider-files/bounded-jsonl.ts` is now shared with the agent dock's `claude-transcript-tail.ts`, and Codex discovery `src/provider-files/codex-rollouts.ts` with Remote usage. `ReviewSessions.renew` is the only effect (exact pending request, never shortens, capped). Choices made here: the binding record is any main-thread tool result/output after the ack carrying the exact id, not only the `helm edit` call's own result, because Claude may move a long call to the background and Codex returns long-running output through a later `write_stdin` poll; an unknown or MCP tool shows the verb "Working"; a Claude turn also ends at any non-`tool_use` stop, an Esc interrupt record or the main thread's `stop_hook_summary`/`turn_duration` (seen after nearly every turn in real 2.1.3xx transcripts), and parallel tool calls keep the 30 s rule until the last result; Codex tokens count from the last `token_count` before the first model output after binding (the count written right after the tool output still belongs to the response that called `helm edit`). Fixtures are real `claude -p` 2.1.322 and `codex exec` 0.160.1 recordings redacted to structure (`tests/fixtures/document-review-activity/`); the opt-in live proof (`tests/document-review-activity-live.test.ts`, `HELM_DOCUMENT_REVIEW_CALLER_PROOF=1`) ran both: Claude Code saw Thinking → Running a command and 951 output tokens, Codex 253, both frozen after the reply; rerun after the review fixes: Claude Code 268 tokens (only Thinking seen in that run), Codex Thinking → Running a command and 230. Not certified: interactive (non `-p`) Claude Code and Codex TUI sessions, and the desktop window rendering of a live line (Storybook already drives `SendActivity` from `ReviewState.activity`).
- **S2 implemented** (2026-11-10). Registry `src/document-review/formats.ts` (pure; detection, magic, encodings, limits: text/code 16 MiB + 1 M lines, data 32 MiB, plain Markdown still 512 KiB); plain admission now reads text families with a kept descriptor (`readViewerFile`, `pinnedViewerSource`). Main: `helm-viewer:` registered privileged before `ready`; per-window in-memory session (`viewer-session.ts`: handler, network block, deny-all permission request/check handlers, `will-navigate`/window-open denied) for plain and feedback windows alike; `viewer-protocol.ts` serves `dist/viewer/` assets with exact MIME types and the CSP header, and `file/<token>` with Range/HEAD, 409 after a change, octet-stream + nosniff + sandbox CSP; tokens per readable version, revoked with the version and on close. Renderer: ESM split build (`dist/viewer/assets`), `PlainViewer` with read-only CodeMirror (`CodeView`, ~50 languages lazily, `.jsx/.tsx` as source) and the data tree (`DataView`, virtualised, worker-parsed JSON/JSONL/YAML/TOML, JSON Pointer status, find that reveals the path, ⌘C as JSON, Raw source toggle), status line with language/lines/encoding/ending/size, live reload keeping the position. Choices made here: the CSP keeps `worker-src blob:` (above); YAML resolves `<<` merge keys; a tree node lists at most 10,000 children then `N more not shown`; copy refuses past 4 MiB; Latin-1 and other legacy encodings refuse (UTF-16 with a BOM decodes); the daemon root's `profiles.json` joins the private files now that `.json` is shown; a touch/chmod with unchanged bytes replaces the file token (its pinned identity moved); integers past 2^53 stay exact in JSON, JSON Lines and YAML as in TOML; YAML `!!omap`/`!!set`/`!!binary` show as object, list and base64; plain Retry rereads the file; a live reload edits only the changed span so the code cursor stays, and a rerun search keeps its current match. Proof: `tests/helm-open-viewer.test.ts` (registry, admission, limits, tokens, Range, handler headers incl. the worker's CSP, data model), `app/browser-tests/helm-open-viewer.spec.ts` on **Views / Document review / Plain files**, and the built-entry spec opening JSON and Go under the real CSP. Not proven: the real Electron session's network block and per-window token isolation (no co-tenant canary run; the handler and predicate are unit-tested, the session wiring only by reading).
- **S3 implemented** (2026-11-10). Registry: PNG/APNG, JPEG, GIF, WebP, AVIF, BMP, ICO (256 MiB, 150 MP), SVG (16 MiB) and HEIC/HEIF (`.heic .heif .hif`) join `formats.ts` with magic checks (`ftyp` brands for AVIF/HEIC) and mismatch refusals that name both types. Main reads only the 256-byte signature of a raster or HEIC picture (an SVG is decoded as text in main only to find its `<svg>` root, prefixed or not, and hash it) and pins the descriptor; the bytes go to the window by the S2 token with the declared image MIME (still octet-stream + nosniff + sandbox on the wire). Header reader `src/document-review/image-header.ts` (pure, also used by Node tests): PNG IHDR + APNG fcTL inside the canvas, JPEG SOF walk (two sizes, DNL and zero height refuse) + EXIF orientation, GIF screen + first frame inside it, WebP VP8/VP8L/VP8X (canvas vs frame), AVIF `pitm`/`ipma`/`ispe`/`irot` (tkhd for sequences), BMP, ICO directory incl. embedded PNG. It runs in the renderer's image worker; Chromium then decodes from a renderer-made `blob:` off screen, and the decoded size must agree with the header (equal or quarter-turned; GIF/ICO/AVIF may be smaller). SVG goes straight to `<img src=blob:>` (no worker; its decoded size meets the same 150 MP cap). HEIC: `heic.ts` exactly as specified above, plus a PNG chunk/CRC walk and a size-agreement check in main, conversion skipped when the file's identity is unchanged. Copy: the renderer encodes the shown picture (EXIF applied) with canvas `toBlob('image/png')`; main's `copyPngToClipboard` walks signature, chunks and CRCs (≤256 MiB, never decodes) and writes `public.png`. UI: fit with 24px inset, 0/1/+/−, ⌘= ⌘− ⌘0 and pinch zoom 5–1600%, arrows/drag pan, checkerboard only when pixels are transparent, pixelated above 200%, status facts (format, size, EXIF words, Animated, bytes), live reload swaps only after the new picture decodes, keeping zoom and scroll. Review fixes (adversarial pass): a JPEG walk refuses a non-marker byte after FF (a stuffed `FF 00` desynchronised it from libjpeg and hid a 156 MP SOF), every GIF/AVIF walk limit refuses instead of stopping (padding hid an oversized first frame or track), a GIF without a frame refuses, AVIF tracks' `tkhd` sizes must match the still image and otherwise the largest track counts; HEIC conversions of one `view` batch share a 24 s budget under the CLI's 30 s deadline and refuse by name when it runs out; a failed reload keeps the last good picture. Choices made here: the raster 150 MP and header refusals show in the window, not on the CLI (main never parses image headers; only HEIC, already converted in main, refuses at open); ICO shows its largest entry as Chromium picks it; animated GIF/APNG/WebP play, no frame stepping; `.heic` files are opened as the converted PNG, so the token never serves the original HEIC bytes. Proof: `tests/helm-open-images.test.ts` (header fixtures per format from real files, synthetic missing/contradictory/151 MP refusals with numbers, admission, token serving, real `/usr/bin/sips` HEIC → PNG, fake-sips empty/oversized/broken/stuck refusals, copy structure), `app/browser-tests/helm-open-pictures.spec.ts` on **Views / Document review / Pictures** (zoom/pan keys, EXIF 6, SVG script and `https://example.invalid` image inert, 151 MP refusal, HEIC, copy as PNG, transparency, every raster family), and the built-entry spec showing a JPEG and the SVG under the real CSP. Not proven: the real Electron pasteboard write and `sips` inside the running app (no co-tenant canary; both are unit-tested through their seams).
- S1 next: plain `helm open` and the `hello` negotiation that S12's `session-hint` feature builds on.
- S12 right after S1: it builds on S11's line and deadline renewal and S1's `hello`, works on today's Markdown/JSX/TSX windows, so the progress line does not wait for the viewer. Pi keeps S11's "Thinking" line until S8b adds its tokens and verb.
- Then the viewer: S2 → S3 → S4 → S5; S7a's per-view keying ships alone before S7b adds any tab; S6 after the multi-file shell; feedback v2 (S8, S8b) once the formats it anchors in exist; S9 and S10 last.

## Decisions

D1–D11 and D13: Jakub agreed with the recommendations on 2026-11-09; they are decided. D12a (A6), D12b (B4) and D14 (E5): he picked them from Storybook the same day. He gave the go on the slice order on 2026-11-10.

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
| D12a | Window chrome | A1–A6 | **Decided: A6** (Storybook `A Window chrome → A6 Collapsing path`). One 40px title row like A1: the folder path as A3's dim, clickable breadcrumb (each folder shows itself in Finder), then the file name. When the title row is narrower than 1000px the whole path folds into one "…" menu before the name. Actions on the right; in bound mode A1's agent button in the row toggles the conversation column. |
| D12b | Multi-file model | B1/B2/B3/B4 | **Decided: B4** (Storybook `B Multiple files → B4 Windows and tabs`). A window per file; tabs drawn by Helm in the title row (native macOS tabs are unavailable with `titleBarStyle: 'hidden'`, § Windows and tabs); Window → Merge All Windows and the Open Files as Tabs setting (off by default) put files into tabs; a tab dragged out, or Move Tab to New Window, is a window again; ⌘⇧O goes to any tab, window or recent file. Needs per-view access keys (§ Per-view access keys); delivered as S7a (keying, no visible change) then S7b (tabs, palette, Window menu, entry points), in the S7 slot after S5. |
| D13 | Feedback on non-journal files outside the agent's workspace (a Downloads PDF) | workspace only; any readable file, with `relativePath` replaced by the canonical path for those | **Decided: workspace only** (S8) for now; widen once he wants it, because it tells the agent where files outside its project live. |
| D14 | Send receipt in the review composer | Today; A composer line; B under your message; C header steps; D send button; E5 activity line (see § Send receipt) | **Decided: E5**, drawn with the shared §3.21 `ActivityIndicator` instead of Claude's orange ✻ (no new colour). On A–D he said "probably neither of them". Includes the policy change: Helm may read a bound caller's Claude Code transcript and Codex rollout for the working state, verb and tokens, display only, never trusted, linked by session id + request id (§ Policy change). Prerequisites: deadline renewal (capped), `--agent` from env, and monotonic sequences before any `helm edit` working report. Delivered as S11 (line, no session files), S12 (Claude Code and Codex progress) and S8b (Pi tokens and verb). |

## Open questions

- Should plain viewing work in **inactive profiles' worktrees** too? Plain mode has no profile-bound state, so yes by default; the recent-files list could be per profile or global.
- Should agents be allowed to open files **outside** their workspace in plain mode? A plain open discloses nothing to the agent and its windows open inactive, so the spec allows it; Jakub may prefer a workspace limit for agent-initiated opens.
- Packaging Helm as its own `.app` (unique bundle id) unlocks D7 and Finder Open With; worth its own spec.
- Printing PDFs natively (pdf.js print rendering) vs always handing to Preview.
- Whether `helm open` in the cockpit should ever open inside the main window (a pane) rather than a separate window. Out of scope here.
