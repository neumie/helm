# Helm design spec audit (docs/design-system.md + decision harvest)

Worktree: /Users/jakubneumann/Documents/code/neumie/helm-wt/feat-design-system (branch feat/design-system, HEAD 10fa3b7). Read-only audit; no repo file edited. Tally repo not touched.

All counts below come from commands run in this session (`wc -l`, `grep -o | wc -l`, `git log | wc -l`, Python regex scans). Line numbers refer to the file at HEAD 10fa3b7.

## 0. Inventory / raw counts

| Measure | Value | Command |
|---|---|---|
| docs/design-system.md lines | 820 | `wc -l` |
| AGENTS.md lines (CLAUDE.md = symlink) | 325 | `wc -l`, `ls -l` |
| Nested AGENTS.md / CLAUDE.md | 0 (root only) | `git ls-files` |
| Tracked docs/*.md (recursive) | 16 files, 3576 lines | `git ls-files docs \| grep .md` + `wc -l` |
| Biggest docs | docs/remote/README.md 609, docs/plans/helm-open/spec.md 543, docs/plans/signals-slack/spec.md 211, docs/document-review.md 212 | `wc -l` |
| Commits on branch | 828 | `git log --oneline \| wc -l` |
| Node test files | 257 `tests/**/*.test.ts` | `ls \| wc -l` |
| Browser test() calls | 625 across 54 files in app/browser-tests | grep count |

Phrase counts (`grep -o`):

| Phrase | design-system.md | AGENTS.md |
|---|---|---|
| `Jakub's pick` | 5 | 3 |
| `Jakub` | 24 | 37 |
| `operator explicitly` | 1 | 1 |
| `operator-approved` | 1 | 0 |
| `operator chose` | 0 | 1 |
| `variant` | 9 | 4 |
| `2026-` | 8 | 11 |
| `rejected` | 4 | 8 |
| `deliberately` | 8 | 27 |
| `never` | 304 | 388 |
| `Never` | 30 | 41 |
| `Don't` | 27 | 11 |
| `RETIRED` | 2 | 0 |
| `retired` | 10 | 8 |
| `MUST` | 13 | 52 |

CSS compliance scans (Python regex over app/src/renderer/**/*.css + extension widget.styles.ts):

| Check | Result |
|---|---|
| `text-transform: uppercase` | 0 hits anywhere |
| `font-weight: 700` | styles.css:798, sidebar.css:1062, document-review.css:953 |
| `font-weight: 650` | widget.styles.ts (1) |
| hex literals | styles.css 44 (mostly the `:root` first-paint mirror), remote.css 8, document-review.css 12, viewer.css 8, widget.styles.ts 14 |
| rgba literals | styles.css 14, remote.css 11, document-review.css 5, widget.styles.ts 9 |
| radius 10/12/14px (banned §2.4) | remote.css 4 (L185 `10px`, L874/L1262/L1440 `12px`) |
| font-size not in `calc(... * var(--ui-scale))` in sidebar.css | sidebar.css:751 `font-size: 11px` |
| 500-700 weights inside dock/Signals blocks | 0 |

Test-coverage grep (last command run): `toHaveScreenshot` 0 browser files; `ui-scale` 0 tests; `--accent-fill` 0 tests; `helm.appearance` 0; `prefers-contrast` 0; `17px` hero 0; `radiogroup` 2 browser files; `aria-keyshortcuts` 3 browser files; `Heroicons|THIRD_PARTY` only tests/helm-background-terminals.test.ts; `widget.styles` referenced by 0 Node tests.

## 1. Section map of docs/design-system.md

