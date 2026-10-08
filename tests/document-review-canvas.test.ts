import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import type * as Compiler from '../app/src/document-review/canvas-compiler.js'
// @ts-expect-error App is CommonJS; Node/tsx exposes its exports through default.
import compiler from '../app/src/document-review/canvas-compiler.js'
import type { CanvasDisplayFrame, CanvasDisplayNode } from '../src/document-review/canvas-types.js'

type WorkerMessage =
	| { type: 'frame'; sequence: number; frame: CanvasDisplayFrame }
	| { type: 'settled'; sequence: number }
	| { type: 'error'; error: string }

const { compileReviewCanvas } = compiler as typeof Compiler

test('compiler rejects module loading without executing source', () => {
	for (const source of [
		"import x from 'node:fs'; export default ()=>null",
		"export {x} from 'react'",
		"export default ()=>import('react')",
		"const x=require('react'); export default ()=>null",
		"import x = require('react'); export default ()=>null",
	])
		assert.equal(compileReviewCanvas(source).code, null)
	const result = compileReviewCanvas('globalThis.hostSideEffect = true; export default () => <p id="safe">hello</p>')
	assert.ok(result.code)
	assert.equal((globalThis as { hostSideEffect?: boolean }).hostSideEffect, undefined)
	assert.equal(compileReviewCanvas('export default () => <p>').code, null)
	assert.equal(compileReviewCanvas('x'.repeat(512 * 1024 + 1)).code, null)
	assert.equal(
		compileReviewCanvas(`export default ()=> ${'<div>'.repeat(10000)}deep${'</div>'.repeat(10000)}`).code,
		null,
	)
	assert.deepEqual(
		compileReviewCanvas(
			'export default ()=> <div><input id="spread" {...{id:"override"}}/><select id="multi" multiple/><select id="dynamic" multiple={false as boolean}/><select id="single" multiple={false}/></div>',
		).fieldIds,
		['single'],
	)
})

test('compiler preserves BOM/CRLF offsets and only unique literal field identities', () => {
	const source =
		'\ufeffimport React, {useState} from "react";\r\nexport default function App(){return <section id="body"><input id="name"/><input id="duplicate"/><span id="duplicate"/><textarea id={"dynamic"}/><input id="secret" type="password"/></section>}'
	const result = compileReviewCanvas(source)
	assert.equal(result.error, null)
	assert.deepEqual(result.fieldIds, ['name'])
	const body = result.blocks.find(b => b.id === 'body')
	assert.ok(body)
	assert.equal(source.slice(body.start, body.end).startsWith('<section'), true)
	assert.equal(
		result.blocks.some(b => b.id === 'duplicate'),
		false,
	)
	assert.equal(
		compileReviewCanvas(
			`export default ()=><div>${Array.from({ length: 65 }, (_, i) => `<p id="b${i}"/>`).join('')}</div>`,
		).code,
		null,
	)
})

