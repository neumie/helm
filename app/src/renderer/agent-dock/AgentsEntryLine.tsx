// The Agents entry's line in one of the candidate looks (agents-entry.ts). Story-only until Jakub picks:
// the row reads `data-agents-entry` off #agent-dock and keeps the current line without it.
import { useLayoutEffect, useState } from 'react'
import type { DockSession } from '../../agent-dock/model'
import {
	AGENTS_BAR_MAX,
	type AgentsEntryVariant,
	type AgentsTally,
	agentsEntryVariant,
	isWarnState,
	shownMarks,
} from './agents-entry'
import { statusGlyph } from './presentation'

/** The variant #agent-dock asks for (`data-agents-entry`), followed live; null keeps the current entry. */
export function useAgentsEntryVariant(node: HTMLElement | null): AgentsEntryVariant | null {
	const [variant, setVariant] = useState<AgentsEntryVariant | null>(null)
	useLayoutEffect(() => {
		const dock = node?.closest<HTMLElement>('.agent-dock')
		if (!dock) return
		const read = () => setVariant(agentsEntryVariant(dock.dataset.agentsEntry))
		read()
		const observer = new MutationObserver(read)
		observer.observe(dock, { attributes: true, attributeFilter: ['data-agents-entry'] })
		return () => observer.disconnect()
	}, [node])
	return variant
}

const Mark = ({ status }: { status: DockSession['status'] }) => (
	<span className="agent-dock-agents-mark" data-status={status}>
		{statusGlyph(status)}
	</span>
)

const Count = ({ n }: { n: number }) => <span className="agent-dock-agents-n">{n}</span>

/** `· N unknown`, toned, while items show (as the current entry). */
const Unknown = ({ unknown }: { unknown: number }) =>
	unknown > 0 ? <span className="agent-dock-agents-unknown">· {unknown} unknown</span> : null

/**
 * The entry's words and marks for `variant`. Everything here is aria-hidden: the button's label carries
 * the states in words. `unknown` is the count the row names while items show.
 */
export function AgentsEntryLine({
	variant,
	tally,
	unknown,
}: {
	variant: AgentsEntryVariant
	tally: AgentsTally
	unknown: number
}) {
	if (tally.total === 0)
		return variant === 'E4' ? (
			<>
				<span className="agent-dock-agents-title">Agents</span>
				<span>none</span>
			</>
		) : (
			<span>no agents</span>
		)
	switch (variant) {
		case 'E1':
			return (
				<>
					<span>
						<Count n={tally.total} /> agent{tally.total === 1 ? '' : 's'}
					</span>
					{tally.busy > 0 ? (
						<span>
							· <Count n={tally.busy} /> busy
						</span>
					) : null}
					<Unknown unknown={unknown} />
				</>
			)
		case 'E2': {
			const { shown, rest } = shownMarks(tally.marks)
			return (
				<span className="agent-dock-agents-marks">
					{shown.map((status, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: marks are positional, one per agent in order.
						<Mark key={at} status={status} />
					))}
					{rest.length > 0 ? (
						<span className="agent-dock-agents-rest" data-tone={rest.some(isWarnState) ? 'warn' : undefined}>
							+{rest.length}
						</span>
					) : null}
				</span>
			)
		}
		case 'E3':
			return (
				<>
					{tally.states.map(state => (
						<span key={state.status} className="agent-dock-agents-state">
							<Mark status={state.status} />
							<Count n={state.count} />
						</span>
					))}
				</>
			)
		case 'E4':
			return (
				<>
					<span className="agent-dock-agents-title">Agents</span>
					<span className="agent-dock-agents-states">
						{tally.states.map(state => (
							<span key={state.status} className="agent-dock-agents-state" data-status={state.status}>
								<Mark status={state.status} />
								<span className="agent-dock-agents-count">{state.count}</span>
							</span>
						))}
					</span>
				</>
			)
		case 'E5':
			return (
				<>
					{tally.busy > 0 ? (
						<span>
							<Count n={tally.busy} />/{tally.total} busy
						</span>
					) : (
						<span>
							<Count n={tally.total} /> agent{tally.total === 1 ? '' : 's'}
						</span>
					)}
					<Unknown unknown={unknown} />
				</>
			)
		case 'E6': {
			const capped = tally.marks.length > AGENTS_BAR_MAX
			return (
				<>
					<span>
						<Count n={tally.total} /> agent{tally.total === 1 ? '' : 's'}
					</span>
					<span
						className="agent-dock-agents-bar"
						data-capped={capped ? 'true' : undefined}
						style={capped ? undefined : { width: `${tally.marks.length * 10 - 2}px` }}
					>
						{tally.marks.map((status, at) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional, one per agent in order.
							<span key={at} className="agent-dock-agents-seg" data-status={status} />
						))}
					</span>
				</>
			)
		}
	}
}
