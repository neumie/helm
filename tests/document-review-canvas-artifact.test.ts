import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { link, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import artifact from '../app/src/document-review/canvas-artifact.js'
import type { CanvasReviewEntry, CanvasReviewThread } from '../src/document-review/canvas-types.js'
const { parseReviewArtifact, appendReviewArtifact } = artifact
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const thread = (): CanvasReviewThread => ({
	id: randomUUID(),
	instruction: 'Explain this',
	intent: 'discuss',
	passage: null,
	fields: [],
	provider: 'pi',
	name: 'Original conversation',
	state: 'unconfirmed',
})
const record = (entry: unknown, jsx = false) =>
	`\n${jsx ? '/*' : '<!--'} helm-review:v1 ${Buffer.from(JSON.stringify(entry)).toString('base64url')} ${jsx ? '*/' : '-->'}`
async function fixture(run: (root: string, file: string) => Promise<void>, extension = 'md') {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'hr-artifact-')))
	const file = join(root, `document.${extension}`)
	try {
		await run(root, file)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}
test('plain source and portable journals preserve BOM, CRLF, CR and no-final-newline bytes', async () => {
	for (const extension of ['md', 'jsx', 'tsx'])
		await fixture(async (root, file) => {
			const body = '\ufeff# Heading\r\n\rparagraph\n末尾'
			await writeFile(file, body)
			const format = extension === 'md' ? 'markdown' : 'jsx'
			assert.equal(parseReviewArtifact(body, format).body, body)
			const start = thread()
			const first = await appendReviewArtifact(root, file, [{ version: 1, type: 'thread', thread: start }], {
				expectedSourceRevision: hash(body),
				current: () => true,
			})
			assert.equal(first.body, body)
			assert.equal(first.archive.threads[0]?.state, 'unconfirmed')
			const second = await appendReviewArtifact(
				root,
				file,
				[{ version: 1, type: 'settle', id: start.id, state: 'complete', reply: '回答' }],
				{ expectedSourceRevision: hash(body), expectedArchiveRevision: first.archive.revision, current: () => true },
			)
			const raw = await readFile(file, 'utf8')
			assert.ok(Buffer.from(raw).subarray(0, Buffer.byteLength(body)).equals(Buffer.from(body)))
			assert.equal(second.archive.revision, hash(raw))
			assert.equal(second.archive.threads[0]?.reply, '回答')
			assert.deepEqual(parseReviewArtifact(raw, format), second)
		}, extension)
})
test('unspecified CLI caller evidence round-trips without inventing a provider or changing journal markers', async () =>
	fixture(async (root, file) => {
		const body = '# Specification\n\nKeep the source intact.\n'
		await writeFile(file, body)
		const start: CanvasReviewThread = { ...thread(), provider: 'cli', name: 'Document conversation' }
		await appendReviewArtifact(root, file, [{ version: 1, type: 'thread', thread: start }], {
			expectedSourceRevision: hash(body),
			current: () => true,
		})
		await appendReviewArtifact(
			root,
			file,
			[{ version: 1, type: 'settle', id: start.id, state: 'complete', reply: 'Refined.' }],
			{
				expectedSourceRevision: hash(body),
				current: () => true,
			},
		)
		const raw = await readFile(file, 'utf8')
		assert.match(raw, /helm-review:v1/)
		const parsed = parseReviewArtifact(raw, 'markdown')
		assert.equal(parsed.body, body)
		assert.deepEqual(parsed.archive.threads, [{ ...start, state: 'complete', reply: 'Refined.', detail: undefined }])
	}))

