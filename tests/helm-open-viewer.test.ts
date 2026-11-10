// S2 of docs/plans/helm-open/spec.md: the format registry, plain admission for code/text/data, the helm-viewer:
// protocol (URL predicate, Range, token table, request handler) and the data model the tree worker runs. All pure
// or temp-file tests; the real Electron session wiring is a canary, never a co-tenant of the desktop.
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, realpath, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import documentModule from '../app/src/document-review/document'
import cspModule from '../app/src/document-review/viewer-csp'
import viewerModule from '../app/src/document-review/viewer-file'
import protocolModule from '../app/src/document-review/viewer-protocol'
import dataModule from '../app/src/renderer/viewer/data-model'
import spanModule from '../app/src/renderer/viewer/text-span'
import {
	VIEWER_TEXT_BYTES,
	VIEWER_TEXT_LINES,
	binarySignature,
	detectViewerFormat,
	sizeText,
	textEncoding,
	textShape,
} from '../src/document-review/formats.js'

const { helmPrivatePaths, pinnedViewerSource, readViewerFile } = viewerModule
const { VIEWER_CSP, VIEWER_FILE_CSP } = cspModule
const {
	handleViewerRequest,
	parseRange,
	VIEWER_INDEX_URL,
	VIEWER_RANGE_CAP,
	ViewerFileTokens,
	ViewerSourceChanged,
	viewerFileUrl,
	viewerRequestAllowed,
} = protocolModule
const { copyJson, flatten, nodeAt, parseData, search, kindOf } = dataModule
const { ReviewDocumentObservation } = documentModule
const { changedSpan } = spanModule

// ---- format registry ---------------------------------------------------------------------------------------------

test('the last extension decides the family; compound archives, unknown and later formats refuse with a reason', () => {
	const shown: Record<string, [string, string]> = {
		'card.tsx': ['code', 'tsx'],
		'foo.test.tsx': ['code', 'tsx'],
		'jquery.min.js': ['code', 'javascript'],
		'main.rs': ['code', 'rust'],
		Dockerfile: ['code', 'dockerfile'],
		Makefile: ['code', 'plain'],
		'.env.local': ['code', 'properties'],
		'server.log': ['text', 'plain'],
		LICENSE: ['text', 'plain'],
		'notes.md': ['markdown', 'markdown'],
		'issue.JSON': ['data', 'json'],
		'events.ndjson': ['data', 'jsonl'],
		'config.yml': ['data', 'yaml'],
		'Cargo.toml': ['data', 'toml'],
	}
	for (const [name, [format, language]] of Object.entries(shown)) {
		const detected = detectViewerFormat(name)
		assert.ok(detected.ok, name)
		assert.equal(detected.entry.format, format, name)
		assert.equal(detected.language, language, name)
	}
	const refused: Record<string, RegExp> = {
		'backup.tar.gz': /backup\.tar\.gz is an archive; Helm doesn't open archives\./,
		'site.tgz': /is an archive/,
		'bundle.zip': /is an archive/,
		'report.final.pdf': /Helm can't show PDFs yet \(report\.final\.pdf\)/,
		'export.csv': /Helm can't show CSV files yet/,
		'photo.heic': /HEIC images yet/,
		'thing.weird': /Helm can't show \.weird files \(thing\.weird\)\./,
		'README-no-dot': /it has no file extension/,
	}
	for (const [name, reason] of Object.entries(refused)) {
		const detected = detectViewerFormat(name)
		assert.equal(detected.ok, false, name)
		if (!detected.ok) assert.match(detected.reason, reason, name)
	}
})

