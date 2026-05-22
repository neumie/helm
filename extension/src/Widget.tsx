import { type Accessor, type JSX, Match, Show, Switch, createEffect, createSignal, onCleanup } from 'solid-js'
import { type PlanInfo, type TaskRecord, api, getServerUrl } from './api'

type Tone = 'gray' | 'blue' | 'green' | 'amber' | 'red'

const STATUS_TONE: Record<string, Tone> = {
	queued: 'gray',
	processing: 'blue',
	completed: 'green',
	failed: 'red',
	cancelled: 'amber',
	skipped: 'gray',
}

const TIER_TONE: Record<string, Tone> = {
	trivial: 'green',
	simple: 'blue',
	complex: 'amber',
	unclear: 'red',
}

const toneOf = (map: Record<string, Tone>, key: string | null | undefined): Tone => (key && map[key]) || 'gray'

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** What the widget should show, derived once and shared by the pill and the card. */
type View =
	| { kind: 'none' }
	| { kind: 'error' }
	| { kind: 'untracked'; solvable: boolean }
	| { kind: 'task'; task: TaskRecord }

export function Widget(props: { taskId: Accessor<string | null> }) {
	const [task, setTask] = createSignal<TaskRecord | null>(null)
	const [expanded, setExpanded] = createSignal(false)
	const [error, setError] = createSignal<string | null>(null)
	const [projects, setProjects] = createSignal<string[]>([])
	const [serverUrl, setServerUrl] = createSignal<string>('http://localhost:7474')
	const [planInfo, setPlanInfo] = createSignal<PlanInfo | null>(null)
	const [planPending, setPlanPending] = createSignal(false)

	getServerUrl().then(setServerUrl)

	// Load projects on mount
	api
		.config()
		.then(c => setProjects(c.projects.map(p => p.slug)))
		.catch(err => {
			console.warn('[vigil]', err)
			setError('Cannot connect to Vigil')
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
			setError(null)
			return
		}

		const taskId = id
		let active = true

		async function lookup() {
			if (!active) return
			try {
				const result = await api.findTask(taskId)
				if (active) {
					setTask(result)
					setError(null)
				}
			} catch (err) {
				if (active) setError(err instanceof Error ? err.message : 'Connection failed')
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
		try {
			await fn()
			const id = props.taskId()
			if (id) {
				const result = await api.findTask(id)
				setTask(result)
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Action failed')
		}
	}

	async function solve() {
		const id = props.taskId()
		if (!id || projects().length === 0) return
		await doAction(() => api.createTask(id))
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
		setPlanPending(true)
		try {
			const info = await api.plan(t.id)
			setPlanInfo(info)
			setError(null)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Plan failed')
		} finally {
			setPlanPending(false)
		}
	}

	const view = (): View => {
		if (!props.taskId()) return { kind: 'none' }
		const t = task()
		if (error() && !t) return { kind: 'error' }
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
				onCollapse={() => setExpanded(false)}
				onSolve={solve}
				onStart={() => {
					const t = task()
					if (t) doAction(() => api.start(t.id))
				}}
				onRetry={() => {
					const t = task()
					if (t) doAction(() => api.retry(t.id))
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
										<Show when={task().tier}>
											{tier => <span class={`vg-chip chip-${toneOf(TIER_TONE, tier())}`}>{tier()}</span>}
										</Show>
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
													Planning agent started for <code>{info().planDirName}</code>.
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
