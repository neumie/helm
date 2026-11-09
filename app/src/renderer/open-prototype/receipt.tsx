// Send receipt variants for the review composer (helm open spec D14). Story-only: each variant is a set of
// `SendReceiptSlots` the real DocumentReview renders through its opt-in seam, so every frame runs the real
// send path. Jakub picks one; nothing here is wired into production.
import { type ReactNode, useEffect, useState } from 'react'
import { ActivityIndicator } from '../activity-indicator'
import type { SendReceiptPhase, SendReceiptSlots, SendReceiptView } from '../document-review/send-receipt-view'
import './receipt.css'

export type ReceiptVariant = 'composer' | 'message' | 'header' | 'button'

export const RECEIPT_VARIANTS: Record<ReceiptVariant, { label: string; note: string }> = {
	composer: { label: 'A Composer line', note: 'One status line right above the box you typed in.' },
	message: { label: 'B Under your message', note: 'Your message appears at once; its status sits under it.' },
	header: { label: 'C Header steps', note: 'Sent · Received · Working · Replied in the conversation header.' },
	button: { label: 'D Send button', note: 'The button you pressed tells you what happened.' },
}

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!active) return
		setNow(Date.now())
		const timer = window.setInterval(() => setNow(Date.now()), 1000)
		return () => window.clearInterval(timer)
	}, [active])
	return now
}
function clock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const RUNNING: SendReceiptPhase[] = ['sending', 'received', 'working']
function Elapsed({ view }: { view: SendReceiptView }) {
	const running = RUNNING.includes(view.phase)
	const now = useNow(running)
	return <span className="rcpt-clock">{clock((running ? now : view.phaseAt) - view.sentAt)}</span>
}

type Mark = 'progress' | 'done' | 'failed' | 'unknown'
function Glyph({ mark, label }: { mark: Mark; label: string }) {
	return (
		<span className="rcpt-glyph" data-mark={mark}>
			{mark === 'progress' ? (
				<ActivityIndicator label={label} />
			) : (
				<span role="img" aria-label={label}>
					{mark === 'failed' ? '!' : mark === 'unknown' ? '?' : '✓'}
				</span>
			)}
		</span>
	)
}
const MARK: Record<SendReceiptPhase, Mark> = {
	sending: 'progress',
	received: 'done',
	working: 'progress',
	replied: 'done',
	'not-sent': 'failed',
	unconfirmed: 'unknown',
}
/** Short words per phase. "Received" means the agent's waiting tool has it, never that it read or acted. */
function words(view: SendReceiptView): { lead: string; rest: ReactNode } {
	const agent = view.agent
	switch (view.phase) {
		case 'sending':
			return { lead: `Sending to ${agent}…`, rest: null }
		case 'received':
			return {
				lead: `${agent} has it`,
				rest: view.reportsProgress ? 'starting' : 'no progress until it replies',
			}
		case 'working':
			return { lead: `${agent} is working`, rest: null }
		case 'replied':
			return { lead: 'Replied', rest: null }
		case 'not-sent':
			return { lead: 'Not sent', rest: <>{view.reason} Your message is back in the editor.</> }
		case 'unconfirmed':
			return {
				lead: 'Not confirmed',
				rest: `${agent} may or may not have it. Check its terminal before sending again.`,
			}
	}
}
const settled = (view: SendReceiptView) => view.phase === 'not-sent' || view.phase === 'unconfirmed'

/** One status row: glyph column, then lead + dim rest + clock that wrap as one sentence. */
function Line({
	view,
	className,
	lead,
	rest,
	timed,
	glyph = true,
}: {
	view: SendReceiptView
	className: string
	lead: ReactNode
	rest?: ReactNode
	timed?: boolean
	glyph?: boolean
}) {
	return (
		<output className={`rcpt-line ${className}`} data-phase={view.phase} aria-live="polite">
			{glyph ? <Glyph mark={MARK[view.phase]} label={typeof lead === 'string' ? lead : view.phase} /> : <span />}
			<span className="rcpt-text">
				{lead && <span className="rcpt-lead">{lead}</span>}
				{rest && (
					<span className="rcpt-rest">
						{lead ? ' · ' : ''}
						{rest}
					</span>
				)}
				{timed && (
					<span className="rcpt-rest">
						{' · '}
						<Elapsed view={view} />
					</span>
				)}
			</span>
		</output>
	)
}

/** A — one status line directly above the writing surface that sent it. */
function ComposerLine({ view }: { view: SendReceiptView }) {
	// Not confirmed keeps today's panel with "I checked the outcome" in every variant; no second copy.
	if (view.phase === 'unconfirmed') return null
	const { lead, rest } = words(view)
	return <Line view={view} className="rcpt-composer" lead={lead} rest={rest} timed={!settled(view)} />
}

