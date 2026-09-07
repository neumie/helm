import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import '../sidebar/sidebar.css'
import '../sidebar/detail-redesign.css'
import { Btn } from '../button.js'
import { RemoteWorkspace } from './RemoteWorkspace.js'
import { type RemoteTransport, createRemoteTransport } from './transport.js'

function RemoteEntry() {
	const [token, setToken] = useState('')
	const [transport, setTransport] = useState<RemoteTransport | null>(null)
	const [invalid, setInvalid] = useState(false)
	if (transport) return <RemoteWorkspace transport={transport} onReconnect={() => setTransport(null)} />
	return (
		<main className="remote-login">
			<h1>Helm Remote · development preview</h1>
			<p>Use the access token from this isolated host’s private browser-token file. It stays in memory in this tab.</p>
			<label>
				Access token
				<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
			</label>
			{invalid && <p role="alert">Enter the host’s 43-character token.</p>}
			<Btn
				tone="primary"
				onClick={() => {
					try {
						setTransport(createRemoteTransport(token.trim()))
						setToken('')
					} catch {
						setInvalid(true)
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
}
const root = document.getElementById('remote-root')
if (root) createRoot(root).render(<RemoteEntry />)
