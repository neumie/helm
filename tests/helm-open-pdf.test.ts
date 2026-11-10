// S4 of docs/plans/helm-open/spec.md: PDFs. Admission in main reads only the first KiB (header within it, size cap
// before any read), the window gets a range-readable token that answers 409 once the file changes, pdf.js and its
// assets are served with exact types and contain no eval, find and range reads are pure, and the fixture builder's
// files (balanced page trees, JBIG2 MQ coding) are what pdf.js itself reads back.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
	type FileHandle,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	truncate,
	writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import documentModule from '../app/src/document-review/document'
import viewerModule from '../app/src/document-review/viewer-file'
import protocolModule from '../app/src/document-review/viewer-protocol'
import findModule from '../app/src/renderer/viewer/pdf-find'
import builderModule from '../app/src/renderer/viewer/pdf-fixture-builder'
import rangeModule from '../app/src/renderer/viewer/pdf-range'
import {
	PDF_HEAD_BYTES,
	VIEWER_PDF_BYTES,
	VIEWER_PDF_PAGES,
	detectViewerFormat,
	pdfHeaderOffset,
	pdfMismatch,
} from '../src/document-review/formats.js'

const { helmPrivatePaths, pinnedViewerSource, readViewerFile } = viewerModule
const { ReviewDocumentObservation } = documentModule
const { ViewerFileTokens, assetMime, assetPath, handleViewerRequest, viewerFileUrl } = protocolModule
const { findPattern, matchParts, pageMatches, pageText } = findModule
const { readTokenRange } = rangeModule
const { buildActiveContentPdf, buildCjkPdf, buildLedgerPdf, buildManyPagesPdf, jbig2Stream } = builderModule

const APP = join(import.meta.dirname, '../app')
const PDFS = join(APP, 'src/renderer/viewer/fixtures/pdf')
const PDFJS = join(APP, 'node_modules/pdfjs-dist')
const bytes = (text: string) => new TextEncoder().encode(text)

async function fixture() {
	const base = await realpath(await mkdtemp('/tmp/hop-'))
	const home = join(base, 'home')
	const docs = join(base, 'docs')
	for (const dir of [join(home, '.helm'), join(home, 'userData'), join(base, 'daemon'), join(base, 'tmp'), docs])
		await mkdir(dir, { recursive: true })
	const paths = await helmPrivatePaths({
		home,
		userData: join(home, 'userData'),
		daemonRoots: [join(base, 'daemon')],
		authFile: join(home, '.helm', 'local-api-token'),
		uid: process.getuid?.() ?? 501,
		tmp: join(base, 'tmp'),
	})
	return { base, docs, paths, close: () => rm(base, { recursive: true, force: true }) }
}

// ---- format registry and header ----------------------------------------------------------------------------------

