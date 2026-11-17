// The token pipeline (docs/design-system.md, section 2.8; plan stage S2). packages/helm-ui/tokens is the only place a
// token value is written; `npm run tokens:write` copies it into every surface. This test holds:
// - every generated copy is byte-fresh (change values in the source, then run the generator);
// - the values every surface resolves equal the snapshot taken before S2 (tests/fixtures/design-tokens-before-s2.json),
//   so the move changed no pixel; S2 only added tokens, listed below with the literals they replaced; the values a
//   ruling changed since are listed below too (RULED_SINCE_S2);
// - every var(--x) a production source uses is defined somewhere;
// - a theme file can set only the theme token names.
// App modules load as CommonJS under tsx (default-import pattern); packages/helm-ui is an ES module (named imports).
// The section sign is escaped in this file so it cites no section itself.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import backgroundsModule from '../app/.storybook/backgrounds.generated.ts'
import type * as BackgroundsTypes from '../app/.storybook/backgrounds.generated.ts'
import designTokensModule from '../app/src/design-tokens.generated.ts'
import type * as DesignTokensTypes from '../app/src/design-tokens.generated.ts'
import tabGroupColorsModule from '../app/src/tab-group-colors.ts'
import type * as TabGroupColorsTypes from '../app/src/tab-group-colors.ts'
import themeFilesModule from '../app/src/theme-files.ts'
import type * as ThemeFilesTypes from '../app/src/theme-files.ts'
import themePresetsModule from '../app/src/theme-presets.ts'
import type * as ThemePresetsTypes from '../app/src/theme-presets.ts'
import * as lint from '../packages/helm-ui/lint.ts'
import { BEGIN, END, TARGETS } from '../packages/helm-ui/tokens/generate.ts'
import { GROUP_COLORS, HELM_TOKENS, ROOT_TOKENS, THEME_TOKEN_NAMES } from '../packages/helm-ui/tokens/index.ts'

type Backgrounds = typeof BackgroundsTypes
type DesignTokens = typeof DesignTokensTypes
type TabGroupColors = typeof TabGroupColorsTypes
type ThemeFiles = typeof ThemeFilesTypes
type ThemePresets = typeof ThemePresetsTypes
const { BACKGROUNDS } = backgroundsModule as unknown as Backgrounds
const { EASINGS, MOTION_MS, WINDOW_BACKGROUNDS } = designTokensModule as unknown as DesignTokens
const { TAB_GROUP_COLORS } = tabGroupColorsModule as unknown as TabGroupColors
const { readThemeFile } = themeFilesModule as unknown as ThemeFiles
const { THEME_PRESETS, PRESET_EARLIER_VALUES } = themePresetsModule as unknown as ThemePresets

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

type Pairs = [string, string][]
const SNAPSHOT = JSON.parse(read('tests/fixtures/design-tokens-before-s2.json')) as {
	root: Pairs
	presets: Record<string, { name: string; tokens: Record<string, string> }>
	presetEarlierValues: Record<string, Record<string, string[]>>
	extensionHost: Pairs
	popupRoot: Pairs
	storybookBackgrounds: Record<string, { name: string; value: string }>
	remote: { manifest: [string, string]; themeColorMeta: string; offlineRoot: Pairs }
	nativeBackgrounds: { main: string; runContext: string; reviewDark: string; reviewLight: string }
	selectChevronStroke: string
	reviewLight: Pairs
}

/**
 * Preset values a ruling changed after S2 (the D15 picks: ruling 110 the High contrast thumb, 111 the Helm bright
 * black, 112 the Helm danger and neutral tones). The snapshot plus these changes is what every copy must hold; each
 * replaced value is also a preset's earlier value, and the extension copies follow under their own names.
 */
const RULED_SINCE_S2: Record<string, Record<string, string>> = {
	helm: { '--danger': '#f46e70', '--neutral': '#969ba3', '--ansi-bright-black': '#767c86' },
	'high-contrast': { '--thumb': 'rgba(255, 255, 255, 0.36)', '--thumb-hover': 'rgba(255, 255, 255, 0.5)' },
}
const WIDGET_NAMES: Record<string, string> = { '--vg-red': '--danger', '--vg-gray': '--neutral' }
const OFFLINE_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif'

