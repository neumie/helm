// Story-only host for the Signals variants (Views / Signals): mounts the production terminal
// workspace and agent dock through terminal-workspace-fixtures.tsx, then places a Signals surface
// or a resting indicator into that real shell. Mock data only; never imported by production.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
	type TerminalWorkspaceFixtureOptions,
	TerminalWorkspaceFixtureView,
	fixtureSessions,
} from '../terminal-workspace-fixtures'
import { AgentsPaneHints, AgentsPaneSection, ArrivalToast, DockToken, SignalsSurface, TopbarCount } from './Signals'
import { type Signal, type SignalsStore, createSignalsStore, signalFixtures } from './signals-fixtures'

/** Where Signals lives (A); `closed` is Signals out of sight (the resting indicators, B). */
export type SignalsPlacement = 'pane' | 'agents' | 'band' | 'sidebar' | 'closed'
/** How Jakub notices new signals while Signals is closed (B). */
export type SignalsIndicator = 'topbar' | 'dock-token' | 'toast' | 'nothing'

export interface SignalsWorkspaceProps {
	placement: SignalsPlacement
	indicator?: SignalsIndicator
	/** New signals waiting: 3 (the fixtures) or 0 (all of them routed, snoozed or done). */
	count?: 0 | 3
	/** C: open a routing flow on its fixture thread. */
	flow?: 'send' | 'new-agent'
	/** A1 pane width in px. */
	paneWidth?: number
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

/** The dispatcher runs in the active tab; A3 names it so. */
function dispatcherSessions() {
	return fixtureSessions().map(session =>
		session.sessionId === 'shell' ? { ...session, customName: 'dispatcher' } : session,
	)
}

export function SignalsWorkspace({
	placement,
	indicator = 'nothing',
	count = 3,
	flow,
	paneWidth = 480,
}: SignalsWorkspaceProps) {
	const store = useMemo(() => storeFor(count, flow), [count, flow])
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			...(placement === 'band' ? { sessions: dispatcherSessions() } : {}),
			agentDock: {
				scenario: 'real-case',
				position: 'bottom',
				// A recorded Claude Code screen does not reflow into a narrower split; a shell log does.
				output: placement === 'pane' ? true : 'claude-code',
				...(placement === 'agents' ? { open: 'agents' as const } : {}),
				...(placement === 'agents'
					? {
							preview: {
								agentsSection: <AgentsPaneSection store={store} />,
								agentsHints: <AgentsPaneHints store={store} />,
							},
						}
					: indicator === 'dock-token'
						? { preview: { beforeAgents: <DockToken store={store} /> } }
						: {}),
			},
		}),
		[placement, indicator, store],
	)
	const wrapRef = useRef<HTMLDivElement>(null)
	const [main, setMain] = useState<HTMLElement | null>(null)
	const [topbar, setTopbar] = useState<HTMLElement | null>(null)

	// The fixture builds its shell in its own effect (children's effects run first), so it exists here.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-place after the fixture remounts its shell (options)
	useEffect(() => {
		const root = wrapRef.current
		const right = root?.querySelector<HTMLElement>('#right')
		const left = root?.querySelector<HTMLElement>('#left')
		const strip = root?.querySelector<HTMLElement>('#tab-strip-region')
		if (!root || !right || !left || !strip) return
		const created: HTMLElement[] = []
		const host = (parent: HTMLElement, before: Element | null = null): HTMLElement => {
			const node = document.createElement('div')
			node.className = 'signals-host'
			parent.insertBefore(node, before)
			created.push(node)
			return node
		}
		if (placement === 'pane' || placement === 'band') {
			right.dataset.signals = placement
			right.style.setProperty('--signals-width', `${paneWidth}px`)
			setMain(host(right, placement === 'band' ? right.firstElementChild : null))
		} else if (placement === 'sidebar') {
			setMain(host(left))
		}
		if (placement === 'closed' && indicator === 'topbar') {
			const node = document.createElement('span')
			node.className = 'signals-topbar-host'
			node.style.display = 'contents'
			strip.insertBefore(node, strip.querySelector('#bg-root'))
			created.push(node)
			setTopbar(node)
		}
		// A2: the Agents pane opens from its entry (a pointer click keeps the keys with the terminal);
		// the story then gives the pane the keys, as ⌘⇧J would, so its footer shows the row's actions.
		let observer: MutationObserver | null = null
		// Only the Agents list (Signals rows in it) takes these keys: never a dock item's pane, a field,
		// or an open flow (it handles its own keys).
		const routeKeys = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
			const target = event.target as HTMLElement
			if (target.closest('textarea, input, [data-kind="agents-flow"]')) return
			if (!pane?.querySelector('.signals-in-agents[data-kind="agents"]')) return
			const key = event.key
			if (key === 'j' || key === 'ArrowDown') store.move(1)
			else if (key === 'k' || key === 'ArrowUp') store.move(-1)
			else if (/^[pnmtsdo]$/.test(key)) store.act(key)
			else return
			event.preventDefault()
			event.stopPropagation()
		}
		let pane: HTMLElement | null = null
		if (placement === 'agents') {
			observer = new MutationObserver(() => {
				const found = root.querySelector<HTMLElement>('.agent-dock-pane')
				if (!found || found === pane) return
				pane = found
				pane.addEventListener('keydown', routeKeys)
				requestAnimationFrame(() => pane?.focus({ preventScroll: true }))
			})
			observer.observe(root, { childList: true, subtree: true })
		}
		// The surface takes the keys on mount, as ⌘⇧I would, so its footer shows the row's actions.
		const focusFrame = requestAnimationFrame(() =>
			(
				root.querySelector<HTMLElement>('.signals-host .signals-flow-keys') ??
				root.querySelector<HTMLElement>('.signals-host section.signals')
			)?.focus({ preventScroll: true }),
		)
		return () => {
			cancelAnimationFrame(focusFrame)
			observer?.disconnect()
			pane?.removeEventListener('keydown', routeKeys)
			for (const node of created) node.remove()
			delete right.dataset.signals
			right.style.removeProperty('--signals-width')
			setMain(null)
			setTopbar(null)
		}
	}, [placement, indicator, paneWidth, options, store])

	const surface =
		placement === 'pane' ? (
			<SignalsSurface store={store} kind="pane" />
		) : placement === 'band' ? (
			<SignalsSurface store={store} kind="band" compact />
		) : placement === 'sidebar' ? (
			<SignalsSurface store={store} kind="sidebar" />
		) : null

	return (
		<div ref={wrapRef} style={{ display: 'contents' }}>
			<TerminalWorkspaceFixtureView options={options} />
			{main && surface ? createPortal(surface, main) : null}
			{topbar ? createPortal(<TopbarCount store={store} />, topbar) : null}
			{placement === 'closed' && indicator === 'toast'
				? createPortal(<ArrivalToast store={store} />, document.body)
				: null}
		</div>
	)
}
