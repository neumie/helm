// "Show terminal" (design §3.24): from an item's pane or an agent's detail, bring up the terminal the
// agent runs in — an Okena pane (Okena focuses it, Helm raises the app) or a Helm terminal (its tab,
// focused, frame pulsed). One mechanism (AgentDock `reveal`, ⌘O from anywhere in the pane); its look
// is Jakub's pick, three variants (stories: Views / Agent dock reveal terminal):
//   button  a quiet footer key left of Ack / Send ("Show in Okena", "Show terminal") — production default
//   where   the header's where text as a link-like token ("Okena ↗ service-date-and-people")
//   hint    no control: a clickable `⌘O terminal` hint in the footer's hint row, always shown
import type { DockRevealTarget } from '../../agent-dock/reveal'
import { revealLabel } from '../../agent-dock/reveal'
import { Hint, Key } from './pane-chrome'
import { type DockModKey, revealShortcut } from './pane-keys'

export type RevealAffordance = 'button' | 'where' | 'hint'

/** What a pane body needs to offer "Show terminal" (null where there is nothing to show). */
export interface RevealView {
	target: DockRevealTarget
	affordance: RevealAffordance
	mod: DockModKey
	/** The request is on its way (Okena: main focusing and raising the app). */
	busy: boolean
	/** The agent's short name: the where token says whose terminal. */
	name: string
	onReveal(): void
}

const sourceWord = (target: DockRevealTarget): string => (target.kind === 'okena' ? 'Okena' : 'Terminal')

/** The control's accessible name and tooltip: what happens and its key. */
function revealTitle(view: RevealView): string {
	return `${revealLabel(view.target)} (${revealShortcut(view.mod).label})`
}

/** Variant `button`: a quiet footer key, left of Ack / Send. */
export function RevealButton({ view }: { view: RevealView | null }) {
	if (!view || view.affordance !== 'button') return null
	return (
		<Key
			tone="quiet"
			busy={view.busy}
			keyShortcuts={revealShortcut(view.mod).aria}
			title={revealTitle(view)}
			onClick={view.onReveal}
		>
			{revealLabel(view.target)}
		</Key>
	)
}

/**
 * The footer hint: `⌘O terminal`. Variant `button`: a plain key hint like the others (shown while the
 * pane holds the keys). Variant `hint`: the only affordance, so it is always shown and clickable (a
 * pointer target only — the hint row is aria-hidden; the pane's ⌘O and aria-keyshortcuts serve the
 * keyboard and screen readers).
 */
export function RevealHint({ view }: { view: RevealView | null }) {
	if (!view || view.affordance === 'where') return null
	const key = revealShortcut(view.mod).label
	if (view.affordance === 'button') return <Hint keys={key}>terminal</Hint>
	return (
		<button
			type="button"
			className="agent-dock-hint agent-dock-reveal-hint"
			tabIndex={-1}
			title={revealTitle(view)}
			disabled={view.busy}
			onClick={view.onReveal}
		>
			<kbd data-face={key.startsWith('⌘') ? 'symbols' : undefined}>{key}</kbd> terminal
		</button>
	)
}

/**
 * Variant `where`: the header's where text as a link-like token, `Okena ↗ name` (an item pane) or
 * `Okena ↗` leading the agent detail's where line; its key hint follows while the pane holds the keys.
 */
export function RevealWhere({ view, withName = true }: { view: RevealView | null; withName?: boolean }) {
	if (!view || view.affordance !== 'where') return null
	const key = revealShortcut(view.mod)
	return (
		<span className="agent-dock-reveal-where">
			<button
				type="button"
				className="agent-dock-reveal-link"
				aria-keyshortcuts={key.aria}
				title={revealTitle(view)}
				disabled={view.busy}
				onClick={view.onReveal}
			>
				{sourceWord(view.target)} <span aria-hidden="true">↗</span>
				{withName ? ` ${view.name}` : ''}
			</button>
			<span className="agent-dock-title-hint" aria-hidden="true">
				<kbd data-face={key.label.startsWith('⌘') ? 'symbols' : undefined}>{key.label}</kbd>
			</span>
		</span>
	)
}
