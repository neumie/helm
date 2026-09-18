import type { UsageProvider } from '../../../../src/remote/usage-protocol.js'
import { type RemoteUsageState, formatObservedAge, formatResetDistance } from './usage-controller.js'

function planLabel(plan: string | null): string | null {
	if (!plan) return null
	return plan.charAt(0).toUpperCase() + plan.slice(1)
}

function UsageProviderCard({ provider, now }: { provider: UsageProvider; now: number }) {
	const plan = planLabel(provider.plan)
	const age = provider.source === 'local' ? formatObservedAge(provider.observedAt, now) : null
	return (
		<article className="remote-usage-provider">
			<h3 className="remote-usage-name">
				{provider.name}
				{plan && <span className="remote-usage-plan">{plan}</span>}
			</h3>
			{provider.windows.map(window => {
				const used = Math.round(window.usedPercent)
				const reset = formatResetDistance(window.resetsAt, now)
				return (
					<div className="remote-usage-window" key={window.label}>
						<p className="remote-usage-window-head">
							<span>{window.label}</span>
							<span className="remote-usage-percent">{used}%</span>
						</p>
						<div
							className="remote-usage-bar"
							role="img"
							aria-label={`${window.label}: ${used}% used${reset ? `, resets ${reset}` : ''}`}
						>
							<div className="remote-usage-fill" style={{ width: `${used}%` }} />
							{window.elapsedPercent !== null && (
								/* Where the window itself has got to, so spend can be read against pace. */
								<div className="remote-usage-pace" style={{ left: `${Math.round(window.elapsedPercent)}%` }} />
							)}
						</div>
						{reset && <p className="remote-usage-reset">Resets {reset}</p>}
					</div>
				)
			})}
			{provider.message && <p className="remote-note">{provider.message}</p>}
			{age && <p className="remote-note">From this Mac’s last Codex record · {age}</p>}
		</article>
	)
}

export function RemoteUsagePanel({ state, now }: { state: RemoteUsageState; now: number }) {
	return (
		<section className="remote-usage" aria-label="Usage">
			<h2 className="remote-section-heading">Usage</h2>
			{!state.supported && <p className="remote-note">This host does not report provider usage.</p>}
			{state.supported && state.loading && !state.response && <p className="remote-note">Reading limits…</p>}
			{state.error && (
				<p className="remote-note">
					<output>{state.error}</output>
				</p>
			)}
			{state.response?.providers.map(provider => (
				<UsageProviderCard key={provider.id} provider={provider} now={now} />
			))}
			{state.supported && state.response?.providers.length === 0 && (
				<p className="remote-note">No provider limits are available on this Mac.</p>
			)}
		</section>
	)
}
