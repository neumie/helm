import * as React from 'react'
import Reconciler from 'react-reconciler'
import { ConcurrentRoot, DefaultEventPriority } from 'react-reconciler/constants'
import type {
	CanvasDisplayEvent,
	CanvasDisplayFrame,
	CanvasDisplayNode,
	ReviewCanvasCompilation,
} from '../../../../src/document-review/canvas-types.js'

type TextItem = { text: string }
type Child = Item | TextItem
type Item = { tag: string; props: Record<string, unknown>; children: Child[] }
type InstanceBinding = Readonly<{ props: Record<string, unknown>; tag: string; sourceId: string | undefined }>
type CanvasRuntime = Readonly<{
	createElement(
		type: React.ElementType,
		props: Record<string, unknown> | null,
		...children: React.ReactNode[]
	): React.ReactElement<Record<string, unknown>>
	Fragment: typeof React.Fragment
	attest(
		sourceId: string,
		element: React.ReactElement<Record<string, unknown>>,
	): React.ReactElement<Record<string, unknown>>
}>
const tags = new Set(
	'div span p h1 h2 h3 h4 h5 h6 section article main header footer ul ol li blockquote pre code strong em b i br hr label button input textarea select option optgroup table thead tbody tr th td details summary'.split(
		' ',
	),
)
const propsAllowed = new Set(
	'id title role aria-label aria-describedby aria-expanded aria-checked aria-live type value checked disabled readOnly required placeholder name min max step rows cols multiple selected htmlFor open colSpan rowSpan'.split(
		' ',
	),
)
const stylesAllowed = new Set(
	'color backgroundColor fontSize fontWeight fontStyle textAlign whiteSpace display flexDirection gap padding margin borderRadius width maxWidth minWidth height maxHeight lineHeight'.split(
		' ',
	),
)

