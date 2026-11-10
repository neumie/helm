import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo } from 'react'
import '../document-review/document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { DocumentReview } from '../document-review/DocumentReview'
import { type PdfFixtureScenario, createPdfFixture } from './pdf-fixtures'

declare global {
	interface Window {
		__helmPdfProof?: ReturnType<typeof createPdfFixture>
	}
}

function PdfFixture({ scenario }: { scenario: PdfFixtureScenario }) {
	const fixture = useMemo(() => createPdfFixture(scenario), [scenario])
	useEffect(() => {
		window.__helmPdfProof = fixture
		return () => {
			if (window.__helmPdfProof === fixture) window.__helmPdfProof = undefined
			fixture.dispose()
		}
	}, [fixture])
	return <DocumentReview api={fixture.api} />
}

const meta: Meta<typeof PdfFixture> = {
	title: 'Views/Document review/PDF',
	component: PdfFixture,
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj<typeof PdfFixture>

const describe = (story: string) => ({ docs: { description: { story } } })

export const Report: Story = {
	args: { scenario: 'report' },
	parameters: describe(
		'`helm open platform-report-2026-10.pdf`: pages fit the window width on paper white, text is selectable. ⌘F finds (Enter / ⇧Enter or ⌘G / ⇧⌘G step through matches), Document options → Go to page… and Outline, keys 0 fit, 1 actual size, + / − zoom, [ ] or j / k page, ⌘= / ⌘− / ⌘0 and pinch. The status line shows the page, zoom, page count, paper size and file size.',
	),
}
export const ReportLightWindow: Story = {
	args: { scenario: 'report-light' },
	parameters: describe('The light window: only the chrome changes; pages stay paper white.'),
}
export const Scan: Story = {
	args: { scenario: 'scan' },
	parameters: describe('A scanned delivery note: one JPEG per page, no text layer, so find has nothing to match.'),
}
export const Locked: Story = {
	args: { scenario: 'locked' },
	parameters: describe(
		'A password-protected agreement (password `helm-2026`). The password stays in this window’s memory only: it is never sent to main or saved, and a live reload tries it once before asking again.',
	),
}
export const Ledger500Pages: Story = {
	args: { scenario: 'ledger' },
	parameters: describe(
		'A 500-page ledger (3.4 MB). pdf.js asks for byte ranges as pages come into view; pages far away drop their pixels. The outline has one entry per 50 pages.',
	),
}
export const TooManyPages: Story = {
	args: { scenario: 'too-many-pages' },
	parameters: describe('5,001 pages: refused with the count before any page is drawn (the limit is 5,000).'),
}
export const Cjk: Story = {
	args: { scenario: 'cjk' },
	parameters: describe(
		'Japanese, Chinese and Korean text in fonts the file does not embed: pdf.js reads the bundled character maps to draw and find it.',
	),
}
export const Jbig2Fax: Story = {
	args: { scenario: 'jbig2' },
	parameters: describe('A one-bit fax compressed with JBIG2, decoded by the bundled jbig2.wasm.'),
}
export const Jpeg2000: Story = {
	args: { scenario: 'jpx' },
	parameters: describe('A JPEG 2000 picture, decoded by the bundled openjpeg.wasm.'),
}
export const ActiveContent: Story = {
	args: { scenario: 'active-content' },
	parameters: describe(
		'A file that tries to run scripts on open, open a web link, launch an app, fetch a remote PDF and submit a form. Helm draws the page and does none of it: no scripts, no links, no requests.',
	),
}
export const Broken: Story = {
	args: { scenario: 'broken' },
	parameters: describe('A file that starts like a PDF and was cut off: one line saying it could not be read.'),
}
