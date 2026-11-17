// Token-only design lint (docs/design-system.md, section 10; plan stage S3). Every finding of
// packages/helm-ui/lint.ts must be in the baseline packages/helm-ui/lint-allowlist.ts with a reason that names
// an open decision, a ruling or a plan stage; a baseline entry whose finding is gone fails too (the value
// was fixed: remove the entry). Fix the value or get a ruling, never this test; regenerate the baseline with
// `node --import tsx packages/helm-ui/scripts/design-lint.ts --write-baseline` (it refuses new entries without
// `--allow-new`, and marks those `TODO:` until a person writes the reason). BASELINE_CAPS below only go down.
// packages/helm-ui is an ES module package, so this test imports it by name.
// The section sign is escaped in this file so it cites no section itself.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DESIGN_LINT_ALLOWLIST, DESIGN_LINT_BASELINE } from '../packages/helm-ui/lint-allowlist.ts'
import * as lint from '../packages/helm-ui/lint.ts'

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
	// Open decisions shrink as Jakub picks them (S9), so only the section is required, not a count.
	assert.ok(
		plan.includes('## Open decisions') && stages.size >= 9 && rulings.size > 50,
		'decision, stage and ruling lists parse',
	)
	const bad: string[] = []
	for (const entry of DESIGN_LINT_ALLOWLIST) {
		const refs = lint.reasonReferences(entry.reason)
		const count = refs.decisions.length + refs.rulings.length + refs.stages.length
		const missing = [
			...refs.decisions.filter(n => !decisions.has(n)).map(n => `D${n}`),
			...refs.rulings.filter(n => !rulings.has(n)).map(n => `ruling ${n}`),
			...refs.stages.filter(n => !stages.has(n)).map(n => `S${n}`),
		]
		const auto = entry.reason.startsWith(lint.AUTO_REASON_PREFIX.trim())
		if (!entry.reason || count === 0 || missing.length || auto)
			bad.push(
				`${show(entry)}  reason "${entry.reason}"${missing.length ? ` (unknown ${missing.join(', ')})` : ''}${auto ? ' (written by --allow-new: write the real reason)' : ''}`,
			)
	}
	assert.deepEqual(bad, [], `Reasons must name a D<n>, a ${S}9 ruling N or an S<n>:\n${bad.join('\n')}`)
})

/**
 * The ratchet: allowlisted findings per rule may only go down. A value fixed lowers its count, and this cap must
 * be lowered with it; growing a count means raising a cap here, in review, with the entry's written reason.
 */
const BASELINE_CAPS: Record<(typeof lint.RULES)[number], number> = {
	// 10: §9 ruling 103 moved the extension popup onto Helm tokens (2026-11-13).
	// 9: S2 gave the PDF paper white its token, --paper.
	// 0: §9 rulings 114-116 put Remote's Send, shadows and scrims on tokens (2026-11-17).
	'raw-color': 0,
	// 36: §9 ruling 94 adds the Review light scope's --neutral and its recomputed --neutral-soft (2026-11-13).
	// 29: §9 ruling 96 removed Remote's seven surface-token overrides (2026-11-13).
	// 25: S2 generates the Remote offline page's :root, a token source now.
	// 23: §9 ruling 108 rules the reading zoom's --ui-scale re-binding in Document Review and the viewer (2026-11-17).
	'token-definition': 23,
	// 5 / 7 / 7: S2 put every z-index and motion literal a token holds on that token; the rest is D19.
	'raw-z-index': 5,
	'raw-duration': 7,
	'raw-easing': 7,
	// 8 / 58 / 20: §9 rulings 15, 98, 100 and 101 (D8 picks) fixed or ruled the rest (2026-11-13).
	// 7 / 55 / 19: §9 ruling 103 put the extension popup on the scale (2026-11-13).
	// 54 / 17: §9 ruling 117 put the Remote offline page on Remote's type steps and the spacing scale (2026-11-17).
	'radius-off-scale': 7,
	'spacing-off-scale': 54,
	'font-size-off-scale': 17,
	'font-size-unscaled': 0,
	uppercase: 0,
	// 0 / 0: §9 rulings 99 and 102 (D8 picks, 2026-11-13).
	'letter-spacing': 0,
	'font-weight': 0,
	'inline-svg': 4,
	'primitive-outside-owner': 5,
	'button-border': 1,
}

