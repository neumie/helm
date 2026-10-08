import type { ReviewApi, ReviewResult, ReviewState } from '../../document-review/types'

/** Optional native amendment; legacy workbench services remain unchanged. */
export interface ArchiveReviewApi extends ReviewApi {
	discardArchive?: (failureId: string) => Promise<ReviewResult<boolean>>
}
export interface ArchiveReviewState extends ReviewState {
	archiveFailureId?: string | null
}
export interface ArchiveRecoveryTarget {
	id: string | null
	documentId: string
	revision: string
	api: ArchiveReviewApi
	generation: number
}
export function captureArchiveRecovery(
	state: ArchiveReviewState | null,
	api: ArchiveReviewApi,
	generation: number,
): ArchiveRecoveryTarget | null {
	if (!state?.archiveError) return null
	return {
		id: state.archiveFailureId ?? null,
		documentId: state.document.id,
		revision: state.document.revision,
		api,
		generation,
	}
}
export function currentArchiveRecovery(
	target: ArchiveRecoveryTarget,
	state: ArchiveReviewState | null,
	api: ArchiveReviewApi,
	generation: number,
): boolean {
	return (
		!!state?.archiveError &&
		target.api === api &&
		target.generation === generation &&
		target.documentId === state.document.id &&
		target.revision === state.document.revision &&
		target.id === (state.archiveFailureId ?? null)
	)
}
