import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo, useState } from 'react'
import type { AgentDockSnapshot, DockItem } from '../../agent-dock/model'
import { AgentDock, type AgentDockTarget } from './AgentDock'
import { type AgentDockScenario, createAgentDockFixture } from './agent-dock-fixtures'
import { type AgentDockPosition, cardKindLabel, needsYouItems } from './presentation'

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
	const item = needsYouItems(snapshot).find(OPEN_MATCH[open])
	return item ? { type: 'item', id: item.id } : null
}

/**
 * Real AgentDock body over reducer-built snapshots from the recorded Okena fixtures,
 * in a pane-sized frame: the empty terminal-colored area stands in for #terms so the
 * popover has room to open over it (the full workspace lives in Views / Terminal workspace).
 */
function AgentDockFixtureView({
	scenario,
	expanded: initialExpanded,
	position: initialPosition = 'bottom',
	open,
}: {
	scenario: AgentDockScenario
	expanded: boolean
	position?: AgentDockPosition
	open?: OpenFixture
}) {
	const fixture = useMemo(() => createAgentDockFixture(scenario), [scenario])
	const [snapshot, setSnapshot] = useState<AgentDockSnapshot | null>(null)
	const [expanded, setExpanded] = useState(initialExpanded)
	const [position, setPosition] = useState(initialPosition)
	useEffect(() => fixture.api.onSnapshot(setSnapshot), [fixture])
	const terminal = <div style={{ flex: '1 1 auto', minHeight: 0, background: 'var(--term-bg)' }} />
	// With a popover requested, mount once the first snapshot exists so it can open on mount.
	const ready = !open || snapshot !== null
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
			{position === 'bottom' ? terminal : null}
			<div className="agent-dock" data-position={position} data-expanded={String(expanded)}>
				<div className="agent-dock-view">
					{ready ? (
						<AgentDock
							snapshot={snapshot}
							now={Date.now()}
							expanded={expanded}
							position={position}
							shortcutLabel="⌘⇧J"
							initialOpen={snapshot ? resolveOpen(snapshot, open) : null}
							onToggle={() => setExpanded(value => !value)}
							onTogglePosition={() => setPosition(value => (value === 'bottom' ? 'top' : 'bottom'))}
							onAck={fixture.api.ack}
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

/** Rail open: two asks (one past 2h, one past 30m), an unchecked turn, and the Agents button. */
export const RailOpen: Story = { args: { scenario: 'busy', expanded: true } }

/** The default 28px strip; arriving items never change its height. */
export const Collapsed: Story = { args: { scenario: 'busy', expanded: false } }

/** Five items: plan approval and a second turn join; cards compact before anything leaves view. */
export const FiveItems: Story = { args: { scenario: 'crowded', expanded: true } }

/** Question popover: two questions as tabs, options with live previews, disabled Submit answers. */
export const QuestionOpen: Story = { args: { scenario: 'crowded', expanded: true, open: 'question' } }

/** Permission popover: "Always allow" wording comes from Claude's permission_suggestions. */
export const PermissionOpen: Story = { args: { scenario: 'crowded', expanded: true, open: 'permission' } }

export const PlanOpen: Story = { args: { scenario: 'crowded', expanded: true, open: 'plan' } }

export const TurnOpen: Story = { args: { scenario: 'crowded', expanded: true, open: 'turn' } }

/** Okena restarted while a question was open: dashed edge, warning line, Ack. */
export const OrphanedOpen: Story = { args: { scenario: 'orphaned', expanded: true, open: 'orphaned' } }

export const AgentsOpen: Story = { args: { scenario: 'crowded', expanded: true, open: 'agents' } }

/** Okena unreachable: everything is frozen, never "all clear". */
export const SourceDown: Story = { args: { scenario: 'down', expanded: true } }

export const SourceDownCollapsed: Story = { args: { scenario: 'down', expanded: false } }

/** Okena reachable, no Claude sessions connected. */
export const Empty: Story = { args: { scenario: 'empty', expanded: true } }

/** Before the first Okena answer. */
export const Connecting: Story = { args: { scenario: 'connecting', expanded: true } }

/** Top position: the rail and its popover open downward, away from the strip. */
export const Top: Story = { args: { scenario: 'crowded', expanded: true, position: 'top', open: 'question' } }
