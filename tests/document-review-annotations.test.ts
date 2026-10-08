import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import annotationsModule from '../app/src/renderer/document-review/annotations.ts'
import recoveryModule from '../app/src/renderer/document-review/archive-recovery.ts'
import displayModule from '../app/src/renderer/document-review/canvas-display.ts'
import threadsModule from '../app/src/renderer/document-review/passage-threads.ts'
import validationModule from '../app/src/renderer/document-review/passage-validation.ts'
import type {
	CanvasDisplayFrame,
	CanvasDisplayNode,
	ReviewAnnotation,
	ReviewCanvasCompilation,
	ReviewDocument,
	ReviewSession,
} from '../src/document-review/types.ts'
const { annotationSaveDraft, captureAnnotationSave, removeReviewAnnotation, updateReviewAnnotation } = annotationsModule
const { CanvasFrameGate, canvasSourceBlock, canvasWorkerInvocation, validateCanvasFrame, validateCanvasValues } =
	displayModule
const { projectPassageThreads } = threadsModule
const { captureArchiveRecovery, currentArchiveRecovery } = recoveryModule
const { validateDocumentPassage } = validationModule
const revision = 'a'.repeat(64)
const annotation: ReviewAnnotation = {
	id: 'saved-id',
	passage: { revision, start: 0, end: 16, source: 'First paragraph.', quote: 'First paragraph.', kind: 'block' },
	note: 'Keep this.',
	intent: 'change',
	resolved: false,
}
const compilation: ReviewCanvasCompilation = {
	code: 'fixture',
	error: null,
	blocks: [{ id: 'field', start: 0, end: 16 }],
	fieldIds: ['field'],
}
type ProvenanceFrame = Omit<CanvasDisplayFrame, 'nodes'> & {
	nodes: (string | (CanvasDisplayNode & { sourceId?: string }))[]
}
function frame(): ProvenanceFrame {
	return {
		nodes: [
			{
				id: 'node-1',
				sourceId: 'field',
				tag: 'input',
				props: { id: 'field', type: 'text', value: 'Visible' },
				children: [],
				events: { change: 'local-change' },
			},
		],
		fields: [{ id: 'field', value: 'Visible' }],
	}
}

test('final reply recovery uses the exact current failure/API/document/lifecycle, never acknowledgement or local drafts', () => {
	const api = {} as Parameters<typeof captureArchiveRecovery>[1]
	const state = {
		document: { id: 'doc', revision },
		archiveError: 'Save failed',
		archiveFailureId: 'failure-1',
	} as Parameters<typeof captureArchiveRecovery>[0]
	const target = captureArchiveRecovery(state, api, 3)
	assert.ok(target)
	assert.equal(currentArchiveRecovery(target, state, api, 3), true)
	assert.equal(
		currentArchiveRecovery(target, { ...state, archiveFailureId: 'failure-2' } as NonNullable<typeof state>, api, 3),
		false,
	)
	assert.equal(currentArchiveRecovery(target, state, { ...api }, 3), false)
	assert.equal(currentArchiveRecovery(target, state, api, 4), false)
	assert.equal(
		currentArchiveRecovery(
			target,
			{ ...state, document: { ...state?.document, revision: 'changed' } } as NonNullable<typeof state>,
			api,
			3,
		),
		false,
	)
	assert.equal(
		currentArchiveRecovery(target, { ...state, archiveError: null } as NonNullable<typeof state>, api, 3),
		false,
	)
	assert.equal(captureArchiveRecovery(null, api, 3), null)
	assert.equal(
		captureArchiveRecovery({ ...state, archiveFailureId: undefined } as NonNullable<typeof state>, api, 3)?.id,
		null,
	)
})

