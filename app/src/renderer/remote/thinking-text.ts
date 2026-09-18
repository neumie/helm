import { Lexer, type Token } from 'marked'

const isC0 = (code: number) => code < 0x20 || code === 0x7f
const isC1 = (code: number) => code >= 0x80 && code <= 0x9f
const isCsiFinal = (code: number) => code >= 0x40 && code <= 0x7e
const isCsiParameter = (code: number) => code >= 0x30 && code <= 0x3f
const isCsiIntermediate = (code: number) => code >= 0x20 && code <= 0x2f
function scanOsc(text: string, start: number): number | null {
	for (let i = start; i < text.length; i++) {
		const c = text.charCodeAt(i)
		if (c === 7 || c === 0x9c) return i
		if (c === 27 && text.charCodeAt(i + 1) === 92) return i + 1
	}
	return null
}
function scanCsi(text: string, start: number): number {
	let i = start
	while (i < text.length && isCsiParameter(text.charCodeAt(i))) i++
	while (i < text.length && isCsiIntermediate(text.charCodeAt(i))) i++
	return i < text.length && isCsiFinal(text.charCodeAt(i)) ? i + 1 : i
}
function scanEsc(text: string, start: number): number {
	let i = start
	while (i < text.length && isCsiIntermediate(text.charCodeAt(i))) i++
	return i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 126 ? i + 1 : i
}
function stripAnsi(input: string, maxUnits: number): string {
	let text = input.slice(0, maxUnits)
	if (text.length && text.charCodeAt(text.length - 1) >= 0xd800 && text.charCodeAt(text.length - 1) <= 0xdbff)
		text = text.slice(0, -1)
	let out = ''
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i)
		if (c === 27 || c === 0x9b) {
			const intro = c === 0x9b ? i + 1 : i + 2
			if (c === 27 && text.charCodeAt(i + 1) === 93) {
				const e = scanOsc(text, i + 2)
				if (e === null) break
				i = e
				continue
			}
			if (c === 0x9b || (c === 27 && text.charCodeAt(i + 1) === 91)) {
				i = scanCsi(text, intro) - 1
				continue
			}
			i = scanEsc(text, i + 1) - 1
			continue
		}
		if (c === 0x9d) {
			const e = scanOsc(text, i + 1)
			if (e === null) break
			i = e
			continue
		}
		if (isC0(c) || isC1(c)) {
			if (c === 9 || c === 10 || c === 13) out += text[i]
			continue
		}
		out += text[i]
	}
	return out
}

