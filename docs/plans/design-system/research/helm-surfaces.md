# Helm UI surfaces and styling ownership (design-system scoping)

Worktree: `/Users/jakubneumann/Documents/code/neumie/helm-wt/feat-design-system` (branch `feat/design-system`, clean, HEAD 10fa3b7). All counts are from commands run in this session (grep / wc / find / perl). No `dist/`, `remote-dist/` or `extension/dist` exists in this worktree, so "what CSS ships" is traced from the import graph and build scripts, not from built output.

Paths below are relative to the worktree root unless absolute.

---

## 0. Build entries (who produces which bundle)

`app/build.mjs` (142 lines, esbuild):

| Bundle | Entry | Format | HTML | CSS that lands in it |
|---|---|---|---|---|
| Cockpit renderer | `app/src/renderer/renderer.ts` | IIFE | `app/src/renderer/index.html` → `dist/index.html`, links `renderer.css` | `@xterm/xterm/css/xterm.css` + `styles.css` (renderer.ts:1-2); `sidebar/sidebar.css` (+ its `@import "./detail-redesign.css"`, sidebar.css:1) via `SidebarRoot.tsx:18`; `button.css` via `button.tsx:2`; `sidebar/scheduled-runs.css` via `ScheduledRunsPage.tsx:2` |
| Run context window | `app/src/renderer/run-context-editor.tsx` | IIFE | `run-context-editor.html` → `dist/run-context-editor.html`, links `./run-context-editor.css` | `styles.css`, `sidebar/sidebar.css`, `run-context/run-context-editor.css` (run-context-editor.tsx:3-5) + `@blocknote/ariakit/style.css` (RunContextEditor.tsx:3) + `button.css` |
| Review / viewer window | `app/src/renderer/document-review.tsx` (+ `data-worker`, `image-worker`, `csv-worker` entries) | ESM, code-split, `dist/viewer/assets` | `document-review.html` → `dist/viewer/index.html`, links `assets/document-review.css`; served via `helm-viewer://app/` | `styles.css` + `sidebar/sidebar.css` (document-review.tsx:5-6), `reading-width.css` + `document-review/document-review.css` (DocumentReview.tsx:49-50), `viewer/viewer.css` (imported by eager `PlainViewer.tsx:16`, `PictureViewer.tsx:8`, `PdfViewer.tsx:8`, `CsvViewer.tsx:14`), `button.css` |
| Document canvas worker | `app/scripts/build-document-canvas.mjs` → `canvas-worker.ts` | IIFE string inlined into `canvas-runtime.generated.ts` | none | none (no CSS; output is styled by the parent window) |
| Preloads | `preload.ts`, `preload-run-context.ts`, `preload-document-review.ts` | CJS | – | – |

