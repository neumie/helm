# Helm verification infrastructure audit (for an enforced design system)

Worktree: `/Users/jakubneumann/Documents/code/neumie/helm-wt/feat-design-system` (branch `feat/design-system`, clean).
All numbers below come from commands run on 2026-11-12. Nothing in the repo was edited.

---

## 0. Headline facts

| Fact | Value |
|---|---|
| CI | **None.** `.github/` contains only `FUNDING.yml`; `git log --all -- .github/workflows` is empty; no git hooks (`core.hooksPath` unset, no non-sample hooks, no husky). |
| Node test runner | `node --import tsx --test tests/**/*.test.ts` — 257 top-level `tests/*.test.ts` files, **2497** `test(` calls. |
| Playwright specs | **53** `*.spec.ts` in `app/browser-tests/` (+1 helper `remote-navigation.ts`), **625** `test(` calls, 21,336 lines. |
| Accessibility tooling | **No axe-core, no `@axe-core/playwright`, no `@storybook/addon-a11y`** in any of Helm's three `node_modules`. Zero browser-test hits for `contrast`/`luminance`/`wcag`/`axe`. |
| Visual regression | `toHaveScreenshot` used **0** times; `page.screenshot(` 88 hits in 21 files (artifacts only, written to `testInfo.outputPath`). |
| Biome | **1.9.4** installed (`^1.9.0` declared). No plugins/GritQL (Biome 2 feature). `noRestrictedImports` exists only as nursery with exact `paths` map. CSS **is** linted+formatted by Biome (22 tracked `.css` files). |
| `biome check .` today | **Fails**: 12 errors, 2 warnings (formatting in 4 files, import sorting in 3, `noControlCharactersInRegex` ×3, `noNoninteractiveTabindex` ×1, `noDelete` ×1, 2 unused suppressions). ~1.1 s wall. |
| stylelint | Not present anywhere. `postcss` 8.5.19 and `lightningcss` 1.32.0 are present in `app/node_modules` as **hard deps of vite 8.1.4** (usable without install). |
| Token mirror | `styles.css :root` vs `HELM_TOKENS` (app/src/theme-presets.ts): 54 TS keys, 64 `:root` props, **0 value mismatches, 0 missing**; 10 extra `:root`-only props. **No test enforces this mirror.** |
| sysbudget | **Not installed** (`which sysbudget` → not found; not in `~/.local/bin`). Repo `~/Documents/code/neumie/sysbudget` exists but README says **Deprecated / archived** (last commit 2026-10-10 "docs: deprecate sysbudget"). AGENTS.md still references it (lines 237-ish, 307, 325). |
| Port 6010 hazard | Right now a **Tally** Storybook (`tally-wt/fix-deliverables-add-and-link/ui`, pid 38290) listens on `*:6010`; `curl 127.0.0.1:6010/index.json` returns Tally's index. Helm's Playwright config uses `reuseExistingServer: !process.env.CI` on 6010 → `bun run test:browser` would silently run against Tally's Storybook. |

---

## 1. Test runners

### 1.1 Root `package.json` (`/package.json`)
```json
"test": "node --import tsx --test tests/**/*.test.ts",
"build": "node scripts/write-build-id.mjs && tsc",
"typecheck:contracts": "tsc -p tests/contracts/tsconfig.json",
"typecheck:all": "tsc --noEmit && npm run typecheck:contracts && npm --prefix app run typecheck && npm --prefix app run typecheck:storybook && npm --prefix extension run typecheck",
"lint": "biome check .",
"lint:fix": "biome check --write ."
```
devDependencies: `@biomejs/biome ^1.9.0` (installed 1.9.4), `playwright 1.62.1`, `tsx ^4.19.0` (4.21.0), `typescript ^5.8.0` (5.9.3), `jsqr 1.4.0`.

