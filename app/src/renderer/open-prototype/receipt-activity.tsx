// E5 — activity line under the conversation (helm open spec D14): Claude Code's "Vibing… (2m 57s · ↓ 16.3k
// tokens)" idea drawn the Helm way, with the shared §3.21 ActivityIndicator in place of Claude's orange ✻. Story-only: the phase comes from the real DocumentReview send path;
// the verb and token count come from a story-only `ActivitySource` standing in for a progress feed Helm does
// not have yet (spec D14 feasibility note). Every field shown has a named real source or is left out.
import { useEffect, useState } from 'react'
import { ActivityIndicator } from '../activity-indicator'
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

function useTicker(active: boolean, ms: number): number {
	const [tick, setTick] = useState(0)
	useEffect(() => {
		if (!active) return
		const timer = window.setInterval(() => setTick(value => value + 1), ms)
		return () => window.clearInterval(timer)
	}, [active, ms])
	return tick
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
	// The clock; the indicator animates in CSS (§3.21), so nothing else ticks.
	useTicker(running, 1000)
	const offset = source.clockOffsetMs ?? 0
	const end = (running ? Date.now() : view.phaseAt) + offset
	const elapsed = activityElapsed(end - view.sentAt)
	const bound = source.steps.length > 0
	// A finished line keeps the last step it reached before the reply.
	const step = view.phase === 'working' || view.phase === 'replied' ? stepAt(source, end - view.sentAt) : null
	const tokens = step?.tokens ?? null
	const replied = view.phase === 'replied'
	const working = view.phase === 'working'
	let verb: string
	if (view.phase === 'sending') verb = `Sending to ${view.agent}`
	// Without a bound source the window only knows the agent has your message, never that it works on it.
	else if (view.phase === 'received') verb = `With ${view.agent}`
	else if (replied) verb = bound ? 'Worked' : 'Replied'
	else verb = step?.verb ?? 'Thinking'
	// One status for the whole line, mounted in every phase, whose text changes only with the phase or the verb:
	// a screen reader hears "Editing" once, never the clock. The indicator keeps a static label of its own.
	const status = replied ? `${view.agent} replied` : working ? `${view.agent}: ${verb}` : verb
	const meta =
		tokens === null ? null : (
			<>
				{' · '}
				<Tokens count={tokens} />
			</>
		)
	return (
		<div className={`act-line${replied ? ' act-done' : ''}`} data-phase={view.phase} title={source.origin}>
			{/* §3.21: the indicator only while the caller is seen working, never as idle decoration. */}
			<span className="act-slot" aria-hidden="true">
				{working ? <ActivityIndicator label="Working" /> : null}
			</span>
			{replied ? (
				<span className="act-text">
					{bound ? `Worked for ${elapsed}` : `Replied after ${elapsed}`}
					{meta ? <span className="act-meta">{meta}</span> : null}
				</span>
			) : (
				<span className="act-text">
					<span className={working ? 'activity-indicator-label' : undefined}>{verb}…</span>
					<span className="act-meta">
						{' ('}
						{elapsed}
						{meta}
						{')'}
					</span>
				</span>
			)}
			<output className="sr-only">{status}</output>
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
