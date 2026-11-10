// helm open S5: CSV and TSV. Main reads only the first bytes (encoding, binary signatures) and serves the file by
// range through a token; the grid's worker decodes strictly and parses into a CsvTable. The table is pure, so these
// tests feed it every split of the input a range read or a decoder could produce.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import documentModule from '../app/src/document-review/document'
import viewerModule from '../app/src/document-review/viewer-file'
import protocolModule from '../app/src/document-review/viewer-protocol'
import builderModule from '../app/src/renderer/viewer/csv-fixture-builder'
import modelModule from '../app/src/renderer/viewer/csv-model'
import tableModule from '../app/src/renderer/viewer/csv-table'
import rangeModule from '../app/src/renderer/viewer/pdf-range'
import { VIEWER_CSV_BYTES, VIEWER_CSV_COLUMNS, detectViewerFormat } from '../src/document-review/formats'

const { helmPrivatePaths, readViewerFile } = viewerModule
const { ReviewDocumentObservation } = documentModule
const { ViewerFileTokens, handleViewerRequest } = protocolModule
const { buildCzechExport, buildInvoiceExport, buildNumbers, buildSupportTickets, buildWideSheet, buildWindows1250 } =
	builderModule
const {
	CsvScanner,
	alignRight,
	columnName,
	detectDelimiter,
	detectHeader,
	displayValue,
	numericValue,
	parseRecord,
	rangeRef,
	tsvValue,
} = modelModule
const { CsvRefusal, CsvTable, textWeight } = tableModule
const { readTokenRange } = rangeModule

type Table = InstanceType<typeof CsvTable>

/** The table of `text` pushed in pieces of `size` characters (all at once when omitted). */
function table(text: string, size = text.length || 1, delimiter: ',' | ';' | '\t' | '|' | null = null): Table {
	const result = new CsvTable(delimiter)
	for (let index = 0; index < text.length; index += size) result.push(text.slice(index, index + size))
	result.finish()
	return result
}
const rows = (t: Table) => Array.from({ length: t.rows }, (_, index) => t.row(index))

// ---- registry ----------------------------------------------------------------------------------------------------

test('.csv/.tsv/.tab are shown now, streamed, with a 128 MiB limit; .csv detects its delimiter, .tsv uses tabs', () => {
	for (const [name, language] of [
		['export.csv', 'csv'],
		['EXPORT.CSV', 'csv'],
		['events.tsv', 'tsv'],
		['events.tab', 'tsv'],
		['report.2026.csv', 'csv'],
	] as const) {
		const detected = detectViewerFormat(name)
		assert.ok(detected.ok, name)
		assert.equal(detected.entry.format, 'csv', name)
		assert.equal(detected.language, language, name)
		assert.equal(detected.entry.read, 'stream')
		assert.equal(detected.entry.maxBytes, VIEWER_CSV_BYTES)
		assert.deepEqual(detected.entry.anchors, ['cell'])
	}
	assert.equal(VIEWER_CSV_BYTES, 128 * 1024 * 1024)
})

// ---- scanner and parser ------------------------------------------------------------------------------------------

test('records follow RFC 4180: quoted delimiters, doubled quotes and line breaks (LF, CRLF, CR) inside quotes', () => {
	const text = 'a,"b,c","say ""hi""",d\r\n"line\none","two\r\nlines",x\rlast,,\n'
	const parsed = table(text, text.length, ',')
	assert.deepEqual(rows(parsed), [
		['a', 'b,c', 'say "hi"', 'd'],
		['line\none', 'two\r\nlines', 'x'],
		['last', '', ''],
	])
	assert.equal(parsed.columns, 4)
	// Lenient like spreadsheets: text after a closing quote is kept; a quote inside an unquoted value is literal.
	assert.deepEqual(parseRecord('"a"b,c"d', 0, 8, ','), ['ab', 'c"d'])
	// A trailing delimiter is an empty last value; an empty record is one empty value.
	assert.deepEqual(parseRecord('a,', 0, 2, ','), ['a', ''])
	assert.deepEqual(parseRecord('', 0, 0, ','), [''])
})