test('.pdf is shown now, by range, with the PDF limits; the header may follow up to a KiB of junk', () => {
	const detected = detectViewerFormat('Invoice 2026-118.PDF')
	assert.ok(detected.ok)
	assert.equal(detected.language, 'pdf')
	assert.equal(detected.entry.format, 'pdf')
	assert.equal(detected.entry.available, true)
	assert.equal(detected.entry.read, 'stream')
	assert.equal(detected.entry.maxBytes, VIEWER_PDF_BYTES)
	assert.equal(VIEWER_PDF_BYTES, 256 * 1024 * 1024)
	assert.equal(VIEWER_PDF_PAGES, 5_000)
	assert.equal(PDF_HEAD_BYTES, 1024)

	assert.equal(pdfHeaderOffset(bytes('%PDF-1.7\n')), 0)
	// Acrobat accepts a header anywhere in the first 1024 bytes (mail gateways prepend junk); so does pdf.js.
	const junk = (count: number) => bytes(`${'x'.repeat(count)}%PDF-1.4\n`)
	assert.equal(pdfHeaderOffset(junk(900)), 900)
	assert.equal(pdfHeaderOffset(junk(PDF_HEAD_BYTES - 5)), PDF_HEAD_BYTES - 5)
	assert.equal(pdfHeaderOffset(junk(PDF_HEAD_BYTES - 4)), -1)
	assert.equal(pdfHeaderOffset(bytes('%PDF')), -1)
	assert.equal(pdfMismatch('a.pdf', bytes('%PDF-2.0')), null)
	assert.equal(
		pdfMismatch('invoice.pdf', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		'invoice.pdf is not a PDF (it starts like a PNG image).',
	)
	assert.match(pdfMismatch('notes.pdf', bytes('Meeting notes, 3 November')) ?? '', /^notes\.pdf is not a PDF/)
	assert.equal(pdfMismatch('empty.pdf', new Uint8Array(0)), 'empty.pdf is not a PDF.')
})

test('plain admission reads only the head of a PDF; mismatches, empty and oversized files refuse', async () => {
	const f = await fixture()
	try {
		const report = await readFile(join(PDFS, 'platform-report-2026-10.pdf'))
		await writeFile(join(f.docs, 'report.pdf'), report)
		const read = await readViewerFile(join(f.docs, 'report.pdf'), f.paths)
		assert.deepEqual([read.format, read.language, read.text, read.size], ['pdf', 'pdf', '', report.length])

		await writeFile(
			join(f.docs, 'invoice.pdf'),
			await readFile(join(APP, 'src/renderer/viewer/fixtures/images/form-error.jpg')),
		)
		await assert.rejects(
			readViewerFile(join(f.docs, 'invoice.pdf'), f.paths),
			/invoice\.pdf is not a PDF \(it starts like a JPEG image\)/,
		)
		await writeFile(join(f.docs, 'empty.pdf'), '')
		await assert.rejects(readViewerFile(join(f.docs, 'empty.pdf'), f.paths), /empty\.pdf is (empty|not a PDF)/)
		// The size cap is checked before any read: a sparse 257 MiB file never has its body touched.
		const huge = join(f.docs, 'scans-2019.pdf')
		await writeFile(huge, '%PDF-1.7\n')
		await truncate(huge, VIEWER_PDF_BYTES + 1024 * 1024)
		await assert.rejects(readViewerFile(huge, f.paths), /scans-2019\.pdf is 257 MiB; Helm shows PDFs up to 256 MiB/)
	} finally {
		await f.close()
	}
})

// ---- token: range reads, change, revocation ----------------------------------------------------------------------

test('a PDF window reads its file by range through a token; a change answers 409, then a new token replaces it', async () => {
	const f = await fixture()
	const file = join(f.docs, 'ledger.pdf')
	const ledger = buildLedgerPdf(40)
	await writeFile(file, ledger)
	const tokens = new ViewerFileTokens()
	const observation = new ReviewDocumentObservation(f.docs, file, () => {}, {
		paths: f.paths,
		displayPath: file,
		tokens,
	})
	const ask = (url: string, range?: string) =>
		handleViewerRequest(new Request(url, range ? { headers: { range } } : {}), { tokens, readAsset: async () => null })
	try {
		await observation.start()
		const doc = observation.current()
		assert.equal(doc.format, 'pdf')
		assert.equal(doc.text, '')
		assert.equal(doc.picture, undefined)
		const pdf = doc.pdf
		assert.ok(pdf)
		assert.equal(pdf.size, ledger.length)
		assert.match(pdf.url, /^helm-viewer:\/\/app\/file\/[A-Za-z0-9_-]{43}$/)
		const part = await ask(pdf.url, 'bytes=100-299')
		assert.equal(part.status, 206)
		assert.equal(part.headers.get('content-type'), 'application/octet-stream')
		assert.equal(part.headers.get('content-range'), `bytes 100-299/${ledger.length}`)
		assert.deepEqual(new Uint8Array(await part.arrayBuffer()), ledger.subarray(100, 300))
		// readTokenRange against the real handler.
		const fetchToken = (url: string, init?: RequestInit) =>
			ask(url, new Headers(init?.headers).get('range') ?? undefined)
		const read = await withFetch(fetchToken, () =>
			readTokenRange(pdf.url, pdf.size, 0, 4096, new AbortController().signal),
		)
		assert.ok(read.kind === 'bytes')
		assert.deepEqual(read.bytes, ledger.subarray(0, 4096))

		// Rewritten in place (same inode): the pinned token refuses with 409 before main has even noticed.
		const handle = await open(file, 'r+')
		await handle.write(bytes('%PDF-1.7 changed'), 0, undefined, 0)
		await handle.close()
		assert.equal((await ask(pdf.url, 'bytes=0-99')).status, 409)
		const stale = await withFetch(fetchToken, () =>
			readTokenRange(pdf.url, pdf.size, 0, 100, new AbortController().signal),
		)
		assert.deepEqual(stale, { kind: 'stale' })
		await observation.refresh()
		const next = observation.current().pdf
		assert.ok(next && next.url !== pdf.url)
		assert.equal((await ask(next.url, 'bytes=0-15')).status, 206)
		// The previous token stays until the version after: its rewritten descriptor answers 409, not old bytes.
		assert.equal((await ask(pdf.url, 'bytes=0-99')).status, 409)

		// An editor's atomic save (new inode): the previous token keeps serving the old version's bytes, so a window
		// still showing it can fetch pages it had not read yet, until the version after that replaces it.
		const saved = buildLedgerPdf(41)
		await writeFile(`${file}.tmp`, saved)
		await rename(`${file}.tmp`, file)
		await observation.refresh()
		const third = observation.current().pdf
		assert.ok(third && third.url !== next.url && third.size === saved.length)
		const kept = await ask(next.url, 'bytes=0-15')
		assert.equal(kept.status, 206)
		assert.deepEqual(new Uint8Array(await kept.arrayBuffer()), bytes('%PDF-1.7 changed'))
		await writeFile(`${file}.tmp`, buildLedgerPdf(42))
		await rename(`${file}.tmp`, file)
		await observation.refresh()
		assert.equal((await ask(next.url, 'bytes=0-15')).status, 404)
		assert.equal((await ask(pdf.url, 'bytes=0-15')).status, 404)
	} finally {
		await observation.dispose()
		await f.close()
	}
})

test('a 409 tells the view to read the file again; a write during a read answers 409, never mixed bytes', async () => {
	const tokens = new ViewerFileTokens()
	let told = 0
	const stop = tokens.onChanged(() => told++)
	let stats = 0
	const identity = { dev: 1, ino: 2, size: 10, mtimeMs: 3, ctimeMs: 4 }
	// The descriptor's identity moves between the check before the read and the one after it.
	const handle = {
		stat: async () => (stats++ === 0 ? identity : { ...identity, mtimeMs: 5, ctimeMs: 6 }),
		read: async (buffer: Buffer, offset: number, length: number) => {
			buffer.fill(7, offset, offset + length)
			return { bytesRead: length, buffer }
		},
		close: async () => {},
	} as unknown as FileHandle
	const token = tokens.issue(pinnedViewerSource(handle, identity, 10))
	const answer = await handleViewerRequest(new Request(viewerFileUrl(token), { headers: { range: 'bytes=0-9' } }), {
		tokens,
		readAsset: async () => null,
	})
	assert.equal(answer.status, 409)
	assert.equal(stats, 2)
	assert.equal(told, 1)
	stop()
	await tokens.revokeAll()
	tokens.reportChanged()
	assert.equal(told, 1)
})

async function withFetch<T>(
	replacement: (url: string, init?: RequestInit) => Promise<Response>,
	run: () => Promise<T>,
): Promise<T> {
	const real = globalThis.fetch
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		replacement(
			typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
			init,
		)) as typeof fetch
	try {
		return await run()
	} finally {
		globalThis.fetch = real
	}
}