test('marker examples elsewhere remain source; malformed trailing records fail closed', () => {
	for (const body of [
		'prose <!-- helm-review:v1 example -->',
		'\n<!-- helm-review:v1 example -->\nordinary text',
		'```\n<!-- helm-review:v1 example -->\n```',
		'const x = "/* helm-review:v1 example */";',
		'\n<!-- helm-review:v1 example -->\nordinary\n<!-- unrelated -->',
	])
		assert.equal(parseReviewArtifact(body, 'markdown').body, body)
	for (const suffix of [
		'\n<!-- helm-review:v1 ',
		'\n<!-- helm-review:v1 abc\npartial',
		'\n<!-- helm-review:v2 abc -->',
		'\n<!-- helm-review:v1 e30= -->',
		record({ version: 1, type: 'annotations', annotations: [], owner: 'private' }),
		'\n<!-- helm-review:v1 _w -->',
	])
		assert.throws(() => parseReviewArtifact(`body${suffix}`, 'markdown'))
})
test('strict schemas and immutable thread/settlement history reject forged or inconsistent evidence', () => {
	const start = thread()
	const raw = record({ version: 1, type: 'thread', thread: start })
	assert.throws(() =>
		parseReviewArtifact(record({ version: 1, type: 'settle', id: start.id, state: 'complete' }), 'markdown'),
	)
	assert.throws(() =>
		parseReviewArtifact(
			raw + record({ version: 1, type: 'thread', thread: { ...start, instruction: 'different' } }),
			'markdown',
		),
	)
	const settled = raw + record({ version: 1, type: 'settle', id: start.id, state: 'complete', reply: 'done' })
	assert.equal(
		parseReviewArtifact(
			settled + record({ version: 1, type: 'settle', id: start.id, state: 'complete', reply: 'done' }),
			'markdown',
		).archive.threads.length,
		1,
	)
	assert.throws(() =>
		parseReviewArtifact(settled + record({ version: 1, type: 'settle', id: start.id, state: 'complete' }), 'markdown'),
	)
	assert.throws(() =>
		parseReviewArtifact(
			settled + record({ version: 1, type: 'settle', id: start.id, state: 'error', reply: 'changed' }),
			'markdown',
		),
	)
	assert.throws(() =>
		parseReviewArtifact(
			record({
				version: 1,
				type: 'thread',
				thread: { ...start, fields: [{ id: 'secret', value: 'x', password: true }] },
			}),
			'markdown',
		),
	)
})
test('annotation snapshots retain legacy IDs and exact stale passages with optimistic revision refusal', async () =>
	fixture(async (root, file) => {
		const body = 'original source'
		await writeFile(file, body)
		const annotations = [
			{
				id: 'legacy-note-7',
				passage: { revision: hash('older'), start: 0, end: 5, source: 'older', quote: 'older', kind: 'exact' as const },
				note: 'Keep me',
				intent: 'change' as const,
				resolved: false,
			},
		]
		const first = await appendReviewArtifact(root, file, [{ version: 1, type: 'annotations', annotations }], {
			expectedSourceRevision: hash(body),
			expectedArchiveRevision: hash(body),
			current: () => true,
		})
		assert.deepEqual(first.archive.annotations, annotations)
		await assert.rejects(
			appendReviewArtifact(root, file, [{ version: 1, type: 'annotations', annotations: [] }], {
				expectedSourceRevision: hash(body),
				expectedArchiveRevision: hash(body),
				current: () => true,
			}),
			/changed/,
		)
		assert.deepEqual(parseReviewArtifact(await readFile(file, 'utf8'), 'markdown').archive.annotations, annotations)
	}))
test('serialized writers retain both independent threads; same optimistic version has one winner', async () =>
	fixture(async (root, file) => {
		const body = 'body'
		await writeFile(file, body)
		const entries = [thread(), thread()].map(
			value => [{ version: 1, type: 'thread', thread: value }] as CanvasReviewEntry[],
		)
		await Promise.all(
			entries.map(value =>
				appendReviewArtifact(root, file, value, { expectedSourceRevision: hash(body), current: () => true }),
			),
		)
		assert.equal(parseReviewArtifact(await readFile(file, 'utf8'), 'markdown').archive.threads.length, 2)
		const revision = hash(await readFile(file, 'utf8'))
		const results = await Promise.allSettled(
			entries.map(() =>
				appendReviewArtifact(root, file, [{ version: 1, type: 'annotations', annotations: [] }], {
					expectedSourceRevision: hash(body),
					expectedArchiveRevision: revision,
					current: () => true,
				}),
			),
		)
		assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
	}))
test('lifecycle refusal before and across awaited IO leaves source untouched and drains writer gates', async () =>
	fixture(async (root, file) => {
		const body = 'body'
		await writeFile(file, body)
		for (const boundary of [1, 3, 8, 14, 20]) {
			let calls = 0
			await assert.rejects(
				appendReviewArtifact(root, file, [{ version: 1, type: 'thread', thread: thread() }], {
					expectedSourceRevision: hash(body),
					current: () => ++calls < boundary,
				}),
			)
			assert.equal(await readFile(file, 'utf8'), body)
		}
		await appendReviewArtifact(root, file, [], { expectedSourceRevision: hash(body), current: () => true })
	}))
