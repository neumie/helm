import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import requestModule from '../app/src/document-review/request.ts'
import sessionsModule from '../app/src/document-review/sessions.ts'
import type { ReviewBlock } from '../app/src/renderer/document-review/markdown.ts'
import projectionModule from '../app/src/renderer/document-review/passage-threads.ts'
import { sessionSchema } from '../src/document-review/protocol.ts'
import type { ReviewDocument, ReviewFeedback, ReviewMessage, ReviewSession } from '../src/document-review/types.ts'

const { ReviewSessions } = sessionsModule
const { projectPassageThreads } = projectionModule
const { locateReviewPassage } = requestModule
const revision = 'a'.repeat(64)
const text = 'First paragraph.\n\nSecond paragraph.\n'
const document: ReviewDocument = {
	id: randomUUID(),
	name: 'spec.md',
	relativePath: 'spec.md',
	revision,
	text,
	previous: null,
	error: null,
}
const blocks: ReviewBlock[] = [
	{
		id: 'first',
		start: 0,
		end: 18,
		heading: null,
		depth: 0,
		token: { type: 'paragraph', raw: text.slice(0, 18), text: 'First paragraph.' },
	},
	{
		id: 'second',
		start: 18,
		end: text.length,
		heading: null,
		depth: 0,
		token: { type: 'paragraph', raw: text.slice(18), text: 'Second paragraph.' },
	},
]
function context() {
	const passage = locateReviewPassage(text, revision, 0, 16, 'First paragraph.')
	assert.ok(passage)
	return { documentId: document.id, passage }
}
function session(messages: ReviewMessage[]): ReviewSession {
	return { ...new ReviewSessions(() => {}).connect('pi', '/fixture', 'Original conversation', 'in-process'), messages }
}

test('passage bubbles project only exact request replies in the current document and source revision', () => {
	const source = context()
	const messages: ReviewMessage[] = [
		{ id: 'a:user', role: 'user', text: 'Why this passage?', passageContext: source },
		{ id: 'unrelated:assistant', role: 'assistant', text: 'Unrelated reply' },
		{ id: 'a:assistant', role: 'assistant', text: 'Exact reply' },
		{ id: 'b:user', role: 'user', text: 'A second question', passageContext: source },
		{ id: 'b:assistant', role: 'assistant', text: 'Second reply' },
		{
			id: 'other:user',
			role: 'user',
			text: 'Another document',
			passageContext: { ...source, documentId: randomUUID() },
		},
		{
			id: 'old:user',
			role: 'user',
			text: 'Old revision',
			passageContext: { ...source, passage: { ...source.passage, revision: 'b'.repeat(64) } },
		},
		{
			id: 'bad:user',
			role: 'user',
			text: 'Invalid locator',
			passageContext: { ...source, passage: { ...source.passage, source: 'wrong source' } },
		},
		{ id: 'whole:user', role: 'user', text: 'Whole document question' },
	]
	const owner = session(messages)
	const projected = projectPassageThreads(document, owner, blocks)
	assert.equal(projected.size, 1)
	assert.deepEqual(
		projected.get('first')?.map(value => value.messages.map(message => message.text)),
		[
			['Why this passage?', 'Exact reply'],
			['A second question', 'Second reply'],
		],
	)
	assert.equal(
		projectPassageThreads({ ...document, revision: 'b'.repeat(64), text: 'New document' }, owner, blocks).size,
		0,
	)
	assert.equal(projectPassageThreads(document, null, blocks).size, 0)
	assert.equal(projectPassageThreads(document, session([]), blocks).size, 0)
	assert.equal(projectPassageThreads(document, owner, []).size, 0)
	// Loss of the question never attaches an orphaned answer to another question.
	assert.equal(
		projectPassageThreads(document, session(messages.filter(value => value.role !== 'user')), blocks).size,
		0,
	)
})

test('admitted questions retain detached source context and exact streaming reply identities within the mailbox bound', async () => {
	const sessions = new ReviewSessions(() => {})
	const owner = sessions.connect('pi', '/fixture', 'Original conversation', 'in-process')
	try {
		for (let index = 0; index < 24; index++) {
			const waiting = sessions.next(owner.id, owner.owner, 1000, new AbortController().signal)
			const id = randomUUID()
			const original = context()
			// Exercise actual escaped metadata bytes, not just instruction lengths.
			const longPassage = { ...original.passage, source: '\u0000'.repeat(8000), quote: '\u0000'.repeat(8000) }
			const feedback: ReviewFeedback = {
				request: {
					id,
					documentId: document.id,
					revision,
					sessionId: owner.id,
					owner: owner.owner,
					intent: 'discuss',
					instruction: 'Question',
					passage: index ? longPassage : original.passage,
				},
				prompt: 'Fixture prompt',
				relativePath: 'spec.md',
			}
			const admitted = sessions.reserve(owner.id, owner.owner, '/fixture')
			sessions.dispatch(admitted, id, id, feedback)
			await waiting
			const question = sessions.list('/fixture')[0]?.messages.find(value => value.id === `${id}:user`)
			assert.deepEqual(question?.passageContext, { documentId: document.id, passage: feedback.request.passage })
			if (!index) {
				original.passage.quote = 'Mutated producer object'
				assert.equal(sessions.list('/fixture')[0]?.messages[0]?.passageContext?.passage.quote, 'First paragraph.')
			}
			sessions.confirm(owner.id, owner.owner, id)
			sessions.report(owner.id, owner.owner, id, 0, 'working', 'Partial reply')
			sessions.report(owner.id, owner.owner, id, 1, 'complete', 'Completed reply')
			const snapshot = sessionSchema.parse(sessions.list('/fixture')[0])
			assert.equal(snapshot.messages.at(-1)?.id, `${id}:assistant`)
			assert.equal(snapshot.messages.at(-1)?.text, 'Completed reply')
			assert.ok(Buffer.byteLength(JSON.stringify(snapshot.messages)) <= 160100)
		}
		assert.equal(sessions.list('/fixture')[0]?.historyTruncated, true)
	} finally {
		sessions.stopOwned()
	}
})
