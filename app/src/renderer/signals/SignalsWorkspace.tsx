// Story-only host for Views / Signals: mounts the production terminal workspace through
// terminal-workspace-fixtures.tsx, then the production left column (mountLeftColumn) with the
// production Signals column on in-memory services (signals-fixtures.ts). The column mode is
// in-memory too, so "Show tasks" never leaks into the next story. Never imported by production.

import { useEffect, useMemo, useRef } from 'react'
import { focusActiveTerminal, memoryLeftColumnMode, mountLeftColumn, mountSignalsShortcut } from '../left-column'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import { type SignalsFlow, mountSignals } from './Signals'
import {
	type SignalsFixture,
	createSignalsFixture,
	signalSourcesFixture,
	signalThreadFixtures,
} from './signals-fixtures'

export interface SignalsWorkspaceProps {
	/** `quiet`: every Needs you thread already handled; `source-down`: Mail needs permission. */
	scenario?: 'column' | 'quiet' | 'source-down'
	/** Open a routing flow on its fixture thread (send: crane-rental#970, new agent: the Sentry alert). */
	flow?: 'send' | 'new-agent'
}

declare global {
	interface Window {
		/** Browser tests only: the effects the story's column asked for. */
		__signalsFixture?: SignalsFixture
	}
}

function fixtureFor(scenario: SignalsWorkspaceProps['scenario']): SignalsFixture {
	const now = Date.now()
	const threads = signalThreadFixtures(now)
	if (scenario === 'quiet')
		return createSignalsFixture({
			threads: threads.map(thread =>
				thread.owner === 'jakub' && (thread.state === 'new' || thread.state === 'seen')
					? { ...thread, state: 'done', updatedAt: new Date(now - 30 * 60_000).toISOString() }
					: thread,
			),
		})
	if (scenario === 'source-down')
		return createSignalsFixture({ threads, sources: signalSourcesFixture(now, 'needs_permission') })
	return createSignalsFixture({ threads })
}

const FLOW_THREAD: Record<NonNullable<SignalsWorkspaceProps['flow']>, number> = { send: 970, 'new-agent': 42 }

export function SignalsWorkspace({ scenario = 'column', flow }: SignalsWorkspaceProps) {
	const fixture = useMemo(() => fixtureFor(scenario), [scenario])
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({ agentDock: { scenario: 'real-case', position: 'bottom', output: 'claude-code' } }),
		[],
	)
	const wrapRef = useRef<HTMLDivElement>(null)

	// The fixture builds its shell in its own effect (children's effects run first), so #left exists here.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-mount after the fixture remounts its shell (options)
	useEffect(() => {
		const root = wrapRef.current
		const left = root?.querySelector<HTMLElement>('#left')
		if (!root || !left) return
		window.__signalsFixture = fixture
		const initialFlow: SignalsFlow = flow ? { type: flow, id: FLOW_THREAD[flow] } : null
		const column = mountLeftColumn({
			left,
			mode: memoryLeftColumnMode('signals'),
			mountTasks: host => {
				host.setAttribute('aria-label', 'Tasks')
				// A stand-in: the real task sidebar has its own Views / Sidebar stories.
				const title = document.createElement('p')
				title.style.cssText = 'margin: 12px 16px; color: var(--text-1)'
				title.textContent = 'Tasks'
				host.append(title)
				return undefined
			},
			mountSignals: host =>
				mountSignals(host, {
					service: fixture.service,
					dock: fixture.dock,
					onShowTasks: () => column.setMode('tasks'),
					onLeave: () => focusActiveTerminal(root),
					mod: 'cmd',
					initialFlow,
				}),
		})
		const disposeShortcut = mountSignalsShortcut({
			window,
			platform: 'darwin',
			column,
			focusTerminal: () => focusActiveTerminal(root),
		})
		const focusFrame = requestAnimationFrame(() => column.focusSignals())
		return () => {
			cancelAnimationFrame(focusFrame)
			disposeShortcut()
			column.dispose()
			if (window.__signalsFixture === fixture) window.__signalsFixture = undefined
		}
	}, [options, fixture, flow])

	return (
		<div ref={wrapRef} style={{ display: 'contents' }}>
			<TerminalWorkspaceFixtureView options={options} />
		</div>
	)
}