test('every split of the input gives the same table: across CRLF, inside quotes, and past the detection sample', () => {
	const samples = [
		buildSupportTickets(),
		'a;b\r\n1;"x\r\ny"\r\n2;z\r',
		'one\n"two\n\n"\n\nthree',
		'x,y\r\n"\r\n",2\r\n',
	]
	for (const text of samples) {
		const whole = rows(table(text))
		for (const size of [1, 2, 3, 5, 7, 64, 1000]) assert.deepEqual(rows(table(text, size)), whole, `size ${size}`)
	}
	// Larger than the 64 KiB detection sample, in pieces that split records and CRLFs at random places.
	const big = buildInvoiceExport(1800)
	assert.ok(big.length > 2 * 64 * 1024)
	const whole = table(big)
	assert.equal(whole.rows, 1801)
	assert.equal(whole.delimiter, ',')
	for (const size of [4093, 65_537, 100_003]) {
		const pieces = table(big, size)
		assert.equal(pieces.rows, whole.rows)
		for (const index of [0, 1, 777, 1312, 1800]) assert.deepEqual(pieces.row(index), whole.row(index), `${size}`)
	}
	const czech = buildCzechExport(3000).replace(/^﻿/, '')
	assert.ok(czech.length > 64 * 1024)
	const ref = rows(table(czech))
	assert.equal(ref.length, 3001)
	assert.deepEqual(rows(table(czech, 9973)), ref)
	assert.deepEqual(rows(table(czech, 1)).slice(-3), ref.slice(-3))
})

test('delimiter detection: comma, semicolon, tab, pipe; Excel’s sep= line decides and is hidden', () => {
	assert.equal(detectDelimiter('a,b,c\n1,2,3\n4,5,6\n'), ',')
	assert.equal(detectDelimiter('Částka;Měna\n1 234,50;CZK\n99,90;EUR\n'), ';')
	assert.equal(detectDelimiter('a\tb\n1\t2\n'), '\t')
	assert.equal(detectDelimiter('id|name\n1|x\n2|y\n'), '|')
	// Commas inside quoted values do not count; decimal commas do not beat the semicolons around them.
	assert.equal(detectDelimiter('"Novák, Jan";1,5\n"Lípa, Eva";2,25\n'), ';')
	// One column: comma.
	assert.equal(detectDelimiter('alpha\nbeta\n'), ',')
	assert.equal(detectDelimiter('sep=;\na,b;c\n'), ';')
	assert.equal(detectDelimiter(buildCzechExport(20)), ';')

	const excel = table('sep=;\r\nName;Amount\r\nPsyon;10,5\r\n')
	assert.equal(excel.delimiter, ';')
	assert.equal(excel.sepLine, true)
	assert.deepEqual(rows(excel), [
		['Name', 'Amount'],
		['Psyon', '10,5'],
	])
	const tabs = table('sep=\t\nName\tAmount\n', undefined, null)
	assert.equal(tabs.delimiter, '\t')
	assert.equal(tabs.rows, 1)
	// Only the first line, and only its own delimiter.
	assert.equal(table('a;b\nsep=;\n').rows, 2)
	assert.equal(table('sep=;\n', undefined, ',').sepLine, false)
	// A .tsv is split on tabs even when commas are everywhere.
	assert.deepEqual(table('a,b\tc\n', undefined, '\t').row(0), ['a,b', 'c'])
})

test('header detection: names over numbers, dates or fixed-length codes; never for data-like first rows', () => {
	assert.equal(
		detectHeader([
			['Invoice', 'Amount'],
			['2026-0001', '12.50'],
			['2026-0002', '7'],
		]),
		true,
	)
	assert.equal(
		detectHeader([
			['id', 'code'],
			['1', 'AX12'],
			['2', 'BQ77'],
		]),
		true,
	)
	assert.equal(
		detectHeader([
			['1', '2'],
			['3', '4'],
		]),
		false,
	)
	assert.equal(
		detectHeader([
			['alpha', 'beta'],
			['gamma', 'delta'],
			['epsilon', 'zeta'],
		]),
		false,
	)
	assert.equal(
		detectHeader([
			['name', 'name'],
			['x', '1'],
		]),
		false,
	)
	assert.equal(detectHeader([['Status'], ['Status'], ['Paid']]), false)
	assert.equal(detectHeader([['only row']]), false)
	assert.equal(table(buildInvoiceExport(200)).header, true)
	assert.equal(table(buildCzechExport(20).replace(/^﻿/, '')).header, true)
	assert.equal(table(buildWideSheet(500, 5)).header, true)
	// Decided after 101 records while reading, or at the end for a short file.
	const reading = new CsvTable(',')
	reading.push(buildInvoiceExport(1000))
	assert.equal(reading.header, true)
})

