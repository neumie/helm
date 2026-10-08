import type { ReviewAnnotation, ReviewDraft } from '../../document-review/types'
import { createReviewFixture } from './fixtures'

/** Display-only injection of native-projected journal/private state; not filesystem certification. */
export function createLegacyProjectionFixture() {
	const base = createReviewFixture('comments')
	const listeners = new Set<() => void>()
	const savedDrafts: ReviewDraft[] = []
	const load = base.api.load
	const save = base.api.save
	let projection: ReviewAnnotation[] | null = null
	let journal = false
	let loads = 0
	const api = {
		...base.api,
		load: async () => {
			loads++
			const result = await load()
			if (result.data) {
				if (projection) result.data.draft.annotations = structuredClone(projection)
				result.data.document.archive = {
					version: 1,
					revision: journal ? 'b'.repeat(64) : result.data.document.revision,
					annotations: journal ? structuredClone(result.data.draft.annotations) : [],
					threads: [],
				}
			}
			return result
		},
		save: async (draft: Parameters<typeof save>[0]) => {
			savedDrafts.push(structuredClone(draft))
			return save(draft)
		},
		onChanged: (listener: () => void) => {
			listeners.add(listener)
			const off = base.api.onChanged(listener)
			return () => {
				listeners.delete(listener)
				off()
			}
		},
	}
	return {
		...base,
		api,
		savedDrafts,
		loads: () => loads,
		changed: () => {
			for (const listener of listeners) listener()
		},
		project: (annotations: ReviewAnnotation[], present: boolean) => {
			projection = structuredClone(annotations)
			journal = present
			for (const listener of listeners) listener()
		},
	}
}
