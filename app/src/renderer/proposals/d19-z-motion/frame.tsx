// D19 proposal frames (docs/plans/design-system/proposals/D19.md), adapted from the D8 frames: each frame is an
// iframe of an EXISTING production story (Remote at phone width, so its media queries pick the phone layout). A
// setup opens the surface through its real controls; the variant CSS is appended at the end of the frame's <body>,
// after every app stylesheet. "Přehrát" restarts the real CSS entrance animations of the named elements in every
// frame on the page at once (Web Animations: cancel + play), optionally slowed down. Nothing here is imported by
// production code.
import { useEffect, useRef, useState } from 'react'
import { Btn } from '../../button'
import { type Motion, SURFACE_LABEL, type Surface, type Timing, durationMs, ease, msToShare } from './timing'

export interface FrameSpec {
	/** Story id of the existing production story, e.g. "views-helm-remote--reading". */
	id: string
	/** Plain label above the frame. */
	label: string
	width: number
	height: number
	/** Magnifies (or shrinks) the frame with CSS zoom; the story keeps its own window size. */
	zoom?: number
	/** Interaction that opens the surface. Runs after the story mounted. */
	setup?: (frame: FrameContext) => Promise<void>
	/** Elements whose entrance animation "Přehrát" restarts. */
	animated: readonly string[]
	/** Shows only the region around one element (its box plus `pad` px). */
	crop?: { selector: string; pad: number }
}

