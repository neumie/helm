import { type Accessor, For, type JSX, Match, Show, Switch, createEffect, createSignal, onCleanup } from 'solid-js'
import {
	type DashboardAction,
	type DashboardActionId,
	type DashboardItem,
	type DashboardLink,
	type DashboardTone,
	type ModelOption,
	type PlainRunContextDocument,
	type PlanInfo,
	type RunContextResponse,
	type SolveSelection,
	type SolverAgent,
	type SolverWorkspace,
	createApi,
	getServerUrl,
} from './api'
import { getSync, setSync } from './storage'

type Tone = DashboardTone

const AGENT_LABEL: Record<SolverAgent, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' }
const agentLabel = (agent: SolverAgent) => AGENT_LABEL[agent]
const isSolverAgent = (value: unknown): value is SolverAgent =>
	value === 'claude' || value === 'codex' || value === 'pi'
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
	return actions.flatMap(action =>
		action.id === 'approve'
			? [
					{ id: 'approve', label: 'Queue', tone: 'muted' },
					{ id: 'start', label: 'Start', tone: 'primary' },
				]
			: [action],
	)
}

export function Widget(props: { taskId: Accessor<string | null> }) {
	const [item, setItem] = createSignal<DashboardItem | null>(null)
	const [expanded, setExpanded] = createSignal(false)
	const [connError, setConnError] = createSignal<string | null>(null)
	const [actionError, setActionError] = createSignal<string | null>(null)
	const [projects, setProjects] = createSignal<string[]>([])
	const [planInfo, setPlanInfo] = createSignal<PlanInfo | null>(null)
	const [busy, setBusy] = createSignal(false)
	const [uncertain, setUncertain] = createSignal(false)
	const [supported, setSupported] = createSignal(false)
	const [solverAgent, setSolverAgent] = createSignal<SolverAgent>('claude')
	const [solverModel, setSolverModel] = createSignal('')
	const [solverWorkspace, setSolverWorkspace] = createSignal<'' | SolverWorkspace>('')
	const [modelCatalog, setModelCatalog] = createSignal<Record<SolverAgent, ModelOption[]>>({
		claude: [],
		codex: [],
		pi: [],
	})
	const [favoriteModels, setFavoriteModels] = createSignal<string[]>([])
	const [defaultWorkspace, setDefaultWorkspace] = createSignal<SolverWorkspace>('worktree')
	const [runText, setRunText] = createSignal('')
	const [runSavedText, setRunSavedText] = createSignal('')
	const [runRevision, setRunRevision] = createSignal<number | null>(null)
	const [runLoading, setRunLoading] = createSignal(false)
	const [runEditing, setRunEditing] = createSignal(false)
	const [runRich, setRunRich] = createSignal(false)
	const [runImages, setRunImages] = createSignal<PlainRunContextDocument['images']>([])
	const [runError, setRunError] = createSignal<string | null>(null)
	let touched = { agent: false, model: false, workspace: false }
	let generation = 0
	let readGeneration = 0
	let operation = false
	type Owner = {
		origin: string
		profile: string
		profileGeneration: number
		source: string
		api: ReturnType<typeof createApi>
		generation: number
	}
	let owner: Owner | null = null
	let itemKey: string | null = null
	let loadingKey: string | null = null
	const dirty = () => runText() !== runSavedText()
	const current = (captured: Owner, id?: string) =>
		owner === captured && props.taskId() === captured.source && (!id || item()?.id === id)
	const selection = (): SolveSelection => ({
		solverAgent: solverAgent(),
		solverModel: solverModel() || null,
		solverWorkspace: solverWorkspace() || null,
	})

	function resetDraft() {
		readGeneration++
		loadingKey = null
		setRunText('')
		setRunSavedText('')
		setRunRevision(null)
		setRunRich(false)
		setRunImages([])
		setRunEditing(false)
		setRunLoading(false)
		setRunError(null)
	}
	function seed(result: RunContextResponse) {
		const document = result.document
		const source = result.source
		const description = source?.descriptionBlocks?.length
			? source.descriptionBlocks
					.filter(block => block.type === 'text')
					.map(block => block.text)
					.join('\n\n')
			: (source?.description ?? '')
		const text =
			document?.version === 2
				? document.text
				: document?.version === 1
					? document.markdown
					: [
							description,
							...(source?.comments ?? []).map(comment => `${comment.author} · ${comment.createdAt}\n${comment.body}`),
						]
							.filter(Boolean)
							.join('\n\n')
		setRunText(text)
		setRunSavedText(text)
		setRunRevision(result.revision)
		setRunRich(document?.version === 1)
		setRunImages(
			document?.version === 2
				? document.images
				: (source?.descriptionBlocks ?? []).filter(
						(block): block is PlainRunContextDocument['images'][number] => block.type === 'image',
					),
		)
		setRunError(null)
	}
	async function loadPrompt(captured: Owner, target: DashboardItem, force = false) {
		if (!supported() || target.kind !== 'solve' || !current(captured, target.id) || dirty() || operation) return
		const key = `${captured.origin}|${captured.profile}|${captured.profileGeneration}|${target.id}|${captured.source}`
		if (loadingKey === key || (!force && runRevision() !== null)) return
		loadingKey = key
		const request = ++readGeneration
		if (runRevision() === null) setRunLoading(true)
		try {
			const result = await captured.api.runContext(target.id)
			if (!current(captured, target.id) || request !== readGeneration || dirty() || operation) return
			seed(result)
		} catch (error) {
			if (current(captured, target.id) && request === readGeneration)
				setRunError(error instanceof Error ? error.message : 'Cannot load prompt')
		} finally {
			if (request === readGeneration) {
				loadingKey = null
				setRunLoading(false)
			}
		}
	}
	function publish(captured: Owner, next: DashboardItem | null) {
		if (!current(captured)) return
		if (next && ((next.profileId ?? 'work') !== captured.profile || next.source?.externalId !== captured.source)) return
		const key = next
			? `${captured.origin}|${captured.profile}|${captured.profileGeneration}|${next.id}|${captured.source}`
			: null
		if (key !== itemKey) {
			itemKey = key
			resetDraft()
			setPlanInfo(null)
			if (next) {
				if (!touched.agent && next.solverAgent) setSolverAgent(next.solverAgent)
				if (!touched.model) setSolverModel(next.solverModel ?? '')
				if (!touched.workspace) setSolverWorkspace(next.solverWorkspace ?? '')
			}
		}
		setItem(next)
	}
	createEffect(() => {
		const source = props.taskId()
		const epoch = ++generation
		owner = null
		itemKey = null
		resetDraft()
		setItem(null)
		setActionError(null)
		setUncertain(false)
		setSupported(false)
		touched = { agent: false, model: false, workspace: false }
		let stopped = false
		let timer: ReturnType<typeof setTimeout> | undefined
		async function lookup() {
			if (!source || stopped) return
			try {
				const origin = new URL(await getServerUrl()).origin
				const transport = createApi(origin)
				const status = await transport.status()
				if (stopped || epoch !== generation) return
				const profile = status.profile?.id ?? 'work'
				const profileGeneration = status.profileGeneration ?? 1
				if (
					!owner ||
					owner.origin !== origin ||
					owner.profile !== profile ||
					owner.profileGeneration !== profileGeneration
				) {
					owner = { origin, profile, profileGeneration, source, api: transport, generation: epoch }
					itemKey = null
					resetDraft()
					setItem(null)
					setActionError(null)
					setUncertain(false)
					const captured = owner
					void transport
						.config()
						.then(async config => {
							const stored = await getSync({
								solverAgent: config.solver?.agent ?? 'claude',
								solverModel: '',
								solverWorkspace: '',
								favoriteModels: [] as string[],
							})
							if (!current(captured)) return
							setProjects(config.projects.map(project => project.slug))
							if (config.modelCatalog) setModelCatalog(config.modelCatalog)
							setDefaultWorkspace(config.solver?.workspace ?? 'worktree')
							if (!touched.agent && !item()?.solverAgent && isSolverAgent(stored.solverAgent))
								setSolverAgent(stored.solverAgent)
							if (!touched.model && !item()?.solverModel && typeof stored.solverModel === 'string')
								setSolverModel(stored.solverModel)
							if (!touched.workspace && !item()?.solverWorkspace && isStoredWorkspace(stored.solverWorkspace))
								setSolverWorkspace(stored.solverWorkspace)
							if (Array.isArray(stored.favoriteModels))
								setFavoriteModels(stored.favoriteModels.filter((value): value is string => typeof value === 'string'))
						})
						.catch(error => current(captured) && setConnError(String(error)))
				}
				const captured = owner
				setSupported((status.protocolVersion ?? 0) >= 49)
				const next = await captured.api.findItemBySource(source)
				if (!current(captured)) return
				publish(captured, next)
				setConnError(null)
				if (next) void loadPrompt(captured, next, true)
			} catch (error) {
				if (!stopped) setConnError(error instanceof Error ? error.message : 'Connection failed')
			} finally {
				if (!stopped) timer = setTimeout(lookup, 5000)
			}
		}
		void lookup()
		onCleanup(() => {
			stopped = true
			if (owner?.generation === epoch) {
				owner = null
				readGeneration++
			}
			if (timer) clearTimeout(timer)
		})
	})

	async function verifyOwner(captured: Owner, id?: string) {
		if (!current(captured, id)) throw new Error('Task identity changed. No further action was sent.')
		const origin = new URL(await getServerUrl()).origin
		const status = await captured.api.status()
		const latestOrigin = new URL(await getServerUrl()).origin
		if (
			!current(captured, id) ||
			origin !== captured.origin ||
			latestOrigin !== captured.origin ||
			(status.profile?.id ?? 'work') !== captured.profile ||
			(status.profileGeneration ?? 1) !== captured.profileGeneration
		)
			throw new Error('Daemon or profile changed. No further action was sent.')
	}
	async function mutate(action: DashboardActionId | 'edit' | 'save' | 'plan') {
		if (operation || uncertain() || !owner) return
		const captured = owner
		let target = item()
		if ((action === 'edit' || action === 'save') && (!supported() || runRich())) return
		if (target && (action === 'edit' || action === 'save') && runRevision() === null) return
		if (
			target?.status === 'running' &&
			(action === 'save' || action === 'edit' || action === 'start' || action === 'plan')
		)
			return
		if (
			action === 'start' &&
			target?.kind === 'solve' &&
			supported() &&
			(runRevision() === null || runLoading() || runError())
		)
			return
		operation = true
		setBusy(true)
		setActionError(null)
		const choices = selection()
		const text = runText()
		let revision = runRevision()
		let mayHaveMutated = false
		try {
			await verifyOwner(captured, target?.id)
			if (!target) {
				if (action !== 'start' && action !== 'edit' && action !== 'approve') return
				mayHaveMutated = true
				target = await captured.api.createItemFromSource(captured.source)
				if (!current(captured) || (target.profileId ?? 'work') !== captured.profile) return
				publish(captured, target)
				await verifyOwner(captured, target.id)
				if (supported()) {
					const loaded = await captured.api.runContext(target.id)
					await verifyOwner(captured, target.id)
					seed(loaded)
					revision = loaded.revision
				}
			}
			if (!current(captured, target.id)) return
			if (action === 'edit') {
				setRunEditing(true)
				return
			}
			if (action === 'save' || (action === 'start' && dirty())) {
				if (revision === null || runRich()) return
				mayHaveMutated = true
				const saved = await captured.api.savePlainRunContext(target.id, revision, text)
				if (!current(captured, target.id)) return
				setRunSavedText(text)
				setRunRevision(saved.revision)
				setRunImages(saved.document.images)
				setRunEditing(false)
				revision = saved.revision
				if (action === 'save') return
				await verifyOwner(captured, target.id)
			}
			if (action === 'plan') {
				mayHaveMutated = true
				const info = await captured.api.planItem(target.id, choices)
				if (current(captured, target.id)) setPlanInfo(info)
			} else {
				mayHaveMutated = true
				const result = await captured.api.itemAction(target.id, action, {
					...choices,
					...(action === 'start' && supported() && target.kind === 'solve' && revision !== null
						? { expectedRunContextRevision: revision }
						: {}),
				})
				if (current(captured, target.id)) publish(captured, result)
			}
		} catch (error) {
			if (current(captured)) {
				setActionError(
					`${error instanceof Error ? error.message : 'Action failed'}${mayHaveMutated ? ' Check the outcome in Helm before another action; nothing is retried automatically.' : ''}`,
				)
				setUncertain(mayHaveMutated)
			}
		} finally {
			operation = false
			setBusy(false)
			// A replacement owner may have arrived while the old mutation held
			// admission. Its first read was deliberately deferred; admit that
			// CURRENT owner's read now, never publish the outgoing result into it.
			const latestOwner = owner
			const latestItem = item()
			if (latestOwner && latestItem && runRevision() === null) void loadPrompt(latestOwner, latestItem)
		}
	}
	const modelOptions = () => {
		const all = modelCatalog()[solverAgent()] ?? []
		const favorites = all.filter(model => favoriteModels().includes(model.id))
		const rest = all.filter(model => !favoriteModels().includes(model.id))
		const custom =
			solverModel() && !all.some(model => model.id === solverModel())
				? [{ id: solverModel(), label: solverModel() }]
				: []
		return [...favorites, ...rest, ...custom]
	}
	const chooseSolverAgent = (agent: SolverAgent) => {
		touched.agent = true
		setSolverAgent(agent)
		touched.model = true
		setSolverModel('')
		void setSync({ solverAgent: agent, solverModel: '' })
	}
	const chooseSolverModel = (model: string) => {
		touched.model = true
		setSolverModel(model)
		void setSync({ solverModel: model })
	}
	const chooseSolverWorkspace = (workspace: SolverWorkspace) => {
		touched.workspace = true
		const next = solverWorkspace() === workspace ? '' : workspace
		setSolverWorkspace(next)
		void setSync({ solverWorkspace: next })
	}
	const view = (): View => {
		const value = item()
		return !props.taskId()
			? { kind: 'none' }
			: value
				? { kind: 'item', item: value }
				: connError()
					? { kind: 'error' }
					: { kind: 'untracked', solvable: projects().length > 0 }
	}
	const helmUrl = () => {
		const i = item()
		return i ? `helm://profile/${encodeURIComponent(i.profileId ?? 'work')}/item/${encodeURIComponent(i.id)}` : null
	}
	return (
		<Show
			when={expanded()}
			fallback={<Pill view={view} onExpand={() => setExpanded(true)} onSolve={() => setExpanded(true)} />}
		>
			<Card
				view={view}
				helmUrl={helmUrl}
				planInfo={planInfo}
				planPending={busy}
				solverAgent={solverAgent}
				solverModel={solverModel}
				solverWorkspace={solverWorkspace}
				modelOptions={modelOptions}
				defaultWorkspace={defaultWorkspace}
				actionError={actionError}
				onSolverAgentChange={chooseSolverAgent}
				onSolverModelChange={chooseSolverModel}
				onSolverWorkspaceChange={chooseSolverWorkspace}
				onDismissError={() => {
					setActionError(null)
					setUncertain(false)
				}}
				onCollapse={() => setExpanded(false)}
				onSolve={() => void mutate('start')}
				runText={runText}
				canEditRun={() => runRevision() !== null}
				runLoading={runLoading}
				runSaving={busy}
				runEditing={runEditing}
				runRich={runRich}
				runImages={runImages}
				runError={runError}
				supported={supported}
				blocked={() => busy() || uncertain()}
				startBlocked={() =>
					busy() ||
					uncertain() ||
					(supported() && item()?.kind === 'solve' && (runRevision() === null || runLoading() || !!runError()))
				}
				onRetryRun={() => {
					const value = item()
					if (owner && value) void loadPrompt(owner, value, true)
				}}
				onRunTextChange={setRunText}
				onEditRun={() => void mutate('edit')}
				onSaveRun={() => void mutate('save')}
				onItemAction={action => void mutate(action)}
				onPlan={() => void mutate('plan')}
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

function ActionMenu(props: {
	disabled: boolean
	actions: Array<{ label: string; disabled?: boolean; run: () => void }>
}) {
	const [open, setOpen] = createSignal(false)
	let root!: HTMLDivElement
	let trigger!: HTMLButtonElement
	const close = () => {
		setOpen(false)
		trigger.focus()
	}
	createEffect(() => {
		if (!open()) return
		const shadow = root.getRootNode() as ShadowRoot
		const inside = (event: Event) => {
			if (event.target instanceof Node && !root.contains(event.target)) setOpen(false)
		}
		const outside = (event: Event) => {
			if (event.target !== shadow.host) setOpen(false)
		}
		shadow.addEventListener('pointerdown', inside, true)
		document.addEventListener('pointerdown', outside, true)
		onCleanup(() => {
			shadow.removeEventListener('pointerdown', inside, true)
			document.removeEventListener('pointerdown', outside, true)
		})
	})
	return (
		<div
			class="vg-more"
			ref={root}
			on:keydown={event => {
				if (event.key === 'Escape') {
					event.preventDefault()
					close()
				}
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault()
					setOpen(true)
					const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
					const index = buttons.findIndex(
						button => button === (root.getRootNode() as ShadowRoot | Document).activeElement,
					)
					buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
				}
			}}
			on:focusout={event => {
				if (!root.contains(event.relatedTarget as Node)) setOpen(false)
			}}
		>
			<button
				type="button"
				class="vg-btn vg-btn--muted"
				ref={trigger}
				aria-haspopup="menu"
				aria-expanded={open()}
				disabled={props.disabled}
				on:click={() => setOpen(!open())}
			>
				More
			</button>
			<Show when={open()}>
				<div role="menu" aria-label="Task actions">
					<For each={props.actions}>
						{action => (
							<button
								type="button"
								role="menuitem"
								disabled={action.disabled || props.disabled}
								on:click={() => {
									close()
									action.run()
								}}
							>
								{action.label}
							</button>
						)}
					</For>
				</div>
			</Show>
		</div>
	)
}

function AgentSelect(props: {
	value: Accessor<SolverAgent>
	onChange: (agent: SolverAgent) => void
	disabled?: boolean
}) {
	const options: SolverAgent[] = ['claude', 'codex', 'pi']
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
		triggerEl?.focus()
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
	canEditRun: Accessor<boolean>
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
	runText: Accessor<string>
	runLoading: Accessor<boolean>
	runSaving: Accessor<boolean>
	runEditing: Accessor<boolean>
	onRunTextChange: (text: string) => void
	onEditRun: () => void
	onSaveRun: () => void
	defaultWorkspace: Accessor<SolverWorkspace>
	runRich: Accessor<boolean>
	runImages: Accessor<PlainRunContextDocument['images']>
	runError: Accessor<string | null>
	supported: Accessor<boolean>
	blocked: Accessor<boolean>
	startBlocked: Accessor<boolean>
	onRetryRun: () => void
}) {
	const v = props.view
	const runSettings = () => (
		<details
			class="vg-run-menu"
			on:keydown={event => {
				if (event.key === 'Escape') {
					event.currentTarget.open = false
					event.currentTarget.querySelector('summary')?.focus()
				}
			}}
		>
			<summary>
				Run with {agentLabel(props.solverAgent())} · {props.solverModel() || 'Default model'} ·{' '}
				{props.solverWorkspace()
					? workspaceLabel(props.solverWorkspace() as SolverWorkspace)
					: `Default (${workspaceLabel(props.defaultWorkspace())})`}
			</summary>
			<AgentSelect
				value={props.solverAgent}
				onChange={props.onSolverAgentChange}
				disabled={props.blocked() || (asItem(v()) && (asItem(v()) as DashboardItem).status === 'running')}
			/>
			<ModelSelect
				value={props.solverModel}
				options={props.modelOptions}
				onChange={props.onSolverModelChange}
				disabled={props.blocked() || (asItem(v()) && (asItem(v()) as DashboardItem).status === 'running')}
			/>
			<label class="vg-agent">
				Custom model
				<input
					aria-label="Custom model"
					value={props.solverModel()}
					on:input={event => props.onSolverModelChange(event.currentTarget.value)}
					disabled={props.blocked() || (asItem(v()) && (asItem(v()) as DashboardItem).status === 'running')}
				/>
			</label>
			<WorkspaceSelect
				value={props.solverWorkspace}
				onChange={props.onSolverWorkspaceChange}
				disabled={props.blocked() || (asItem(v()) && (asItem(v()) as DashboardItem).status === 'running')}
			/>
		</details>
	)
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
						<div class="vg-text vg-text--primary">
							This task isn’t tracked by Helm yet. Edit prompt prepares an Inbox item without starting it.
						</div>
						{runSettings()}
						<Show when={!(v() as { kind: 'untracked'; solvable: boolean }).solvable}>
							<div class="vg-text">No projects are configured.</div>
						</Show>
					</div>
					<Show when={(v() as { kind: 'untracked'; solvable: boolean }).solvable}>
						<div class="vg-card__actions">
							<Show when={props.supported()}>
								<Btn variant="muted" onClick={props.onEditRun} disabled={props.blocked()}>
									Edit prompt
								</Btn>
							</Show>
							<Btn variant="muted" onClick={() => props.onItemAction('approve')} disabled={props.blocked()}>
								Queue
							</Btn>
							<Btn variant="primary" onClick={props.onSolve} disabled={props.blocked()}>
								Start
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
												<button type="button" class="vg-link-open" on:click={() => window.location.assign(url())}>
													Helm ↗
												</button>
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
									<Show when={props.supported() && item().kind === 'solve'}>
										<div class="vg-run-context">
											<div class="vg-run-context__header">
												<span>Prompt</span>
												<Show
													when={
														props.canEditRun() &&
														!props.runEditing() &&
														!props.runLoading() &&
														!props.runRich() &&
														!isProcessing()
													}
												>
													<button
														type="button"
														class="vg-link-open"
														on:click={props.onEditRun}
														disabled={props.blocked()}
													>
														Edit
													</button>
												</Show>
											</div>
											<Show when={props.runRich()}>
												<div class="vg-text">Rich context is read-only here. Open Helm to edit it.</div>
											</Show>
											<Show when={isProcessing()}>
												<div class="vg-text">Running — edit after this run finishes.</div>
											</Show>
											<Show when={props.runError()}>
												<div class="vg-error">
													{props.runError()}{' '}
													<button
														type="button"
														class="vg-link-open"
														on:click={props.onRetryRun}
														disabled={props.blocked()}
													>
														Retry prompt load
													</button>
												</div>
											</Show>
											<Show when={!props.runLoading()} fallback={<div class="vg-text">Loading prompt…</div>}>
												<Show
													when={props.runEditing() && !props.runRich()}
													fallback={<div class="vg-run-context__text">{props.runText() || 'No prompt override'}</div>}
												>
													<textarea
														aria-label="Original task narrative"
														maxlength={200000}
														on:keydown={event => {
															if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
																event.preventDefault()
																if (!props.startBlocked()) props.onItemAction('start')
															}
														}}
														value={props.runText()}
														on:input={event => props.onRunTextChange(event.currentTarget.value)}
														disabled={props.blocked() || isProcessing()}
													/>
													<div class="vg-run-context__actions">
														<Btn
															variant="muted"
															onClick={() => props.onRunTextChange('')}
															disabled={props.blocked() || isProcessing()}
														>
															Clear
														</Btn>
														<Btn
															variant="primary"
															onClick={props.onSaveRun}
															disabled={props.blocked() || isProcessing()}
														>
															{props.runSaving() ? 'Saving…' : 'Save prompt'}
														</Btn>
													</div>
												</Show>
											</Show>
										</div>
										<Show when={props.runImages().length > 0}>
											<div class="vg-text">
												Protected source images:{' '}
												{props
													.runImages()
													.map(image => image.name ?? 'Unnamed image')
													.join(', ')}
											</div>
										</Show>
									</Show>
									<LinkLine label="Branch" link={item().links.branch} />
									<LinkLine label="PR" link={item().links.pr} />
									{runSettings()}
									<For each={itemRunNotices(item())}>
										{notice => <NoticeText kind={notice.kind} text={notice.text} />}
									</For>
									<Show when={item().errorMessage}>{message => <div class="vg-error">{message()}</div>}</Show>
								</div>

								<div class="vg-card__actions">
									<For each={extensionItemActions(item().allowedActions).filter(action => action.id !== 'reject')}>
										{action => (
											<Btn
												variant={action.tone}
												onClick={() => props.onItemAction(action.id)}
												disabled={action.id === 'start' ? props.startBlocked() : props.blocked()}
											>
												{action.label}
											</Btn>
										)}
									</For>
									<ActionMenu
										disabled={props.blocked()}
										actions={[
											{
												label: props.planInfo() || item().plan ? 'Re-plan' : 'Plan',
												disabled: isProcessing(),
												run: props.onPlan,
											},
											...item()
												.allowedActions.filter(action => action.id === 'reject')
												.map(action => ({ label: action.label, run: () => props.onItemAction(action.id) })),
										]}
									/>
								</div>
							</>
						)
					}}
				</Match>
			</Switch>
			<Show when={props.actionError()}>
				<div class="vg-error">
					{props.actionError()}
					<button type="button" class="vg-link-open" on:click={props.onDismissError}>
						I checked the outcome
					</button>
				</div>
			</Show>
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
							<button
								type="button"
								class="vg-link-line__link"
								on:click={() => window.open(url(), '_blank', 'noopener,noreferrer')}
							>
								{link().label}
							</button>
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
