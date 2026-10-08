import type { ReviewAnnotation, ReviewIntent, ReviewPassage, ReviewProvider } from './types.js'

/** Compiler-observed source bounds, never renderer-supplied Markdown offsets. */
export interface CanvasSourceBlock {
	id: string
	start: number
	end: number
}
export interface CanvasFieldValue {
	id: string
	value: string | boolean
}
export interface ReviewCanvasCompilation {
	code: string | null
	blocks: CanvasSourceBlock[]
	fieldIds: string[]
	error: string | null
}

/** Portable display evidence only. No native owners, sessions, paths, grants or replay data. */
export interface CanvasReviewThread {
	id: string
	instruction: string
	intent: ReviewIntent
	passage: ReviewPassage | null
	fields: CanvasFieldValue[]
	provider: ReviewProvider
	name: string
	state: 'unconfirmed' | 'complete' | 'error' | 'unknown' | 'rejected'
	reply?: string
	detail?: string
}
export interface CanvasReviewArchive {
	version: 1
	/** Hash of the exact full file, used only for optimistic metadata writes. */
	revision: string
	threads: CanvasReviewThread[]
	annotations: ReviewAnnotation[]
}
export type CanvasReviewEntry =
	| { version: 1; type: 'thread'; thread: CanvasReviewThread }
	| {
			version: 1
			type: 'settle'
			id: string
			state: 'complete' | 'error' | 'unknown' | 'rejected'
			reply?: string
			detail?: string
	  }
	| { version: 1; type: 'annotations'; annotations: ReviewAnnotation[] }

/** Bounded inert browser display tree. An event handle only routes back into its own worker. */
export interface CanvasDisplayNode {
	id: string
	tag: string
	/** Runtime-owned exact compiler-created props/original-tag provenance, never a producer prop. */
	sourceId?: string
	/** Arrays are local-only select-multiple value/defaultValue, never public field data. */
	props: Record<string, string | number | boolean | string[] | Record<string, string | number>>
	children: (string | CanvasDisplayNode)[]
	events?: { click?: string; change?: string }
}
export interface CanvasDisplayFrame {
	nodes: (string | CanvasDisplayNode)[]
	fields: CanvasFieldValue[]
}
export interface CanvasDisplayEvent {
	handle: string
	value?: string
	checked?: boolean
	/** Local-only selectedOptions, bounded to 64 strings/16384 total UTF-16 units. */
	values?: string[]
}
