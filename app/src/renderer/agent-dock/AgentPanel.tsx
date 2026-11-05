// The agent detail (design §3.24 Agents): one agent opened from the Agents pane when it owes Jakub
// nothing — its state in words and where it runs, its last message in full (read live through its
// source, like `helm dock show`; the stored first line until then or when that read fails), and a
// reply typed into its terminal as the next prompt (same CAS and receipts as a turn reply). An agent
// that does owe him something (stepped onto with ‹ ›) offers its item instead. Esc goes back.
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react'
import { DOCK_LIVE_MESSAGE_MAX } from '../../../../src/agent-dock/dock-vocabulary.js'
import type {
	AgentDockActResult,
	AgentDockMessageResult,
	AgentDockPromptRequest,
	AgentDockSnapshot,
	DockSession,
} from '../../agent-dock/model'
import { type RevealView, RevealWhere } from './RevealTerminal'
import { CloseKey, Footer, Header, Hint, Key, PromptField, Receipt, ScrollBody, Stepper } from './pane-chrome'
import { type DetailKeys, type DockModKey, isPrintable, modHint, modShortcut, submitKeys, useKeys } from './pane-keys'
import { type DockDrafts, useDraft } from './panel'
import { type AgentRow, agentReplyBlocked, plainAgentLine, sessionReplyView } from './presentation'
import { turnMessage } from './turn-markdown'

/** The live read of the agent's last message: null while it runs (or with no reader). */
type LiveMessage = { key: string; result: AgentDockMessageResult } | null

export const agentDraftKey = (session: string): string => `agent-reply:${session}`

