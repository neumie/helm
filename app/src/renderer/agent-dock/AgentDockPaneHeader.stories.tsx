import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ReactNode, useMemo } from 'react'
import type { AgentDockSnapshot, DockItem, DockSession } from '../../agent-dock/model'
import { AgentDock } from './AgentDock'
import { createAgentDockFixture } from './agent-dock-fixtures'

/**
 * The item pane's header (design §3.24; Jakub picked "with task title", 2026-11-05): what, then whose,
 * then the task — `↵ Turn ended · Psyon · fakturoid-digisign-errors — <task title>   Okena ↗ ⌘O … ‹ 1/3 › esc`.
 * The question's context stays next to the kind (`? Question  Jeřáb · JVS · …`). The task title gives way
 * first and drops whole once it would be a stub (`useTaskTitleRoom`; always under a 640px pane), then the
 * agent's name truncates; full texts stay in the tooltips.
 *
 * Cases (the `reveal-okena` snapshot with its two agents restated): a Psyon turn with a Czech task title,
 * a JVS question (context `Jeřáb`) whose Okena pane name is a very long Czech task title, the same JVS
 * agent's turn, and an agent with no project and no task title. At a normal 960px dock, at 680px (where
 * the long title drops rather than shrinking to a stub) and at a narrow 560px one.
 */

type Case = 'psyon-turn' | 'jvs-question' | 'jvs-turn' | 'no-project'
const CASES: ReadonlyArray<{ id: Case; label: string }> = [
	{ id: 'psyon-turn', label: 'Psyon turn' },
	{ id: 'jvs-question', label: 'JVS question + context' },
	{ id: 'jvs-turn', label: 'JVS turn · long title' },
	{ id: 'no-project', label: 'no project, no title' },
]

const PSYON_TITLE = 'Fakturoid: chyby z podpisu přes DigiSign se nezobrazují v detailu faktury (ClientCare #4417)'
const JVS_TITLE =
	'Mobilní aplikace, Na fotce při přiřazení projektu to neukazuje o jaký jeřáb jde, takže technik musí otevírat detail projektu a hledat jeřáb podle čísla zakázky (ClientCare #5126)'

/** Who each agent is, as Okena reports it: a worktree of its repository, named after its task. */
const psyon = (session: DockSession): DockSession => ({
	...session,
	repo: 'Psyon',
	project: 'fix/fakturoid-digisign-errors',
	branch: 'fix/fakturoid-digisign-errors',
	name: PSYON_TITLE,
})
const jvs = (session: DockSession): DockSession => ({
	...session,
	repo: 'JVS',
	project: 'feat/mobile-project-crane-search',
	branch: 'feat/mobile-project-crane-search',
	name: JVS_TITLE,
})
/** No repository Okena knows and no pane name: only the branch names it. */
const bare = (session: DockSession): DockSession => ({
	...session,
	repo: undefined,
	project: '',
	branch: 'fix/fakturoid-digisign-errors',
	name: '',
})

/** A single AskUserQuestion with a short header (the header's context), in Czech. */
const craneQuestion = (item: DockItem): DockItem =>
	item.fact.kind === 'ask'
		? {
				...item,
				fact: {
					...item.fact,
					input: {
						questions: [
							{
								question: 'Co ukázat na fotce u přiřazení projektu, aby technik poznal jeřáb?',
								header: 'Jeřáb',
								multiSelect: false,
								options: [
									{ label: 'Typ a evidenční číslo', description: 'Liebherr LTM 1060 · EV 214' },
									{ label: 'Jen evidenční číslo', description: 'EV 214' },
									{ label: 'Typ, číslo a fotka jeřábu', description: 'Náhled z karty jeřábu' },
								],
							},
						],
					},
				},
			}
		: item

let base: AgentDockSnapshot | null = null
/** `reveal-okena` through the real reducer: a turn and a question from two Okena agents, plus one working. */
function baseSnapshot(): AgentDockSnapshot {
	if (base) return base
	const stop = createAgentDockFixture('reveal-okena').api.onSnapshot(next => {
		base = next
	})
	stop()
	if (!base) throw new Error('no snapshot for reveal-okena')
	return base
}

function caseSnapshot(id: Case): { snapshot: AgentDockSnapshot; open: number } {
	const shot = baseSnapshot()
	const turn = shot.items.find(item => item.fact.kind === 'turn')
	const ask = shot.items.find(item => item.fact.kind === 'ask')
	if (!turn || !ask) throw new Error('reveal-okena lost its turn or question')
	const restate = (turnWho: (s: DockSession) => DockSession, askWho: (s: DockSession) => DockSession) =>
		shot.sessions.map(session =>
			session.key === turn.session ? turnWho(session) : session.key === ask.session ? askWho(session) : session,
		)
	const items = shot.items.map(item => (item.id === ask.id ? craneQuestion(item) : item))
	switch (id) {
		case 'psyon-turn':
			return { snapshot: { ...shot, items, sessions: restate(psyon, jvs) }, open: turn.id }
		case 'jvs-question':
			return { snapshot: { ...shot, items, sessions: restate(psyon, jvs) }, open: ask.id }
		case 'jvs-turn':
			return { snapshot: { ...shot, items, sessions: restate(jvs, psyon) }, open: turn.id }
		case 'no-project':
			return { snapshot: { ...shot, items, sessions: restate(bare, jvs) }, open: turn.id }
	}
}

/** One production dock, its item pane open, under a sliver of terminal. */
function Dock({ scenario, width }: { scenario: Case; width: number }) {
	const { snapshot, open } = useMemo(() => caseSnapshot(scenario), [scenario])
	return (
		<div style={{ width, display: 'flex', flexDirection: 'column' }}>
			<div style={{ height: 12, background: 'var(--term-bg)' }} />
			<div className="agent-dock" data-position="bottom">
				<div className="agent-dock-view">
					<AgentDock
						snapshot={snapshot}
						now={Date.now()}
						position="bottom"
						mod="cmd"
						initialOpen={{ type: 'item', id: open }}
						onAck={async () => false}
						onReveal={async () => ({ ok: true, activated: true })}
					/>
				</div>
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
			margin: '16px 0 4px',
		}}
	>
		{children}
	</div>
)

const Canvas = ({ children }: { children: ReactNode }) => (
	<div style={{ padding: 24, background: 'var(--term-bg)', minHeight: '100vh', boxSizing: 'border-box' }}>
		{children}
	</div>
)

/** Every case stacked at one dock width. */
function HeaderView({ width }: { width: number }) {
	return (
		<Canvas>
			{CASES.map(({ id, label }) => (
				<div key={id}>
					<Label>
						{label} · {width}px
					</Label>
					<Dock scenario={id} width={width} />
				</div>
			))}
		</Canvas>
	)
}

const meta: Meta<typeof HeaderView> = {
	title: 'Views/Agent dock pane header',
	component: HeaderView,
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof HeaderView>

/** A normal 960px dock: every part of whose; a long task title truncates first. */
export const Normal: Story = { name: 'Normal · 960px', args: { width: 960 } }
/** 680px: too little room for a readable task title, so it drops whole (no `Mobilní a…` stub). */
export const Between: Story = { name: 'Between · 680px', args: { width: 680 } }
/** A narrow 560px dock: under 640px the task title always drops; the name truncates after it. */
export const Narrow: Story = { name: 'Narrow · 560px', args: { width: 560 } }
