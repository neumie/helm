// D17 proposal frames (docs/plans/design-system/proposals/D17.md), adapted from the D8 frames. Each frame is an
// iframe of an EXISTING production story at a realistic window size. The variant CSS is appended at the end of the
// frame's <body>, after every app stylesheet, so it wins on equal specificity and touches nothing outside that
// frame. A crop shows only the region around one element, magnified, so 1-3 px details are comparable. Nothing
// here is imported by production code.
import { useEffect, useRef, useState } from 'react'

export interface FrameContext {
	doc: Document
	win: Window
	/** The variant CSS (for surfaces inside a shadow root, which the body <style> cannot reach). */
	css: string
}

export interface CropSpec {
	/** Element to crop around (first match), or a finder for elements a selector cannot reach (shadow roots). */
	selector?: string
	find?: (frame: FrameContext) => Element | null | undefined
	/** Extra px around the element's box. */
	pad: number
	/** Clamps the region to this width/height from its top-left (a corner of a large element). */
	width?: number
	height?: number
}

export interface FrameSpec {
	/** Story id of the existing production story, e.g. "views-sidebar--work-list". */
	id: string
	/** Plain label above the frame (Czech): what it shows and where the value lives. */
	label: string
	width: number
	height: number
	/** Magnifies the frame (CSS zoom); the frame keeps its own window size. */
	zoom?: number
	/** Interaction that reveals the surface (open a menu, focus a field). Runs after the story mounted. */
	setup?: (frame: FrameContext) => Promise<void>
	crop?: CropSpec
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Polls until `find` returns a value (8s), so setups can wait for asynchronously mounted UI. */
export async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
	const deadline = Date.now() + 8000
	for (;;) {
		const found = find()
		if (found) return found
		if (Date.now() > deadline) throw new Error(`D17 frame: ${what} did not appear`)
		await sleep(50)
	}
}

/** Clicks the first element matching `selector` (optionally whose text includes `text`). */
export async function click(doc: Document, selector: string, text?: string): Promise<void> {
	const element = await waitFor(
		() =>
			[...doc.querySelectorAll<HTMLElement>(selector)].find(
				candidate => text === undefined || candidate.textContent?.includes(text),
			),
		text === undefined ? selector : `${selector} "${text}"`,
	)
	element.click()
	await sleep(300)
}

interface Region {
	x: number
	y: number
	width: number
	height: number
}