`app/scripts/build-remote.mjs` (esbuild, minified ESM): entry `app/src/renderer/remote/entry.tsx` → `remote-dist/remote.js` + `remote.css`; writes `remote-dist/index.html` inline (html class `remote-page`, `color-scheme: dark`, `theme-color #0d0d0d`); copies `assets/remote/{manifest.webmanifest, remote-sw.js, icon-180/192/512.png}`. CSS: `styles.css`, `sidebar/sidebar.css`, `sidebar/detail-redesign.css` (entry.tsx:3-5, detail-redesign is imported twice: directly and via sidebar.css's `@import`), `remote/remote.css` (RemoteWorkspace.tsx:65), `button.css`.

`extension/build.mjs` (rollup + babel-preset-solid): `src/content.tsx` → `dist/content.js`, `src/popup.ts` → `dist/popup.js`, copies `manifest.json` and `src/popup.html`. `extension/build-workbench.mjs` builds `src/widget-workbench.tsx` → `dist/workbench.js` for Storybook only.

Storybook: `app/.storybook/main.ts` stories glob `../src/renderer/**/*.stories.tsx`; `preview.ts` globally imports `styles.css`, `sidebar/sidebar.css`, `sidebar/detail-redesign.css`, `preview.css` (8 lines, only html/body scroll override). Playwright (`app/playwright.config.ts`) runs every browser test against Storybook dev on `127.0.0.1:6010` (so "browser tests" = Storybook-iframe tests).

---

## 1. CSS file inventory (wc -l, run this session)

| File | Lines | `var(--` uses | custom props defined | hex literals | rgb(a) literals |
|---|---:|---:|---:|---:|---:|
| `app/src/renderer/styles.css` | 3969 | 413 | 82 | 44 | 14 |
| `app/src/renderer/sidebar/sidebar.css` | 2088 | 272 | 0 | 0 | 0 |
| `app/src/renderer/remote/remote.css` | 1744 | 194 | 18 | 8 | 11 |
| `app/src/renderer/document-review/document-review.css` | 1254 | 166 | 30 | 12 | 5 |
| `app/src/renderer/viewer/viewer.css` | 864 | 152 | 24 | 8 | 0 |
| `app/src/renderer/run-context/run-context-editor.css` | 266 | 55 | 19 (all `--bn-*`) | 0 | 0 |
| `app/src/renderer/sidebar/detail-redesign.css` | 213 | 25 | 0 | 0 | 0 |
| `app/src/renderer/sidebar/scheduled-runs.css` | 82 | 10 | 0 | 0 | 0 |
| `app/src/renderer/button.css` | 72 | 14 | 0 | 0 | 0 |
| `app/src/renderer/reading-width.css` | 63 | 6 | 2 | 0 | 0 |
| `extension/src/widget.styles.ts` (CSS-in-TS string) | 506 | 127 | 33 (`--vg-*`) | 14 | 9 |
| `extension/src/popup.html` (inline `<style>`) | 70 | 0 | 0 | 10 | 0 |
| `app/src/renderer/open-prototype/*.css` (11 files, story-only) | 2,341 total (chrome 870, doc 303, json 302, chrome-hybrid 265, sheet 239, code 229, open 131, pdf 119, chrome-combined 94, image 48, receipt-story 41) | – | – | 1 (pdf) | 0 |
| `app/prototypes/document-review-selection/index.html` (inline) | – | – | own `--pane/--chrome/...` light set | many | many |

Total app `*.css` under `app/src/renderer`: 13,256 lines (`wc -l` total). Production (non-prototype) app CSS = 10,615 lines.

Notes on the literal counts: styles.css literals sit almost entirely in the `:root` token block (lines 8–86); outside it only `#000` in two `mask-image` gradients (styles.css:2175, 2191) and a comment. document-review.css literals are the scoped light palette (document-review.css:13-36). remote.css literals outside variable definitions: `#fff`/`#0d0d0d` send button (remote.css:817-818), `rgb(255 255 255 / 88%)` (822), and five raw shadow/scrim values (860, 1356, 1372, 1565, 1617, 1634). viewer.css: `#fff` PDF page (685) plus light syntax colors (19-25).

### styles.css section map (by its own `/* ---------- */` headings)

| Lines | Section | Owner surface |
|---|---|---|
| 8–86 | `:root` tokens (63 custom props: ladder, lines/fills, text, tones, 7 group colors, derived soft fills, thumbs, scrim/shadows, terminal + ANSI 16, `--font-ui`/`--font-mono`, `--left-width`, `--ui-scale`) | global |
| 88–125 | reset, body type, focus ring, `#app` grid | global |
| 126–206 | top bar (window chrome, drag regions) | desktop shell |
| 207–718 | terminal tabs, tab groups, tab numbers, ActivityIndicator primitive (513–638), inline rename | terminal workspace |
| 719–976 | background terminals strip control + popover | terminal workspace |
| 977–1006 | DOM context menus (tab/group right-click) | terminal workspace |
| 1007–1053 | panes + divider | desktop shell |
| 1054–1239 | terminal well, xterm mount, overlay scrollbar | terminal workspace |
| 1240–1342 | toasts | global (plain DOM) |
| 1343–1388 | "No terminal open" card | terminal workspace |
| 1389–1403 | `.sr-only` | global |
| 1404–3199 | agent dock (§3.24) — 1,796 lines | agent dock |
| 3200–3969 | Signals (§3.25) — 770 lines | Signals |

So styles.css is not a token file: ~45% of it (1,796 + 770 = 2,566 of 3,969 lines) is agent-dock + Signals component CSS, and every other bundle that imports styles.css for the tokens (Run context, review/viewer, Remote) also pulls in the terminal, dock and Signals rules.

### sidebar.css section map (headings)

Shell & push nav 13–201, list toolbar 202–264, segmented 265–406, list rows 407–557, status dots 558–593, chips 594–639, menus (§3.8) 640–773, empty states 774–801, detail page 802–1074, banners 1075–1178, run section/setup 1179–1266, action bar 1267–1294, plan & task subpages 1295–1514, fields 1515–1851 (incl. new-item composer, terminal shortcut editor), sheet 1852–1954, swipe-back 1955–1977, Appearance page 1978–2028, Remote pairing (Settings) 2029–2088.

---

## 2. Tokens: canonical source and who honours it

- Canonical: `app/src/theme-presets.ts` `HELM_TOKENS` — 54 distinct token names (perl over the file). Presets: `helm` (default, `DEFAULT_THEME_ID`, theme-presets.ts:145) and `high-contrast`.
- `styles.css :root` mirrors all 54, plus 9 that are not theme tokens: `--accent-soft --danger-soft --danger-strong --font-mono --font-ui --left-width --neutral-soft --success-soft --warn-soft` (comm of the two sets; 0 preset tokens missing from :root).
- Runtime theming is `appearance.ts` (`appearance.init()`), called in only two entries: `renderer.ts:19` and `run-context-editor.tsx:11`. **Document Review/viewer and Remote never call it**, so they always render the `:root` first-paint defaults: custom themes, the High contrast preset and the UI text scale preference do not reach them (review has its own zoom via `--review-ui-scale: var(--ui-scale, 1)` × `--review-zoom`).
- Token overrides by scope:
  - `.document-review[data-review-theme="light"]` (document-review.css:13-36): 21 overrides — the only light ladder in production; `[data-review-theme="dark"]` just sets `color-scheme: dark` (37-39).
  - `.viewer-window` (viewer.css:6-15) adds `--syntax-*` mapped to ANSI tokens; `[data-review-theme="light"]` (17-25) hard-codes 7 darker syntax hexes.
  - `.remote-workspace, .remote-login, .remote-empty` (remote.css:26-37) override the ladder with a separate near-black set: `--pane: var(--remote-page,#0d0d0d)`, `--chrome #1c1c1e`, `--well #1a1a1a`, `--hairline 8%`, `--fill-subtle 5.5%`, `--fill-raised 11%`, plus `--remote-bubble #2f2f2f`. `:root.remote-page` defines `--remote-page #0d0d0d` (remote.css:1-7).
  - `.agent-dock` (styles.css:1416-1428) and `.signals` (styles.css:3219-3226) each define the same 7 `--dock-*` vars (`--dock-mono --dock-sans --dock-fs --dock-lh --dock-prose-fs --dock-prose-lh --dock-dim`) — duplicated verbatim; the agent dock adds `--dock-inset`.
  - `.run-context-editor .bn-container` (run-context-editor.css:134-153) maps 19 BlockNote `--bn-*` vars onto Helm tokens; `--bn-font-family` is a literal stack instead of `var(--font-ui)`.
  - Extension `:host` (widget.styles.ts:13-56): 33 `--vg-*` vars that copy the Helm values by hand (`#1a1c1f`, `#141517`, `#ececee`, `#4c9aff`, …) with different tone names (`--vg-green/amber/red/blue/gray` vs `--success/warn/danger/accent/neutral`) and its own radius/shadow/font vars.
- **Referenced but defined nowhere (perl over all app CSS + grep of TS for setters):** `--radius-sm` (3 uses), `--radius-md` (6), `--radius-lg` (4), `--motion-state` (5), `--accent-text` (1). design-system.md documents the radius ladder 8/6/4 and the motion values, but no CSS defines them. Uses with a fallback degrade fine (`var(--radius-md, 6px)` in document-review.css:423/766/1191, remote.css:1563; `var(--motion-state, 140ms)` in viewer.css and open-prototype). **Uses with no fallback silently resolve to the initial value (square corners / inherited color):** `styles.css:999` (`border-radius: var(--radius-sm)`), `sidebar/detail-redesign.css:36` (`--radius-sm`), `sidebar/sidebar.css:1891` (`--radius-lg`), `sidebar/sidebar.css:2051` (`--radius-md`), `sidebar/sidebar.css:1824` (`color: var(--accent-text)`). design-system.md §3.23 (line 494) already notes "the current native root exports color variables but does not define every structural custom property".
- Other vars set from JS at runtime (fine): `--group-color`, `--project-color`, `--depth`, `--sidebar-column-width/-divider-width/-header-width`, `--review-zoom`, `--review-companion-width`, `--remote-keyboard-height`, `--remote-composer-overlap`, `--open-docx-scale`, `--total-scale-factor`.
- Native window backgrounds are literals in main: cockpit `backgroundColor: '#141517'` (main.ts:1108), run context `#141517` (run-context-window.ts:151), review containers `REVIEW_DARK_BACKGROUND '#141517'` / `REVIEW_LIGHT_BACKGROUND '#faf9f6'` (document-review/window.ts:61-62).
- Font-size scaling (`font-size` declarations vs those using `--ui-scale`/`--dock-*`/`--review-reading`): styles.css 48/33, sidebar.css 75/74, detail-redesign 9/9, scheduled-runs 4/4, button.css 2/2, document-review.css 52/52, viewer.css 25/19, remote.css 54/51, run-context 12/12, widget.styles.ts 23/0.
- `prefers-reduced-motion` blocks: styles.css 7, document-review.css 2, viewer.css 1, remote.css 1, widget.styles.ts 1, sidebar.css 0. No `prefers-color-scheme`, `prefers-contrast` or `forced-colors` in any app or extension CSS.

---

## 3. Shared primitives (what crosses surfaces)

| Primitive | File | Styling | Imported by (non-story files, by directory) |
|---|---|---|---|
| `Btn` / `createButton` | `app/src/renderer/button.tsx` | `button.css` (72 lines) | renderer root 2, agent-dock 1 (`pane-chrome.tsx`), document-review 4, viewer 7, sidebar 1 (+ re-export through `sidebar/ui.tsx`), signals 1, remote 4 (`../button.js`), open-prototype 2 |
| `IconBtn` / `createIconButton` | `icon-button.tsx` | (in button/sidebar CSS) | renderer root 3 (toast, terminal workspace), sidebar 1, signals 1 |
| `MenuButton`, `GLYPH`, Field, Banner, Section… | `sidebar/ui.tsx` | `sidebar.css` | sidebar 14, document-review 4, viewer 4, open-prototype 4, remote 4 (`../sidebar/ui.js`), signals 1, run-context 1, renderer root 1 |
| ActivityIndicator | `activity-indicator.tsx` | styles.css 513–638 | renderer root 1, document-review 2, run-context 1, sidebar 1, remote 1, open-prototype 1 |
| Safe Markdown | `safe-markdown.ts` | each consumer styles it | agent-dock 1 (`turn-markdown.ts`), remote 1 (`RemoteMarkdown`) |
| Reading width | `reading-width.css` | 63 lines, `--reading-measure`, `--reading-block-max` | document-review only (DocumentReview.tsx:49) |
| Toast | `toast.ts` (plain DOM, 125 lines) | styles.css 1240–1342 | terminal workspace, SidebarRoot |

Raw `<button>` vs shared components per directory (counts of JSX tags in `*.tsx`, stories included): agent-dock 12 raw / 1 `<Btn` (dock buttons are its own key-style CSS in styles.css), signals 5 / 6 `<Btn` / 1 `<IconBtn`, sidebar 26 / 81 / 18 `<IconBtn` / 7 `<MenuButton`, document-review 2 / 32 / 0 / 3, viewer 1 / 17 / 0 / 4, remote 9 / 23 / 6 / 1, run-context 0 / 8, open-prototype 28 / 5 / 0 / 5.

---

## 4. Surface table

Legend — Light/dark: "dark, themeable" = follows `appearance.ts` (Helm / High contrast / custom JSON themes); "dark, fixed" = `:root` defaults only. Stories = exported story consts counted per file (`^export const …`), browser tests = `test(` occurrences per spec. DS § = section in `docs/design-system.md` (820 lines).

| # | Surface | Entry / mount | CSS loaded (own → shared) | Framework | Light / dark | Tokens | Storybook | Browser tests | DS § | Production reachable? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Desktop shell + terminal workspace** (topbar, tab strip, tab groups, background popover, context menus, terminal well, overlay scrollbar, no-terminal card, divider) | `index.html` (97 lines, static topbar/tab DOM) + `renderer.ts` → `mountTerminalWorkspace` (`terminal-workspace.ts`) | `styles.css` 126–1403 + `xterm.css` | plain DOM + xterm.js; React-free except shared `createButton`/`createIconButton` adapters | dark, themeable (xterm theme rebuilt from `--term-*`/`--ansi-*` by `appearance.ts`) | Helm `:root` | Views/Terminal workspace (26), Views/Tab drag (1), Views/Tab numbers (2), Views/Topbar background terminals (2) | terminal-workspace 30, tab-drag-folders 10, tab-numbers 7 | §3.14 Terminal well (l.348), §3.18 Background terminals (l.398), §1/§3.5 topbar, §2.7 z-layers | yes (main window) |
| 2 | **Left column: Signals** | `left-column.ts` → `mountSignals` (`signals/Signals.tsx`, `SignalsList.tsx`) | `styles.css` 3200–3969 (no own file) | React 19 | dark, themeable | Helm + duplicated `--dock-*` set | Views/Signals/{Agent asks 4, Column 6, Done 2, Flows 3, Slack 2} = 17 | signals 20, signals-asks 13, signals-done 7 = 40 | §3.25 (l.555) | yes (default left column) |
| 3 | **Left column: Settings stack** (Settings root, Appearance, Terminal, Profiles + profile editor/knowledge bindings, Scheduled runs + editor/history, Remote pairing, Agent integrations, Run limits) | `mountSidebar(host, { base: 'settings' })` (renderer.ts:49) via `SidebarRoot.tsx` | `sidebar.css` (+ `detail-redesign.css`), `scheduled-runs.css`, `button.css`; tokens from styles.css | React 19 | dark, themeable | Helm | Views/Sidebar Settings… stories (Settings, RunLimitsSettings, Remote×6, TerminalSettings, AgentIntegrations×2, ScheduledRuns×4, Profiles, ProfileKnowledge, Appearance = 18 of the 27 in `SidebarViews.stories.tsx`), Views/Editors maintenance (4) | run-limits 3, terminal-settings 5, maintenance-editors 6, knowledge 2 (partly), work-menu 9 (partly) | §2.8 Theming/Appearance (l.166), §3.10 push nav incl. Profiles/Terminal/Remote (l.306-309), §3.15 flat groups + Run limits (l.371, 383), §3.12 notices incl. scheduled-run feedback (l.334-335) | yes |
| 4 | **Task sidebar** (work list, item detail, task/plan reading, new item, finish-setup sheet) | same `SidebarRoot` but list-rooted | `sidebar.css` + `detail-redesign.css` | React 19 | dark, themeable | Helm | Views/Sidebar (WorkList, WorkListScheduledRunning, NewItem, NewItemNavigation, SwipeBackMidGesture, ItemDetail, UnassignedItemDetail, TaskReading, PlanDocuments = 9), all Primitives/Compositions stories | item-sheets 3, work-menu 9, knowledge 2 | §3.2–3.13, §3.15, §3.19, §3.20, appendix flat-editorial redesign | **no**: SidebarRoot.tsx:11-13 "Production mounts it rooted at Settings … the task list is not shown. The list-rooted form remains for stories." |
| 5 | **Agent dock** | `#agent-dock` section in index.html; `agent-dock-layout.ts` `mountAgentDock` → `agent-dock/AgentDock.tsx` (+ Queue, Detail, AgentPanel, AgentsDetail, AskPanel, DecisionPanels, TurnPanel, pane-chrome, RevealTerminal) | `styles.css` 1404–3199 (no own file) | React 19 | dark, themeable | Helm + `--dock-*` | Compositions/Agent dock (29) + 9 Views/Agent dock * files (40) + 17 `AgentDock*` stories inside Views/Terminal workspace | agent-dock 62, -agents 10, -arrival 4, -facts 2, -pane-height 10, -pane-resize 12, -reveal 5, -scroll 8 = 113 | §3.24 (l.518) | yes (when preload exposes `window.helm.agentDock`) |
| 6 | **Run Context editor window** | `run-context-editor.html` + `run-context-editor.tsx` → `run-context/RunContextEditor.tsx`; window `run-context-window.ts` (BrowserWindow, `#141517`) | `run-context-editor.css` (266) + `@blocknote/ariakit/style.css` → `styles.css`, `sidebar.css`, `button.css` | React 19 + BlockNote (ariakit), `theme="dark"` hard-coded (RunContextEditor.tsx:318) | dark, themeable (only non-main entry calling `appearance.init()`) | Helm + `--bn-*` mapping | Views/Run context editor (4) | run-context-editor 2, run-context-shortcuts 1 | §3.22 (l.457) | **effectively no**: the only opener is `DetailPage.tsx:324` (`window.helm.runContext.open`), and DetailPage is not mounted in production (row 4) |
| 7 | **Document Review window** (Markdown/JSX/TSX review: header, Contents rail, companion chat, passage bubble, comments, changes, source, send activity) | `document-review.html` (CSP, `assets/document-review.css`) + `document-review.tsx` → `document-review/DocumentReview.tsx`; `BaseWindow` + per-document `WebContentsView` (`app/src/document-review/window.ts`), `helm-viewer://` protocol | `document-review.css` (1254) + `reading-width.css` → `styles.css`, `sidebar.css`, `button.css` (also `viewer.css` in the same bundle) | React 19 (StrictMode) | **dark + scoped light reading surface** (`data-review-theme`, document-review.css:13-39); NOT themeable (no `appearance.init`) | Helm `:root` defaults + scoped light overrides | Views/Document review (39), Views/Document review/Content width (3), Views/Helm open/E Send receipt (1, runs production DocumentReview) | document-review 77, -passage-chat 20, -content-width 6, -native-entry 5 (built entry), helm-open-send-receipt 10 | Appendix "Native document review workspace" (l.765-820; not a numbered §3), plus `docs/document-review.md` | yes (File → Open document…, `helm edit`, `helm review`) |
| 8 | **File viewer** (`helm open`: plain text/code/data, pictures, PDF, CSV/TSV) | same review window, `data-review-mode="plain"`; `viewer/PlainViewer.tsx`, `PictureViewer.tsx`, `PdfViewer.tsx`, `CsvViewer.tsx`; lazy chunks CodeView (CodeMirror), DataView, PdfView (pdf.js), CsvGrid; workers data/image/csv | `viewer.css` (864; includes pdf.js text-layer vars at 700+) → `document-review.css`, `styles.css`, `sidebar.css`, `button.css` | React 19 + CodeMirror + pdf.js | dark + scoped light (`.viewer-window[data-review-theme="light"]`, viewer.css:17-25; per-window toggle "Light/Dark reading surface") | Helm + `--syntax-*` | Views/Document review/{Plain files 10, Pictures 12, PDF 11, CSV 12} = 45 | helm-open-plain 4, -pictures 11, -pdf 13, -csv 12, -viewer 11 = 51 | Appendix "Native document review workspace" → Plain viewing / Plain files / Pictures / PDFs / CSV (l.769-777) | yes |
| 9 | **Document canvas** (rendered JSX/TSX in review) | `DocumentCanvas.tsx` (291) + `canvas-display.ts` (243) + hardened Worker `canvas-worker.ts` (629) built by `build-document-canvas.mjs` | No own file: `.review-canvas` rules in document-review.css:1138-1220 (22 matching lines) + producer inline `style` restricted to an allowlist of 37 properties (`canvasStyles`, canvas-vocabulary.ts) — no `className` | React (official reconciler inside a Worker), display re-validated in parent | inherits review theme (light/dark) | Helm via review; producer colors are free-form inline values | InteractiveCanvas, InteractiveCanvasLight, InteractiveCanvasCompact, CanvasCompileError, CanvasNoCaller inside Views/Document review | document-review-canvas 11 | Appendix "Interactive documents and portable history" (l.803) | yes |
| 10 | **open-prototype** (`app/src/renderer/open-prototype/`) | Storybook only; `registry.ts:1-2` "Story-only here"; `chrome.tsx:1` "Story-only window chrome variants for `helm open`"; formats incl. DOCX (`docx-preview`) and XLSX (`xlsx`) that production does not ship | 11 own CSS files (2,341 lines) → `styles.css`/`sidebar.css` via preview | React 19 | mostly dark; `pdf.css:35` `color-scheme: only light` for the page | Helm vars + own `--open-*` | Views/Helm open/{A Window chrome 13, B Multiple files 5, C Code 4, C Documents 5, C Image 3, C JSON 8, C PDF 3, C Spreadsheet 4, D Feedback anchors 6, E Send receipt 1} = 52 | helm-open-prototype 3 ("Nothing here ships", spec header) | not described; the only mention is the story name **Views / Helm open / E Send receipt** (l.787). 0 hits for "open-prototype" | **no** — no production file imports it; production only references `../open-prototype/vite-env.d.ts` (viewer/pdf-fixtures.ts:1, picture-fixtures.ts:1, viewer-fixtures.ts:1) |
| 11 | **Selection prototype** `app/prototypes/document-review-selection/index.html` | standalone HTML, inline `<style>` + `<script>` | own inline light palette (`--pane #faf9f6` etc.) | vanilla JS | light only | own | no | no | none | no ("Throwaway prototype") |
| 12 | **Helm Remote (browser/PWA)** | `remote-dist/index.html` (generated in build-remote.mjs), `remote/entry.tsx` → `RemoteWorkspace.tsx`; `assets/remote/manifest.webmanifest`, `remote-sw.js` (offline page), icons; served by `src/remote/` runtime | `remote.css` (1744) → `styles.css` (whole file, incl. terminal/dock/Signals rules), `sidebar.css`, `detail-redesign.css`, `button.css` | React 19 (browser, not Electron) | dark only, fixed (`color-scheme: dark` meta; own near-black ladder); not themeable | own scoped ladder overriding Helm names (remote.css:26-37) + `--remote-*`; offline page in remote-sw.js:31 uses Helm `#141517`, not Remote `#0d0d0d` | Views/Helm Remote (38) | 17 remote-*.spec files + maintenance-remote-ui = 194 tests (activity 2, composer 17, favorites 6, history-entry 11, history 11, image-input 19, information 19, layout 11, model 7, pairing 9, readability 10, reading 8, subagents 7, submit-feedback 15, usage 4, ux-review 4, workspace 28, maintenance-remote-ui 6) | §3.23 (l.479) + appendix Remote subsections (l.749-763) + Settings → Remote (l.308-309) | yes (opt-in host) |
| 13 | **Extension widget** (ClientCare content script) | `extension/src/content.tsx` → `mount-widget.tsx` (closed shadow root, `<style>` with `WIDGET_STYLES`) → `Widget.tsx` (1275 lines) | `widget.styles.ts` (506 lines) only | SolidJS | dark only, fixed | own `--vg-*` copy of the ladder (33 vars), 14 hex + 9 rgba literals | Views/Extension widget (1, `ClosedShadow`, loads `extension/dist/workbench.js`) | extension-widget 17 | §2.7 z-layer row, §3.7 shadow-root `<select>` exception (l.272), unnumbered "Extension prompt quick editor" (l.473), appendix "reconciled drift" (l.730-747) | yes (Chrome extension) |
| 14 | **Extension popup** | `extension/src/popup.html` (70 lines) + `popup.ts` (97) | inline `<style>` only | vanilla TS | dark only | **none** — VS Code palette literals (`#252526`, `#1e1e1e`, `#3c3c3c`, `#cccccc`, `#808080`, `#007acc`, `#6a9955`), radius 3px, 10 hex literals | no | no | **none** (only incidental "popup" in the shadow-root select note) | yes |
| 15 | **Toast** | `toast.ts` (plain DOM) | styles.css 1240–1342 | plain DOM + `createButton`/`createIconButton` | dark, themeable | Helm | Compositions/Toast (4) | (via terminal-workspace) | §3.6 (l.251) | yes |
| 16 | **Native OS surfaces** | main process | n/a | Electron | system | – | – | – | see below | yes |

### Row 16 detail: native surfaces (no CSS)

- Application menu: `Menu.setApplicationMenu(Menu.buildFromTemplate(template))` main.ts:1759; menus Helm (`app-menu.ts`, 25 lines), Profile, File (incl. "Open document…"), Shell, Edit (role), View, Go, Window. DS mentions only Go-menu accelerators (§3.10 l.313) and the View-menu font accelerators (§2.8); no menu-bar section.
- Native notifications: scheduled attention (`new Notification(content)` main.ts:3192 via `scheduled-attention-notifier.ts`), agent dock (`agent-dock-notify-main.ts`, policy `agent-dock/notifier.ts`). DS covers only the agent-dock one (§3.24 l.548).
- Dock badge: `app.dock.setBadge` (agent-dock notify, side-by-side `'dev'` main.ts:3221). Covered only inside §3.24.
- Native dialogs: `dialog.showMessageBox/showOpenDialog` 6× in main.ts, 3× in `document-review/window.ts`. No DS section (Run context close guard is described in §3.22 as copy only).
- Side-by-side "DOCK DEV · read-only daemon" pill: injected CSS literal (main.ts:1087, `background:#c2410c`, `z-index:2147483647`). No DS mention.

---

## 5. What is shared vs separate

Shared everywhere in `app/` (Electron cockpit, run context, review/viewer, Remote):
- `styles.css` (token `:root` + reset + body type + focus ring) — but imported as a whole 3,969-line file, so every bundle also carries terminal, agent-dock and Signals rules.
- `sidebar.css` + `detail-redesign.css` (menus, banners, fields, sheet, chips, segmented, flat groups) — imported by run-context-editor.tsx, document-review.tsx, remote/entry.tsx for the shared primitives.
- `button.css` via `Btn`.
- `sidebar/ui.tsx` primitives (MenuButton, GLYPH, Banner, Field…) and `activity-indicator.tsx`.

Separate per surface:
- Agent dock + Signals: component CSS lives inside `styles.css`, not in their own files, and they share a duplicated `--dock-*` sub-system (two identical 7-var blocks). Their "register" (one typeface, no bold, 12/18 + 13/20) differs from the sidebar's (12/600 section headers, 17/600 titles).
- Document Review + viewer: own CSS (2,118 lines combined) and the **only light palette** in production. Light values are duplicated in docs (l.809-818), document-review.css:13-36, viewer.css:17-25 (syntax), and the native window background constant `#faf9f6`.
- Remote: own 1,744-line sheet and its own ladder that re-binds Helm token names (`--pane`, `--chrome`, `--well`, `--hairline`, `--fill-*`) to different values, plus `--remote-bubble`. design-system.md §3.23 line 492 still says "Existing `--pane`/`--well`… tokens only; no new color", which the code contradicts (only `#0d0d0d` is mentioned in the doc, l.508).
- Run context: own 266-line sheet + BlockNote's ariakit stylesheet, with a `--bn-*` → Helm token bridge.
- Extension widget: completely separate token copy (`--vg-*`) in a TS string; no way to import app CSS (closed shadow root, SolidJS, separate package). Extension popup: no tokens at all, stale VS Code-dark palette.
- open-prototype: 11 story-only CSS files (2,341 lines) that are not part of any shipped bundle.

Theming reach:
- Follows user theme/High contrast/UI scale: cockpit (terminal, Signals, Settings, dock, toast) and Run context.
- Fixed Helm dark defaults: Document Review/viewer (dark mode) — plus their own light mode.
- Own fixed palettes: Remote (near-black), extension widget (`--vg-*`), popup (VS Code literals), Remote offline page (inline Helm values `#141517/#ececee/#9a9ea6/#4c9aff`).

---

## 6. Gaps in docs/design-system.md

Headings present: §1 Principles; §2.1–2.8 tokens; §3.1–3.25 components; unnumbered "Extension prompt quick editor" (l.473); §4 Interaction; §5 Copy voice; §6 Performance; §7 Storybook; appendices "2026-07 flat-editorial redesign" (l.674), "reconciled drift" (l.724), "Remote plain-thinking…" (l.749), "Remote shared session favorites" (l.755), "Remote limited subagent observation" (l.761), "Native document review workspace" (l.765, which also holds viewer, canvas, reading width and the light palette).

Missing entirely or only incidental:
1. **Extension popup page** (`popup.html`) — no section; its palette matches nothing in the system.
2. **open-prototype** and **`app/prototypes/document-review-selection`** — 0 mentions of either path (the prototype story group is cited once by story name, l.787). Their status (story-only, not shipped) is not documented in the design system.
3. **Native app menu bar, native dialogs, Dock badge, scheduled-attention notifications, side-by-side DEV pill** — no section; only agent-dock notifications/badge inside §3.24 and accelerator mentions.
4. **Settings sub-pages without a spec**: Agent integrations (`AgentIntegrationsPage.tsx`; Pi package status) and Profile knowledge bindings (`ProfilesPage.tsx`, story `ProfileKnowledge`) — grep for "integration"/"knowledge" in the doc finds nothing about these pages. Scheduled runs page is covered only by two bullets (l.233, 335).
5. **Document Review, file viewer and document canvas** are documented, but only in an appendix ("Native document review workspace"), not as numbered §3 components; the doc's header still names only "the app renderer" and "the extension widget" as surfaces (l.3).
6. **Light theme**: §2.8 (l.172) says "Deliberately NO light preset"; the scoped review light palette is described as an exception in the appendix (l.809). Viewer's light syntax colors (viewer.css:19-25) are not in the doc table.
7. **Remote's own ladder** (`#1c1c1e`, `#1a1a1a`, `#2f2f2f`, alpha 8%/5.5%/11%) is not in the doc; §3.23 l.492 states the opposite.
8. **Structural tokens** `--radius-sm/md/lg`, `--motion-state`, `--accent-text` are used but never defined (see §2 above); §2.4/§2.5 describe radii/motion as values, not as defined custom properties.
9. **Dormant surfaces still specified as live**: §3.3, §3.11, §3.19, §3.20 and the flat-editorial appendix spec the task list/detail, which production no longer mounts (row 4); §3.22 specs the Run context window, whose only opener is in DetailPage (row 6).

---

## 7. Totals (this session's counts)

- Story files: 53; exported story consts (regex `^export const [A-Z]`): 397 total — sidebar 97 (16 files), agent-dock 71 (10), open-prototype 52 (10), viewer 45 (4), document-review 42 (2), remote 38 (1), renderer root 35 (5), signals 17 (5).
- Browser specs: 53 files (+ helper `remote-navigation.ts`), grouped: Remote 194, Document Review 118 (incl. canvas 11, send-receipt 10), agent dock 113, viewer 51, terminal workspace 47, Signals 40, Settings/sidebar 28 (run-limits 3, terminal-settings 5, maintenance-editors 6, knowledge 2, item-sheets 3, work-menu 9), extension widget 17, open-prototype 3, run context 3.
- Production CSS: 10,615 lines in `app/src/renderer` + 506 in widget.styles.ts + 70 in popup.html. Prototype CSS: 2,341 lines.

## 8. Reference

Tally (`/Users/jakubneumann/Documents/code/neumie/tally`) has a design doc at `ui/DESIGN.md`; it was not analysed for this report (not required by the task).
