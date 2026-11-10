// A plain `helm open` window for PDFs (docs/plans/helm-open/spec.md, S4). The chrome follows the window theme; pages
// render on paper white. pdf.js and its worker load only when a PDF opens (lazy chunk).
import { type CSSProperties, Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { ReviewDocument } from '../../document-review/types'
import { Btn, buttonClassName } from '../button'
import { MenuButton } from '../sidebar/ui'
import type { PdfStatus, PdfViewHandle } from './PdfView'
import './viewer.css'

const PdfView = lazy(() => import('./PdfView').then(module => ({ default: module.PdfView })))

export interface PdfViewerProps {
	document: ReviewDocument
	theme: 'dark' | 'light'
	onToggleTheme(): void
	onRetry(): void
	subscribeZoom?: (listener: (step: -1 | 0 | 1) => void) => () => void
}

const timeText = (date: Date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export function PdfViewer({ document: file, theme, onToggleTheme, onRetry, subscribeZoom }: PdfViewerProps) {
	const pdf = file.pdf
	const view = useRef<PdfViewHandle>(null)
	const [status, setStatus] = useState<PdfStatus>({ position: '', facts: [], outline: 'none' })
	// `Updated HH:MM` after a live reload, as in the other plain views.
	const [updated, setUpdated] = useState<Date | null>(null)
	const firstRevision = useRef(file.revision)
	useEffect(() => {
		if (file.revision !== firstRevision.current) setUpdated(new Date())
	}, [file.revision])
	const problem = file.error ?? status.problem
	return (
		<main
			className="document-review viewer-window"
			data-review-theme={theme}
			data-review-mode="plain"
			data-viewer-format="pdf"
			style={{ '--review-zoom': '1' } as CSSProperties}
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
							{ label: 'Find', section: 'View', meta: '⌘F', onSelect: () => view.current?.openFind() },
							{ label: 'Go to page…', onSelect: () => view.current?.goToPage() },
							{
								label: 'Outline',
								checked: status.outline === 'shown',
								checkedRole: 'checkbox',
								disabled: status.outline === 'none',
								onSelect: () => view.current?.toggleOutline(),
							},
							{ label: 'Zoom to fit', section: 'Zoom', meta: '0', onSelect: () => view.current?.fit() },
							{ label: 'Actual size', meta: '1', onSelect: () => view.current?.actualSize() },
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
					<span>{problem} The last readable version remains visible.</span>
					<Btn
						sm
						onClick={() => {
							view.current?.retry()
							onRetry()
						}}
					>
						Retry read
					</Btn>
				</div>
			)}
			<section className="viewer-stage" aria-label="PDF">
				{!pdf ? (
					<p className="viewer-note">This file is not available.</p>
				) : (
					<Suspense fallback={<p className="viewer-note">Reading {file.name}…</p>}>
						<PdfView name={file.name} pdf={pdf} onStatus={setStatus} subscribeZoom={subscribeZoom} handle={view} />
					</Suspense>
				)}
			</section>
			<footer className="viewer-status">
				<span className="viewer-status-position">{status.position}</span>
				<span className="viewer-status-facts">
					{(problem || updated) && (
						<output className="viewer-status-note">
							{problem ? 'Last readable version' : updated ? `Updated ${timeText(updated)}` : ''}
						</output>
					)}
					{status.facts.map(fact => (
						<span key={fact}>{fact}</span>
					))}
				</span>
			</footer>
		</main>
	)
}
