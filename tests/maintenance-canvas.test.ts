import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
// @ts-expect-error App is CommonJS; Node/tsx exposes its exports through default.
import compiler from '../app/src/document-review/canvas-compiler.js'
import type * as Compiler from '../app/src/document-review/canvas-compiler.js'
// @ts-expect-error App is CommonJS; Node/tsx exposes its exports through default.
import display from '../app/src/renderer/document-review/canvas-display.js'
import type * as Display from '../app/src/renderer/document-review/canvas-display.js'
// @ts-expect-error App is CommonJS; Node/tsx exposes its exports through default.
import vocabulary from '../app/src/renderer/document-review/canvas-vocabulary.js'
import type * as Vocabulary from '../app/src/renderer/document-review/canvas-vocabulary.js'
import type { CanvasDisplayFrame, CanvasDisplayNode } from '../src/document-review/canvas-types.js'

const { compileReviewCanvas } = compiler as typeof Compiler
const { validateCanvasFrame, canvasWorkerInvocation } = display as typeof Display
const { canvasTags, canvasTextProps, canvasBooleanProps, canvasBooleanishProps, canvasNumberProps, canvasStyles } =
	vocabulary as typeof Vocabulary
const compilation = compileReviewCanvas('export default () => <div/>')
const scalarCases: [string, string | number | boolean][] = [
	...[...canvasTextProps].map(key => [key, key === 'type' ? 'text' : 'example'] as [string, string]),
	...[...canvasBooleanProps].flatMap(
		key =>
			[
				[key, true],
				[key, false],
			] as [string, boolean][],
	),
	...[...canvasBooleanishProps].flatMap(
		key =>
			[
				[key, true],
				[key, false],
				[key, 'true'],
				[key, 'mixed'],
			] as [string, string | boolean][],
	),
	...[...canvasNumberProps].flatMap(
		key =>
			[
				[key, 2],
				[key, '2'],
			] as [string, string | number][],
	),
	['value', 2],
	['defaultValue', 2],
]
function frame(tag: string, props: CanvasDisplayNode['props']): CanvasDisplayFrame {
	return { nodes: [{ id: 'node', tag, props, children: [] }], fields: [] }
}

test('canvas decoder accepts the complete explicit vocabulary and rejects unknown or mistyped data', () => {
	for (const tag of canvasTags) assert.doesNotThrow(() => validateCanvasFrame(frame(tag, {}), compilation), tag)
	for (const [key, value] of scalarCases)
		assert.doesNotThrow(() => validateCanvasFrame(frame('div', { [key]: value }), compilation), key)
	for (const name of canvasStyles)
		for (const value of [1, '1px'])
			assert.doesNotThrow(() => validateCanvasFrame(frame('div', { style: { [name]: value } }), compilation), name)
	for (const tag of ['script', 'iframe', 'img', 'a', 'form', 'svg', 'custom-element'])
		assert.throws(() => validateCanvasFrame(frame(tag, {}), compilation), tag)
	for (const props of [
		{ href: 'https://example.com' },
		{ src: 'https://example.com' },
		{ onClick: 'execute()' },
		{ dangerouslySetInnerHTML: 'html' },
		{ className: 'overlay' },
		{ required: 'yes' },
		{ open: 1 },
		{ 'aria-expanded': 1 },
		{ 'aria-checked': [] },
		{ title: true },
		{ rows: 'calc(2)' },
		{ value: ['array'] },
		{ style: { position: 'fixed' } },
		{ style: { color: 'var(--secret)' } },
		{ style: { width: 10001 } },
		{ style: { color: 'x'.repeat(121) } },
		{ style: { color: 'url(https://example.com)' } },
	])
		assert.throws(() => validateCanvasFrame(frame('div', props as CanvasDisplayNode['props']), compilation))
	assert.throws(() => validateCanvasFrame(frame('input', { type: 'password' }), compilation))
})

