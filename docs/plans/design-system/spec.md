# Helm design system: one spec, one token source, every rule checked

Status: in progress (2026-11-12). Done: S1, S3, S4, S5 (StateGrid and forced states; the rest moved to S11), S7 (the parts that need no pick), S8; Jakub picked the D1–D14 Proposals on 2026-11-13 (two D7 questions still open); S9 implements the picks (§ Progress). S2 waits on D2, S6, S10 and S11 are not started, S9 is in progress. Details under § Progress. Branch `feat/design-system`; the dispatcher merges each stage into local `main` with `--no-ff`.

Jakub (2026-11-12): "jak děláme ten design system pro tally a jvs, tak chci jeden i pro helm." Earlier, about JVS: "udělej na to worktree, kterej to celý spojí a udělá pořádný jako má tally. chci všechno aby bylo dokonalý a dodržovalo se."

Research (read-only audits, every number measured with a command): `research/tally.md` (how Tally's system works, with code), `research/helm-spec.md` (section map, 104 candidate rulings, 22 contradictions), `research/helm-tokens.md`, `research/helm-components.md`, `research/helm-infra.md`, `research/helm-surfaces.md`, `research/critic.md` (34 claims re-measured, 6 corrected; measured WCAG contrast).

## Problem

Helm has a real design spec (`docs/design-system.md`, 820 lines, §1–§7 + two appendices) and strong per-feature browser tests, but almost nothing holds the system itself together:

- **Tokens are copied by hand.** `app/src/theme-presets.ts` (54 tokens, 51 High contrast) is mirrored by hand into `styles.css :root` (64 properties), the extension's `--vg-*` block (`extension/src/widget.styles.ts`), Storybook backgrounds, the Remote PWA manifest/offline page and three native window backgrounds. They match today (0/54, 22/22 differ); no test keeps them so.
- **Five custom properties are used but never defined:** `--radius-sm/md/lg`, `--motion-state`, `--accent-text`. Four radius uses have no fallback, so those corners render square (then `styles.css:999`, now `terminal-context-menu.css:23` `.menu-name-input`; `detail-redesign.css:36`; `sidebar.css:1909` `.sheet`; `sidebar.css:2069` `.remote-qr`).
- **Measured contrast fails AA where it matters.** `--text-2` (`#62666e`, the standard meta colour, 77 production uses) is 2.96–3.28:1; white on `--accent-fill` (primary button) is 3.68:1 (hover 2.73); control edges are 1.20/1.62:1. Even the High contrast preset fails primary-button text (4.46) and control edges (2.84). Tally's contrast test would start red.
- **No rule is linted.** 36 raw colours, 45 raw z-index, 77 hard-coded durations, 97 raw radii (16 off-scale), 112 off-scale spacings, 46 unscaled font sizes, 0 forced-colors rules. Biome 1.9.4 has no plugin mechanism; `biome check .` already fails with 12 errors.
- **Surfaces drifted apart.** Remote re-binds 7 core colours; Document Review/viewer/Remote never run `appearance.init()` (no High contrast, no user theme, no UI scale); the extension popup uses VS Code colours; the agent dock and Signals (2,566 of styles.css's 3,969 lines) copy each other's keys/choices; there was no icon module (21 of 23 `GLYPH` icons are hand-drawn despite the AGENTS.md rule).
- **Storybook is a workbench, not a contract.** 53 story files, 397 stories, no addons, no forced-state grids (one story-only hover hack), the extension shows one story, a coverage test pins 19 titles; the task list/detail are Storybook-only since production mounts Signals.
- **Decisions have no numbers.** About 100 rulings exist as prose ("Jakub's pick 2026-11-05", commit messages, memory); 22 contradictions between spec, AGENTS.md, code and memory.
- **No CI.** `main` is local and never pushed, so enforcement has to live in `npm test` and an explicit design gate that AGENTS.md makes mandatory.

## What Tally does that makes it hold (and what Helm copies)

| Tally mechanism | Helm today | Helm target |
|---|---|---|
| `ui/DESIGN.md` wins over code; literal px/tokens per component | `docs/design-system.md` wins (AGENTS.md "law") but mixes history and canonical values | same file, restructured; appendices become rulings; section numbers kept stable (agents cite §3.24, §3.25) |
| §9 numbered rulings `\| # \| Topic \| Delivered spec \| Ruled \| Where \|`, cited `(§9 ruling N)` | none | §9 with an extra **Enforced by** column naming the check |
| `tokens/*.ts` → `scripts/tokens.ts` → committed outputs, `tokens.test.ts` byte-compares | hand mirrors, no test | `app/src/design/tokens/*.ts` → `app/scripts/tokens.mjs` → committed outputs, freshness test |
| `contrastPairs.ts` with the spec's ratio per row, `open` list must be empty | no table | same; `open` lists today's failures, each tied to a decision; an entry that starts passing fails the test |
| axe over every story, both themes, allowlist with stale-entry failure | 0 axe runs | `app/scripts/a11y.mjs` over the static Storybook, Helm + High contrast (+ light review scope) |
| StateGrid + `:is(:hover,[data-force-state=hover])` | one hack (`data-bg-preview`) | StateGrid in `app/src/renderer/storybook/`, forced-state selectors on every interactive primitive |
| Biome import ban, CSS-scanning tests | Biome recommended only | node tests that lint CSS/TSX for tokens-only (Biome 1.9 cannot), plus Biome clean |
| root AGENTS.md § Design system | scattered rules in a 325-line AGENTS.md | one § Design system with the process: variants in Storybook → Jakub picks → ruling recorded |

Deliberately not copied: Tally's generated Swift/Mac outputs, `light-dark()` dual theme (Helm is dark-only by ruling; the Document Review light reading scope is the documented exception), MDX docs pages (Helm keeps stories + the markdown spec).

## Target architecture

```
docs/design-system.md            the spec (wins over code)
  §0 index: surfaces → sections → stories → checks
  §1 principles, §2 tokens (+ §2.9 measured contrast, generated), §3 components (numbers kept, new ones appended)
  §4 interaction, §5 copy, §6 performance, §7 Storybook, §8 accessibility checklist (new), §9 rulings (new), §10 enforcement map (new)
app/src/design/
  tokens/{color,type,space,radius,motion,z,surface}.ts   the only place a value is written
  tokens/contrast-pairs.ts        measured pairs per palette, spec ratio, open list
  tokens/index.ts                 HELM_TOKENS / HIGH_CONTRAST_TOKENS / scoped palettes (Remote, Review light)
app/scripts/tokens.mjs            writes the generated files below; `--check` exits 1 when stale
  app/src/renderer/tokens.generated.css     :root block (styles.css imports it first; same cascade)
  extension/src/tokens.generated.ts         --vg-* block for the closed shadow root
  app/.storybook/backgrounds.generated.ts, Remote manifest/offline colours, native window backgrounds
app/src/renderer/storybook/StateGrid.tsx    forced-state grid for every interactive primitive
app/scripts/a11y.mjs (+ a11y-allowlist.json) axe over storybook-static in each theme
app/scripts/visual-diff.mjs       before/after screenshot of every story: proof that a refactor is pixel-identical
tests/design-*.test.ts            node checks (below), part of `npm test`
npm run check:design              tokens --check, design tests, coverage, biome; a11y (needs a Storybook build) joins in S6
```

Where the design system lives and how app and extension share it are open decisions (D1, D2); the plan above assumes the recommendation (tokens shared by generation, components per framework) and changes only paths if Jakub picks otherwise.

## Stages

Every stage is a clean commit series, ends with independent review (workflow: find → adversarial verify), the four checks from AGENTS.md (root `npm run build`, `extension/ node build.mjs`, `app/ node scripts/build-document-canvas.mjs && node build.mjs`, `npm run typecheck:all`), the stage's own tests, and a pixel-identity proof for any CSS/TSX change (`visual-diff.mjs`, every story before/after, 0 differing pixels). No `make test`/`make check` in this worktree (symlinked `node_modules`).

| Stage | Delivers | Enforces after the stage | Visible change |
|---|---|---|---|
| **S1 Spec + rulings** | §0 index, §8 a11y checklist, §9 rulings back-filled (each row cites its source: commit, date, spec line, Jakub's words), §10 enforcement map; stale text fixed where code + tests already agree (C1, C9, C10, C12–C17); contradictions where code disagrees go to § Open decisions, not silently edited | `tests/design-spec.test.ts`: every `§N`/`§N.M`/`ruling N` cited in AGENTS.md, docs, code comments and tests exists; every ruling has an **Enforced by** cell naming an existing file or `D<n>` (pending); every story title the spec names exists in the story index; §0 index lists every story root | none (docs) |
| **S2 Token pipeline** | `app/src/design/tokens/*` as the single source; generator + committed outputs for `:root`, theme presets, extension `--vg-*`, Storybook backgrounds, Remote PWA colours, native window backgrounds; z-index, motion, radius, spacing, type tokens added with **today's values** | `tests/design-tokens.test.ts`: generated files byte-fresh; resolved values equal a snapshot taken before the move (0 changes); every `var(--x)` used in CSS/TS is defined (`--motion-state` is the one left, used with a 140ms fallback; the radius tokens and `--accent-text` are defined since D4, §9 rulings 17 and 87); user-theme files may only set known token names (validation test) | none (identical values, proven) |
| **S3 Token-only lint** | node CSS/TSX scanner (no new dependency) for: raw colours, raw z-index, raw durations/easings, off-scale radius/spacing/font-size, unscaled sidebar font-size, uppercase, letter-spacing, font-weight outside {400,500,600}, inline `<svg>` outside the icon module; replace raw values with tokens where the value is identical | `tests/design-lint.test.ts` with a baseline allowlist (`file + selector + property`, reason, `D<n>` or ruling); a new violation fails, an allowlisted one that disappears fails until removed (ratchet). `biome check .` brought to 0 errors and added to the gate | none (identical values; visual-diff) |
| **S4 Contrast** | `contrast-pairs.ts` for Helm, High contrast, Remote, Review light, extension popup; §2.9 table generated from it into the spec | `tests/design-contrast.test.ts`: ratio per pair to 2 decimals, `ratio ≥ need` unless the pair is in `open` with a `D<n>`; open entry that now passes fails; spec table fresh | none (measures) |
| **S5 Storybook contract** | StateGrid + `data-force-state` selectors on every interactive primitive (attribute selectors only, production output unchanged); `States` story per primitive; `storySort` method; a **Proposals/** root for design variants. The theme toolbar, the stories for unstoried states and `tests/design-stories.test.ts` moved to S11 | `tests/design-force-state.test.ts`: every interactive state selector on a primitive has a `[data-force-state]` copy in the same rule; every primitive file has a StateGrid `States` story | none (Storybook only) |
| **S6 Accessibility** | `axe-core` (MPL-2.0) as an app devDependency (see § Install); `a11y.mjs` serves `storybook-static`, scans every story in each theme with real Chromium (Playwright 1.62, already installed), waits for fonts/animations; allowlist `{story, rule, target, reason, D<n>}` | every story passes axe or is allowlisted with a decision; stale allowlist entry fails; `forced-colors`/`prefers-reduced-motion` smoke per primitive | none (measures) |
| **S7 Shared components** | merge pixel-identical duplicates: dock/Signals key buttons and choices, `.viewer-search-field` → `.input`, terminal tab context menu onto `MenuButton` CSS; icon module (`app/src/renderer/icons/`) with every existing glyph moved as-is (source/licence recorded, hand-drawn ones flagged for D6); component CSS beside its component (split the dock/Signals 2,566 lines out of `styles.css`) **after** the open Signals branches land | lint: icons only from the icon module; a primitive's CSS only in its own file; visual-diff 0 pixels | none (pixel-identical, proven) |
| **S8 Process** | root AGENTS.md § Design system (where UI goes, tokens-only, stories + StateGrid + a11y required, `npm run check:design` before handoff, variants in `Proposals/` → Jakub picks → ruling in §9 + check); the stale `sysbudget` guidance in AGENTS.md, the design-system docs and the Remote runbook; `THIRD_PARTY_NOTICES` fixed | `design-spec.test.ts` also checks AGENTS.md names the gate and the §9 file | none |
| **S9 Rulings that change pixels** | one Proposals story set per decision D3–D9, Jakub picks, then implement, remove the allowlist/open entries, record the ruling | the entries leave the allowlist/open lists, so the checks hold the new value | **yes, only after picks** |
| **S10 Remaining rule checks** | lint rules for the families S3's scanner does not cover: tone soft fills exactly 15% (§9 ruling 7), only the two elevation shadows (ruling 20), font stacks only through `--font-ui`/`--font-mono` (ruling 14), glyph chips and in-flow boxes beyond the shared resource group (rulings 1, 3), local button/menu/field chrome that bypasses `Btn`/`MenuButton`/`Field` (§10 component reach), the rest of the copy voice (ruling 86) | each as a `tests/design-lint.test.ts` rule with baseline entries (reason: ruling or `D<n>`), same ratchet as S3 | none (baseline) |
| **S11 Story coverage and component measures** | what S5 did not deliver: theme toolbar (Helm / High contrast / Review light / UI scale 0.92·1·1.08); stories for unstoried states (terminal tab menu, rename editor, no-terminals card, scrollbar, Remote drawer/sheets/menus, Sheet, action bar, extension widget states, popup); checks for the component measures and behaviors §9 still marks `pending S11` (segmented track, lifecycle index, queue ownership buttons, chips, status dots, menus, sheets, push navigation, banners, toggle, tab group band, Background viewing, Run context window sizes, Slack reply, focus ring and field border values, disabled cells) | `tests/design-stories.test.ts` (reads the story index): every §3 section names ≥1 story; every production destination has a Views story; Proposals stories never import from production-only code paths; each listed ruling held by a browser spec or lint rule | none (Storybook and checks) |

Order: S1 → S2 → S3/S4 (parallel) → S5 → S6 → S7 → S8 → S10 → S11, S9 as picks arrive. S7's `styles.css` split waits for `fix/signals-done-footer-bottom` (Signals CSS) to land, to avoid a large rebase conflict; everything else rebases cheaply.

### Progress

- **S1** done (`cf37ee9`): spec index, rulings, enforcement map, `tests/design-spec.test.ts`.
- **S3** done (`758c860`, `ca8db1a`, baseline refreshed after the S7 split): `app/src/design/lint.ts` with 14 rules, the ratchet baseline `app/src/design/lint-allowlist.ts` (468 entries, every reason a `D<n>`, ruling or stage), `tests/design-lint.test.ts`, `npm run lint:design`; `biome check .` is clean and is the last step of `npm run check:design`. Deferred: replacing raw values with tokens. A literal that equals a token today still differs under High contrast or a user theme (a visible change, D7/D10), and z-index/motion literals have no token until S2 (waits on D2); the baseline names the decision for each.
- **S4** done (`a24644a`): `contrast-pairs.ts`, `tests/design-contrast.test.ts`, generated §2.9 table.
- **S5** done (`1a9bce3`): StateGrid, `data-force-state` selectors, `tests/design-force-state.test.ts`. Not delivered, moved to S11: the theme toolbar, the stories for unstoried states, `tests/design-stories.test.ts`, and the checks for the rulings §9 had marked as waiting on S5.
- **S7** done for the parts that need no pick: `styles.css` is an ordered `@import` manifest with every rule beside its component, dock/Signals CSS in `agent-dock/agent-dock.css` and `signals/signals.css` (`f9ae194`); dock and Signals keys and choices share one rule (`74fa65c`); one icon module `app/src/renderer/icons/` with every glyph moved as-is and its source (`2d761b8`, `tests/design-icons.test.ts`). Lint: inline SVG outside the icon module, and a primitive's base rules only in its owner file (`primitive-outside-owner`, 0 violations), plus no border on any button (§9 ruling 4). Not merged, because they are not pixel-identical: `.viewer-search-field` vs `.input` (font shorthand, a transition, full width, a hover media query; the viewer's own field is part of D7 surface reach). The terminal tab context menu had no duplicated menu CSS to merge (`terminal-context-menu.css` only positions the panel and styles its name form). The 22 hand-drawn icons wait on D6.
- **S8** done (`0bec1ca`; `THIRD_PARTY_NOTICES.md` corrected in `2d761b8`): AGENTS.md § Design system, `npm run check:design`, no `sysbudget` guidance left in AGENTS.md, the design-system docs or the Remote runbook `docs/remote/README.md`; `tests/design-spec.test.ts` checks the section, its scripts and its paths.
- **S9** picks from 2026-11-13 implemented (`52e2402`): D4 (radius tokens on `:root`, group-name field 6px, `--accent-text`), D11 (on toggles exempt from the one-filled-accent rule), D12 (widget buttons 32), D13 (`.menu-hint` follows `--ui-scale`), D14 (no toast cap; Undo stays its whole grace).
- **S2** waits on D2. **S6** not started. **S10** not started (the families it lists show `pending S10` in §10). **S11** not started (the rulings it lists show `pending S11` in §9 and §8).

### Install

AGENTS.md forbids installs through the symlinked `node_modules`. `axe-core` 4.13.0 is already in the npm cache. Plan: add it to `app/package.json` + `bun.lock` in S6; the a11y script resolves it from `node_modules` or from `HELM_AXE_CORE` (a path) so this worktree can run it from an unpacked tarball. After the merge, `main` needs one `bun install` in `app/` (dispatcher). No other new dependency: the CSS scanner, generator and contrast maths are plain Node.

## Open decisions (Jakub's)

Structural:

- **D1 How app and extension share the system.** (a) *Recommended:* tokens shared by generation (one source writes the extension's `--vg-*` file), components stay per framework (React app, SolidJS extension), each tested against the spec. Cheap, no build coupling; component look kept equal by spec + story review, not by shared code. (b) One framework-free CSS package of component classes both import; the extension ships it inside its shadow root. Removes CSS duplication but couples the extension build to app CSS and grows the widget bundle. (c) Rewrite the widget in React to share components. Largest; changes the extension's AGENTS.md rule (SolidJS).
- **D2 Where it lives.** (a) *Recommended:* `app/src/design/` + `app/src/renderer/{icons,storybook}` inside the app package (no new workspace wiring; app already owns Storybook). (b) A workspace package `packages/helm-ui` like `@tally/ui`, with its own Storybook, tsconfig and exports. Cleaner boundary, but Helm's three packages use different package managers (npm root, bun app, npm extension) and the app build would need a new step.
- **D3 Gate without CI.** (a) *Recommended:* `npm run check:design` mandatory in AGENTS.md before any UI handoff, fast parts inside `npm test`. (b) Also a local git pre-commit hook running the fast parts (slows every commit by ~2 s; agents in worktrees would hit it too).

Visible (each gets Proposals stories and a link before anything changes; S9):

- **D5 Contrast.** `--text-2` meta text (2.96–3.28:1), primary button white on accent fill (3.68, hover 2.73), control edges (1.20/1.62), High contrast preset (4.46 button, 2.84 edges), Remote text-2 on bubble (2.32), Review light accent on well (4.499) and `--neutral` (2.70). Variants per pair: lift to AA, or rule an exception (e.g. decorative edges) and record it. Proposal: `docs/plans/design-system/proposals/D5.md`, Storybook Proposals/D5 Contrast.
- **D6 Icons.** 21 of 23 `GLYPH` icons are hand-drawn (22 module entries with the sidebar toggle, plus the 2 extension SVGs and the select data URI); AGENTS.md says production icons are sourced. Replace with sourced equivalents (Heroicons micro), or rule the hand-drawn set as Helm's own and record it. Proposal: `docs/plans/design-system/proposals/D6.md`, Storybook Proposals/D6 Icons.
- **D7 Surface reach.** Should Document Review, the viewer and Remote follow High contrast, user themes and UI scale (today only the cockpit and Run Context do)? Remote's own darker palette: keep as a ruled Remote palette or align with the app. Proposal: `docs/plans/design-system/proposals/D7.md`, Storybook Proposals/D7 Surface reach.
- **D8 Off-scale values.** remote.css radius 10/12 (banned by §2.4), button radius 6 vs 8 (§2.4 vs §3.1), 31 off-scale font sizes, 112 off-scale spacings, weight 700 ×3 and 650 in the widget, letter-spacing overrides: snap to the scale or extend the scale by ruling. Proposal: `docs/plans/design-system/proposals/D8.md`, Storybook Proposals/D8 Scale.
- **D9 Extension popup** uses VS Code colours; bring it onto Helm tokens. Proposal: `docs/plans/design-system/proposals/D9.md`, Storybook Proposals/D9 Extension popup.
- **D10 User theme files** seeded once never update (live machine: 44 of 54 tokens, so High contrast users get Helm's values for 10). Options: re-seed bundled presets on upgrade and keep only real user files, or merge missing tokens from the same preset (not from Helm). Not visual by itself but changes what High contrast users see. Proposal: `docs/plans/design-system/proposals/D10.md`, Storybook Proposals/D10 Theme files.

## Non-goals

- Redesigning anything. Every pixel change goes through S9 and a pick.
- Web visual regression in the gate (Tally has none either). `visual-diff.mjs` is a refactor proof, run by the stage author.
- Native menus/dialogs styling beyond what Electron exposes.
- Unshipped prototypes (`open-prototype/`, `app/prototypes/`): stories stay, but they are excluded from lint and coverage by an explicit allowlist rule.

## Testing decisions

- Every rule names its check in §10; a rule without one is listed as unfinished in the stage report.
- Checks that run in `npm test` (node, < 5 s total): spec references, tokens freshness + identity, lint, contrast, story index coverage. a11y needs a Storybook build and joins `npm run check:design` in S6; visual-diff stays a manual refactor proof outside the gate (see Non-goals).
- Allowlists are ratchets: each entry has a reason and a decision or ruling; an entry that no longer matches fails, so fixes are recorded.
- Pixel identity is measured, not argued: S2, S3, S5 and S7 each attach the visual-diff summary (stories scanned, 0 differing pixels) to the stage report.