test('native annotation updates preserve saved identity and exact stale source locator', () => {
	const values = [annotation]
	const changed = updateReviewAnnotation(values, annotation.id, value => ({
		...value,
		id: 'wrong',
		note: 'Edited',
		resolved: true,
	}))
	assert.equal(changed[0]?.id, annotation.id)
	assert.equal(changed[0]?.passage, annotation.passage)
	assert.equal(changed[0]?.intent, 'change')
	assert.equal(values[0]?.note, 'Keep this.')
	assert.deepEqual(removeReviewAnnotation(changed, annotation.id), [])
	assert.deepEqual(removeReviewAnnotation(changed, 'missing'), changed)
})
test('ordinary preference autosave omits archive fence; explicit mutation captures null or exact revision', () => {
	const draft = { instruction: 'New text', annotations: [annotation], archiveRevision: 'obsolete' }
	assert.equal('archiveRevision' in annotationSaveDraft(draft), false)
	assert.equal(annotationSaveDraft(draft, { value: null }).archiveRevision, null)
	assert.equal(annotationSaveDraft(draft, { value: revision }).archiveRevision, revision)
	assert.equal(draft.archiveRevision, 'obsolete')
})
test('comment retry retains the exact captured draft and original archive fence after newer edits', () => {
	const draft = {
		instruction: 'Original note',
		annotations: [structuredClone(annotation)],
		archiveRevision: 'old',
		sessionId: null,
		paneWidth: 380,
		theme: 'dark' as const,
	}
	const captured = captureAnnotationSave(draft, revision)
	draft.instruction = 'New draft'
	const value = draft.annotations[0]
	if (value) value.note = 'Newer annotation'
	draft.archiveRevision = 'new metadata'
	assert.equal(captured.archiveRevision, revision)
	assert.equal(captured.instruction, 'Original note')
	assert.equal(captured.annotations[0]?.note, 'Keep this.')
	assert.equal(captured.annotations[0]?.id, 'saved-id')
	assert.notEqual(captured.annotations[0]?.passage, draft.annotations[0]?.passage)
})

test('worker launch supplies compiler attestation as a separate JSON literal outside producer factory', () => {
	const source = canvasWorkerInvocation(compilation)
	assert.ok(
		source.startsWith(
			'\nHelmReviewCanvasWorker.startReviewCanvas((module,exports,require,__helmCanvasRuntime)=>{\nfixture\n},',
		),
	)
	assert.ok(source.endsWith(`${JSON.stringify({ blocks: compilation.blocks, fieldIds: compilation.fieldIds })});`))
	assert.throws(() => canvasWorkerInvocation({ ...compilation, code: null, error: 'Compile failed' }))
})

