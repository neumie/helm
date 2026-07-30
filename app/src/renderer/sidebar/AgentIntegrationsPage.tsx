import { useCallback, useEffect, useRef, useState } from 'react'
import type { PiAgentStatusIntegrationSnapshot } from '../../shared'
import { Banner, Btn, Card, EmptyState, InfoRow, PushHeader } from './ui'

const PI_AGENT_STATUS_SETUP_URL = 'https://github.com/neumie/pi-agent-status#install'

function integrationStatusLabel(status: PiAgentStatusIntegrationSnapshot['status']): string {
	switch (status) {
		case 'external':
			return 'Managed by Pi'
		case 'not-installed':
			return 'Not configured'
		case 'conflict':
			return 'Legacy extension detected'
		case 'unavailable':
			return 'Unavailable'
	}
}

export function AgentIntegrationsPage({ onBack }: { onBack: () => void }) {
	const [integration, setIntegration] = useState<PiAgentStatusIntegrationSnapshot | null>(null)
	const [error, setError] = useState<string | null>(null)
	const requestRevision = useRef(0)

	const refresh = useCallback(async () => {
		const revision = ++requestRevision.current
		try {
			const next = await window.helm.agentIntegrations.piStatus()
			if (revision !== requestRevision.current) return
			setIntegration(next)
			setError(null)
		} catch (reason) {
			if (revision === requestRevision.current) setError(reason instanceof Error ? reason.message : String(reason))
		}
	}, [])

	useEffect(() => {
		void refresh()
		const onFocus = () => void refresh()
		window.addEventListener('focus', onFocus)
		return () => {
			requestRevision.current++
			window.removeEventListener('focus', onFocus)
		}
	}, [refresh])

	const openSetup = async () => {
		try {
			if (!(await window.helm.external.open(PI_AGENT_STATUS_SETUP_URL))) {
				setError('Could not open the pi-agent-status setup instructions.')
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason))
		}
	}

	const needsSetup = integration?.status === 'not-installed' || integration?.status === 'conflict'
	return (
		<div className="page-frame">
			<PushHeader title="Agent integrations" onBack={onBack} />
			<div className="page-scroll">
				{error && (
					<Banner tone="error" label="Agent integration unavailable">
						{error}
					</Banner>
				)}
				{!integration ? (
					<EmptyState
						title={error ? 'Agent integrations unavailable' : 'Loading agent integrations'}
						detail={error ?? 'Checking the Pi status integration.'}
					/>
				) : (
					<Card
						label="Pi"
						trailing={
							needsSetup ? (
								<Btn sm tone="primary" onClick={() => void openSetup()}>
									View setup
								</Btn>
							) : undefined
						}
					>
						<InfoRow label="Status" value={integrationStatusLabel(integration.status)} />
						{(integration.status === 'conflict' || integration.status === 'unavailable') && (
							<Banner tone="warning" label="Package setup required">
								{integration.message}
							</Banner>
						)}
						{integration.status === 'external' && <p className="meta-text">{integration.message}</p>}
						<p className="meta-text">
							Reports Pi lifecycle and active tool names only inside new ordinary Helm terminals. It never reports
							prompts, commands, paths, or tool results.
						</p>
					</Card>
				)}
			</div>
		</div>
	)
}
