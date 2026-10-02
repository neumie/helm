import { Lexer } from 'marked'
import type { MarkedToken, Token } from 'marked'

export interface ReviewBlock {
	token: Token
	start: number
	end: number
	id: string
	heading: string | null
	depth: number
}
export interface ReviewMarkdownModel {
	blocks: ReviewBlock[]
	limited: boolean
	error: string | null
}

/** Prove raw top-level partitions against a normalized-to-original source index. */
export function parseReviewMarkdown(text: string): ReviewMarkdownModel {
	if (text.length > 524288)
		return { blocks: [], limited: true, error: 'This document exceeds the 512 KiB review limit.' }
	let normalized = ''
	const boundaries: number[] = [0]
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\r') {
			normalized += '\n'
			if (text[i + 1] === '\n') i++
		} else normalized += text[i]
		boundaries.push(i + 1)
	}
	const lines = normalized.split('\n')
	const safeTableShape =
		lines.length <= 10000 &&
		lines.reduce((total, line) => total + (line.match(/\|/g)?.length ?? 0), 0) <= 20000 &&
		lines.every(line => (line.match(/\|/g)?.length ?? 0) <= 48)
	if (!safeTableShape)
		return {
			blocks: [],
			limited: true,
			error: 'This document’s table shape exceeds safe rendering limits. Its complete Markdown is available in Source.',
		}
	try {
		const tokens = new Lexer({ gfm: true }).lex(normalized)
		if (tokens.length > 10000) throw new Error('Too many blocks')
		let cursor = 0
		const blocks = tokens.map((token, i): ReviewBlock => {
			if (!token.raw || normalized.slice(cursor, cursor + token.raw.length) !== token.raw)
				throw new Error('Unmapped source')
			const start = boundaries[cursor]
			cursor += token.raw.length
			const end = boundaries[cursor]
			if (start === undefined || end === undefined) throw new Error('Unmapped source')
			const typed = token as MarkedToken
			return {
				token,
				start,
				end,
				id: `review-block-${i}`,
				heading: typed.type === 'heading' ? typed.text : null,
				depth: typed.type === 'heading' ? typed.depth : 0,
			}
		})
		if (cursor !== normalized.length) throw new Error('Incomplete partition')
		return { blocks, limited: false, error: null }
	} catch {
		return {
			blocks: [],
			limited: true,
			error: 'This Markdown cannot be mapped safely. Read its complete Source and select exact source text there.',
		}
	}
}
