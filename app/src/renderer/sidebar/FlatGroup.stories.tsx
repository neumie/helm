// Flat groups (§3.15): rule + section header + rows — no box, fill, radius,
// or shadow. Fact rows (28px), copy/external rows (28px), push/nav rows (36px
// with soft inset separators). The first group on a page omits its rule.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ActionRow, Btn, Card, Disclosure, InfoRow } from './ui'

const meta: Meta = {
	title: 'Sidebar/Flat group',
	decorators: [
		story => (
			<div className="page-scroll" style={{ width: 340, overflow: 'visible' }}>
				{story()}
			</div>
		),
	],
}

export default meta
type Story = StoryObj

const noop = () => {}

/** Two stacked groups: the first omits its leading rule (the page header above
 *  provides the edge); the second carries the full-width hairline rule. */
export const Groups: Story = {
	render: () => (
		<>
			<Card label="Outcome">
				<div className="section-description">Shipped a fix for the flaky login test and opened a PR.</div>
			</Card>
			<Card label="Delivery" flush>
				<InfoRow label="Branch" value="fix/flaky-login-test" mono />
				<InfoRow label="Base" value="origin/main" mono />
				<InfoRow label="Attempts" value="2" />
			</Card>
		</>
	),
}

export const FactRows: Story = {
	render: () => (
		<Card label="Details" flush>
			<InfoRow label="Project" value="clientcare" />
			<InfoRow label="Created" value="Jul 14" />
			<InfoRow label="Branch" value="helm/item/fix-login-4f2a" mono />
			<InfoRow label="Run outcome" value="ok" />
		</Card>
	),
}

/** Copy and external rows share the 28px fact pitch; only external links read
 *  as links (accent). Push rows (chevron) sit at the 36px nav pitch. */
export const ActionRows: Story = {
	render: () => (
		<Card label="Links" flush>
			<ActionRow label="Branch" value="fix/flaky-login-test" glyphKind="copy" mono onClick={noop} />
			<ActionRow label="PR" value="github.com/neumie/helm/pull/42" glyphKind="external" onClick={noop} />
			<ActionRow label="Source" value="ClientCare #1043" glyphKind="external" onClick={noop} />
			<ActionRow label="Task" value="View" onClick={noop} />
			<ActionRow label="Disabled" value="Unavailable" glyphKind="copy" onClick={noop} disabled />
		</Card>
	),
}

/** Nav rows (§3.15): the title IS the content, value is the current-state
 *  summary; consecutive rows divide with the soft inset separator. */
export const NavRows: Story = {
	render: () => (
		<Card label="Settings" flush>
			<ActionRow nav label="Projects" value="3 configured" onClick={noop} />
			<ActionRow nav label="Solver" value="claude" onClick={noop} />
			<ActionRow nav label="Provider" value="contember" onClick={noop} />
			<ActionRow nav label="Appearance" value="Helm" onClick={noop} />
		</Card>
	),
}

export const HeaderWithTrailing: Story = {
	render: () => (
		<Card
			label="Plan"
			trailing={
				<Btn tone="ghost" sm>
					Open in Okena
				</Btn>
			}
			flush
		>
			<InfoRow label="Spec" value="prd.md" mono />
			<InfoRow label="Tickets" value="2 of 5 complete" />
		</Card>
	),
}

/** Inline run evidence on Item detail (§3.15/§3.20): Activity facts + the
 *  latest-first timeline, the log's two-message newest-first preview, and Run
 *  setup's summary-at-rest above its own disclosure. */
export const EvidenceGroups: Story = {
	render: () => (
		<>
			<Card label="Activity">
				<InfoRow label="Started" value="14m" />
				<ol className="activity-list">
					{[
						['Solver result recorded', '2m'],
						['Pull request opened', '4m'],
						['Branch pushed', '5m'],
					].map(([label, time]) => (
						<li key={label} className="activity-item">
							<span>{label}</span>
							<time className="activity-time">{time}</time>
						</li>
					))}
				</ol>
				<button type="button" className="detail-disclosure" aria-expanded={false}>
					Show all
				</button>
			</Card>
			<Card label="Log">
				<section className="log-well">{'[12:05:19] solver-result.json written\n[12:04:40] tests: 12 passed'}</section>
				<button type="button" className="detail-disclosure" aria-expanded={false}>
					Show all
				</button>
			</Card>
			<Card label="Run setup">
				<p className="run-setup-summary">Claude Code · claude-sonnet-5 · High effort · Worktree</p>
				<Disclosure label="Change setup" hideLabel="Hide setup">
					<p className="section-description">Agent, model, effort, and workspace pickers render here.</p>
				</Disclosure>
			</Card>
		</>
	),
}
