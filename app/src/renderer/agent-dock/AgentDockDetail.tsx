// Agent dock pane bodies (design §3.24): a plain header row on the dock's surface
// (kind glyph, kind, the question's context; ‹ 1/3 › and esc), choices as one line each
// (a drawn mark on the picked row, label, dim description; numbers as key hints while the
// pane holds the keys), key hints in the footer. Jakub answers from here — pick options
// (click, or 1–9 while the pane has focus), Other… text, allow / always allow /
// deny, approve / keep planning, or reply to a finished turn — then one explicit
// submit; nothing is ever sent implicitly. Main re-reads Okena (CAS) before the
// effect; the receipt (Sending… → ✓ answered / sent, unconfirmed / refused /
// verbatim error) comes back in the snapshot. Agent text is untrusted and always
// plain React text. One typeface, the UI's; mono only for literal commands, code,
// plans and previews.
//
// This module picks the body for an item (ItemDetail); the bodies live beside it (AskPanel,
// DecisionPanels, TurnPanel), built from pane-chrome and pane-keys.
import type { MutableRefObject, ReactNode } from 'react'
import type { DockAction, DockItem, DockSession } from '../../agent-dock/model'
import { AskPanel } from './AskPanel'
import { PermissionPanel, PlanPanel } from './DecisionPanels'
import { type RevealView, RevealWhere } from './RevealTerminal'
import { TurnPanel } from './TurnPanel'
import { Hint, ItemHeader, Key, Receipt, Warn } from './pane-chrome'
import { type DetailKeys, type DockModKey, ackShortcut } from './pane-keys'
import type { DockDrafts, PanelProps } from './panel'
import {
	type AgentWho,
	askQuestions,
	canAck,
	planApproveModeText,
	receiptView,
	resolutionLabel,
	sentSummary,
} from './presentation'

export function ItemDetail({
	item,
	session,
	who,
	now,
	index,
	total,
	pending,
	refused,
	canAct,
	blockedNote,
	submitting,
	sent,
	localError,
	keys,
	drafts,
	mod,
	reveal,
	revealNote,
	onStep,
	onClose,
	onAck,
	onAct,
}: {
	item: DockItem
	session: DockSession | undefined
	who: AgentWho
	now: number
	index: number
	total: number
	pending: boolean
	refused: boolean
	/** Okena reachable and the item open: answering is possible. */
	canAct: boolean
	blockedNote: string | null
	submitting: boolean
	sent: DockAction | null
	/** A refusal/failure main did not record on the item (bad request, IPC failure). */
	localError: string | null
	keys: MutableRefObject<DetailKeys | null>
	drafts: DockDrafts
	mod: DockModKey
	/** "Show terminal" for the item's agent (the header's where link), or null when nothing can be shown. */
	reveal: RevealView | null
	/** A reveal that failed (or could not raise Okena): a quiet line in the footer, ahead of the receipt. */
	revealNote: string | null
	onStep(delta: number): void
	onClose(): void
	onAck(): void
	onAct(action: DockAction): void
}) {
	const orphaned = item.state === 'orphaned'
	const resolved = item.state === 'resolved'
	const ackKey = ackShortcut(mod)
	const ackable = canAck(item)
	const ack = ackable ? (
		<Key
			tone="quiet"
			busy={pending}
			onClick={onAck}
			ariaLabel={`Ack item ${item.id}`}
			keyShortcuts={ackKey.aria}
			title={`Ack (${ackKey.label})`}
		>
			Ack
		</Key>
	) : null
	const sourceName = session?.source === 'helm' ? "Helm's Claude hub" : 'Okena'
	const view = receiptView(item)
	const receipt = revealNote ? (
		<Receipt view={{ text: revealNote, tone: 'neutral' }} />
	) : view ? (
		<Receipt
			view={view}
			detail={
				view.tone === 'danger'
					? null
					: ((sent ? sentSummary(item, sent) : null) ??
						(view.tone === 'success' && item.receipt?.action === 'allow'
							? planApproveModeText(item, session?.source)
							: null))
			}
		/>
	) : localError ? (
		<Receipt view={{ text: localError, tone: 'danger' }} />
	) : resolved ? (
		// Closed elsewhere while the pane showed it: it stays until Jakub steps off it or closes the pane, saying how it went.
		<Receipt view={{ text: resolutionLabel(item), tone: 'neutral' }} />
	) : null
	const warnings = (
		<>
			{refused ? <Warn>Not acked: the item changed. Check it again.</Warn> : null}
			{orphaned ? (
				<Warn>{sourceName} restarted while this was open. The agent may still be waiting in its terminal.</Warn>
			) : null}
			{item.state === 'unconfirmed' ? (
				<Warn>
					{item.kind === 'ask'
						? 'Helm has not seen this answer land. If the dialog is still open, it comes back here to answer again.'
						: `${sourceName} took the answer, but Helm has not seen it land. Check the agent's terminal, then Ack.`}
				</Warn>
			) : null}
		</>
	)
	const panel: PanelProps = {
		item,
		live: canAct && !submitting,
		answerable: canAct,
		decidable: canAct || submitting || item.state === 'sending',
		sent,
		mod,
		blockedNote: orphaned ? `Answer in the terminal (${sourceName} lost this dialog)` : canAct ? null : blockedNote,
		receipt,
		ack,
		ackHint: ackable ? <Hint keys={ackKey.label}>ack</Hint> : null,
		warnings,
		keys,
		drafts,
		// An answer on its way (sent from here, or already Sending… in the snapshot): the button shows busy.
		submitting: submitting || item.state === 'sending',
		onAct,
	}
	let body: ReactNode
	if (item.fact.kind === 'turn') body = <TurnPanel key={item.id} {...panel} session={session} />
	else if (item.fact.tool === 'AskUserQuestion' && askQuestions(item.fact.input))
		body = <AskPanel key={item.id} {...panel} />
	else if (item.fact.tool === 'ExitPlanMode') body = <PlanPanel key={item.id} {...panel} session={session} />
	else body = <PermissionPanel key={item.id} {...panel} session={session} />
	return (
		<>
			<ItemHeader
				item={item}
				who={who}
				now={now}
				index={index}
				total={total}
				where={<RevealWhere view={reveal} />}
				onStep={onStep}
				onClose={onClose}
			/>
			{body}
		</>
	)
}
