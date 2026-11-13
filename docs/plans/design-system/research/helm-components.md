# Helm UI components + Storybook audit (worktree `feat-design-system`, HEAD 10fa3b7)

All paths relative to `/Users/jakubneumann/Documents/code/neumie/helm-wt/feat-design-system`. All numbers come from `rg`/`find`/`wc` runs in this session. Tally (`/Users/jakubneumann/Documents/code/neumie/tally`) was only read for comparison at the end.

---

## 1. Shared primitives inventory

### 1.1 Where the primitives live

There is no component package. The shared primitives are spread over four root renderer files and one sidebar file:

| File | Lines | Exports |
| --- | --- | --- |
| `app/src/renderer/button.tsx` (+ `button.css`, 72 lines) | 122 | `ButtonTone` (`primary`/`quiet`/`danger`/`ghost`), `buttonClassName()`, `Btn`, `createButton()` (plain-DOM adapter) |
| `app/src/renderer/icon-button.tsx` | ~60 | `IconBtn`, `createIconButton()` (plain-DOM, glyph is a **text string**) |
| `app/src/renderer/activity-indicator.tsx` | ~80 | `ActivityIndicator`, `createActivityIndicator()`, `setActivityIndicatorState()` |
| `app/src/renderer/toast.ts` | — | `showToast()`, `ToastAction/ToastOptions/ToastHandle` (plain DOM; uses `createButton` + `createIconButton`) |
| `app/src/renderer/safe-markdown.ts` | — | `renderSafeMarkdown`, `SafeMarkdownProfile`, `MARKDOWN_TEXT_MAX` (Remote + agent dock) |
| `app/src/renderer/sidebar/ui.tsx` | 948 | re-exports `Btn`, `IconBtn`; `GLYPH` (icon table, line 26), `Chip` (80), `StatusDot` (88), `ProjectColorText` (92), `MenuEntry`/`MenuButton` (117/134), `SegmentOption`/`Segmented` (321/327), `PushHeader` (392), `EmptyState` (421), `Banner` (454), `ClampText` (521), `Disclosure` (576), `Card` (633), `InfoRow` (664), `ActionRow` (675), `FieldLabel` (718), `TextInput` (726), `TextArea` (761), `SelectInput` (792), `Toggle` (829), `Sheet` (858) |

Styling is not co-located with the components: `.btn` is in `button.css`, but `.icon-btn` (`sidebar/sidebar.css:157`), `.chip` (`sidebar.css:599`), `.status-dot` (`sidebar.css:560`), `.segmented` (`sidebar.css:274`), `.menu-item` (`sidebar.css:676`), `.input` (`sidebar.css:1527`), `.empty-*` (`sidebar.css:776-800`) are in the sidebar stylesheet. So every surface that uses `IconBtn`/`MenuButton`/`Chip` must also load `sidebar.css`. The document-review, run-context, and remote entries do (`document-review.tsx:5-6`, `run-context-editor.tsx:3-4`, `remote/entry.tsx:3-5`), and so does Storybook (`.storybook/preview.ts:6-8`).

CSS sizes (`wc -l`): styles.css 3969, sidebar.css 2088, remote.css 1744, document-review.css 1254, viewer.css 864, run-context-editor.css 266, detail-redesign.css 213, scheduled-runs.css 82, button.css 72, reading-width.css 63; open-prototype CSS 2,331 across 10 files. The agent dock (283 top-level `.agent-dock*` rules, styles.css 1404–3199) and Signals (110 `.signals*` rules, styles.css 3200–3969) have no stylesheets of their own. They live in `styles.css`.

### 1.2 Usage matrix (JSX/DOM occurrences, non-story and non-fixture files)

Counted with `rg -o '<Name\b'` per surface directory. ROOT means the renderer's top-level `.ts/.tsx` files (terminal-workspace, sidebar-layout, toast, run-context-editor, …). For `sidebar`, `ui.tsx` itself is excluded.

