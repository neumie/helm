import assert from 'node:assert/strict'
import test from 'node:test'
import {
	MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH,
	applyRunContextDocument,
	parseRunContextDocument,
	plainRunContextFromSource,
	runContextDraftSchema,
} from '../src/items/run-context.js'

test('Run Context v1 preserves independent block and markdown limits', () => {
	const markdown = 'm'.repeat(180_000)
	const blocks = [{ type: 'paragraph', content: 'x'.repeat(600_000) }]
	assert.ok(JSON.stringify({ blocks, markdown }).length > 750_000)
	assert.ok(JSON.stringify(blocks).length < MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH)
	const draft = runContextDraftSchema.parse({ version: 1, blocks, markdown })
	assert.equal(draft.markdown.length, 180_000)
	assert.throws(() =>
		parseRunContextDocument({
			version: 1,
			blocks: [],
			markdown: 'm'.repeat(200_001),
			updatedAt: new Date().toISOString(),
		}),
	)
	assert.equal(parseRunContextDocument({ ...draft, updatedAt: new Date().toISOString() }).version, 1)
	assert.throws(
		() =>
			parseRunContextDocument({
				version: 1,
				blocks: [{ payload: 'x'.repeat(MAX_RUN_CONTEXT_BLOCKS_JSON_LENGTH) }],
				markdown: '',
				updatedAt: new Date().toISOString(),
			}),
		/Run context editor state exceeds/,
	)
})

test('plain v2 captures canonical ordered images and preserves protected execution fields', () => {
	const source = {
		title: 'Title',
		description: 'provider flat fallback',
		descriptionBlocks: [
			{ type: 'text' as const, text: 'before' },
			{ type: 'image' as const, url: 'https://example.test/a.png', name: 'a', contentType: 'image/png' },
			{ type: 'image' as const, url: 'https://example.test/b.png', name: 'b' },
		],
		comments: [{ author: 'A', createdAt: new Date().toISOString(), body: 'comment' }],
		metadata: { priority: 'high' },
		projectContext: 'project',
		attachments: [{ name: 'file.txt', url: '/api/file' }],
	}
	const document = plainRunContextFromSource(source, 'operator narrative')
	assert.deepEqual(
		document.images.map(image => image.name),
		['a', 'b'],
	)
	const projected = applyRunContextDocument(source, document)
	assert.equal(projected.title, source.title)
	assert.equal(projected.metadata?.priority, 'high')
	assert.equal(projected.projectContext, 'project')
	assert.deepEqual(projected.attachments, source.attachments)
	assert.match(projected.description ?? '', /operator narrative/)
	assert.match(projected.description ?? '', /a\.png/)
	assert.equal(projected.descriptionBlocks, undefined)
	assert.equal(projected.comments, undefined)
})

test('client-supplied v2 image shape is rejected by the strict v1 draft schema', () => {
	assert.throws(() =>
		runContextDraftSchema.parse({ version: 2, text: 'x', images: [], updatedAt: new Date().toISOString() }),
	)
})
