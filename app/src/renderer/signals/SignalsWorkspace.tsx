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
	signalAnswerDoneFixture,
	signalAnswerFixtures,
	signalAskChoiceFixtures,
	signalAskFixtures,
	signalDoneFixtures,
	signalSlackFilteredFixture,
	signalSlackFixtures,
	signalSourcesFixture,
	signalThreadFixtures,
	signalsAskSessions,
	signalsDockFixture,
} from './signals-fixtures'

/**
 * `empty`: every thread done (nothing needs you, nothing managed, nothing snoozed); `empty-down`: the
 * same while Mail needs permission (no all-clear).
 */
export type SignalsScenario =
	| 'column'
	| 'quiet'
	| 'source-down'
	| 'asks'
	| 'answers'
	| 'detail'
	| 'done'
	| 'slack'
	| 'empty'
	| 'empty-down'

export interface SignalsWorkspaceProps {
	/**
	 * `quiet`: every Needs you thread already handled; `source-down`: Mail needs permission;
	 * `asks`: agent asks on top of the column's threads, their agents in the dock; `done`: more
	 * threads done today, one per way a thread gets done.
	 */
	scenario?: SignalsScenario
	/**
	 * Open a flow on its fixture thread (send: crane-rental#970, new agent: the Sentry alert, reply
	 * and links: the `Signals asks` row-layout ask), or the filtered mail or done today list.
	 */
	flow?: 'send' | 'new-agent' | 'reply' | 'slack-reply' | 'links' | 'filtered' | 'done'
	/** The agent row whose detail is open on load (the `detail` scenario: 505 the quick-answer ask). */
	detail?: number
	/**
	 * Story only: 1 s after load, Jakub types this prompt into the idle ask agent's Okena terminal
	 * (`ASK_TERMINAL_IDLE`); main's real ask resolver closes the open asks bound to it.
	 */
	terminalPrompt?: string
	/** The column's width in px (`--left-width`); default the production 340. */
	width?: number
}

declare global {
	interface Window {
		/** Browser tests only: the effects the story's column asked for. */
		__signalsFixture?: SignalsFixture
	}
}

export function fixtureFor(scenario: SignalsWorkspaceProps['scenario']): SignalsFixture {
	const now = Date.now()
	const threads = signalThreadFixtures(now)
	if (scenario === 'empty' || scenario === 'empty-down') {
		const allDone = [...threads, ...signalDoneFixtures(now)].map(thread =>
			thread.state === 'done'
				? thread
				: {
						...thread,
						state: 'done' as const,
						owner: 'jakub' as const,
						snoozedUntil: null,
						updatedAt: new Date(now - 40 * 60_000).toISOString(),
					},
		)
		return createSignalsFixture({
			threads: allDone,
			sources: scenario === 'empty-down' ? signalSourcesFixture(now, 'needs_permission') : undefined,
		})
	}
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
	if (scenario === 'detail') {
		const dock = signalsDockFixture(now)
		// The dispatcher's asks with quick answers and a long one, answers, then the column's threads.
		return createSignalsFixture({
			threads: [
				...signalAskChoiceFixtures(now),
				...signalAnswerFixtures(now),
				...signalAskFixtures(now).filter(thread => thread.id === 501),
				...threads,
			],
			dock: { ...dock, sessions: [...dock.sessions, ...signalsAskSessions(now)] },
		})
	}
	if (scenario === 'answers') {
		const dock = signalsDockFixture(now)
		// Answers beside an ask and the column's threads; one read today shows in Done today.
		const asks = signalAskFixtures(now).filter(thread => thread.id === 502)
		return createSignalsFixture({
			threads: [...signalAnswerFixtures(now), signalAnswerDoneFixture(now), ...asks, ...threads],
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
	if (scenario === 'slack') {
		return createSignalsFixture({
			threads: [...signalSlackFixtures(now), ...threads],
			filtered: [signalSlackFilteredFixture(now)],
			// Slack answering beside GitHub and Mail, as when it is turned on.
			sources: [
				...signalSourcesFixture(now),
				{
					source: 'slack',
					status: 'ok',
					detail: null,
					lastPollAt: new Date(now).toISOString(),
					lastOkAt: new Date(now).toISOString(),
				},
			],
		})
	}
	return createSignalsFixture({ threads })
}

const FLOW_THREAD: Record<Exclude<NonNullable<SignalsWorkspaceProps['flow']>, 'filtered' | 'done'>, number> = {
	send: 970,
	'new-agent': 42,
	reply: 501,
	'slack-reply': 701,
	links: 501,
}

export function SignalsWorkspace({ scenario = 'column', flow, terminalPrompt, width, detail }: SignalsWorkspaceProps) {
	const fixture = useMemo(() => fixtureFor(flow === 'slack-reply' ? 'slack' : scenario), [scenario, flow])
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
		const content = left.parentElement
		if (width) content?.style.setProperty('--left-width', `${width}px`)
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
					...(detail !== undefined ? { initialDetail: detail } : {}),
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
			content?.style.removeProperty('--left-width')
			if (window.__signalsFixture === fixture) window.__signalsFixture = undefined
		}
	}, [options, fixture, flow, terminalPrompt, width, detail])

	return (
		<div ref={wrapRef} style={{ display: 'contents' }}>
			<TerminalWorkspaceFixtureView options={options} />
		</div>
	)
}

export interface SignalsColumnFramesProps {
	/** Each frame: a width and a scenario, the production column alone at that size. */
	frames: readonly { width: number; scenario: SignalsScenario; label: string }[]
	height?: number
}

/** Story only: the bare production column in fixed frames side by side (narrow and wide checks). */
export function SignalsColumnFrames({ frames, height = 640 }: SignalsColumnFramesProps) {
	const hosts = useRef<(HTMLDivElement | null)[]>([])
	useEffect(() => {
		const mounted = frames.flatMap((frame, index) => {
			const host = hosts.current[index]
			if (!host) return []
			const fixture = fixtureFor(frame.scenario)
			return [
				mountSignals(host, {
					service: fixture.service,
					dock: fixture.dock,
					onOpenSettings: () => undefined,
					mod: 'cmd',
				}),
			]
		})
		return () => {
			for (const signals of mounted) signals.dispose()
		}
	}, [frames])
	return (
		<div
			style={{
				display: 'flex',
				gap: 24,
				padding: 24,
				alignItems: 'flex-start',
				background: 'var(--chrome)',
				minHeight: '100vh',
				boxSizing: 'border-box',
			}}
		>
			{frames.map((frame, index) => (
				<figure key={frame.label} style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
					<figcaption style={{ font: '12px/18px var(--font-ui)', color: 'var(--text-2)' }}>{frame.label}</figcaption>
					<div
						ref={element => {
							hosts.current[index] = element
						}}
						style={{
							position: 'relative',
							width: frame.width,
							height,
							display: 'flex',
							flexDirection: 'column',
							background: 'var(--pane)',
							outline: '1px solid var(--hairline)',
						}}
					/>
				</figure>
			))}
		</div>
	)
}
