import type { Meta, StoryObj } from '@storybook/react-vite'
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef } from 'react'
import type { AgentDockSnapshot, DockSession } from '../../agent-dock/model'
import { AgentDock } from './AgentDock'
import { type AgentDockScenario, createAgentDockFixture } from './agent-dock-fixtures'
import { AGENTS_ENTRY_VARIANTS, type AgentsEntryVariant } from './agents-entry'

/**
 * Candidate looks for the Agents entry at the row's right end (story-only: `data-agents-entry` on the
 * dock; production keeps the current entry until Jakub picks). The real AgentDock over reducer-built
 * snapshots; only the agents' statuses are restated so every variant shows the same counts.
 */

type Status = DockSession['status']
type Variant = AgentsEntryVariant | 'current'
const VARIANTS: readonly Variant[] = ['current', ...AGENTS_ENTRY_VARIANTS]

const VARIANT_NOTES: Record<Variant, string> = {
	current: 'current — agents 3 · 2 busy',
	E1: 'E1 plain text',
	E2: 'E2 glyph tally',
	E3: 'E3 counts by state',
	E4: 'E4 label + glyph counts',
	E5: 'E5 joined to the row end',
	E6: 'E6 count + segment bar',
}

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

type Case = 'none' | 'one' | 'three' | 'nine' | 'unknown' | 'open'
const CASES: ReadonlyArray<{ id: Case; note: string }> = [
	{ id: 'none', note: '0 agents' },
	{ id: 'one', note: '1 agent' },
	{ id: 'three', note: '3 · 2 working' },
	{ id: 'nine', note: '9 mixed' },
	{ id: 'unknown', note: '1 unknown' },
	{ id: 'open', note: 'pane open' },
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
		case 'unknown':
			return agentsSnapshot(['idle', 'working', 'unknown'])
		default:
			return agentsSnapshot(['idle', 'working', 'working'])
	}
}