/** B — your message appears at once; its status sits right under it. */
function UnderMessage({ view }: { view: SendReceiptView }) {
	if (view.phase === 'replied') return null
	const { lead, rest } = words(view)
	if (view.phase === 'unconfirmed') return <Line view={view} className="rcpt-under" lead={lead} rest="see below" />
	const failed = view.phase === 'not-sent'
	const status =
		view.phase === 'received' ? (
			<Line
				view={view}
				className="rcpt-under"
				lead="Delivered"
				rest={view.reportsProgress ? 'starting' : `${view.agent} replies when it is done`}
				timed
			/>
		) : (
			<Line view={view} className="rcpt-under" lead={lead} rest={rest} timed={!settled(view)} />
		)
	// Until the host adds the real "You" message (and after a refusal, which never adds it) show the text
	// locally so the window answers the click at once.
	if (!view.echoed || failed)
		return (
			<article className="review-message review-message-user rcpt-echo" data-phase={view.phase}>
				<h3>You</h3>
				<div>{view.text || 'Screenshot'}</div>
				{status}
			</article>
		)
	return status
}

const STEPS = ['sent', 'received', 'working', 'replied'] as const
const STEP_WORDS: Record<(typeof STEPS)[number], string> = {
	sent: 'Sent',
	received: 'Received',
	working: 'Working',
	replied: 'Replied',
}
/** C — the conversation header shows where the message is on its way. */
function HeaderSteps({ view, compact }: { view: SendReceiptView; compact?: boolean }) {
	if (settled(view)) {
		const { lead, rest } = words(view)
		return <Line view={view} className="rcpt-steps-failed" lead={lead} rest={compact ? rest : null} />
	}
	// A tool-return caller never reports working, so its track has no Working step to light.
	const steps = STEPS.filter(step => step !== 'working' || view.reportsProgress)
	// Done steps are what happened; the animated step is what the window waits for next.
	const at = view.phase === 'sending' ? 0 : view.phase === 'replied' ? steps.length : 2
	return (
		<output
			className="rcpt-steps"
			data-phase={view.phase}
			data-compact={compact || undefined}
			aria-label={`${view.agent}: ${words(view).lead}`}
		>
			{steps.map((step, index) => {
				const state = index < at ? 'done' : index === at ? 'now' : 'next'
				return (
					<span className="rcpt-step" data-state={state} key={step}>
						<span className="rcpt-step-mark" aria-hidden="true">
							{state === 'now' ? <ActivityIndicator label={STEP_WORDS[step]} /> : state === 'done' ? '✓' : '·'}
						</span>
						{STEP_WORDS[step]}
					</span>
				)
			})}
			{view.phase !== 'replied' && <Elapsed view={view} />}
		</output>
	)
}

/** D — the button you pressed tells you what happened; a refusal speaks above it. */
function buttonLabel(view: SendReceiptView): ReactNode | null {
	switch (view.phase) {
		case 'sending':
			return 'Sending'
		case 'received':
			return (
				<span className="rcpt-button">
					<span className="rcpt-button-mark">✓</span> Delivered <Elapsed view={view} />
				</span>
			)
		case 'working':
			return (
				<span className="rcpt-button">
					<ActivityIndicator label="Working" /> Working <Elapsed view={view} />
				</span>
			)
		case 'unconfirmed':
			return (
				<span className="rcpt-button" data-phase="unconfirmed">
					<span className="rcpt-button-mark">?</span> Not confirmed
				</span>
			)
		default:
			return null
	}
}
function ButtonNote({ view }: { view: SendReceiptView }) {
	if (view.phase === 'received' && !view.reportsProgress)
		return (
			<Line
				view={view}
				className="rcpt-composer rcpt-quiet"
				lead={null}
				rest={`${view.agent} answers here when it is done.`}
				glyph={false}
			/>
		)
	if (view.phase !== 'not-sent') return null
	const { lead, rest } = words(view)
	return <Line view={view} className="rcpt-composer" lead={lead} rest={rest} />
}

export function receiptSlots(variant: ReceiptVariant): SendReceiptSlots {
	switch (variant) {
		case 'composer':
			return { replacesToday: true, composer: view => <ComposerLine view={view} /> }
		case 'message':
			return { replacesToday: true, transcript: view => <UnderMessage view={view} /> }
		case 'header':
			return {
				replacesToday: true,
				header: view => (view.scope === 'whole' ? <HeaderSteps view={view} /> : null),
				composer: view =>
					view.scope === 'passage' || view.phase === 'not-sent' ? <HeaderSteps view={view} compact /> : null,
			}
		case 'button':
			return {
				replacesToday: true,
				sendLabel: buttonLabel,
				composer: view => <ButtonNote view={view} />,
			}
	}
}
