# Helm design system

**This document is law for every helm UI surface**: the app renderer (`app/src/renderer/`), the extension widget (`extension/src/widget.styles.ts`), and any future surface. A UI change that introduces a new pattern MUST add it here in the same slice; a value not in these tables is drift. Where existing code disagreed, the canonical value was picked and the change is recorded in [Appendix: reconciled drift](#appendix-reconciled-drift).

Helm is the captain's station: dark, machined, quiet. Everything below serves that.

---

## 1. Principles

1. **One bold element per surface.** Each surface gets exactly one signature/high-emphasis element (a detail page owns its single primary button; the sidebar list owns its filter's active segment). The topbar deliberately owns NONE — traffic-light inset, drag region, tab strip; no branding, no status jewelry. Never two filled-accent elements visible at once.
2. **Depth from the ladder, not decoration.** Hierarchy comes from the three-step background ladder + hairlines + white-alpha fills. No gradients, no borders heavier than 1px, no shadows on inline elements — shadows are for detached surfaces (toast, menu, sheet, widget) only.
3. **Quiet motion.** 120–160ms, ease-out, transform/opacity only. `prefers-reduced-motion` MUST be respected globally. Ambient animation (pulse, breathe) is reserved for live status, never decoration.
4. **Designed for its width.** Every surface is designed at its real width (sidebar: 340px). Never cram a desktop layout into a narrow pane; use push navigation instead of side-by-side panes below 480px.
5. **Selection is the action; copy gives direction.** No hover-revealed actions in lists — selecting the row is the interaction. All copy is sentence case, active voice; states tell the user what happens next, never how to feel ("Daemon unreachable — retrying", never "Oops!").

---

## 2. Tokens

Canonical CSS custom properties. Helm defines them on `:root` (`app/src/renderer/styles.css`); the extension defines the same values on `:host` with a `--vg-` prefix (shadow-root isolation). **The values MUST be identical across surfaces**; the prefix is the only allowed difference.

### 2.1 Color

Background ladder (dark only — helm surfaces do not ship a light theme):

| Token | Value | Role |
|---|---|---|
| `--chrome` | `#1a1c1f` | Window chrome, topbar, elevated cards (toast, menu, offline card, sheet) |
| `--pane` | `#141517` | Default surface: sidebar, dashboard, widget card base |
| `--well` | `#0f1113` | Deepest inset: terminal well, code wells, log viewers |

White-alpha fills and lines (always on the ladder, never opaque grays):

| Token | Value | Role |
|---|---|---|
| `--hairline` | `rgba(255,255,255,0.07)` | All borders and separators. The only line weight is 1px |
| `--hairline-strong` | `rgba(255,255,255,0.16)` | Emphasized border: quiet-button outline, hovered input border, drag-target hover |
| `--fill-subtle` | `rgba(255,255,255,0.05)` | Hover fill; resting input/segmented-track background |
| `--fill-raised` | `rgba(255,255,255,0.09)` | Active/selected fill (active tab, selected row, active segment) |

Text:

| Token | Value | Role |
|---|---|---|
| `--text-0` | `#ececee` | Primary: titles, body, button labels |
| `--text-1` | `#9a9ea6` | Secondary: descriptions, toast detail, quiet-button labels |
| `--text-2` | `#62666e` | Faint: meta, timestamps, labels, placeholders, disabled-adjacent |

Accent and semantic tones. Each tone has a **text/icon value** and a **soft fill** (15% alpha) for chips and banners:

| Token | Value | Soft fill | Role |
|---|---|---|---|
| `--accent` | `#4c9aff` | `rgba(76,154,255,0.15)` | Links, focus ring, running state, cursor, selection |
| `--accent-fill` | `#3b82f6` | (hover `#5a9dff`) | Filled primary button background ONLY — `#4c9aff` is too bright as a fill under white text |
| `--success` | `#4ec98a` | `rgba(78,201,138,0.15)` | Done, connected, merged |
| `--warn` | `#e0b341` | `rgba(224,179,65,0.15)` | Needs attention, review, degraded |
| `--danger` | `#f2585b` | `rgba(242,88,91,0.15)` | Failed, destructive actions |
| `--neutral` | `#8a8f98` | `rgba(138,143,152,0.15)` | Queued, triage, cancelled, unknown |

- All soft fills are exactly **0.15 alpha** of their tone. Never invent per-component alphas.
- Never use a tone color as an opaque background (exception: `--accent-fill` primary button).
- Status → tone mapping is fixed: triage/queued/cancelled = neutral, running = accent, review/needs-you = warn, done = success, failed = danger. Do not remap per surface.

### 2.2 Typography

Families:

| Token | Stack | Use |
|---|---|---|
| `--font-ui` | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif` | All UI text |
| `--font-mono` | `'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace` | Terminal, branch names, ids, kbd, code |

Scale (px / weight / notes). Base letter-spacing is `-0.01em`; only the Label and Chip styles override it:

| Style | Size/weight | Spec |
|---|---|---|
| Page title | 15/600 | Detail-page heading. One per page. `--text-0` |
| Body / row title | 13/400 (titles 13/500) | Default. Line-height 1.5 for paragraphs, single-line ellipsis in rows |
| Emphasis / button | 13/600 (buttons 12/600) | Section titles, empty-state titles |
| Secondary | 12/400 | Detail lines, toast detail, descriptions. `--text-1` |
| Meta | 11/400 | Timestamps, counts. `--text-2`, `font-variant-numeric: tabular-nums` for numbers/times |
| Label | 11/600, uppercase, `0.06em` | Section labels, wordmark, field labels. `--text-2` |
| Chip | 10/700, uppercase, `0.04em` | Chip/badge text only. Never for standalone labels |
| Mono inline | 11/400 mono | Branch names, ids, kbd |
| Terminal | 13/400 mono (default), cell height ≈19px | xterm: `lineHeight: 1.2` multiplier lands 13px at ~19px cells (`app/src/renderer/renderer.ts`) — a literal 1.45 would render ~22px. Size is user-adjustable **9–24px** via ⌘= / ⌘− / ⌘0 or Settings → Appearance (§2.8). Theme comes from the `--term-*` / `--ansi-*` tokens (§2.8): bg `--term-bg`, fg `--term-fg`, cursor `--term-cursor`, selection `--term-selection` |

- `-webkit-font-smoothing: antialiased` on the body.
- Never use font sizes outside this scale. Never bold below 600 or above 700.
- **UI text scale**: the sidebar's type scale multiplies by `--ui-scale` (0.92 / 1 / 1.08 — Settings → Appearance): every sidebar `font-size` is written `calc(<spec px> * var(--ui-scale))`. Layout metrics (heights, padding, hit targets) and the terminal do NOT scale.

### 2.3 Spacing

4px base scale: **4, 8, 12, 16, 20, 24, 32**. No other values (1px is a line, not a space; 2px only as inner padding of segmented tracks and countdown-bar height).

| Context | Value |
|---|---|
| Inside controls (icon↔label, dot↔text) | 4–8 |
| Control-to-control in a row (toolbar, action bar) | 8 |
| Card/section internal padding | 12 (compact) or 16 |
| Between sections / stacked cards | 12 |
| Surface edge inset (toasts from viewport, sheet inset, pane padding) | 16 |

### 2.4 Radii

| Token | Value | Use |
|---|---|---|
| `--radius-lg` | 8 | Cards, toasts, menus, sheets, banners, wells |
| `--radius-md` | 6 | Buttons, inputs, selects, tabs, segmented outer, menu-item hover |
| `--radius-sm` | 4 | kbd, segmented inner option, tab-close hover, mini affordances |
| full | 999 | Chips, pills, dots |

Never 10/12/14px radii (extension card's 14px is reconciled to 8 — see appendix).

### 2.5 Motion

| Token | Value | Use |
|---|---|---|
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
|---|---|---|
| `--shadow-1` | `0 8px 24px rgba(0,0,0,0.35)` | Toast, menu/popover |
| `--shadow-2` | `0 10px 30px -8px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.35)` | Sheet/modal, injected widget (floats over foreign pages — needs harder separation) |

### 2.7 Z-layers

| Layer | z-index |
|---|---|
| Content | 0 |
| Pinned bars (topbar, action bar, push-nav header) | 10 |
| Menus / popovers | 40 |
| Sheet + scrim | 60 |
| Toasts | 100 |
| Injected widget root (extension shadow DOM, competes with host page) | 2147483647 — allowed ONLY at the shadow-root host; layers inside the widget use this table |

### 2.8 Theming

Every color in this document is a **CSS custom property** — components MUST consume `var(--token)`, never literals; a hex/rgba literal in component CSS is drift. Beyond §2.1, the token set includes `--accent-fill-hover`, `--on-accent` (text on accent fills), `--thumb`/`--thumb-hover` (pane scrollbars + toast countdown), `--term-scroll-thumb`/`--term-scroll-thumb-hover` (the terminal overlay scrollbar, §3.14 — a brighter pair because it floats over `--well`), `--scrim`, `--shadow-1`/`--shadow-2`, the terminal surface (`--term-bg`/`--term-fg`/`--term-cursor`/`--term-cursor-accent`/`--term-selection`), and the ANSI 16 as `--ansi-<name>`/`--ansi-bright-<name>`. The canonical values live in `app/src/theme-presets.ts` (`HELM_TOKENS`); `app/src/renderer/styles.css` `:root` mirrors them only for the pre-JS first paint — keep both in sync.

- **Soft fills are derived, not stored**: `--<tone>-soft: color-mix(in srgb, var(--<tone>) 15%, transparent)`. Themes override the tone; every chip/banner/soft border follows automatically. Never hand-mix a per-component alpha (the §2.1 0.15 rule, mechanized).
- **A theme is a flat JSON object of token overrides**, stored as `<userData>/themes/<id>.json` (`{ "name": "…", "tokens": { "--token": "value", … } }`). Main seeds the presets as editable files on first list (`themes:list` IPC) and any other `*.json` dropped in the dir appears in the Appearance theme picker; sparse themes backfill missing tokens from the Helm base. Runtime application is owned by `app/src/renderer/appearance.ts`: `documentElement.style.setProperty` per token plus an xterm `options.theme` rebuild from the `--term-*`/`--ansi-*` tokens (`termThemeFromTokens`) — CSS and terminal can never disagree.
- **Presets: "Helm" + "High contrast".** Deliberately NO light preset: the §2.1 ladder is dark-only — the white-alpha hairline/fill system and the terminal palette assume a dark surface, so a genuinely good light theme needs its own ladder and fill system designed from scratch, not inverted tokens. High contrast raises the text ladder to white, doubles the line/fill alphas, deepens the wells to black, and brightens the ANSI 16.
- **Appearance state** (active theme id, per-token overrides from the color wells, terminal font size, UI text scale) persists in `localStorage['helm.appearance']` — same persistence surface as the split width. Settings → Appearance live-applies every change; "Reset to preset" drops the overrides; switching themes starts clean. The accent color well writes the whole accent family (`--accent`, `--accent-fill`, derived `--accent-fill-hover`) so buttons, links, and focus rings stay coherent.
- **Type knobs**: terminal font size **9–24px, default 13**, via ⌘= / ⌘− / ⌘0 — View-menu accelerators forwarded over IPC (the ⌘T pattern; the stock `viewMenu` zoom roles are replaced) — or the Appearance stepper; terminals refit on change. UI text scale is `--ui-scale` per §2.2.

---

## 3. Components

All px values are exact. "Do/Don't" lines are normative.

### 3.1 Buttons

Sizes:

| Size | Height | Padding | Text |
|---|---|---|---|
| md (default) | 28 | 0 12 | 12/600 |
| sm | 24 | 0 10 | 12/600 |
| icon | 28×28 (sm 24×24) | 0 | glyph 14–16px |

Tones:

| Tone | Resting | Hover | Use |
|---|---|---|---|
| primary | `--accent-fill` bg, `#fff` text | bg `#5a9dff` | THE one primary action of the surface |
| quiet | transparent, 1px `--hairline-strong` border, `--text-1` text | bg `--fill-subtle`, text `--text-0` | Secondary actions |
| danger | transparent, 1px danger-soft border, `--danger` text | bg danger-soft | Destructive (reject, cancel run, delete) |
| ghost | transparent, no border, `--text-2` | bg `--fill-subtle`, text `--text-0` | Icon buttons, overflow "…", back chevron, close × |

- Radius `--radius-md`. Disabled: `opacity: 0.45; cursor: default` — never a different color set.
- A ghost control sitting on a pane edge keeps its **text** on the pane's 12px left-edge rhythm: keep the 8px padding for the hover fill but pull it back with a matching negative margin (`padding: 0 8px; margin-left: -8px` — the list page's project trigger), so the fill extends into the gutter and the label stays flush at x=12.
- Focus: `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible` only.
- Transitions: background/color/border 140ms ease-out.
- **Do** keep exactly one primary button per surface (principle 1). **Don't** place two filled buttons adjacent; **don't** make a destructive action primary-filled — danger tone is always outline-style.

### 3.2 Segmented control

- Outer: height **28**, padding 2, radius `--radius-md`, background `--fill-subtle`, 1px `--hairline` ring. The ring is an **inset box-shadow, not a border**, so the arithmetic is exact: 2px padding + 24px option + 2px padding = 28 (a real border would push the track to 30 or squeeze the options to 22 — verify with DevTools: outer 28, padding 2, option 24).
- Options: height 24, radius `--radius-sm`, text 12/600, `--text-1`; equal-width columns (`grid-template-columns: repeat(n, 1fr)`).
- Active option: background `--fill-raised`, text `--text-0`. Filter/segmented navigation is NEVER accent-filled — accent fill on a segment is allowed only for a true either/or commit choice (e.g. the widget's agent picker), and then it uses `--accent-fill` + white.
- **Workspace picker** (detail "Run with" card, `Segmented` in `DetailPage.tsx`): a two-option either/or (Worktree / Main) that stays **NEUTRAL** (`--fill-raised` active — the base spec, NOT `commit`), even though it's an either/or, because the Agent picker directly above already owns the card's one accent-filled commit and two accent fills on one surface is banned (§1). A trailing quiet **"Default"** reset (`.field-reset`, text `--text-2`) sits on the field-label row and appears ONLY when an override is active (stored on the Item, or freshly picked); it clears the override back to `config.solver.workspace`. Picking **Main** shows a one-line `.run-caption` (`--text-2`): "Runs in the project's checkout — shares your working tree." The extension widget's own Workspace segmented (`.vg-agent` pattern) DOES reuse the accent-filled chip (its dense card follows the agent-picker precedent), with "no chip active" = follow the daemon default.
- Trailing count badges inside options: 11px tabular, `--text-2` (active: `--text-1`), separated by 4px. No pill background — bare number.
- Keyboard: Left/Right arrows move selection; the control is one tab stop (`role="tablist"` semantics).
- **Do** cap at 4–5 segments (sidebar filter: Needs / Active / Queue / Triage). **Don't** build full-width tab bars with icons; **don't** let labels wrap or ellipsize — shorten the label instead.

### 3.3 List row

The sidebar work-item row; also the template for any dense list.

- Height **48**, horizontal padding 12, radius 0 (rows are flush; the list well provides the frame). Separator: none by default — rely on spacing; a 1px `--hairline` inset separator is allowed for mixed-content lists.
- Line 1: status dot (8px, §3.5) + 8px gap + title 13/500 `--text-0` single-line ellipsis + trailing relative time 11px tabular `--text-2`.
- Line 2 (2px below): 11px `--text-2` meta — project tag, then ONE mini verdict chip when an assessment exists. Nothing else.
- Hover: background `--fill-subtle`. Selected: `--fill-raised` (text unchanged — no accent text on selection).
- The entire row is the hit target and the only affordance.
- **Do** keep trailing time tabular so columns don't jitter. **Don't** put buttons/icons that appear on hover in rows (principle 5); **don't** exceed two lines.

### 3.4 Chips & badges

- Padding **2 7**, radius 999, text 10/700 uppercase `0.04em`, line-height 1.4.
- Color: tone text on tone soft fill (`chip-gray/blue/green/amber/red` map to neutral/accent/success/warn/danger — the tone-class naming in `widget.styles.ts:344` and the web dashboard is the shared vocabulary).
- Verdict chips (triage assessment) use the mapping in `web/src/verdict.ts` — that file owns verdict→label/tone/icon; do not re-derive it per surface.
- **Do** cap at one chip per list-row meta line. **Don't** make chips interactive (a chip is a state readout, not a button); **don't** use chip style for section labels — that's the Label type style.

### 3.5 Status dots

- Standard: **8px** circle, filled with the status tone (§2.1 mapping). Running state adds `pulse 1.6s ease-in-out infinite`.
- Activity dot (background-terminal popover rows, §3.18): **6px**, `--accent`, no ambient — a quiet "output arrived" mark, not a status.
- **There is no topbar connection dot.** The topbar carries no branding or status (§1); daemon reachability is the sidebar's job — the waiting empty state ("Waiting for the daemon" / "Start it with helm start") when unreachable, silence when connected. The retired spec (7px, `--success` + glow; unreachable `--warn` + breathe 2.4s) stays on record here only for a future surface that genuinely needs an ambient connection signal.
- **Don't** add glow/halo to list-row dots — glow is reserved for an ambient connection signal, and no current surface has one; **don't** use a dot and a chip for the same fact in one row.

### 3.6 Toast

Reference implementation: `app/src/renderer/toast.ts` + `styles.css` "toasts" block.

- Container fixed bottom-right, 16px inset, column stack, gap 8, newest at bottom, `role="status"` + `aria-live="polite"`.
- Box: min-width 220, max-width 340, padding **10 12**, background `--chrome`, 1px `--hairline`, radius `--radius-lg`, `--shadow-1`, `overflow: hidden` (clips countdown bar).
- Content: message 13 `--text-0`; optional detail 12 `--text-1` single-line ellipsis, 2px below; optional one action button — 12/600 `--accent` text, padding 3 10, 1px `--hairline` border, radius `--radius-md`.
- Motion: enter 140ms ease-out (opacity 0→1, translateY(8px)→0, double-rAF before adding the shown class); exit 120ms reverse. Removal by timer, not `transitionend` (unreliable in hidden tabs).
- TTL default 4000ms. Optional countdown: 2px bar, `rgba(255,255,255,0.14)`, `transform: scaleX` draining left→right, `linear` over the TTL.
- **Do** use a toast + Undo for soft-destructive actions (tab close grace). **Don't** stack more than 3 visible toasts — coalesce; **don't** put more than one action in a toast.

### 3.7 Inputs & selects

- Height **28** (textarea min-height 64), padding 0 10, background `--fill-subtle`, 1px `--hairline` border, radius `--radius-md`, text 12 `--text-0`, placeholder `--text-2`.
- Hover: border `--hairline-strong`. Focus: border `--accent`, no outer ring (the border is the ring for fields; buttons/rows use the outline ring).
- Select: `appearance: none` + inline SVG chevron data-URI, stroke `#62666e` (`--text-2`), positioned `right 10px center`, right padding 28. Option list background `--chrome`.
- Field labels: Label type style (11/600 uppercase 0.06em, `--text-2`), 4px above the field.
- Disabled: `opacity: 0.5; cursor: default`.
- **Color wells** (`<input type="color">`, `.color-input`): well = `--fill-subtle`, 1px `--hairline`, radius 6. Chromium's default swatch bezel (1px gray border, square corners) MUST be stripped via the pseudo-elements: `::-webkit-color-swatch-wrapper { padding: 3px }` + `::-webkit-color-swatch { border: none; border-radius: 3px }` — inner radius = outer radius − padding, so the color chip sits inset on the well with token-only lines.
- **Don't** use browser-default selects or native focus rings; **don't** make inputs taller than 28 to "feel friendly" — density is the register.
- **Shadow-root exception**: inside the extension widget's closed shadow root, a native `<select>` cannot be used at all — macOS Chromium never opens its popup there. The widget's model picker is a custom §3.8-style menu in widget tokens (`.vg-model*` in `extension/src/widget.styles.ts`): trigger mirrors the select spec (chevron, ctl radius, 12px/650), panel = surface bg + hairline + card shadow, 28px rows, selected row accent text + check, max-height 180 clamped to the card and flipping above when the bottom would clip.

### 3.8 Menus (overflow / popover)

- Panel: min-width 180, max-width 280, padding 4, background `--chrome`, 1px `--hairline`, radius `--radius-lg`, `--shadow-1`, z-layer 40.
- Items: height 28, padding 0 8, radius `--radius-sm`, text 13 `--text-0`; hover `--fill-subtle`; destructive items `--danger` text (hover danger-soft fill). Disabled items `--text-2`, no hover.
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

The narrow-pane navigation model (Mail-on-iPhone): list → detail → sub-page as a push stack inside the pane. **No side-by-side master/detail below 480px pane width, ever.**

- Header: height 36, background inherits the pane, 1px `--hairline` bottom border, z-layer 10. Contents: 28×28 ghost back-chevron button + page title 13/600 single-line ellipsis; optional one trailing icon button.
- **The header title names the content, never its type.** An item's detail header shows the item's `displayName ?? title` (single-line ellipsis) at all scroll positions — a literal type word ("Item") never appears as a header title. The page may repeat the name in full below as its 15px page title (the header copy is truncated; the page title wraps). Sub-pages of an already-named object (Plan, Task) and pages whose name IS the page (Settings, Archive) keep a static header title.
- Forward: incoming page slides `translateX(100%)`→0 over **150ms ease-out**; outgoing page slides 0→`translateX(-25%)` (parallax) and dims to 0.9 opacity. Back: exact reverse at 120ms.
- Reduced motion: instant swap (the global clamp handles it).
- The list page preserves scroll position and selection across push/pop. Deep pages (plan preview, settings section) push onto the same stack; Esc = back.
- **Gestures — every pushed page inherits these** (implementation: `app/src/renderer/sidebar/swipe.ts` + the nav-stack wiring in `SidebarRoot.tsx`):
  - **Two-finger swipe-back** (macOS trackpad, wheel `deltaX`): an interactive edge-tracking pop. WheelEvent carries no gesture-phase info in Chromium — fingers-down motion, the lift, and the momentum tail (same-sign deltas decaying roughly exponentially over ~300–800ms) are one undifferentiated delta stream — so every rule below is gap- and threshold-based, never phase-based. **Engagement is a dead zone, not a first-event bet**: tracking engages only once the gesture shows clear back intent — ≥ **30px** accumulated back travel since gesture start AND horizontal dominance `|ΣdeltaX| > 2×|ΣdeltaY|` — with a page to pop and no horizontally-scrollable ancestor under the pointer that can still scroll left (`scrollLeft > 0` consumes the pan; at 0 it falls through to navigation — Safari's edge rule). Below the dead zone the page must not move at all; a gesture whose accumulation first crosses the bar any other way (vertical, diagonal, forward pan, consumed) is rejected for its whole lifetime. While tracking, the top page translates 1:1 with the delta past the dead zone (inline transform, no easing) and the previous page peeks: parallax −25%→0 under a `--scrim` dimming layer fading 1→0. **Commits are eager** — evaluated after every event, firing the moment a bar is crossed (an end-of-gesture decision would wait out the whole momentum tail): past **50% pane width**, or a **genuine flick** — back-velocity ≥ **1.5 px/ms averaged over the trailing 80ms** with ≥ **20% pane width** traveled. Rationale: ordinary two-finger scrolling runs ~0.3–1 px/ms and a deliberate flick 2–4, so 1.5 never fires on scroll speed (the old 0.7 did — hair trigger); the trailing-80ms window means an early burst or a decayed tail can't smuggle a commit through; the 20%-width travel floor kills violent micro-twitches. The remaining travel settles at constant-ish perceived speed — duration proportional to remaining distance, **≤ 200ms with an 80ms floor, ease-out** — then the stack pops with NO pop animation (replaying it would flash). A gesture that ends below both bars (gesture end = **140ms** of wheel idle, long enough to bridge fingers resting mid-drag) **springs back in 180ms**. After ANY engaged gesture settles (commit or spring-back) the controller enters a **refractory quiescence gap — 280ms, restarted by every wheel event** — which outlasts any momentum tail, so one physical swipe can never pop two pages; only a real pause re-arms the gesture. Reduced motion: no tracked animation at all — a threshold-crossing gesture pops instantly (the refractory gap still applies).
  - **Native three-finger swipe**: `BrowserWindow` `'swipe'` event → back/forward over the same channel as the Go menu. Back runs the wheel controller's **single-owner check** (`interceptNativeNav`) first — with the "two or three fingers" system setting, one physical gesture can arrive both as wheel deltas and as a native `'swipe'` event: if the wheel path already owns it (engaged tracking, settle animation, or refractory) the native event is swallowed; otherwise the native pop proceeds and arms the refractory gap so the same gesture's wheel deltas can't double-pop.
  - **Keyboard**: ⌘[ back, ⌘] forward — Go-menu accelerators, not renderer listeners (§4: xterm swallows renderer keys). **Mouse back/forward buttons** (`event.button` 3/4, plus `app-command` mice) → back/forward.
  - **Forward** re-pushes the most recently popped route; any new push clears the forward memory.
- **Do** keep every pushed page self-sufficient (own header, own back). **Don't** animate anything except the two page transforms (the swipe scrim's opacity is part of the pop transform pair); **don't** push more than 3 levels — flatten the IA instead.

### 3.11 Action bar (pinned bottom)

Detail pages pin their actions; content scrolls, actions don't.

- Height 48 (content 28 + 10px vertical padding), padding 10 12, background `--pane` (opaque), 1px `--hairline` top border, z-layer 10.
- One **primary** button (the contextual main action: Approve / Start / Retry) + a quiet or ghost "…" overflow for the rest. Danger actions live in the overflow unless the page's whole point is destructive.
- **Don't** put more than two visible buttons in the bar; **don't** let the bar scroll away.

### 3.12 Banners (error / notice)

- Padding 10 12, radius `--radius-md`, text 12 line-height 1.5, `word-break: break-word`.
- Error: `--danger` text on danger-soft fill. Warning: `--warn` on warn-soft. Info: `--text-1` on `--fill-subtle`.
- Optional ghost dismiss × (16px glyph, opacity 0.6→1 on hover), top-aligned.
- Long content (root-cause paragraphs, result summaries): clamp to 4 lines (`-webkit-line-clamp: 4`), expand on click — the block itself is the toggle (`widget.styles.ts` `.vg-notice`, helm `ClampText`). The toggle gets a quiet **"More"/"Less" cue** in the Label type style (11/600 uppercase 0.06em, `--text-2`, hover `--text-1`), 4px below the text, shown only when the content actually overflows the clamp.
- **Actionable notice** (info banner + one quiet `sm` button, right-aligned, text flexes; an `<output>` element — implicit `role="status"` — never the clamp-toggle `<button>`, no nested buttons): for a persistent state with exactly one way out, e.g. Settings' pending-restart notice ("Saved. Restart the daemon to apply — 2 runs active." + "Restart now", `.restart-notice` in `sidebar.css`). It may sit stacked above the action-bar primary (`.action-bar-stack`: auto height, column). One action max — two ways out is a sheet or a page, not a banner.
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
- Tab labels: shell OSC titles matching `user@host[:path]` normalize to the trailing path segment ("helm"); a bare `user@host` falls back to "zsh" (the "shell default" title class); other titles pass through. The raw title survives as the label's tooltip. Normalization + arbitration live in `app/src/renderer/tab-title.ts` (pure, node-tested) — renderer code never re-derives them.
- **Tab rename (pin)**: double-click a tab (or context-menu "Rename…") opens an inline rename field replacing the label — a §3.7 field compacted into the 28px tab: width 120, height 20, padding 0 6, radius `--radius-sm`, background `--fill-subtle`, **1px `--accent` border** (the field's focus signal — no outer ring), text 12 `--text-0`; value preselected on open. Enter/blur commit, Esc cancels; a commit equal to the current name is a no-op (a stray double-click must not silently pin). A committed name **pins** the tab: stored as registry `customName` (separate from `lastTitle`), never overwritten by OSC titles, survives relaunch and park/restore; the background-popover row shows it too. While pinned, the tooltip carries the live OSC title so the underlying shell/program stays one hover away. An **empty commit unpins** — OSC title following resumes from the last live title.
- **Restored-title stickiness**: for `TITLE_STICKY_WINDOW_MS` (~3s) after a dtach reattach, an incoming shell-default-class title does NOT overwrite the restored label (attach chatter must not stamp "zsh" over a saved name — and it would clobber the registry too, compounding across relaunches). A real (non-default) title applies immediately, even inside the window, and settles the tab — from then on every title applies, so live title following is intact; after the window, default titles apply too (a prompt the user summoned is the live truth). Fresh tabs never suppress. Suppressed titles are not persisted.
- xterm theme = the `--term-*` / `--ansi-*` tokens (§2.8), rebuilt into an xterm theme object by `appearance.ts` (`termThemeFromTokens`) — `HELM_TOKENS` in `app/src/theme-presets.ts` is the canonical ANSI-16 for any future terminal surface. Defaults: cursor `--accent`, selection `rgba(76,154,255,0.25)`.
- **Don't** restyle ANSI colors per surface; **don't** put chrome-level controls inside the well.

### 3.15 Cards & info rows (sidebar detail/settings)

The in-flow content card and its fact/navigation rows (`app/src/renderer/sidebar/ui.tsx`).

- Card: 1px `--hairline` border, radius `--radius-lg`, padding 12, transparent background (depth from the ladder — cards in flow get no fill and no shadow). Optional head row: Label-style section label left, one small control or chip right.
- Info row (static fact): min-height 20, 12px value `--text-0` right-aligned single-line ellipsis; label is the Label type style. Mono values (branch, refs) use Mono inline 11.
- **Row rhythm in a flush card** (the Details card, settings lists — `.card-flush`, gap 0, rows at exact pitch): fact rows AND copy/external action rows share **one 28px pitch** (`.card-flush .info-row` min-height 28, center-aligned; `.action-row` min-height 28); only rows that navigate — push rows (chevron ›, `.action-row-push`) and nav rows — sit at the **36px pitch**. Two pitches, one meaning: 28 = read/act in place, 36 = go somewhere.
- Tappable row (`.action-row`): min-height 28 (push rows 36, above), radius `--radius-sm`, hover `--fill-subtle`. Trailing glyph declares the behavior — chevron ›= pushes a sub-page, ↗ = opens externally, copy glyph = copies to clipboard (confirm with a toast). ONLY external-link values are `--accent`; push/copy values stay `--text-0` so the pane doesn't read as a link farm.
- Nav row (`.action-row-nav` — the settings section list): a tappable row whose **title is the content, not a label** — min-height **36** (36px pitch), title 13/400 `--text-0` sentence case, value 12 `--text-1` right-aligned single-line ellipsis, chevron `--text-2`. Nav rows stack flush (card gap 0 via `.card-flush`) inside cards with head rows; grouping comes from the card head row, never from a title prefix ("AI · …" is a namespace hack). Every nav row shows a current-state value with units and real state ("60s", "2 of 3 on", "default") — a blank cell next to a chevron reads as broken, a unit-less number gives no direction, and independent toggles never collapse into one fake on/off.
- **Don't** mix behaviors on one row; **don't** accent-color a value that doesn't leave the app; **don't** use a placeholder verb ("view", "open") or a bare destination name as a value — the value carries the fact (destination + short id: "Contember #4821", "GitHub #132" parsed from the PR url — "GitHub" alone never appears); one object gets one row — fold source + task views into a single push row and demote the external ↗ to the pushed page's header.

### 3.16 Toggle switch

- Track 32×18, radius 999, 1px `--hairline` border, background `--fill-subtle`; on: `--accent-fill`, no border. Knob 12px, `--text-0` (on: `#fff`), travels 14px at 140ms ease-out.
- `role="switch"` + `aria-checked`; label sits left of the control in a row (12px `--text-0`).
- **Don't** use a toggle for anything but an immediate boolean — choices go to a select or segmented control.

### 3.17 Pane scrollbars

- `color-scheme: dark` on `:root` so native form controls and fallback scrollbars render dark.
- Custom webkit scrollbar inside panes: 10px gutter, transparent track, thumb `rgba(255,255,255,0.14)` inset 3px via `background-clip: content-box` (hover `0.24`), radius 999. The terminal uses helm's own overlay scrollbar per §3.14 (full-pane track, 7px pill, the brighter `--term-scroll-thumb` pair).
- **Don't** leave a default (light) scrollbar on any pane surface.

### 3.18 Background terminals (tab strip)

iTerm2's "bury session", helm-style: a tab leaves the strip while its Terminal instance stays mounted in the hidden holder and its pty stays attached — scrollback keeps accumulating headlessly. Memory cost equals an inactive strip tab (those are already hidden, live xterm instances), so parking buys strip space, not memory. Implementation: `app/src/renderer/renderer.ts` (park/restore/popover) + `app/src/sessions.ts` (persisted `parked` flag).

- **Move to background**: right-click a tab → context menu (§3.8 panel at the pointer, viewport-clamped; items "Move to background" ⇧⌘B, "Close" ⌘W with §3.8 trailing shortcut hints). ⌘⇧B parks the active tab — an Electron Shell-menu accelerator per §4 (xterm swallows renderer keys).
- **Strip control**: ghost button pinned at the strip's right edge (28px height, radius `--radius-md`), visible ONLY when the background count > 0 — the empty state is the hidden button, never an empty popover. Content: stack/layers glyph 14px `--text-2` + count badge in the §3.4 chip spec (neutral tone soft fill, 10/700 tabular). Hover and open: `--fill-subtle` fill, `--text-0` glyph.
- **Popover**: §3.8 panel (background `--chrome`, `--hairline`, radius `--radius-lg`, `--shadow-1`, z 40), fixed width 260, anchored `menu-end` under the button. Header "Background terminals" in the Label type style. One row per background terminal, park order.
  - Row: 28px pitch, padding 0 8, radius `--radius-sm`, hover/focus `--fill-subtle`. Leading fixed 6px activity-dot slot (`--accent` when output arrived since parking; cleared on restore and on exit; transparent otherwise so titles align) + title 13 `--text-0` single-line ellipsis (exited rows: `--text-1`) + state 11 `--text-2` tabular ("Running" / "Exited (code)") + hover/focus-within ✕ (16px, opacity 0→0.6→1). The ✕ mirrors the strip tab's close affordance — the row is a tab surrogate, not a §3.3 list row, which is why the hover-revealed control is allowed here.
  - Row click / Enter / Space = restore: the terminal returns as a full tab at the strip end, activated, focused, and refit through the §3.14 fit pipeline (the pty stayed attached, so only a real size change emits a resize). ✕ = close through the grace path: toast + Undo, and **Undo restores to the background list, not to a tab**.
  - Dismiss: outside click or Esc (focus returns to the button). ↑/↓ move between rows.
- **Exited in background**: a pty ending while parked keeps its row with state "Exited (code)" — no toast. Restoring shows the dead terminal's buffer; ✕ removes the row.
- **Persistence**: the session registry (`sessions.json`) carries a per-session `parked` flag. On relaunch, parked sessions reattach headless into the popover; non-parked sessions restore as strip tabs. Registry titles are reused for row labels; a pinned `customName` (§3.14 tab rename) wins over the OSC title on the row.
- **Copy**: menu item "Move to background", header "Background terminals", states "Running" / "Exited (n)" — sentence case per §5.
- **Don't** show the strip button at count 0; **don't** toast background exits; **don't** give the popover more than the one ✕ action per row — restore is the row itself.

---

## 4. Interaction rules

- **Focus**: rings on `:focus-visible` only (never on mouse click). Ring = `2px solid var(--accent)`, offset 2. Text fields signal focus via accent border instead (§3.7). Every interactive element MUST have a visible focus state.
- **Hover**: hover changes fills/borders only — it never reveals functionality that keyboard/touch users can't reach (principle 5). Hover transitions 140ms ease-out.
- **Keyboard**: everything reachable by Tab in visual order; lists navigable with Up/Down + Enter to open; Esc = back (push stack) or close (menu/sheet/toast-action context); segmented controls are one tab stop with arrow keys. Global shortcuts (⌘T/⌘W in helm) live in the Electron menu, not renderer listeners — xterm swallows renderer keys.
- **Hit targets**: minimum 24×24; standard controls are 28. 1px hairlines that are drag handles get an invisible ≥8px hit area (`#divider::before` pattern).
- **Reduced motion**: the §2.5 global clamp on every surface; ambient pulses stop; push navigation swaps instantly.
- **Text selection**: disabled on controls/labels (`user-select: none`), always enabled on content (titles, logs, errors, ids).
- **Live regions**: toasts announce via `aria-live="polite"`; state must exist as accessible text, not color alone (the sidebar's waiting card names the daemon state in words — no status-color-only signal exists to depend on).

---

## 5. Copy voice

- Sentence case everywhere — titles, buttons, labels, menu items ("Open pull request", not "Open Pull Request"). Acronyms keep their caps (PR, URL).
- Active voice, verb-first buttons: "Approve", "Retry run", "Open on this Mac".
- States give direction, not mood: name the state, then the way out. No "oops", no apologies, no exclamation marks.
- "…" only on in-flight progress labels ("Starting…") and — per the macOS convention — on menu items that require further input before acting ("Rename…" opens the inline editor); never on buttons or on menu items that act immediately.
- Relative timestamps under 24h ("4m", "2h"), absolute after; always tabular numerals.
- Uppercase is a *style* (Label, Chip) applied via CSS `text-transform` — source strings stay sentence case.

---

## 6. Performance budgets

Budgets are **measured, not aspirational**: each number below was measured on 2026-07-11 (M-series Mac, dev build via `bun run start`, live daemon with 50 items) and the budget is set with headroom above the measurement. Re-measure before raising a budget; a regression past a budget is a bug, not a new baseline. Method notes live with each number so the measurement is repeatable (temporary `[perf]` console marks — instrument, measure, remove; don't leave counters in).

### 6.1 Startup

| Metric | Measured (median of 3) | Budget |
|---|---|---|
| Electron launch → window visible (`ready-to-show`) | 473ms (452–495) | **< 800ms** |
| Launch → sidebar painted **with data** (50 items) | 474ms | **< 900ms** |

Method: `process.getCreationTime()` as t0; marks at main-load (~120ms), app-ready (~175ms), ready-to-show, and a `requestAnimationFrame` after the first snapshot render. The daemon-offline path shows the waiting empty state inside the same window-visible budget (the bridge push is not on the paint path).

### 6.2 Interaction latency

- **Terminal keystroke echo**: the `pty:data` path is main `proc.onData → webContents.send` and renderer `tabs.find(...).term.write(data)` — no synchronous DOM reads, no forced layout, xterm buffers its own parsing. Keep it that way: never touch layout (`offsetWidth`, `getBoundingClientRect`, `fit()`) in a `pty:data` or `onData` handler; `fit()` runs only on resize/activate.
- **Push transition**: 150ms push / 120ms pop animation (§2.5) — transform/opacity only, and the incoming page renders from already-held snapshot data (no fetch-before-paint). Detail enrichment (`GET /items/:id`, ~60–240ms daemon-side) streams in after paint; the page shows the list row's data until it lands.
- **Row select / segmented switch**: pure state + class swap; nothing to budget beyond "no fetch on the paint path".

### 6.3 List rendering & polling

| Metric | Measured | Budget |
|---|---|---|
| Idle `daemon:snapshot` pushes (queue idle, nothing changing) | **0 pushes / 5 min** (120 poll ticks) | **0** — the bridge must diff (uptime stripped) before pushing |
| Sidebar re-renders while idle | 2 (mount + first snapshot), then flat | re-render **only** on push + the 30s relative-time tick |
| Full 50-row list render + paint (cold mount) | ~60ms | one poll-refresh re-render **< 16ms** (steady state; rows are memoized, only rows whose time label flipped re-render) |

**Virtualization: not used, deliberately.** At 50 items (the daemon list default/limit) plain memoized rows are nowhere near a frame budget. Do not add a virtual list until a *measured* paint exceeds ~16ms on push at real item counts — extrapolating from the cold-mount number, that's roughly **500+ rows**. If the list route's limit grows past that, measure first, then virtualize.

### 6.4 Memory

| Process | Measured (5 min idle, 2 terminal tabs, 50 items) | Budget |
|---|---|---|
| Electron main | 179MB RSS | — |
| Renderer (sidebar + 2 × xterm, 10k scrollback each) | 149MB RSS | — |
| **Main + renderer total** | **328MB** | **< 400MB** |

No growth trend measured (321MB at 40s → 328MB at 5min). GPU/utility helpers add ~137MB (Chromium fixed cost, not budgeted). Terminal scrollback is xterm's own ring buffer, capped at 10k lines per tab (`renderer.ts`) — raise that cap only with a matching memory re-measure.

### 6.5 Daemon API

| Route | Measured | Budget |
|---|---|---|
| `GET /api/items` (50 items, ~190KB, cheap observation only) | p50 8ms (3.7–12.2) | **p50 < 50ms** — this route must stay DB-only; adding per-row IO (logs, `gh`) is the regression to watch for |
| `GET /api/status` | p50 2ms | p50 < 20ms |
| `GET /api/items/:id` (full observation) | ~60ms without PR, ~240ms with PR (`gh pr view` subprocess) | **< 500ms**; expensive by design — single-item surfaces only, never called per list row, and helm dedupes it across stacked pages (one fetch per id + updatedAt, `DetailPage.tsx`) |

### 6.6 Bundle size

`dist/renderer.js` is ~6MB with the inline sourcemap (~1.5MB of code: React + xterm); read+parse is inside the measured startup, so it's fine at this size. If startup breaches its budget, moving to an external sourcemap is the first cheap lever. Extension content-script budget: unchanged (see `extension/`), injected pages must not pay for helm's dependencies.

---

## Appendix: reconciled drift

Values that existed in code before this document, and the canonical pick. Migrate on next touch of the affected file; do not batch-restyle preemptively.

| Where | Was | Canonical | Why |
|---|---|---|---|
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