test('baseline counts per rule never grow and every cap matches its count (lower the cap when a value is fixed)', () => {
	const over: string[] = []
	const under: string[] = []
	for (const rule of lint.RULES) {
		const count = DESIGN_LINT_ALLOWLIST.filter(e => e.rule === rule).length
		const cap = BASELINE_CAPS[rule]
		if (count > cap) over.push(`${rule}: ${count} entries, cap ${cap}`)
		if (count < cap) under.push(`${rule}: ${count} entries, cap ${cap} (lower it to ${count})`)
	}
	assert.deepEqual(over, [], 'the baseline grew: fix the new value instead of listing it')
	assert.deepEqual(under, [], 'a value was fixed: lower its cap so it cannot come back')
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
			'.remote-workspace, .remote-login, .remote-empty { --pane: #111; --remote-bubble: #2f2f2f }',
			'app/src/renderer/remote/remote.css',
		),
		['.remote-workspace, .remote-login, .remote-empty | --pane: #111 | token-definition'],
	)
	// §9 ruling 108: only the reading zoom re-binds --ui-scale, to the cockpit scale times the zoom, and only in
	// the Document Review reading area and the viewer stage.
	const zoom = '--ui-scale: calc(var(--review-ui-scale) * var(--review-zoom, 1))'
	const scaled = (text: string, file: string) =>
		lint
			.lintCss(file, text, { coreTokens: new Set([...CORE, '--ui-scale']) })
			.map(f => `${f.selector} | ${f.property}: ${f.value} | ${f.rule}`)
	const review = 'app/src/renderer/document-review/document-review.css'
	assert.deepEqual(scaled(`.review-reading { ${zoom} }`, review), [])
	assert.deepEqual(scaled(`.viewer-stage { ${zoom} }`, 'app/src/renderer/viewer/viewer.css'), [])
	assert.deepEqual(scaled(`.review-header { ${zoom} }`, review), [`.review-header | ${zoom} | token-definition`])
	assert.deepEqual(scaled('.review-reading { --ui-scale: 1.2 }', review), [
		'.review-reading | --ui-scale: 1.2 | token-definition',
	])
	// §9 rulings 109 and 113: a filled row (or a tab in a group band) steps --text-2 up one rung, never anywhere else.
	assert.deepEqual(
		css('.item-row:hover { --text-2: var(--text-1) } .tab-group-section .tab:hover { --text-2: var(--text-0) }'),
		[],
	)
	assert.deepEqual(css('.item-row:hover { --text-2: var(--accent) } .x { --text-2: #fff }'), [
		'.item-row:hover | --text-2: var(--accent) | token-definition',
		'.x | --text-2: #fff | token-definition',
	])
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
			'.c | transition-timing-function: var(--ease, linear) | raw-easing',
			'@media (min-width: 1px) .d | transition-duration: 0.01ms | raw-duration',
		],
	)
})

