import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import type { AgentDockPosition } from './presentation'

/**
 * Jakub drags the pane's height himself (design §3.24 Pane height): its terminal-side edge — the dock's
 * 1px edge — is a 6px row-resize target with nothing visible at rest. Hovered it turns --accent (the
 * focus edge's token); dragged, --accent at 2px. The height he leaves is stored and every pane opens at
 * it (clamped to the room that keeps 8 terminal rows); a double-click on the edge goes back to automatic
 * sizing. Production dock, production mount; a pointer-opened turn at a stored 360px, with the edge's
 * look pinned (story-only: a story cannot hold the pointer there). The stored height is put back on
 * unmount.
 */
function AgentDockPaneResizeView({ position, look }: { position: AgentDockPosition; look: 'hover' | 'drag' }) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			agentDock: {
				scenario: 'real-case',
				position,
				output: 'claude-code',
				open: 'turn',
				paneHeight: 360,
				resizeLook: look,
			},
		}),
		[position, look],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const meta: Meta<typeof AgentDockPaneResizeView> = {
	title: 'Views/Agent dock pane resize',
	component: AgentDockPaneResizeView,
	globals: { viewport: { value: 'helm1280', isRotated: false } },
	parameters: {
		layout: 'fullscreen',
		viewport: { options: { helm1280: { name: 'Helm 1280×800', styles: { width: '1280px', height: '800px' } } } },
	},
	args: { position: 'bottom', look: 'drag' },
	argTypes: {
		position: { control: 'inline-radio', options: ['bottom', 'top'] },
		look: { control: 'inline-radio', options: ['hover', 'drag'] },
	},
}

export default meta
type Story = StoryObj<typeof AgentDockPaneResizeView>

/** Dock below the terminal: the pane's top edge, dragged (--accent, 2px). */
export const Dragging: Story = {}

/** Dock below the terminal: the pane's top edge under the pointer (--accent, 1px). */
export const Hover: Story = { args: { look: 'hover' } }

/** Dock above the terminal: the pane's bottom edge is the one to drag. */
export const DraggingAbove: Story = { name: 'Dragging above', args: { position: 'top' } }

/** Dock above the terminal, the bottom edge under the pointer. */
export const HoverAbove: Story = { name: 'Hover above', args: { position: 'top', look: 'hover' } }
