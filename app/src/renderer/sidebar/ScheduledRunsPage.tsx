import { useCallback, useEffect, useMemo, useState } from 'react'
import './scheduled-runs.css'
import type { AppConfig, ScheduledRun, ScheduledSchedule, ScheduledScheduleInput } from '../../shared-helm'
import { showToast } from '../toast'
import { relativeTime, useNow } from './model'
import { canCancelScheduledRun, isFiveFieldCron, isIanaTimezone, scheduledRunStateLabel } from './scheduled-runs-model'
import {
	Banner,
	Btn,
	Card,
	Chip,
	EmptyState,
	FieldLabel,
	GLYPH,
	InfoRow,
	MenuButton,
	PushHeader,
	SelectInput,
	TextArea,
	TextInput,
	Toggle,
} from './ui'

const HISTORY_LIMIT = 20
const CADENCE_PRESETS: Array<{ value: ScheduledScheduleInput['cadenceKind']; label: string; cron: string }> = [
	{ value: 'hourly', label: 'Hourly', cron: '0 * * * *' },
	{ value: 'daily', label: 'Daily', cron: '0 9 * * *' },
	{ value: 'weekly', label: 'Weekly', cron: '0 9 * * 1' },
	{ value: 'cron', label: 'Custom', cron: '' },
]

type EditorDraft = ScheduledScheduleInput & { promptReplacement: string }

function blankDraft(config: AppConfig | null): EditorDraft {
	const projectSlug = config?.projects?.[0]?.slug ?? ''
	return {
		name: '',
		enabled: true,
		cron: '0 9 * * *',
		cadenceKind: 'daily',
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
		definition: { prompt: '', target: { kind: 'project', projectSlug }, agent: 'claude', maximumRuntimeMinutes: 120 },
		promptReplacement: '',
	}
}

function draftFrom(schedule: ScheduledSchedule): EditorDraft {
	return {
		name: schedule.name,
		enabled: schedule.enabled,
		cron: schedule.cron,
		cadenceKind: schedule.cadenceKind,
		timezone: schedule.timezone,
		definition: {
			prompt: '',
			target:
				schedule.target.kind === 'project'
					? { ...schedule.target }
					: { kind: 'system', riskAcknowledgement: 'broad-host-access' },
			agent: schedule.agent,
			...(schedule.model ? { model: schedule.model } : {}),
			...(schedule.effort ? { effort: schedule.effort } : {}),
			maximumRuntimeMinutes: schedule.maximumRuntimeMinutes,
		},
		promptReplacement: '',
	}
}

function scheduleTone(run: ScheduledRun): 'gray' | 'blue' | 'green' | 'amber' | 'red' {
	if (run.state === 'needs_attention') return 'amber'
	if (['failed', 'timed_out', 'interrupted', 'quarantined', 'session_lost'].includes(run.state)) return 'red'
	if (['running', 'launching', 'preparing', 'admitted', 'closing'].includes(run.state)) return 'blue'
	if (run.state === 'closed_quiet') return 'green'
	return 'gray'
}