test('display boundary allows literal public controls and local callbacks only', () => {
	assert.deepEqual(validateCanvasFrame(frame(), compilation), frame())
	for (const props of [
		{ onClick: 'nativeSend' },
		{ dangerouslySetInnerHTML: { __html: 'x' } },
		{ href: 'https://secret.invalid' },
		{ style: { backgroundImage: 'url(https://secret.invalid)' } },
		{ style: { position: 'fixed' } },
		{ style: { color: 'var(--secret)' } },
		{ type: 'password' },
		{ type: 'file' },
	]) {
		const bad = frame()
		Object.assign(bad.nodes[0] as object, { props: { id: 'field', ...props } })
		assert.throws(() => validateCanvasFrame(bad, compilation))
	}
	for (const tag of ['script', 'iframe', 'img', 'a', 'form', 'svg', 'video']) {
		const bad = frame()
		;(bad.nodes[0] as { tag: string }).tag = tag
		assert.throws(() => validateCanvasFrame(bad, compilation))
	}
})
test('fields require compiler authority, unique current rendered IDs and bounded complete projection', () => {
	const bad = frame()
	bad.fields = [{ id: 'invented', value: 'secret' }]
	assert.throws(() => validateCanvasFrame(bad, compilation))
	const duplicate = frame()
	duplicate.nodes.push({
		...(duplicate.nodes[0] as Exclude<CanvasDisplayFrame['nodes'][number], string>),
		id: 'node-2',
	})
	assert.throws(() => validateCanvasFrame(duplicate, compilation))
	const omitted = frame()
	omitted.fields = []
	assert.throws(() => validateCanvasFrame(omitted, compilation))
	const long = frame()
	long.fields[0] = { id: 'field', value: 'x'.repeat(4001) }
	assert.throws(() => validateCanvasFrame(long, compilation))
	assert.throws(() => validateCanvasFrame({ nodes: ['x'.repeat(64001)], fields: [] }, compilation))
	assert.throws(() => validateCanvasFrame({ nodes: Array.from({ length: 2049 }, () => 'x'), fields: [] }, compilation))
})
test('projected fields require unique valid compiler bounds inside the current source, not only a matching ID', () => {
	for (const blocks of [
		[],
		[{ id: 'field', start: -1, end: 16 }],
		[{ id: 'field', start: 0, end: 99 }],
		[
			{ id: 'field', start: 0, end: 16 },
			{ id: 'field', start: 0, end: 16 },
		],
	]) {
		assert.equal(canvasSourceBlock({ ...compilation, blocks }, 'field', 16), null)
		assert.throws(() => validateCanvasFrame(frame(), { ...compilation, blocks }, 16))
		const unproven = frame()
		;(unproven.nodes[0] as { sourceId?: string }).sourceId = undefined
		unproven.fields = []
		assert.doesNotThrow(() => validateCanvasFrame(unproven, { ...compilation, blocks }, 16))
	}
	assert.equal(canvasSourceBlock(compilation, 'field', 16)?.end, 16)
	assert.deepEqual(validateCanvasFrame(frame(), compilation, 16), frame())
})

test('runtime-private provenance is required; reused producer IDs never authorize fields or source markers', () => {
	const dynamic = frame()
	;(dynamic.nodes[0] as { sourceId?: string }).sourceId = undefined
	assert.throws(() => validateCanvasFrame(dynamic, compilation))
	dynamic.fields = []
	assert.equal((validateCanvasFrame(dynamic, compilation).nodes[0] as { sourceId?: string }).sourceId, undefined)
	for (const sourceId of ['unknown', '', 'x'.repeat(81), 1, null]) {
		const bad = frame()
		Object.assign(bad.nodes[0] as object, { sourceId })
		assert.throws(() => validateCanvasFrame(bad, compilation))
	}
	const mismatched = frame()
	Object.assign(mismatched.nodes[0] as object, { props: { id: 'other' } })
	assert.throws(() => validateCanvasFrame(mismatched, compilation))
	const collision = frame()
	collision.nodes.push({ ...(dynamic.nodes[0] as CanvasDisplayNode), id: 'dynamic-collision' })
	assert.throws(() => validateCanvasFrame(collision, compilation))
	collision.fields = []
	const validated = validateCanvasFrame(collision, compilation)
	assert.ok(validated.nodes.every(node => typeof node === 'string' || node.sourceId === undefined))
})

test('unattested controls and bounded multi-select stay local-only; arrays never enter public fields', () => {
	const local = {
		nodes: [
			{
				id: 'local-node',
				tag: 'input',
				props: { id: 'dynamic-id', defaultValue: 'Scratch' },
				children: [],
				events: { change: 'local' },
			},
		],
		fields: [],
	}
	assert.doesNotThrow(() => validateCanvasFrame(local, compilation))
	const multi = {
		nodes: [
			{
				id: 'multi-node',
				tag: 'select',
				props: { id: 'field', multiple: true, value: ['red', 'blue'] },
				children: [],
				events: { change: 'multi' },
			},
		],
		fields: [],
	}
	assert.doesNotThrow(() => validateCanvasFrame(multi, compilation))
	assert.throws(() => validateCanvasFrame({ ...multi, fields: [{ id: 'field', value: ['red'] }] }, compilation))
	assert.throws(() => validateCanvasFrame({ ...multi, fields: [{ id: 'field', value: 'red' }] }, compilation))
	assert.throws(() => validateCanvasFrame({ ...multi, nodes: [{ ...multi.nodes[0], tag: 'input' }] }, compilation))
	assert.throws(() => validateCanvasValues(Array.from({ length: 65 }, () => 'a')))
	assert.throws(() => validateCanvasValues(['a'.repeat(4001)]))
	assert.throws(() => validateCanvasValues(Array.from({ length: 5 }, () => 'a'.repeat(4000))))
	assert.deepEqual(validateCanvasValues(['red', 'blue']), ['red', 'blue'])
})

