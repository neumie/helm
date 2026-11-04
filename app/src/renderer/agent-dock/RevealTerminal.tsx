// "Show terminal" (design §3.24): from an item's pane or an agent's detail, bring up the terminal the
// agent runs in — an Okena pane (Okena focuses it, Helm raises the app) or a Helm terminal (its tab,
// focused, frame pulsed). One mechanism (AgentDock `reveal`, ⌘O from anywhere in the pane); its look is
// the header's where text as a link-like token, a bare `Okena ↗` after the kind (an
// item pane) or `Okena ↗` leading the agent detail's where line, with a dim `⌘O` after it while the
// pane holds the keys (stories: Views / Agent dock reveal terminal).
import type { DockRevealTarget } from '../../agent-dock/reveal'
import { revealLabel } from '../../agent-dock/reveal'
import { type DockModKey, revealShortcut } from './pane-keys'

/** What a pane body needs to offer "Show terminal" (null where there is nothing to show). */
export interface RevealView {
	target: DockRevealTarget
	mod: DockModKey
	/** The request is on its way (Okena: main focusing and raising the app). */
	busy: boolean
	/** The agent's short name: the where token says whose terminal. */
	name: string
	onReveal(): void
}

const sourceWord = (target: DockRevealTarget): string => (target.kind === 'okena' ? 'Okena' : 'Terminal')

/**
 * The header's where text as a link to the agent's terminal: a bare `Okena ↗` / `Terminal ↗` (Jakub: no
 * agent name in the link), in an item pane or leading the agent detail's where line; its key hint follows while the
 * pane holds the keys, dim and bare like the row's ⌘⇧J (aria-hidden; the link carries
 * aria-keyshortcuts).
 */
export function RevealWhere({ view }: { view: RevealView | null }) {
	if (!view) return null
	const key = revealShortcut(view.mod)
	return (
		<span className="agent-dock-reveal-where">
			<button
				type="button"
				className="agent-dock-reveal-link"
				// VoiceOver: the act and whose terminal, not the bare token ("Okena service-date-and-people").
				aria-label={`${revealLabel(view.target)}, ${view.name}`}
				aria-keyshortcuts={key.aria}
				title={`${revealLabel(view.target)} (${key.label})`}
				disabled={view.busy}
				onClick={view.onReveal}
			>
				{sourceWord(view.target)} <span aria-hidden="true">↗</span>
			</button>
			<span className="agent-dock-title-hint" aria-hidden="true">
				<kbd data-face={key.label.startsWith('⌘') ? 'symbols' : undefined}>{key.label}</kbd>
			</span>
		</span>
	)
}