test('range reads: exact 206 slices, 409/404 end the stream, anything else is an error', async () => {
	const file = buildManyPagesPdf(3)
	const signal = new AbortController().signal
	const served =
		(status = 206) =>
		async (_url: string, init?: RequestInit) => {
			const [, from, to] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '') ?? []
			const headers = status === 206 ? { 'content-range': `bytes ${from}-${to}/${file.length}` } : undefined
			return new Response(file.slice(Number(from), Number(to) + 1), { status, headers })
		}
	assert.deepEqual(await withFetch(served(), () => readTokenRange('t', file.length, 10, 30, signal)), {
		kind: 'bytes',
		bytes: file.slice(10, 30),
	})
	for (const status of [409, 404])
		assert.deepEqual(await withFetch(served(status), () => readTokenRange('t', file.length, 0, 10, signal)), {
			kind: 'stale',
		})
	await assert.rejects(
		withFetch(served(500), () => readTokenRange('t', file.length, 0, 10, signal)),
		/\(500\)/,
	)
	// A 200 for a part of the file is not a range answer.
	await assert.rejects(
		withFetch(served(200), () => readTokenRange('t', file.length, 5, 10, signal)),
		/\(200\)/,
	)
	await assert.rejects(
		withFetch(
			async () =>
				new Response(file.slice(0, 3), { status: 206, headers: { 'content-range': `bytes 0-9/${file.length}` } }),
			() => readTokenRange('t', file.length, 0, 10, signal),
		),
		/completely/,
	)
	// The right length from the wrong place, or of a different file, is not the part asked for.
	for (const range of [`bytes 1-10/${file.length}`, `bytes 0-9/${file.length + 1}`, null])
		await assert.rejects(
			withFetch(
				async () =>
					new Response(file.slice(1, 11), { status: 206, headers: range ? { 'content-range': range } : undefined }),
				() => readTokenRange('t', file.length, 0, 10, signal),
			),
			/different range/,
		)
	await assert.rejects(readTokenRange('t', 100, 90, 101, signal), RangeError)
})