test('same-task canvas event invalidates public fields until current frame AND settlement; retirement is permanent', () => {
	const gate = new CanvasFrameGate()
	assert.equal(gate.ready, false)
	gate.frame(0, [{ id: 'field', value: 'before' }])
	gate.settle(0)
	assert.equal(gate.ready, true)
	const sequence = gate.admit()
	assert.equal(gate.ready, false)
	gate.settle(sequence)
	assert.equal(gate.ready, false)
	assert.equal(gate.frame(0, [{ id: 'field', value: 'old' }]), false)
	gate.frame(sequence, [{ id: 'field', value: 'after' }])
	assert.equal(gate.ready, true)
	gate.admit()
	gate.settle(sequence)
	assert.equal(gate.ready, false)
	gate.dispose()
	assert.equal(gate.frame(2, []), false)
	gate.settle(2)
	assert.equal(gate.ready, false)
	assert.deepEqual(gate.fields, [])
})
function canvasPassageFixture() {
	const text =
		'export default function Proposal(){return <section id="outer"><p id="inner">First paragraph.</p></section>}'
	const sourceRevision = createHash('sha256').update(text).digest('hex')
	const blocks = [
		{ id: 'outer', start: text.indexOf('<section'), end: text.indexOf('</section>') + '</section>'.length },
		{ id: 'inner', start: text.indexOf('<p '), end: text.indexOf('</p>') + '</p>'.length },
	]
	const inner = blocks[1] as NonNullable<(typeof blocks)[1]>
	const passage = {
		revision: sourceRevision,
		start: inner.start,
		end: inner.end,
		source: text.slice(inner.start, inner.end),
		quote: 'First paragraph.',
		kind: 'block' as const,
		canvasId: 'inner',
	}
	const canvas: ReviewCanvasCompilation = {
		code: 'module.exports.default=function Proposal(){return require("react").createElement("section",{id:"outer"},require("react").createElement("p",{id:"inner"},"First paragraph."))}',
		error: null,
		blocks,
		fieldIds: [],
	}
	const document: ReviewDocument = {
		id: 'doc',
		name: 'spec.jsx',
		relativePath: 'spec.jsx',
		text,
		revision: sourceRevision,
		previous: null,
		error: null,
		format: 'jsx',
		canvas,
		archive: {
			version: 1,
			revision: sourceRevision,
			annotations: [{ ...annotation, passage }],
			threads: [
				{
					id: '00000000-0000-4000-8000-000000000001',
					instruction: 'Why this?',
					intent: 'discuss',
					passage,
					fields: [],
					provider: 'pi',
					name: 'Original conversation',
					state: 'complete',
					reply: 'Saved reply.',
				},
			],
		},
	}
	const session: ReviewSession = {
		id: 'fixture-caller',
		owner: 'fixture-owner',
		provider: 'pi',
		name: 'Original conversation',
		state: 'idle',
		listening: true,
		busy: false,
		needsAcknowledgement: false,
		historyTruncated: false,
		error: null,
		capabilities: {
			transport: 'in-process',
			continuation: 'live-session',
			readOnlyPolicy: 'session-owned',
			interactiveQuestions: true,
			interrupt: 'unsupported',
			providerAcknowledgement: false,
			minimumVersion: null,
		},
		messages: [
			{ id: 'live:user', role: 'user', text: 'Live question.', passageContext: { documentId: document.id, passage } },
			{ id: 'live:assistant', role: 'assistant', text: 'Live reply.' },
		],
	}
	return { document, passage, canvas, blocks, session }
}

