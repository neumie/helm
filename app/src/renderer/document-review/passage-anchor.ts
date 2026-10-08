interface TextSpan {
	node: Text
	start: number
	end: number
}

const MAX_TEXT_UNITS = 512 * 1024
const MAX_TEXT_NODES = 60000
const MAX_QUOTES = 80

// Native selections add breaks between list/table rows and <br>; Range text does
// not. Ignore only these presentation separators, never spaces or Unicode text.
const displayText = (text: string) => text.replace(/[\r\n\t]/g, '')

function textOffset(node: Text, units: number, edge: 'start' | 'end'): number {
	let seen = 0
	for (let offset = 0; offset < node.data.length; offset++) {
		if ('\r\n\t'.includes(node.data[offset] ?? '')) continue
		if (edge === 'start' && seen === units) return offset
		seen++
		if (edge === 'end' && seen === units) return offset + 1
	}
	return node.data.length
}

/** Display only, inside an already validated current source block. No Markdown offsets or relocation. */
export function locatePassageDisplayRanges(element: HTMLElement, quotes: readonly string[]): (Range | null)[] {
	const missing = () => quotes.map(() => null)
	if (!element.isConnected || quotes.length > MAX_QUOTES) return missing()
	const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
	const spans: TextSpan[] = []
	const parts: string[] = []
	let units = 0
	let examined = 0
	let nodes = 0
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node as Text
		examined += text.data.length
		if (++nodes > MAX_TEXT_NODES || examined > MAX_TEXT_UNITS) return missing()
		const value = displayText(text.data)
		if (!value.length) continue
		spans.push({ node: text, start: units, end: units + value.length })
		parts.push(value)
		units += value.length
	}
	const text = parts.join('')
	return quotes.map(quote => {
		if (!quote.trim() || quote.length > 8000) return null
		const value = displayText(quote)
		if (!value.length) return null
		const start = text.indexOf(value)
		// A duplicate inside this same block is ambiguous too. Never choose the first.
		if (start < 0 || text.indexOf(value, start + 1) !== -1) return null
		const end = start + value.length
		const first = spans.find(span => span.start <= start && start < span.end)
		const last = spans.find(span => span.start < end && end <= span.end)
		if (!first || !last) return null
		const range = element.ownerDocument.createRange()
		range.setStart(first.node, textOffset(first.node, start - first.start, 'start'))
		range.setEnd(last.node, textOffset(last.node, end - last.start, 'end'))
		return displayText(range.toString()) === value ? range : null
	})
}