export function AgentPanel({
	snapshot,
	session,
	row,
	now,
	index,
	total,
	mod,
	keys,
	drafts,
	submitting,
	localError,
	readMessage,
	canPrompt,
	reveal,
	revealNote,
	onStep,
	onClose,
	onOpenItem,
	onPrompt,
}: {
	snapshot: AgentDockSnapshot | null
	session: DockSession
	row: AgentRow
	now: number
	index: number
	total: number
	mod: DockModKey
	keys: MutableRefObject<DetailKeys | null>
	drafts: DockDrafts
	/** A reply from here is on its way to main (the button shows busy before the snapshot does). */
	submitting: boolean
	/** A refusal/failure main did not record on the session (bad request, IPC failure). */
	localError: string | null
	readMessage?: (session: string) => Promise<AgentDockMessageResult>
	/** This build can reply from the dock at all. */
	canPrompt: boolean
	/** "Show terminal" for this agent (its where line leads with the link), or null when nothing can be shown. */
	reveal: RevealView | null
	/** A reveal that failed (or could not raise Okena): a quiet line in the footer, ahead of the receipt. */
	revealNote: string | null
	onStep(delta: number): void
	onClose(): void
	onOpenItem(itemId: number): void
	/** Resolves with main's result; a sent reply clears the field. */
	onPrompt(request: Omit<AgentDockPromptRequest, 'session'>): Promise<AgentDockActResult>
}) {
	const key = session.key
	const [live, setLive] = useState<LiveMessage>(null)
	const stored = session.lastMessage
	const sourceOk = (snapshot?.sources?.[session.source] ?? snapshot?.source)?.state === 'ok'
	// Read live on open, and again whenever the reducer sees a newer message.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a newer stored uuid is the cue to read again
	useEffect(() => {
		if (!readMessage || !sourceOk) return
		let current = true
		setLive(prev => (prev?.key === key ? prev : null))
		readMessage(key)
			.catch(
				(error: unknown): AgentDockMessageResult => ({
					ok: false,
					detail: error instanceof Error ? error.message : String(error),
				}),
			)
			.then(result => {
				if (current) setLive({ key, result })
			})
		return () => {
			current = false
		}
	}, [readMessage, key, stored?.uuid, sourceOk])
	const result = live?.key === key ? live.result : null
	const full = result?.ok ? result.message : undefined
	// What Jakub reads (and so what a reply answers): the live message, else the stored first line.
	const shownUuid = full?.uuid ?? stored?.uuid
	const message = useMemo(() => (full ? turnMessage(full.text, undefined, DOCK_LIVE_MESSAGE_MAX) : null), [full])

	const [text, setText] = useDraft(drafts, agentDraftKey(key))
	const replyRef = useRef<HTMLTextAreaElement>(null)
	const blocked = row.itemId !== undefined ? null : agentReplyBlocked(snapshot, session, row.standing)
	const replyable = canPrompt && row.itemId === undefined && blocked === null
	const armed = replyable && !submitting
	const ready = armed && text.trim() !== ''
	const sessionId = (result?.ok ? result.sessionId : undefined) ?? session.sessionId
	const send = () => {
		if (!ready) return
		void onPrompt({
			text,
			...(sessionId ? { sessionId } : {}),
			...(shownUuid ? { assistantUuid: shownUuid } : {}),
		}).then(sent => {
			if (sent.ok) setText('')
		})
	}
	const openItem = () => {
		if (row.itemId !== undefined) onOpenItem(row.itemId)
	}
	useKeys(keys, event => {
		if (row.itemId !== undefined) return submitKeys(event, { bareEnter: true, submit: openItem })
		if (submitKeys(event, { bareEnter: false, submit: send })) return true
		// A key typed at the pane starts the reply (not on a message link: it keeps its keys).
		const field = replyRef.current
		const onLink = event.target instanceof Element && event.target.closest('.agent-dock-md a') !== null
		if (!armed || !field || onLink || !isPrintable(event)) return false
		field.focus({ preventScroll: true })
		setText(text + event.key)
		return true
	})

	const receipt = sessionReplyView(session, now)
	const note = revealNote ? (
		<Receipt view={{ text: revealNote, tone: 'neutral' }} />
	) : receipt ? (
		<Receipt view={receipt} />
	) : localError ? (
		<Receipt view={{ text: localError, tone: 'danger' }} />
	) : canPrompt || row.itemId !== undefined ? (
		blocked
	) : (
		'Reply in the terminal'
	)
	const fallback = stored?.text ? plainAgentLine(stored.text, 160) : ''
	const readNote = result && !result.ok && fallback ? `First line only: ${plainAgentLine(result.detail, 120)}` : null
	const openLabel =
		row.standing === 'needs-you' ? `Open ${row.word}` : row.standing === 'reply-waiting' ? 'Open reply' : 'Open'
	return (
		<>
			<Header
				title={[row.title || row.name, row.repo, row.where.join(' · ')].filter(Boolean).join('\n')}
				end={
					<>
						<Stepper index={index} total={total} noun="agent" onStep={onStep} />
						<CloseKey onClose={onClose} />
					</>
				}
			>
				<span className="agent-dock-title-kind">
					<span
						className="agent-dock-agent-glyph"
						data-tone={row.glyphTone}
						data-status={row.status}
						aria-hidden="true"
					>
						{row.glyph}
					</span>
					{row.name}
				</span>
				<span className="agent-dock-title-state" data-standing={row.standing} data-tone={row.tone}>
					{row.word}
					{row.age ? ` ${row.age}` : ''}
				</span>
				{/* Where it runs stays at any width (item panes drop their project context below 640px). With a
				    terminal to show, its source leads as the link to it. */}
				{reveal ? (
					<span className="agent-dock-title-project agent-dock-title-where">
						<RevealWhere view={reveal} />
						{row.where.length > 1 ? ` · ${row.where.slice(1).join(' · ')}` : ''}
					</span>
				) : (
					<span className="agent-dock-title-project agent-dock-title-where">{row.where.join(' · ')}</span>
				)}
			</Header>
			<ScrollBody label="Last message">
				<div className="agent-dock-message">
					<span className="agent-dock-message-mark" aria-hidden="true">
						●
					</span>
					{row.itemId !== undefined ? (
						<p className="agent-dock-message-text">{row.excerpt || row.word}</p>
					) : (
						(message ?? (
							<p className="agent-dock-message-text" data-quiet={fallback ? undefined : 'true'}>
								{fallback || (result ? 'No message from this agent yet.' : '')}
							</p>
						))
					)}
				</div>
				{readNote ? (
					<p className="agent-dock-facts">
						<span>{readNote}</span>
					</p>
				) : null}
				{row.itemId === undefined ? (
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
							disabled={!armed}
							onChange={event => setText(event.currentTarget.value)}
						/>
					</PromptField>
				) : null}
			</ScrollBody>
			<Footer
				hints={
					<>
						{row.itemId !== undefined ? (
							<Hint keys="↵">open</Hint>
						) : replyable ? (
							<Hint keys={modHint(mod)}>send</Hint>
						) : null}
						<Hint keys="esc">back</Hint>
					</>
				}
				note={note}
			>
				{row.itemId !== undefined ? (
					<Key tone="primary" onClick={openItem}>
						{openLabel}
					</Key>
				) : replyable || submitting ? (
					<Key tone="primary" disabled={!ready} busy={submitting} keyShortcuts={modShortcut(mod)} onClick={send}>
						Send
					</Key>
				) : null}
			</Footer>
		</>
	)
}
