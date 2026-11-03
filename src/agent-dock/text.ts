// Plain-text bounding for agent text the dock stores, spools or prints. Import-free,
// so the reducer (also bundled into renderer stories), the spool and the CLI share it.

/** `text` cut to `max` UTF-16 units with an ellipsis, never splitting a surrogate pair. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text
	let end = max - 1
	const code = text.charCodeAt(end - 1)
	if (code >= 0xd800 && code <= 0xdbff) end -= 1
	return `${text.slice(0, end)}…`
}

/** Multi-line plain text: C0/C1 controls stripped except tab/newline, then bounded (clip). */
export function boundText(text: string, max: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
	return clip(text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''), max)
}

/** One line: controls/newlines collapsed to spaces, bounded with an ellipsis. */
export function oneLine(text: string, max: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing controls is the point
	const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
	return clip(text.replace(controls, ' ').replace(/\s+/g, ' ').trim(), max)
}

/** Bidi overrides/isolates and marks: they could reorder text where it is shown. */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * The first non-empty line of agent text as a one-line excerpt: C0/C1 controls and bidi
 * controls stripped, whitespace collapsed, bounded with an ellipsis. '' when nothing is left.
 */
export function excerptLine(text: string, max: number): string {
	const line = text
		.replace(BIDI, '')
		.split(/\r\n|[\n\r\u2028\u2029]/)
		.map(part => oneLine(part, max * 4))
		.find(part => part !== '')
	return line ? clip(line, max) : ''
}
