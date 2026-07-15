// State-led item decision surface. Heavy source/plan/run artifacts live on pushed pages.
import { useRef, useState } from 'react'
import type { DashboardAction, HelmSnapshot, ItemStatus, PlanInfo } from '../../shared-helm'
import { showToast } from '../toast'
import {
	DeliveryCard,
	FailureCard,
	IntentCard,
	OutcomeCard,
	ProgressCard,
	StateSummary,
	WorkCard,
} from './DetailSections'
import { lifecycleActionPlan, lifecycleActionPresentation, manualStatusOptions } from './detail-actions'
import { useItemDetail } from './detail-data'
import { detailState } from './detail-state'
import { itemTitle, relativeTime, useNow } from './model'
import { type RunSelectionDraft, buildPlanBody, buildRunBody } from './run-selection'
import { Banner, Btn, Card, Chip, EmptyState, GLYPH, MenuButton, PushHeader, Sheet, StatusDot } from './ui'

export interface DetailPageProps {
	id: string
	snapshot: HelmSnapshot | null
	draft: RunSelectionDraft
	onBack: () => void
	onOpenPlan: (id: string) => void
	onOpenTask: (id: string) => void
	onOpenRun: (id: string) => void
	onOpenSetup: (id: string) => void
}

interface Confirmation {
	action: DashboardAction
	reason: string
}

