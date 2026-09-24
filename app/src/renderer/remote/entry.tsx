import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import '../sidebar/sidebar.css'
import '../sidebar/detail-redesign.css'
import { Btn } from '../button.js'
import { RemoteWorkspace } from './RemoteWorkspace.js'
import { initializeRemotePwa } from './pwa.js'
import { RemoteAccessError, type RemoteTransport, createRemoteTransport, pairRemote } from './transport.js'

// Own the complete browser canvas, including iOS's exposed safe-area paint.
document.documentElement.classList.add('remote-page')
document.body.classList.add('remote-page')

function isDevelopmentFixture(): boolean {
	return window.location.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)
}
function takePairFragment(): string | null {
	const value = new URLSearchParams(window.location.hash.slice(1)).get('pair')
	if (value) history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
	return value
}

/** Explicit workbench dependency seam; production never reads mode/authority from browser flags. */
export interface RemoteEntryFixture {
	createTransport(): RemoteTransport
	pair: typeof pairRemote
	takeFragment(): string | null
}
export function RemoteEntry({ fixture }: { fixture?: RemoteEntryFixture } = {}) {
	const development = !fixture && isDevelopmentFixture()
	const makeTransport = fixture?.createTransport ?? createRemoteTransport
	const redeem = fixture?.pair ?? pairRemote
	const [token, setToken] = useState('')
	const [transport, setTransport] = useState<RemoteTransport | null>(null)
	const [checking, setChecking] = useState(!development)
	const [unavailable, setUnavailable] = useState(false)
	const [accessAttempt, setAccessAttempt] = useState(0)
	const [code, setCode] = useState('')
	const [pairCapability, setPairCapability] = useState(() =>
		development ? null : (fixture?.takeFragment ?? takePairFragment)(),
	)
	const [error, setError] = useState<string | null>(null)
	const [pairing, setPairing] = useState(false)
	const pairingRequest = useRef<AbortController | null>(null)
	const pairingInput = useRef<HTMLInputElement>(null)
	const pairingButton = useRef<HTMLButtonElement>(null)
	const restorePairingFocus = useRef(false)
	useEffect(() => {
		// Pair fragments are consumed during render, before any PWA or access request.
		if (!fixture) initializeRemotePwa()
	}, [fixture])
	// biome-ignore lint/correctness/useExhaustiveDependencies: an explicit retry starts one fresh GET in this mounted entry.
	useEffect(() => {
		if (development) return
		const controller = new AbortController()
		const current = makeTransport()
		void current.access(controller.signal).then(
			() => {
				if (controller.signal.aborted) return
				setTransport(current)
				setChecking(false)
			},
			value => {
				if (controller.signal.aborted) return
				setUnavailable(!(value instanceof RemoteAccessError && [401, 403].includes(value.status)))
				setChecking(false)
			},
		)
		return () => controller.abort()
	}, [development, makeTransport, accessAttempt])
	useEffect(
		() => () => {
			pairingRequest.current?.abort()
			pairingRequest.current = null
		},
		[],
	)
	useEffect(() => {
		if (pairing || !error || !restorePairingFocus.current) return
		restorePairingFocus.current = false
		const frame = requestAnimationFrame(() => {
			if (document.activeElement === document.body || document.activeElement === pairingButton.current)
				pairingInput.current?.focus()
		})
		return () => cancelAnimationFrame(frame)
	}, [error, pairing])
	function submitPairing() {
		if (pairing || pairingRequest.current) return
		const value = code.trim() ? { code: code.trim() } : { qrCapability: pairCapability ?? undefined }
		const controller = new AbortController()
		const restoreInput =
			document.activeElement === pairingInput.current ||
			document.activeElement === pairingButton.current ||
			document.activeElement === document.body
		pairingRequest.current = controller
		setPairing(true)
		void redeem(value, controller.signal)
			.then(
				() => {
					if (!controller.signal.aborted && pairingRequest.current === controller) setTransport(makeTransport())
				},
				value => {
					if (!controller.signal.aborted && pairingRequest.current === controller) {
						// A capability is single-use whether it succeeded or failed. Never let it shadow a fresh code.
						setPairCapability(null)
						setError(value instanceof RemoteAccessError ? 'pairing' : 'network')
						restorePairingFocus.current = restoreInput
					}
				},
			)
			.finally(() => {
				if (pairingRequest.current === controller) {
					pairingRequest.current = null
					setPairing(false)
				}
			})
	}
	if (transport)
		return (
			<RemoteWorkspace
				transport={transport}
				onReconnect={() => {
					pairingRequest.current?.abort()
					pairingRequest.current = null
					setPairing(false)
					setTransport(null)
					setPairCapability(null)
					setCode('')
					setError(null)
					setChecking(false)
				}}
			/>
		)
	if (development)
		return (
			<main className="remote-login">
				<h1>Helm Remote · development preview</h1>
				<p>
					Use the access token from this isolated host’s private browser-token file. It stays in memory in this tab.
				</p>
				<label>
					Access token
					<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
				</label>
				{error && <p role="alert">Enter the host’s 43-character token.</p>}
				<Btn
					tone="primary"
					onClick={() => {
						try {
							setTransport(createRemoteTransport(token.trim()))
							setToken('')
						} catch {
							setError('invalid')
						}
					}}
				>
					Connect
				</Btn>
				<p className="remote-note">
					No public tunnel or daemon API proxy. Existing Pi sessions need explicit local enrollment.
				</p>
			</main>
		)
	if (checking)
		return (
			<main className="remote-empty">
				<h1>Connecting to Helm Remote</h1>
				<p>Checking this device’s access.</p>
			</main>
		)
	if (unavailable)
		return (
			<main className="remote-login">
				<h1>Helm Remote unavailable</h1>
				<p>This device’s access could not be checked. Retry when the host is available.</p>
				<Btn
					tone="primary"
					onClick={() => {
						setUnavailable(false)
						setChecking(true)
						setAccessAttempt(value => value + 1)
					}}
				>
					Retry connection
				</Btn>
			</main>
		)
	return (
		<main className="remote-login">
			<h1>Pair this device</h1>
			<p>On your Mac, open Helm → Settings → Remote to create a pairing code.</p>
			<p>
				The code grants this browser access only to the personal Pi conversations the local operator selected, including
				future conversations when stated during pairing.
			</p>
			<form
				onSubmit={event => {
					event.preventDefault()
					submitPairing()
				}}
			>
				<label htmlFor="remote-pairing-code">One-time code</label>
				<input
					id="remote-pairing-code"
					ref={pairingInput}
					autoComplete="one-time-code"
					inputMode="text"
					maxLength={7}
					disabled={pairing}
					value={code}
					aria-invalid={error ? true : undefined}
					aria-describedby={
						[error ? 'remote-pairing-error' : null, pairCapability ? 'remote-pairing-qr-note' : null]
							.filter(Boolean)
							.join(' ') || undefined
					}
					onChange={event => {
						// A deliberate manual entry always supersedes a stale/consumed QR fragment.
						setPairCapability(null)
						setCode(event.target.value.toUpperCase())
						setError(null)
					}}
					placeholder="XXX-XXX"
				/>
				{pairCapability && (
					<p id="remote-pairing-qr-note" className="remote-note">
						A one-time QR pairing code is ready. Confirm pairing to use it.
					</p>
				)}
				{error && (
					<p id="remote-pairing-error" role="alert">
						Pairing expired or was unavailable. Ask the local operator for a new code.
					</p>
				)}
				<Btn type="submit" ref={pairingButton} tone="primary" disabled={pairing || (!code.trim() && !pairCapability)}>
					{pairing ? 'Pairing…' : 'Pair device'}
				</Btn>
			</form>
			<p className="remote-note">The code works once and expires. Access stays in this browser.</p>
		</main>
	)
}
const root = document.getElementById('remote-root')
if (root) createRoot(root).render(<RemoteEntry />)
