// A plain `helm open` window for code, text and data files (docs/plans/helm-open/spec.md, S2). Main admits the file
// and serves its bytes through this view's own helm-viewer:// token; the window fetches them, decodes them strictly
// and hands plain text to the code or data view. Markdown and the JSX canvas stay in DocumentReview.
import { type CSSProperties, Suspense, lazy, useEffect, useState } from 'react'
import {
	DATA_LANGUAGES,
	type DataLanguage,
	ENCODING_LABEL,
	decoderLabel,
	sizeText,
} from '../../../../src/document-review/formats'
import type { ReviewDocument } from '../../document-review/types'
import { Btn, buttonClassName } from '../button'
import { MenuButton } from '../sidebar/ui'
import { LANGUAGE_WORDS } from './code-languages'
import './viewer.css'

const CodeView = lazy(() => import('./CodeView').then(module => ({ default: module.CodeView })))
const DataTree = lazy(() => import('./DataView').then(module => ({ default: module.DataTree })))

export interface PlainViewerProps {
	document: ReviewDocument
	theme: 'dark' | 'light'
	zoom: number
	onToggleTheme(): void
	onRetry(): void
}

type Bytes =
	| { kind: 'loading' }
	| { kind: 'ready'; url: string; text: string }
	| { kind: 'failed'; url: string; error: string }

