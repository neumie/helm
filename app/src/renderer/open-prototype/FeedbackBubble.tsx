// Anchored feedback bubble for agent feedback mode (spec §Feedback per format). Same language
// as Document Review's passage bubble: --chrome, 1px hairline, radius 8, shadow-1, anchored
// 8px from what was pointed at, clamped 16px inside the viewer. Prototype: no admission.
import { useLayoutEffect, useRef, useState } from 'react'
import { Btn } from '../button'
import { GLYPH, MenuButton } from '../sidebar/ui'
import type { FeedbackAnchor } from './types'
import { anchorLabel } from './types'

const WIDTH = 400

export function FeedbackBubble({
	anchor,
	box,
	onClose,
	initialText = '',
}: {
	anchor: FeedbackAnchor
	/** Viewport rect of what the anchor covers. */
	box: DOMRect
	onClose: () => void
	initialText?: string
}) {
	const ref = useRef<HTMLDivElement>(null)
	const fieldRef = useRef<HTMLTextAreaElement>(null)
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
	const [text, setText] = useState(initialText)
	const [intent, setIntent] = useState<'Ask' | 'Request change'>('Ask')
	const label = anchorLabel(anchor)

	// Grow with the draft up to six lines, then scroll. Runs before placement so the bubble is placed
	// at its real height (Document Review's passage editor grows the same way).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
	useLayoutEffect(() => {
		const field = fieldRef.current
		if (!field) return
		field.style.height = 'auto'
		field.style.height = `${Math.min(field.scrollHeight + 2, 132)}px`
	}, [text])

	useLayoutEffect(() => {
		const element = ref.current
		const host = element?.offsetParent
		if (!element || !(host instanceof HTMLElement)) return
		const frame = host.getBoundingClientRect()
		const height = element.offsetHeight
		const width = Math.min(WIDTH, frame.width - 32)
		let left = box.left - frame.left
		left = Math.max(16, Math.min(left, frame.width - width - 16))
		const below = box.bottom - frame.top + 8
		const above = box.top - frame.top - 8 - height
		const top =
			below + height <= frame.height - 16 ? below : above >= 16 ? above : Math.max(16, frame.height - height - 16)
		setPosition({ left, top })
	}, [box])

	useLayoutEffect(() => {
		if (position) fieldRef.current?.focus({ preventScroll: true })
	}, [position])

	return (
		<div
			ref={ref}
			className="open-bubble"
			// biome-ignore lint/a11y/useSemanticElements: an anchored non-modal bubble; <dialog>'s UA inset and margin fight the anchor placement
			role="dialog"
			aria-label={`Feedback on ${label.place}${label.literal ? ` ${label.literal}` : ''}`}
			style={{
				width: `min(${WIDTH}px, calc(100% - 32px))`,
				left: position?.left ?? 0,
				top: position?.top ?? 0,
				visibility: position ? 'visible' : 'hidden',
			}}
			onKeyDown={event => {
				if (event.key === 'Escape') {
					event.stopPropagation()
					onClose()
				}
			}}
		>
			<div className="open-bubble-head">
				<span className="open-bubble-place">{label.place}</span>
				{label.literal ? <span className="open-mono open-bubble-literal">{label.literal}</span> : null}
				<button type="button" className="icon-btn open-bubble-close" aria-label="Close" onClick={onClose}>
					{GLYPH.close}
				</button>
			</div>
			<AnchorPreview anchor={anchor} />
			<textarea
				ref={fieldRef}
				className="open-composer-field"
				rows={2}
				aria-label="Feedback"
				placeholder={intent === 'Ask' ? 'Ask about this' : 'Describe the change'}
				value={text}
				onChange={event => setText(event.target.value)}
			/>
			<div className="open-composer-actions">
				<MenuButton
					align="start"
					trigger={
						<span className="open-intent">
							{intent}
							{GLYPH.chevronDown}
						</span>
					}
					triggerLabel={`Intent: ${intent}`}
					triggerClass="btn btn-ghost btn-sm"
					entries={(['Ask', 'Request change'] as const).map(entry => ({
						label: entry,
						checked: entry === intent,
						onSelect: () => setIntent(entry),
					}))}
				/>
				<span className="open-bubble-keys">⌘↵ send</span>
				<Btn sm tone={text.trim() ? 'primary' : 'quiet'} disabled={!text.trim()} ariaKeyShortcuts="Meta+Enter">
					Send
				</Btn>
			</div>
		</div>
	)
}

/**
 * Non-text anchors show what the agent will receive, because there is no highlighted prose
 * on screen to speak for itself: a cell preview, a JSON value. Text anchors show nothing
 * extra (the highlight is the context, as in Document Review).
 */
function AnchorPreview({ anchor }: { anchor: FeedbackAnchor }) {
	if (anchor.kind === 'cells' && anchor.preview.length > 0)
		return (
			<table className="open-bubble-cells">
				<tbody>
					{anchor.preview.slice(0, 4).map((row, rowIndex) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed preview grid; rows never reorder
						<tr key={rowIndex}>
							{row.slice(0, 4).map((cell, cellIndex) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: cells never reorder within a row
								<td key={cellIndex}>{cell}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		)
	if (anchor.kind === 'json-path') return <div className="open-bubble-value open-mono">{anchor.preview}</div>
	return null
}