function ruled(snapshot: typeof SNAPSHOT): typeof SNAPSHOT {
	const helm = RULED_SINCE_S2.helm ?? {}
	const patch = (pairs: Pairs, names: Record<string, string> = {}): Pairs =>
		pairs.map(([name, value]) => [name, helm[names[name] ?? name] ?? value])
	const presets = Object.fromEntries(
		Object.entries(snapshot.presets).map(([id, preset]) => [
			id,
			{ ...preset, tokens: { ...preset.tokens, ...(RULED_SINCE_S2[id] ?? {}) } },
		]),
	)
	const presetEarlierValues = Object.fromEntries(
		Object.entries(snapshot.presetEarlierValues).map(([id, earlier]) => {
			const next = { ...earlier }
			for (const name of Object.keys(RULED_SINCE_S2[id] ?? {})) {
				const before = snapshot.presets[id]?.tokens[name]
				if (before !== undefined) next[name] = [...(next[name] ?? []), before]
			}
			return [id, next]
		}),
	)
	return {
		...snapshot,
		root: patch(snapshot.root),
		presets,
		presetEarlierValues,
		extensionHost: patch(snapshot.extensionHost, WIDGET_NAMES),
		popupRoot: patch(snapshot.popupRoot),
		// §9 ruling 117: the offline page's :root also carries the UI family its type steps are set in.
		remote: { ...snapshot.remote, offlineRoot: [...snapshot.remote.offlineRoot, ['--font-ui', OFFLINE_FONT]] },
	}
}
const BEFORE = ruled(SNAPSHOT)

/** Font stacks were written with single quotes in places before S2; the generator writes double quotes. */
const same = (value: string) => value.replace(/'/g, '"')
const record = (pairs: Pairs) => Object.fromEntries(pairs.map(([name, value]) => [name, same(value)]))

/** Every declaration of `selector` in a stylesheet, in order. */
function cssBlock(file: string, selector: string): Pairs {
	return lint
		.parseCss(read(file))
		.filter(d => d.selector === selector)
		.map(d => [d.property, d.value] as [string, string])
}

/** The `name: value;` lines between a file's tokens:begin / tokens:end markers. */
function region(file: string): Pairs {
	const text = read(file)
	const body = text.slice(text.indexOf(BEGIN) + BEGIN.length, text.indexOf(END))
	return [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1] ?? '', (m[2] ?? '').trim()] as [string, string])
}

/**
 * The tokens S2 added, each with the literal it replaced (`--motion-state` was used with a 140ms fallback; the z and
 * motion values are the literals of sections 2.5 and 2.7; `--paper` is the PDF paper white), plus the tokens a later
 * ruling added at the literals it replaced. Nothing else may be new.
 */
const ADDED_IN_S2: Record<string, string> = {
	'--motion-exit': '120ms',
	'--motion-state': '140ms',
	'--motion-enter': '150ms',
	'--motion-pulse': '1.6s',
	'--motion-arrival': '1.4s',
	'--motion-resting': '4.8s',
	'--motion-activity': '1s',
	'--motion-activity-waiting': '0.9s',
	'--motion-activity-breathe': '1.8s',
	'--ease-out': 'ease-out',
	'--ease-linear': 'linear',
	'--ease-ambient': 'ease-in-out',
	'--z-under': '-1',
	'--z-content': '0',
	'--z-local-1': '1',
	'--z-local-2': '2',
	'--z-local-3': '3',
	'--z-local-4': '4',
	'--z-bar': '10',
	'--z-menu': '40',
	'--z-sheet': '60',
	'--z-toast': '100',
	'--z-widget-host': '2147483647',
	'--paper': '#fff',
	// §9 ruling 123 (D19 Remote entrances B): the large-surface entrance, at the values Remote's drawer and sheet had.
	'--motion-enter-large': '180ms',
	'--ease-enter-large': 'cubic-bezier(0.22, 1, 0.36, 1)',
}
const ADDED_TO_WIDGET: Record<string, string> = {
	'--vg-motion-exit': '120ms',
	'--vg-motion-state': '140ms',
	'--vg-motion-enter': '150ms',
	'--vg-motion-pulse': '1.6s',
	'--vg-ease-out': 'ease-out',
	'--vg-ease-ambient': 'ease-in-out',
	'--vg-z-menu': '40',
	'--vg-z-widget-host': '2147483647',
}