/** Runs only inside the trusted dedicated Worker bundle, before document evaluation. */
export function startReviewCanvas(
	factory: (
		module: { exports: unknown },
		exports: unknown,
		require: (id: string) => unknown,
		__helmCanvasRuntime: CanvasRuntime,
	) => void,
	metadata?: Pick<ReviewCanvasCompilation, 'blocks' | 'fieldIds'>,
): void {
	// SAFETY: this entry runs only in a dedicated browser Worker, whose methods are captured before hardening.
	const scope = globalThis as unknown as {
		postMessage: (data: string) => void
		addEventListener: (type: string, cb: (event: MessageEvent) => void) => void
	}
	const freeze = Object.freeze
	const descriptor = Object.getOwnPropertyDescriptor
	const entries = Object.entries
	const isArray = Array.isArray
	const safeInteger = Number.isSafeInteger
	const finite = Number.isFinite
	const send = scope.postMessage.bind(scope)
	const listen = scope.addEventListener.bind(scope)
	const stringify = JSON.stringify.bind(JSON)
	const parse = JSON.parse.bind(JSON)
	let failed = false
	let sequence = 0
	let serial = 0
	const callbacks = new Map<string, (event: CanvasDisplayEvent) => void>()
	const fieldValues = new WeakMap<Item, string | boolean | string[]>()
	const localValues = (value: unknown): string[] => {
		if (!isArray(value)) throw new Error('values')
		const count = value.length
		if (!safeInteger(count) || count < 0 || count > 64) throw new Error('values')
		const copy: string[] = []
		let units = 0
		for (let i = 0; i < count; i++) {
			const text: unknown = value[i]
			if (typeof text !== 'string' || text.length > 4000) throw new Error('values')
			units += text.length
			if (units > 16384) throw new Error('values')
			copy.push(text)
		}
		return copy
	}
	const copyChildren = (value: unknown): Child[] => {
		if (!isArray(value)) throw new Error('children')
		const length = value.length
		if (!safeInteger(length) || length < 0 || length > 2048) throw new Error('bounds')
		const children: Child[] = []
		for (let i = 0; i < length; i++) children.push(value[i] as Child)
		return children
	}
	const textOf = (item: TextItem): string => {
		const text: unknown = item.text
		if (typeof text !== 'string') throw new Error('text')
		return text
	}
	const attestedFields = new Set<string>()
	const sourceIds = new Set<string>()
	const created = new WeakMap<object, { props: object; tag: string }>()
	const sourceBindings = new WeakMap<object, { sourceId: string; tag: string }>()
	// Capture the real primitive before producer imports/monkeypatches can run.
	const createElement = React.createElement
	const runtime: CanvasRuntime = freeze({
		createElement(type: React.ElementType, props: Record<string, unknown> | null, ...children: React.ReactNode[]) {
			const element = createElement<Record<string, unknown>>(type, props, ...children)
			if (typeof type === 'string') created.set(element, { props: element.props, tag: type })
			return element
		},
		Fragment: React.Fragment,
		attest(sourceId: string, element: React.ReactElement<Record<string, unknown>>) {
			const origin = created.get(element)
			if (
				origin &&
				sourceIds.has(sourceId) &&
				origin.props === element.props &&
				origin.tag === element.type &&
				descriptor(element.props, 'id')?.value === sourceId
			) {
				freeze(element.props)
				sourceBindings.set(element.props, freeze({ sourceId, tag: origin.tag }))
			}
			return element
		},
	})
	const instanceBindings = new WeakMap<Item, InstanceBinding>()
	const provenance = (tag: string, props: Record<string, unknown>): string | undefined => {
		const binding = sourceBindings.get(props)
		return binding?.tag === tag && binding.sourceId === props.id ? binding.sourceId : undefined
	}
	const admitInstance = (item: Item, tag: string, props: Record<string, unknown>): void => {
		instanceBindings.set(item, freeze({ props, tag, sourceId: provenance(tag, props) }))
	}
	const publishedProvenance = (item: Item, tag: string, props: Record<string, unknown>): string | undefined => {
		// React class fibers expose host Items. Authority exists only in these private snapshots.
		const snapshot = instanceBindings.get(item)
		if (
			!snapshot?.sourceId ||
			snapshot.props !== props ||
			snapshot.tag !== tag ||
			descriptor(item, 'props')?.value !== props ||
			descriptor(item, 'tag')?.value !== tag
		)
			return undefined
		return provenance(tag, props) === snapshot.sourceId ? snapshot.sourceId : undefined
	}
	const fieldItems = new Set<Item>()
	const identities = new WeakMap<Item, { id: string; click?: string; change?: string }>()
	const container: Item = { tag: 'div', props: {}, children: [] }
	const emit = (data: unknown): void => {
		if (failed) return
		const text = stringify(data)
		if (text.length > 128 * 1024 || new TextEncoder().encode(text).length > 128 * 1024) throw new Error('bounds')
		send(text)
	}
	const fail = (): void => {
		if (!failed) {
			failed = true
			send('{"type":"error","error":"Canvas execution or display limits failed"}')
		}
	}
	const publish = (): void => {
		if (failed) return
		try {
			callbacks.clear()
			fieldItems.clear()
			let count = 0
			let textUnits = 0
			let fieldUnits = 0
			const fields: CanvasDisplayFrame['fields'] = []
			const ids = new Map<string, CanvasDisplayNode[]>()
			const publications: { item: Item; tag: string; props: Record<string, unknown>; node: CanvasDisplayNode }[] = []
			const walk = (item: Child, depth: number): CanvasDisplayNode | string => {
				if (++count > 2048 || depth > 32) throw new Error('bounds')
				if (!item || typeof item !== 'object') throw new Error('child')
				if ('text' in item) {
					const text = textOf(item)
					textUnits += text.length
					if (textUnits > 64000) throw new Error('bounds')
					return text
				}
				const itemTag = item.tag
				const itemProps = item.props
				const children = copyChildren(item.children)
				if (!tags.has(itemTag)) throw new Error('tag')
				const props: CanvasDisplayNode['props'] = {}
				for (const [key, value] of entries(itemProps)) {
					if (propsAllowed.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
						if (typeof value === 'string' && value.length > 4000) throw new Error('bounds')
						if (typeof value === 'number' && !finite(value)) continue
						props[key] = value as string | number | boolean
					}
					if (key === 'style' && value && typeof value === 'object') {
						const style: Record<string, string | number> = {}
						for (const [name, v] of entries(value))
							if (
								stylesAllowed.has(name) &&
								((typeof v === 'number' && finite(v)) ||
									(typeof v === 'string' && v.length <= 160 && !/[\\;{}]|url\s*\(|expression|@import/i.test(v)))
							)
								style[name] = v
						props.style = style
					}
				}
				const isField = ['input', 'textarea', 'select'].includes(itemTag)
				const multi = itemTag === 'select' && Boolean(props.multiple)
				if (isField) {
					const checked = ['checkbox', 'radio'].includes(String(props.type))
					const controlled = itemProps[checked ? 'checked' : 'value']
					const childText = (children: Child[]): string => {
						let text = ''
						for (const child of children)
							if (child && typeof child === 'object' && 'text' in child) {
								text += textOf(child)
								if (text.length > 4000) throw new Error('bounds')
							}
						return text
					}
					const options: { value: string; selected: boolean; disabled: boolean }[] = []
					let optionAttempts = 0
					const collectOptions = (children: Child[], depth: number): void => {
						if (depth > 32) throw new Error('bounds')
						for (const child of children) {
							if (++optionAttempts > 2048) throw new Error('bounds')
							if (!child || typeof child !== 'object' || !('tag' in child)) continue
							const tag = child.tag
							if (tag === 'option') {
								const props = child.props
								const value = String(props.value ?? childText(copyChildren(child.children)))
								if (value.length > 4000) throw new Error('bounds')
								options.push({ value, selected: Boolean(props.selected), disabled: Boolean(props.disabled) })
							} else if (tag === 'optgroup') collectOptions(copyChildren(child.children), depth + 1)
						}
					}
					if (itemTag === 'select') collectOptions(children, 0)
					const defaultValue = multi
						? options.filter(option => option.selected).map(option => option.value)
						: itemTag === 'select' && options.length
							? ((options.find(option => option.selected) ?? options[0])?.value ?? '')
							: itemTag === 'textarea'
								? childText(children)
								: ''
					const value =
						controlled !== undefined
							? controlled
							: (fieldValues.get(item) ??
								itemProps[checked ? 'defaultChecked' : 'defaultValue'] ??
								(checked ? false : defaultValue))
					fieldItems.add(item)
					props[checked ? 'checked' : 'value'] = multi
						? localValues(value).filter(v => options.some(option => option.value === v))
						: checked
							? Boolean(value)
							: itemTag === 'select' && !options.some(option => option.value === String(value))
								? options.length
									? ((options.find(option => !option.disabled) ?? options[0])?.value ?? '')
									: ''
								: String(value)
				}
				if (
					itemTag === 'input' &&
					!['text', 'number', 'checkbox', 'radio', 'email'].includes(String(props.type ?? 'text'))
				)
					throw new Error('field')
				let identity = identities.get(item)
				if (!identity) {
					identity = { id: `node-${++serial}` }
					identities.set(item, identity)
				}
				const node: CanvasDisplayNode = {
					id: identity.id,
					tag: itemTag,
					props,
					children: children.map(child => walk(child, depth + 1)),
				}
				publications.push({ item, tag: itemTag, props: itemProps, node })
				if (typeof props.id === 'string') ids.set(props.id, [...(ids.get(props.id) ?? []), node])
				const events: NonNullable<CanvasDisplayNode['events']> = {}
				for (const [name, prop] of [
					['click', 'onClick'],
					['change', 'onChange'],
				] as const) {
					const cb = itemProps[prop]
					if (typeof cb === 'function' || (name === 'change' && isField)) {
						const handle = identity[name] ?? `event-${++serial}`
						identity[name] = handle
						callbacks.set(handle, event => {
							if (name === 'change' && isField) {
								if (props.type === 'radio' && event.checked && props.name)
									for (const peer of fieldItems)
										if (peer !== item && peer.props.type === 'radio' && peer.props.name === props.name)
											fieldValues.set(peer, false)
								fieldValues.set(
									item,
									multi
										? localValues(event.values ?? [])
										: ['checkbox', 'radio'].includes(String(props.type))
											? Boolean(event.checked)
											: (event.value ?? ''),
								)
							}
							const selectedOptions = freeze((event.values ?? []).map(value => freeze({ value })))
							const target = {
								value: multi ? (event.values?.[0] ?? '') : event.value,
								checked: event.checked,
								selectedOptions,
							}
							if (typeof cb === 'function')
								cb({
									target,
									currentTarget: target,
									preventDefault() {},
									stopPropagation() {},
								})
						})
						events[name] = handle
					}
				}
				if (Object.keys(events).length) node.events = events
				return node
			}
			const nodes = copyChildren(container.children).map(item => walk(item, 0))
			// Complete all producer getters first, then revalidate every binding before publication.
			for (const { item, tag, props, node } of publications) {
				const sourceId = publishedProvenance(item, tag, props)
				if (sourceId && sourceId === node.props.id) node.sourceId = sourceId
			}
			const radioGroups = new Map<string, CanvasDisplayNode>()
			const radios = (list: (string | CanvasDisplayNode)[]): void => {
				for (const node of list) {
					if (typeof node === 'string') continue
					if (
						node.tag === 'input' &&
						node.props.type === 'radio' &&
						typeof node.props.name === 'string' &&
						node.props.name &&
						node.props.checked
					) {
						const prior = radioGroups.get(node.props.name)
						if (prior) prior.props.checked = false
						radioGroups.set(node.props.name, node)
					}
					radios(node.children)
				}
			}
			radios(nodes)
			for (const [id, list] of ids) {
				if (list.length !== 1) {
					for (const node of list) {
						Reflect.deleteProperty(node.props, 'id')
						Reflect.deleteProperty(node, 'sourceId')
					}
					continue
				}
				const node = list[0] as CanvasDisplayNode
				if (
					node.sourceId !== id ||
					!attestedFields.has(id) ||
					!['input', 'textarea', 'select'].includes(node.tag) ||
					(node.tag === 'select' && node.props.multiple)
				)
					continue
				const value = ['checkbox', 'radio'].includes(String(node.props.type))
					? Boolean(node.props.checked)
					: String(node.props.value ?? '')
				if (id.length > 80 || (typeof value === 'string' && value.length > 4000)) throw new Error('bounds')
				fieldUnits += typeof value === 'string' ? value.length : 0
				fields.push({ id, value })
			}
			if (fields.length > 16 || fieldUnits > 16384) throw new Error('bounds')
			emit({ type: 'frame', sequence, frame: { nodes, fields } })
		} catch {
			fail()
		}
	}
	const append = (parent: Item, child: Child): void => {
		const i = parent.children.indexOf(child)
		if (i >= 0) parent.children.splice(i, 1)
		parent.children.push(child)
	}
	const remove = (parent: Item, child: Child): void => {
		const i = parent.children.indexOf(child)
		if (i >= 0) parent.children.splice(i, 1)
	}
	const insert = (parent: Item, child: Child, before: Child): void => {
		remove(parent, child)
		parent.children.splice(parent.children.indexOf(before), 0, child)
	}
	let priority = DefaultEventPriority
	const config = {
		supportsMutation: true,
		supportsPersistence: false,
		supportsHydration: false,
		isPrimaryRenderer: true,
		getRootHostContext: () => ({}),
		getChildHostContext: (context: unknown) => context,
		getPublicInstance: () => null,
		prepareForCommit: () => null,
		resetAfterCommit: publish,
		createInstance: (tag: string, props: Record<string, unknown>) => {
			const item: Item = { tag, props, children: [] }
			admitInstance(item, tag, props)
			return item
		},
		createTextInstance: (text: string) => ({ text }),
		shouldSetTextContent: () => false,
		appendInitialChild: append,
		appendChild: append,
		appendChildToContainer: append,
		removeChild: remove,
		removeChildFromContainer: remove,
		insertBefore: insert,
		insertInContainerBefore: insert,
		finalizeInitialChildren: () => false,
		commitUpdate: (item: Item, tag: string, _old: unknown, props: Record<string, unknown>) => {
			item.props = props
			item.tag = tag
			admitInstance(item, tag, props)
		},
		commitTextUpdate: (item: TextItem, _old: string, text: string) => {
			item.text = text
		},
		resetTextContent: (item: Item) => {
			item.children = []
		},
		clearContainer: (item: Item) => {
			item.children = []
		},
		scheduleTimeout: setTimeout,
		cancelTimeout: clearTimeout,
		noTimeout: -1,
		getCurrentUpdatePriority: () => priority,
		setCurrentUpdatePriority: (value: number) => {
			priority = value
		},
		resolveUpdatePriority: () => priority,
		maySuspendCommit: () => false,
		preloadInstance: () => true,
		startSuspendingCommit: () => {},
		suspendInstance: () => {},
		waitForCommitToBeReady: () => null,
		NotPendingTransition: null,
		HostTransitionContext: React.createContext(null),
		requestPostPaintCallback: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
		resetFormInstance: () => {},
		bindToConsole: () => () => {},
		supportsMicrotasks: true,
		scheduleMicrotask: queueMicrotask,
		detachDeletedInstance: () => {},
		getInstanceFromNode: () => null,
	}
	// SAFETY: React 19's mutation host interface is implemented above; optional hydration/persistence paths are disabled.
	const renderer = Reconciler(config as unknown as Parameters<typeof Reconciler>[0])
	const root = renderer.createContainer(
		container,
		ConcurrentRoot,
		null,
		false,
		null,
		'',
		fail,
		fail,
		fail,
		() => {},
		null,
	)
	// SAFETY: react-reconciler 0.33 exports this method; its 0.32 declaration still names it flushSync.
	const flush = (renderer as unknown as { flushSyncFromReconciler: (cb: () => void) => void }).flushSyncFromReconciler
	listen('message', event => {
		if (
			failed ||
			typeof event.data !== 'string' ||
			event.data.length > 128 * 1024 ||
			new TextEncoder().encode(event.data).length > 128 * 1024
		)
			return
		try {
			const data = parse(event.data) as { type: string; sequence: number; event: CanvasDisplayEvent }
			if (data.type !== 'event' || !safeInteger(data.sequence) || data.sequence <= sequence) return
			const e = data.event
			if (
				!e ||
				typeof e.handle !== 'string' ||
				(e.value !== undefined && (typeof e.value !== 'string' || e.value.length > 4000)) ||
				(e.checked !== undefined && typeof e.checked !== 'boolean')
			)
				throw new Error('event')
			if (e.values !== undefined) localValues(e.values)
			const callback = callbacks.get(e.handle)
			sequence = data.sequence
			if (callback) flush(() => callback(e))
			publish()
			emit({ type: 'settled', sequence })
		} catch {
			fail()
		}
	})
	try {
		// Capture compiler-owned data before any producer runs; no references are retained.
		if (metadata) {
			const blocks = descriptor(metadata, 'blocks')?.value
			const fieldIds = descriptor(metadata, 'fieldIds')?.value
			if (!isArray(blocks) || blocks.length > 64 || !isArray(fieldIds) || fieldIds.length > 64)
				throw new Error('metadata')
			const ids = new Set<string>()
			for (const block of blocks) {
				const id = descriptor(block, 'id')?.value
				const start = descriptor(block, 'start')?.value
				const end = descriptor(block, 'end')?.value
				if (
					typeof id !== 'string' ||
					!id.length ||
					id.length > 80 ||
					Array.from(id).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
					ids.has(id) ||
					!safeInteger(start) ||
					!safeInteger(end) ||
					start < 0 ||
					end <= start ||
					end > 512 * 1024
				)
					throw new Error('metadata')
				ids.add(id)
				sourceIds.add(id)
			}
			for (const id of fieldIds) {
				if (typeof id !== 'string' || !ids.has(id) || attestedFields.has(id)) throw new Error('metadata')
				attestedFields.add(id)
			}
		}
		harden()
		const module = { exports: {} as unknown }
		factory(
			module,
			module.exports,
			id => {
				if (id !== 'react') throw new Error('module')
				return React
			},
			runtime,
		)
		const component = (module.exports as { default?: React.ComponentType }).default
		if (
			typeof component !== 'function' &&
			(typeof component !== 'object' ||
				component === null ||
				!['react.memo', 'react.forward_ref', 'react.lazy'].some(
					kind => (component as { $$typeof?: symbol }).$$typeof === Symbol.for(kind),
				))
		)
			throw new Error('component')
		renderer.updateContainer(createElement(component), root, null, () => {
			emit({ type: 'settled', sequence })
		})
	} catch {
		fail()
	}
}

function harden(): void {
	const functionPrototype = Function.prototype
	const timeout = globalThis.setTimeout.bind(globalThis)
	const interval = globalThis.setInterval.bind(globalThis)
	const microtask = globalThis.queueMicrotask.bind(globalThis)
	for (const name of ['clearTimeout', 'clearInterval'] as const)
		Object.defineProperty(globalThis, name, {
			value: globalThis[name].bind(globalThis),
			writable: false,
			configurable: false,
		})
	// String timers are an eval/import bypass even when Function and eval are removed.
	for (const [name, schedule] of [
		['setTimeout', timeout],
		['setInterval', interval],
	] as const) {
		Object.defineProperty(globalThis, name, {
			value: (callback: unknown, delay?: number, ...args: unknown[]) => {
				if (typeof callback !== 'function') throw new TypeError('Canvas timers require callbacks')
				return schedule(() => callback(...args), delay)
			},
			writable: false,
			configurable: false,
		})
	}
	Object.defineProperty(globalThis, 'queueMicrotask', {
		value: (callback: unknown) => {
			if (typeof callback !== 'function') throw new TypeError('Canvas microtasks require callbacks')
			microtask(() => callback())
		},
		writable: false,
		configurable: false,
	})
	// Remove ambient capabilities, including inherited WorkerGlobalScope methods.
	const allowed = new Set(
		'Object Function Array Number BigInt Boolean String Symbol Date Math JSON RegExp Error EvalError RangeError ReferenceError SyntaxError TypeError URIError AggregateError Map Set WeakMap WeakSet Promise Reflect Proxy Intl ArrayBuffer SharedArrayBuffer DataView Uint8Array Uint8ClampedArray Uint16Array Uint32Array Int8Array Int16Array Int32Array Float32Array Float64Array BigInt64Array BigUint64Array Atomics TextEncoder TextDecoder Infinity NaN undefined globalThis self setTimeout clearTimeout setInterval clearInterval queueMicrotask performance'.split(
			' ',
		),
	)
	for (
		let object: object | null = globalThis;
		object && object !== Object.prototype;
		object = Object.getPrototypeOf(object)
	) {
		for (const name of Object.getOwnPropertyNames(object))
			if (!allowed.has(name)) {
				const desc = Object.getOwnPropertyDescriptor(object, name)
				if (desc?.configurable)
					Object.defineProperty(object, name, { value: undefined, writable: false, configurable: false })
				else if (desc?.writable) Object.defineProperty(object, name, { value: undefined, writable: false })
			}
	}
	for (const prototype of [
		Function.prototype,
		Object.getPrototypeOf(async () => {}),
		Object.getPrototypeOf(function* () {}),
		Object.getPrototypeOf(async function* () {}),
	])
		Object.defineProperty(prototype, 'constructor', { value: undefined, writable: false, configurable: false })
	Object.defineProperty(globalThis, 'Function', { value: undefined, writable: false, configurable: false })
	// Global slot replacement is as dangerous as prototype mutation: secure native getters/inherited values too.
	const retained = new Map<string, unknown>()
	for (const name of allowed) retained.set(name, Reflect.get(globalThis, name))
	for (const [name, value] of retained)
		Object.defineProperty(globalThis, name, { value, writable: false, configurable: false })
	// Producer prototype mutation must not alter the runtime's validators or serialization.
	for (const value of retained.values()) {
		if (value && (typeof value === 'object' || typeof value === 'function') && value !== globalThis) {
			const prototype = Object.getOwnPropertyDescriptor(value, 'prototype')?.value
			if (prototype) Object.freeze(prototype)
			Object.freeze(value)
		}
	}
	Object.freeze(functionPrototype)
	Object.freeze(Object.prototype)
}
