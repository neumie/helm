import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalPreferencesSnapshot } from '../../shared'
import {
	SHORTCUTS,
	type ShortcutAction,
	type ShortcutChord,
	definitionForShortcut,
	moveShortcutCandidate,
	serializeShortcut,
	shortcutConflicts,
	shortcutDisplay,
} from '../../shortcuts'
import { showToast } from '../toast'
import { Banner, Btn, Card, EmptyState, InfoRow, PushHeader, Toggle } from './ui'

function PathValue({ value }: { value: string }) {
	return <span title={value}>{value}</span>
}
const SHORTCUT_SCOPE_LABELS = {
	menu: 'Helm menus',
	'terminal-selection': 'Terminal selection',
	'terminal-input': 'Terminal input',
	'run-context': 'Run context',
} as const

function cloneBindings(preferences: TerminalPreferencesSnapshot): Record<ShortcutAction, ShortcutChord[]> {
	return Object.fromEntries(
		Object.entries(preferences.shortcuts).map(([action, bindings]) => [
			action,
			bindings.map(binding => ({ ...binding })),
		]),
	) as Record<ShortcutAction, ShortcutChord[]>
}

export function TerminalSettingsPage({ onBack }: { onBack: () => void }) {
	const [preferences, setPreferences] = useState<TerminalPreferencesSnapshot | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [working, setWorking] = useState(false)
	const [recording, setRecording] = useState<{ action: ShortcutAction; index: number | null } | null>(null)
	const [conflict, setConflict] = useState<{
		chord: ShortcutChord
		from: ShortcutAction
		to: ShortcutAction
		candidate: Record<ShortcutAction, ShortcutChord[]>
		replacementIndex: number
		baseRevision: number
	} | null>(null)
	const requestRevision = useRef(0)

	const refresh = useCallback(async () => {
		const request = ++requestRevision.current
		try {
			const next = await window.helm.terminalPreferences.get()
			if (request !== requestRevision.current) return
			setPreferences(current => (!current || next.revision >= current.revision ? next : current))
			setError(null)
		} catch (reason) {
			if (request === requestRevision.current) setError(reason instanceof Error ? reason.message : String(reason))
		}
	}, [])
	useEffect(() => {
		void refresh()
		const unsubscribe = window.helm.terminalPreferences.onChanged(next => {
			setPreferences(current => (!current || next.revision >= current.revision ? next : current))
		})
		const onFocus = () => void refresh()
		window.addEventListener('focus', onFocus)
		return () => {
			requestRevision.current++
			window.helm.terminalPreferences.cancelShortcutRecorder()
			unsubscribe()
			window.removeEventListener('focus', onFocus)
		}
	}, [refresh])

	const apply = async (update: Omit<Parameters<typeof window.helm.terminalPreferences.update>[0], 'revision'>) => {
		if (!preferences || working) return
		setWorking(true)
		setError(null)
		try {
			const next = await window.helm.terminalPreferences.update({ revision: preferences.revision, ...update })
			requestRevision.current++
			setPreferences(next)
			setConflict(null)
		} catch (reason) {
			const message = reason instanceof Error ? reason.message : String(reason)
			setError(
				message.includes('changed in another window')
					? 'Terminal settings changed elsewhere. Reloaded the latest settings.'
					: message,
			)
			if (message.includes('changed in another window')) void refresh()
		} finally {
			setWorking(false)
		}
	}
	const chooseFolder = async () => {
		if (working) return
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
		if (working) return
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
	const saveBindings = (bindings: Record<ShortcutAction, ShortcutChord[]>) => void apply({ shortcuts: bindings })
	const record = async (action: ShortcutAction, index: number | null) => {
		if (!preferences || working) return
		const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
		window.helm.terminalPreferences.cancelShortcutRecorder()
		setRecording({ action, index })
		setConflict(null)
		setError(null)
		try {
			const chord = await window.helm.terminalPreferences.recordShortcut()
			if (!chord) return
			const before = cloneBindings(preferences)
			const next = cloneBindings(preferences)
			const replacementIndex = index ?? next[action].length
			if (index === null) next[action].push(chord)
			else next[action][index] = chord
			const found = shortcutConflicts(next, window.helm.platform)[0]
			if (found?.kind === 'helm') {
				const key = serializeShortcut(chord)
				const owner = SHORTCUTS.find(definition =>
					before[definition.action].some(binding => serializeShortcut(binding) === key),
				)?.action
				if (!owner) throw new Error('Shortcut ownership changed while recording. Try again.')
				setConflict({
					chord,
					from: owner,
					to: action,
					candidate: next,
					replacementIndex,
					baseRevision: preferences.revision,
				})
				return
			}
			if (found?.kind === 'native') {
				setError(`${shortcutDisplay(chord, window.helm.platform)} belongs to ${found.owner}. Choose another shortcut.`)
				return
			}
			if (found?.kind === 'invalid') {
				setError(found.message)
				return
			}
			saveBindings(next)
		} catch (reason) {
			setError(`Could not record shortcut: ${reason instanceof Error ? reason.message : String(reason)}`)
		} finally {
			setRecording(null)
			requestAnimationFrame(() => restoreFocus?.isConnected && restoreFocus.focus())
		}
	}
	const remove = (action: ShortcutAction, index: number) => {
		if (!preferences) return
		const next = cloneBindings(preferences)
		next[action].splice(index, 1)
		saveBindings(next)
	}
	const resetAction = (action: ShortcutAction) => {
		if (!preferences) return
		const next = cloneBindings(preferences)
		next[action] = definitionForShortcut(action).bindings.map(binding => ({ ...binding }))
		saveBindings(next)
	}
	const move = () => {
		if (!preferences || !conflict) return
		if (preferences.revision !== conflict.baseRevision) {
			setConflict(null)
			setError('Terminal settings changed elsewhere. Record the shortcut again.')
			return
		}
		try {
			saveBindings(
				moveShortcutCandidate(
					conflict.candidate,
					conflict.chord,
					conflict.from,
					conflict.to,
					conflict.replacementIndex,
					window.helm.platform,
				),
			)
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason))
		}
	}
	const resetAll = async () => {
		if (!preferences || working) return
		setWorking(true)
		setError(null)
		try {
			const next = await window.helm.terminalPreferences.resetShortcuts(preferences.revision)
			requestRevision.current++
			setPreferences(next)
			showToast({ message: 'Shortcuts restored' })
		} catch (reason) {
			const message = reason instanceof Error ? reason.message : String(reason)
			setError(
				message.includes('changed in another window')
					? 'Terminal settings changed elsewhere. Reloaded the latest settings.'
					: message,
			)
			void refresh()
		} finally {
			setWorking(false)
		}
	}

	return (
		<div className="page-frame">
			<PushHeader title="Terminal" onBack={onBack} />
			<div className="page-scroll">
				{preferences && error && (
					<Banner tone="error" label="Could not update terminal settings">
						{error}
					</Banner>
				)}
				{!preferences ? (
					<EmptyState
						title={error ? 'Terminal settings unavailable' : 'Loading terminal settings'}
						detail={error ?? 'Reading terminal preferences.'}
					/>
				) : (
					<>
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
								<button type="button" className="field-reset" disabled={working} onClick={useHomeFolder}>
									Use Home folder
								</button>
							)}
						</Card>
						<Card label="Option key">
							<div className="toggle-row">
								<div>
									<div className="toggle-label">Option acts as Meta</div>
									<p className="meta-text">
										On sends Meta word commands to the shell. Off keeps Option for accent and dead-key text input.
									</p>
								</div>
								<Toggle
									label="Option acts as Meta"
									value={preferences.optionAsMeta}
									disabled={working}
									onChange={value => void apply({ optionAsMeta: value })}
								/>
							</div>
						</Card>
						<Card
							label="Shortcuts"
							trailing={
								<Btn sm disabled={working} onClick={() => void resetAll()}>
									Reset all
								</Btn>
							}
						>
							<p className="meta-text">
								Use Command on Mac or Ctrl elsewhere. Removing every alias disables that action.
							</p>
							{recording && (
								<output className="shortcut-recording" aria-live="polite">
									Recording {definitionForShortcut(recording.action).label}. Press a shortcut, or Escape to cancel.
								</output>
							)}
							{conflict && (
								<Banner tone="warning" label="Shortcut already used">
									{shortcutDisplay(conflict.chord, window.helm.platform)} belongs to{' '}
									{definitionForShortcut(conflict.from).label}.{' '}
									<button type="button" className="field-reset" disabled={working} onClick={move}>
										Move shortcut
									</button>
								</Banner>
							)}
							<div className="shortcut-list">
								{(['menu', 'terminal-selection', 'terminal-input', 'run-context'] as const).map(scope => (
									<section className="shortcut-scope" aria-labelledby={`shortcut-scope-${scope}`} key={scope}>
										<h3 id={`shortcut-scope-${scope}`}>{SHORTCUT_SCOPE_LABELS[scope]}</h3>
										{SHORTCUTS.filter(definition => definition.scope === scope).map(definition => {
											const bindings = preferences.shortcuts[definition.action]
											return (
												<fieldset className="shortcut-row" aria-label={definition.label} key={definition.action}>
													<div className="shortcut-title">
														<strong>{definition.label}</strong>
														<span>
															{bindings.length === 0
																? 'Not set'
																: bindings.map(binding => shortcutDisplay(binding, window.helm.platform)).join(' · ')}
														</span>
													</div>
													<div className="shortcut-actions">
														{bindings.map((binding, index) => (
															<span className="shortcut-alias" key={`${definition.action}-${index}`}>
																<button
																	type="button"
																	aria-label={`Change ${shortcutDisplay(binding, window.helm.platform)} for ${definition.label}`}
																	disabled={working || recording !== null}
																	onClick={() => void record(definition.action, index)}
																>
																	{shortcutDisplay(binding, window.helm.platform)}
																</button>
																<button
																	type="button"
																	aria-label={`Remove ${shortcutDisplay(binding, window.helm.platform)} from ${definition.label}`}
																	disabled={working || recording !== null}
																	onClick={() => remove(definition.action, index)}
																>
																	×
																</button>
															</span>
														))}
														<Btn
															sm
															disabled={working || recording !== null}
															onClick={() => void record(definition.action, null)}
														>
															Add {definition.label}
														</Btn>
														<button
															type="button"
															className="field-reset"
															aria-label={`Reset ${definition.label} shortcut`}
															disabled={working || recording !== null}
															onClick={() => resetAction(definition.action)}
														>
															Reset
														</button>
													</div>
												</fieldset>
											)
										})}
									</section>
								))}
							</div>
						</Card>
					</>
				)}
			</div>
		</div>
	)
}
