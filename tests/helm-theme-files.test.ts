// Theme preset files in <userData>/themes (app/src/theme-files.ts, docs/design-system.md §9 ruling 97): main
// writes missing preset files, rewrites untouched ones with the current presets, keeps files the user changed,
// never follows a symlink and never touches user themes. Every case runs in its own temp directory.

import assert from 'node:assert/strict'
import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import themeFilesModule from '../app/src/theme-files.ts'
import themePresetsModule from '../app/src/theme-presets.ts'

type ThemeFilesModule = typeof import('../app/src/theme-files.ts')
type ThemePresetsModule = typeof import('../app/src/theme-presets.ts')
const { SEED_RECORD, fingerprint, listThemes, presetFileContent, seedPresetFiles } =
	themeFilesModule as ThemeFilesModule
const { PRESET_EARLIER_VALUES, THEME_PRESETS } = themePresetsModule as ThemePresetsModule

const HC = THEME_PRESETS['high-contrast']
const HELM = THEME_PRESETS.helm
if (!HC || !HELM) throw new Error('bundled presets missing')

/** The ten tokens added to the presets after the operator's files were seeded on 2026-07-13 (44 of 54). */
const ADDED_LATER = [
	'--fill-strong',
	'--group-blue',
	'--group-purple',
	'--group-pink',
	'--group-red',
	'--group-orange',
	'--group-green',
	'--group-cyan',
	'--term-scroll-thumb',
	'--term-scroll-thumb-hover',
]

function themesDir(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), 'helm-themes-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return join(root, 'themes')
}

const fileOf = (preset: { name: string; tokens: Record<string, string> }) =>
	`${JSON.stringify({ name: preset.name, tokens: preset.tokens }, null, '\t')}\n`

function without(tokens: Record<string, string>, keys: string[]): Record<string, string> {
	return Object.fromEntries(Object.entries(tokens).filter(([key]) => !keys.includes(key)))
}

const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8')
const record = (dir: string) => JSON.parse(read(dir, SEED_RECORD)) as { version: number; files: Record<string, string> }

test('an empty themes directory gets both presets as owner-private files and their fingerprints', t => {
	const dir = themesDir(t)
	const report = seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES)
	assert.deepEqual(report, { written: ['helm', 'high-contrast'], kept: [] })
	assert.equal(read(dir, 'helm.json'), presetFileContent(HELM))
	assert.equal(read(dir, 'high-contrast.json'), presetFileContent(HC))
	for (const name of ['helm.json', 'high-contrast.json', SEED_RECORD])
		assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name)
	assert.deepEqual(record(dir), {
		version: 1,
		files: { helm: fingerprint(presetFileContent(HELM)), 'high-contrast': fingerprint(presetFileContent(HC)) },
	})
	// A second run changes nothing and leaves no temp files.
	assert.deepEqual(seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES), { written: [], kept: [] })
	assert.deepEqual(readdirSync(dir).sort(), [SEED_RECORD, 'helm.json', 'high-contrast.json'])
})

test('an untouched 44-token preset file seeded by an older Helm is upgraded to the current preset', t => {
	const dir = themesDir(t)
	seedPresetFiles(dir, {}, {})
	// The 2026-07 files: the ten later tokens missing, the values from before D5.
	const oldHc = { ...without(HC.tokens, ADDED_LATER), ...pick(PRESET_EARLIER_VALUES['high-contrast']) }
	const oldHelm = { ...without(HELM.tokens, ADDED_LATER), ...pick(PRESET_EARLIER_VALUES.helm) }
	assert.equal(Object.keys(oldHc).length, Object.keys(HC.tokens).length - ADDED_LATER.length)
	assert.notEqual(oldHc['--hairline'], HC.tokens['--hairline'])
	writeFileSync(join(dir, 'high-contrast.json'), fileOf({ name: HC.name, tokens: oldHc }))
	writeFileSync(join(dir, 'helm.json'), fileOf({ name: HELM.name, tokens: oldHelm }))
	const report = seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES)
	assert.deepEqual(report, { written: ['helm', 'high-contrast'], kept: [] })
	assert.equal(read(dir, 'high-contrast.json'), presetFileContent(HC))
	assert.equal(read(dir, 'helm.json'), presetFileContent(HELM))
})

test('a file still equal to what main last wrote is upgraded when a later preset changes a value', t => {
	const dir = themesDir(t)
	// Release N wrote a High contrast with another --text-1 and recorded it.
	const releaseN = { name: HC.name, tokens: { ...HC.tokens, '--text-1': '#b0b0b0' } }
	seedPresetFiles(dir, { 'high-contrast': releaseN })
	assert.equal(read(dir, 'high-contrast.json'), fileOf(releaseN))
	// Release N+1 ships the current preset; the value is in no earlier-values list, only the fingerprint knows it.
	const report = seedPresetFiles(dir, { 'high-contrast': HC }, {})
	assert.deepEqual(report, { written: ['high-contrast'], kept: [] })
	assert.equal(read(dir, 'high-contrast.json'), presetFileContent(HC))
	assert.equal(record(dir).files['high-contrast'], fingerprint(presetFileContent(HC)))
})

