// Signals design exploration (Views / Signals): story-only presentation of "what the world wants
// from Jakub" — GitHub review requests, PR comments, CI and mail (Sentry alerts arrive as mail).
// It follows the agent dock's register (design §3.24): one typeface, bright/dim instead of weight,
// color on glyphs only, no cards, no box-drawing, key hints as words. Never imported by production.

import { type KeyboardEvent, type ReactNode, useState, useSyncExternalStore } from 'react'
import { Btn } from '../button'
import {
	type AgentChoice,
	DONE_TODAY_UNLISTED,
	NEW_AGENT_AGENTS,
	NEW_AGENT_PROMPT,
	type OwnerStatus,
	SEND_AGENTS,
	SEND_PROMPT,
	SIGNAL_ACTIONS,
	type Signal,
	type SignalKind,
	type SignalsState,
	type SignalsStore,
	newSignalCount,
} from './signals-fixtures'
import './signals.css'

export function useSignals(store: SignalsStore): SignalsState {
	return useSyncExternalStore(store.subscribe, store.get)
}

const KIND_GLYPH: Record<SignalKind, string> = {
	review: '◇',
	comments: '○',
	ci: '✗',
	sentry: '!',
	mail: '@',
}

const KIND_WORD: Record<SignalKind, string> = {
	review: 'Review request',
	comments: 'Comments',
	ci: 'CI',
	sentry: 'Sentry alert',
	mail: 'Mail',
}

/** Choice rows are radios like the dock's (a button per choice, one group). */
const RADIO = 'radio'
const RADIOGROUP = 'radiogroup'

const OWNER_GLYPH: Record<OwnerStatus, string> = { working: '✻', idle: '·', waiting: '?' }

