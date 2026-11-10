// A plain `helm open` window for pictures (docs/plans/helm-open/spec.md, S3): raster images, SVG (as an image) and
// HEIC (converted by `sips` in main's child). The chrome follows the window theme; the picture keeps its own colors.
import { type CSSProperties, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewDocument } from '../../document-review/types'
import { Btn, buttonClassName } from '../button'
import { MenuButton } from '../sidebar/ui'
import type { ImageStatus, ImageViewHandle } from './ImageView'
import './viewer.css'

const ImageView = lazy(() => import('./ImageView').then(module => ({ default: module.ImageView })))

export interface PictureViewerProps {
	document: ReviewDocument
	theme: 'dark' | 'light'
	onToggleTheme(): void
	onRetry(): void
	subscribeZoom?: (listener: (step: -1 | 0 | 1) => void) => () => void
	/** Puts PNG bytes on the clipboard; resolves to an error message or null. */
	onCopy?: (png: Uint8Array) => Promise<string | null>
}

const NOTE_MS = 2500
const timeText = (date: Date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export function PictureViewer({
	document: file,
	theme,
	onToggleTheme,
	onRetry,
	subscribeZoom,
	onCopy,
}: PictureViewerProps) {
	const picture = file.picture
	const view = useRef<ImageViewHandle>(null)
	const [status, setStatus] = useState<ImageStatus>({ position: '', facts: [] })
	const [note, setNote] = useState('')
	// `Updated HH:MM` after a live reload, as in the code and data views.
	const [updated, setUpdated] = useState<Date | null>(null)
	const firstRevision = useRef(file.revision)
	useEffect(() => {
		if (file.revision !== firstRevision.current) setUpdated(new Date())
	}, [file.revision])
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const flash = useCallback((text: string) => {
		setNote(text)
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => setNote(''), NOTE_MS)
	}, [])
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current)
		},
		[],
	)
	const copy = useCallback(() => {
		const handle = view.current
		if (!handle) return
		void handle.copy().then(flash, () => flash('The image could not be copied'))
	}, [flash])
	// ⌘C (the Edit menu's copy) copies the picture unless text is selected somewhere in the window.
	useEffect(() => {
		const onCopyEvent = (event: ClipboardEvent) => {
			const selection = window.getSelection()
			if (selection && !selection.isCollapsed && selection.toString()) return
			event.preventDefault()
			copy()
		}
		window.document.addEventListener('copy', onCopyEvent)
		return () => window.document.removeEventListener('copy', onCopyEvent)
	}, [copy])

	const stale = Boolean(file.error || status.problem)
	return (
		<main
			className="document-review viewer-window"
			data-review-theme={theme}
			data-review-mode="plain"
			data-viewer-format="image"
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
							{ label: 'Zoom to fit', section: 'View', meta: '0', onSelect: () => view.current?.fit() },
							{ label: 'Actual size', meta: '1', onSelect: () => view.current?.actualSize() },
							{ label: 'Copy image', section: 'Edit', meta: '⌘C', disabled: !onCopy, onSelect: copy },
							{
								label: theme === 'dark' ? 'Light window' : 'Dark window',
								section: 'Appearance',
								onSelect: onToggleTheme,
							},
						]}
					/>
				</div>
			</header>
			{(file.error || status.problem) && (
				<div className="review-banner" role="alert">
					<span>{file.error ?? status.problem} The last readable version remains visible.</span>
					<Btn sm onClick={onRetry}>
						Retry read
					</Btn>
				</div>
			)}
			<section className="viewer-stage" aria-label="Picture">
				{!picture ? (
					<p className="viewer-note">This file is not available.</p>
				) : (
					<Suspense fallback={<p className="viewer-note">Reading {file.name}…</p>}>
						<ImageView
							name={file.name}
							picture={picture}
							onStatus={setStatus}
							subscribeZoom={subscribeZoom}
							onCopy={onCopy}
							handle={view}
						/>
					</Suspense>
				)}
			</section>
			<footer className="viewer-status">
				<span className="viewer-status-position">{status.position}</span>
				<span className="viewer-status-facts">
					{(note || stale || updated) && (
						<output className="viewer-status-note">
							{note || (stale ? 'Last readable version' : updated ? `Updated ${timeText(updated)}` : '')}
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