| Primitive | sidebar | signals | agent-dock | remote | document-review | viewer | run-context | open-prototype | ROOT |
|---|---|---|---|---|---|---|---|---|---|
| `<Btn` | 51 | 6 | 1 | 23 | 32 | 17 | 8 | 3 | 1 |
| `<IconBtn` | 4 | 1 | 0 | 6 | 0 | 0 | 0 | 0 | 0 |
| `createButton(` / `createIconButton(` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 / 6 (includes the definitions) |
| `<MenuButton` | 5 | 0 | 0 | 1 | 3 | 4 | 0 | 5 | 0 |
| `<Chip` | 4 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| `<StatusDot` | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<Segmented` | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| `<Toggle` | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<Sheet` | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `<Banner` | 13 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<EmptyState` | 23 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<Disclosure` | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<Card` | 34 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<ActionRow` / `<InfoRow` | 15 / 11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<PushHeader` | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<TextInput`/`<TextArea`/`<SelectInput`/`<FieldLabel` | 11/3/11/27 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<ClampText` | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `<ActivityIndicator` / `createActivityIndicator(` | 1 / 0 | 0 | 0 | 1 | 2 | 0 | 1 | 2 | 0 / 4 |
| `GLYPH.` | 35 | 1 | 0 | 11 | 8 | 0 | 0 | 11 | 0 |
| `showToast`/`toast(` | 36 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 9 |
| **raw `<button`** | 14 | 5 | **11** | 9 | 2 | 1 | 0 | 28 | 2 (the primitives) |
| `createElement('button')` | — | 1 (story harness `SignalsWorkspace.tsx:162`) | — | — | — | — | — | — | 7 (5 in `terminal-workspace.ts` + 2 primitives) |
| raw `<input>`/`<textarea>`/`<select>` | 4/0/0 | 1/3/0 | 1/3/0 | 6/1/1 | 0/1/0 | 5/0/0 | 0 | 2/2/0 | 0 |

Import graph (who imports what, non-story):
- `button` is imported by agent-dock/pane-chrome, document-review (DocumentCanvas, DocumentReview, PassageChat, PassageComments), open-prototype (chrome, FeedbackBubble), sidebar-layout, sidebar/ui, signals/Signals, terminal-workspace, toast, viewer (CsvGrid, CsvViewer, DataView, PdfView, PdfViewer, PictureViewer, PlainViewer). Remote imports it as `'../button.js'` 4×.
- `icon-button` is imported by sidebar-layout, sidebar/ui, signals/Signals, terminal-workspace, toast.
- `sidebar/ui` is imported by all 13 sidebar pages, document-review (DocumentReview, PassageChat, PassageComments, ScreenshotStrip), run-context (run-context-editor.tsx, RunContextEditor.tsx), signals/Signals, viewer (CsvViewer, PdfViewer, PictureViewer, PlainViewer), remote (4 imports as `'../sidebar/ui.js'`), and open-prototype.
- `activity-indicator` is imported by document-review (DocumentReview, SendActivity), run-context, sidebar/ListPage, terminal-workspace, remote, and open-prototype.
- `toast` is used only by the sidebar pages and terminal-workspace.

What this shows:
- The **sidebar is the only full consumer** of the primitive set. Field, Card, Banner, EmptyState, Disclosure, Toggle, and PushHeader are used **only** in the sidebar.
- The **agent dock uses almost none of it**: 1 `<Btn` (the `.agent-dock-key` footer keys in `pane-chrome.tsx`), 0 IconBtn, 0 MenuButton, and 11 hand-rolled buttons.
- **Signals** uses 6 `Btn` and 1 `IconBtn` (Settings, `Signals.tsx:646`). Everything else there is hand-rolled.
- **Remote** uses `Btn`/`IconBtn`/`MenuButton`/`Chip`/`GLYPH` but builds its own sheet, disclosure, menus, and navigation drawer.
- **Document Review and the viewer** use `Btn`, `MenuButton`, `GLYPH`, and one `Sheet`, with heavy `.btn` overrides (12 `.btn` rules in document-review.css).

---

## 2. Duplicated / parallel implementations

"Identical?" means: could the two be merged with no visual change at `--ui-scale: 1`? This is judged by comparing the declarations.

### 2.1 Buttons

| Parallel impl | Location | vs shared | Identical? |
|---|---|---|---|
| Extension `Btn` (`.vg-btn`, variants primary/muted/danger) | `extension/src/Widget.tsx:532`, `widget.styles.ts:452-472` | `.btn` md = 32h / 0 14 / 13px scaled / radius 8; sm = 24h / 0 10 / 12px / radius 6. `.vg-btn` = **28h** / 0 12 / 12px fixed / radius 6 | **Differs**: height is between md and sm. Tone colours match the token copies. |
| `.agent-dock-title-btn` (‹ › esc, close) | `styles.css:2015`, used `pane-chrome.tsx:79,256,273` | `.icon-btn` 28×28, r6 | **Differs**: min-width 24, padding 0 4, radius 4 |
| `.signals-title-btn` | `styles.css:3299`, `Signals.tsx:1106` | ghost `Btn` / IconBtn | **Differs**: 28h, padding 0 8, r4, `--dock-dim !important` |
| `.agent-dock-key.btn` vs `.signals-key.btn` | `styles.css:2867` / `styles.css:3708` | each other (both are `Btn` with dock type) | **Plausibly identical**: same 4 declarations; dock adds `text-align:center`, a no-op in an inline-flex `.btn`. Merge candidate. |
| `.signals-list-btn`, `.field-reset`, `.agent-dock-group-option`, `.agent-dock-reveal-link` | `styles.css:3718`; `sidebar.css:1242`; `styles.css:2219`; agent-dock RevealTerminal | text-only link buttons, a concept with no primitive | **Differ** from each other: signals = inherit/`--dock-dim`/24 min-h; field-reset = 11/600 `--text-2`; group-option = 24h r4 `--dock-dim`, `aria-pressed` |
| Terminal tab close `.tab-close` (`×` text) | `terminal-workspace.ts:3495` | `IconBtn`/`createIconButton` | Differs. This is a strip-specific control, not using the adapter, while the Background-row ×/⇥ do use `createIconButton` (`terminal-workspace.ts:517,1706,1713`). |
| `#new-tab` "+" text button | `index.html:21` | `IconBtn` | Differs (strip-specific) |
| `remote-add-images` raw `<button className="icon-btn …">` | `RemoteWorkspace.tsx:2016` | `IconBtn` | **Identical class**. It is raw only because it needs a ref for `showPicker()`. `IconBtn` has no `ref` prop (unlike `Btn`). |
| `review-contents-link` raw `<button className={buttonClassName(...)}>` | `DocumentReview.tsx:2440` | `Btn` | Identical (uses the shared class builder) |
| open-prototype: 28 raw buttons | `open-prototype/*` | — | Prototype only (Storybook), not shipped |

Surface-level `.btn` overrides (count of `.btn` selectors per file): document-review.css 12, remote.css 12, button.css 12, styles.css 3, detail-redesign.css 3, sidebar.css 2. Remote buttons also look different from sidebar buttons because remote **redefines core tokens** (see 2.8): quiet `--fill-raised` is 11% there versus 9% in the app.

### 2.2 Menus

| Parallel impl | Location | Identical? |
|---|---|---|
| Terminal tab context menu `openMenu()` | `terminal-workspace.ts:2924-2960` (+ name form `:3015-3031`) | Same CSS classes as `MenuButton` (`.menu-panel menu-fixed`, `.menu-item`, `.menu-separator`, `.menu-hint`) → **plausibly pixel-identical** rows. Leading icons are **Unicode text** (`icon: '›'` ×13, `'+'` ×1) instead of the 14px SVG column. Keyboard/roving logic is a second implementation. |
| Background popover | `index.html` + `terminal-workspace.ts` (`menu-panel menu-end`) | reuses panel CSS; content is custom |
| `RemoteSessionMenu` (`.remote-row-menu`, long-press) | `remote/RemoteSessionMenu.tsx:42` | **Differs**: 44px items, padding 8 12, r6 (touch sizing) vs 28px/0 8/r4 |
| `RemoteNavigationMenu` drawer | `remote/RemoteNavigationMenu.tsx` | **Differs**: 48px items, 16px/500 |
| `RemoteChoiceSheet` (menu/radio sheet) | `remote/RemoteChoiceSheet.tsx` | **Differs**: 52px options, 16px |
| Extension `ActionMenu`, `ModelSelect` (custom dropdown; native select fails in a closed shadow root) | `Widget.tsx:545,703` | Separate Solid implementation, token copies. Spec-mirrored but not shared. |
| Agent dock "group state/project" pressed-button switch | `AgentsDetail.tsx:221`, `.agent-dock-group-option` | a segmented/menu analogue. Differs. |

### 2.3 Choice lists / radio groups

- `.agent-dock-choice` (`styles.css:2474`, `pane-chrome.tsx:539`, role radio/checkbox) vs `.signals-choice` (`styles.css:3770`, `Signals.tsx:1173,1844`, role radiogroup): the grid/subgrid, 28px min-height, r6, transparent background, and `--fill-subtle` hover declarations are **copied**. Dock sets `color: var(--text-1)`; Signals inherits. Disabled/focus rules exist only on the dock. **Near-identical; strong merge candidate.**
- Extension segmented `.vg-agent__option` (24h, r4, 12/600) vs `Segmented` (`.segment` 24h, r4, 12/600 scaled, track 28/2px/inset ring): **plausibly identical** at scale 1.

### 2.4 Inputs

- `.viewer-search-field` (`viewer/viewer.css:165`: 28h, 0 10, `--fill-subtle`, 1px `--hairline`, r6, 12px scaled) vs `.input` (`sidebar.css:1527`: same values plus `letter-spacing:-0.01em`, which the body supplies anyway): **plausibly identical**. The viewer uses it in PdfView ×3, CsvGrid, and DataView, but never uses `TextInput`.
- `.agent-dock-input` (`styles.css:2605`, borderless transparent, caret accent) and `.signals-prompt-input` (`styles.css:3893`, **mono** 8 12 padding r6) are intentionally different. Note that the design-system rule says "mono is reserved for code-shaped editors, never an ordinary prompt", yet the Signals prompt input is mono.
- The Remote and Document Review textareas carry no class and are styled by parent selectors.

### 2.5 Sheets / dialogs / disclosure

- `Sheet` (`ui.tsx:858`, pane-scoped `<dialog open>`, used in sidebar ×2 and DocumentReview ×1) vs `RemoteChoiceSheet` (phone bottom sheet, `role="dialog"` div): **differs**, by design.
- `Disclosure` (`ui.tsx:576`: Card + quiet sm Show/Hide Btn) vs `RemoteDisclosure` (`remote/RemoteDisclosure.tsx`: ghost Btn + chevron GLYPH + `<pre>`): **differs**. These are two disclosure grammars.
- `NoticeText` in the extension (`Widget.tsx:519`, click-to-expand clamp) is the extension analogue of `ClampText`/`Banner`. It differs.

### 2.6 Empty / waiting states

| Impl | Location | Notes |
|---|---|---|
| `EmptyState` (`.empty-wrap/.empty-card/.empty-title 13/600 --text-1/.empty-detail 12 --text-2`) | `ui.tsx:421`, `sidebar.css:776-800` | sidebar only (23 uses) |
| `.signals-resting*` | `SignalsList.tsx`, `styles.css:3430-3450` | dock prose size, padding `24px 16px 14vh`, `--dock-dim` detail. Differs. |
| `.review-empty` | `DocumentReview.tsx`, `document-review.css:836` | max-width 400, 13/600 heading. Differs. |
| `.remote-empty` | `remote/entry.tsx`, `RemoteWorkspace.tsx` | also a token-override scope. Differs. |
| `#no-terms` card | `index.html` / `terminal-workspace-fixtures.tsx:249-256` | terminal pane. Differs. |
| `.agent-dock-queue-empty`, `.agent-dock-preview-empty`, `.review-contents-empty` | dock / review | one-liners |

None of these could be merged without visual change. They are six different empty-state grammars.

### 2.7 Status dots / indicators / chips

- `StatusDot` (`.status-dot` 8px r999, `.dot-pulse` 1.6s) vs extension `Dot` (`.vg-dot` 8px r50%, `vg-pulse` 1.6s, opacity 0.35): **plausibly identical**.
- `Chip` (`.chip`, `.chip-{gray,blue,green,amber,red}`) is the only chip in the app. No other surface defines chip classes (rg found chip/badge classes only in sidebar.css plus `.menu-trigger-badge`). The extension has its own chip classes in `widget.styles.ts`, which the spec references as "the shared vocabulary" (§3.4).
- The agent dock's status/kind marks are **text glyphs** (`presentation.ts:795-818`: `✓ ↵ ? ≡ $`, `✻ ◐ ? · ¿ ▪`). This is a separate indicator system from `ActivityIndicator`. The dock uses no `ActivityIndicator`.

### 2.8 Token copies / overrides

- Extension `widget.styles.ts:15-56` hard-codes ~30 `--vg-*` tokens copied from `app/src/theme-presets.ts:20-58`. Values match today (e.g. `--vg-chrome #1a1c1f`, `--vg-accent-fill #3b82f6`). It also has its own `--vg-font`/`--vg-mono` stacks. **No parity test was found** (`rg 'widget.styles|--vg-' tests app/browser-tests` → 0 files).
- `remote/remote.css:26-38` redefines 7 core tokens (`--pane #0d0d0d`, `--chrome #1c1c1e`, `--well #1a1a1a`, hairline 8%, fill-subtle 5.5%, fill-raised 11%). So every shared primitive renders **visibly differently in Remote**. This is intentional ("phone chat app").
- `document-review.css` redefines 19 core tokens for the scoped light reading surface (documented in the appendix).
- `open-prototype/open.css:7-8` re-declares `--font-ui`/`--font-mono`.
- Hex/rgb literals per production CSS: styles.css 58, remote.css 19, document-review.css 17, viewer.css 8, all others 0. TSX: `AppearancePage.tsx` 1, `SettingsPage.tsx` 1.

### 2.9 Scroll areas

- `::-webkit-scrollbar` rules: document-review.css 6, sidebar.css 4, run-context-editor.css 4, styles.css 2 (+ prototype open.css 5, sheet.css 1, chrome.css 1).
- `scrollbar-gutter`: document-review 10, remote 5, viewer 4, sidebar 3, run-context 2.
- Terminal: a custom overlay scrollbar `.term-scrollbar`.

This gives at least four scrollbar styling implementations and no shared scroll-area primitive or class.

### 2.10 Markdown renderers

`marked` is imported by `safe-markdown.ts` (shared by Remote `RemoteMarkdown.tsx` and dock `turn-markdown.ts`), by `document-review/ReviewMarkdown.tsx` + `document-review/markdown.ts`, by `remote/thinking-text.ts`, and by `open-prototype/MarkdownView.tsx`. That makes three independent Markdown→React renderers (safe-markdown, ReviewMarkdown, prototype). They differ by design (budgets, source mapping).

### 2.11 Prototype vs production viewer (same concepts, two codebases)

`open-prototype/` (Storybook only; nothing in production imports it, though the viewer fixtures reference its `vite-env.d.ts`) has `CodeView.tsx`, `PdfView.tsx`, `ImageView.tsx`, `JsonView.tsx`, `SheetView.tsx`, `MarkdownView.tsx`, `DocxView.tsx`, `chrome*.tsx`, `FeedbackBubble.tsx`, and its own 10 CSS files (2,331 lines). Production `viewer/` has `CodeView.tsx`, `PdfView.tsx`, `ImageView.tsx`, `DataView.tsx`, `CsvGrid.tsx`. Same names, different implementations; they visibly differ. `SheetView.tsx:30` hard-codes a canvas font stack.

### 2.12 Extension (SolidJS) component map

`extension/src/Widget.tsx` (1275 lines) holds `Dot` (510), `NoticeText` (519), `Btn` (532), `ActionMenu` (545), `AgentSelect` (629), `WorkspaceSelect` (662), `ModelSelect` (703), `Pill` (895), `Card` (939), `LinkLine` (1249). The styles are all in `widget.styles.ts` (506 lines). Each one is a Solid reimplementation of an app concept:

| Extension | App counterpart | Identical? |
|---|---|---|
| `Btn` `.vg-btn` | `Btn` | **Differs** (28h) |
| `Dot` | `StatusDot` | plausibly identical |
| `AgentSelect`/`WorkspaceSelect` (`.vg-agent`) | `Segmented` (+commit) | plausibly identical |
| `ModelSelect` | `SelectInput` + `MenuButton` | Differs (custom popup, shadow-root constraint) |
| `ActionMenu` | `MenuButton` | spec-mirrored; not verified pixel-equal |
| `NoticeText` | `ClampText`/`Banner` | Differs |
| `Card`/`Pill` | none (widget-only) | — |

Sharing is structurally blocked: the extension is SolidJS and the app is React. Only tokens/CSS could be shared, and today they are copied.

---

## 3. Storybook

### 3.1 Configuration

- `app/.storybook/main.ts`: `stories: ['../src/renderer/**/*.stories.tsx']`; framework `@storybook/react-vite` ^10.5.0. **No addons** (`package.json` lists only `@storybook/react-vite` and `storybook`: no a11y, themes, docs, or pseudo-states). staticDirs `/pdfjs`. `server.fs.allow` includes `extension/dist/workbench.js`.
- `preview.ts`: imports styles.css, sidebar.css, detail-redesign.css, preview.css; storySort `['Views', ['Sidebar','Terminal workspace','Run context editor'], 'Compositions', 'Primitives', '*']`; backgrounds pane/chrome/well.
- **53 story files, 397 named story exports.** By group: Views 29 files / 251 stories; Views/Helm open (prototype) 10 files / 52; Compositions 6 / 58; Primitives 8 / 36.

### 3.2 Every story file (title | count | stories)

| File | Title | # | Stories |
|---|---|---|---|
| agent-dock/AgentDock.stories.tsx | Compositions/Agent dock | 29 | Queue, HelmTerminals, HelmPlanOpen, HelmPermissionAddDirectories, FiveItems, QuestionOpen, PermissionOpen, PlanOpen, TurnOpen, TurnPrLinks, RealCase, RealCaseTurn, RealCaseQuestion, RealCasePermission, Overflow, OrphanedOpen, AgentsOpen, BackgroundShell, BackgroundShellTurn, SourceDown, Empty, Connecting, Top, ReceiptSending, ReceiptUnconfirmed, ReceiptAnswered, ReceiptRefused, ReceiptFailed, ReceiptEntries |
| agent-dock/AgentDockAgentsEntry.stories.tsx | Views/Agent dock agents entry | 3 | AgentsEntry, States, Narrow |
| agent-dock/AgentDockAgentsPane.stories.tsx | Views/Agent dock agents pane | 10 | ByState, ByProject, ByStateNarrow, ByProjectNarrow, SourcesConnected, SourcesOkenaDown, SourcesHelmConnecting, SourcesOkenaDownNarrow, AgentDetail, AgentDetailNarrow |
| agent-dock/AgentDockArrival.stories.tsx | Views/Agent dock arrival | 2 | Question, Turn |
| agent-dock/AgentDockFocus.stories.tsx | Views/Agent dock focus | 2 | Focused, FocusedEmpty |
| agent-dock/AgentDockPaneHeader.stories.tsx | Views/Agent dock pane header | 3 | Normal, Between, Narrow |
| agent-dock/AgentDockPaneResize.stories.tsx | Views/Agent dock pane resize | 4 | Dragging, Hover, DraggingAbove, HoverAbove |
| agent-dock/AgentDockRevealTerminal.stories.tsx | Views/Agent dock reveal terminal | 9 | TurnOkena, TurnOkenaKeys, QuestionOkena, TurnHelm, AgentDetail, RevealedHelm, FailureGone, FailureUnreachable, NotRaised |
| agent-dock/AgentDockTurnMessage.stories.tsx | Views/Agent dock turn message | 1 | Markdown |
| agent-dock/AgentDockUnderClaudeCode.stories.tsx | Views/Agent dock under Claude Code | 8 | ClaudeCodeSession, RealCaseCollapsed, RealCaseQuestion, RealCasePermission, RealCaseTurn, Overflow, Top, HighContrast |
| document-review/ContentWidth.stories.tsx | Views/Document review/Content width | 3 | Window1000, Window1400, Window1900 |
| document-review/DocumentReview.stories.tsx | Views/Document review | 39 | Reading, NativeEntryLifecycle, CliEditing, MultipleConnectedAgents, LegacyProjectedNotes, InteractiveCanvas, InteractiveCanvasLight, InteractiveCanvasCompact, SavedReviewHistory, SavedReviewStale, SavedReviewUnconfirmed, SavedReviewRejected, CanvasCompileError, CanvasNoCaller, ReviewPersistenceFailure, CommentPersistenceFailure, Editorial, EditorialLight, ContentsNavigation, WritingFirst, PassageConversations, PassageConversationsLight, PassageLongReply, PassageLongReplyLight, PassageList, PassageListLight, Light, Working, MissingFile, UnknownOutcome, Comments, StaleAnchor, Changes, SaveFailure, NoConnectedAgent, ListenerPaused, PassageFeedback, PlainViewing, EmptyPreferencesRecovery |
| open-prototype/AChrome.stories.tsx | Views/Helm open/A Window chrome | 13 | A1TitleRowPlain, A1TitleRowBound, A2StatusLinePlain, A2StatusLineBound, A3BreadcrumbPlain, A3BreadcrumbBound, A4PathThenNamePlain, A4PathThenNameBound, A5NameThenPathPlain, A5NameThenPathBound, A6CollapsingPlain, A6CollapsingBound, LongPathCompare |
| open-prototype/BMultiFile.stories.tsx | Views/Helm open/B Multiple files | 5 | B1Tabs, B2WindowPerFile, B3Sidebar, B3SidebarBound, B4WindowsAndTabs |
| open-prototype/CCode.stories.tsx | Views/Helm open/C Format views/Code | 4 | Default, Search, PlainText, FeedbackMode |
| open-prototype/CDocument.stories.tsx | Views/Helm open/C Format views/Documents | 5 | Docx, Markdown, MarkdownSource, DocxFeedbackMode, MarkdownFeedbackMode |
| open-prototype/CImage.stories.tsx | Views/Helm open/C Format views/Image | 3 | Default, ActualSize, FeedbackMode |
| open-prototype/CJson.stories.tsx | Views/Helm open/C Format views/JSON | 8 | Tree, Raw, FeedbackMode, Yaml, YamlRaw, JsonLines, Toml, TomlRaw |
| open-prototype/CPdf.stories.tsx | Views/Helm open/C Format views/PDF | 3 | Default, Zoomed, FeedbackMode |
| open-prototype/CSheet.stories.tsx | Views/Helm open/C Format views/Spreadsheet | 4 | Workbook, WorkbookSummary, Csv, FeedbackMode |
| open-prototype/DFeedback.stories.tsx | Views/Helm open/D Feedback anchors | 6 | PdfTextSelection, PdfRegion, SpreadsheetRange, ImageRegion, JsonNode, CodeLines |
| open-prototype/ESendReceipt.stories.tsx | Views/Helm open/E Send receipt | 1 | E5ActivityLine |
| remote/RemoteWorkspace.stories.tsx | Views/Helm Remote | 38 | BrowserHarness, Favorites, FavoritesReadOnly, Usage, UsageSignedOut, FavoritesWire, ImageInput, ImmediateSubmitFeedback, CompactHeader, Information, InformationQuestion, Working, WorkingWithHistory, HistoryScroll, HistoryReader, HistoryProgress, HistoryExpired, HistoryProgressQuestion, HistoryExpiredQuestion, HistoryGap, HistoryUnsupported, Composer, ReadingEdge, Reading, PlainThinking, ChainedReply, TerminalMetadata, Readability, RowDensity, LiveScopes, Questions, QuestionsReadOnly, AccessEnded, PairingEntry, PairingFromQr, PairingRecovery, AccessUnavailable, Subagents |
| sidebar/ActivityIndicator.stories.tsx | Primitives/Activity indicator | 4 | InProgress, Waiting, NeedsAttention, WithVisibleLabel |
| sidebar/Banner.stories.tsx | Primitives/Banner | 4 | ErrorBanner, Warning, Info, WithAction |
| sidebar/Button.stories.tsx | Primitives/Button | 10 | Tones, Small, Disabled, Busy, FocusReturn, FormSubmission, Block, IconButtons, IconLedActions, CurrentDestination |
| sidebar/ChipAndDot.stories.tsx | Primitives/Chip and dot | 5 | ChipTones, VerdictChips, StatusMenuTrigger, StatusDots, StatusToneMapping |
| sidebar/ClampText.stories.tsx | Primitives/Clamp text | 2 | Short, Long |
| sidebar/Disclosure.stories.tsx | Compositions/Disclosure group | 3 | Closed, Open, WithSummaryAtRest |
| sidebar/EditorsMaintenance.stories.tsx | Views/Editors maintenance | 4 | SettingsSave, ProfileSave, ScheduleSave, ScheduleCreate |
| sidebar/EmptyState.stories.tsx | Primitives/Empty state | 2 | EmptyBucket, WaitingForDaemon |
| sidebar/ExtensionWidget.stories.tsx | Views/Extension widget | 1 | ClosedShadow |
| sidebar/Field.stories.tsx | Primitives/Field | 4 | TextInputs, TextAreaField, Select, Toggles |
| sidebar/FlatGroup.stories.tsx | Compositions/Flat group | 7 | Groups, FactRows, ActionRows, FullWidthActionHover, NavRows, ItemDestinations, EvidenceGroups |
| sidebar/ListRow.stories.tsx | Compositions/List row | 10 | Resting, FullWidthHover, StatusWords, MetaLineVariants, VerdictRows, QuickActions, LongTitleEllipsis, UnconfiguredProject, UnassignedDraft, ProjectGroups |
| sidebar/Menus.stories.tsx | Compositions/Menu and navigation | 5 | OverflowMenu, WorkMenu, PushNavHeader, PushNavHeaderLongTitle, FinishItemSetupSheet |
| sidebar/RunContextEditor.stories.tsx | Views/Run context editor | 4 | SourceContext, V2PlainContext, Customized, V2EmptyContext |
| sidebar/Segmented.stories.tsx | Primitives/Segmented control | 5 | Boxed, Commit, LifecycleIndex, LifecycleIndexHover, LifecycleIndexStates |
| sidebar/SidebarViews.stories.tsx | Views/Sidebar | 27 | WorkList, WorkListScheduledRunning, NewItem, NewItemNavigation, SwipeBackMidGesture, ItemDetail, UnassignedItemDetail, TaskReading, PlanDocuments, Settings, RunLimitsSettings, RemoteNavigation, RemoteAvailable, RemoteNoDevices, RemotePairingCode, RemoteExpired, RemoteUnavailable, TerminalSettings, AgentIntegrations, AgentIntegrationsExternal, ScheduledRuns, ScheduledRunsDisabled, ScheduledRunEditor, ScheduledRunHistory, Profiles, ProfileKnowledge, Appearance |
| signals/SignalsAsks.stories.tsx | Views/Signals/Agent asks | 4 | NeedsYou, Reply, Links, AnsweredInTerminal |
| signals/SignalsColumn.stories.tsx | Views/Signals/Column | 6 | Column, Quiet, SourceDown, Empty, EmptySourceDown, Widths |
| signals/SignalsDone.stories.tsx | Views/Signals/Done | 2 | Line, List |
| signals/SignalsFlows.stories.tsx | Views/Signals/Flows | 3 | SendToAgent, NewAgentInOkena, FilteredMail |
| signals/SignalsSlack.stories.tsx | Views/Signals/Slack | 2 | Column, Reply |
| TabDrag.stories.tsx | Views/Tab drag | 1 | CollapsedFolders |
| TabNumbers.stories.tsx | Views/Tab numbers | 2 | BuildCollapsed, BuildExpanded |
| TerminalWorkspace.stories.tsx | Views/Terminal workspace | 26 | FullWorkspace, TabStrip, BackgroundTerminals, CollapsedBackgroundGroup, GroupedTabHeaders, CollapsedTabGroup, BrowserHarness, SidebarVisibility, AgentDock, AgentDockQuestion, AgentDockPermission, AgentDockPlan, AgentDockTurn, AgentDockOrphaned, AgentDockAgents, AgentDockNarrow, AgentDockNarrowQuestion, AgentDockSourceDown, AgentDockEmpty, AgentDockTop, AgentDockReceiptSending, AgentDockReceiptUnconfirmed, AgentDockReceiptAnswered, AgentDockReceiptRefused, AgentDockReceiptFailed, AgentDockHarness |
| Toast.stories.tsx | Compositions/Toast | 4 | Message, WithDetail, WithAction, Stack |
| TopbarBackground.stories.tsx | Views/Topbar background terminals | 2 | BackgroundTerminals, States |
| viewer/CsvViewer.stories.tsx | Views/Document review/CSV | 12 | Invoices, InvoicesLightWindow, CzechExcelExport, ExcelSepLine, SentryTsv, Wide500Columns, MillionRows, QuotedLineBreaks, UnclosedQuote, TooManyRows, Windows1250, Empty |
| viewer/PdfViewer.stories.tsx | Views/Document review/PDF | 11 | Report, ReportLightWindow, Scan, Locked, Ledger500Pages, TooManyPages, Cjk, Jbig2Fax, Jpeg2000, ActiveContent, Broken |
| viewer/PictureViewer.stories.tsx | Views/Document review/Pictures | 12 | Screenshot, ScreenshotLightWindow, ExifRotated, Transparent, Svg, Heic, TooLarge, Gif, WebP, Avif, Bmp, Ico |
| viewer/PlainViewer.stories.tsx | Views/Document review/Plain files | 10 | Code, CodeLight, Log, JsonTree, JsonTreeLight, Yaml, Toml, JsonLines, ParseError, LargeJson |

Observations:
- "Compositions/Agent dock" (29) sits under Compositions although it is a full view, and it largely duplicates the `TerminalWorkspace` AgentDock* stories (15) and "Views/Agent dock under Claude Code" (8).
- The viewer stories render through production `DocumentReview` (`viewer/PlainViewer.stories.tsx` imports `../document-review/DocumentReview`), so CsvGrid, DataView, PdfView, and ImageView are covered transitively.

### 3.3 design-system.md §3 → stories

`docs/design-system.md` (820 lines) has §3.1–§3.25, an "Extension prompt quick editor" section, and a "Native document review workspace" appendix.

| § | Component | Story coverage |
|---|---|---|
| 3.1 Buttons | Primitives/Button (10) | ✔ |
| 3.2 Segmented | Primitives/Segmented control (5) | ✔ |
| 3.3 List row | Compositions/List row (10) | ✔ |
| 3.4 Chips | Primitives/Chip and dot | ✔ |
| 3.5 Status dots | Chip and dot → StatusDots, StatusToneMapping | ✔ |
| 3.6 Toast | Compositions/Toast (4) | ✔ |
| 3.7 Inputs & selects | Primitives/Field (4; color well inside Views/Sidebar Appearance) | ✔ (no dedicated color-well/invalid/disabled grid) |
| 3.8 Menus | Compositions/Menu and navigation (OverflowMenu, WorkMenu) | ✔ React MenuButton only. **No story for the terminal tab context menu** (`openMenu`). |
| 3.9 Sheets | Menus → FinishItemSetupSheet | partial: no Primitives/Sheet story; DocumentReview discard sheet only inside review stories |
| 3.10 Push navigation | Menus → PushNavHeader(+LongTitle); Sidebar → NewItemNavigation, SwipeBackMidGesture | ✔ |
| 3.11 Action bar | only inside Sidebar ItemDetail etc. | **no dedicated story** |
| 3.12 Banners | Primitives/Banner (4) | ✔ |
| 3.13 Empty & waiting | Primitives/Empty state (2) | ✔ (sidebar EmptyState only; the other 5 empty grammars appear only in their views) |
| 3.14 Terminal well | Views/Terminal workspace | ✔ (fixture) |
| 3.15 Flat groups & info rows | Compositions/Flat group (7) | ✔ |
| 3.16 Toggle | Primitives/Field → Toggles | ✔ |
| 3.17 Pane scrollbars | — | **no story** |
| 3.18 Background terminals | Terminal workspace → BackgroundTerminals, CollapsedBackgroundGroup; Views/Topbar background terminals | ✔ |
| 3.19 Task detail | Sidebar → TaskReading | ✔ |
| 3.20 Disclosure | Compositions/Disclosure group (3) | ✔ (RemoteDisclosure is not storied separately) |
| 3.21 Activity indicator | Primitives/Activity indicator (4) | ✔ |
| 3.22 Run context editor | Views/Run context editor (4) | ✔ |
| Extension prompt quick editor | Views/Extension widget (1: ClosedShadow) | thin (1 story) |
| 3.23 Helm Remote | Views/Helm Remote (38) | ✔ broad |
| 3.24 Agent dock | 10 files, 71 stories + 15 in Terminal workspace | ✔ broad |
| 3.25 Signals | Views/Signals/* (5 files, 17 stories) | ✔ |
| Appendix: Document review / helm open | Views/Document review (39) + CSV/PDF/Pictures/Plain/Content width (48) + Helm open prototype (52) | ✔ |

### 3.4 Components/screens WITHOUT a story (or only reachable by interaction)

- **Terminal workspace**: tab context menu (`terminal-workspace.ts:2924`), tab-group name form (`:3015`), inline tab rename editor, the `#no-terms` "New terminal" empty card (the fixture builds its DOM at `terminal-workspace-fixtures.tsx:249-256`, but no story shows the zero-terminal state), the overlay terminal scrollbar (§3.17), and the close-tab toast with Undo (only the generic Toast story exists).
- **Remote**: the navigation drawer open (`RemoteNavigationMenu`), the Model `RemoteChoiceSheet` open, the session row long-press menu (`RemoteSessionMenu`), the composer More / delivery menu open, `RemoteDisclosure` expanded (needs Show tool activity), and the offline PWA page. All of these are reachable only by clicking in BrowserHarness-style stories. No story pins them open (`rg -i 'drawer|navigationOpen|choiceSheet|sessionMenu'` in the stories and remote-fixtures finds only description text).
- **Signals → Settings**: `SignalsWorkspace.tsx:150-166` mounts a **stand-in** Settings page (a hand-built `<h2>` and a raw "Back" button), not the real `mountSidebar(... base:'settings')`. The production composition of the left column in Settings mode is not storied.
- **Extension**: one story (`ClosedShadow`, default state). It has no per-state stories (Pill vs Card, each lifecycle, ModelSelect open, ActionMenu open, error/notice states, prompt editor dirty/conflict). Those exist only as Playwright-driven harness states (`window.extensionWorkbench`, `extension/src/widget-workbench.tsx:226-258`). The `popup.html` page is not in Storybook.
- **Primitives without their own story**: `Sheet` (only FinishItemSetupSheet), `GLYPH` (no icon gallery: `rg 'Object.(entries|keys)(GLYPH'` in stories → none), `ProjectColorText` (only inside ListRow), `PushHeader` (inside Menus), `Card`/`InfoRow`/`ActionRow` (inside FlatGroup; that is the composition), and the `createButton`/`createIconButton` DOM adapters.
- **Native-only surfaces**: the macOS app menu, notifications, the DOCK DEV banner (`main.ts:1087`).

### 3.5 Extension workbench

- `extension/build-workbench.mjs` rolls `src/widget-workbench.tsx` through `babel-preset-solid` (same compiler as production) into `extension/dist/workbench.js` (ES module).
- `app/src/renderer/sidebar/ExtensionWidget.stories.tsx` dynamically imports `../../../../extension/dist/workbench.js` (`@vite-ignore`) and calls `mountWidgetWorkbench(ref)`. If the bundle is missing, it renders "Build the extension workbench bundle: …". The Vite fs allowlist (`.storybook/main.ts`) admits exactly that file.
- The workbench mounts the **production closed-shadow `mountWidget`**, intercepts `attachShadow` to keep a fixture reference to the closed root, stubs `window.fetch`/`chrome` with an in-memory daemon (state: profile, generation, protocol 49, lifecycle, revision, hold/fail toggles), and exposes `window.extensionWorkbench` (`state`, `calls`, `query`, `require`, `switchSource`, `release`, `unmountWidget`) for `app/browser-tests/extension-widget.spec.ts`.
- Result: one Storybook entry, "Views/Extension widget → ClosedShadow". States are changed by Playwright, not by stories or controls.

### 3.6 Forced states (hover / focus / disabled grids)

- There is **no general mechanism** (no pseudo-states addon, no shared StateGrid).
- There is exactly **one true forced-state grid**: `TopbarBackground.stories.tsx` → `States` (`StatesView`, lines 189-198, 98-133). It renders closed / viewing / viewing-long / dialog / hover / focus cells in Helm and High-contrast columns. It pins hover/focus through a **story-only `data-bg-preview` attribute that production CSS honours** (`styles.css:115`, `:745-747`, `:815`; comment: "pins hover/focus for the Storybook states grid only").
- Hover through real interaction: 3 stories use a `play` function with `userEvent.hover` on one element: `ListRow → FullWidthHover` (`ListRow.stories.tsx:103`), `FlatGroup → FullWidthActionHover` (`:68`), `Segmented → LifecycleIndexHover` (`:86`). Only one element can be hovered per story, so these are not grids.
- Pinned looks through fixture options: `AgentDockPaneResize` Hover/Dragging (fixture `resizeLook`, "story-only: a story cannot hold the pointer there"). `AgentDockAgentsEntry` focuses an entry in an effect (`:110`).
- Disabled appears as separate static examples: `Button → Disabled`, `IconButtons` (disabled IconBtn, `:139`), `FormSubmission` (ariaDisabled), `FlatGroup → ActionRows` (disabled ActionRow `:59`).
- §7 of the design-system demands "every state in its spec … hover-independent states like selected/disabled/active". Hover/focus/pressed are not systematically shown.
- Story-local styling despite §7's "never story-local styles": `open-prototype/receipt-story.css`, `.storybook/preview.css`, and inline `font: '11px/16px -apple-system…'` in `AgentDockArrival.stories.tsx:43`, `AgentDockPaneHeader.stories.tsx:141`, `TopbarBackground.stories.tsx:140`, `AgentDockAgentsEntry.stories.tsx:133`.

---

## 4. Icons

**There is no single icon module.** Icons live in at least 9 places, and only part of them are listed in `THIRD_PARTY_NOTICES.md` (89 lines; the Heroicons section is at lines 52-65).

| Location | What | Sourced? |
|---|---|---|
| `app/src/renderer/sidebar/ui.tsx:19-78` `GLYPH` | **23 icons**. **20** are built with the local `glyph(d)` helper: 16-viewBox stroke paths at 1.5px (plus, back, chevronRight/Down, external, copy, check, agent, manual, play, queue, retry, stop, pause, return, plan, archive, group, settings, close). 3 are filled: `menu` (= Heroicons Bars 2, in notices), `calendar` (= Heroicons Calendar Days, in notices), `ellipsis` (3 circles) | 20 stroke glyphs + ellipsis **hand-drawn**. This contradicts AGENTS.md "Production icons are sourced, not hand-drawn". |
| `remote/RemoteArrow.tsx` | Heroicons arrow-up/arrow-down 16 solid | ✔ in notices (line 59/61) |
| `document-review/PassageComments.tsx` | Heroicons chat-bubble-left-ellipsis | ✔ (line 64) |
| `app/src/renderer/index.html` (bg-toggle) | Heroicons arrow-down-on-square-stack | ✔ (line 57) |
| `terminal-workspace-fixtures.tsx:177-192` | **duplicate copy** of the index.html SVG, built with createElementNS | duplicate geometry |
| `terminal-workspace.ts:429-445` `GROUP_ICON_PATH` | Heroicons folder (createElementNS) | ✔ (line 56) |
| `sidebar-layout.ts:62-78` | sidebar-toggle panel icon (rect + `M8 4v12`, 20 viewBox, createElementNS) | **hand-drawn, not in notices** |
| `sidebar/sidebar.css:1670` | select chevron data-URI | hand-drawn (spec §3.7 prescribes it) |
| `extension/src/Widget.tsx:834,872` | 2 inline SVGs (chevron 10×6, check 10×8) | hand-drawn |
| `open-prototype/chrome.tsx` | 1 inline SVG | prototype |
| `app/assets/remote/command-line.svg` | PWA icon source | ✔ (line 62) |

Stale notice: `THIRD_PARTY_NOTICES.md:63` names `app/src/renderer/remote/RemoteFavoriteStar.tsx` (Heroicons Star). **That file no longer exists**: it was last touched in commit 62b5d99 "feat(remote): keep the destination bar on every page and section the pinned rows", and no star SVG or ★ glyph remains in the renderer.

Counts:
- `<svg` literals in `app/src` non-story files: **11** total. That is ui.tsx 4, `document-review/viewer-file.ts` 2 (false positives: SVG format detection), `viewer/fixtures/images/release-badge.svg` 1 (fixture), RemoteArrow 1, open-prototype/chrome 1, index.html 1, PassageComments 1. Real production inline `<svg>` icon sites = **7** (ui.tsx 4, RemoteArrow 1, PassageComments 1, index.html 1), plus **2** createElementNS icon sites (terminal-workspace, sidebar-layout), **1** createElementNS duplicate in the fixture, **1** CSS data-URI, and 2 in the extension. Stories contain 0 `<svg`.
- `viewBox` occurrences in app+extension source: 14.
- Unicode characters used as icons: tab context menu `icon: '›'` ×13 and `'+'` ×1 (`terminal-workspace.ts`); `createIconButton` glyphs `'⇥'` ×2, `'×'` ×2 (`terminal-workspace.ts:517,1706,1713`, `toast.ts:103`); `.tab-close` `'×'`; `#new-tab` `'+'`; agent-dock `kindGlyph`/`statusGlyph` (`presentation.ts:795-818`: ✓ ↵ ? ≡ $ ✻ ◐ · ¿ ▪); `RevealWhere` "Okena ↗". Raw character occurrences across non-story/non-fixture `.ts*` (these include strings and comments, so they are an upper bound): × 50, › 27, ‹ 21, ✓ 31, ↗ 15, ● 10, ⇥ 5, ▸ 4, ✎ 2, ○ 2, ▾ 2.
- `createIconButton` takes a text `glyph: string` (`icon-button.tsx:38-60`). So the DOM adapter cannot carry an SVG icon. `sidebar-layout.ts:59` passes `glyph: ''` and then replaces the children with an SVG.

---

## 5. Fonts and type

- **No web fonts** (`@font-face`/woff/ttf: only MIME entries in `app/src/document-review/viewer-protocol.ts:184-186`). The pdf.js standard fonts are shipped for PDF rendering only.
- Canonical stacks: `styles.css:83-84`, `--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif` and `--font-mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace`. Body: `styles.css:104-111`, 13px, `-0.01em`, antialiased. Dock aliases: `--dock-sans/--dock-mono` (`styles.css:1417-1418`), `--dock-fs` 12, `--dock-lh` 18, `--dock-prose-fs` 13, `--dock-prose-lh` 20 (all ×ui-scale).
- **Duplicate/hard-coded stacks outside the tokens**:
  - `terminal-workspace.ts:3442` xterm `fontFamily: "'SF Mono', Menlo, ui-monospace, monospace"` (a different order and no SFMono-Regular; the spec says "the xterm font is set in JavaScript")
  - `run-context/run-context-editor.css:135` `--bn-font-family: -apple-system, …` (BlockNote)
  - `extension/src/widget.styles.ts:55-56` `--vg-font`, `--vg-mono`
  - `open-prototype/open.css:7-8`, `open-prototype/SheetView.tsx:30`
  - `remote/remote.css` uses `var(--font-ui, <full fallback stack>)` (standalone bundle)
  - `viewer/CsvGrid.tsx:139` reads the computed body font for canvas measurement
  - `main.ts:1087` (DOCK DEV banner)
  - 4 stories with inline `-apple-system` fonts (listed in 3.6)
- `font-family` declarations per CSS: sidebar 20, styles 19, remote 7, viewer 5, document-review 5, run-context 1, reading-width 1, button 1 (+ prototype 23). Only one production CSS stack is hard-coded (the run-context BlockNote variable). All others use `var(--…)` or `inherit`.
- **Type scale** (spec §2.2: 17 / 13 / 12 / 11 plus terminal; "Never use font sizes outside this scale"; sizes written `calc(<px> * var(--ui-scale))`):
  - calc() sizes used: 12px ×93, 11px ×51, 13px ×44, 17px ×18, 14px ×6, 16px ×5, 10px ×5, 21px ×3, 15px ×3, 28px ×2, 9px ×1, 20px ×1.
  - Fixed-px (unscaled) sizes used: 12px ×40, 13px ×26, 11px ×15, 16px ×3, 15px ×2, 14px ×2, 9/10/17/21/28 ×1 each. Of those, 37 + 13 + … are in styles.css (13), sidebar.css (1), remote.css (1). The rest are in the prototype (chrome.css alone has 37).
  - **Off-scale sizes (9/10/14/15/16/20/21/28px) in production CSS: 31 declarations**: remote.css 9 (16px phone targets, 20px, 14px), document-review.css 7 (28/21/15, documented reading typography), styles.css 6 (10, 16, 14, 9), run-context-editor.css 5, sidebar.css 3 (10, 14), viewer.css 1 (14). Plus 6 in the prototype.
  - Fixed-px (unscaled) font sizes per production file: styles.css 13, sidebar.css 1, remote.css 1.
- Weights (all CSS): 600 ×74, 500 ×27, 400 ×12, 700 ×3. The 700s are at `styles.css:798` (`.bg-count`), `sidebar.css:1062`, and `document-review.css:953` (`.review-send-refused-glyph`).
- Letter-spacing (spec: "-0.01em everywhere; no style overrides it"): -0.01em ×23, `0` ×13, `normal` ×6, `inherit` ×3, **0.04em ×3** (`styles.css:1522, 2094, 2830`, agent dock), **0.08em ×1** (`sidebar.css:2058`).
- `text-transform: uppercase`: 0 (compliant).
- `font-variant-numeric` is used in remote 2, viewer 6, sidebar 9, detail-redesign 1, scheduled-runs 1, styles 8, document-review 1.

---

## 6. Reference: how Tally is organised (read-only comparison)

- A separate `ui/` package with `DESIGN.md`. Components are grouped by kind: `ui/src/components/{actions,data,feedback,inputs,overlays,reports,shell,time}`, one folder per component (e.g. `actions/Button`, `actions/IconButton`, `feedback/EmptyState`, `feedback/ErrorState`, `overlays/Menu`, `overlays/Sheet`, `inputs/SegmentedControl`, `inputs/Switch`).
- Tokens are TypeScript (`ui/src/tokens/{color,border,motion,material,primitives,…}.ts`) with contrast tests.
- **One icon facade**: `ui/src/icons/{Icon.tsx, lucide.ts, catalog.ts, glyphs.tsx}`. App icons are generated from it by `ui/scripts/icons.ts`.
- `ui/src/storybook/StateGrid.tsx` renders each component in rest/hover/pressed/focus/disabled through `data-force-state`. Component CSS writes `:is(:hover,[data-force-state="hover"])`. `StateGrid` appears in 125 files under `ui/src`.
- Storybook 10.6 with addon-a11y, addon-docs, and addon-themes. There are 93 stories under `ui/src`, plus `ui/src/patterns/*.stories.tsx` (cross-component flows).

Helm has none of these four: no component folders, no icon facade, no forced-state convention, no a11y/themes addons.
