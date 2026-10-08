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
			parseReviewArtifact(`${record({ version: 1, type: 'annotations', annotations: [] })}\n`, 'markdown'),
		)
		assert.throws(() =>
			parseReviewArtifact(
				`\n<!-- helm-review:v1 ${Buffer.from(' '.repeat(256 * 1024 + 1)).toString('base64url')} -->`,
				'markdown',
			),
		)
	}))
