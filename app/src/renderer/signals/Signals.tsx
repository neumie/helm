// Signals column (design §3.25): what the world wants from Jakub — GitHub review requests,
// comments and failed CI on his PRs, mentions, mail (Sentry alerts arrive as mail) — in the task
// sidebar's column. The agent dock's register (§3.24): one typeface, bright/dim instead of weight,
// color on glyphs only, no cards, no box-drawing, key hints as words. Data and effects come from
// injected services (services.ts); row text, matching and prompts from the pure model.ts.

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentDockSnapshot } from '../../agent-dock/model'
import type { SignalOkenaProject } from '../../shared'
import type { SignalThread } from '../../shared-helm'
import { statusGlyph } from '../agent-dock/presentation'
import { Btn } from '../button'
import { IconBtn } from '../icon-button'
import { GLYPH } from '../sidebar/ui'
import {
	type AgentMatch,
	PICK_MAX,
	type SignalActionKey,
	type SignalSections,
	actionNote,
	actionPatch,
	allSourcesOk,
	closedHeader,
	defaultAgentPick,
	following,
	healthLines,
	keepSelection,
	matchAgents,
	newAgentPrompt,
	orderedRows,
	sendPrompt,
	signalRowView,
	signalSection,
	signalSections,
	signalsSummary,
	suggestBranch,
	threadActions,
} from './model'
import type { DockService, SignalsService } from './services'

/** Re-render ages while nothing else changes. */
const AGE_TICK_MS = 30_000

export interface SignalsColumnProps {
	service: SignalsService
	dock: DockService
	/** The header's "Show tasks" button: switch the column to the task sidebar. */
	onShowTasks(): void
	/** Esc on the list: hand the keys back to the terminal. */
	onLeave?(): void
	/** `cmd` on macOS (⌘↵), else `ctrl`. */
	mod?: 'cmd' | 'ctrl'
	now?: () => number
	/** Review fixtures only: the row selected and the flow open on first render. */
	initialSelected?: number
	initialFlow?: SignalsFlow
}

export type SignalsFlow = { type: 'send' | 'new-agent'; id: number } | null

/** What a flow's attempt (the dock prompt / the Okena start) came back with. */
export type RouteAttempt =
	| { failed: string }
	| {
			agent: string
			how: 'sent' | 'started'
			/** Note once the receipt is saved. */
			done: string
			/** Note when the effect happened but the receipt could not be saved. */
			unsaved(error: string): string
	  }

/**
 * One routing effect (`p` send / `n` start), owned by the column rather than the flow: Esc or the
 * thread leaving the snapshot may close the flow while it runs, and the late success still saves its
 * receipt (`service.routed`) and lands in the column's note. One at a time: no double submit.
 */
export interface RouteJob {
	id: number
	type: 'send' | 'new-agent'
	/** `Starting agent…`: the footer says `… (still running)` once the flow is closed. */
	label: string
	attempt(): Promise<RouteAttempt>
	/** The flow instance that submitted it is still mounted: a failure goes back to it. */
	flowAlive(): boolean
}

/** The column's route runner: resolves with a failure note for a still-mounted flow, else null. */
export type RouteRunner = (job: RouteJob) => Promise<string | null>

/** Daemon threads, with the threads an action just returned laid over them until a newer push. */
function mergeThreads(threads: readonly SignalThread[], overrides: ReadonlyMap<number, SignalThread>): SignalThread[] {
	if (overrides.size === 0) return [...threads]
	return threads.map(thread => {
		const override = overrides.get(thread.id)
		return override && Date.parse(override.updatedAt) > Date.parse(thread.updatedAt) ? override : thread
	})
}

function Hint({ keys, pick, children }: { keys: string; pick?: boolean; children: string }) {
	return (
		<span className="signals-hint" data-hint={pick ? 'pick' : undefined}>
			<kbd>{keys}</kbd> {children}
		</span>
	)
}