/** `before` holds exactly the same values in `after`, which may add only `added`. */
function assertKeepsValues(after: Pairs, before: Pairs, added: Record<string, string>, where: string) {
	const now = record(after)
	assert.deepEqual(
		Object.fromEntries(Object.keys(record(before)).map(name => [name, now[name]])),
		record(before),
		`${where}: a value changed`,
	)
	const extra = Object.fromEntries(Object.entries(now).filter(([name]) => !(name in record(before))))
	assert.deepEqual(extra, added, `${where}: only the S2 tokens are new, at the literals they replaced`)
}

test('every generated token copy is fresh (edit packages/helm-ui/tokens, then run npm run tokens:write)', () => {
	const stale = TARGETS.filter(target => {
		let current: string | null = null
		try {
			current = read(target.file)
		} catch {}
		return target.render(current) !== current
	}).map(target => target.file)
	assert.deepEqual(stale, [])
})

test('the app :root keeps every value it had before S2 and adds only the z, motion and paper tokens', () => {
	assertKeepsValues(cssBlock('app/src/renderer/tokens.css', ':root'), BEFORE.root, ADDED_IN_S2, 'tokens.css :root')
	for (const [name, value] of Object.entries(ADDED_IN_S2)) assert.equal(ROOT_TOKENS[name], value, name)
})

test('the theme presets and their earlier values are the ones before S2', () => {
	assert.deepEqual(JSON.parse(JSON.stringify(THEME_PRESETS)), BEFORE.presets)
	assert.deepEqual(JSON.parse(JSON.stringify(PRESET_EARLIER_VALUES)), BEFORE.presetEarlierValues)
	// Key order is the theme file main writes, so the seeded-file fingerprints stay valid.
	assert.deepEqual(Object.keys(THEME_PRESETS.helm?.tokens ?? {}), Object.keys(BEFORE.presets.helm?.tokens ?? {}))
})

test('the extension widget and popup copies keep their values', () => {
	assertKeepsValues(region('extension/src/widget.styles.ts'), BEFORE.extensionHost, ADDED_TO_WIDGET, 'widget :host')
	assertKeepsValues(region('extension/src/popup.html'), BEFORE.popupRoot, {}, 'popup :root')
})

test('the Review light palette keeps its values', () => {
	assertKeepsValues(
		cssBlock('app/src/renderer/document-review/document-review.css', '.document-review[data-review-theme="light"]'),
		BEFORE.reviewLight,
		{},
		'Review light',
	)
})

test('Storybook, the Remote PWA, the native windows and the select chevron keep their colours', () => {
	assert.deepEqual(JSON.parse(JSON.stringify(BACKGROUNDS)), BEFORE.storybookBackgrounds)
	const manifest = JSON.parse(read('app/assets/remote/manifest.webmanifest')) as Record<string, string>
	assert.deepEqual([manifest.background_color, manifest.theme_color], BEFORE.remote.manifest)
	assert.equal(
		read('app/scripts/build-remote.mjs').match(/<meta name="theme-color" content="([^"]*)">/)?.[1],
		BEFORE.remote.themeColorMeta,
	)
	const offline = read('app/assets/remote/remote-sw.js').match(/<style>:root\{([^}]*)\}/)?.[1] ?? ''
	assert.deepEqual(
		offline.split(';').map(pair => pair.split(':') as [string, string]),
		BEFORE.remote.offlineRoot,
	)
	assert.deepEqual(
		{ dark: WINDOW_BACKGROUNDS.dark, reviewLight: WINDOW_BACKGROUNDS.reviewLight },
		{ dark: BEFORE.nativeBackgrounds.main, reviewLight: BEFORE.nativeBackgrounds.reviewLight },
	)
	assert.equal(BEFORE.nativeBackgrounds.runContext, BEFORE.nativeBackgrounds.main)
	assert.equal(BEFORE.nativeBackgrounds.reviewDark, BEFORE.nativeBackgrounds.main)
	// The native windows read the generated values, never a literal.
	assert.match(read('app/src/main.ts'), /backgroundColor: WINDOW_BACKGROUNDS\.dark/)
	assert.match(read('app/src/run-context-window.ts'), /backgroundColor: WINDOW_BACKGROUNDS\.dark/)
	assert.match(read('app/src/document-review/window.ts'), /REVIEW_LIGHT_BACKGROUND = WINDOW_BACKGROUNDS\.reviewLight/)
	const stroke = read('app/src/renderer/sidebar/sidebar.css').match(/stroke='(%23[0-9a-fA-F]{3,8})' stroke-width/)?.[1]
	assert.equal(decodeURIComponent(stroke ?? ''), BEFORE.selectChevronStroke)
})

