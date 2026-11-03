import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RestoredSession, TabGroup } from '../shared'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from './terminal-workspace-fixtures'

/**
 * Tab drag across folders through the real `mountTerminalWorkspace`: the strip
 * opens with three collapsed folders (Alpha, Beta, Gamma) in front of the
 * ordinary tabs, then an expanded Delta folder. A tab can be dropped before the
 * whole run, between folders, into a folder, or after it.
 */

const ALPHA = 'group-000000c1'
const BETA = 'group-000000c2'
const GAMMA = 'group-000000c3'
const DELTA = 'group-000000c4'

function session(sessionId: string, name: string, groupId: string | null = null): RestoredSession {
	return {
		sessionId,
		title: name,
		customName: name,
		parked: false,
		groupId,
		agentRunning: false,
		agentAttention: false,
		placementEligible: true,
	}
}

function sessions(): RestoredSession[] {
	return [
		session('lint', 'lint', ALPHA),
		session('format', 'format', ALPHA),
		session('migrate', 'migrate', BETA),
		session('e2e', 'e2e', GAMMA),
		session('smoke', 'smoke', GAMMA),
		session('shell', 'active shell'),
		session('api', 'api'),
		session('web', 'web', DELTA),
		session('worker', 'worker', DELTA),
	]
}

function groups(): TabGroup[] {
	return [
		{ id: ALPHA, name: 'Alpha', color: 'blue', collapsedStrip: true, collapsedBackground: false },
		{ id: BETA, name: 'Beta', color: 'green', collapsedStrip: true, collapsedBackground: false },
		{ id: GAMMA, name: 'Gamma', color: 'purple', collapsedStrip: true, collapsedBackground: false },
		{ id: DELTA, name: 'Delta', color: 'orange', collapsedStrip: false, collapsedBackground: false },
	]
}

const meta: Meta<typeof TerminalWorkspaceFixtureView> = {
	title: 'Views/Tab drag',
	component: TerminalWorkspaceFixtureView,
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof TerminalWorkspaceFixtureView>

const options: TerminalWorkspaceFixtureOptions = { sessions: sessions(), groups: groups(), expose: true }

/** Three collapsed folders lead the strip; drag "api" in front of them, between them, or into one. */
export const CollapsedFolders: Story = { name: 'Collapsed folders', args: { options } }
