// D5 Contrast — the real production surfaces every variant mounts. Only framing lives here (cell size and labels,
// identical in every variant); the variants change tokens through <Proposal overrides> or a scoped rule.
import { composeStories } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import * as ReviewStories from '../../document-review/DocumentReview.stories'
import * as RemoteStories from '../../remote/RemoteWorkspace.stories'
import * as ButtonStories from '../../sidebar/Button.stories'
import * as FieldStories from '../../sidebar/Field.stories'
import * as SegmentedStories from '../../sidebar/Segmented.stories'
import * as SidebarStories from '../../sidebar/SidebarViews.stories'
import { SignalsWorkspace } from '../../signals/SignalsWorkspace'

const Sidebar = composeStories(SidebarStories)
const Buttons = composeStories(ButtonStories)
const Fields = composeStories(FieldStories)
const Segmented = composeStories(SegmentedStories)
const Remote = composeStories(RemoteStories)
const Review = composeStories(ReviewStories)

/** Framing only. The reused sidebar frames are full-viewport pages; here several share one board. The caption gets
 *  a fixed height so flipping variants of one question never shifts the stage. */
export const FRAME_CSS = `
.proposal[data-decision^="D5"] .proposal-caption { box-sizing: border-box; min-height: 102px; align-content: flex-start; }
.proposal-stage .d5-board { display: grid; gap: 16px; padding: 16px; justify-content: start; }
.proposal-stage .d5-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: start; }
.proposal-stage .d5-cell { display: grid; gap: 6px; min-width: 0; align-content: start; }
.proposal-stage .d5-label { color: var(--text-1); font: 12px / 18px var(--font-ui); }
.proposal-stage .d5-terminal { width: 1280px; height: 760px; overflow: hidden; border: 1px solid var(--hairline); }
.proposal-stage .d5-terminal #app { height: 760px; }
.proposal-stage .d5-sidebar > div { min-height: 0 !important; padding: 0 !important; display: block !important; background: none !important; }
.proposal-stage .d5-sidebar .sidebar { height: 640px !important; box-shadow: none !important; border: 1px solid var(--hairline); }
.proposal-stage .d5-primitives { width: max-content; min-width: 372px; display: grid; gap: 12px; padding: 16px; background: var(--pane); border: 1px solid var(--hairline); }
.proposal-stage .d5-state { color: var(--text-1); font: 11px / 16px var(--font-ui); }
.proposal-stage .d5-full { height: 760px; overflow: hidden; border: 1px solid var(--hairline); }
.proposal-stage .d5-full .document-review { height: 760px; }
.proposal-stage .d5-remote { width: 1280px; }
.proposal-stage .d5-full .remote-workspace { --remote-keyboard-height: 760px; }
`

export function Board({ children }: { children: ReactNode }) {
	return <div className="d5-board">{children}</div>
}

export function Row({ children }: { children: ReactNode }) {
	return <div className="d5-row">{children}</div>
}

export function Cell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
	return (
		<div className="d5-cell">
			<span className="d5-label">{label}</span>
			<div className={className}>{children}</div>
		</div>
	)
}

/** Terminal workspace with the Signals column on the left and the agent dock (real-case) under the terminal. */
export function SignalsAndDock({ label = 'Signals + agent dock (Views/Signals/Column)' }: { label?: string }) {
	return (
		<Cell label={label} className="d5-terminal">
			<SignalsWorkspace scenario="column" />
		</Cell>
	)
}

export function SidebarWorkList() {
	return (
		<Cell label="Sidebar · work list (Views/Sidebar/Work list)" className="d5-sidebar">
			<Sidebar.WorkList />
		</Cell>
	)
}

export function SidebarNewItem() {
	return (
		<Cell label="Sidebar · New item (Views/Sidebar/New item)" className="d5-sidebar">
			<Sidebar.NewItem />
		</Cell>
	)
}

export function SidebarSettings() {
	return (
		<Cell label="Sidebar · Settings (Views/Sidebar/Settings)" className="d5-sidebar">
			<Sidebar.Settings />
		</Cell>
	)
}

export function SidebarItemDetail() {
	return (
		<Cell label="Sidebar · detail položky (Views/Sidebar/Item detail)" className="d5-sidebar">
			<Sidebar.ItemDetail />
		</Cell>
	)
}

export function SidebarRunLimits() {
	return (
		<Cell label="Sidebar · Settings → Run limits (Views/Sidebar/Run limits settings)" className="d5-sidebar">
			<Sidebar.RunLimitsSettings />
		</Cell>
	)
}

/** Button primitives: the real StateGrid (rest, forced hover through `data-force-state`, focus, disabled, busy),
 *  the small size, and the agent picker's commit segment, which paints the same --accent-fill. */
export function ButtonPrimitives() {
	return (
		<Cell label="Primitives/Button · stavy (StateGrid)" className="d5-primitives">
			<Buttons.States />
			<span className="d5-state">Malé</span>
			<Buttons.Small />
			<span className="d5-state">Výběr agenta (Primitives/Segmented control/Commit)</span>
			<Segmented.Commit />
		</Cell>
	)
}

export function FieldPrimitives() {
	return (
		<Cell label="Primitives/Field · pole, select, přepínače" className="d5-primitives">
			<Fields.TextInputs />
			<Fields.Select />
			<Fields.Toggles />
		</Cell>
	)
}

/** Field primitives in the real StateGrid: rest, forced hover, focus and disabled. */
export function FieldStates() {
	return (
		<Cell label="Primitives/Field · stavy (StateGrid)" className="d5-primitives">
			<Fields.States />
		</Cell>
	)
}

/** Remote with literal assistant thinking (13px --text-2 reading text on the page). */
export function RemoteThinking() {
	return (
		<Cell label="Helm Remote · čtení s thinking (Views/Helm Remote/Reading)" className="d5-full d5-remote">
			<Remote.Reading />
		</Cell>
	)
}

export function ReviewLight() {
	return (
		<Cell label="Document review · světlý (Views/Document review/Editorial light)" className="d5-full">
			<Review.EditorialLight />
		</Cell>
	)
}

export function ReviewLightPassages() {
	return (
		<Cell
			label="Document review · světlý, konverzace (Views/Document review/Passage conversations light)"
			className="d5-full"
		>
			<Review.PassageConversationsLight />
		</Cell>
	)
}
