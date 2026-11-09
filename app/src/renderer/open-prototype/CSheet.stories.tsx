import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { FormatStage } from './FormatStage'
import { SheetView } from './SheetView'
import { FIXTURES } from './fixtures'
import type { FeedbackAnchor, FeedbackHost, RendererProps } from './types'

const meta = {
	title: 'Views/Helm open/C Format views/Spreadsheet',
	parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function SummaryView(props: RendererProps) {
	return <SheetView {...props} initialSheet="Summary" initialRange="B2:D11" />
}

const SUMMARY_ANCHOR: FeedbackAnchor = {
	kind: 'cells',
	sheet: 'Summary',
	range: 'A2:D6',
	preview: [
		['Psyon s.r.o.', '24', '540250', '653704'],
		['Nordic Freight AB', '27', '651410', '788206'],
		['Kavárna Lípa', '24', '612680', '741341'],
		['Dentium Clinic', '21', '515000', '623152'],
	],
}

function FeedbackStage() {
	const [active, setActive] = useState<FeedbackAnchor | null>(SUMMARY_ANCHOR)
	const host: FeedbackHost = { active, onAnchor: anchor => setActive(anchor) }
	return <FormatStage file={FIXTURES.xlsx} Renderer={SheetView} feedback={host} />
}

/** The workbook opens on its first sheet, Invoices (240 invoices plus a header row). */
export const Workbook: Story = {
	render: () => <FormatStage file={FIXTURES.xlsx} Renderer={SheetView} />,
}

/** The Summary sheet with B2:D11 selected, so the formula bar shows COUNTIF/SUMIF formulas. */
export const WorkbookSummary: Story = {
	render: () => <FormatStage file={FIXTURES.xlsx} Renderer={SummaryView} />,
}

/** 1 801-row CSV, first row as data, virtualized in both axes. */
export const Csv: Story = {
	render: () => <FormatStage file={FIXTURES.csv} Renderer={SheetView} />,
}

/** Agent feedback mode: Summary!A2:D6 stays painted; a new range selection becomes the anchor. */
export const FeedbackMode: Story = {
	render: () => <FeedbackStage />,
}
