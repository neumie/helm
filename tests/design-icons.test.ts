// The icon module (app/src/renderer/icons/) holds every production icon of the desktop renderer, each with its
// source (docs/design-system.md §9 ruling 54; decision D6 for the hand-drawn ones). This test fails on an SVG
// drawn outside the module, an entry without a source, a sourced icon missing from THIRD_PARTY_NOTICES.md, and
// index.html's static Background terminals icon drifting from the module's copy.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import iconComponentModule from '../app/src/renderer/icons/Icon.tsx'
import iconsModule from '../app/src/renderer/icons/icons.ts'

const { ICONS, ICONS_OUTSIDE_MODULE } = iconsModule
const { GLYPH, iconElement } = iconComponentModule
const appRequire = createRequire(new URL('../app/package.json', import.meta.url))
const { renderToStaticMarkup } = appRequire('react-dom/server') as typeof import('react-dom/server')

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
type Icon = (typeof ICONS)[keyof typeof ICONS]
const entries = Object.entries(ICONS) as [string, Icon][]

/** Not production: stories, fixtures, prototypes, proposals, the Storybook harness, generated bundles. */
const notProduction = (path: string) =>
	/\.stories\.tsx?$/.test(path) ||
	/(^|\/)[^/]*fixture[^/]*(\/|$)/i.test(path) ||
	/\.generated\.ts$/.test(path) ||
	/^app\/src\/renderer\/(open-prototype|proposals|storybook|icons)\//.test(path)

function files(dir: string): string[] {
	return readdirSync(join(root, dir)).flatMap(name => {
		const path = `${dir}/${name}`
		return statSync(join(root, path)).isDirectory() ? files(path) : [path]
	})
}

const SVG_SITE = [
	/<svg\b/,
	/createElementNS\([^)]*['"]svg['"]/,
	/createElement\(\s*['"]svg['"]/,
	/data:image\/svg/,
	/['"]http:\/\/www\.w3\.org\/2000\/svg['"]/,
]

test('every production SVG of the renderer is drawn by the icon module', () => {
	const allowed = new Set(ICONS_OUTSIDE_MODULE.map(entry => entry.file))
	const outside: string[] = []
	for (const path of [...files('app/src/renderer'), ...files('extension/src')]) {
		if (!/\.(tsx?|html|css)$/.test(path) || notProduction(path) || path === 'extension/src/widget-workbench.tsx')
			continue
		const text = read(path)
		if (SVG_SITE.some(re => re.test(text)) && !allowed.has(path)) outside.push(path)
	}
	assert.deepEqual(outside, [], 'draw icons in app/src/renderer/icons/icons.ts (or list a real exception)')
	for (const entry of ICONS_OUTSIDE_MODULE) assert.ok(existsSync(join(root, entry.file)), entry.file)
})

test('every icon names its source: a Heroicons file with its licence, or hand-drawn awaiting D6', () => {
	for (const [name, icon] of [...entries, ...ICONS_OUTSIDE_MODULE.map(e => [e.file, e] as const)]) {
		const source = icon.source
		if (source.kind === 'hand-drawn') {
			assert.equal(source.decision, 'D6', name)
			continue
		}
		assert.equal(source.license, 'MIT', name)
		assert.ok(source.name.length > 0, name)
		assert.match(
			source.url,
			new RegExp(
				`^https://github\\.com/tailwindlabs/heroicons/blob/${source.revision}/optimized/16/solid/[a-z0-9-]+\\.svg$`,
			),
			name,
		)
	}
	// The hand-drawn set is closed: a new icon is sourced (AGENTS.md "Production icons are sourced").
	assert.deepEqual(
		entries
			.filter(([, icon]) => icon.source.kind === 'hand-drawn')
			.map(([name]) => name)
			.sort(),
		[
			'agent',
			'archive',
			'back',
			'check',
			'chevronDown',
			'chevronRight',
			'close',
			'copy',
			'ellipsis',
			'external',
			'group',
			'manual',
			'pause',
			'plan',
			'play',
			'plus',
			'queue',
			'retry',
			'return',
			'settings',
			'sidebarToggle',
			'stop',
		],
	)
})

test('THIRD_PARTY_NOTICES.md lists every sourced icon with the file that holds it', () => {
	const notices = read('THIRD_PARTY_NOTICES.md')
	const heroicons = notices.slice(notices.indexOf('## Heroicons'), notices.indexOf('### MIT License'))
	assert.match(heroicons, /`app\/src\/renderer\/icons\/icons\.ts`/)
	for (const [name, icon] of entries) {
		if (icon.source.kind !== 'heroicons') continue
		assert.ok(heroicons.includes(`**${icon.source.name}** (\`${name}\``), `${name}: notice names it and its entry`)
		assert.ok(heroicons.includes(`<${icon.source.url}>`), `${name}: notice links ${icon.source.url}`)
	}
	for (const entry of ICONS_OUTSIDE_MODULE) {
		if (entry.source.kind !== 'heroicons') continue
		assert.ok(heroicons.includes(`**${entry.source.name}**`), entry.file)
		assert.ok(heroicons.includes(`\`${entry.file}\``), entry.file)
		assert.ok(heroicons.includes(`<${entry.source.url}>`), entry.file)
	}
	// Every file the section names exists.
	for (const [, path] of heroicons.matchAll(/`((?:app|extension|tests)\/[^`]+)`/g))
		assert.ok(existsSync(join(root, path)), `notice names missing ${path}`)
})

const attributes = (tag: string) =>
	Object.fromEntries([...tag.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))

test("index.html's static Background terminals icon equals the module's backgroundStack", () => {
	const html = read('app/src/renderer/index.html')
	const svg = /<svg\b[^>]*class="background-icon"[^>]*>([\s\S]*?)<\/svg>/.exec(html)
	assert.ok(svg, 'index.html has the #bg-toggle svg')
	assert.deepEqual(attributes(svg[0].slice(0, svg[0].indexOf('>'))), ICONS.backgroundStack.svg)
	const paths = [...(svg[1] ?? '').matchAll(/<path\b([^>]*?)\/?>/g)].map(([, attrs]) => attributes(attrs ?? ''))
	assert.deepEqual(
		paths,
		ICONS.backgroundStack.shapes.map(shape => shape.attributes),
	)
})

/** The markup an entry stands for, attribute for attribute in DOM spelling and order. */
const markup = (icon: Icon) => {
	const attrs = (record: Readonly<Record<string, string>>) =>
		Object.entries(record)
			.map(([name, value]) => ` ${name}="${value}"`)
			.join('')
	return `<svg${attrs(icon.svg)}>${icon.shapes.map(shape => `<${shape.tag}${attrs(shape.attributes)}></${shape.tag}>`).join('')}</svg>`
}

test('the React form renders exactly the entry, and GLYPH keeps its 23 glyphs', () => {
	for (const [name, icon] of entries) assert.equal(renderToStaticMarkup(iconElement(icon)), markup(icon), name)
	const glyphs = Object.keys(GLYPH) as (keyof typeof GLYPH)[]
	assert.equal(glyphs.length, 23)
	for (const name of glyphs) assert.equal(renderToStaticMarkup(GLYPH[name]), markup(ICONS[name]), name)
	// The pre-module glyph markup, verbatim (sidebar/ui.tsx before the move).
	assert.equal(
		renderToStaticMarkup(GLYPH.chevronRight),
		'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
	)
})

test('the module path matches what AGENTS.md and the spec name', () => {
	assert.ok(read('AGENTS.md').includes('`app/src/renderer/icons/`'))
	assert.ok(read('docs/design-system.md').includes('Primitives/Icons'))
})
