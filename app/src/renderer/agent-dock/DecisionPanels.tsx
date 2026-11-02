// Pick-then-submit pane bodies for permission and plan dialogs: a numbered choice, an optional
// message for deny / keep planning, one submit. No single click allows anything.
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react'
import type { DockAction, DockSession } from '../../agent-dock/model'
import { REVIEW_COMMAND_MAX, REVIEW_FIELDS_MAX, REVIEW_PLAN_MAX, planReview } from '../../agent-dock/review'
import {
	type ChoiceRow,
	Choices,
	Footer,
	Hint,
	PromptField,
	RiskyConfirm,
	ScrollBody,
	SubmitActions,
	Warn,
	cancelHints,
	closeHints,
	pickHints,
	useScrollEdges,
} from './pane-chrome'
import { digitOf, isStrayKey, modHint, modShortcut, submitKeys, useKeys } from './pane-keys'
import { type PanelProps, useDraft } from './panel'
import {
	alwaysAllowChoice,
	permissionReview,
	plainAgentLine,
	plainAgentText,
	planApproveModeText,
	riskyWord,
} from './presentation'

/** A decision row: what its button says, the note once it is picked ("Ready to deny"), and the act. */
type Choice = ChoiceRow & { submit: string; ready: string; action: DockAction | 'deny' }

/** The row a sent decision picked (deny / keep planning, allow once / always / approve). */
const sentChoice = (choices: Choice[], sent: DockAction | null): string | null =>
	choices.find(choice =>
		sent?.type === 'deny'
			? choice.action === 'deny'
			: sent?.type === 'allow' &&
				choice.action !== 'deny' &&
				choice.action.type === 'allow' &&
				(choice.action.always === true) === (sent.always === true),
	)?.id ?? null

/**
 * Pick-then-submit body shared by permission and plan dialogs: a numbered choice,
 * an optional message field for "deny", one submit. No single click allows anything.
 */
