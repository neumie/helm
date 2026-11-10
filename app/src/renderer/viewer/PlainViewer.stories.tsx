import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo } from 'react'
import '../document-review/document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { DocumentReview } from '../document-review/DocumentReview'
import { type ViewerFixtureScenario, createViewerFixture } from './viewer-fixtures'

declare global {
	interface Window {
		__helmViewerProof?: ReturnType<typeof createViewerFixture>
	}
}

function ViewerFixture({ scenario }: { scenario: ViewerFixtureScenario }) {
	const fixture = useMemo(() => createViewerFixture(scenario), [scenario])
	useEffect(() => {
		window.__helmViewerProof = fixture
		return () => {
			if (window.__helmViewerProof === fixture) window.__helmViewerProof = undefined
			fixture.dispose()
		}
	}, [fixture])
	return <DocumentReview api={fixture.api} />
}

const meta: Meta<typeof ViewerFixture> = {
	title: 'Views/Document review/Plain files',
	component: ViewerFixture,
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj<typeof ViewerFixture>

const describe = (story: string) => ({ docs: { description: { story } } })

export const Code: Story = {
	args: { scenario: 'code' },
	parameters: describe(
		'`helm open src/…/refusal.ts`: the read-only CodeMirror view. Arrows, Shift+arrows, ⌘A and ⌘C work; ⌘F finds, ⌘G / ⇧⌘G step, Esc closes. Space / ⇧Space page, J / K move a line. The status line shows the cursor, language, lines, encoding, line ending and size.',
	),
}
export const CodeLight: Story = {
	args: { scenario: 'code-light' },
	parameters: describe('The scoped light reading surface with its darker syntax colors.'),
}
export const Log: Story = {
	args: { scenario: 'log' },
	parameters: describe('A `.log` file is plain text: no highlighting, same keys.'),
}
export const JsonTree: Story = {
	args: { scenario: 'json' },
	parameters: describe(
		'A Sentry issue JSON as a tree: ↑ ↓ (or J K) move, → expands, ← collapses or goes to the parent, Enter toggles, ⌘C copies the focused node as JSON. ⌘F finds keys and values and expands the path to each match. Document options switches to Raw source. The status line shows the focused node’s JSON Pointer.',
	),
}
export const JsonTreeLight: Story = { args: { scenario: 'json-light' } }
export const Yaml: Story = {
	args: { scenario: 'yaml' },
	parameters: describe('A GitHub workflow: anchors and merge keys shown resolved.'),
}
export const Toml: Story = {
	args: { scenario: 'toml' },
	parameters: describe('Cargo.toml: integers beyond 2^53 keep every digit.'),
}
export const JsonLines: Story = {
	args: { scenario: 'jsonl' },
	parameters: describe('One record per line; a line that does not parse stays in the tree with the parser’s message.'),
}
export const ParseError: Story = {
	args: { scenario: 'json-error' },
	parameters: describe(
		'A file that does not parse opens as its source, with the parser’s first line above it. Tree is unavailable.',
	),
}
export const LargeJson: Story = {
	args: { scenario: 'json-large' },
	parameters: describe(
		'A 12 500-company export: the tree is virtualised and lists the first 10 000 children of a node with an “N more” row.',
	),
}