test('exact bundled browser worker uses real React hooks, bounded inert frames and no ambient capabilities', async () => {
	const { buildDocumentCanvas } = await import('../app/scripts/build-document-canvas.mjs')
	const workerSource: string = await buildDocumentCanvas()
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage()
		// tsx/esbuild preserves nested fixture function names using this injected helper.
		await page.addInitScript('globalThis.__name = (value) => value')
		await page.goto('about:blank')
		const run = async (
			source: string,
			interact = false,
			eventKind: 'click' | 'change' = 'click',
			metadata = true,
			noop = false,
			values?: string[],
			deadline = 5000,
			readyText?: string,
		) => {
			const compilation = compileReviewCanvas(source)
			assert.ok(compilation.code, compilation.error ?? undefined)
			return await page.evaluate(
				async ({
					bundle,
					code,
					interact,
					eventKind,
					metadata,
					noop,
					values,
					deadline,
					readyText,
				}: {
					bundle: string
					code: string
					interact: boolean
					eventKind: 'click' | 'change'
					metadata: unknown
					noop: boolean
					values?: string[]
					deadline: number
					readyText?: string
				}) => {
					const url = URL.createObjectURL(
						new Blob(
							[
								bundle,
								'\nHelmReviewCanvasWorker.startReviewCanvas((module,exports,require,__helmCanvasRuntime)=>{\n',
								code,
								'\n},',
								JSON.stringify(metadata),
								');',
							],
							{ type: 'text/javascript' },
						),
					)
					const worker = new Worker(url)
					const messages: WorkerMessage[] = []
					try {
						await new Promise<void>((resolve, reject) => {
							const timer = setTimeout(
								() => reject(new Error(`Worker did not settle: ${JSON.stringify(messages)}`)),
								deadline,
							)
							worker.onerror = e => {
								clearTimeout(timer)
								reject(new Error(e.message))
							}
							let clicked = false
							worker.onmessage = e => {
								const message = JSON.parse(e.data) as WorkerMessage
								messages.push(message)
								if (message.type === 'error') {
									clearTimeout(timer)
									resolve()
									return
								}
								if (
									message.type === 'settled' ||
									(message.type === 'frame' && readyText && JSON.stringify(message.frame).includes(readyText))
								) {
									if (
										readyText &&
										!messages.some(m => m.type === 'frame' && JSON.stringify(m.frame).includes(readyText))
									)
										return
									if (interact && !clicked) {
										clicked = true
										const frame = [...messages].reverse().find(m => m.type === 'frame')
										const search = (nodes: (string | CanvasDisplayNode)[]): CanvasDisplayNode | undefined => {
											for (const n of nodes) {
												if (typeof n === 'string') continue
												if (n.events?.[eventKind]) return n
												if (n.children) {
													const found = search(n.children)
													if (found) return found
												}
											}
										}
										if (!frame) throw new Error('Missing worker frame')
										const node = search(frame.frame.nodes)
										if (!node?.events) throw new Error('Missing event handle')
										worker.postMessage(
											JSON.stringify({
												type: 'event',
												sequence: 1,
												event: {
													handle: noop ? 'retired-handle' : node.events[eventKind],
													value: 'edited',
													checked: true,
													values,
												},
											}),
										)
									} else {
										clearTimeout(timer)
										resolve()
									}
								}
							}
						})
						return messages
					} finally {
						worker.terminate()
						URL.revokeObjectURL(url)
					}
				},
				{
					bundle: workerSource,
					code: compilation.code as string,
					interact,
					eventKind,
					noop,
					values,
					deadline,
					readyText,
					metadata: metadata ? { blocks: compilation.blocks, fieldIds: compilation.fieldIds } : undefined,
				},
			)
		}
		const messages = await run(
			'import React, {useState, useEffect} from "react"; export default function App(){ const [n,setN]=useState(0); useEffect(()=>{setN(2)},[]); return <button id="counter" onClick={()=>setN(n+1)}>{n}</button> }',
			true,
			'click',
			true,
			false,
			undefined,
			5000,
			'"2"',
		)
		assert.equal(
			messages.some(m => m.type === 'error'),
			false,
			JSON.stringify(messages),
		)
		const frames = messages.filter(m => m.type === 'frame')
		assert.ok(
			frames.some(m => JSON.stringify(m.frame).includes('"3"')),
			JSON.stringify(messages),
		)
		assert.equal(frames.at(-1)?.sequence, 1)
		const capability = await run(
			'export default ()=> <p id="caps">{[typeof fetch,typeof XMLHttpRequest,typeof WebSocket,typeof importScripts,typeof Worker,typeof MessageChannel,typeof postMessage,typeof navigator,typeof caches,typeof Function,typeof (()=>{}).constructor,typeof (async()=>{}).constructor].join(",")}</p>',
		)
		assert.equal(
			capability.some(m => m.type === 'error'),
			false,
			JSON.stringify(capability),
		)
		assert.ok(JSON.stringify(capability).includes(Array(12).fill('undefined').join(',')))
		const hardening = await run(
			'let blocked = 0; try {setTimeout("import(\\"https://example.com/escape.js\\")",0)} catch {blocked++}; try {Set.prototype.has = ()=>true} catch {blocked++}; export default ()=> <p>{blocked}</p>',
		)
		assert.ok(JSON.stringify(hardening).includes('"2"'), JSON.stringify(hardening))
		const input = await run('export default ()=> <input id="public" defaultValue="initial"/>', true, 'change')
		assert.deepEqual(input.filter(m => m.type === 'frame').at(-1)?.frame.fields, [{ id: 'public', value: 'edited' }])
		const missingMetadata = await run('export default ()=> <input id="public" value="initial"/>', false, 'click', false)
		assert.deepEqual(missingMetadata.find(m => m.type === 'frame')?.frame.fields, [])
		const dynamic = await run('export default ()=> <input id={"dynamic"} defaultValue="initial"/>', true, 'change')
		assert.deepEqual(dynamic.filter(m => m.type === 'frame').at(-1)?.frame.fields, [])
		const noop = await run(
			'export default ()=> <button id="noop" onClick={()=>{}}>unchanged</button>',
			true,
			'click',
			true,
			true,
		)
		assert.equal(noop.filter(m => m.type === 'frame').at(-1)?.sequence, 1)
		assert.equal(noop.at(-1)?.type, 'settled')
		const checkbox = await run('export default ()=> <input id="check" type="checkbox"/>', true, 'change')
		assert.deepEqual(checkbox.filter(m => m.type === 'frame').at(-1)?.frame.fields, [{ id: 'check', value: true }])
		const select = await run('export default ()=> <select id="single"><option value="one">One</option></select>')
		assert.deepEqual(select.find(m => m.type === 'frame')?.frame.fields, [{ id: 'single', value: 'one' }])
		const multi = await run(
			'import {useState} from "react"; export default function App(){const [label,setLabel]=useState("");return <div><select id="multi" multiple defaultValue={["one"]} onChange={e=>setLabel(e.target.selectedOptions.map(o=>o.value).join("+"))}><option value="one">One</option><option value="two">Two</option></select><p>{label}</p></div>}',
			true,
			'change',
			true,
			false,
			['one', 'two'],
		)
		const multiFrame = multi.filter(m => m.type === 'frame').at(-1)?.frame
		assert.deepEqual(multiFrame?.fields, [])
		assert.ok(JSON.stringify(multiFrame).includes('one+two'))
		assert.ok(JSON.stringify(multiFrame).includes('"value":["one","two"]'))
		const duplicates = await run(
			'function Field(){return <input id="repeated"/>} export default ()=> <div><Field/><Field/></div>',
		)
		assert.deepEqual(duplicates.find(m => m.type === 'frame')?.frame.fields, [])
		const memo = await run('import {memo} from "react"; export default memo(()=> <p>Memo component</p>)')
		assert.equal(
			memo.some(m => m.type === 'error'),
			false,
		)
		const inert = await run(
			'export default ()=> <div id="box" dangerouslySetInnerHTML={{__html:"<img src=https://example.com>"}} style={{backgroundImage:"url(https://example.com)",color:"red"}}><a href="https://example.com">no navigation</a></div>',
		)
		assert.ok(inert.some(m => m.type === 'error'))
		for (const source of [
			'export default ()=> <p>{"x".repeat(64001)}</p>',
			'export default ()=> <p>{"€".repeat(64000)}</p>',
			`export default ()=> ${'<div>'.repeat(34)}deep${'</div>'.repeat(34)}`,
			'export default ()=> <input id="large" value={"x".repeat(4001)}/>',
			`export default ()=> <div>${Array.from({ length: 5 }, (_, i) => `<input id="large${i}" value={"x".repeat(4000)}/>`).join('')}</div>`,
			'export default ()=> <input id="file" type="file"/>',
			'export default ()=> <div>{Array.from({length:2049},()=> <span>x</span>)}</div>',
			'export default ()=> <input id="secret" type="password"/>',
			`export default ()=> <div>${Array.from({ length: 17 }, (_, i) => `<input id="f${i}" value="x"/>`).join('')}</div>`,
		]) {
			const bounded = await run(source)
			assert.ok(
				bounded.some(m => m.type === 'error'),
				JSON.stringify(bounded).slice(0, 300),
			)
		}
		await assert.rejects(
			run('while(true){} export default ()=>null', false, 'click', true, false, undefined, 2000),
			/Worker did not settle/,
		)
		await assert.rejects(
			run(
				'export default ()=> <button onClick={()=>{while(true){}}}>Loop</button>',
				true,
				'click',
				true,
				false,
				undefined,
				2000,
			),
			/Worker did not settle/,
		)
	} finally {
		await browser.close()
	}
})