/** One production dock (row, and the pane when open) with the variant on its `.agent-dock`. */
function Dock({
	variant,
	snapshot,
	open = false,
	focus = false,
	style,
}: {
	variant: Variant
	snapshot: AgentDockSnapshot
	open?: boolean
	focus?: boolean
	style?: CSSProperties
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
		<div
			ref={ref}
			className="agent-dock"
			data-position="bottom"
			data-agents-entry={variant === 'current' ? undefined : variant}
			style={style}
		>
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

const Label = ({ children, strong = false }: { children: ReactNode; strong?: boolean }) => (
	<div
		style={{
			font: '11px/16px -apple-system, BlinkMacSystemFont, sans-serif',
			color: strong ? 'var(--text-0)' : 'var(--text-2)',
			whiteSpace: 'nowrap',
		}}
	>
		{children}
	</div>
)

/** The normal case under a terminal at Helm's width: three agents, two working, one idle with a turn. */
function VariantView({ variant, focus = false }: { variant: Variant; focus?: boolean }) {
	const snapshot = useMemo(() => caseSnapshot('three'), [])
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
			<div style={{ flex: '1 1 auto', minHeight: 0, background: 'var(--term-bg)' }} />
			<Dock variant={variant} snapshot={snapshot} focus={focus} />
		</div>
	)
}

/** Each variant across the cases, stacked: the row's right end lines up so they compare at a glance. */
function MatrixView({ width }: { width: number }) {
	const snapshots = useMemo(() => new Map(CASES.map(({ id }) => [id, caseSnapshot(id)])), [])
	return (
		<div style={{ padding: 24, background: 'var(--term-bg)', minHeight: '100vh', boxSizing: 'border-box' }}>
			<div style={{ display: 'grid', gridTemplateColumns: `96px ${width}px`, columnGap: 16, rowGap: 6 }}>
				{VARIANTS.map(variant => (
					<div key={variant} style={{ display: 'contents' }}>
						<div style={{ gridColumn: '1 / -1', paddingTop: 14 }}>
							<Label strong>{VARIANT_NOTES[variant]}</Label>
						</div>
						{CASES.map(({ id, note }) => {
							const snapshot = snapshots.get(id)
							return snapshot ? (
								<div key={id} style={{ display: 'contents' }}>
									<div style={{ alignSelf: 'center' }}>
										<Label>{note}</Label>
									</div>
									{/* The pane opens above the row: only the row shows here. */}
									<div style={{ height: 28, overflow: 'hidden', display: 'flex', flexDirection: 'column-reverse' }}>
										<Dock variant={variant} snapshot={snapshot} open={id === 'open'} />
									</div>
								</div>
							) : null
						})}
					</div>
				))}
			</div>
		</div>
	)
}

/** Every variant at 900px with the `busy` day's queue (three items, six agents): the row stays one line. */
function NarrowView() {
	const snapshot = useMemo(() => scenarioSnapshot('busy'), [])
	return (
		<div style={{ padding: '24px 0', background: 'var(--term-bg)', minHeight: '100vh', boxSizing: 'border-box' }}>
			<div style={{ display: 'grid', rowGap: 6, width: 900 }}>
				{VARIANTS.map(variant => (
					<div key={variant}>
						<div style={{ padding: '10px 16px 4px' }}>
							<Label strong>{VARIANT_NOTES[variant]}</Label>
						</div>
						<Dock variant={variant} snapshot={snapshot} />
					</div>
				))}
			</div>
		</div>
	)
}

const meta: Meta<typeof VariantView> = {
	title: 'Views/Agent dock agents entry',
	component: VariantView,
	globals: { viewport: { value: 'helm1280', isRotated: false } },
	parameters: {
		layout: 'fullscreen',
		viewport: { options: { helm1280: { name: 'Helm 1280×800', styles: { width: '1280px', height: '800px' } } } },
	},
	argTypes: { variant: { control: 'inline-radio', options: VARIANTS } },
}

export default meta
type Story = StoryObj<typeof VariantView>

/** Today's entry, for comparison: `agents 3 · 2 busy`. */
export const Current: Story = { args: { variant: 'current' } }
/** E1: plain words on --chrome like the entries beside it, counts brighter: `3 agents · 2 busy`. */
export const E1PlainText: Story = { name: 'E1 plain text', args: { variant: 'E1' } }
/** E2: one status glyph per agent (✻ ✻ ·), toned as in the Agents pane; past 8, `+N`. Words live in the label. */
export const E2GlyphTally: Story = { name: 'E2 glyph tally', args: { variant: 'E2' } }
/** E3: glyph and count for each state present (`✻ 2  · 1`), no word. */
export const E3CountsByState: Story = { name: 'E3 counts by state', args: { variant: 'E3' } }
/** E4: `Agents` bright, then the states dim and tight (`✻2 ·1`). */
export const E4LabelAndCounts: Story = { name: 'E4 label + glyph counts', args: { variant: 'E4' } }
/** E5: `2/3 busy` joins Okena's dot and ⌘⇧J as one trailing group behind a short hairline. */
export const E5RowEnd: Story = { name: 'E5 joined to the row end', args: { variant: 'E5' } }
/** E6: the count, then a 2px bar with one segment per agent (busy bright, idle faint, attention amber). */
export const E6SegmentBar: Story = { name: 'E6 count + segment bar', args: { variant: 'E6' } }

/** Keyboard focus on the Agents entry (pick the variant): the selected fill, and the accent edge. */
export const Focused: Story = { args: { variant: 'E1', focus: true } }

/** All variants × 0 / 1 / 3 (2 working) / 9 mixed / unknown / pane open, rows 760px wide. */
export const Matrix: StoryObj<typeof MatrixView> = {
	render: () => <MatrixView width={760} />,
	globals: { viewport: { value: 'matrix', isRotated: false } },
	parameters: {
		viewport: { options: { matrix: { name: 'Matrix 940×1700', styles: { width: '940px', height: '1700px' } } } },
	},
}

/** All variants in a 900px dock with three items queued. */
export const Narrow: StoryObj<typeof NarrowView> = {
	name: 'Narrow 900',
	render: () => <NarrowView />,
}