function SignalRow({
	thread,
	snapshot,
	now,
	selected,
	onSelect,
}: {
	thread: SignalThread
	snapshot: AgentDockSnapshot | null
	now: number
	selected: boolean
	onSelect(): void
}) {
	const view = signalRowView(thread, snapshot, now)
	const section = signalSection(thread, now) ?? 'done'
	return (
		<li
			className="signals-tr"
			data-section={section}
			data-signal-id={thread.id}
			data-selected={selected ? 'true' : undefined}
			aria-current={selected ? 'true' : undefined}
			title={view.title}
			onMouseDown={event => {
				// Selecting gives the surface the keys (j k p n …), without scrolling or a focus ring on the row.
				event.preventDefault()
				event.currentTarget.closest<HTMLElement>('section.signals')?.focus({ preventScroll: true })
				onSelect()
			}}
		>
			<span className="signals-edge" />
			<span className="signals-glyph" data-kind={view.toned ? thread.kind : undefined} aria-hidden="true">
				{view.glyph}
			</span>
			<span className="signals-td-ref">{view.ref}</span>
			<span className="signals-td-what" title={view.what}>
				{view.what}
			</span>
			<span className="signals-td-age">
				{view.receipt ? (
					<span className="signals-receipt">
						<span className="signals-receipt-mark" aria-hidden="true">
							✓
						</span>{' '}
						{view.receipt.how} {view.receipt.ago}
					</span>
				) : (
					view.age
				)}
			</span>
			<span className="signals-td-agent" title={view.agentTitle}>
				{view.agentArrow ? <span className="signals-arrow">→ </span> : null}
				{view.agentGlyph ? (
					<span className="signals-agent-glyph" aria-hidden="true">
						{view.agentGlyph}{' '}
					</span>
				) : null}
				{view.agent}
			</span>
			<span className="signals-edge" />
		</li>
	)
}

function SignalsTable({
	sections,
	snapshot,
	now,
	selected,
	quietEmpty,
	onSelect,
}: {
	sections: SignalSections
	snapshot: AgentDockSnapshot | null
	now: number
	selected: number | null
	/** Every source answered: an empty Needs you may say so. */
	quietEmpty: boolean
	onSelect(id: number): void
}) {
	const row = (thread: SignalThread) => (
		<SignalRow
			key={thread.id}
			thread={thread}
			snapshot={snapshot}
			now={now}
			selected={selected === thread.id}
			onSelect={() => onSelect(thread.id)}
		/>
	)
	return (
		<ul className="signals-table" aria-label="Signals">
			<li className="signals-subhead" role="presentation">
				Needs you
			</li>
			{sections.needs.length > 0 ? (
				sections.needs.map(row)
			) : (
				<li className="signals-empty" role="presentation">
					{quietEmpty ? 'Nothing needs you' : 'Nothing listed. Not every source answered'}
				</li>
			)}
			<li className="signals-subhead" role="presentation">
				Managed
			</li>
			{sections.managed.length > 0 ? (
				sections.managed.map(row)
			) : (
				<li className="signals-empty" role="presentation">
					Nothing is managed. m hands a thread to the dispatcher
				</li>
			)}
			<li className="signals-subhead" role="presentation">
				{closedHeader(sections)}
			</li>
			{sections.snoozed.map(row)}
			{sections.done.map(row)}
		</ul>
	)
}

