// The icon module (app/src/renderer/icons/) holds every production icon of the desktop renderer, each with its
// source (docs/design-system.md §9 rulings 54 and 95). This test fails on an SVG drawn outside the module, an
// entry that is not a Heroicons 24 outline icon drawn with stroke 2, a solid/micro or hand-drawn glyph left
// anywhere but the PWA launcher asset, a sourced icon missing from THIRD_PARTY_NOTICES.md, and index.html's
// static Background terminals icon, the `.select` data URI or the extension's two SVGs drifting from the set.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import iconComponentModule from '../app/src/renderer/icons/Icon.tsx'
import iconsModule from '../app/src/renderer/icons/icons.ts'

const { ICONS, ICONS_OUTSIDE_MODULE, OUTSIDE_GEOMETRY, ICON_STROKE_WIDTH, HEROICONS_REVISION } = iconsModule
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

const sourcesOf = (entry: (typeof ICONS_OUTSIDE_MODULE)[number]) =>
	Array.isArray(entry.source) ? entry.source : [entry.source as typeof entry.source & { kind: 'heroicons' }]

test('every module icon is a Heroicons 24 outline icon drawn with stroke 2 (§9 ruling 95)', () => {
	for (const [name, icon] of entries) {
		const source = icon.source
		assert.equal(source.kind, 'heroicons', name)
		assert.equal(source.style, '24 outline', name)
		assert.equal(source.license, 'MIT', name)
		assert.equal(source.revision, HEROICONS_REVISION, name)
		assert.match(
			source.url,
			new RegExp(
				`^https://github\\.com/tailwindlabs/heroicons/blob/${source.revision}/src/24/outline/[a-z0-9-]+\\.svg$`,
			),
			name,
		)
		assert.equal(icon.svg.viewBox, '0 0 24 24', name)
		assert.equal(icon.svg.fill, 'none', name)
		assert.equal(icon.svg.stroke, 'currentColor', name)
		assert.equal(icon.svg['stroke-width'], ICON_STROKE_WIDTH, name)
		assert.equal(ICON_STROKE_WIDTH, '2')
		for (const shape of icon.shapes) {
			assert.equal(shape.tag, 'path', name)
			assert.deepEqual(Object.keys(shape.attributes), ['d', 'stroke-linecap', 'stroke-linejoin'], name)
			assert.equal(shape.attributes['stroke-linecap'], 'round', name)
			assert.equal(shape.attributes['stroke-linejoin'], 'round', name)
			// Outline geometry is absolute uppercase commands only (no micro arcs, no fills).
			assert.match(shape.attributes.d ?? '', /^M[0-9MLHVCZ .-]+$/, name)
		}
	}
	// Today's sizes, carried over from the hand-drawn glyphs (D6 variant D: no layout moves).
	const sizes = Object.fromEntries(entries.map(([name, icon]) => [name, icon.svg.width ?? 'css']))
	assert.deepEqual(sizes, {
		plus: '14',
		menu: '16',
		back: '14',
		chevronRight: '12',
		chevronDown: '12',
		ellipsis: '14',
		external: '12',
		copy: '12',
		check: '14',
		agent: '14',
		manual: '14',
		play: '14',
		queue: '14',
		retry: '14',
		stop: '14',
		pause: '14',
		return: '14',
		plan: '13',
		archive: '14',
		calendar: '14',
		settings: '14',
		close: '14',
		arrowUp: '16',
		arrowDown: '16',
		chatBubbleLeftEllipsis: '16',
		folder: 'css',
		backgroundStack: '16',
		sidebarToggle: '16',
	})
})

