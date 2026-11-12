# Helm token audit (color / typography / spacing / radius / z / motion)

Worktree: `/Users/jakubneumann/Documents/code/neumie/helm-wt/feat-design-system` (branch `feat/design-system`, HEAD 10fa3b7). Read-only audit.
Tooling: custom Python scanners in `tools/` (`cssvars.py` = custom-property extractor with selector context; `scan.py` = literal scanner over 372 files: `app/src/**/*.{css,ts,tsx,html}` + `extension/src/**` minus `*.d.ts`/`*.generated.ts`; `report.py` = per-file tallies). CSS is parsed per declaration (comments stripped); TS is scanned per line with comments stripped and literals required inside a quote/backtick context. All numbers below come from those runs or from the grep commands quoted.

File classes used: **production**, **story** (`*.stories.tsx`, `*-stories.tsx`), **fixture** (`*fixture*`, `*workbench*`), **prototype** (`app/src/renderer/open-prototype/**`, Storybook-only — imported only by stories, viewer fixtures and `app/scripts/open-prototype-fixtures.mjs`), **test**.

---

## 1. Token definition sources (inventory)

| # | Source | Scope / selector | Count | Role |
|---|---|---|---|---|
| 1 | `app/src/theme-presets.ts` `HELM_TOKENS` (L18–82) | JS object | 54 tokens | Declared canonical source ("Helm" preset) |
| 2 | `app/src/theme-presets.ts` `HIGH_CONTRAST_TOKENS` (L84–137) | `...HELM_TOKENS` + 51 overrides | 51 explicit; inherits `--on-accent`, `--shadow-1`, `--shadow-2` | Second preset |
| 3 | `app/src/renderer/styles.css` `:root` (L8–88) | `:root` | 64 custom props (54 theme mirrors + 6 derived soft/strong + `--font-ui`, `--font-mono`, `--left-width`, `--ui-scale`) + `color-scheme: dark` | Pre-JS first-paint mirror |
| 4 | `app/src/renderer/appearance.ts` | runtime `documentElement.style.setProperty` (L300–307) | resolves `helmBase ∪ theme ∪ overrides` (`resolveTokens`, L101–107), sets `--ui-scale` | Only runtime owner; also `termThemeFromTokens` (L111–135) maps 21 `--term-*`/`--ansi-*` → xterm |
| 5 | `app/src/renderer/styles.css` `.agent-dock` (L1417–1428) and `.signals` (L3220–3226) | component scope | 8 + 7 | `--dock-mono/-sans/-fs/-lh/-prose-fs/-prose-lh/-dim` (identical in both blocks), `--dock-inset: 16px` (dock only); plus `--arrival-color` (L1731/1735), `--agent-row` (L2911) |
| 6 | `app/src/renderer/document-review/document-review.css` | `.document-review` (L2), `[data-review-theme="light"]` (L13–36), various | 30 | Scoped **light** palette (21 overrides) + layout knobs (`--review-*`) + `--ui-scale` re-scope (L1246–1249) |
| 7 | `app/src/renderer/viewer/viewer.css` | `.viewer-window` (L8–15), `[data-review-theme="light"]` (L19–25), `.viewer-stage` (L36), pdf.js text layer (L707–737) | 24 | Syntax tokens `--syntax-*` (8 dark→ANSI, 7 light literals), pdf.js vars |
| 8 | `app/src/renderer/remote/remote.css` | `:root.remote-page` (L2), `.remote-workspace, .remote-login, .remote-empty` (L28–38), `.remote-workspace` (L56), media blocks (L1060–1097) | 18 | Remote's own surface ladder (7 overrides + `--remote-page`, `--remote-bubble`) + composer layout knobs |
| 9 | `app/src/renderer/run-context/run-context-editor.css` `.run-context-editor .bn-container` (L135–153) | BlockNote theme | 19 | Maps `--bn-*` → Helm tokens; radii 4/6/8; **font stack written literally** (L135) |
| 10 | `app/src/renderer/reading-width.css` `[data-reading-width]` (L16–17) | | 2 | `--reading-measure` 680px, `--reading-block-max` 1280px (both × ui-scale) |
| 11 | `extension/src/widget.styles.ts` `:host` (L13–57) | shadow root | 33 | `--vg-` prefixed copy of the palette + soft fills + radius ladder + shadows + fonts |
| 12 | `extension/src/popup.html` `<style>` (L4–57) | page | 0 tokens | **Hard-coded VS Code palette, no tokens at all** |
| 13 | `app/assets/remote/manifest.webmanifest` | PWA | — | `background_color` / `theme_color` `#0d0d0d` |
| 14 | `app/scripts/build-remote.mjs` L19 | generated HTML | — | `<meta name="theme-color" content="#0d0d0d">`, `color-scheme: dark` |
| 15 | `app/assets/remote/remote-sw.js` L31 | offline page inline `<style>` | 4 | `:root{--pane:#141517;--text-0:#ececee;--text-1:#9a9ea6;--accent:#4c9aff}` |
| 16 | `app/scripts/write-remote-icons.mjs` L7–18 | authoring tool | — | Regex-reads `--pane`/`--text-0` hex from `styles.css` for PNG icons |
| 17 | `app/.storybook/preview.ts` L24–29 | Storybook backgrounds | 3 | `pane #141517`, `chrome #1a1c1f`, `well #0f1113` (hard-coded) |
| 18 | Native window backgrounds | `app/src/main.ts:1108`, `app/src/run-context-window.ts:151`, `app/src/document-review/window.ts:61–62` | 4 literals | `'#141517'` ×3, `'#faf9f6'` (review light) |
| 19 | Inline style custom props in TSX | `DocumentReview.tsx:2167` (`--review-companion-width`, `--review-zoom`), `ui.tsx:101` (`--project-color`), Csv/Pdf/Plain/PictureViewer (`--review-zoom`), `sidebar-layout.ts:96–99` (`--left-width`, `--sidebar-*`), `terminal-workspace.ts:426/2700` (`--group-color`), `SignalsWorkspace.tsx:147`, `RemoteWorkspace.tsx:290/1057`, `AppearancePage.tsx:114–116` (accent family override) | — | Runtime layout/state vars, not palette |
| 20 | Prototype only: `open-prototype/open.css:7–8` (`:root --font-ui/--font-mono`), `json.css:8–9`, `chrome-combined.css:8–9`, `pdf.css:52–82` | | 14 | Storybook prototypes |
| 21 | Document canvas | none of its own | — | `.review-canvas` rules in `document-review.css:1138–1220` consume shared tokens; `canvas-display.ts:118–126` only validates producer `style` props (≤40 keys) — no token layer |
| 22 | `docs/design-system.md` §2 (L19–177) | documentation | — | Declares tokens that **do not exist in code**: `--radius-lg/md/sm`, `--motion-exit/state/enter` (see §3) |

