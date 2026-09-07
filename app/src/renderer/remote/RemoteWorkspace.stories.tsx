import type { Meta, StoryObj } from '@storybook/react-vite'
import { Profiler, useEffect, useState } from 'react'
import { RemoteWorkspace } from './RemoteWorkspace.js'
import { type RemoteFixture, createRemoteFixture } from './remote-fixtures.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
		__remoteRenderDurations?: number[]
	}
}
function Harness({ question = false }: { question?: boolean }) {
	const [fixture] = useState(() => {
		const value = createRemoteFixture()
		if (question) value.ask()
		return value
	})
	useEffect(() => {
		window.__remoteFixture = fixture
		return () => {
			window.__remoteFixture = undefined
		}
	}, [fixture])
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
export const Questions: Story = { args: { question: true } }
