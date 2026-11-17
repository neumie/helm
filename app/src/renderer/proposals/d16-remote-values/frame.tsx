// D16 proposal frames (docs/plans/design-system/proposals/D16.md), adapted from the deleted D16 frames. Each frame is
// an iframe of an EXISTING production story at a realistic window size (Remote frames at phone width, so its viewport
// media queries pick the phone layout), or of a static production document (`srcDoc`, the offline page). The variant CSS is appended at the end of the frame's <body>, after every app stylesheet, so it wins on
// equal specificity and touches nothing outside that frame. Nothing here is imported by production code.
import { useEffect, useRef, useState } from 'react'

export interface FrameSpec {
	/** Story id of the existing production story, e.g. "views-helm-remote--reading". */
	id: string
	/** A static production document shown instead of a story (the frame then waits for its <body>, not a story root). */
	srcDoc?: string
	/** Plain label above the frame: what it shows and where the value lives. */
	label: string
	width: number
	height: number
	/** Magnifies the frame (CSS zoom) so 10-11 px details are comparable; the frame keeps its own window size. */
	zoom?: number
	/** Storybook `args` URL value, e.g. "frame:not-sent". */
	args?: string
	/** Interaction that reveals the surface (open a menu, push a page). Runs after the story mounted. */
	setup?: (frame: FrameContext) => Promise<void>
	/**
	 * Keeps the page's focus in this frame (e.g. the dock pane, whose key hints show only while it holds the keys).
	 * Every other frame gives the focus back after its setup: only one frame on the page can hold it, so a leftover
	 * focus ring would land in whichever frame finished last and read as a difference between variants.
	 */
	keepFocus?: boolean
	/**
	 * Shows only the region around one element (its box plus `pad` px), magnified by `zoom`. The story still lays
	 * out at the frame's full window size; the crop only clips what is shown.
	 */
	crop?: { selector: string; pad: number }
}

export interface FrameContext {
	doc: Document
	win: Window
	/** The variant CSS (for surfaces inside a shadow root, which the body <style> cannot reach). */
	css: string
}

/** The framed story's Storybook channel (only the two methods used here). */
interface StoryChannel {
	on(event: string, listener: () => void): void
	off(event: string, listener: () => void): void
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Polls until `find` returns an element (8s), so setups can wait for asynchronously mounted UI. */
export async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
	const deadline = Date.now() + 8000
	for (;;) {
		const found = find()
		if (found) return found
		if (Date.now() > deadline) throw new Error(`D16 frame: ${what} did not appear`)
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

function StoryFrame({ spec, css }: { spec: FrameSpec; css: string }) {
	const ref = useRef<HTMLIFrameElement>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [region, setRegion] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
	const src = `iframe.html?id=${encodeURIComponent(spec.id)}&viewMode=story${spec.args ? `&args=${spec.args}` : ''}`
	useEffect(() => {
		const iframe = ref.current
		if (!iframe) return
		let disposed = false
		let unsubscribe: (() => void) | undefined
		const prepare = async () => {
			const win = iframe.contentWindow
			const doc = iframe.contentDocument
			if (!win || !doc) return
			if (spec.srcDoc === undefined)
				await waitFor(() => (doc.querySelector('#storybook-root')?.childElementCount ?? 0) > 0, 'story root')
			if (disposed) return
			if (!doc.querySelector('style[data-d16="variant"]')) {
				const style = doc.createElement('style')
				style.dataset.d16 = 'variant'
				style.textContent = css
				doc.body.append(style)
			}
			await spec.setup?.({ doc, win, css })
			if (disposed) return
			if (!spec.keepFocus) {
				// Move the page's focus out of this frame without blurring inside it: an element blur closes the
				// menus and sheets the setup opened, while a frame that merely lost the page's focus keeps them open
				// and draws no focus ring. Story autofocus can land late, hence the short wait.
				await sleep(300)
				if (disposed) return
				if (document.activeElement === iframe) iframe.blur()
			}
			if (spec.crop) {
				const { selector, pad } = spec.crop
				const target = await waitFor(() => doc.querySelector(selector), selector)
				// Let late layout (fonts, async content) settle before measuring.
				await sleep(400)
				if (disposed) return
				const box = target.getBoundingClientRect()
				// Clamp to the frame's window, so a surface at its edge never shows empty space past it.
				const x = Math.max(0, box.left - pad)
				const y = Math.max(0, box.top - pad)
				setRegion({
					x,
					y,
					width: Math.min(spec.width, box.right + pad) - x,
					height: Math.min(spec.height, box.bottom + pad) - y,
				})
			}
			// The framed story re-renders when Storybook hot-reloads any module (another story file saved), which
			// drops the state the setup made (typed draft, open menu). Run the setup again after such a re-render.
			if (unsubscribe === undefined && spec.srcDoc === undefined) {
				const channel = (win as Window & { __STORYBOOK_ADDONS_CHANNEL__?: StoryChannel }).__STORYBOOK_ADDONS_CHANNEL__
				if (channel) {
					const rerun = () => {
						if (!disposed) onLoad()
					}
					channel.on('storyRendered', rerun)
					unsubscribe = () => channel.off('storyRendered', rerun)
				}
			}
		}
		const onLoad = () => {
			prepare().catch(reason => {
				if (!disposed) setProblem(String(reason))
			})
		}
		// A fresh document has a fresh channel: forget the listener on the old one.
		const onFrameLoad = () => {
			unsubscribe?.()
			unsubscribe = undefined
			onLoad()
		}
		iframe.addEventListener('load', onFrameLoad)
		const loaded = iframe.contentDocument
		if (loaded?.readyState === 'complete' && (spec.srcDoc !== undefined || loaded.URL !== 'about:blank')) onLoad()
		return () => {
			disposed = true
			unsubscribe?.()
			iframe.removeEventListener('load', onFrameLoad)
		}
	}, [css, spec])
	const zoom = spec.zoom ?? 1
	const iframe = (
		<iframe
			ref={ref}
			title={spec.label}
			src={spec.srcDoc === undefined ? src : undefined}
			srcDoc={spec.srcDoc}
			width={spec.width}
			height={spec.height}
			style={spec.zoom === undefined ? undefined : { zoom: spec.zoom }}
		/>
	)
	return (
		<figure className="d16-frame">
			<figcaption className="d16-frame-label">
				{problem ?? (spec.zoom === undefined ? spec.label : `${spec.label} · zvětšeno ${spec.zoom}×`)}
			</figcaption>
			{spec.crop ? (
				// Until the region is measured the crop shows the frame's top-left corner at its final size.
				<div
					className="d16-crop"
					style={{
						width: (region?.width ?? 320) * zoom,
						height: (region?.height ?? 120) * zoom,
					}}
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
.proposal-stage .d16-board { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; padding: 16px; }
.proposal-stage .d16-frame { display: grid; gap: 4px; margin: 0; }
.proposal-stage .d16-frame-label { color: var(--text-2); font: 11px / 16px var(--font-mono); }
.proposal-stage .d16-frame iframe { display: block; border: 1px solid var(--hairline-strong); background: var(--pane); }
.proposal-stage .d16-crop { position: relative; overflow: hidden; border: 1px solid var(--hairline-strong); }
.proposal-stage .d16-crop iframe { border: 0; }
`

export function Board({ frames, css }: { frames: readonly FrameSpec[]; css: string }) {
	return (
		<div className="d16-board">
			{frames.map(spec => (
				<StoryFrame key={`${spec.id}:${spec.label}`} spec={spec} css={css} />
			))}
		</div>
	)
}
