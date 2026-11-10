// Story/Playwright-only fixtures for CSV/TSV windows. The bytes are built at run time by csv-fixture-builder.ts and
// served from blob: URLs that stand in for main's helm-viewer://app/file/<token> URLs (Chromium answers a blob:
// Range request with 206 and the exact Content-Range, as main does). Everything else is the production
// DocumentReview window and the production CSV worker. Never import this from production renderer code.
import type { ReviewViewerCsv } from '../../document-review/types'
import { createReviewFixture } from '../document-review/fixtures'
import {
	buildCzechExport,
	buildEventLog,
	buildInvoiceExport,
	buildNumbers,
	buildSentryTsv,
	buildSupportTickets,
	buildWideSheet,
	buildWindows1250,
} from './csv-fixture-builder'

type Parts = (string | Uint8Array)[]

interface CsvFile {
	name: string
	path: string
	kind: ReviewViewerCsv['kind']
	encoding?: ReviewViewerCsv['encoding']
	theme?: 'light'
	parts(): Parts
}

const one = (make: () => string | Uint8Array) => () => [make()]

const FILES = {
	invoices: {
		name: 'clientcare-invoices-2026-10.csv',
		path: '~/Downloads/clientcare-invoices-2026-10.csv',
		kind: 'csv',
		parts: one(() => buildInvoiceExport()),
	},
	'invoices-light': {
		name: 'clientcare-invoices-2026-10.csv',
		path: '~/Downloads/clientcare-invoices-2026-10.csv',
		kind: 'csv',
		theme: 'light',
		parts: one(() => buildInvoiceExport()),
	},
	czech: {
		name: 'faktury-2026-10.csv',
		path: '~/Downloads/faktury-2026-10.csv',
		kind: 'csv',
		encoding: 'utf-8-bom',
		parts: one(() => buildCzechExport()),
	},
	'czech-sep': {
		name: 'faktury-2026-10-excel.csv',
		path: '~/Downloads/faktury-2026-10-excel.csv',
		kind: 'csv',
		parts: one(() => `sep=;\r\n${buildCzechExport(40).slice(1)}`),
	},
	sentry: {
		name: 'sentry-events-2026-11-09.tsv',
		path: '~/Downloads/sentry-events-2026-11-09.tsv',
		kind: 'tsv',
		parts: one(() => buildSentryTsv()),
	},
	wide: {
		name: 'sensor-readings-wide.csv',
		path: '~/Documents/Lab/sensor-readings-wide.csv',
		kind: 'csv',
		parts: one(() => buildWideSheet()),
	},
	'million-rows': {
		name: 'events-2026.csv',
		path: '~/Documents/Exports/events-2026.csv',
		kind: 'csv',
		parts: () => buildEventLog(),
	},
	tickets: {
		name: 'support-tickets.csv',
		path: '~/Downloads/support-tickets.csv',
		kind: 'csv',
		parts: one(buildSupportTickets),
	},
	'unclosed-quote': {
		name: 'notes-cut-off.csv',
		path: '~/Downloads/notes-cut-off.csv',
		kind: 'csv',
		parts: one(() => 'Date,Note\n2026-11-01,Call the bank\n2026-11-02,"Ask Petra about the IČO\nand the address'),
	},
	'too-many-rows': {
		name: 'numbers.csv',
		path: '~/Downloads/numbers.csv',
		kind: 'csv',
		parts: () => buildNumbers(1_000_001),
	},
	windows1250: {
		name: 'kontakty-1250.csv',
		path: '~/Downloads/kontakty-1250.csv',
		kind: 'csv',
		parts: one(buildWindows1250),
	},
	empty: { name: 'empty.csv', path: '~/Downloads/empty.csv', kind: 'csv', parts: () => [] },
} satisfies Record<string, CsvFile>

export type CsvFixtureScenario = keyof typeof FILES

/** The production review fixture in plain mode, showing one CSV or TSV file. */
export function createCsvFixture(scenario: CsvFixtureScenario) {
	const file: CsvFile = FILES[scenario]
	const review = createReviewFixture('plain')
	const tokens: string[] = []
	let revision = 1
	if (file.theme) review.replaceDocument({}, file.theme)
	const show = (parts: Parts, encoding: ReviewViewerCsv['encoding'] = file.encoding ?? 'utf-8') => {
		const blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' })
		const url = URL.createObjectURL(blob)
		tokens.push(url)
		review.replaceDocument({
			name: file.name,
			relativePath: file.path,
			format: 'csv',
			text: '',
			previous: null,
			revision: String(revision++).padStart(64, '0'),
			csv: { url, size: blob.size, kind: file.kind, encoding },
		})
	}
	const started = performance.now()
	show(file.parts())
	return {
		...review,
		/** When the first token was issued (performance.now()), for timing budgets. */
		started,
		/** Main issued a new token for the next readable version, with these rows appended. */
		append: (text: string) => {
			const parts = file.parts()
			show([...parts, text])
		},
		dispose: () => {
			review.dispose()
			for (const url of tokens) URL.revokeObjectURL(url)
		},
	}
}
