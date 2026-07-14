import type { DashboardAction, ItemStatus } from '../../shared-helm'

export interface LifecycleActionPlan {
	markDone: boolean
	primary: DashboardAction | null
	rest: DashboardAction[]
}

/** Review has one human workflow: accept the shipped work and clear Needs you. */
export function lifecycleActionPlan(status: ItemStatus, actions: readonly DashboardAction[]): LifecycleActionPlan {
	if (status === 'review') return { markDone: true, primary: null, rest: [...actions] }
	const primary =
		actions.find(action => action.tone === 'primary') ?? actions.find(action => action.tone === 'muted') ?? actions[0]
	return {
		markDone: false,
		primary: primary ?? null,
		rest: primary ? actions.filter(action => action !== primary) : [],
	}
}

export default { lifecycleActionPlan }
