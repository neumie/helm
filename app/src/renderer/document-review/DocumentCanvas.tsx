import { createElement, useLayoutEffect, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode } from 'react'
import type { CanvasDisplayEvent, CanvasFieldValue, ReviewApi, ReviewDocument } from '../../document-review/types'
import { buttonClassName } from '../button'
import { PassageComments } from './PassageComments'
import {
	CanvasFrameGate,
	canvasSourceBlock,
	canvasWorkerInvocation,
	validateCanvasFrame,
	validateCanvasValues,
} from './canvas-display'
import type { ValidatedCanvasFrame, ValidatedCanvasNode } from './canvas-display'
type LocalCanvasEvent = CanvasDisplayEvent & { values?: string[] }
import { reviewCanvasWorkerSource } from './canvas-runtime.generated'
import type { PassageThread } from './passage-threads'

export interface DocumentCanvasHandle {
	/** Synchronous native admission check; null means busy/stale/unavailable, not empty fields. */
	read(documentId: string, revision: string, api: ReviewApi): CanvasFieldValue[] | null
}
export interface DocumentCanvasProps {
	document: ReviewDocument
	api: ReviewApi
	handle: MutableRefObject<DocumentCanvasHandle | null>
	onReady: (ready: boolean) => void
	threads?: Map<string, PassageThread[]>
	binding: string
}

