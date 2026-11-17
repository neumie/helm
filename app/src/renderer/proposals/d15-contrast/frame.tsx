// D15 proposal frames (docs/plans/design-system/proposals/D15.md), adapted from the deleted D8 frame. Each frame is
// an iframe of an EXISTING production story. The frame CSS (the palette, any state copy, then the variant) is
// appended at the end of the frame's <body>, after every app stylesheet, so it wins on equal specificity and touches
// nothing outside that frame. A crop shows only the region around one element, magnified. Nothing here is imported
// by production code.
import { useEffect, useRef, useState } from 'react'
import { HIGH_CONTRAST_CSS, STATE_CSS } from './values'

export interface FrameSpec {
	/** Story id of the existing production story, e.g. "compositions-list-row--verdict-rows". */
	id: string
	/** Plain label above the frame: what it shows. */
	label: string
	width: number
	height: number
	/**
	 * Magnifies the frame (CSS zoom) so 11-12 px meta text is comparable; the frame keeps its own window size. Chromium
	 * does not paint a `::-webkit-scrollbar` inside a zoomed (or scaled) iframe, so frames showing a styled native scrollbar
	 * omit it.
	 */
	zoom?: number
	/** CSS shared by every variant for this frame, appended before the variant. */
	base?: string
	/**
	 * `high` applies the whole High contrast preset to the frame's :root (what the theme picker does) and marks it
	 * `data-d15-palette="high"`, so a variant can give High contrast its own value.
	 */
	palette?: 'high'
	/** Interaction that puts the surface in the state that matters (hover, pressed, open). Runs after mount. */
	setup?: (frame: FrameContext) => Promise<void>
	/**
	 * Shows only the region around one element (its box plus `pad` px), magnified by `zoom`; `right` / `bottom`
	 * keep only that many px at the element's right / bottom edge (a scrollbar, the last terminal rows).
	 */
	crop?: { selector: string; pad: number; right?: number; bottom?: number }
}

export interface FrameContext {
	doc: Document
	win: Window
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Polls until `find` returns something truthy (8s), so setups can wait for asynchronously mounted UI. */
export async function waitFor<T>(find: () => T | null | undefined | false, what: string): Promise<T> {
	const deadline = Date.now() + 8000
	for (;;) {
		const found = find()
		if (found) return found
		if (Date.now() > deadline) throw new Error(`D15 frame: ${what} did not appear`)
		await sleep(50)
	}
}

/** Sets `name=value` on every element matching `selector` (or the `pick`ed ones). */
export async function mark(doc: Document, selector: string, name: string, value: string, pick?: number[]) {
	const all = await waitFor(() => {
		const found = [...doc.querySelectorAll<HTMLElement>(selector)]
		return found.length > 0 ? found : null
	}, selector)
	all.forEach((element, index) => {
		if (pick === undefined || pick.includes(index)) element.setAttribute(name, value)
	})
}

function StoryFrame({ spec, css }: { spec: FrameSpec; css: string }) {
	const ref = useRef<HTMLIFrameElement>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [region, setRegion] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
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
			style.dataset.d15 = 'variant'
			if (spec.palette === 'high') doc.documentElement.dataset.d15Palette = 'high'
			style.textContent = `${spec.palette === 'high' ? HIGH_CONTRAST_CSS : ''}\n${STATE_CSS}\n${spec.base ?? ''}\n${css}`
			doc.body.append(style)
			await spec.setup?.({ doc, win })
			if (disposed) return
			// Give the page's focus back without blurring inside the frame (a blur closes what the setup opened).
			await sleep(300)
			if (disposed) return
			if (document.activeElement === iframe) iframe.blur()
			if (spec.crop) {
				const { selector, pad, right, bottom } = spec.crop
				const target = await waitFor(() => doc.querySelector(selector), selector)
				await sleep(400)
				if (disposed) return
				const box = target.getBoundingClientRect()
				const left = right === undefined ? box.left : Math.max(box.left, box.right - right)
				const top = bottom === undefined ? box.top : Math.max(box.top, box.bottom - bottom)
				setRegion({
					x: Math.max(0, left - pad),
					y: Math.max(0, top - pad),
					width: box.right - left + 2 * pad,
					height: box.bottom - top + 2 * pad,
				})
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
		<figure className="d15-frame">
			<figcaption className="d15-frame-label">
				{problem ??
					`${spec.palette === 'high' ? 'High contrast · ' : ''}${spec.label}${spec.zoom === undefined ? '' : ` · zvětšeno ${spec.zoom}×`}`}
			</figcaption>
			{spec.crop ? (
				<div
					className="d15-crop"
					style={{ width: (region?.width ?? 320) * zoom, height: (region?.height ?? 120) * zoom }}
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

/** Framing only (identical in every variant). The caption keeps a fixed height so variants never shift the stage. */
export const BOARD_CSS = `
.proposal[data-decision^="D15"] .proposal-caption { box-sizing: border-box; min-height: 110px; align-content: flex-start; }
.proposal-stage .d15-board { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; padding: 16px; }
.proposal-stage .d15-frame { display: grid; gap: 4px; margin: 0; }
.proposal-stage .d15-frame-label { color: var(--text-1); font: 12px / 18px var(--font-ui); max-width: 640px; }
.proposal-stage .d15-frame iframe { display: block; border: 1px solid var(--hairline-strong); background: var(--pane); }
.proposal-stage .d15-crop { position: relative; overflow: hidden; border: 1px solid var(--hairline-strong); }
.proposal-stage .d15-crop iframe { border: 0; }
`

export function Board({ frames, css }: { frames: readonly FrameSpec[]; css: string }) {
	return (
		<div className="d15-board">
			{frames.map(spec => (
				<StoryFrame key={`${spec.id}:${spec.label}`} spec={spec} css={css} />
			))}
		</div>
	)
}
