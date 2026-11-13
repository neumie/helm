// Measured contrast (docs/design-system.md, section 2.9): every pair in packages/helm-ui/contrast-pairs.ts
// meets its need or is open under a named decision, every stored ratio is the measured one, every
// copied colour still matches its source file, and the spec's generated table is fresh. Fix the token,
// the pair list or the decision, never this test, when it fails; regenerate the table with
// `node --import tsx packages/helm-ui/scripts/contrast-table.ts`.
// CJS default-import pattern per the other app tests (app sources load as CommonJS under tsx).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import themePresetsModule from '../app/src/theme-presets.ts'
import {
	EXEMPT,
	NEED,
	OPEN,
	PALETTES,
	ROWS,
	SOURCES,
	measure,
	rowKey,
	spliceContrastTable,
} from '../packages/helm-ui/contrast-pairs.ts'
import { contrast, paint, resolveValue, truncate2 } from '../packages/helm-ui/contrast.ts'

type ThemePresetsModule = typeof import('../app/src/theme-presets.ts')
const { THEME_PRESETS } = themePresetsModule as unknown as ThemePresetsModule

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const files = new Map<string, string>()
const read = (path: string) => {
	const cached = files.get(path)
	if (cached !== undefined) return cached
	const text = readFileSync(join(ROOT, path), 'utf8')
	files.set(path, text)
	return text
}

const fails = (row: (typeof ROWS)[number]) => {
	const need = NEED[row.use]
	return need !== null && measure(row) < need
}

test('WCAG maths: black/white is 21:1, equal colours 1:1, #767676 on white passes 4.5 and #777777 does not', () => {
	const white = resolveValue([], '#ffffff')
	assert.equal(contrast(resolveValue([], '#000'), white), 21)
	assert.equal(contrast(white, white), 1)
	assert.equal(truncate2(contrast(resolveValue([], '#767676'), white)), 4.54)
	assert.equal(truncate2(contrast(resolveValue([], '#777777'), white)), 4.47)
})

test('colour resolution: color-mix with transparent is the tone at that alpha; var() resolves in its declaring scope', () => {
	const soft = resolveValue([{ '--a': '#4c9aff' }], 'color-mix(in srgb, var(--a) 15%, transparent)')
	assert.deepEqual({ ...soft, a: Number(soft.a.toFixed(6)) }, { r: 76, g: 154, b: 255, a: 0.15 })
	const mixed = resolveValue([], 'color-mix(in srgb, #ffffff 60%, #000000)')
	assert.equal(mixed.r, 153)
	assert.deepEqual(resolveValue([], 'rgb(255 255 255 / 8%)'), { r: 255, g: 255, b: 255, a: 0.08 })
	// A soft fill declared on :root keeps :root's tone even where a descendant scope changes the tone.
	const scopes = [
		{ '--t': '#000000', '--t-soft': 'color-mix(in srgb, var(--t) 15%, transparent)' },
		{ '--t': '#ffffff' },
	]
	assert.equal(paint(scopes, ['--t', '--t-soft']).r, 255 * 0.85)
	assert.throws(() => paint([{ '--x': 'rgba(0, 0, 0, 0.5)' }], ['--x']), /translucent/)
})

test('every stored ratio is the measured ratio (two decimals, truncated)', () => {
	const drift = ROWS.filter(row => truncate2(measure(row)).toFixed(2) !== row.ratio.toFixed(2)).map(
		row => `${rowKey(row)}: stored ${row.ratio.toFixed(2)}, measured ${truncate2(measure(row)).toFixed(2)}`,
	)
	assert.deepEqual(drift, [], 'update the row (and regenerate the spec table)')
})

test('pairs are unique and name known colours', () => {
	const keys = ROWS.map(rowKey)
	assert.deepEqual(
		keys.filter((key, i) => keys.indexOf(key) !== i),
		[],
	)
	for (const row of ROWS) assert.ok(Number.isFinite(measure(row)), rowKey(row))
})

test('every pair meets its need, is open under a decision, or is exempt by a ruling', () => {
	const explained = new Set([...OPEN, ...EXEMPT].map(rowKey))
	const unexplained = ROWS.filter(row => fails(row) && !explained.has(rowKey(row))).map(
		row => `${rowKey(row)} = ${truncate2(measure(row)).toFixed(2)} < ${NEED[row.use]}`,
	)
	assert.deepEqual(
		unexplained,
		[],
		'lift the colour, add an OPEN entry naming the decision that owns it, or an EXEMPT entry naming its ruling',
	)
})

