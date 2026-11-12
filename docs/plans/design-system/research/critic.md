# Completeness critic: Helm vs Tally design-system gap analysis

Worktree `/Users/jakubneumann/Documents/code/neumie/helm-wt/feat-design-system` (HEAD 10fa3b7, read-only). Tally `/Users/jakubneumann/Documents/code/neumie/tally` (read-only). Every number below comes from a command run in this session (wc/grep/rg, or small tsx scripts in the scratchpad: `critic-contrast.ts`, `critic-contrast2.ts`, `critic-c3.ts`, `critic-themes.ts`). Inputs reviewed: `r-tally.md`, `r-helm-spec.md`, `r-helm-tokens.md`, `r-helm-components.md`, `r-helm-infra.md`, `r-helm-surfaces.md`.

---

## 1. Spot-check of the auditors' numeric claims (34 checked)

| # | Claim (report) | Re-measured | Verdict |
|---|---|---|---|
| 1 | `docs/design-system.md` 820 lines (spec, components) | 820 | ✓ |
| 2 | `AGENTS.md` 325 lines (spec) | 325 | ✓ |
| 3 | 257 `tests/*.test.ts`, 2497 `test(` (infra) | 257 / 2497 | ✓ |
| 4 | 53 Playwright specs, 625 `test(` (infra) | 53 / 625 (`^\s*test(`); 635 with `\btest\(` | ✓ (spec report's "54 files" counts the helper `remote-navigation.ts`) |
| 5 | Spec files 21,336 lines (infra) | 21,336 all `*.ts` (21,329 specs only) | ✓ |
| 6 | 53 story files, 397 story exports (components, infra, surfaces) | 53 / 397; titles: 39 Views, 6 Compositions, 8 Primitives | ✓ |
| 7 | `HELM_TOKENS` 54, `HIGH_CONTRAST_TOKENS` 51 explicit (tokens) | 54 / 51 (inherits `--on-accent`, `--shadow-1`, `--shadow-2`) | ✓ |
| 8 | `styles.css :root` 64 custom props, 10 not in HELM_TOKENS (tokens, infra) | 64; extras = 6 derived + `--font-ui`, `--font-mono`, `--left-width`, `--ui-scale` | ✓ |
| 9 | `:root` has "63 custom props" and "9 not theme tokens" (surfaces §1/§2) | 64 and 10 (surfaces omits `--ui-scale`) | **✗ wrong** |
| 10 | styles.css 44 hex, 14 rgb(a), 82 custom-prop declarations (spec, surfaces) | 44 / 14 / 82 | ✓ |
| 11 | `sidebar.css:751 font-size: 11px` is the one unscaled sidebar size (spec, tokens) | confirmed | ✓ |
| 12 | sidebar.css font-size "75/74 scaled" (surfaces §2) | 75 lines contain `font-size`; 74 contain `ui-scale` but one is the comment at L6 → **73 real scaled** (tokens' 73 is right) | **✗ off by one** |
| 13 | remote.css radius 10px at L185, 12px at L874 (spec, tokens) | confirmed | ✓ |
| 14 | `font-weight: 700` at styles.css:798, sidebar.css:1062, document-review.css:953 | confirmed | ✓ |
| 15 | `--radius-sm/md/lg`, `--motion-*`, `--accent-text` never defined; no-fallback uses at styles.css:999, detail-redesign.css:36, sidebar.css:1891/2051/1824 (tokens, surfaces) | `rg -e '--radius-(sm|md|lg)\s*:'` → 0 definitions; lines confirmed | ✓ |
| 16 | 45 production `z-index` (tokens) | CSS 41 (styles 12, viewer 10, remote 10, sidebar 8, review 1) + widget 4 = 45; prototype 14 | ✓ |
| 17 | 58 `color-mix(` in production CSS; styles 26, viewer 12, widget 10 (tokens) | 26 / 12 / 10 | ✓ |
| 18 | 4 distinct cubic-beziers in code (tokens) | 4: `(0.2,0.8,0.2,1)`×4, `(0.22,1,0.36,1)`×2, `(0.16,1,0.3,1)`×1, `(0.32,0.72,0,1)`×1 | ✓ |
| 19 | `GLYPH` has 23 icons (components) | 23 keys in ui.tsx L19-80 | ✓ |
| 20 | THIRD_PARTY_NOTICES.md 89 lines, line 63 names missing `RemoteFavoriteStar.tsx` (components) | 89; L63 confirmed; file absent | ✓ |
| 21 | `biome check .` fails: 12 errors, 2 warnings (infra) | 12 errors, 2 warnings (1.8 s this run vs reported 1.08 s) | ✓ |
| 22 | 283 `.agent-dock*` top-level rules, 110 `.signals*` (components) | 283 / 110 | ✓ |
| 23 | agent-dock 11 raw `<button` non-story; sidebar 51 `<Btn` non-story (components) | 11 (12 incl. stories) / 51 (81 incl. stories) | ✓ |
| 24 | 21 node tests reference a `.css` path (infra §1.1) | **20** (`\.css\b` and `\.css['"\`]` both give 20) | **✗ off by one** |
| 25 | `toHaveScreenshot` 0; `screenshot(` 88 in 21 files (infra) | 0 / 88 / 21 | ✓ |
| 26 | Port 6010 currently held by Tally Storybook pid 38290 (infra) | `lsof` → `node 38290` listening on 6010 | ✓ (transient, still true now) |
| 27 | "`ui-scale` 0 tests" and "`prefers-contrast` 0 tests" (spec §0 line 53, rulings rows 16, 18) | `tests/helm-appearance.test.ts` tests `uiScale` normalization (L40-51) and `effectiveAppearance` OS-contrast selection ("macOS Increase Contrast picks High contrast until a theme is chosen", L89-99) | **✗ wrong** (literal strings absent, behavior tested) |
| 28 | design-system "L823 claims Semantic soft fills remain 15%" (tokens §2.5) | file has 820 lines; claim is at **L820** | **✗ wrong line** |
| 29 | Tally `ui/DESIGN.md` 2158 lines, sections at 18/49/448/1153/1219/1691/1947/1988/2058/2108 | confirmed | ✓ |
| 30 | Tally 26 rulings | 26 rows in §9 table | ✓ |
| 31 | Tally §2.3 contrast table 113 rows (Light 48, Dark 51, Both 14) (tally) | **115 rows: Light 48, Dark 52, Both 15** (all inside L594-714) | **✗ wrong** |
| 32 | Tally 93 stories, 77 story files use StateGrid; components report "StateGrid appears in 125 files" | 93; 77 story files; 125 files of any kind | ✓ both (different denominators) |
| 33 | Tally `data-force-state` 212 hits in 37 CSS files; `a11y.ts` 480, `emit.ts` 590, `contrast.test.ts` 110, `tokens.css` 665 lines | all confirmed | ✓ |
| 34 | Tally CI runs only the 7 a11y tool tests, not `build-storybook && a11y` (tally) | `deploy-prod.yml` L65 `--project='!a11y'`, L71 `--project=a11y`; no storybook build | ✓ |

Also confirmed: `SidebarRoot.tsx:11-13` says production mounts Settings-rooted (task list unshipped) and the only Run Context opener is `DetailPage.tsx:324` (surfaces rows 4/6); design-system.md L116 vs L190 button radius contradiction (spec C2).

**Wrong or imprecise: 6 of 34** (#9, #12, #24, #27, #28, #31). None changes a conclusion except #27: the "no test" claim for UI scale and OS contrast is false; only the CSS/visual effect of them is untested.

---

## 2. Things none of the six reports covered (or covered only in passing)

| Gap | Covered before? | Filled in §3 |
|---|---|---|
| Actual WCAG contrast of Helm's token pairs (both presets, Remote ladder, review light, popup) | No. Tally report describes Tally's contrast machinery; Helm reports only say "no contrast tests". | §3.1 |
| User theme files in `<userData>/themes` (seeding, precedence, drift, validation) | Mentioned as a sentence (spec row 16 "schema not specified"); mechanics not examined | §3.2 |
| High-contrast preset content and reach | tokens §1 (counts) and surfaces (not applied in Remote/review); not its contrast nor its Storybook presence | §3.1, §3.3 |
| `--ui-scale` reach (what scales, what does not) | Partial (tokens: font-size counts; surfaces: review/Remote ignore it) | §3.4 |
| Extension shadow-root token injection mechanics | Partial (tokens/surfaces: `--vg-` copy); injection, inheritance leaks, `color-scheme`, stale comment not covered | §3.5 |
| Storybook title/sort mechanics and doc→story references | Partial (components lists titles) | §3.6 |
| Browser-test overlap with a11y checks | Partial (infra counts getByRole etc.) | §3.7 |
| Focus-ring coverage in CSS | No | §3.8 |
| OS appearance integration (`nativeTheme`, reduced motion JS, forced colors) | No | §3.9 |

---

## 3. Filled gaps

### 3.1 Measured contrast (WCAG 2.x, blended alphas over their background)

Script: `critic-contrast.ts` (170 rows, output `critic-contrast.tsv`), `critic-contrast2.ts`, `critic-c3.ts`. Alpha fills composited over the stated base like Tally's `measureContrast`.

**Helm preset (default):**

| Foreground | Background | Ratio | Needs | Result |
|---|---|---|---|---|
| text-0 `#ececee` | chrome / pane / well | 14.47 / 15.49 / 16.04 | 4.5 | ✓ |
| text-1 `#9a9ea6` | chrome / pane / well | 6.35 / 6.80 / 7.04 | 4.5 | ✓ |
| text-1 | fill-strong over pane | 4.68 | 4.5 | ✓ (tight) |
| **text-2 `#62666e`** | chrome / pane / well | **2.96 / 3.17 / 3.28** | 4.5 | **✗** |
| text-2 | fill-raised over pane | **2.49** | 4.5 | ✗ |
| `--dock-dim` (text-1 60% + text-2) | chrome | 4.78 | 4.5 | ✓ (matches §3.24 claim) |
| `--dock-dim` | fill-raised over chrome (selected) | 3.68 | 3 (spec's own target) | ✓ (but < 4.5) |
| accent `#4c9aff` | pane / fill-strong over pane | 6.42 / 4.41 | 4.5 | ✓ / ✗ |
| danger `#f2585b` | fill-strong over pane | 3.78 | 4.5 | ✗ |
| neutral `#8a8f98` | fill-strong over pane | 3.87 | 4.5 | ✗ |
| **on-accent `#fff`** | **accent-fill `#3b82f6`** | **3.68** | 4.5 (13/600 is not "large") | **✗ primary button text** |
| on-accent | accent-fill-hover `#5a9dff` | **2.73** | 4.5 | ✗ (hover is lighter, so worse) |
| hairline over pane (input/control edge) | pane | 1.20 | 3 (WCAG 1.4.11) | ✗ |
| hairline-strong over pane | pane | 1.62 | 3 | ✗ |
| accent (focus ring) | pane | 6.42 | 3 | ✓ |
| ansi-black / ansi-bright-black | term-bg | 1.38 / 2.99 | – | low (terminal convention) |

`color: var(--text-2)` appears **77 times in production CSS** (sidebar 28, remote 13, styles 11, viewer 8, detail-redesign 5, document-review 5, run-context 4, scheduled-runs 2, button 1) plus 6 `--vg-text-2` in the widget; 48 more in open-prototype. design-system.md §3.24 already says "`--text-2` alone is ~3:1 on `--chrome`, too faint for 12px meta", yet it is the sidebar's standard meta colour. The appendix (L744) justifies `#3b82f6` as "better fill contrast under white text than `#4c9aff`": measured 3.68 vs 2.85, better but still below AA.

**High contrast preset:**

| Pair | Ratio | Result |
|---|---|---|
| text-2 `#9096a0` on chrome / pane | 5.98 / 6.53 | ✓ |
| text-2 on fill-strong over pane | 3.37 | ✗ |
| on-accent on accent-fill `#3574de` | **4.46** | ✗ by 0.04 |
| on-accent on accent-fill-hover `#5093f5` | 3.07 | ✗ |
| hairline / hairline-strong over pane | 1.55 / 2.84 | ✗ (control edges still < 3:1) |
| danger on fill-strong over pane | 3.62 | ✗ |

So even the preset auto-selected for macOS Increase Contrast fails AA for primary-button text and for control edges.

**Other palettes:**

| Surface | Pair | Ratio |
|---|---|---|
| Remote ladder | text-2 on page `#0d0d0d` / chrome `#1c1c1e` / bubble `#2f2f2f` | 3.37 / 2.95 / **2.32** |
| Remote | text-1 on bubble | 4.98 |
| Review light | text-1 / text-2 on pane | 5.64 / 5.47 (text-2 ≈ text-1, as tokens report noted) |
| Review light | accent `#176ac2` on well `#ebeae6` | **4.499** (fails 4.5 by 0.001) |
| Review light | `--neutral` (dark-tuned, not overridden) on pane / well | **3.09 / 2.70** |
| Review light | white on accent-fill `#176ac2` | 5.42 ✓ |
| Review light syntax (spec L771 "each ≥4.5:1 on its well") | `#8a3ab0` 5.27, `#1f7347` 4.84, `#0a6878` 5.34, `#855708` 5.19, `#1764b8` 4.91, comment text-2 4.79 | ✓ claim holds |
| Extension popup | `#808080` / `#007acc` on `#252526` | 3.88 / 3.40 |

Tally's equivalent: 115 documented pairs, every one ≥ need, pinned by `contrast.test.ts`. Helm has no table and fails AA on its most-used meta colour and on its primary button in both presets. A Helm `contrastPairs` test would start red unless the failing pairs are ruled on (Tally's ruling mechanism).

### 3.2 User theme files (`<userData>/themes/*.json`)

Code: `app/src/main.ts:2903-2973` (`themesDir`, `readThemeFile`, `ipcMain.handle('themes:list')`), `app/src/renderer/appearance.ts:96-107, 263-274`.

- Seeding: on every `themes:list`, each preset is written to `<id>.json` **only if the file does not exist**. Never updated afterwards.
- Precedence: `fromDisk.get(id) ?? bundled`, so an on-disk preset file always beats the bundled preset ("a user-edited preset file wins").
- Validation: only `key.startsWith('--') && typeof value === 'string'` (main and renderer `isTokenMap`). No allowlist of token names, no value parsing, no contrast check. Any custom property can be set by a theme (including structural ones like `--left-width`; `--ui-scale` is re-set after tokens in `apply()`).
- Resolution: `resolveTokens` = Helm base ∪ theme file ∪ overrides, so a token missing from a file falls back to **Helm**, not to the preset of the same id.
- **Live drift found (operator's machine, read-only):** `~/Library/Application Support/Helm/themes/helm.json` and `high-contrast.json` were seeded 2026-07-13 with **44 tokens; bundled presets have 54**. Missing in both: `--fill-strong`, `--group-blue/purple/pink/red/orange/green/cyan`, `--term-scroll-thumb`, `--term-scroll-thumb-hover`. Existing 44 values match exactly. Effect: a user on High contrast (chosen or via OS Increase Contrast) gets the **Helm** values for those 10 tokens, e.g. `--fill-strong` .13 instead of .22, Helm group colours, Helm terminal thumb. Any future change to a preset value is likewise invisible to every installed user. Nobody reported this; no test covers seeding/upgrade (helm-appearance.test.ts tests `resolveTokens` with in-memory themes only).
- Accent colour well (`AppearancePage.tsx:107-118`): one well sets `--accent` = `--accent-fill` = picked hex and `--accent-fill-hover` = `color-mix(in srgb, hex 78%, white)` (lighter). No contrast guard; the default picks already fail (§3.1).
- Tally has no user themes; its theme axis is light/dark via `data-theme` + `light-dark()`.

### 3.3 High-contrast preset: reach and testing

- Selected when the user picks it or, until a theme is chosen, by `matchMedia('(prefers-contrast: more)')` (`appearance.ts:58-72, 177-187`). Tested in `helm-appearance.test.ts:89-99`.
- Applied only where `appearance.init()` runs: `renderer.ts` and `run-context-editor.tsx` (tokens/surfaces confirmed). Not Remote, not Document Review/viewer, not the extension widget, not the popup, not native window backgrounds (`#141517` literals).
- No CSS reacts to `prefers-contrast` (0 hits in `app/src`/`extension/src` CSS); the preset swap is the whole mechanism. Tally instead emits `@media (prefers-contrast: more)` remaps (`increasedContrast`: hairline→edge, tertiary→secondary) plus 52 `forced-colors` rules in 51 CSS files. Helm has **0** `forced-colors` rules.
- Storybook: no theme toolbar/global. High contrast appears only in 2 story files: `TopbarBackground.stories.tsx` (`States` grid, Helm + High contrast columns via inline `THEME_PRESETS[theme].tokens`) and `AgentDockUnderClaudeCode.stories.tsx` (`HighContrast` story via fixture option). Browser tests: 0 hits for `high-contrast`/`High contrast`, 0 `emulateMedia({ contrast })`.

### 3.4 `--ui-scale` reach

- Values 0.92 / 1 / 1.08 (`appearance.ts:36-40`), set on `documentElement` in `apply()` (L307). `:root` default 1.
- Consumers (`var(--ui-scale` in production CSS): document-review 53, remote 51, sidebar 74 (73 + comment), viewer 20, styles 18, run-context 12, detail-redesign 9, scheduled-runs 4, button 2, reading-width 2. Non-font uses: only `viewer.css` one `min-height`, `--agent-row`, `--reading-measure`, `--reading-block-max`, `--review-ui-scale`. So **only text scales; row heights, paddings, icon sizes, hit targets do not** (28px rows with 1.08× text).
- Not scaled: `body { font-size: 13px }` (styles.css:108) and 13 terminal-chrome/toast sizes in styles.css (L657, 679, 707, 780, 797, 855, 951, 963, 970, 974, 1293, 1304); 22 raw sizes in the extension widget; 6 in popup.
- Surfaces where the Settings value never arrives: Remote (no `appearance.init`, stays 1) and Document Review/viewer (`--review-ui-scale: var(--ui-scale, 1)` re-scoped for zoom only).
- Tests: normalization only (`helm-appearance.test.ts:40-51`). No browser test at 0.92/1.08 (`ui-scale|uiScale` 0 hits in `app/browser-tests`). No Storybook global for it. Tally's equivalent is touch/desktop size pairs and Dynamic Type `rem/17` scaling, covered by the generator freshness test.

### 3.5 Extension shadow-root token injection

- `extension/src/content.tsx` appends an unstyled `div#helm-widget-host` to `document.body`; `mount-widget.tsx` (15 lines) attaches a **closed** shadow root, appends one `<style>` whose `textContent = WIDGET_STYLES`, then a mount `div`. The `widget.styles.ts` header comment still says "injected … by `content.tsx`" (stale: it is `mount-widget.tsx`).
- Tokens live on `:host` (33 `--vg-*`). Consequences none of the reports named:
  - Page styles that target the host element (`#helm-widget-host { --vg-accent: … }`) beat `:host` rules, so the host page can re-theme the widget. ClientCare is trusted, but it means the widget's palette is not sealed.
  - No `:host { all: initial }` reset; only `* { box-sizing; margin; padding }`. Inherited properties not explicitly set by each class (`text-transform`, `font-style`, `word-spacing`, `direction`, `visibility`, `cursor`) cross the shadow boundary from ClientCare. `font-family`, `letter-spacing`, `line-height` are set per class (grep: 9 `font-family: var(--vg-font)`, 2 `letter-spacing`, several `line-height`).
  - **No `color-scheme: dark`** anywhere in `widget.styles.ts` (app has it at styles.css:9). The widget's one `<textarea>` (prompt quick editor) and native scrollbars/caret UI render with the page's (light) scheme on a dark card; only `.vg-model__menu` has custom `::-webkit-scrollbar` rules (L351-352).
  - No `--ui-scale`, no High contrast, no `prefers-contrast`; `prefers-reduced-motion` 1 block (L60).
  - z-index `2147483647` on pill and card (L74, L120), `z-index: 5` menus (L198), `40` (L329).
- Parity: 0 tests or specs reference `widget.styles`/`WIDGET_STYLES` (`rg -l` over tests + browser-tests: none). The 22-colour `--vg-*` copy currently matches HELM_TOKENS (tokens §2.2) by hand only.
- The `ExtensionWidget` story mounts this exact production path through `extension/dist/workbench.js` (components §3.5), so a Storybook-based axe/contrast scan could reach inside the closed root only via the workbench's retained root reference, not via plain `frame.addScriptTag`.

### 3.6 Storybook titles and sorting

- `preview.ts` `storySort.order = ['Views', ['Sidebar','Terminal workspace','Run context editor'], 'Compositions', 'Primitives', '*']`, **no `method`**. The other 36 `Views/*` titles (including 10 prototype `Views/Helm open/*` files) therefore follow file-discovery order (glob path order), not alphabetical title order; production views and story-only prototypes interleave by directory.
- Groups by meta title: Views 39 files, Compositions 6, Primitives 8. "Compositions/Agent dock" (29 stories) is a full view.
- `tests/helm-storybook-coverage.test.ts` (52 lines) pins 19 file→title pairs plus `order: ['Views'` and 8 SidebarViews exports. Not pinned: anything under agent-dock, remote, document-review, viewer, Signals Asks/Slack, extension widget.
- Doc → story references: of the bold/backtick story names in design-system.md/AGENTS.md, **`Views / Document review / Plain viewing` (design-system.md L769) does not exist** (real title `Views/Document review/Plain files`; `PlainViewing` is a story inside `Views/Document review`). Others resolve.
- No addon-docs/autodocs, 0 `.mdx` files, 0 per-story `a11y` parameters; 31 `play:` functions in 16 files; `argTypes` in 10 files; backgrounds hard-coded hex (pane/chrome/well) with no High-contrast or light option. Tally: autodocs on every component, 15 MDX docs pages, Theme + Motion toolbar globals, docs pages audited by the same a11y run.

### 3.7 Browser tests vs accessibility (overlap)

Counts in `app/browser-tests` (53 specs):

| Pattern | Hits (files) | What it means |
|---|---|---|
| `getByRole(` | 1737 | role/name queries implicitly assert accessible names exist |
| `.locator(` | 1566 | CSS selectors (no a11y signal) |
| `getByLabel(` / `getByText(` / `getByTestId(` | 182 / 193 / 1 | |
| `keyboard.press` | 520 (34 files); top: agent-dock 135, document-review 58, signals 41 | keyboard operability is heavily tested |
| `toBeFocused` | 330 | focus management |
| `toHaveAttribute('aria-…` | 131 (19 files) | ARIA state |
| `toHaveAccessibleName` / `…Description` | 12 (4) / 1 (1) | |
| `inert` | 9 (6) | |
| `press('Tab'` | 6 (5) | tab order barely tested |
| `outline` | 8 (3) | focus ring visibility asserted in 3 files |
| `emulateMedia` / reduced motion | 7 (7) | reduced motion only |
| `contrast: 'more'`, `forcedColors`, `colorScheme` | 0 | |
| axe / contrast / luminance / wcag | 0 | |
| `ariaSnapshot` | 0 | |

So Helm's specs already cover much of what Tally's axe run cannot (keyboard flows, focus return, ARIA state), but nothing covers what axe does cover (contrast, missing labels across every story, landmark/duplicate-id/role rules). The overlap is small, which argues for adding an axe pass over Storybook stories rather than replacing spec assertions.

### 3.8 Focus-ring coverage in CSS

- Global ring (styles.css:113-118): `button:focus-visible, .tab:focus-visible, #bg-toggle[data-bg-preview~="focus"] { outline: 2px solid var(--accent); outline-offset: 2px }`. Inputs, links, `[tabindex]`, `[role=option|radio|menuitem]` get only per-component rules.
- Per file `:focus-visible` / `outline: none|0`: styles 9 / **12**, viewer 10 / 6, sidebar 5 / 2, remote 5 / 2, document-review 3 / 1, detail-redesign 1 / 0, widget 11 / 1, button.css 0 / 0. The dock's 12 removals are deliberate (§3.24: focused entry shows the selected fill, never a ring); that fill's text (`--dock-dim` 3.68 on selected fill) is below 4.5.
- Tally: one global rule `:focus-visible, [data-tl-focus-visible]:focus, [data-force-state="focus"]` (`base.css:104-122`) and focus contrast checked by axe in both themes.

### 3.9 OS appearance integration

- No `nativeTheme.themeSource` anywhere in `app/src` → native menus, dialogs (`showMessageBox`/`showOpenDialog`, 9 call sites per surfaces §4) and context menus follow the macOS system appearance, which can be light while Helm is dark-only.
- Reduced motion: CSS blocks (styles 7, document-review 2, remote 1, viewer 1, widget 1) plus JS `matchMedia` in `terminal-workspace.ts:1821` and `SidebarRoot.tsx:286`. No in-app toggle/attribute (Tally has `data-reduced-motion` toolbar global, 89 uses in 42 CSS files).
- `prefers-reduced-transparency` (Remote capsule blur, review frosted controls): 0 handling.
- `forced-colors`: 0 (Tally 52).

---

## 4. Other corrections and nuances to the six reports

- **spec report §0 / rulings rows 16, 18:** UI scale and OS-contrast selection are unit-tested (`helm-appearance.test.ts`); what is untested is their rendered effect.
- **tokens §1 row 3 / infra:** correct that the `:root` mirror is unguarded, but the larger live drift is the on-disk seeded theme files (§3.2), which override the bundled presets and are already 10 tokens behind.
- **components §2.8 "Hex/rgb literals per production CSS: styles.css 58"** equals hex 44 + rgb(a) 14 (spec/surfaces); consistent, just a different split.
- **surfaces §2 "No prefers-contrast in any app or extension CSS"** is true for CSS; the JS preset swap exists (`appearance.ts`).
- **tally §1c** contrast row counts: 115 (48/52/15), not 113.
- **infra §1.1** CSS-reading node tests: 20, not 21.

---

## 5. Implications for the gap analysis (what a Helm port of Tally's mechanisms would hit first)

1. A Tally-style contrast test fed from `THEME_PRESETS` would fail on day one: `--text-2` text (2.96-3.28), `--on-accent`/`--accent-fill` (3.68 Helm, 4.46 HC), hover fills, hairline control edges (1.20/1.55). These need design rulings (raise `--text-2`, darken `--accent-fill`, or rule 13/600 as acceptable) before the test can be green, which is exactly Tally's §9 rulings workflow.
2. A theme-file upgrade path is needed before presets are generated/changed: seeded files shadow bundled presets forever. Options: reseed when the file equals an older bundled version, or merge preset-of-same-id under the file.
3. Theme/UI-scale/High-contrast reach stops at two entries; Remote, review/viewer, extension and popup need either `appearance.init()` (or a shared token module) or an explicit "fixed palette" ruling.
4. Storybook lacks the globals Tally relies on (theme, motion, scale), and sorting without `method` makes the sidebar order depend on file paths.
5. The extension needs `color-scheme: dark` and a `:host` reset before its tokens can be treated as sealed; a parity test against HELM_TOKENS is cheap (22 colours, currently equal).
