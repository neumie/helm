import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo } from 'react'
import '../document-review/document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { DocumentReview } from '../document-review/DocumentReview'
import { type CsvFixtureScenario, createCsvFixture } from './csv-fixtures'

declare global {
	interface Window {
		__helmCsvProof?: ReturnType<typeof createCsvFixture>
	}
}

function CsvFixture({ scenario }: { scenario: CsvFixtureScenario }) {
	const fixture = useMemo(() => createCsvFixture(scenario), [scenario])
	useEffect(() => {
		window.__helmCsvProof = fixture
		return () => {
			if (window.__helmCsvProof === fixture) window.__helmCsvProof = undefined
			fixture.dispose()
		}
	}, [fixture])
	return <DocumentReview api={fixture.api} />
}

const meta: Meta<typeof CsvFixture> = {
	title: 'Views/Document review/CSV',
	component: CsvFixture,
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj<typeof CsvFixture>

const describe = (story: string) => ({ docs: { description: { story } } })

export const Invoices: Story = {
	args: { scenario: 'invoices' },
	parameters: describe(
		'`helm open clientcare-invoices-2026-10.csv`: 1,800 invoices. The first row is detected as a header and stays on top; row numbers and column letters stay put while scrolling; numbers are right-aligned. Click or drag to select (⇧ extends, letters and numbers select whole columns and rows), arrows / ⌘arrows / Page / Home / End move, ⌘A selects all, ⌘C copies as TSV. The value bar shows the cell reference and the whole value; the status line shows Count and Sum of the selection. ⌘F finds (Enter / ⇧Enter or ⌘G / ⇧⌘G).',
	),
}
export const InvoicesLightWindow: Story = {
	args: { scenario: 'invoices-light' },
	parameters: describe('The light window.'),
}
export const CzechExcelExport: Story = {
	args: { scenario: 'czech' },
	parameters: describe(
		'What Czech Excel writes: UTF-8 with a byte order mark, semicolons, decimal commas and CRLF. The delimiter is detected (status line: Semicolon-separated, UTF-8 with BOM); decimal-comma amounts are numbers, so they align right and sum.',
	),
}
export const ExcelSepLine: Story = {
	args: { scenario: 'czech-sep' },
	parameters: describe(
		'A file starting with Excel’s `sep=;` line: the line sets the delimiter and is not shown as a row.',
	),
}
export const SentryTsv: Story = {
	args: { scenario: 'sentry' },
	parameters: describe('A tab-separated Sentry export: `.tsv` files are always split on tabs.'),
}
export const Wide500Columns: Story = {
	args: { scenario: 'wide' },
	parameters: describe(
		'500 columns (A … SF): columns are virtualised like rows, widths come from the first 1,000 rows, and the row numbers stay on the left while scrolling sideways.',
	),
}
export const MillionRows: Story = {
	args: { scenario: 'million-rows' },
	parameters: describe(
		'1,000,000 records (55 MB), the largest file Helm shows. The first rows appear while the rest is read (status: Reading… N%); ⌘↓ goes to the last row.',
	),
}
export const QuotedLineBreaks: Story = {
	args: { scenario: 'tickets' },
	parameters: describe(
		'Support tickets whose messages hold line breaks, quotes and commas inside quoted values. A cell shows breaks as ↵; the value bar shows the whole message.',
	),
}
export const UnclosedQuote: Story = {
	args: { scenario: 'unclosed-quote' },
	parameters: describe(
		'A file cut off inside a quoted value: the rest is shown as one value and the status line names the row.',
	),
}
export const TooManyRows: Story = {
	args: { scenario: 'too-many-rows' },
	parameters: describe('1,000,001 rows: refused once the limit is passed (the limit is 1,000,000 rows).'),
}
export const Windows1250: Story = {
	args: { scenario: 'windows1250' },
	parameters: describe(
		'A Windows-1250 export from an old Excel: refused as not UTF-8 (Helm shows UTF-8 and UTF-16 with a byte order mark).',
	),
}
export const Empty: Story = {
	args: { scenario: 'empty' },
	parameters: describe('An empty file.'),
}
