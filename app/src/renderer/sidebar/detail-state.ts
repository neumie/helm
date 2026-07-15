import type { DashboardItem, DashboardTone } from '../../shared-helm'
import { planStatusDetail, planStatusLabel, statusTone } from './model'

export type DetailSection = 'intent' | 'queue' | 'progress' | 'outcome' | 'failure' | 'work' | 'delivery' | 'run-setup'
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

/** Presentation only: lifecycle permissions remain in `allowedActions`. */
export function detailState(item: DashboardItem): {
	headline: string | null
	direction: string | null
	chipTone: DashboardTone
	attention: Attention
	sections: DetailSection[]
} {
	const messy = item.runOutcome === 'errored' || item.runOutcome === 'no_result'
	const attention = attentionFor(item, messy)
	switch (item.status) {
		case 'inbox':
			return {
				headline: item.source ? 'Review the intent' : 'Ready to plan or start',
				direction: item.source ? 'Approve to queue this work, or reject it.' : 'Start runs this item now.',
				chipTone: chipTone(item),
				attention,
				sections: ['intent', 'work', 'run-setup'],
			}
		case 'ready':
			return {
				headline: null,
				direction: null,
				chipTone: chipTone(item),
				attention,
				sections: ['queue', 'run-setup', 'work'],
			}
		case 'active':
			return item.planStatus
				? {
						headline: planStatusLabel(item),
						direction: planStatusDetail(item),
						chipTone: chipTone(item),
						attention,
						sections: ['work', 'run-setup'],
					}
				: {
						headline: null,
						direction: null,
						chipTone: chipTone(item),
						attention,
						sections: ['work'],
					}
		case 'running':
			return {
				headline: 'Work is in progress',
				direction: 'Nothing needs you right now.',
				chipTone: chipTone(item),
				attention,
				sections: ['progress', 'work'],
			}
		case 'review':
			return {
				headline: null,
				direction: null,
				chipTone: chipTone(item),
				attention,
				sections: ['outcome', 'delivery', 'work'],
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
				sections: ['failure', 'outcome', 'run-setup', 'work'],
			}
		case 'done':
			return {
				headline: 'Work is complete',
				direction: 'Retry starts a new run and replaces the current run result.',
				chipTone: chipTone(item),
				attention,
				sections: ['outcome', 'delivery', 'work'],
			}
		case 'cancelled':
			return {
				headline: cancellationReason(item),
				direction: 'Retry queues a new run.',
				chipTone: chipTone(item),
				attention: null,
				sections: ['failure', 'work'],
			}
		default:
			throw new Error(`Unsupported item status: ${item.status}`)
	}
}

export default { detailState, cancellationReason }
