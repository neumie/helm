// Token-only design lint (docs/design-system.md, section 10; plan stage S3). Every finding of
// app/src/design/lint.ts must be in the baseline app/src/design/lint-allowlist.ts with a reason that names
// an open decision, a ruling or a plan stage; a baseline entry whose finding is gone fails too (the value
// was fixed: remove the entry). Fix the value or get a ruling, never this test; regenerate the baseline with
// `node --import tsx app/scripts/design-lint.ts --write-baseline` and review the reasons.
// CJS default-import pattern per the other app tests (app sources load as CommonJS under tsx).
// The section sign is escaped in this file so it cites no section itself.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import allowlistModule from '../app/src/design/lint-allowlist.ts'
import lintModule from '../app/src/design/lint.ts'

type LintModule = typeof import('../app/src/design/lint.ts')
type AllowlistModule = typeof import('../app/src/design/lint-allowlist.ts')
const lint = lintModule as unknown as LintModule
const { DESIGN_LINT_ALLOWLIST, DESIGN_LINT_BASELINE } = allowlistModule as unknown as AllowlistModule

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const S = '§'

const findings = lint.scanRepository(ROOT)
const show = (f: { rule: string; file: string; selector: string; property: string; value: string; line?: number }) =>
	`  ${f.rule}: ${f.file}${f.line === undefined ? '' : `:${f.line}`}  ${f.selector}  { ${f.property}: ${f.value} }`

test('every design-lint finding is in the baseline (use a token or a scale value, or get a ruling first)', () => {
	const { unlisted } = lint.compareBaseline(findings, DESIGN_LINT_ALLOWLIST)
	assert.equal(unlisted.length, 0, `New design-lint violations:\n${unlisted.map(show).join('\n')}`)
})

test('every baseline entry still matches a finding (remove it: the value was fixed)', () => {
	const { stale } = lint.compareBaseline(findings, DESIGN_LINT_ALLOWLIST)
	assert.equal(stale.length, 0, `Stale baseline entries, remove them:\n${stale.map(show).join('\n')}`)
})

test('every baseline reason names an existing open decision, ruling or plan stage', () => {
	const plan = read('docs/plans/design-system/spec.md')
	const spec = read('docs/design-system.md')
	const decisions = new Set([...plan.matchAll(/^- \*\*D(\d+) /gm)].map(m => Number(m[1])))
	const stages = new Set([...plan.matchAll(/^\| \*\*S(\d+) /gm)].map(m => Number(m[1])))
	const rulingsSection = spec.slice(spec.indexOf('## 9. Rulings'), spec.indexOf('## 10. Enforcement map'))
	const rulings = new Set([...rulingsSection.matchAll(/^\| (\d+) \|/gm)].map(m => Number(m[1])))
	assert.ok(decisions.size > 10 && stages.size >= 9 && rulings.size > 50, 'decision, stage and ruling lists parse')
	const bad: string[] = []
	for (const entry of DESIGN_LINT_ALLOWLIST) {
		const refs = lint.reasonReferences(entry.reason)
		const count = refs.decisions.length + refs.rulings.length + refs.stages.length
		const missing = [
			...refs.decisions.filter(n => !decisions.has(n)).map(n => `D${n}`),
			...refs.rulings.filter(n => !rulings.has(n)).map(n => `ruling ${n}`),
			...refs.stages.filter(n => !stages.has(n)).map(n => `S${n}`),
		]
		if (!entry.reason || count === 0 || missing.length)
			bad.push(`${show(entry)}  reason "${entry.reason}"${missing.length ? ` (unknown ${missing.join(', ')})` : ''}`)
	}
	assert.deepEqual(bad, [], `Reasons must name a D<n>, a ${S}9 ruling N or an S<n>:\n${bad.join('\n')}`)
})

test('the baseline is in canonical order (regenerate it rather than editing lines in place)', () => {
	assert.equal(lint.formatBaseline(lint.parseBaseline(DESIGN_LINT_BASELINE)), DESIGN_LINT_BASELINE.trim())
})

