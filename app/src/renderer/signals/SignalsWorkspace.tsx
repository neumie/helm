// Story-only host for Views / Signals: mounts the production terminal workspace through
// terminal-workspace-fixtures.tsx, then the production left column (mountLeftColumn) with the
// production Signals column on in-memory services (signals-fixtures.ts). The column mode is
// in-memory, as in production. Settings is a stand-in (the real pages have their own Views / Sidebar
// stories). Never imported by production.

import { useEffect, useMemo, useRef } from 'react'
import { focusActiveTerminal, memoryLeftColumnMode, mountLeftColumn, mountSignalsShortcut } from '../left-column'
import { type TerminalWorkspaceFixtureOptions, TerminalWorkspaceFixtureView } from '../terminal-workspace-fixtures'
import { type SignalsFlow, mountSignals } from './Signals'
import {
	ASK_TERMINAL_IDLE,
	type SignalsFixture,
	createSignalsFixture,
	signalAskFixtures,
	signalDoneFixtures,
	signalSourcesFixture,
	signalThreadFixtures,
	signalsAskSessions,
	signalsDockFixture,
} from './signals-fixtures'

export interface SignalsWorkspaceProps {
	/**
	 * `quiet`: every Needs you thread already handled; `source-down`: Mail needs permission;
	 * `asks`: agent asks on top of the column's threads, their agents in the dock; `done`: more
	 * threads done today, one per way a thread gets done.
	 */
	scenario?: 'column' | 'quiet' | 'source-down' | 'asks' | 'done'
	/**
	 * Open a flow on its fixture thread (send: crane-rental#970, new agent: the Sentry alert, reply
	 * and links: the `Signals asks` row-layout ask), or the filtered mail or done today list.
	 */
	flow?: 'send' | 'new-agent' | 'reply' | 'links' | 'filtered' | 'done'
	/**
	 * Story only: 1 s after load, Jakub types this prompt into the idle ask agent's Okena terminal
	 * (`ASK_TERMINAL_IDLE`); main's real ask resolver closes the open asks bound to it.
	 */
	terminalPrompt?: string
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
	if (scenario === 'done') {
		const dock = signalsDockFixture(now)
		return createSignalsFixture({
			threads: [...threads, ...signalDoneFixtures(now)],
			dock: { ...dock, sessions: [...dock.sessions, ...signalsAskSessions(now)] },
		})
	}
	if (scenario === 'asks') {
		const dock = signalsDockFixture(now)
		return createSignalsFixture({
			threads: [...signalAskFixtures(now), ...threads],
			dock: { ...dock, sessions: [...dock.sessions, ...signalsAskSessions(now)] },
		})
	}
	return createSignalsFixture({ threads })
}

const FLOW_THREAD: Record<Exclude<NonNullable<SignalsWorkspaceProps['flow']>, 'filtered' | 'done'>, number> = {
	send: 970,
	'new-agent': 42,
	reply: 501,
	links: 501,
}

export function SignalsWorkspace({ scenario = 'column', flow, terminalPrompt }: SignalsWorkspaceProps) {
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
		const initialFlow: SignalsFlow =
			flow === 'filtered' || flow === 'done' ? { type: flow } : flow ? { type: flow, id: FLOW_THREAD[flow] } : null
		const column = mountLeftColumn({
			left,
			mode: memoryLeftColumnMode('signals'),
			mountSettings: host => {
				// A stand-in for the Settings stack: its top page heading and a Back to Signals.
				const page = document.createElement('div')
				page.className = 'nav-page'
				const title = document.createElement('h2')
				title.dataset.pageHeading = ''
				title.tabIndex = -1
				title.style.cssText = 'margin: 12px 16px; color: var(--text-1); font-size: 13px; font-weight: 400'
				title.textContent = 'Settings'
				const back = document.createElement('button')
				back.type = 'button'
				back.textContent = 'Back'
				back.addEventListener('click', () => column.setMode('signals'))
				page.append(back, title)
				host.append(page)
				return undefined
			},
			mountSignals: host =>
				mountSignals(host, {
					service: fixture.service,
					dock: fixture.dock,
					onOpenSettings: () => column.setMode('settings'),
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
		const promptTimer =
			terminalPrompt === undefined
				? undefined
				: window.setTimeout(() => void fixture.terminalPrompt(ASK_TERMINAL_IDLE, terminalPrompt), 1_000)
		return () => {
			window.clearTimeout(promptTimer)
			cancelAnimationFrame(focusFrame)
			disposeShortcut()
			column.dispose()
			if (window.__signalsFixture === fixture) window.__signalsFixture = undefined
		}
	}, [options, fixture, flow, terminalPrompt])

	return (
		<div ref={wrapRef} style={{ display: 'contents' }}>
			<TerminalWorkspaceFixtureView options={options} />
		</div>
	)
}