test('script-driven motion keeps the durations and curves it had before S2', () => {
	// The tab drag FLIP and settle, and the swipe-back curves.
	assert.deepEqual({ ...MOTION_MS }, { dragFlip: 160, dragSettle: 180, dragPark: 140 })
	assert.deepEqual(
		{ ...EASINGS },
		{
			drag: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
			swipeCommit: 'cubic-bezier(0.16, 1, 0.3, 1)',
			swipeSpring: 'cubic-bezier(0.32, 0.72, 0, 1)',
		},
	)
})

test('the terminal group colours are the same list in the app and the token source', () => {
	assert.deepEqual([...TAB_GROUP_COLORS], [...GROUP_COLORS])
	for (const colour of GROUP_COLORS) assert.ok(`--group-${colour}` in HELM_TOKENS, `--group-${colour} is a theme token`)
})

test('every var(--x) a production source uses is defined', () => {
	const sources = lint.collectSources(ROOT)
	const defined = new Set<string>(Object.keys(ROOT_TOKENS))
	const used = new Map<string, Set<string>>()
	for (const source of sources) {
		const text = read(source.file)
		// A declaration (`--x:` in CSS, a `'--x':` style key) or a property set from script (`setProperty('--x'`,
		// a computed `['--x' as string]` key).
		for (const m of text.matchAll(/(--[\w-]+)\s*['"`]?\s*:/g)) defined.add(m[1] ?? '')
		for (const m of text.matchAll(/['"`](--[\w-]+)['"`]/g)) defined.add(m[1] ?? '')
		for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
			const name = m[1] ?? ''
			// `var(--group-${colour})` is built from GROUP_COLORS, checked above.
			if (name.endsWith('-')) continue
			used.set(name, (used.get(name) ?? new Set()).add(source.file))
		}
	}
	assert.ok(sources.length > 100, 'the production sources are found')
	const missing = [...used]
		.filter(([name]) => !defined.has(name))
		.map(([name, files]) => `${name}: ${[...files].join(', ')}`)
	assert.deepEqual(missing, [])
})

test('a theme file sets only theme token names; anything else in it is ignored', t => {
	assert.deepEqual([...THEME_TOKEN_NAMES], Object.keys(HELM_TOKENS))
	for (const preset of Object.values(THEME_PRESETS))
		for (const name of Object.keys(preset.tokens)) assert.ok(THEME_TOKEN_NAMES.includes(name as never), name)
	const dir = mkdtempSync(join(tmpdir(), 'helm-theme-names-'))
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const file = join(dir, 'mine.json')
	const tokens = { '--pane': '#101010', '--motion-state': '0ms', '--z-toast': '1', '--made-up': 'red', color: 'red' }
	writeFileSync(file, JSON.stringify({ name: 'Mine', tokens }))
	assert.deepEqual(readThemeFile(file), { id: 'mine', name: 'Mine', tokens: { '--pane': '#101010' } })
	writeFileSync(file, JSON.stringify({ name: 'Nothing known', tokens: { '--radius-md': '0' } }))
	assert.equal(readThemeFile(file), null, 'a file with no theme token is not listed')
})