// ---- pdf.js assets ------------------------------------------------------------------------------------------------

test('pdf.js and its worker contain no eval or new Function; their assets have exact types and safe paths', () => {
	// build/pdf.mjs is what esbuild bundles into the PdfView chunk (package main); the worker is copied as is.
	for (const file of ['build/pdf.mjs', 'build/pdf.worker.min.mjs']) {
		const source = readFileSync(join(PDFJS, file), 'utf8')
		assert.doesNotMatch(source, /\beval\s*\(/, file)
		// `new FunctionBasedShading(` is a class name, not the Function constructor.
		assert.doesNotMatch(source, /\bnew Function\s*\(/, file)
	}
	for (const [path, mime] of [
		['pdfjs/build/pdf.worker.min.mjs', 'text/javascript; charset=utf-8'],
		['pdfjs/cmaps/UniJIS-UCS2-H.bcmap', 'application/octet-stream'],
		['pdfjs/standard_fonts/FoxitSans.pfb', 'application/octet-stream'],
		['pdfjs/standard_fonts/LiberationSans-Regular.ttf', 'font/ttf'],
		['pdfjs/wasm/jbig2.wasm', 'application/wasm'],
		['pdfjs/wasm/openjpeg.wasm', 'application/wasm'],
		['pdfjs/iccs/CGATS001Compat-v2-micro.icc', 'application/vnd.iccprofile'],
	] as const) {
		assert.equal(assetPath(`/assets/${path}`), path)
		assert.equal(assetMime(path), mime, path)
	}
	assert.equal(assetPath('/assets/pdfjs/../../index.html'), null)
	assert.equal(assetMime('pdfjs/wasm/quickjs-eval.js'), 'text/javascript; charset=utf-8')
	// The build copies only what the viewer uses: no scripting engine, no JS fallbacks for the wasm decoders.
	const build = readFileSync(join(APP, 'build.mjs'), 'utf8')
	const copied = /for \(const wasm of (\[[^\]]*\])\)/.exec(build)?.[1]
	assert.deepEqual(JSON.parse((copied ?? '').replaceAll("'", '"')), ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm'])
	assert.doesNotMatch(build, /cpSync\([^)]*(quickjs|nowasm|sandbox)/)
})

// ---- find ----------------------------------------------------------------------------------------------------------

test('find: items join with line breaks, whitespace runs match any whitespace, matches map back to item parts', () => {
	const text = pageText([
		{ str: 'Two severity', hasEOL: true },
		{ str: '2 incidents ', hasEOL: false },
		{ str: 'in Brno (C++)', hasEOL: false },
	])
	assert.equal(text.text, 'Two severity\n2 incidents in Brno (C++)')
	const pattern = findPattern('  severity   2 ')
	assert.ok(pattern)
	const [match] = pageMatches(3, text, pattern)
	assert.deepEqual(match, { page: 3, start: 4, end: 14 })
	assert.deepEqual(matchParts(text, match as { start: number; end: number }), [
		{ item: 0, from: 4, to: 12 },
		{ item: 1, from: 0, to: 1 },
	])
	// Special characters are literal, matching is case-insensitive and Unicode-aware.
	assert.equal(pageMatches(1, text, findPattern('(c++)') as RegExp).length, 1)
	assert.equal(
		pageMatches(1, pageText([{ str: 'IČO ičo Ičo', hasEOL: false }]), findPattern('ičo') as RegExp).length,
		3,
	)
	assert.equal(findPattern('   '), null)
	const many = pageText([{ str: 'a'.repeat(50), hasEOL: false }])
	assert.equal(pageMatches(1, many, findPattern('a') as RegExp, 7).length, 7)
})

// ---- fixture builder ------------------------------------------------------------------------------------------------

test('builder: balanced page trees, outline and text that pdf.js reads back; active content is all there', async () => {
	const pdfjs = await import(pathToFileURL(join(PDFJS, 'legacy/build/pdf.mjs')).href)
	const load = (data: Uint8Array) =>
		pdfjs.getDocument({ data: data.slice(), verbosity: 0, useWorkerFetch: false }).promise
	const ledger = await load(buildLedgerPdf(500))
	assert.equal(ledger.numPages, 500)
	const page = await ledger.getPage(377)
	const content = await page.getTextContent()
	assert.match(content.items.map((item: { str: string }) => item.str).join(' '), /page 377 of 500/)
	const outline = await ledger.getOutline()
	assert.equal(outline.length, 10)
	assert.equal(await ledger.getPageIndex(outline[3].dest[0]), 150)
	await ledger.loadingTask.destroy()
	const many = await load(buildManyPagesPdf(5001))
	assert.equal(many.numPages, 5001)
	await many.loadingTask.destroy()

	// No Kids array longer than 10: pdf.js walks a flat array object by object.
	const text = new TextDecoder('latin1').decode(buildLedgerPdf(500))
	const longest = Math.max(
		...[...text.matchAll(/\/Kids \[([^\]]*)\]/g)].map(match => (match[1] ?? '').split(' R').length - 1),
	)
	assert.ok(longest <= 10, `longest Kids array is ${longest}`)

	const active = new TextDecoder('latin1').decode(buildActiveContentPdf())
	for (const marker of [
		'/OpenAction',
		'/S /JavaScript',
		'/S /Launch',
		'/S /URI',
		'/S /GoToR',
		'/S /SubmitForm',
		'/FS /URL',
	])
		assert.ok(active.includes(marker), marker)
	const cjk = new TextDecoder('latin1').decode(buildCjkPdf())
	for (const cmap of ['UniJIS-UCS2-H', 'UniGB-UCS2-H', 'UniKS-UCS2-H']) assert.ok(cjk.includes(`/Encoding /${cmap}`))
	assert.doesNotMatch(cjk, /FontFile/)
})

test('builder: the JBIG2 MQ coder round-trips through pdf.js’s own decoder', async () => {
	const decoders = await import(pathToFileURL(join(PDFJS, 'image_decoders/pdf.image_decoders.mjs')).href)
	// The JS port of the same decoder the viewer runs as jbig2.wasm (Node has no fetch for file: wasm URLs).
	decoders.Jbig2Image.setOptions({
		useWasm: false,
		useWorkerFetch: true,
		wasmUrl: pathToFileURL(join(PDFJS, 'wasm/')).href,
	})
	for (const [width, height, ink] of [
		[37, 23, (index: number) => ((index * 7919) % 13 < 5 ? 1 : 0)],
		[200, 64, (index: number) => (index % 200 < 100 === Math.floor(index / 200) % 8 < 4 ? 1 : 0)],
		[9, 9, () => 1],
		[64, 8, () => 0],
	] as const) {
		const pixels = Uint8Array.from({ length: width * height }, (_, index) => ink(index))
		const decoded: Uint8ClampedArray = await decoders.Jbig2Image.instance.decode(
			jbig2Stream({ width, height, pixels }),
			width,
			height,
			null,
		)
		const stride = Math.ceil(width / 8)
		assert.equal(decoded.length, stride * height)
		const back = Uint8Array.from({ length: width * height }, (_, index) => {
			const x = index % width
			const y = Math.floor(index / width)
			return ((decoded[y * stride + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1
		})
		// pdf.js hands PDF imaging 1 = white, the opposite of JBIG2's 1 = black.
		assert.deepEqual(
			back.map(bit => 1 - bit),
			pixels,
			`${width} × ${height}`,
		)
	}
})