test('production entries match the build scripts and the token source is found', () => {
	const scripts = [
		read('app/build.mjs'),
		read('app/scripts/build-remote.mjs'),
		read('app/scripts/build-document-canvas.mjs'),
	].join('\n')
	const appEntries = [...scripts.matchAll(/['"](?:\.\.\/)?(src\/renderer\/[\w/.-]+?\.tsx?)['"]/g)].map(
		m => `app/${m[1]}`,
	)
	const extensionEntries = [...read('extension/build.mjs').matchAll(/input: ['"](src\/[\w/.-]+)['"]/g)].map(
		m => `extension/${m[1]}`,
	)
	// Outputs written into src (the generated canvas runtime) are excluded sources, not entries.
	const fromScripts = [...new Set([...appEntries, ...extensionEntries])].filter(f => !lint.isExcluded(f)).sort()
	assert.deepEqual([...lint.PRODUCTION_ENTRIES].sort(), fromScripts)
	const core = lint.coreTokensFrom(ROOT)
	assert.ok(core.has('--accent-soft') && core.has('--font-ui'), 'the app :root token source block is found')
	const production = lint.productionFiles(ROOT)
	assert.ok(production.has('app/src/renderer/remote/RemoteWorkspace.tsx'), 'imports with .js specifiers resolve')
	assert.ok(!production.has('app/src/renderer/signals/SignalsWorkspace.tsx'), 'story-only hosts are not production')
})

// ---------------------------------------------------------------------------------------------------------
// Scanner self-tests on fixture strings.

const CORE = new Set(['--pane', '--accent', '--text-2'])
const css = (text: string, file = 'app/src/renderer/x.css') =>
	lint.lintCss(file, text, { coreTokens: CORE }).map(f => `${f.selector} | ${f.property}: ${f.value} | ${f.rule}`)
const tsx = (text: string, file = 'app/src/renderer/x.tsx') =>
	lint.lintTs(file, text, { coreTokens: CORE }).map(f => `${f.selector} | ${f.property}: ${f.value} | ${f.rule}`)

test('tokenizer: comments and strings with braces, nested at-rules, selector lists, @import-only files', () => {
	assert.deepEqual(css(`@import './tokens.css';\n@import url(base.css);`), [])
	assert.deepEqual(
		css(`
			/* .fake { color: red; } } */
			.a, .b>.c ,
			.d { content: "} { color: red"; color: #fff; }
			@media (max-width: 800px) { @supports (display: grid) { .e { z-index: 3 } } }
			@container card (min-width: 1px) { .f { padding: 5px } }
			@layer base { .g { text-transform: uppercase } }
		`),
		[
			'.a, .b>.c, .d | color: #fff | raw-color',
			'@media (max-width: 800px) @supports (display: grid) .e | z-index: 3 | raw-z-index',
			'@container card (min-width: 1px) .f | padding: 5px | spacing-off-scale',
			'@layer base .g | text-transform: uppercase | uppercase',
		],
	)
	const decls = lint.parseCss(
		'.a { background: url(data:x;y{z}); color: red } .b { &:hover { gap: 3px } .c & { gap: 4px } }',
	)
	assert.deepEqual(
		decls.map(d => `${d.selector} ${d.property}`),
		['.a background', '.a color', '.b:hover gap', '.c .b gap'],
	)
	assert.deepEqual(
		lint.parseCss('@keyframes pulse { 0%, 50% { opacity: 1 } to { opacity: 0 } }').map(d => d.selector),
		['@keyframes pulse 0%, 50%', '@keyframes pulse to'],
	)
})

test('raw-color: literals, names and fallbacks; tokens, keywords, masks and token sources pass', () => {
	assert.deepEqual(
		css(`.a {
			color: var(--text-2); background: transparent; border-color: currentColor; fill: inherit;
			outline-color: var(--accent, #4c9aff); box-shadow: 0 1px 2px rgb(0 0 0 / 30%);
			background-image: linear-gradient(white, var(--pane)); animation: red-pulse 1s;
			mask-image: linear-gradient(#000, transparent); font-family: Gold;
			--local: hsl(10 20% 30%); --pane: #000;
			color: color-mix(in srgb, var(--accent) 15%, transparent);
		}`),
		[
			'.a | outline-color: var(--accent, #4c9aff) | raw-color',
			'.a | box-shadow: 0 1px 2px rgb(0 0 0 / 30%) | raw-color',
			'.a | background-image: linear-gradient(white, var(--pane)) | raw-color',
			'.a | animation: red-pulse 1s | raw-duration',
			'.a | --local: hsl(10 20% 30%) | raw-color',
			'.a | --pane: #000 | token-definition',
		],
	)
	// The token source and the documented scoped palettes may hold literals; a core token redefined in a
	// scoped palette is still reported.
	assert.deepEqual(
		css(':root { --pane: #141517; --accent-soft: rgba(1, 2, 3, 0.15) }', 'app/src/renderer/tokens.css'),
		[],
	)
	assert.deepEqual(
		css(
			':root.remote-page { --remote-page: #0d0d0d } .remote-workspace, .remote-login, .remote-empty { --pane: #111; --remote-bubble: #2f2f2f }',
			'app/src/renderer/remote/remote.css',
		),
		['.remote-workspace, .remote-login, .remote-empty | --pane: #111 | token-definition'],
	)
})

test('raw-z-index, raw-duration and raw-easing; var() and the reduced-motion clamp pass', () => {
	assert.deepEqual(
		css(`
			.a { z-index: auto; transition: none; transition-delay: 0s; animation-duration: var(--motion-enter) }
			.b { z-index: -1; transition: color 140ms ease-out }
			.c { animation: spin 1s cubic-bezier(0.2, 0.8, 0.2, 1) infinite; transition-timing-function: var(--ease, linear) }
			@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important } }
			@media (min-width: 1px) { .d { transition-duration: 0.01ms } }
		`),
		[
			'.b | z-index: -1 | raw-z-index',
			'.b | transition: color 140ms ease-out | raw-duration',
			'.b | transition: color 140ms ease-out | raw-easing',
			'.c | animation: spin 1s cubic-bezier(0.2, 0.8, 0.2, 1) infinite | raw-duration',
			'.c | animation: spin 1s cubic-bezier(0.2, 0.8, 0.2, 1) infinite | raw-easing',
			'@media (min-width: 1px) .d | transition-duration: 0.01ms | raw-duration',
		],
	)
})

test('radius and spacing scales: on-scale, hairlines, segmented 2px, calc widths and var fallbacks', () => {
	assert.deepEqual(
		css(`
			.a { border-radius: 6px; border-top-left-radius: 999px; border-radius: 50%; border-radius: var(--r, 10px) }
			.b { border-radius: 10px 0 0 10px }
			.c { padding: 4px 8px 12px 16px; margin: -1px auto 0; gap: 20px 24px; inset: 32px; padding: 1em 2rem 5% }
			.d { padding: 6px; margin-top: calc(-44px - env(safe-area-inset-top, 0px)) }
			.e { padding-inline: max(16px, calc((100% - 800px) / 2)); padding-top: calc(28px + var(--o, 76px)) }
			.segmented-track { padding: 2px } .chip { padding: 2px 8px }
		`),
		[
			'.b | border-radius: 10px 0 0 10px | radius-off-scale',
			'.d | padding: 6px | spacing-off-scale',
			'.d | margin-top: calc(-44px - env(safe-area-inset-top, 0px)) | spacing-off-scale',
			'.e | padding-top: calc(28px + var(--o, 76px)) | spacing-off-scale',
			'.chip | padding: 2px 8px | spacing-off-scale',
		],
	)
})

test('type: ladder, surface sizes, unscaled sidebar sizes, letter-spacing, weights, uppercase', () => {
	assert.deepEqual(
		css(`
			.a { font-size: calc(12px * var(--ui-scale)); font-size: 13px; font-size: inherit; font-size: var(--dock-fs) }
			.b { font-size: 14px } .c { font-size: 0.92em } .d { font: 600 12px/1.4 var(--font-ui) } .e { font: 700 15px var(--font-ui) }
			.f { letter-spacing: -0.01em } .g { letter-spacing: normal } .h { letter-spacing: 0.04em }
			.i { font-weight: 500 } .j { font-weight: bold } .k { font-weight: 650 } .l { text-transform: none }
		`),
		[
			'.b | font-size: 14px | font-size-off-scale',
			'.c | font-size: 0.92em | font-size-off-scale',
			'.e | font: 700 15px var(--font-ui) | font-size-off-scale',
			'.e | font: 700 15px var(--font-ui) | font-weight',
			'.h | letter-spacing: 0.04em | letter-spacing',
			'.j | font-weight: bold | font-weight',
			'.k | font-weight: 650 | font-weight',
		],
	)
	// Document Review's reading scope sets 15/21/28 beside the ladder.
	assert.deepEqual(css('.r { font-size: calc(15px * var(--ui-scale)) }', 'app/src/renderer/document-review/x.css'), [])
	// Sidebar stylesheets scale every font size by --ui-scale.
	assert.deepEqual(
		css(
			'.m { font-size: calc(11px * var(--ui-scale)) } .n { font-size: 11px } .o { font-size: calc(11px + 1px) }',
			'app/src/renderer/sidebar/x.css',
		),
		[
			'.n | font-size: 11px | font-size-unscaled',
			'.o | font-size: calc(11px + 1px) | font-size-off-scale',
			'.o | font-size: calc(11px + 1px) | font-size-unscaled',
		],
	)
	assert.deepEqual(css('.n { font-size: 11px }', 'app/src/renderer/x.css'), [])
})

test('inline-svg: data URIs, JSX, markup strings and createElementNS outside the icon module', () => {
	assert.deepEqual(css(`.s { background-image: url("data:image/svg+xml,%3Csvg%3E") } .t { background: url(a.png) }`), [
		'.s | background-image: url("data:image/svg+xml,%3Csvg%3E") | inline-svg',
	])
	const source = `
		export function Icon() { return <svg viewBox="0 0 16 16"><path d="M0 0" /></svg> }
		const markup = '<svg width="8"></svg>'
		function make() { return document.createElementNS('http://www.w3.org/2000/svg', 'svg') }
		function child() { return document.createElementNS('http://www.w3.org/2000/svg', 'path') }
	`
	assert.deepEqual(tsx(source), [
		'in Icon | jsx: <svg viewBox="0 0 16 16"> | inline-svg',
		'in markup | string: <svg> | inline-svg',
		"in make | createElementNS: 'svg' | inline-svg",
	])
	assert.deepEqual(tsx(source, 'app/src/renderer/icons/heroicons.tsx'), [])
	assert.deepEqual(
		lint
			.lintHtml(
				'app/src/renderer/x.html',
				`<style>.a{color:#fff}</style><div style="z-index: 2"><svg viewBox="0 0 8 8"></svg></div>`,
				{},
			)
			.map(f => `${f.selector} | ${f.rule}`),
		['.a | raw-color', '<div style> | raw-z-index', 'html | inline-svg'],
	)
})

test('inline-svg in the repository: the icon module is scanned and exempt, every other svg is a finding', () => {
	const production = lint.productionFiles(ROOT)
	assert.ok(production.has('app/src/renderer/icons/icons.ts'), 'the icon module is production code the lint reads')
	const icons = read('app/src/renderer/icons/icons.ts')
	assert.ok(/<svg\b|createElementNS\(/.test(icons), 'the icon module holds the svg markup')
	assert.deepEqual(
		findings.filter(f => f.rule === 'inline-svg' && f.file.startsWith('app/src/renderer/icons/')),
		[],
	)
	for (const dir of lint.ICON_MODULE_DIRS) assert.ok(read(`${dir}icons.ts`).length > 0, `${dir} exists`)
})

test('primitive-outside-owner: base rules of a shared primitive only in its owner file', () => {
	const primitives = [
		{ name: 'button', owner: 'app/src/renderer/button.css', classes: new Set(['btn', 'btn-primary', 'btn-sm']) },
		{ name: 'menu', owner: 'app/src/renderer/sidebar/sidebar.css', classes: new Set(['menu-panel', 'menu-item']) },
	]
	const own = (text: string, file = 'app/src/renderer/x.css') =>
		lint
			.lintCss(file, text, { coreTokens: CORE, primitives })
			.filter(f => f.rule === 'primitive-outside-owner')
			.map(f => `${f.selector} | ${f.property}: ${f.value}`)
	const text = `
		.btn { color: var(--pane) }
		.btn-primary:hover:not(:disabled), .x { color: var(--pane) }
		button.btn.btn-sm[data-force-state="hover"] { color: var(--pane) }
		@media (hover: hover) { .menu-item:hover { color: var(--pane) } }
		.review .btn, .a > .btn, .a + .menu-item { color: var(--pane) }
		.agent-dock-key.btn, .menu-panel.menu-fixed { color: var(--pane) }
		.btn:not(.a .b) { color: var(--pane); background: var(--pane) }
		.b { & .btn { color: var(--pane) } &.btn { color: var(--pane) } }
	`
	assert.deepEqual(own(text), [
		'.btn | button: .btn',
		'.btn-primary:hover:not(:disabled), .x | button: .btn-primary:hover:not(:disabled)',
		'button.btn.btn-sm[data-force-state="hover"] | button: button.btn.btn-sm[data-force-state="hover"]',
		'@media (hover: hover) .menu-item:hover | menu: .menu-item:hover',
		'.btn:not(.a .b) | button: .btn:not(.a .b)',
	])
	assert.deepEqual(own(text, 'app/src/renderer/button.css').length, 1, 'the owner file may style its own base')
	assert.deepEqual(own(text, 'app/src/renderer/sidebar/sidebar.css').length, 4)
	assert.deepEqual(own('.btn.menu-item { color: var(--pane) }', 'app/src/renderer/sidebar/sidebar.css'), [])
})

test('every shared primitive owner file exists and defines the primitive (the rule cannot go blind)', () => {
	for (const p of lint.primitiveVocabulary(ROOT)) {
		assert.ok(read(p.owner).length > 0, `${p.name}: owner ${p.owner} exists`)
		assert.ok(p.classes.size > 0, `${p.name}: ${p.owner} uses the primitive's classes`)
	}
})

test(`buttons draw no border in any tone (${S}9 ruling 4): every stylesheet, every button subject`, () => {
	const BORDER = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-(width|style|color))?$/
	const BUTTON = /\.(icon-btn|btn|vg-btn)(-[\w-]+)?(?![\w-])/
	const sheets = lint
		.collectSources(ROOT)
		.filter(source => source.kind === 'css')
		.map(source => ({ file: source.file, text: read(source.file) }))
	const widget = /WIDGET_STYLES\s*=\s*`([^`]*)`/.exec(read('extension/src/widget.styles.ts'))?.[1]
	assert.ok(widget, 'the widget stylesheet constant is found')
	sheets.push({ file: 'extension/src/widget.styles.ts', text: widget })
	const drawn: string[] = []
	let buttonRules = 0
	for (const { file, text } of sheets) {
		for (const d of lint.parseCss(text)) {
			const subjects = lint.splitTopLevel(d.selector).map(
				complex =>
					complex
						.replace(/\([^)]*\)|\[[^\]]*\]/g, '')
						.trim()
						.split(/\s*[>+~]\s*|\s+/)
						.pop() ?? '',
			)
			if (!subjects.some(subject => BUTTON.test(subject))) continue
			buttonRules++
			if (BORDER.test(d.property) && !/^(none|0(px)?)$/.test(d.value))
				drawn.push(`${file}  ${d.selector} { ${d.property}: ${d.value} }`)
		}
	}
	assert.ok(buttonRules > 50, 'button rules are found in the app and the widget')
	assert.deepEqual(drawn, [], 'buttons take their weight from the fill, never a border')
})

test('inline styles in TS/TSX: JSX objects (also conditional and cast), DOM style writes, CSS constants', () => {
	assert.deepEqual(
		tsx(`
			function A({ on, w }) {
				return <>
					<div style={{ zIndex: 5, padding: 6, gap: 8, color: 'var(--text-2)', width: w, fontSize: 13 }} />
					<i style={on ? { color: '#fff' } : undefined} />
					<b style={{ WebkitLineClamp: 2, textTransform: 'uppercase' } as React.CSSProperties} />
				</>
			}
			function B(el) {
				el.style.zIndex = '9'
				el.style.transition = \`opacity \${ms}ms linear\`
				el.style.setProperty('--hover', 'color-mix(in srgb, var(--accent) 78%, white)')
				el.style.cssText = 'border-radius: 3px'
				el.setAttribute('style', 'letter-spacing: 0.1em')
				Object.assign(el.style, { marginTop: '7px' })
			}
			export const WIDGET_STYLES = \`.vg { font-weight: 700 }\`
		`),
		[
			'<div style> in A | z-index: 5 | raw-z-index',
			'<div style> in A | padding: 6px | spacing-off-scale',
			'<i style> in A | color: #fff | raw-color',
			'<b style> in A | text-transform: uppercase | uppercase',
			'el.style in B | z-index: 9 | raw-z-index',
			'el.style in B | transition: opacity var(--expr)ms linear | raw-easing',
			'el.style in B | --hover: color-mix(in srgb, var(--accent) 78%, white) | raw-color',
			'el.style in B | border-radius: 3px | radius-off-scale',
			'el[style] in B | letter-spacing: 0.1em | letter-spacing',
			'el.style in B | margin-top: 7px | spacing-off-scale',
			'.vg | font-weight: 700 | font-weight',
		],
	)
})

test('baseline format: parse/format round trip, multiset matching, reasons kept on regeneration', () => {
	const f = (value: string) => ({
		rule: 'raw-z-index' as const,
		file: 'app/src/renderer/x.css',
		selector: '.a',
		property: 'z-index',
		value,
		line: 1,
	})
	const entries = lint.nextBaseline([f('3'), f('3'), f('4')], [{ ...f('3'), reason: 'D8 kept' }])
	assert.deepEqual(
		entries.map(e => `${e.value} ${e.reason}`),
		['3 D8 kept', '3 S2 adds z/motion tokens (pending D2)', '4 S2 adds z/motion tokens (pending D2)'],
	)
	const text = lint.formatBaseline(entries)
	assert.equal(
		text,
		'## raw-z-index\n### app/src/renderer/x.css\n.a | z-index | 3 | D8 kept\n.a | z-index | 3 | S2 adds z/motion tokens (pending D2)\n.a | z-index | 4 | S2 adds z/motion tokens (pending D2)',
	)
	assert.deepEqual(lint.parseBaseline(text), entries)
	const { unlisted, stale } = lint.compareBaseline([f('3'), f('5')], entries)
	assert.deepEqual(
		unlisted.map(u => u.value),
		['5'],
	)
	assert.deepEqual(
		stale.map(s => s.value),
		['3', '4'],
	)
	assert.throws(() => lint.parseBaseline('## not-a-rule'))
	assert.throws(() => lint.formatBaseline([{ ...f('a | b'), reason: 'D8' }]))
})