test('indirection: !important, var() fallbacks behind non-tokens, local custom properties, calc() wrappers', () => {
	assert.deepEqual(
		css(`
			.a { color: #f00!important; padding: 7px!important; z-index: 5 ! important }
			.b { z-index: var(--nope, 9999); padding: var(--nope, 7px); border-radius: var(--x, 3px) }
			.c { transition: opacity var(--d, 300ms) var(--e, ease-in) }
			.d { padding: var(--accent, 7px); font-weight: calc(700) }
			.e { --e-z: 9999; --e-d: 900ms; --e-tt: uppercase; --e-fw: 800; --e-fs: 14px }
			.f { z-index: var(--e-z); transition-duration: var(--e-d); text-transform: var(--e-tt) }
			.g { font-weight: var(--e-fw); font-size: var(--e-fs); gap: var(--e-gap-unknown) }
		`),
		[
			'.a | color: #f00!important | raw-color',
			'.a | padding: 7px!important | spacing-off-scale',
			'.a | z-index: 5 ! important | raw-z-index',
			'.b | z-index: var(--nope, 9999) | raw-z-index',
			'.b | padding: var(--nope, 7px) | spacing-off-scale',
			'.b | border-radius: var(--x, 3px) | radius-off-scale',
			'.c | transition: opacity var(--d, 300ms) var(--e, ease-in) | raw-duration',
			'.c | transition: opacity var(--d, 300ms) var(--e, ease-in) | raw-easing',
			'.d | font-weight: calc(700) | font-weight',
			'.f | z-index: var(--e-z) => 9999 | raw-z-index',
			'.f | transition-duration: var(--e-d) => 900ms | raw-duration',
			'.f | text-transform: var(--e-tt) => uppercase | uppercase',
			'.g | font-weight: var(--e-fw) => 800 | font-weight',
			'.g | font-size: var(--e-fs) => 14px | font-size-off-scale',
		],
	)
	// The same indirection in TS: a sibling custom property of one style object, and a setProperty definition
	// read by a later write in the same function (not in another one).
	assert.deepEqual(
		tsx(`
			export const C = () => <div style={{ '--zz': 9999, zIndex: 'var(--zz)', '--d': '900ms', transitionDuration: 'var(--d)' }} />
			function f(el) { el.style.setProperty('--zz', '9999'); el.style.zIndex = 'var(--zz)' }
			function g(el) { el.style.zIndex = 'var(--zz)' }
		`),
		[
			'<div style> in C | z-index: var(--zz) => 9999 | raw-z-index',
			'<div style> in C | transition-duration: var(--d) => 900ms | raw-duration',
			'el.style in f | z-index: var(--zz) => 9999 | raw-z-index',
		],
	)
})

test('radius and spacing scales: on-scale, hairlines, segmented 2px, calc widths and var fallbacks', () => {
	assert.deepEqual(
		css(`
			.a { border-radius: 6px; border-top-left-radius: 999px; border-radius: 50%; border-radius: var(--r, 10px) }
			.b { border-radius: 10px 0 0 10px }
			.c { padding: 4px 8px 12px 16px; margin: -1px auto 0; gap: 20px 24px; inset: 32px; padding: 1em 2rem 5% }
			.d { padding: 5px; margin-top: calc(-44px - env(safe-area-inset-top, 0px)) }
			.e { padding-inline: max(16px, calc((100% - 800px) / 2)); padding-top: calc(28px + var(--o, 76px)) }
			.segmented-track { padding: 2px } .chip { padding: 2px 8px }
		`),
		[
			'.a | border-radius: var(--r, 10px) | radius-off-scale',
			'.b | border-radius: 10px 0 0 10px | radius-off-scale',
			'.d | padding: 5px | spacing-off-scale',
			'.d | margin-top: calc(-44px - env(safe-area-inset-top, 0px)) | spacing-off-scale',
			'.e | padding-top: calc(28px + var(--o, 76px)) | spacing-off-scale',
			'.chip | padding: 2px 8px | spacing-off-scale',
		],
	)
	// rem is checked at 16px; a px argument of max()/min()/clamp() is a value, not a measure; positions
	// (inset, top/right/bottom/left) are not spaces.
	assert.deepEqual(
		css(`
			.r { padding: 0.3125rem; gap: 1.5rem; margin: 0.25rem; padding: max(7px, 0%); gap: 0.3em }
			.s { inset: 6px; top: 6px; inset-inline: 3px }
		`),
		['.r | padding: 0.3125rem | spacing-off-scale', '.r | padding: max(7px, 0%) | spacing-off-scale'],
	)
})

