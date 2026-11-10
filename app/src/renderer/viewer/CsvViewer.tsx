// A plain `helm open` window for CSV and TSV files (docs/plans/helm-open/spec.md, S5). Main admits the file and
// serves it by range through this view's own helm-viewer:// token; a worker per token decodes and parses it, and
// the grid (lazy chunk) asks that worker for what is on screen. A live reload opens a new worker and keeps the old
// rows on screen until the new version has its first rows.
import { type CSSProperties, Suspense, lazy, useEffect, useRef, useState } from 'react'
import { ENCODING_LABEL, sizeText } from '../../../../src/document-review/formats'
import type { ReviewDocument, ReviewViewerCsv } from '../../document-review/types'
import { Btn, buttonClassName } from '../button'
import { MenuButton } from '../sidebar/ui'
import type { CsvGridHandle, CsvGridStatus } from './CsvGrid'
import { CsvClient } from './csv-client'
import { DELIMITER_WORDS } from './csv-model'
import type { CsvEvent, CsvProgress } from './csv-protocol'
import './viewer.css'

const CsvGrid = lazy(() => import('./CsvGrid').then(module => ({ default: module.CsvGrid })))

export interface CsvViewerProps {
	document: ReviewDocument
	theme: 'dark' | 'light'
	zoom: number
	onToggleTheme(): void
	onRetry(): void
	/** Test seam: the worker to talk to (defaults to the bundled CSV worker). */
	createClient?: (csv: ReviewViewerCsv, onEvent: (event: CsvEvent) => void) => CsvClient
}

/** One worker for one token, and what it has read so far. */
interface Session {
	url: string
	/** The encoding of this session's version (the status line names the shown version's). */
	encoding: ReviewViewerCsv['encoding']
	client: CsvClient
	progress: CsvProgress | null
	error: string | null
	/** Its token answered 409 before the read finished: the rows so far are part of an older version. */
	stale: boolean
}

/** A version read to the end without a refusal: only that may stay on screen while a newer one is refused. */
const complete = (session: Session | null) =>
	Boolean(session && !session.error && !session.stale && session.progress?.done)

