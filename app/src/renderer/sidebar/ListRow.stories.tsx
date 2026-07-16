// List rows (§3.3): 64px row — title flush on the text grid + trailing time;
// meta line = status word where the tab mixes statuses (pulsing mini-dot on
// Running) + project tag + one signal (verdict chip, work mode, or planning
// readiness). ListPage's ItemRow is module-private and rides the bridge, so
// this story mirrors its exact markup/class names with typed fixtures (§7:
// Electron-coupled data comes from mock fixtures, never a live daemon).
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { AssessmentVerdict, ItemStatus, WorkMode } from '../../shared-helm'
import { VERDICT_META, statusWord } from './model'
import { Chip, GLYPH, IconBtn, ProjectColorText, StatusDot } from './ui'

const meta: Meta = {
	title: 'Sidebar/List row',
	decorators: [
		story => (
			<div className="list-scroll" style={{ width: 340, overflow: 'visible' }}>
				{story()}
			</div>
		),
	],
}

export default meta
type Story = StoryObj

/** Typed row fixture — the slice of DashboardItem the row actually renders. */
interface RowFixture {
	title: string
	time: string
	status: ItemStatus
	projectSlug: string
	projectColor: string | null
	workMode?: WorkMode
	verdict?: AssessmentVerdict
	planningLabel?: string
	quickActions?: boolean
}

/** Presentational mirror of ListPage's ItemRow — same classes, same slots. */
function StoryItemRow(fixture: RowFixture) {
	const verdictMeta = fixture.verdict ? VERDICT_META[fixture.verdict] : null
	const word = statusWord(fixture.status)
	return (
		<div className={`item-row-shell${fixture.quickActions ? ' item-row-shell-actions' : ''}`}>
			<button type="button" className="item-row">
				<div className="item-row-line1">
					<span className="item-row-title">{fixture.title}</span>
					<span className="item-row-time">{fixture.time}</span>
				</div>
				<div className="item-row-line2">
					{word ? (
						<span className={`item-row-status tone-${word.tone}`}>
							{fixture.status === 'running' && <StatusDot tone="accent" pulse />}
							{word.label}
						</span>
					) : null}
					<ProjectColorText color={fixture.projectColor} className="item-row-project">
						{fixture.projectSlug}
					</ProjectColorText>
					{fixture.planningLabel ? (
						<span className="item-row-mode mode-manual" title="Planning readiness">
							{GLYPH.plan}
							{fixture.planningLabel}
						</span>
					) : fixture.workMode ? (
						<span className={`item-row-mode mode-${fixture.workMode}`}>
							{GLYPH[fixture.workMode]}
							{fixture.workMode === 'agent' ? 'Agent' : 'Manual'}
						</span>
					) : verdictMeta ? (
						<Chip tone={verdictMeta.tone} title={`Intent verdict: ${verdictMeta.label}`}>
							{verdictMeta.label}
						</Chip>
					) : null}
				</div>
			</button>
			{fixture.quickActions ? (
				<div className="item-row-actions" aria-label="Choose work owner">
					<IconBtn label="Work manually">{GLYPH.manual}</IconBtn>
					<IconBtn label="Start agent">{GLYPH.agent}</IconBtn>
				</div>
			) : null}
		</div>
	)
}

const CLIENTCARE_GREEN = '#4ec98a'
const HELM_BLUE = '#4c9aff'

export const Resting: Story = {
	render: () => (
		<StoryItemRow
			title="Fix the flaky login test"
			time="4m"
			status="inbox"
			projectSlug="clientcare"
			projectColor={CLIENTCARE_GREEN}
			verdict="clear"
		/>
	),
}

/** Status-word rows (§3.3): words where a tab mixes statuses — Needs shows
 *  Review/Failed, Archive shows Done/Cancelled, Running carries the one
 *  remaining (6px, pulsing) dot. */
export const StatusWords: Story = {
	render: () => (
		<>
			<StoryItemRow
				title="Agent shipping a fix right now"
				time="2m"
				status="running"
				projectSlug="clientcare"
				projectColor={CLIENTCARE_GREEN}
			/>
			<StoryItemRow
				title="Ready for your review"
				time="1h"
				status="review"
				projectSlug="helm"
				projectColor={HELM_BLUE}
			/>
			<StoryItemRow
				title="Run failed in worktree phase"
				time="3h"
				status="failed"
				projectSlug="clientcare"
				projectColor={CLIENTCARE_GREEN}
			/>
			<StoryItemRow
				title="Merged and deployed"
				time="Jul 12"
				status="done"
				projectSlug="helm"
				projectColor={HELM_BLUE}
			/>
			<StoryItemRow
				title="Rejected duplicate request"
				time="Jul 10"
				status="cancelled"
				projectSlug="helm"
				projectColor={HELM_BLUE}
			/>
		</>
	),
}

