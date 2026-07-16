// Chips (§3.4) + status dots (§3.5). Chip text is sentence case, text-only;
// the verdict set comes from the one verdict→label/tone mapping (VERDICT_META).
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { AssessmentVerdict, DashboardTone, ItemStatus } from '../../shared-helm'
import { ITEM_STATUSES } from '../../shared-helm'
import type { StatusTone } from './model'
import { VERDICT_META, statusTone } from './model'
import { Chip, GLYPH, StatusDot } from './ui'

const meta: Meta = {
	title: 'Sidebar/Chips & Dots',
}

export default meta
type Story = StoryObj

const CHIP_TONES: Array<{ tone: DashboardTone; label: string }> = [
	{ tone: 'gray', label: 'Cancelled' },
	{ tone: 'blue', label: 'Running' },
	{ tone: 'green', label: 'Done' },
	{ tone: 'amber', label: 'Review' },
	{ tone: 'red', label: 'Failed' },
]

export const ChipTones: Story = {
	render: () => (
		<div className="chip-row">
			{CHIP_TONES.map(({ tone, label }) => (
				<Chip key={tone} tone={tone}>
					{label}
				</Chip>
			))}
		</div>
	),
}

const VERDICTS = Object.keys(VERDICT_META) as AssessmentVerdict[]

export const VerdictChips: Story = {
	render: () => (
		<div className="chip-row">
			{VERDICTS.map(verdict => {
				const verdictMeta = VERDICT_META[verdict]
				return (
					<Chip key={verdict} tone={verdictMeta.tone} title={`Intent verdict: ${verdictMeta.label}`}>
						{verdictMeta.label}
					</Chip>
				)
			})}
		</div>
	),
}

/** The status chip as the detail page's status menu trigger — the chevron is
 *  the one sanctioned non-text chip content (§3.4). */
export const StatusMenuTrigger: Story = {
	render: () => (
		<div className="chip-row">
			<button type="button" className="status-menu-trigger" aria-haspopup="menu">
				<Chip tone="amber">Review {GLYPH.chevronDown}</Chip>
			</button>
			<button type="button" className="status-menu-trigger" disabled>
				<Chip tone="blue">Running</Chip>
			</button>
		</div>
	),
}

const DOT_TONES: StatusTone[] = ['neutral', 'accent', 'success', 'warn', 'danger']

export const StatusDots: Story = {
	render: () => (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			{DOT_TONES.map(tone => (
				<span key={tone} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<StatusDot tone={tone} />
					<span className="meta-text">{tone}</span>
				</span>
			))}
			<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<StatusDot tone="accent" pulse />
				<span className="meta-text">accent + pulse (running)</span>
			</span>
		</div>
	),
}

/** The fixed status→tone mapping (§2.1) applied to every ItemStatus. */
export const StatusToneMapping: Story = {
	render: () => (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			{ITEM_STATUSES.map((status: ItemStatus) => (
				<span key={status} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<StatusDot tone={statusTone(status)} pulse={status === 'running'} />
					<span className="meta-text">{status}</span>
				</span>
			))}
		</div>
	),
}
