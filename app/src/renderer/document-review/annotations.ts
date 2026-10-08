import type { ReviewAnnotation, ReviewDraft } from '../../document-review/types'

export function captureAnnotationSave(draft: ReviewDraft, revision: string | null): ReviewDraft {
	return structuredClone(annotationSaveDraft(draft, { value: revision }))
}

/** Native immutable state operations. IDs and source locators are never regenerated. */
export function removeReviewAnnotation(values: ReviewAnnotation[], id: string): ReviewAnnotation[] {
	return values.filter(value => value.id !== id)
}
export function updateReviewAnnotation(
	values: ReviewAnnotation[],
	id: string,
	update: (value: ReviewAnnotation) => ReviewAnnotation,
): ReviewAnnotation[] {
	return values.map(value => (value.id === id ? { ...update(value), id: value.id } : value))
}
export function annotationSaveDraft<T extends { archiveRevision?: string | null }>(
	draft: T,
	revision?: { value: string | null },
): T {
	const { archiveRevision: _previous, ...rest } = draft
	return (revision ? { ...rest, archiveRevision: revision.value } : rest) as T
}