test('canvas source provenance refuses unused literal IDs reused by actual dynamic Worker nodes', async () => {
	const source =
		'const unused = <section><input id="public" /><p id="passage">Unused source</p></section>; export default () => <section><input id={"public"} defaultValue="Unattested value" /><p id={"passage"}>Visible quote</p></section>;'
	const compilation = compileReviewCanvas(source)
	assert.ok(compilation.code, compilation.error ?? undefined)
	const { buildDocumentCanvas } = await import('../app/scripts/build-document-canvas.mjs')
	const bundle = await buildDocumentCanvas()
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage()
		await page.addInitScript('globalThis.__name = value => value')
		await page.goto('about:blank')
		const frame = await page.evaluate(
			async ({ bundle, code, metadata }) => {
				const url = URL.createObjectURL(
					new Blob(
						[
							bundle,
							'\nHelmReviewCanvasWorker.startReviewCanvas((module,exports,require,__helmCanvasRuntime)=>{\n',
							code,
							'\n},',
							JSON.stringify(metadata),
							');',
						],
						{ type: 'text/javascript' },
					),
				)
				const worker = new Worker(url)
				try {
					return await new Promise<CanvasDisplayFrame>((resolve, reject) => {
						let frame: CanvasDisplayFrame | undefined
						const timer = setTimeout(() => reject(new Error('Worker timeout')), 5000)
						worker.onerror = e => {
							clearTimeout(timer)
							reject(new Error(e.message))
						}
						worker.onmessage = e => {
							const m = JSON.parse(e.data) as WorkerMessage
							if (m.type === 'frame') frame = m.frame
							else if (m.type === 'settled' && frame) {
								clearTimeout(timer)
								resolve(frame)
							} else if (m.type === 'error') {
								clearTimeout(timer)
								reject(new Error(m.error))
							}
						}
					})
				} finally {
					worker.terminate()
					URL.revokeObjectURL(url)
				}
			},
			{ bundle, code: compilation.code, metadata: { blocks: compilation.blocks, fieldIds: compilation.fieldIds } },
		)
		const nodes = frame.nodes
			.flatMap(node => (typeof node === 'string' ? [] : node.children))
			.filter((node): node is CanvasDisplayNode => typeof node !== 'string')
		const visibleNode = nodes.find(node => node.props.id === 'passage')
		assert.ok(visibleNode)
		const proofRoot = process.env.HELM_CANVAS_NATIVE_PROOF_ROOT
		let nativeAcceptsWrongBounds: boolean | null = null
		let nativeError: string | null = null
		if (proofRoot) {
			const loaded = await import(pathToFileURL(join(proofRoot, 'app/src/document-review/request.ts')).href)
			const request = loaded.default ?? loaded
			assert.equal(typeof request.validatePassage, 'function')
			const block = compilation.blocks.find(block => block.id === 'passage')
			assert.ok(block)
			const revision = createHash('sha256').update(source).digest('hex')
			nativeAcceptsWrongBounds = true
			try {
				request.validatePassage(
					source,
					revision,
					{
						revision,
						start: block.start,
						end: block.end,
						source: source.slice(block.start, block.end),
						quote: 'Visible quote',
						kind: 'block',
						canvasId: 'passage',
					},
					compilation,
				)
			} catch (error) {
				nativeAcceptsWrongBounds = false
				nativeError = String(error)
			}
		}
		console.log(
			JSON.stringify({
				fields: frame.fields,
				visibleNode,
				nativeAcceptsWrongBounds,
				nativeError,
				nativeProofRoot: proofRoot ?? 'not-run',
			}),
		)
		assert.deepEqual(frame.fields, [], 'Actual dynamic nodes must remain local-only despite unused literal IDs')
		assert.equal(visibleNode.sourceId, undefined)
		const local = lastFrame(await observeProvenance(page, bundle, source, ['change']))
		assert.deepEqual(local.fields, [])
		assert.ok(renderedNodes(local).every(node => node.sourceId === undefined))
		assert.equal(
			renderedNodes(local).find(node => node.tag === 'input')?.props.value,
			'edited',
			'Unproven controls remain interactive locally',
		)
		if (proofRoot) {
			assert.equal(
				nativeAcceptsWrongBounds,
				true,
				'This unchanged guard counterexample must not be mistaken for native rejection',
			)
			const loaded = await import(pathToFileURL(join(proofRoot, 'app/src/document-review/request.ts')).href)
			const request = loaded.default ?? loaded
			const positiveSource = 'export default()=> <p id="passage">Actual literal quote</p>'
			const positiveCompilation = compileReviewCanvas(positiveSource)
			const positive = lastFrame(await observeProvenance(page, bundle, positiveSource))
			const node = renderedNodes(positive)[0]
			assert.equal(node?.sourceId, 'passage')
			const block = positiveCompilation.blocks.find(block => block.id === node?.sourceId)
			assert.ok(block)
			const revision = createHash('sha256').update(positiveSource).digest('hex')
			assert.doesNotThrow(() =>
				request.validatePassage(
					positiveSource,
					revision,
					{
						revision,
						start: block.start,
						end: block.end,
						source: positiveSource.slice(block.start, block.end),
						quote: 'Actual literal quote',
						kind: 'block',
						canvasId: node?.sourceId,
					},
					positiveCompilation,
				),
			)
		}
	} finally {
		await browser.close()
	}
})