export function SignalsColumn({
	service,
	dock,
	onShowTasks,
	onLeave,
	mod = 'cmd',
	now: clock = Date.now,
	initialSelected,
	initialFlow = null,
}: SignalsColumnProps) {
	const bridge = useSyncExternalStore(service.subscribe, service.getState)
	const snapshot = useSyncExternalStore(dock.subscribe, dock.snapshot)
	const [now, setNow] = useState(clock)
	const [selected, setSelected] = useState<number | null>(initialSelected ?? initialFlow?.id ?? null)
	const [flow, setFlow] = useState<SignalsFlow>(initialFlow)
	const [note, setNote] = useState<string | null>(null)
	const [overrides, setOverrides] = useState<ReadonlyMap<number, SignalThread>>(() => new Map())
	const sectionRef = useRef<HTMLElement>(null)
	const busy = useRef(false)
	const alive = useRef(true)
	// The routing effect in flight (ref: synchronous single flight; state: footer and flow busy).
	const routingRef = useRef<RouteJob | null>(null)
	const [routing, setRouting] = useState<RouteJob | null>(null)
	const flowRef = useRef<SignalsFlow>(flow)
	flowRef.current = flow

	useEffect(() => {
		alive.current = true
		const timer = setInterval(() => setNow(clock()), AGE_TICK_MS)
		return () => {
			alive.current = false
			clearInterval(timer)
		}
	}, [clock])

	const threads = useMemo(() => mergeThreads(bridge.snapshot?.threads ?? [], overrides), [bridge.snapshot, overrides])
	const sections = useMemo(() => signalSections(threads, now), [threads, now])
	const rows = useMemo(() => orderedRows(sections), [sections])
	const current = keepSelection(rows, selected)
	const sources = bridge.snapshot?.sources ?? []
	const flowThread = flow ? threads.find(thread => thread.id === flow.id) : undefined

	// Keyboard moves keep the selected row in view.
	useEffect(() => {
		if (current === null) return
		sectionRef.current
			?.querySelector<HTMLElement>(`[data-signal-id="${current}"]`)
			?.scrollIntoView?.({ block: 'nearest' })
	}, [current])

	// A flow whose thread left the snapshot closes; the list keeps the keys.
	useEffect(() => {
		if (flow && !flowThread) setFlow(null)
	}, [flow, flowThread])

	const applyThread = useCallback((thread: SignalThread) => {
		setOverrides(previous => new Map(previous).set(thread.id, thread))
	}, [])

	const refocus = useCallback(() => {
		requestAnimationFrame(() => sectionRef.current?.focus({ preventScroll: true }))
	}, [])

	const closeFlow = useCallback(
		(message?: string | null) => {
			setFlow(null)
			if (message !== undefined) setNote(message)
			refocus()
		},
		[refocus],
	)

	const route: RouteRunner = useCallback(
		async job => {
			if (routingRef.current) return `${routingRef.current.label} (still running)`
			routingRef.current = job
			setRouting(job)
			// Success closes the flow showing this thread (whichever instance it is); focus returns to the list.
			const finish = (message: string): void => {
				const open = flowRef.current
				if (open && open.id === job.id && open.type === job.type) closeFlow(message)
				else setNote(message)
			}
			try {
				let outcome: RouteAttempt
				try {
					outcome = await job.attempt()
				} catch (error) {
					outcome = { failed: `Failed: ${error instanceof Error ? error.message : String(error)}` }
				}
				if (!alive.current) return null
				if ('failed' in outcome) {
					if (job.flowAlive()) return outcome.failed
					setNote(outcome.failed)
					return null
				}
				const routed = await service.routed(job.id, { agent: outcome.agent, how: outcome.how })
				if (!alive.current) return null
				if (routed.error !== undefined) {
					finish(outcome.unsaved(routed.error))
					return null
				}
				applyThread(routed.data)
				finish(outcome.done)
				return null
			} finally {
				routingRef.current = null
				if (alive.current) setRouting(null)
			}
		},
		[service, applyThread, closeFlow],
	)

	const run = async (task: () => Promise<void>): Promise<void> => {
		if (busy.current) return
		busy.current = true
		try {
			await task()
		} finally {
			busy.current = false
		}
	}

	const act = (key: SignalActionKey): void => {
		const thread = rows.find(entry => entry.id === current)
		if (!thread || !threadActions(thread, now).some(action => action.key === key)) return
		if (key === 'p' || key === 'n') {
			setNote(null)
			setFlow({ type: key === 'p' ? 'send' : 'new-agent', id: thread.id })
			return
		}
		if (key === 'o') {
			void run(async () => {
				const url = thread.url
				if (!url) return
				const opened = await service.open(url)
				if (!alive.current) return
				if (opened.error !== undefined) {
					setNote(`Could not open ${thread.ref}: ${opened.error}`)
					return
				}
				setNote(`Opened ${thread.ref}`)
				if (thread.state !== 'new') return
				const seen = await service.update(thread.id, { state: 'seen' })
				if (alive.current && seen.data) applyThread(seen.data)
			})
			return
		}
		const patch = actionPatch(key, thread, now)
		if (!patch) return
		const next = following(sections, thread.id)
		void run(async () => {
			const result = await service.update(thread.id, patch)
			if (!alive.current) return
			if (result.error !== undefined) {
				setNote(`Could not update ${thread.ref}: ${result.error}`)
				return
			}
			applyThread(result.data)
			setSelected(next)
			setNote(actionNote(key, thread, now))
		})
	}

	const move = (delta: number): void => {
		if (rows.length === 0) return
		const index = rows.findIndex(thread => thread.id === current)
		const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]
		if (next) {
			setSelected(next.id)
			setNote(null)
		}
	}

	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		// An open flow handles its own keys (Esc back, digits, ⌘↵); typing never reaches the list.
		if (flow || event.defaultPrevented) return
		if (event.metaKey || event.ctrlKey || event.altKey) return
		if ((event.target as HTMLElement).closest('textarea, input')) return
		if (event.key === 'Escape') {
			if (!onLeave) return
			event.preventDefault()
			// The task sidebar sharing this column treats a window-level Esc as Back (SidebarRoot): this
			// one is Signals' own and must not pop the hidden task stack.
			event.stopPropagation()
			onLeave()
			return
		}
		if (event.key === 'j' || event.key === 'ArrowDown') move(1)
		else if (event.key === 'k' || event.key === 'ArrowUp') move(-1)
		else if (/^[pnmtsdo]$/.test(event.key)) act(event.key as SignalActionKey)
		else return
		event.preventDefault()
	}

	const selectedThread = rows.find(thread => thread.id === current)
	const health = healthLines(sources)
	return (
		<section
			ref={sectionRef}
			className="signals"
			aria-label="Signals"
			aria-keyshortcuts={mod === 'cmd' ? 'Meta+Shift+I' : undefined}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the surface takes the keys (j k p n m t s d o).
			tabIndex={0}
			onKeyDown={onKeyDown}
		>
			{flow && flowThread ? (
				flow.type === 'send' ? (
					<SendFlow
						thread={flowThread}
						snapshot={snapshot}
						dock={dock}
						mod={mod}
						routing={routing}
						onRoute={route}
						onClose={closeFlow}
					/>
				) : (
					<NewAgentFlow
						thread={flowThread}
						service={service}
						mod={mod}
						routing={routing}
						onRoute={route}
						onClose={closeFlow}
					/>
				)
			) : (
				<>
					<header className="signals-title">
						<span className="signals-title-text">
							<span className="signals-title-kind">Signals</span>
							<span className="signals-title-context">
								{signalsSummary(sections, now, bridge.snapshot ? sources : null)}
							</span>
						</span>
						<IconBtn label="Show tasks" className="signals-show-tasks" onClick={onShowTasks}>
							{GLYPH.menu}
						</IconBtn>
					</header>
					<div className="signals-scroll">
						{bridge.snapshot ? (
							<SignalsTable
								sections={sections}
								snapshot={snapshot}
								now={now}
								selected={current}
								quietEmpty={allSourcesOk(sources)}
								onSelect={id => {
									setSelected(id)
									setNote(null)
								}}
							/>
						) : (
							<p className="signals-placeholder">{bridge.error ?? 'Reading signals…'}</p>
						)}
					</div>
					<footer className="signals-foot">
						<span className="signals-foot-hints" aria-hidden="true">
							{selectedThread
								? threadActions(selectedThread, now).map(action => (
										<Hint key={action.key} keys={action.key}>
											{action.label}
										</Hint>
									))
								: null}
						</span>
						<output className="signals-note">{note ?? (routing ? `${routing.label} (still running)` : null)}</output>
						{bridge.snapshot && bridge.error ? <span className="signals-health">{bridge.error}</span> : null}
						{health.map(line => (
							<span key={line} className="signals-health">
								{line}
							</span>
						))}
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
				<span className="signals-title-context" title={context}>
					{context}
				</span>
			</span>
			<button type="button" className="signals-title-btn" aria-label="Back to Signals" onClick={onClose}>
				esc
			</button>
		</header>
	)
}

/** An opened flow takes the keys (Esc back, 1–9, ⌘↵), as the dock's own panes do. */
const takeKeys = (node: HTMLDivElement | null) => node?.focus({ preventScroll: true })

/** Keys inside a flow: Esc back, 1–9 pick (not while typing), ⌘↵ / Ctrl+Enter acts from anywhere in it. */
function flowKeys({
	count,
	onPick,
	onSubmit,
	onClose,
}: {
	count: number
	onPick(index: number): void
	onSubmit(): void
	onClose(): void
}) {
	return (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === 'Escape') {
			event.preventDefault()
			event.stopPropagation()
			onClose()
			return
		}
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault()
			event.stopPropagation()
			onSubmit()
			return
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return
		if ((event.target as HTMLElement).closest('textarea, input')) return
		const digit = Number(event.key)
		if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(count, PICK_MAX)) {
			event.preventDefault()
			event.stopPropagation()
			onPick(digit - 1)
		}
	}
}