test('no exempt entry is stale: each names a measured pair that still fails, once, and is not also open', () => {
	const rows = new Map(ROWS.map(row => [rowKey(row), row]))
	const unknown = EXEMPT.filter(entry => !rows.has(rowKey(entry))).map(rowKey)
	assert.deepEqual(unknown, [], 'exempt entries must name a row')
	const stale = EXEMPT.filter(entry => {
		const row = rows.get(rowKey(entry))
		return row !== undefined && !fails(row)
	}).map(rowKey)
	assert.deepEqual(stale, [], 'these pairs pass now: remove them from EXEMPT')
	const keys = EXEMPT.map(rowKey)
	assert.deepEqual(
		keys.filter((key, i) => keys.indexOf(key) !== i),
		[],
	)
	const openKeys = new Set(OPEN.map(rowKey))
	assert.deepEqual(
		keys.filter(key => openKeys.has(key)),
		[],
		'a pair is either open or exempt',
	)
})

test('exempt entries name rulings in the docs/design-system.md rulings table', () => {
	const spec = read('docs/design-system.md')
	for (const ruling of new Set(EXEMPT.map(entry => entry.ruling))) {
		assert.ok(spec.includes(`\n| ${ruling} | `), `ruling ${ruling} is not a row of the rulings table`)
	}
})

test('no open entry is stale: each names a measured pair that still fails', () => {
	const rows = new Map(ROWS.map(row => [rowKey(row), row]))
	const unknown = OPEN.filter(entry => !rows.has(rowKey(entry))).map(rowKey)
	assert.deepEqual(unknown, [], 'open entries must name a row')
	const stale = OPEN.filter(entry => {
		const row = rows.get(rowKey(entry))
		return row !== undefined && !fails(row)
	}).map(rowKey)
	assert.deepEqual(stale, [], 'these pairs pass now: remove them from OPEN')
	const keys = OPEN.map(rowKey)
	assert.deepEqual(
		keys.filter((key, i) => keys.indexOf(key) !== i),
		[],
	)
})

