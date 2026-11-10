// D — Feedback anchors (spec §Feedback anchoring per format). Agent-bound mode only: each story
// opens with an anchor already pointed at and its feedback bubble open, drafted. Pointing at
// something else moves the anchor and the bubble. Chrome-neutral host, so A stays a separate pick.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react'
import { CodeView } from './CodeView'
import { FeedbackBubble } from './FeedbackBubble'
import { ImageView } from './ImageView'
import { JsonView } from './JsonView'
import { PdfView } from './PdfView'
import { SheetView } from './SheetView'
import './chrome.css'
import { FIXTURES } from './fixtures'
import refusalSource from './fixtures/refusal.ts?raw'
import './open.css'
import type { FeedbackAnchor, FeedbackHost, RendererProps, ViewerFile, ViewerStatus } from './types'
import { formatBytes, formatWord } from './types'

const meta: Meta = {
	title: 'Views/Helm open/D Feedback anchors',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

/** Union of the painted anchor's on-screen boxes, once the renderer has painted it and it stopped moving. */
function usePaintedBox(root: React.RefObject<HTMLElement | null>, selector: string, anchor: FeedbackAnchor | null) {
	const [box, setBox] = useState<DOMRect | null>(null)
	useEffect(() => {
		if (!anchor) return
		let last = ''
		let frame = 0
		let tries = 0
		const timer = window.setInterval(() => {
			tries += 1
			const elements = root.current ? [...root.current.querySelectorAll(selector)] : []
			const rects = elements
				.map(element => element.getBoundingClientRect())
				.filter(rect => rect.width > 0 && rect.height > 0)
			if (rects.length === 0) {
				if (tries > 80) window.clearInterval(timer)
				return
			}
			const left = Math.min(...rects.map(rect => rect.left))
			const top = Math.min(...rects.map(rect => rect.top))
			const right = Math.max(...rects.map(rect => rect.right))
			const bottom = Math.max(...rects.map(rect => rect.bottom))
			const key = `${left}:${top}:${right}:${bottom}`
			if (key === last) {
				window.clearInterval(timer)
				frame = requestAnimationFrame(() => setBox(new DOMRect(left, top, right - left, bottom - top)))
			}
			last = key
		}, 120)
		return () => {
			window.clearInterval(timer)
			cancelAnimationFrame(frame)
		}
	}, [root, selector, anchor])
	return box
}

function AnchorStage({
	file,
	Renderer,
	initial,
	paintedSelector,
	draft,
	hint,
}: {
	file: ViewerFile
	Renderer: ComponentType<RendererProps>
	initial: FeedbackAnchor
	/** Where the renderer paints the active anchor, to open the bubble against it on load. */
	paintedSelector: string
	draft: string
	/** How to point at something in this format, shown in the status line. */
	hint: string
}) {
	const rootRef = useRef<HTMLDivElement>(null)
	const [status, setStatus] = useState<ViewerStatus>({})
	const [active, setActive] = useState<FeedbackAnchor | null>(initial)
	const [pointedBox, setPointedBox] = useState<DOMRect | null>(null)
	const [dismissed, setDismissed] = useState(false)
	const paintedBox = usePaintedBox(rootRef, paintedSelector, pointedBox ? null : active)
	const box = pointedBox ?? paintedBox
	const host = useMemo<FeedbackHost>(
		() => ({
			active,
			onAnchor: (anchor, rect) => {
				setActive(anchor)
				setPointedBox(rect)
				setDismissed(false)
			},
		}),
		[active],
	)
	return (
		<div ref={rootRef} className="open-stage">
			<div className="open-body">
				<Renderer file={file} onStatus={setStatus} feedback={host} />
				{active && box && !dismissed ? (
					<FeedbackBubble
						key={`${JSON.stringify(active)}`}
						anchor={active}
						box={box}
						initialText={pointedBox ? '' : draft}
						onClose={() => setDismissed(true)}
					/>
				) : null}
			</div>
			<div className="open-format-status" aria-label="Viewer status">
				<b>{file.name}</b>
				<span>{formatWord(file)}</span>
				<span>{formatBytes(file.size)}</span>
				{status.facts?.map(fact => (
					<span key={fact}>{fact}</span>
				))}
				<span>{hint}</span>
				{status.position ? <span className="open-status-end">{status.position}</span> : null}
			</div>
		</div>
	)
}

/** PDF text selection: page + quote; the agent also gets a crop of the selection as a screenshot. */
export const PdfTextSelection: Story = {
	render: () => (
		<AnchorStage
			file={FIXTURES.pdf}
			Renderer={PdfView}
			initial={{
				kind: 'pdf-text',
				page: 1,
				quote: 'p95 latency fell from 412 ms to 268 ms after the ARES cache landed on 14 October',
			}}
			paintedSelector=".open-anchor-box:not(.open-pdf-draft)"
			draft="Is this drop real, or is it the cache warming up after the deploy? Check the re-verification batch on the 26th."
			hint="Select text, or ⌥-drag a region"
		/>
	),
}

/** PDF region (⌥-drag): page + normalized rect, for charts and scans that have no text to select. */
export const PdfRegion: Story = {
	render: () => (
		<AnchorStage
			file={FIXTURES.pdf}
			Renderer={PdfView}
			initial={{ kind: 'pdf-region', page: 1, rect: { x: 0.09, y: 0.45, width: 0.82, height: 0.26 } }}
			paintedSelector=".open-anchor-box:not(.open-pdf-draft)"
			draft="Sort this chart by October revenue, not the year to date."
			hint="Select text, or ⌥-drag a region"
		/>
	),
}

/** Spreadsheet range: sheet + A1 range + a preview of the values the agent receives. */
export const SpreadsheetRange: Story = {
	render: () => (
		<AnchorStage
			file={FIXTURES.xlsx}
			Renderer={SheetView}
			initial={{
				kind: 'cells',
				sheet: 'Summary',
				range: 'A2:D6',
				preview: [
					['Psyon s.r.o.', '24', '540250', '653704'],
					['Nordic Freight AB', '27', '651410', '788206'],
					['Kavárna Lípa', '24', '612680', '741341'],
					['Dentium Clinic', '21', '515000', '623152'],
				],
			}}
			paintedSelector=".open-sheet-anchor"
			draft="Gross for Nordic Freight should use the reverse-charge rate. Why is it 21% here?"
			hint="Drag or ⇧-arrow a range"
		/>
	),
}

/** Image region: a rectangle in natural pixels; the agent gets a crop of it as a screenshot. */
export const ImageRegion: Story = {
	render: () => (
		<AnchorStage
			file={FIXTURES.png}
			Renderer={ImageView}
			initial={{ kind: 'image-region', rect: { x: 472, y: 950, width: 1456, height: 100 } }}
			paintedSelector=".open-anchor-box"
			draft="This banner blames the IČO, but the log says ARES timed out. Say the registry is unavailable and keep the form filled in."
			hint="Drag a region · space-drag pans"
		/>
	),
}

/** JSON node: a JSON Pointer-like path plus the value preview. */
export const JsonNode: Story = {
	render: () => (
		<AnchorStage
			file={FIXTURES.json}
			Renderer={JsonView}
			initial={{
				kind: 'json-path',
				path: '$.latestEvent.exception.values[0].value',
				preview: '"Cannot read properties of undefined (reading \'ico\')"',
			}}
			paintedSelector=".is-anchor"
			draft="Where does `ico` come from on this path? I think the ARES response is null when the firm changed its legal form."
			hint="Click a node · ↵ points at the selected one"
		/>
	),
}

/** Code lines: a line range and the exact text (the v1 passage shape, so older agents understand it). */
export const CodeLines: Story = {
	render: () => (
		<AnchorStage
			file={FIXTURES.ts}
			Renderer={CodeView}
			initial={{
				kind: 'lines',
				startLine: 18,
				endLine: 23,
				quote: refusalSource.split('\n').slice(17, 23).join('\n'),
			}}
			paintedSelector=".cm-line.cm-open-code-anchor"
			draft="A git failure with an empty stderr shows ' Command failed' here. Fall back to the exit code alone?"
			hint="Select lines"
		/>
	),
}