test('canvas local/saved/live bubbles and selection share exact current compiler metadata, never containing bounds', () => {
	const { document, passage, blocks, session } = canvasPassageFixture()
	assert.doesNotThrow(() => validateDocumentPassage(document, passage))
	const projected = projectPassageThreads(document, session, blocks)
	assert.equal(projected.has('outer'), false)
	assert.equal(projected.get('inner')?.length, 3)
	assert.deepEqual(
		projected.get('inner')?.map(thread => thread.id),
		['archive:00000000-0000-4000-8000-000000000001', 'annotation:saved-id', 'live:user'],
	)
	assert.equal(projectPassageThreads(document, null, blocks).get('inner')?.length, 2)
	assert.equal(
		projectPassageThreads(document, session, [{ id: 'other', start: passage.start, end: passage.end }]).size,
		0,
	)
})

test('missing/error/stale/wrong/duplicate canvas metadata never authorizes local/saved/live passages or selection', () => {
	const { document, passage, canvas, blocks, session } = canvasPassageFixture()
	const refused: ReviewDocument[] = [
		{ ...document, canvas: undefined },
		{ ...document, canvas: { ...canvas, code: null } },
		{ ...document, canvas: { ...canvas, error: 'Compiler refused source' } },
		{ ...document, revision: 'f'.repeat(64) },
		{ ...document, text: document.text.replace('First paragraph.', 'Other paragraph.') },
		{ ...document, canvas: { ...canvas, blocks: blocks.filter(block => block.id !== 'inner') } },
		{ ...document, canvas: { ...canvas, blocks: blocks.map(block => ({ ...block, start: block.start + 1 })) } },
		{ ...document, canvas: { ...canvas, blocks: [...blocks, { ...(blocks[1] as NonNullable<(typeof blocks)[1]>) }] } },
	]
	for (const current of refused) {
		assert.throws(() => validateDocumentPassage(current, passage))
		assert.equal(projectPassageThreads(current, session, blocks).size, 0)
	}
	assert.throws(() => validateDocumentPassage(document, { ...passage, canvasId: 'unattested' }))
	assert.throws(() => validateDocumentPassage(document, { ...passage, canvasId: undefined }))
	assert.doesNotThrow(() => validateDocumentPassage(document, { ...passage, kind: 'exact', canvasId: undefined }))
})

test('saved history and local comments project without a caller only at unchanged exact source', () => {
	const document: ReviewDocument = {
		id: 'doc',
		name: 'spec.md',
		relativePath: 'spec.md',
		text: 'First paragraph.',
		revision,
		previous: null,
		error: null,
		archive: {
			version: 1,
			revision: 'b'.repeat(64),
			annotations: [annotation],
			threads: [
				{
					id: 'portable-thread',
					instruction: 'Why this?',
					intent: 'discuss',
					passage: annotation.passage,
					fields: [],
					provider: 'pi',
					name: 'Original human conversation',
					state: 'unconfirmed',
				},
			],
		},
	}
	const blocks = [{ id: 'first', start: 0, end: 16 }]
	const projected = projectPassageThreads(document, null, blocks)
	assert.equal(projected.get('first')?.length, 2)
	assert.match(projected.get('first')?.[0]?.messages.at(-1)?.text ?? '', /nothing replayed/)
	assert.match(projected.get('first')?.[1]?.messages.at(-1)?.text ?? '', /not sent/)
	assert.equal(projectPassageThreads({ ...document, revision: 'c'.repeat(64) }, null, blocks).size, 0)
	assert.equal(projectPassageThreads({ ...document, text: 'Changed content.' }, null, blocks).size, 0)
})
