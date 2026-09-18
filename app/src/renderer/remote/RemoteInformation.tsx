import { memo, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, Ref } from 'react'
import type { InformationEnvelope } from '../../../../src/remote/information-protocol.js'
import type { RemoteSubagentActivity } from '../../../../src/remote/subagent-activity-protocol.js'
import { type InformationState, RemoteInformationController } from './information-controller.js'
import {
	type RemoteSessionPresentation,
	type RemoteSessionStatus,
	RemoteStatusChip,
} from './remote-session-presentation.js'
import type { InformationTarget, RemoteTransport } from './transport.js'

export function useRemoteInformation(transport: RemoteTransport, owner: InformationTarget) {
	const {
		hostEpoch,
		target: { sessionId, incarnation, scopeId, generation },
	} = owner
	const controller = useMemo(
		() =>
			new RemoteInformationController(transport, {
				hostEpoch,
				target: { sessionId, incarnation, scopeId, generation },
			}),
		[transport, hostEpoch, sessionId, incarnation, scopeId, generation],
	)
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
	useLayoutEffect(() => {
		const visible = () => controller.setVisible(document.visibilityState !== 'hidden')
		visible()
		document.addEventListener('visibilitychange', visible)
		return () => {
			document.removeEventListener('visibilitychange', visible)
			controller.dispose()
		}
	}, [controller])
	return { controller, state }
}
export function useInformationRail() {
	const [rail, setRail] = useState(() => window.matchMedia('(min-width: 1200px)').matches)
	useEffect(() => {
		const media = window.matchMedia('(min-width: 1200px)')
		const changed = () => setRail(media.matches)
		changed()
		media.addEventListener('change', changed)
		return () => media.removeEventListener('change', changed)
	}, [])
	return rail
}
const display = (value: string | number | boolean | null) =>
	value === null ? 'Unavailable' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)
const tokenNumberFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const formatTokenCount = (value: number | null) =>
	value === null ? 'Unavailable' : tokenNumberFormat.format(value).toLowerCase()

export function reportedTokensSpent(inputTokens: number | null, outputTokens: number | null): number | null {
	if (inputTokens === null || outputTokens === null) return null
	const total = inputTokens + outputTokens
	return Number.isSafeInteger(total) ? total : null
}
const availability = (value: string) =>
	value === 'unsupported' ? 'Unsupported' : value === 'access-ended' ? 'Access ended' : 'Unavailable'