test('numbers: right alignment, unambiguous Sum values, decimal commas only where the delimiter is a semicolon', () => {
	for (const value of ['12', '-3.5', '1 234,50', '2026-10-31', '31. 10. 2026', '21 %', '€ 12.00', '1,234,567'])
		assert.equal(alignRight(value), true, value)
	for (const value of ['Paid', 'FV-2026-0001', '', 'T-1041']) assert.equal(alignRight(value), false, value)
	assert.equal(numericValue('12.5', ','), 12.5)
	assert.equal(numericValue('-3', ','), -3)
	assert.equal(numericValue('1e3', ','), 1000)
	assert.equal(numericValue('12,5', ','), null)
	assert.equal(numericValue('12,5', ';'), 12.5)
	assert.equal(numericValue('1,234', ';'), 1.234)
	assert.equal(numericValue('1 234,50', ';'), null)
	assert.equal(numericValue('1.500', ';'), null)
	assert.equal(numericValue('-12.500', ';'), null)
	assert.equal(numericValue('1.5', ';'), 1.5)
	assert.equal(numericValue('1.500', ','), 1.5)
	assert.equal(numericValue('Paid', ','), null)
})

test('references, TSV values and the grid’s display of a value', () => {
	assert.deepEqual([0, 25, 26, 51, 52, 499, 701, 702, 16383].map(columnName), [
		'A',
		'Z',
		'AA',
		'AZ',
		'BA',
		'SF',
		'ZZ',
		'AAA',
		'XFD',
	])
	assert.equal(rangeRef({ r0: 11, r1: 11, c0: 1, c1: 1 }), 'B12')
	assert.equal(rangeRef({ r0: 1, r1: 8, c0: 0, c1: 3 }), 'A2:D9')
	assert.equal(tsvValue('plain, value'), 'plain, value')
	assert.equal(tsvValue('a\tb'), '"a\tb"')
	assert.equal(tsvValue('say "hi"\nthere'), '"say ""hi""\nthere"')
	assert.equal(displayValue('one\r\ntwo\nthree'), 'one ↵ two ↵ three')
	assert.equal(displayValue('x'.repeat(1500)).length, 1001)
})

// ---- table: rows, cells, copy, stats, search ---------------------------------------------------------------------