Tally reference (for comparison only): `/Users/jakubneumann/Documents/code/neumie/tally/ui/src/tokens/*.ts` (color, space, radius, motion, z, typography, shadow…) is the one source; `ui/scripts/tokens.ts` generates `ui/src/styles/tokens.css` (665 lines, `--tl-` prefix, `light-dark()` pairs), Swift `DesignTokens.swift`, the PWA manifest and `theme-color` metas; guarded by `ui/scripts/tokens.test.ts` plus `ui/src/tokens/contrast.test.ts` / `typography.test.ts`. Helm has none of that generation or guarding.

---

## 2. Duplication / mismatch tables

### 2.1 `styles.css :root` vs `HELM_TOKENS` (programmatic compare, whitespace/case-normalized)

- Keys in HELM_TOKENS missing from `:root`: **none**.
- Value mismatches: **none (0 of 54)**.
- Keys in `:root` not in HELM_TOKENS (10): `--accent-soft`, `--success-soft`, `--warn-soft`, `--danger-soft`, `--neutral-soft`, `--danger-strong` (derived via `color-mix`, L43–48), `--font-ui`, `--font-mono`, `--left-width`, `--ui-scale`.
- **No test enforces this sync** (comment at `styles.css:1–7` says "Keep both files in sync").

### 2.2 Extension `--vg-*` vs HELM_TOKENS (programmatic)

All 22 mappable color/shadow tokens are **SAME**: chrome, pane, hairline, hairline-strong, fill-subtle/raised/strong, thumb, text-0/1/2, accent, accent-fill, accent-fill-hover, on-accent, shadow-1, shadow-2; renamed semantic tones `--vg-green=#4ec98a(=--success)`, `--vg-amber=#e0b341(=--warn)`, `--vg-red=#f2585b(=--danger)`, `--vg-blue=#4c9aff(=--accent)`, `--vg-gray=#8a8f98(=--neutral)`.
Differences:
| Item | Extension | App | Note |
|---|---|---|---|
| Tone names | `--vg-green/amber/red/blue/gray` | `--success/warn/danger/accent/neutral` | design-system §2 says "prefix is the only allowed difference" → **naming drift** |
| `--vg-blue` | duplicate of `--vg-accent` | no `--blue` | redundant |
| `--vg-radius-lg/md/sm` 8/6/4 | defined | **not defined in app** | app documents but never defines these |
| `--vg-font` / `--vg-mono` | single-quoted stacks | double-quoted | equivalent |
| Missing in extension | — | `--well`, `--thumb-hover`, `--scrim`, `--group-*`, `--term-*`, `--ansi-*` | expected for a widget |
| Raw radii despite radius tokens | 7 raw (`999px` ×3, `50%`, `6px` L196, `8px` L198, `6px` L204) vs 10 `var(--vg-radius…)` uses | | |