| Lines | Section | What it specifies concretely | What it leaves vague |
|---|---|---|---|
| 1-7 | Intro | Spec is "law" for app/ + extension/ | L5 still describes the register as "dark, machined, quiet" (stale wording, see C1) |
| 9-15 | §1 Principles (5) | One filled accent per surface; quiet by default; content over chrome | Prose-only; no measurable test; "one accent" collides with on-Toggles (C8) |
| 19 | §2 Tokens header | | |
| 23-65 | §2.1 Color | Exact table: chrome #1a1c1f, pane #141517, well #0f1113, hairline .07 / hairline-strong .16 white-alpha, fill-subtle .05 / raised .09 / strong .13; text-0 #ececee, text-1 #9a9ea6, text-2 #62666e; accent #4c9aff, accent-fill #3b82f6, success #4ec98a, warn #e0b341, danger #f2585b, neutral #8a8f98; soft fills always 15%; fixed status→tone map | Contrast targets per pair only partially stated; extension `--vg-` mapping described in drift appendix only |
| 67-95 | §2.2 Typography | Stacks; scale 17/600 hero, 13 body, 12 secondary, 11 meta, 12/600 section header, 12/500 label, 11/500 chip, 11 mono, terminal 13 mono lh 1.2; letter-spacing -0.01em; no uppercase; `--ui-scale` 0.92/1/1.08 via calc | Many surfaces use sizes outside the scale (Remote 16/14, Doc Review 15/21/28, badge 10/700) without amending the scale (C5) |
| 97-109 | §2.3 Spacing | 4/8/12/16/20/24/32 "no other values"; one 16px text grid; square full-width row stripes clearing row boundary by 4px | Rule is absolute but violated by documented components (C6) |
| 111-120 | §2.4 Radii | lg 8, md 6, sm 4, full 999; never 10/12/14 | Table assigns buttons md 6, but §3.1 says 8 (C2) |
| 122-144 | §2.5 Motion | 120/140/150ms, ease-out, transform/opacity only, 8px entrance, reduced-motion clamp CSS | Long ambient animations (1.4s, 1.8s, 4.8s) and custom curves live elsewhere (C7) |
| 146-153 | §2.6 Elevation | Exactly two shadows | Which components may use which; inset rings counted or not (styles.css has 13 box-shadow decls) |
| 155-164 | §2.7 Z-layers | 0/10/40/60/100; widget 2147483647 | |
| 166-174 | §2.8 Theming | Every color a CSS var; HELM_TOKENS in theme-presets.ts; presets Helm + High contrast; deliberately no light preset; prefers-contrast; localStorage helm.appearance; terminal font 9-24 | User theme JSON schema / validation not specified |
| 178 | §3 Components header | | |
| 182-210 | §3.1 Buttons | md 32 / 13/600 / radius 8; sm 24; icon 28; tones primary/quiet/danger/ghost, no borders; disabled .45; focus ring 2px accent offset 2; one primary per surface | L198 hardcodes `#fff` / hover `#5a9dff` (C3) |
| 212-221 | §3.2 Segmented | 28 outer, padding 2, inset ring; lifecycle index variant (44px targets, 24px gaps, 2px accent underline, radiogroup); max 4-5 segments | Tablist vs radiogroup semantics split (documented exception) |
| 223-234 | §3.3 List row | 64px, no separators, no persistent selection; running row = ActivityIndicator before title; slug color-mix 55/45; Queue ownership icon buttons; Work overflow More | |
| 236-241 | §3.4 Chips | 2x8 padding, 11/500, text only, one per row; detail uses status text menu | |
| 243-249 | §3.5 Status dots | Dot = live; 6px pulsing only beside "Agent running"; no topbar connection dot | |
| 251-261 | §3.6 Toast | Bottom-right, 12px inset, width min(320, 100vw-32), min-height 48, padding 11 12 13, TTL 4000, inset countdown hairline, × dismiss, max 3, one action | Off-scale padding (C6) |
| 263-272 | §3.7 Inputs | 28px, textarea min 64, focus accent border, chevron stroke #62666e, color wells; shadow-root native-select ban | Hex chevron (C3) |
| 274-282 | §3.8 Menus | 180-280 wide, max-h min(70vh,360), 28px items, leading icon column, 20px section labels, no submenus, about 8 items | Mentions Poll now/Pause behind "…" (C14) |
| 284-294 | §3.9 Sheets | Scrim, max-w 400, three zones, non-top-layer `<dialog open>`; Finish setup sheet | |
| 296-315 | §3.10 Push navigation | Header 36; push 150ms with -25% parallax; isolation; New item page; swipe: 8px lock, 2x dominance, 140ms quiescence, commit 50% or flick >=1.5px/ms with >=30%, settle 90-240ms, refractory 280ms; depth max 3 | Work toolbar as profile switcher is stale (C14) |
| 317-326 | §3.11 Action bar | 56px, max two visible buttons, icon-led labels | |
| 328-336 | §3.12 Banners | padding 10 12; 4-line clamp; actionable notice; no success banners | |
| 338-346 | §3.13 Empty states | Copy pattern; terminal pane "No terminal open" | kbd rgba literal (C3) |
| 348-369 | §3.14 Terminal well | Task sidebar toggle beyond 84px traffic-light reserve; flex insets 6-14; fit invariants; overlay scrollbar 7px pill / 9px hover; ⌘+click links; tab title normalization + rename pin; ANSI tokens | Toggle label text stale (C15); letter-spacing override (C4) |
| 371-384 | §3.15 Flat groups | Rule with 20px inset; 28 vs 36 pitch; Okena workspace button; nav rows; inline run evidence; Run limits | |
| 386-390 | §3.16 Toggle | 32x18 track | Accent-fill on many simultaneous toggles (C8) |
| 392-396 | §3.17 Pane scrollbars | stable gutter + exceptions | rgba thumb literals (C3) |
| 398-418 | §3.18 Background terminals + tab groups | Continuous group band 15/22/30%; tab numbers ⌘1-9 (story Views / Tab numbers); Move to profile; drag 5px intent, 160ms FLIP, 180ms settle, folder leading-edge-only; window drag regions + hiddenInset ban; strip control; popover 320px, 44px rows | Count badge 10/700 (C5) |
| 420-429 | §3.19 Task detail | Pushed long-form reading page | |
| 431-441 | §3.20 Disclosure | Quiet small Btn Show/Hide, Change/Done; snaps open; wells log 240 / plan 320 | |
| 443-455 | §3.21 ActivityIndicator | 2x3 Braille 2px dots; progress 1s cycle; waiting 0.9s warn; attention 1.8s diagonal accent; never success color | |
| 457-469 | §3.22 Run context editor | 980x760 window, 236px rail hidden below 820px | |
| 473-477 | Extension prompt quick editor (unnumbered) | | Mostly behavioral prose, almost no visual metrics |
| 479-516 | §3.23 Helm Remote | Metrics table L483-492: 320 directory, 800 measure, 44 targets, 16px form text, composer capsule 68% tint; info rail >=1200px; budgets <100ms, <16ms p95, <8MiB | Long prose paragraphs; radius 10/12 in CSS (C11) |
| 518-553 | §3.24 Agent dock | One typeface 12/18 + 13/20, mono only for commands; no bold; --dock-dim; color on glyphs only; 28px row; aging 30m warn / 2h danger; pane 216 → max(60%, 480), grow once never shrink; header = Jakub's pick 2026-11-05; Show terminal ⌘O = Jakub's pick 2026-11-04; arrival pulse 1.4s; Don'ts | Very dense; most metrics also restated in AGENTS.md L161 |
| 555-581 | §3.25 Signals | Anatomy = Jakub's pick 2026-11-11 look 11 (sticky 28px --chrome bands, Braille count marks, resting dots 4.8s); agent ask third body line = Jakub's pick 2026-11-10; Slack reply heads only = Jakub's pick 2026-11-11; Done today; Filtered; Don'ts | Interacts with sidebar label rule (C15) |
| 584-592 | §4 Interaction | focus-visible rings; hover never reveals; keyboard; hit targets >=24 (28 standard); reduced motion; user-select; live regions .sr-only | |
| 596-603 | §5 Copy voice | Sentence case; "…" rules; relative times <24h; no uppercase | |
| 607-656 | §6 Performance budgets (measured 2026-07-11) | Startup <800/<900ms; 0 idle pushes; re-render <16ms; no virtualization below ~500 rows; memory <400MB; API p50 <50ms; detail <500ms | §6.5 L652 references a log preview state that no longer exists (C9); bundle section vague |
| 660-670 | §7 Storybook rules | Real CSS, fixtures, Views first | |
| 674-722 | Appendix: flat-editorial redesign | Four passes of was/now tables (L676 retires the machined register; L695 md button radius 8) | Historical, mixes current + superseded values |
| 724-747 | Appendix: reconciled drift | Table of canonical values | L736-L738 stale (C10) |
| 749-807 | Remote plain-thinking (749), favorites (755), subagents (761), Native document review workspace (765-820) | Reading 680px measure, 15/1.7 body; passage bubble 560 wide, max 640 high; send activity line E5 (D14); reading width 1280 cap; canvas; portable history | Prose-heavy |
| 811-818 | Operator-approved light reading surface table | Scoped light palette | Exception to dark-only |