const pickRange = (count: number): string => (count <= 1 ? '1' : `1–${Math.min(count, PICK_MAX)}`)
const submitKeys = (mod: 'cmd' | 'ctrl'): string => (mod === 'cmd' ? '⌘↵' : 'Ctrl+↵')

const TIER_WORD: Record<NonNullable<AgentMatch['tier']>, string> = {
	pr: 'has this PR',
	branch: 'same branch',
	repo: 'same repo',
}

function AgentChoices({
	matches,
	picked,
	onPick,
}: {
	matches: readonly AgentMatch[]
	picked: string | null
	onPick(index: number): void
}) {
	return (
		<div className="signals-choices" role="radiogroup" aria-label="Agent">
			{matches.map((match, index) => (
				<button
					key={match.session.key}
					type="button"
					// biome-ignore lint/a11y/useSemanticElements: a button radiogroup like the dock's choices (pane-chrome.tsx): label, description and key hint on one row.
					role="radio"
					aria-checked={picked === match.session.key}
					aria-disabled={match.sendable ? undefined : true}
					data-busy={match.sendable ? undefined : 'true'}
					className="signals-choice"
					onClick={() => onPick(index)}
				>
					<span className="signals-choice-mark" data-on={picked === match.session.key ? 'true' : undefined} />
					<span className="signals-choice-label">
						<span className="signals-glyph signals-owner" data-status={match.status} aria-hidden="true">
							{statusGlyph(match.session.status)}
						</span>
						{match.name}
					</span>
					<span className="signals-choice-description">
						{[match.session.repo ?? match.session.project, match.tier ? TIER_WORD[match.tier] : '', match.status]
							.filter(Boolean)
							.join(' · ')}
					</span>
					<span className="signals-choice-n">{index < PICK_MAX ? index + 1 : ''}</span>
				</button>
			))}
		</div>
	)
}