export function ScheduledRunsPage({
	profileId,
	profileName,
	schedulingEnabled,
	onBack,
	onOpenEditor,
}: {
	profileId: string
	profileName: string
	schedulingEnabled: boolean
	onBack: () => void
	onOpenEditor: (scheduleId?: string) => void
}) {
	const [schedules, setSchedules] = useState<ScheduledSchedule[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const now = useNow()
	const reload = useCallback(async () => {
		const result = await window.helm.daemon.listScheduledRuns(profileId)
		if (result.error) setError(result.error)
		else {
			setSchedules(result.data ?? [])
			setError(null)
		}
	}, [profileId])
	useEffect(() => {
		void reload()
	}, [reload])
	return (
		<div className="page-frame">
			<PushHeader
				title="Scheduled runs"
				onBack={onBack}
				trailing={
					<Btn sm onClick={() => onOpenEditor()}>
						New
					</Btn>
				}
			/>
			<div className="page-scroll scheduled-page">
				{!schedulingEnabled && (
					<Banner tone="info" label="Scheduling is off">
						Definitions are saved, but they will not run until Scheduled runs is enabled in daemon settings.
					</Banner>
				)}
				<Card label="Profile" flush>
					<InfoRow label="Runs belong to" value={profileName} />
				</Card>
				{error ? (
					<EmptyState title="Scheduled runs unavailable" detail={error} />
				) : schedules === null ? (
					<EmptyState title="Loading scheduled runs" detail="Fetching definitions for this profile." />
				) : schedules.length === 0 ? (
					<EmptyState title="No scheduled runs" detail="Create a schedule to run work at a fixed time." />
				) : (
					<Card label="Definitions" flush>
						{schedules
							.filter(schedule => !schedule.archivedAt)
							.map(schedule => (
								<button
									key={schedule.id}
									type="button"
									className="scheduled-definition-row"
									onClick={() => onOpenEditor(schedule.id)}
								>
									<span className="scheduled-definition-main">
										<span>{schedule.name}</span>
										<small>
											{schedule.target.kind === 'project' ? schedule.target.projectSlug : 'System'} ·{' '}
											{schedule.timezone}
										</small>
									</span>
									<span className="scheduled-definition-side">
										<small>
											{schedule.enabled
												? schedule.nextRunAt
													? `Next ${relativeTime(schedule.nextRunAt, now)}`
													: 'Enabled'
												: 'Disabled'}
										</small>
									</span>
								</button>
							))}
					</Card>
				)}
			</div>
		</div>
	)
}

export function ScheduledRunEditorPage({
	profileId,
	scheduleId,
	config,
	onBack,
}: { profileId: string; scheduleId?: string; config: AppConfig | null; onBack: () => void }) {
	const [schedule, setSchedule] = useState<ScheduledSchedule | null>(null)
	const [draft, setDraft] = useState<EditorDraft>(() => blankDraft(config))
	const [history, setHistory] = useState<ScheduledRun[]>([])
	const [loading, setLoading] = useState(Boolean(scheduleId))
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const systemAllowed = config?.scheduledRuns?.systemTargetsEnabled === true
	const projects = config?.projects?.map(project => project.slug) ?? []
	const isEdit = Boolean(scheduleId)
	useEffect(() => {
		if (!scheduleId) return
		let alive = true
		void Promise.all([
			window.helm.daemon.listScheduledRuns(profileId),
			window.helm.daemon.scheduledRunHistory(profileId, scheduleId, HISTORY_LIMIT),
		]).then(([definitions, runs]) => {
			if (!alive) return
			if (definitions.error) {
				setError(definitions.error)
				setLoading(false)
				return
			}
			const found = definitions.data?.find(value => value.id === scheduleId) ?? null
			if (!found) {
				setError('Scheduled definition not found.')
				setLoading(false)
				return
			}
			setSchedule(found)
			setDraft(draftFrom(found))
			setHistory(runs.data ?? [])
			setError(runs.error ?? null)
			setLoading(false)
		})
		return () => {
			alive = false
		}
	}, [profileId, scheduleId])
	const validation = useMemo(() => {
		if (!draft.name.trim()) return 'Enter a schedule name.'
		if (!isFiveFieldCron(draft.cron)) return 'Cron must contain exactly five fields and cannot use aliases.'
		if (!isIanaTimezone(draft.timezone)) return 'Enter an IANA timezone such as America/New_York or UTC.'
		if (!isEdit && !draft.definition.prompt.trim()) return 'Enter a prompt for this schedule.'
		if (draft.definition.target.kind === 'project' && !draft.definition.target.projectSlug)
			return 'Choose a project target.'
		if (draft.definition.target.kind === 'system' && !systemAllowed)
			return 'System targets are disabled by daemon policy.'
		const maximumRuntime = draft.definition.target.kind === 'system' ? 120 : 360
		if (
			!Number.isInteger(draft.definition.maximumRuntimeMinutes) ||
			draft.definition.maximumRuntimeMinutes < 5 ||
			draft.definition.maximumRuntimeMinutes > maximumRuntime
		)
			return `Maximum runtime must be from 5 to ${maximumRuntime} minutes for this target.`
		return null
	}, [draft, isEdit, systemAllowed])
	const body = (): ScheduledScheduleInput => {
		const { promptReplacement, ...input } = draft
		return {
			...input,
			definition: { ...input.definition, prompt: isEdit ? promptReplacement : input.definition.prompt },
		}
	}
	const save = async () => {
		if (validation) {
			setError(validation)
			return
		}
		setSaving(true)
		setError(null)
		try {
			const result = schedule
				? await window.helm.daemon.updateScheduledRun(profileId, schedule.id, {
						...body(),
						revision: schedule.revision,
					})
				: await window.helm.daemon.createScheduledRun(profileId, body())
			if (result.error) {
				setError(result.error)
				return
			}
			showToast({ message: schedule ? 'Scheduled run updated' : 'Scheduled run created' })
			if (!result.data) {
				setError('The daemon returned no scheduled definition.')
				return
			}
			if (!schedule) {
				onBack()
				return
			}
			setSchedule(result.data)
			setDraft(draftFrom(result.data))
		} finally {
			setSaving(false)
		}
	}
	const action = async (actionName: 'enable' | 'disable' | 'archive' | 'run') => {
		if (!schedule) return
		const result = await window.helm.daemon.scheduledRunAction(profileId, schedule.id, actionName, schedule.revision)
		if (result.error) {
			setError(result.error)
			return
		}
		if (actionName === 'run') {
			if (result.data && 'state' in result.data) setHistory(current => [result.data as ScheduledRun, ...current])
			showToast({ message: 'Scheduled run started' })
			return
		}
		const updated = result.data as ScheduledSchedule
		setSchedule(updated)
		setDraft(current => ({ ...current, enabled: updated.enabled }))
		showToast({ message: actionName === 'archive' ? 'Scheduled run archived' : `Scheduled run ${actionName}d` })
		if (actionName === 'archive') onBack()
	}
	const openTerminal = async (run: ScheduledRun) => {
		const result = await window.helm.daemon.openScheduledTerminal(profileId, run.id, run.revision)
		if (result.error) setError(result.error)
		else showToast({ message: 'Opening scheduled terminal' })
	}
	const cancelRun = async (run: ScheduledRun) => {
		const result = await window.helm.daemon.cancelScheduledRun(profileId, run.id, run.revision)
		if (result.error) {
			setError(result.error)
			return
		}
		if (result.data) setHistory(current => current.map(value => (value.id === run.id ? result.data : value)))
		showToast({ message: 'Scheduled run cancellation requested' })
	}
	const setCadence = (cadenceKind: ScheduledScheduleInput['cadenceKind']) => {
		const preset = CADENCE_PRESETS.find(value => value.value === cadenceKind)
		setDraft(current => ({ ...current, cadenceKind, cron: preset?.cron || current.cron }))
	}
	if (loading)
		return (
			<div className="page-frame">
				<PushHeader title="Scheduled run" onBack={onBack} />
				<EmptyState title="Loading scheduled run" detail="Fetching definition and latest history." />
			</div>
		)
	return (
		<div className="page-frame">
			<PushHeader title={schedule?.name || 'New scheduled run'} onBack={onBack} />
			<div className="page-scroll scheduled-page">
				{error && (
					<Banner tone="error" label="Schedule needs attention">
						{error}
					</Banner>
				)}
				<Card label="Schedule">
					<div className="settings-field">
						<FieldLabel htmlFor="schedule-name">Name</FieldLabel>
						<TextInput
							id="schedule-name"
							value={draft.name}
							onChange={name => setDraft(current => ({ ...current, name }))}
						/>
					</div>
					<div className="settings-field">
						<FieldLabel htmlFor="schedule-cadence">Preset</FieldLabel>
						<SelectInput
							id="schedule-cadence"
							value={draft.cadenceKind}
							onChange={value => setCadence(value as ScheduledScheduleInput['cadenceKind'])}
							options={CADENCE_PRESETS.map(value => ({ value: value.value, label: value.label }))}
						/>
					</div>
					<div className="settings-field">
						<FieldLabel htmlFor="schedule-cron">Cron</FieldLabel>
						<TextInput
							id="schedule-cron"
							value={draft.cron}
							placeholder="0 9 * * 1"
							invalid={draft.cron !== '' && !isFiveFieldCron(draft.cron)}
							onChange={cron => setDraft(current => ({ ...current, cron }))}
						/>
					</div>
					<div className="settings-field">
						<FieldLabel htmlFor="schedule-timezone">Timezone</FieldLabel>
						<TextInput
							id="schedule-timezone"
							value={draft.timezone}
							placeholder="America/New_York"
							invalid={draft.timezone !== '' && !isIanaTimezone(draft.timezone)}
							onChange={timezone => setDraft(current => ({ ...current, timezone }))}
						/>
					</div>
					<div className="toggle-row">
						<span className="toggle-label">Enabled</span>
						<Toggle
							label="Enabled"
							value={draft.enabled}
							onChange={enabled => setDraft(current => ({ ...current, enabled }))}
						/>
					</div>
				</Card>
				<Card label="Work">
					<div className="settings-field">
						<FieldLabel htmlFor="schedule-target">Target</FieldLabel>
						<SelectInput
							id="schedule-target"
							value={
								draft.definition.target.kind === 'project' ? `project:${draft.definition.target.projectSlug}` : 'system'
							}
							onChange={value =>
								setDraft(current => ({
									...current,
									definition: {
										...current.definition,
										target:
											value === 'system'
												? { kind: 'system', riskAcknowledgement: 'broad-host-access' }
												: { kind: 'project', projectSlug: value.slice('project:'.length) },
									},
								}))
							}
							options={[
								...projects.map(slug => ({ value: `project:${slug}`, label: slug })),
								...(systemAllowed || draft.definition.target.kind === 'system'
									? [{ value: 'system', label: systemAllowed ? 'System' : 'System (disabled)' }]
									: []),
							]}
						/>
					</div>
					<div className="settings-field">
						<FieldLabel htmlFor="schedule-agent">Agent</FieldLabel>
						<SelectInput
							id="schedule-agent"
							value={draft.definition.agent}
							onChange={agent =>
								setDraft(current => ({
									...current,
									definition: { ...current.definition, agent: agent as 'claude' | 'codex' },
								}))
							}
							options={[
								{ value: 'claude', label: 'Claude Code' },
								{ value: 'codex', label: 'Codex' },
							]}
						/>
					</div>
					<div className="settings-field">
						<FieldLabel htmlFor="schedule-runtime">Maximum runtime (minutes)</FieldLabel>
						<TextInput
							id="schedule-runtime"
							type="number"
							value={String(draft.definition.maximumRuntimeMinutes)}
							onChange={value =>
								setDraft(current => ({
									...current,
									definition: { ...current.definition, maximumRuntimeMinutes: Number(value) },
								}))
							}
						/>
					</div>
					<div className="settings-field">
						<FieldLabel htmlFor="schedule-prompt">{isEdit ? 'Replace prompt' : 'Prompt'}</FieldLabel>
						<TextArea
							id="schedule-prompt"
							value={isEdit ? draft.promptReplacement : draft.definition.prompt}
							placeholder={isEdit ? 'Leave blank to keep the existing prompt' : 'Describe the work to run.'}
							onChange={prompt =>
								setDraft(current =>
									isEdit
										? { ...current, promptReplacement: prompt }
										: { ...current, definition: { ...current.definition, prompt } },
								)
							}
							rows={6}
						/>
					</div>
				</Card>
				{schedule && (
					<Card label="Latest history" flush>
						{history.length === 0 ? (
							<p className="section-description">No runs recorded yet.</p>
						) : (
							history.map(run => (
								<div className="scheduled-history-row" key={run.id}>
									<div>
										<Chip tone={scheduleTone(run)}>{scheduledRunStateLabel(run.state)}</Chip>
										<p>{run.reportSummary || `Scheduled ${relativeTime(run.scheduledFor, Date.now())}`}</p>
										<small>
											{run.startedAt
												? `Started ${new Date(run.startedAt).toLocaleString()}`
												: `Scheduled ${new Date(run.scheduledFor).toLocaleString()}`}
										</small>
									</div>
									<div className="scheduled-history-actions">
										{run.state === 'needs_attention' && run.sessionAvailability === 'available' && (
											<Btn sm tone="quiet" onClick={() => void openTerminal(run)}>
												Open terminal
											</Btn>
										)}
										{canCancelScheduledRun(run.state) && (
											<Btn sm tone="quiet" onClick={() => void cancelRun(run)}>
												Cancel
											</Btn>
										)}
									</div>
								</div>
							))
						)}
					</Card>
				)}
				{validation && <output className="scheduled-validation">{validation}</output>}
			</div>
			<div className="action-bar scheduled-actions">
				{schedule && (
					<Btn tone="quiet" onClick={() => void action('run')}>
						Run now
					</Btn>
				)}
				<Btn tone="primary" busy={saving} disabled={Boolean(validation)} onClick={() => void save()}>
					{saving ? 'Saving' : schedule ? 'Save changes' : 'Create schedule'}
				</Btn>
				{schedule && (
					<MenuButton
						trigger={GLYPH.ellipsis}
						triggerLabel="More scheduled actions"
						entries={[
							{
								label: schedule.enabled ? 'Disable' : 'Enable',
								icon: schedule.enabled ? GLYPH.pause : GLYPH.play,
								onSelect: () => void action(schedule.enabled ? 'disable' : 'enable'),
							},
							{ label: 'Archive', icon: GLYPH.archive, danger: true, onSelect: () => void action('archive') },
						]}
					/>
				)}
			</div>
		</div>
	)
}
