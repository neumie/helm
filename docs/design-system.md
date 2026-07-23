# Helm design system

**This document is law for every helm UI surface**: the app renderer (`app/src/renderer/`), the extension widget (`extension/src/widget.styles.ts`), and any future surface. A UI change that introduces a new pattern MUST add it here in the same slice; a value not in these tables is drift. Where existing code disagreed, the canonical value was picked and the change is recorded in [Appendix: reconciled drift](#appendix-reconciled-drift).

Helm is the captain's station: dark, machined, quiet. Everything below serves that.

---

## 1. Principles

1. **One bold element per surface.** Each surface gets exactly one signature/high-emphasis element (a detail page owns its single primary button; the sidebar list owns its filter's active segment). The topbar deliberately owns NONE — traffic-light inset, drag region, tab strip; no branding, no status jewelry. Never two filled-accent elements visible at once.
2. **Depth from the ladder, not decoration.** Hierarchy comes from the three-step background ladder + hairlines + white-alpha fills. No gradients, no borders heavier than 1px, no shadows on inline elements — shadows are for detached surfaces (toast, menu, sheet, widget) only. **In-flow content is flat**: grouping comes from section headers, hairline rules, and spacing — bordered/boxed cards are reserved for detached surfaces and wells, never for content sitting in the page flow.
3. **Quiet motion.** 120–160ms, ease-out, transform/opacity only. `prefers-reduced-motion` MUST be respected globally. Ambient animation (pulse, breathe) is reserved for live status, never decoration.
4. **Designed for its width.** Every surface is designed at its real width (sidebar: 340px). Never cram a desktop layout into a narrow pane; use push navigation instead of side-by-side panes below 480px.
5. **Selection is the action; copy gives direction.** No hover-revealed actions in lists — selecting the row is the interaction. All copy is sentence case, active voice; states tell the user what happens next, never how to feel ("Daemon unreachable — retrying", never "Oops!").

---

## 2. Tokens

Canonical CSS custom properties. Helm defines them on `:root` (`app/src/renderer/styles.css`); the extension defines the same values on `:host` with a `--vg-` prefix (shadow-root isolation). **The values MUST be identical across surfaces**; the prefix is the only allowed difference.

### 2.1 Color

Background ladder (dark only — helm surfaces do not ship a light theme):

| Token | Value | Role |
| --- | --- | --- |
| `--chrome` | `#1a1c1f` | Window chrome, topbar, elevated cards (toast, menu, offline card, sheet) |
| `--pane` | `#141517` | Default surface: sidebar, dashboard, widget card base |
| `--well` | `#0f1113` | Deepest inset: terminal well, code wells, log viewers |

White-alpha fills and lines (always on the ladder, never opaque grays):

| Token | Value | Role |
| --- | --- | --- |
| `--hairline` | `rgba(255,255,255,0.07)` | All borders and separators. The only line weight is 1px |
| `--hairline-strong` | `rgba(255,255,255,0.16)` | Emphasized border: quiet-button outline, hovered input border, drag-target hover |
| `--fill-subtle` | `rgba(255,255,255,0.05)` | Hover fill; resting input/segmented-track background |
| `--fill-raised` | `rgba(255,255,255,0.09)` | Active/selected fill (active tab, selected row, active segment); resting quiet-button fill |
| `--fill-strong` | `rgba(255,255,255,0.13)` | Hovered quiet-button fill — the only step above raised |

Text:

| Token | Value | Role |
| --- | --- | --- |
| `--text-0` | `#ececee` | Primary: titles, body, button labels |
| `--text-1` | `#9a9ea6` | Secondary: descriptions, toast detail, quiet-button labels |
| `--text-2` | `#62666e` | Faint: meta, timestamps, labels, placeholders, disabled-adjacent |

Accent and semantic tones. Each tone has a **text/icon value** and a **soft fill** (15% alpha) for chips and banners:

| Token | Value | Soft fill | Role |
| --- | --- | --- | --- |
| `--accent` | `#4c9aff` | `rgba(76,154,255,0.15)` | Links, focus ring, running state, cursor, selection |
| `--accent-fill` | `#3b82f6` | (hover `#5a9dff`) | Filled primary button background ONLY — `#4c9aff` is too bright as a fill under white text |
| `--success` | `#4ec98a` | `rgba(78,201,138,0.15)` | Done, connected, merged |
| `--warn` | `#e0b341` | `rgba(224,179,65,0.15)` | Needs attention, review, degraded |
| `--danger` | `#f2585b` | `rgba(242,88,91,0.15)` | Failed, destructive actions |
| `--neutral` | `#8a8f98` | `rgba(138,143,152,0.15)` | Inbox, queued, cancelled, unknown |

- All soft fills are exactly **0.15 alpha** of their tone. Never invent per-component alphas.
- Never use a tone color as an opaque background (exception: `--accent-fill` primary button).
- Status → tone mapping is fixed: inbox/queued/cancelled = neutral, active/running = accent, review/needs-you = warn, done = success, failed = danger. Do not remap per surface.

### 2.2 Typography

Families:

| Token | Stack | Use |
| --- | --- | --- |
| `--font-ui` | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif` | All UI text |
| `--font-mono` | `'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace` | Terminal, branch names, ids, kbd, code |

Scale (px / weight / notes). Base letter-spacing is `-0.01em` everywhere; no style overrides it. **Uppercase text does not exist in helm** — the former uppercase Label/Chip styles are retired (see appendix):

| Style | Size/weight | Spec |
| --- | --- | --- |
| Page/hero title | 17/600, line-height 1.3 | The one leading line of a page: the detail hero's next-step headline, the pushed Task page's canonical title. One per page. `--text-0` |
| Body / row title | 13/400 (titles 13/500) | Default. Line-height 1.5 for paragraphs, single-line ellipsis in rows |
| Emphasis / button | 13/600 (buttons 12/600) | Empty-state titles, hero headlines |
| Secondary | 12/400 | Detail lines, toast detail, descriptions. `--text-1` |
| Meta | 11/400 | Timestamps, counts. `--text-2`, `font-variant-numeric: tabular-nums` for numbers/times |
| Section header | 12/600, sentence case | Group/section titles ("Outcome", "Work", "Daemon", "Comments"). `--text-1` |
| Label | 12/500, sentence case | Field labels, fact-row labels ("Branch", "Workspace"). `--text-2` |
| Chip | 11/500, sentence case | Chip/badge text only ("Review", "Needs info"). Tone-colored per §3.4 |
| Mono inline | 11/400 mono | Branch names, ids, kbd |
| Terminal | 13/400 mono (default), cell height ≈19px | xterm: `lineHeight: 1.2` multiplier lands 13px at ~19px cells (`app/src/renderer/renderer.ts`) — a literal 1.45 would render ~22px. Size is user-adjustable **9–24px** via ⌘= / ⌘− / ⌘0 or Settings → Appearance (§2.8). Theme comes from the `--term-*` / `--ansi-*` tokens (§2.8): bg `--term-bg`, fg `--term-fg`, cursor `--term-cursor`, selection `--term-selection` |

- `-webkit-font-smoothing: antialiased` on the body.
- Never use font sizes outside this scale. Never bold below 600 or above 700.
- **UI text scale**: the sidebar's type scale multiplies by `--ui-scale` (0.92 / 1 / 1.08 — Settings → Appearance): every sidebar `font-size` is written `calc(<spec px> * var(--ui-scale))`. Layout metrics (heights, padding, hit targets) and the terminal do NOT scale.

### 2.3 Spacing

4px base scale: **4, 8, 12, 16, 20, 24, 32**. No other values (1px is a line, not a space; 2px only as inner padding of segmented tracks and countdown-bar height).

**One text grid.** Every text column in the sidebar pane starts **16px from the pane edge** — the same 16 as the terminal well's text inset, so the whole app shares one left edge. Containers never nest horizontal insets (a group inside the 16px page gutter has 0 side padding). **Controls are rounded; row state backgrounds are not controls:** button/field fills keep their token radius, while hover/selection/current fills for list/nav/terminal rows are square full-width stripes with internal padding that leaves text on the 16px grid. In divided editorial groups, the stripe clears its row boundary by 4px above and below so it never visually collides with a hairline. Symptoms of breaking this: text columns at 20px (a leftover sub-inset), labels pinned to the pane edge, a rounded row highlight reading like a giant pill, or a highlight fused to its divider.

| Context | Value |
| --- | --- |
| Inside controls (icon↔label, dot↔text) | 4–8 |
| Control-to-control in a row (toolbar, action bar) | 8 |
| Card/section internal padding | 12 (compact) or 16 |
| Between sections / stacked cards | 12 |
| Surface edge inset (toasts from viewport, sheet inset, pane padding) | 16 |

### 2.4 Radii

| Token | Value | Use |
| --- | --- | --- |
| `--radius-lg` | 8 | Cards, toasts, menus, sheets, banners, wells |
| `--radius-md` | 6 | Buttons, inputs, selects, tabs, segmented outer, menu-item hover |
| `--radius-sm` | 4 | kbd, segmented inner option, tab-close hover, mini affordances |
| full | 999 | Chips, pills, dots |

Never 10/12/14px radii (extension card's 14px is reconciled to 8 — see appendix). Buttons and compact controls use these radii; full-width row hover/selection/current stripes always use radius 0.

### 2.5 Motion

| Token | Value | Use |
| --- | --- | --- |
| `--motion-exit` | 120ms | Leaving: toast dismiss, menu close, back-navigation |
| `--motion-state` | 140ms | State change: hover, active, color/background transitions |
| `--motion-enter` | 150ms | Entering: toast/sheet/menu appear, push navigation |
| easing | `ease-out` | Everything. `linear` ONLY for countdown/progress bars |

- Animate `transform` and `opacity` only; `background-color`/`color` may transition at 140ms. Never animate layout properties (width/height/top/left) — the pane divider drag is direct manipulation, not animation.
- Entrances travel **8px** (translateY(8px)→0 for toasts/sheets; see §3.10 for push).
- Ambient (live-status only): running-dot pulse `1.6s ease-in-out infinite`. (The retired topbar connection dot's offline breathe `2.4s ease-in-out infinite`, opacity 1→0.4, is no longer used by any surface; reuse that spec if a future surface genuinely needs an offline ambient.)
- Global reduced-motion clamp is mandatory on every surface (pattern from `styles.css:428`):

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### 2.6 Elevation

Exactly two shadows. Attached surfaces (cards in flow, banners, rows) get **no shadow**.

| Token | Value | Use |
| --- | --- | --- |
| `--shadow-1` | `0 8px 24px rgba(0,0,0,0.35)` | Toast, menu/popover |
| `--shadow-2` | `0 10px 30px -8px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.35)` | Sheet/modal, injected widget (floats over foreign pages — needs harder separation) |

### 2.7 Z-layers

| Layer | z-index |
| --- | --- |
| Content | 0 |
| Pinned bars (topbar, action bar, push-nav header) | 10 |
| Menus / popovers | 40 |
| Sheet + scrim | 60 |
| Toasts | 100 |
| Injected widget root (extension shadow DOM, competes with host page) | 2147483647 — allowed ONLY at the shadow-root host; layers inside the widget use this table |

### 2.8 Theming

Every color in this document is a **CSS custom property** — components MUST consume `var(--token)`, never literals; a hex/rgba literal in component CSS is drift. Beyond §2.1, the token set includes `--fill-strong` (quiet-button hover), `--accent-fill-hover`, `--on-accent` (text on accent fills), `--thumb`/`--thumb-hover` (pane scrollbars + toast countdown), `--term-scroll-thumb`/`--term-scroll-thumb-hover` (the terminal overlay scrollbar, §3.14 — a brighter pair because it floats over `--well`), `--scrim`, `--shadow-1`/`--shadow-2`, the terminal surface (`--term-bg`/`--term-fg`/`--term-cursor`/`--term-cursor-accent`/`--term-selection`), and the ANSI 16 as `--ansi-<name>`/`--ansi-bright-<name>`. The canonical values live in `app/src/theme-presets.ts` (`HELM_TOKENS`); `app/src/renderer/styles.css` `:root` mirrors them only for the pre-JS first paint — keep both in sync.

- **Soft fills are derived, not stored**: `--<tone>-soft: color-mix(in srgb, var(--<tone>) 15%, transparent)`. Themes override the tone; every chip/banner/soft border follows automatically. Never hand-mix a per-component alpha (the §2.1 0.15 rule, mechanized).
- **A theme is a flat JSON object of token overrides**, stored as `<userData>/themes/<id>.json` (`{ "name": "…", "tokens": { "--token": "value", … } }`). Main seeds the presets as editable files on first list (`themes:list` IPC) and any other `*.json` dropped in the dir appears in the Appearance theme picker; sparse themes backfill missing tokens from the Helm base. Runtime application is owned by `app/src/renderer/appearance.ts`: `documentElement.style.setProperty` per token plus an xterm `options.theme` rebuild from the `--term-*`/`--ansi-*` tokens (`termThemeFromTokens`) — CSS and terminal can never disagree.
- **Presets: "Helm" + "High contrast".** Deliberately NO light preset: the §2.1 ladder is dark-only — the white-alpha hairline/fill system and the terminal palette assume a dark surface, so a genuinely good light theme needs its own ladder and fill system designed from scratch, not inverted tokens. High contrast raises the text ladder to white, doubles the line/fill alphas, deepens the wells to black, and brightens the ANSI 16.
- **Appearance state** (active theme id, per-token overrides from the color wells, terminal font size, UI text scale) persists in `localStorage['helm.appearance']` — same persistence surface as the split width. Settings → Appearance live-applies every change; "Reset to preset" drops the overrides; switching themes starts clean. The accent color well writes the whole accent family (`--accent`, `--accent-fill`, derived `--accent-fill-hover`) so buttons, links, and focus rings stay coherent.
- **Type knobs**: terminal font size **9–24px, default 13**, via ⌘= / ⌘− / ⌘0 — View-menu accelerators forwarded over IPC (the ⌘T pattern; the stock `viewMenu` zoom roles are replaced) — or the Appearance stepper; terminals refit on change. UI text scale is `--ui-scale` per §2.2.

---

## 3. Components

All px values are exact. "Do/Don't" lines are normative.

### 3.1 Buttons

Implementation: `app/src/renderer/button.tsx` owns the React `Btn`, shared class builder, and plain-DOM `createButton` adapter. Non-React renderer surfaces use that adapter—never recreate `.btn` class composition or button chrome locally.

Sizes:

| Size | Height | Padding | Text | Radius |
| --- | --- | --- | --- | --- |
| md (default) | 32 | 0 14 | 13/600 | 8 (`--radius-lg`) |
| sm | 24 | 0 10 | 12/600 | 6 (`--radius-md`) |
| icon | 28×28 (sm 24×24) | 0 | glyph 14–16px | 6 |

Tones:

| Tone | Resting | Hover | Use |
| --- | --- | --- | --- |
| primary | `--accent-fill` bg, `#fff` text | bg `#5a9dff` | THE one primary action of the surface |
| quiet | bg `--fill-raised`, no border, `--text-0` text | bg `--fill-strong` | Secondary actions — a filled gray button, never an outline |
| danger | bg danger-soft, no border, `--danger` text | bg danger soft ×22% (`color-mix(in srgb, var(--danger) 22%, transparent)`) | Destructive (reject, cancel run, delete) |
| ghost | transparent, no border, `--text-2` | bg `--fill-subtle`, text `--text-0` | Icon buttons, overflow "…", back chevron, close × |

Buttons carry **no borders in any tone** — weight comes from the fill. (The retired outline quiet/danger styles are in the appendix.)

- Disabled: `opacity: 0.45; cursor: default` — never a different color set.
- A rounded ghost control inside the list toolbar is not a row-state band: the toolbar's 8px inset plus the control's 8px padding places text on the pane's 16px grid while its hover fill intentionally remains inset (the project trigger pattern).
- Focus: `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible` only.
- Transitions: background/color/border 140ms ease-out.
- **Do** keep exactly one primary button per surface (principle 1). **Don't** place two accent-filled buttons adjacent (a primary beside a quiet gray fill is the intended pair); **don't** make a destructive action primary-filled — danger is always the soft-filled tone, never opaque `--danger`.
- **Extension Inbox actions:** the 332px widget keeps **Start** as its one primary action and exposes the server's approval transition separately as quiet **Queue** (the compact label for “Approve and queue”), alongside quiet **Plan** and danger-soft **Reject**. Queue calls `approve` and leaves ownership undecided in Queue; Start calls `start` and runs immediately. Never remap Queue to Start or hide either choice.

### 3.2 Segmented control

- Outer: height **28**, padding 2, radius `--radius-md`, background `--fill-subtle`, 1px `--hairline` ring. The ring is an **inset box-shadow, not a border**, so the arithmetic is exact: 2px padding + 24px option + 2px padding = 28 (a real border would push the track to 30 or squeeze the options to 22 — verify with DevTools: outer 28, padding 2, option 24).
- Options: height 24, radius `--radius-sm`, text 12/600, `--text-1`; equal-width columns (`grid-template-columns: repeat(n, 1fr)`).
- Active option: background `--fill-raised`, text `--text-0`. Filter/segmented navigation is NEVER accent-filled — accent fill on a segment is allowed only for a true either/or commit choice (e.g. the widget's agent picker), and then it uses `--accent-fill` + white.
- **Workspace picker** (detail "Run with" card, `Segmented` in `DetailPage.tsx`): a two-option either/or (Worktree / Main) that stays **NEUTRAL** (`--fill-raised` active — the base spec, NOT `commit`), even though it's an either/or, because the Agent picker directly above already owns the card's one accent-filled commit and two accent fills on one surface is banned (§1). A trailing quiet **"Default"** reset (`.field-reset`, text `--text-2`) sits on the field-label row and appears ONLY when an override is active (stored on the Item, or freshly picked); it clears the override back to `config.solver.workspace`. Picking **Main** shows a one-line `.run-caption` (`--text-2`): "Runs in the project's checkout — shares your working tree." The extension widget's own Workspace segmented (`.vg-agent` pattern) DOES reuse the accent-filled chip (its dense card follows the agent-picker precedent), with "no chip active" = follow the daemon default.
- Trailing count badges inside options: 11px tabular, `--text-2` (active: `--text-1`), separated by 4px. No pill background — bare number.
- Keyboard: Left/Right arrows move selection; the control is one tab stop (`role="tablist"` semantics).
- **Work-list lifecycle index:** Needs / Active / Queue / Inbox uses the `index` visual variant: no surrounding track or option fills; a **left-aligned flex row of auto-width 44px-high targets** starting on the 16px text grid, **24px gaps**, one bottom `--hairline` spanning the full row. Never a justified full-width grid — edge-pinned first/last labels with centered middles read as uneven padding at 340px. Labels 13/500 `--text-2` with 11px tabular counts (`--text-2`, 6px after the label). An inactive hover/focus raises label text to `--text-0` and its count to `--text-1` without adding a fill. The active option is 13/600 `--text-0` with its count at `--text-1`, marked by a **2px `--accent` underline** (radius 1px, exactly the label+count width, sitting on the bottom hairline) — never accent-colored label text, never an option fill. Because it filters one list rather than switching page panels, its accessibility model is one-tab-stop `radiogroup`/`radio` with `aria-checked`; Left/Right changes and focuses the choice. This is the narrow sidebar's persistent navigation index, not a generic segmented control.
- **Do** cap at 4–5 segments. **Don't** build full-width tab bars with icons; **don't** let labels wrap or ellipsize — shorten the label instead.

### 3.3 List row

The sidebar work-item row; also the template for any dense list.

- Height **64**, square full-width hover/active stripe (`border-radius: 0`) with horizontal padding 16 owned by the row; the scroll container has no horizontal inset, so the state fill reaches both usable pane edges while text remains on the 16px rhythm. **No separators** — the 64px pitch and line spacing carry the rhythm; no card border, no shadow. The work list deliberately uses the platform overlay scrollbar without a reserved gutter per §3.17; a permanently blank right strip would break the full-width state band.
- Line 1: title 13/500 `--text-0`, single-line ellipsis + trailing relative time 11px tabular `--text-2`. A running Item places the shared §3.21 `ActivityIndicator` immediately **before its title**; it is an explicit process signal, not a lifecycle/color dot. Other rows remain flush on the 16px text grid.
- Line 2 (4px below): 11px meta — first, a **status word** (11/500, tone-colored text) ONLY where the tab mixes statuses: "Review" (`--warn`) / "Failed" (`--danger`) in Needs, "Done" (`--success`) / "Cancelled" (`--text-2`) in Archive. Running has no repeated word here; its title-row indicator also suppresses the redundant "Agent" ownership marker. Then the project slug carrying the project's configured color, mixed **55% project / 45% `--text-1`** so it identifies without shouting (`--text-2` when unconfigured; the old 72%/28% mix read as an alarm — see appendix), then ONE of: the mini assessment-verdict chip, a compact Agent/Manual ownership marker, or document icon + server-cached planning/ticket progress. Planning has three truthful labels: **Planning** (session exists, no runnable spec detected), **Plan ready** (spec/PRD exists, no explicit queue), or **X of Y tickets complete** (combined local `issues/*.md` + associated GitHub issues; complete = total − open). Once ticket data exists, that progress marker wins in every lifecycle state—including Review and Archive—so completion does not disappear after execution starts.
- Hover: background `--fill-subtle`. Press (`:active`): `--fill-raised`. **No persistent selected state** — under push navigation the list is never visible beside a detail, so a lingering highlight reads as a stuck hover (a selection idiom belongs to side-by-side master/detail only). Returning from a detail restores scroll position and keyboard focus (via `data-item-id`), not a visual highlight.
- The entire row is the hit target by default. **Queue ownership exception:** undecided Queue rows reserve 64px at the trailing edge for two permanently-visible 28px ghost icon buttons — person = “Work manually”, robot = “Start agent” (or loop). They are sibling controls, never nested inside the row button; each has an accessible label. Permanent visibility avoids the inaccessible hover-action anti-pattern.
- The same colored-slug treatment appears for the selected project in the toolbar filter and for the project slug in Item detail. Project color never introduces a second dot, rail, badge, or other competing status-like shape; the visible slug remains the accessible identity and color remains supplementary.
- **Organization menu:** the toolbar's group icon opens a radio menu with **Flat list** / **Group by project**. The active project-grouping state accents the icon; the preference is local and changes only presentation—project scope filtering and server queries are untouched. Grouped mode inserts flat 30px project headers (colored slug + Item count) above the same balanced rows; it does not create rounded project cards.
- **Do** keep trailing time tabular so columns don't jitter. **Don't** add hover-only row controls; **don't** exceed two lines.

### 3.4 Chips & badges

- Padding **2 8**, radius 999, text 11/500 **sentence case** ("Review", "Needs info", "Clear"), line-height 1.4. Text only — no glyph prefixes inside chips; the tone carries the signal.
- Color: tone text on tone soft fill (`chip-gray/blue/green/amber/red` map to neutral/accent/success/warn/danger — the tone-class naming in `widget.styles.ts:344` is the shared vocabulary).
- Verdict chips (triage assessment) use the mapping in `VERDICT_META` (`app/src/renderer/sidebar/model.ts`) — that file owns verdict→label/tone; do not re-derive it per surface. Labels are sentence case.
- **Do** cap at one chip per list-row meta line. **Don't** make list-row chips interactive (a chip is a state readout, not a button). Item detail deliberately does **not** use a status chip: its editable lifecycle state is a quiet 11/600 text menu with a down chevron and subtle hover fill; run-owned status is the same text without the chevron. **Don't** use chip style for section labels — that's the Label type style.

### 3.5 Status dots

- **A dot means "live", never "lifecycle".** Item list rows no longer use one: active work uses the richer §3.21 ActivityIndicator before its title. The 6px pulsing accent dot survives only beside the explicit detail action-bar words "Agent running". Never show a bare status dot — color-only state is banned (§4).
- The standard 8px status-tone circle remains available for a future surface that genuinely shows mixed statuses side by side, but no current list uses it.
- Background-terminal rows reuse the shared §3.21 `ActivityIndicator`: grayscale while Pi explicitly reports active, accent only for unchecked completion attention. They never infer activity from arbitrary output.
- **There is no topbar connection dot.** The topbar carries no branding or status (§1); daemon reachability is the sidebar's job — the waiting empty state ("Waiting for the daemon" / "Start it with helm start") when unreachable, silence when connected. The retired spec (7px, `--success` + glow; unreachable `--warn` + breathe 2.4s) stays on record here only for a future surface that genuinely needs an ambient connection signal.
- **Don't** reintroduce a per-row lifecycle dot column; **don't** substitute a dot for the list-row ActivityIndicator; **don't** add glow/halo to dots — glow is reserved for an ambient connection signal, and no current surface has one; **don't** use a dot and a chip for the same fact in one row.

### 3.6 Toast

Reference implementation: `app/src/renderer/toast.ts` + `styles.css` "toasts" block.

- **Compact bottom-right notice:** container fixed 12px from the right and bottom edges, width `min(320px, 100vw − 32px)`, column stack, gap 6, newest at bottom, `role="status"` + `aria-live="polite"`. In Helm’s split cockpit this avoids straddling the sidebar divider or covering the active prompt at center. The container ignores pointer events; each notice restores them.
- Notice: full container width, **48px minimum height**, padding **11 12 13**, background `--chrome`, 1px `--hairline`, radius `--radius-lg`, `--shadow-1`. The minimum preserves breathing room around a one-line message plus the 24px shared action; multi-line notices grow naturally.
- Content: message 13/500, 18px line-height, `--text-0`; optional detail 11/400, 14px line-height, `--text-2`, single-line ellipsis 1px below. Optional one action is the shared small ghost `Btn` (`tone="ghost" sm`; plain DOM uses `createButton`) aligned to the first line. `.toast-action` owns positioning only—never redefine its height, padding, border, radius, color, type, or hover chrome.
- Motion: enter 150ms ease-out (opacity 0→1, translateY(8px)→0, double-rAF before adding the shown class); exit 120ms reverse. Removal by timer, not `transitionend` (unreliable in hidden tabs).
- TTL default 4000ms. Optional countdown: one **inset 1px hairline** (`left/right 12`, bottom 5, `--thumb` at 0.7 opacity), `transform: scaleX` draining left→right, `linear` over the TTL. It communicates time without becoming a full-width progress bar.
- Soft-close copy names the terminal in one line: **“<display name> closed” + Undo**. Never suppress generic names such as `zsh`; long names ellipsize before the action.
- **Do** use a toast + Undo for soft-destructive actions (tab close grace). **Don't** stack more than 3 visible toasts — coalesce; **don't** put more than one action in a toast.

### 3.7 Inputs & selects

- Height **28** (textarea min-height 64), padding 0 10, background `--fill-subtle`, 1px `--hairline` border, radius `--radius-md`, text 12 `--text-0`, placeholder `--text-2`.
- Hover: border `--hairline-strong`. Focus: border `--accent`, no outer ring (the border is the ring for fields; buttons/rows use the outline ring).
- Select: `appearance: none` + inline SVG chevron data-URI, stroke `#62666e` (`--text-2`), positioned `right 10px center`, right padding 28. Option list background `--chrome`.
- Field labels: Label type style (12/500 sentence case, `--text-2`), 4px above the field.
- Disabled: `opacity: 0.5; cursor: default`.
- **Color wells** (`<input type="color">`, `.color-input`): well = `--fill-subtle`, 1px `--hairline`, radius 6. Chromium's default swatch bezel (1px gray border, square corners) MUST be stripped via the pseudo-elements: `::-webkit-color-swatch-wrapper { padding: 3px }` + `::-webkit-color-swatch { border: none; border-radius: 3px }` — inner radius = outer radius − padding, so the color chip sits inset on the well with token-only lines.
- **Don't** use browser-default selects or native focus rings; **don't** make inputs taller than 28 to "feel friendly" — density is the register.
- **Shadow-root exception**: inside the extension widget's closed shadow root, a native `<select>` cannot be used at all — macOS Chromium never opens its popup there. The widget's model picker is a custom §3.8-style menu in widget tokens (`.vg-model*` in `extension/src/widget.styles.ts`): trigger mirrors the select spec (chevron, ctl radius, 12px/650), panel = surface bg + hairline + card shadow, 28px rows, selected row accent text + check, max-height 180 clamped to the card and flipping above when the bottom would clip.

### 3.8 Menus (overflow / popover)

- Panel: min-width 180, max-width 280, padding 4, background `--chrome`, 1px `--hairline`, radius `--radius-lg`, `--shadow-1`, z-layer 40.
- Items: height 28, padding 0 8, radius `--radius-sm`, text 13 `--text-0`; hover `--fill-subtle`; destructive items `--danger` text (hover danger-soft fill). Disabled items `--text-2`, no hover. Action/overflow menus use a 14px `currentColor` outline icon in a fixed leading column with an 8px gap; every sibling in an icon-led menu gets an icon. Simple value-selection menus may stay text-only.
- Separator: 1px `--hairline`, margin 4 0. Trailing shortcut hints: 11px mono `--text-2`.
- Motion: open 120ms ease-out, opacity 0→1 + translateY(4px)→0 from the anchor edge; close instant or 120ms.
- Keyboard: Down/Up cycle, Home/End jump, Enter activates, Esc closes and returns focus to the trigger. Click-outside closes.
- **Do** put rare actions (Poll now, Pause, Settings) behind a "…" ghost button. **Don't** nest submenus; **don't** exceed ~8 items — the surface needs a Settings page instead.

### 3.9 Sheets (modal over the pane)

For pane-scoped tasks like New Item.

- Scrim: `rgba(0,0,0,0.4)` covering the pane (not the whole window when the pane is a distinct surface), z-layer 60.
- Sheet: background `--chrome`, radius `--radius-lg`, `--shadow-2`, padding 16, inset 16 from pane edges, max-width 400.
- Header: title 13/600 + ghost close ×. Footer: right-aligned action row — one primary + one quiet, gap 8.
- Motion: enter 150ms ease-out (opacity + translateY(8px)→0); exit 120ms. Scrim fades on the same clock.
- Focus is trapped; initial focus on the first field; Esc closes (equivalent to Cancel); focus returns to the opener.
- **Don't** stack sheets; **don't** use a sheet for content that deserves a push page (anything scrollable/multi-section).

### 3.10 Push navigation

The narrow-pane navigation model (Mail-on-iPhone): list → detail → sub-page as a push stack inside the pane. **No side-by-side master/detail below 480px pane width, ever.** The item detail subtree is exactly two pushed pages — **Task** (§3.19) and **Plan documents** — the genuine long-form reading surfaces. Run evidence (activity timeline, log, solve input) and execution setup are INLINE on the detail page (§3.15/§3.20), never subpages: the single-item fetch already carries all of it, so nesting it was pure click tax (the retired Run details / Run setup pages are in the appendix).

- Header: height 36, background inherits the pane, 1px `--hairline` bottom border, z-layer 10. Contents: 28×28 ghost back-chevron button + page title 13/600 single-line ellipsis; optional one trailing icon button.
- **The header title names the content, never its type, and is the sole visible item-name heading.** An item's detail header shows the item's `displayName ?? title` (single-line ellipsis) at all scroll positions — a literal type word ("Item") never appears as a header title, and the body does NOT repeat the item name. The detail body begins with a compact two-tier identity hero: row one puts the colored project slug (12/600) left and quiet lifecycle status text/menu (§3.4) right; row two carries optional planned-ticket progress + ownership + time at 11px with middle-dot separators. **Do not add a lifecycle headline or explanatory state sentence above this metadata** — the status chip and pinned action bar already communicate state and next action. Lifecycle actions stay in the pinned action bar (§3.11); external workspace access is the full-width quiet button immediately after any alerts and before evidence groups (§3.15), not in the identity hero. When an AI display name differs from the canonical source title, the pushed Task page carries the full source title. Sub-pages of an already-named object (Plan, Task) and pages whose name IS the page (Settings, Archive) keep a static header title.
- Forward: incoming page slides `translateX(100%)`→0 over **150ms ease-out**; outgoing page slides 0→`translateX(-25%)` (parallax) and dims to 0.9 opacity. Back: exact reverse at 120ms. Every `.nav-page` remains its own stacking context (`isolation: isolate`) after motion ends, so a previous page's z-indexed pinned bar can never paint through a content-only subpage.
- Reduced motion: instant swap (the global clamp handles it).
- The list page preserves scroll position and keyboard focus (the last-opened row) across push/pop — no visual selection highlight (§3.3). Deep pages (plan preview, settings section) push onto the same stack; Esc = back.
- **Profiles:** Settings → Profiles is a pushed resource list; opening a profile pushes its editor. Project membership uses 36px square full-width rows with the standard Toggle, separated by `--hairline`. Profile actions are a vertical 8px stack of shared block Buttons: Save is the single primary action; Switch is quiet and disabled while unsaved edits exist; Archive is danger. Archived profiles expose only Restore. The native application menu mirrors active non-archived profiles as a radio group—no persistent topbar selector. The Work toolbar's existing `…` menu is the quick switcher: non-archived profiles appear as checked menu entries, followed by **Manage profiles…**. This is the one justified exception to §3.8's ~8-entry guidance; `.menu-panel` becomes vertically scrollable rather than hiding profiles. Switching keeps the BrowserWindow open: buffer flush → old PTY-client detach → profile session namespace swap → renderer-only reload while the daemon atomically changes its active tenant. Agent runs continue in their owning profile; only a dirty Run Context draft blocks switching. Never restart the daemon or close/relaunch the app for a profile change.
- **Gestures — every pushed page inherits these** (implementation: `app/src/renderer/sidebar/swipe.ts` + the nav-stack wiring in `SidebarRoot.tsx`):
  - **Two-finger swipe-back** (macOS trackpad, pixel-mode wheel `deltaX`): an interactive edge-tracking pop. WheelEvent carries no gesture-phase info in Chromium — fingers-down motion, lift, and the same-sign momentum tail are one undifferentiated stream — so ownership remains threshold- and quiescence-based, never inferred from a fake release phase. **Engagement is a fast axis lock, not a first-event bet or a sticky dead zone**: tracking locks after **8px** accumulated back travel with horizontal dominance `|ΣdeltaX| > 2×|ΣdeltaY|`, a page to pop, and no horizontally-scrollable ancestor that can still scroll left (`scrollLeft > 0` consumes; at 0 navigation owns the edge). The 8px slop is subtracted, so the first visible position is exactly 0 rather than a jump. Vertical, diagonal, forward, consumed, ctrl-zoom, and non-pixel wheel streams are rejected. While owned, input only updates logical progress; visual publication is rAF-coalesced to the newest sample once per display frame and uses `translate3d` on two temporarily promoted layers. The top page follows 1:1 past the lock while the previous page parallaxes −25%→0 under a `--scrim` layer fading 1→0. **The page remains finger-owned for the whole gesture: crossing a threshold never auto-finishes it.** Release is the stream's **140ms quiescence boundary** (Electron exposes no public macOS finger-up phase); only then is the destination chosen from the final position: commit past **50% pane width**, or after a genuine flick that previously reached back-velocity ≥ **1.5 px/ms over the trailing 80ms** with ≥ **30% pane width** real travel. Flick intent is latched before momentum decays its velocity sample, but any deliberate reversal disarms it; crossing halfway and pulling back below it cancels. Momentum samples after finger lift remain part of the same owned stream, so the page continues following them rather than taking off independently. Settlement publishes the exact final logical position on one frame, then installs its target on the next—no wheel callback writes visual styles or forces a settlement layout flush—and uses velocity-aware **90–240ms** Apple-style deceleration (`cubic-bezier(0.16, 1, 0.3, 1)`) or a **140–240ms** distance-scaled return (`cubic-bezier(0.32, 0.72, 0, 1)`). Transition completion owns stack removal, with an idempotent watchdog only for hidden/throttled renderers, and the React pop is flushed before stale transforms are cleared so no snap-back frame can paint. After either settle, a **280ms refractory quiescence gap** is restarted by each back-horizontal tail event; those owned tails are cancelled while unrelated vertical input remains available. This guarantees one physical swipe can pop at most one page. Reduced motion keeps the same release/ownership/threshold/cooldown rules but creates no gesture visuals or settle frames.
  - **Native three-finger swipe**: `BrowserWindow` `'swipe'` event → back/forward over the same channel as the Go menu. Back runs the wheel controller's **single-owner check** (`interceptNativeNav`) first — with the "two or three fingers" system setting, one physical gesture can arrive both as wheel deltas and as a native `'swipe'` event: if the wheel path already owns it (engaged tracking, settle animation, or refractory) the native event is swallowed; otherwise the native pop proceeds and arms the refractory gap so the same gesture's wheel deltas can't double-pop.
  - **Keyboard**: ⌘[ back, ⌘] forward — Go-menu accelerators, not renderer listeners (§4: xterm swallows renderer keys). **Mouse back/forward buttons** (`event.button` 3/4, plus `app-command` mice) → back/forward.
  - **Forward** re-pushes the most recently popped route; any new push clears the forward memory.
- **Do** keep every pushed page self-sufficient (own header, own back). **Don't** animate anything except the two page transforms (the swipe scrim's opacity is part of the pop transform pair); **don't** push more than 3 levels — flatten the IA instead.

### 3.11 Action bar (pinned bottom)

Detail pages pin their actions; content scrolls, actions don't.

- Height 56 (content 32 + 12px vertical padding), padding 12 16, background `--pane` (opaque), 1px `--hairline` top border, z-layer 10.
- One **primary** button (the contextual main action) + a quiet or ghost "…" overflow for the rest. The button explains its effect through a concise verb phrase plus a 14px outline icon: check + **Set as done** for a status-only review handoff, tray arrow + **Approve and queue**, play + **Start agent** (or **Start loop**), circular arrow + **Queue retry** (or **Queue loop retry**). **Ownership-choice exception:** an undecided Queue Item shows quiet person + **Work manually** beside primary robot + **Start agent**; a human-owned unplanned Active Item shows quiet tray + **Return to Queue** beside primary check + **Set as done**; a planned Active solve Item shows quiet robot + **Start agent** beside primary circular arrow + **Start loop**, both honoring its selected execution workspace. These are the bar's maximum two visible buttons; overflow may remain as the one ghost control. Do not add an instructional caption above the bar; controls must be self-explanatory. Review's Set as done returns to the work list and moves the Item to Archive; Retry moves into overflow. Danger actions live in the overflow unless the page's whole point is destructive.
- **Inbox completion:** Approve and queue remains the one primary action; check + **Set as done** lives in overflow for work already completed elsewhere. It uses the guarded manual status route and returns to the work list.
- **Start loop semantics:** on a planned solve Item, this is the autonomous full-queue action—not “run one ticket.” It runs every currently agent-ready local/GitHub ticket in AFK mode, skips human-ready tickets, and uses the effective Agent + Model + Effort + Workspace from Execution setup (Item override, otherwise daemon/agent default). Main is valid only when the plan was prepared in the canonical checkout; switching a worktree-prepared plan to Main requires re-planning there.
- **Shared execution controls:** Execution setup (the inline §3.20 disclosure on detail) configures both **Start agent** and **Start loop**. Agent + Model select the CLI/model for either mode. Effort is passed to Claude as `--effort`, to Codex as `model_reasoning_effort`, and to Almanac as `--effort`; choices are Default, Low, Medium, High, Extra high, plus Max for Claude (switching Max to Codex clears it). Workspace selects Worktree or Main for either mode; a Main loop requires its plan to have been prepared in Main, and Helm never copies a worktree plan into the canonical checkout.
- **Don't** put more than two visible buttons in the bar; **don't** let the bar scroll away.

### 3.12 Banners (error / notice)

- Padding 10 12, radius `--radius-md`, text 12 line-height 1.5, `word-break: break-word`.
- Error: `--danger` text on danger-soft fill. Warning: `--warn` on warn-soft. Info: `--text-1` on `--fill-subtle`.
- Optional ghost dismiss × (16px glyph, opacity 0.6→1 on hover), top-aligned.
- Long banner content (root-cause paragraphs): clamp to 4 lines (`-webkit-line-clamp: 4`), expand on click—the Banner itself is the toggle. It gets a quiet **"More"/"Less" cue** in the Label type style (12/500 sentence case, `--text-2`, hover `--text-1`), 4px below the text, shown only when content actually overflows. Generic non-banner prose uses the separate `ClampText` primitive/story; do not mix those specimens into Banners.
- **Actionable notice:** the SAME `Banner` component/tone/padding/radius/label/body grammar plus one top-aligned trailing quiet `sm` action (`action` slot), using `--fill-raised` so it remains visibly button-like inside the tone fill. It renders as an `<output>`—implicit `role="status"`—so it never nests a button inside the clamp-toggle button. Use for a persistent state with exactly one way out, e.g. Settings' **Restart required** info banner + **Restart**. It may sit stacked above the action-bar primary (`.action-bar-stack`: auto height, column). One action max—two ways out is a sheet or page, not a banner. Never create a special no-fill actionable style; actionable and passive banners must read as one family.
- **Don't** use a banner for success — success is a status change (dot/chip), not an interruption.

### 3.13 Empty & waiting states

Quiet and directive: say what the state is, then what to do.

- Centered card (bare, or on `--chrome` with `--hairline` border + radius `--radius-lg` + padding 22 26 when floating over a well).
- Title 13/600 `--text-1`; detail 12 `--text-2`, 6px below. Keyboard hints as `<kbd>`: 11px mono, padding 1 5, 1px `rgba(255,255,255,0.09)` border, radius `--radius-sm`, background `--fill-subtle`.
- Copy pattern: state, then direction — "No terminals open" / "Press ⌘T to start one"; "Waiting for the daemon" / "Start it with helm start".
- **Don't** use illustrations, emoji, or exclamation marks; **don't** leave an empty state without a next step.

### 3.14 Terminal well

- Background `--well`; text inset via `.term-holder` padding — **left 16, right 0, top/bottom FLEX 6–14** (nominal 14). The vertical inset flexes so the grid packs the MAXIMUM rows that fit: with a fixed 14px pair, the integer-row remainder stacked on the bottom inset left up to ~31px blank below the last line — more than a whole row, which read as "one line is missing". `fitTab` (renderer.ts) computes rows against the 6px minimum, then splits the leftover into top/bottom insets capped at 14 (excess beyond 28 stays at the bottom, exactly like the old remainder; CSS `padding: 14px 0 14px 16px` is only the pre-fit default). The right padding MUST stay 0: the overlay scrollbar (below) is positioned against the holder's edge, so any right padding pushes it off the pane edge into the well (Terminal.app never does that). Right-side breathing room comes from FitAddon's integer-column remainder plus its fixed scrollbar reserve (below). The topbar/tab strip alignment mirrors the well's 16px **left** text inset.
- **Fit-measurement invariants** (each shipped as a clipped-right-columns bug; keep all three):
  - xterm mounts into the UNPADDED `.term-mount` inside the padded `.term-holder`. FitAddon measures the computed width of xterm's parent element, which under border-box INCLUDES that element's own padding — so well padding must live on an ancestor of the mount, never on the element xterm is opened in.
  - `.term-mount` forces `letter-spacing: normal`: the body's `-0.01em` otherwise leaks into xterm's DOM-renderer width cache (span-based, inherits CSS) but not its cell metric (canvas measureText), and xterm "compensates" with ~+0.13px/char span letter-spacing — cumulative drift that clips the last ~2 columns at the `.xterm-screen` edge.
  - `.term-holder` is `overflow: hidden` so a transient fit desync (mid-drag, mid-reattach) clips at the pane edge instead of painting across the window.
- **Terminal scrollbar: helm's own overlay** (`.term-scrollbar` in `renderer.ts`/`styles.css`), macOS-standard. xterm 6 scrolls through a monaco `SmoothScrollableElement` — NOT a native-scrolling `.xterm-viewport`, so `::-webkit-scrollbar` styling never reaches it — whose track is inline-sized to `rows*cellHeight` from the screen's top (inside the padded holder it can never reach the pane edges) with a square slider; helm hides it (`display:none` on `.xterm-scrollable-element > .scrollbar`; wheel input is unaffected — the widget listens on the screen element) and renders its own. Spec: track spans the **full pane height** (absolute `top/right/bottom: 0` in the holder — its padding box, so the 14px text inset never shortens it), **12px wide hit area**; thumb a **7px pill** (`border-radius: 999px`), **2px in** from the pane edge, **widening to 9px on hover/drag** (Apple's overlay expands under the pointer), `--term-scroll-thumb` `rgba(255,255,255,0.22)` (hover/drag `--term-scroll-thumb-hover` `0.35`; high-contrast preset 0.35/0.5), **no track fill, no buttons, no corner**. Pure overlay: it floats inside FitAddon's FIXED 14px scrollbar reserve, so it reserves no layout space and columns are identical with or without scrollback. Geometry synced rAF-coalesced from buffer state (`onScroll`/`onResize`/`onWriteParsed`); hidden on the alt screen and when nothing has scrolled out (`baseY === 0`); min thumb 24px; drag scrubs, track click jumps to the spot. `.xterm-viewport` (still created by xterm 6, empty) keeps its background forced transparent — xterm.css hardcodes `#000` there — AND `overflow: hidden`: xterm.css leaves it `overflow-y: scroll`, and the unstyled native webkit track/corner otherwise renders as a gray sliver at the pane's bottom-right. No idle fade — a JS fader isn't worth it.
- **Restored sessions repaint quietly.** A reattached tab shows its previous screen immediately (buffer snapshot written before the live stream attaches — see AGENTS.md, buffer snapshots) and the shell's natural WINCH prompt redraw is the only seam: **no marker line, no "restored" banner, no flash**. dtach's attach-time clear is filtered out precisely so nothing visibly wipes.
- **Long synchronized redraws stay atomic.** TUI programs wrap whole-history refreshes in DEC synchronized output (`CSI ?2026 h/l`), but xterm releases its own render lock after one second. A long Pi history can exceed that safety timeout and otherwise expose the clear plus partial replay as shrinking/expanding history. Helm keeps a non-interactive clone of the last complete `.xterm-screen` above the live renderer until the closing marker's write callback confirms the replacement frame parsed; custom-scrollbar updates and buffer snapshots wait too. Ordinary output is never frozen. Split PTY markers and overlapping frames are handled by `synchronized-output.ts`; abort/close always removes the clone.
- **Agent-running tabs:** Pi's explicit OSC 9;4 protocol owns this state (`3` active, `0` clear; active repeats every second). A running tab places the shared §3.21 `ActivityIndicator` **before the title**, with 2px extra right separation beyond the tab's normal gap. There is no visible status word; the tab and polite status node still expose **Running** to assistive technology. Repeated keepalives are idempotent. Park/restore preserves the state because the process remains attached; close or PTY exit clears it. Never infer running/completion from ordinary output, silence, process names, shell prompts, or tab titles.
- Tab labels: shell OSC titles matching `user@host[:path]` normalize to the trailing path segment ("helm"); a bare `user@host` falls back to "zsh" (the "shell default" title class); other titles pass through. The raw title survives as the label's tooltip. Normalization + arbitration live in `app/src/renderer/tab-title.ts` (pure, node-tested) — renderer code never re-derives them.
- **Tab rename (pin)**: double-click a tab (or context-menu "Rename…") opens an inline rename field replacing the label — a §3.7 field compacted into the 28px tab: width 120, height 20, padding 0 6, radius `--radius-sm`, background `--fill-subtle`, **1px `--accent` border** (the field's focus signal — no outer ring), text 12 `--text-0`; value preselected on open. Enter/blur commit, Esc cancels; a commit equal to the current name is a no-op (a stray double-click must not silently pin). A committed name **pins** the tab: stored as registry `customName` (separate from `lastTitle`), never overwritten by OSC titles, survives relaunch and park/restore; the background-popover row shows it too. While pinned, the tooltip carries the live OSC title so the underlying shell/program stays one hover away. An **empty commit unpins** — OSC title following resumes from the last live title.
- **Restored-title stickiness**: for `TITLE_STICKY_WINDOW_MS` (~3s) after a dtach reattach, an incoming shell-default-class title does NOT overwrite the restored label (attach chatter must not stamp "zsh" over a saved name — and it would clobber the registry too, compounding across relaunches). A real (non-default) title applies immediately, even inside the window, and settles the tab — from then on every title applies, so live title following is intact; after the window, default titles apply too (a prompt the user summoned is the live truth). Fresh tabs never suppress. Suppressed titles are not persisted.
- xterm theme = the `--term-*` / `--ansi-*` tokens (§2.8), rebuilt into an xterm theme object by `appearance.ts` (`termThemeFromTokens`) — `HELM_TOKENS` in `app/src/theme-presets.ts` is the canonical ANSI-16 for any future terminal surface. Defaults: cursor `--accent`, selection `rgba(76,154,255,0.25)`.
- **Don't** restyle ANSI colors per surface; **don't** put chrome-level controls inside the well.

### 3.15 Flat groups & info rows (sidebar detail/settings)

The in-flow content group and its fact/navigation rows (`app/src/renderer/sidebar/ui.tsx`). **There are no bordered cards in flow** (principle 2; the retired boxed `.card` chrome is in the appendix) — every detail and settings surface is one flat editorial stack.

- Group: begins with one full-width `--hairline` rule, 20px top inset, **0 horizontal inset** (the page's 16px gutter is the text grid — §2.3); a Section-header line (12/600 sentence case, `--text-1`) with optionally ONE small control or chip trailing right; rows follow. The first group on a page omits the leading rule (the hero/page header provides the edge). No box, no fill, no radius, no shadow.
- The unframed identity hero stays compact on Item detail; do not reintroduce a lifecycle headline, grouped boxes, or repeated low-priority context facts on the base page.
- Info row (static fact): min-height 20, 12px value `--text-0` right-aligned single-line ellipsis; label is the Label type style (12/500 sentence case, `--text-2`). Mono values (branch, refs) use Mono inline 11.
- **Row rhythm in a flush group** (the Details stack, settings lists — `.card-flush`, gap 0, rows at exact pitch): fact rows AND copy/external action rows share **one 28px pitch** (`.card-flush .info-row` min-height 28, center-aligned; `.action-row` min-height 28); only rows that navigate — push rows (chevron ›, `.action-row-push`) and nav rows — sit at the **36px pitch**. Two pitches, one meaning: 28 = read/act in place, 36 = go somewhere. Consecutive 36px nav rows are divided by a **soft inset separator** (1px, `--hairline` mixed 60% toward transparent, inset to the text edge); 28px fact rows carry no separators.
- Tappable row (`.action-row`): min-height 28 (push rows 36, above); hover is a square, full-pane-width `--fill-subtle` stripe (`margin: 0 -16px`, matching 16px internal padding) so the row state reaches both pane edges while text stays on the 16px grid. Its row-heavy `.page-scroll` owner uses platform overlay scrolling—never a reserved/custom 10px right lane—so “full pane width” remains physically true. The fill itself is inset **4px vertically** inside the row: a separator sits at the row boundary with 4px of clear pane above/below the state fill instead of colliding with it. Actual controls remain rounded (§2.4); never round a row-state band. The soft nav-row separator also insets 16px to land on the text edge. Trailing glyph declares the behavior — chevron ›= pushes a sub-page, ↗ = opens externally, copy glyph = copies to clipboard (confirm with a toast). ONLY external-link values are `--accent`; push/copy values stay `--text-0` so the pane doesn't read as a link farm.
- **Item workspace action is immediately accessible below the identity hero and any alerts, before Activity/Log can push it below the fold.** It is one full-width 32px quiet button with an external glyph and dynamic copy carrying the full effect (`Focus in Okena`, `Register worktree in Okena`, `Create Okena workspace from local branch`, `Fetch branch and create Okena workspace`, `Create branch and Okena workspace`, or `Focus main checkout in Okena`). There is no generic "Open in Okena" label and no explanatory caption—the button itself says what it will do. It is lifecycle-neutral and available in every status. Preview inspection may query Okena and git only on the single-Item detail route; list routes stay DB-only, and the POST recomputes the action for race safety. Success resolves the terminal from Okena's live pane layout, focuses the project, and best-effort raises its window. Focus is strictly control-plane only: Helm sends no terminal input—not BEL, a command, or `ctrl_c`—because the foreground process can interpret any byte. Toast **Focused in Okena** with the daemon's truthful focus hint; a newly-opened workspace whose terminal is still becoming ready is still success, not a false retryable error. Actual workspace-open failures stay in Helm's retryable command error.
- Nav row (`.action-row-nav` — settings section lists and Item-detail resource links): a tappable row whose **title is the content, not a label** — min-height **36** (36px pitch), title 13/400 `--text-0` sentence case, value 12 `--text-1` right-aligned single-line ellipsis, chevron `--text-2`. On Item detail, **Task**, **Run context**, and **Plan documents** are peer reading destinations rendered through the same `ResourceLink` primitive inside ONE unlabeled `.card-flush` group: one outer rule + 20px inset, then compact consecutive 36px rows with soft internal separators. Never wrap each resource in its own group—that multiplies whitespace and hairlines. These resource links consistently follow Activity, the execution log, and Solve input in every lifecycle state; they never jump above run evidence or sit under ticket/status facts. Every nav row shows a current-state value with units and real state ("60s", "2 of 3 on", "default") — a blank cell next to a chevron reads as broken, a unit-less number gives no direction, and independent toggles never collapse into one fake on/off.
- **Run evidence and execution setup are inline groups on Item detail** (the retired Work hub and its pushed pages are in the appendix), ordered per lifecycle state by `detail-state.ts` — decision content first. Activity is result/history only: its Section-header line carries the quiet §3.20 **Show / Hide** action; at rest it has no body, while expansion reveals the solver result summary (when present) followed by newest-first lifecycle events. It renders nothing when neither exists. **Never expose Started, normalized State, Almanac Loop status, Round, or raw Almanac summary here** — Started duplicates the identity time, State/Loop duplicate lifecycle, and Round/raw summary are orchestration internals rather than ticket progress. The execution log is named by its producer—**Loop log** for Almanac execution, **Agent log** for normal solver execution. It is append-only output normalized to newest-first and always fully rendered in the bounded, scrollable `.log-well`; it has no disclosure or preview state. Solve input uses a §3.20 expandable group with **Show / Hide** in its header. Execution setup keeps only a one-line effective-selection summary readable at rest (12/500 `--text-0`, "Claude Code · model · effort · Worktree"); its shared small quiet button says **Change / Done**, and only the four pickers are conditional. Planned items with tickets put `X of Y complete` directly in the top identity metadata row (11/600 `--text-1`, no chip), after the project slug. **There is no in-flow Plan section.** Status is redundant with ticket progress, Spec is represented by Plan documents, and Plan documents belongs beside Task as an equal resource link.
- **Don't** mix behaviors on one row; **don't** accent-color a value that doesn't leave the app; **don't** use a placeholder verb ("view", "open") or a bare destination name as a value — the value carries the fact (destination + short id: "Contember #4821", "GitHub #132" parsed from the PR url — "GitHub" alone never appears); one object gets one row — fold source + task views into a single push row and demote the external ↗ to the pushed page's header.

### 3.16 Toggle switch

- Track 32×18, radius 999, 1px `--hairline` border, background `--fill-subtle`; on: `--accent-fill`, no border. Knob 12px, `--text-0` (on: `#fff`), travels 14px at 140ms ease-out.
- `role="switch"` + `aria-checked`; label sits left of the control in a row (12px `--text-0`).
- **Don't** use a toggle for anything but an immediate boolean — choices go to a select or segmented control.

### 3.17 Pane scrollbars

- `color-scheme: dark` on `:root` so native form controls and fallback scrollbars render dark.
- Custom webkit scrollbar inside stable panes: 10px gutter, transparent track, thumb `rgba(255,255,255,0.14)` inset 3px via `background-clip: content-box` (hover `0.24`), radius 999. Persistent reading and editing surfaces use `scrollbar-gutter: stable` so crossing the overflow threshold never narrows content or slides text/controls. This covers sheets, evidence/plan wells, and both Run Context panes; the Run Context window owns the same pseudo-element styling explicitly because it is outside `.sidebar`. Row-heavy sidebar page/list scrollers are explicit exceptions: their square hover/active bands must reach both pane edges, so they use the platform overlay scrollbar without a permanently blank right gutter. The terminal uses helm's own overlay scrollbar per §3.14 (full-pane track, 7px pill, the brighter `--term-scroll-thumb` pair) and therefore does NOT reserve a native gutter. The transient background-terminal popover likewise uses the platform overlay scrollbar without a reserved gutter: reserving 10px in a 320px action panel visibly unbalances its right controls.
- **Don't** apply one broad `.sidebar ::-webkit-scrollbar` width: it silently reintroduces a right lane on overlay page/list scrollers. Scope custom scrollbar chrome to stable reading/editing surfaces. **Don't** add `overflow: auto` without reserving a stable gutter unless the surface owns/uses an overlay scrollbar or is one of the explicit full-width page/list/§3.18 exceptions above.

### 3.18 Background terminals (tab strip)

iTerm2's "bury session", helm-style: a tab leaves the strip while its Terminal instance stays mounted in the hidden holder and its pty stays attached — scrollback keeps accumulating headlessly. Memory cost equals an inactive strip tab (those are already hidden, live xterm instances), so parking buys strip space, not memory. Implementation: `app/src/renderer/renderer.ts` (park/restore/popover) + `app/src/sessions.ts` (persisted `parked` flag).

- **Move to background**: right-click a tab → context menu (§3.8 panel at the pointer, viewport-clamped; items "Move to background" ⇧⌘B, "Close" ⌘W with §3.8 trailing shortcut hints). ⌘⇧B parks the active tab — an Electron Shell-menu accelerator per §4 (xterm swallows renderer keys).
- **Drag**: custom pointer drag, never native HTML DnD (Chromium's ghost/cursor cannot match the app). After 5px intent, the tab lifts into a fixed clone at 1.02× with `--fill-raised`, strong hairline, and `--shadow-1`; its in-strip original becomes an invisible placeholder. Reordering is LIVE as pointer crosses every tab midpoint: placeholder moves, neighbors FLIP-settle over 160ms (`cubic-bezier(0.2, 0.8, 0.2, 1)`), no insertion rails. A 6px leading gutter makes slot 0 reachable. Holding either 28px strip edge auto-scrolls by 12px/frame while more tabs exist there. Pointer-up in strip settles clone home over 180ms; invalid drop/Esc restores original order and settles home. Reduced motion skips settles. Background is a magnetic layers well: appears during drag even at count 0, **keeps its count badge visible so the control never changes width or shifts**, scales 0.94 at rest → 1.06 inside an 8px expanded hit area, then absorbs clone at 0.72×/0 opacity over 140ms through the existing `parkTab` path. Close and inline-rename controls never start a drag.
- **Window dragging:** tabs, +, the background control, and the 4px gaps inside their `.tab-strip-controls` wrapper are `no-drag`; the visible whitespace to their right is an explicit flexible `.topbar-drag-space` and remains native draggable titlebar. Do not mark the whole right header `no-drag` (the window becomes immovable from its largest empty chrome area), and do not make internal control gaps draggable (double-clicking one can trigger native window zoom).
- **Strip control**: ghost button pinned at the strip's right edge (28px height, radius `--radius-md`), visible ONLY when the background count > 0 — the empty state is the hidden button, never an empty popover. Content: stack/layers glyph 14px `--text-2` + count badge in the §3.4 chip spec (neutral tone soft fill, 10/700 tabular). Hover and open: `--fill-subtle` fill, `--text-0` glyph.
- **Popover — editorial terminal list**: §3.8 panel (background `--chrome`, `--hairline`, radius `--radius-lg`, `--shadow-1`, z 40), fixed width 320 (viewport-clamped) and max-height `min(480px, 100vh - 48px)`, anchored `menu-end` under the button with a 5px offset so its border does not fuse to the header hairline; the generic menu padding is removed so row state stripes reach both panel edges, while the header and row content own their own insets. Rows scroll under the platform overlay scrollbar with NO reserved gutter while the header stays fixed, keeping left/right action spacing balanced. Its 12/600 header contains only “Background terminals”; the strip-control badge is the single count source, so the open panel never repeats it. One row per background terminal, park order.
  - Row: minimum 44px, three-column grid, 4px inter-row gap. The large **Open** target is one compact title line for a live idle terminal—no generic "Running" copy and no empty indicator gutter. When exact OSC 9;4 state says the agent is active or needs attention, the shared §3.21 indicator appears immediately before the 13/500 `--text-0` title; arbitrary terminal output and mere PTY liveness never animate it. Only an exited terminal adds a second 11px `--text-2` tabular line, "Exited (code)", and mutes the title to `--text-1`. The Open target's accessible name includes exited and OSC agent state only when present. Hover and the currently-open parked row use the same square, panel-edge-to-edge `--fill-subtle` stripe as sidebar rows (§2.3); only the ⇥/× controls are rounded.
  - Three explicit operations remain: clicking the title target **opens and focuses the terminal while it remains parked** (no tab button, count and persisted `parked` flag unchanged); quiet icon-only **⇥** (28px, tooltip/accessible name "Move to tabs and open") moves it to the strip end and opens it; quiet **×** closes through the grace path. Both secondary controls use the shared `IconBtn` primitive (`createIconButton` is its plain-DOM adapter for this non-React renderer), never ad-hoc button chrome. Undo after close returns it to the background list, not to a tab.
  - Dismiss: Open/⇥ close the popover; outside click or Esc closes it and returns focus to the stack button. Electron's native `.topbar-drag-space` normally swallows DOM pointer events, so while this popover alone is open it becomes a temporary `no-drag` click-away target; closing immediately restores native window dragging. ↑/↓ move between Open targets; Tab reaches each row's ⇥ and × controls normally. Closing the final row moves focus to New terminal before the hidden stack control disappears.
- **Exited in background**: a pty ending while parked keeps its row with state "Exited (code)" — no toast. Restoring shows the dead terminal's buffer; ✕ removes the row.
- **Persistence**: the session registry (`sessions.json`) carries per-session `parked` + additive numeric `order` metadata. Writes are temp+rename atomic — an interrupted truncate once left a 0-byte registry. On relaunch, every definitively-live dtach socket is re-adopted before metadata lookup, so missing/corrupt registry state self-heals and rename/order writers no longer ignore the surviving session as unknown. Parked sessions reattach headless into the popover; non-parked sessions restore as strip tabs; both lists retain drag order. Legacy entries without `order` fall back to `createdAt`. Registry titles are reused for row labels; a pinned `customName` (§3.14 tab rename) wins over the OSC title on the row.
- **Copy**: menu item "Move to background", header "Background terminals", exited state "Exited (n)", ⇥ tooltip/accessible name "Move to tabs and open" — sentence case per §5. A live terminal has no generic state word; OSC activity is the indicator.
- **Don't** show the strip button at count 0; **don't** toast background exits; **don't** treat Open as restore—temporary viewing must preserve background ownership.

### 3.19 Task detail

The pushed Task page is a reading surface, not another dashboard. It follows the Item detail's flat editorial language while preserving the source's canonical content.

- Static push title "Task" (or "Imported task") + optional external-source icon; the body begins with a compact source overline (Section-header style — 12/600 sentence case, `--text-1`, e.g. "Contember") and the canonical task title in the Page/hero style (17/600).
- Description, attachments, and comments are full-width sections separated only by `--hairline`, with 20px vertical insets and no extra horizontal inset (the page's 16px gutter is the grid). No cards, fills, or repeated metadata block above the description.
- Rich description images render inline in source order, contained by one hairline/radius frame because the media itself needs an edge; clicking opens the source image. Non-inline attachments remain 36px text rows.
- Comments use quiet author/time metadata and hairline separators between comments — never quote bars or chat bubbles.
- Provider metadata is secondary and potentially noisy: keep it collapsed in a final "Metadata" disclosure. Its rows may use the standard fact-row pattern only after expansion.
- **Don't** put metadata before the description; **don't** dump images into an attachment-name list; **don't** add a second visible container around any section.

### 3.20 Expandable group (disclosure)

The behavior is the WAI-ARIA disclosure pattern; the visible object is an **expandable flat group**, not a detached “collapsible” control (`Disclosure` in `app/src/renderer/sidebar/ui.tsx`). It keeps heavy evidence in place without a subpage and owns the same Section-header + hairline grammar as every §3.15 group. Activity and Solve input have no collapsed body. Execution setup keeps its useful summary visible and conditionally mounts only the pickers. Log is not expandable: it is always fully present inside its bounded scroll well.

- Shape: the Section-header owns one trailing shared **small quiet `Btn`** (`tone="quiet"`, `sm`)—Disclosure does not invent a parallel button style. The heading supplies context, so copy stays short: **Show / Hide** for evidence and **Change / Done** for editable setup. No `+ / −`, chevron, or separate toggle row.
- It is a section-level action, NOT a 28px fact/action row or 36px nav row. §3.15's two-pitch law stays intact because the shared button occupies the existing header slot rather than adding another row. Execution setup's resting summary is one 12/500 `--text-0` line (`Agent · Model · Effort · Workspace` when values exist); do not add a second explanatory caption beneath it.
- The button carries `aria-expanded` + `aria-controls`; the group is labelled by its Section-header. The controlled region shell keeps its stable `id` mounted (hidden while closed) so the IDREF always resolves. Content **snaps** open and closed — never animate height (§2.5). Reduced motion is automatically satisfied.
- `Disclosure` children render only while open; its optional `summary` remains mounted at rest. The hidden region shell is layout-neutral and empty, so heavy evidence still unmounts completely. The always-expanded Log bypasses `Disclosure` entirely.
- `defaultOpen` is a mount-time-only option for exceptional stories/callers; status changes must never re-apply it and override the user's current choice.
- Long text inside an expandable group or the always-expanded Log lives in a `--well` scroll box (`.log-well` 240px, `.plan-well` 320px) with text selection enabled (§4) and keyboard focus (`tabIndex` 0).
- **Don't** use an expandable group where the content is short enough to just show (a fact row costs less than a toggle); **don't** nest them; **don't** use one to hide a page's primary decision content — it is for evidence or secondary controls, not the decision.

### 3.21 Activity indicator

The shared loading/in-progress primitive (`ActivityIndicator` + `createActivityIndicator` in `app/src/renderer/activity-indicator.tsx`; story: `ActivityIndicator.stories.tsx`). React and plain-DOM surfaces use the same class contract rather than redrawing their own spinner.

- Shape: a compact six-dot Braille matrix, **2 columns × 3 rows**, each dot 2px with a 2px gap. It contributes no visible words by itself.
- Color encodes urgency, not mere motion: ordinary progress is entirely grayscale (`--text-0` with opacity forming the head/tail); **only needs-attention may use `--accent`**. Neither variant uses glow.
- **Progress variant:** motion is clockwise: top-left → top-right → middle-right → bottom-right → bottom-left → middle-left. One dot advances about every 167ms, one 1s cycle; opacity fades from the bright neutral head into the quiet grayscale tail.
- **Attention variant:** completion becomes a slower 1.8s **diagonal** color-wave, distinct from progress: top-left leads, top-right + middle-left share the next phase, middle-right + bottom-left the next, and bottom-right closes the gradient. Every dot remains legible while color interpolates from `--text-2` gray at 55% opacity to full `--accent`, then recedes. Terminal tabs retain it only for an OSC 9;4 active→clear transition that happened outside the selected, focused tab; opening that tab (or focusing Helm while it is selected) acknowledges and removes it. A new active marker replaces it. The global reduced-motion clamp applies to both variants.
- Accessibility: the semantic `<output>` status uses `aria-live="polite"` and a caller-supplied state label (`Running`, `Run finished — open tab to clear`, `Loading Items`, etc.). Surfaces may render adjacent visible copy when the words matter; icon-only compact placements must still pass the label.
- Optional visible copy uses `.activity-indicator-label`: only the text breathes gently from 100% to 76% opacity over 1.8s; the dots retain their independent clockwise motion. Reduced-motion mode clamps the breath with every other animation.
- Placement is owned by the caller. Terminal tabs put it before the title with 2px extra right margin; running Item rows put it before the title at the row's normal 8px gap; loading rows/buttons may choose their normal component gap. Never bake surface padding into the primitive.
- **Don't** use the indicator for idle decoration, static status, or inferred activity. It means a process explicitly reported in-progress state.

### 3.22 Run context editor

A dedicated external Helm window for controlling the narrative planning and execution receive (`RunContextEditor`, story: `RunContextEditor.stories.tsx`). It is a full BlockNote block editor, not a textarea, sidebar sheet, or modal over the terminal.

- **Source safety:** the provider/captured task is never mutated. Title, Item/project metadata, source URL, and attachment references remain server-owned. The fixed right rail shows only the protected task title and **Source attachments** filenames; it renders no metadata rows at all, deliberately hiding status, priority, Item id, kind, BaseRef, source/external id, source URL, project, and every other metadata field. Those fields still reach the agent through server-owned context—they are merely absent from this editor UI. The editable document replaces only description/description blocks/comments in future plan and solve context. Deleting a source-derived block means “exclude from the run,” not “delete at source.”
- **Capabilities:** rich inline formatting, headings, paragraphs, lists, checklists, quotes, code, tables, links and media/reference blocks supported by the local BlockNote core, drag reorder, nesting, slash commands, undo/redo, and lossless JSON restoration. No cloud, AI, collaboration, or commercial export package.
- **Window:** standalone 980×760 default, minimum 720×520; hidden-inset titlebar and draggable 58px header. One window per Item—repeat Open focuses it. The restricted preload exposes only load/save/reset/dirty/close operations; it has no PTY, session, config-write, or generic daemon surface.
- **Layout:** title + project identity on the left, quiet save state, then Reset and the one primary **Save context** action. A plain explanatory strip precedes the editor. The document gets the flexible canvas; the 236px `--chrome` rail lists protected context. Below 820px the rail hides so the editor stays usable.
- **Persistence:** explicit save (⌘S supported), optimistic revision token, no hidden autosave. Conflict keeps the local draft and offers **Reload latest**. Reset fetches the latest provider/captured/manual source first and replaces the document only after confirmation; provider failure leaves the saved document intact. A saved document remains loadable during a provider outage (with a minimal title-only source shell); only an unsaved first load and Reset require live source. The document survives retries and stale-run recovery.
- **Running lock:** an active run is immutable evidence. The editor may open read-only while the Item is `running`, but Save and Reset are disabled; edit after completion for a retry. A clean editor refreshes its narrow resource when the auxiliary window regains focus so the lock follows lifecycle transitions without polling; dirty content is never replaced by that refresh.
- **Close guard:** dirty window close offers **Keep editing / Discard / Save and close**. ⌘W targets the focused auxiliary window and follows the same guard; it must never close an unrelated terminal.
- **Accessibility:** editor and toolbar retain BlockNote keyboard behavior; Save/Reset/loading/error/conflict states are named, focusable, and announced. Dialogs are modal with visible headings and ordered actions. Source facts remain selectable text. Reduced-motion rules apply to all activity feedback.
- **Don't** put this document into list payloads or Item events; **don't** rebuild it from mutable source on every retry; **don't** let a rich-editor JSON format leak into prompt assembly—the daemon consumes the saved Markdown projection through the Item context seam.

---

## 4. Interaction rules

- **Focus**: rings on `:focus-visible` only (never on mouse click). Ring = `2px solid var(--accent)`, offset 2. Text fields signal focus via accent border instead (§3.7). Every interactive element MUST have a visible focus state.
- **Hover**: hover changes fills/borders only — it never reveals functionality that keyboard/touch users can't reach (principle 5). Hover transitions 140ms ease-out.
- **Keyboard**: everything reachable by Tab in visual order; lists navigable with Up/Down + Enter to open; Esc = back (push stack) or close (menu/sheet/toast-action context); segmented controls are one tab stop with arrow keys. Global shortcuts (⌘T/⌘W in helm) live in the Electron menu, not renderer listeners — xterm swallows renderer keys.
- **Hit targets**: minimum 24×24; standard controls are 28. 1px hairlines that are drag handles get an invisible ≥8px hit area (`#divider::before` pattern).
- **Reduced motion**: the §2.5 global clamp on every surface; ambient pulses stop; push navigation swaps instantly.
- **Text selection**: disabled on controls/labels (`user-select: none`), always enabled on content (titles, logs, errors, ids).
- **Live regions**: toasts announce via `aria-live="polite"`; state must exist as accessible text, not color alone (the sidebar's waiting card names the daemon state in words — no status-color-only signal exists to depend on). Nonvisual live-region text uses the shared `.sr-only` utility; that utility must retain absolute 1px clipping so progress copy such as “Plan in progress” never enters the visible action-bar layout.

---

## 5. Copy voice

- Sentence case everywhere — titles, buttons, labels, menu items ("Open pull request", not "Open Pull Request"). Acronyms keep their caps (PR, URL).
- Active voice, verb-first buttons: "Approve", "Retry run", "Open on this Mac".
- States give direction, not mood: name the state, then the way out. No "oops", no apologies, no exclamation marks.
- "…" only on in-flight progress labels ("Starting…") and — per the macOS convention — on menu items that require further input before acting ("Rename…" opens the inline editor); never on buttons or on menu items that act immediately.
- Relative timestamps under 24h ("4m", "2h"), absolute after; always tabular numerals.
- **No uppercase text, anywhere.** The former uppercase Label/Chip treatments are retired; section headers, field labels, and chips are sentence case like everything else. Remove `text-transform: uppercase` on sight.

---

## 6. Performance budgets

Budgets are **measured, not aspirational**: each number below was measured on 2026-07-11 (M-series Mac, dev build via `bun run start`, live daemon with 50 items) and the budget is set with headroom above the measurement. Re-measure before raising a budget; a regression past a budget is a bug, not a new baseline. Method notes live with each number so the measurement is repeatable (temporary `[perf]` console marks — instrument, measure, remove; don't leave counters in).

### 6.1 Startup

| Metric | Measured (median of 3) | Budget |
| --- | --- | --- |
| Electron launch → window visible (`ready-to-show`) | 473ms (452–495) | **< 800ms** |
| Launch → sidebar painted **with data** (50 items) | 474ms | **< 900ms** |

Method: `process.getCreationTime()` as t0; marks at main-load (~120ms), app-ready (~175ms), ready-to-show, and a `requestAnimationFrame` after the first snapshot render. The daemon-offline path shows the waiting empty state inside the same window-visible budget (the bridge push is not on the paint path).

### 6.2 Interaction latency

- **Terminal keystroke echo**: the `pty:data` path is main `proc.onData → webContents.send` and renderer `tabs.find(...).term.write(data)` — no synchronous DOM reads, no forced layout, xterm buffers its own parsing. Keep it that way: never touch layout (`offsetWidth`, `getBoundingClientRect`, `fit()`) in a `pty:data` or `onData` handler; `fit()` runs only on resize/activate.
- **Push transition**: 150ms push / 120ms pop animation (§2.5) — transform/opacity only, and the incoming page renders from already-held snapshot data (no fetch-before-paint). Detail enrichment (`GET /items/:id`, ~60–240ms daemon-side) streams in after paint; the page shows the list row's data until it lands.
- **Row select / segmented switch**: pure state + class swap; nothing to budget beyond "no fetch on the paint path".

### 6.3 List rendering & polling

| Metric | Measured | Budget |
| --- | --- | --- |
| Idle `daemon:snapshot` pushes (queue idle, nothing changing) | **0 pushes / 5 min** (120 poll ticks) | **0** — the bridge must diff (uptime stripped) before pushing |
| Sidebar re-renders while idle | 2 (mount + first snapshot), then flat | re-render **only** on push + the 30s relative-time tick |
| Full 50-row list render + paint (cold mount) | ~60ms | one poll-refresh re-render **< 16ms** (steady state; rows are memoized, only rows whose time label flipped re-render) |

**Virtualization: not used, deliberately.** Bare `GET /api/items` returns every actionable Item plus 50 recent archived Items; a work bucket must never lose an old active row to archive pagination. At the measured 50-row dataset, plain memoized rows are nowhere near a frame budget. Do not add a virtual list until a *measured* paint exceeds ~16ms on push at real item counts — extrapolating from the cold-mount number, that's roughly **500+ rows**. If actionable work grows past that, measure first, then virtualize.

### 6.4 Memory

| Process | Measured (5 min idle, 2 terminal tabs, 50 items) | Budget |
| --- | --- | --- |
| Electron main | 179MB RSS | — |
| Renderer (sidebar + 2 × xterm, 10k scrollback each) | 149MB RSS | — |
| **Main + renderer total** | **328MB** | **< 400MB** |

No growth trend measured (321MB at 40s → 328MB at 5min). GPU/utility helpers add ~137MB (Chromium fixed cost, not budgeted). Terminal scrollback is xterm's own ring buffer, capped at 10k lines per tab (`renderer.ts`) — raise that cap only with a matching memory re-measure.

### 6.5 Daemon API

| Route | Measured | Budget |
| --- | --- | --- |
| `GET /api/items` (50 items, ~190KB, cheap observation only) | p50 8ms (3.7–12.2) | **p50 < 50ms** — this route must stay DB-only; adding per-row IO (logs, `gh`) is the regression to watch for |
| `GET /api/status` | p50 2ms | p50 < 20ms |
| `GET /api/items/:id` (full observation) | ~60ms without PR, ~240ms with PR (`gh pr view` subprocess) | **< 500ms**; expensive by design — single-item surfaces only, never called per list row, and helm dedupes it across stacked pages (one fetch per id + updatedAt, `DetailPage.tsx`). One sanctioned bypass: the detail log's two-message **live preview** force-refetches on a ~5s cadence while a `running` Item's detail page is the top nav layer (expanded or collapsed); each tick self-reschedules after the previous response, so ticks never overlap or outlive the gates |

### 6.6 Bundle size

`dist/renderer.js` is ~6MB with the inline sourcemap (~1.5MB of code: React + xterm); read+parse is inside the measured startup, so it's fine at this size. If startup breaches its budget, moving to an external sourcemap is the first cheap lever. Extension content-script budget: unchanged (see `extension/`), injected pages must not pay for helm's dependencies.

---

## 7. Component workbench (Storybook)

Helm's renderer workbench lives in Storybook (`app/.storybook/`, `app/src/renderer/**/*.stories.tsx`; run `bun run storybook` in `app/`). It covers the desktop cockpit, terminal chrome, sidebar surfaces, compositions, and primitives. Rules:

- Every §3 component with a React implementation has a story showing **every state in its spec** (tones, sizes, hover-independent states like selected/disabled/active).
- Taxonomy follows abstraction, not source folder: reusable atoms live under **Primitives** (Banner, Button, Chip and dot, Field, Segmented control, Activity indicator, Clamp text); reusable arrangements live under **Compositions** (including the section-owning Disclosure group); large review surfaces live under **Views**. An action slot is a Banner capability/story (**With action**), not a separate notice component.
- **Views sort first** and render at realistic review size (`layout: fullscreen`): Sidebar covers Work list, Item detail, Task, Plan, and Settings; Terminal workspace covers full chrome, tab states, background terminals, and rename. These stories are the primary visual-review entry points, not thumbnails.
- Storybook coverage is a register, not a sample: every §3 primitive/composition and every major renderer view must have a story. Behavioral seams that need Electron/PTYS stay in tests, but their visible states still need a production-class fixture in Storybook.
- Stories consume the real `sidebar.css`/`styles.css` and tokens — never story-local styles; a story that needs its own CSS is exposing missing system CSS.
- Changing a component spec in this document means updating its story in the same slice (same law as the doc itself).
- Storybook is a workbench, not a build target: it stays out of `make check` and the app build; Electron-coupled data comes from typed mock fixtures, never a live daemon.

---

## Appendix: 2026-07 flat-editorial redesign

Deliberate system-wide restyle (not drift): the machined-terminal register was reworked into a quieter, Apple-flat editorial language. Old values below are RETIRED — never reintroduce them.

| What | Was | Now |
| --- | --- | --- |
| Section labels | 11/600 uppercase `0.06em` (`OUTCOME`, `DAEMON`) | Section header 12/600 sentence case `--text-1` |
| Field/fact labels | 11/600 uppercase `0.06em` | Label 12/500 sentence case `--text-2` |
| Chip text | 10/700 uppercase `0.04em`, glyph prefixes (`✓ CLEAR`) | 11/500 sentence case, text-only ("Clear") |
| Quiet button | transparent + 1px `--hairline-strong` outline | filled `--fill-raised`, no border, hover `--fill-strong` |
| Danger button | transparent + 1px danger-soft outline | filled danger-soft, no border |
| In-flow cards | 1px `--hairline` boxed `.card`, radius 8 | flat groups: rule + section header + rows (no box) |
| Lifecycle index active | accent-colored label text | `--text-0` label + 2px accent underline |
| List-row project slug | 72% project / 28% `--text-0` mix | 55% project / 45% `--text-1` mix |
| Uppercase via `text-transform` | allowed as a style | banned everywhere |

Second pass (same redesign, after "it looks the same" feedback — scale + air):

| What | Was | Now |
| --- | --- | --- |
| Page-leading titles | 15/600 | Page/hero title 17/600, always present in the detail hero, headline-first |
| md buttons | 28px / 12/600 / radius 6 | 32px / 13/600 / radius 8 |
| Action bar | 48px, padding 10 12 | 56px, padding 12 16 |
| List rows | 56px + soft separators + accent-edge selection | 64px square full-width hover/active stripe, row-owned 16px content padding, no separators or persistent selection |
| Lifecycle index | 40px, 12px labels | 44px, 13px labels |
| Pane scroll padding / section gap | 12 / 12, groups 16px top inset | 16 / 16, groups 20px top inset |

Third pass (geometry — one text grid, §2.3):

| What | Was | Now |
| --- | --- | --- |
| Text columns | mixed 12/16/20px lefts (12px-era toolbar, +4px card/hero/task sub-insets) | one 16px grid; all sub-insets 0 |
| Lifecycle index | justified full-width grid, edge-pinned first/last, centered middles, 10px counts | left-aligned flex, auto-width targets, 24px gaps, 16px start, 11px counts |
| Action-row fill | 4px overhang, radius 4 (detail: no overhang, flush separators) | square full-page-width stripe via 16px gutter compensation; separators inset 16px to the text edge |
| Queue row action buttons | floating at their own offset | aligned to the row's 16px content edge (same column as the time label) |
| Task page sections | 16px vertical, 4px horizontal insets | 20px vertical, 0 horizontal |
| List-row status | leading 8px tone dot on every row (color-only) | mixed lifecycle WORD only on line two; shared ActivityIndicator before a running title |
| List-row selection | persistent `--fill-raised` highlight after pop-back | none — hover/press feedback only; pop-back restores scroll + keyboard focus |

Fourth pass (2026-07 IA flattening — depth, not paint): the item detail's pushed **Run details** and **Run setup** pages and the **Work** hub group are RETIRED. The single-item fetch already carried everything they showed, so the nesting was presentational click tax (the log sat three interactions from the list).

| What | Was | Now |
| --- | --- | --- |
| Run evidence (timeline, log, solve input) | pushed Run details page behind a Work-group nav row, log behind a further Show-log toggle | inline detail groups (§3.15); Activity/input use expandable groups, Log is always expanded |
| Execution setup | pushed Run setup page behind a nav row | shared agent/model/effort/workspace summary + §3.20 Change/Done header action |
| Work hub group | "Work" group with Run details / Task / Plan nav rows | Task + Plan documents as one shared destination group; ticket progress in the top identity metadata |
| Progress card (running) | "Latest: …" summary of the Run details page | deleted — the inline timeline IS the progress |
| Plan page | Status facts + Workspace + Notes | Workspace + Notes only (status facts moved inline to detail) |
| Detail subtree | detail → run / run-setup / task / plan | detail → task / plan documents only |

## Appendix: reconciled drift

Values that existed in code before this document, and the canonical pick. Migrate on next touch of the affected file; do not batch-restyle preemptively.

| Where | Was | Canonical | Why |
| --- | --- | --- | --- |
| `extension/src/widget.styles.ts` bg ladder | `#17181a` / `#1e2024` / `#292c31` | `--pane #141517` / `--chrome #1a1c1f` / `--fill-raised` hover | One ladder everywhere; helm's matches the design seed |
| widget border | `rgba(255,255,255,0.09)` | `--hairline 0.07` | 0.09 is the *fill-raised* alpha, not a line |
| widget text | `#ededee` / `#a6a9af` / `#6b6f77` | `#ececee` / `#9a9ea6` / `#62666e` | Near-duplicates; helm's are canonical |
| widget card radius | 14 / controls 8 | 8 / 6 | Radii ladder is 8/6/4 |
| widget soft fills | 0.15 and 0.16 mixed | 0.15 everywhere | One alpha for all tone fills |
| widget motion | `150ms ease` | 140ms state / 150ms enter, `ease-out` | §2.5 |
| widget label style | 11/700 uppercase 0.04em | Label = 11/600 uppercase 0.06em | Seed-specified; chips keep 10/700/0.04em |
| widget status dot | 9px + halo ring | 8px, no halo | Glow/halo reserved for the connection dot |
| widget buttons | height 30 | 28 | Control height ladder 28/24 |
| widget focus | border-color change only on buttons | 2px accent outline ring | Visible focus everywhere; fields keep accent border |
| widget font stack | no SF Pro Text entry; `ui-monospace` first | §2.2 stacks | Single canonical stacks |
| helm `styles.css` divider hover | `rgba(255,255,255,0.18)` | `--hairline-strong 0.16` | Fold into the strong-line token |
| helm kbd background | `rgba(255,255,255,0.04)` | `--fill-subtle 0.05` | No off-scale alphas |
| extension select chevron | stroke `#6b6f77` | `#62666e` (`--text-2`) | Text ladder |
| extension accent-fill + hover | `#3b82f6`, hover `#5a9dff` | **adopted** as `--accent-fill` | Better fill contrast under white text than `#4c9aff`; promoted into the system |
| extension `--vg-border-strong 0.16` | — | **adopted** as `--hairline-strong` | Useful second line weight; promoted |
| extension shadow | `0 10px 30px -8px …` | **adopted** as `--shadow-2` | Floating-over-foreign-page elevation; helm toast shadow stays `--shadow-1` |
| extension tone-class names (`chip-*`, `c-*`, `bg-*`) | — | **adopted** as shared tone vocabulary | Already mirrored by the web dashboard |