test('no-follow, single-link, canonical parent, source edits and descriptor substitution refuse writes', async () =>
	fixture(async (root, file) => {
		const body = 'body'
		const original = join(root, 'original.md')
		await writeFile(original, body)
		await symlink(original, file)
		const append = () =>
			appendReviewArtifact(root, file, [], { expectedSourceRevision: hash(body), current: () => true })
		await assert.rejects(append())
		await rm(file)
		await link(original, file)
		await assert.rejects(append())
		await rm(file)
		await writeFile(file, 'edited')
		await assert.rejects(append(), /changed/)
		await writeFile(file, body)
		let calls = 0
		let substitution: Promise<void> | null = null
		await assert.rejects(
			appendReviewArtifact(root, file, [{ version: 1, type: 'thread', thread: thread() }], {
				expectedSourceRevision: hash(body),
				current: () => {
					if (++calls === 9)
						substitution = rename(file, join(root, 'retired.md')).then(() => writeFile(file, 'replacement'))
					return true
				},
			}),
		)
		await substitution
		assert.equal(await readFile(file, 'utf8'), 'replacement')
		assert.equal(await readFile(join(root, 'retired.md'), 'utf8'), body)
	}))
test('byte/count/field limits reject without truncation; genuine Unicode replies fit their unit allowance', async () =>
	fixture(async (root, file) => {
		const body = 'body'
		await writeFile(file, body)
		const start = thread()
		const large = '界'.repeat(64000)
		await appendReviewArtifact(
			root,
			file,
			[
				{ version: 1, type: 'thread', thread: start },
				{ version: 1, type: 'settle', id: start.id, state: 'complete', reply: large },
			],
			{ expectedSourceRevision: hash(body), current: () => true },
		)
		assert.equal(parseReviewArtifact(await readFile(file, 'utf8'), 'markdown').archive.threads[0]?.reply, large)
		const before = await readFile(file)
		await assert.rejects(
			appendReviewArtifact(
				root,
				file,
				[
					{
						version: 1,
						type: 'thread',
						thread: {
							...thread(),
							fields: Array.from({ length: 5 }, (_, i) => ({ id: String(i), value: 'x'.repeat(4000) })),
						},
					},
				],
				{ expectedSourceRevision: hash(body), current: () => true },
			),
		)
		assert.ok((await readFile(file)).equals(before))
		assert.throws(() => parseReviewArtifact('x'.repeat(512 * 1024 + 1), 'markdown'))
		assert.throws(() =>
			parseReviewArtifact(
				Array.from({ length: 65 }, () => record({ version: 1, type: 'thread', thread: thread() })).join(''),
				'markdown',
			),
		)
		assert.throws(() =>
			parseReviewArtifact(record({ version: 1, type: 'annotations', annotations: [] }).repeat(1025), 'markdown'),
		)
	}))

test('lifecycle loss after append reports uncertainty rather than publishing or repairing', async () =>
	fixture(async (root, file) => {
		const body = 'body'
		await writeFile(file, body)
		await assert.rejects(
			appendReviewArtifact(root, file, [{ version: 1, type: 'thread', thread: thread() }], {
				expectedSourceRevision: hash(body),
				current: () => !readFileSync(file, 'utf8').includes('helm-review:v1'),
			}),
			/may be partial or already saved/,
		)
		const raw = await readFile(file, 'utf8')
		assert.equal(parseReviewArtifact(raw, 'markdown').body, body)
		assert.equal(parseReviewArtifact(raw, 'markdown').archive.threads.length, 1)
		await appendReviewArtifact(root, file, [], { expectedSourceRevision: hash(body), current: () => true })
	}))

test('journal capacity and complete-file capacity refuse append without altering existing bytes', async () =>
	fixture(async (root, file) => {
		const body = 'body'
		await writeFile(file, body)
		const starts = [thread(), thread()]
		await assert.rejects(
			appendReviewArtifact(
				root,
				file,
				starts.flatMap(value => [
					{ version: 1, type: 'thread', thread: value } as CanvasReviewEntry,
					{
						version: 1,
						type: 'settle',
						id: value.id,
						state: 'complete',
						reply: '界'.repeat(64000),
					} as CanvasReviewEntry,
				]),
				{ expectedSourceRevision: hash(body), current: () => true },
			),
		)
		assert.equal(await readFile(file, 'utf8'), body)
		const full = 'x'.repeat(512 * 1024)
		await writeFile(file, full)
		await assert.rejects(
			appendReviewArtifact(root, file, [{ version: 1, type: 'thread', thread: thread() }], {
				expectedSourceRevision: hash(full),
				current: () => true,
			}),
		)
		assert.equal(await readFile(file, 'utf8'), full)
		assert.throws(() =>
			parseReviewArtifact(`${record({ version: 1, type: 'annotations', annotations: [] })}\n\u00a0`, 'markdown'),
		)
		assert.throws(() =>
			parseReviewArtifact(
				`\n<!-- helm-review:v1 ${Buffer.from(' '.repeat(256 * 1024 + 1)).toString('base64url')} -->`,
				'markdown',
			),
		)
	}))