test('outside the module only the PWA launcher asset stays 16 solid; everything else is the outline set', () => {
	for (const entry of ICONS_OUTSIDE_MODULE) {
		for (const source of sourcesOf(entry)) {
			assert.equal(source.kind, 'heroicons', entry.file)
			assert.equal(source.license, 'MIT', entry.file)
			const solid = entry.file === 'app/assets/remote/command-line.svg'
			assert.equal(source.style, solid ? '16 solid' : '24 outline', entry.file)
			assert.match(
				source.url,
				new RegExp(
					`^https://github\\.com/tailwindlabs/heroicons/blob/${source.revision}/${solid ? 'optimized/16/solid' : 'src/24/outline'}/[a-z0-9-]+\\.svg$`,
				),
				entry.file,
			)
		}
	}
	// The `.select` chevron: outline Chevron Down, stroke 2, 14px box, keeping its --text-2 stroke (§9 ruling 89).
	const css = read('app/src/renderer/sidebar/sidebar.css')
	const uri = /\.select \{[^}]*background-image: url\("data:image\/svg\+xml;charset=utf-8,([^"]*)"\)/.exec(css)
	assert.ok(uri, 'sidebar.css .select has its data URI')
	const svg = decodeURIComponent(uri[1] ?? '')
	assert.ok(svg.includes(`width='14' height='14' viewBox='0 0 24 24'`), svg)
	assert.ok(svg.includes(`d='${OUTSIDE_GEOMETRY.chevronDown}'`), svg)
	assert.ok(svg.includes(`stroke-width='2'`), svg)
	assert.ok(svg.includes(`stroke='#7f848d'`), svg)
	// The extension's two SVGs: the same outline geometry, stroke 2, 14px box.
	const widget = read('extension/src/Widget.tsx')
	const svgs = [...widget.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/g)].map(match => match[0].replace(/\s+/g, ' '))
	assert.equal(svgs.length, 2, 'Widget.tsx draws exactly the chevron and the check')
	for (const [index, d] of [OUTSIDE_GEOMETRY.chevronDown, OUTSIDE_GEOMETRY.check].entries()) {
		const markup = svgs[index] ?? ''
		assert.match(markup, /width="14" height="14" viewBox="0 0 24 24"/, markup)
		assert.ok(markup.includes(`d="${d}"`), markup)
		assert.match(markup, /stroke-width="2"/, markup)
		assert.match(markup, /stroke="currentColor"/, markup)
	}
})

test('no solid, micro or hand-drawn glyph is left in production renderer code', () => {
	for (const path of files('app/src/renderer')) {
		if (!/\.(tsx?|html|css)$/.test(path) || notProduction(path)) continue
		const text = read(path)
		assert.doesNotMatch(
			text,
			/viewBox=['"]0 0 (16|20|10) (16|20|6|8)['"]/,
			`${path}: an icon outside the 24 outline set`,
		)
		assert.doesNotMatch(text, /16px solid|Heroicons micro/i, `${path}: names the retired solid set`)
	}
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
		assert.ok(heroicons.includes(`\`${entry.file}\``), entry.file)
		for (const source of sourcesOf(entry)) {
			assert.ok(heroicons.includes(`**${source.name}**`), entry.file)
			assert.ok(heroicons.includes(`<${source.url}>`), entry.file)
		}
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

test('the React form renders exactly the entry, and GLYPH keeps its 22 glyphs', () => {
	for (const [name, icon] of entries) assert.equal(renderToStaticMarkup(iconElement(icon)), markup(icon), name)
	const glyphs = Object.keys(GLYPH) as (keyof typeof GLYPH)[]
	assert.equal(glyphs.length, 22)
	for (const name of glyphs) assert.equal(renderToStaticMarkup(GLYPH[name]), markup(ICONS[name]), name)
	// The rendered markup, verbatim: Heroicons 24 outline Chevron Right, stroke 2, at the old 12px slot.
	assert.equal(
		renderToStaticMarkup(GLYPH.chevronRight),
		'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8.25 4.5L15.75 12L8.25 19.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
	)
})

test('the module path matches what AGENTS.md and the spec name', () => {
	assert.ok(read('AGENTS.md').includes('`app/src/renderer/icons/`'))
	assert.ok(read('docs/design-system.md').includes('Primitives/Icons'))
})