function PromptField({ value, onChange }: { value: string; onChange(value: string): void }) {
	return (
		<label className="signals-prompt">
			<span className="signals-field-label">Prompt</span>
			<textarea
				className="signals-prompt-input"
				value={value}
				spellCheck={false}
				onChange={event => onChange(event.target.value)}
			/>
		</label>
	)
}

/** `p`: hand a thread to a running agent as its next prompt (prefilled, editable, fenced). */
function SendFlow({
	thread,
	snapshot,
	dock,
	mod,
	routing,
	onRoute,
	onClose,
}: {
	thread: SignalThread
	snapshot: AgentDockSnapshot | null
	dock: DockService
	mod: 'cmd' | 'ctrl'
	/** The column's routing effect in flight (this flow's or an earlier one's). */
	routing: RouteJob | null
	onRoute: RouteRunner
	onClose(message?: string | null): void
}) {
	const matches = useMemo(() => matchAgents(thread, snapshot), [thread, snapshot])
	const [picked, setPicked] = useState<string | null>(() => matches[defaultAgentPick(matches)]?.session.key ?? null)
	const [text, setText] = useState(() => sendPrompt(thread))
	const sending = routing !== null
	const [note, setNote] = useState<string | null>(null)
	const alive = useRef(true)
	useEffect(
		() => () => {
			alive.current = false
		},
		[],
	)
	const match = matches.find(entry => entry.session.key === picked)
	const pick = (index: number): void => {
		const choice = matches[index]
		if (!choice) return
		if (!choice.sendable) {
			setNote(`${choice.name} is ${choice.status}; pick an idle agent`)
			return
		}
		setPicked(choice.session.key)
		setNote(null)
	}
	const send = async (): Promise<void> => {
		if (routing) {
			setNote(`${routing.label} (still running)`)
			return
		}
		if (!match) {
			setNote(matches.length === 0 ? 'No agent is running. n starts a new one' : 'Pick an agent first')
			return
		}
		if (!match.sendable) {
			setNote(`${match.name} is ${match.status}; pick an idle agent`)
			return
		}
		if (!text.trim()) {
			setNote('The prompt is empty')
			return
		}
		setNote(null)
		const name = match.name
		const request = {
			session: match.session.key,
			...(match.session.sessionId ? { sessionId: match.session.sessionId } : {}),
			...(match.session.lastMessage ? { assistantUuid: match.session.lastMessage.uuid } : {}),
			text,
		}
		const failed = await onRoute({
			id: thread.id,
			type: 'send',
			label: `Sending to ${name}…`,
			flowAlive: () => alive.current,
			attempt: async () => {
				const outcome = (await dock.prompt(request)).outcome
				if (outcome.status !== 'sent')
					return {
						failed:
							outcome.status === 'unconfirmed'
								? `Not confirmed: ${outcome.detail}. Check ${name} before sending again`
								: `Not sent: ${outcome.detail}`,
					}
				return {
					agent: name,
					how: 'sent',
					done: `Sent ${thread.ref} to ${name}`,
					unsaved: error => `Sent to ${name}; the receipt was not saved: ${error}`,
				}
			},
		})
		if (failed !== null && alive.current) setNote(failed)
	}
	return (
		<div
			ref={takeKeys}
			tabIndex={-1}
			className="signals-flow-keys"
			onKeyDown={flowKeys({
				count: matches.length,
				onPick: pick,
				onSubmit: () => void send(),
				onClose: () => onClose(),
			})}
		>
			<FlowHeader glyph="→" kind="Send to agent" context={`${thread.ref} · ${thread.head}`} onClose={() => onClose()} />
			<div className="signals-scroll signals-flow">
				<span className="signals-field-label">To</span>
				{matches.length > 0 ? (
					<AgentChoices matches={matches} picked={picked} onPick={pick} />
				) : (
					<span className="signals-dim">No agent is running. n starts a new one in Okena</span>
				)}
				<PromptField value={text} onChange={setText} />
			</div>
			<footer className="signals-foot">
				<span className="signals-foot-hints" aria-hidden="true">
					{matches.length > 0 ? (
						<Hint keys={pickRange(matches.length)} pick>
							pick
						</Hint>
					) : null}
					<Hint keys={submitKeys(mod)}>send</Hint>
					<Hint keys="esc">back</Hint>
				</span>
				<output className="signals-note">
					{note ?? (routing ? routing.label : match ? `Typed into ${match.name}’s terminal as its next prompt` : '')}
				</output>
				<span className="signals-foot-actions">
					<Btn
						tone="primary"
						sm
						className="signals-key"
						busy={sending}
						ariaKeyShortcuts={mod === 'cmd' ? 'Meta+Enter' : 'Control+Enter'}
						onClick={() => void send()}
					>
						Send
					</Btn>
				</span>
			</footer>
		</div>
	)
}

