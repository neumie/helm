// Signals column (design §3.25): what the world wants from Jakub — GitHub review requests,
// comments and failed CI on his PRs, mentions, mail (Sentry alerts arrive as mail), asks local
// agents filed with `helm signal add` — in the task sidebar's column. The agent dock's register (§3.24): one typeface, bright/dim instead of weight,
// color on glyphs only, no cards, no box-drawing, key hints as words. Data and effects come from
// injected services (services.ts); row text, matching and prompts from the pure model.ts.

import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentDockSnapshot } from '../../agent-dock/model'
import type { SignalOkenaProject } from '../../shared'
import type { SignalFilteredPage, SignalIncludeResult, SignalMuteResult, SignalThread } from '../../shared-helm'
import { statusGlyph } from '../agent-dock/presentation'
import { Btn } from '../button'
import { IconBtn } from '../icon-button'
import { GLYPH } from '../sidebar/ui'
import { SignalsList } from './SignalsList'
import {
	type AgentMatch,
	type AnswerLayout,
	PICK_MAX,
	REPLY_MAX,
	type SignalActionKey,
	type SignalSections,
	actionKeyHint,
	actionNote,
	actionPatch,
	agentBlockedNote,
	answerInline,
	askDeliveryTarget,
	askReceipt,
	defaultAgentPick,
	filteredLine,
	filteredRowView,
	filteredSummary,
	following,
	formatAgo,
	healthLines,
	includeAction,
	includeNote,
	isAnswer,
	keepSelection,
	matchAgents,
	muteNote,
	newAgentPrompt,
	orderedRows,
	replyPrompt,
	sendPrompt,
	signalRowView,
	signalSection,
	signalSections,
	suggestBranch,
	threadActions,
} from './model'
import type { DockService, SignalsService } from './services'

/** Re-render ages while nothing else changes. */
const AGE_TICK_MS = 30_000

export interface SignalsColumnProps {
	service: SignalsService
	dock: DockService
	/** The header's Settings button: switch the column to Settings. */
	onOpenSettings(): void
	/** Esc on the list: hand the keys back to the terminal. */
	onLeave?(): void
	/** `cmd` on macOS (⌘↵), else `ctrl`. */
	mod?: 'cmd' | 'ctrl'
	now?: () => number
	/** Review fixtures only: the row selected and the flow open on first render. */
	initialSelected?: number
	initialFlow?: SignalsFlow
	/**
	 * Review only, until Jakub picks: where agent answers live and what closes them (see
	 * `AnswerLayout`). Production passes nothing (`section`).
	 */
	answerLayout?: AnswerLayout
}

/**
 * `send` (p), `new-agent` (n), `reply` (r on an agent ask), `links` (o on an ask with several links),
 * `read` (↵ on an agent answer), `filtered` (f: the filtered mail list), `done` (D: the threads done today).
 */
export type SignalsFlow =
	| { type: 'send' | 'new-agent' | 'reply' | 'slack-reply'; id: number }
	/** `back: 'done'`: opened from the done list, so Esc goes back there. */
	| { type: 'links' | 'read'; id: number; back?: 'done' }
	| { type: 'filtered' | 'done' }
	| null

/** What a flow's attempt (the dock prompt / the Okena start / an answer) came back with. */
export type RouteAttempt =
	| { failed: string }
	/** Done with nothing to record as routed (an answer saved but not typed into the agent). */
	| { closed: string; thread?: SignalThread }
	| {
			agent: string
			how: 'sent' | 'started' | 'replied'
			/** Note once the receipt is saved. */
			done: string
			/** Note when the effect happened but the receipt could not be saved. */
			unsaved(error: string): string
			/** The thread as the effect left it (an ask's saved answer): shown even when the receipt fails. */
			thread?: SignalThread
	  }

/**
 * One routing effect (`p` send / `n` start), owned by the column rather than the flow: Esc or the
 * thread leaving the snapshot may close the flow while it runs, and the late success still saves its
 * receipt (`service.routed`) and lands in the column's note. One at a time: no double submit.
 */
