import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemotePairingApi, RemotePairingPresentation, RemotePairingSnapshot } from '../../shared'
import { Banner, Btn, Card, EmptyState, FieldLabel, InfoRow, PushHeader, TextInput } from './ui'

const DEVICE_REFRESH_MS = 5_000

export interface RemoteSettingsServices {
	remotePairing: RemotePairingApi
	now?: () => number
}

/** Native, main-authorized device pairing. Pairing presentation is deliberately
 * component-local: leaving this pushed page removes its code and QR DOM. */
export function RemoteSettingsPage({
	onBack,
	active,
	services,
	initialPresentation = null,
}: {
	onBack: () => void
	active: boolean
	services?: RemoteSettingsServices
	/** Workbench-only fixture seam; production never persists a presentation. */
	initialPresentation?: RemotePairingPresentation | null
}) {
	// Resolve window.helm only when production actually renders. Storybook's
	// injected services therefore never require an Electron preload global.
	const pairingApi = services?.remotePairing ?? window.helm.remotePairing
	const [snapshot, setSnapshot] = useState<RemotePairingSnapshot | null>(null)
	const [label, setLabel] = useState('This device')
	const [presentation, setPresentation] = useState<RemotePairingPresentation | null>(initialPresentation)
	const [presentationExpired, setPresentationExpired] = useState(false)
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState<string | null>(null)
	const [failedRevocations, setFailedRevocations] = useState<Set<string>>(() => new Set())
	const pageRoot = useRef<HTMLDivElement>(null)
	const disclosureGeneration = useRef(0)
	const refreshInFlight = useRef(false)
	// React state does not synchronously disable a second same-turn click.
	const mutationInFlight = useRef(false)
	const pairAction = useRef<HTMLButtonElement>(null)
	const restoreActionFocus = useRef(false)
	const generation = useRef(0)
	const now = services?.now ?? Date.now

	const refresh = useCallback(async () => {
		if (!active || refreshInFlight.current) return
		const requestGeneration = generation.current
		refreshInFlight.current = true
		try {
			const next = await pairingApi.status()
			if (generation.current === requestGeneration && active) setSnapshot(next)
		} catch {
			if (generation.current === requestGeneration && active)
				setSnapshot({
					availability: 'unavailable',
					message: 'Helm Remote is unavailable. Retry when its local runtime is online.',
				})
		} finally {
			refreshInFlight.current = false
		}
	}, [active, pairingApi])

	useEffect(() => {
		generation.current++
		if (!active) {
			setPresentation(null)
			setPresentationExpired(false)
			setBusy(false)
			return
		}
		void refresh()
		const interval = window.setInterval(() => void refresh(), DEVICE_REFRESH_MS)
		return () => {
			generation.current++
			window.clearInterval(interval)
			setPresentation(null)
		}
	}, [active, refresh])

	useEffect(() => {
		if (!presentation) return
		const delay = presentation.expiresAt - now()
		if (delay <= 0) {
			setPresentation(null)
			setPresentationExpired(true)
			return
		}
		const timer = window.setTimeout(() => {
			setPresentation(null)
			setPresentationExpired(true)
		}, delay)
		return () => window.clearTimeout(timer)
	}, [presentation, now])

	useEffect(() => {
		if (busy || !active || !restoreActionFocus.current) return
		restoreActionFocus.current = false
		// Disabling the clicked action moves focus to body. Do not steal focus
		// if the operator deliberately moved to another control while waiting.
		if (document.activeElement === document.body) pairAction.current?.focus()
	}, [active, busy])

	const pair = useCallback(async () => {
		if (!active || mutationInFlight.current || busy || label.trim().length === 0 || label.length > 80) return
		mutationInFlight.current = true
		const requestGeneration = generation.current
		const requestDisclosure = disclosureGeneration.current
		setBusy(true)
		setMessage(null)
		setPresentationExpired(false)
		try {
			const result = await pairingApi.pair(label)
			if (generation.current !== requestGeneration || !active) return
			if (result.kind === 'created') {
				if (requestDisclosure === disclosureGeneration.current) setPresentation(result.presentation)
				void refresh()
			} else if (result.kind === 'error') setMessage(result.message ?? 'Helm Remote could not create a pairing code.')
		} catch {
			if (generation.current === requestGeneration && active)
				setMessage('Helm Remote could not create a pairing code. Retry when ready.')
		} finally {
			mutationInFlight.current = false
			if (generation.current === requestGeneration && active) {
				restoreActionFocus.current = true
				setBusy(false)
			}
		}
	}, [active, busy, label, pairingApi, refresh])

	const revoke = useCallback(
		async (deviceId: string) => {
			if (!active || mutationInFlight.current || busy) return
			mutationInFlight.current = true
			const requestGeneration = generation.current
			const rememberFailure = () => setFailedRevocations(current => new Set([...current, deviceId].slice(-128)))
			setBusy(true)
			setMessage(null)
			try {
				const result = await pairingApi.revoke(deviceId)
				if (generation.current !== requestGeneration || !active) return
				if (result.kind === 'not-found') {
					setMessage('This device is no longer listed. Reload devices before trying again.')
					void refresh()
				} else if (result.kind === 'error') {
					rememberFailure()
					setMessage(result.message ?? 'Helm Remote could not revoke this device.')
				} else if (result.kind === 'revoked') {
					// A GET's memory-only fence is not durable success. Only the
					// explicit successful mutation settles this failed operation.
					setFailedRevocations(current => {
						const next = new Set(current)
						next.delete(deviceId)
						return next
					})
					void refresh()
				}
			} catch {
				if (generation.current === requestGeneration && active) {
					rememberFailure()
					setMessage('Helm Remote could not revoke this device. Its access may still be active.')
				}
			} finally {
				mutationInFlight.current = false
				if (generation.current === requestGeneration && active) {
					restoreActionFocus.current = true
					setBusy(false)
				}
			}
		},
		[active, busy, pairingApi, refresh],
	)

	return (
		<div ref={pageRoot} className="page-frame remote-settings-page">
			<PushHeader title="Remote" onBack={onBack} />
			<div className="page-scroll">
				{message && (
					<Banner tone="error" label="Remote action failed">
						{message}
					</Banner>
				)}
				{snapshot?.availability === 'unavailable' ? (
					<div className="remote-unavailable">
						<EmptyState title="Helm Remote unavailable" detail={snapshot.message} />
						<Btn tone="primary" busy={busy} onClick={() => void refresh()}>
							Retry connection
						</Btn>
					</div>
				) : (
					<>
						<Card label="Remote">
							<InfoRow
								label="Public origin"
								value={snapshot?.availability === 'available' ? snapshot.origin : 'Checking'}
							/>
							<p className="section-description">
								Remote access is personal and applies to current and future Pi conversations. It is not scoped to this
								Helm profile.
							</p>
						</Card>
						<Card label="Pair device">
							<div className="remote-pair-field">
								<FieldLabel htmlFor="remote-device-name">Device name</FieldLabel>
								<TextInput
									id="remote-device-name"
									value={label}
									maxLength={80}
									autoComplete="off"
									placeholder="Phone"
									onChange={setLabel}
								/>
							</div>
							<Btn
								ref={pairAction}
								tone="primary"
								busy={busy}
								disabled={snapshot?.availability !== 'available' || label.trim().length === 0}
								onClick={() => void pair()}
							>
								{presentation ? 'New code' : 'Pair device'}
							</Btn>
							<p className="section-description">A native confirmation is required before a code is issued.</p>
							{presentation && (
								<PairingPresentation
									presentation={presentation}
									now={now}
									onHide={() => {
										disclosureGeneration.current++
										const target = pairAction.current?.disabled
											? pageRoot.current?.querySelector<HTMLElement>('[data-page-heading]')
											: pairAction.current
										target?.focus()
										setPresentation(null)
									}}
								/>
							)}
							{presentationExpired && (
								<Banner tone="warning" label="Pairing code expired">
									Create a new code to pair a device.
								</Banner>
							)}
						</Card>
						<Card label="Paired devices" flush>
							{snapshot === null ? (
								<p className="section-description">Checking paired devices.</p>
							) : snapshot.availability === 'available' && snapshot.devices.length > 0 ? (
								snapshot.devices.map(device => (
									<div className="remote-device-row" key={device.id}>
										<div>
											<div className="remote-device-title">{device.label}</div>
											<div className={`remote-device-state remote-device-${device.state}`}>
												{failedRevocations.has(device.id)
													? 'Revocation not confirmed — retry'
													: deviceStateLabel(device.state, device.expiresAt)}
											</div>
										</div>
										{(device.state !== 'expired' || failedRevocations.has(device.id)) && (
											<Btn
												tone={device.state === 'revoked' && !failedRevocations.has(device.id) ? 'quiet' : 'danger'}
												sm
												busy={busy}
												onClick={() => void revoke(device.id)}
											>
												{failedRevocations.has(device.id)
													? 'Retry revoke'
													: device.state === 'revoked'
														? 'Revoke again'
														: 'Revoke'}
											</Btn>
										)}
									</div>
								))
							) : (
								<p className="section-description">No devices are paired yet.</p>
							)}
						</Card>
					</>
				)}
			</div>
		</div>
	)
}