## 2. Decision trail (explicit picks, dated)

| Date | Decision | Source |
|---|---|---|
| 2026-07-11 | Design system + perf budgets established | d499fd6 |
| 2026-07-16 | Machined register rejected; "polished flat editorial" chosen over macOS grouped cards; Storybook over in-app gallery | memory user_design_taste.md, project_flat_redesign.md; 9cbe937 (#52), 651602f |
| 2026-07-16 | Sidebar work index redesign | 45cf682 |
| 2026-07-20 | Item detail header | 90e9636 |
| 2026-07-21 | Square edge-to-edge stripes (supersedes "rounded list rows" in 9cbe937) | 9ff0e82 |
| 2026-07-22 | Toast as centered bottom notice (later superseded: bottom-right) | fb2d299 |
| 2026-07-28 | Flatten background groups | 6954a28 |
| 2026-10-31 | Terminal-native dock; dock position in Appearance | c70ea1a, 22affaa |
| 2026-11-02 | Divider/calm variants; rejected-variant names dropped | 7f48518, 80d97ee, dd17db2 |
| 2026-11-02 | Tab numbers: N1+B1 picked, digits always shown, leading | f5a5699 → c076d17 |
| 2026-11-03 | Arrival flash: Jakub picked F3 edge pulse | 697d024 → 42f5579 |
| 2026-11-03 | Agents pane by state/project; health dot out of row; Recent list dropped per Jakub | 40b4ec8, 88b7fb5, 41fb0c6, 97024ee |
| 2026-11-03 | Turn message as quiet Markdown, no weight | 8ac95b9 |
| 2026-11-03 | Background toggle B3 "tab-like" ships; six Agents-entry looks explored | 28a0fb8 → 1b914c2, fab3e91 |
| 2026-11-04 | Where-link V2 picked; then "no agent name in the link" | a79dfd4; design-system.md L546 |
| 2026-11-04 | Pane resize; no growth after typing; 60% cap | edd002c, 0317af2, ac91bd0 |
| 2026-11-05 | Dock pane header variant D "with task title" (Jakub's pick) | f74be4a; design-system.md §3.24; AGENTS.md L161 |
| 2026-11-05 | Signals: task-sidebar column, no resting indicator, flows | 555a120 → ea0704e |
| 2026-11-09 | Reading width variant D; send receipt variants; helm-open D1-D11, D13 decided | 95db976 → 254a082, be516de, ff83c99, 408f0e8 |
| 2026-11-10 | Done reason + filtered count picks; ask body third line; Done today replaces inline expand | b0b5d1c → a87ea42, 54ff5ca; AGENTS.md L183 |
| 2026-11-11 | Slack reply heads only, variant A (Jakub's pick, port-6152 preview) | 1b098de → f724fb1; signals-slack/spec.md L187; AGENTS.md L181 |
| 2026-11-11 | Signals look 11 sticky bands ("4 with 2") | f3b2fa0, be7b79e, 86d2507, c32b388 → 5ff053b, merge a201b92 |
| 2026-11-11 | Closing a passage chat clears the selection ("a selection left behind a closed chat is a bug") | AGENTS.md L306; merge 4836402 |

helm-open spec (docs/plans/helm-open/spec.md L517-533, Jakub 2026-11-09, slice-order go-ahead 2026-11-10; picks also at L357-363; sidecar rejected L188):
D1=(a) plain `helm open`, bind only via `--listen`; D2 bind existing plain window; D3 view anything readable, .jsx/.tsx as source; D4 tier 1 then XLSX; D5 feedback history memory-only, no sidecars; D6 Quick Look fallback for PPTX; D7 refuse when desktop not running; D8 Finder Alternate handler packaged only; D9 vendored SheetJS; D10 hello/features negotiation; D11 delete dormant code; D12a = A6 collapsing path (40px title row, path folds to "…" below 1000px); D12b = B4 window per file + Helm-drawn tabs, Open Files as Tabs default off; D13 workspace only; D14 = E5 activity line with ActivityIndicator (Jakub: "probably neither of them" for A-D).

Other operator rulings in AGENTS.md: L227 operator chose to keep Pi unchanged (SGR mouse fragmentation); L235 operator explicitly removed the "Choose images…" menu (Remote plus button opens picker directly).

## 3. Candidate rulings table

Legend: Enforced = an existing test asserts it (file:line where known). Auto = could it be tested mechanically (yes / partial / no).

| # | Topic | Ruling | Source | Enforced by test? | Auto-testable? |
|---|---|---|---|---|---|
| 1 | Register | Flat-editorial; machined register (uppercase micro-labels, glyph chips, outline buttons, wireframe boxes) retired | design-system.md L676 appendix; memory user_design_taste.md (2026-07-16); AGENTS.md L195 | partial (no uppercase test) | yes (CSS lint) |
| 2 | Uppercase | No uppercase text anywhere | design-system.md §2.2 L67-95, §5 L596-603; AGENTS.md L195 | no (0 tests grep text-transform) | yes |
| 3 | Cards | No bordered in-flow cards | AGENTS.md L195; appendix L674-722 | no | partial |
| 4 | Buttons border | No outline buttons; tones primary/quiet/danger/ghost, no borders | §3.1 L182-210; AGENTS.md L195 | no | yes |
| 5 | Primary count | One primary per surface | §3.1 L182-210 | no | partial (story DOM count) |
| 6 | Accent | Never two filled-accent elements per surface | §1 L9-15 | no | partial |
| 7 | Button metrics | md 32h / 13/600 / radius 8; sm 24; icon 28 | §3.1 L190; appendix L695 | no | yes (computed style in Storybook) |
| 8 | Disabled | opacity .45 | §3.1 | no | yes |
| 9 | Focus ring | 2px accent ring, offset 2, focus-visible only | §3.1, §4 L584-592 | no | yes |
| 10 | Color tokens | Exact token table (chrome/pane/well, hairlines, fills, text-0..2, tones) | §2.1 L23-65 | yes tests/helm-appearance.test.ts (presets) | yes |
| 11 | Soft fills | Always 15% color-mix | §2.1; AGENTS.md L213 | no (0 color-mix tests) | yes |
| 12 | Status → tone | Fixed mapping | §2.1; tests/helm-model.test.ts:185 | yes helm-model.test.ts:185 | yes |
| 13 | Hex literals | Every color a CSS variable; hex in component CSS = drift | §2.8 L166-174; AGENTS.md L213 | no | yes |
| 14 | Light theme | Deliberately no light preset (dark-only) | §2.8; AGENTS.md L213 | partial helm-appearance.test.ts | yes |
| 15 | Light exception | Operator-approved scoped light Document Review reading surface | design-system.md L811-818 | no | partial |
| 16 | Presets | Helm + High contrast, prefers-contrast auto | §2.8 | partial (preset list only; prefers-contrast 0 tests) | yes |
| 17 | Terminal font | Size 9-24, default 13 | §2.8; AGENTS.md L213 | yes helm-appearance.test.ts | yes |
| 18 | UI scale | --ui-scale 0.92/1/1.08; new sidebar font-size = calc(px * var(--ui-scale)) | §2.2; AGENTS.md L213 | no (0 tests; violation sidebar.css:751) | yes |
| 19 | Type scale | 17/600 hero, 13 body, 12, 11, 12/600 section, 12/500 label, 11/500 chip, 11 mono | §2.2 L67-95 | no | yes |
| 20 | Letter-spacing | -0.01em; .term-mount neutralizes to normal | §2.2 L78; §3.14 L356; AGENTS.md L210 (fit pipeline) | no | yes |
| 21 | Bold weights | Bold only 600-700 | §2.2 | no | yes |
| 22 | Spacing scale | 4/8/12/16/20/24/32 only | §2.3 L97-109 | no | yes (lint) |
| 23 | Text grid | One 16px content grid | §2.3 | partial helm-flat-group.test.ts | yes |
| 24 | Row stripes | Square full-width stripes, radius 0, `.action-row` margin 0 -16px, `::after` inset 4px 0 | §2.3; AGENTS.md L210; 9ff0e82 (2026-07-21) | yes tests/helm-flat-group.test.ts | yes |
| 25 | Scrollbar gutter | Full-width sidebar scrollers + background popover reserve no gutter; reading/editing panes stable gutter | §3.17 L392-396; AGENTS.md L210, L213 | yes tests/helm-scrollbar-gutter.test.ts | yes |
| 26 | Radii | lg 8, md 6, sm 4, full 999; never 10/12/14 | §2.4 L111-120 | no (remote.css has 4 violations) | yes |
| 27 | Motion durations | 120/140/150ms ease-out, transform/opacity only, 8px travel | §2.5 L122-144 | no | partial |
| 28 | Reduced motion | Clamp animations; arrival pulse holds colors statically | §2.5; §3.24; AGENTS.md L161 | yes agent-dock-arrival.spec.ts:121 | yes |
| 29 | Elevation | Exactly two shadows | §2.6 L146-153 | no | yes |
| 30 | Z layers | 0/10/40/60/100; widget 2147483647 | §2.7 L155-164 | no | yes |
| 31 | Segmented | 28 outer, padding 2, max 4-5 segments | §3.2 L212-221 | no | yes |
| 32 | Lifecycle index | 44px targets, 24px gaps, 2px accent underline, radiogroup, zero outer padding, no option fill | §3.2; AGENTS.md L210 | yes helm-flat-group.test.ts | yes |
| 33 | List row | 64px, no separators, no persistent selection | §3.3 L223-234; memory calibration | partial helm-flat-group.test.ts (radius 0) | yes |
| 34 | Running row | ActivityIndicator before title | §3.3; helm-model.test.ts:46 | yes helm-model.test.ts:46 | yes |
| 35 | Queue row ownership | Permanent icon buttons Start agent / Work manually | §3.3; AGENTS.md L49 | no | partial |
| 36 | Chips | 2x8, 11/500, text only, one per row | §3.4 L236-241 | no | yes |
| 37 | Detail status | Status text menu, not chip; running non-editable | §3.4; AGENTS.md L49 | partial helm-detail-state.test.ts | partial |
| 38 | Status dots | Dot = live; pulsing 6px only beside "Agent running"; no topbar connection dot | §3.5 L243-249; AGENTS.md L210 | no | yes |
| 39 | Toast | Bottom-right, 12px inset, width min(320,100vw-32), TTL 4000, inset countdown hairline, ghost Btn action, max 3 | §3.6 L251-261; supersedes fb2d299 | yes tests/helm-toast.test.ts | yes |
| 40 | Inputs | 28px; textarea min 64; accent border focus | §3.7 L263-272 | no | yes |
| 41 | Native select | Never in the widget closed shadow root | §3.7; AGENTS.md L203 | yes extension-widget.spec.ts:214 (custom dropdown) | yes |
| 42 | Menus | 180-280 wide, 28px items, leading icon column, no submenus, ~8 items | §3.8 L274-282 | partial work-menu.spec.ts | yes |
| 43 | Work More menu | Sections Work / View / Profiles; Group by project checked item | AGENTS.md L128 area (Dashboard Item lists) | yes work-menu.spec.ts | yes |
| 44 | Sheets | Scrim, max-w 400, three zones, non-top-layer dialog | §3.9 L284-294 | partial item-sheets.spec.ts | yes |
| 45 | New item | Real pushed page, never a centered sheet | §3.10; AGENTS.md L49 | partial | partial |
| 46 | Push nav | Header 36, 150ms push with -25% parallax, isolation:isolate on every .nav-page, max depth 3 | §3.10 L296-315; AGENTS.md L210 | no | yes |
| 47 | Swipe back | 8px lock, 2x dominance, 140ms quiescence, commit 50% or flick, 90-240ms settle, never auto-finish mid gesture | §3.10; AGENTS.md L213 | yes tests/helm-swipe.test.ts | yes |
| 48 | Action bar | 56px, max two visible, icon-led concise labels | §3.11 L317-326 | yes tests/helm-detail-actions.test.ts:36 | yes |
| 49 | Danger actions | Overflow-only | helm-detail-state.test.ts:124 | yes | yes |
| 50 | Banners | 4-line clamp, actionable notice, no success banners | §3.12 L328-336 | yes tests/helm-banner.test.ts | yes |
| 51 | Restart notice | Deferred config apply = persistent notice with Restart now, not dead end | §3.12; AGENTS.md L164 (Scheduled), Gotchas config restart | partial | partial |
| 52 | Empty terminal | Closing open terminal opens no other; centered "No terminal open" card with one primary New terminal | §3.13; AGENTS.md Gotchas | yes terminal-workspace.spec.ts:552 | yes |
| 53 | Task sidebar toggle | Persistent header icon beyond 84px traffic-light reserve; content stays mounted/inert | §3.14 L350; CLAUDE.md header | partial | yes |
| 54 | Terminal insets | Flexed vertical 6-14px; mount unpadded | §3.14 L348-369; AGENTS.md L210 | partial helm-terminal-fit tests | yes |
| 55 | Terminal scrollbar | Helm overlay, 7px pill, 9px hover, inside fixed reserve | §3.14; AGENTS.md L210 | no | yes |
| 56 | Terminal links | Plain click inert; only ⌘+left-click opens http(s) | §3.14; AGENTS.md L210 | yes (shouldOpenTerminalLink test) | yes |
| 57 | Tab rename | Manual rename pins title, never overwritten by OSC | §3.14; AGENTS.md L210 | yes tests/helm-tab-title.test.ts, helm-sessions-rename.test.ts | yes |
| 58 | Flat groups | Rule with 20px inset; 28 vs 36 pitch; one shared .card-flush resource group for nav rows | §3.15 L371-384; AGENTS.md L128 | yes helm-flat-group.test.ts | yes |
| 59 | Okena button | Full-width quiet, dynamic label, no caption, below hero | §3.15 L380; helm-model.test.ts:51; AGENTS.md L193 | yes helm-model.test.ts:51 | yes |
| 60 | Run evidence | Inline on detail; log always expanded, no pushed Run pages | §3.15, §3.20; AGENTS.md L128 | yes tests/helm-disclosure.test.ts | yes |
| 61 | Disclosure | Quiet small Btn Show/Hide, Change/Done; content snaps open; children unmounted | §3.20 L431-441 | yes helm-disclosure.test.ts | yes |
| 62 | Toggle | 32x18 track | §3.16 L386-390 | no | yes |
| 63 | Tab group band | Continuous band, 15/22/30% fills, no separate top highlight, outer radius only, no chevron | §3.18 L398-418; AGENTS.md L221 | yes tests/helm-tab-groups-renderer.test.ts:115 | yes |
| 64 | Tab numbers | ⌘1-9, digits always shown, leading (N1+B1) | §3.18; c076d17 (2026-11-02); story Views / Tab numbers | yes tests/helm-tab-numbers.test.ts, tab-numbers.spec.ts | yes |
| 65 | Tab drag | Pointer drag, 5px intent, 160ms FLIP, 180ms settle, folder leading edge only, no native DnD | §3.18; AGENTS.md Gotchas | yes tab-drag-folders.spec.ts | yes |
| 66 | Window drag | Isolated positive drag regions; never titleBarStyle hiddenInset | §3.18; AGENTS.md Gotchas | yes tests/helm-window-drag.test.ts | yes |
| 67 | No zoom | No Zoom / Toggle Full Screen menu items; tab-scoped zoom guard | AGENTS.md Gotchas | yes tests/helm-native-window-zoom.test.ts | yes |
| 68 | Background popover | 320px, 44px rows, title-only header, no gutter, flat group rows, restore column alignment | §3.18; AGENTS.md L210 | yes tests/helm-background-terminals.test.ts | yes |
| 69 | Icons | Sourced (Heroicons 16 micro), exact geometry, THIRD_PARTY_NOTICES; Folder = groups, Arrow Down on Square Stack = background | AGENTS.md L196 | yes helm-background-terminals.test.ts | partial |
| 70 | ActivityIndicator | 2x3 Braille 2px; progress 1s; waiting 0.9s warn; attention 1.8s diagonal accent; never success color; no idle indicator | §3.21 L443-455; AGENTS.md L210 | yes terminal-workspace.spec.ts:1039 | yes |
| 71 | Arbitrary output dot | Never revive output-activity dot | AGENTS.md L210 | no | partial |
| 72 | Run context window | 980x760, 236px rail hidden <820px; rail shows only title + attachments, no metadata rows | §3.22 L457-469; AGENTS.md L128 | no | yes |
| 73 | Remote metrics | 320 directory, 800 measure, 44 targets, 16px form text, capsule 68% tint | §3.23 L483-492 | partial remote browser specs | yes |
| 74 | Remote header | Transparent, single 44px frosted circular nav control, 55% fill + 5px blur, no header-wide blur | AGENTS.md L41 | partial | yes |
| 75 | Remote composer | One writing surface, no visible Message label/select; blur only on capsule ::before | AGENTS.md L41, L45 | partial | yes |
| 76 | Remote image picker | Plus opens picker directly; no "Choose images…" menu (operator explicitly removed) | AGENTS.md L235 | yes remote image browser tests | yes |
| 77 | Remote thinking | Always-visible literal text, never disclosure/toggle | AGENTS.md L41; design-system.md L749 | yes | yes |
| 78 | Dock type | One typeface; 12/18 row, 13/20 read; mono only for literal commands | §3.24 L518-553; AGENTS.md L161 | yes agent-dock.spec.ts | yes |
| 79 | Dock bold | No bold anywhere in the dock | §3.24; AGENTS.md L161 | yes agent-dock.spec.ts:901-908 | yes |
| 80 | Dock surface | One --chrome surface, 1px hairline edge toward terminal, accent while focus-within | §3.24 | yes agent-dock.spec.ts:856, :1643/1968 | yes |
| 81 | Dock row | 28px queue row, no summary strip, no kind word, entries edge to edge | §3.24 | yes agent-dock.spec.ts | yes |
| 82 | Dock aging | 30m warn, 2h danger, color on glyphs only | §3.24 | yes helm-agent-dock-presentation.test.ts:163 | yes |
| 83 | Dock pane | Not an overlay; 216 → max(60%, 480); grow once, never shrink; never auto-close | §3.24; ac91bd0, 0317af2 | yes agent-dock-pane-height.spec.ts, presentation.test.ts:1103, agent-dock.spec.ts:1013 | yes |
| 84 | Dock pane resize | Hidden 6px edge, Esc cancels, double-click resets, ⌥↑/↓ nudge | §3.24; edd002c | yes agent-dock-pane-resize.spec.ts | yes |
| 85 | Dock header | Glyph + Kind + context + whose + "— task title", ‹ 1/N ›, esc (Jakub's pick 2026-11-05, variant D) | §3.24; f74be4a; AGENTS.md L161 | partial agent-dock.spec.ts | yes |
| 86 | Show terminal | ⌘O, bare `Okena ↗` link, no agent name in link (Jakub 2026-11-04) | §3.24 L546; a79dfd4 | yes agent-dock-reveal.spec.ts | yes |
| 87 | Dock turn Markdown | Quiet Markdown, weight 400, emphasis --text-0 on --text-1 | §3.24; 8ac95b9 | yes agent-dock.spec.ts:2035 | yes |
| 88 | Arrival pulse | 1.4s edge pulse in most-urgent kind color (F3) | §3.24; 42f5579 | yes agent-dock-arrival.spec.ts | yes |
| 89 | Agents pane | Grouped by state (default) or project; health dot in pane header not row | §3.24; 40b4ec8, 88b7fb5 | yes agent-dock-agents.spec.ts:146 | yes |
| 90 | Signals look | Sticky 28px --chrome section bands, Braille count marks, resting dots 4.8s (Jakub's pick 2026-11-11, look 11) | §3.25 L555-581; merge a201b92 | yes signals.spec.ts:177 | yes |
| 91 | Signals bold | No bold | §3.25 | yes signals.spec.ts:44 | yes |
| 92 | Signals resting | No all-clear / resting indicator beyond dot field words | §3.25; ea0704e | yes signals.spec.ts:151 | yes |
| 93 | Done today | Separate view via D / count click, replaces inline expand (Jakub 2026-11-10) | §3.25; AGENTS.md L183 | yes signals-done.spec.ts | yes |
| 94 | Ask body | Third body line (Jakub's pick 2026-11-10) | §3.25; 54ff5ca | yes signals-asks.spec.ts:36 | yes |
| 95 | Slack reply | Heads only, variant A (Jakub's pick 2026-11-11) | §3.25; signals-slack/spec.md L187; AGENTS.md L181 | partial (story Views / Signals / Slack) | partial |
| 96 | Copy voice | Sentence case; "…" only when more input follows; relative times <24h | §5 L596-603 | no | partial |
| 97 | Hit targets | >=24, 28 standard; 44 on Remote | §4 L584-592; §3.23 | no | yes |
| 98 | Hover | Hover never reveals essential controls | §4 | no | partial |
| 99 | Perf budgets | Startup <800/<900ms; 0 idle pushes; re-render <16ms; memory <400MB | §6 L607-656 | partial (profiler stories, dev Storybook) | partial |
| 100 | Storybook | Every §3 family has a story; Views sort first; Terminal Workspace stories mount mountTerminalWorkspace | §7 L660-670; AGENTS.md L197 | yes tests/helm-storybook-coverage.test.ts (19 titles, order Views first) | yes |
| 101 | Doc Review reading | 680px measure, 15/1.7 body; tables/code fit-content up to 1280 | design-system.md L765-820; AGENTS.md reading width | yes document-review-content-width.spec.ts:121 | yes |
| 102 | Passage bubble | 560 wide, <=640 high, 15px replies, 64px editor floor | design-system.md doc review section; AGENTS.md L227 area | yes document-review-passage-chat.spec.ts | yes |
| 103 | Send activity | E5 activity line with ActivityIndicator under newest message, no success panel (D14) | helm-open spec L517-533; design-system.md doc review | partial | yes |
| 104 | Doc Review title row | 40px, path collapses to "…" below 1000px (D12a A6) | helm-open spec | no | yes |

(104 rows; 60+ are mechanically testable; about 45 currently have a test.)

## 4. Contradictions

| # | Conflict | Locations | Note |
|---|---|---|---|
| C1 | Intro still says "dark, machined, quiet" | design-system.md L5 vs appendix L676 + memory (machined retired 2026-07-16) | Stale wording |
| C2 | Button radius md 6 vs 8 | §2.4 table L116 vs §3.1 L190 + appendix L695 | Pick one, amend table |
| C3 | Hex/rgba literals inside spec component rules | §3.1 L198 `#fff` + hover `#5a9dff` (tokens `--on-accent`, `--accent-fill-hover` exist per §2.8); §3.7 chevron `#62666e`; §3.13 kbd rgba .09; §3.17 thumb rgba .14/.24 | §2.8 calls hex in component CSS drift |
| C4 | Letter-spacing "nothing overrides -0.01em" | §2.2 L78 vs §3.14 L356 `.term-mount` letter-spacing normal | Needed exception, not documented in §2.2 |
| C5 | "Never sizes outside scale" | §2.2 vs count badge 10/700 (§3.18 L410, claims §3.4 chip spec which is 11/500), Remote 16px form / 14px menu, Doc Review 15/21/28 | Scale needs surface extensions |
| C6 | Spacing "no other values" | §2.3 vs toast padding 11 12 13 + gap 6, banner 10 12, empty card 22 26, popover offset 5, 6px resize zone, 3px offsets | |
| C7 | Motion "ease-out, 120-160ms" | §1/§2.5 vs drag FLIP cubic-bezier(0.2,0.8,0.2,1), swipe Apple curves 90-240ms, arrival 1.4s, attention 1.8s, resting dots 4.8s | Ambient vs transition classes not separated |
| C8 | "Never two filled-accent elements" | §1 vs multiple on-state Toggles using accent-fill on one Settings page | |
| C9 | Log preview state | §6.5 L652 "two-message live preview (expanded or collapsed)" vs §3.15 L382, §3.20 L433, AGENTS.md L128 "log always expanded" | Stale perf text |
| C10 | Drift appendix stale | L736 widget Label "11/600 uppercase 0.06em" canonical; L737 halo for retired connection dot; L738 widget buttons 28 while md now 32 | Appendix contradicts redesign |
| C11 | Banned radii in code | §2.4 never 10/12/14 vs remote.css L185 (10px), L874/L1262/L1440 (12px) | Code drift |
| C12 | Rounded vs square selection | memory user_design_taste.md "rounded inset selection"; 9cbe937 "64px rounded list rows" vs §2.3 + AGENTS.md L210 square stripes radius 0 (tested helm-flat-group.test.ts) | Memory stale; spec + test win |
| C13 | Okena button caption | memory project_flat_redesign.md "hero Open in Okena with caption" vs §3.15 L380 "no caption" (tested helm-model.test.ts:51) | Memory stale |
| C14 | Work toolbar / task list | §3.10 L306 "… = profile quick switcher"; §3.8 L282 Poll now/Pause behind "…" vs AGENTS.md Signals subsystem: desktop shows no task list; Settings/profiles only via Signals header Settings; Pause/Poll have no UI | Spec describes removed surface |
| C15 | Sidebar toggle label | §3.14 L350 "Hide task sidebar / Show task sidebar" vs §3.25 label names surface ("Hide Signals"/"Hide Settings"); code sidebar-layout.ts:59 initial 'Hide task sidebar', L118 dynamic | Initial label disagrees with §3.25 |
| C16 | Toast placement history | fb2d299 (2026-07-22) centered bottom vs spec bottom-right | Resolved in spec + helm-toast.test.ts |
| C17 | Where-link agent name | a79dfd4 `Okena ↗ <agent>` vs L546 no agent name (Jakub 2026-11-04) | Resolved; spec current |
| C18 | Elevation | §2.6 "exactly two shadows" vs 13 box-shadow declarations in styles.css (some inset rings) | Unverified whether all map to the two tokens |
| C19 | Segmented semantics | §3.2 one tab stop role=tablist vs lifecycle index radiogroup | Documented exception |
| C20 | Dark-only | §2.8 no light preset vs light Doc Review reading surface L811-818 | Documented scoped exception |
| C21 | Weight 700 / 650 | §2.2 bold 600-700 permits 700, but dock/Signals say no bold; widget.styles.ts uses 650 (between ladder steps) | Minor |
| C22 | --ui-scale | AGENTS.md L213 requires calc(... var(--ui-scale)) for new sidebar font-size vs sidebar.css:751 `font-size: 11px` | Code drift |

## 5. Enforcement gaps

- No lint or test for: uppercase / text-transform, hex/rgba literals outside token files, radius values (10/12/14 ban), spacing scale, font-size ladder, `--ui-scale` calc, letter-spacing, color-mix 15% soft fills, two-shadow elevation, z-layer table, "one primary per surface", "one filled accent".
- 0 visual-regression screenshot assertions (`toHaveScreenshot` 0 files); browser tests assert computed styles case by case (strong for dock/Signals, absent for sidebar typography and Remote radii).
- extension widget.styles.ts referenced by 0 Node tests; drift appendix values for the widget are stale and untested.
- prefers-contrast, helm.appearance persistence, accent-fill usage: 0 tests.
- Strongly enforced areas: square stripes + gutters (helm-flat-group, helm-scrollbar-gutter), toast, banners, disclosure, window drag/zoom, tab groups/numbers/drag, agent dock (no bold, surface, pane height/resize, arrival, reveal, agents), Signals (no bold, bands, done, asks), Storybook coverage list (19 titles), Doc Review reading width.

## 6. Vague / prose-only areas worth tightening

- §1 Principles: no measurable criteria.
- §6.6 bundle budget: not quantified per chunk.
- Extension prompt quick editor (L473-477): behavior only, no visual spec.
- §3.23 Remote and Doc Review sections (L749-820): long prose paragraphs mixing behavior, protocol and visuals; metrics scattered rather than in tables (except L483-492 and L811-818).
- Two appendices hold both history and canonical values; readers cannot tell which rows are current (C10).