// An editor saving the file adds a final newline (or CRLF, blank lines, stray spaces)
// after the journal. That whitespace is neither source nor corruption.
const tails = ['\n', '\n\n', '\r\n', '\r\n\r\n', '  ', '\t', ' \t\n  \n\t', '\n\n\n\n']
test('whitespace after the journal opens with the same body, source revision and history', () => {
	for (const jsx of [false, true]) {
		const format = jsx ? 'jsx' : 'markdown'
		const start = thread()
		const body = jsx ? 'export default () => <p>hi</p>\n' : '# Spec\n\nText.\n'
		const exact =
			body +
			record({ version: 1, type: 'thread', thread: start }, jsx) +
			record({ version: 1, type: 'settle', id: start.id, state: 'complete', reply: 'ok' }, jsx)
		const expected = parseReviewArtifact(exact, format)
		assert.equal(expected.body, body)
		for (const tail of tails) {
			const parsed = parseReviewArtifact(exact + tail, format)
			assert.equal(parsed.body, body, JSON.stringify(tail))
			assert.deepEqual(parsed.archive.threads, expected.archive.threads)
			assert.equal(parsed.archive.revision, hash(exact + tail))
		}
	}
	// Without a journal, trailing whitespace is ordinary source and stays in the body.
	for (const body of ['# Spec\n', '# Spec\r\n\r\n', 'text  \t', '\n<!-- helm-review:v1 example -->\nordinary text\n'])
		assert.equal(parseReviewArtifact(body, 'markdown').body, body)
})
test('CRLF rewriting of the journal keeps the source revision; an unrewritten journal parses exactly as before', () => {
	const start = thread()
	const a = record({ version: 1, type: 'thread', thread: start })
	const b = record({ version: 1, type: 'settle', id: start.id, state: 'complete', reply: 'ok' })
	const body = '# Spec\r\n\r\nText.\r\n'
	const lf = parseReviewArtifact(body + a + b, 'markdown')
	assert.equal(lf.body, body)
	const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n')
	for (const tail of ['', '\r\n', '\r\n\r\n']) {
		// A two-record journal shows CRLF between its records even with no final newline.
		const parsed = parseReviewArtifact(crlf(body + a + b) + tail, 'markdown')
		assert.equal(parsed.body, body)
		assert.deepEqual(parsed.archive.threads, lf.archive.threads)
	}
	// One record, final CRLF: the tail shows the rewriting.
	assert.equal(parseReviewArtifact(`${crlf(body + a)}\r\n`, 'markdown').body, body)
	// One record and no tail looks exactly like a body ending in CR; older desktops kept
	// that CR in the body, and so does this parser, so both agree on the revision.
	assert.equal(parseReviewArtifact(`body\r${a}`, 'markdown').body, 'body\r')
	assert.equal(parseReviewArtifact(`body\r${a}${b}`, 'markdown').body, 'body\r')
})
test('real corruption is still refused with a reason, with or without trailing whitespace', () => {
	const start = thread()
	const good = record({ version: 1, type: 'thread', thread: start })
	const cases: [string, RegExp][] = [
		[`body${good}\n<!-- helm-review:v1 not-json -->`, /record on line 3 is not valid review JSON/],
		[`body${good}\n<!-- helm-review:v1 e30= -->`, /line 3 is not valid base64url/],
		[`body${good}\n<!-- helm-review:v2 abc -->`, /line 3 is incomplete or has an unknown version/],
		[`body${good}\n<!-- helm-review:v1 abc`, /line 3 is incomplete or has an unknown version/],
		[
			`body${record({ version: 1, type: 'annotations', annotations: [], owner: 'private' })}`,
			/record on line 2 is not a valid review entry/,
		],
		[
			`body${record({ version: 1, type: 'settle', id: start.id, state: 'complete' })}`,
			/thread history is inconsistent/,
		],
		[`body${good}\u00a0`, /line 2 is followed by unsupported whitespace/],
		[`body${good}\n\u2028`, /line 2 is followed by unsupported whitespace/],
		[`body${good}\f`, /line 2 is followed by unsupported whitespace/],
	]
	for (const [raw, reason] of cases)
		for (const tail of ['', '\n', '\r\n', ' \t\n\n']) {
			assert.throws(() => parseReviewArtifact(raw + tail, 'markdown'), reason, JSON.stringify(raw + tail))
			assert.throws(() => parseReviewArtifact(raw + tail, 'markdown'), artifact.ReviewJournalError)
		}
	// A whitespace-only gap before a corrupt record is no excuse either.
	assert.throws(() => parseReviewArtifact(`body${good}\n\n\n<!-- helm-review:v1 e30= -->\n`, 'markdown'), /base64url/)
})
test('appends keep the file ending: none stays none, a final newline or CRLF stays', async () => {
	const append = (root: string, file: string, body: string, entries: CanvasReviewEntry[], archive?: string) =>
		appendReviewArtifact(root, file, entries, {
			expectedSourceRevision: hash(body),
			expectedArchiveRevision: archive,
			current: () => true,
		})
	await fixture(async (root, file) => {
		// No journal yet: unchanged older layout, ending exactly at the record.
		const body = '# Spec\n'
		await writeFile(file, body)
		const entry: CanvasReviewEntry = { version: 1, type: 'thread', thread: thread() }
		await append(root, file, body, [entry, { version: 1, type: 'annotations', annotations: [] }])
		assert.equal(
			await readFile(file, 'utf8'),
			body + record(entry) + record({ version: 1, type: 'annotations', annotations: [] }),
		)
	})
	for (const tail of tails)
		await fixture(async (root, file) => {
			const body = '# Spec\n\nText.\n'
			const first: CanvasReviewEntry = { version: 1, type: 'thread', thread: thread() }
			const initial = body + record(first) + tail
			await writeFile(file, initial)
			const second: CanvasReviewEntry = { version: 1, type: 'thread', thread: thread() }
			const third: CanvasReviewEntry = { version: 1, type: 'annotations', annotations: [] }
			const result = await append(root, file, body, [second, third], hash(initial))
			const raw = await readFile(file, 'utf8')
			assert.ok(raw.startsWith(initial), 'append-only')
			assert.ok(raw.endsWith(record(third).slice(1) + tail), `keeps ${JSON.stringify(tail)}`)
			assert.deepEqual(parseReviewArtifact(raw, 'markdown'), result)
			assert.equal(result.body, body)
			assert.equal(result.archive.threads.length, 2)
		})
})
test('round trip: comment, editor adds a final newline, reopen, comment again; git sees one added line', async () =>
	fixture(async (root, file) => {
		const body = '# Spec\n\nThe plan.\n'
		await writeFile(file, body)
		const passage = { revision: hash(body), start: 0, end: 6, source: '# Spec', quote: 'Spec', kind: 'exact' as const }
		const annotation = { id: 'a1', passage, note: 'Rename', intent: 'change' as const, resolved: false }
		const start = thread()
		await appendReviewArtifact(
			root,
			file,
			[
				{ version: 1, type: 'thread', thread: start },
				{ version: 1, type: 'annotations', annotations: [annotation] },
			],
			{ expectedSourceRevision: hash(body), current: () => true },
		)
		// The editor saves with "insert final newline".
		await writeFile(file, `${await readFile(file, 'utf8')}\n`)
		const saved = await readFile(file, 'utf8')
		const reopened = parseReviewArtifact(saved, 'markdown')
		assert.equal(reopened.body, body)
		assert.equal(reopened.archive.annotations[0]?.passage.revision, hash(reopened.body), 'comment stays current')
		await appendReviewArtifact(
			root,
			file,
			[{ version: 1, type: 'settle', id: start.id, state: 'complete', reply: 'Renamed.' }],
			{
				expectedSourceRevision: hash(reopened.body),
				expectedArchiveRevision: reopened.archive.revision,
				current: () => true,
			},
		)
		const after = await readFile(file, 'utf8')
		// One added line before the kept final newline: the editor has nothing left to add.
		const lines = (text: string) => text.split('\n')
		assert.deepEqual(lines(after).slice(0, -2), lines(saved).slice(0, -1))
		assert.match(lines(after).at(-2) ?? '', /^<!-- helm-review:v1 [A-Za-z0-9_-]+ -->$/)
		assert.equal(lines(after).at(-1), '')
		const final = parseReviewArtifact(after, 'markdown')
		assert.equal(final.body, body)
		assert.equal(final.archive.threads[0]?.reply, 'Renamed.')
		assert.deepEqual(final.archive.annotations, [annotation])
		// The editor saving again changes nothing.
		assert.ok(after.endsWith('\n'))
	}))
