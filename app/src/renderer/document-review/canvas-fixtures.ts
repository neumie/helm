import type { CanvasReviewArchive, ReviewCanvasCompilation, ReviewRequest } from '../../document-review/types'
import type { ArchiveReviewApi, ArchiveReviewState } from './archive-recovery'
import { createReviewFixture } from './fixtures'

export type CanvasFixtureScenario =
	| 'interactive'
	| 'light'
	| 'compact'
	| 'archive'
	| 'stale'
	| 'unconfirmed'
	| 'rejected'
	| 'compile-error'
	| 'no-caller'
	| 'save-error'
	| 'comment-save-error'
export const canvasFixtureSource = `import React, { useState } from 'react';
export default function Proposal() {
  const [name, setName] = useState('Workshop');
  const [count, setCount] = useState(2);
  const [choices, setChoices] = useState(['red']);
  const localId = 'local-input';
  return <section>
    <h1>Workshop proposal</h1>
    <p id="intro">Keep the reading surface calm and let the conversation support a precise question.</p>
    <label htmlFor="name">Public workshop name</label>
    <input id="name" value={name} onChange={event => setName(event.target.value)} />
    <label htmlFor="count">Public seats</label>
    <input id="count" type="number" value={count} onChange={event => setCount(Number(event.target.value))} />
    <button onClick={() => setCount(count + 1)}>Add a seat</button>
    <p>Seats: {count}</p>
    <label htmlFor={localId}>Local scratch text</label>
    <input id={localId} defaultValue="Private local draft" />
    <label htmlFor="local-choice">Local colors</label>
    <select id="local-choice" multiple value={choices} onChange={event => setChoices(Array.from(event.target.selectedOptions, option => option.value))}>
      <option value="red">Red</option><option value="blue">Blue</option>
    </select>
    <p>Colors: {choices.join(', ')}</p>
  </section>;
}
`
/** Hand-authored display fixture using private runtime helper; NOT native compiler/provenance proof. */
const factoryCode = `const React = require('react');
module.exports.default = function Proposal() {
 const [name, setName] = React.useState('Workshop'); const [count, setCount] = React.useState(2); const [choices,setChoices]=React.useState(['red']);
 return __helmCanvasRuntime.createElement('section', null,
  __helmCanvasRuntime.createElement('h1', null, 'Workshop proposal'),
  __helmCanvasRuntime.attest('intro', __helmCanvasRuntime.createElement('p', {id:'intro'}, 'Keep the reading surface calm and let the conversation support a precise question.')),
  __helmCanvasRuntime.createElement('label', {htmlFor:'name'}, 'Public workshop name'),
  __helmCanvasRuntime.attest('name', __helmCanvasRuntime.createElement('input', {id:'name', value:name, onChange:event=>setName(event.target.value)})),
  __helmCanvasRuntime.createElement('label', {htmlFor:'count'}, 'Public seats'),
  __helmCanvasRuntime.attest('count', __helmCanvasRuntime.createElement('input', {id:'count', type:'number', value:String(count), onChange:event=>setCount(Number(event.target.value))})),
  __helmCanvasRuntime.createElement('button', {onClick:()=>setCount(count+1)}, 'Add a seat'),
  __helmCanvasRuntime.createElement('p', null, 'Seats: '+count),
  __helmCanvasRuntime.createElement('label', {htmlFor:'local-input'}, 'Local scratch text'),
  __helmCanvasRuntime.createElement('input', {id:'local-input', defaultValue:'Private local draft'}),
  __helmCanvasRuntime.createElement('label', {htmlFor:'local-choice'}, 'Local colors'),
  __helmCanvasRuntime.createElement('select', {id:'local-choice',multiple:true,value:choices,onChange:event=>setChoices(Array.from(event.target.selectedOptions, option=>option.value))}, __helmCanvasRuntime.createElement('option',{value:'red'},'Red'),__helmCanvasRuntime.createElement('option',{value:'blue'},'Blue')),
  __helmCanvasRuntime.createElement('p', null, 'Colors: '+choices.join(', ')));
};`
function bounds(id: string, tag: string) {
	const start = canvasFixtureSource.indexOf(`<${tag} id="${id}"`)
	const end =
		tag === 'input'
			? canvasFixtureSource.indexOf('/>', start) + 2
			: canvasFixtureSource.indexOf(`</${tag}>`, start) + tag.length + 3
	return { id, start, end }
}
export const canvasFixtureCompilation: ReviewCanvasCompilation = {
	code: factoryCode,
	error: null,
	blocks: [bounds('intro', 'p'), bounds('name', 'input'), bounds('count', 'input')],
	fieldIds: ['name', 'count'],
}
const archiveBody =
	'# Workshop proposal\n\nKeep the reading surface calm and let the conversation support a precise question.\n'