export interface RouteJob {
	id: number
	type: 'send' | 'new-agent' | 'reply'
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
	inline = false,
}: {
	thread: SignalThread
	snapshot: AgentDockSnapshot | null
	now: number
	selected: boolean
	onSelect(): void
	/** The `inline` answer layout: an open answer shows its body in place of the dim body line. */
	inline?: boolean
}) {
	const view = signalRowView(thread, snapshot, now)
	const section = signalSection(thread, now) ?? 'done'
	const body = inline && isAnswer(thread) && section !== 'done' ? answerInline(thread) : null
	return (
		<li
			className="signals-tr"
			data-section={section}
			data-done-reason={view.doneReason?.kind}
			data-signal-id={thread.id}
			data-selected={selected ? 'true' : undefined}
			aria-current={selected ? 'true' : undefined}
			title={view.title}
			onMouseDown={event => {
				// Selecting gives the surface the keys (j k p n …; the done list's own), without scrolling or a focus ring.
				event.preventDefault()
				event.currentTarget.closest<HTMLElement>('.signals-flow-keys, section.signals')?.focus({ preventScroll: true })
				onSelect()
			}}
		>
			<span className="signals-edge" />
			<span className="signals-glyph" data-kind={view.toned ? thread.kind : undefined} aria-hidden="true">
				{view.glyph}
			</span>
			<span className="signals-td-ref">
				{view.ref}
				{view.doneReason ? (
					<span className="signals-done-reason" title={view.doneReason.title}>
						{' · '}
						{view.doneReason.word}
					</span>
				) : null}
			</span>
			<span className="signals-td-what" title={view.what}>
				{view.what}
			</span>
			<span className="signals-td-age">
				{view.receipt ? (
					// An answer only saved on the thread was not delivered: no check mark.
					<span className="signals-receipt" data-how={view.receipt.how}>
						{view.receipt.how === 'saved' ? null : (
							<>
								<span className="signals-receipt-mark" aria-hidden="true">
									✓
								</span>{' '}
							</>
						)}
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
			{body ? (
				<span className="signals-td-answer">
					{body.text}
					{body.more || thread.links.length > 0 ? (
						<span className="signals-td-answer-more">
							{[
								body.more ? '… ↵ read all' : '',
								thread.links.length > 0 ? (thread.links.length === 1 ? '1 link' : `${thread.links.length} links`) : '',
							]
								.filter(Boolean)
								.join(' · ')}
						</span>
					) : null}
				</span>
			) : view.detail ? (
				<span className="signals-td-detail" title={view.detail}>
					{view.detail}
				</span>
			) : null}
			<span className="signals-edge" />
		</li>
	)
}

/**
 * `Done today 8 · D` / `5 filtered · f`: a dim text button that opens its list in place of the
 * column's (the list takes the keys); the key hint shows only while Signals holds the keys.
 */
function ListButton({
	className,
	text,
	keys,
	keyShortcuts,
	title,
	onOpen,
}: {
	className: string
	text: string
	keys: string
	keyShortcuts: string
	title: string
	onOpen(): void
}) {
	return (
		<button
			type="button"
			className={`signals-list-btn ${className}`}
			aria-keyshortcuts={keyShortcuts}
			title={title}
			// The opened list takes the keys; a pointer press never moves focus on its own.
			onMouseDown={event => event.preventDefault()}
			onClick={onOpen}
		>
			{text}
			<span className="signals-list-key" aria-hidden="true">
				{' '}
				· <kbd>{keys}</kbd>
			</span>
		</button>
	)
}

export function SignalsColumn({
	service,
	dock,
	onOpenSettings,
	onLeave,
	mod = 'cmd',
	now: clock = Date.now,
	initialSelected,
	initialFlow = null,
	answerLayout = 'section',
}: SignalsColumnProps) {
	const bridge = useSyncExternalStore(service.subscribe, service.getState)
	const snapshot = useSyncExternalStore(dock.subscribe, dock.snapshot)
	const [now, setNow] = useState(clock)
	const [selected, setSelected] = useState<number | null>(
		initialSelected ?? (initialFlow && 'id' in initialFlow ? initialFlow.id : null),
	)
	const [flow, setFlow] = useState<SignalsFlow>(initialFlow)
	// The done list's selection, kept while a links list opened from it is on screen.
	const [doneSelected, setDoneSelected] = useState<number | null>(null)
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
	const allSections = useMemo(() => signalSections(threads, now, answerLayout), [threads, now, answerLayout])
	// Done rows are listed only in their own view (D); the list's subhead counts them.
	const sections = useMemo(() => ({ ...allSections, done: [] }), [allSections])
	const rows = useMemo(() => orderedRows(sections), [sections])
	const current = keepSelection(rows, selected)
	const sources = bridge.snapshot?.sources ?? []
	const flowThread = flow && 'id' in flow ? threads.find(thread => thread.id === flow.id) : undefined
	const filteredCount = bridge.snapshot?.filteredCount

	// Keyboard moves keep the selected row in view.
	useEffect(() => {
		if (current === null) return
		sectionRef.current
			?.querySelector<HTMLElement>(`[data-signal-id="${current}"]`)
			?.scrollIntoView?.({ block: 'nearest' })
	}, [current])

	// A flow whose thread left the snapshot closes; the list (or the done list it came from) keeps the keys.
	useEffect(() => {
		if (flow && 'id' in flow && !flowThread)
			setFlow((flow.type === 'links' || flow.type === 'read') && flow.back ? { type: flow.back } : null)
	}, [flow, flowThread])

	const applyThread = useCallback((thread: SignalThread) => {
		setOverrides(previous => new Map(previous).set(thread.id, thread))
	}, [])

	const refocus = useCallback(() => {
		requestAnimationFrame(() => sectionRef.current?.focus({ preventScroll: true }))
	}, [])

	const closeFlow = useCallback(
		(message?: string | null) => {
			// Links opened from the done list go back to it, which takes the keys itself when it mounts.
			const open = flowRef.current
			const back = (open?.type === 'links' || open?.type === 'read') && open.back ? open.back : null
			setFlow(back ? { type: back } : null)
			if (message !== undefined) setNote(message)
			if (!back) refocus()
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
				if (open && 'id' in open && open.id === job.id && open.type === job.type) closeFlow(message)
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
				if ('closed' in outcome) {
					if (outcome.thread) applyThread(outcome.thread)
					finish(outcome.closed)
					return null
				}
				const routed = await service.routed(job.id, { agent: outcome.agent, how: outcome.how })
				if (!alive.current) return null
				if (routed.error !== undefined) {
					if (outcome.thread) applyThread(outcome.thread)
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

	/**
	 * An action key on `thread` (the list's selected row, or the done list's): `select` moves that
	 * list's selection once the thread leaves its group.
	 */
	const act = (
		key: SignalActionKey,
		thread = rows.find(entry => entry.id === current),
		select: (id: number) => void = setSelected,
	): void => {
		if (!thread || !threadActions(thread, now).some(action => action.key === key)) return
		if (key === 'p' || key === 'n' || key === 'r') {
			setNote(null)
			// `r` on a Slack row opens the Slack reply flow (posts to Slack); on an agent ask, the ask reply.
			const type =
				key === 'p' ? 'send' : key === 'n' ? 'new-agent' : thread.source === 'slack' ? 'slack-reply' : 'reply'
			setFlow({ type, id: thread.id })
			return
		}
		if (key === 'Enter') {
			// Read an answer in full; opening it marks it seen (as opening a thread's source does).
			setNote(null)
			setFlow({ type: 'read', id: thread.id, ...(flowRef.current?.type === 'done' ? { back: 'done' as const } : {}) })
			if (thread.state === 'new')
				void service.update(thread.id, { state: 'seen' }).then(seen => {
					if (alive.current && seen.data) applyThread(seen.data)
				})
			return
		}
		if (key === 'o' && thread.source === 'agent') {
			// Several links: pick one by number. One: open it at once, as `o` does for a thread's source.
			if (thread.links.length > 1) {
				setNote(null)
				setFlow({
					type: 'links',
					id: thread.id,
					...(flowRef.current?.type === 'done' ? { back: 'done' as const } : {}),
				})
				return
			}
			void run(async () => {
				const failed = await openAskLink(thread, 0)
				if (failed !== null && alive.current) setNote(failed)
			})
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
		if (key === 'x') {
			// Mute the sender: every open thread of its leaves at once, the selection skips them all.
			const slack = thread.source === 'slack'
			void run(async () => {
				const result = slack ? await service.slackMute(thread.id) : await service.mute(thread.id)
				if (!alive.current) return
				if (result.error !== undefined) {
					setNote(`Could not mute ${thread.ref}: ${result.error}`)
					return
				}
				select(following(allSections, thread.id, new Set([thread.id, ...result.data.threadIds])))
				setNote(
					slack
						? `Muted ${thread.ref}${result.data.threadIds.length > 0 ? ` · ${result.data.threadIds.length} thread${result.data.threadIds.length === 1 ? '' : 's'}` : ''}`
						: muteNote(thread, result.data as SignalMuteResult),
				)
			})
			return
		}
		const patch = actionPatch(key, thread, now)
		if (!patch) return
		const next = following(allSections, thread.id)
		void run(async () => {
			const result = await service.update(thread.id, patch)
			if (!alive.current) return
			if (result.error !== undefined) {
				setNote(`Could not update ${thread.ref}: ${result.error}`)
				return
			}
			applyThread(result.data)
			select(next)
			setNote(actionNote(key, thread, now))
		})
	}

	/**
	 * Opens link `index` of an ask (main reads it fresh, checks it again and opens it only while it is
	 * still the link shown here), notes it and marks a new ask seen. Resolves with the failure note,
	 * or null once opened.
	 */
	const openAskLink = async (thread: SignalThread, index: number): Promise<string | null> => {
		const shown = thread.links[index]
		if (shown === undefined) return `${thread.ref} has no link ${index + 1}`
		const opened = await service.openLink(thread.id, index, shown)
		if (!alive.current) return null
		if (opened.error !== undefined) return `Could not open link ${index + 1} of ${thread.ref}: ${opened.error}`
		setNote(`Opened link ${index + 1} of ${thread.ref}`)
		if (thread.state === 'new') {
			const seen = await service.update(thread.id, { state: 'seen' })
			if (alive.current && seen.data) applyThread(seen.data)
		}
		return null
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

	/** `D` / the done count: the threads done today, in place of the list. */
	const openDone = (): void => {
		setNote(null)
		setDoneSelected(null)
		setFlow({ type: 'done' })
	}

	const openFiltered = (): void => {
		setNote(null)
		setFlow({ type: 'filtered' })
	}

	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		// An open flow handles its own keys (Esc back, digits, ⌘↵); typing never reaches the list.
		if (flow || event.defaultPrevented) return
		if (event.metaKey || event.ctrlKey || event.altKey) return
		if ((event.target as HTMLElement).closest('textarea, input')) return
		// Enter on a button (Done today, filtered, Settings) is that button's own.
		if (event.key === 'Enter' && (event.target as HTMLElement).closest('button')) return
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
		else if (/^[pnmtsdorx]$/.test(event.key) || event.key === 'Enter') act(event.key as SignalActionKey)
		else if (event.key === 'f' && filteredLine(filteredCount)) openFiltered()
		else if (event.key === 'D' && allSections.doneToday > 0) openDone()
		else return
		event.preventDefault()
	}

	const selectedThread = rows.find(thread => thread.id === current)
	const health = healthLines(sources)
	const filtered = filteredLine(filteredCount)
	const filteredButton = filtered ? (
		<ListButton
			className="signals-filtered"
			text={filtered}
			keys="f"
			keyShortcuts="f"
			title="Mail the rules kept out of Needs you (last 7 days)"
			onOpen={openFiltered}
		/>
	) : null
	const doneLabel = `Done today ${allSections.doneToday}`
	const doneButton =
		allSections.doneToday > 0 ? (
			<ListButton
				className="signals-done"
				text={doneLabel}
				keys="D"
				keyShortcuts="Shift+D"
				title="Threads done in the last 24 hours, and how each got done"
				onOpen={openDone}
			/>
		) : (
			doneLabel
		)
	return (
		<section
			ref={sectionRef}
			className="signals"
			aria-label="Signals"
			aria-keyshortcuts={mod === 'cmd' ? 'Meta+Shift+I' : undefined}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the surface takes the keys (j k p n m t s d o r x).
			tabIndex={0}
			onKeyDown={onKeyDown}
		>
			{flow?.type === 'filtered' ? (
				<FilteredMail service={service} count={filteredCount} now={now} onClose={closeFlow} />
			) : flow?.type === 'done' ? (
				<DoneToday
					sections={allSections}
					snapshot={snapshot}
					now={now}
					selected={doneSelected}
					onSelect={setDoneSelected}
					note={note}
					onNote={setNote}
					onAct={(key, thread) => act(key, thread, setDoneSelected)}
					onClose={closeFlow}
				/>
			) : flow && flowThread ? (
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
				) : flow.type === 'reply' ? (
					<ReplyFlow
						thread={flowThread}
						snapshot={snapshot}
						service={service}
						dock={dock}
						mod={mod}
						now={now}
						routing={routing}
						onRoute={route}
						onClose={closeFlow}
					/>
				) : flow.type === 'slack-reply' ? (
					<SlackReplyFlow thread={flowThread} service={service} mod={mod} onClose={closeFlow} onThread={applyThread} />
				) : flow.type === 'links' ? (
					<LinksFlow thread={flowThread} onOpen={index => openAskLink(flowThread, index)} onClose={closeFlow} />
				) : flow.type === 'read' ? (
					<ReadFlow
						thread={flowThread}
						now={now}
						closesOnLeave={answerLayout === 'read-closes'}
						onOpen={index => openAskLink(flowThread, index)}
						onDone={() => {
							closeFlow()
							act('d', flowThread)
						}}
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
						</span>
						<IconBtn label="Settings" className="signals-settings" onClick={onOpenSettings}>
							{GLYPH.settings}
						</IconBtn>
					</header>
					<div className="signals-scroll">
						{bridge.snapshot ? (
							<SignalsList
								sections={sections}
								sources={sources}
								now={now}
								row={thread => (
									<SignalRow
										key={thread.id}
										thread={thread}
										snapshot={snapshot}
										now={now}
										selected={current === thread.id}
										inline={answerLayout === 'inline'}
										onSelect={() => {
											setSelected(thread.id)
											setNote(null)
										}}
									/>
								)}
								done={doneButton}
								filtered={filteredButton}
							/>
						) : (
							<p className="signals-placeholder">{bridge.error ?? 'Reading signals…'}</p>
						)}
					</div>
					<footer className="signals-foot">
						<span className="signals-foot-hints" aria-hidden="true">
							{selectedThread
								? threadActions(selectedThread, now).map(action => (
										<Hint key={action.key} keys={actionKeyHint(action.key)}>
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

type FilteredState =
	| { status: 'loading' }
	| { status: 'error'; error: string }
	| { status: 'ready'; page: SignalFilteredPage }

/**
 * `f` / the `12 filtered` count: the mail the rules kept out of Needs you (heads only, last 7 days),
 * newest first, in place of the list. `i` shows the selected row's sender from the next poll: a
 * muted one (`x` in the list; the daemon marks it `unmute`) is unmuted, any other always shown (its
 * exact address goes onto the include list). `o` opens it in Mail, Esc back.
 */
function FilteredMail({
	service,
	count,
	now,
	onClose,
}: {
	service: SignalsService
	/** The snapshot's count: a change (a poll, an include) reloads the list. */
	count: number | undefined
	now: number
	onClose(message?: string | null): void
}) {
	const [state, setState] = useState<FilteredState>({ status: 'loading' })
	const [index, setIndex] = useState(0)
	const [note, setNote] = useState<string | null>(null)
	const [reload, setReload] = useState(0)
	const busy = useRef(false)
	const alive = useRef(true)
	const scrollRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		alive.current = true
		return () => {
			alive.current = false
		}
	}, [])

	// biome-ignore lint/correctness/useExhaustiveDependencies: count and reload are the reload triggers.
	useEffect(() => {
		let current = true
		void service.filtered().then(result => {
			if (!current) return
			setState(
				result.error !== undefined ? { status: 'error', error: result.error } : { status: 'ready', page: result.data },
			)
		})
		return () => {
			current = false
		}
	}, [service, count, reload])

	const entries = state.status === 'ready' ? state.page.entries : []
	const at = Math.min(index, Math.max(0, entries.length - 1))
	const entry = entries[at]

	useEffect(() => {
		if (!entry) return
		scrollRef.current
			?.querySelector<HTMLElement>(`[data-filtered-id="${entry.id}"]`)
			?.scrollIntoView?.({ block: 'nearest' })
	}, [entry])

	const run = async (task: () => Promise<void>): Promise<void> => {
		if (busy.current) return
		busy.current = true
		try {
			await task()
		} finally {
			busy.current = false
		}
	}

	const include = (): void => {
		if (!entry) return
		const slack = entry.source === 'slack'
		void run(async () => {
			const result = slack ? await service.slackInclude(entry.id) : await service.include(entry.id)
			if (!alive.current) return
			if (result.error !== undefined) {
				setNote(`Could not ${entry.unmute ? 'unmute' : 'include'} ${filteredRowView(entry, now).ref}: ${result.error}`)
				return
			}
			setNote(
				slack
					? `${entry.senderName || entry.senderIdentity} is ${result.data.unmuted ? 'unmuted' : 'always shown'} from the next poll`
					: includeNote(result.data as SignalIncludeResult),
			)
			setReload(value => value + 1)
		})
	}

	const open = (): void => {
		const url = entry?.url
		if (!url) return
		void run(async () => {
			const opened = await service.open(url)
			if (!alive.current) return
			setNote(opened.error !== undefined ? `Could not open the mail: ${opened.error}` : 'Opened in Mail')
		})
	}

	const onKey = (key: string): boolean => {
		if (key === 'i') include()
		else if (key === 'o') open()
		else return false
		return true
	}

	const context =
		state.status === 'ready' ? filteredSummary(state.page) : state.status === 'error' ? 'Unavailable' : 'Reading…'
	const more = state.status === 'ready' ? state.page.total - entries.length : 0
	return (
		<SignalsListView
			glyph="@"
			kind="Filtered mail"
			context={context}
			scrollRef={scrollRef}
			onStep={delta => {
				setIndex(Math.max(0, Math.min(entries.length - 1, at + delta)))
				setNote(null)
			}}
			onKey={onKey}
			onClose={onClose}
			hints={
				entry ? (
					<>
						<Hint keys="i">{includeAction(entry).label}</Hint>
						{entry.url ? <Hint keys="o">open</Hint> : null}
					</>
				) : null
			}
			note={note}
			action={
				entry ? (
					<Btn sm ariaKeyShortcuts="i" onClick={include}>
						{includeAction(entry).button}
					</Btn>
				) : null
			}
		>
			{state.status === 'loading' ? <p className="signals-placeholder">Reading filtered mail…</p> : null}
			{state.status === 'error' ? <p className="signals-placeholder">{state.error}</p> : null}
			{state.status === 'ready' ? (
				entries.length > 0 ? (
					<ul className="signals-table" aria-label="Filtered mail">
						{entries.map((item, position) => {
							const view = filteredRowView(item, now)
							const selected = position === at
							return (
								<li
									key={item.id}
									className="signals-tr"
									data-section="filtered"
									data-filtered-id={item.id}
									data-selected={selected ? 'true' : undefined}
									aria-current={selected ? 'true' : undefined}
									title={view.title}
									onMouseDown={event => {
										event.preventDefault()
										event.currentTarget.closest<HTMLElement>('.signals-flow-keys')?.focus({ preventScroll: true })
										setIndex(position)
										setNote(null)
									}}
								>
									<span className="signals-edge" />
									<span className="signals-glyph" aria-hidden="true">
										@
									</span>
									<span className="signals-td-ref">{view.ref}</span>
									<span className="signals-td-what" title={view.what}>
										{view.what}
									</span>
									<span className="signals-td-age">{view.age}</span>
									<span className="signals-td-agent" title={view.title}>
										{view.reason}
									</span>
									<span className="signals-edge" />
								</li>
							)
						})}
						{more > 0 ? (
							<li className="signals-empty" role="presentation">
								… {more} more (helm signal ls --filtered)
							</li>
						) : null}
					</ul>
				) : (
					<p className="signals-placeholder">Nothing was filtered in the last 7 days</p>
				)
			) : null}
		</SignalsListView>
	)
}

/**
 * `D` / the `Done today 8` count: the threads done in the last 24 hours, newest first, in place of
 * the list, each saying how it got done. Built like Filtered mail: `j`/`k` move, the selected row's
 * actions as keys (`t` reopen, `o` open), Esc back. Rows come from the column's own snapshot, so a
 * reopened thread leaves here at once and the selection moves to the next done row.
 */
function DoneToday({
	sections,
	snapshot,
	now,
	selected,
	onSelect,
	note,
	onNote,
	onAct,
	onClose,
}: {
	sections: SignalSections
	snapshot: AgentDockSnapshot | null
	now: number
	/** The column keeps it, so it survives a links list opened from here. */
	selected: number | null
	onSelect(id: number): void
	/** The column's status line (its actions write it; it stays after Esc). */
	note: string | null
	onNote(note: string | null): void
	/** The column's action keys on `thread` (a reopened thread moves the selection to the next done row). */
	onAct(key: SignalActionKey, thread: SignalThread): void
	onClose(message?: string | null): void
}) {
	const rows = sections.done
	const current = keepSelection(rows, selected)
	const thread = rows.find(entry => entry.id === current)
	const scrollRef = useRef<HTMLDivElement>(null)

	// The row shown selected is the one kept: a push of a newer done thread never moves it, and a
	// links list opened from here comes back to it.
	useEffect(() => {
		if (current !== null && current !== selected) onSelect(current)
	}, [current, selected, onSelect])

	useEffect(() => {
		if (current === null) return
		scrollRef.current
			?.querySelector<HTMLElement>(`[data-signal-id="${current}"]`)
			?.scrollIntoView?.({ block: 'nearest' })
	}, [current])

	const actions = thread ? threadActions(thread, now) : []
	const more = sections.doneToday - rows.length
	return (
		<SignalsListView
			glyph="✓"
			kind="Done today"
			context={`${sections.doneToday} in the last 24 hours`}
			scrollRef={scrollRef}
			onStep={delta => {
				const index = rows.findIndex(entry => entry.id === current)
				const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]
				if (!next) return
				onSelect(next.id)
				onNote(null)
			}}
			onKey={key => {
				if (!/^[pnmtsdor]$/.test(key) && key !== 'Enter') return false
				if (thread) onAct(key as SignalActionKey, thread)
				return true
			}}
			onClose={onClose}
			hints={actions.map(action => (
				<Hint key={action.key} keys={actionKeyHint(action.key)}>
					{action.label}
				</Hint>
			))}
			note={note}
			action={
				thread && actions.some(action => action.key === 't') ? (
					<Btn sm ariaKeyShortcuts="t" onClick={() => onAct('t', thread)}>
						Reopen
					</Btn>
				) : null
			}
		>
			{rows.length > 0 ? (
				<ul className="signals-table" aria-label="Done today">
					{rows.map(entry => (
						<SignalRow
							key={entry.id}
							thread={entry}
							snapshot={snapshot}
							now={now}
							selected={entry.id === current}
							onSelect={() => {
								onSelect(entry.id)
								onNote(null)
							}}
						/>
					))}
					{more > 0 ? (
						<li className="signals-empty" role="presentation">
							… {more} more (helm signal ls --state done)
						</li>
					) : null}
				</ul>
			) : (
				<p className="signals-placeholder">Nothing was done in the last 24 hours</p>
			)}
		</SignalsListView>
	)
}

/**
 * A list in place of the column's (Filtered mail, Done today): the flow header with a dim glyph,
 * one scroll owner, then the key hints, the status line and one quiet button. It takes the keys:
 * `j`/`k` (↓/↑) move, Esc back to Signals, `onKey` the list's own (true when handled).
 */
function SignalsListView({
	glyph,
	kind,
	context,
	scrollRef,
	onStep,
	onKey,
	onClose,
	hints,
	note,
	action,
	children,
}: {
	glyph: string
	kind: string
	context: string
	scrollRef: RefObject<HTMLDivElement | null>
	onStep(delta: number): void
	onKey(key: string): boolean
	onClose(message?: string | null): void
	hints: ReactNode
	note: string | null
	action: ReactNode
	children: ReactNode
}) {
	const rootRef = useRef<HTMLDivElement>(null)
	// Opened, it takes the keys (as a flow does).
	useEffect(() => rootRef.current?.focus({ preventScroll: true }), [])
	// The footer button went away while it had focus (it acted on the last row): the keys stay here.
	const hasAction = action !== null && action !== undefined
	useEffect(() => {
		const root = rootRef.current
		const active = document.activeElement
		if (!hasAction && root && (!active || active === document.body || !active.isConnected))
			root.focus({ preventScroll: true })
	}, [hasAction])
	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key === 'Escape') {
			event.preventDefault()
			event.stopPropagation()
			onClose()
			return
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return
		if (event.key === 'j' || event.key === 'ArrowDown') onStep(1)
		else if (event.key === 'k' || event.key === 'ArrowUp') onStep(-1)
		else if (!onKey(event.key)) return
		event.preventDefault()
		event.stopPropagation()
	}
	return (
		<div className="signals-flow-keys" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
			<FlowHeader glyph={glyph} kind={kind} context={context} quiet onClose={() => onClose()} />
			<div className="signals-scroll" ref={scrollRef}>
				{children}
			</div>
			<footer className="signals-foot">
				<span className="signals-foot-hints" aria-hidden="true">
					{hints}
					<Hint keys="esc">back</Hint>
				</span>
				<output className="signals-note">{note}</output>
				{action ? <span className="signals-foot-actions">{action}</span> : null}
			</footer>
		</div>
	)
}

function FlowHeader({
	glyph,
	kind,
	context,
	quiet,
	onClose,
}: {
	glyph: string
	kind: string
	context: string
	/** A dim, untoned glyph (the filtered and done lists: nothing there wants Jakub). */
	quiet?: boolean
	onClose(): void
}) {
	return (
		<header className="signals-title">
			<span className="signals-title-text">
				<span className="signals-title-kind">
					<span className="signals-glyph" data-kind={quiet ? undefined : 'flow'} aria-hidden="true">
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
			setNote(agentBlockedNote(choice))
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
		const delivery = match.delivery
		if (!delivery) {
			setNote(agentBlockedNote(match))
			return
		}
		if (!text.trim()) {
			setNote('The prompt is empty')
			return
		}
		setNote(null)
		const name = match.name
		const session = match.session
		// Decided at submit, as Jakub saw it; main checks it again. A working agent gets it queued.
		const effect =
			delivery.via === 'turn'
				? () => dock.act({ itemId: delivery.itemId, action: { type: 'prompt', text } })
				: () =>
						dock.prompt({
							session: session.key,
							...(session.sessionId ? { sessionId: session.sessionId } : {}),
							...(session.lastMessage ? { assistantUuid: session.lastMessage.uuid } : {}),
							queue: true,
							handoff: true,
							text,
						})
		const failed = await onRoute({
			id: thread.id,
			type: 'send',
			label: `Sending to ${name}…`,
			flowAlive: () => alive.current,
			attempt: async () => {
				const outcome = (await effect()).outcome
				if (outcome.status !== 'sent')
					return {
						failed:
							outcome.status === 'unconfirmed'
								? `Not confirmed: ${outcome.detail}. Check ${name} before sending again`
								: `Not sent: ${outcome.detail}`,
					}
				// Okena or Helm's hub holds it until the agent's turn ends (Okena's MCP channel too).
				const queued = outcome.delivery === 'queued' || outcome.delivery === 'channel'
				return {
					agent: name,
					how: 'sent',
					done: queued ? `Queued ${thread.ref} for ${name}` : `Sent ${thread.ref} to ${name}`,
					unsaved: error => `${queued ? `Queued for ${name}` : `Sent to ${name}`}; the receipt was not saved: ${error}`,
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
					{note ??
						(routing
							? routing.label
							: match
								? match.queued
									? `Queued for ${match.name}: typed in once it stops working`
									: `Typed into ${match.name}’s terminal as its next prompt`
								: '')}
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

/** An ask's links as plain text lines (never `<a href>`): what opens is exactly what is shown. */
function AskLinks({ links, numbered = false }: { links: readonly string[]; numbered?: boolean }) {
	return (
		<ul className="signals-ask-links" aria-label="Links">
			{links.map((link, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: links are positional (openLink takes the index and the link shown)
				<li key={index} className="signals-ask-link">
					{numbered && index < PICK_MAX ? <span className="signals-ask-link-n">{index + 1} </span> : null}
					{link}
				</li>
			))}
		</ul>
	)
}

/** The reply flow exists to be typed into: opening it puts the keys in the answer field. */
const takeAnswerKeys = (node: HTMLDivElement | null) =>
	(node?.querySelector<HTMLElement>('.signals-answer-input') ?? node)?.focus({ preventScroll: true })

/**
 * `r` on an agent ask: Jakub types a short answer. It is always saved on the thread first (the
 * agent can read it with `helm signal show`); when the ask came from an Okena terminal whose agent
 * is idle (or working: queued until its turn ends), it is also typed into that agent as its next
 * prompt through the dock's CAS-guarded prompt path, fenced like any other prompt. Never auto-sent:
 * only ⌘↵ or Send.
 */
function ReplyFlow({
	thread,
	snapshot,
	service,
	dock,
	mod,
	now,
	routing,
	onRoute,
	onClose,
}: {
	thread: SignalThread
	snapshot: AgentDockSnapshot | null
	service: SignalsService
	dock: DockService
	mod: 'cmd' | 'ctrl'
	now: number
	/** The column's routing effect in flight (this flow's or an earlier one's). */
	routing: RouteJob | null
	onRoute: RouteRunner
	onClose(message?: string | null): void
}) {
	const target = useMemo(() => askDeliveryTarget(thread, snapshot), [thread, snapshot])
	// An answer saved but never delivered comes back prefilled, so sending it again is one key.
	const [text, setText] = useState(() => (askReceipt(thread, now)?.how === 'saved' ? (thread.reply ?? '') : ''))
	const [note, setNote] = useState<string | null>(null)
	const alive = useRef(true)
	useEffect(
		() => () => {
			alive.current = false
		},
		[],
	)
	const where = target
		? target.sendable
			? target.queued
				? `Queued for ${target.name}: typed in once it stops working`
				: `Typed into ${target.name}’s terminal as its next prompt`
			: target.blocked === 'item'
				? `${target.name} has an open question in the dock; the answer is saved on the thread`
				: `${target.name} is ${target.status}: the answer is saved on the thread`
		: `Saved on the thread; ${thread.ref} reads it with helm signal show`
	const send = async (): Promise<void> => {
		if (routing) {
			setNote(`${routing.label} (still running)`)
			return
		}
		const answer = text.trim()
		if (!answer) {
			setNote('The answer is empty')
			return
		}
		setNote(null)
		// Decided at submit: the agent (or its open turn) as Jakub saw it; main checks it again before typing.
		const delivery = target?.delivery ?? null
		const deliver = target && delivery ? target : null
		const prompt = replyPrompt(thread, answer)
		const session = target?.session
		const effect =
			!session || !delivery
				? null
				: delivery.via === 'turn'
					? () => dock.act({ itemId: delivery.itemId, action: { type: 'prompt', text: prompt } })
					: () =>
							dock.prompt({
								session: session.key,
								...(session.sessionId ? { sessionId: session.sessionId } : {}),
								...(session.lastMessage ? { assistantUuid: session.lastMessage.uuid } : {}),
								queue: true,
								handoff: true,
								text: prompt,
							})
		const failed = await onRoute({
			id: thread.id,
			type: 'reply',
			label: deliver ? `Replying to ${deliver.name}…` : 'Saving the answer…',
			flowAlive: () => alive.current,
			attempt: async () => {
				const saved = await service.reply(thread.id, { text: answer })
				if (saved.error !== undefined) return { failed: `Not saved: ${saved.error}` }
				if (!deliver || !effect)
					return { closed: `Saved on #${thread.id}. ${thread.ref} reads it with helm signal show`, thread: saved.data }
				const outcome = (await effect()).outcome
				if (outcome.status !== 'sent')
					return {
						closed:
							outcome.status === 'unconfirmed'
								? `Saved on #${thread.id}; delivery not confirmed: ${outcome.detail}. Check ${deliver.name} before replying again`
								: `Saved on #${thread.id}; not delivered: ${outcome.detail}`,
						thread: saved.data,
					}
				const queued = outcome.delivery === 'queued' || outcome.delivery === 'channel'
				return {
					agent: deliver.name,
					how: 'replied',
					done: queued ? `Queued the answer for ${deliver.name}` : `Replied to ${deliver.name}`,
					unsaved: error =>
						`${queued ? `Queued the answer for ${deliver.name}` : `Replied to ${deliver.name}`}; the receipt was not saved: ${error}`,
					thread: saved.data,
				}
			},
		})
		if (failed !== null && alive.current) setNote(failed)
	}
	return (
		<div
			ref={takeAnswerKeys}
			tabIndex={-1}
			className="signals-flow-keys"
			onKeyDown={flowKeys({ count: 0, onPick: () => undefined, onSubmit: () => void send(), onClose: () => onClose() })}
		>
			<FlowHeader glyph="↩" kind={`Reply to ${thread.ref}`} context={thread.title} onClose={() => onClose()} />
			<div className="signals-scroll signals-flow">
				<p className="signals-ask-title">{thread.title}</p>
				{thread.body ? <p className="signals-ask-body">{thread.body}</p> : null}
				{thread.links.length > 0 ? <AskLinks links={thread.links} /> : null}
				<label className="signals-prompt">
					<span className="signals-field-label">Answer</span>
					<textarea
						className="signals-prompt-input signals-answer-input"
						value={text}
						maxLength={REPLY_MAX}
						spellCheck
						onChange={event => setText(event.target.value)}
					/>
				</label>
			</div>
			<footer className="signals-foot">
				<span className="signals-foot-hints" aria-hidden="true">
					<Hint keys={submitKeys(mod)}>send</Hint>
					<Hint keys="esc">back</Hint>
				</span>
				<output className="signals-note">{note ?? (routing ? routing.label : where)}</output>
				<span className="signals-foot-actions">
					<Btn
						tone="primary"
						sm
						className="signals-key"
						busy={routing !== null}
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

/**
 * `r` on a Slack row: Jakub types a reply that is posted to that DM/thread and closes the thread.
 * Variant A (heads only): shows the thread's ref, the latest line, and an answer field. The thread
 * text is third-party data, shown as plain text; the answer is Jakub's own words.
 */
function SlackReplyFlow({
	thread,
	service,
	mod,
	onClose,
	onThread,
}: {
	thread: SignalThread
	service: SignalsService
	mod: 'cmd' | 'ctrl'
	onClose(message?: string | null): void
	onThread(thread: SignalThread): void
}) {
	const [text, setText] = useState('')
	const [note, setNote] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const alive = useRef(true)
	useEffect(
		() => () => {
			alive.current = false
		},
		[],
	)
	const send = async (): Promise<void> => {
		const answer = text.trim()
		if (!answer) {
			setNote('The reply is empty')
			return
		}
		if (busy) return
		setBusy(true)
		setNote(null)
		const result = await service.slackReply(thread.id, { text: answer })
		if (!alive.current) return
		setBusy(false)
		if (result.error !== undefined) {
			setNote(`Not sent: ${result.error}`)
			return
		}
		onThread(result.data)
		onClose(`Replied to ${thread.ref} in Slack`)
	}
	return (
		<div
			ref={takeAnswerKeys}
			tabIndex={-1}
			className="signals-flow-keys"
			onKeyDown={flowKeys({ count: 0, onPick: () => undefined, onSubmit: () => void send(), onClose: () => onClose() })}
		>
			<FlowHeader glyph="↩" kind={`Reply to ${thread.ref}`} context={thread.title} onClose={() => onClose()} />
			<div className="signals-scroll signals-flow">
				<p className="signals-ask-title">{thread.title}</p>
				<p className="signals-ask-body">{thread.head}</p>
				<label className="signals-prompt">
					<span className="signals-field-label">Reply</span>
					<textarea
						className="signals-prompt-input signals-answer-input"
						value={text}
						maxLength={4000}
						spellCheck
						onChange={event => setText(event.target.value)}
					/>
				</label>
			</div>
			<footer className="signals-foot">
				<span className="signals-foot-hints" aria-hidden="true">
					<Hint keys={submitKeys(mod)}>send</Hint>
					<Hint keys="esc">back</Hint>
				</span>
				<output className="signals-note">{note ?? `Posts to ${thread.ref} on Slack and closes the thread`}</output>
				<span className="signals-foot-actions">
					<Btn
						tone="primary"
						sm
						className="signals-key"
						busy={busy}
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

/**
 * `↵` on an agent answer: the whole answer, read (13/20, line breaks kept, plain untrusted text), its
 * links as numbered plain-text lines (1–9 opens one). Nothing to send back: `d` (or Done) closes it
 * once read; with `closesOnLeave` (the `read-closes` review layout) going back closes it too.
 */
function ReadFlow({
	thread,
	now,
	closesOnLeave,
	onOpen,
	onDone,
	onClose,
}: {
	thread: SignalThread
	now: number
	closesOnLeave: boolean
	/** Resolves with the failure note, or null once opened. */
	onOpen(index: number): Promise<string | null>
	/** Closes the answer (done), then back. */
	onDone(): void
	onClose(message?: string | null): void
}) {
	const [note, setNote] = useState<string | null>(null)
	const opening = useRef(false)
	const alive = useRef(true)
	useEffect(
		() => () => {
			alive.current = false
		},
		[],
	)
	const open = thread.state !== 'done'
	const leave = (): void => {
		if (closesOnLeave && open) onDone()
		else onClose()
	}
	const openLink = async (index: number): Promise<void> => {
		if (opening.current || index < 0 || index >= thread.links.length) return
		opening.current = true
		try {
			const failed = await onOpen(index)
			if (alive.current) setNote(failed ?? `Opened link ${index + 1}`)
		} finally {
			opening.current = false
		}
	}
	const keys = flowKeys({
		count: thread.links.length,
		onPick: index => void openLink(index),
		onSubmit: () => undefined,
		onClose: leave,
	})
	const age = formatAgo(now - Date.parse(thread.lastActivityAt))
	return (
		<div
			ref={takeKeys}
			tabIndex={-1}
			className="signals-flow-keys"
			data-flow="read"
			onKeyDown={event => {
				keys(event)
				if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
				if (event.key === 'd' && open) {
					event.preventDefault()
					event.stopPropagation()
					onDone()
				}
			}}
		>
			<FlowHeader glyph="↳" kind={`Answer from ${thread.ref}`} context={age} onClose={leave} />
			<div className="signals-scroll signals-flow">
				<p className="signals-ask-title">{thread.title}</p>
				{thread.body ? <p className="signals-ask-body">{thread.body}</p> : null}
				{thread.links.length > 0 ? <AskLinks links={thread.links} numbered /> : null}
			</div>
			<footer className="signals-foot">
				<span className="signals-foot-hints" aria-hidden="true">
					{thread.links.length > 0 ? (
						<Hint keys={pickRange(thread.links.length)} pick>
							open
						</Hint>
					) : null}
					{open ? <Hint keys="d">done</Hint> : null}
					<Hint keys="esc">{closesOnLeave && open ? 'done and back' : 'back'}</Hint>
				</span>
				<output className="signals-note">
					{note ??
						(open
							? closesOnLeave
								? 'Going back closes it as read'
								: 'Close it once read; it stays in Answers until then'
							: 'Read and closed')}
				</output>
				{open ? (
					<span className="signals-foot-actions">
						<Btn sm ariaKeyShortcuts="d" onClick={onDone}>
							Done
						</Btn>
					</span>
				) : null}
			</footer>
		</div>
	)
}

/** `o` on an ask with several links: each shown as text; 1–9 (or a click) opens that one. */
function LinksFlow({
	thread,
	onOpen,
	onClose,
}: {
	thread: SignalThread
	/** Resolves with the failure note, or null once opened. */
	onOpen(index: number): Promise<string | null>
	onClose(message?: string | null): void
}) {
	const [note, setNote] = useState<string | null>(null)
	const opening = useRef(false)
	const alive = useRef(true)
	useEffect(
		() => () => {
			alive.current = false
		},
		[],
	)
	const open = async (index: number): Promise<void> => {
		if (opening.current || index < 0 || index >= thread.links.length) return
		opening.current = true
		try {
			const failed = await onOpen(index)
			if (!alive.current) return
			// Opened: back to the list, whose note already says which link opened.
			if (failed === null) onClose()
			else setNote(failed)
		} finally {
			opening.current = false
		}
	}
	return (
		<div
			ref={takeKeys}
			tabIndex={-1}
			className="signals-flow-keys"
			onKeyDown={flowKeys({
				count: thread.links.length,
				onPick: index => void open(index),
				onSubmit: () => undefined,
				onClose: () => onClose(),
			})}
		>
			<FlowHeader glyph="↗" kind="Open a link" context={`${thread.ref} · ${thread.title}`} onClose={() => onClose()} />
			<div className="signals-scroll signals-flow">
				<div className="signals-choices" aria-label="Links">
					{thread.links.map((link, index) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: links are positional (openLink takes the index and the link shown)
							key={index}
							type="button"
							className="signals-choice"
							title={link}
							onClick={() => void open(index)}
						>
							<span className="signals-choice-mark" />
							<span className="signals-choice-label signals-ask-link">{link}</span>
							<span className="signals-choice-n">{index < PICK_MAX ? index + 1 : ''}</span>
						</button>
					))}
				</div>
			</div>
			<footer className="signals-foot">
				<span className="signals-foot-hints" aria-hidden="true">
					<Hint keys={pickRange(thread.links.length)} pick>
						open
					</Hint>
					<Hint keys="esc">back</Hint>
				</span>
				<output className="signals-note">{note ?? 'Opens in the browser'}</output>
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
	/** Gives the column the keys: an open flow (a reply's answer field), else the list. */
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
				host.querySelector<HTMLElement>('.signals-answer-input') ??
				host.querySelector<HTMLElement>('.signals-flow-keys') ??
				host.querySelector<HTMLElement>('section.signals')
			)?.focus({ preventScroll: true })
		},
		dispose() {
			// Unmount outside any React commit that may be disposing this mount (a fixture effect cleanup).
			queueMicrotask(() => root.unmount())
		},
	}
}