export function formatAgo(minutes: number): string {
	if (minutes < 1) return 'now'
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const rest = minutes % 60
	return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}m`
}

/** Counts for headers and indicators: `3 need you · 2 managed`. */
export function signalsSummary(signals: readonly Signal[]): string {
	const fresh = newSignalCount(signals)
	const managed = signals.filter(signal => signal.section === 'managed').length
	const parts = [fresh === 0 ? 'nothing needs you' : `${fresh} need${fresh === 1 ? 's' : ''} you`]
	if (managed > 0) parts.push(`${managed} managed`)
	return parts.join(' · ')
}

function KindGlyph({ signal, toned = true }: { signal: Signal; toned?: boolean }) {
	return (
		<span className="signals-glyph" data-kind={toned ? signal.kind : undefined} aria-hidden="true">
			{KIND_GLYPH[signal.kind]}
		</span>
	)
}

function OwnerGlyph({ status }: { status: OwnerStatus }) {
	return (
		<span className="signals-glyph signals-owner" data-status={status} aria-hidden="true">
			{OWNER_GLYPH[status]}
		</span>
	)
}

/** The thread's line of what happened; a CI result inside it is a toned glyph (`CI ✓`). */
function What({ signal }: { signal: Signal }) {
	return (
		<span className="signals-td-what" title={signal.what}>
			{signal.what}
			{signal.ci ? (
				<span className="signals-ci" data-ci={signal.ci} aria-label={`CI ${signal.ci}`}>
					{' '}
					{signal.ci === 'pass' ? '✓' : signal.ci === 'fail' ? '✗' : '·'}
				</span>
			) : null}
		</span>
	)
}

/** Right-hand hint: the agent this thread is bound to (`?` = guessed from the repo, never auto). */
function agentHint(signal: Signal): string {
	if (signal.routed) return signal.routed.agent
	if (!signal.agent) return ''
	return signal.agentTier === 'repo' ? `${signal.agent}?` : signal.agent
}

function agentHintTitle(signal: Signal): string | undefined {
	if (signal.section === 'managed') return `Owner: ${signal.agent}`
	if (signal.routed) return `${signal.routed.how === 'sent' ? 'Sent to' : 'Started'} ${signal.routed.agent}`
	if (!signal.agent) return undefined
	switch (signal.agentTier) {
		case 'pr':
			return `${signal.agent} opened this PR`
		case 'branch':
			return `${signal.agent} works on a matching branch`
		default:
			return `Only the repo matches: ${signal.agent}. Never sent automatically`
	}
}

export function SignalRow({
	signal,
	selected,
	onSelect,
}: {
	signal: Signal
	selected: boolean
	onSelect(): void
}) {
	const closed = signal.section === 'snoozed' || signal.section === 'done'
	return (
		<li
			className="signals-tr"
			data-section={signal.section}
			data-selected={selected ? 'true' : undefined}
			aria-current={selected ? 'true' : undefined}
			title={`${KIND_WORD[signal.kind]} · ${signal.fullRef}`}
			onMouseDown={event => {
				// Selecting gives the surface the keys (j k p n …), without scrolling or a focus ring on the row.
				event.preventDefault()
				event.currentTarget.closest<HTMLElement>('section.signals, .agent-dock-pane')?.focus({ preventScroll: true })
				onSelect()
			}}
		>
			<span className="signals-edge" />
			{signal.section === 'managed' && signal.owner ? (
				<OwnerGlyph status={signal.owner.status} />
			) : (
				<KindGlyph signal={signal} toned={!closed} />
			)}
			<span className="signals-td-ref">{signal.ref}</span>
			<What signal={signal} />
			<span className="signals-td-age">
				{signal.routed ? (
					<span className="signals-receipt">
						<span className="signals-receipt-mark" aria-hidden="true">
							✓
						</span>{' '}
						{signal.routed.how} {formatAgo(signal.routed.agoMinutes)}
					</span>
				) : signal.section === 'managed' && signal.owner ? (
					signal.owner.at
				) : closed ? (
					signal.closed
				) : (
					formatAgo(signal.agoMinutes)
				)}
			</span>
			<span className="signals-td-agent" title={agentHintTitle(signal)}>
				{signal.routed ? <span className="signals-arrow">→ </span> : null}
				{agentHint(signal)}
			</span>
			<span className="signals-edge" />
		</li>
	)
}

/**
 * The three sections as one grid, so refs, ages and agents line up across them. `compact` folds
 * `snoozed · done` into its header line (the band and other tight placements).
 */
export function SignalsSections({
	store,
	compact = false,
	sections = ['needs', 'managed', 'closed'],
}: {
	store: SignalsStore
	compact?: boolean
	sections?: ReadonlyArray<'needs' | 'managed' | 'closed'>
}) {
	const state = useSignals(store)
	const needs = state.signals.filter(signal => signal.section === 'needs')
	const managed = state.signals.filter(signal => signal.section === 'managed')
	const snoozed = state.signals.filter(signal => signal.section === 'snoozed')
	const done = state.signals.filter(signal => signal.section === 'done')
	const row = (signal: Signal) => (
		<SignalRow
			key={signal.id}
			signal={signal}
			selected={state.selected === signal.id}
			onSelect={() => store.select(signal.id)}
		/>
	)
	const closedLabel = `Snoozed ${snoozed.length} · done today ${done.length + DONE_TODAY_UNLISTED}`
	return (
		<ul className="signals-table" aria-label="Signals">
			{sections.includes('needs') ? (
				<>
					<li className="signals-subhead" role="presentation">
						Needs you
					</li>
					{needs.length > 0 ? (
						needs.map(row)
					) : (
						<li className="signals-empty" role="presentation">
							Nothing needs you
						</li>
					)}
				</>
			) : null}
			{sections.includes('managed') ? (
				<>
					<li className="signals-subhead" role="presentation">
						Managed
					</li>
					{managed.length > 0 ? (
						managed.map(row)
					) : (
						<li className="signals-empty" role="presentation">
							Nothing is managed. m hands a thread to the dispatcher
						</li>
					)}
				</>
			) : null}
			{sections.includes('closed') ? (
				<>
					<li className="signals-subhead" role="presentation">
						{closedLabel}
					</li>
					{compact ? null : [...snoozed, ...done].map(row)}
				</>
			) : null}
		</ul>
	)
}

function Hint({ keys, pick, children }: { keys: string; pick?: boolean; children: ReactNode }) {
	return (
		<span className="signals-hint" data-hint={pick ? 'pick' : undefined}>
			<kbd>{keys}</kbd> {children}
		</span>
	)
}

/** The selected row's actions, as key hints (only the ones its section offers). */
export function SignalsHints({ store }: { store: SignalsStore }) {
	const state = useSignals(store)
	const signal = state.signals.find(entry => entry.id === state.selected)
	if (state.flow) return null
	return (
		<>
			{SIGNAL_ACTIONS.filter(action => signal && action.sections.includes(signal.section)).map(action => (
				<Hint key={action.key} keys={action.key}>
					{action.label}
				</Hint>
			))}
		</>
	)
}

export function SignalsNote({ store }: { store: SignalsStore }) {
	const state = useSignals(store)
	return state.note ? <span className="signals-note">{state.note}</span> : null
}

function onSurfaceKey(store: SignalsStore, event: KeyboardEvent<HTMLElement>) {
	if (event.metaKey || event.ctrlKey || event.altKey) return
	const target = event.target as HTMLElement
	// In the Agents pane the pane itself holds the keys; elsewhere the surface does.
	const surface = event.currentTarget.closest<HTMLElement>('.agent-dock-pane') ?? event.currentTarget
	const closeFlow = () => {
		event.preventDefault()
		event.stopPropagation()
		store.closeFlow()
		// The flow unmounts with the focused field; the list keeps the keys.
		requestAnimationFrame(() => surface.focus({ preventScroll: true }))
	}
	if (target.closest('textarea, input')) {
		if (event.key === 'Escape') closeFlow()
		return
	}
	if (event.key === 'Escape' && store.get().flow) {
		closeFlow()
		return
	}
	if (store.get().flow) return
	if (event.key === 'j' || event.key === 'ArrowDown') store.move(1)
	else if (event.key === 'k' || event.key === 'ArrowUp') store.move(-1)
	else if (/^[pnmtsdo]$/.test(event.key)) store.act(event.key)
	else return
	event.preventDefault()
}

/**
 * A whole Signals surface: header, the sections (or a routing flow), footer with the selected
 * row's key hints. `kind` only changes the header's words and padding; every placement shares it.
 */
export function SignalsSurface({
	store,
	kind,
	shortcut = '⌘⇧I',
	compact = false,
}: {
	store: SignalsStore
	kind: 'pane' | 'band' | 'sidebar'
	shortcut?: string
	compact?: boolean
}) {
	const state = useSignals(store)
	const flow = state.flow
	const flowSignal = flow ? state.signals.find(signal => signal.id === flow.id) : undefined
	return (
		<section
			className="signals"
			data-kind={kind}
			aria-label="Signals"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the surface takes the keys (j k p n m t s d o).
			tabIndex={0}
			onKeyDown={event => onSurfaceKey(store, event)}
		>
			{flow && flowSignal ? (
				flow.type === 'send' ? (
					<SendFlow signal={flowSignal} store={store} />
				) : (
					<NewAgentFlow signal={flowSignal} store={store} />
				)
			) : (
				<>
					<header className="signals-title">
						<span className="signals-title-text">
							<span className="signals-title-kind">Signals</span>
							<span className="signals-title-context">{signalsSummary(state.signals)}</span>
						</span>
						<kbd className="signals-title-key" title={`Close Signals (${shortcut})`}>
							{shortcut}
						</kbd>
					</header>
					<div className="signals-scroll">
						<SignalsSections store={store} compact={compact} />
					</div>
					<footer className="signals-foot">
						<span className="signals-foot-hints" aria-hidden="true">
							<SignalsHints store={store} />
						</span>
						<SignalsNote store={store} />
					</footer>
				</>
			)}
		</section>
	)
}

function FlowHeader({
	glyph,
	kind,
	context,
	onClose,
}: { glyph: string; kind: string; context: string; onClose(): void }) {
	return (
		<header className="signals-title">
			<span className="signals-title-text">
				<span className="signals-title-kind">
					<span className="signals-glyph" data-kind="flow" aria-hidden="true">
						{glyph}
					</span>
					{kind}
				</span>
				<span className="signals-title-context">{context}</span>
			</span>
			<button type="button" className="signals-title-btn" aria-label="Back to Signals" onClick={onClose}>
				esc
			</button>
		</header>
	)
}

/** An opened flow takes the keys (Esc back, 1–N, ⌘↵), as the dock's own panes do. */
const takeKeys = (node: HTMLDivElement | null) => node?.focus({ preventScroll: true })

/** Routing closes the flow with the focused element; the list (or the Agents pane) keeps the keys. */
function routeThenRefocus(from: Element | null, route: () => void) {
	const surface = from?.closest<HTMLElement>('.agent-dock-pane, section.signals')
	route()
	requestAnimationFrame(() => surface?.focus({ preventScroll: true }))
}

/** Keys inside a flow: 1–N pick (not while typing), ⌘↵ / Ctrl+Enter acts from anywhere in it. */
function flowKeys(count: number, onPick: (index: number) => void, onSubmit: (from: Element) => void) {
	return (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault()
			event.stopPropagation()
			onSubmit(event.currentTarget)
			return
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return
		if ((event.target as HTMLElement).closest('textarea, input')) return
		const digit = Number(event.key)
		if (Number.isInteger(digit) && digit >= 1 && digit <= count) {
			event.preventDefault()
			event.stopPropagation()
			onPick(digit - 1)
		}
	}
}

function AgentChoices({
	agents,
	picked,
	onPick,
}: {
	agents: readonly AgentChoice[]
	picked: number
	onPick(index: number): void
}) {
	return (
		<div className="signals-choices" role={RADIOGROUP} aria-label="Agent">
			{agents.map((agent, index) => (
				<button
					key={agent.name}
					type="button"
					role={RADIO}
					aria-checked={picked === index}
					className="signals-choice"
					onClick={() => onPick(index)}
				>
					<span className="signals-choice-mark" data-on={picked === index ? 'true' : undefined} />
					<span className="signals-choice-label">
						<OwnerGlyph status={agent.status} />
						{agent.name}
					</span>
					<span className="signals-choice-description">
						{[agent.project, agent.why, agent.since].filter(Boolean).join(' · ')}
					</span>
					<span className="signals-choice-n">{index + 1}</span>
				</button>
			))}
		</div>
	)
}

function PromptField({ label, initial }: { label: string; initial: string }) {
	const [value, setValue] = useState(initial)
	return (
		<label className="signals-prompt">
			<span className="signals-field-label">{label}</span>
			<textarea
				className="signals-prompt-input"
				value={value}
				spellCheck={false}
				onChange={event => setValue(event.target.value)}
			/>
		</label>
	)
}

/** C1: hand a thread to a running agent as its next prompt (prefilled, editable, fenced). */
function SendFlow({ signal, store }: { signal: Signal; store: SignalsStore }) {
	const [picked, setPicked] = useState(0)
	const agent = SEND_AGENTS[picked] ?? SEND_AGENTS[0]
	const send = (from: Element | null) =>
		routeThenRefocus(from, () => store.route(signal.id, agent?.name ?? 'agent', 'sent'))
	return (
		<div
			ref={takeKeys}
			tabIndex={-1}
			className="signals-flow-keys"
			onKeyDown={flowKeys(SEND_AGENTS.length, setPicked, send)}
		>
			<FlowHeader
				glyph="→"
				kind="Send to agent"
				context={`${signal.ref} · ${signal.what}`}
				onClose={() => store.closeFlow()}
			/>
			<div className="signals-scroll signals-flow">
				<span className="signals-field-label">To</span>
				<AgentChoices agents={SEND_AGENTS} picked={picked} onPick={setPicked} />
				<PromptField label="Prompt" initial={SEND_PROMPT} />
			</div>
			<footer className="signals-foot">
				<span className="signals-foot-hints" aria-hidden="true">
					<Hint keys="1–3" pick>
						pick
					</Hint>
					<Hint keys="⌘↵">send</Hint>
					<Hint keys="esc">back</Hint>
				</span>
				<span className="signals-note">Typed into {agent?.name}’s terminal as its next prompt</span>
				<span className="signals-foot-actions">
					<Btn
						tone="primary"
						sm
						className="signals-key"
						ariaKeyShortcuts="Meta+Enter"
						onClick={() => send(document.querySelector('.signals-flow-keys'))}
					>
						Send
					</Btn>
				</span>
			</footer>
		</div>
	)
}

/** C2: start a fresh agent in a new Okena worktree with the thread as its first prompt. */
function NewAgentFlow({ signal, store }: { signal: Signal; store: SignalsStore }) {
	const [picked, setPicked] = useState(0)
	const agent = NEW_AGENT_AGENTS[picked] ?? 'claude'
	const start = (from: Element | null) =>
		routeThenRefocus(from, () => store.route(signal.id, 'slots-typeerror', 'started'))
	return (
		<div
			ref={takeKeys}
			tabIndex={-1}
			className="signals-flow-keys"
			onKeyDown={flowKeys(NEW_AGENT_AGENTS.length, setPicked, start)}
		>
			<FlowHeader
				glyph="+"
				kind="New agent in Okena"
				context={`${signal.ref} · ${signal.what}`}
				onClose={() => store.closeFlow()}
			/>
			<div className="signals-scroll signals-flow">
				<dl className="signals-fields">
					<dt>Project</dt>
					<dd>
						psyon-admin <span className="signals-dim">· from the Sentry project</span>
					</dd>
					<dt>Worktree</dt>
					<dd>
						<span className="signals-mono">fix/slots-typeerror</span>{' '}
						<span className="signals-dim">· new, from main</span>
					</dd>
					<dt>Agent</dt>
					<dd>
						<span className="signals-inline-choices" role={RADIOGROUP} aria-label="Agent">
							{NEW_AGENT_AGENTS.map((name, index) => (
								<button
									key={name}
									type="button"
									role={RADIO}
									aria-checked={picked === index}
									className="signals-inline-choice"
									onClick={() => setPicked(index)}
								>
									<span className="signals-choice-mark" data-on={picked === index ? 'true' : undefined} />
									{name}
									<span className="signals-choice-n">{index + 1}</span>
								</button>
							))}
						</span>
					</dd>
				</dl>
				<PromptField label="Prompt" initial={NEW_AGENT_PROMPT} />
			</div>
			<footer className="signals-foot">
				<span className="signals-foot-hints" aria-hidden="true">
					<Hint keys="1–3" pick>
						agent
					</Hint>
					<Hint keys="⌘↵">start</Hint>
					<Hint keys="esc">back</Hint>
				</span>
				<span className="signals-note">Creates the worktree in Okena and starts {agent} there</span>
				<span className="signals-foot-actions">
					<Btn
						tone="primary"
						sm
						className="signals-key"
						ariaKeyShortcuts="Meta+Enter"
						onClick={() => start(document.querySelector('.signals-flow-keys'))}
					>
						Start agent
					</Btn>
				</span>
			</footer>
		</div>
	)
}

// ---------- resting indicators (B) ----------

/** B1: a dim count in the top bar, beside the Background stack; nothing at zero. */
export function TopbarCount({ store }: { store: SignalsStore }) {
	const count = newSignalCount(useSignals(store).signals)
	if (count === 0) return null
	return (
		<button
			type="button"
			className="signals-topbar-count"
			aria-label={`${count} new signals. Open Signals`}
			aria-keyshortcuts="Meta+Shift+I"
			title="Signals (⌘⇧I)"
		>
			{count} signals
		</button>
	)
}

/** B2: a `⌁3` token in the dock row, right before the Agents entry; nothing at zero. */
export function DockToken({ store }: { store: SignalsStore }) {
	const signals = useSignals(store).signals
	const count = newSignalCount(signals)
	if (count === 0) return null
	return (
		<div className="signals-dock-token-cell">
			<button
				type="button"
				className="signals-dock-token"
				aria-label={`${count} new signals. Open Signals`}
				aria-keyshortcuts="Meta+Shift+I"
				title={`${signalsSummary(signals)} (⌘⇧I)`}
			>
				<span className="signals-dock-token-glyph" aria-hidden="true">
					⌁
				</span>
				{count}
			</button>
		</div>
	)
}

/** B4: nothing at rest; arrivals raise one toast (the production toast's look), then it goes. */
export function ArrivalToast({ store }: { store: SignalsStore }) {
	const signals = useSignals(store).signals
	const fresh = signals.filter(signal => signal.section === 'needs' && !signal.routed)
	if (fresh.length === 0) return null
	return (
		<output id="toasts" className="signals-toasts" aria-live="polite">
			<div className="toast shown">
				<div className="toast-body">
					<div className="toast-msg">
						{fresh.length} new signal{fresh.length === 1 ? '' : 's'}
					</div>
					<div className="toast-detail">{fresh.map(signal => signal.ref).join(' · ')}</div>
				</div>
				<Btn tone="ghost" sm className="toast-action">
					Open ⌘⇧I
				</Btn>
			</div>
		</output>
	)
}

/** A2: footer key hints for the Agents pane while a Signals row is selected. */
export function AgentsPaneHints({ store }: { store: SignalsStore }) {
	return (
		<>
			<SignalsHints store={store} />
			<Hint keys="esc">close</Hint>
		</>
	)
}

/** A2: the Signals groups inside the Agents pane (no header of their own; the pane names itself Agents). */
export function AgentsPaneSection({ store }: { store: SignalsStore }) {
	const state = useSignals(store)
	const flow = state.flow
	const flowSignal = flow ? state.signals.find(signal => signal.id === flow.id) : undefined
	if (flow && flowSignal)
		return (
			<div
				className="signals signals-in-agents"
				data-kind="agents-flow"
				onKeyDown={event => onSurfaceKey(store, event)}
			>
				{flow.type === 'send' ? (
					<SendFlow signal={flowSignal} store={store} />
				) : (
					<NewAgentFlow signal={flowSignal} store={store} />
				)}
			</div>
		)
	return (
		<div className="signals signals-in-agents" data-kind="agents" onKeyDown={event => onSurfaceKey(store, event)}>
			<SignalsSections store={store} compact />
			<SignalsNote store={store} />
		</div>
	)
}