/** Only inert validated React elements enter the privileged renderer. Source executes only in Worker. */
export function DocumentCanvas({ document: doc, api, handle, onReady, threads, binding }: DocumentCanvasProps) {
	const root = useRef<HTMLDivElement>(null)
	const [frame, setFrame] = useState<ValidatedCanvasFrame | null>(null)
	const [error, setError] = useState<string | null>(null)
	const renderedFrame = useRef<ValidatedCanvasFrame | null>(null)
	useLayoutEffect(() => {
		renderedFrame.current = frame
	}, [frame])
	const dispatch = useRef<(event: LocalCanvasEvent) => void>(() => {})
	const reportError = useRef<(message: string) => void>(() => {})
	const readiness = useRef(onReady)
	readiness.current = onReady
	// biome-ignore lint/correctness/useExhaustiveDependencies: Compilation belongs to source revision; fresh archive-only DTOs must never restart the canvas.
	useLayoutEffect(() => {
		const compilation = doc.canvas
		const gate = new CanvasFrameGate()
		let alive = true
		let acceptedFrame: ValidatedCanvasFrame | null = null
		let worker: Worker | null = null
		let timer: ReturnType<typeof setTimeout> | null = null
		let url: string | null = null
		setFrame(null)
		setError(null)
		readiness.current(false)
		const stop = (message: string) => {
			gate.dispose()
			worker?.terminate()
			if (timer !== null) clearTimeout(timer)
			if (alive) {
				setError(message)
				setFrame(null)
				readiness.current(false)
			}
		}
		reportError.current = stop
		const deadline = () => {
			if (timer !== null) clearTimeout(timer)
			timer = setTimeout(() => stop('Document canvas stopped responding. Reopen the document or read Source.'), 2000)
		}
		const currentHandle: DocumentCanvasHandle = {
			read(id, revision, currentApi) {
				if (
					!alive ||
					id !== doc.id ||
					revision !== doc.revision ||
					currentApi !== api ||
					!gate.ready ||
					renderedFrame.current !== acceptedFrame ||
					!root.current ||
					!compilation
				)
					return null
				const values: CanvasFieldValue[] = []
				let units = 0
				for (const field of gate.fields) {
					const matches = root.current.querySelectorAll(`[data-canvas-field="${CSS.escape(field.id)}"]`)
					if (matches.length !== 1) return null
					const control = matches[0]
					if (
						!(
							control instanceof HTMLInputElement ||
							control instanceof HTMLTextAreaElement ||
							control instanceof HTMLSelectElement
						)
					)
						return null
					if (control instanceof HTMLSelectElement && control.multiple) return null
					const value =
						control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)
							? control.checked
							: control.value
					if (typeof value === 'string') {
						units += value.length
						if (value.length > 4000 || units > 16384) return null
					}
					values.push({ id: field.id, value })
				}
				return values
			},
		}
		handle.current = currentHandle
		dispatch.current = event => {
			if (!alive || gate.retired || !worker) return
			const sequence = gate.admit()
			readiness.current(false)
			deadline()
			worker.postMessage(JSON.stringify({ type: 'event', sequence, event }))
		}
		if (!compilation?.code || compilation.error)
			stop(compilation?.error ?? 'Document canvas could not be compiled. Read Source.')
		else {
			try {
				url = URL.createObjectURL(
					new Blob([reviewCanvasWorkerSource, canvasWorkerInvocation(compilation)], { type: 'text/javascript' }),
				)
				worker = new Worker(url)
				worker.onmessage = event => {
					if (!alive || gate.retired) return
					try {
						if (
							typeof event.data !== 'string' ||
							event.data.length > 128 * 1024 ||
							new TextEncoder().encode(event.data).length > 128 * 1024
						)
							throw new Error('Invalid canvas response')
						const message = JSON.parse(event.data)
						if (!message || typeof message !== 'object') throw new Error('Invalid canvas response')
						if (message.type === 'error') {
							stop(typeof message.error === 'string' ? message.error.slice(0, 1000) : 'Document canvas unavailable.')
							return
						}
						if (!Number.isSafeInteger(message.sequence) || message.sequence < 0)
							throw new Error('Invalid canvas sequence')
						if (message.type === 'frame') {
							const next = validateCanvasFrame(message.frame, compilation, doc.text.length)
							if (gate.frame(message.sequence, next.fields)) {
								acceptedFrame = next
								setFrame(next)
							}
						} else if (message.type === 'settled') gate.settle(message.sequence)
						else throw new Error('Invalid canvas response')
						if (gate.ready) {
							if (timer !== null) clearTimeout(timer)
							readiness.current(true)
						}
					} catch {
						stop('Document canvas returned an unsupported display. Read Source.')
					}
				}
				worker.onerror = () => stop('Document canvas failed. Read Source.')
				deadline()
			} catch {
				stop('Document canvas is unavailable in this browser. Read Source.')
			}
		}
		return () => {
			alive = false
			gate.dispose()
			worker?.terminate()
			if (timer !== null) clearTimeout(timer)
			if (url) URL.revokeObjectURL(url)
			if (handle.current === currentHandle) handle.current = null
			dispatch.current = () => {}
			reportError.current = () => {}
		}
	}, [doc.id, doc.revision, api, handle])
	const occurrences = new Map<string, number>()
	const visit = (nodes: (string | ValidatedCanvasNode)[]) => {
		for (const node of nodes)
			if (typeof node !== 'string') {
				const id = node.props.id
				if (typeof id === 'string') occurrences.set(id, (occurrences.get(id) ?? 0) + 1)
				visit(node.children)
			}
	}
	if (frame) visit(frame.nodes)
	const render = (node: string | ValidatedCanvasNode): ReactNode => {
		if (typeof node === 'string') return node
		const publicId = typeof node.props.id === 'string' ? node.props.id : null
		const block =
			publicId && node.sourceId === publicId && occurrences.get(publicId) === 1
				? canvasSourceBlock(doc.canvas, node.sourceId, doc.text.length)
				: null
		const control = ['input', 'textarea', 'select'].includes(node.tag)
		const field =
			control &&
			block &&
			publicId &&
			doc.canvas?.fieldIds.includes(publicId) &&
			frame?.fields.some(field => field.id === publicId)
		const localOnly = control && !field
		const helperId = `canvas-local-${node.id}`
		const { id: _sourceId, ...safeProps } = node.props
		const props: Record<string, unknown> = { ...safeProps, key: node.id }
		if (node.tag === 'button') props.className = buttonClassName({ tone: 'quiet', sm: true })
		if (publicId) props.id = `canvas-${publicId}`
		if (block) {
			props['data-source-start'] = block.start
			props['data-source-end'] = block.end
			props['data-canvas-id'] = block.id
		}
		if (field) props['data-canvas-field'] = publicId
		if (localOnly) props['aria-describedby'] = helperId
		if (node.props.htmlFor) props.htmlFor = `canvas-${node.props.htmlFor}`
		if (node.events?.click) props.onClick = () => dispatch.current({ handle: node.events?.click ?? '' })
		if (node.events?.change)
			props.onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
				let values: string[] | undefined
				if (event.currentTarget instanceof HTMLSelectElement && event.currentTarget.multiple) {
					try {
						values = validateCanvasValues([...event.currentTarget.selectedOptions].map(option => option.value))
					} catch {
						reportError.current('Local selection exceeds the document canvas limit. Read Source.')
						return
					}
				}
				dispatch.current({
					handle: node.events?.change ?? '',
					value: event.currentTarget.value.slice(0, 4000),
					...(values ? { values } : {}),
					...(event.currentTarget instanceof HTMLInputElement ? { checked: event.currentTarget.checked } : {}),
				})
			}
		if (['input', 'textarea', 'select'].includes(node.tag)) {
			if (!node.events?.change) props.readOnly = true
			if (node.tag === 'select' && !node.events?.change) props.disabled = true
			if (node.props.value !== undefined && node.props.defaultValue !== undefined) props.defaultValue = undefined
			if (node.props.checked !== undefined && node.props.defaultChecked !== undefined) props.defaultChecked = undefined
		}
		if (node.tag === 'input' || node.tag === 'textarea')
			props.maxLength = Math.min(4000, Number(props.maxLength) || 4000)
		const content = createElement(node.tag, props, ...node.children.map(render))
		const element = localOnly ? (
			<span key={node.id} className="review-canvas-local-control">
				{content}
				<small id={helperId}>Local only · values not included in feedback</small>
			</span>
		) : (
			content
		)
		if (block && threads?.has(block.id))
			return (
				<div key={node.id} className="review-block">
					<div className="review-block-text">{element}</div>
					<PassageComments
						key={`${binding}:${node.id}`}
						threads={threads.get(block.id) ?? []}
						api={api}
						providerName="Original conversation"
					/>
				</div>
			)
		return element
	}
	return (
		<div ref={root} className="review-canvas" aria-label="Interactive document">
			{error ? (
				<p role="alert">{error}</p>
			) : frame ? (
				frame.nodes.map(render)
			) : (
				<output>Opening document canvas…</output>
			)}
		</div>
	)
}
