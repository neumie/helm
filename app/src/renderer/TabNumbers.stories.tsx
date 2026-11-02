import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import type { RestoredSession, TabGroup } from '../shared'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from './terminal-workspace-fixtures'

/**
 * ⌘1–⌘9 through the real `mountTerminalWorkspace`: only tabs visible in the
 * strip are numbered, each with a dim leading digit; members of a collapsed
 * folder are skipped. Keyboard is live: in a browser ⌘1–⌘9 belong to the
 * browser, so ⌥1–⌥9 (or ⌃1–⌃9) stand in for ⌘.
 */
interface TabNumbersProps {
	/** The Build folder (one tab: compile). Review stays collapsed. */
	buildCollapsed: boolean
}

const BUILD = 'group-000000a1'
const REVIEW = 'group-000000b2'

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

/** Eleven strip tabs: "active shell", Build › compile, and a two-tab Review folder that stays collapsed. */
function stripSessions(): RestoredSession[] {
	return [
		session('shell', 'active shell'),
		{ ...session('compile', 'compile', BUILD), agentRunning: true },
		session('dev', 'dev server'),
		session('tests', 'tests', REVIEW),
		session('logs', 'release logs', REVIEW),
		session('api', 'api'),
		session('db', 'db shell'),
		session('docs', 'docs'),
		session('pi', 'pi: helm'),
		session('deploy', 'deploy'),
		session('scratch', 'scratch'),
	]
}

function stripGroups(buildCollapsed: boolean): TabGroup[] {
	return [
		{ id: BUILD, name: 'Build', color: 'blue', collapsedStrip: buildCollapsed, collapsedBackground: false },
		{ id: REVIEW, name: 'Review', color: 'purple', collapsedStrip: true, collapsedBackground: false },
	]
}

function TabNumbers({ buildCollapsed }: TabNumbersProps) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			sessions: stripSessions(),
			groups: stripGroups(buildCollapsed),
			relayPrimaryDigits: true,
			expose: true,
		}),
		[buildCollapsed],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const meta: Meta<typeof TabNumbers> = {
	title: 'Views/Tab numbers',
	component: TabNumbers,
	parameters: { layout: 'fullscreen' },
	argTypes: { buildCollapsed: { control: 'boolean' } },
	args: { buildCollapsed: true },
}

export default meta
type Story = StoryObj<typeof TabNumbers>

/** Build and Review collapsed: compile, tests and release logs take no number; ⌘9 holds nothing. */
export const BuildCollapsed: Story = { name: 'Build collapsed', args: { buildCollapsed: true } }

/** Build expanded: compile takes ⌘2 and every later tab shifts by one; ⌘9 is the ninth visible tab. */
export const BuildExpanded: Story = { name: 'Build expanded', args: { buildCollapsed: false } }