test('magic bytes, byte order marks and line shapes', () => {
	assert.equal(textEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'utf-8-bom')
	assert.equal(textEncoding(new Uint8Array([0xff, 0xfe, 0x61, 0])), 'utf-16le')
	assert.equal(textEncoding(new Uint8Array([0xfe, 0xff, 0, 0x61])), 'utf-16be')
	assert.equal(textEncoding(new Uint8Array([0x61, 0x62])), 'utf-8')
	assert.match(binarySignature(Buffer.from('%PDF-1.7\n')) ?? '', /PDF/)
	assert.match(binarySignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ?? '', /PNG/)
	assert.match(binarySignature(Buffer.from('PK\x03\x04rest')) ?? '', /zip/i)
	assert.equal(binarySignature(Buffer.from('plain words')), null)
	// Lines as the editor counts them: a final newline starts an empty last line.
	assert.deepEqual(textShape('a\nb\n'), { lines: 3, ending: 'LF' })
	assert.deepEqual(textShape('a\r\nb'), { lines: 2, ending: 'CRLF' })
	assert.deepEqual(textShape('a\nb\r\n'), { lines: 3, ending: 'mixed' })
	assert.deepEqual(textShape('one'), { lines: 1, ending: 'none' })
	assert.equal(sizeText(16 * 1024 * 1024), '16 MiB')
})

// ---- plain admission for code, text and data ---------------------------------------------------------------------

async function fixture() {
	const base = await realpath(await mkdtemp('/tmp/hov-'))
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
	return { docs, paths, close: () => rm(base, { recursive: true, force: true }) }
}