type Range = { start: number; end: number }
function isWord(text: string, at: number): boolean {
	if (at < 0 || at >= text.length) return false
	// A backward boundary names the final UTF-16 unit, not necessarily the code point start.
	const start = text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff && at > 0 ? at - 1 : at
	return /[\p{L}\p{N}_]/u.test(String.fromCodePoint(text.codePointAt(start) ?? 0))
}
function protectedRanges(text: string): Range[] {
	const ranges: Range[] = []
	const locked: boolean[] = Array(text.length).fill(false)
	const lock = (start: number, end: number) => {
		ranges.push({ start, end })
		for (let i = start; i < end; i++) locked[i] = true
	}
	const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(m => m[0].length)
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (!line) continue
		const start = line.index
		const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line[0])?.[1]
		if (fence) {
			let end = text.length
			const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*(?:\\r\\n|\\r|\\n|$)$`)
			while (++i < lines.length) {
				const next = lines[i]
				if (next && close.test(next[0])) {
					end = next.index + next[0].length
					break
				}
			}
			lock(start, end)
		} else if (/^(?: {4}|\t)/.test(line[0])) lock(start, start + line[0].length)
	}
	// Escapes and code are scanned once; a failed code search protects the remaining source.
	for (let i = 0; i < text.length; ) {
		if (locked[i]) {
			i++
			continue
		}
		if (text[i] === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\^_`{|}~]/.test(text[i + 1] ?? '')) {
			lock(i, i + 2)
			i += 2
			continue
		}
		if (text[i] !== '`') {
			i++
			continue
		}
		let openEnd = i + 1
		while (text[openEnd] === '`') openEnd++
		let end = openEnd
		while (end < text.length) {
			if (text[end] !== '`' || locked[end]) {
				end++
				continue
			}
			const run = end
			while (text[end] === '`') end++
			if (end - run === openEnd - i) break
		}
		lock(i, end)
		i = end
	}
	const union: Range[] = []
	for (const range of ranges.sort((a, b) => a.start - b.start)) {
		const last = union.at(-1)
		if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
		else union.push({ ...range })
	}
	return union
}
function labelEnd(text: string, locked: boolean[]): number {
	let start = 0
	for (let count = 0; count < 8; count++) {
		// Exactly one immediate prefix. No blank-line search, case folding, or recursive restart.
		const match = /^( {0,3})(?:#{1,6} )?(?:(\*{1,2}|_{1,2})Thinking(:?)\2(:?)|Thinking(:?))([ \t]*)/s.exec(
			text.slice(start),
		)
		if (!match) break
		let end = start + match[0].length
		if (locked.slice(start, end).some(Boolean)) break
		const colon = !!(match[3] || match[4] || match[5])
		if (match[3] && match[4]) break
		const newline = /^(?:\r\n|\r|\n)/.exec(text.slice(end))?.[0]
		if (!colon && end !== text.length && !newline) break
		if (newline) end += newline.length
		if (end <= start) break
		start = end
	}
	return start
}
function decorate(text: string): string {
	if (!/[*_]|Thinking/.test(text)) return text
	const locks = protectedRanges(text)
	const locked: boolean[] = Array(text.length).fill(false)
	for (const range of locks) for (let i = range.start; i < range.end; i++) locked[i] = true
	const prefix = labelEnd(text, locked)
	const deletions: Range[] = prefix ? [{ start: 0, end: prefix }] : []
	const mappedMarkers: boolean[] = Array(text.length).fill(false)
	const operand = (at: number) => !mappedMarkers[at] && isWord(text, at)
	let tokensLeft = 2048
	let unitsLeft = 32768
	const walk = (tokens: Token[], start: number, end: number, depth: number) => {
		if (depth > 16) throw new Error('Thinking depth budget')
		let cursor = start
		for (const token of tokens) {
			const raw = token.raw
			tokensLeft--
			unitsLeft -= raw?.length ?? 0
			if (
				tokensLeft < 0 ||
				!raw ||
				unitsLeft < 0 ||
				cursor + raw.length > end ||
				text.slice(cursor, cursor + raw.length) !== raw
			)
				throw new Error('Thinking source mapping budget')
			const next = cursor + raw.length
			if (token.type === 'em' || token.type === 'strong') {
				const width = token.type === 'em' ? 1 : 2
				const marker = raw[0]
				if (
					(marker !== '*' && marker !== '_') ||
					raw.length <= 2 * width ||
					!raw.startsWith(marker.repeat(width)) ||
					!raw.endsWith(marker.repeat(width))
				)
					throw new Error('Thinking delimiter mapping')
				const innerStart = cursor + width
				const innerEnd = next - width
				for (let i = cursor; i < innerStart; i++) mappedMarkers[i] = true
				for (let i = innerEnd; i < next; i++) mappedMarkers[i] = true
				const unsafe =
					(operand(cursor - 1) && (operand(innerStart) || operand(next))) ||
					(operand(innerEnd - 1) && operand(next)) ||
					/[\/\\]/.test(text[cursor - 1] ?? '') ||
					/[\/\\]/.test(text[next] ?? '') ||
					(text[cursor - 1] === marker && locked[cursor - 1]) ||
					(text[next] === marker && locked[next])
				if (!unsafe && text.slice(innerStart, innerEnd).trim())
					deletions.push({ start: cursor, end: innerStart }, { start: innerEnd, end: next })
				if (!token.tokens) throw new Error('Missing thinking source partition')
				walk(token.tokens, innerStart, innerEnd, depth + 1)
			}
			cursor = next
		}
		if (cursor !== end) throw new Error('Incomplete thinking source partition')
	}
	const segment = (start: number, end: number) => {
		if (start < end) walk(new Lexer({ gfm: false }).inlineTokens(text.slice(start, end)), start, end, 0)
	}
	let cursor = prefix
	for (const range of locks) {
		segment(cursor, range.start)
		cursor = Math.max(cursor, range.end)
	}
	segment(cursor, text.length)
	let out = ''
	cursor = 0
	for (const range of deletions.sort((a, b) => a.start - b.start)) {
		if (range.start < cursor || range.end <= range.start || range.end > text.length)
			throw new Error('Conflicting thinking deletions')
		out += text.slice(cursor, range.start)
		cursor = range.end
	}
	return out + text.slice(cursor)
}

/** Remove terminal formatting and safe thinking presentation decoration. */
export function normalizeThinkingText(input: string, maxUnits = 8192): string {
	const ansi = stripAnsi(input, maxUnits)
	try {
		return decorate(ansi)
	} catch {
		return ansi
	}
}