export function createCanvasReviewFixture(scenario: CanvasFixtureScenario) {
	const base = createReviewFixture('editorial')
	const canvas = ['interactive', 'light', 'compact', 'compile-error', 'no-caller'].includes(scenario)
	base.edit(canvas ? canvasFixtureSource : archiveBody)
	const archive: CanvasReviewArchive = { version: 1, revision: 'b'.repeat(64), threads: [], annotations: [] }
	const links = new Map<string, string>()
	const listeners = new Set<() => void>()
	let revision = 11
	let retries = 0
	let discarded = 0
	let archiveFailureId: string | null = scenario === 'save-error' ? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' : null
	let commentFailures = scenario === 'comment-save-error' ? 1 : 0
	let archiveError =
		scenario === 'save-error' ? 'The completed reply is not saved. Keep this window open and retry review save.' : null
	let seeded = false
	const notify = () => {
		for (const listener of listeners) listener()
	}
	const savedDrafts: unknown[] = []
	const api: ArchiveReviewApi = {
		...base.api,
		load: async () => {
			const result = await base.api.load()
			if (!result.data) return result
			const state: ArchiveReviewState = result.data
			if (!seeded && !canvas) {
				seeded = true
				const start = archiveBody.indexOf('Keep')
				const passage = {
					revision: state.document.revision,
					start,
					end: archiveBody.length,
					source: archiveBody.slice(start),
					quote: 'Keep the reading surface calm',
					kind: 'block' as const,
				}
				archive.threads.push({
					id: '11111111-2222-4333-8444-555555555555',
					instruction: 'Why keep this reading surface calm?',
					intent: 'discuss',
					passage,
					fields: [],
					provider: 'pi',
					name: 'Original workshop conversation',
					state:
						scenario === 'unconfirmed' || scenario === 'save-error'
							? 'unconfirmed'
							: scenario === 'rejected'
								? 'rejected'
								: 'complete',
					...(scenario === 'unconfirmed' || scenario === 'rejected' || scenario === 'save-error'
						? { detail: 'Saved evidence only. This request will not be replayed.' }
						: { reply: 'The prose stays primary; the companion supports a precise question.' }),
				})
				archive.annotations.push({
					id: 'saved-comment',
					passage,
					note: 'Keep this reading rhythm.',
					intent: 'change',
					resolved: false,
				})
				if (scenario === 'stale') {
					base.edit(`${archiveBody}\nChanged source.\n`)
					return api.load()
				}
			}
			state.document.format = canvas ? 'jsx' : 'markdown'
			if (canvas)
				state.document.canvas =
					scenario === 'compile-error'
						? { code: null, blocks: [], fieldIds: [], error: 'Only React imports are supported in this document.' }
						: structuredClone(canvasFixtureCompilation)
			state.document.name = canvas ? 'proposal.jsx' : 'proposal.md'
			state.document.archive = structuredClone(archive)
			state.draft.annotations = structuredClone(archive.annotations)
			state.draft.theme = scenario === 'light' ? 'light' : 'dark'
			state.archiveError = archiveError
			state.archiveFailureId = archiveFailureId
			if (['archive', 'stale', 'unconfirmed', 'rejected', 'no-caller'].includes(scenario)) {
				state.sessions = []
				state.draft.sessionId = null
			}
			if (scenario === 'save-error' && state.sessions[0])
				state.sessions[0].messages.push(
					{
						id: 'failed-review:user',
						role: 'user',
						text: 'Why keep this reading surface calm?',
						archiveThreadId: archive.threads[0]?.id,
					},
					{
						id: 'failed-review:assistant',
						role: 'assistant',
						text: 'This reply remains in the original conversation even if its document save is discarded.',
						archiveThreadId: archive.threads[0]?.id,
					},
				)
			for (const session of state.sessions)
				for (const message of session.messages) {
					const requestId = message.id.replace(/:(user|assistant|error)$/, '')
					const id = links.get(requestId)
					if (id) message.archiveThreadId = id
				}
			return { data: state }
		},
		save: async draft => {
			savedDrafts.push(structuredClone(draft))
			if (draft.archiveRevision !== undefined) {
				if (commentFailures > 0) {
					commentFailures--
					return { error: 'Comment append failed. Retry deliberately with the original review revision.' }
				}
				if (draft.archiveRevision !== archive.revision)
					return { error: 'Review metadata changed. Reload before saving comments.' }
				archive.annotations = structuredClone(draft.annotations)
				archive.revision = (++revision).toString(16).padStart(64, '0')
			}
			return base.api.save(draft)
		},
		send: async (request: ReviewRequest) => {
			const id = crypto.randomUUID()
			links.set(request.id, id)
			archive.threads.push({
				id,
				instruction: request.instruction,
				intent: request.intent,
				passage: request.passage,
				fields: request.canvasFields ?? [],
				provider: 'pi',
				name: 'Workshop conversation',
				state: 'unconfirmed',
			})
			archive.revision = (++revision).toString(16).padStart(64, '0')
			return base.api.send(request)
		},
		discardArchive: async id => {
			if (!archiveError || id !== archiveFailureId)
				return { error: 'This unsaved reply is no longer the current failure.' }
			discarded++
			archiveError = null
			archiveFailureId = null
			notify()
			return { data: true }
		},
		retryDocument: async () => {
			retries++
			archiveError = null
			archiveFailureId = null
			if (scenario === 'save-error' && archive.threads[0]) {
				archive.threads[0].state = 'complete'
				archive.threads[0].reply =
					'This reply remains in the original conversation even if its document save is discarded.'
				archive.revision = (++revision).toString(16).padStart(64, '0')
			}
			notify()
			return { data: true }
		},
		onChanged: listener => {
			listeners.add(listener)
			const remove = base.api.onChanged(listener)
			return () => {
				listeners.delete(listener)
				remove()
			}
		},
	}
	return {
		...base,
		api,
		savedDrafts,
		retries: () => retries,
		discarded: () => discarded,
		replaceFailure: () => {
			archiveFailureId = crypto.randomUUID()
			notify()
		},
		metadataChange: () => {
			archive.revision = (++revision).toString(16).padStart(64, '0')
			notify()
		},
		dispose: () => {
			base.dispose()
			listeners.clear()
		},
	}
}
