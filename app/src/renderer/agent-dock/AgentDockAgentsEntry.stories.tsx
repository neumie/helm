import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import type { AgentDockSnapshot, DockSession } from '../../agent-dock/model'
import { AgentDock } from './AgentDock'
import { type AgentDockScenario, createAgentDockFixture } from './agent-dock-fixtures'

/**
 * The Agents entry at the row's right end: the count, then a bar with one segment per agent (working
 * bright, background --text-1, idle faint, waiting/unknown amber). The real AgentDock over reducer-built
 * snapshots; only the agents' statuses are restated.
 */

type Status = DockSession['status']

function scenarioSnapshot(scenario: AgentDockScenario): AgentDockSnapshot {
	let shot: AgentDockSnapshot | null = null
	const stop = createAgentDockFixture(scenario).api.onSnapshot(next => {
		shot = next
	})
	stop()
	if (!shot) throw new Error(`no snapshot for ${scenario}`)
	return shot
}

/**
 * `single-turn` (ios-sync, idle, its unchecked turn in the queue) plus recorded agents from `busy` and
 * `real-case`, each given the next status: the first status is ios-sync's own.
 */
function agentsSnapshot(statuses: readonly Status[]): AgentDockSnapshot {
	const base = scenarioSnapshot('single-turn')
	const owner = base.sessions[0]
	if (!owner) return base
	const pool = [...scenarioSnapshot('busy').sessions, ...scenarioSnapshot('real-case').sessions].filter(
		session => session.key !== owner.key,
	)
	const sessions = statuses.flatMap((status, at): DockSession[] => {
		const session = at === 0 ? owner : pool[(at - 1) % pool.length]
		return session ? [{ ...session, key: at === 0 ? session.key : `${session.key}#${at}`, status }] : []
	})
	return { ...base, sessions }
}

type Case = 'none' | 'one' | 'three' | 'nine' | 'twelve' | 'unknown' | 'open' | 'focused'
const CASES: ReadonlyArray<{ id: Case; note: string }> = [
	{ id: 'none', note: '0 agents' },
	{ id: 'one', note: '1 agent' },
	{ id: 'three', note: '3 · 2 working' },
	{ id: 'nine', note: '9 mixed' },
	{ id: 'twelve', note: '12 · capped' },
	{ id: 'unknown', note: '1 unknown' },
	{ id: 'open', note: 'pane open' },
	{ id: 'focused', note: 'keyboard focus' },
]

function caseSnapshot(id: Case): AgentDockSnapshot {
	switch (id) {
		case 'none':
			return scenarioSnapshot('empty')
		case 'one':
			return agentsSnapshot(['idle'])
		case 'nine':
			return agentsSnapshot([
				'idle',
				'working',
				'working',
				'working',
				'background',
				'waiting',
				'idle',
				'idle',
				'unknown',
			])
		case 'twelve':
			return agentsSnapshot([
				'idle',
				'working',
				'working',
				'background',
				'waiting',
				'idle',
				'idle',
				'idle',
				'unreachable',
				'idle',
				'working',
				'idle',
			])
		case 'unknown':
			return agentsSnapshot(['idle', 'working', 'unknown'])
		default:
			return agentsSnapshot(['idle', 'working', 'working'])
	}
}

/** One production dock (row, and the pane when open). */
function Dock({
	snapshot,
	open = false,
	focus = false,
}: {
	snapshot: AgentDockSnapshot
	open?: boolean
	focus?: boolean
}) {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!focus) return
		// Keyboard arrival (⌘⇧J, then → to the Agents entry): the entry holds the keys.
		const frame = requestAnimationFrame(() =>
			ref.current?.querySelector<HTMLElement>('.agent-dock-agents-entry')?.focus(),
		)
		return () => cancelAnimationFrame(frame)
	}, [focus])
	return (
		<div ref={ref} className="agent-dock" data-position="bottom">
			<div className="agent-dock-view">
				<AgentDock
					snapshot={snapshot}
					now={Date.now()}
					position="bottom"
					mod="cmd"
					initialOpen={open ? { type: 'agents' } : null}
					onAck={async () => false}
				/>
			</div>
		</div>
	)
}

const Label = ({ children }: { children: ReactNode }) => (
	<div
		style={{
			font: '11px/16px -apple-system, BlinkMacSystemFont, sans-serif',
			color: 'var(--text-2)',
			whiteSpace: 'nowrap',
		}}
	>
		{children}
	</div>
)

/** The normal case under a terminal at Helm's width: three agents, two working, one idle with a turn. */
function EntryView() {
	const snapshot = useMemo(() => caseSnapshot('three'), [])
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
			<div style={{ flex: '1 1 auto', minHeight: 0, background: 'var(--term-bg)' }} />
			<Dock snapshot={snapshot} />
		</div>
	)
}

/** Every case stacked, rows 760px wide: the row's right end lines up so they compare at a glance. */
function StatesView({ width }: { width: number }) {
	const snapshots = useMemo(() => new Map(CASES.map(({ id }) => [id, caseSnapshot(id)])), [])
	return (
		<div style={{ padding: 24, background: 'var(--term-bg)', minHeight: '100vh', boxSizing: 'border-box' }}>
			<div style={{ display: 'grid', gridTemplateColumns: `96px ${width}px`, columnGap: 16, rowGap: 6 }}>
				{CASES.map(({ id, note }) => {
					const snapshot = snapshots.get(id)
					return snapshot ? (
						<div key={id} style={{ display: 'contents' }}>
							<div style={{ alignSelf: 'center' }}>
								<Label>{note}</Label>
							</div>
							{/* The pane opens above the row: only the row shows here. */}
							<div style={{ height: 28, overflow: 'hidden', display: 'flex', flexDirection: 'column-reverse' }}>
								<Dock snapshot={snapshot} open={id === 'open'} focus={id === 'focused'} />
							</div>
						</div>
					) : null
				})}
			</div>
		</div>
	)
}

/** A 900px dock with the `busy` day's queue (three items, six agents): the row stays one line. */
function NarrowView() {
	const snapshot = useMemo(() => scenarioSnapshot('busy'), [])
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: 900 }}>
			<div style={{ flex: '1 1 auto', minHeight: 0, background: 'var(--term-bg)' }} />
			<Dock snapshot={snapshot} />
		</div>
	)
}

const meta: Meta<typeof EntryView> = {
	title: 'Views/Agent dock agents entry',
	component: EntryView,
	globals: { viewport: { value: 'helm1280', isRotated: false } },
	parameters: {
		layout: 'fullscreen',
		viewport: { options: { helm1280: { name: 'Helm 1280×800', styles: { width: '1280px', height: '800px' } } } },
	},
}

export default meta
type Story = StoryObj<typeof EntryView>

/** `3 agents` and the bar: two working segments bright, the idle one faint. */
export const AgentsEntry: Story = { name: 'Agents entry' }

/** 0 / 1 / 3 (2 working) / 9 mixed / 12 capped / unknown / pane open / keyboard focus, rows 760px wide. */
export const States: StoryObj<typeof StatesView> = {
	render: () => <StatesView width={760} />,
	globals: { viewport: { value: 'states', isRotated: false } },
	parameters: {
		viewport: { options: { states: { name: 'States 900×420', styles: { width: '900px', height: '420px' } } } },
	},
}

/** A 900px dock with three items queued. */
export const Narrow: StoryObj<typeof NarrowView> = {
	name: 'Narrow 900',
	render: () => <NarrowView />,
}