### 2.3 Extension popup (`extension/src/popup.html` + `popup.ts`) — completely off-token

| Line | Value | Nearest Helm token |
|---|---|---|
| popup.html:9 | `background: #252526` | `--pane #141517` |
| :10, :31 | `color: #cccccc` | `--text-0 #ececee` |
| :16, :36 | `#007acc` | `--accent #4c9aff` |
| :22, :46 | `#808080` | `--text-1 #9a9ea6` / `--text-2` |
| :28 | `#1e1e1e` | `--well` / `--fill-subtle` |
| :29 | `1px solid #3c3c3c` | `--hairline` |
| :40 | `#6a9955` | `--success #4ec98a` |
| :30 | `border-radius: 3px` | `--radius-sm` 4 |
| popup.ts:28 | `'#6a9955'` | `--success` |
| popup.ts:32, :37 | `'#f14c4c'` | `--danger #f2585b` |
Also 6 raw font sizes (11px ×3, 12px ×2, 14px) and a font stack without `'SF Pro Text'`.

### 2.4 Remote (`remote.css`) overrides vs HELM (dark → dark, scoped to `.remote-workspace, .remote-login, .remote-empty`)

| Token | Remote | HELM | Same? |
|---|---|---|---|
| `--pane` | `var(--remote-page, #0d0d0d)` → `#0d0d0d` | `#141517` | **DIFF** |
| `--chrome` | `#1c1c1e` | `#1a1c1f` | **DIFF** |
| `--well` | `#1a1a1a` | `#0f1113` | **DIFF** (and now *lighter* than `--pane`: ladder inverted) |
| `--hairline` | `rgb(255 255 255 / 8%)` | `0.07` | **DIFF** |
| `--hairline-strong` | `/ 16%` | `0.16` | same |
| `--fill-subtle` | `/ 5.5%` | `0.05` | **DIFF** |
| `--fill-raised` | `/ 11%` | `0.09` | **DIFF** |
| `--fill-strong` | not overridden (0.13) | 0.13 | step gap now 0.11→0.13 |
| `--remote-page` / `--remote-bubble` | `#0d0d0d` / `#2f2f2f` | — | remote-only |
Related surfaces disagree with remote's own page color:
| Surface | Value |
|---|---|
| manifest `background_color`/`theme_color` | `#0d0d0d` (matches) |
| build-remote meta theme-color | `#0d0d0d` (matches) |
| `remote-sw.js:31` offline page `--pane` | **`#141517`** (Helm pane, not remote page) |
| `write-remote-icons.mjs` icon background | reads `--pane` from `styles.css` → **`#141517`** |
The remote bundle imports `styles.css` (+ sidebar.css, detail-redesign.css) via `remote/entry.tsx:3–5` but never runs `appearance.init()`, so it is always the `:root` Helm palette + its own overrides (no High contrast, `--ui-scale` stays 1).

### 2.5 Document Review scoped light palette (`document-review.css:13–36`) vs HELM dark

| Token | Light | Dark (HELM) |
|---|---|---|
| `--chrome` | `#f1f0ed` | `#1a1c1f` |
| `--pane` | `#faf9f6` | `#141517` |
| `--well` | `#ebeae6` | `#0f1113` |
| `--text-0` | `#24272c` | `#ececee` |
| `--text-1` | `#60646c` | `#9a9ea6` |
| `--text-2` | **`#62666e`** | **`#62666e`** (identical in both themes; light `--text-2` is *darker-equal* to `--text-1` `#60646c` — faint and secondary are nearly the same) |
| `--hairline` / `-strong` | `rgba(0,0,0,.07/.16)` | white .07/.16 |
| `--fill-subtle/raised/strong` | black .05/.09/.13 | white .05/.09/.13 |
| `--thumb` / `--thumb-hover` | `color-mix(--text-0 14%/24%)` | white .14/.24 |
| `--accent` / `--accent-fill` | `#176ac2` / `#176ac2` | `#4c9aff` / `#3b82f6` |
| `--accent-fill-hover` | `#125ba8` | `#5a9dff` |
| `--danger` / `--warn` / `--success` | `#b91c1c` / `#8a5a0a` / `#267347` | `#f2585b` / `#e0b341` / `#4ec98a` |
| `--danger-soft`, `--warn-soft` | re-derived in scope | `:root` |
| **Not overridden** | `--neutral`, `--on-accent`, `--scrim`, `--shadow-1/2`, `--term-*`, `--ansi-*`, `--group-*`, `--accent-soft`, `--success-soft`, `--neutral-soft`, `--danger-strong`, `--term-scroll-thumb*` | |

