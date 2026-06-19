import { type Accessor, For, type JSX, Match, Show, Switch, createEffect, createSignal, onCleanup } from 'solid-js'
import { type PlanInfo, type SolverAgent, type TaskRecord, api, getServerUrl } from './api'

type Tone = 'gray' | 'blue' | 'green' | 'amber' | 'red'

const STATUS_TONE: Record<string, Tone> = {
	queued: 'gray',
	processing: 'blue',
	completed: 'green',
	failed: 'red',
	cancelled: 'amber',
	skipped: 'gray',
}

const toneOf = (map: Record<string, Tone>, key: string | null | undefined): Tone => (key && map[key]) || 'gray'

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const agentLabel = (agent: SolverAgent) => (agent === 'codex' ? 'Codex' : 'Claude')
const isSolverAgent = (value: unknown): value is SolverAgent => value === 'claude' || value === 'codex'

/** What the widget should show, derived once and shared by the pill and the card. */
type View =
	| { kind: 'none' }
	| { kind: 'error' }
	| { kind: 'untracked'; solvable: boolean }
	| { kind: 'task'; task: TaskRecord }

export function Widget(props: { taskId: Accessor<string | null> }) {
	const [task, setTask] = createSignal<TaskRecord | null>(null)
	const [expanded, setExpanded] = createSignal(false)
	// connError = connectivity/poll failures, cleared on a successful poll.
	// actionError = explicit action (plan/solve/start/retry/...) failures, sticky
	// until the user takes another action or dismisses. Splitting them keeps a
	// real failure visible — a poll tick used to wipe it within 5s.
	const [connError, setConnError] = createSignal<string | null>(null)
	const [actionError, setActionError] = createSignal<string | null>(null)
	const [projects, setProjects] = createSignal<string[]>([])
	const [serverUrl, setServerUrl] = createSignal<string>('http://localhost:7474')
	const [planInfo, setPlanInfo] = createSignal<PlanInfo | null>(null)
	const [planPending, setPlanPending] = createSignal(false)
	const [solverAgent, setSolverAgent] = createSignal<SolverAgent>('claude')
	const [agentTouched, setAgentTouched] = createSignal(false)

	getServerUrl().then(setServerUrl)

	// Load projects on mount
	api
		.config()
		.then(c => {
			setProjects(c.projects.map(p => p.slug))
			const configAgent = c.solver?.agent ?? 'claude'
			chrome.storage.sync.get({ solverAgent: configAgent }, items => {
				if (isSolverAgent(items.solverAgent)) setSolverAgent(items.solverAgent)
			})
		})
		.catch(err => {
			console.warn('[vigil]', err)
			setConnError('Cannot connect to Vigil')
		})

	const dashboardUrl = () => {
		const t = task()
		return t ? `${serverUrl()}/#task/${t.id}` : null
	}

	// Poll for task data
	createEffect(() => {
		const id = props.taskId()
		if (!id) {
			setTask(null)
			setConnError(null)
			setActionError(null)
			setAgentTouched(false)
			return
		}

		const taskId = id
		let active = true
		setAgentTouched(false)

		async function lookup() {
			if (!active) return
			try {
				const result = await api.findTask(taskId)
				if (active) {
					setTask(result)
					if (result?.solverAgent && !agentTouched()) setSolverAgent(result.solverAgent)
					setConnError(null)
				}
			} catch (err) {
				if (active) setConnError(err instanceof Error ? err.message : 'Connection failed')
			}
		}

		lookup()
		const interval = setInterval(lookup, 5000)
		onCleanup(() => {
			active = false
			clearInterval(interval)
		})
	})

	async function doAction(fn: () => Promise<unknown>) {
		setActionError(null)
		try {
			await fn()
			const id = props.taskId()
			if (id) {
				const result = await api.findTask(id)
				setTask(result)
			}
		} catch (err) {
			setActionError(err instanceof Error ? err.message : 'Action failed')
		}
	}

	async function solve() {
		const id = props.taskId()
		if (!id || projects().length === 0) return
		await doAction(() => api.createTask(id, solverAgent()))
	}

	async function handleDelete() {
		const t = task()
		if (!t) return
		await api.deleteTask(t.id)
		setTask(null)
		setExpanded(false)
	}

	async function handlePlan() {
		const t = task()
		if (!t) return
		setActionError(null)
		setPlanPending(true)
		try {
			const info = await api.plan(t.id, solverAgent())
			setPlanInfo(info)
		} catch (err) {
			setActionError(err instanceof Error ? err.message : 'Plan failed')
		} finally {
			setPlanPending(false)
		}
	}

	function chooseSolverAgent(agent: SolverAgent) {
		setAgentTouched(true)
		setSolverAgent(agent)
		chrome.storage.sync.set({ solverAgent: agent })
	}

	const view = (): View => {
		if (!props.taskId()) return { kind: 'none' }
		const t = task()
		if (connError() && !t) return { kind: 'error' }
		if (!t) return { kind: 'untracked', solvable: projects().length > 0 }
		return { kind: 'task', task: t }
	}

	return (
		<Show when={expanded()} fallback={<Pill view={view} onExpand={() => setExpanded(true)} onSolve={solve} />}>
			<Card
				view={view}
				dashboardUrl={dashboardUrl}
				planInfo={planInfo}
				planPending={planPending}
				solverAgent={solverAgent}
				actionError={actionError}
				onSolverAgentChange={chooseSolverAgent}
				onDismissError={() => setActionError(null)}
				onCollapse={() => setExpanded(false)}
				onSolve={solve}
				onStart={() => {
					const t = task()
					if (t) doAction(() => api.start(t.id, solverAgent()))
				}}
				onRetry={() => {
					const t = task()
					if (t) doAction(() => api.retry(t.id, solverAgent()))
				}}
				onCancel={() => {
					const t = task()
					if (t) doAction(() => api.cancel(t.id))
				}}
				onSkip={() => {
					const t = task()
					if (t) doAction(() => api.setStatus(t.id, 'skipped'))
				}}
				onDelete={handleDelete}
				onPlan={handlePlan}
			/>
		</Show>
	)
}

