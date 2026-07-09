import { type Accessor, For, type JSX, Match, Show, Switch, createEffect, createSignal, onCleanup } from 'solid-js'
import {
	type DashboardAction,
	type DashboardActionId,
	type DashboardItem,
	type DashboardLink,
	type DashboardTone,
	type ModelOption,
	type PlanInfo,
	type SolveSelection,
	type SolverAgent,
	api,
	getServerUrl,
} from './api'
import { DEFAULT_SERVER_URL, getSync, setSync } from './storage'

type Tone = DashboardTone

const agentLabel = (agent: SolverAgent) => (agent === 'codex' ? 'Codex' : 'Claude')
const isSolverAgent = (value: unknown): value is SolverAgent => value === 'claude' || value === 'codex'

/** What the widget should show, derived once and shared by the pill and the card. */
type View =
	| { kind: 'none' }
	| { kind: 'error' }
	| { kind: 'untracked'; solvable: boolean }
	| { kind: 'item'; item: DashboardItem }

export interface ItemRunNotice {
	kind: 'summary' | 'failure'
	text: string
}

export function itemRunNotices(item: DashboardItem): ItemRunNotice[] {
	const failureReason = item.runObservation.almanac.failureReason
	const loopSummary =
		item.runObservation.source === 'loop' ? (item.runObservation.almanac.summary ?? item.runObservation.summary) : null
	const summary = item.resultSummary ?? loopSummary
	const notices: ItemRunNotice[] = []
	if (summary && summary !== failureReason) notices.push({ kind: 'summary', text: summary })
	if (failureReason) notices.push({ kind: 'failure', text: failureReason })
	return notices
}

/**
 * Extension action list. From the in-page widget, the server's two-step "approve
 * (→ ready, wait for the drainer)" is pointless — the operator is looking at the
 * task and wants it solved now — so `approve` becomes `start`, which runs the
 * Item immediately (bypasses the queue + pause). `reject` and everything else
 * pass through untouched.
 */
export function extensionItemActions(actions: DashboardAction[]): DashboardAction[] {
	return actions.map(action => (action.id === 'approve' ? { id: 'start', label: 'Start', tone: 'primary' } : action))
}