/** Meta-line variants: verdict chip, agent/manual work mode, planning
 *  readiness, and a bare project tag (no signal yet). */
export const MetaLineVariants: Story = {
	render: () => (
		<>
			<StoryItemRow
				title="Fix the flaky login test"
				time="4m"
				status="inbox"
				projectSlug="clientcare"
				projectColor={CLIENTCARE_GREEN}
				verdict="needs_clarification"
			/>
			<StoryItemRow
				title="Rename vigil references in the CLI"
				time="18m"
				status="running"
				projectSlug="helm"
				projectColor={HELM_BLUE}
			/>
			<StoryItemRow
				title="Draft the Q3 release notes"
				time="2h"
				status="active"
				projectSlug="helm"
				projectColor={HELM_BLUE}
				workMode="manual"
			/>
			<StoryItemRow
				title="Overhaul the deploy pipeline"
				time="Jul 12"
				status="active"
				projectSlug="helm"
				projectColor={HELM_BLUE}
				planningLabel="2 of 5 tickets complete"
			/>
			<StoryItemRow
				title="Recently ingested email task"
				time="now"
				status="inbox"
				projectSlug="clientcare"
				projectColor={CLIENTCARE_GREEN}
			/>
		</>
	),
}

/** One row per verdict — the full VERDICT_META set on the meta line. */
export const VerdictRows: Story = {
	render: () => (
		<>
			{(Object.keys(VERDICT_META) as AssessmentVerdict[]).map(verdict => (
				<StoryItemRow
					key={verdict}
					title={`Task assessed as ${VERDICT_META[verdict].label}`}
					time="12m"
					status="inbox"
					projectSlug="clientcare"
					projectColor={CLIENTCARE_GREEN}
					verdict={verdict}
				/>
			))}
		</>
	),
}

/** Ready + ownership-undecided rows keep permanent manual/agent icon actions. */
export const QuickActions: Story = {
	render: () => (
		<StoryItemRow
			title="Add retry backoff to the enricher"
			time="30m"
			status="ready"
			projectSlug="helm"
			projectColor={HELM_BLUE}
			quickActions
		/>
	),
}

export const LongTitleEllipsis: Story = {
	render: () => (
		<StoryItemRow
			title="Investigate why the deploy watcher misses merge events when the PR was opened from a fork and the branch was renamed mid-run"
			time="1h"
			status="review"
			projectSlug="clientcare"
			projectColor={CLIENTCARE_GREEN}
			verdict="human_decision"
		/>
	),
}

/** Unconfigured project: slug stays --text-2 (no 55/45 color mix). */
export const UnconfiguredProject: Story = {
	render: () => (
		<StoryItemRow
			title="Task from a project without a color"
			time="3h"
			status="inbox"
			projectSlug="scratch"
			projectColor={null}
		/>
	),
}

/** Client-side project grouping: group head (slug + count) above its rows. */
export const ProjectGroups: Story = {
	render: () => (
		<>
			<section className="item-project-group">
				<div className="item-project-group-head">
					<ProjectColorText color={CLIENTCARE_GREEN}>clientcare</ProjectColorText>
					<span>2 items</span>
				</div>
				<StoryItemRow
					title="Fix the flaky login test"
					time="4m"
					status="inbox"
					projectSlug="clientcare"
					projectColor={CLIENTCARE_GREEN}
					verdict="clear"
				/>
				<StoryItemRow
					title="Update the invoice export"
					time="1h"
					status="review"
					projectSlug="clientcare"
					projectColor={CLIENTCARE_GREEN}
				/>
			</section>
			<section className="item-project-group">
				<div className="item-project-group-head">
					<ProjectColorText color={HELM_BLUE}>helm</ProjectColorText>
					<span>1 item</span>
				</div>
				<StoryItemRow
					title="Rename vigil references in the CLI"
					time="18m"
					status="running"
					projectSlug="helm"
					projectColor={HELM_BLUE}
				/>
			</section>
		</>
	),
}