function StoryFrame({ spec, css }: { spec: FrameSpec; css: string }) {
	const ref = useRef<HTMLIFrameElement>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [region, setRegion] = useState<Region | null>(null)
	const src = `iframe.html?id=${encodeURIComponent(spec.id)}&viewMode=story`
	useEffect(() => {
		const iframe = ref.current
		if (!iframe) return
		let disposed = false
		const prepare = async () => {
			const win = iframe.contentWindow
			const doc = iframe.contentDocument
			if (!win || !doc) return
			await waitFor(() => (doc.querySelector('#storybook-root')?.childElementCount ?? 0) > 0, 'story root')
			if (disposed) return
			const style = doc.createElement('style')
			style.dataset.d17 = 'variant'
			style.textContent = css
			doc.body.append(style)
			const context = { doc, win, css }
			await spec.setup?.(context)
			if (disposed) return
			// Move the page's focus out of this frame without blurring inside it (a blur closes opened menus).
			await sleep(300)
			if (disposed) return
			if (document.activeElement === iframe) iframe.blur()
			const crop = spec.crop
			if (crop) {
				// A nested frame below the fold gets no animation frames, so UI that lays out on rAF (terminal
				// workspace, popovers) settles only once it is scrolled into view: keep measuring for a while and
				// follow the element's laid-out box.
				const find = () => (crop.find ? crop.find(context) : crop.selector ? doc.querySelector(crop.selector) : null)
				let last = ''
				for (let round = 0; round < 60 && !disposed; round += 1) {
					const box = find()?.getBoundingClientRect()
					if (box && box.width > 0 && box.height > 0) {
						const x = Math.max(0, box.left - crop.pad)
						const y = Math.max(0, box.top - crop.pad)
						const next = {
							x,
							y,
							width: crop.width ?? box.right + crop.pad - x,
							height: crop.height ?? box.bottom + crop.pad - y,
						}
						const key = JSON.stringify(next)
						if (key !== last) {
							last = key
							setRegion(next)
						}
					}
					await sleep(500)
				}
				if (!disposed && last === '') setProblem(`D17 frame: ${crop.selector ?? 'crop target'} has no box`)
			}
		}
		const onLoad = () => {
			prepare().catch(reason => {
				if (!disposed) setProblem(String(reason))
			})
		}
		iframe.addEventListener('load', onLoad)
		const loaded = iframe.contentDocument
		if (loaded?.readyState === 'complete' && loaded.URL !== 'about:blank') onLoad()
		return () => {
			disposed = true
			iframe.removeEventListener('load', onLoad)
		}
	}, [css, spec])
	const zoom = spec.zoom ?? 1
	const iframe = (
		<iframe
			ref={ref}
			title={spec.label}
			src={src}
			width={spec.width}
			height={spec.height}
			style={spec.zoom === undefined ? undefined : { zoom: spec.zoom }}
		/>
	)
	return (
		<figure className="d17-frame">
			<figcaption className="d17-frame-label">
				{problem ?? (spec.zoom === undefined ? spec.label : `${spec.label} · zvětšeno ${spec.zoom}×`)}
			</figcaption>
			{spec.crop ? (
				// Until the region is measured the crop shows the frame's top-left corner.
				<div
					className="d17-crop"
					style={{ width: (region?.width ?? 200) * zoom, height: (region?.height ?? 80) * zoom }}
				>
					<div style={{ position: 'absolute', left: -(region?.x ?? 0) * zoom, top: -(region?.y ?? 0) * zoom }}>
						{iframe}
					</div>
				</div>
			) : (
				iframe
			)}
		</figure>
	)
}

/** Framing only (identical in every variant). */
export const BOARD_CSS = `
.proposal-stage .d17-board { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; padding: 16px; }
.proposal-stage .d17-frame { display: grid; gap: 4px; margin: 0; }
.proposal-stage .d17-frame-label { max-width: 520px; color: var(--text-2); font: 11px / 16px var(--font-mono); }
.proposal-stage .d17-frame iframe { display: block; border: 1px solid var(--hairline-strong); background: var(--pane); }
/* clip, not hidden: a story that focuses a field would scroll a hidden-overflow crop away from its region. */
.proposal-stage .d17-crop { position: relative; overflow: clip; border: 1px solid var(--hairline-strong); }
.proposal-stage .d17-crop iframe { border: 0; }
`

export function Board({ frames, css }: { frames: readonly FrameSpec[]; css: string }) {
	return (
		<div className="d17-board">
			{frames.map(spec => (
				<StoryFrame key={`${spec.id}:${spec.label}`} spec={spec} css={css} />
			))}
		</div>
	)
}

/** Opens the extension widget card and puts the variant CSS inside its closed shadow root. */
export async function openWidget({ win, css }: FrameContext): Promise<Element> {
	interface WidgetHarness {
		require(selector: string): HTMLElement
		query(selector: string): HTMLElement | null
	}
	const harness = await waitFor(
		() => (win as Window & { extensionWorkbench?: WidgetHarness }).extensionWorkbench,
		'extension widget harness',
	)
	harness.require('.vg-pill').click()
	const close = await waitFor(() => harness.query('.vg-close'), 'widget close')
	// The frame has its own realm: compare by shape, not `instanceof ShadowRoot`.
	const root = close.getRootNode() as ShadowRoot | Document
	if (css !== '' && 'host' in root) {
		const style = close.ownerDocument.createElement('style')
		style.textContent = css
		root.append(style)
	}
	return close
}