const DATA_KINDS = new Set<string>(Object.values(DATA_LANGUAGES))
const timeText = (date: Date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/** Reads one token's bytes and decodes them strictly; a stale token (409/404) leaves the last text in place. */
async function readText(url: string, encoding: NonNullable<ReviewDocument['viewer']>['encoding'], signal: AbortSignal) {
	const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' })
	if (response.status === 409 || response.status === 404) return null
	if (!response.ok) throw new Error(`The file could not be read (${response.status}).`)
	const bytes = await response.arrayBuffer()
	try {
		return new TextDecoder(decoderLabel(encoding), { fatal: true }).decode(bytes)
	} catch {
		throw new Error(`The file is not valid ${ENCODING_LABEL[encoding]} text.`)
	}
}

export function PlainViewer({ document: file, theme, zoom, onToggleTheme, onRetry }: PlainViewerProps) {
	const viewer = file.viewer
	const [bytes, setBytes] = useState<Bytes>({ kind: 'loading' })
	const [position, setPosition] = useState('')
	const [nodeStatus, setNodeStatus] = useState('')
	const [updated, setUpdated] = useState<Date | null>(null)
	const [mode, setMode] = useState<'tree' | 'raw'>('tree')
	const [parseError, setParseError] = useState<string | null>(null)
	/** Bumped by the menu's Find; the active view opens its search. */
	const [find, setFind] = useState(0)
	const isData = file.format === 'data' && viewer !== undefined && DATA_KINDS.has(viewer.language)

	const url = viewer?.url
	const encoding = viewer?.encoding ?? 'utf-8'
	useEffect(() => {
		if (!url) return
		const abort = new AbortController()
		void readText(url, encoding, abort.signal).then(
			text => {
				if (abort.signal.aborted || text === null) return
				setBytes(previous => {
					if (previous.kind === 'ready') setUpdated(new Date())
					return { kind: 'ready', url, text }
				})
			},
			(error: unknown) => {
				if (abort.signal.aborted) return
				setBytes(previous =>
					previous.kind === 'ready'
						? previous
						: { kind: 'failed', url, error: error instanceof Error ? error.message : 'The file could not be read.' },
				)
			},
		)
		return () => abort.abort()
	}, [url, encoding])

	const tree = isData && mode === 'tree' && parseError === null
	// Main counts lines as the editor does; the status line does not count the empty line after a final newline.
	const lines = viewer
		? Math.max(0, viewer.lines - (bytes.kind === 'ready' && /(\r\n|\r|\n)$/.test(bytes.text) ? 1 : 0))
		: 0
	const facts = viewer
		? [
				isData
					? viewer.language === 'jsonl'
						? 'JSON Lines'
						: viewer.language.toUpperCase()
					: (LANGUAGE_WORDS[viewer.language] ?? 'Plain text'),
				`${lines.toLocaleString('en-US')} ${lines === 1 ? 'line' : 'lines'}`,
				ENCODING_LABEL[viewer.encoding],
				...(viewer.ending === 'none' ? [] : [viewer.ending === 'mixed' ? 'Mixed line endings' : viewer.ending]),
				sizeText(viewer.size),
			]
		: []
	// The banner carries the reason; the status line only says what is on screen.
	const note =
		file.error && bytes.kind === 'ready' ? 'Last readable version' : updated ? `Updated ${timeText(updated)}` : ''

	return (
		<main
			className="document-review viewer-window"
			data-review-theme={theme}
			data-review-mode="plain"
			data-viewer-format={file.format}
			style={{ '--review-zoom': String(zoom) } as CSSProperties}
		>
			<header className="review-header">
				<div className="review-identity">
					<h1>{file.name}</h1>
				</div>
				<div className="review-header-controls">
					<MenuButton
						trigger="⋯"
						triggerLabel="Document options"
						triggerClass={buttonClassName({ tone: 'ghost', sm: true })}
						align="end"
						entries={[
							...(isData
								? [
										{
											label: 'Tree',
											section: 'View',
											checked: tree,
											disabled: parseError !== null,
											onSelect: () => setMode('tree'),
										},
										{ label: 'Raw source', checked: !tree, onSelect: () => setMode('raw') },
									]
								: []),
							{
								label: 'Find',
								section: isData ? undefined : 'View',
								group: isData,
								meta: '⌘F',
								onSelect: () => setFind(value => value + 1),
							},
							{
								label: theme === 'dark' ? 'Light reading surface' : 'Dark reading surface',
								section: 'Appearance',
								onSelect: onToggleTheme,
							},
						]}
					/>
				</div>
			</header>
			{file.error && (
				<div className="review-banner" role="alert">
					<span>
						{file.error} {bytes.kind === 'ready' ? 'The last readable version remains visible.' : ''}
					</span>
					<Btn sm onClick={onRetry}>
						Retry read
					</Btn>
				</div>
			)}
			{isData && parseError !== null && (
				// biome-ignore lint/a11y/useSemanticElements: the review banners are status divs (document-review.css).
				<div className="review-banner" role="status">
					<span>Helm couldn’t parse this file: {parseError}. Showing the source.</span>
				</div>
			)}
			<section className="viewer-stage" aria-label="Document">
				{!viewer ? (
					<p className="viewer-note">This file is not available.</p>
				) : bytes.kind === 'loading' ? (
					<p className="viewer-note">Reading {file.name}…</p>
				) : bytes.kind === 'failed' ? (
					<p className="viewer-note" role="alert">
						{bytes.error}
					</p>
				) : (
					<Suspense fallback={<p className="viewer-note">Reading {file.name}…</p>}>
						{isData && (
							<div className="viewer-pane" hidden={!tree}>
								<DataTree
									text={bytes.text}
									language={viewer.language as DataLanguage}
									zoom={zoom}
									active={tree}
									find={find}
									onParsed={setParseError}
									onStatus={setNodeStatus}
								/>
							</div>
						)}
						{!tree && (
							<div className="viewer-pane">
								<CodeView
									name={file.name}
									text={bytes.text}
									language={viewer.language}
									theme={theme}
									zoom={zoom}
									find={find}
									onPosition={setPosition}
								/>
							</div>
						)}
					</Suspense>
				)}
			</section>
			<footer className="viewer-status">
				<span className="viewer-status-position">{tree ? nodeStatus : position}</span>
				<span className="viewer-status-facts">
					{note && <output className="viewer-status-note">{note}</output>}
					{facts.map(fact => (
						<span key={fact}>{fact}</span>
					))}
				</span>
			</footer>
		</main>
	)
}