// Executes only compiler output in an actual dedicated Worker; never evaluates source in Node/page.
async function observeProvenance(
	page: Page,
	bundle: string,
	source: string,
	changes: ('click' | 'change')[] = [],
	metadata = true,
	waitText?: string,
): Promise<WorkerMessage[]> {
	const compiled = compileReviewCanvas(source)
	assert.ok(compiled.code, compiled.error ?? undefined)
	return page.evaluate(
		async ({ bundle, code, metadata, changes, waitText }) => {
			const url = URL.createObjectURL(
				new Blob(
					[
						bundle,
						'\nHelmReviewCanvasWorker.startReviewCanvas((module,exports,require,__helmCanvasRuntime)=>{\n',
						code,
						'\n},',
						JSON.stringify(metadata),
						');',
					],
					{ type: 'text/javascript' },
				),
			)
			const worker = new Worker(url)
			const messages: WorkerMessage[] = []
			try {
				return await new Promise<WorkerMessage[]>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`Worker timeout: ${JSON.stringify(messages)}`)), 5000)
					let next = 0
					worker.onerror = e => {
						clearTimeout(timer)
						reject(new Error(e.message))
					}
					worker.onmessage = e => {
						const m = JSON.parse(e.data) as WorkerMessage
						messages.push(m)
						if (m.type === 'error') {
							clearTimeout(timer)
							reject(new Error(m.error))
							return
						}
						if (m.type === 'frame' && waitText && JSON.stringify(m.frame).includes(waitText)) {
							clearTimeout(timer)
							resolve(messages)
							return
						}
						if (m.type !== 'settled') return
						if (next === changes.length && waitText) return
						if (next === changes.length) {
							clearTimeout(timer)
							resolve(messages)
							return
						}
						const kind = changes[next] as 'click' | 'change'
						const latest = messages.filter(m => m.type === 'frame').at(-1)
						const search = (nodes: (string | CanvasDisplayNode)[]): CanvasDisplayNode | undefined => {
							for (const node of nodes) {
								if (typeof node === 'string') continue
								if (node.events?.[kind]) return node
								const nested = search(node.children)
								if (nested) return nested
							}
						}
						const node = latest && search(latest.frame.nodes)
						if (!node?.events?.[kind]) {
							clearTimeout(timer)
							reject(new Error('Missing interactive control'))
							return
						}
						worker.postMessage(
							JSON.stringify({
								type: 'event',
								sequence: ++next,
								event: { handle: node.events[kind], value: 'edited', checked: true },
							}),
						)
					}
				})
			} finally {
				worker.terminate()
				URL.revokeObjectURL(url)
			}
		},
		{
			bundle,
			code: compiled.code,
			changes,
			waitText,
			metadata: metadata ? { blocks: compiled.blocks, fieldIds: compiled.fieldIds } : undefined,
		},
	)
}

