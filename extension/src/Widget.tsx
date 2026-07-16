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
	type SolverWorkspace,
	api,
} from './api'
import { getSync, setSync } from './storage'

type Tone = DashboardTone

const agentLabel = (agent: SolverAgent) => (agent === 'codex' ? 'Codex' : 'Claude')
const isSolverAgent = (value: unknown): value is SolverAgent => value === 'claude' || value === 'codex'
const workspaceLabel = (workspace: SolverWorkspace) => (workspace === 'main' ? 'Main' : 'Worktree')
// '' = follow the daemon default (no per-item override).
const isStoredWorkspace = (value: unknown): value is '' | SolverWorkspace =>
	value === '' || value === 'worktree' || value === 'main'

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
	// '' = no per-item override (the daemon's configured workspace). Persisted like
	// the agent/model picks so the quick-switch survives popup/tab reloads.
	const [solverWorkspace, setSolverWorkspace] = createSignal<'' | SolverWorkspace>('')
	const [workspaceTouched, setWorkspaceTouched] = createSignal(false)

	// Load projects on mount
	api
		.config()
		.then(c => {
			setProjects(c.projects.map(p => p.slug))
			if (c.modelCatalog) setModelCatalog(c.modelCatalog)
			const configAgent = c.solver?.agent ?? 'claude'
			getSync({ solverAgent: configAgent, solverModel: '', solverWorkspace: '', favoriteModels: [] as string[] })
				.then(items => {
					if (!agentTouched() && isSolverAgent(items.solverAgent)) setSolverAgent(items.solverAgent)
					if (!modelTouched() && typeof items.solverModel === 'string') setSolverModel(items.solverModel)
					if (!workspaceTouched() && isStoredWorkspace(items.solverWorkspace)) setSolverWorkspace(items.solverWorkspace)
					if (Array.isArray(items.favoriteModels)) {
						setFavoriteModels(items.favoriteModels.filter((m): m is string => typeof m === 'string'))
					}
				})
				.catch(err => console.warn('[helm]', err))
		})
		.catch(err => {
			console.warn('[helm]', err)
			setConnError('Cannot connect to Helm')
		})

	// Deep link into helm (the native cockpit) — the browser dashboard is gone.
	// the app registers the helm:// scheme (app/src/main.ts) and navigates its
	// sidebar to the item.
	const helmUrl = () => {
		const i = item()
		return i ? `helm://item/${i.id}` : null
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
		// null = follow the daemon default (no workspace override); a value pins it.
		solverWorkspace: solverWorkspace() || null,
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

	function chooseSolverWorkspace(workspace: SolverWorkspace) {
		setWorkspaceTouched(true)
		// Two chips, tri-state: clicking the active chip toggles back to '' (the
		// daemon default), the only way to reach "no override" without a 3rd chip.
		const next: '' | SolverWorkspace = solverWorkspace() === workspace ? '' : workspace
		setSolverWorkspace(next)
		void setSync({ solverWorkspace: next })
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
				helmUrl={helmUrl}
				planInfo={planInfo}
				planPending={planPending}
				solverAgent={solverAgent}
				solverModel={effectiveModel}
				solverWorkspace={solverWorkspace}
				modelOptions={modelOptions}
				actionError={actionError}
				onSolverAgentChange={chooseSolverAgent}
				onSolverModelChange={chooseSolverModel}
				onSolverWorkspaceChange={chooseSolverWorkspace}
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

/**
 * A run summary/failure notice. Solver summaries can be a full root-cause
 * paragraph, so it's clamped to a few lines by default and expands on click
 * (the whole block is the toggle).
 */
function NoticeText(props: { kind: 'summary' | 'failure'; text: string }) {
	const [expanded, setExpanded] = createSignal(false)
	return (
		<div
			class={`${props.kind === 'failure' ? 'vg-error' : 'vg-summary'} vg-notice${expanded() ? ' is-expanded' : ''}`}
			on:click={() => setExpanded(v => !v)}
			title={expanded() ? 'Click to collapse' : 'Click to show more'}
		>
			{props.kind === 'failure' ? `Failure: ${props.text}` : props.text}
		</div>
	)
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
 * Execution-workspace picker — two chips reusing the agent segmented pattern.
 * '' (no chip active) = follow the daemon default; clicking a chip pins it, and
 * clicking the active chip again toggles back to the default.
 */
function WorkspaceSelect(props: {
	value: Accessor<'' | SolverWorkspace>
	onChange: (workspace: SolverWorkspace) => void
	disabled?: boolean
}) {
	const options: SolverWorkspace[] = ['worktree', 'main']
	return (
		<div class="vg-agent">
			<span class="vg-agent__label">Workspace</span>
			<div class="vg-agent__seg" aria-label="Execution workspace">
				<For each={options}>
					{workspace => (
						<button
							type="button"
							class={`vg-agent__option${props.value() === workspace ? ' is-active' : ''}`}
							aria-pressed={props.value() === workspace}
							disabled={props.disabled}
							on:click={() => props.onChange(workspace)}
						>
							{workspaceLabel(workspace)}
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
 *
 * This is a CUSTOM dropdown, not a native `<select>`: the widget renders in a
 * closed shadow root, and macOS Chromium silently fails to open native select
 * popups inside shadow DOM (clicks land, no popup ever shows). The options
 * panel renders in the same shadow root, anchored to the trigger; the card is
 * `overflow: hidden`, so the panel flips above the trigger when it wouldn't
 * fit below and clamps its max-height to the room actually inside the card.
 */
function ModelSelect(props: {
	value: Accessor<string>
	options: Accessor<ModelOption[]>
	onChange: (model: string) => void
	disabled?: boolean
}) {
	const [open, setOpen] = createSignal(false)
	const [dropUp, setDropUp] = createSignal(false)
	const [maxHeight, setMaxHeight] = createSignal(180)
	// Keyboard/hover highlight — one source so arrows and the mouse never
	// paint two rows at once (rows style `.is-active`, not `:hover`).
	const [active, setActive] = createSignal(0)
	let rootEl: HTMLDivElement | undefined
	let triggerEl: HTMLButtonElement | undefined

	// "Auto" first, then the favorites — one flat row list; '' = no override.
	const rows = (): ModelOption[] => [{ id: '', label: 'Auto' }, ...props.options()]
	const selectedIndex = () =>
		Math.max(
			0,
			rows().findIndex(row => row.id === props.value()),
		)
	const currentLabel = () => rows()[selectedIndex()]?.label ?? 'Auto'

	function openMenu() {
		const card = triggerEl?.closest('.vg-card')
		if (triggerEl && card) {
			const t = triggerEl.getBoundingClientRect()
			const c = card.getBoundingClientRect()
			const below = c.bottom - t.bottom - 10
			const above = t.top - c.top - 10
			const wanted = Math.min(180, rows().length * 28 + 10)
			const up = below < wanted && above > below
			setDropUp(up)
			setMaxHeight(Math.max(64, Math.min(180, Math.floor(up ? above : below))))
		}
		setActive(selectedIndex())
		setOpen(true)
	}

	const close = () => setOpen(false)

	function choose(id: string) {
		props.onChange(id)
		close()
	}

	// While open: click outside closes. The shadow root is CLOSED, so one
	// document listener can't do it — events from inside the widget retarget
	// to the host and their composedPath is truncated there. Two capture
	// listeners: the shadow root sees clicks inside the widget but outside
	// this control; the document sees page clicks (target ≠ host).
	createEffect(() => {
		if (!open()) return
		const root = rootEl?.getRootNode()
		const host = root instanceof ShadowRoot ? root.host : null
		const onShadowDown = (e: Event) => {
			if (rootEl && e.target instanceof Node && !rootEl.contains(e.target)) close()
		}
		const onDocDown = (e: Event) => {
			if (e.target !== host) close()
		}
		const onDocKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close()
		}
		root?.addEventListener('pointerdown', onShadowDown, true)
		document.addEventListener('pointerdown', onDocDown, true)
		document.addEventListener('keydown', onDocKey, true)
		onCleanup(() => {
			root?.removeEventListener('pointerdown', onShadowDown, true)
			document.removeEventListener('pointerdown', onDocDown, true)
			document.removeEventListener('keydown', onDocKey, true)
		})
	})

	// A run starting mid-open (control becomes disabled) closes the panel.
	createEffect(() => {
		if (props.disabled && open()) close()
	})

	function onKeyDown(e: KeyboardEvent) {
		if (!open()) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault()
				if (!props.disabled) openMenu()
			}
			return
		}
		const count = rows().length
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setActive(i => (i + 1) % count)
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setActive(i => (i - 1 + count) % count)
		} else if (e.key === 'Home') {
			e.preventDefault()
			setActive(0)
		} else if (e.key === 'End') {
			e.preventDefault()
			setActive(count - 1)
		} else if (e.key === 'Enter' || e.key === ' ') {
			// preventDefault also cancels the focused trigger's native
			// activation, so this can't double-fire as a toggle click.
			e.preventDefault()
			const row = rows()[active()]
			if (row) choose(row.id)
		} else if (e.key === 'Escape') {
			e.preventDefault()
			close()
		}
	}

	return (
		<Show when={props.options().length > 0}>
			<div class="vg-agent">
				<span class="vg-agent__label">Model</span>
				<div class="vg-model" ref={rootEl} on:keydown={onKeyDown}>
					<button
						type="button"
						ref={triggerEl}
						class={`vg-model__trigger${open() ? ' is-open' : ''}`}
						aria-label="Solver model"
						aria-haspopup="listbox"
						aria-expanded={open()}
						disabled={props.disabled}
						on:click={() => (open() ? close() : openMenu())}
					>
						<span class="vg-model__value">{currentLabel()}</span>
						<span class="vg-model__chevron" aria-hidden="true">
							<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
								<path
									d="M1 1l4 4 4-4"
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</span>
					</button>
					<Show when={open()}>
						{/* biome-ignore lint/a11y/useSemanticElements: a native <select> is the bug this control replaces — its popup never opens inside the closed shadow root on macOS Chromium */}
						<div
							role="listbox"
							tabIndex={-1}
							class={`vg-model__menu vg-model__menu--${dropUp() ? 'up' : 'down'}`}
							aria-label="Solver model options"
							style={{ 'max-height': `${maxHeight()}px` }}
						>
							<For each={rows()}>
								{(row, i) => (
									// biome-ignore lint/a11y/useSemanticElements: rows of the custom listbox above — native <option> requires the native <select> this replaces
									<button
										role="option"
										type="button"
										tabindex="-1"
										class={`vg-model__option${i() === active() ? ' is-active' : ''}${
											row.id === props.value() ? ' is-selected' : ''
										}`}
										aria-selected={row.id === props.value()}
										on:click={() => choose(row.id)}
										on:mousemove={() => setActive(i())}
									>
										<span class="vg-model__option-label">{row.label}</span>
										<Show when={row.id === props.value()}>
											<span class="vg-model__check" aria-hidden="true">
												<svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true">
													<path
														d="M1 4l2.6 2.6L9 1"
														fill="none"
														stroke="currentColor"
														stroke-width="1.6"
														stroke-linecap="round"
														stroke-linejoin="round"
													/>
												</svg>
											</span>
										</Show>
									</button>
								)}
							</For>
						</div>
					</Show>
				</div>
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
					<span class="vg-pill__brand">H</span>
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
						<span class="vg-pill__brand">H</span>
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
	helmUrl: Accessor<string | null>
	planInfo: Accessor<PlanInfo | null>
	planPending: Accessor<boolean>
	solverAgent: Accessor<SolverAgent>
	solverModel: Accessor<string>
	solverWorkspace: Accessor<'' | SolverWorkspace>
	modelOptions: Accessor<ModelOption[]>
	actionError: Accessor<string | null>
	onSolverAgentChange: (agent: SolverAgent) => void
	onSolverModelChange: (model: string) => void
	onSolverWorkspaceChange: (workspace: SolverWorkspace) => void
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
							<span class="vg-card__brand">Helm</span>
						</div>
						<div class="vg-card__hactions">
							<button type="button" class="vg-close" on:click={props.onCollapse}>
								&times;
							</button>
						</div>
					</div>
					<div class="vg-card__body">
						<div class="vg-error">Cannot connect to Helm</div>
						<div class="vg-text">Make sure the Helm daemon is running.</div>
					</div>
				</Match>

				{/* Not tracked */}
				<Match when={v().kind === 'untracked'}>
					<div class="vg-card__header">
						<div class="vg-card__id">
							<span class="vg-card__brand">Helm</span>
						</div>
						<div class="vg-card__hactions">
							<button type="button" class="vg-close" on:click={props.onCollapse}>
								&times;
							</button>
						</div>
					</div>
					<div class="vg-card__body">
						<div class="vg-text vg-text--primary">This task isn’t tracked by Helm yet.</div>
						<Show when={!(v() as { kind: 'untracked'; solvable: boolean }).solvable}>
							<div class="vg-text">No projects are configured.</div>
						</Show>
					</div>
					<Show when={(v() as { kind: 'untracked'; solvable: boolean }).solvable}>
						<div class="vg-card__actions">
							<Btn variant="primary" onClick={props.onSolve}>
								Solve with Helm
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
										{/* helm:// = external protocol launch (the Helm app), not a navigation —
										    no target: the page stays put while the OS opens Helm. */}
										<Show when={props.helmUrl()}>
											{url => (
												<a class="vg-link-open" href={url()}>
													Helm ↗
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
									<WorkspaceSelect
										value={props.solverWorkspace}
										onChange={props.onSolverWorkspaceChange}
										disabled={isProcessing()}
									/>
									<For each={itemRunNotices(item())}>
										{notice => <NoticeText kind={notice.kind} text={notice.text} />}
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