test('D8 picks: in-component 6/10, Remote phone radii as tokens only, Remote 16/21, key and code spacing', () => {
	// §9 ruling 15: 6 and 10 are scale steps; odd values stay off.
	assert.deepEqual(css('.a { padding: 6px 10px; gap: 6px; margin: -6px 0 0 } .b { padding: 11px 12px 13px }'), [
		'.b | padding: 11px 12px 13px | spacing-off-scale',
	])
	// §9 ruling 100: the phone radii live in tokens used only by Remote; literals stay off-scale there too.
	const remote = 'app/src/renderer/remote/x.css'
	assert.deepEqual(
		css(
			'.t { border-radius: var(--radius-touch) } .f { border-radius: var(--radius-float) } .c { border-radius: var(--radius-capsule) } .l { border-radius: 12px }',
			remote,
		),
		['.l | border-radius: 12px | radius-off-scale'],
	)
	assert.deepEqual(css('.d { border-radius: var(--radius-touch) }'), [
		'.d | border-radius: var(--radius-touch) | radius-off-scale',
	])
	// §9 ruling 101: Remote's phone reading step 16 and its Markdown h3 21, only in Remote.
	assert.deepEqual(
		css(
			'.m { font-size: calc(16px * var(--ui-scale, 1)) } .h { font-size: calc(21px * var(--ui-scale, 1)) } .x { font-size: 14px }',
			remote,
		),
		['.x | font-size: 14px | font-size-off-scale'],
	)
	assert.deepEqual(css('.m { font-size: 16px }'), ['.m | font-size: 16px | font-size-off-scale'])
	// §9 ruling 102: +0.04em only on key symbols and codes to copy; any other spacing or selector is off.
	assert.deepEqual(
		css(
			'.agent-dock-kbd { letter-spacing: 0.04em } .hint kbd[data-face="symbols"] { letter-spacing: 0.04em } .remote-code { letter-spacing: 0.04em } .remote-code { letter-spacing: 0.08em } .title { letter-spacing: 0.04em }',
		),
		['.remote-code | letter-spacing: 0.08em | letter-spacing', '.title | letter-spacing: 0.04em | letter-spacing'],
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
		{ name: 'button', owner: 'app/src/renderer/button.css', classes: /^btn(-|$)/ },
		{ name: 'menu', owner: 'app/src/renderer/sidebar/sidebar.css', classes: /^menu(-|$)/ },
	]
	const surfaceModifiers = new Set(['menu-fixed'])
	const own = (text: string, file = 'app/src/renderer/x.css') =>
		lint
			.lintCss(file, text, { coreTokens: CORE, primitives, surfaceModifiers })
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
	// A new or moved variant the owner file never names is still the primitive's; wrappers do not hide it.
	assert.deepEqual(own('.btn-danger-outline { color: var(--pane) } :is(.btn) { color: var(--pane) }'), [
		'.btn-danger-outline | button: .btn-danger-outline',
		':is(.btn) | button: :is(.btn)',
	])
	assert.deepEqual(own(':where(.btn-primary):hover, :is(.a .btn) { color: var(--pane) }'), [
		':where(.btn-primary):hover, :is(.a .btn) | button: :where(.btn-primary):hover',
	])
	assert.deepEqual(lint.expandIsWhere(':is(.a, .b):hover'), ['.a:hover', '.b:hover'])
	// Primitive base rules in an HTML <style> block or a CSS constant are checked too.
	const html = lint
		.lintHtml('app/src/renderer/x.html', '<style>.btn { color: var(--pane) }</style>', {
			primitives,
			surfaceModifiers,
		})
		.map(f => f.rule)
	assert.deepEqual(html, ['primitive-outside-owner'])
	const constant = lint
		.lintTs('app/src/renderer/x.ts', 'export const PANEL_CSS = `.menu-item { color: var(--pane) }`', {
			primitives,
			surfaceModifiers,
		})
		.map(f => f.rule)
	assert.deepEqual(constant, ['primitive-outside-owner'])
})

test('every surface modifier class matches a primitive pattern (a stale exception cannot hide a variant)', () => {
	for (const name of lint.SURFACE_MODIFIER_CLASSES.keys())
		assert.ok(
			lint.PRIMITIVES.some(p => p.classes.test(name)),
			`${name} matches no primitive pattern: drop it from SURFACE_MODIFIER_CLASSES`,
		)
})