const timeText = (date: Date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const count = (value: number, one: string, many: string) =>
	`${value.toLocaleString('en-US')} ${value === 1 ? one : many}`

export function CsvViewer({ document: file, theme, zoom, onToggleTheme, onRetry, createClient }: CsvViewerProps) {
	const csv = file.csv
	/** The session on screen, and the newer one reading behind it. */
	const [shown, setShown] = useState<Session | null>(null)
	const [next, setNext] = useState<Session | null>(null)
	const [headerChoice, setHeaderChoice] = useState<boolean | null>(null)
	const [status, setStatus] = useState<CsvGridStatus>({ position: '', facts: [] })
	const [updated, setUpdated] = useState<Date | null>(null)
	/** Retry reopens the same token: main publishes nothing when the file is unchanged. */
	const [attempt, setAttempt] = useState(0)
	const grid = useRef<CsvGridHandle>(null)
	const makeClient = useRef(createClient)
	/** Source of truth for the effect's callbacks; `shown` follows it. */
	const shownRef = useRef<Session | null>(null)

	const url = csv?.url
	// biome-ignore lint/correctness/useExhaustiveDependencies: a token is one version; its other fields come with it.
	useEffect(() => {
		if (!csv || !url) return
		let session: Session | null = null
		const update = (change: Partial<Session>) => {
			if (!session) return
			session = { ...session, ...change }
			const current = session
			// The first rows of a newer version replace the shown one; until then it reads behind it.
			const promote = Boolean(current.progress && current.progress.rows > 0) || current.progress?.done || current.error
			if (shownRef.current?.client === current.client) {
				shownRef.current = current
				setShown(current)
			} else if (promote && !(current.error && complete(shownRef.current))) {
				const previous = shownRef.current
				if (previous) {
					previous.client.close()
					if (!previous.error) setUpdated(new Date())
				}
				shownRef.current = current
				setShown(current)
				setNext(null)
			} else setNext(current)
		}
		const onEvent = (event: CsvEvent) => {
			if (event.type === 'progress') update({ progress: event })
			else if (event.type === 'failed') update({ error: event.error })
			else update({ stale: true })
		}
		const client = makeClient.current?.(csv, onEvent) ?? new CsvClient(csv, onEvent)
		session = { url, encoding: csv.encoding, client, progress: null, error: null, stale: false }
		// The same token again (React's development double effect): the new worker takes over at once.
		if (shownRef.current?.url === url) shownRef.current.client.close()
		if (!shownRef.current || shownRef.current.url === url) {
			shownRef.current = session
			setShown(session)
		} else setNext(session)
		return () => {
			// A session that never made it on screen is closed; the shown one stays until a newer one replaces it.
			if (session && shownRef.current?.client !== session.client) session.client.close()
		}
	}, [url, attempt])
	useEffect(
		() => () => {
			shownRef.current?.client.close()
		},
		[],
	)

	// A refusal while reading (row limit, invalid text) replaces the table: nothing read before it stays on screen.
	const refused = Boolean(shown?.error) && !shown?.progress?.done
	const progress = refused ? null : (shown?.progress ?? null)
	const header = headerChoice ?? progress?.header ?? false
	// A read cut off by a change shows its rows until the next version replaces them, but never as the whole file.
	const cut = Boolean(shown?.stale) && !progress?.done
	const reading = progress && !progress.done && !cut
	const newerFailed = next?.error ?? null
	const problem = file.error ?? newerFailed
	const retry = () => {
		onRetry()
		setAttempt(value => value + 1)
	}
	const facts = progress
		? [
				count(progress.rows, 'row', 'rows'),
				count(progress.columns, 'column', 'columns'),
				DELIMITER_WORDS[progress.delimiter],
				...(shown ? [ENCODING_LABEL[shown.encoding]] : []),
				sizeText(progress.size),
			]
		: []
	const percent = progress ? Math.floor((progress.bytes / Math.max(1, progress.size)) * 100) : 0
	const note = reading
		? `Reading… ${percent}%`
		: cut && progress
			? `Partly read (${percent}%) before the file changed`
			: problem && progress
				? 'Last readable version'
				: progress?.unclosedQuote != null
					? `Row ${(progress.unclosedQuote + 1).toLocaleString('en-US')} has an unclosed quote`
					: updated
						? `Updated ${timeText(updated)}`
						: ''

	return (
		<main
			className="document-review viewer-window"
			data-review-theme={theme}
			data-review-mode="plain"
			data-viewer-format="csv"
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
							{
								label: 'Find',
								section: 'View',
								meta: '⌘F',
								disabled: !progress,
								onSelect: () => grid.current?.openFind(),
							},
							{
								label: 'First row is a header',
								checked: header,
								checkedRole: 'checkbox',
								disabled: !progress || progress.rows < 2,
								onSelect: () => setHeaderChoice(!header),
							},
							{
								label: 'Copy as TSV',
								section: 'Edit',
								meta: '⌘C',
								disabled: !progress || progress.rows === 0,
								onSelect: () => grid.current?.copy(),
							},
							{
								label: 'Select all',
								meta: '⌘A',
								disabled: !progress || progress.rows === 0,
								onSelect: () => grid.current?.selectAll(),
							},
							{
								label: theme === 'dark' ? 'Light window' : 'Dark window',
								section: 'Appearance',
								onSelect: onToggleTheme,
							},
						]}
					/>
				</div>
			</header>
			{problem && (
				<div className="review-banner" role="alert">
					<span>
						{problem} {progress?.done ? 'The last readable version remains visible.' : ''}
					</span>
					<Btn sm onClick={retry}>
						Retry read
					</Btn>
				</div>
			)}
			<section className="viewer-stage" aria-label="Table">
				{!csv || !shown ? (
					<p className="viewer-note">This file is not available.</p>
				) : refused ? (
					<div className="viewer-note">
						<p role="alert">
							Helm couldn’t show {file.name}. {shown.error}
						</p>
						{!problem && (
							<Btn sm onClick={retry}>
								Retry read
							</Btn>
						)}
					</div>
				) : !progress ? (
					<p className="viewer-note">Reading {file.name}…</p>
				) : progress.done && progress.rows === 0 ? (
					<p className="viewer-note">{file.name} is empty.</p>
				) : (
					<Suspense fallback={<p className="viewer-note">Reading {file.name}…</p>}>
						<CsvGrid
							name={file.name}
							client={shown.client}
							rows={progress.rows}
							columns={progress.columns}
							samples={progress.samples}
							header={header && progress.rows > 1}
							zoom={zoom}
							onStatus={setStatus}
							handle={grid}
						/>
					</Suspense>
				)}
			</section>
			<footer className="viewer-status">
				<span className="viewer-status-position">{progress ? status.position : ''}</span>
				<span className="viewer-status-facts">
					{note && <output className="viewer-status-note">{note}</output>}
					{[...(progress ? status.facts : []), ...facts].map(fact => (
						<span key={fact}>{fact}</span>
					))}
				</span>
			</footer>
		</main>
	)
}