test('a table answers rows, cells, ranges as TSV, Count/Sum and search', () => {
	const t = table(buildSupportTickets())
	assert.equal(t.rows, 6)
	assert.equal(t.columns, 6)
	assert.equal(t.header, true)
	assert.deepEqual(t.rowsForDisplay(1, 1)[0]?.slice(0, 2), ['T-1041', '2026-11-02'])
	assert.match(t.rowsForDisplay(1, 1)[0]?.[4] ?? '', /^Hi, ↵ the "Create company"/)
	assert.deepEqual(t.cell(1, 4), {
		value: 'Hi,\nthe "Create company" form forgets the IČO after Save.\nTried twice, same result.\n\nThanks, Petra',
		truncated: false,
	})
	assert.deepEqual(t.cell(1, 40), { value: '', truncated: false })
	assert.deepEqual(t.cell(99, 0), { value: null, truncated: false })
	assert.deepEqual(t.copy({ r0: 2, r1: 3, c0: 0, c1: 2 }), {
		text: 'T-1042\t2026-11-02\tKavárna Lípa\nT-1043\t2026-11-03\tNordic Freight AB',
		cells: 6,
	})
	// Reversed and out-of-bounds ranges are clamped.
	assert.equal(t.copy({ r0: 3, r1: 2, c0: 2, c1: 0 }).cells, 6)
	assert.equal(t.copy({ r0: 5, r1: 50, c0: 5, c1: 50 }).text, 'Normal')
	assert.deepEqual(t.search('IČO'), { matches: [[1, 4]], truncated: false })
	assert.deepEqual(t.search('"21 %"'), { matches: [[5, 4]], truncated: false })
	assert.deepEqual(t.search('nothing here'), { matches: [], truncated: false })
	assert.equal(t.search('').matches.length, 0)

	const czech = table(buildCzechExport(10).replace(/^﻿/, ''))
	const amounts = rows(czech)
		.slice(1)
		.map(row => Number(row[3]?.replace(',', '.')))
	const stats = czech.stats({ r0: 1, r1: 10, c0: 3, c1: 3 })
	assert.equal(stats.count, 10)
	assert.equal(stats.numbers, 10)
	assert.ok(Math.abs(stats.sum - amounts.reduce((a, b) => a + b, 0)) < 1e-6)
	// Text and empty values: counted when present, never summed.
	assert.deepEqual(czech.stats({ r0: 0, r1: 10, c0: 1, c1: 1 }), { count: 11, numbers: 0, sum: 0 })
})

test('caps: copy and stats stop counting past their limits; search stops at 10,000 matches', () => {
	const t = table(buildNumbers(300_000).join(''))
	assert.equal(t.rows, 300_000)
	const copy = t.copy({ r0: 0, r1: 299_999, c0: 0, c1: 0 })
	assert.equal(copy.text, null)
	assert.equal(copy.cells, 300_000)
	assert.equal(t.copy({ r0: 0, r1: 199_999, c0: 0, c1: 0 }).text?.split('\n').length, 200_000)
	const found = t.search('1')
	assert.equal(found.matches.length, 10_000)
	assert.equal(found.truncated, true)
	assert.deepEqual(t.stats({ r0: 0, r1: 9, c0: 0, c1: 0 }), { count: 10, numbers: 10, sum: 45 })
})

test('refusals: more than a million rows, too many columns, NUL bytes, a record past 16M characters', () => {
	const many = new CsvTable(',')
	assert.throws(() => {
		for (const part of buildNumbers(1_000_001)) many.push(part)
		many.finish()
	}, /This file has more than 1,000,000 rows; Helm shows CSV files up to 1,000,000 rows\./)
	assert.ok(many.rows === 1_000_000)
	const exactly = new CsvTable(',')
	for (const part of buildNumbers(1_000_000)) exactly.push(part)
	exactly.finish()
	assert.equal(exactly.rows, 1_000_000)
	assert.deepEqual(exactly.row(999_999), ['999999'])

	assert.throws(
		() => table(`${'x,'.repeat(VIEWER_CSV_COLUMNS)}x\n`),
		/Row 1 has 16,385 columns; Helm shows CSV files up to 16,384 columns\./,
	)
	assert.throws(() => table('a,b\n1,\u00002\n'), CsvRefusal)
	assert.throws(() => table('a,b\n1,\u00002\n'), /NUL bytes/)
	const open = new CsvTable(',')
	assert.throws(() => {
		open.push('a,"')
		const chunk = 'x'.repeat(4 * 1024 * 1024)
		for (let index = 0; index < 5; index++) open.push(chunk)
	}, /Row 1 runs past 16,777,216 characters: a quoted value is probably missing its closing quote\./)
})

test('an unclosed quote at the end keeps the rest as one value and names its row', () => {
	const t = table('Date,Note\n2026-11-01,Call the bank\n2026-11-02,"Ask Petra\nand the address')
	assert.equal(t.rows, 3)
	assert.equal(t.unclosedQuote, 2)
	assert.deepEqual(t.row(2), ['2026-11-02', 'Ask Petra\nand the address'])
	assert.equal(table('a,b\n1,2\n').unclosedQuote, null)
	// An empty file and a file of only line breaks.
	assert.equal(table('').rows, 0)
	assert.deepEqual(rows(table('\n\n')), [[''], ['']])
})

