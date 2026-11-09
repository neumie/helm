// B — Several open files (spec §Behaviour). Tabs, a window per file with a go-to-file palette,
// or a file sidebar; each over the same eight fixtures, all built on the A1 title row.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { MultiSidebar, MultiTabs, MultiWindows } from './chrome'
import { FIXTURES, OPEN_ORDER } from './fixtures'

const meta: Meta = {
	title: 'Views/Helm open/B Multiple files',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

const FILES = OPEN_ORDER.map(key => FIXTURES[key])

/** B1: one window, a tab per file in the title row; ⌘1–9 jump to a tab. */
export const B1Tabs: Story = {
	name: 'B1 Tabs',
	render: () => <MultiTabs files={FILES} />,
}

/** B2: one window per file; ⌘⇧O lists open windows and recent files. Shown with the palette open. */
export const B2WindowPerFile: Story = {
	name: 'B2 Window per file',
	render: () => <MultiWindows files={FILES} />,
}

/** B3: a file list grouped by folder beside the viewer. */
export const B3Sidebar: Story = {
	name: 'B3 Sidebar',
	render: () => <MultiSidebar files={FILES} />,
}

/** B3 with an agent bound to the open file. */
export const B3SidebarBound: Story = {
	name: 'B3 Sidebar · bound',
	render: () => (
		<MultiSidebar files={FILES} agent={{ provider: 'Claude', name: 'October platform report', state: 'listening' }} />
	),
}
