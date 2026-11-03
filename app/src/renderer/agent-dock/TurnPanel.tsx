// The turn-ended pane body: the agent's last message, PR links, and a reply typed into its
// terminal as the next prompt.
import { useMemo, useRef, useState } from 'react'
import type { DockSession } from '../../agent-dock/model'
import {
	Footer,
	Hint,
	PromptField,
	RiskyConfirm,
	ScrollBody,
	SubmitActions,
	cancelHints,
	closeHints,
} from './pane-chrome'
import { isPrintable, modHint, modShortcut, submitKeys, useKeys } from './pane-keys'
import { type PanelProps, useDraft } from './panel'
import { itemHeadline, riskyWord } from './presentation'
import { turnMessage } from './turn-markdown'

export function TurnPanel(panel: PanelProps & { session: DockSession | undefined }) {
	const {
		item,
		live,
		answerable,
		decidable,
		sent,
		mod,
		blockedNote,
		receipt,
		ack,
		warnings,
		keys,
		drafts,
		submitting,
		onAct,
		session,
	} = panel
	// A sent reply stays in its field (dimmed) under the receipt; a failure keeps it for another try.
	const [text, setText] = useDraft(drafts, `reply:${item.id}`, sent?.type === 'prompt' ? sent.text : '')
	/** The risky word the pending confirmation is about, while it asks. */
	const [confirming, setConfirming] = useState<string | null>(null)
	const replyRef = useRef<HTMLTextAreaElement>(null)
	// Lexed once per message, not on every keystroke in the reply.
	const message = useMemo(() => (item.fact.kind === 'turn' ? turnMessage(item.fact.text) : null), [item.fact])
	const ready = live && text.trim() !== ''
	const send = (confirmed: boolean) => {
		if (!ready) return
		const risky = riskyWord(text)
		if (risky && !confirmed) {
			setConfirming(risky)
			return
		}
		setConfirming(null)
		onAct({ type: 'prompt', text, ...(risky ? { confirmed: true } : {}) })
	}
	useKeys(keys, event => {
		const keyed = submitKeys(event, {
			confirming: confirming !== null,
			bareEnter: false,
			cancel: () => setConfirming(null),
			submit: () => send(false),
		})
		if (keyed) return true
		// A turn has no choices: a key typed at the pane starts the reply.
		const field = replyRef.current
		if (!live || !field || !isPrintable(event)) return false
		field.focus({ preventScroll: true })
		setText(text + event.key)
		setConfirming(null)
		return true
	})
	if (item.fact.kind !== 'turn') return null
	const fact = item.fact
	const notes = [fact.hadBackground ? 'Subagents were still running.' : ''].filter(Boolean)
	const note = confirming ? <RiskyConfirm word={confirming} what="This reply" /> : (receipt ?? blockedNote ?? null)
	return (
		<>
			<ScrollBody label="Last message">
				{warnings}
				<div className="agent-dock-message">
					<span className="agent-dock-message-mark" aria-hidden="true">
						●
					</span>
					{message ?? <p className="agent-dock-message-text">{itemHeadline(item)}</p>}
				</div>
				{notes.length > 0 || session?.prLinks.length ? (
					<p className="agent-dock-facts">
						{session?.prLinks.slice(0, 4).map(pr => (
							<span key={pr.number} className="agent-dock-fact-pr">
								PR #{pr.number}
							</span>
						))}
						{notes.map(line => (
							<span key={line}>{line}</span>
						))}
					</p>
				) : null}
				<PromptField>
					<textarea
						ref={replyRef}
						className="agent-dock-input agent-dock-input-fit"
						aria-label="Reply"
						aria-keyshortcuts={modShortcut(mod)}
						placeholder="Reply to the agent"
						title="Typed into the agent's terminal as your next prompt"
						maxLength={16384}
						rows={1}
						value={text}
						disabled={!live}
						onChange={event => {
							setText(event.currentTarget.value)
							setConfirming(null)
						}}
					/>
				</PromptField>
			</ScrollBody>
			<Footer
				hints={
					!answerable ? (
						closeHints
					) : confirming ? (
						cancelHints
					) : (
						<>
							<Hint keys={modHint(mod)}>send</Hint>
							<Hint keys="esc">close</Hint>
						</>
					)
				}
				note={note}
			>
				{ack}
				<SubmitActions
					decidable={decidable}
					confirming={confirming !== null}
					disabled={!ready}
					busy={submitting}
					mod={mod}
					label="Send"
					onSubmit={() => send(false)}
					onConfirm={() => send(true)}
					onCancel={() => setConfirming(null)}
				/>
			</Footer>
		</>
	)
}
