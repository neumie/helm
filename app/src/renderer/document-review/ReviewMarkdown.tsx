import type { MarkedToken, Token, Tokens } from 'marked'
import { Fragment, createElement, memo } from 'react'
import type { ReactNode } from 'react'
import { Btn } from '../button'
import type { ReviewBlock } from './markdown'

function decode(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (raw, entity: string) => {
		const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
		if (!entity.startsWith('#')) return names[entity.toLowerCase()] ?? raw
		const n =
			entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
		return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd'
	})
}

/** Separate document renderer: no chat truncation, parser HTML or automatic image fetching. */
export const ReviewMarkdown = memo(function ReviewMarkdown({
	blocks,
	onBlock,
	selectedStart,
}: { blocks: ReviewBlock[]; onBlock(block: ReviewBlock): void; selectedStart: number | null }) {
	let remaining = 30000
	let limited = false
	const render = (tokens: Token[], depth = 0): ReactNode => {
		if (depth > 16 || remaining < tokens.length) {
			limited = true
			return <span className="review-source-fallback">{tokens.map(token => token.raw).join('')}</span>
		}
		let sourceOffset = 0
		return tokens.map(value => {
			const key = `${value.type}:${sourceOffset}`
			sourceOffset += value.raw.length
			remaining--
			const token = value as MarkedToken
			const children = 'tokens' in token && token.tokens ? render(token.tokens, depth + 1) : null
			let node: ReactNode
			switch (token.type) {
				case 'space':
				case 'def':
					return null
				case 'heading':
					node = createElement(`h${token.depth}`, null, children)
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
				case 'br':
					node = <br />
					break
				case 'hr':
					node = <hr />
					break
				case 'link': {
					let safe: string | null = null
					try {
						const url = new URL(decode(token.href))
						if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) safe = url.href
					} catch {
						/* inert */
					}
					node = safe ? (
						<a href={safe} target="_blank" rel="noopener noreferrer">
							{children}
						</a>
					) : (
						children
					)
					break
				}
				case 'image':
					node = <span className="review-image-note">Image not loaded: {decode(token.text || 'unnamed image')}</span>
					break
				case 'html':
					node = <span className="review-source-fallback">{token.raw}</span>
					break
				case 'table': {
					const cell = (cell: Tokens.TableCell, i: number, header: boolean) =>
						createElement(header ? 'th' : 'td', { key: i }, render(cell.tokens, depth + 1))
					node = (
						<div className="review-table">
							<table>
								<thead>
									<tr>{token.header.map((value, i) => cell(value, i, true))}</tr>
								</thead>
								<tbody>
									{token.rows.map((row, i) => {
										// biome-ignore lint/suspicious/noArrayIndexKey: Immutable table cells have no component state; source row order is their identity.
										return <tr key={`row:${i}`}>{row.map((value, n) => cell(value, n, false))}</tr>
									})}
								</tbody>
							</table>
						</div>
					)
					break
				}
				default:
					node = value.raw
			}
			return <Fragment key={key}>{node}</Fragment>
		})
	}
	const nodes = blocks.map(block => (
		<div
			key={block.id}
			id={block.id}
			className="review-block"
			data-source-start={block.start}
			data-source-end={block.end}
			data-selected={
				selectedStart !== null && selectedStart >= block.start && selectedStart < block.end ? 'true' : undefined
			}
		>
			<div className="review-block-text">{render([block.token])}</div>
			{block.token.type !== 'space' && block.token.type !== 'def' && (
				<div className="review-block-action">
					<Btn
						tone="ghost"
						sm
						ariaLabel={`Review passage ${block.heading ?? `at source offset ${block.start}`}`}
						onClick={() => onBlock(block)}
					>
						Review
					</Btn>
				</div>
			)}
		</div>
	))
	return (
		<>
			{nodes}
			{limited && (
				<output>Some complex formatting is shown as literal Markdown. No document content was omitted.</output>
			)}
		</>
	)
})