test('code, text and data are admitted with language, encoding and shape; binary and bad text refuse', async () => {
	const f = await fixture()
	try {
		await writeFile(join(f.docs, 'app.ts'), 'export const a = 1\r\nexport const b = 2\r\n')
		const code = await readViewerFile(join(f.docs, 'app.ts'), f.paths)
		assert.deepEqual(
			[code.format, code.language, code.encoding, code.lines, code.ending],
			['code', 'typescript', 'utf-8', 3, 'CRLF'],
		)
		const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ahoj\nsvěte\n', 'utf16le')])
		await writeFile(join(f.docs, 'win.txt'), utf16)
		const text = await readViewerFile(join(f.docs, 'win.txt'), f.paths)
		assert.equal(text.encoding, 'utf-16le')
		assert.equal(text.text.replace(/^﻿/, ''), 'ahoj\nsvěte\n')
		await writeFile(join(f.docs, 'odd.txt'), Buffer.from([0xff, 0xfe, 0x61]))
		await assert.rejects(readViewerFile(join(f.docs, 'odd.txt'), f.paths), /odd\.txt is not valid UTF-16 text/)
		await writeFile(join(f.docs, 'fake.txt'), '%PDF-1.4\nstuff')
		await assert.rejects(
			readViewerFile(join(f.docs, 'fake.txt'), f.paths),
			/fake\.txt is not a text file \(it starts like/,
		)
		await writeFile(join(f.docs, 'nul.log'), 'a\u0000b')
		await assert.rejects(readViewerFile(join(f.docs, 'nul.log'), f.paths), /contains NUL bytes/)
		await writeFile(join(f.docs, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
		await assert.rejects(
			readViewerFile(join(f.docs, 'latin.txt'), f.paths),
			/not valid UTF-8 text; Helm shows UTF-8 and UTF-16/,
		)
		await writeFile(join(f.docs, 'issue.json'), '{"a":[1,2]}')
		const data = await readViewerFile(join(f.docs, 'issue.json'), f.paths)
		assert.deepEqual([data.format, data.language], ['data', 'json'])
	} finally {
		await f.close()
	}
})

test('text limits: 16 MiB by size before reading, 1 M lines after decoding, both named in the refusal', async () => {
	const f = await fixture()
	try {
		const big = join(f.docs, 'huge.log')
		await writeFile(big, '')
		await truncate(big, VIEWER_TEXT_BYTES + 1)
		await assert.rejects(readViewerFile(big, f.paths), /huge\.log is 16(\.0)? MiB; Helm shows .* up to 16 MiB\./)
		await writeFile(join(f.docs, 'tall.txt'), '\n'.repeat(VIEWER_TEXT_LINES + 1))
		await assert.rejects(
			readViewerFile(join(f.docs, 'tall.txt'), f.paths),
			/tall\.txt has 1,000,00[12] lines; Helm shows .* up to 1,000,000 lines\./,
		)
		await writeFile(join(f.docs, 'fits.txt'), '\n'.repeat(VIEWER_TEXT_LINES - 1))
		assert.equal((await readViewerFile(join(f.docs, 'fits.txt'), f.paths)).format, 'text')
	} finally {
		await f.close()
	}
})

test('a pinned source serves the admitted bytes and answers changed once the file is rewritten in place', async () => {
	const f = await fixture()
	try {
		const file = join(f.docs, 'main.go')
		await writeFile(file, 'package main\n')
		const read = await readViewerFile(file, f.paths, {}, { pin: true })
		assert.ok(read.handle && read.identity)
		const source = pinnedViewerSource(read.handle, read.identity, read.size)
		assert.equal(Buffer.from(await source.read(0, 7)).toString(), 'package')
		await assert.rejects(source.read(10, 10), RangeError)
		await appendFile(file, 'func main() {}\n')
		await assert.rejects(source.read(0, 7), ViewerSourceChanged)
		await source.close()
		await assert.rejects(source.read(0, 1), ViewerSourceChanged)
	} finally {
		await f.close()
	}
})

// ---- helm-viewer: protocol -----------------------------------------------------------------------------------------

test('only the viewer origin, blob: and data: may load; every other scheme and host is cancelled', () => {
	for (const url of [
		'helm-viewer://app/index.html',
		'helm-viewer://app/assets/x.js',
		'blob:helm-viewer://app/1',
		'data:text/plain,hi',
	])
		assert.equal(viewerRequestAllowed(url), true, url)
	for (const url of [
		'https://example.com/',
		'http://127.0.0.1:7474/api',
		'ws://localhost/',
		'file:///etc/passwd',
		'helm-viewer://other/index.html',
		'helm-viewer://user:pw@app/index.html',
		'ftp://x/',
		'chrome://settings',
		'not a url',
	])
		assert.equal(viewerRequestAllowed(url), false, url)
})

test('Range parsing: suffix, open and bounded ranges, 416 past the end, clamping and the response cap', () => {
	assert.deepEqual(parseRange(null, 100), { kind: 'full' })
	assert.deepEqual(parseRange('bytes=0-9', 100), { kind: 'partial', start: 0, end: 9 })
	assert.deepEqual(parseRange('bytes=90-', 100), { kind: 'partial', start: 90, end: 99 })
	assert.deepEqual(parseRange('bytes=-10', 100), { kind: 'partial', start: 90, end: 99 })
	assert.deepEqual(parseRange('bytes=-500', 100), { kind: 'partial', start: 0, end: 99 })
	assert.deepEqual(parseRange('bytes=50-5000', 100), { kind: 'partial', start: 50, end: 99 })
	assert.deepEqual(parseRange('bytes=100-', 100), { kind: 'unsatisfiable' })
	assert.deepEqual(parseRange('bytes=-0', 100), { kind: 'unsatisfiable' })
	assert.deepEqual(parseRange('bytes=0-', 0), { kind: 'unsatisfiable' })
	assert.deepEqual(parseRange('bytes=9-1', 100), { kind: 'full' })
	assert.deepEqual(parseRange('bytes=0-1,5-6', 100), { kind: 'full' })
	assert.deepEqual(parseRange('items=0-1', 100), { kind: 'full' })
	assert.deepEqual(parseRange('bytes=1234567890123456-', 100), { kind: 'unsatisfiable' })
	assert.deepEqual(parseRange('bytes=0-', 10, 4), { kind: 'partial', start: 0, end: 3 })
})

function memorySource(text: string, closes: { count: number }, changed = false) {
	const bytes = Buffer.from(text)
	return {
		size: bytes.length,
		async read(offset: number, length: number) {
			if (changed) throw new ViewerSourceChanged('changed')
			return bytes.subarray(offset, offset + length)
		},
		close() {
			closes.count++
		},
	}
}

test('file tokens: 256-bit, bounded, revoked at once, descriptors closed after the last read in flight', async () => {
	const tokens = new ViewerFileTokens()
	const closes = { count: 0 }
	const token = tokens.issue(memorySource('hello', closes))
	assert.match(token, /^[A-Za-z0-9_-]{43}$/)
	assert.equal(tokens.has(token), true)
	let release!: () => void
	const held = tokens.read(token, async () => {
		await new Promise<void>(resolve => {
			release = resolve
		})
		return new Response('ok')
	})
	await tokens.revoke(token)
	assert.equal(tokens.has(token), false)
	assert.equal(await tokens.read(token, async () => new Response('late')), null)
	assert.equal(closes.count, 0, 'still being read')
	release()
	assert.equal(await (await held)?.text(), 'ok')
	assert.equal(closes.count, 1)
	for (let index = 0; index < ViewerFileTokens.LIMIT; index++) tokens.issue(memorySource('x', closes))
	assert.throws(() => tokens.issue(memorySource('x', closes)), /Too many open file tokens/)
	assert.equal(closes.count, 2, 'a refused source is closed')
	await tokens.revokeAll()
	assert.equal(tokens.size, 0)
	assert.throws(() => tokens.issue(memorySource('x', closes)), /closed/)
	assert.equal(closes.count, 2 + ViewerFileTokens.LIMIT + 1)
})

test('the handler serves the page and assets with the CSP header, file bytes inert, and refuses everything else', async () => {
	const assets: Record<string, string> = {
		'index.html': '<!doctype html><script type="module" src="assets/document-review.js"></script>',
		'assets/document-review.js': 'export {}',
		'assets/data-worker.js': 'self.onmessage = null',
		'assets/document-review.css': 'body{}',
	}
	const tokens = new ViewerFileTokens()
	const closes = { count: 0 }
	const token = tokens.issue(memorySource('0123456789', closes))
	const stale = tokens.issue(memorySource('abc', closes, true))
	const deps = {
		tokens,
		readAsset: async (path: string) => (path in assets ? Buffer.from(assets[path] as string) : null),
	}
	const ask = (url: string, init: RequestInit = {}) => handleViewerRequest(new Request(url, init), deps)

	for (const [url, mime] of [
		[VIEWER_INDEX_URL, 'text/html; charset=utf-8'],
		['helm-viewer://app/', 'text/html; charset=utf-8'],
		['helm-viewer://app/assets/document-review.js', 'text/javascript; charset=utf-8'],
		// Workers take their CSP from their own response, so the worker script carries it too.
		['helm-viewer://app/assets/data-worker.js', 'text/javascript; charset=utf-8'],
		['helm-viewer://app/assets/document-review.css', 'text/css; charset=utf-8'],
	] as const) {
		const response = await ask(url)
		assert.equal(response.status, 200, url)
		assert.equal(response.headers.get('content-type'), mime, url)
		assert.equal(response.headers.get('content-security-policy'), VIEWER_CSP, url)
		assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
		assert.equal(response.headers.get('cache-control'), 'no-store')
	}
	assert.match(VIEWER_CSP, /default-src 'none'/)
	assert.match(VIEWER_CSP, /connect-src 'self'/)
	assert.doesNotMatch(VIEWER_CSP, /(^|[\s;])'unsafe-eval'|https?:|\*/)

	const file = await ask(viewerFileUrl(token))
	assert.equal(file.status, 200)
	assert.equal(await file.text(), '0123456789')
	assert.equal(file.headers.get('content-type'), 'application/octet-stream')
	assert.equal(file.headers.get('content-security-policy'), VIEWER_FILE_CSP)
	assert.equal(file.headers.get('accept-ranges'), 'bytes')
	const part = await ask(viewerFileUrl(token), { headers: { Range: 'bytes=2-4' } })
	assert.equal(part.status, 206)
	assert.equal(part.headers.get('content-range'), 'bytes 2-4/10')
	assert.equal(await part.text(), '234')
	const past = await ask(viewerFileUrl(token), { headers: { Range: 'bytes=10-' } })
	assert.equal(past.status, 416)
	assert.equal(past.headers.get('content-range'), 'bytes */10')
	const head = await ask(viewerFileUrl(token), { method: 'HEAD' })
	assert.equal(head.status, 200)
	assert.equal(head.headers.get('content-length'), '10')
	assert.equal((await ask(viewerFileUrl(stale))).status, 409)

	assert.equal((await ask(viewerFileUrl(token), { method: 'POST', body: 'x' })).status, 405)
	assert.equal((await ask(viewerFileUrl('A'.repeat(43)))).status, 404)
	assert.equal((await ask('helm-viewer://app/file/short')).status, 404)
	assert.equal((await ask('helm-viewer://other/index.html')).status, 404)
	// The URL parser resolves dot segments before the handler sees them: this is just the page.
	assert.equal((await ask('helm-viewer://app/assets/../index.html')).status, 200)
	assert.equal((await ask('helm-viewer://app/assets/..%2findex.html')).status, 404)
	assert.equal((await ask('helm-viewer://app/assets/%2e%2e/secret.js')).status, 404)
	assert.equal((await ask('helm-viewer://app/assets/missing.js')).status, 404)
	assert.equal((await ask('helm-viewer://app/assets/tool.exe')).status, 404)
	assert.equal((await ask('helm-viewer://app/etc/passwd')).status, 404)
	await tokens.revoke(token)
	assert.equal((await ask(viewerFileUrl(token))).status, 404)
	assert.ok(VIEWER_RANGE_CAP >= 32 * 1024 * 1024)
})

// ---- data model (runs in the tree worker) --------------------------------------------------------------------------

test('data parses JSON, JSON Lines with bad lines, YAML documents and TOML big integers; errors are one line', () => {
	assert.deepEqual(parseData('{"a":1}', 'json'), { root: { a: 1 }, error: null })
	assert.match(parseData('{"a":', 'json').error ?? '', /\S/)
	assert.doesNotMatch(parseData('{"a":', 'json').error ?? '', /\n/)
	const lines = parseData('{"a":1}\n\nnot json\n[2]\n', 'jsonl')
	assert.equal(kindOf(lines.root), 'records')
	const rows = flatten(lines.root, new Set(['']))
	assert.deepEqual(
		rows.rows.map(row => [row.key, row.kind]),
		[
			['', 'records'],
			['Line 1', 'object'],
			['Line 3', 'invalid'],
			['Line 4', 'array'],
		],
	)
	const yaml = parseData('a: 1\n---\nb: [x, y]\n', 'yaml')
	assert.equal(kindOf(yaml.root), 'documents')
	assert.equal(parseData('a: [1\n', 'yaml').error !== null, true)
	const bomb = ['a: &a [x, x, x, x, x, x, x, x, x, x]']
	for (let level = 1; level < 9; level++)
		bomb.push(
			`${String.fromCharCode(97 + level)}: &${String.fromCharCode(97 + level)} [${Array(10)
				.fill(`*${String.fromCharCode(96 + level)}`)
				.join(', ')}]`,
		)
	assert.match(parseData(bomb.join('\n'), 'yaml').error ?? '', /alias|resource|count/i)
	const toml = parseData('id = 12345678901234567890\nname = "x"\n', 'toml')
	assert.equal(toml.error, null)
	assert.equal(typeof (toml.root as Record<string, unknown>).id, 'bigint')
	assert.match(copyJson(toml.root) ?? '', /"id": 12345678901234567890/)
})

test('tree rows cap children per node with a more row, search finds keys and values, pointers are own keys only', () => {
	const root = { items: Array.from({ length: 25 }, (_, index) => ({ id: index })), 'a/b': { '~x': 'needle' }, n: null }
	const rows = flatten(root, new Set(['', '/items']), 10).rows
	const more = rows.find(row => row.kind === 'more')
	assert.equal(more?.hidden, 15)
	assert.equal(rows.filter(row => row.depth === 2 && row.kind !== 'more').length, 10)
	assert.deepEqual(search(root, 'NEEDLE').matches, ['/a~1b/~0x'])
	assert.deepEqual(search(root, 'a/b').matches, ['/a~1b'])
	assert.deepEqual(nodeAt(root, '/a~1b/~0x'), { value: 'needle' })
	assert.equal(nodeAt(root, '/items/25'), undefined)
	assert.equal(nodeAt(root, '/items/01'), undefined)
	assert.equal(nodeAt({}, '/constructor'), undefined)
	assert.equal(nodeAt({}, '/__proto__'), undefined)
	assert.equal(flatten(root, new Set(['', '/items']), 10, 5).truncated, true)
	assert.equal(copyJson('x'.repeat(100), 50), null)
})

// ---- review fixes ----------------------------------------------------------------------------------------------

test('names that are Object.prototype keys refuse like any extension-less name instead of throwing', () => {
	for (const name of ['constructor', 'Constructor', '__proto__', 'toString', 'hasOwnProperty']) {
		const detected = detectViewerFormat(name)
		assert.equal(detected.ok, false, name)
	}
	assert.equal(detectViewerFormat('Makefile').ok, true)
})

test("the daemon's profile registry is private like its config and database", async () => {
	const f = await fixture()
	try {
		const daemon = f.paths.daemonRoots[0] as string
		await writeFile(join(daemon, 'profiles.json'), '{"active":"work"}')
		await assert.rejects(readViewerFile(join(daemon, 'profiles.json'), f.paths), /private files/)
		await writeFile(join(f.docs, 'profiles.json'), '{}')
		assert.equal((await readViewerFile(join(f.docs, 'profiles.json'), f.paths)).format, 'data')
	} finally {
		await f.close()
	}
})

test('touching a viewed file without changing its bytes replaces the dead token', async () => {
	const f = await fixture()
	const file = join(f.docs, 'a.go')
	await writeFile(file, 'package main\n')
	const tokens = new ViewerFileTokens()
	let changes = 0
	const observation = new ReviewDocumentObservation(f.docs, file, () => changes++, {
		paths: f.paths,
		displayPath: file,
		tokens,
	})
	try {
		await observation.start()
		const first = observation.current().viewer?.url as string
		const ask = (url: string) => handleViewerRequest(new Request(url), { tokens, readAsset: async () => null })
		assert.equal((await ask(first)).status, 200)
		const later = new Date(Date.now() + 5000)
		await utimes(file, later, later)
		await observation.refresh()
		const second = observation.current().viewer?.url as string
		assert.notEqual(second, first)
		assert.equal((await ask(second)).status, 200)
		assert.equal(await (await ask(second)).text(), 'package main\n')
		assert.equal((await ask(first)).status, 404)
		const published = changes
		// Nothing moved: no new token, nothing published.
		await observation.refresh()
		assert.equal(observation.current().viewer?.url, second)
		assert.equal(changes, published)
	} finally {
		await observation.dispose()
		await f.close()
	}
})

test('YAML ordered maps, sets and binary show their contents; integers past 2^53 keep their digits everywhere', () => {
	const yaml = parseData(
		'o: !!omap\n  - a: 1\n  - b: 2\ns: !!set\n  ? x\nbin: !!binary aGVsbG8=\nbig: 12345678901234567890\nsmall: 5\n',
		'yaml',
	)
	assert.equal(yaml.error, null)
	const root = yaml.root as Record<string, unknown>
	assert.deepEqual(root.o, { a: 1, b: 2 })
	assert.deepEqual(root.s, ['x'])
	assert.equal(root.bin, 'aGVsbG8=')
	assert.equal(root.small, 5)
	assert.equal(typeof root.big, 'bigint')
	assert.match(copyJson(root) ?? '', /"big": 12345678901234567890/)
	const json = parseData('{"id": 12345678901234567890, "n": 1.5, "e": 1e300, "s": 9007199254740993}', 'json')
	const record = json.root as Record<string, unknown>
	assert.equal(record.id, 12345678901234567890n)
	assert.equal(record.s, 9007199254740993n)
	assert.equal(record.n, 1.5)
	assert.equal(record.e, 1e300)
	assert.match(copyJson(record) ?? '', /"id": 12345678901234567890/)
	const lines = parseData('{"id": 12345678901234567890}\n', 'jsonl')
	assert.match(copyJson(lines.root) ?? '', /12345678901234567890/)
	assert.deepEqual(parseData('{"__proto__": {"x": 1}}', 'json').root, JSON.parse('{"__proto__": {"x": 1}}'))
})

test('live reload replaces only the changed span, never splitting a surrogate pair', () => {
	assert.deepEqual(changedSpan('a\nb\nc\n', 'a\nB\nc\n'), { from: 2, to: 3, insert: 'B' })
	assert.deepEqual(changedSpan('log\n', 'log\nmore\n'), { from: 4, to: 4, insert: 'more\n' })
	assert.deepEqual(changedSpan('same', 'same'), { from: 4, to: 4, insert: '' })
	const before = 'x\u{1F600}y'
	const after = 'x\u{1F601}y'
	const span = changedSpan(before, after)
	assert.equal(before.slice(0, span.from) + span.insert + before.slice(span.to), after)
	assert.equal(span.from, 1)
	assert.equal(span.to, 3)
})
