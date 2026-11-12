# Tally design-system mechanisms (for porting to Helm)

Source: `/Users/jakubneumann/Documents/code/neumie/tally` (read-only). All counts below come from commands run on 2026-11-12 (rg/wc/node). Paths are relative to the Tally repo root unless absolute.

## 0. Inventory / sizes

| File | Lines |
|---|---|
| `ui/DESIGN.md` | 2158 |
| `AGENTS.md` | 745 |
| `ui/README.md` | 460 |
| `ui/vitest.config.ts` | 47 |
| `biome.json` | 46 |
| `ui/src/tokens/*.ts` (19 files) | 1307 total; `contrastPairs.ts` 223, `color.ts` 131, `contrast.test.ts` 110, `typography.ts` 115, `colorMath.ts` 83, `typography.test.ts` 27 |
| `ui/scripts/*.ts` (14 files) | 1891 total; `emit.ts` 590, `a11y.ts` 480, `a11yScan.ts` 96, `a11yReady.ts` 66, `generated.ts` 40, `tokens.test.ts` 45, `tokens.ts` 22 |

Other counts: 93 `*.stories.tsx` under `ui/src`, 15 `*.mdx`; 135 test files under `ui/src`, 5 under `ui/scripts`; 77 story files use `StateGrid`; `data-force-state` appears 212 times across 37 CSS files. Built `ui/storybook-static/index.json` has 959 entries (865 stories, 94 docs).

---

## 1. `ui/DESIGN.md` structure

Top-level sections (`grep -n '^#'`): 0 The decision (l.18), 1 Brand (49), 2 Tokens (448; subsections 2.0–2.17), 3 Iconography (1153), 4 Component catalogue (1219; 4.0–4.10), 5 Layouts (1691), 6 Motion catalogue (1947), 7 Storybook (1988), 8 Accessibility checklist (2058), 9 Build order and open checks (2108).

Header (l.1–16): a one-line promise, "Engineers implement it literally. Where this document and a mockup disagree, this document wins", then a file table pointing to brand SVGs, the colour scripts (`colorMath.ts`, `contrastPairs.ts`, `contrast.test.ts`, `project.test.ts`: "the tests re-run them on every change") and Storybook ("the living reference").

### 1a. §2.0 Source, naming, outputs (l.450–476)
- Single source `ui/src/tokens/{primitives,color,project,typography,space,size,radius,border,shadow,material,motion,z,breakpoint}.ts`, re-exported from `index.ts`. Plain `as const` objects, **erasable syntax only** (no enums), imports with explicit `.ts` so the generator runs under plain Node type stripping.
- Generator writes committed, never-hand-edited files; freshness test regenerates in memory and compares.
- **Primitives are not emitted to CSS**; components use semantic tokens only.
- Mechanical name mapping table (TS path → CSS var → Swift), e.g. `color.live.onFill` → `--tl-color-live-on-fill` → `Tokens.Color.liveOnFill`; `space.12` → `--tl-space-12` → `Tokens.Space.s12`. Rule text: "CSS = `--tl-` + path segments in kebab-case joined by `-`."

### 1b. §2.2 Semantic colours (l.506–592)
Table columns: `| Token | Light | Dark | Use |`. Alpha written `a(#1C1C1F, .04)`. Each row states use and, where relevant, cites §2.3 / a ruling (e.g. `color.danger.tint` "…keeps danger.text on it at 4.5:1 over bg.grouped and bg.sheet (§2.3, §9 ruling 13)").

### 1c. §2.3 Measured contrast (l.594–714)
Intro paragraph (l.596) states: computed by `ui/src/tokens/contrastPairs.ts`, checked by `contrast.test.ts`; alpha tokens blended over their background first; glass measured against its solid fallback and over the backgrounds it floats on; "**No failures.**"; explains how the worst case set an alpha (ruling 9) incl. the exact threshold (.948) and the one-step-lower failure; requirement legend "Text needs 4.5:1; control edges, focus rings and meaningful graphics need 3:1; 'n/a' rows are decorative or always paired with text."

Table format (exact):

```
| Theme | Foreground | Background | Ratio | Needs |
|---|---|---|---|---|
| Light | text.primary `#1c1c1f` | bg.canvas `#ffffff` | 17.00 | ≥ 4.5 ✓ |
| Light | text.tertiary `#6c6c76` (quiet text in a hovered row, …) | fill.hover over bg.canvas `#f6f6f6` | 4.80 | ≥ 4.5 ✓ |
| Light | text.disabled `#a6a6af` | bg.canvas `#ffffff` | 2.42 | n/a |
| Both | display.textSecondary 66% `#b7b7b9` | display.faceTop `#2b2b30` | 7.03 | ≥ 4.5 ✓ |
```

- Foreground cell = token name + resolved (blended) hex in backticks, optional parenthetical "where used / why this pair" note (e.g. "text.tertiary there is 4.48 ✗").
- Background cell = token, or `X over Y` for alpha-over-base, + resolved hex.
- Ratio 2 decimals. Needs `≥ 4.5 ✓` / `≥ 3 ✓` / `n/a`.
- Row counts in DESIGN.md table: 113 (Light 48, Dark 51, Both 14). Code rows (`contrastRows`): 130 (light 63, dark 67; need 4.5: 100, need 3: 22, need 0: 8; min measured required ratio 3.108). "Both" rows in prose correspond to two code rows (one per scheme).

**How it is "computed"/checked:** the markdown table is **hand-maintained**, not generated. Drift is prevented because every code row carries `spec: number` = the ratio printed in DESIGN.md, and `contrast.test.ts` asserts `ratio.toFixed(2) === spec.toFixed(2)` plus `ratio >= need`. No test parses DESIGN.md itself (no `readFileSync(...DESIGN...)` anywhere). The same `contrastRows` feeds the Storybook Foundations/Colors docs page (`ui/src/docs/blocks/ColorDocs.tsx` `ContrastTable()` at l.529, used in `ui/src/docs/foundations/Colors.mdx` l.32), so docs show live-measured ratios.

### 1d. §4 Component catalogue (l.1219–1690)
Intro: every component presentational/prop-driven, own CSS file `ui/src/components/<group>/<Name>/<Name>.css`, `--tl-*` tokens only, story covering every variant and state in both themes with Czech content; "`Mac:` notes the SwiftUI twin".

**§4.0 Shared state rules** (l.1223–1237), table `| State | Treatment |` for Hover (`@media (hover: hover)` only; fill steps one level over `motion.duration.quick`), Pressed (step again + `scale(0.97)` over `duration.instant`; discs 0.92; full-width rows never scale, ruling 20), Focus-visible (`outline: 2px solid var(--tl-color-focus-ring); outline-offset: 2px`, never removed, never yellow), Disabled (no opacity tricks; `aria-disabled` when it must stay focusable), Loading (label stays, 14px Spinner, width locked, `aria-busy`), Selected toggle, Error (border + inline message linked by `aria-describedby`, never colour alone). Plus: "Hit areas never shrink below `size.target.min` (24 px pointer, 44 px touch); smaller drawn shapes get an invisible `::after` hit area."

**Per-component template** (bold name then bullet fields with italic labels). Example (Button, l.1241–1260):

```
**Button**
- *Purpose:* every text action.
- *Anatomy:* `[leading icon] label [trailing icon]`, capsule. Gap 6 (sm) / 7 (md, lg). Horizontal padding 12 / 14 / 16; …
- *Variants:*
  | Variant | Rest | Hover | Pressed | Use |
  | `primary` | `accent.fill` / `accent.onFill` | `accent.fillHover` | `accent.fillPressed` | Save, Create, … |
