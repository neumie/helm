/// <reference path="../open-prototype/vite-env.d.ts" />
// Story/Playwright-only fixtures for PDF windows. The bytes are the checked-in fixture files (fetched by Vite URL) or
// files built at run time by pdf-fixture-builder.ts, served again from blob: URLs that stand in for main's
// helm-viewer://app/file/<token> URLs. While a fixture is mounted it watches window.fetch for its own token URLs:
// it counts pdf.js's range reads and, after `stale()`, answers them 409 like main does once the file changed.
// Everything else is the production DocumentReview window. Never import this from production renderer code.
import { createReviewFixture } from '../document-review/fixtures'
import jp2Url from './fixtures/pdf/form-error.jp2?url'
import reportUrl from './fixtures/pdf/platform-report-2026-10.pdf?url'
import scanUrl from './fixtures/pdf/scanned-delivery-note.pdf?url'
import lockedUrl from './fixtures/pdf/service-agreement-locked.pdf?url'
import {
	type Bitmap,
	buildActiveContentPdf,
	buildBrokenPdf,
	buildCjkPdf,
	buildJbig2Pdf,
	buildJpxPdf,
	buildLedgerPdf,
	buildManyPagesPdf,
} from './pdf-fixture-builder'

/** The password of service-agreement-locked.pdf (scripts/write-pdf-fixtures.mjs). */
export const LOCKED_PDF_PASSWORD = 'helm-2026'

