import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'

/**
 * The turn pane's last message as quiet Markdown (design §3.24 Turn): Claude's real ending
 * (`TURN_MARKDOWN_TEXT`: bold leads, nested lists, inline code, cut mid-sentence by the excerpt bound)
 * in the production dock under a Claude Code session, the pane open, at 1280×800. No weight anywhere:
 * the body is --text-1, bold and headings --text-0; list markers dim, code in mono with no box.
 */
function AgentDockTurnMessageView() {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({ agentDock: { scenario: 'markdown-turn', position: 'bottom', output: 'claude-code', open: 'turn' } }),
		[],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const meta: Meta<typeof AgentDockTurnMessageView> = {
	title: 'Views/Agent dock turn message',
	component: AgentDockTurnMessageView,
	globals: { viewport: { value: 'helm1280', isRotated: false } },
	parameters: {
		layout: 'fullscreen',
		viewport: { options: { helm1280: { name: 'Helm 1280×800', styles: { width: '1280px', height: '800px' } } } },
	},
}

export default meta
type Story = StoryObj<typeof AgentDockTurnMessageView>

/** Paragraphs 8px apart, lists 2px apart with one 18px step per level, emphasis by tone. */
export const Markdown: Story = {}