test('actual compiler and hardened Worker output round-trips every vocabulary entry through the production decoder', async () => {
	const { buildDocumentCanvas } = await import('../app/scripts/build-document-canvas.mjs')
	const workerSource: string = await buildDocumentCanvas()
	const cases: { tag: string; props: CanvasDisplayNode['props'] }[] = [
		...[...canvasTags].map(tag => ({ tag, props: {} })),
		...scalarCases.filter(([key]) => key !== 'id').map(([key, value]) => ({ tag: 'div', props: { [key]: value } })),
		...[...canvasStyles].flatMap(name =>
			[1, '1px'].map(value => ({ tag: 'div', props: { style: { [name]: value } } })),
		),
	]
	const specimens = cases
		.map(({ tag, props }, index) => `<${tag} id={"case-${index}"} {...${JSON.stringify(props)}}/>`)
		.join('')
	const source = `export default () => <section>${specimens}
		<details id="disclosure" open aria-expanded={true}><summary>Details</summary>Body</details>
		<input id="answer" required defaultValue="initial" aria-checked={false}/>
		<select id="grouped" required><optgroup label="Choices"><option value="a">A</option><option value="b" selected>B</option></optgroup></select>
		<select id="local" multiple defaultValue={["b"]}><optgroup label="Choices"><option value="a">A</option><option value="b">B</option></optgroup></select>
		<div id="filtered" href="https://example.com" className="overlay" required="invalid" style={{position:"fixed",color:"var(--secret)",width:10001}}/>
	</section>`
	const compiled = compileReviewCanvas(source)
	assert.ok(compiled.code, compiled.error ?? undefined)
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage()
		// Browser-native function string avoids tsx inserting its __name helper into Worker fixtures.
		const evaluateWorker = `(bundle) => new Promise((resolve, reject) => {
			const url = URL.createObjectURL(new Blob([bundle], {type: 'text/javascript'}));
			const worker = new Worker(url);
			let frame;
			const finish = (error) => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); error ? reject(error) : resolve(frame); };
			const timer = setTimeout(() => finish(new Error('Worker did not settle')), 5000);
			worker.onerror = event => finish(new Error(event.message));
			worker.onmessage = event => {
				const message = JSON.parse(event.data);
				if (message.type === 'error') finish(new Error(message.error));
				if (message.type === 'frame') frame = message.frame;
				if (message.type === 'settled') finish(frame ? null : new Error('No frame'));
			};
		})`
		// String evaluation is an expression, not a function call with Playwright's arg.
		const runWorker = (bundle: string) => page.evaluate(`(${evaluateWorker})(${JSON.stringify(bundle)})`)
		const raw = await runWorker(workerSource + canvasWorkerInvocation(compiled))
		const decoded = validateCanvasFrame(raw, compiled, source.length)
		const nodes = new Map<string, Display.ValidatedCanvasNode>()
		const visit = (children: (string | Display.ValidatedCanvasNode)[]) => {
			for (const node of children)
				if (typeof node !== 'string') {
					nodes.set(String(node.props.id), node)
					visit(node.children)
				}
		}
		visit(decoded.nodes)
		for (const [index, specimen] of cases.entries()) {
			const node = nodes.get(`case-${index}`)
			assert.equal(node?.tag, specimen.tag)
			for (const [key, value] of Object.entries(specimen.props)) assert.deepEqual(node?.props[key], value, key)
			assert.equal(node?.sourceId, undefined, 'dynamic IDs must not acquire source provenance')
		}
		assert.equal(nodes.get('disclosure')?.props.open, true)
		assert.equal(nodes.get('answer')?.props.required, true)
		assert.equal(nodes.get('answer')?.sourceId, 'answer')
		assert.equal(nodes.get('grouped')?.children[0] && typeof nodes.get('grouped')?.children[0], 'object')
		assert.deepEqual(decoded.fields, [
			{ id: 'answer', value: 'initial' },
			{ id: 'grouped', value: 'b' },
		])
		assert.deepEqual(nodes.get('local')?.props.value, ['b'])
		assert.deepEqual(nodes.get('filtered')?.props, { id: 'filtered', style: {} })
		assert.equal(
			nodes.get('grouped')?.children.filter(node => typeof node !== 'string' && node.props.label === 'Choices').length,
			1,
		)
		await assert.rejects(() =>
			runWorker(workerSource + canvasWorkerInvocation(compileReviewCanvas('export default () => <iframe/>'))),
		)
	} finally {
		await browser.close()
	}
})
