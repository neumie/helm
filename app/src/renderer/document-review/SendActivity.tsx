// The send activity line (helm open spec D14, E5; design-system § Native document review workspace): Claude Code's
// "Vibing… (2m 57s · ↓ 16.3k tokens)" idea drawn the Helm way. The shared §3.21 ActivityIndicator (grayscale
// progress, the global reduced-motion clamp) shows only while the caller is seen working; no colour, no new token.
import { createContext, useContext, useEffect, useState } from 'react'
import { ActivityIndicator } from '../activity-indicator'
import { type SendActivity, activityElapsed, activityTokens, activityWords } from './send-activity'

const RUNNING = new Set(['sending', 'received', 'working'])

/**
 * The latest passage send, for the read-only bubble a marker opens while that send is admitted. That bubble lives
 * inside the memoized Markdown, so it reads the line through context instead of props. `inspect` tells the review
 * window the bubble showing this request is open, so the companion does not say it a second time.
 */
export const PassageSendContext = createContext<{
	view: SendActivity | null
	inspect: (requestId: string, open: boolean) => void
} | null>(null)

/** The line for a read-only passage bubble: only this request's own thread, only while the bubble is open. */
export function PassageSendLine({ messageIds, open }: { messageIds: string[]; open: boolean }) {
	const send = useContext(PassageSendContext)
	const view = send?.view?.scope === 'passage' && messageIds.includes(`${send.view.id}:user`) ? send.view : null
	const inspect = send?.inspect
	const id = view?.id ?? null
	const shown = open && id !== null
	useEffect(() => {
		if (!shown || !inspect || !id) return
		inspect(id, true)
		return () => inspect(id, false)
	}, [shown, inspect, id])
	return shown && view ? <SendActivityLine view={view} /> : null
}

/** Re-render once a second while the clock runs; the indicator animates in CSS, so nothing else ticks. */
function useSecondTicker(active: boolean): void {
	const [, setTick] = useState(0)
	useEffect(() => {
		if (!active) return
		const timer = window.setInterval(() => setTick(value => value + 1), 1000)
		return () => window.clearInterval(timer)
	}, [active])
}

/** "↓ 16.3k tokens", read as "16.3k output tokens". */
function Tokens({ count }: { count: number }) {
	return (
		<>
			<span aria-hidden="true">↓ </span>
			{activityTokens(count)}
			<span className="sr-only"> output</span> tokens
		</>
	)
}

/** Under the newest message of the conversation that sent: Sending → With <agent> → working → Replied. */
export function SendActivityLine({ view }: { view: SendActivity }) {
	const running = RUNNING.has(view.phase)
	useSecondTicker(running)
	if (view.phase === 'not-sent' || view.phase === 'unconfirmed') return null
	const replied = view.phase === 'replied'
	const working = view.phase === 'working'
	const end = running ? Date.now() : view.endedAt
	const elapsed = end === null ? null : activityElapsed(end - view.sentAt)
	const { verb, status } = activityWords(view)
	const meta =
		view.outputTokens === null ? null : (
			<>
				{' · '}
				<Tokens count={view.outputTokens} />
			</>
		)
	return (
		<div className={`review-activity${replied ? ' review-activity-done' : ''}`} data-phase={view.phase}>
			{/* §3.21: the indicator only while the caller is seen working, never as idle decoration. */}
			<span className="review-activity-slot" aria-hidden="true">
				{working ? <ActivityIndicator label="Working" /> : null}
			</span>
			{replied ? (
				<span className="review-activity-text">
					{elapsed === null ? verb : `${view.bound ? 'Worked for' : 'Replied after'} ${elapsed}`}
					{meta ? <span className="review-activity-meta">{meta}</span> : null}
				</span>
			) : (
				<span className="review-activity-text">
					<span className={working ? 'activity-indicator-label' : undefined}>{verb}…</span>
					<span className="review-activity-meta">
						{' ('}
						{elapsed}
						{meta}
						{')'}
					</span>
				</span>
			)}
			{/* One status for the whole line, mounted while the line shows; its text changes only with the phase or verb. */}
			<output className="sr-only">{status}</output>
		</div>
	)
}

/** A refusal before any effect, next to the composer that sent it instead of the top banner. */
export function SendRefusedNote({ view }: { view: SendActivity }) {
	if (view.phase !== 'not-sent') return null
	return (
		<div className="review-send-refused" role="alert">
			<span className="review-send-refused-glyph" aria-hidden="true">
				!
			</span>
			<span>
				<span className="review-send-refused-lead">Not sent</span>
				{' · '}
				{view.reason}
				{view.restored ? ' Your message is back in the editor.' : ''}
			</span>
		</div>
	)
}
