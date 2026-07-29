import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalPreferencesSnapshot } from '../../shared'
import { showToast } from '../toast'
import { Banner, Btn, Card, EmptyState, InfoRow, PushHeader } from './ui'

function PathValue({ value }: { value: string }) {
	return <span title={value}>{value}</span>
}

export function TerminalSettingsPage({ onBack }: { onBack: () => void }) {
	const [preferences, setPreferences] = useState<TerminalPreferencesSnapshot | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [working, setWorking] = useState(false)
	const requestRevision = useRef(0)

	const refresh = useCallback(async () => {
		const revision = ++requestRevision.current
		try {
			const next = await window.helm.terminalPreferences.get()
			if (revision !== requestRevision.current) return
			setPreferences(next)
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

	const chooseFolder = async () => {
		setWorking(true)
		setError(null)
		try {
			const next = await window.helm.terminalPreferences.chooseDefaultCwd()
			if (next) {
				requestRevision.current++
				setPreferences(next)
				showToast({ message: 'Terminal folder updated' })
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason))
		} finally {
			setWorking(false)
		}
	}

	const useHomeFolder = async () => {
		setWorking(true)
		setError(null)
		try {
			const next = await window.helm.terminalPreferences.resetDefaultCwd()
			requestRevision.current++
			setPreferences(next)
			showToast({ message: 'New terminals will start in Home' })
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason))
		} finally {
			setWorking(false)
		}
	}

	return (
		<div className="page-frame">
			<PushHeader title="Terminal" onBack={onBack} />
			<div className="page-scroll">
				{error && preferences && (
					<Banner tone="error" label="Terminal settings unavailable">
						{error}
					</Banner>
				)}
				{!preferences ? (
					<EmptyState
						title={error ? 'Terminal settings unavailable' : 'Loading terminal settings'}
						detail={error ?? 'Reading the global starting folder.'}
					/>
				) : (
					<Card
						label="New terminals"
						trailing={
							<Btn sm tone="primary" busy={working} onClick={() => void chooseFolder()}>
								Choose folder
							</Btn>
						}
					>
						{preferences.usingFallback && preferences.defaultCwd && (
							<InfoRow label="Configured" value={<PathValue value={preferences.defaultCwd} />} mono />
						)}
						<InfoRow label="Starting folder" value={<PathValue value={preferences.effectiveCwd} />} mono />
						{preferences.usingFallback && (
							<Banner tone="warning" label="Folder unavailable">
								Helm will use your Home folder until you choose an available folder.
							</Banner>
						)}
						<p className="meta-text">
							Applies to every new ordinary terminal. Existing and restored sessions keep their current directory.
						</p>
						{preferences.defaultCwd !== null && (
							<button type="button" className="field-reset" disabled={working} onClick={() => void useHomeFolder()}>
								Use Home folder
							</button>
						)}
					</Card>
				)}
			</div>
		</div>
	)
}