test('the scanner keeps a CR at a segment end pending until the next piece shows whether an LF follows', () => {
	const records: [number, number][] = []
	const scanner = new CsvScanner(',')
	const rest = scanner.scan('a,b\r', 0, (start, end) => records.push([start, end]))
	assert.deepEqual(records, [[0, 3]])
	assert.equal(rest, 4)
	const next: [number, number][] = []
	const rest2 = scanner.scan('\nc,d\n', 0, (start, end) => next.push([start, end]))
	assert.deepEqual(next, [[1, 4]])
	assert.equal(rest2, 5)
})

// ---- admission and token ------------------------------------------------------------------------------------------

async function fixture() {
	const base = await realpath(await mkdtemp('/tmp/hoc-'))
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

test('admission reads only the first bytes: encoding from the BOM, binary files and odd UTF-16 refused, size first', async () => {
	const f = await fixture()
	try {
		const invoices = buildInvoiceExport(200)
		await writeFile(join(f.docs, 'invoices.csv'), invoices)
		const read = await readViewerFile(join(f.docs, 'invoices.csv'), f.paths)
		assert.deepEqual([read.format, read.language, read.text, read.encoding], ['csv', 'csv', '', 'utf-8'])
		assert.equal(read.size, Buffer.byteLength(invoices))

		await writeFile(join(f.docs, 'faktury.csv'), buildCzechExport(5))
		assert.equal((await readViewerFile(join(f.docs, 'faktury.csv'), f.paths)).encoding, 'utf-8-bom')
		await writeFile(join(f.docs, 'events.tsv'), Buffer.from('﻿a\tb\n', 'utf16le'))
		const tsv = await readViewerFile(join(f.docs, 'events.tsv'), f.paths)
		assert.deepEqual([tsv.language, tsv.encoding], ['tsv', 'utf-16le'])
		await writeFile(join(f.docs, 'odd.csv'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('abc')]))
		await assert.rejects(readViewerFile(join(f.docs, 'odd.csv'), f.paths), /odd\.csv is not valid UTF-16 text/)
		// Windows-1250 bytes pass admission (only the start is read); the worker's strict decoder refuses them.
		await writeFile(join(f.docs, 'kontakty.csv'), buildWindows1250())
		assert.equal((await readViewerFile(join(f.docs, 'kontakty.csv'), f.paths)).encoding, 'utf-8')
		await writeFile(join(f.docs, 'export.csv'), Buffer.from('PK\x03\x04\x14\x00rest of a zip'))
		await assert.rejects(
			readViewerFile(join(f.docs, 'export.csv'), f.paths),
			/export\.csv is not a text file \(it starts like a zip/i,
		)
		await writeFile(join(f.docs, 'empty.csv'), '')
		const empty = await readViewerFile(join(f.docs, 'empty.csv'), f.paths)
		assert.equal(empty.size, 0)
		// The size cap is checked before any read.
		const huge = join(f.docs, 'dump.csv')
		await writeFile(huge, 'a,b\n')
		await truncate(huge, VIEWER_CSV_BYTES + 1)
		await assert.rejects(
			readViewerFile(huge, f.paths),
			/dump\.csv is 128(\.0)? MiB; Helm shows CSV files up to 128 MiB/,
		)
	} finally {
		await f.close()
	}
})

test('a CSV window reads its file by range through a token and re-reads a newer version', async () => {
	const f = await fixture()
	const file = join(f.docs, 'invoices.csv')
	const text = buildInvoiceExport(300)
	await writeFile(file, text)
	const tokens = new ViewerFileTokens()
	const observation = new ReviewDocumentObservation(f.docs, file, () => {}, {
		paths: f.paths,
		displayPath: file,
		tokens,
	})
	const ask = (url: string, range?: string) =>
		handleViewerRequest(new Request(url, range ? { headers: { range } } : {}), { tokens, readAsset: async () => null })
	const real = globalThis.fetch
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		ask(String(input), new Headers(init?.headers).get('range') ?? undefined)) as typeof fetch
	try {
		await observation.start()
		const doc = observation.current()
		assert.equal(doc.format, 'csv')
		assert.equal(doc.text, '')
		assert.equal(doc.pdf, undefined)
		const csv = doc.csv
		assert.ok(csv)
		assert.deepEqual([csv.size, csv.kind, csv.encoding], [Buffer.byteLength(text), 'csv', 'utf-8'])
		assert.match(csv.url, /^helm-viewer:\/\/app\/file\/[A-Za-z0-9_-]{43}$/)
		// What the worker does: range reads, a streaming strict decoder, the table.
		const decoder = new TextDecoder('utf-8', { fatal: true })
		const parsed = new CsvTable(null)
		for (let offset = 0; offset < csv.size; offset += 10_000) {
			const read = await readTokenRange(
				csv.url,
				csv.size,
				offset,
				Math.min(csv.size, offset + 10_000),
				new AbortController().signal,
				'The file',
			)
			assert.ok(read.kind === 'bytes')
			parsed.push(decoder.decode(read.bytes, { stream: true }))
		}
		parsed.push(decoder.decode())
		parsed.finish()
		assert.equal(parsed.rows, 301)
		assert.deepEqual(parsed.row(300), table(text).row(300))

		await writeFile(`${file}.tmp`, `${text}2026-9999,Psyon s.r.o.,2026-10-31,2026-11-30,1.00,21,Draft,\n`)
		const { rename } = await import('node:fs/promises')
		await rename(`${file}.tmp`, file)
		await observation.refresh()
		const next = observation.current().csv
		assert.ok(next && next.url !== csv.url && next.size > csv.size)
		assert.equal((await ask(next.url, 'bytes=0-6')).status, 206)
	} finally {
		globalThis.fetch = real
		await observation.dispose()
		await f.close()
	}
})