test('every shared primitive owner file exists and defines the primitive (the rule cannot go blind)', () => {
	for (const p of lint.primitiveVocabulary(ROOT)) {
		assert.ok(read(p.owner).length > 0, `${p.name}: owner ${p.owner} exists`)
		assert.ok(p.classes.size > 0, `${p.name}: ${p.owner} uses the primitive's classes`)
	}
})

test(`buttons draw no border in any tone (${S}9 ruling 4): the button-border rule over every button subject`, () => {
	const own = (text: string) =>
		lint
			.lintCss('app/src/renderer/x.css', text)
			.filter(f => f.rule === 'button-border')
			.map(f => `${f.selector} | ${f.property}: ${f.value}`)
	assert.deepEqual(
		own(`
			.btn-quiet { border: 1px solid var(--hairline) } .icon-btn:hover { border-color: var(--accent) }
			.x button + button { border-left: 1px solid var(--hairline) } [role="button"] { border-bottom: 1px solid }
			input[type=submit] { border: 1px solid } .row > .vg-btn-x { border-top-width: 2px }
			.btn { border: none; border-radius: 6px } button { border: 0 } .btn-ghost { border: 0px !important }
			.card { border: 1px solid } .btn .label { border: 1px solid } :is(.a, .btn-sm) { border: 1px solid }
		`),
		[
			'.btn-quiet | border: 1px solid var(--hairline)',
			'.icon-btn:hover | border-color: var(--accent)',
			'.x button + button | border-left: 1px solid var(--hairline)',
			'[role="button"] | border-bottom: 1px solid',
			'input[type=submit] | border: 1px solid',
			'.row > .vg-btn-x | border-top-width: 2px',
			':is(.a, .btn-sm) | border: 1px solid',
		],
	)
	// A type selector inside :is()/:where() after a class joins the compound (`button.x`), not `.xbutton`.
	assert.deepEqual(
		own(
			'.x:is(button) { border: 1px solid } .y:where(button):hover { border-color: red } a.z:is(button) { border: 1px solid }',
		),
		['.x:is(button) | border: 1px solid', '.y:where(button):hover | border-color: red'],
	)
	assert.deepEqual(lint.expandIsWhere('.x:is(button, .b):hover'), ['button.x:hover', '.x.b:hover'])
	assert.deepEqual(lint.expandIsWhere('.a > :is(button)'), ['.a > button'])
	assert.deepEqual(lint.expandIsWhere('a.x:is(button)'), [], 'an anchor that is a button never matches')
	// HTML <style> blocks and CSS constants (the widget) go through the same rule.
	assert.deepEqual(
		lint.lintHtml('app/src/renderer/x.html', '<style>button { border: 1px solid }</style>').map(f => f.rule),
		['button-border'],
	)
	// The rule sees the app's and the widget's button rules (it cannot go blind).
	let buttonRules = 0
	const sheets = lint
		.collectSources(ROOT)
		.filter(source => source.kind === 'css')
		.map(source => read(source.file))
	const widget = lint.embeddedConstant(
		'extension/src/widget.styles.ts',
		read('extension/src/widget.styles.ts'),
		'WIDGET_STYLES',
	)
	for (const text of [...sheets, widget.text])
		for (const d of lint.parseCss(text)) if (lint.splitTopLevel(d.selector).some(lint.isButtonSubject)) buttonRules++
	assert.ok(buttonRules > 50, 'button rules are found in the app and the widget')
})

