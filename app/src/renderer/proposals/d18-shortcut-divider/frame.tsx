// D18 proposal frames (docs/plans/design-system/proposals/D18.md), adapted from the deleted D8 frame. Each frame is
// an iframe of the EXISTING production story Views / Sidebar / Terminal settings. The variant CSS is appended at the
// end of the frame's <body>, after every app stylesheet, so it wins on equal specificity and touches nothing outside
// that frame. A crop shows only the region around one element, magnified, so a 1px line is visible.
// Nothing here is imported by production code.
import { useEffect, useRef, useState } from 'react'

export interface FrameSpec {
	/** Plain label above the frame (Czech): what it shows. */
	label: string
	/** Finds the element(s) to crop around, after the story mounted; several elements crop to their union. */
	pick: (doc: Document) => Element | readonly Element[] | null | undefined
	/** Pixels around the picked element. */
	pad: number
	zoom: number
	/** Marks the picked chip's remove (×) button as hovered: the variant CSS styles `[data-d18-hover]` like :hover. */
	hoverRemove?: boolean
}

const STORY_ID = 'views-sidebar--terminal-settings'
const WIDTH = 420
const HEIGHT = 900

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
	const deadline = Date.now() + 8000
	for (;;) {
		const found = find()
		if (found) return found
		if (Date.now() > deadline) throw new Error(`D18 frame: ${what} did not appear`)
		await sleep(50)
	}
}

/**
 * Scrolls the sidebar's own scroller so `target` sits in its middle. Never `scrollIntoView`: that also scrolls the
 * ancestors outside the iframe (the crop box), which moves the crop off the element.
 */
function centerInScroller(target: Element) {
	for (let node = target.parentElement; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY
		if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
			const box = target.getBoundingClientRect()
			const frame = node.getBoundingClientRect()
			node.scrollTop += box.top - frame.top - (node.clientHeight - box.height) / 2
			return
		}
	}
}

const union = (boxes: readonly DOMRect[]) => {
	const left = Math.min(...boxes.map(b => b.left))
	const top = Math.min(...boxes.map(b => b.top))
	const right = Math.max(...boxes.map(b => b.right))
	const bottom = Math.max(...boxes.map(b => b.bottom))
	return { left, top, width: right - left, height: bottom - top }
}

/** The fieldset row of one shortcut action (rows carry the action label as aria-label). */
export const row = (doc: Document, label: string) => doc.querySelector(`fieldset.shortcut-row[aria-label="${label}"]`)

function StoryFrame({ spec, css }: { spec: FrameSpec; css: string }) {
	const ref = useRef<HTMLIFrameElement>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [region, setRegion] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
	useEffect(() => {
		const iframe = ref.current
		if (!iframe) return
		let disposed = false
		const prepare = async () => {
			const doc = iframe.contentDocument
			if (!doc) return
			await waitFor(() => (doc.querySelector('#storybook-root')?.childElementCount ?? 0) > 0, 'story root')
			const pick = (): readonly Element[] | null => {
				const found = spec.pick(doc)
				if (Array.isArray(found)) return found.length > 0 ? found : null
				return found ? [found as Element] : null
			}
			await waitFor(pick, spec.label)
			if (disposed) return
			const style = doc.createElement('style')
			style.dataset.d18 = 'variant'
			style.textContent = css
			doc.body.append(style)
			// The settings page mounts its preferences asynchronously and may still be sliding in: center and measure
			// until two measurements agree (fonts, async content, the push transition).
			let last = ''
			for (let attempt = 0; attempt < 20; attempt++) {
				// Re-pick every round: a late preferences snapshot can re-render the rows.
				const targets = await waitFor(pick, spec.label)
				const target = targets[0] as Element
				if (spec.hoverRemove) target.querySelector('button + button')?.setAttribute('data-d18-hover', '')
				centerInScroller(target)
				await sleep(250)
				if (disposed) return
				const box = union(targets.map(element => element.getBoundingClientRect()))
				const measured = {
					x: Math.max(0, box.left - spec.pad),
					y: Math.max(0, box.top - spec.pad),
					width: box.width + 2 * spec.pad,
					height: box.height + 2 * spec.pad,
				}
				const key = JSON.stringify(measured)
				if (key === last) {
					setRegion(measured)
					return
				}
				last = key
			}
			throw new Error('D18 frame: layout did not settle')
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
	const zoom = spec.zoom
	return (
		<figure className="d18-frame">
			<figcaption className="d18-frame-label">{problem ?? `${spec.label} · zvětšeno ${zoom}×`}</figcaption>
			<div className="d18-crop" style={{ width: (region?.width ?? 120) * zoom, height: (region?.height ?? 40) * zoom }}>
				<div style={{ position: 'absolute', left: -(region?.x ?? 0) * zoom, top: -(region?.y ?? 0) * zoom }}>
					<iframe
						ref={ref}
						title={spec.label}
						src={`iframe.html?id=${STORY_ID}&viewMode=story`}
						width={WIDTH}
						height={HEIGHT}
						style={{ zoom }}
					/>
				</div>
			</div>
		</figure>
	)
}

/** Framing only (identical in every variant). */
export const BOARD_CSS = `
.proposal-stage .d18-board { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 24px; padding: 16px; }
.proposal-stage .d18-frame { display: grid; gap: 4px; margin: 0; }
.proposal-stage .d18-frame-label { color: var(--text-2); font: 11px / 16px var(--font-mono); }
.proposal-stage .d18-crop { position: relative; overflow: hidden; border: 1px solid var(--hairline-strong); background: var(--pane); }
.proposal-stage .d18-crop iframe { display: block; border: 0; }
.proposal-stage .d18-aside { flex-basis: 100%; margin: 0; color: var(--text-2); font-size: 12px; }
`

export function Board({ frames, css }: { frames: readonly FrameSpec[]; css: string }) {
	return (
		<div className="d18-board">
			<p className="d18-aside">
				Světlé čáry nad jamkou a podél řádků jsou výchozí rámeček prohlížeče kolem řádku (fieldset). Je to jiná chyba,
				mimo D18, ve všech variantách stejná.
			</p>
			{frames.map(spec => (
				<StoryFrame key={spec.label} spec={spec} css={css} />
			))}
		</div>
	)
}