test('a preset file the user changed is never overwritten, with or without a fingerprint', t => {
	const dir = themesDir(t)
	seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES)
	const edited = fileOf({ name: HC.name, tokens: { ...without(HC.tokens, ADDED_LATER), '--accent': '#ff00aa' } })
	writeFileSync(join(dir, 'high-contrast.json'), edited)
	const renamed = fileOf({ name: 'My Helm', tokens: HELM.tokens })
	writeFileSync(join(dir, 'helm.json'), renamed)
	const before = record(dir)
	const report = seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES)
	assert.deepEqual(report, { written: [], kept: ['helm', 'high-contrast'] })
	assert.equal(read(dir, 'high-contrast.json'), edited)
	assert.equal(read(dir, 'helm.json'), renamed)
	assert.deepEqual(record(dir), before)
	// A file with an unknown token or another key is the user's too.
	writeFileSync(join(dir, 'helm.json'), fileOf({ name: HELM.name, tokens: { ...HELM.tokens, '--mine': '#000' } }))
	assert.deepEqual(seedPresetFiles(dir, { helm: HELM }, PRESET_EARLIER_VALUES), { written: [], kept: ['helm'] })
})

test('an edit that restores an earlier preset value is kept once a fingerprint is recorded', t => {
	const dir = themesDir(t)
	seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES)
	const earlierText2 = PRESET_EARLIER_VALUES.helm?.['--text-2']?.[0]
	assert.ok(earlierText2, 'helm --text-2 has an earlier value')
	assert.notEqual(earlierText2, HELM.tokens['--text-2'])
	const edited = fileOf({ name: HELM.name, tokens: { ...HELM.tokens, '--text-2': earlierText2 } })
	writeFileSync(join(dir, 'helm.json'), edited)
	const before = record(dir)
	assert.deepEqual(seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES), { written: [], kept: ['helm'] })
	assert.equal(read(dir, 'helm.json'), edited)
	assert.deepEqual(record(dir), before)
})

test('a symlinked preset path, a corrupt record and user themes are left alone', t => {
	const dir = themesDir(t)
	seedPresetFiles(dir, {}, {})
	const outside = join(dir, '..', 'elsewhere.json')
	const outsideContent = fileOf({ name: HC.name, tokens: without(HC.tokens, ADDED_LATER) })
	writeFileSync(outside, outsideContent)
	symlinkSync(outside, join(dir, 'high-contrast.json'))
	writeFileSync(join(dir, SEED_RECORD), '{ not json')
	const custom = fileOf({ name: 'Dusk', tokens: { '--pane': '#101010' } })
	writeFileSync(join(dir, 'dusk.json'), custom)
	const report = seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES)
	assert.deepEqual(report, { written: ['helm'], kept: ['high-contrast'] })
	assert.ok(lstatSync(join(dir, 'high-contrast.json')).isSymbolicLink())
	assert.equal(readFileSync(outside, 'utf8'), outsideContent)
	assert.equal(read(dir, 'dusk.json'), custom)
	assert.deepEqual(record(dir), { version: 1, files: { helm: fingerprint(presetFileContent(HELM)) } })
})

test('a symlinked themes directory is refused, never written through', t => {
	const dir = themesDir(t)
	const real = join(dir, '..', 'real-themes')
	seedPresetFiles(real, {}, {})
	symlinkSync(real, dir)
	assert.throws(() => seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES), /not a directory/)
	assert.deepEqual(readdirSync(real), [])
})

test('the picker lists preset files (sparse ones as they are) then user themes, never the record', t => {
	const dir = themesDir(t)
	seedPresetFiles(dir, THEME_PRESETS, PRESET_EARLIER_VALUES)
	const sparse = { ...without(HC.tokens, ADDED_LATER), '--accent': '#ff00aa' }
	writeFileSync(join(dir, 'high-contrast.json'), fileOf({ name: HC.name, tokens: sparse }))
	writeFileSync(join(dir, 'b-theme.json'), fileOf({ name: 'Bravo', tokens: { '--pane': '#111111' } }))
	writeFileSync(join(dir, 'a-theme.json'), fileOf({ name: 'Alpha', tokens: { '--pane': '#222222' } }))
	const list = listThemes(dir, THEME_PRESETS)
	assert.deepEqual(
		list.map(entry => entry.id),
		['helm', 'high-contrast', 'a-theme', 'b-theme'],
	)
	// The renderer fills the sparse file's missing tokens from the preset (resolveTokens, helm-appearance.test.ts).
	assert.deepEqual(list[1]?.tokens, sparse)
	assert.deepEqual(
		listThemes(join(dir, 'missing'), THEME_PRESETS).map(entry => entry.id),
		['helm', 'high-contrast'],
	)
})

function pick(values: Readonly<Record<string, readonly string[]>> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(values ?? {}).map(([key, list]) => [key, list[0] ?? '']))
}