export function DetailPage(props: DetailPageProps) {
	const { id, snapshot, draft, onBack, onOpenPlan, onOpenTask, onOpenRun, onOpenSetup } = props
	const { item, phase, error, refetch } = useItemDetail(id, snapshot)
	const now = useNow()
	const token = useRef(0)
	const commandLock = useRef(false)
	const [busy, setBusy] = useState<string | null>(null)
	const [commandError, setCommandError] = useState<string | null>(null)
	const [retryCommand, setRetryCommand] = useState<(() => void) | null>(null)
	const [confirm, setConfirm] = useState<Confirmation | null>(null)

	if (!item) return <MissingDetail phase={phase} error={error} onBack={onBack} onRetry={refetch} />
	const state = detailState(item)
	const effectiveWorkspace =
		item.kind === 'solve' ? (item.solverWorkspace ?? snapshot?.config?.solver?.workspace) : 'worktree'
	const okenaWorkspaceValue =
		effectiveWorkspace === 'main'
			? 'Okena · main checkout'
			: item.branchName
				? `Okena · ${item.branchName}`
				: 'Okena · create workspace'
	const disabled = busy !== null
	const run = async (
		label: string,
		call: () => Promise<{ error?: string }>,
		after?: () => void,
		successMessage: string | null = `${label} complete`,
	) => {
		if (commandLock.current) return
		commandLock.current = true
		const own = ++token.current
		setBusy(label)
		setCommandError(null)
		try {
			const result = await call()
			if (result.error !== undefined) {
				setCommandError(result.error)
				setRetryCommand(() => () => void run(label, call, after, successMessage))
				return
			}
			if (successMessage) showToast({ message: successMessage })
			after?.()
		} finally {
			if (token.current === own) {
				commandLock.current = false
				setBusy(null)
			}
			void refetch()
		}
	}
	const actionCall = (action: DashboardAction) => () =>
		run(action.label, () =>
			window.helm.daemon.itemAction(
				item.id,
				action.id,
				['approve', 'start', 'retry'].includes(action.id) ? buildRunBody(draft) : undefined,
			),
		)
	const plan = () =>
		run('Plan', async () => {
			const result = await window.helm.daemon.plan(item.id, buildPlanBody(item, draft))
			if (result.error === undefined) {
				const info: PlanInfo = result.data
				showToast({ message: `${info.spawner} planning started`, detail: info.hint, ttlMs: 8000 })
			}
			return result
		})
	const sourceTask = () => run('Create source task', () => window.helm.daemon.sourceTask(item.id))
	const openOkena = () =>
		run(
			'Open in Okena',
			async () => {
				const result = await window.helm.daemon.openOkena(item.id)
				if (result.error === undefined) {
					showToast({
						message: result.data.focused ? 'Focused in Okena' : 'Workspace opened in Okena',
						detail: result.data.activated ? undefined : result.data.hint,
					})
				}
				return result
			},
			undefined,
			null,
		)
	const setManualStatus = (status: ItemStatus, label: string) =>
		run(
			['Status', label].join(': '),
			() => window.helm.daemon.setStatus(item.id, status),
			status === 'done' || status === 'cancelled' ? onBack : undefined,
		)
	const markDone = () => run('Set as done', () => window.helm.daemon.setStatus(item.id, 'done'), onBack)
	const workManually = () => run('Work manually', () => window.helm.daemon.setStatus(item.id, 'active'))
	const returnToQueue = () => run('Return to Queue', () => window.helm.daemon.setStatus(item.id, 'ready'))
	const startPlanned = (executionMode: 'agent' | 'loop') => {
		const label = executionMode === 'loop' ? 'Start loop' : 'Start agent'
		return run(label, () => window.helm.daemon.itemAction(item.id, 'start', { ...buildRunBody(draft), executionMode }))
	}
	const {
		markDone: hasMarkDone,
		completeInOverflow,
		primary,
		rest,
	} = lifecycleActionPlan(item.status, item.allowedActions)
	const statusOptions = manualStatusOptions(item.status)
	const statusEntries = statusOptions.map(option => ({
		label: option.label,
		danger: option.status === 'failed' || option.status === 'cancelled',
		disabled: disabled || option.status === item.status,
		group: option.status === 'done',
		onSelect: () => void setManualStatus(option.status, option.label),
	}))
	const canPlan = ['inbox', 'ready', 'active'].includes(item.status)
	const askOrRun = (action: DashboardAction) => {
		if (action.id === 'cancel' && item.status === 'running') {
			setConfirm({
				action,
				reason:
					'Canceling stops the active run. Existing branch and run artifacts are preserved; Retry remains available.',
			})
			return
		}
		if (action.id === 'retry' && ['review', 'done', 'cancelled'].includes(item.status)) {
			setConfirm({
				action,
				reason: 'Retry queues a new run and clears the current result, pull request, and run outcome.',
			})
			return
		}
		void actionCall(action)()
	}
	const menuAction = (action: DashboardAction) => {
		const presentation = lifecycleActionPresentation(action.id, action.label, item.kind, item.executionMode)
		return {
			label: presentation.label,
			icon: GLYPH[presentation.icon],
			danger: action.tone === 'danger',
			disabled,
			onSelect: () => askOrRun(action),
		}
	}
	const overflow = [
		...rest.map(menuAction),
		...(primary?.tone === 'danger' ? [menuAction(primary)] : []),
		...(completeInOverflow
			? [
					{
						label: 'Set as done',
						icon: GLYPH.check,
						group: true,
						disabled,
						onSelect: () => void markDone(),
					},
				]
			: []),
		...(canPlan
			? [
					{
						label: item.plannedAt ? 'Re-plan' : 'Plan',
						icon: GLYPH.plan,
						group: rest.length > 0,
						disabled,
						onSelect: () => void plan(),
					},
				]
			: []),
		...(item.canCreateSourceTask
			? [{ label: 'Create source task', icon: GLYPH.plus, disabled, onSelect: () => void sourceTask() }]
			: []),
	]
	const plannedActive = item.status === 'active' && item.plannedAt != null
	const plannedSolve = plannedActive && item.kind === 'solve'
	const primaryAction = primary?.tone === 'danger' ? null : primary
	const primaryPresentation = primaryAction
		? lifecycleActionPresentation(primaryAction.id, primaryAction.label, item.kind, item.executionMode)
		: null
	const content = (section: ReturnType<typeof detailState>['sections'][number]) => {
		switch (section) {
			case 'intent':
				return (
					<IntentCard
						key="intent"
						assessment={item.assessment}
						hideSecurityNote={state.attention?.text === item.assessment?.securityNote}
					/>
				)
			case 'queue':
				return (
					<Card key="queue" label="Queue">
						<p className="section-description">Queued {relativeTime(item.queuedAt ?? item.createdAt, now)} ago.</p>
					</Card>
				)
			case 'progress':
				return <ProgressCard key="progress" item={item} now={now} />
			case 'outcome':
				return <OutcomeCard key="outcome" item={item} />
			case 'failure':
				return <FailureCard key="failure" item={item} hideError={state.attention?.text === item.errorMessage} />
			case 'work':
				return (
					<WorkCard
						key="work"
						item={item}
						now={now}
						onTask={() => onOpenTask(id)}
						onPlan={() => onOpenPlan(id)}
						onRun={() => onOpenRun(id)}
						onSetup={() => onOpenSetup(id)}
						onOpenOkena={() => void openOkena()}
						okenaWorkspaceValue={okenaWorkspaceValue}
						disabled={disabled}
					/>
				)
			case 'delivery':
				return <DeliveryCard key="delivery" item={item} />
			case 'run-setup':
				return item.kind === 'solve' ? (
					<Card key="run-setup" label="Run setup" flush>
						<WorkCard
							item={item}
							now={now}
							onTask={() => onOpenTask(id)}
							onPlan={() => onOpenPlan(id)}
							onRun={() => onOpenRun(id)}
							onOpenOkena={() => void openOkena()}
							okenaWorkspaceValue={okenaWorkspaceValue}
							disabled={disabled}
							onlySetup
							onSetup={() => onOpenSetup(id)}
						/>
					</Card>
				) : null
		}
	}
	return (
		<div className="page-frame" data-detail-state={item.status} aria-busy={phase === 'loading'}>
			<PushHeader title={itemTitle(item)} onBack={onBack} />
			<div className="page-scroll">
				<section className="detail-hero" aria-label="Current item state">
					<div className="detail-identity-meta">
						{statusOptions.length > 0 ? (
							<MenuButton
								entries={statusEntries}
								align="start"
								trigger={
									<Chip tone={state.chipTone}>
										{item.card.statusLabel}
										{GLYPH.chevronDown}
									</Chip>
								}
								triggerLabel={`Change status, currently ${item.card.statusLabel}`}
								triggerClass="status-menu-trigger"
								disabled={disabled}
							/>
						) : (
							<Chip tone={state.chipTone}>{item.card.statusLabel}</Chip>
						)}
						<span className="detail-project">{item.projectSlug}</span>
						{item.workMode ? (
							<span className={`detail-work-mode mode-${item.workMode}`}>
								{GLYPH[item.workMode]}
								{item.workMode === 'agent' ? 'Agent' : 'Manual'}
							</span>
						) : null}
						<span className="detail-meta-separator" aria-hidden="true">
							·
						</span>
						<span className="detail-elapsed">
							{relativeTime(
								item.status === 'active' || item.status === 'running'
									? (item.startedAt ?? item.queuedAt ?? item.createdAt)
									: (item.completedAt ?? item.updatedAt),
								now,
							)}
						</span>
					</div>
					{state.headline && state.direction ? (
						<StateSummary headline={state.headline} direction={state.direction} />
					) : null}
				</section>
				{phase === 'stale-error' && (
					<div className="detail-fetch-alert" role="alert">
						<span>Latest detail is unavailable: {error}</span>
						<button type="button" className="detail-disclosure" onClick={() => void refetch()}>
							Retry
						</button>
					</div>
				)}
				{state.attention && (
					<Banner tone={state.attention.tone} label={state.attention.label}>
						{state.attention.text}
					</Banner>
				)}
				{state.sections.map(content)}
			</div>
			{commandError && (
				<div className="command-error" role="alert">
					<span>{commandError}</span>
					<button type="button" className="detail-disclosure" onClick={() => retryCommand?.()}>
						Retry
					</button>
				</div>
			)}
			<output className="sr-only" aria-live="polite">
				{busy ? `${busy} in progress` : ''}
			</output>
			<div className="action-bar" aria-busy={disabled}>
				<div className="action-bar-main">
					{plannedSolve ? (
						<>
							<Btn
								tone="quiet"
								busy={busy === 'Start agent'}
								disabled={disabled}
								onClick={() => void startPlanned('agent')}
							>
								{GLYPH.agent}
								Start agent
							</Btn>
							<Btn
								tone="primary"
								block
								busy={busy === 'Start loop'}
								disabled={disabled}
								onClick={() => void startPlanned('loop')}
							>
								{GLYPH.retry}
								Start loop
							</Btn>
						</>
					) : plannedActive && primaryAction ? (
						<Btn
							tone="primary"
							block
							busy={busy === primaryAction.label}
							disabled={disabled}
							onClick={() => askOrRun(primaryAction)}
						>
							{GLYPH.retry}
							Start loop
						</Btn>
					) : item.status === 'active' ? (
						<>
							<Btn
								tone="quiet"
								busy={busy === 'Return to Queue'}
								disabled={disabled}
								onClick={() => void returnToQueue()}
							>
								{GLYPH.queue}
								Return to Queue
							</Btn>
							<Btn
								tone="primary"
								block
								busy={busy === 'Set as done'}
								disabled={disabled}
								onClick={() => void markDone()}
							>
								{GLYPH.check}
								Set as done
							</Btn>
						</>
					) : item.status === 'ready' &&
						item.workMode === null &&
						primaryAction?.id === 'start' &&
						primaryPresentation ? (
						<>
							<Btn tone="quiet" busy={busy === 'Work manually'} disabled={disabled} onClick={() => void workManually()}>
								{GLYPH.manual}
								Work manually
							</Btn>
							<Btn
								tone="primary"
								block
								busy={busy === primaryAction.label}
								disabled={disabled}
								onClick={() => askOrRun(primaryAction)}
							>
								{GLYPH.agent}
								{primaryPresentation.label}
							</Btn>
						</>
					) : hasMarkDone ? (
						<Btn tone="primary" block busy={busy === 'Set as done'} disabled={disabled} onClick={() => void markDone()}>
							{GLYPH.check}
							Set as done
						</Btn>
					) : primaryAction && primaryPresentation ? (
						<Btn
							tone={primaryAction.tone === 'primary' ? 'primary' : 'quiet'}
							block
							busy={busy === primaryAction.label}
							disabled={disabled}
							onClick={() => askOrRun(primaryAction)}
						>
							{primaryPresentation.icon ? GLYPH[primaryPresentation.icon] : null}
							{primaryPresentation.label}
						</Btn>
					) : item.status === 'running' ? (
						<span className="command-status">
							<StatusDot tone="accent" pulse />
							Agent running
						</span>
					) : null}
				</div>
				{(hasMarkDone || primaryAction || overflow.length > 0) && overflow.length > 0 && (
					<MenuButton entries={overflow} trigger={GLYPH.ellipsis} triggerLabel="More actions" disabled={disabled} />
				)}
				{confirm && (
					<Sheet
						title={confirm.action.id === 'cancel' ? 'Cancel run?' : 'Retry run?'}
						onClose={() => setConfirm(null)}
						footer={
							<>
								<Btn tone="quiet" onClick={() => setConfirm(null)}>
									Keep current state
								</Btn>
								<Btn
									tone={confirm.action.id === 'cancel' ? 'danger' : 'primary'}
									onClick={() => {
										setConfirm(null)
										void actionCall(confirm.action)()
									}}
								>
									{confirm.action.label}
								</Btn>
							</>
						}
					>
						<p className="section-description">{confirm.reason}</p>
					</Sheet>
				)}
			</div>
		</div>
	)
}

function MissingDetail({
	phase,
	error,
	onBack,
	onRetry,
}: { phase: string; error: string | null; onBack: () => void; onRetry: () => Promise<void> }) {
	const notFound = phase === 'not-found'
	return (
		<div className="page-frame">
			<PushHeader title="Item" onBack={onBack} />
			<div className="page-scroll" aria-busy={phase === 'loading'}>
				<EmptyState
					title={notFound ? 'Item not found' : phase === 'loading' ? 'Loading item' : 'Item unavailable'}
					detail={
						notFound ? 'It may have been removed. Go back to the list.' : (error ?? 'Fetching the latest item details.')
					}
				/>
				{!notFound && (
					<Btn tone="quiet" onClick={() => void onRetry()}>
						Retry
					</Btn>
				)}
			</div>
		</div>
	)
}