function footerRows(
	fields: NonNullable<InformationEnvelope['footer']['fields']>,
): Array<[string, string | number | boolean | null]> {
	return [
		['Workspace', fields.cwd],
		['Session name', fields.sessionName],
		['Input tokens', formatTokenCount(fields.inputTokens)],
		['Output tokens', formatTokenCount(fields.outputTokens)],
		['Context tokens', formatTokenCount(fields.contextTokens)],
		['Context window', formatTokenCount(fields.contextWindow)],
		['Trusted workspace', fields.trusted],
		['Goal', !fields.goalAvailable ? 'Unavailable' : (fields.goalPhase?.replaceAll('_', ' ') ?? 'No active goal')],
		['Other statuses omitted', fields.omittedStatuses],
	]
}
export const InformationFooter = memo(function InformationFooter({
	state,
	source,
	modelFallback,
}: {
	state: InformationState
	source: 'Okena' | 'Helm' | 'Source unavailable'
	modelFallback?: string | null
}) {
	const fields = state.information?.footer.fields
	const model = fields ? fields.model : modelFallback
	const thinking = fields?.thinking ?? null
	const spent = formatTokenCount(reportedTokensSpent(fields?.inputTokens ?? null, fields?.outputTokens ?? null))
	const percent = fields?.contextPercent ?? null
	const description = fields
		? 'Conversation information'
		: `Conversation information: ${availability(state.information?.footer.availability ?? state.status)}`
	return (
		<div className="remote-information-footer" aria-label={description} title={description}>
			<div className="remote-information-footer-metadata">
				<div className="remote-information-footer-identity">
					<span
						className="remote-information-footer-group remote-information-footer-model"
						title={model ?? 'Model unavailable'}
					>
						{model ?? 'Model unavailable'}
					</span>
					<span
						className="remote-information-footer-group remote-information-footer-effort"
						aria-label={thinking === null ? 'Effort unavailable' : undefined}
					>
						<span className={thinking === null ? 'remote-information-footer-unavailable-value' : undefined}>
							{thinking ?? 'Unavailable'}
						</span>
						{thinking === null && (
							<span className="remote-information-footer-compact-dash" aria-hidden="true">
								—
							</span>
						)}
					</span>
				</div>
				<span className="remote-information-footer-group remote-information-footer-source">{source}</span>
			</div>
			<div className="remote-information-footer-usage">
				<span
					className="remote-information-footer-group remote-information-footer-spent"
					aria-label={`Reported tokens spent: ${spent}`}
				>
					<span className={spent === 'Unavailable' ? 'remote-information-footer-unavailable-value' : undefined}>
						{spent}
					</span>
					{spent === 'Unavailable' && (
						<span className="remote-information-footer-compact-dash" aria-hidden="true">
							—
						</span>
					)}
				</span>
				<span className="remote-information-footer-dot" aria-hidden="true">
					·
				</span>
				<span
					className="remote-information-footer-group remote-information-footer-context"
					aria-label={percent === null ? 'Context used unavailable' : undefined}
				>
					<span
						className={`remote-context-meter ${percent === null ? 'remote-context-meter-unknown' : ''}`}
						{...(percent === null
							? { 'aria-label': 'Context used unavailable' }
							: {
									role: 'meter',
									'aria-label': 'Context used',
									'aria-valuenow': percent,
									'aria-valuemin': 0,
									'aria-valuemax': 100,
									style: { '--context-percent': percent } as CSSProperties,
								})}
					/>
					<span className={percent === null ? 'remote-information-footer-unavailable-value' : undefined}>
						{percent === null ? 'Unavailable' : `${Math.round(percent)}%`}
					</span>
					{percent === null && (
						<span className="remote-information-footer-compact-dash" aria-hidden="true">
							—
						</span>
					)}
				</span>
			</div>
		</div>
	)
})
export interface CurrentConversation {
	presentation: RemoteSessionPresentation
	status: RemoteSessionStatus
	workspace: string | null
	subagents?: RemoteSubagentActivity
}
export const RemoteInformation = memo(function RemoteInformation({
	state,
	mobile = false,
	headingRef,
	current,
}: { state: InformationState; mobile?: boolean; headingRef: Ref<HTMLHeadingElement>; current: CurrentConversation }) {
	const information = state.information
	return (
		<aside
			className={`remote-information ${mobile ? 'remote-information-view' : 'remote-information-rail'}`}
			aria-label="Conversation information"
		>
			<header>
				<h2 ref={headingRef} tabIndex={-1}>
					Information
				</h2>
			</header>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: bounded information reading region is keyboard scrollable. */}
			<section className="remote-information-body" tabIndex={0} aria-label="Information details">
				<section className="remote-current-conversation">
					<h3>Current conversation</h3>
					<p className="remote-current-title">{current.presentation.title}</p>
					<RemoteStatusChip status={current.status} />
					<p className="remote-current-subagents">
						Subagents:{' '}
						{current.subagents?.availability === 'available'
							? current.subagents.active
								? 'Active'
								: 'None active observed'
							: 'Unavailable'}
					</p>
					<p className="remote-current-subagents-note">
						Covers observed foreground and built-in async work in this Pi session; retained and separate external jobs
						may be omitted.
					</p>
					<dl>
						{current.presentation.facts.map(fact => (
							<div key={fact.label}>
								<dt>{fact.label}</dt>
								<dd>{fact.value}</dd>
							</div>
						))}
						{current.presentation.branch && (
							<div>
								<dt>Branch</dt>
								<dd>{current.presentation.branch}</dd>
							</div>
						)}
					</dl>
				</section>
				{!information ? (
					<p>
						Information {availability(state.status).toLowerCase()}.{' '}
						{state.status === 'unsupported'
							? 'This owner does not provide information.'
							: 'Waiting for a fresh authorized observation.'}
					</p>
				) : (
					<>
						<section>
							<h3>Session details</h3>
							{information.footer.fields ? (
								<>
									<dl>
										{footerRows(information.footer.fields)
											.filter(([label, value]) =>
												label === 'Session name'
													? value !== current.presentation.title.trim()
													: label !== 'Workspace' ||
														!(
															current.workspace !== null &&
															current.workspace.trim() !== '' &&
															(value === current.workspace ||
																current.presentation.facts.some(
																	fact => fact.label === 'Workspace' && fact.value === value,
																))
														),
											)
											.map(([label, value]) => (
												<div key={label}>
													<dt>{label}</dt>
													<dd>{display(value)}</dd>
												</div>
											))}
									</dl>
									{information.footer.fields.omitted > 0 && (
										<p>{information.footer.fields.omitted} footer fields omitted.</p>
									)}
									<p>
										Reported tokens spent counts input plus output on this conversation branch; cached and
										separate-agent usage is excluded.
									</p>
								</>
							) : (
								<p>{availability(information.footer.availability)}</p>
							)}
						</section>
						{information.sidebar.availability !== 'available' && (
							<p>Sidebar information: {availability(information.sidebar.availability)}</p>
						)}
						{information.sidebar.sections.map((section, index) => (
							<section key={`${index}:${section.title}`}>
								<h3>{section.title}</h3>
								{section.scope === 'process' && <p className="remote-information-scope">Process-wide</p>}
								{section.availability !== 'available' ? (
									<p>{availability(section.availability)}</p>
								) : (
									<>
										{section.coverage === 'limited' && <p>Limited coverage — not a complete observation.</p>}
										<dl>
											{section.rows.map((row, rowIndex) => (
												<div key={`${rowIndex}:${row.label}`}>
													<dt>{row.label}</dt>
													<dd>{display(row.value)}</dd>
												</div>
											))}
										</dl>
										{section.rows.length === 0 && section.coverage === 'complete' && section.omitted === 0 && (
											<p>No entries in this observation.</p>
										)}
									</>
								)}
								{section.omitted > 0 && <p>{section.omitted} entries omitted.</p>}
							</section>
						))}
						{information.sidebar.omittedProviders > 0 && (
							<p>{information.sidebar.omittedProviders} providers omitted.</p>
						)}
					</>
				)}
				<p className="remote-information-scope">Full subagent fleet is unsupported and unfinished.</p>
			</section>
		</aside>
	)
})