/** A status/tier dot. */
function Dot(props: { tone: Tone; pulse?: boolean }) {
	return <span class={`vg-dot c-${props.tone} bg-${props.tone}${props.pulse ? ' vg-dot--pulse' : ''}`} />
}

function Btn(props: {
	variant: 'primary' | 'muted' | 'danger'
	onClick: () => void
	disabled?: boolean
	children: JSX.Element
}) {
	return (
		<button type="button" class={`vg-btn vg-btn--${props.variant}`} on:click={props.onClick} disabled={props.disabled}>
			{props.children}
		</button>
	)
}

function AgentSelect(props: {
	value: Accessor<SolverAgent>
	onChange: (agent: SolverAgent) => void
	disabled?: boolean
}) {
	const options: SolverAgent[] = ['claude', 'codex']
	return (
		<div class="vg-agent">
			<span class="vg-agent__label">Agent</span>
			<div class="vg-agent__seg" aria-label="Solver agent">
				<For each={options}>
					{agent => (
						<button
							type="button"
							class={`vg-agent__option${props.value() === agent ? ' is-active' : ''}`}
							aria-pressed={props.value() === agent}
							disabled={props.disabled}
							on:click={() => props.onChange(agent)}
						>
							{agentLabel(agent)}
						</button>
					)}
				</For>
			</div>
		</div>
	)
}

function Pill(props: { view: Accessor<View>; onExpand: () => void; onSolve: () => void }) {
	const v = props.view
	return (
		<Switch>
			<Match when={v().kind === 'none'}>
				<button type="button" class="vg-pill" on:click={props.onExpand}>
					<span class="vg-pill__brand">V</span>
					<span class="vg-pill__label vg-pill__label--faint">No task</span>
				</button>
			</Match>
			<Match when={v().kind === 'error'}>
				<button type="button" class="vg-pill" on:click={props.onExpand}>
					<Dot tone="red" />
					<span class="vg-pill__label vg-pill__label--danger">Error</span>
				</button>
			</Match>
			<Match when={v().kind === 'untracked'}>
				<Show
					when={(v() as { kind: 'untracked'; solvable: boolean }).solvable}
					fallback={
						<button type="button" class="vg-pill" on:click={props.onExpand}>
							<Dot tone="gray" />
							<span class="vg-pill__label vg-pill__label--faint">Not tracked</span>
						</button>
					}
				>
					<button type="button" class="vg-pill vg-pill--cta" on:click={props.onSolve}>
						<span class="vg-pill__brand">V</span>
						<span class="vg-pill__label vg-pill__label--accent">Solve</span>
					</button>
				</Show>
			</Match>
			<Match when={asTask(v())}>
				{task => (
					<button type="button" class="vg-pill" on:click={props.onExpand}>
						<Dot tone={toneOf(STATUS_TONE, task().status)} pulse={task().status === 'processing'} />
						<span class="vg-pill__label">{titleCase(task().status)}</span>
					</button>
				)}
			</Match>
		</Switch>
	)
}