function DecisionPanel({
	panel,
	choices,
	children,
	bodyLabel,
	choicesLabel,
	messageLabel,
	messagePlaceholder,
	denyVerb,
	hint,
}: {
	panel: PanelProps
	choices: Choice[]
	children: ReactNode
	/** Accessible name of the scroll body ("Command", "Plan"). */
	bodyLabel: string
	/** Names the choice list: the lead's id, or words. */
	choicesLabel: { labelledBy: string } | { label: string }
	messageLabel: string
	messagePlaceholder: string
	/** Hint word for ⌘Enter while the deny/keep-planning field shows ("deny", "send back"). */
	denyVerb: string
	/** The note before a pick, only when it says more than the choices do. */
	hint: string | null
}) {
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
	} = panel
	// A sent decision stays shown (dimmed while sending, under the receipt after); a failure keeps it armed.
	const [selected, setSelected] = useState<string | null>(() => sentChoice(choices, sent))
	const [message, setMessage] = useDraft(drafts, `deny:${item.id}`, sent?.type === 'deny' ? (sent.message ?? '') : '')
	/** The risky word a deny message mentions, while the second confirmation asks. */
	const [confirming, setConfirming] = useState<string | null>(null)
	const messageRef = useRef<HTMLTextAreaElement>(null)
	const fixedRef = useRef<HTMLDivElement>(null)
	useScrollEdges(fixedRef)
	const focusMessage = useRef(false)
	useLayoutEffect(() => {
		if (!focusMessage.current) return
		focusMessage.current = false
		const field = messageRef.current
		const fixed = fixedRef.current
		if (!field || !fixed) return
		// Keep the lead and command in view: no scroll on focus, and the choices block only shows the field's first line.
		field.focus({ preventScroll: true })
		const prompt = field.closest('.agent-dock-prompt')?.getBoundingClientRect()
		const box = fixed.getBoundingClientRect()
		if (prompt && prompt.bottom > box.bottom) fixed.scrollTop += prompt.bottom - box.bottom
	})
	const choice = choices.find(entry => entry.id === selected) ?? null
	const denying = choice?.action === 'deny'
	const choose = (id: string) => {
		if (!live) return
		setSelected(id)
		setConfirming(null)
		if (choices.find(entry => entry.id === id)?.action === 'deny') focusMessage.current = true
	}
	const submit = (confirmed = false) => {
		if (!live || !choice) return
		if (choice.action !== 'deny') {
			onAct(choice.action)
			return
		}
		const text = message.trim()
		const risky = riskyWord(text)
		if (risky && !confirmed) {
			setConfirming(risky)
			return
		}
		setConfirming(null)
		onAct({ type: 'deny', ...(text ? { message: text } : {}), ...(risky ? { confirmed: true } : {}) })
	}
	useKeys(keys, event => {
		const keyed = submitKeys(event, {
			confirming: confirming !== null,
			bareEnter: true,
			cancel: () => setConfirming(null),
			submit: () => submit(),
		})
		if (keyed) return true
		const digit = digitOf(event)
		if (digit !== null) {
			const entry = choices[digit - 1]
			if (!entry) return false
			choose(entry.id)
			return true
		}
		// Letters typed at the pane are meant for somewhere else: drop the pick so a stray Enter sends nothing.
		if (isStrayKey(event)) {
			setSelected(null)
			setConfirming(null)
			return true
		}
		return false
	})
	const note = confirming ? (
		<RiskyConfirm word={confirming} what="This message" />
	) : (
		(receipt ?? blockedNote ?? choice?.ready ?? hint)
	)
	const hints = !answerable ? (
		closeHints
	) : confirming ? (
		cancelHints
	) : denying ? (
		<>
			<Hint keys={modHint(mod)}>{denyVerb}</Hint>
			<Hint keys="esc">close</Hint>
		</>
	) : (
		pickHints(choices.length, mod)
	)
	return (
		<>
			<ScrollBody label={bodyLabel}>
				{warnings}
				{children}
			</ScrollBody>
			{/* Choices never scroll out of a pane sized for an earlier item: only the request above them scrolls. */}
			<div ref={fixedRef} className="agent-dock-pane-fixed">
				<Choices
					rows={choices}
					picked={new Set(selected ? [selected] : [])}
					live={live}
					{...choicesLabel}
					onPick={choose}
				/>
				{denying ? (
					<PromptField>
						<textarea
							ref={messageRef}
							className="agent-dock-input agent-dock-input-fit agent-dock-input-grow"
							aria-label={messageLabel}
							aria-keyshortcuts={modShortcut(mod)}
							placeholder={messagePlaceholder}
							maxLength={4096}
							rows={1}
							value={message}
							disabled={!live}
							onChange={event => {
								setMessage(event.currentTarget.value)
								setConfirming(null)
							}}
						/>
					</PromptField>
				) : null}
			</div>
			<Footer hints={hints} note={note}>
				{ack}
				<SubmitActions
					decidable={decidable}
					confirming={confirming !== null}
					disabled={!live || !choice}
					busy={submitting}
					mod={mod}
					tone={choice?.tone === 'danger' ? 'danger' : 'primary'}
					label={choice?.submit ?? 'Send'}
					onSubmit={() => submit()}
					onConfirm={() => submit(true)}
					onCancel={() => setConfirming(null)}
				/>
			</Footer>
		</>
	)
}

