import type { Meta, StoryObj } from '@storybook/react-vite'
import { Suspense, lazy } from 'react'
import '../run-context/run-context-editor.css'
import type { RunContextEditorApi } from '../../shared'
import type { RunContextLoad } from '../../shared-helm'
import { type ShortcutChord, effectiveShortcuts } from '../../shortcuts'

const RunContextEditor = lazy(async () => {
	const module = await import('../run-context/RunContextEditor')
	return { default: module.RunContextEditor }
})

function EditorSurface({ loaded }: { loaded: RunContextLoad }) {
	return (
		<Suspense fallback={<div>Loading editor…</div>}>
			<RunContextEditor loaded={loaded} onReload={() => {}} />
		</Suspense>
	)
}

const sourceFixture: RunContextLoad = {
	item: {
		id: 'item-context-story',
		title: 'Correct the export behavior and remove the stale workaround',
		projectSlug: 'helm',
		status: 'ready',
	},
	source: {
		title: 'Correct the export behavior and remove the stale workaround',
		description: 'The export should preserve manually entered labels and use the final approved ordering.',
		comments: [
			{
				author: 'Maya',
				createdAt: '2026-07-20T09:30:00.000Z',
				body: 'The earlier comment about alphabetical ordering is no longer true. Remove it from the run context.',
			},
		],
		metadata: { Project: 'helm', Priority: 'High' },
		attachments: [{ name: 'expected-export.png', url: 'https://example.test/expected-export.png' }],
	},
	document: null,
	revision: 0,
}

declare global {
	interface Window {
		__runContextSaveCalls?: number
		__emitRunContextSaveBindings?: (bindings: ShortcutChord[]) => void
	}
}

const saveBindingListeners = new Set<(bindings: ShortcutChord[]) => void>()
const mockApi: RunContextEditorApi = {
	platform: 'darwin',
	saveBindings: effectiveShortcuts().runContextSave,
	onSaveBindingsChanged: listener => {
		saveBindingListeners.add(listener)
		return () => saveBindingListeners.delete(listener)
	},
	load: async () => ({ data: sourceFixture }),
	save: async (revision, document) => {
		window.__runContextSaveCalls = (window.__runContextSaveCalls ?? 0) + 1
		return {
			data: { document: { ...document, updatedAt: new Date().toISOString() }, revision: revision + 1 },
		}
	},
	reset: async revision => ({ data: { source: sourceFixture.source, document: null, revision: revision + 1 } }),
	setDirty() {},
	close() {},
	cancelClose() {},
	onCloseRequested: () => () => {},
}

const meta: Meta = {
	title: 'Views/Run context editor',
	parameters: { layout: 'fullscreen' },
	decorators: [
		story => {
			window.__runContextSaveCalls = 0
			window.__emitRunContextSaveBindings = bindings => {
				for (const listener of saveBindingListeners) listener(bindings.map(binding => ({ ...binding })))
			}
			window.runContextEditor = mockApi
			return <div style={{ width: '100vw', height: '100vh' }}>{story()}</div>
		},
	],
}

export default meta
type Story = StoryObj

export const SourceContext: Story = {
	render: () => <EditorSurface loaded={sourceFixture} />,
}

export const Customized: Story = {
	render: () => (
		<EditorSurface
			loaded={{
				...sourceFixture,
				document: {
					version: 1,
					updatedAt: '2026-07-21T10:00:00.000Z',
					markdown: '## Verified specification\n\nPreserve manual labels. Ignore the stale ordering comment.',
					blocks: [
						{
							id: 'verified-heading',
							type: 'heading',
							props: { level: 2 },
							content: [{ type: 'text', text: 'Verified specification', styles: {} }],
							children: [],
						},
						{
							id: 'verified-body',
							type: 'paragraph',
							props: {},
							content: [
								{
									type: 'text',
									text: 'Preserve manual labels. Ignore the stale ordering comment.',
									styles: {},
								},
							],
							children: [],
						},
					],
				},
				revision: 3,
			}}
		/>
	),
}
