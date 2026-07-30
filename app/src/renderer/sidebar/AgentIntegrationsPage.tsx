import { useCallback, useEffect, useRef, useState } from 'react'
import type { PiAgentStatusIntegrationSnapshot } from '../../shared'
import { showToast } from '../toast'
import { Banner, Btn, Card, EmptyState, InfoRow, PushHeader } from './ui'

function integrationStatusLabel(status: PiAgentStatusIntegrationSnapshot['status']): string {
	switch (status) {
		case 'installed':
			return 'Installed'
		case 'external':
			return 'Managed by Pi'
		case 'outdated':
			return 'Update available'
		case 'not-installed':
			return 'Not installed'
		case 'conflict':
			return 'Conflicting file'
		case 'unavailable':
			return 'Unavailable'
	}
}

export function AgentIntegrationsPage({ onBack }: { onBack: () => void }) {
	const [integration, setIntegration] = useState<PiAgentStatusIntegrationSnapshot | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [working, setWorking] = useState(false)
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

	const install = async () => {
		setWorking(true)
		setError(null)
		try {
			const next = await window.helm.agentIntegrations.installPiStatus()
			requestRevision.current++
			setIntegration(next)
			showToast({ message: 'Pi status integration installed', detail: 'Run /reload in an open Pi session.' })
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason))
		} finally {
			setWorking(false)
		}
	}

	const remove = async () => {
		setWorking(true)
		setError(null)
		try {
			const next = await window.helm.agentIntegrations.removePiStatus()
			requestRevision.current++
			setIntegration(next)
			showToast({ message: 'Pi status integration removed', detail: 'Run /reload in an open Pi session.' })
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason))
		} finally {
			setWorking(false)
		}
	}

	const installable = integration?.status === 'not-installed' || integration?.status === 'outdated'
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
							installable ? (
								<Btn sm tone="primary" busy={working} onClick={() => void install()}>
									{integration.status === 'outdated' ? 'Update' : 'Install'}
								</Btn>
							) : undefined
						}
					>
						<InfoRow label="Status" value={integrationStatusLabel(integration.status)} />
						{(integration.status === 'conflict' || integration.status === 'unavailable') && (
							<Banner tone="warning" label="Installation unavailable">
								{integration.message}
							</Banner>
						)}
						{integration.status === 'external' && <p className="meta-text">{integration.message}</p>}
						<p className="meta-text">
							Reports Pi lifecycle and active tool names only inside new ordinary Helm terminals. It never reports
							prompts, commands, paths, or tool results.
						</p>
						{integration.status === 'installed' && (
							<button type="button" className="field-reset" disabled={working} onClick={() => void remove()}>
								Remove integration
							</button>
						)}
					</Card>
				)}
			</div>
		</div>
	)
}