**Latent bug — derived tokens computed at `:root`:** `--accent-soft`, `--success-soft`, `--neutral-soft`, `--danger-strong` are declared on `:root` as `color-mix(var(--accent|…))`; custom properties substitute `var()` where declared, so descendants inherit the *dark* computed value. In the light scope only `--danger-soft`/`--warn-soft` were re-declared. The review window imports `sidebar.css` (`document-review.tsx:5–6`), which uses `--accent-soft` (sidebar.css L194 `.menu-trigger-badge`, L618 `.chip-blue`), `--success-soft` (1), `--neutral-soft` (1), `--danger-strong` (1) — those render with the dark tones on a light surface. `TopbarBackground.stories.tsx:151–156` explicitly re-declares soft fills with the comment "the derived soft fills, which compute where they are declared", proving the behavior is known. Design-system L823 claims "Semantic soft fills remain 15%".
Light shadows (`--shadow-1/2` black .35/.6) and `--neutral` `#8a8f98` are dark-tuned values left on light.

Light window native background: `app/src/document-review/window.ts:61–62` duplicate literals `#141517` / `#faf9f6` (tested in `tests/document-review-views.test.ts:610–629`). Selection: `data-review-theme={theme}` on `DocumentReview.tsx:2164` and each viewer (`PlainViewer.tsx:112`, `PictureViewer.tsx:76`, `PdfViewer.tsx:36`, `CsvViewer.tsx:151`).

### 2.6 Viewer syntax tokens (`viewer.css`)

| Token | Dark | Light (literal) |
|---|---|---|
| `--syntax-keyword` | `var(--ansi-magenta)` | `#8a3ab0` |
| `--syntax-string` | `var(--ansi-green)` | `#1f7347` (vs light `--success` `#267347`) |
| `--syntax-number` | `var(--ansi-cyan)` | `#0a6878` |
| `--syntax-comment` | `var(--text-2)` | inherits `--text-2` |
| `--syntax-type` | `var(--ansi-yellow)` | `#855708` (vs light `--warn` `#8a5a0a`) |
| `--syntax-function` | `var(--ansi-blue)` | `#1764b8` (vs light `--accent` `#176ac2`) |
| `--syntax-property` | `var(--ansi-white)` | `#24272c` (= light `--text-0`, duplicated literal) |
| `--syntax-invalid` | `var(--ansi-red)` | `#b91c1c` (= light `--danger`, duplicated literal) |
Near-duplicates of light semantic tones with slightly different values (string/type/function) — three different "light green/amber/blue" exist.

### 2.7 Font-family duplicates

| Location | Stack | vs `--font-ui`/`--font-mono` |
|---|---|---|
| `styles.css:83–84` | canonical | — |
| `open-prototype/open.css:7–8` (`:root`) | identical | SAME (prototype redefines `:root`) |
| `remote.css:50,176,606` | `var(--font-*, <same stack>)` fallbacks | SAME |
| `run-context-editor.css:135` `--bn-font-family` | literal UI stack | SAME value but **not `var(--font-ui)`** |
| `extension widget.styles.ts:55–56` | same (single quotes) | SAME |
| `terminal-workspace.ts:3442` xterm `fontFamily` | `'SF Mono', Menlo, ui-monospace, monospace` | **DIFF order** (Menlo before ui-monospace; no SFMono-Regular) vs `--font-mono` `"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace` |
| `extension/src/popup.html:8` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | **DIFF** (no `'SF Pro Text'`) |
| `main.ts:1087` DOCK DEV pill | `-apple-system,system-ui,sans-serif` | dev-only |

### 2.8 Other duplicated literals of token values

| Location | Literal | Token |
|---|---|---|
| `app/.storybook/preview.ts:26–28` | `#141517`, `#1a1c1f`, `#0f1113` | `--pane/--chrome/--well` (SAME; no HC/light options) |
| `main.ts:1108`, `run-context-window.ts:151`, `document-review/window.ts:61` | `'#141517'` | `--pane` — ignores High contrast (`--pane #0c0d0f`) and custom themes |
| `ListRow.stories.tsx:83–84` | `'#4ec98a'`, `'#4c9aff'` | `--success`, `--accent` |
| `TopbarBackground.stories.tsx:154–155` | soft-fill formulas | re-declares `:root` derivations |
| `.agent-dock` vs `.signals` `--dock-*` (styles.css L1417–1425 vs L3220–3226) | 7 identical declarations | duplicated block |
| `AppearancePage.tsx:116` | `color-mix(in srgb, ${hex} 78%, white)` | hover derivation not a token |

### 2.9 Referenced-but-never-defined custom properties (critical)

Scanned all `var(--x)` across `app/src`, `extension/src`, `app/.storybook` vs every definition (CSS, quoted TS keys, `setProperty`):