Glob detail: under `sh` (npm's shell) `tests/**/*.test.ts` expands to nothing (`sh -c 'echo tests/**/*.test.ts'` prints the literal), so the literal is passed to Node (v25.6.0), whose test runner globs it itself and matches all `tests/*.test.ts` (no `.test.ts` exists in subdirs `tests/contracts/`, `tests/fixtures/`, `tests/helpers/`). Keep the pattern quoted-or-literal; a shell with `globstar` would behave the same.

- `ls tests | wc -l` = 260 entries; `ls tests/*.test.ts | wc -l` = **257**.
- `grep -c "^\s*test(" tests/*.test.ts` sum = **2497**.
- **CSS-reading node tests already exist** (the pattern a token/CSS lint test should follow): 21 files under `tests/` reference a `.css'` path; design-focused ones read stylesheets with `readFileSync(new URL('../app/src/renderer/…css', import.meta.url))`:
  - `tests/helm-terminal-progress.test.ts:83` (styles.css)
  - `tests/helm-tab-groups-renderer.test.ts:11` (styles.css)
  - `tests/helm-background-terminals.test.ts:6` (styles.css)
  - `tests/helm-scrollbar-gutter.test.ts:5-6` (sidebar.css + styles.css)
  - `tests/helm-banner.test.ts:9` (sidebar.css)
  - `tests/helm-disclosure.test.ts:7` (detail-redesign.css)
  - `tests/helm-window-drag.test.ts:7` (styles.css)
  - `tests/helm-toast.test.ts:5-6` (styles.css + button.css)
  - `tests/helm-flat-group.test.ts:6` (sidebar.css)
- Convention (AGENTS.md / `tests/helm-appearance.test.ts:1-24`): app modules are CommonJS from Node's view → **default-import** the module then destructure (`import appearanceModule from '../app/src/renderer/appearance.ts'; const {...} = appearanceModule as AppearanceModule`). `tests/helm-appearance.test.ts` covers token resolution (`resolveTokens`, `termThemeFromTokens`, `THEME_PRESETS`) but **does not compare styles.css `:root` to `HELM_TOKENS`** (line 5 is only a comment).
- Timing: 5 CSS/appearance tests (`helm-appearance`, `helm-scrollbar-gutter`, `helm-toast`, `helm-flat-group`, `helm-banner`) = 23 tests, `duration_ms 583.9`, real 0.73 s.

### 1.2 Token mirror check I ran (scratch script, not committed)
Parsed `app/src/renderer/styles.css` first `:root { … }` block vs `THEME_PRESETS.helm.tokens`:
```
HELM_TOKENS keys 54 :root custom props 64
value mismatches 0
in TS not in :root 0
in :root not in TS 10 [--accent-soft, --success-soft, --warn-soft, --danger-soft, --neutral-soft,
                        --danger-strong, --font-ui, --font-mono, --left-width, --ui-scale]
```
Comments asserting the mirror: `app/src/renderer/styles.css:4-5` ("values here mirror helm/src/theme-presets.ts HELM_TOKENS (the canonical source)"), `app/src/theme-presets.ts:6` and `:18` (`const HELM_TOKENS: Record<string,string> = {`), `:141` (`helm: { name: 'Helm', tokens: HELM_TOKENS }`). Today in sync; nothing would catch drift.

### 1.3 Playwright (`app/playwright.config.ts`, full file)
```ts
import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
	testDir: './browser-tests',
	fullyParallel: false,
	use: { baseURL: 'http://127.0.0.1:6010', browserName: 'chromium', trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'node scripts/build-document-canvas.mjs && bunx storybook dev --ci -p 6010',
		url: 'http://127.0.0.1:6010',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
})
```
- Storybook dev is started on **6010** (dev script uses 6006). Before it, `build-document-canvas.mjs` regenerates the ignored `canvas-runtime.generated.ts`.
- `reuseExistingServer: !process.env.CI` — locally ANY server on 6010 is reused with no identity check. **Currently Tally's Storybook owns 6010** (see §0). A design-system gate should either use a distinct port, or verify identity (e.g. fetch `/index.json` and assert a known Helm story id such as `views-terminal-workspace--agent-dock-harness`).
- No `workers`, `timeout`, `retries`, `outputDir`, `reporter` set → defaults (workers = half CPUs, files run in parallel; `fullyParallel:false` serialises tests within a file; 30 s per-test timeout; `test-results/` output, ignored via `/app/test-results/` in `.gitignore`).
- `HELM_STORYBOOK_CACHE_DIR` is honoured in `app/.storybook/main.ts:15-18` (must be absolute, else throws) → sets Vite `cacheDir`. AGENTS.md: proof worktrees with symlinked deps must also set Storybook's `CACHE_DIR` (Storybook 10.5's bundled empathic cache helper). Current shared caches live in `/Users/jakubneumann/Documents/code/neumie/helm/app/node_modules/.cache/{jiti,sb-vite-plugin-externals,storybook}` (no `.vite` dir currently) — i.e. without these env vars a worktree run writes into the MAIN checkout's node_modules.
- `.storybook/main.ts` also allows `../../extension/dist/workbench.js` in `server.fs.allow` (extension widget proof bundle; build with `cd extension && node build-workbench.mjs`), and `staticDirs` maps `../node_modules/pdfjs-dist` → `/pdfjs`.
- `.storybook/preview.ts` imports the REAL CSS: `styles.css`, `sidebar/sidebar.css`, `sidebar/detail-redesign.css`, `./preview.css`; storySort `['Views', [...], 'Compositions', 'Primitives', '*']`; background options hard-code hex (`#141517` pane, `#1a1c1f` chrome, `#0f1113` well).
- Last recorded main-checkout run: `/Users/jakubneumann/Documents/code/neumie/helm/app/test-results/.last-run.json` = `{"status":"passed","failedTests":[]}` (4 Nov 11:12).

