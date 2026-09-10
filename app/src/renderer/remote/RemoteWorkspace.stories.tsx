import type { Meta, StoryObj } from '@storybook/react-vite'
import { Profiler, useEffect, useState } from 'react'
import { RemoteWorkspace } from './RemoteWorkspace.js'
import { RemoteEntry } from './entry.js'
import {
	type RemoteEntryTestFixture,
	type RemoteFixture,
	createRemoteEntryFixture,
	createRemoteFixture,
} from './remote-fixtures.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
		__remoteEntryFixture?: RemoteEntryTestFixture & { dispose(): void }
		__remoteRenderDurations?: number[]
	}
}
function Harness({
	question = false,
	revoked = false,
	readOnly = false,
	scoped = false,
	composerExample = false,
	markdownExample = false,
	chainedExample = false,
	terminalMetadataExample = false,
	rowDensityExample = false,
}: {
	question?: boolean
	revoked?: boolean
	readOnly?: boolean
	scoped?: boolean
	composerExample?: boolean
	markdownExample?: boolean
	chainedExample?: boolean
	terminalMetadataExample?: boolean
	rowDensityExample?: boolean
}) {
	const [fixture] = useState(() => {
		const value = createRemoteFixture()
		if (composerExample) value.showComposerExample()
		if (markdownExample) value.showMarkdownExample()
		if (chainedExample) value.showChainedExample()
		if (rowDensityExample) value.showTerminalMetadataExample(null, 3)
		else if (terminalMetadataExample) value.showTerminalMetadataExample()
		if (question) value.ask()
		if (readOnly) value.setReadOnly(true)
		if (scoped) value.addScopedSession()
		if (revoked) value.revoke()
		return value
	})
	useEffect(() => {
		window.__remoteFixture = fixture
		return () => {
			window.__remoteFixture = undefined
		}
	}, [fixture])
	useEffect(() => {
		if (!composerExample && !markdownExample && !chainedExample) return
		let frame = 0
		let attempts = 0
		const open = () => {
			const row = document.querySelector<HTMLButtonElement>('.remote-session-row')
			if (row) row.click()
			else if (++attempts < 60) frame = requestAnimationFrame(open)
		}
		frame = requestAnimationFrame(open)
		return () => cancelAnimationFrame(frame)
	}, [composerExample, markdownExample, chainedExample])
	return (
		<Profiler
			id="Remote workspace"
			onRender={(_id, _phase, duration) => {
				const values = window.__remoteRenderDurations ?? []
				values.push(duration)
				window.__remoteRenderDurations = values.slice(-300)
			}}
		>
			<RemoteWorkspace transport={fixture.transport} />
		</Profiler>
	)
}
const meta = { title: 'Views/Helm Remote', component: Harness, parameters: { layout: 'fullscreen' } } satisfies Meta<
	typeof Harness
>
export default meta
type Story = StoryObj<typeof meta>
export const BrowserHarness: Story = {}
export const Composer: Story = { args: { composerExample: true } }
export const Reading: Story = { args: { markdownExample: true } }
export const ChainedReply: Story = { args: { chainedExample: true } }
export const TerminalMetadata: Story = { args: { terminalMetadataExample: true } }
export const Readability: Story = { args: { terminalMetadataExample: true } }
export const RowDensity: Story = { args: { rowDensityExample: true } }
export const LiveScopes: Story = { args: { scoped: true } }
export const Questions: Story = { args: { question: true } }
export const QuestionsReadOnly: Story = { args: { question: true, readOnly: true } }
export const AccessEnded: Story = { args: { revoked: true } }
function PairingHarness({
	qr = false,
	authenticated = false,
	unavailable = false,
}: { qr?: boolean; authenticated?: boolean; unavailable?: boolean }) {
	const [value] = useState(() => createRemoteEntryFixture(qr, authenticated, unavailable))
	const [mounted, setMounted] = useState(true)
	useEffect(() => {
		window.__remoteEntryFixture = { ...value, dispose: () => setMounted(false) }
		return () => {
			window.__remoteEntryFixture = undefined
		}
	}, [value])
	return mounted ? <RemoteEntry fixture={value.fixture} /> : <p>Entry disposed</p>
}
export const PairingEntry: Story = { render: () => <PairingHarness /> }
export const PairingFromQr: Story = { render: () => <PairingHarness qr /> }
export const PairingRecovery: Story = { render: () => <PairingHarness authenticated /> }

export const AccessUnavailable: Story = { render: () => <PairingHarness authenticated unavailable /> }