test('inline styles in TS/TSX: JSX objects (also conditional and cast), DOM style writes, CSS constants', () => {
	assert.deepEqual(
		tsx(`
			function A({ on, w }) {
				return <>
					<div style={{ zIndex: 5, padding: 7, gap: 8, color: 'var(--text-2)', width: w, fontSize: 13 }} />
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
			'<div style> in A | padding: 7px | spacing-off-scale',
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

test('CSS constants: substitutions, any-case names, JSX <style>, and an unreadable upper-case constant throws', () => {
	assert.deepEqual(
		tsx(`
			const R = 5
			export const WIDGET_STYLES = \`.vg-r { border-radius: \${R}px } .vg-z { z-index: \${depth} }\`
			export const css = '.a { z-index: 9 }'
			const panel_styles = \`.b { padding: 7px }\`
			const style = { zIndex: 3 }
			export function C() { return <style>{\`.c { letter-spacing: 0.1em }\`}</style> }
		`),
		[
			'.vg-r | border-radius: 5px | radius-off-scale',
			'.a | z-index: 9 | raw-z-index',
			'.b | padding: 7px | spacing-off-scale',
			'.c | letter-spacing: 0.1em | letter-spacing',
		],
	)
	assert.throws(() => tsx('export const WIDGET_STYLES = makeCss()'), /CSS constant WIDGET_STYLES/)
	// Tagged templates are read (String.raw raw), in any case; a <style> child naming a template with a
	// substitution reads it, and a CSS constant named there is linted once, at its declaration.
	assert.deepEqual(
		tsx(`
			export const css = String.raw\`.a { z-index: 9 } .b::after { content: "\\2014" }\`
			const SHEET = \`.c { z-index: 8 } \${x}\`
			const PANEL_STYLES = \`.d { z-index: 7 }\`
			export const C = () => <><style>{SHEET}</style><style>{PANEL_STYLES}</style></>
		`),
		['.a | z-index: 9 | raw-z-index', '.d | z-index: 7 | raw-z-index', '.c | z-index: 8 | raw-z-index'],
	)
	// A lower-case CSS-named constant that builds text the lint cannot read fails loud; any other value
	// (`const style = getComputedStyle(el)`) is not a stylesheet.
	assert.throws(() => tsx("const css = '.a { z-index: ' + depth + ' }'"), /CSS constant css/)
	assert.throws(() => tsx("const styles = ['.a {', '}'].join('')"), /CSS constant styles/)
	assert.deepEqual(tsx('function f(el) { const style = getComputedStyle(el); return style }'), [])
	assert.throws(() => tsx('export const C = () => <style>{makeCss()}</style>'), /<style> child/)
})

test('the widget stylesheet is read whole (a substitution cannot drop it from the lint)', () => {
	const text = lint.embeddedConstant(
		'extension/src/widget.styles.ts',
		read('extension/src/widget.styles.ts'),
		'WIDGET_STYLES',
	).text
	assert.ok(lint.parseCss(text).length > 400, 'WIDGET_STYLES parses into its declarations')
	assert.ok(
		findings.some(f => f.file === 'extension/src/widget.styles.ts'),
		'the scan reports findings in WIDGET_STYLES',
	)
})

test('motion set from TS: Element.animate() timing, same-file constants, easing strings', () => {
	assert.deepEqual(
		tsx(`
			const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
			const MS = 160
			function f(el, on) {
				el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: on ? 140 : 180, easing: 'ease-out', delay: 0 })
				el.style.transition = \`transform \${MS}ms linear\`
				el.animate([], { duration: d, easing: e })
			}
		`),
		[
			'in EASE | string: cubic-bezier(0.16, 1, 0.3, 1) | raw-easing',
			'el.animate() in f | animation-duration: 140ms | raw-duration',
			'el.animate() in f | animation-duration: 180ms | raw-duration',
			'el.animate() in f | animation-timing-function: ease-out | raw-easing',
			'el.style in f | transition: transform 160ms linear | raw-duration',
			'el.style in f | transition: transform 160ms linear | raw-easing',
		],
	)
	// Shorthand options, a bare-number duration, options held in a const, and an easing per keyframe.
	assert.deepEqual(
		tsx(`
			function g(el) { const duration = 600; const easing = 'ease-in'; el.animate([{ opacity: 0 }], { duration, easing }) }
			function h(el) { el.animate([{ opacity: 0 }], 600) }
			function i(el) { const o = { duration: 700, easing: 'ease-out' } as const; el.animate([{ opacity: 0 }], o) }
			function j(el) { el.animate([{ opacity: 0, easing: 'ease-in-out' }, { opacity: 1 }], { duration: 'var(--motion-fast)' }) }
			function k(el) { el.animate({ opacity: [0, 1], easing: ['linear', 'ease'] }, { duration: speed }) }
			function l(el, duration) { el.animate([], { duration }) }
		`),
		[
			'el.animate() in g | animation-duration: 600ms | raw-duration',
			'el.animate() in g | animation-timing-function: ease-in | raw-easing',
			'el.animate() in h | animation-duration: 600ms | raw-duration',
			'el.animate() in i | animation-duration: 700ms | raw-duration',
			'el.animate() in i | animation-timing-function: ease-out | raw-easing',
			'el.animate() in j | animation-timing-function: ease-in-out | raw-easing',
			'el.animate() in k | animation-timing-function: linear | raw-easing',
			'el.animate() in k | animation-timing-function: ease | raw-easing',
		],
	)
})

