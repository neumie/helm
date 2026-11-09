// A — Window chrome (spec §Design exploration). Three ways to frame one viewer window, each in plain
// viewing and in agent-bound feedback mode, over the same PDF so only the chrome differs.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { type AgentBinding, ChromeBreadcrumb, ChromeStatusLine, ChromeTitleRow } from './chrome'
import { FIXTURES } from './fixtures'

const meta: Meta = {
	title: 'Views/Helm open/A Window chrome',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

const CLAUDE: AgentBinding = { provider: 'Claude', name: 'October platform report', state: 'listening' }

/** A1 plain: one 40px title row (extension tag, name, folder) and icon actions on the right. */
export const A1TitleRowPlain: Story = {
	name: 'A1 Title row · plain',
	render: () => <ChromeTitleRow file={FIXTURES.pdf} />,
}

/** A1 bound: the agent's state sits in the title row; it toggles a right-hand conversation column. */
export const A1TitleRowBound: Story = {
	name: 'A1 Title row · bound',
	render: () => <ChromeTitleRow file={FIXTURES.pdf} agent={CLAUDE} />,
}

/** A2 plain: only the drag strip with the centered name on top; facts and keys in a bottom status line. */
export const A2StatusLinePlain: Story = {
	name: 'A2 Status line · plain',
	render: () => <ChromeStatusLine file={FIXTURES.pdf} />,
}

/** A2 bound: the agent is a status-line segment; the conversation splits off above it, like the agent dock. */
export const A2StatusLineBound: Story = {
	name: 'A2 Status line · bound',
	render: () => <ChromeStatusLine file={FIXTURES.pdf} agent={{ ...CLAUDE, state: 'working' }} />,
}

/** A3 plain: a breadcrumb of clickable folders, text-key actions on the right. */
export const A3BreadcrumbPlain: Story = {
	name: 'A3 Breadcrumb · plain',
	render: () => <ChromeBreadcrumb file={FIXTURES.pdf} />,
}

/** A3 bound: a 28px agent line under the breadcrumb and a feedback margin beside the document. */
export const A3BreadcrumbBound: Story = {
	name: 'A3 Breadcrumb · bound',
	render: () => <ChromeBreadcrumb file={FIXTURES.pdf} agent={CLAUDE} />,
}