| Var | Refs | With fallback | Without fallback (broken → property invalid at computed time) |
|---|---|---|---|
| `--radius-md` | 6 | 5 | `sidebar/sidebar.css:2051` `.remote-qr { border-radius: var(--radius-md) }` → radius 0 |
| `--radius-lg` | 4 | 3 | `sidebar/sidebar.css:1891` (`.sheet { border-radius: var(--radius-lg) }` — every sidebar sheet; document-review overrides it with a fallback at document-review.css:1210) → 0 |
| `--radius-sm` | 3 | 1 | `styles.css:999` `.menu-name-input`, `sidebar/detail-redesign.css:36` `.status-menu-trigger` → 0 |
| `--motion-state` | 5 | 5 | (viewer.css:458; prototype sheet.css:110,207, doc.css:103×2) — always fallback 140ms |
| `--accent-text` | 1 | 0 | `sidebar/sidebar.css:1824` `.shortcut-recording { color: var(--accent-text) }` → inherits parent color, not accent |
| `--bg-0` | 1 | 0 | `ActivityIndicator.stories.tsx:15` (story background → transparent) |
| `--total-scale-factor` | 2 | 0 | set by pdf.js at runtime (OK) |
| `--depth` | 5 | 0 | set via inline style in `chrome-combined.tsx:16,191` (OK, prototype) |
Fallback users: `document-review.css:423,709,766,1191,1210`, `remote.css:616,717,1563,1572` (`var(--radius-*, Npx)`).
`docs/design-system.md` §2.4 (L111–120) and §2.5 (L122–130) document `--radius-lg/md/sm` and `--motion-exit/state/enter` as canonical tokens; **none is defined anywhere in app code**. Only the extension defines radii (`--vg-radius-*`).

### 2.10 Tokens defined in `:root` with zero `var()` references
`--group-*` (7; consumed via `tabGroupColorCssVar` string `var(--group-${color})` in `app/src/tab-group-colors.ts`), `--term-fg/-cursor/-cursor-accent/-selection`, `--ansi-black`, all 8 `--ansi-bright-*` (consumed by JS `termThemeFromTokens`). Expected, but they are invisible to grep-based audits.

