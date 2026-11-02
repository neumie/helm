import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import type { RestoredSession, TabGroup } from '../shared'
import type { TabNumberHints, TabNumberMode } from './tab-numbers'
import { TerminalWorkspaceFixtureView, type TerminalWorkspaceFixtureOptions } from './terminal-workspace-fixtures'

/**
 * ⌘1–⌘9 review: numbering mode (B) × number display (N), all through the real
 * `mountTerminalWorkspace`. Keyboard is live: in a browser ⌘1–⌘9 belong to the
 * browser, so ⌥1–⌥9 (or ⌃1–⌃9) stand in for ⌘ and holding ⌥ stands in for
 * holding ⌘. Production is still `all` numbering with no hints.
 */
interface TabNumbersReviewProps {
	/** N1 always · N2 hold · N3 trailing (none = production). */
	hints: TabNumberHints
	/** B1 skip-collapsed · B2 folder-slot (all = production). */
	mode: TabNumberMode
	/** The Build folder from the screenshot (one tab: compile). */
	buildCollapsed: boolean
	/** Simulates holding ⌘ for N2. */
	holdCommand: boolean
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
function reviewSessions(): RestoredSession[] {
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

function reviewGroups(buildCollapsed: boolean): TabGroup[] {
	return [
		{ id: BUILD, name: 'Build', color: 'blue', collapsedStrip: buildCollapsed, collapsedBackground: false },
		{ id: REVIEW, name: 'Review', color: 'purple', collapsedStrip: true, collapsedBackground: false },
	]
}

function TabNumbersReview({ hints, mode, buildCollapsed, holdCommand }: TabNumbersReviewProps) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			sessions: reviewSessions(),
			groups: reviewGroups(buildCollapsed),
			tabNumbers: { mode, hints, held: holdCommand },
			relayPrimaryDigits: true,
			expose: true,
		}),
		[hints, mode, buildCollapsed, holdCommand],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

const meta: Meta<typeof TabNumbersReview> = {
	title: 'Views/Tab numbers',
	component: TabNumbersReview,
	parameters: { layout: 'fullscreen' },
	argTypes: {
		hints: { control: 'inline-radio', options: ['none', 'always', 'hold', 'trailing'] },
		mode: { control: 'inline-radio', options: ['all', 'skip-collapsed', 'folder-slot'] },
		buildCollapsed: { control: 'boolean' },
		holdCommand: { control: 'boolean' },
	},
	args: { hints: 'always', mode: 'skip-collapsed', buildCollapsed: true, holdCommand: false },
}

export default meta
type Story = StoryObj<typeof TabNumbersReview>

/** Production numbering made visible: ⌘2 still opens compile inside the collapsed Build folder. */
export const Today: Story = { args: { hints: 'always', mode: 'all' } }

/** N1 always · B1 skip collapsed. */
export const N1_B1: Story = { name: 'N1 · B1', args: { hints: 'always', mode: 'skip-collapsed' } }
/** N1 always · B2 a collapsed folder is one slot. */
export const N1_B2: Story = { name: 'N1 · B2', args: { hints: 'always', mode: 'folder-slot' } }
/** N2 ⌘ hold · B1 (toggle holdCommand, or hold ⌥). */
export const N2_B1: Story = { name: 'N2 · B1', args: { hints: 'hold', mode: 'skip-collapsed' } }
/** N2 ⌘ hold · B2. */
export const N2_B2: Story = { name: 'N2 · B2', args: { hints: 'hold', mode: 'folder-slot' } }
/** N3 trailing ⌘N · B1 (hover a tab; the active tab always shows it). */
export const N3_B1: Story = { name: 'N3 · B1', args: { hints: 'trailing', mode: 'skip-collapsed' } }
/** N3 trailing ⌘N · B2. */
export const N3_B2: Story = { name: 'N3 · B2', args: { hints: 'trailing', mode: 'folder-slot' } }

/** The same six with Build expanded: compile takes its own number in both modes. */
export const N1_B1_Expanded: Story = {
	name: 'N1 · B1 · Build expanded',
	args: { hints: 'always', mode: 'skip-collapsed', buildCollapsed: false },
}
export const N1_B2_Expanded: Story = {
	name: 'N1 · B2 · Build expanded',
	args: { hints: 'always', mode: 'folder-slot', buildCollapsed: false },
}
export const N2_B1_Expanded: Story = {
	name: 'N2 · B1 · Build expanded',
	args: { hints: 'hold', mode: 'skip-collapsed', buildCollapsed: false },
}
export const N2_B2_Expanded: Story = {
	name: 'N2 · B2 · Build expanded',
	args: { hints: 'hold', mode: 'folder-slot', buildCollapsed: false },
}
export const N3_B1_Expanded: Story = {
	name: 'N3 · B1 · Build expanded',
	args: { hints: 'trailing', mode: 'skip-collapsed', buildCollapsed: false },
}
export const N3_B2_Expanded: Story = {
	name: 'N3 · B2 · Build expanded',
	args: { hints: 'trailing', mode: 'folder-slot', buildCollapsed: false },
}
