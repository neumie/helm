// Find in a PDF (docs/plans/helm-open/spec.md, Search): pure text matching over pdf.js text content. A page's text is
// its items joined in order, with a line break after an item that ends a line; a match maps back to the text-layer
// spans it covers (pdf.js renders one span per text item, in the same order), so highlights are DOM Ranges.

export interface PdfTextItem {
	str: string
	hasEOL: boolean
}
export interface PdfPageText {
	text: string
	/** Offset in `text` where each item starts. */
	starts: number[]
	lengths: number[]
}
export interface PdfMatch {
	/** 1-based page number. */
	page: number
	start: number
	end: number
}
/** Matches shown at most; the count says "+" past it. */
export const PDF_FIND_LIMIT = 10_000

export function pageText(items: readonly PdfTextItem[]): PdfPageText {
	let text = ''
	const starts: number[] = []
	const lengths: number[] = []
	for (const item of items) {
		starts.push(text.length)
		lengths.push(item.str.length)
		text += item.str
		if (item.hasEOL) text += '\n'
	}
	return { text, starts, lengths }
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g
/** Case-insensitive; any run of whitespace in the query matches any run in the text (pdf.js splits lines). */
export function findPattern(query: string): RegExp | null {
	const words = query.trim().split(/\s+/).filter(Boolean)
	if (!words.length) return null
	return new RegExp(words.map(word => word.replace(SPECIAL, '\\$&')).join('\\s+'), 'giu')
}

/** Matches on one page, in order, at most `limit`. */
export function pageMatches(page: number, text: PdfPageText, pattern: RegExp, limit = PDF_FIND_LIMIT): PdfMatch[] {
	const found: PdfMatch[] = []
	const search = new RegExp(pattern.source, pattern.flags)
	for (let match = search.exec(text.text); match && found.length < limit; match = search.exec(text.text)) {
		if (match[0].length === 0) {
			search.lastIndex++
			continue
		}
		found.push({ page, start: match.index, end: match.index + match[0].length })
	}
	return found
}

/** The part of each item a match covers: `{ item, from, to }` offsets inside that item's string. */
export function matchParts(text: PdfPageText, match: { start: number; end: number }) {
	const parts: { item: number; from: number; to: number }[] = []
	for (let item = 0; item < text.starts.length; item++) {
		const start = text.starts[item] ?? 0
		const end = start + (text.lengths[item] ?? 0)
		if (end <= match.start) continue
		if (start >= match.end) break
		const from = Math.max(match.start, start) - start
		const to = Math.min(match.end, end) - start
		if (to > from) parts.push({ item, from, to })
	}
	return parts
}