test('open entries name decisions that exist in the plan', () => {
	const plan = read('docs/plans/design-system/spec.md')
	for (const decision of new Set(OPEN.map(entry => entry.decision))) {
		assert.ok(plan.includes(`**${decision} `), `${decision} is not an open decision in the plan`)
	}
})

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ')
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The declarations of every CSS block opened by `opener` at a rule boundary, in file order. */
const parsedBlocks = new Map<string, Map<string, string>[]>()
function allBlockDeclarations(file: string, opener: string): Map<string, string>[] {
	const cacheKey = `${file}\n${opener}`
	const cached = parsedBlocks.get(cacheKey)
	if (cached) return cached
	const text = normalize(read(file).replace(/\/\*[\s\S]*?\*\//g, ''))
	const pattern = new RegExp(`(?:^|[{};>\`])\\s*${escapeRegExp(normalize(opener))}`, 'g')
	const blocks: Map<string, string>[] = []
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		const start = match.index + match[0].length
		const body = text.slice(start, text.indexOf('}', start))
		const out = new Map<string, string>()
		for (const declaration of body.split(';')) {
			const colon = declaration.indexOf(':')
			if (colon < 0) continue
			const property = declaration.slice(0, colon).trim()
			if (!out.has(property)) out.set(property, normalize(declaration.slice(colon + 1)))
		}
		blocks.push(out)
	}
	parsedBlocks.set(cacheKey, blocks)
	return blocks
}

/** The declarations of the first CSS block opened by `opener` at a rule boundary. */
function blockDeclarations(file: string, opener: string): Map<string, string> {
	const [first] = allBlockDeclarations(file, opener)
	assert.ok(first, `${file}: no block "${opener}"`)
	return first
}

function paletteValue(palette: keyof typeof PALETTES, key: string): string | undefined {
	const scopes = PALETTES[palette].scopes as readonly Readonly<Record<string, string>>[]
	for (let i = scopes.length - 1; i >= 0; i--) {
		const value = scopes[i]?.[key]
		if (value !== undefined) return value
	}
	return undefined
}

test('every copied colour matches its source declaration', () => {
	const drift: string[] = []
	for (const source of SOURCES) {
		const key = source.key ?? source.property
		const expected = source.expect ?? (source.palette === 'widget' ? undefined : paletteValue(source.palette, key))
		assert.ok(expected !== undefined, `${source.palette} has no ${key}`)
		const actual = blockDeclarations(source.file, source.block).get(source.property)
		if (actual !== normalize(expected)) {
			drift.push(`${source.file} ${source.block} ${source.property}: ${actual ?? 'missing'}, expected ${expected}`)
		}
	}
	assert.deepEqual(drift, [], 'update the palette in contrast-pairs.ts (and the rows), then regenerate')
})

/** Whether a declared value is a colour, resolving `var()` against the palette and the block itself. */
function isColour(scopes: readonly Readonly<Record<string, string>>[], block: Map<string, string>, value: string) {
	try {
		resolveValue([...scopes, Object.fromEntries(block)], value)
		return true
	} catch {
		return false
	}
}

test('a pinned block declares no colour token the palette does not copy, and opens only once', () => {
	const helmRoot = Object.keys(THEME_PRESETS.helm?.tokens ?? {})
	const pinned = new Map<string, { file: string; block: string; palette: string; copied: Set<string> }>()
	for (const source of SOURCES) {
		if (!source.property.startsWith('--')) continue
		const id = `${source.file} ${source.block}`
		const entry = pinned.get(id) ?? { ...source, copied: new Set<string>() }
		entry.copied.add(source.property)
		pinned.set(id, entry)
	}
	const problems: string[] = []
	for (const { file, block, palette, copied } of pinned.values()) {
		const blocks = allBlockDeclarations(file, block).filter(decls => [...decls.keys()].some(p => p.startsWith('--')))
		if (blocks.length !== 1) problems.push(`${file} ${block}: ${blocks.length} blocks declare tokens; keep one`)
		// tokens.css :root mirrors the preset (checked by the next test) besides the derived soft fills.
		const allowed = new Set([...copied, ...(file.endsWith('/tokens.css') && block === ':root {' ? helmRoot : [])])
		const scopes = palette === 'widget' ? PALETTES.helm.scopes : PALETTES[palette as keyof typeof PALETTES].scopes
		for (const decls of blocks) {
			for (const [property, value] of decls) {
				if (property.startsWith('--') && !allowed.has(property) && isColour(scopes, decls, value)) {
					problems.push(`${file} ${block}: ${property}: ${value} is a colour contrast-pairs.ts does not copy`)
				}
			}
		}
	}
	assert.deepEqual(problems, [], 'copy the token into its palette (and pin it in SOURCES), then measure its pairs')
})

test('the stylesheet :root the Remote and Review palettes inherit still equals the Helm preset', () => {
	const root = blockDeclarations('app/src/renderer/tokens.css', ':root {')
	const helm = THEME_PRESETS.helm?.tokens ?? {}
	const drift = Object.entries(helm)
		.filter(([token, value]) => root.has(token) && root.get(token) !== normalize(value))
		.map(([token, value]) => `${token}: tokens.css ${root.get(token)}, preset ${value}`)
	assert.deepEqual(drift, [])
})

test('the extension popup copies the app type family and writes no inline colour (§9 ruling 103)', () => {
	const root = blockDeclarations('app/src/renderer/tokens.css', ':root {')
	const popup = blockDeclarations('extension/src/popup.html', ':root {')
	assert.equal(popup.get('--font-ui'), root.get('--font-ui'))
	assert.doesNotMatch(
		read('extension/src/popup.ts'),
		/\.style\b/,
		'popup.ts sets status--ok / status--error, never a style',
	)
})

test('the measured-contrast table in docs/design-system.md is fresh', () => {
	const spec = read('docs/design-system.md')
	assert.equal(
		spliceContrastTable(spec),
		spec,
		'regenerate with node --import tsx packages/helm-ui/scripts/contrast-table.ts',
	)
})

test('the .select chevron data URI strokes the Helm --text-2 value (a token cannot reach inside the URI)', () => {
	const text2 = THEME_PRESETS.helm?.tokens['--text-2'] ?? ''
	const css = read('app/src/renderer/sidebar/sidebar.css')
	const start = css.indexOf('\n.select {')
	assert.ok(start >= 0, 'sidebar.css has no .select block')
	const block = css.slice(start, css.indexOf('}', start))
	const strokes = [...block.matchAll(/stroke='%23([0-9a-f]{6})'/gi)].map(match => `#${match[1]}`)
	assert.match(text2, /^#[0-9a-f]{6}$/)
	assert.deepEqual(strokes, [text2], 'the chevron stroke must be the --text-2 value')
})
