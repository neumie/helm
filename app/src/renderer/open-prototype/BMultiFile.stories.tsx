// B — Several open files (spec §Behaviour). Tabs, a window per file with a go-to-file palette,
// or a file sidebar; each over the same eight fixtures, all built on the A1 title row. B4 combines B1 and B2.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useState } from 'react'
import { Btn } from '../button'
import { MultiSidebar, MultiTabs, MultiWindows } from './chrome'
import { type CombinedFrame, MultiCombined } from './chrome-combined'
import './receipt-story.css'
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

const B4_FRAMES: Record<CombinedFrame, { label: string; note: string }> = {
	windows: { label: 'Windows', note: 'Default: each file opens in its own window, like B2.' },
	tabs: {
		label: 'Merged into tabs',
		note: 'Window → Merge All Windows (or Open Files as Tabs) puts them in one tab strip, like B1. Drag a tab out or Move Tab to New Window to split it off again.',
	},
	menu: {
		label: 'Window menu',
		note: "Helm's own items: macOS native tabs are unavailable with Helm's title row. Open windows are listed below.",
	},
	palette: {
		label: 'Go to file ⌘⇧O',
		note: 'One palette over both: tabs in this window, other windows, recent files.',
	},
}

function CombinedStory({ frame: initial }: { frame: CombinedFrame }) {
	const [frame, setFrame] = useState<CombinedFrame>(initial)
	useEffect(() => setFrame(initial), [initial])
	return (
		<div className="rcpt-story">
			<nav className="rcpt-story-bar" aria-label="Story frames">
				<span className="rcpt-story-title">
					B4 Windows and tabs
					<span>{B4_FRAMES[frame].note}</span>
				</span>
				<span className="rcpt-story-frames">
					{(Object.keys(B4_FRAMES) as CombinedFrame[]).map(key => (
						<Btn
							key={key}
							sm
							tone={key === frame ? 'quiet' : 'ghost'}
							ariaCurrent={key === frame ? 'page' : undefined}
							onClick={() => setFrame(key)}
						>
							{B4_FRAMES[key].label}
						</Btn>
					))}
				</span>
			</nav>
			<MultiCombined key={frame} files={FILES} frame={frame} />
		</div>
	)
}

/** B4: a window per file by default, merged into Helm's own tabs on demand; ⌘⇧O over both. */
export const B4WindowsAndTabs: Story = {
	name: 'B4 Windows and tabs',
	render: () => <CombinedStory frame="windows" />,
}
