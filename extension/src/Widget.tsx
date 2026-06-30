import { type Accessor, For, type JSX, Match, Show, Switch, createEffect, createSignal, onCleanup } from 'solid-js'
import {
	type DashboardActionId,
	type DashboardItem,
	type DashboardLink,
	type DashboardPlan,
	type DashboardTone,
	type PlanInfo,
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

type DisplayPlan = PlanInfo | DashboardPlan

function planLeadPrefix(plan: DisplayPlan): string {
	if ('spawner' in plan) return `${plan.spawner} planning started for`
	return 'Plan prepared for'
}

export function planLeadText(plan: DisplayPlan): string {
	return `${planLeadPrefix(plan)} ${plan.planDirName}.`
}

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

export function itemMetaLabels(item: DashboardItem): string[] {
	return [item.kind, item.projectSlug, ...(item.group ? [item.group.label] : [])]
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

	getServerUrl().then(setServerUrl)

	// Load projects on mount
	api
		.config()
		.then(c => {
			setProjects(c.projects.map(p => p.slug))
			const configAgent = c.solver?.agent ?? 'claude'
			getSync({ solverAgent: configAgent })
				.then(items => {
					if (!agentTouched() && isSolverAgent(items.solverAgent)) setSolverAgent(items.solverAgent)
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

	async function handlePlan() {
		const i = item()
		if (!i) return
		setActionError(null)
		setPlanPending(true)
		try {
			setPlanInfo(await api.planItem(i.id, solverAgent()))
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
				actionError={actionError}
				onSolverAgentChange={chooseSolverAgent}
				onDismissError={() => setActionError(null)}
				onCollapse={() => setExpanded(false)}
				onSolve={solve}
				onItemAction={action => {
					const i = item()
					if (i) doAction(() => api.itemAction(i.id, action, solverAgent()))
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

function PlanInfoBlock(props: { planInfo: Accessor<PlanInfo | null>; plan?: Accessor<DashboardPlan | null> }) {
	const info = () => props.planInfo() ?? props.plan?.() ?? null
	return (
		<Show when={info()}>
			{plan => (
				<div class="vg-plan">
					<span>
						<PlanLead plan={plan()} />
					</span>
					<span>
						Tell it what you want, or run <code>/grill-me {plan().planDirName}</code> /{' '}
						<code>/grill-plan {plan().planDirName}</code>.
					</span>
				</div>
			)}
		</Show>
	)
}

function PlanLead(props: { plan: DisplayPlan }) {
	return (
		<>
			{planLeadPrefix(props.plan)} <code>{props.plan.planDirName}</code>.
		</>
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
	actionError: Accessor<string | null>
	onSolverAgentChange: (agent: SolverAgent) => void
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
									<div class="vg-text vg-text--primary">{item().title}</div>
									<div class="vg-item-meta">
										<For each={itemMetaLabels(item())}>
											{(label, index) => (
												<Show when={index() === 0} fallback={<span>{label}</span>}>
													<span class="vg-chip chip-gray">{label}</span>
												</Show>
											)}
										</For>
									</div>
									<LinkLine label="Source" link={item().links.source} />
									<LinkLine label="Branch" link={item().links.branch} />
									<LinkLine label="PR" link={item().links.pr} />
									<AgentSelect
										value={props.solverAgent}
										onChange={props.onSolverAgentChange}
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
									<PlanInfoBlock planInfo={props.planInfo} plan={() => item().plan} />
								</div>

								<div class="vg-card__actions">
									<Btn variant="muted" onClick={props.onPlan} disabled={props.planPending() || isProcessing()}>
										{props.planPending() ? 'Planning…' : props.planInfo() || item().plan ? 'Re-plan' : 'Plan'}
									</Btn>
									<Show when={item().allowedActions.length > 0}>
										<For each={item().allowedActions}>
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
