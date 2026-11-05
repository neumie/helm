// Story-only host for the Signals views (Views / Signals): mounts the production terminal workspace
// through terminal-workspace-fixtures.tsx, then places the Signals column into the task sidebar's
// column (#left). Mock data only; never imported by production.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import { SignalsSurface } from './Signals'
import { type Signal, type SignalsStore, createSignalsStore, signalFixtures } from './signals-fixtures'

export interface SignalsWorkspaceProps {
	/** New signals waiting: 3 (the fixtures) or 0 (all of them routed, snoozed or done). */
	count?: 0 | 3
	/** Open a routing flow on its fixture thread. */
	flow?: 'send' | 'new-agent'
}

/** Every needs-you thread already handled: what a quiet afternoon looks like. */
function quietFixtures(): Signal[] {
	return signalFixtures().map(signal =>
		signal.section === 'needs' ? { ...signal, section: 'done', closed: 'earlier', routed: undefined } : signal,
	)
}

function storeFor(count: 0 | 3, flow: SignalsWorkspaceProps['flow']): SignalsStore {
	const signals = count === 0 ? quietFixtures() : signalFixtures()
	if (flow === 'send')
		return createSignalsStore({ signals, selected: 'crane-970', flow: { type: 'send', id: 'crane-970' } })
	if (flow === 'new-agent')
		return createSignalsStore({ signals, selected: 'psyon-sentry', flow: { type: 'new-agent', id: 'psyon-sentry' } })
	return createSignalsStore({ signals })
}

export function SignalsWorkspace({ count = 3, flow }: SignalsWorkspaceProps) {
	const store = useMemo(() => storeFor(count, flow), [count, flow])
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({ agentDock: { scenario: 'real-case', position: 'bottom', output: 'claude-code' } }),
		[],
	)
	const wrapRef = useRef<HTMLDivElement>(null)
	const [main, setMain] = useState<HTMLElement | null>(null)

	// The fixture builds its shell in its own effect (children's effects run first), so it exists here.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-place after the fixture remounts its shell (options)
	useEffect(() => {
		const left = wrapRef.current?.querySelector<HTMLElement>('#left')
		if (!left) return
		const node = document.createElement('div')
		node.className = 'signals-host'
		left.appendChild(node)
		setMain(node)
		const focusFrame = requestAnimationFrame(() =>
			(
				node.querySelector<HTMLElement>('.signals-flow-keys') ?? node.querySelector<HTMLElement>('section.signals')
			)?.focus({ preventScroll: true }),
		)
		return () => {
			cancelAnimationFrame(focusFrame)
			node.remove()
			setMain(null)
		}
	}, [options, store])

	return (
		<div ref={wrapRef} style={{ display: 'contents' }}>
			<TerminalWorkspaceFixtureView options={options} />
			{main ? createPortal(<SignalsSurface store={store} kind="sidebar" />, main) : null}
		</div>
	)
}
