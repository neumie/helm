// Bounded Markdown → explicit React elements, shared by Helm Remote (RemoteMarkdown) and the agent
// dock's turn message. Marked only lexes; nothing it produces is ever rendered as HTML: every token
// maps to an allowlisted element or to inert text, and raw HTML tokens stay literal text.
import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked'
import { Fragment, type MouseEvent, type ReactNode, createElement } from 'react'

/** Input bound in UTF-16 units; longer text is cut before lexing. */
export const MARKDOWN_TEXT_MAX = 8192
/** Tokens rendered per message; past it (or past the depth bound) the rest stays raw text. */
const TOKEN_BUDGET = 2048
const DEPTH_MAX = 16

/** Where the two surfaces differ. Everything else (the element allowlist, bounds, decoding) is shared. */
export interface SafeMarkdownProfile {
	/** The wrapper `div`'s class. */
	className: string
	/** The wrapper's class when lexing fails and the bounded text renders as one plain text node. */
	plainClassName: string
	/**
	 * Credential-free absolute http(s) links: an anchor opening a new tab, just their text, or an anchor
	 * whose activation (click, Enter) never navigates and hands the URL to `open` instead.
	 */
	links: 'anchor' | 'text' | { open(href: string): void }
	/** Images are never fetched: a note span of this class (`Image: alt`), or null for the alt text alone. */
	imageNoteClassName: string | null
	/** GFM tables: a `table` in a `div` of this class, or null for their Markdown source in a `pre`. */
	tableClassName: string | null
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Marked keeps a few entities encoded in text; decode them back to characters (React escapes on output). */
function decode(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (raw, entity: string) => {
		if (!entity.startsWith('#')) return NAMED_ENTITIES[entity] ?? raw
		const code =
			entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
		return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
	})
}

function safeHref(href: string): string | undefined {
	try {
		const url = new URL(decode(href))
		if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href
	} catch {
		/* Relative paths and unsupported schemes remain text. */
	}
	return undefined
}

/** Parse bounded Markdown, never HTML. Only explicit React elements cross the rendering boundary. */
export function renderSafeMarkdown(text: string, profile: SafeMarkdownProfile): ReactNode {
	let remaining = TOKEN_BUDGET
	function render(tokens: Token[], depth = 0): ReactNode {
		if (depth > DEPTH_MAX || remaining <= 0) return tokens.map(token => token.raw).join('')
		return tokens.map((value, index) => {
			if (--remaining <= 0) return value.raw
			// This private Lexer has no custom extensions: its output is the standard token union.
			const token = value as MarkedToken
			const children = 'tokens' in token && token.tokens ? render(token.tokens, depth + 1) : null
			let node: ReactNode
			switch (token.type) {
				case 'space':
				case 'def':
					return null
				case 'heading':
					node = createElement(`h${Math.min(6, token.depth + 2)}`, null, children)
					break
				case 'paragraph':
					node = createElement('p', null, children)
					break
				case 'text':
					node = children ?? decode(token.text)
					break
				case 'escape':
					node = decode(token.text)
					break
				case 'strong':
					node = createElement('strong', null, children)
					break
				case 'em':
					node = createElement('em', null, children)
					break
				case 'del':
					node = createElement('del', null, children)
					break
				case 'br':
					node = createElement('br')
					break
				case 'hr':
					node = createElement('hr')
					break
				case 'codespan':
					node = createElement('code', null, token.text)
					break
				case 'code':
					node = createElement('pre', null, createElement('code', null, token.text))
					break
				case 'blockquote':
					node = createElement('blockquote', null, children)
					break
				case 'list':
					node = createElement(
						token.ordered ? 'ol' : 'ul',
						token.ordered ? { start: Number(token.start) || 1 } : null,
						render(token.items, depth + 1),
					)
					break
				case 'list_item':
					node = createElement(
						'li',
						null,
						token.task &&
							createElement(
								'span',
								{ 'aria-label': token.checked ? 'Complete' : 'Incomplete' },
								token.checked ? '☑ ' : '☐ ',
							),
						children,
					)
					break
				case 'checkbox':
					node = createElement(
						'span',
						{ 'aria-label': token.checked ? 'Complete' : 'Incomplete' },
						token.checked ? '☑' : '☐',
					)
					break
				case 'link': {
					const { links } = profile
					const href = links === 'text' ? undefined : safeHref(token.href)
					if (!href || links === 'text') node = children
					else if (links === 'anchor')
						node = createElement('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children)
					else {
						const { open } = links
						node = createElement(
							'a',
							{
								href,
								// The renderer never follows it: no navigation, no new window (middle click).
								onClick: (event: MouseEvent) => {
									event.preventDefault()
									open(href)
								},
								onAuxClick: (event: MouseEvent) => event.preventDefault(),
							},
							children,
						)
					}
					break
				}
				case 'image': {
					const alt = decode(token.text || 'not loaded')
					node = profile.imageNoteClassName
						? createElement('span', { className: profile.imageNoteClassName }, 'Image: ', alt)
						: decode(token.text)
					break
				}
				case 'html':
					node = token.raw
					break
				case 'table': {
					if (!profile.tableClassName) {
						node = createElement('pre', null, token.raw.replace(/\n+$/, ''))
						break
					}
					const cell = (value: Tokens.TableCell, index: number, header: boolean) =>
						createElement(header ? 'th' : 'td', { key: index }, render(value.tokens, depth + 1))
					node = createElement(
						'div',
						{ className: profile.tableClassName },
						createElement(
							'table',
							null,
							createElement(
								'thead',
								null,
								createElement(
									'tr',
									null,
									token.header.map((value, index) => cell(value, index, true)),
								),
							),
							createElement(
								'tbody',
								null,
								// Immutable parsed rows have positional identity and no component state.
								token.rows.map((row, index) =>
									createElement(
										'tr',
										{ key: index },
										row.map((value, index) => cell(value, index, false)),
									),
								),
							),
						),
					)
					break
				}
				default:
					node = value.raw
			}
			// Stateless tokens are positions in this single bounded message.
			return createElement(Fragment, { key: index }, node)
		})
	}
	try {
		const bounded = text.slice(0, MARKDOWN_TEXT_MAX)
		// Avoid table-cell amplification (many empty columns × many short rows).
		// Oversized table-shaped input degrades to ordinary Markdown paragraphs.
		const lines = bounded.split('\n')
		const gfm = lines.length <= 256 && lines.every(line => (line.match(/\|/g)?.length ?? 0) <= 24)
		return createElement('div', { className: profile.className }, render(new Lexer({ gfm }).lex(bounded)))
	} catch {
		return createElement('div', { className: profile.plainClassName }, text.slice(0, MARKDOWN_TEXT_MAX))
	}
}