### 1.4 What browser specs assert (counts across 53 spec files + helper)
| Pattern | files | hits |
|---|---|---|
| `getByRole` | 50 | 1737 |
| `evaluate(` | 50 | 1309 |
| `toBeFocused` | 32 | 330 |
| `setViewportSize` | — | 272 |
| `aria` | 30 | 206 |
| `boundingBox(` (geometry) | 26 | 183 |
| `getComputedStyle` | 26 | 135 |
| `screenshot(` | 21 | 88 |
| `outputPath` | — | 60 |
| `toHaveCSS` | 11 | 39 |
| `font-size`/`fontSize` | 6 | 13 |
| `prefers-reduced-motion`/`reducedMotion` | 7 | 7 |
| `emulateMedia` | — | 7 |
| `toHaveScreenshot` | 0 | 0 |
| `contrast`/`luminance`/`wcag`/`axe` (case-insens.) | 0 | 0 |
| `ariaSnapshot`/`toMatchAriaSnapshot` | 0 | 0 (available in installed @playwright/test 1.62.0: `types/test.d.ts:252-255`) |
| `newCDPSession` | 2 files | 3 (`remote-workspace.spec.ts:567,697`, `remote-readability.spec.ts:66`) |

So specs assert **geometry** (bounding boxes, 44px targets e.g. `remote-composer.spec.ts:372-373,404-405,576-577` `toHaveCSS('width','44px')`), **computed styles/token equality** (e.g. `agent-dock.spec.ts:428-443` probes `var(--warn)` with a temp span and compares to the glyph colour; `agent-dock.spec.ts:839-849` `tokenColor()` helper; `:854-884` asserts dock background equals `#topbar`, `::before` edge `1px` + topbar border colour, transparent pane/row fills, font-family not Menlo/SF Mono), **focus/ARIA behaviour**, and reduced motion — but **no contrast ratio checks and no axe scans**.

Most-used story URLs (iframe ids): `views-helm-remote--information` (15), `views-helm-remote--browser-harness` (10), `views-terminal-workspace--agent-dock-harness` (6), `views-helm-remote--questions` (6), `views-sidebar--new-item-navigation` (5).

Per-file `test(` counts (top): `document-review.spec.ts` 77, `agent-dock.spec.ts` 62, `terminal-workspace.spec.ts` 30, `remote-workspace.spec.ts` 28, `document-review-passage-chat.spec.ts` 20, `signals.spec.ts` 20, `remote-information.spec.ts` 19, `remote-image-input.spec.ts` 19, `extension-widget.spec.ts` 17, `remote-composer.spec.ts` 17 … (total 625).

### 1.5 Storybook inventory
- 53 `*.stories.tsx` under `app/src/renderer`, **397** `export const <Story>` declarations.
- Main checkout has an old static build: `/Users/jakubneumann/Documents/code/neumie/helm/app/storybook-static/index.json` (9 Sep, 123 story entries) — stale relative to 397 exports; don't use it as an inventory source.
- No Storybook test-runner / vitest addon / interaction-test addon installed; Playwright drives `iframe.html?id=…&viewMode=story` directly.

---

## 2. Installed versions (resolved through the symlinks)