function Card(props: {
	view: Accessor<View>
	dashboardUrl: Accessor<string | null>
	planInfo: Accessor<PlanInfo | null>
	planPending: Accessor<boolean>
	solverAgent: Accessor<SolverAgent>
	actionError: Accessor<string | null>
	onSolverAgentChange: (agent: SolverAgent) => void
	onDismissError: () => void
	onCollapse: () => void
	onSolve: () => void
	onStart: () => void
	onRetry: () => void
	onCancel: () => void
	onSkip: () => void
	onDelete: () => void
	onPlan: () => void
}) {
	const v = props.view
	return (
		<div class="vg-card">
			<Switch>
				{/* Daemon unreachable */}
				<Match when={v().kind === 'error'}>
					<div class="vg-card__header">
						<div class="vg-card__id">
							<span class="vg-card__brand">Vigil</span>
						</div>
						<div class="vg-card__hactions">
							<button type="button" class="vg-close" on:click={props.onCollapse}>
								&times;
							</button>
						</div>
					</div>
					<div class="vg-card__body">
						<div class="vg-error">Cannot connect to Vigil</div>
						<div class="vg-text">Make sure the Vigil daemon is running.</div>
					</div>
				</Match>

				{/* Not tracked */}
				<Match when={v().kind === 'untracked'}>
					<div class="vg-card__header">
						<div class="vg-card__id">
							<span class="vg-card__brand">Vigil</span>
						</div>
						<div class="vg-card__hactions">
							<button type="button" class="vg-close" on:click={props.onCollapse}>
								&times;
							</button>
						</div>
					</div>
					<div class="vg-card__body">
						<div class="vg-text vg-text--primary">This task isn’t tracked by Vigil yet.</div>
						<Show when={!(v() as { kind: 'untracked'; solvable: boolean }).solvable}>
							<div class="vg-text">No projects are configured.</div>
						</Show>
						<Show when={(v() as { kind: 'untracked'; solvable: boolean }).solvable}>
							<AgentSelect value={props.solverAgent} onChange={props.onSolverAgentChange} />
						</Show>
					</div>
					<Show when={(v() as { kind: 'untracked'; solvable: boolean }).solvable}>
						<div class="vg-card__actions">
							<Btn variant="primary" onClick={props.onSolve}>
								Solve with Vigil
							</Btn>
						</div>
					</Show>
				</Match>

				{/* Tracked task */}
				<Match when={asTask(v())}>
					{task => {
						const statusTone = () => toneOf(STATUS_TONE, task().status)
						const isQueued = () => task().status === 'queued'
						const isProcessing = () => task().status === 'processing'
						return (
							<>
								<div class="vg-card__header">
									<div class="vg-card__id">
										<Dot tone={statusTone()} pulse={isProcessing()} />
										<span class="vg-card__status">{titleCase(task().status)}</span>
									</div>
									<div class="vg-card__hactions">
										<Show when={props.dashboardUrl()}>
											{url => (
												<a class="vg-link-open" href={url()} target="_blank" rel="noreferrer">
													Open ↗
												</a>
											)}
										</Show>
										<button type="button" class="vg-close" on:click={props.onCollapse}>
											&times;
										</button>
									</div>
								</div>

								<div class="vg-card__body">
									<AgentSelect
										value={props.solverAgent}
										onChange={props.onSolverAgentChange}
										disabled={isProcessing()}
									/>
									<Show when={props.actionError()}>
										{msg => (
											<div class="vg-error vg-error--dismissible">
												<span>{msg()}</span>
												<button type="button" class="vg-error__dismiss" on:click={props.onDismissError}>
													&times;
												</button>
											</div>
										)}
									</Show>
									<Show when={task().solverSummary}>
										<div class="vg-summary">{task().solverSummary}</div>
									</Show>
									<Show when={task().errorMessage}>
										<div class="vg-error">{task().errorMessage}</div>
									</Show>
									<Show when={task().prUrl}>
										{prUrl => (
											<a class="vg-pr" href={prUrl()} target="_blank" rel="noreferrer">
												🔗 {formatPr(prUrl())}
											</a>
										)}
									</Show>
									<Show when={props.planInfo()}>
										{info => (
											<div class="vg-plan">
												<span>
													{agentLabel(info().solverAgent)} planning started for <code>{info().planDirName}</code>.
												</span>
												<span>
													Tell it what you want, or run <code>/grill-me {info().planDirName}</code> /{' '}
													<code>/grill-plan {info().planDirName}</code>.
												</span>
											</div>
										)}
									</Show>
								</div>

								<div class="vg-card__actions">
									<Btn variant="muted" onClick={props.onPlan} disabled={props.planPending() || isProcessing()}>
										{props.planPending() ? 'Planning…' : props.planInfo() ? 'Re-plan' : 'Plan'}
									</Btn>
									<Show when={isQueued()}>
										<Btn variant="primary" onClick={props.onStart}>
											Start
										</Btn>
										<span class="vg-spacer" />
										<Btn variant="muted" onClick={props.onSkip}>
											Skip
										</Btn>
									</Show>
									<Show when={isProcessing()}>
										<span class="vg-spacer" />
										<Btn variant="danger" onClick={props.onCancel}>
											Cancel
										</Btn>
									</Show>
									<Show when={!isQueued() && !isProcessing()}>
										<Btn variant="primary" onClick={props.onRetry}>
											Re-queue
										</Btn>
										<span class="vg-spacer" />
										<Btn variant="danger" onClick={props.onDelete}>
											Delete
										</Btn>
									</Show>
								</div>
							</>
						)
					}}
				</Match>
			</Switch>
		</div>
	)
}

/** Narrowing helper for the `task` view inside Solid's `<Match>`. */
function asTask(v: View): TaskRecord | false {
	return v.kind === 'task' && v.task
}

function formatPr(url: string): string {
	const m = url.match(/\/pull\/(\d+)/)
	return m ? `PR #${m[1]}` : 'Pull Request'
}