function renderedNodes(frame: CanvasDisplayFrame): CanvasDisplayNode[] {
	const nodes: CanvasDisplayNode[] = []
	const visit = (children: (string | CanvasDisplayNode)[]): void => {
		for (const child of children) {
			if (typeof child === 'string') continue
			nodes.push(child)
			visit(child.children)
		}
	}
	visit(frame.nodes)
	return nodes
}

function lastFrame(messages: WorkerMessage[]): CanvasDisplayFrame {
	const message = messages.filter(m => m.type === 'frame').at(-1)
	assert.ok(message)
	return message.frame
}

test('canvas compiler rejects reserved source names and actual JSX compilation pragmas, not literal prose', () => {
	for (const name of ['__helm', '__helmCanvasRuntime', '__helmAnything', String.raw`__he\u006cmCanvasRuntime`]) {
		const result = compileReviewCanvas(`const ${name} = 1; export default ()=> <p>Never executed</p>`)
		assert.equal(result.code, null)
		assert.match(result.error ?? '', /reserved identifier/)
	}
	for (const pragma of [
		'@jsx __helmCanvasRuntime.createElement.bind',
		String.raw`@jsx __he\u006cmCanvasRuntime.createElement.bind`,
		'@jsx customFactory',
		'@jsxFrag CustomFragment',
		'@jsxRuntime automatic',
		'@jsxImportSource other-package',
	]) {
		const result = compileReviewCanvas(
			`/** ${pragma} */ globalThis.executedRejectedPragma=true; export default ()=> <p>Never executed</p>`,
		)
		assert.equal(result.code, null)
		assert.match(result.error ?? '', /compilation pragmas are unsupported/)
	}
	assert.equal((globalThis as { executedRejectedPragma?: boolean }).executedRejectedPragma, undefined)
	for (const source of [
		'const example="/** @jsx customFactory */"; export default ()=> <p>{example}</p>',
		'// ordinary prose mentions @jsx customFactory\nexport default ()=> <p>Prose</p>',
		'export default ()=> <pre>{"@jsxFrag Fragment @jsxRuntime automatic @jsxImportSource other"}</pre>',
	])
		assert.ok(compileReviewCanvas(source).code)
})