test('CRLF round trip: editor rewrites every line ending; history, revision and CRLF survive', async () =>
	fixture(async (root, file) => {
		const body = '# Spec\r\n\r\nThe plan.\r\n'
		await writeFile(file, body)
		const start = thread()
		await appendReviewArtifact(root, file, [{ version: 1, type: 'thread', thread: start }], {
			expectedSourceRevision: hash(body),
			current: () => true,
		})
		const normalized = `${(await readFile(file, 'utf8')).replace(/\r?\n/g, '\r\n')}\r\n`
		await writeFile(file, normalized)
		const reopened = parseReviewArtifact(normalized, 'markdown')
		assert.equal(reopened.body, body)
		await appendReviewArtifact(
			root,
			file,
			[{ version: 1, type: 'settle', id: start.id, state: 'complete', reply: 'ok' }],
			{ expectedSourceRevision: hash(body), expectedArchiveRevision: reopened.archive.revision, current: () => true },
		)
		const after = await readFile(file, 'utf8')
		assert.ok(after.startsWith(normalized))
		assert.ok(!/[^\r]\n/.test(after), 'every line ending stays CRLF')
		assert.ok(after.endsWith(' -->\r\n'))
		assert.equal(parseReviewArtifact(after, 'markdown').archive.threads[0]?.reply, 'ok')
	}))