test('the scan covers production modules outside the scan roots and the Remote offline page', () => {
	const sources = lint.collectSources(ROOT).map(source => `${source.kind} ${source.file}`)
	const production = lint.productionFiles(ROOT)
	const outside = [...production].filter(
		f => !lint.SCAN_ROOTS.some(root => f.startsWith(`${root}/`)) && !lint.isExcluded(f),
	)
	assert.ok(outside.length > 0, 'renderer entries import modules outside the scan roots')
	for (const file of outside) assert.ok(sources.includes(`ts ${file}`), `${file} is scanned`)
	for (const { file } of lint.EMBEDDED_HTML) assert.ok(sources.includes(`embedded-html ${file}`), `${file} is scanned`)
	// The offline page is on Remote's steps and the spacing scale (§9 ruling 117), so it has no finding left; the
	// same page with its old 48px padding back is still reported.
	const worker = read('app/assets/remote/remote-sw.js')
	assert.ok(worker.includes('padding:32px 24px'), 'the offline page padding is 32px 24px')
	const offline = lint.embeddedConstant(
		'remote-sw.js',
		worker.replace('padding:32px 24px', 'padding:48px 24px'),
		'OFFLINE',
	)
	assert.ok(
		lint.lintHtml('app/assets/remote/remote-sw.js', offline.text).some(f => f.rule === 'spacing-off-scale'),
		'the offline page HTML is linted',
	)
	assert.deepEqual(
		findings.filter(f => f.file === 'app/assets/remote/remote-sw.js'),
		[],
		'the offline page HTML has no finding',
	)
	assert.throws(() => lint.embeddedConstant('x.js', 'const A = 1', 'OFFLINE'), /not found/)
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
		['3 D8 kept', '3 TODO: S2 adds z/motion tokens', '4 TODO: S2 adds z/motion tokens'],
	)
	const text = lint.formatBaseline(entries)
	assert.equal(
		text,
		'## raw-z-index\n### app/src/renderer/x.css\n.a | z-index | 3 | D8 kept\n.a | z-index | 3 | TODO: S2 adds z/motion tokens\n.a | z-index | 4 | TODO: S2 adds z/motion tokens',
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

test("Remote's Send, floating shadows and scrims are the app tokens (§9 rulings 114-116)", () => {
	const declared = new Map<string, string>()
	for (const d of lint.parseCss(read('app/src/renderer/remote/remote.css')))
		declared.set(`${d.selector} | ${d.property}`, d.value)
	const send = '.remote-composer-actions .remote-send.btn-primary'
	const expected: Record<string, string> = {
		[`${send} | background`]: 'var(--text-0)',
		[`${send} | color`]: 'var(--pane)',
		[`@media (hover: hover) ${send}:hover:not(:disabled), ${send}[data-force-state="hover"]:not(:disabled) | background`]:
			'color-mix(in srgb, var(--text-0) 88%, transparent)',
		'.remote-composer-actions .menu-panel | box-shadow': 'var(--shadow-1)',
		'.remote-row-menu | box-shadow': 'var(--shadow-1)',
		'.remote-sheet | box-shadow': 'var(--shadow-2)',
		'.remote-navigation-menu | box-shadow': 'var(--shadow-2)',
		'.remote-sheet-dismiss | background': 'var(--scrim)',
		'.remote-navigation-dismiss | background': 'var(--scrim)',
	}
	for (const [key, value] of Object.entries(expected)) assert.equal(declared.get(key), value, key)
})
