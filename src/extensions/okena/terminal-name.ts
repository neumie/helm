import type { OkenaTerminalRole } from '../../items/okena-terminals.js'

/**
 * Short display names for the Okena terminals Helm creates. Same rule as the
 * agents' own terminal names: 1–4 words, at most 24 characters (code points,
 * as `wc -m` counts them), in the task's language, no ids or ticket numbers.
 * A name is display-only: Helm finds its terminals by id
 * (`item_okena_terminals`), so an agent may rename them at any time.
 */
export const TERMINAL_NAME_MAX_CHARS = 24
export const TERMINAL_NAME_MAX_WORDS = 4
/** The only role mark: a planning terminal starts with this glyph; a solve terminal has none. */
export const PLAN_TERMINAL_MARK = '✎'
const FALLBACK_NAME = 'Helm task'

function codePoints(text: string): string[] {
	return Array.from(text)
}

/** Ticket ids, issue numbers and bare numbers say nothing to a reader of the tab. */
function isIdToken(token: string): boolean {
	const bare = token.replace(/[:.,;)]+$/, '').replace(/^\(+/, '')
	return /^#?\d+$/.test(bare) || /^[A-Z][A-Z0-9]*-\d+$/.test(bare) || /^#[\w-]+$/.test(bare)
}

const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u
const TRAILING_SEPARATORS = /[\s,;:.\-–—/|·•]+$/u

/** 1–4 words of `text` within `budget` code points; a single over-long word is cut with an ellipsis. */
export function shortName(text: string, budget: number = TERMINAL_NAME_MAX_CHARS): string {
	const words = text
		// Control, format and bidi characters never belong in a tab label.
		.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
		// Bracketed prefixes like "[Echo]" or "[helm:<id>]" are tags, not the task.
		.replace(/\[[^\]]*\]|【[^】]*】/g, ' ')
		.split(/\s+/)
		.filter(token => token !== '' && !isIdToken(token) && !PUNCTUATION_ONLY.test(token))
	const picked: string[] = []
	let length = 0
	for (const word of words) {
		if (picked.length === TERMINAL_NAME_MAX_WORDS) break
		const size = codePoints(word).length
		const next = picked.length === 0 ? size : length + 1 + size
		if (next > budget) {
			if (picked.length === 0)
				picked.push(
					`${codePoints(word)
						.slice(0, budget - 1)
						.join('')}…`,
				)
			break
		}
		picked.push(word)
		length = next
	}
	return picked.join(' ').replace(TRAILING_SEPARATORS, '')
}

/**
 * The name Helm gives a terminal it takes for an Item: the first of `taskNames`
 * (display name, then raw title) that still says something once ids and tags
 * are dropped; planning terminals are marked `✎`.
 */
export function okenaTerminalName(
	taskNames: string | ReadonlyArray<string | null | undefined>,
	role: OkenaTerminalRole,
): string {
	const mark = role === 'plan' ? `${PLAN_TERMINAL_MARK} ` : ''
	const budget = TERMINAL_NAME_MAX_CHARS - codePoints(mark).length
	const candidates = typeof taskNames === 'string' ? [taskNames] : taskNames
	let name = ''
	for (const candidate of candidates) {
		if (candidate) name = shortName(candidate, budget)
		if (name) break
	}
	return `${mark}${name || FALLBACK_NAME}`
}