test('a journal filled to its cap still opens after an editor adds whitespace; caps say "limits", not "malformed"', async () => {
	// Two annotation records sized so the tail-free journal is exactly 384 KiB.
	// Notes are capped at 8,000 characters, so `size` characters spread over several annotations.
	const line = (size: number) =>
		record({
			version: 1,
			type: 'annotations',
			annotations: Array.from({ length: Math.ceil(size / 8000) || 1 }, (_, i) => ({
				id: `a${i}`,
				passage: { revision: hash('doc'), start: 0, end: 3, source: 'doc', quote: 'doc', kind: 'exact' },
				note: 'x'.repeat(Math.max(0, Math.min(8000, size - i * 8000))),
				intent: 'change',
				resolved: false,
			})),
		})
	const target = 384 * 1024
	let first = line(140000)
	// Start below the answer (base64 is 4/3 the JSON, minus a few KB of annotation overhead).
	let n = Math.floor(((target - Buffer.byteLength(first)) * 3) / 4) - 8000
	while (Buffer.byteLength(first + line(n)) < target) n++
	// Unpadded base64 cannot hit every length; shorten the first record by one note character if needed.
	if (Buffer.byteLength(first + line(n)) !== target) first = line(139999)
	const exact = `doc${first}${line(n)}`
	assert.equal(Buffer.byteLength(exact) - 3, target)
	assert.equal(parseReviewArtifact(exact, 'markdown').body, 'doc')
	for (const tail of ['\n', '\r\n', '\n\n'])
		assert.equal(parseReviewArtifact(exact + tail, 'markdown').body, 'doc', JSON.stringify(tail))
	assert.equal(parseReviewArtifact(exact.replace(/\n/g, '\r\n'), 'markdown').body, 'doc')
	assert.throws(
		() => parseReviewArtifact(`doc${first}${line(n + 3)}\n`, 'markdown'),
		/at its limits: it exceeds 384 KiB/,
	)
	// A well-formed but oversized record names its size, not its encoding.
	assert.throws(
		() => parseReviewArtifact(`doc\n<!-- helm-review:v1 ${'A'.repeat(349600)} -->\n`, 'markdown'),
		/at its limits: the record on line 2 exceeds 256 KiB/,
	)
	await fixture(async (root, file) => {
		const threads = Array.from({ length: 64 }, () => record({ version: 1, type: 'thread', thread: thread() })).join('')
		await writeFile(file, `doc${threads}\n`)
		await assert.rejects(
			appendReviewArtifact(root, file, [{ version: 1, type: 'thread', thread: thread() }], {
				expectedSourceRevision: hash('doc'),
				current: () => true,
			}),
			/The review journal is at its limits: it would have more than 64 threads\. No content was changed\./,
		)
		await assert.rejects(
			appendReviewArtifact(root, file, [{ version: 1, type: 'bogus' } as unknown as CanvasReviewEntry], {
				expectedSourceRevision: hash('doc'),
				current: () => true,
			}),
			/The review save request is invalid/,
		)
	})
})
