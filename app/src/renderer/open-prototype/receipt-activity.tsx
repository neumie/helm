// E5 — activity line under the conversation (helm open spec D14), in the style of Claude Code's own
// "✻ Vibing… (2m 57s · ↓ 16.3k tokens)". Story-only: the phase comes from the real DocumentReview send path;
// the verb and token count come from a story-only `ActivitySource` standing in for a progress feed Helm does
// not have yet (spec D14 feasibility note). Every field shown has a named real source or is left out.
import { useEffect, useState } from 'react'
import type { SendReceiptSlots, SendReceiptView } from '../document-review/send-receipt-view'
import { receiptSlots } from './receipt'
import './receipt-activity.css'

/** What a provider was last seen doing, `at` ms after Send. */
export interface ActivityStep {
	at: number
	/** Output tokens since your message, or null when the source has none. */
	tokens: number | null
	/** Generic verb from the last tool name ("Editing", "Running a command"); null = a model request in flight. */
	verb: string | null
}

/** Where a provider's progress would come from, and what it can really tell. */
export interface ActivitySource {
	/** Steps in time order; the line shows the newest step whose `at` has passed. Empty = nothing bound. */
	steps: ActivityStep[]
	/** Tooltip naming where the numbers come from. */
	origin: string
	/** Story-only: pretend the send happened this long ago, for still frames. */
	clockOffsetMs?: number
}

/** Claude Code's spinner frames; reduced motion keeps ✻. */
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

function useTicker(active: boolean, ms: number): number {
	const [tick, setTick] = useState(0)
	useEffect(() => {
		if (!active) return
		const timer = window.setInterval(() => setTick(value => value + 1), ms)
		return () => window.clearInterval(timer)
	}, [active, ms])
	return tick
}

function useReducedMotion(): boolean {
	const query = '(prefers-reduced-motion: reduce)'
	const [reduced, setReduced] = useState(() => window.matchMedia(query).matches)
	useEffect(() => {
		const list = window.matchMedia(query)
		const change = () => setReduced(list.matches)
		list.addEventListener('change', change)
		return () => list.removeEventListener('change', change)
	}, [])
	return reduced
}

/** Claude Code's spelling: 12s, 2m 57s, 1h 4m. */
export function activityElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** 812, 16.3k, 1.2m; no trailing ".0". */
export function activityTokens(count: number): string {
	const scaled = (value: number, unit: string) => `${Number(value.toFixed(1))}${unit}`
	if (count < 1000) return `${count}`
	if (count < 1_000_000) return scaled(count / 1000, 'k')
	return scaled(count / 1_000_000, 'm')
}

function stepAt(source: ActivitySource, sinceSend: number): ActivityStep | null {
	let found: ActivityStep | null = null
	for (const step of source.steps) if (step.at <= sinceSend) found = step
	return found
}

const RUNNING = new Set(['sending', 'received', 'working'])

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

function ActivityLine({ view, source }: { view: SendReceiptView; source: ActivitySource }) {
	const running = RUNNING.has(view.phase)
	const reduced = useReducedMotion()
	// Only a caller seen working spins; received means the tool has your message, not that the agent works.
	const tick = useTicker(view.phase === 'working' && !reduced, 120)
	useTicker(running, 1000)
	const offset = source.clockOffsetMs ?? 0
	const end = (running ? Date.now() : view.phaseAt) + offset
	const elapsed = activityElapsed(end - view.sentAt)
	const bound = source.steps.length > 0
	// A finished line keeps the last step it reached before the reply.
	const step = view.phase === 'working' || view.phase === 'replied' ? stepAt(source, end - view.sentAt) : null
	const tokens = step?.tokens ?? null
	if (view.phase === 'replied')
		return (
			<div className="act-line act-done" data-phase="replied" title={source.origin}>
				<span className="act-glyph" aria-hidden="true">
					✻
				</span>
				<span className="act-text">
					{bound ? `Worked for ${elapsed}` : `Replied after ${elapsed}`}
					{tokens === null ? null : (
						<span className="act-meta">
							{' · '}
							<Tokens count={tokens} />
						</span>
					)}
				</span>
			</div>
		)
	let verb: string
	if (view.phase === 'sending') verb = `Sending to ${view.agent}`
	// Without a bound source the window only knows the agent has your message, never that it works on it.
	else if (view.phase === 'received') verb = `With ${view.agent}`
	else verb = step?.verb ?? 'Thinking'
	const glyph = view.phase !== 'working' || reduced ? '✻' : (SPINNER[tick % SPINNER.length] ?? '✻')
	// The clock and the spinner change every second; only the verb is announced, so a screen reader hears
	// "Editing" once rather than every tick. The full line stays readable in place.
	return (
		<div className="act-line" data-phase={view.phase} title={source.origin}>
			<span className="act-glyph" aria-hidden="true">
				{glyph}
			</span>
			<span className="act-text">
				{verb}…
				<span className="act-meta">
					{' ('}
					{elapsed}
					{tokens === null ? null : (
						<>
							{' · '}
							<Tokens count={tokens} />
						</>
					)}
					)
				</span>
			</span>
			<output className="sr-only">{verb}</output>
		</div>
	)
}

/**
 * E5 slots. The line sits under the newest message of the conversation that sent. Not sent is variant A's:
 * the reason next to the composer instead of today's top banner, the message back in the editor. Not confirmed
 * keeps today's panel with "I checked the outcome".
 */
export function activitySlots(source: ActivitySource): SendReceiptSlots {
	const composerLine = receiptSlots('composer').composer
	return {
		replacesToday: true,
		transcript: view =>
			view.phase === 'not-sent' || view.phase === 'unconfirmed' ? null : <ActivityLine view={view} source={source} />,
		composer: view => (view.phase === 'not-sent' ? (composerLine?.(view) ?? null) : null),
	}
}