| Package | Location | Version |
|---|---|---|
| @biomejs/biome | root node_modules | 1.9.4 (+ `@biomejs/cli-darwin-arm64`) |
| playwright / playwright-core | root | 1.62.1 / 1.62.1 |
| typescript / tsx | root | 5.9.3 / 4.21.0 |
| storybook | app | 10.5.0 |
| @storybook/* | app | `builder-vite csf-plugin global icons react react-dom-shim react-vite` (react-vite/react/builder-vite 10.5.0). **No addon-a11y, addon-docs, addon-themes.** |
| @playwright/test, playwright, playwright-core | app | 1.62.0 |
| vite / esbuild / electron / react / typescript | app | 8.1.4 / 0.28.1 / 43.0.0 / 19.2.7 / 5.9.3 |
| postcss / lightningcss (+ `lightningcss-darwin-arm64`) | app (via vite deps) | 8.5.19 / 1.32.0 |
| esbuild / typescript / vite / solid-js | extension | 0.28.0 / **6.0.2** / 8.0.7 / 1.9.5 |
| postcss / lightningcss | extension | 8.5.9 / 1.32.0 |

`find` (maxdepth 6) of all three node_modules for `axe-core`, `stylelint`, `addon-a11y`: **none**; only `postcss`, `lightningcss`, `lightningcss-darwin-arm64`.

vite 8.1.4 `dependencies`: `lightningcss ^1.32.0, picomatch, postcss ^8.5.16, rolldown ~1.1.4, tinyglobby` → both CSS toolkits are guaranteed present as long as vite is. `require('lightningcss')` (from `app/`) exports `transform, transformStyleAttribute, bundle, bundleAsync, browserslistToTargets, composeVisitors, Features` — its **visitor API** can walk declarations/colors/lengths for a custom CSS lint without any install; postcss can do the same (`postcss.parse`).

### Playwright browsers
`~/Library/Caches/ms-playwright`: `chromium-1208, -1228, -1234, -1243` + matching `chromium_headless_shell-*`, `webkit-2359`, `ffmpeg-1011`, `mcp-chrome*`. Both root (1.62.1) and app (1.62.0) `browsers.json` want chromium **1234** (151.0.7922.34) → **installed**; no `playwright install` needed.

---

## 3. Biome 1.9.4 capabilities (from `node_modules/@biomejs/biome/configuration_schema.json`)

Current `/biome.json`: schema 1.9.0, organizeImports on, formatter (lineWidth 120, tabs), JS single quotes/asNeeded semicolons/arrowParentheses asNeeded, linter `recommended: true`, overrides disabling everything for `packages/helm-ask-user-question/**` except `remote-answers.ts`, `files.ignore` [dist, node_modules, .pi-subagents, helm.config.json, vigil.config.json, profiles.json, profiles, storybook-static, app/test-results, app/remote-dist].

- Top-level config keys: `$schema, assists, css, extends, files, formatter, graphql, javascript, json, linter, organizeImports, overrides, vcs` — **no `plugins`** key; `grit` appears 0 times → **GritQL plugins not available in 1.9.4** (Biome 2.x feature).
- `RestrictedImportsOptions` = `{ paths: { [name]: message } }` (exact module names only, no glob/`patterns`/`importNames`); rule lives in **nursery** (`nursery.noRestrictedImports`).
- `RestrictedGlobalsOptions` = `{ deniedGlobals: string[] }` (style).
- `noRestrictedTypes` (nursery).
- Nursery CSS-relevant rules available: `noDescendingSpecificity, noDuplicateCustomProperties, noDuplicateProperties, noMissingVarFunction, noUnknownPseudoClass, noUnknownPseudoElement, noUnknownTypeSelector, noValueAtRule, noIrregularWhitespace`; plus `useSortedClasses`, `useImportRestrictions` (package-private import restriction, no config), `noStaticElementInteractions`, `useAriaPropsSupportedByRole`, `useComponentExportOnlyModules`, `noProcessEnv`. Stable CSS rules incl. `noUnknownProperty`, `noUnknownUnit`, `noUnknownFunction`, `noImportantInKeyframe`. **No rule for "no raw color literal / must use var()" or "no inline style"** (`noInlineStyles` 0 hits). `noDangerouslySetInnerHtml` exists.
- CSS options: `css.linter.enabled`, `css.formatter.*`, `css.parser.{allowWrongLineComments, cssModules}`. Biome does process CSS today: `biome check $(git ls-files '*.css')` → "Checked 22 files", no diagnostics; `biome check .` → 949 files.
- Implication: in 1.9.4, design-system enforcement beyond exact-name import bans must be a **custom node test / script** (CSS via postcss/lightningcss already installed; TSX via the TypeScript compiler API already installed). Biome 2 would add GritQL plugins + `noRestrictedImports.patterns`, but that is a dependency upgrade (see §6).
- Reference: Tally uses Biome **2.5.14** with `style.noRestrictedImports.options.patterns[{group:["lucide-react","lucide-react/**"], message}]` + override `includes: ["ui/src/icons/**"]` (`/Users/jakubneumann/Documents/code/neumie/tally/biome.json`).

### Current lint state (baseline — a new gate must not be confused by these)
`biome check . --reporter=summary`: 12 errors, 2 warnings:
- format: `app/browser-tests/helm-open-pictures.spec.ts`, `app/src/terminal-placement.ts`, `app/src/terminal-warm.ts`, `src/remote/owned-start.ts`
- organizeImports: `src/remote/owned-start.ts`, `src/remote/runtime.ts`, `tests/remote-owned-start.test.ts`
- `noControlCharactersInRegex` ×3 (`app/src/agent-dock/reduce.ts:89:14`, `:89:21`, …), `noNoninteractiveTabindex` (`app/src/renderer/document-review/DocumentReview.tsx:2723:9`), `noDelete` (`tests/slack-web-api.test.ts:115:27`), `suppressions/unused` ×2 (`reduce.ts:87:2`, `DocumentReview.tsx:2718:9`); also `useExhaustiveDependencies` at `DocumentReview.tsx:59:2`.
- Wall time: 1.08 s (5.47 s user, ~530% CPU).

---

## 4. CI / Makefile

- `.github/`: `FUNDING.yml` only (`ls .github` and `git ls-files .github` both show just that file). **No workflows, ever** (`git log --all -- .github/workflows` empty). AGENTS.md's "macOS CI must execute it" (profile-switch attestation) refers to CI that doesn't exist in this repo.
- No pre-commit hooks of any kind.
- `/Makefile` targets: `install uninstall restart status logs build test check`.
  - `build: node_modules` → `npm run build`
  - `test: node_modules` → `npm run test`
  - `check: build` (backend build only — **no lint, no app/extension/storybook**)
  - `node_modules: package.json` → `npm install` (**dangerous in a worktree with symlinked node_modules** — `make build/test/check` will run `npm install` through the link whenever `package.json` is newer than the `node_modules` symlink target's mtime; the target is `make`-compared via the symlink).
- Documented pre-commit loop (AGENTS.md "Verification"): `npm run lint`, `make test`, `make check`, `npm run typecheck:all`; app: `bun run build`; extension: `node build.mjs`; Storybook/browser out of `make check` by design (design-system.md §7, lines 660-670).

---

## 5. Build scripts and generated-file patterns

### 5.1 `app/build.mjs` (142 lines) — esbuild 0.28.1
- Line 6: `await buildDocumentCanvas()` first (imports `./scripts/build-document-canvas.mjs`).
- `common = { bundle: true, sourcemap: 'inline', logLevel: 'warning' }` (line 8).
- Node CJS bundles: `src/main.ts → dist/main.cjs` (externals electron, node-pty, native zoom guard), `src/preload.ts`, `src/preload-run-context.ts`, `src/preload-document-review.ts`.
- **CSS** has no explicit loader config: esbuild's default `.css` handling — CSS imported from a JS entry is bundled into a sibling CSS file:
  - `src/renderer/renderer.ts` (IIFE, `outdir: 'dist'`, jsx automatic) → `dist/renderer.js` + **`dist/renderer.css`** (comment line 38: "CSS imports (xterm.css + styles.css) bundle into dist/renderer.css"). Imports: `renderer.ts:1 '@xterm/xterm/css/xterm.css'`, `:2 './styles.css'`; transitively `button.tsx:2 './button.css'`, `sidebar/SidebarRoot.tsx:18 './sidebar.css'` (which `@import "./detail-redesign.css"` at line 1), `sidebar/ScheduledRunsPage.tsx:2 './scheduled-runs.css'`. Linked by `src/renderer/index.html:10 <link rel="stylesheet" href="renderer.css">`.
  - `src/renderer/run-context-editor.tsx` (IIFE) → `dist/run-context-editor.css` (imports `./styles.css`, `./sidebar/sidebar.css`, `./run-context/run-context-editor.css`; `RunContextEditor.tsx:3 '@blocknote/ariakit/style.css'`), linked from `run-context-editor.html:11`.
  - Viewer (lines 82-103): ESM `splitting: true`, `target es2022`, entries `document-review` / `data-worker` / `image-worker` / `csv-worker` → `dist/viewer/assets/[name]`, chunks `[name]-[hash]`, `metafile: true`, plugin `helm-viewer-workers` swaps `/(data|image|csv)-worker-factory|pdf-assets$/` for sibling `*.built.ts`. CSS: `document-review.tsx:5-6` (styles.css, sidebar.css), `DocumentReview.tsx:49-50` (reading-width.css, document-review.css), viewer `*Viewer.tsx` import `./viewer.css`. `document-review.html` links only `assets/document-review.css` (lazy chunks' CSS is never linked — AGENTS: put every viewer style in `viewer.css` imported by eager `*Viewer.tsx`).
  - Copies: pdfjs worker/cmaps/fonts/3 wasm/ICC + licenses; `index.html`, `run-context-editor.html`, claude-remote cjs.
- 22 tracked `.css` files, 13,264 lines total; largest: `styles.css` 3969, `sidebar/sidebar.css` 2088, `remote/remote.css` 1744, `document-review/document-review.css` 1254, `open-prototype/chrome.css` 870, `viewer/viewer.css` 864. (open-prototype/* are story-only; excluded from app tsconfig.)
- `app/src/renderer/remote/entry.tsx:3-5` imports styles.css, sidebar.css, detail-redesign.css; `RemoteWorkspace.tsx:65 './remote.css'`.
- Extension CSS is **CSS-in-TS**: `extension/src/widget.styles.ts` (506 lines), not a `.css` file → a CSS-file-based linter will not see it.

### 5.2 `app/scripts/build-remote.mjs` (20 lines)
esbuild `src/renderer/remote/entry.tsx` → `remote-dist/remote.js` (esm, minify, no sourcemap; CSS emitted as `remote-dist/remote.css`), copies 5 PWA assets, writes inline `index.html` linking `/remote.css`. Output dir ignored (`/app/remote-dist/`).

### 5.3 `app/scripts/build-document-canvas.mjs` (27 lines) — the generator template
```js
export async function buildDocumentCanvas() {
	const result = await build({ entryPoints: [...canvas-worker.ts], bundle: true, write: false, platform: 'browser',
		format: 'iife', globalName: 'HelmReviewCanvasWorker', target: 'es2022', minify: true,
		define: { 'process.env.NODE_ENV': '"production"' } })
	const source = result.outputFiles[0].text
	await writeFile(new URL('../src/renderer/document-review/canvas-runtime.generated.ts', import.meta.url),
		`// Generated by build-document-canvas.mjs; do not edit.\nexport const reviewCanvasWorkerSource: string = ${JSON.stringify(source)}\n`)
	return source
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDocumentCanvas()
```
Pattern: exported function + "run when invoked directly" guard; output `.generated.ts` is **gitignored** (`/.gitignore`: `/app/src/renderer/document-review/canvas-runtime.generated.ts`) with a **tracked `.d.ts` stub** (`canvas-runtime.generated.d.ts`: `export declare const reviewCanvasWorkerSource: string`). Invoked from: `app/build.mjs:6`, `app/package.json` `typecheck`, `typecheck:storybook`, `storybook`, `storybook:build`, and the Playwright `webServer.command`.

### 5.4 `scripts/write-build-id.mjs` (42 lines)
Computes `git rev-parse --short=12 HEAD` + sha256 of `git diff --binary HEAD` (excluding both generated files) + untracked files → writes identical `export const HELM_BUILD_ID = '…'` into `src/build-id.generated.ts` and `app/src/build-id.generated.ts` (both gitignored); tracked stubs `src/build-id.generated.d.ts`, `app/src/build-id.generated.d.ts` (`/** Generated implementation is created before build by scripts/write-build-id.mjs. */ export declare const HELM_BUILD_ID: string`). Invoked by root `build`. Fallback `'development'` with no `.git`.

`git ls-files | grep generated` → only the three `.d.ts` stubs. In this fresh worktree none of the `.generated.ts` implementations exist yet.

### 5.5 `*.built.ts` swap modules (tracked)
`app/src/renderer/viewer/{csv,data,image}-worker-factory.built.ts`, `pdf-assets.built.ts` — tracked alternates the esbuild plugin substitutes at build time (not generated).

### 5.6 Extension
- `extension/build.mjs` (32 lines): **rollup** (not esbuild) + `@rollup/plugin-node-resolve` + `@rollup/plugin-babel` with `@babel/preset-typescript` + `babel-preset-solid {generate:'dom'}` → `dist/content.js`, `dist/popup.js` (iife); copies manifest + popup.html.
- `extension/build-workbench.mjs` (21 lines): same toolchain, `src/widget-workbench.tsx` → `dist/workbench.js` (es) for the app Storybook / `extension-widget.spec.ts`.

### 5.7 Freshness patterns: what exists vs what a token generator needs
- Helm's two existing generators **regenerate on every build/typecheck/storybook run** and never commit outputs → no freshness test is needed for them, but every consumer script has to call the generator first (5 call sites for canvas).
- A token generator emitting CSS consumed by esbuild/Storybook could follow either:
  (a) Helm style: gitignored `*.generated.css/.ts` + tracked `.d.ts` stub + generator invoked by `build`, `typecheck`, `storybook`, `storybook:build`, Playwright `webServer.command` (and the root/app build chain); or
  (b) Tally style (`/Users/jakubneumann/Documents/code/neumie/tally/ui/scripts/tokens.test.ts:1-16`): commit generated files and add a freshness test that regenerates in memory and `expect(committed).toBe(files[path])` ("Fix a failure with `npm run tokens`"). In Helm that would be a `tests/*.test.ts` node test — it runs in `npm test` with no build prerequisite, which (a) cannot offer. (b) also keeps `styles.css` readable for first paint, which AGENTS.md requires (the `:root` mirror exists "only for pre-JS first paint").

---

## 6. node_modules are symlinks — getting axe-core etc. without installing

Symlinks:
```
node_modules           -> /Users/jakubneumann/Documents/code/neumie/helm/node_modules
app/node_modules       -> /Users/jakubneumann/Documents/code/neumie/helm/app/node_modules
extension/node_modules -> /Users/jakubneumann/Documents/code/neumie/helm/extension/node_modules
```
AGENTS.md forbids installs through those links. Findings:

1. **npm cache has axe-core 4.13.0 tarball**: index `~/.npm/_cacache/index-v5/a4/6b/440e26…`, key `make-fetch-happen:request-cache:https://registry.npmjs.org/axe-core/-/axe-core-4.13.0.tgz`, integrity `sha512-UzGt8zg7Ny8djbYMhxl2zuEevVa7r2gJjYY5Lwr1xM7+XU2nd6CkIWFTVcCIbAP63vSz71NaVyyuSk9lHKcy0A==`, size 627,805; content blob present at `~/.npm/_cacache/content-v2/sha512/53/31/adf3383b…a732d0`; `tar -tzf` lists `package/axe.min.js`, `package/LICENSE`, `package/LICENSE-3RD-PARTY.txt`, `package/package.json`. License **MPL-2.0**.
   - Also cached: `@storybook/addon-a11y-10.6.0.tgz` (but Helm's Storybook is **10.5.0**; Storybook addons must match core version → not drop-in), `@biomejs/biome` 2.5.14 / 2.5.15 and `cli-darwin-arm64` 2.5.14 / 2.5.15 (+ 1.9.4). Bun cache `~/.bun/install/cache` has `@biomejs/biome@2.4.14` + cli; **no axe-core in bun cache**. **No `@axe-core/playwright`, no stylelint** in any cache.
2. **Installed copies on disk**: `/Users/jakubneumann/Documents/code/neumie/tally/node_modules/axe-core` (4.13.0, `axe.min.js` 580,491 bytes), `tally-wt/fix-deliverables-add-and-link/node_modules/axe-core`, and a stale crane-rental copy. Pointing Helm at another repo's node_modules would be fragile cross-repo coupling.
3. **Playwright bundles no axe.** It does ship `locator.ariaSnapshot()` / `expect(locator).toMatchAriaSnapshot()` (1.62) and CDP sessions (`page.context().newCDPSession(page)`, already used in 3 places) — CDP `Accessibility.getFullAXTree` gives roles/names without axe, but not WCAG contrast rules.
4. **Viable no-install routes**, in order of robustness:
   - **Vendor `axe.min.js`** (4.13.0, from the npm-cache tarball, sha512 verifiable against the integrity above) into the repo (e.g. `app/browser-tests/vendor/axe-core-4.13.0/axe.min.js` + `LICENSE`), record it in `THIRD_PARTY_NOTICES.md` (MPL-2.0 file-level copyleft: unmodified file with its license is fine), and inject with `page.addScriptTag({ path })` / `frame.addScriptTag({ path })` then `page.evaluate(() => axe.run(...))` — exactly Tally's approach (`tally/ui/scripts/a11yScan.ts:33-35` `await frame.addScriptTag({ path: axePath })`, then `window.axe.run({include:['body'], exclude}, {iframes:false, …})`, failing when `window.axe` is missing). ~580 KB tracked file; no dependency/lockfile change; works in Storybook iframe (`/iframe.html?id=…`) since Playwright tests already navigate there directly.
   - Offline install into a **scratch/non-linked prefix** (`npm install --offline --prefix <scratch> axe-core@4.13.0` resolves from cacache) and pass the absolute path via env (e.g. `HELM_AXE_PATH`) — keeps the repo clean but is not reproducible for others.
   - Proper devDependency added in the **main checkout** by the operator (owner of the shared node_modules), not from this worktree.
   - Contrast without axe: compute WCAG ratios in-test from `getComputedStyle` colours (specs already resolve tokens via probe spans, `agent-dock.spec.ts:428-443`, `:839-849`), or offline in a node test from `HELM_TOKENS` pairs (no browser needed).
5. **CSS linting without install**: `postcss` 8.5.19 and `lightningcss` 1.32.0 already resolve from `app/` (hard deps of vite). A node test under `tests/` importing from `../app/node_modules/postcss` would work, but a plain regex/`postcss.parse` scan from root needs `app/node_modules` resolution (root `node_modules` has neither). The TypeScript compiler API (root `typescript` 5.9.3) is available for TSX inline-style / import scanning.

---

## 7. tsconfig layout

| tsconfig | include | notes |
|---|---|---|
| `/tsconfig.json` | `src` | ES2022, Node16 module/resolution, strict, `rootDir: src`, emits `dist` + d.ts. `src/` can never import `app/src/*`. |
| `/app/tsconfig.json` | `src` | ES2022, ESNext/Bundler, DOM libs, `jsx: react-jsx`, `noEmit`, `verbatimModuleSyntax`, **`noUncheckedIndexedAccess`**; **excludes** `src/**/*.stories.tsx` and `src/renderer/open-prototype/**`. |
| `/app/.storybook/tsconfig.json` | `./*.ts`, `../src/renderer/**/*.stories.tsx`, `../src/renderer/helm-window.d.ts` | `extends ../tsconfig.json`, `exclude: []` (`typecheck:storybook`). |
| `/extension/tsconfig.json` | `src` | ES2022, ESNext/bundler, `jsx: preserve`, `jsxImportSource: solid-js`; checked with extension's **TypeScript 6.0.2**. |
| `/tests/contracts/tsconfig.json` | `maintenance.ts`, `../../extension/src/chrome.d.ts` | bundler resolution; `maintenance.ts` (31 lines) is compile-time DTO parity: `type Assert<T extends true>`, `Compatible<A,B>` over `src/items/contract.ts` vs `app/src/shared-helm.ts` vs `extension/src/api.ts`, plus `src/signals/contract.ts`. Good template for a compile-time "token name set" parity assertion. |
| `packages/helm-remote-bridge/tsconfig.json`, `packages/helm-document-review/tsconfig.json` | `index.ts` | extend root. |

**Gaps:** `tests/*.test.ts` and `app/browser-tests/*.spec.ts` are **not covered by any tsconfig** (tsx and Playwright strip types) — type errors in tests/specs are never reported by `typecheck:all`.

---

## 8. Timings and `sysbudget`

Measured (light commands only):
- `biome check .`: 1.08 s wall (949 files).
- root `tsc --noEmit`: 5.63 s real.
- `tsc -p tests/contracts/tsconfig.json`: 1.99 s real.
- 5 CSS/appearance node test files: 0.73 s real (23 tests).
Not measured (heavy, not run): full `npm test` (257 files / 2497 tests), app build, Storybook dev cold start (Playwright gives it 120 s), full browser suite (625 tests). AGENTS.md hint (≈line 237, "Finish builds before dev-Storybook browser gates"): "a 15-minute preview expired mid-suite and all later tests failed with `ERR_CONNECTION_REFUSED`" → the serial full browser gate takes **longer than 15 minutes**.

`sysbudget`:
- AGENTS.md mentions it (2 occurrences: Document Review CLI proof note ≈ line 307 "real CLI fixture needs a response deadline that includes multiple actual Node/tsx startups under sysbudget (30s)"; ≈ line 325 "Owned proof previews are services, not CPU batches … Do not reserve a long-lived `sysbudget` CPU lease for Storybook … CPU builds/tests/bundles still use `sysbudget`").
- `which sysbudget` → **not found**; not in `~/.local/bin`; no config dirs.
- Source repo `/Users/jakubneumann/Documents/code/neumie/sysbudget`: README "**Deprecated:** sysbudget is no longer maintained or supported. This repository is archived"; uninstall via `./scripts/uninstall.sh --purge`. Historical usage: `sysbudget run -n 2 -- make -j`, `sysbudget run -n 1 --label docs -- …`, `--class background`, `status [--watch]`, `release <id>`, `gc`, `doctor`; default config 4 vCPU reserved, group `shared` capacity 6 / default request 2 / max 3.
- → AGENTS.md's sysbudget guidance is **stale**; a new gate should not depend on it.

---

## 9. Implications for an enforced design system (infra-only)

1. **Where enforcement can run today with zero installs**: node tests in `tests/` (runs in `npm test`, ~sub-second for CSS scans) reading CSS via `readFileSync` (existing pattern) and parsing with regex or postcss/lightningcss resolved from `app/node_modules`; TS compiler API from root for TSX scans; compile-time parity in `tests/contracts/maintenance.ts`.
2. **Token mirror test** (styles.css `:root` ⇔ `HELM_TOKENS`) is missing and trivially addable; today it passes (0 mismatches, 10 intentional `:root`-only props to allowlist).
3. **Biome 1.9.4 cannot express design rules** (no plugins, no import patterns, no raw-colour rule). Upgrading to Biome 2.x (tarballs cached: 2.5.14/2.5.15) is a dependency + config migration (`include`→`includes`, `organizeImports`→`assist`), must be done in the main checkout, and the current lint baseline already fails (12 errors) — fix or baseline first.
4. **Browser a11y/contrast**: no axe anywhere in Helm deps; vendoring `axe.min.js` 4.13.0 from the npm cache + `addScriptTag` (Tally pattern) is the cleanest no-install path. Chromium 1234 is installed.
5. **Gate isolation**: change/verify the Playwright Storybook port (6010 currently serves Tally), set absolute `HELM_STORYBOOK_CACHE_DIR` + `CACHE_DIR`, and give each run distinct `outputDir`/reporter paths (AGENTS.md).
6. **No CI** → "enforced" means `npm test`/`npm run lint`/`typecheck:all` discipline (or adding a workflow / hook later); `make check` only builds the backend and `make` targets may trigger `npm install` through the symlink.
7. Generated-token outputs should follow either the existing ignored-`.generated.ts` + tracked `.d.ts` + generator-in-every-script pattern, or a committed-output + freshness-test pattern (Tally); the latter fits `npm test` and the first-paint `:root` requirement better.
