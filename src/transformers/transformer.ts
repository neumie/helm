import type { TaskContext } from '../providers/provider.js'
import { defaultTransformer } from './default.js'

export interface TransformerContext {
	externalId: string
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