test('canvas source provenance binds frozen compiler props and original tag, never new wrappers or public IDs', async () => {
	const { buildDocumentCanvas } = await import('../app/scripts/build-document-canvas.mjs')
	const bundle = await buildDocumentCanvas()
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage()
		await page.addInitScript('globalThis.__name=value=>value')
		await page.goto('about:blank')
		const literal = 'const literal=<input id="public" value="literal"/>; '
		const samples = [
			['copied props', 'export default()=>({...literal,props:{...literal.props}})'],
			['changed props', `export default()=>({...literal,props:{...literal.props,value:'changed'},sourceId:'public'})`],
			['wrong original tag', `export default()=>({...literal,type:'textarea'})`],
			['manual React.createElement', `export default()=> React.createElement('input',literal.props)`],
			['unchanged React.cloneElement', 'export default()=> React.cloneElement(literal)'],
			['changed React.cloneElement', `export default()=> React.cloneElement(literal,{value:'changed'})`],
			['spread forwarding', 'export default()=> <input {...literal.props}/>'],
			[
				'custom forwarding',
				`function Forward(props){return React.createElement('input',props)} export default()=> <Forward {...literal.props}/>`,
			],
			[
				'fake new props',
				`export default()=> ({$$typeof:Symbol.for('react.transitional.element'),type:'input',key:null,props:{id:'public',value:'fake'}})`,
			],
			['fake wrong source', `export default()=> ({...literal,props:{id:'other',value:'changed'},sourceId:'public'})`],
		] as const
		for (const [name, body] of samples) {
			const frame = lastFrame(
				await observeProvenance(page, bundle, `import * as React from 'react'; ${literal}${body}`),
			)
			assert.deepEqual(frame.fields, [], name)
			assert.ok(
				renderedNodes(frame).every(node => node.sourceId === undefined),
				name,
			)
		}
		const exact = lastFrame(await observeProvenance(page, bundle, `${literal}export default()=>({...literal})`))
		assert.deepEqual(exact.fields, [{ id: 'public', value: 'literal' }])
		assert.equal(
			renderedNodes(exact)[0]?.sourceId,
			'public',
			'Exact frozen props plus original tag retain only the original binding',
		)
		const mutation = lastFrame(
			await observeProvenance(
				page,
				bundle,
				`${literal}try{literal.props.id='changed';literal.props.value='changed'}catch{} export default()=>literal`,
			),
		)
		assert.deepEqual(mutation.fields, [{ id: 'public', value: 'literal' }])
		const duplicate = lastFrame(
			await observeProvenance(
				page,
				bundle,
				`${literal}export default()=> <section>{literal}{({...literal})}</section>`,
			),
		)
		assert.deepEqual(duplicate.fields, [])
		assert.ok(renderedNodes(duplicate).every(node => node.sourceId === undefined))
		const dynamicCollision = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'export default()=> <section><input id="public"/><p id={"public"}>Collision</p></section>',
			),
		)
		assert.deepEqual(dynamicCollision.fields, [])
		assert.ok(renderedNodes(dynamicCollision).every(node => node.sourceId === undefined))
		const unsupportedForward = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'function Forward(props){return <input {...props}/>} export default()=> <Forward id="outer" value="local"/>',
			),
		)
		assert.deepEqual(unsupportedForward.fields, [])
		assert.ok(renderedNodes(unsupportedForward).every(node => node.sourceId === undefined))
		const inner = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'function Field(){return <input id="inner" defaultValue="initial"/>} export default()=> <Field/>',
				['change'],
			),
		)
		assert.deepEqual(inner.fields, [{ id: 'inner', value: 'edited' }])
		assert.equal(renderedNodes(inner)[0]?.sourceId, 'inner')
		const missing = lastFrame(await observeProvenance(page, bundle, `${literal}export default()=>literal`, [], false))
		assert.deepEqual(missing.fields, [])
		assert.ok(renderedNodes(missing).every(node => node.sourceId === undefined))
		const privateBoundary = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'import * as React from "react"; const value=[typeof arguments,typeof globalThis["__helmCanvasRuntime"],typeof React["__helmCanvasRuntime"],typeof module["__helmCanvasRuntime"]].join(",");function nested(){return arguments[0]} export default()=> <p id="private">{value+":"+nested("nested works")}</p>',
			),
		)
		assert.ok(JSON.stringify(privateBoundary).includes('undefined,undefined,undefined,undefined:nested works'))
		const captured = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'import * as React from "react"; let mutable=React;while(mutable.default && mutable.default!==mutable)mutable=mutable.default;mutable.createElement=()=>({$$typeof:Symbol.for("react.transitional.element"),type:"input",key:null,props:{id:"public",value:"fake"}}); export default()=> <input id="public" value="real"/>',
			),
		)
		assert.deepEqual(captured.fields, [{ id: 'public', value: 'real' }])
		const replacement = await observeProvenance(
			page,
			bundle,
			'import {useState} from "react";export default function App(){const [dynamic,setDynamic]=useState(false);return <section>{dynamic ? <input id={"public"} value="dynamic"/> : <input id="public" value="literal"/>}<button onClick={()=>setDynamic(!dynamic)}>Switch</button></section>}',
			['click', 'click'],
		)
		const frames = replacement.filter(m => m.type === 'frame')
		const initial = frames.find(m => m.sequence === 0)
		const changed = frames.filter(m => m.sequence === 1).at(-1)
		const restored = frames.filter(m => m.sequence === 2).at(-1)
		assert.ok(initial && changed && restored)
		assert.deepEqual(initial.frame.fields, [{ id: 'public', value: 'literal' }])
		assert.deepEqual(changed.frame.fields, [])
		assert.deepEqual(restored.frame.fields, [{ id: 'public', value: 'literal' }])
		const first = renderedNodes(initial.frame).find(node => node.tag === 'input')
		const next = renderedNodes(changed.frame).find(node => node.tag === 'input')
		assert.equal(first?.id, next?.id, 'React reused the actual host instance')
		assert.equal(first?.sourceId, 'public')
		assert.equal(next?.sourceId, undefined, 'Same-instance replacement must derive provenance afresh')
		for (const seq of [1, 2]) {
			const settledIndex = replacement.findIndex(m => m.type === 'settled' && m.sequence === seq)
			assert.ok(replacement.slice(0, settledIndex).some(m => m.type === 'frame' && m.sequence === seq))
		}
	} finally {
		await browser.close()
	}
})

