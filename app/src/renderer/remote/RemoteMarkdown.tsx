import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked'
import { Fragment, type ReactNode, createElement, memo } from 'react'

/** Parse bounded Markdown, never HTML. Only explicit React elements cross the rendering boundary. */
export const RemoteMarkdown = memo(function RemoteMarkdown({ text }: { text: string }) {
	let remaining = 2048
	const decode = (value: string) =>
		value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (raw, entity: string) => {
			const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
			if (!entity.startsWith('#')) return named[entity] ?? raw
			const code =
				entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd'
		})
	function render(tokens: Token[], depth = 0): ReactNode {
		if (depth > 16 || remaining <= 0) return tokens.map(token => token.raw).join('')
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
					node = <p>{children}</p>
					break
				case 'text':
					node = children ?? decode(token.text)
					break
				case 'escape':
					node = decode(token.text)
					break
				case 'strong':
					node = <strong>{children}</strong>
					break
				case 'em':
					node = <em>{children}</em>
					break
				case 'del':
					node = <del>{children}</del>
					break
				case 'br':
					node = <br />
					break
				case 'hr':
					node = <hr />
					break
				case 'codespan':
					node = <code>{token.text}</code>
					break
				case 'code':
					node = (
						<pre>
							<code>{token.text}</code>
						</pre>
					)
					break
				case 'blockquote':
					node = <blockquote>{children}</blockquote>
					break
				case 'list':
					node = createElement(
						token.ordered ? 'ol' : 'ul',
						token.ordered ? { start: Number(token.start) || 1 } : null,
						render(token.items, depth + 1),
					)
					break
				case 'list_item':
					node = (
						<li>
							{token.task && (
								<span aria-label={token.checked ? 'Complete' : 'Incomplete'}>{token.checked ? '☑ ' : '☐ '}</span>
							)}
							{children}
						</li>
					)
					break
				case 'checkbox':
					node = <span aria-label={token.checked ? 'Complete' : 'Incomplete'}>{token.checked ? '☑' : '☐'}</span>
					break
				case 'link': {
					let href: string | undefined
					try {
						const url = new URL(decode(token.href))
						if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) href = url.href
					} catch {
						/* Relative paths and unsupported schemes remain text. */
					}
					node = href ? (
						<a href={href} target="_blank" rel="noopener noreferrer">
							{children}
						</a>
					) : (
						children
					)
					break
				}
				case 'image':
					node = <span className="remote-image-note">Image: {decode(token.text || 'not loaded')}</span>
					break
				case 'html':
					node = token.raw
					break
				case 'table': {
					const cell = (value: Tokens.TableCell, index: number, header: boolean) =>
						createElement(header ? 'th' : 'td', { key: index }, render(value.tokens, depth + 1))
					node = (
						<div className="remote-table">
							<table>
								<thead>
									<tr>{token.header.map((value, index) => cell(value, index, true))}</tr>
								</thead>
								<tbody>
									{token.rows.map((row, index) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: immutable parsed rows have positional identity and no component state.
										<tr key={index}>{row.map((value, index) => cell(value, index, false))}</tr>
									))}
								</tbody>
							</table>
						</div>
					)
					break
				}
				default:
					node = value.raw
			}
			// biome-ignore lint/suspicious/noArrayIndexKey: stateless tokens are positions in this single bounded message.
			return <Fragment key={index}>{node}</Fragment>
		})
	}
	try {
		const bounded = text.slice(0, 8192)
		// Avoid table-cell amplification (many empty columns × many short rows).
		// Oversized table-shaped input degrades to ordinary Markdown paragraphs.
		const lines = bounded.split('\n')
		const gfm = lines.length <= 256 && lines.every(line => (line.match(/\|/g)?.length ?? 0) <= 24)
		return <div className="remote-markdown">{render(new Lexer({ gfm }).lex(bounded))}</div>
	} catch {
		return <div className="remote-markdown remote-plain">{text.slice(0, 8192)}</div>
	}
})