- *Sizes:* `sm` 28 / 36 touch (`labelSmall`), `md` 32 / 44 (`label`), `lg` 40 / 50 …
- *States:* §4.0. …
- *Keyboard/a11y:* native `<button>`; Enter/Space. Shortcuts appear in the Tooltip and menus, never as keycaps …
- *Replaces:* `.primary`, `.secondary`, …
```

Field-label frequency (`rg "^- \*([A-Za-z/ ]+):\*"`): Anatomy 25, Replaces 21, Purpose 12, Behaviour 10, Variants 6, States 6, Motion 5, List 4, Keyboard 4, Sizes 3, Placement 3, Phone 3, …; `*Keyboard/a11y:*` 5; `Mac:` 9 occurrences; 75 `**Name**` bold component headings. Big components (TimerDisplay, l.1491ff) use numbered anatomy lists and a sizes matrix `| | Desktop | Phone | Mac |` (Radius / Padding / Numeral / Stop / Ruler height / Secondary row), then *Surface*, *Interaction*, *a11y*, *Mac*, *Replaces*. Px values, desktop / touch pairs ("28 / 36 touch"), tokens in backticks; touch targets ("size.target.min"). Small components are a single paragraph (`**SecondsRuler**: 60 ticks …`).

### 1e. §7 Storybook (l.1988–2056)
Defines: versions pinned (10.6.0, all addons same), story globs, `withThemeByDataAttribute` on `<html data-theme>`, backgrounds off, `a11y: { test: "error" }`, `tags: ["autodocs"]`; toolbar globals (Theme Light/Dark, Motion Full/Reduced → `data-reduced-motion`, 8 named viewports); fixtures (Czech, frozen `now` 2026-09-25 14:01:37, `Europe/Prague`; every ticking component takes `now`); **State stories** rule; exact sidebar hierarchy as a code block (Brand / Foundations / Components / Patterns / Screens / Platforms with every title); screen-story harness; **CI**: `npm run build-storybook -w ui && npm run a11y -w ui`, allow-list rules (`data-a11y-allow="<key>"`, stale entry fails).

### 1f. §8 Accessibility checklist (l.2058–2106)
"Ship-blocking unless marked otherwise." `- [ ]` items grouped under **Perception** (contrast table re-run by `contrast.test.ts`; nothing by colour alone, enumerated per concept; project colour adaptation + ring; 200% text, reflow at 320 CSS px and 320×256; no input <16px on touch; no text in images; Increase Contrast `prefers-contrast: more` (hairline→edge, tertiary→secondary, fill-only controls get 1px `line.edge`); Windows `forced-colors: active` (gradients/glass → `Canvas` + `CanvasText` edge, selected = `Highlight`)), **Operation** (keyboard reach + skip link; focus always visible and not hidden under fixed chrome WCAG 2.4.11 via `scroll-padding` + `scrollIntoView({block:"nearest"})`; overlay focus in/trap/return/Escape; roving tabindex, single-key shortcuts toggleable WCAG 2.1.4; targets 24/44; swipe/long-press alternatives; continuous motion switch WCAG 2.2.2; destructive Undo vs Dialog list; numeric keypad), **Understanding** (aria-label on icon-only + tooltip shortcut; labels/autocomplete/errors; one verb per action), **Robustness** (landmarks, state attributes list, live regions, charts, `aria-hidden` decor, Turnstile), **Mac**, **Process** (`npm run a11y -w ui` passes; manual passes list: keyboard-only Safari/Chrome, VoiceOver iOS/macOS, 200% zoom, reduced motion, dark mode).

### 1g. §9 Build order + rulings (l.2108–2158)
"**Design-owner rulings (final).** Every place where this document … departs from the delivered spec, or where the delivered spec contradicts itself, with the design owner's ruling. The rulings override the delivered spec and are folded into the sections listed under 'Where'; nothing here is open."

Exact column format:

```
| # | Topic | Delivered spec | Ruled | Where |
|---|---|---|---|---|
| 9 | Glass contrast | text on `bg.bar` `#f7f7f9` / `#26262a` (stand-ins …), all passing | **Raise the bar alpha until … special-case nothing.** Light `material.bar` .72 → .95 … | §2.2, §2.3, §2.12, §2.16, `color.ts`, `contrastPairs.ts`, `scripts/a11y.ts` |
| 13 | `danger.tint`, light | `a(#C62A21, .10)`: … measured 4.37:1 | **Light alpha .08** (4.51; dark keeps .14). The contrast table gains …, `contrast.test.ts` checks that .09 would fail, and the a11y allow-list is empty again | §2.2, §2.3, §2.16, `color.ts`, `contrastPairs.ts`, `scripts/a11y.ts` |
```

26 rulings (1–26). The "Ruled" cell opens with a **bold verdict**, often "**…, as built**", then evidence; "Where" lists both doc sections and code files/tests that enforce it.

Inline citation style: `(§9 ruling 23)`, `(§9, ruling 9)`, `(§2.3, §9 ruling 13)`, `(DESIGN.md §9, ruling 10)`. Counts: 33 `ruling N` mentions inside DESIGN.md; 33 more across 26 files in `ui/src`, `ui/scripts`, `web/src` (CSS comments too, e.g. `Sheet.css:54 "(§4.3, §9 ruling 15)"`, `WeekStrip.css:4 "(WCAG 1.4.11, §9 ruling 17)"`, `Table.css:7`, `EntryRow.css:20`; tests like `web/src/breakpoints.test.ts` "the 744 px tablet breakpoint (§9 ruling 26)"; `contrast.test.ts` test names "(DESIGN.md §9, ruling 9)"). Ruling text also states which test enforces it (e.g. ruling 1: "`typography.test.ts` rejects the 501–599 band").

After the table: "**Checks that need a real device** (not verifiable headless)" list.

---

## 2. Token pipeline

### 2a. Token file shapes
- `primitives.ts`: ramps named by OKLCH lightness×100 (`graphite = { 100: "#FFFFFF", 98: …, 0: "#000000" } as const`), `sweep`, `red`, `green`, `amber`; re-exports project palette from `shared`.
- `color.ts`:
  ```ts
  export type Hex = `#${string}`;
  export type Paint = Hex | { hex: Hex; alpha: number };
  export type Pair = { light: Paint; dark: Paint };
  const a = (hex: Hex, alpha: number): Paint => ({ hex, alpha });
  const p = (light: Paint, dark: Paint = light): Pair => ({ light, dark });
  export const color = {
    bg: { canvas: p(g[100], g[17]), chrome: p(g[96], g[21]), … },
    fill: { hover: p(a(g[22], 0.04), a(g[100], 0.05)), … },
    text: { primary: p(g[22], g[96]), secondary: p(g[48], g[72]), tertiary: p(g[53], g[64]), … },
    …
  };
  export const increasedContrast = [
    ["line.hairline", "line.edge"],
    ["text.tertiary", "text.secondary"],
  ] as const satisfies readonly (readonly [string, string])[];
  ```
  Groups: bg, fill, line, text, accent, live, stop, display, danger, success, warning, focus, overlay, material, chart, project.
- `typography.ts`: `TypeStyle = { size, line, weight, tracking }` (tracking in em); `TypographyToken = { desktop: TypeStyle; touch: TypeStyle; mac?: MacTextStyle; numeric?: boolean }`; helper `t(size,line,weight,tracking=0)`; `typography = { numeralHero: { desktop: t(116,108,250,-0.04), touch: t(64,70,250,-0.035), mac: {...}, numeric: true }, titleLarge…, body…, caption…, micro… } as const satisfies Record<string, TypographyToken>`; `fontFamily`; `lowDpiNumeralWeight = { from: 250, to: 300 }`.
- `space.ts`: `{ 0:0, 2:2, 4:4, …, 80:80 } as const` (4px base, 2px half-steps <12). `radius.ts`: `{ xs:4, sm:6, md:8, lg:12, xl:16, xxl:20, xxxl:28, full:9999 }`. `motion.ts`: `duration` (instant 90, tick 120, quick 160, base 240, slow 360, deliberate 600, spin 800), `easing` cubic-bezier arrays, `exitScale`, `spring.{snappy,smooth,bouncy}` with SwiftUI params + `samples` arrays for CSS `linear()`. `size.ts` uses `{desktop, touch}` pairs. Each file's first comment cites its DESIGN.md section.
- `index.ts` re-exports everything as `@tally/ui/tokens`.

### 2b. Generator: `ui/scripts/tokens.ts` (22 lines) + `generated.ts` + `emit.ts`
Run with `npm run tokens` → `node scripts/tokens.ts` (plain Node 24+ type stripping; no tsx). **There is no `--check` flag**; staleness is detected only by the vitest freshness test. (Other `--check` modes in the repo: root `legal:check` = `node scripts/legal-archive.mjs --check`, and the Mac `TallyMacSnapshots --check`.)

```ts
// ui/scripts/tokens.ts
for (const [path, content] of Object.entries(generate())) {
  const file = join(repoRoot, path);
  let current: string | null = null;
  try { current = readFileSync(file, "utf8"); } catch { current = null; }
  if (current === content) console.log(`unchanged ${path}`);
  else { writeFileSync(file, content); console.log(`wrote     ${path}`); }
}
```

```ts
// ui/scripts/generated.ts
export const repoRoot = join(import.meta.dirname, "../..");
export function biomeFormat(repoPath: string, source: string): string {
  const bin = join(repoRoot, "node_modules/.bin/biome");
  return execFileSync(bin, ["format", `--stdin-file-path=${repoPath}`], {
    cwd: repoRoot, input: source, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
}
export function generate(): Record<string, string> {
  const index = readFileSync(join(repoRoot, OUTPUTS.indexHtml), "utf8");
  return {
    [OUTPUTS.css]: biomeFormat(OUTPUTS.css, emitCss()),
    [OUTPUTS.swift]: emitSwift(),
    [OUTPUTS.manifest]: biomeFormat(OUTPUTS.manifest, emitManifest()),
    [OUTPUTS.themeJs]: biomeFormat(OUTPUTS.themeJs, emitThemeJs()),
    [OUTPUTS.indexHtml]: updateIndexHtml(index),
    [OUTPUTS.projectVectors]: emitProjectVectors(),
  };
}
```
Key idea: output is piped through the repo's Biome formatter so committed files pass `npm run lint` unchanged and the freshness comparison is byte-exact.

`emit.ts` (590 lines, "Pure emitters … No I/O here"):
```ts
export const HEADER = "Generated by ui/scripts/tokens.ts from ui/src/tokens. Do not edit.";
export const OUTPUTS = {
  css: "ui/src/styles/tokens.css",
  swift: "mac/Sources/TallyMacCore/DesignTokens.swift",
  manifest: "web/public/manifest.webmanifest",
  themeJs: "web/public/theme.js",
  indexHtml: "web/index.html",
  projectVectors: "mac/Tests/TallyMacCoreTests/Fixtures/project-colors.json",
} as const;
export const TOUCH_MEDIA = "(pointer: coarse), (max-width: 1023px)";
export const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
export const cssVar = (path: readonly (string | number)[]) =>
  `--tl-${path.map((s) => kebab(String(s))).join("-")}`;
function paintCss(paint: Paint): string {           // "#rrggbb" or "rgb(r g b / a)"
  if (typeof paint === "string") return paint.toLowerCase();
  const h = paint.hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return `rgb(${r} ${g} ${b} / ${num(paint.alpha)})`;
}
function pairCss(light: Paint, dark: Paint): string {
  const l = paintCss(light); const d = paintCss(dark);
  return l === d ? l : `light-dark(${l}, ${d})`;
}
```
`emitCss()` builds `:root { color-scheme: light dark; … }` (fonts, every colour as `light-dark()`, space, size (desktop value; touch in `@media TOUCH_MEDIA` block), radius, border, shadow, materials, motion durations/easings/`linear()` springs, z, breakpoints, typography `-size/-line/-weight/-tracking` vars), then `[data-theme="light"] { color-scheme: light; …shadows }`, `[data-theme="dark"] {…}`, `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }`, touch scale media block (type `calc(Nrem / 17)` for Dynamic Type; sizes `max(px, calc(rem/17))`; desktop `max(px, n/16 rem)`), low-DPI weight block, `@media (prefers-contrast: more)` from `increasedContrast`, hi-DPI hairline, and `.tl-typography-<name>` classes (`font: var(weight) var(size) / var(line) var(--tl-font-family-sans); letter-spacing; tabular-nums when numeric`). Theme scoping = `data-theme` on any element because colours use `light-dark()` + `color-scheme`.

### 2c. Freshness test `ui/scripts/tokens.test.ts`
```ts
describe("generated token files", () => {
  const files = generate();
  it.each(Object.keys(files))("%s is up to date (run `npm run tokens`)", (path) => {
    const committed = readFileSync(join(repoRoot, path), "utf8");
    expect(committed).toBe(files[path]);
  });
});
describe("naming (DESIGN.md §2.0)", () => {
  it("maps token paths to CSS custom properties mechanically", () => {
    expect(cssVar(["color", "bg", "canvas"])).toBe("--tl-color-bg-canvas");
    expect(cssVar(["color", "live", "onFill"])).toBe("--tl-color-live-on-fill");
    …
  });
  it("emits every colour token as light-dark() or a single value", () => {
    const css = emitCss();
    expect(css).toContain("--tl-color-bg-canvas: light-dark(#ffffff, #111113);");
    expect(css).not.toMatch(/--tl-(graphite|sweep|red|green|amber)-/); // primitives stay in TS
  });
});
```
Staleness detection = in-memory regenerate (including Biome format) vs committed bytes, one `it.each` case per output file; the failure title tells the fix. Same pattern in `scripts/icons.test.ts` (Buffer compare) and `scripts/favicon.test.ts`.

---

## 3. `contrast.test.ts` and `typography.test.ts`

### 3a. `ui/src/tokens/colorMath.ts`
WCAG 2.x maths + OKLCH:
```ts
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function luminance(rgb: RGB) { const [r,g,b] = rgb.map(toLinear); return 0.2126*r + 0.7152*g + 0.0722*b; }
export function contrast(a: RGB, b: RGB) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
export function blend(fg: RGB, alpha: number, bg: RGB): RGB {
  return fg.map((c, i) => c * alpha + (bg[i] ?? 0) * (1 - alpha));
}
```
plus `hexToRgb`, `rgbToHex`, `rgbToOklch`, `oklchToRgb` (gamut map by stepping chroma 5% up to 60 times).

### 3b. `ui/src/tokens/contrastPairs.ts`
```ts
type Ref = string | { hex: string };
function resolve(ref: Ref, scheme: Scheme, under?: RGB): RGB {
  if (typeof ref !== "string") return hexToRgb(ref.hex);
  const [group, name] = ref.split(".");
  const pair = color[group]?.[name];
  if (!pair) throw new Error(`Unknown colour token ${ref}`);
  const paint = pair[scheme];
  if (typeof paint === "string") return hexToRgb(paint);
  if (!under) throw new Error(`${ref} has alpha; give it a background`);
  return blend(hexToRgb(paint.hex), paint.alpha, under);
}
export interface ContrastRow {
  scheme: "light" | "dark"; fg: Ref; bg: Ref;
  bgUnder?: Ref;           // background under bg when bg has alpha (glass)
  need: 0 | 3 | 4.5;
  spec: number;            // the ratio printed in DESIGN.md §2.3 (two decimals)
  open?: string;           // known failure awaiting a ruling (none; test pins list empty)
}
// helper: three text tiers on a background
const text = (scheme, bg, specs: [number, number, number], bgUnder?) => {
  const fgs = ["text.primary", "text.secondary", "text.tertiary"];
  specs.forEach((spec, i) => rows.push({ scheme, fg: fgs[i], bg, bgUnder, need: 4.5, spec }));
};
text(L, "bg.canvas", [17.0, 6.42, 5.19]);
rows.push({ scheme: L, fg: "danger.text", bg: "danger.tint", bgUnder: "bg.grouped", need: 4.5, spec: 4.51 }, …);
export function measureContrast(row: ContrastRow) {
  const under = row.bgUnder ? resolve(row.bgUnder, row.scheme) : undefined;
  const bg = resolve(row.bg, row.scheme, under);
  const fg = resolve(row.fg, row.scheme, bg);  // fg alpha blended over the resolved bg
  return { ratio: contrast(fg, bg), fg: rgbToHex(fg), bg: rgbToHex(bg) };
}
export const contrastRows: readonly ContrastRow[] = rows;
```
Rows carry comments explaining why the pair exists (e.g. "Quiet text on a pressed or open control … text.tertiary there is 4.48 … contrast.test.ts checks that tertiary would fail").

### 3c. `contrast.test.ts` logic (110 lines)
1. `it.each(contrastRows)` per row: `if (need && !open) expect(ratio) >= need`; `expect(ratio.toFixed(2)).toBe(spec.toFixed(2))` → the doc ratio is pinned.
2. "pins every ratio to DESIGN.md": no non-finite `spec`.
3. "has no failing pair and no open gap (§9 ruling 9)": failures list `[]`, and `contrastRows.filter(r => r.open)` must be `[]` ("A new gap must be ruled on by the design owner, not marked `open` here quietly").
4. **Negative/"step-up" proofs**: e.g. on `fill.selected` over `bg.canvas`, `text.tertiary < 4.5` and `text.secondary >= 4.5` in both schemes — proves the rule "quiet text steps up on selected fills" is necessary. Same for Display hovered head and for a double-blended `fill.hover` (hover inside hovered row).
5. **Alpha optimality proofs**: light `material.bar` alpha is the lowest two-decimal value passing over all underlays (`worst(alpha) >= 4.5` and `worst(alpha - 0.01) < 4.5`); light `danger.tint` is the strongest passing (`worst(alpha + 0.01) < 4.5`).

### 3d. `typography.test.ts` (27 lines)
```ts
it("gives every title a line-height of at least 1.2 in both scales, so Ů, Č, Ř never collide", () => {
  const titles = Object.entries(typography).filter(([n]) => n.startsWith("title"));
  expect(titles.map(([n]) => n)).toEqual(["titleLarge", "titlePage", "titleSection"]);
  for (const [name, t] of titles) for (const scale of ["desktop", "touch"] as const) {
    const { size, line } = t[scale];
    expect(line / size, `${name}.${scale} ${size}/${line}`).toBeGreaterThanOrEqual(1.2);
  }
});
it("keeps every weight out of 501–599, which Chrome on macOS draws heavier than Bold for SF", () => {
  for (const [name, t] of Object.entries(typography)) for (const scale of ["desktop", "touch"] as const) {
    const { weight } = t[scale];
    expect(weight > 500 && weight < 600, `${name}.${scale} weight ${weight}`).toBe(false);
  }
});
```
(Pins the exact title list so a new title must be consciously added.)

---

## 4. A11y tooling (`ui/scripts/a11y.ts`, `a11yReady.ts`, `a11yScan.ts`)

### 4a. Invocation / inputs
- `npm run a11y -w ui` = `node scripts/a11y.ts` (Node type stripping). Must run after `npm run build-storybook -w ui` (`storybook build -o storybook-static`).
- **Runs only against a static build**, never the dev server: `const root = process.env.A11Y_ROOT ?? join(import.meta.dirname, "../storybook-static")`; it serves that folder itself with a tiny `node:http` server on `127.0.0.1:0` (random port), path-traversal guarded (`file.startsWith(root + sep)` else 403), a MIME map.
- Filters: `argv[2]` comma-separated substrings of entry id (`npm run a11y -w ui -- toast,dialog`); `A11Y_VIEWPORTS=desktop|phone`.
- **Story enumeration**: reads `storybook-static/index.json`, `Object.values(index.entries).filter(e => (e.type === "story" || e.type === "docs") && filters.some(f => e.id.includes(f)))`. Missing index → prints "run build-storybook first", exit 1.
- Jobs: entries × viewports (`desktop` 1280×900, `phone` 402×874; docs pages desktop only) × themes `["Light","Dark"]`. Concurrency: 4 workers pulling from a shared index over one browser.

### 4b. Browser launch
```ts
import { type Browser, chromium } from "playwright-core";
async function launch(): Promise<Browser> {
  const executablePath = process.env.CHROME_PATH;
  return executablePath ? chromium.launch({ executablePath }) : chromium.launch({ channel: "chrome" });
}
```
`playwright-core` (no bundled browsers) + the installed Google Chrome channel; `CHROME_PATH` overrides. axe from `createRequire(import.meta.url).resolve("axe-core/axe.min.js")` (axe-core ^4.13).

### 4c. Theme application per page
URL: `${base}/iframe.html?viewMode=${story|docs}&id=${entry.id}&globals=theme:${theme};a11y.manual:!true` — globals in the URL set the toolbar Theme (the preview decorators `withThemeByDataAttribute` + `withThemeNow` write `<html data-theme>`; docs via `ThemedDocsContainer`), and `a11y.manual:!true` stops the addon's own axe ("two runs at once throw 'Axe is already running'"). Readiness then **waits until `document.documentElement.dataset.theme === wanted`**.

### 4d. Readiness (`a11yReady.ts`)
```ts
async function contentReady(frame: Frame, selector: string, theme: string) {
  await frame.waitForSelector(selector, { state: "visible", timeout: 15_000 });
  await frame.waitForFunction((w) => document.documentElement.dataset.theme === w, theme, { timeout: 10_000 });
  await frame.evaluate(() => document.fonts.ready);
  await frame.waitForFunction(() => {
    const preview = (window as any).__STORYBOOK_PREVIEW__;
    return preview?.storyRenders?.every((r: {phase: string}) => r.phase === "finished");
  }, undefined, { timeout: 15_000 });
  await frame.waitForFunction(() => !document.getAnimations().some((a) =>
      a.playState === "running" && a.timeline instanceof DocumentTimeline &&
      a.effect?.getComputedTiming().iterations !== Infinity), undefined, { timeout: 10_000 });
}
export async function auditReady(page: Page, kind: "story" | "docs", theme: string) {
  await contentReady(page.mainFrame(), kind === "docs" ? "#storybook-docs h1" : "#storybook-root > *", theme);
  const frames: Frame[] = [page.mainFrame()];
  async function readyChildren(parent: Frame, selector: string) {
    for (const preview of await parent.locator(selector).all()) {   // DOM-owned iframes, incl. lazy
      await preview.waitFor({ state: "attached", timeout: 15_000 });
      await preview.evaluate((el) => { (el as HTMLIFrameElement).loading = "eager"; });
      const frame = await (await preview.elementHandle())?.contentFrame();
      if (!frame) throw new Error("Storybook preview has no document frame");
      await contentReady(frame, "#storybook-root > *", theme);
      frames.push(frame);
      await readyChildren(frame, "body iframe");
    }
  }
  await readyChildren(page.mainFrame(), kind === "docs" ? "#storybook-docs iframe" : "body iframe");
  return frames;
}
```
Waits for: visible content selector, theme attribute, fonts, all Storybook story renders `finished` (play functions done), finite animations settled (infinite spinners/scroll timelines ignored). Then `page.waitForTimeout(250)`.

### 4e. Scan (`a11yScan.ts`)
`scanReadyFrames(page, frames, axePath, exclude, disabled)`: a `coverage()` guard throws if the live frame set changed/detached/added vs the ready inventory (before, between and after scans); injects axe into **every** frame (`frame.addScriptTag({ path: axePath })`); per frame runs
```ts
axe.run({ include: ["body"], exclude: excluded.map((s) => [s]) },
        { iframes: false, elementRef: true,
          rules: Object.fromEntries(disabledRules.map((r) => [r, { enabled: false }])) })
```
and maps each violation node to `{ rule, impact, target, allow: node.element?.closest("[data-a11y-allow]")?.getAttribute("data-a11y-allow") ?? null }`. Missing `window.axe` throws (fatal, not clean). Child-frame targets prefixed `frame[i] <url> :: …`. Returns `{findings, documents, childDocuments}`; throws if `documents !== frames.length`.

Excluded Storybook chrome: `.sb-wrapper`, `#storybook-highlights-root`, `#storybook-a11y-vision-filters`, `.docblock-argstable`, plus `#storybook-docs` on a story / `#storybook-root` on a docs page. Disabled rules: `["region"]` only. Whole document checked (portaled popovers/sheets/tooltips).

### 4f. Extra non-axe checks in `check()` (each becomes a `Found` with a pseudo-rule)
`docgen-leak` (/displayName|__docgenInfo/ in `body.innerText`), `nan` (/\bNaN\b/ in text), `console-nan` (console errors with NaN), docs: `docs-open-modal` (visible `[aria-modal="true"], dialog[open]` on load), `docs-without-docgen` (Components/* props table where every row lacks a description), `docs-without-description` (no paragraph under the h1), `docs-capitals` (any visible element with own lowercase text and `text-transform: uppercase`, i.e. sentence-case enforcement), `docs-snippet` (first "Show code" must match `/^<(?:[A-Z]\w*)[\s/>]/`, Light only), `console-warning` (docs pages). Once per run: `manager-capitals` on Storybook's own sidebar root headers. Any thrown error → `audit-incomplete` (serious).

### 4g. Allowlist format + stale-entry failure + exit code
```ts
const ALLOWED: { key: string; rule: string; reason: string }[] = [];   // empty today
const allowedBy = (f: Found) => ALLOWED.find((a) => a.key === f.allow && a.rule === f.rule);
const failures = found.filter((f) => !allowedBy(f));
const unused = ALLOWED.filter((a) => !found.some((f) => allowedBy(f) === a));
for (const f of failures) console.log(`FAIL ${f.entry} (${f.theme}, ${f.viewport}) ${f.rule} [${f.impact}] ${f.target}`);
for (const a of unused) console.log(`STALE allow-list entry: ${a.key} ${a.rule}`);
…
process.exit(failures.length || unused.length ? 1 : 0);
```
A specimen opts in with `data-a11y-allow="<key>"` on itself or an ancestor; match requires key **and** rule. A listed entry that no longer matches anything fails the run → no lingering allowances. Summary lines report document coverage and counts.

### 4h. Tests of the tooling (vitest project `a11y`)
`a11yReady.test.ts` (3 tests: waits for delayed embedded preview content; loads below-the-fold lazy previews; fails rather than scanning unready content) and `a11yScan.test.ts` (4 tests: detects violation in a deeper lazy preview with local allow metadata; fails if a required child is missing from inventory; fails if a child detaches; fails if a child cannot execute axe under its CSP). Both launch real Chrome the same way and use `page.setContent` fixtures faking `window.__STORYBOOK_PREVIEW__ = { storyRenders: [{ phase: "finished" }] }`.

**CI reality**: `.github/workflows/deploy-prod.yml` runs `npm run lint`, `npm run typecheck`, `npm run test --workspaces --if-present -- --maxWorkers=2 --project='!a11y'`, then `npm run test -w ui -- --project=a11y --maxWorkers=1 --no-file-parallelism` (the 7 tool-regression tests). It does **not** run `build-storybook` + `npm run a11y` (DESIGN §7 says run them before handing off; "There is no CI configuration in the repo yet" in §7 is now outdated).

---

## 5. StateGrid + `data-force-state`

`ui/src/storybook/StateGrid.tsx` (exported as `@tally/ui/storybook`, not from `@tally/ui`):
```tsx
export type ForcedState = "rest" | "hover" | "pressed" | "focus" | "disabled";
export const ALL_STATES: readonly ForcedState[] = ["rest", "hover", "pressed", "focus", "disabled"];
export interface StateGridProps { rows: { label: string; element: ReactElement }[]; states?: readonly ForcedState[]; }
function force(element: ReactElement, state: ForcedState): ReactNode {
  if (!isValidElement(element)) return element;
  if (state === "rest") return element;
  if (state === "disabled") return cloneElement(element, { disabled: true } as never);
  return cloneElement(element, { "data-force-state": state } as never);
}
export function StateGrid({ rows, states = ALL_STATES }: StateGridProps) {
  return (
    <table className="tl-state-grid">
      <thead><tr>
        <th scope="col"><span className="tl-visually-hidden">Variant</span></th>
        {states.map((s) => <th key={s} scope="col">{s}</th>)}
      </tr></thead>
      <tbody>{rows.map((row) => (
        <tr key={row.label}><th scope="row">{row.label}</th>
          {states.map((s) => <td key={s}>{force(row.element, s)}</td>)}</tr>))}
      </tbody>
    </table>
  );
}
```
`SplitStateGrid({ label, rows, groups = [["rest","hover","pressed"],["focus","disabled"]] })` stacks several grids, each in `<section aria-label="${label}: rest, hover, pressed" tabIndex={0} className="tl-state-grid-split__frame">` (focusable scroll region, biome-ignore comment for `noNoninteractiveTabindex`). Requirement: components pass unknown props to their root element.

CSS (`ui/src/storybook/storybook.css`, imported only by `.storybook/preview.tsx`): `.tl-state-grid { border-collapse: separate; border-spacing: 16px 12px; }`, headers in micro type `text.tertiary`.

Convention in component CSS (Button.css l.191–210):
```css
@media (hover: hover) {
  .tl-button:not(:disabled, [aria-disabled="true"], [aria-busy="true"]):is(:hover, [data-force-state="hover"]) {
    --tl-button-icon: var(--tl-button-icon-active);
    background-color: var(--tl-button-bg-hover);
  }
}
.tl-button:not(:disabled, [aria-disabled="true"], [aria-busy="true"]):is(:active, [data-force-state="pressed"]) {
  background-color: var(--tl-button-bg-pressed);
  transform: scale(var(--tl-button-press-scale));
  transition-duration: var(--tl-motion-duration-instant);
}
```
Global focus in `ui/src/styles/base.css` l.104–122:
```css
:focus-visible, [data-tl-focus-visible]:focus, [data-force-state="focus"] {
  outline: var(--tl-border-focus-width) solid var(--tl-color-focus-ring);
  outline-offset: var(--tl-border-focus-offset);
}
.tl-on-display :focus-visible, .tl-on-display [data-force-state="focus"] { outline-color: var(--tl-color-focus-ring-on-display); }
```
Story usage (`Button.stories.tsx` l.297): `export const States: Story = { parameters: { layout: "padded" }, render: () => <StateGrid rows={[{ label: "primary", element: <Button variant="primary">Save</Button> }, …]} /> }`. Because forced states are real renders, axe runs over them in both themes (so hover/pressed/focus contrast is audited).

---

## 6. `ui/vitest.config.ts` projects
```ts
const dom = ["src/components/**/*.test.{ts,tsx}", "src/**/*.dom.test.{ts,tsx}"];
const a11y = ["scripts/a11yReady.test.ts", "scripts/a11yScan.test.ts"];
export default defineConfig({ test: { projects: [
  { extends: true, test: { name: "node", include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...dom, ...a11y] } },
  { extends: true, test: { name: "a11y", include: a11y, hookTimeout: 60_000, testTimeout: 30_000 } },
  { extends: true, test: { name: "dom", environment: "happy-dom", include: dom,
      setupFiles: ["./vitest.setup-dom.ts"], testTimeout: 15_000 } },
]}});
```
`node` = tokens/contrast/typography/generator freshness/markup tests; `dom` = happy-dom + Testing Library (setup does `cleanup()` + `restoreMatchMedia()` after each test; globals off); `a11y` = real-Chrome tooling regressions (long timeouts; cold runner Chrome launch exceeded 10 s). CI selects with `--project='!a11y'` / `--project=a11y`.

---

## 7. Lint guards

`biome.json` (root, Biome 2.5.14): files exclude `mac`, `dist`, `.wrangler`, `storybook-static`; formatter 2 spaces/100 cols; linter `preset: "recommended"` plus one restriction:
```json
"style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
  { "group": ["lucide-react", "lucide-react/**"],
    "message": "Import icons from @tally/ui/icons; only ui/src/icons may use lucide-react." } ] } } }