test('canvas source provenance cannot be forged through real React class fiber host records', async () => {
	const { buildDocumentCanvas } = await import('../app/scripts/build-document-canvas.mjs')
	const bundle = await buildDocumentCanvas()
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage()
		await page.addInitScript('globalThis.__name=value=>value')
		await page.goto('about:blank')
		const scenes = [
			[
				'assigned sourceId',
				'const unused=<input id="public"/>;',
				'this._reactInternals.child.stateNode.sourceId="public"',
				'<input id={"public"} defaultValue="local"/>',
				'change',
			],
			[
				'copied admitted host record',
				'',
				'const item=this._reactInternals.child.stateNode;this._reactInternals.return.stateNode.containerInfo.children=[{...item}]',
				'<input id="public" value="literal"/>',
				'change',
			],
			[
				'inherited admitted host record',
				'',
				'const item=this._reactInternals.child.stateNode;this._reactInternals.return.stateNode.containerInfo.children=[Object.create(item)]',
				'<input id="public" value="literal"/>',
				'change',
			],
			[
				'accessor-backed admitted props',
				'',
				'const item=this._reactInternals.child.stateNode;const original=item.props;Object.defineProperty(item,"props",{get(){return original}})',
				'<input id="public" value="literal"/>',
				'change',
			],
			[
				'new props pointer',
				'',
				'this._reactInternals.child.stateNode.props={id:"public",value:"mutated host props"}',
				'<input id="public" value="literal"/>',
				'change',
			],
			[
				'wrong host tag',
				'',
				'this._reactInternals.child.stateNode.tag="textarea"',
				'<input id="public" value="literal"/>',
				'change',
			],
			[
				'fake host record',
				'const unused=<input id="public"/>;',
				'this._reactInternals.return.stateNode.containerInfo.children.push({tag:"input",props:{id:"public",value:"fake host"},children:[],sourceId:"public"})',
				'<button onClick={()=>{}}>Publish</button>',
				'click',
			],
			[
				'prototype-inherited fake host record',
				'const unused=<input id="public"/>;',
				'this._reactInternals.return.stateNode.containerInfo.children.push(Object.create({tag:"input",props:{id:"public",value:"inherited host"},children:[],sourceId:"public"}))',
				'<button onClick={()=>{}}>Publish</button>',
				'click',
			],
		] as const
		const failures: string[] = []
		for (const [name, unused, mutate, render, kind] of scenes) {
			const source = `import {Component} from "react";${unused}export default class App extends Component{componentDidMount(){${mutate}}render(){return ${render}}}`
			const messages = await observeProvenance(page, bundle, source, [kind])
			const frame = lastFrame(messages)
			console.log(
				JSON.stringify({
					scene: name,
					fields: frame.fields,
					sourceIds: renderedNodes(frame).map(node => node.sourceId ?? null),
				}),
			)
			if (frame.fields.length || renderedNodes(frame).some(node => node.sourceId !== undefined)) failures.push(name)
		}
		assert.deepEqual(failures, [], 'No reachable host object or fake record can establish private provenance')
		const genuine = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'import {Component} from "react";export default class App extends Component{state={value:"initial"};render(){return <input id="class" value={this.state.value} onChange={event=>this.setState({value:event.target.value})}/>}}',
				['change'],
			),
		)
		assert.deepEqual(genuine.fields, [{ id: 'class', value: 'edited' }])
		assert.equal(renderedNodes(genuine)[0]?.sourceId, 'class')
	} finally {
		await browser.close()
	}
})

