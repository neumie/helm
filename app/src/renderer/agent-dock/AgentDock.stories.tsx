import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo, useState } from 'react'
import type { AgentDockSnapshot, DockItem } from '../../agent-dock/model'
import { AgentDock, type AgentDockTarget } from './AgentDock'
import { type AgentDockScenario, createAgentDockFixture } from './agent-dock-fixtures'
import { type AgentDockPosition, cardKindLabel, railItems } from './presentation'

type OpenFixture = 'question' | 'permission' | 'plan' | 'turn' | 'orphaned' | 'agents'

const OPEN_MATCH: Record<Exclude<OpenFixture, 'agents'>, (item: DockItem) => boolean> = {
	question: item => cardKindLabel(item) === 'Question',
	permission: item => cardKindLabel(item) === 'Permission',
	plan: item => cardKindLabel(item) === 'Plan',
	turn: item => item.kind === 'turn',
	orphaned: item => item.state === 'orphaned',
}

function resolveOpen(snapshot: AgentDockSnapshot, open: OpenFixture | undefined): AgentDockTarget | null {
	if (!open) return null
	if (open === 'agents') return { type: 'agents' }
	const item = railItems(snapshot, Date.now()).find(OPEN_MATCH[open])
	return item ? { type: 'item', id: item.id } : null
}

/**
 * Real AgentDock body over reducer-built snapshots from the recorded Okena fixtures,
 * in a pane-sized frame: the empty terminal-colored area stands in for #terms and
 * shrinks when a pane splits off it (the full workspace lives in Views / Terminal workspace).
 */
function AgentDockFixtureView({
	scenario,
	position = 'bottom',
	open,
}: {
	scenario: AgentDockScenario
	position?: AgentDockPosition
	open?: OpenFixture
}) {
	const fixture = useMemo(() => createAgentDockFixture(scenario), [scenario])
	const [snapshot, setSnapshot] = useState<AgentDockSnapshot | null>(null)
	useEffect(() => fixture.api.onSnapshot(setSnapshot), [fixture])
	const terminal = <div style={{ flex: '1 1 auto', minHeight: 0, background: 'var(--term-bg)' }} />
	// With a pane requested, mount once the first snapshot exists so it can open on mount.
	const ready = !open || snapshot !== null
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
			{position === 'bottom' ? terminal : null}
			<div className="agent-dock" data-position={position}>
				<div className="agent-dock-view">
					{ready ? (
						<AgentDock
							snapshot={snapshot}
							now={Date.now()}
							position={position}
							shortcutLabel="⌘⇧J"
							initialOpen={snapshot ? resolveOpen(snapshot, open) : null}
							initialSent={fixture.sent()}
							onAck={fixture.api.ack}
							onAct={(itemId, rev, action) => fixture.api.act({ itemId, rev, action })}
						/>
					) : null}
				</div>
			</div>
			{position === 'top' ? terminal : null}
		</div>
	)
}

const meta: Meta<typeof AgentDockFixtureView> = {
	title: 'Compositions/Agent dock',
	component: AgentDockFixtureView,
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof AgentDockFixtureView>

/** The 28px queue row, no pane: two asks (one past 2h, one past 30m), an unchecked turn, the Agents entry. */
export const Queue: Story = { args: { scenario: 'busy' } }

/** Claude in Helm terminals beside Okena: the same row; the health tooltip reads "Okena · Helm terminals". */
export const HelmTerminals: Story = { args: { scenario: 'helm-terminals' } }

/** A plan from a Helm terminal: Approve also switches the agent to accept edits (said in its description). */
export const HelmPlanOpen: Story = { args: { scenario: 'helm-terminals', open: 'plan' } }

/** Five items: plan approval and a second turn join, still one row. */
export const FiveItems: Story = { args: { scenario: 'crowded' } }

/** Question pane: two questions as tabs, numbered options with live previews, disabled Submit answers. */
export const QuestionOpen: Story = { args: { scenario: 'crowded', open: 'question' } }

/** Permission pane: "Always allow" wording comes from Claude's permission_suggestions. */
export const PermissionOpen: Story = { args: { scenario: 'crowded', open: 'permission' } }

export const PlanOpen: Story = { args: { scenario: 'crowded', open: 'plan' } }

export const TurnOpen: Story = { args: { scenario: 'crowded', open: 'turn' } }

/**
 * Jakub's real case: long ClientCare task titles behind short branch names — two sessions on
 * `fix/company-create-save-firm` (the second numbered `#2`), a turn on
 * `fix/repeated-android-camera-permission`; agents 4, 2 busy.
 */
export const RealCase: Story = { args: { scenario: 'real-case' } }
export const RealCaseTurn: Story = { args: { scenario: 'real-case', open: 'turn' } }
export const RealCaseQuestion: Story = { args: { scenario: 'real-case', open: 'question' } }
export const RealCasePermission: Story = { args: { scenario: 'real-case', open: 'permission' } }

/** Eight items: the row shows what fits, then one quiet "+N more" cell that opens the next. */
export const Overflow: Story = { args: { scenario: 'overflow' } }

/** Okena restarted while a question was open: amber kind, warning line, Ack. */
export const OrphanedOpen: Story = { args: { scenario: 'orphaned', open: 'orphaned' } }

export const AgentsOpen: Story = { args: { scenario: 'crowded', open: 'agents' } }

/** Okena unreachable: everything is frozen, never "all clear". */
export const SourceDown: Story = { args: { scenario: 'down' } }

/** Okena reachable, no Claude sessions connected. */
export const Empty: Story = { args: { scenario: 'empty' } }

/** Before the first Okena answer. */
export const Connecting: Story = { args: { scenario: 'connecting' } }

/** Top position: the queue row, then the pane split off the terminal below it. */
export const Top: Story = { args: { scenario: 'crowded', position: 'top', open: 'question' } }

/** Answering: the question pane after Submit answers, while main runs the Okena CAS read and POST. */
export const ReceiptSending: Story = { args: { scenario: 'receipt-sending', open: 'question' } }

/** Okena took the answer but the dialog has not been seen closing for 10 s: amber, Ack offered. */
export const ReceiptUnconfirmed: Story = { args: { scenario: 'receipt-unconfirmed', open: 'question' } }

/** The dialog closed after the dock answer: the entry keeps its slot with "✓ answered", then leaves the queue. */
export const ReceiptAnswered: Story = { args: { scenario: 'receipt-answered', open: 'question' } }

/** CAS refused it: the dialog was already answered in the terminal. */
export const ReceiptRefused: Story = { args: { scenario: 'receipt-refused', open: 'question' } }

/** Okena failed the POST: the verbatim error, and the controls are live again for a retry. */
export const ReceiptFailed: Story = { args: { scenario: 'receipt-failed', open: 'question' } }

/** Receipt states on the entries with no pane open. */
export const ReceiptCards: Story = { args: { scenario: 'receipt-unconfirmed' } }
