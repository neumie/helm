// A — Window chrome (spec §Design exploration). Ways to frame one viewer window, each in plain viewing and
// in agent-bound feedback mode, over the same PDF so only the chrome differs. A4–A6 are A1 × A3 hybrids:
// A1's single title row and conversation column, A3's clickable path.
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import { type AgentBinding, ChromeBreadcrumb, ChromeStatusLine, ChromeTitleRow } from './chrome'
import { ChromeHybrid, type HybridVariant } from './chrome-hybrid'
import { FIXTURES } from './fixtures'
import type { ViewerFile } from './types'

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

/** The same PDF in a deep synced folder, so path truncation and collapsing are visible. */
const DEEP: ViewerFile = {
	...FIXTURES.pdf,
	path: '~/Library/CloudStorage/Dropbox-Psyon/Reports/2026/October/platform-report-2026-10.pdf',
}

/** A4 plain: A3's order in A1's row — dim clickable folders, then the name; A1's icon actions. */
export const A4PathThenNamePlain: Story = {
	name: 'A4 Path, then name · plain',
	render: () => <ChromeHybrid variant="path-first" file={FIXTURES.pdf} />,
}

/** A4 bound: A1's agent button in the row and its conversation column. */
export const A4PathThenNameBound: Story = {
	name: 'A4 Path, then name · bound',
	render: () => <ChromeHybrid variant="path-first" file={FIXTURES.pdf} agent={CLAUDE} />,
}

/** A5 plain: the name first, the path after it as dim folders; narrow windows show the path on hover or focus. A3's text keys. */
export const A5NameThenPathPlain: Story = {
	name: 'A5 Name, then path · plain',
	render: () => <ChromeHybrid variant="name-first" file={FIXTURES.pdf} />,
}

/** A5 bound: A1's agent button in the row and its conversation column. */
export const A5NameThenPathBound: Story = {
	name: 'A5 Name, then path · bound',
	render: () => <ChromeHybrid variant="name-first" file={FIXTURES.pdf} agent={CLAUDE} />,
}

/** A6 plain: the full breadcrumb before the name when there is room; below 1000px it folds into one "…" menu. */
export const A6CollapsingPlain: Story = {
	name: 'A6 Collapsing path · plain',
	render: () => <ChromeHybrid variant="collapsing" file={FIXTURES.pdf} />,
}

/** A6 bound: A1's agent button in the row and its conversation column. */
export const A6CollapsingBound: Story = {
	name: 'A6 Collapsing path · bound',
	render: () => <ChromeHybrid variant="collapsing" file={FIXTURES.pdf} agent={CLAUDE} />,
}

const ROWS: { label: string; note: string; render: (file: ViewerFile) => ReactNode }[] = [
	{ label: 'A1', note: 'Title row', render: file => <ChromeTitleRow file={file} /> },
	{ label: 'A3', note: 'Breadcrumb', render: file => <ChromeBreadcrumb file={file} /> },
	...(
		[
			['A4', 'Path, then name', 'path-first'],
			['A5', 'Name, then path', 'name-first'],
			['A6', 'Collapsing path', 'collapsing'],
		] as [string, string, HybridVariant][]
	).map(([label, note, variant]) => ({
		label,
		note,
		render: (file: ViewerFile) => <ChromeHybrid variant={variant} file={file} />,
	})),
]

/** Only the title rows, stacked, for a file five folders deep. Resize the window to see each one give way. */
export const LongPathCompare: Story = {
	name: 'A1–A6 Long path, title rows only',
	render: () => (
		<div className="hy-compare">
			{ROWS.map(row => (
				<section key={row.label} aria-label={`${row.label} ${row.note}`}>
					<div className="hy-compare-label">
						<b>{row.label}</b> {row.note}
					</div>
					<div className="hy-compare-row">{row.render(DEEP)}</div>
				</section>
			))}
		</div>
	),
}