type ProjectsState =
	| { status: 'loading' }
	| { status: 'error'; message: string }
	| { status: 'ready'; projects: SignalOkenaProject[]; suggested: string | null }

/** `n`: a new Okena worktree with Claude, the thread as its first prompt. */
function NewAgentFlow({
	thread,
	service,
	mod,
	routing,
	onRoute,
	onClose,
}: {
	thread: SignalThread
	service: SignalsService
	mod: 'cmd' | 'ctrl'
	/** The column's routing effect in flight (this flow's or an earlier one's). */
	routing: RouteJob | null
	onRoute: RouteRunner
	onClose(message?: string | null): void
}) {
	const [projects, setProjects] = useState<ProjectsState>({ status: 'loading' })
	const [picked, setPicked] = useState<string | null>(null)
	const [branch, setBranch] = useState(() => suggestBranch(thread))
	const [text, setText] = useState(() => newAgentPrompt(thread))
	const starting = routing !== null
	const [note, setNote] = useState<string | null>(null)
	const alive = useRef(true)
	useEffect(
		() => () => {
			alive.current = false
		},
		[],
	)
	useEffect(() => {
		let current = true
		void service.okenaProjects(thread.repo).then(result => {
			if (!current) return
			if (result.error !== undefined) {
				setProjects({ status: 'error', message: result.error })
				return
			}
			setProjects({ status: 'ready', projects: result.data.projects, suggested: result.data.suggested })
			setPicked(previous => previous ?? result.data.suggested)
		})
		return () => {
			current = false
		}
	}, [service, thread.repo])
	const list = projects.status === 'ready' ? projects.projects : []
	const suggested = projects.status === 'ready' ? projects.suggested : null
	const project = list.find(entry => entry.id === picked)
	const pick = (index: number): void => {
		const choice = list[index]
		if (!choice) return
		setPicked(choice.id)
		setNote(null)
	}
	const start = async (): Promise<void> => {
		if (routing) {
			setNote(`${routing.label} (still running)`)
			return
		}
		if (!project) {
			setNote(list.length === 0 ? 'No Okena project to start in' : 'Pick a project first')
			return
		}
		const name = branch.trim()
		if (!name) {
			setNote('The branch name is empty')
			return
		}
		if (!text.trim()) {
			setNote('The prompt is empty')
			return
		}
		setNote(null)
		const request = { signalId: thread.id, projectId: project.id, branch: name, agent: 'claude' as const, prompt: text }
		const failed = await onRoute({
			id: thread.id,
			type: 'new-agent',
			label: 'Starting agent…',
			flowAlive: () => alive.current,
			attempt: async () => {
				const result = await service.newAgent(request)
				if (result.error !== undefined) return { failed: `Not started: ${result.error}` }
				const agent = result.data.agentName
				return {
					agent,
					how: 'started',
					done: `Started claude in ${agent} with ${thread.ref}`,
					unsaved: error => `Started claude in ${agent}; the receipt was not saved: ${error}`,
				}
			},
		})
		if (failed !== null && alive.current) setNote(failed)
	}
	return (
		<div
			ref={takeKeys}
			tabIndex={-1}
			className="signals-flow-keys"
			onKeyDown={flowKeys({ count: list.length, onPick: pick, onSubmit: () => void start(), onClose: () => onClose() })}
		>
			<FlowHeader
				glyph="+"
				kind="New agent in Okena"
				context={`${thread.ref} · ${thread.head}`}
				onClose={() => onClose()}
			/>
			<div className="signals-scroll signals-flow">
				<span className="signals-field-label">Project</span>
				{projects.status === 'loading' ? (
					<span className="signals-dim">Reading Okena projects…</span>
				) : projects.status === 'error' ? (
					<span className="signals-dim">{projects.message}</span>
				) : list.length === 0 ? (
					<span className="signals-dim">Okena has no project to start in</span>
				) : (
					<div className="signals-choices" role="radiogroup" aria-label="Project">
						{list.map((entry, index) => (
							<button
								key={entry.id}
								type="button"
								// biome-ignore lint/a11y/useSemanticElements: a button radiogroup like the dock's choices (pane-chrome.tsx): label, description and key hint on one row.
								role="radio"
								aria-checked={picked === entry.id}
								className="signals-choice"
								onClick={() => pick(index)}
							>
								<span className="signals-choice-mark" data-on={picked === entry.id ? 'true' : undefined} />
								<span className="signals-choice-label">{entry.name}</span>
								<span className="signals-choice-description">
									{[entry.repo, entry.id === suggested ? 'this repo' : ''].filter(Boolean).join(' · ')}
								</span>
								<span className="signals-choice-n">{index < PICK_MAX ? index + 1 : ''}</span>
							</button>
						))}
					</div>
				)}
				<dl className="signals-fields">
					<dt>
						<label htmlFor={`signals-branch-${thread.id}`}>Worktree</label>
					</dt>
					<dd>
						<input
							id={`signals-branch-${thread.id}`}
							className="signals-branch-input"
							value={branch}
							spellCheck={false}
							autoComplete="off"
							onChange={event => setBranch(event.target.value)}
						/>
					</dd>
					<dt>Agent</dt>
					<dd>claude</dd>
				</dl>
				<PromptField value={text} onChange={setText} />
			</div>
			<footer className="signals-foot">
				<span className="signals-foot-hints" aria-hidden="true">
					{list.length > 0 ? (
						<Hint keys={pickRange(list.length)} pick>
							project
						</Hint>
					) : null}
					<Hint keys={submitKeys(mod)}>start</Hint>
					<Hint keys="esc">back</Hint>
				</span>
				<output className="signals-note">
					{note ??
						(routing
							? routing.label
							: project
								? `Creates the worktree in ${project.name} and starts claude there`
								: '')}
				</output>
				<span className="signals-foot-actions">
					<Btn
						tone="primary"
						sm
						className="signals-key"
						busy={starting}
						ariaKeyShortcuts={mod === 'cmd' ? 'Meta+Enter' : 'Control+Enter'}
						onClick={() => void start()}
					>
						Start agent
					</Btn>
				</span>
			</footer>
		</div>
	)
}

export interface MountedSignals {
	/** Gives the column the keys: an open flow, else the list. */
	focus(): void
	dispose(): void
}

/** Production mount (left-column.ts) and the story host share this root. */
export function mountSignals(host: HTMLElement, props: SignalsColumnProps): MountedSignals {
	const root = createRoot(host)
	root.render(<SignalsColumn {...props} />)
	return {
		focus() {
			;(
				host.querySelector<HTMLElement>('.signals-flow-keys') ?? host.querySelector<HTMLElement>('section.signals')
			)?.focus({ preventScroll: true })
		},
		dispose() {
			// Unmount outside any React commit that may be disposing this mount (a fixture effect cleanup).
			queueMicrotask(() => root.unmount())
		},
	}
}