export function PermissionPanel(panel: PanelProps & { session: DockSession | undefined }) {
	const { item, session } = panel
	const leadId = useId()
	if (item.fact.kind !== 'ask') return null
	const { tool, input } = item.fact
	// Okena allows with the full original tool_input and applies every suggestion:
	// offer Allow only when all of it shows here verbatim (main refuses otherwise too).
	// Helm terminals: Always allow only for rule suggestions (the hub cannot apply addDirectories).
	const review = permissionReview(input)
	const always = review.complete ? alwaysAllowChoice(item, session?.source) : null
	const description = review.description ? plainAgentLine(review.description, 240) : ''
	const allows: Choice[] = review.complete
		? [
				{
					id: 'once',
					label: 'Allow once',
					submit: 'Allow once',
					ready: 'Ready to allow once',
					action: { type: 'allow' },
				},
				...(always && always.length > 0
					? [
							{
								id: 'always',
								label: 'Always allow',
								description: (
									<>
										<code className="agent-dock-mono">{always.join(', ')}</code> (this session)
									</>
								),
								submit: 'Always allow',
								ready: 'Ready to always allow',
								action: { type: 'allow', always: true } as DockAction,
							},
						]
					: []),
			]
		: []
	const choices: Choice[] = [
		...allows,
		{
			id: 'deny',
			label: 'Deny',
			description: 'and tell the agent what to do',
			tone: 'danger',
			submit: 'Deny',
			ready: 'Ready to deny',
			action: 'deny',
		},
	]
	return (
		<DecisionPanel
			panel={panel}
			choices={choices}
			bodyLabel={review.command !== null ? 'Command' : 'Tool input'}
			choicesLabel={{ labelledBy: leadId }}
			messageLabel="Message to the agent (optional)"
			messagePlaceholder="What should it do instead?"
			denyVerb="deny"
			hint={review.complete ? null : 'Allow in the terminal, or deny here'}
		>
			<p className="agent-dock-pane-lead" id={leadId}>
				<span className="agent-dock-mono agent-dock-bright">{plainAgentLine(tool, 64)}</span> wants to{' '}
				{review.command !== null ? 'run' : 'use'}
				{description ? <span className="agent-dock-quiet"> · {description}</span> : null}
			</p>
			{review.flags.length > 0 ? (
				<Warn>
					{review.flags
						.map(flag => (flag === 'dangerouslyDisableSandbox' ? 'Runs outside the sandbox' : `${flag}: true`))
						.join(' · ')}
				</Warn>
			) : null}
			{review.command !== null ? (
				<pre className="agent-dock-command">
					<span className="agent-dock-command-prompt" aria-hidden="true">
						${' '}
					</span>
					{plainAgentText(review.command, REVIEW_COMMAND_MAX)}
				</pre>
			) : null}
			{review.fields !== null ? (
				<pre className="agent-dock-command agent-dock-fields">{plainAgentText(review.fields, REVIEW_FIELDS_MAX)}</pre>
			) : null}
			{review.complete ? null : (
				<Warn>Too long or unusual to show in full here. Review it in the agent's terminal to allow it.</Warn>
			)}
		</DecisionPanel>
	)
}

export function PlanPanel(panel: PanelProps & { session: DockSession | undefined }) {
	const { item, session } = panel
	const review = item.fact.kind === 'ask' ? planReview(item.fact.input) : null
	const complete = review?.complete === true
	// Helm terminals: approving also switches the agent to accept edits (said here and in the receipt).
	const mode = planApproveModeText(item, session?.source)
	// Approve sends the whole tool_input back: offer it only when every part of it shows here.
	const choices: Choice[] = [
		...(complete
			? [
					{
						id: 'approve',
						label: 'Approve the plan',
						...(mode ? { description: 'and switch to accept edits' } : {}),
						submit: 'Approve',
						ready: 'Ready to approve',
						action: { type: 'allow' },
					} satisfies Choice,
				]
			: []),
		{
			id: 'keep',
			label: 'Keep planning',
			description: 'say what should change',
			submit: 'Keep planning',
			ready: 'Ready to send back',
			action: 'deny',
		},
	]
	return (
		<DecisionPanel
			panel={panel}
			choices={choices}
			bodyLabel="Plan"
			choicesLabel={{ label: 'Plan decision' }}
			messageLabel="What should change? (optional)"
			messagePlaceholder="Tell the agent what to plan differently"
			denyVerb="send back"
			hint={complete ? null : 'Approve in the terminal, or keep planning here'}
		>
			{review?.plan ? (
				<pre className="agent-dock-plan">{plainAgentText(review.plan, REVIEW_PLAN_MAX)}</pre>
			) : (
				<p className="agent-dock-pane-lead">Plan ready for approval.</p>
			)}
			{review?.fields ? (
				<pre className="agent-dock-command agent-dock-fields">{plainAgentText(review.fields, REVIEW_FIELDS_MAX)}</pre>
			) : null}
			{complete ? null : (
				<Warn>
					The plan is missing, too long or unusual to show in full here. Review it in the agent's terminal to approve
					it.
				</Warn>
			)}
		</DecisionPanel>
	)
}
