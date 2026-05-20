import { createSignal, createEffect, onCleanup, Show, type Accessor } from 'solid-js'
import { type PlanInfo, type TaskRecord, api, getServerUrl } from './api'

const STATUS_COLORS: Record<string, string> = {
	queued: '#808080',
	processing: '#569cd6',
	completed: '#6a9955',
	failed: '#f14c4c',
	cancelled: '#cca700',
	skipped: '#5a5a5a',
}

const TIER_COLORS: Record<string, string> = {
	trivial: '#6a9955',
	simple: '#569cd6',
	complex: '#cca700',
	unclear: '#f14c4c',
}

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
	api.config()
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

		let active = true

		async function lookup() {
			if (!active) return
			try {
				const result = await api.findTask(id!)
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
		onCleanup(() => { active = false; clearInterval(interval) })
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

	const statusColor = () => {
		const t = task()
		return t ? STATUS_COLORS[t.status] ?? '#808080' : '#808080'
	}

	return (
		<Show
			when={expanded()}
			fallback={
				<Pill
					task={task}
					taskId={props.taskId}
					error={error}
					projects={projects}
					statusColor={statusColor}
					onExpand={() => setExpanded(true)}
					onSolve={solve}
				/>
			}
		>
			<Card
				task={task}
				taskId={props.taskId}
				error={error}
				projects={projects}
				statusColor={statusColor}
				dashboardUrl={dashboardUrl}
				planInfo={planInfo}
				planPending={planPending}
				onCollapse={() => setExpanded(false)}
				onSolve={solve}
				onStart={() => doAction(() => api.start(task()!.id))}
				onRetry={() => doAction(() => api.retry(task()!.id))}
				onCancel={() => doAction(() => api.cancel(task()!.id))}
				onSkip={() => doAction(() => api.setStatus(task()!.id, 'skipped'))}
				onDelete={handleDelete}
				onPlan={handlePlan}
			/>
		</Show>
	)
}

function Pill(props: {
	task: Accessor<TaskRecord | null>
	taskId: Accessor<string | null>
	error: Accessor<string | null>
	projects: Accessor<string[]>
	statusColor: Accessor<string>
	onExpand: () => void
	onSolve: () => void
}) {
	return (
		<Show when={props.taskId()} fallback={
			<div class="pill" on:click={props.onExpand}><span class="brand">V</span><span class="pill-text muted">No task</span></div>
		}>
			<Show when={!props.error() || props.task()} fallback={
				<div class="pill" on:click={props.onExpand}><span class="dot" style={{ background: '#f14c4c' }} /><span class="pill-text" style={{ color: '#f14c4c' }}>Error</span></div>
			}>
				<Show when={props.task()} fallback={
					<Show when={props.projects().length > 0} fallback={
						<div class="pill" on:click={props.onExpand}><span class="dot" style={{ background: '#5a5a5a' }} /><span class="pill-text muted">Not tracked</span></div>
					}>
						<div class="pill pill-action" on:click={props.onSolve}><span class="brand">V</span><span class="pill-text" style={{ color: '#007acc' }}>Solve</span></div>
					</Show>
				}>
					{(t) => {
						const glow = () => t().status === 'processing' ? `0 0 6px ${props.statusColor()}` : 'none'
						return (
							<div class="pill" on:click={props.onExpand}>
								<span class="dot" style={{ background: props.statusColor(), 'box-shadow': glow() }} />
								<span class="pill-text">{t().status}</span>
							</div>
						)
					}}
				</Show>
			</Show>
		</Show>
	)
}

function Card(props: {
	task: Accessor<TaskRecord | null>
	taskId: Accessor<string | null>
	error: Accessor<string | null>
	projects: Accessor<string[]>
	statusColor: Accessor<string>
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
	return (
		<Show when={props.task()} fallback={
			<div class="card">
				<div class="card-header"><span class="brand">Vigil</span><span class="close" on:click={props.onCollapse}>&times;</span></div>
				<div class="card-body">
					<Show when={props.error()}>
						<div class="card-error">{props.error()}</div>
						<div class="card-summary">Make sure Vigil is running.</div>
					</Show>
					<Show when={!props.error()}>
						<div class="card-text">Task not tracked by Vigil.</div>
						<Show when={props.projects().length > 0}>
							<div class="card-actions"><button class="btn btn-primary" on:click={props.onSolve}>Solve with Vigil</button></div>
						</Show>
					</Show>
				</div>
			</div>
		}>
			{(t) => {
				const sc = () => props.statusColor()
				const tc = () => t().tier ? TIER_COLORS[t().tier!] ?? '#808080' : null
				const glow = () => t().status === 'processing' ? `0 0 6px ${sc()}` : 'none'

				return (
					<div class="card">
						<div class="card-header">
							<div class="card-badges">
								<span class="dot" style={{ background: sc(), 'box-shadow': glow() }} />
								<span class="badge" style={{ color: sc(), background: `${sc()}20` }}>{t().status}</span>
								<Show when={tc()}>
									<span class="badge" style={{ color: tc()!, background: `${tc()!}20` }}>{t().tier}</span>
								</Show>
							</div>
							<div class="card-header-actions">
								<Show when={props.dashboardUrl()}>
									<a
										class="header-link"
										href={props.dashboardUrl()!}
										target="_blank"
										rel="noreferrer"
										title="Open in Vigil dashboard"
									>
										Open ↗
									</a>
								</Show>
								<span class="close" on:click={props.onCollapse}>&times;</span>
							</div>
						</div>
						<div class="card-body">
							<Show when={t().solverSummary}><div class="card-summary">{t().solverSummary}</div></Show>
							<Show when={t().errorMessage}><div class="card-error">{t().errorMessage}</div></Show>
							<Show when={t().prUrl}><div class="card-pr"><a class="link" href={t().prUrl!} target="_blank">{formatPr(t().prUrl!)}</a></div></Show>
							<Show when={props.planInfo()}>
								{(info) => (
									<div class="card-plan">
										<div class="card-plan-line">Planning agent started for <code>{info().planDirName}</code>.</div>
										<div class="card-plan-line">{info().hint}</div>
										<div class="card-plan-line">Tell the agent what you want to do, or invoke <code>/grill-me {info().planDirName}</code> / <code>/grill-plan {info().planDirName}</code>.</div>
									</div>
								)}
							</Show>
							<div class="card-actions">
								<button class="btn btn-muted" on:click={props.onPlan} disabled={props.planPending() || t().status === 'processing'}>
									{props.planPending() ? 'Planning…' : props.planInfo() ? 'Re-plan' : 'Plan'}
								</button>
								<Show when={t().status === 'queued'}>
									<button class="btn btn-primary" on:click={props.onStart}>Start</button>
									<button class="btn btn-muted" on:click={props.onSkip}>Skip</button>
								</Show>
								<Show when={t().status === 'processing'}>
									<button class="btn btn-danger" on:click={props.onCancel}>Cancel</button>
								</Show>
								<Show when={t().status !== 'processing' && t().status !== 'queued'}>
									<button class="btn btn-primary" on:click={props.onRetry}>Re-queue</button>
									<button class="btn btn-danger" on:click={props.onDelete}>Delete</button>
								</Show>
							</div>
						</div>
					</div>
				)
			}}
		</Show>
	)
}

function formatPr(url: string): string {
	const m = url.match(/\/pull\/(\d+)/)
	return m ? `PR #${m[1]}` : 'Pull Request'
}
