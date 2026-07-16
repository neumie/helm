// Banners (§3.12): error/warning/info tones, the 4-line clamp with its More
// cue, the actionable restart notice, and ClampText for run summaries.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Banner, Btn, ClampText } from './ui'

const meta: Meta = {
	title: 'Sidebar/Banners',
	decorators: [story => <div style={{ width: 340, display: 'flex', flexDirection: 'column', gap: 12 }}>{story()}</div>],
}

export default meta
type Story = StoryObj

const LONG_ERROR = [
	'Solve failed in phase worktree: fatal: could not create work tree dir',
	"'/Users/dev/worktrees/helm-item-fix-login-4f2a': Permission denied.",
	'The daemon retried twice on a transient-failure backoff before giving up.',
	'Check that the worktree parent directory is writable by the daemon user,',
	'then use Queue retry to re-run this item in the same workspace. The full',
	'run log is available on the Run page.',
].join(' ')

export const ErrorTone: Story = {
	render: () => (
		<Banner tone="error" label="Run failed">
			The agent exited with code 1 before writing solver-result.json.
		</Banner>
	),
}

export const WarningTone: Story = {
	render: () => (
		<Banner tone="warning" label="Stale worktree">
			The recorded worktree path no longer exists; retry will recreate it.
		</Banner>
	),
}

export const InfoTone: Story = {
	render: () => (
		<Banner tone="info" label="Planning">
			The planning workspace is open. No runnable spec has been detected yet.
		</Banner>
	),
}

/** Body over 4 lines clamps; the whole block toggles via the More/Less cue. */
export const ErrorClamped: Story = {
	render: () => (
		<Banner tone="error" label="Run failed">
			{LONG_ERROR}
		</Banner>
	),
}

/** Settings' pending-restart notice: §3.12 info banner + one quiet action,
 *  stacked above the primary action in the pinned action bar (§3.11). */
export const ActionableNotice: Story = {
	render: () => (
		<div className="action-bar action-bar-stack">
			<output className="restart-notice">
				<span className="restart-notice-text">Saved. Restart the daemon to apply the new settings.</span>
				<Btn sm>Restart now</Btn>
			</output>
			<Btn tone="primary" block>
				Save changes
			</Btn>
		</div>
	),
}

export const ClampTextShort: Story = {
	render: () => <ClampText text="Shipped a one-line fix; PR opened against main." />,
}

export const ClampTextLong: Story = {
	render: () => (
		<ClampText
			text={
				'Renamed the legacy vigil references across the daemon and app, kept the compat fallbacks for pre-rename installs, and updated the launchd job identity. The plist migration unloads com.vigil.daemon before installing com.helm.daemon so a stale KeepAlive job cannot respawn the old binary. Added regression tests for the config fallback order and verified the extension still reaches the daemon on :7474.'
			}
		/>
	),
}
