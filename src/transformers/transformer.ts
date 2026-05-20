import type { TaskContext } from '../providers/provider.js'
import { defaultTransformer } from './default.js'

export interface TransformerContext {
	/**
	 * Human-readable, chronologically-sortable folder name under
	 * `<worktree>/docs/plans/` (e.g. `2026-05-20-add-user-avatar`).
	 * Stable per task; computed once via `computePlanDirName` and
	 * persisted on the task row.
	 */
	planDirName: string
	worktreePath: string
}

export type TaskTransformer = (task: TaskContext, ctx: TransformerContext) => string

const transformers: Record<string, TaskTransformer> = {
	default: defaultTransformer,
}

export function getTransformer(name: string): TaskTransformer {
	const transformer = transformers[name]
	if (!transformer) {
		throw new Error(`Unknown transformer: "${name}". Available: ${Object.keys(transformers).join(', ')}`)
	}
	return transformer
}
