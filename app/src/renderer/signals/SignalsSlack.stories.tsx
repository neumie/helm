// Views / Signals / Slack (§3.25). The Slack source in the production Signals column, and the three
// reply-flow layouts for Jakub to pick (A heads only — shipped; B a short excerpt; C the live thread
// with author and time). Only variant A is wired to production; B and C are presentational previews.

import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Slack',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'slack' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** Slack DMs, a group DM, an @mention and a followed thread in Needs you, plus a filtered bot message. */
export const Column: Story = {}

/** `r` on the DM from Klára: reply posted to Slack, the thread closes. Variant A (heads only, shipped). */
export const ReplyVariantA: Story = { args: { flow: 'slack-reply' } }

// ---- Reply-flow layout variants (presentational; pick one) ----

const EXCERPT: { who: string; at: string; text: string; me?: boolean }[] = [
	{ who: 'Klára D.', at: '14:02', text: 'Ahoj, můžeš se kouknout na fakturaci u Psyonu dnes?' },
	{ who: 'Klára D.', at: '14:03', text: 'Klient se ptá, jestli to stihneme do konce týdne.' },
]

function ReplyShell({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="signals"
			style={{ width: 360, height: 520, display: 'flex', flexDirection: 'column', background: 'var(--pane)' }}
		>
			<div className="signals-flow-keys" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
				<header className="signals-title">
					<span className="signals-title-text">
						<span className="signals-title-kind">
							<span className="signals-glyph" data-kind="flow" aria-hidden="true">
								↩
							</span>
							Reply to Klára D.
						</span>
						<span className="signals-title-context">Můžeš se kouknout na fakturaci u Psyonu dnes?</span>
					</span>
					<button type="button" className="signals-title-btn">
						esc
					</button>
				</header>
				{children}
				<footer className="signals-foot">
					<span className="signals-foot-hints" aria-hidden="true">
						⌘↵ send · esc back
					</span>
					<output className="signals-note">Posts to Klára D. on Slack and closes the thread</output>
				</footer>
			</div>
		</div>
	)
}

function Answer() {
	return (
		<label className="signals-prompt">
			<span className="signals-field-label">Reply</span>
			<textarea
				className="signals-prompt-input signals-answer-input"
				defaultValue="Kouknu se na to odpoledne a dám vědět."
			/>
		</label>
	)
}

/** B: the latest few messages as a plain excerpt above the answer field. */
export const ReplyVariantB: StoryObj = {
	render: () => (
		<ReplyShell>
			<div className="signals-scroll signals-flow">
				<div className="signals-slack-excerpt">
					{EXCERPT.map(m => (
						<p key={m.at} className="signals-slack-line">
							<span className="signals-slack-who">{m.who}</span> <span className="signals-slack-at">{m.at}</span>
							<br />
							{m.text}
						</p>
					))}
				</div>
				<Answer />
			</div>
		</ReplyShell>
	),
}

/** C: the thread read live, each message with author and time (what `helm slack read` would show). */
export const ReplyVariantC: StoryObj = {
	render: () => (
		<ReplyShell>
			<div className="signals-scroll signals-flow">
				<div className="signals-slack-thread">
					{[...EXCERPT, { who: 'Jakub', at: '14:10', text: '(píšeš…)', me: true }].map(m => (
						<div key={m.at} className={`signals-slack-msg${m.me ? ' is-me' : ''}`}>
							<div className="signals-slack-meta">
								<span className="signals-slack-who">{m.who}</span>
								<span className="signals-slack-at">{m.at}</span>
							</div>
							<div className="signals-slack-text">{m.text}</div>
						</div>
					))}
				</div>
				<Answer />
			</div>
		</ReplyShell>
	),
}