export function Widget(props: { taskId: Accessor<string | null> }) {
	const [item, setItem] = createSignal<DashboardItem | null>(null)
	const [expanded, setExpanded] = createSignal(false)
	// connError = connectivity/poll failures, cleared on a successful poll.
	// actionError = explicit action (plan/solve/start/retry/...) failures, sticky
	// until the user takes another action or dismisses. Splitting them keeps a
	// real failure visible — a poll tick used to wipe it within 5s.
	const [connError, setConnError] = createSignal<string | null>(null)
	const [actionError, setActionError] = createSignal<string | null>(null)
	const [projects, setProjects] = createSignal<string[]>([])
	const [serverUrl, setServerUrl] = createSignal<string>(DEFAULT_SERVER_URL)
	const [planInfo, setPlanInfo] = createSignal<PlanInfo | null>(null)
	const [planPending, setPlanPending] = createSignal(false)
	const [solverAgent, setSolverAgent] = createSignal<SolverAgent>('claude')
	const [agentTouched, setAgentTouched] = createSignal(false)
	// '' = no per-item override — the daemon's configured model. Persisted like
	// the agent choice so the quick-switch survives popup/tab reloads.
	const [solverModel, setSolverModel] = createSignal<string>('')
	const [modelTouched, setModelTouched] = createSignal(false)
	const [modelCatalog, setModelCatalog] = createSignal<Record<SolverAgent, ModelOption[]>>({ claude: [], codex: [] })
	const [favoriteModels, setFavoriteModels] = createSignal<string[]>([])

	getServerUrl().then(setServerUrl)

	// Load projects on mount
	api
		.config()
		.then(c => {
			setProjects(c.projects.map(p => p.slug))
			if (c.modelCatalog) setModelCatalog(c.modelCatalog)
			const configAgent = c.solver?.agent ?? 'claude'
			getSync({ solverAgent: configAgent, solverModel: '', favoriteModels: [] as string[] })
				.then(items => {
					if (!agentTouched() && isSolverAgent(items.solverAgent)) setSolverAgent(items.solverAgent)
					if (!modelTouched() && typeof items.solverModel === 'string') setSolverModel(items.solverModel)
					if (Array.isArray(items.favoriteModels)) {
						setFavoriteModels(items.favoriteModels.filter((m): m is string => typeof m === 'string'))
					}
				})
				.catch(err => console.warn('[vigil]', err))
		})
		.catch(err => {
			console.warn('[vigil]', err)
			setConnError('Cannot connect to Vigil')
		})

	const dashboardUrl = () => {
		const i = item()
		return i ? `${serverUrl()}/#item/${i.id}` : null
	}

	// Poll for the Item backing this source task
	createEffect(() => {
		const id = props.taskId()
		if (!id) {
			setItem(null)
			setConnError(null)
			setActionError(null)
			setAgentTouched(false)
			return
		}

		const sourceId = id
		let active = true
		setAgentTouched(false)

		async function lookup() {
			if (!active) return
			try {
				const contractItem = await api.findItemBySource(sourceId)
				if (active) {
					setItem(contractItem)
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
			if (id) setItem(await api.findItemBySource(id))
		} catch (err) {
			setActionError(err instanceof Error ? err.message : 'Action failed')
		}
	}

	async function solve() {
		const id = props.taskId()
		if (!id || projects().length === 0) return
		await doAction(() => api.createItemFromSource(id))
	}

	// Favorite models for the current agent — quick-switch chips. An empty
	// favorites list falls back to the whole catalog so the switch works before
	// any favorites are picked in the extension popup.
	const modelOptions = (): ModelOption[] => {
		const all = modelCatalog()[solverAgent()] ?? []
		const picked = all.filter(m => favoriteModels().includes(m.id))
		return picked.length > 0 ? picked : all
	}

	// The model actually SENT must be a chip the user can see — a persisted pick
	// that fell out of the rendered options (favorites changed, agent switched,
	// catalog updated) degrades to Auto instead of silently riding along.
	const effectiveModel = (): string => {
		const m = solverModel()
		return m && modelOptions().some(o => o.id === m) ? m : ''
	}

	const selection = (): SolveSelection => ({
		solverAgent: solverAgent(),
		// null = explicitly clear any stored per-item override ("Auto").
		solverModel: effectiveModel() || null,
	})

	async function handlePlan() {
		const i = item()
		if (!i) return
		setActionError(null)
		setPlanPending(true)
		try {
			setPlanInfo(await api.planItem(i.id, selection()))
		} catch (err) {
			setActionError(err instanceof Error ? err.message : 'Plan failed')
		} finally {
			setPlanPending(false)
		}
	}

	function chooseSolverAgent(agent: SolverAgent) {
		setAgentTouched(true)
		setSolverAgent(agent)
		void setSync({ solverAgent: agent })
		// A model id belongs to one agent's CLI — switching agents drops a
		// now-foreign override back to the daemon default.
		if (solverModel() && !(modelCatalog()[agent] ?? []).some(m => m.id === solverModel())) {
			chooseSolverModel('')
		}
	}

	function chooseSolverModel(model: string) {
		setModelTouched(true)
		setSolverModel(model)
		void setSync({ solverModel: model })
	}

	const view = (): View => {
		if (!props.taskId()) return { kind: 'none' }
		const i = item()
		if (i) return { kind: 'item', item: i }
		if (connError()) return { kind: 'error' }
		return { kind: 'untracked', solvable: projects().length > 0 }
	}

	return (
		<Show when={expanded()} fallback={<Pill view={view} onExpand={() => setExpanded(true)} onSolve={solve} />}>
			<Card
				view={view}
				dashboardUrl={dashboardUrl}
				planInfo={planInfo}
				planPending={planPending}
				solverAgent={solverAgent}
				solverModel={effectiveModel}
				modelOptions={modelOptions}
				actionError={actionError}
				onSolverAgentChange={chooseSolverAgent}
				onSolverModelChange={chooseSolverModel}
				onDismissError={() => setActionError(null)}
				onCollapse={() => setExpanded(false)}
				onSolve={solve}
				onItemAction={action => {
					const i = item()
					if (i) doAction(() => api.itemAction(i.id, action, selection()))
				}}
				onPlan={handlePlan}
			/>
		</Show>
	)
}

/** A dashboard status tone dot. */
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

/**
 * Quick-switch between favorite models for the selected agent — a compact
 * dropdown so the row never wraps. "Auto" = no per-item override (the
 * daemon's configured model). Hidden when the daemon didn't provide a
 * catalog (older server).
 */
function ModelSelect(props: {
	value: Accessor<string>
	options: Accessor<ModelOption[]>
	onChange: (model: string) => void
	disabled?: boolean
}) {
	return (
		<Show when={props.options().length > 0}>
			<div class="vg-agent">
				<span class="vg-agent__label">Model</span>
				<select
					class="vg-model-select"
					aria-label="Solver model"
					disabled={props.disabled}
					value={props.value()}
					on:change={e => props.onChange((e.currentTarget as HTMLSelectElement).value)}
				>
					<option value="">Auto</option>
					<For each={props.options()}>
						{model => (
							<option value={model.id} selected={props.value() === model.id}>
								{model.label}
							</option>
						)}
					</For>
				</select>
			</div>
		</Show>
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
			<Match when={asItem(v())}>
				{item => (
					<button type="button" class="vg-pill" on:click={props.onExpand}>
						<Dot tone={item().card.statusTone} pulse={item().card.pulse} />
						<span class="vg-pill__label">{item().card.statusLabel}</span>
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
	solverModel: Accessor<string>
	modelOptions: Accessor<ModelOption[]>
	actionError: Accessor<string | null>
	onSolverAgentChange: (agent: SolverAgent) => void
	onSolverModelChange: (model: string) => void
	onDismissError: () => void
	onCollapse: () => void
	onSolve: () => void
	onItemAction: (action: DashboardActionId) => void
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

				{/* Tracked Item */}
				<Match when={asItem(v())}>
					{item => {
						const isProcessing = () => item().status === 'running'
						return (
							<>
								<div class="vg-card__header">
									<div class="vg-card__id">
										<Dot tone={item().card.statusTone} pulse={item().card.pulse} />
										<span class="vg-card__status">{item().card.statusLabel}</span>
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
									<div class="vg-text vg-text--primary vg-text--oneline" title={item().title}>
										{item().title}
									</div>
									<LinkLine label="Branch" link={item().links.branch} />
									<LinkLine label="PR" link={item().links.pr} />
									<AgentSelect
										value={props.solverAgent}
										onChange={props.onSolverAgentChange}
										disabled={isProcessing()}
									/>
									<ModelSelect
										value={props.solverModel}
										options={props.modelOptions}
										onChange={props.onSolverModelChange}
										disabled={isProcessing()}
									/>
									<For each={itemRunNotices(item())}>
										{notice => (
											<div class={notice.kind === 'failure' ? 'vg-error' : 'vg-summary'}>
												{notice.kind === 'failure' ? `Failure: ${notice.text}` : notice.text}
											</div>
										)}
									</For>
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
									<Show when={item().errorMessage}>{message => <div class="vg-error">{message()}</div>}</Show>
								</div>

								<div class="vg-card__actions">
									<Btn variant="muted" onClick={props.onPlan} disabled={props.planPending() || isProcessing()}>
										{props.planPending() ? 'Planning…' : props.planInfo() || item().plan ? 'Re-plan' : 'Plan'}
									</Btn>
									<Show when={item().allowedActions.length > 0}>
										<For each={extensionItemActions(item().allowedActions)}>
											{action => (
												<Btn variant={action.tone} onClick={() => props.onItemAction(action.id)}>
													{action.label}
												</Btn>
											)}
										</For>
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

function LinkLine(props: { label: string; link: DashboardLink | null }) {
	return (
		<Show when={props.link}>
			{link => (
				<div class="vg-link-line">
					<span>{props.label}</span>
					<Show when={link().url} fallback={<span class="vg-link-line__value">{link().label}</span>}>
						{url => (
							<a href={url()} target="_blank" rel="noreferrer">
								{link().label}
							</a>
						)}
					</Show>
				</div>
			)}
		</Show>
	)
}

/** Narrowing helper for Solid's `<Match>`. */
function asItem(v: View): DashboardItem | false {
	return v.kind === 'item' && v.item
}