### 2.11 Theme application coverage
`appearance.init()` runs only in `app/src/renderer/renderer.ts` and `app/src/renderer/run-context-editor.tsx`. Document Review / `helm open` viewer windows (`document-review.tsx`) and Remote (`remote/entry.tsx`) never import `appearance`: no High contrast (incl. macOS Increase Contrast auto-follow), no custom theme, no per-token overrides, and `--ui-scale` stays at the `:root` default `1` (the review's `--review-ui-scale: var(--ui-scale, 1)` at document-review.css:1246 therefore never follows Settings).

---

## 3. Raw literal counts outside token-definition blocks

### 3.1 Color literals (hex, rgb/rgba/hsl/oklch…, named colors) — excluding custom-property declarations and `theme-presets.ts`

Scanner totals: production **36**, story **11**, fixture **5**, prototype **1** (19 files). Token-definition literals (inside `--x:` declarations): 217 (theme-presets.ts 106, styles.css 55, widget.styles.ts 23, document-review.css 17, remote.css 9, viewer.css 7).

Per file (production):
| Count | File | Detail |
|---|---|---|
| 10 | `extension/src/popup.html` | full VS Code palette (§2.3) |
| 10 | `app/src/renderer/remote/remote.css` | `:10` `var(--remote-page, #0d0d0d)` fallback; `:817–818` Send `#fff`/`#0d0d0d`; `:822` `rgb(255 255 255 / 88%)`; scrims `:1356,:1617` `rgb(0 0 0 / 58%)` (vs `--scrim` 0.4); bespoke shadows `:860` `0 16px 44px /48%`, `:1372` `20px 0 60px /48%`, `:1565` `0 8px 24px /35%` (= `--shadow-1` literal), `:1634` `0 20px 60px /55%` |
| 3 | `extension/src/popup.ts` | L28 `#6a9955`, L32/L37 `#f14c4c` |
| 3 | `app/src/main.ts` | L1087 DOCK DEV pill `#c2410c`, `#fff` (dev-only); L1108 `backgroundColor: '#141517'` |
| 2 | `app/src/renderer/styles.css` | L2270, L2286 `mask-image … #000` (alpha mask — functional, not a paint color) |
| 2 | `app/src/document-review/window.ts` | L61 `#141517`, L62 `#faf9f6` |
| 2 | `app/src/renderer/sidebar/AppearancePage.tsx` | L48 `'#000000'` fallback for `<input type=color>`; L116 `white` in hover `color-mix` |
| 1 | `app/src/run-context-window.ts` | L151 `'#141517'` |
| 1 | `app/src/renderer/viewer/viewer.css` | L685 `background: #fff` (PDF paper; sanctioned in design-system L775) |
| 1 | `app/src/renderer/sidebar/SettingsPage.tsx` | L656 `'#808080'` color-input default |
| 1 | `app/src/renderer/remote/image-preparation.ts` | L85 `fillStyle = '#ffffff'` (JPEG flatten; functional) |
Stories/fixtures/prototype:
| Count | File | Notes |
|---|---|---|
| 4 | `TabDrag.stories.tsx` L46–49 | **false positive**: `color: 'blue'` = `TabGroupColor` enum |
| 2 | `TabNumbers.stories.tsx` L52–53 | false positive (enum) |
| 3 | `terminal-workspace-fixtures.tsx` L366, 850, 851 | false positive (enum) |
| 3 | `sidebar/SidebarViews.stories.tsx:374` | `projectColors` `#7aa2f7`, `#bb9af7`, `#9ece6a` (user project colors — data) |
| 2 | `sidebar/ListRow.stories.tsx:83–84` | token values duplicated |
| 1 | `agent-dock/agent-dock-fixtures.ts:2005` | false positive (prose text) |
| 1 | `viewer/pdf-fixtures.ts:39` | canvas `#fff` |
| 1 | `open-prototype/pdf.css:33` | `#fff` paper |
Genuine raw color literals: production ≈ 36 (of which ~9 functional/sanctioned: 2 masks, PDF paper, JPEG flatten, color-input defaults, 2 dev-pill), stories 5, fixtures 1, prototype 1. The extension widget (`widget.styles.ts`) and all sidebar CSS have **zero** raw colors outside `:host`/`:root`. Ad-hoc `color-mix` percentages (not literals, but per-component alpha recipes): 58 `color-mix(` in production CSS — styles.css 26, viewer.css 12, widget 10, document-review.css 10, remote.css 5, sidebar.css 2, scheduled-runs.css 1, button.css 1; percentages used: 15%×26, 30%×15, 55%×6, 60%×5, 22%×3, then 68/6/20/12/10 ×2 and 80/70/50/40/35/24/14 ×1.

### 3.2 Font sizes

Production CSS font-size declarations: **231 scaled** (`calc(Npx * var(--ui-scale))`: sidebar.css 73, document-review.css 52, remote.css 51, viewer.css 19, run-context-editor.css 12, styles.css 9, detail-redesign.css 9, scheduled-runs.css 4, button.css 2), **25 via var** (styles.css 24 `var(--dock-fs|--dock-prose-fs)` which are themselves scaled; viewer.css 1 pdf.js), **46 raw** in production:
| Raw | File |
|---|---|
| 22 | `extension/src/widget.styles.ts` (12px×11, 13px×5, 11px×4, 16px×2) — extension does not scale (no `--ui-scale` there) |
| 13 | `app/src/renderer/styles.css`: L108 body 13px, L657 `.tab-rename` 12, L679 `.tab-close` 13, L707 `#new-tab` 16, L780 `.bg-current` 13, L797 `.bg-count` 10, L855 `.bg-header` 12, L951 `.bg-title` 13, L963 `.bg-state` 11, L970 `.bg-action-glyph` 16, L974 `.bg-kill-glyph` 14, L1293 `.toast-msg` 13, L1304 `.toast-detail` 11 (terminal chrome / background popover / toast) |
| 6 | `extension/src/popup.html` |
| 2 | `remote.css`: L540 `0.92em`, L1028 `16px` (iOS input zoom guard — intentional) |
| 1 | **`sidebar/sidebar.css:751` `.menu-item .menu-hint { font-size: 11px }`** — the only unscaled sidebar font-size (violates §2.2 "every sidebar font-size … calc") |
| 1 | `viewer.css:456` `0.92em`; `reading-width.css:62` `0.92em` |
Prototype: 78 raw (chrome.css 37, doc.css 11, chrome-hybrid.css 9, code.css 6, sheet.css 5, open.css 4, json.css 4, chrome-combined.css 2).
TS: only `terminal-workspace.ts:3441` `fontSize: appearance.getTermFontSize()` (OK).

Off-scale sizes (spec scale 11/12/13/17 + review 15/21/28): px values in production CSS font-size: 9×1, 10×6, 11×53, 12×97, 13×50, 14×7, 15×4, 16×8, 17×18, 20×1, 21×3, 28×2. Off-scale lines: styles.css L318 (10), L707 (16), L797 (10), L970 (16), L974 (14), L2668 (9); run-context-editor.css L35, L204 (10), L42, L161 (14), L233 (15); sidebar.css L547, L1061 (10), L706 (14); viewer.css L841 (14); remote.css L278, L442, L1446, L1659, L1681 (16), L520 (20), L875, L1422 (14).
Font weights (production + extension): 600×69, 500×30, 400×13, 700×3, **650×1 (extension/src/widget.styles.ts)** — 500/400 conflict with §2.2 "Never bold below 600" only where used for emphasis (body/title 400/500 are spec'd).

### 3.3 z-index

Raw CSS z-index declarations: production **45**, prototype 14; **zero tokens** (no `--z-*` anywhere). Value distribution (production): `-1`×5, `0`×4, `1`×6, `2`×6, `3`×4, `4`×2, `5`×1, `8`×1, `9`×1, `10`×3, `30`×1, `40`×3, `60`×4, `70`×1, `100`×1, `2147483647`×2.
Per file: styles.css 12, viewer.css 10, remote.css 10, sidebar.css 8, widget.styles.ts 4, document-review.css 1. Off-table layers (§2.7 table is 0/10/40/60/100): `styles.css:1118` 9, `:1174` 8; `sidebar.css:1975` 30; `remote.css:1345` **70** (above sheet 60); widget `:198` 5. Extra: `main.ts:1087` inline `z-index:2147483647` (dev pill). TS: `AgentDockArrival.stories.tsx:42` `zIndex: 10`.

### 3.4 Durations / easings vs motion tokens

Motion tokens: **none defined** (`--motion-*` documented only). Only one production reference: `viewer.css:458` `var(--motion-state, 140ms)` (falls back).
- CSS transition durations (production): 77 occurrences — 140ms×67, 120ms×4, 150ms×3, 0.01ms×3 (reduced-motion clamps) → 74/77 on spec values but **all hard-coded**.
- CSS animation durations (production): 120ms×5, 140ms×2, 150ms×5, **160ms×5** (remote L1299, L1313, L1360, L1469, L1621), **180ms×2** (remote L1373, L1637), 0.9s×1 (styles.css:578), 1s×1 (L534), 1.4s×4 (styles.css L1124, L1740, L1745, L1749), 1.6s×3 (spec ambient), 1.8s×2 (L594, L626), 4.8s×1 (L3480), plus 0/0.01 clamps.
- Per file duration count (raw): styles.css 48, sidebar.css 25, widget.styles.ts 18, remote.css 17, button.css 2, viewer.css 1, document-review.css 1.
- Easings (production CSS): `ease-out`×95, `ease-in-out`×7, `cubic-bezier(0.22, 1, 0.36, 1)`×2 (remote), `linear`×1. Per file: styles.css 44, sidebar.css 25, widget 16, remote.css 15, viewer 2, button 2, document-review 1.
- TS motion literals: `terminal-workspace.ts` WAAPI `duration: 160` (L1833), `140/180` (L2054, L2378, L2775) with `cubic-bezier(0.2, 0.8, 0.2, 1)` ×4; `sidebar/swipe.ts` `SWIPE_COMMIT_EASING 'cubic-bezier(0.16, 1, 0.3, 1)'` (L60), `SWIPE_SPRING_EASING 'cubic-bezier(0.32, 0.72, 0, 1)'` (L62), 90–240ms constants (L40–58); `toast.ts:30` `EXIT_MS = 160`, L117 `linear`; `REVEAL_PULSE_MS 1_400` (terminal-workspace.ts:100), `ARRIVAL_FLASH_MS 1_400` (use-arrival-flash.ts:6) — four distinct cubic-beziers across code, none in the spec.
- Reduced-motion blocks: styles.css 7, document-review.css 2, remote.css 1, viewer.css 1, widget 1; sidebar.css/detail-redesign/run-context/button rely on the global clamp in styles.css (imported by every bundle).

### 3.5 Border radius

Raw px/% radii: production **97**, prototype 26; `var(--radius-*)` refs: 13 (5 document-review, 4 remote, 2 sidebar, 1 styles, 1 detail-redesign), 4 of which are broken (no fallback, §2.9).
Per file: styles.css 30, sidebar.css 25, remote.css 18, widget 7, document-review.css 7, viewer.css 4, run-context 2, button.css 2, detail-redesign 1, popup.html 1.
Value distribution (production): 999px×28, 6px×24, 4px×14, 8px×11, 12px×3, 3px×3, 18px×2, 1px×2, 50%×2, 2px×2, 10px×1, 28px×1, 24px×1, `6px 0 0 6px`×1, `0 6px 6px 0`×1, 1.5px×1.
Off-ladder (spec 8/6/4/999; "Never 10/12/14px"): `remote.css` L185 10px, L473 18px, L677 28px, L859 18px, L874 12px, L1262 12px, L1440 12px, L1632 24px; `sidebar.css` L391 1px, L1623 1px, L1849 3px; `styles.css` L1863 1.5px, L2530 3px; `viewer.css` L135, L686 2px (PDF paper, spec'd); `popup.html:30` 3px.

### 3.6 Spacing (no tokens exist)
Padding/margin/gap/inset px values in production CSS + widget: 747 occurrences; off the 4-scale (excluding 0/1/2): **112** (3×3, 5×8, 6×37, 7×5, 9×1, 10×31, 11×2, 13×1, 14×7, 18×3, 22×2, 28×2, 40×2, 48×2, 80×1, 84×3, 90×2). Some are spec'd component metrics (button padding 10/14, 84/90 traffic-light reserves). Per file off/total: styles.css 37/185, sidebar.css 22/143, remote.css 14/147, document-review.css 9/125, run-context 9/24, viewer.css 7/51, detail-redesign 5/19, widget 5/39, button.css 3/3, scheduled-runs 1/11. Only spacing custom properties: `--dock-inset: 16px` (styles.css:1428), `--review-bottom-padding`, `--composer-floor`.

---

## 4. Existing test coverage of tokens

- `tests/helm-appearance.test.ts` imports `THEME_PRESETS`/`DEFAULT_THEME_ID` and tests `resolveTokens` layering (L56–75), `termThemeFromTokens` mapping every `--term-*`/`--ansi-*` (L77), High contrast auto-follow (L89). **It does not compare presets to `styles.css :root`.**
- No test compares `widget.styles.ts` `--vg-*` to HELM_TOKENS, nor popup, Remote PWA colors, Storybook backgrounds, native window backgrounds (except `tests/document-review-views.test.ts:610–629` asserting literal `#141517`/`#faf9f6` window backgrounds).
- CSS-reading tests exist but assert component rules, not tokens: `tests/helm-toast.test.ts`, `helm-banner.test.ts`, `helm-flat-group.test.ts`, `helm-disclosure.test.ts`, `helm-scrollbar-gutter.test.ts`, `helm-window-drag.test.ts`, `helm-tab-groups-renderer.test.ts`, `helm-terminal-progress.test.ts` (e.g. L113/132 regex for `var(--accent)`/`var(--text-2)`), `helm-background-terminals.test.ts`.
- Browser: `app/browser-tests/remote-layout.spec.ts:7–8` inlines `styles.css` + `remote.css`; `document-review-content-width.spec.ts:123` reads `--font-mono`; `agent-dock.spec.ts:440` probes `--warn`. No contrast checks, no undefined-var check, no raw-literal lint.
- Tally contrast/token tests (`ui/src/tokens/contrast.test.ts`, `ui/scripts/tokens.test.ts`) have no Helm counterpart.

---

## 5. Most important findings (ranked)

1. **Documented tokens that don't exist**: `--radius-lg/md/sm` and `--motion-exit/state/enter` (design-system §2.4/§2.5) are never defined in the app; 4 radius usages without fallback silently compute to radius 0 (`styles.css:999`, `detail-redesign.css:36`, `sidebar.css:1891`, `sidebar.css:2051`; plus `--accent-text` undefined at `sidebar.css:1824`).
2. **Light review scope leaks dark derived tones**: `--accent-soft`, `--success-soft`, `--neutral-soft`, `--danger-strong` resolve at `:root` with dark tones; light block re-derives only danger/warn soft. Also `--neutral`, shadows, scrim stay dark-tuned; light `--text-2` = dark `--text-2` = `#62666e` ≈ light `--text-1` `#60646c`.
3. **Remote ladder diverges** from Helm (pane `#0d0d0d`, chrome `#1c1c1e`, well `#1a1a1a` lighter than pane, hairline 8%, fills 5.5/11%) while its offline page and icons still use Helm `#141517`; raw scrims/shadows in remote.css (58%, 48%, 55%).
4. **Extension popup** ignores tokens entirely (VS Code palette, 13 color literals across popup.html/popup.ts); extension widget renames tones (`--vg-green/amber/red/blue/gray`) despite "prefix is the only allowed difference", and has a `font-weight: 650`.
5. **Theme engine coverage gap**: Document Review/viewer and Remote never run `appearance.init()` → no High contrast, custom themes, or UI scale; native window backgrounds hard-code `#141517` in 3 places.
6. **No sync guard**: `styles.css :root` currently matches HELM_TOKENS exactly (0/54 mismatches) and extension matches (22/22), but nothing tests it; four separate hand-maintained copies of the palette (theme-presets, styles.css, widget.styles.ts, Storybook preview) + remote-sw offline page.
7. **No z/motion/spacing tokens**: 45 raw z-indexes (off-table 70/30/9/8/5), 77 hard-coded transition durations (all on-spec values), 9 off-spec animation durations in remote (160/180ms), 4 distinct ad-hoc cubic-beziers in TS/CSS, 97 raw radii (16 off-ladder, mostly remote), 112 off-scale spacing values.
8. **Typography**: one unscaled sidebar font-size (`sidebar.css:751`), 13 unscaled in terminal chrome (styles.css, arguably intentional but undocumented), xterm font stack order differs from `--font-mono`, run-context hard-codes the UI stack in `--bn-font-family`.
