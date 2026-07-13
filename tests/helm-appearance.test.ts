// Appearance engine pure helpers (helm/src/renderer/appearance.ts): terminal
// font-size stepping/bounds, persisted-state normalization, and theme token
// resolution (preset ∪ theme ∪ overrides). CJS default-import pattern per the
// helm test convention.

import assert from 'node:assert/strict'
import test from 'node:test'
import appearanceModule from '../app/src/renderer/appearance.ts'
import themePresetsModule from '../app/src/theme-presets.ts'

type AppearanceModule = typeof import('../app/src/renderer/appearance.ts')
type ThemePresetsModule = typeof import('../app/src/theme-presets.ts')
const {
	TERM_FONT_DEFAULT,
	TERM_FONT_MAX,
	TERM_FONT_MIN,
	clampTermFont,
	normalizeAppearance,
	resolveTokens,
	stepTermFont,
	termThemeFromTokens,
} = appearanceModule as AppearanceModule
const { THEME_PRESETS, DEFAULT_THEME_ID } = themePresetsModule as ThemePresetsModule

test('terminal font size clamps to 9..24 and steps by 1', () => {
	assert.equal(clampTermFont(4), TERM_FONT_MIN)
	assert.equal(clampTermFont(99), TERM_FONT_MAX)
	assert.equal(clampTermFont(Number.NaN), TERM_FONT_DEFAULT)
	assert.equal(stepTermFont(13, 1), 14)
	assert.equal(stepTermFont(TERM_FONT_MAX, 1), TERM_FONT_MAX)
	assert.equal(stepTermFont(TERM_FONT_MIN, -1), TERM_FONT_MIN)
	assert.equal(stepTermFont(21, 0), TERM_FONT_DEFAULT) // cmd+0 resets
})

test('normalizeAppearance survives garbage and clamps persisted values', () => {
	const fromGarbage = normalizeAppearance('nonsense')
	assert.equal(fromGarbage.themeId, DEFAULT_THEME_ID)
	assert.equal(fromGarbage.termFontSize, TERM_FONT_DEFAULT)
	assert.equal(fromGarbage.uiScale, 1)
	assert.deepEqual(fromGarbage.overrides, {})

	const cleaned = normalizeAppearance({
		themeId: 'high-contrast',
		termFontSize: 240,
		uiScale: 3,
		overrides: { '--accent': '#ff0000', 'not-a-token': 'x', '--bad': 42 },
	})
	assert.equal(cleaned.themeId, 'high-contrast')
	assert.equal(cleaned.termFontSize, TERM_FONT_MAX)
	assert.equal(cleaned.uiScale, 1) // off-scale value falls back to Default
	// a non-token key poisons the map → dropped wholesale (never applied to :root)
	assert.deepEqual(cleaned.overrides, {})
})

test('resolveTokens layers theme over the Helm base and overrides over both', () => {
	const state = normalizeAppearance({ themeId: 'high-contrast', overrides: { '--accent': '#123456' } })
	const tokens = resolveTokens(state, [])
	assert.equal(tokens['--accent'], '#123456') // override wins
	assert.equal(tokens['--text-0'], THEME_PRESETS['high-contrast']?.tokens['--text-0']) // theme wins over base
})

test('a sparse custom theme backfills missing tokens from the Helm base', () => {
	const state = normalizeAppearance({ themeId: 'my-theme' })
	const tokens = resolveTokens(state, [{ id: 'my-theme', name: 'Mine', tokens: { '--term-bg': '#000022' } }])
	assert.equal(tokens['--term-bg'], '#000022')
	assert.equal(tokens['--ansi-red'], THEME_PRESETS[DEFAULT_THEME_ID]?.tokens['--ansi-red'])
})

test('an unknown themeId falls back to the cached tokens, then the Helm preset', () => {
	const cached = normalizeAppearance({ themeId: 'gone', themeTokensCache: { '--term-bg': '#111111' } })
	assert.equal(resolveTokens(cached, [])['--term-bg'], '#111111')
	const uncached = normalizeAppearance({ themeId: 'gone' })
	assert.equal(resolveTokens(uncached, [])['--term-bg'], THEME_PRESETS[DEFAULT_THEME_ID]?.tokens['--term-bg'])
})

test('termThemeFromTokens maps every --term-*/--ansi-* token onto the xterm theme', () => {
	const tokens = resolveTokens(normalizeAppearance(null), [])
	const theme = termThemeFromTokens(tokens)
	assert.equal(theme.background, tokens['--term-bg'])
	assert.equal(theme.cursor, tokens['--term-cursor'])
	assert.equal(theme.brightMagenta, tokens['--ansi-bright-magenta'])
	for (const value of Object.values(theme)) {
		assert.equal(typeof value, 'string')
		assert.ok(value.length > 0)
	}
})