const fetched = (url: string) => () => fetch(url).then(response => response.arrayBuffer())
const built = (make: () => Uint8Array | Promise<Uint8Array>) => async () => {
	const bytes = await make()
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** A fax-like page: dark text drawn on a canvas at 150 dpi, thresholded to one bit. */
function faxBitmap(): Bitmap {
	const width = 1240
	const height = 1754
	const canvas = new OffscreenCanvas(width, height)
	const context = canvas.getContext('2d', { willReadFrequently: true })
	if (!context) throw new Error('No 2D canvas.')
	context.fillStyle = '#fff'
	context.fillRect(0, 0, width, height)
	context.fillStyle = '#000'
	context.font = 'bold 54px Helvetica, Arial, sans-serif'
	context.fillText('FAX  ·  Kancelářské potřeby Brno', 110, 190)
	context.font = '32px "Courier New", monospace'
	const lines = [
		'To:    ClientCare a.s., accounts',
		'Date:  21. 10. 2026',
		'Re:    Delivery note No. 2026-1043',
		'',
		'Pages: 1 of 1',
		'',
		'Please confirm receipt of the goods below by',
		'return fax or e-mail. Thank you.',
		'',
		'  A4 copy paper, 80 g ............ 40 ream',
		'  Toner HP 59A ...................  6 pcs',
		'  Archive box, 75 mm ............. 25 pcs',
	]
	lines.forEach((line, index) => context.fillText(line, 110, 300 + index * 52))
	context.lineWidth = 4
	context.strokeRect(80, 80, width - 160, height - 160)
	const rgba = context.getImageData(0, 0, width, height).data
	const pixels = new Uint8Array(width * height)
	for (let index = 0; index < pixels.length; index++) pixels[index] = (rgba[index * 4] ?? 255) < 140 ? 1 : 0
	return { width, height, pixels }
}

interface PdfFile {
	name: string
	path: string
	bytes(): Promise<ArrayBuffer>
}

const FILES = {
	report: {
		name: 'platform-report-2026-10.pdf',
		path: '~/Downloads/platform-report-2026-10.pdf',
		bytes: fetched(reportUrl),
	},
	'report-light': {
		name: 'platform-report-2026-10.pdf',
		path: '~/Downloads/platform-report-2026-10.pdf',
		bytes: fetched(reportUrl),
	},
	scan: {
		name: 'delivery-note-2026-1043.pdf',
		path: '~/Downloads/delivery-note-2026-1043.pdf',
		bytes: fetched(scanUrl),
	},
	locked: {
		name: 'service-agreement-northwind.pdf',
		path: '~/Documents/Contracts/service-agreement-northwind.pdf',
		bytes: fetched(lockedUrl),
	},
	ledger: {
		name: 'invoice-ledger-2026.pdf',
		path: '~/Documents/Accounts/invoice-ledger-2026.pdf',
		bytes: built(() => buildLedgerPdf(500)),
	},
	'too-many-pages': {
		name: 'scanned-archive-2019.pdf',
		path: '~/Documents/Archive/scanned-archive-2019.pdf',
		bytes: built(() => buildManyPagesPdf(5001)),
	},
	cjk: { name: 'invoices-asia-2026-11.pdf', path: '~/Downloads/invoices-asia-2026-11.pdf', bytes: built(buildCjkPdf) },
	jbig2: {
		name: 'fax-2026-10-21.pdf',
		path: '~/Downloads/fax-2026-10-21.pdf',
		bytes: built(() => buildJbig2Pdf(faxBitmap())),
	},
	jpx: {
		name: 'form-error-jpeg2000.pdf',
		path: '~/Downloads/form-error-jpeg2000.pdf',
		bytes: built(async () => {
			const jp2: ArrayBuffer = await (await fetch(jp2Url)).arrayBuffer()
			return buildJpxPdf(new Uint8Array(jp2), 760, 520)
		}),
	},
	'active-content': {
		name: 'invoice-2026-118.pdf',
		path: '~/Downloads/invoice-2026-118.pdf',
		bytes: built(buildActiveContentPdf),
	},
	broken: { name: 'copied-halfway.pdf', path: '~/Downloads/copied-halfway.pdf', bytes: built(buildBrokenPdf) },
} satisfies Record<string, PdfFile>

export type PdfFixtureScenario = keyof typeof FILES

/** One range read pdf.js made through a fixture token. */
export interface PdfRead {
	token: number
	begin: number
	end: number
	status: number
}

/** The production review fixture in plain mode, showing one PDF. */
export function createPdfFixture(scenario: PdfFixtureScenario) {
	const file: PdfFile = FILES[scenario]
	const review = createReviewFixture('plain')
	const tokens: string[] = []
	const stale = new Set<string>()
	const reads: PdfRead[] = []
	let revision = 1
	if (scenario.endsWith('-light')) review.replaceDocument({}, 'light')
	const realFetch = window.fetch
	const watched: typeof fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
		const token = tokens.indexOf(url)
		if (token < 0) return realFetch(input, init)
		const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '')
		const begin = Number(range?.[1] ?? 0)
		const end = range ? Number(range[2]) + 1 : 0
		if (stale.has(url)) {
			reads.push({ token, begin, end, status: 409 })
			return new Response('The file changed; it is being read again', { status: 409 })
		}
		const response = await realFetch(input, init)
		reads.push({ token, begin, end, status: response.status })
		return response
	}
	window.fetch = watched
	const show = (bytes: ArrayBuffer) => {
		const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
		tokens.push(url)
		review.replaceDocument({
			name: file.name,
			relativePath: file.path,
			format: 'pdf',
			text: '',
			previous: null,
			revision: String(revision++).padStart(64, '0'),
			pdf: { url, size: bytes.byteLength },
		})
	}
	const ready = file.bytes().then(show)
	return {
		...review,
		reads,
		ready,
		/** Bytes pdf.js has read so far through any of this fixture's tokens. */
		bytesRead: () => reads.filter(read => read.status === 206).reduce((sum, read) => sum + read.end - read.begin, 0),
		/** The file changed on disk: the current token answers 409 from now on (main is reading the new version). */
		stale: () => {
			const current = tokens[tokens.length - 1]
			if (current) stale.add(current)
		},
		/** Main issued a new token for the next readable version. */
		update: async (next: PdfFixtureScenario = scenario) => show(await FILES[next].bytes()),
		dispose: () => {
			if (window.fetch === watched) window.fetch = realFetch
			review.dispose()
			for (const url of tokens) URL.revokeObjectURL(url)
		},
	}
}
