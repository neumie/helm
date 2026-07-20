import type { DashboardItem, DashboardTone } from '../../shared-helm'
import { planStatusDetail, planStatusLabel, statusTone } from './model'

export type DetailSection =
	| 'intent'
	| 'queue'
	| 'activity'
	| 'outcome'
	| 'failure'
	| 'log'
	| 'input'
	| 'setup'
	| 'plan'
	| 'source'
	| 'delivery'

/** One entry in the detail page's flat editorial stack. `open` is the
 *  disclosure's MOUNT-TIME default only (§3.20): it is never re-applied on a
 *  status flip, so a mid-read status change cannot collapse a section the
 *  user opened (or pop one open under their pointer). */
export interface DetailSectionEntry {
	kind: DetailSection
	open?: boolean
}

export type Attention = { tone: 'error' | 'warning' | 'info'; label: string; text: string } | null

function chipTone(item: DashboardItem): DashboardTone {
	switch (statusTone(item.status)) {
		case 'accent':
			return 'blue'
		case 'success':
			return 'green'
		case 'warn':
			return 'amber'
		case 'danger':
			return 'red'
		default:
			return 'gray'
	}
}

export function cancellationReason(item: DashboardItem): string {
	const event = item.runObservation.events.find(
		event => event.type === 'item_rejected' || event.type === 'item_cancelled',
	)
	if (event?.type === 'item_rejected') return 'Intent was rejected'
	return 'Work was stopped'
}

function attentionFor(item: DashboardItem, messy: boolean): Attention {
	if (item.status === 'failed' && item.errorMessage) {
		return {
			tone: 'error',
			label: item.errorPhase ? `Failed — ${item.errorPhase}` : 'Failed',
			text: item.errorMessage,
		}
	}
	if (item.status === 'review' && messy) {
		return {
			tone: 'warning',
			label: 'Verify before marking done',
			text: 'The run did not finish cleanly, but work may be on the branch or pull request.',
		}
	}
	if (item.assessment?.verdict === 'security' && item.assessment.securityNote) {
		return { tone: 'warning', label: 'Security review', text: item.assessment.securityNote }
	}
	return null
}

const sections = (...kinds: Array<DetailSection | DetailSectionEntry>): DetailSectionEntry[] =>
	kinds.map(kind => (typeof kind === 'string' ? { kind } : kind))

/** Presentation only: lifecycle permissions remain in `allowedActions`.
 *  Sections order the one flat stack per state (decision content first); each
 *  section component self-gates on its data and renders null when empty. */
export function detailState(item: DashboardItem): {
	headline: string | null
	direction: string | null
	chipTone: DashboardTone
	attention: Attention
	sections: DetailSectionEntry[]
} {
	const messy = item.runOutcome === 'errored' || item.runOutcome === 'no_result'
	const attention = attentionFor(item, messy)
	switch (item.status) {
		case 'inbox':
			// Run-evidence sections trail every pre-run state: they self-gate to
			// nothing on a pristine item, but an item moved BACK here after a run
			// (manual status, Return to Queue) must not lose its history.
			return {
				headline: item.source ? 'Review the intent' : 'Ready to plan or start',
				direction: item.source ? 'Approve to queue this work, or reject it.' : 'Start runs this item now.',
				chipTone: chipTone(item),
				attention,
				sections: sections('intent', 'source', 'setup', 'plan', 'activity', 'log', 'input'),
			}
		case 'ready':
			return {
				headline: 'Waiting in queue',
				direction: 'Start the agent now, or work it manually.',
				chipTone: chipTone(item),
				attention,
				sections: sections('queue', 'setup', 'plan', 'source', 'activity', 'log', 'input'),
			}
		case 'active':
			return item.planStatus
				? {
						headline: planStatusLabel(item),
						direction: planStatusDetail(item),
						chipTone: chipTone(item),
						attention,
						sections: sections('plan', 'setup', 'source', 'activity', 'log', 'input'),
					}
				: {
						headline: "You're working on this",
						direction: 'Set it as done when you finish, or return it to the queue.',
						chipTone: chipTone(item),
						attention,
						sections: sections('plan', 'source', 'activity', 'log', 'input'),
					}
		case 'running':
			return {
				headline: 'Work is in progress',
				direction: 'Nothing needs you right now.',
				chipTone: chipTone(item),
				attention,
				sections: sections('activity', 'log', 'input', 'plan', 'source'),
			}
		case 'review':
			return {
				headline: 'Ready for your review',
				direction: 'Check the work, then set it as done.',
				chipTone: chipTone(item),
				attention,
				sections: sections('outcome', 'delivery', 'activity', 'log', 'input', 'plan', 'source'),
			}
		case 'failed':
			return {
				headline: 'Choose how to recover',
				direction:
					item.kind === 'solve'
						? 'Retry starts a new run. Move usable work to review without rerunning.'
						: 'Retry starts a new loop run.',
				chipTone: chipTone(item),
				attention,
				// The log is the diagnostic — open, directly beneath the failure text.
				sections: sections(
					'failure',
					{ kind: 'log', open: true },
					'activity',
					'outcome',
					'setup',
					'input',
					'plan',
					'source',
				),
			}
		case 'done':
			return {
				headline: 'Work is complete',
				direction: 'Retry starts a new run and replaces the current run result.',
				chipTone: chipTone(item),
				attention,
				sections: sections('outcome', 'delivery', 'activity', 'log', 'input', 'plan', 'source'),
			}
		case 'cancelled':
			// Outcome/input stay reachable: a cancelled run may hold a partial
			// result, a branch, and the solve input worth reviewing before retry.
			return {
				headline: cancellationReason(item),
				direction: 'Retry queues a new run.',
				chipTone: chipTone(item),
				attention: null,
				sections: sections('failure', 'outcome', 'activity', 'log', 'input', 'plan', 'source'),
			}
		default:
			throw new Error(`Unsupported item status: ${item.status}`)
	}
}

export default { detailState, cancellationReason }
