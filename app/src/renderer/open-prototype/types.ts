// Story-only prototype of `helm open` (docs/plans/helm-open/spec.md). Nothing here ships:
// app/tsconfig.json excludes this folder and only *.stories.tsx files import it.

/** The format families the viewer knows. One renderer per family (spec §Formats). */
export type ViewerFormat =
	| 'pdf'
	| 'image'
	| 'sheet' // xlsx / xls / ods
	| 'csv' // csv / tsv
	| 'docx'
	| 'json' // json / jsonl / yaml / toml
	| 'code'
	| 'markdown'
	| 'html'
	| 'media'
	| 'email'

export interface ViewerFile {
	/** Display name, the real file name. */
	name: string
	/** Display path, home-relative (`~/Downloads/…`). */
	path: string
	format: ViewerFormat
	/** Bytes on disk. */
	size: number
	/** Human modified time, already formatted (fixtures are static). */
	modified: string
	/** Where the prototype loads the bytes from (a Vite asset URL). */
	url: string
	/** Language hint for code/json renderers. */
	language?: string
}

/** What a renderer tells the chrome about the current view, for a status line or title row. */
export interface ViewerStatus {
	/** Where the reader is: "Page 2 of 3", "B4:D9", "$.latestEvent", "Ln 42, Col 7". */
	position?: string
	/** Plain facts about the file: "A4", "1200 × 760", "2 sheets", "1 800 rows". */
	facts?: string[]
}

/** Where a piece of feedback points (spec §Feedback per format). */
export type FeedbackAnchor =
	| { kind: 'text'; quote: string; blockId?: string }
	| { kind: 'lines'; startLine: number; endLine: number; quote: string }
	| { kind: 'pdf-text'; page: number; quote: string }
	| { kind: 'pdf-region'; page: number; rect: NormalizedRect }
	| { kind: 'image-region'; rect: PixelRect }
	| { kind: 'cells'; sheet: string; range: string; preview: string[][] }
	| { kind: 'json-path'; path: string; preview: string }

/** 0–1 fractions of the page box, origin top-left. */
export interface NormalizedRect {
	x: number
	y: number
	width: number
	height: number
}

/** Image pixels, origin top-left. */
export interface PixelRect {
	x: number
	y: number
	width: number
	height: number
}

/**
 * Present only in agent feedback mode. A renderer that receives it lets the reader point at
 * something (selection, region, range) and reports the anchor plus the on-screen box it covers,
 * so the chrome can place the feedback bubble. Plain viewing passes null and renderers keep
 * ordinary selection/copy only.
 */
export interface FeedbackHost {
	onAnchor(anchor: FeedbackAnchor, box: DOMRect): void
	/** The anchor currently being written about, for the renderer to keep painted. */
	active: FeedbackAnchor | null
}

/** Props every format renderer takes. */
export interface RendererProps {
	file: ViewerFile
	/** 1 = 100%. Renderers without zoom ignore it. */
	zoom?: number
	onStatus?: (status: ViewerStatus) => void
	feedback?: FeedbackHost | null
}

/** One human line naming an anchor. Literal locators (cells, paths) are code; the rest are words. */
export function anchorLabel(anchor: FeedbackAnchor): { place: string; literal?: string } {
	switch (anchor.kind) {
		case 'text':
			return { place: 'Selected text' }
		case 'lines':
			return {
				place:
					anchor.startLine === anchor.endLine
						? `Line ${anchor.startLine}`
						: `Lines ${anchor.startLine}–${anchor.endLine}`,
			}
		case 'pdf-text':
			return { place: `Page ${anchor.page}` }
		case 'pdf-region':
			return { place: `Page ${anchor.page} · region` }
		case 'image-region':
			return {
				place: 'Region',
				literal: `${Math.round(anchor.rect.width)} × ${Math.round(anchor.rect.height)} at ${Math.round(anchor.rect.x)}, ${Math.round(anchor.rect.y)}`,
			}
		case 'cells':
			return { place: anchor.sheet, literal: anchor.range }
		case 'json-path':
			return { place: 'Value', literal: anchor.path }
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Short format word for chrome ("PDF", "Spreadsheet"). Sentence case, acronyms keep caps. */
export function formatWord(file: ViewerFile): string {
	const ext = file.name.split('.').pop()?.toUpperCase() ?? ''
	switch (file.format) {
		case 'pdf':
			return 'PDF'
		case 'image':
			return `${ext} image`
		case 'sheet':
			return `${ext} spreadsheet`
		case 'csv':
			return ext
		case 'docx':
			return 'Word document'
		case 'json':
			return ext === 'JSONL' || ext === 'NDJSON' ? 'JSON Lines' : ext === 'YML' ? 'YAML' : ext
		case 'code':
			return file.language ?? ext
		case 'markdown':
			return 'Markdown'
		case 'html':
			return 'HTML'
		case 'media':
			return `${ext} media`
		case 'email':
			return 'Email'
	}
}