export interface FrameContext {
	doc: Document
	win: Window
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Polls until `find` returns an element (8s), so setups can wait for asynchronously mounted UI. */
export async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
	const deadline = Date.now() + 8000
	for (;;) {
		const found = find()
		if (found) return found
		if (Date.now() > deadline) throw new Error(`D19 frame: ${what} did not appear`)
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
	await sleep(400)
}

type Replay = (rate: number) => void
/** Every mounted frame's replay, so one button restarts all frames together. */
const replays = new Set<Replay>()

function StoryFrame({ spec, css }: { spec: FrameSpec; css: string }) {
	const ref = useRef<HTMLIFrameElement>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [region, setRegion] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
	const src = `iframe.html?id=${encodeURIComponent(spec.id)}&viewMode=story`
	useEffect(() => {
		const iframe = ref.current
		if (!iframe) return
		let disposed = false
		const replay: Replay = rate => {
			const doc = iframe.contentDocument
			if (!doc) return
			for (const element of doc.querySelectorAll(spec.animated.join(', '))) {
				for (const animation of element.getAnimations()) {
					animation.cancel()
					animation.playbackRate = rate
					animation.play()
				}
			}
		}
		const prepare = async () => {
			const win = iframe.contentWindow
			const doc = iframe.contentDocument
			if (!win || !doc) return
			await waitFor(() => (doc.querySelector('#storybook-root')?.childElementCount ?? 0) > 0, 'story root')
			if (disposed) return
			const style = doc.createElement('style')
			style.dataset.d19 = 'variant'
			style.textContent = css
			doc.body.append(style)
			await spec.setup?.({ doc, win })
			if (disposed) return
			replays.add(replay)
			// Give the page's focus back without blurring inside the frame (a blur would close the opened sheet).
			await sleep(300)
			if (disposed) return
			if (document.activeElement === iframe) iframe.blur()
			if (spec.crop) {
				const { selector, pad } = spec.crop
				const target = await waitFor(() => doc.querySelector(selector), selector)
				await sleep(400)
				if (disposed) return
				const box = target.getBoundingClientRect()
				setRegion({
					x: Math.max(0, box.left - pad),
					y: Math.max(0, box.top - pad),
					width: box.width + 2 * pad,
					height: box.height + 2 * pad,
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
			replays.delete(replay)
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
		<figure className="d19-frame">
			<figcaption className="d19-frame-label">{problem ?? spec.label}</figcaption>
			{spec.crop ? (
				<div
					className="d19-crop"
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

/** Framing only (identical in every variant). */
export const BOARD_CSS = `
.proposal-stage .d19-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 16px 16px 0; }
.proposal-stage .d19-hint { color: var(--text-2); font-size: 12px; }
.proposal-stage .d19-row { padding: 12px 16px 0; }
.proposal-stage .d19-row-title { color: var(--text-0); font-size: 13px; font-weight: 600; }
.proposal-stage .d19-board { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; padding: 8px 0 0; }
.proposal-stage .d19-frame { display: grid; gap: 4px; margin: 0; width: min-content; }
.proposal-stage .d19-frame-label { color: var(--text-2); font: 11px / 16px var(--font-mono); }
.proposal-stage .d19-frame iframe { display: block; border: 1px solid var(--hairline-strong); background: var(--pane); }
.proposal-stage .d19-crop { position: relative; overflow: hidden; border: 1px solid var(--hairline-strong); }
.proposal-stage .d19-crop iframe { border: 0; }
.proposal-stage .d19-charts { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; }
.proposal-stage .d19-chart { display: grid; gap: 4px; margin: 0; }
.proposal-stage .d19-chart figcaption { color: var(--text-1); font-size: 12px; }
.proposal-stage .d19-chart svg { display: block; background: var(--well); border-radius: 6px; }
.proposal-stage .d19-chart .d19-legend { color: var(--text-2); font: 11px / 16px var(--font-mono); }
`

export function Board({ frames, css }: { frames: readonly FrameSpec[]; css: string }) {
	return (
		<div className="d19-board">
			{frames.map(spec => (
				<StoryFrame key={`${spec.id}:${spec.label}`} spec={spec} css={css} />
			))}
		</div>
	)
}

function replayAll(rate: number): void {
	for (const replay of replays) replay(rate)
}

/** One "Přehrát" bar for every frame on the page. */
export function ReplayControls() {
	return (
		<div className="d19-controls">
			<Btn tone="primary" onClick={() => replayAll(1)}>
				Přehrát
			</Btn>
			<Btn onClick={() => replayAll(0.2)}>Přehrát 5× pomaleji</Btn>
			<span className="d19-hint">
				Spustí skutečné animace příchodu ve všech rámech naráz. Zpomalení jen ukazuje průběh; rozdíl v reálné rychlosti
				je to, co uživatel uvidí.
			</span>
		</div>
	)
}

const CHART_W = 240
const CHART_H = 96
const CHART_MS = 200

function curvePath(motion: Motion): string {
	const total = durationMs(motion)
	const points: string[] = []
	for (let ms = 0; ms <= CHART_MS; ms += 2) {
		const progress = ms >= total ? 1 : ease(motion.easing, ms / total)
		points.push(`${((ms / CHART_MS) * CHART_W).toFixed(1)},${(CHART_H - progress * (CHART_H - 8) - 4).toFixed(1)}`)
	}
	return `M${points.join(' L')}`
}

/**
 * How far along each surface is over the first 200 ms (y = share of the way, x = time): Current dashed,
 * the variant solid. Two identical lines mean nobody can tell them apart.
 */
export function Curves({
	current,
	variant,
	surfaces,
}: { current: Timing; variant: Timing | null; surfaces: Surface[] }) {
	return (
		<div className="d19-charts">
			{surfaces.map(surface => (
				<figure key={surface} className="d19-chart">
					<figcaption>{SURFACE_LABEL[surface]}</figcaption>
					<svg width={CHART_W} height={CHART_H} role="img" aria-label={`Průběh: ${SURFACE_LABEL[surface]}`}>
						<path
							d={curvePath(current[surface])}
							fill="none"
							stroke="var(--text-2)"
							strokeWidth={1.5}
							strokeDasharray="4 3"
						/>
						{variant === null ? null : (
							<path d={curvePath(variant[surface])} fill="none" stroke="var(--accent)" strokeWidth={2} />
						)}
					</svg>
					<span className="d19-legend">
						- - dnes {current[surface].label} · 90 % cesty za {msToShare(current[surface], 0.9)}ms
					</span>
					{variant === null ? null : (
						<span className="d19-legend">
							— varianta {variant[surface].label} · 90 % cesty za {msToShare(variant[surface], 0.9)}ms
						</span>
					)}
				</figure>
			))}
		</div>
	)
}