test('a column keeps its widest sample, not its longest', () => {
	assert.ok(textWeight('FV-2026-0001') > textWeight('Číslo faktury'))
	assert.ok(textWeight('WWWW') > textWeight('iiiiiii'))
	assert.equal(textWeight('\ufeff\u200b'), 0)
	const parsed = table('﻿Číslo faktury;Odběratel\r\nFV-2026-0001;Psyon s.r.o.\r\nFV-2026-0002;Kavárna Lípa\r\n')
	assert.equal(parsed.samples[0], 'FV-2026-0001')
})

test('find matches text that follows a closing quote', () => {
	const t = table('city,zip\n"Praha" 4,110\n"ab"c,"x""y"\n')
	assert.deepEqual(t.row(1), ['Praha 4', '110'])
	assert.deepEqual(t.search('praha 4').matches, [[1, 0]])
	assert.deepEqual(t.search('abc').matches, [[2, 0]])
	assert.deepEqual(t.search('x"y').matches, [[2, 1]])
})

test('a record past the length limit refuses however the file is split', () => {
	const long = `${'a'.repeat(16 * 1024 * 1024 + 1)}\n`
	const before = 'x,y\n'.repeat(900_000)
	for (const text of [long, before + long, before + long.slice(0, -1)])
		for (const size of [1024 * 1024, 4 * 1024 * 1024, text.length])
			assert.throws(
				() => table(text, size, ','),
				/^CsvRefusal: Row [\d,]+ runs past 16,777,216 characters\.$|runs past 16,777,216 characters\.$/,
			)
	const quoted = `a\n"${'q'.repeat(16 * 1024 * 1024 + 1)}"\n`
	for (const size of [1024 * 1024, 4 * 1024 * 1024])
		assert.throws(() => table(quoted, size, ','), /Row 2 runs past 16,777,216 characters/)
})

test('the header answer is given before the header sample is complete', () => {
	const t = new CsvTable(',')
	t.push(
		`id,amount,note\n${Array.from({ length: 80 }, (_, index) => `${index},${index * 3}.50,${'n'.repeat(1000)}`).join('\n')}\n`,
	)
	assert.equal(t.header, false)
	assert.equal(t.headerGuess, true)
	t.finish()
	assert.equal(t.header, true)
	assert.equal(t.headerGuess, true)
})
