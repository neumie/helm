import type { RemoteSnapshot, RemoteSummary } from '../../../../src/remote/protocol.js'
import type { RemoteSubagentActivity } from '../../../../src/remote/subagent-activity-protocol.js'
import type { DashboardTone } from '../../shared-helm.js'
import { Chip } from '../sidebar/ui.js'

export const ACTIVITY_LABEL: Record<RemoteSnapshot['activity'], string> = {
	idle: 'Main Pi idle',
	working: 'Working',
	waiting: 'Needs you',
	unknown: 'State unknown',
}

const ACTIVITY_TONE: Record<RemoteSnapshot['activity'], DashboardTone> = {
	idle: 'gray',
	working: 'blue',
	waiting: 'amber',
	unknown: 'gray',
}

const GENERIC_PI_LABEL = 'pi session'

type RemoteSession = Pick<RemoteSummary, 'label' | 'workspace' | 'model' | 'terminal'>

export interface RemoteSessionStatus {
	label: string
	tone: DashboardTone
}

interface SessionFact {
	label: 'Group' | 'Project' | 'Worktree' | 'Workspace'
	value: string
}

export interface RemoteSessionPresentation {
	title: string
	source: 'Okena' | 'Helm' | 'Source unavailable'
	facts: SessionFact[]
	branch: string | null
	model: string | null
}

function text(value: string | null | undefined): string | null {
	const normalized = value?.trim()
	return normalized ? normalized : null
}

function isGenericPiLabel(value: string): boolean {
	return value.trim().toLowerCase() === GENERIC_PI_LABEL
}

/**
 * Prefer native terminal identity, but do not turn Pi's generic label into a
 * repeated heading when a meaningful workspace label is available.
 */
export function describeRemoteSession(session: RemoteSession): RemoteSessionPresentation {
	const terminal = session.terminal
	const label = text(session.label)
	const workspace = text(session.workspace)
	const title =
		text(terminal?.name) ??
		text(terminal?.worktree) ??
		text(terminal?.project) ??
		(label && !isGenericPiLabel(label) ? label : null) ??
		workspace ??
		label ??
		'Pi session'
	const facts: SessionFact[] = []
	const addFact = (fact: SessionFact['label'], value: string | null) => {
		if (!value || value === title || facts.some(item => item.label === fact && item.value === value)) return
		facts.push({ label: fact, value })
	}
	addFact('Group', text(terminal?.group))
	addFact('Project', text(terminal?.project))
	addFact('Worktree', text(terminal?.worktree))
	if (!terminal || (!terminal.group && !terminal.project && !terminal.worktree && !terminal.branch))
		addFact('Workspace', workspace)
	return {
		title,
		source: terminal?.source === 'okena' ? 'Okena' : terminal?.source === 'helm' ? 'Helm' : 'Source unavailable',
		facts,
		branch: text(terminal?.branch),
		model: text(session.model),
	}
}

/** Search text intentionally retains raw labels and workspace values in addition to the visible projection. */
export function remoteSessionSearchText(session: RemoteSession): string {
	const terminal = session.terminal
	return [
		describeRemoteSession(session).title,
		session.label,
		session.workspace,
		terminal?.source,
		terminal?.name,
		terminal?.group,
		terminal?.project,
		terminal?.worktree,
		terminal?.branch,
		session.model,
	]
		.filter((value): value is string => !!value)
		.join(' ')
}

export function remoteSessionStatus(
	activity: RemoteSnapshot['activity'],
	connected: boolean,
	subagents?: RemoteSubagentActivity,
): RemoteSessionStatus {
	if (!connected) return { label: 'Disconnected', tone: 'gray' }
	if (activity === 'waiting') return { label: 'Needs you', tone: 'amber' }
	if (activity === 'working') return { label: 'Working', tone: 'blue' }
	if (activity === 'unknown') return { label: 'State unknown', tone: 'gray' }
	if (subagents?.availability === 'available' && subagents.active) return { label: 'Subagents active', tone: 'blue' }
	return { label: 'Main Pi idle', tone: 'gray' }
}

export function RemoteStatusChip({ status }: { status: RemoteSessionStatus }) {
	return <Chip tone={status.tone}>{status.label}</Chip>
}

export function RemoteSessionInfo({
	session,
	status,
	variant,
	model,
}: {
	session: RemoteSession
	status: RemoteSessionStatus
	variant: 'row' | 'detail'
	model?: string | null
}) {
	const presentation = describeRemoteSession(session)
	const sourceLine =
		presentation.source === 'Source unavailable' ? presentation.source : `Source: ${presentation.source}`
	const detailModel = model === undefined ? presentation.model : text(model)
	return (
		<span className={`remote-session-info remote-session-info-${variant}`}>
			{variant === 'row' && (
				<span className="remote-session-primary">
					<strong className="remote-session-title" title={presentation.title}>
						{presentation.title}
					</strong>
					<RemoteStatusChip status={status} />
				</span>
			)}
			{variant === 'detail' ? (
				<span className="remote-session-detail-head">
					<span className="remote-session-source">{sourceLine}</span>
					<RemoteStatusChip status={status} />
				</span>
			) : (
				<span className="remote-session-source">{sourceLine}</span>
			)}
			{presentation.facts.length > 0 && (
				<span className="remote-session-context">
					{presentation.facts.map((fact, index) => (
						<span key={`${fact.label}:${fact.value}`}>
							{index > 0 && ' · '}
							<span className="remote-session-fact-label">{fact.label}:</span> {fact.value}
						</span>
					))}
				</span>
			)}
			{presentation.branch && (
				<span className="remote-session-branch">
					<span className="remote-session-fact-label">Branch:</span> {presentation.branch}
				</span>
			)}
			{variant === 'detail' && detailModel && (
				<span className="remote-session-model">
					<span className="remote-session-fact-label">Model:</span> {detailModel}
				</span>
			)}
		</span>
	)
}