test('canvas private provenance records cannot leak through replaced global validation intrinsics', async () => {
	const { buildDocumentCanvas } = await import('../app/scripts/build-document-canvas.mjs')
	const bundle = await buildDocumentCanvas()
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage()
		await page.addInitScript('globalThis.__name=value=>value')
		await page.goto('about:blank')
		const source =
			'const nativeObject=Object;const leaked=[];try{globalThis.Object=new Proxy({},{get(target,key){if(key==="freeze")return value=>{if(value && value.sourceId==="public")leaked.push(value);return value};return Reflect.get(nativeObject,key)}})}catch{} const unused=<input id="wrong-source" value="Unused source"/>;const actual=<input id="public" value="literal"/>;const stamp=leaked.find(value=>value.sourceId==="public");if(stamp){stamp.sourceId="wrong-source";actual.props.id="wrong-source";actual.props.value="Unattested value"}export default()=>actual;'
		const frame = lastFrame(await observeProvenance(page, bundle, source))
		console.log(JSON.stringify({ intrinsicLeakFields: frame.fields, nodes: frame.nodes }))
		assert.deepEqual(
			frame.fields,
			[{ id: 'public', value: 'literal' }],
			'Ambient replacement must not receive private stamp/snapshot records or unfreeze props',
		)
		assert.equal(renderedNodes(frame)[0]?.sourceId, 'public')
		const safe = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'const names=["Object","Array","Number","String","Boolean","Symbol","Reflect","JSON","Math","Map","Set","WeakMap","TextEncoder","setTimeout","clearTimeout","setInterval","clearInterval","queueMicrotask","globalThis","self","performance"];const locked=names.every(name=>{const before=globalThis[name];try{Object.defineProperty(globalThis,name,{value:{}})}catch{};try{globalThis[name]={}}catch{};const desc=Object.getOwnPropertyDescriptor(globalThis,name);return globalThis[name]===before && desc.writable===false && desc.configurable===false});let denied=0;for(const name of ["setTimeout","setInterval","queueMicrotask"]){try{globalThis[name]("import(\\"https://invalid.invalid\\")");}catch{denied++}}export default()=> <p id="safe">{String(locked)+":"+denied+":"+String(self===globalThis)+":"+typeof Function+":"+typeof eval}</p>',
			),
		)
		assert.ok(JSON.stringify(safe).includes('true:3:true:undefined:undefined'))
		const timers = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'import {Component} from "react";export default class App extends Component{state={mask:0};componentDidMount(){queueMicrotask(()=>this.setState(({mask})=>({mask:mask|1})));setTimeout(()=>this.setState(({mask})=>({mask:mask|2})),10)}render(){return <p id="timers">{this.state.mask===3?"timers ready":"waiting"}</p>}}',
				[],
				true,
				'timers ready',
			),
		)
		assert.equal(renderedNodes(timers)[0]?.sourceId, 'timers')
	} finally {
		await browser.close()
	}
})

test('canvas outgoing display arrays cannot run producer map or serialization hooks to forge source IDs', async () => {
	const { buildDocumentCanvas } = await import('../app/scripts/build-document-canvas.mjs')
	const bundle = await buildDocumentCanvas()
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage()
		await page.addInitScript('globalThis.__name=value=>value')
		await page.goto('about:blank')
		const source =
			'import {Component} from "react";const unused=<p id="passage">Unused source</p>;export default class App extends Component{componentDidMount(){const children=this._reactInternals.return.stateNode.containerInfo.children;Object.defineProperty(children,"map",{value:()=>[{id:"forged-frame",tag:"p",props:{id:"passage"},children:["Visible quote"],sourceId:"passage"}]})}render(){return <button onClick={()=>{}}>Publish</button>}}'
		const frame = lastFrame(await observeProvenance(page, bundle, source, ['click']))
		console.log(JSON.stringify({ sourceMapFrame: frame }))
		assert.ok(
			renderedNodes(frame).every(node => node.sourceId === undefined),
			'Producer map must not manufacture runtime source attestation',
		)
		assert.equal(renderedNodes(frame)[0]?.tag, 'button')
		for (const hook of [
			'Object.defineProperty(children,"toJSON",{value:()=>{throw Error("source toJSON executed")}})',
			'Object.defineProperty(children,Symbol.iterator,{value:()=>{throw Error("source iterator executed")}})',
			'Object.defineProperty(children,"constructor",{value:{get [Symbol.species](){throw Error("source species executed")}}})',
		]) {
			const scene = `import {Component} from "react";export default class App extends Component{componentDidMount(){const children=this._reactInternals.return.stateNode.containerInfo.children;${hook}}render(){return <button onClick={()=>{}}>Plain arrays</button>}}`
			assert.equal(renderedNodes(lastFrame(await observeProvenance(page, bundle, scene, ['click'])))[0]?.tag, 'button')
		}
		const later = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'import {Component} from "react";export default class App extends Component{render(){const owner=this;return <section><input id="public" value="literal"/><p style={{get color(){owner._reactInternals.child.child.stateNode.props={id:"public",value:"changed later"};return "red"}}}>Later getter</p></section>}}',
			),
		)
		assert.deepEqual(later.fields, [])
		assert.ok(
			renderedNodes(later).every(node => node.sourceId === undefined),
			'Later source getter invalidates earlier admission before emission',
		)
		const localArray = lastFrame(
			await observeProvenance(
				page,
				bundle,
				'const values=["b"];Object.defineProperty(values,"slice",{value:()=>{throw Error("source slice executed")}});Object.defineProperty(values,"map",{value:()=>{throw Error("source map executed")}});Object.defineProperty(values,"toJSON",{value:()=>{throw Error("source serialization executed")}});Object.defineProperty(values,Symbol.iterator,{value:()=>{throw Error("source iterator executed")}});export default()=> <section><select multiple value={values}><option value="a">A</option><option value="b">B</option></select><textarea id="note">Initial note</textarea></section>',
			),
		)
		assert.deepEqual(renderedNodes(localArray).find(node => node.tag === 'select')?.props.value, ['b'])
		assert.deepEqual(localArray.fields, [{ id: 'note', value: 'Initial note' }])
	} finally {
		await browser.close()
	}
})