```
with an override turning it off for `ui/src/icons/**`; `assist.organizeImports` on. There is no `ui/biome.json`.

**No automated raw-colour guard exists.** The "tokens only, no hex/rgb()/color-mix()/raw ms" rule (ui/README.md Conventions, AGENTS.md) is enforced by review only. Measured: `rg "#[0-9a-fA-F]{6}\b" ui/src/components -g '*.css'` → 1 hit, and it is inside a comment (`Switch.css:25`). Other source-scanning guard tests that exist:
- `web/src/breakpoints.test.ts`: walks every `.css` under `web/src` and `ui/src` (reads files via dynamic `node:fs` because vitest gives `.css` imports empty strings) and fails on `/\((?:max|min)-width:\s*(?:759|760)px\)/` (ruling 26), asserting the scan actually saw known files first.
- `ui/src/docs/jsdocMarkup.test.ts`: walks `ui/src/**/*.ts(x)`, finds raw `<tag>` in JSDoc comments outside backticks (docgen renders them as elements); self-test with constructed strings.
- Many component tests read their own CSS (`readFileSync(join(__dirname,"X.css")).replace(/\s+/g," ")`) to assert specific rules (Legend, MiniPlayer, TimerDisplay, EntrySheet, Tabs, GroupedList, TextField, Sheet…).
- a11y script's `docs-capitals` / `manager-capitals` enforce sentence case in rendered docs.

---

## 8. Rules for agents (AGENTS.md "Design system (`ui/`)" l.131–216, ui/README.md)

AGENTS.md: "The spec is `ui/DESIGN.md` (it wins over code); the working guide … is `ui/README.md`." Then bullets:
- `@tally/ui` presentational: no fetch/route/clock/timezone; ticking components take `now`; a missing prop gets a small backwards-compatible addition **with its story and test**; web never forks/restyles a component.
- Eight groups = DESIGN §4 sections; `ui/src/components/<group>/<Name>/` = `<Name>.tsx/.css/.stories.tsx/test`; group barrel `index.ts` + stylesheet index `index.css`; `_lib/` private; import across groups only through barrels; web imports only package entry points.
- `ui/src/tokens/*.ts` single source; generated files never edited; `npm run tokens` outputs listed; freshness tests fail when stale.
- Component CSS takes every colour/shadow/duration/radius/spacing/shared size from `--tl-*`; only §4 one-off dimensions are literal px; "A colour without a token is a foundation gap, never inlined"; touch size tokens as `min-height`.
- Copy follows §1.4 (sentence case, British English, numbered strings verbatim).
- Icons only via `@tally/ui/icons` (Biome).
- "Every component has a story (`Default`, one per variant, `States` through `StateGrid`) that passes axe in both themes: `npm run build-storybook -w ui && npm run a11y -w ui`."
- Screen stories through `web/src/storybook/` (fixture account, stand-in fetch failing every change, frozen clock).
- Storybook packages share one exact version, pinned without a range.
- CSP, browser floor (`light-dark()` needs Chrome 123/FF 128/Safari 18; `build.cssTarget` must match or minifier polyfills `light-dark()` breaking `data-theme`).
Commands block (l.56–75) lists `storybook`, `build-storybook`, `a11y`, `tokens`, `icons`.

ui/README.md (460 lines) sections: Entry points (table of package exports incl. `@tally/ui/storybook` = StateGrid), Tokens (generated-file table "Generated file | From"; theming via `data-theme` on any element), Where things go (tree), Component inventory, Prop conventions (`value`/`onValueChange`, `checked`/`onCheckedChange`, `onCommit`, overlays `open`/`onOpenChange(open, reason)`, `variant`/`size`/`tone`/`layout`, `disabled` vs `loading`/`pending`, shared callback sets, `now`/`timezone`), Wiring into web, Focus hooks, **Conventions** (l.401+): tokens for paint and time ("no hex, `rgb()` or `color-mix()` of a token, no raw `ms`"; one-off px with a comment citing §4; class names `tl-<component>` / `tl-<component>--<modifier>`), weights never 501–599, heights `min-height`, explicit `.ts` extensions, CSP, icons, **Forced states** (write `:is(:hover, [data-force-state="hover"])`… pass unknown props to root; hover inside `@media (hover: hover)`), **Reduced motion per component** (both `@media (prefers-reduced-motion: reduce)` and `:root[data-reduced-motion]`), time, project colours, base.css utilities, tests (happy-dom vs Node), **Stories** (Czech fixtures; Default/variants/States; axe both themes; stories at 1280×900 and 402×874, docs 1280; titles exactly as DESIGN §7; wide grids use SplitStateGrid; allow-list), pickers vs sheets.

---

## 9. Storybook config (`ui/.storybook/`)

`main.ts`:
- `framework: "@storybook/react-vite"`; stories `../src/**/*.mdx`, `../src/**/*.stories.@(ts|tsx)`, `{ directory: "../../web/src", titlePrefix: "Screens", files: "**/*.stories.@(ts|tsx)" }`.
- addons: `@storybook/addon-docs`, `@storybook/addon-a11y`, `@storybook/addon-themes` (all 10.6.0 exact).
- `managerHead` injects `<style>`: sentence-case sidebar section headers (`text-transform: none !important`), sidebar icon colour, dark-chrome selected-row fill, keyed off `[data-tally-theme="dark"]` set by manager.ts.
- `typescript.reactDocgen: "react-docgen-typescript"` with `shouldExtractLiteralValuesFromEnum`, `shouldRemoveUndefinedFromOptional`, `savePropValueAsString`, `propFilter` excluding node_modules props.
- custom Vite post-plugin `docgenComponentsOnly()` guarding docgen's `displayName/__docgenInfo` assignments to functions or `$$typeof` objects (stops leaks onto plain object exports; a11y script checks for leaks).
- `features: { backgrounds: false, sidebarOnboardingChecklist: false, menuOnboardingChecklist: false }`; `core.disableTelemetry`; `viteFinal` merges `build.target/cssTarget = browserTarget`.

`manager.ts`: two `create()` themes (light/dark) built from `graphite` primitives + `fontFamily` + lockup brand image (dark lockup re-stroked); `addons.register("tally/theme")` listens to `SET_GLOBALS`/`GLOBALS_UPDATED`, swaps `api.setOptions({ theme })` and sets `document.documentElement.dataset.tallyTheme` — the Storybook chrome follows the Theme toolbar.

`preview.tsx`:
- imports `../src/styles/index.css`, `../src/storybook/storybook.css`, `../src/docs/docs.css`.
- Child-iframe globals propagation: an iframe preview inside a docs page copies `globals` from the parent URL.
- Decorators: `withThemeByDataAttribute({ themes: { Light: "light", Dark: "dark" }, defaultTheme: "Light", attributeName: "data-theme" })`, `withThemeNow` (sets `data-theme` synchronously at render because addon-themes waits up to 5 s for animations), `withReducedMotion` (toggles `data-reduced-motion` on `<html>`).
- `globalTypes.reducedMotion` toolbar `{ title: "Motion", icon: "accessibility", items: [{value:"full",title:"Full motion"},{value:"reduced",title:"Reduced motion"}], dynamicTitle: true }`; `initialGlobals: { reducedMotion: "full" }` (Theme global comes from addon-themes).
- parameters: `layout: "centered"`, `controls.matchers.color`, `a11y: { test: "error" }` (panel only; "Nothing runs it headless"), 8 viewport options (Mac menu bar 360×560, iPhone SE 320×568, iPhone 17 402×874, Pro Max 440×956, iPad mini 744×1133, iPad Air 820×1180, Desktop 1440×900, Desktop 1280×720), `docs: { toc: { headingSelector: "h2, h3" }, theme: docsLight, container: ThemedDocsContainer, components: { code: MdxCode } }`.
- `options.storySort.order`: `["Brand", ["Overview","Logo","App icons","Voice"], "Foundations", ["Colors","Typography","Spacing","Sizes and radii","Elevation and materials","Motion","Icons","Z-index and breakpoints"], "Components", ["Actions","Inputs","Pickers","Overlays","Feedback","Data display","Time","Reports","Shell"], "Patterns", [...9 flows], "Screens", [...], "Platforms"]`.
- `tags: ["autodocs"]`.

`ThemedDocsContainer.tsx` (96 lines): decorators don't run on MDX pages, so the container reads globals from the preview store or URL (`globals=theme:Dark;…`), subscribes to `GLOBALS_UPDATED`, sets `<html data-theme>` and `data-reduced-motion` in an effect, and switches `DocsContainer theme={dark ? docsDark : docsLight}` (themes built from token primitives).

---

## 10. Porting notes for Helm (observations, not decisions)
- Tally's strongest guarantees are: (a) byte-exact generated-file freshness via in-memory regeneration + formatter; (b) contrast table pinned in code (`spec`) with negative/optimality proofs; (c) real-Chrome axe over the static Storybook index in both themes with forced states as real renders; (d) an allow-list that fails when stale.
- Gaps Helm could close better: no raw-colour CSS lint guard; the DESIGN.md contrast table is hand-copied (could be generated or parsed); the full a11y run is not in CI.
- Helm today uses Playwright via its own `app` dependency and dev-Storybook browser tests; Tally's `a11y.ts` instead serves `storybook-static` with its own HTTP server and `index.json` enumeration, which avoids the dev-server reload hazards documented in Helm's AGENTS.md.