function PairingPresentation({
	presentation,
	now,
	onHide,
}: {
	presentation: RemotePairingPresentation
	now: () => number
	onHide: () => void
}) {
	const [remaining, setRemaining] = useState(() => Math.max(0, presentation.expiresAt - now()))
	useEffect(() => {
		const tick = () => setRemaining(Math.max(0, presentation.expiresAt - now()))
		tick()
		const interval = window.setInterval(tick, 1000)
		return () => window.clearInterval(interval)
	}, [now, presentation.expiresAt])
	if (remaining <= 0)
		return (
			<Banner tone="warning" label="Pairing code expired">
				Create a new code to pair a device.
			</Banner>
		)
	return (
		<div className="remote-presentation" aria-live="polite">
			<img className="remote-qr" src={presentation.qrDataUrl} alt="Pairing QR code" />
			<div className="remote-code" aria-label={`Pairing code ${presentation.code}`}>
				{presentation.code}
			</div>
			<p className="section-description">
				Expires in {Math.ceil(remaining / 1000)}s. Scan the code or enter it at the approved Remote origin.
			</p>
			<Btn tone="quiet" sm onClick={onHide}>
				Hide code
			</Btn>
		</div>
	)
}

function deviceStateLabel(state: 'active' | 'expired' | 'revoked', expiresAt: number): string {
	if (state === 'revoked') return 'Revoked — no active access'
	if (state === 'expired') return 'Expired — no active access'
	return `Active until ${new Date(expiresAt).toLocaleDateString()}`
}
