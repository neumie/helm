// Story-only `helm open` DOCX renderer (docs/plans/helm-open/spec.md §Formats).
// docx-preview builds DOM by construction (no HTML string parsing of file content) into a host this
// component owns. Hardening: alt-chunks (embedded HTML → iframe srcdoc), comments and change
// tracking stay off; images become data: URLs (no blob leaks); every hyperlink loses its href.
import { renderAsync } from 'docx-preview'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './doc.css'
import { useTextSelectionFeedback } from './MarkdownView'
import { loadBytes } from './fixtures'
import type { RendererProps } from './types'

const CLASS = 'open-docx-paper'
const PAGE_GAP = 24

/** Neutralize anything that could navigate or load: links keep their text, the address moves to a tooltip. */
function harden(host: HTMLElement) {
	for (const link of Array.from(host.querySelectorAll('a[href]'))) {
		const href = link.getAttribute('href') ?? ''
		link.removeAttribute('href')
		link.removeAttribute('target')
		if (href && !href.startsWith('#')) link.setAttribute('title', href)
		link.classList.add('open-docx-link')
	}
	for (const node of Array.from(host.querySelectorAll('iframe, script, object, embed, link'))) node.remove()
	for (const img of Array.from(host.querySelectorAll('img'))) {
		if (!(img.getAttribute('src') ?? '').startsWith('data:')) img.removeAttribute('src')
	}
}

const PT_PER_MM = 72 / 25.4
const PAPER: { name: string; w: number; h: number }[] = [
	{ name: 'A4', w: 210, h: 297 },
	{ name: 'A5', w: 148, h: 210 },
	{ name: 'A3', w: 297, h: 420 },
	{ name: 'Letter', w: 215.9, h: 279.4 },
	{ name: 'Legal', w: 215.9, h: 355.6 },
]

/** "A4" / "A4 landscape" / "180 × 240 mm" from a section's pt size. */
function paperName(section: HTMLElement): string | null {
	const w = Number.parseFloat(section.style.width) / PT_PER_MM
	const h = Number.parseFloat(section.style.minHeight || section.style.height) / PT_PER_MM
	if (!Number.isFinite(w) || !Number.isFinite(h)) return null
	for (const paper of PAPER) {
		if (Math.abs(paper.w - w) < 2 && Math.abs(paper.h - h) < 2) return paper.name
		if (Math.abs(paper.h - w) < 2 && Math.abs(paper.w - h) < 2) return `${paper.name} landscape`
	}
	return `${Math.round(w)} × ${Math.round(h)} mm`
}

export function DocxView({ file, zoom, onStatus, feedback }: RendererProps) {
	const scrollRef = useRef<HTMLDivElement>(null)
	const hostRef = useRef<HTMLDivElement>(null)
	const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
	const [error, setError] = useState('')
	const [pages, setPages] = useState(0)
	const [paper, setPaper] = useState<string | null>(null)
	const [pageWidth, setPageWidth] = useState(0)
	const [viewWidth, setViewWidth] = useState(0)
	const [page, setPage] = useState(1)

	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		const controller = new AbortController()
		setState('loading')
		loadBytes(file, controller.signal)
			.then(bytes =>
				renderAsync(bytes, host, undefined, {
					className: CLASS,
					inWrapper: true,
					ignoreLastRenderedPageBreak: true,
					experimental: false,
					useBase64URL: true,
					renderHeaders: true,
					renderFooters: true,
					renderFootnotes: true,
					renderEndnotes: true,
					renderComments: false,
					renderChanges: false,
					renderAltChunks: false,
					breakPages: true,
				}),
			)
			.then(
				() => {
					if (controller.signal.aborted) return
					harden(host)
					const sections = Array.from(host.querySelectorAll<HTMLElement>(`section.${CLASS}`))
					setPages(sections.length)
					const first = sections[0]
					setPaper(first ? paperName(first) : null)
					setPageWidth(first ? first.offsetWidth : 0)
					setState('ready')
				},
				(reason: unknown) => {
					if (controller.signal.aborted) return
					setError(reason instanceof Error ? reason.message : String(reason))
					setState('error')
				},
			)
		return () => {
			controller.abort()
			host.replaceChildren()
		}
	}, [file])

	useLayoutEffect(() => {
		const root = scrollRef.current
		if (!root) return
		const observer = new ResizeObserver(() => setViewWidth(root.clientWidth))
		observer.observe(root)
		setViewWidth(root.clientWidth)
		return () => observer.disconnect()
	}, [])

	// Fit the page to the view width (never above 100%) unless the chrome asks for an exact zoom.
	const fit = pageWidth > 0 && viewWidth > 0 ? Math.min(1, (viewWidth - PAGE_GAP * 2) / pageWidth) : 1
	const scale = zoom ?? Math.max(0.25, fit)

	// Current page: the last page whose top passed the upper third of the view (re-picked after a rescale).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `scale` moves every page.
	useEffect(() => {
		const root = scrollRef.current
		const host = hostRef.current
		if (state !== 'ready' || !root || !host) return
		const sections = Array.from(host.querySelectorAll<HTMLElement>(`section.${CLASS}`))
		const pick = () => {
			const limit = root.getBoundingClientRect().top + root.clientHeight / 3
			let current = 1
			sections.forEach((section, index) => {
				if (section.getBoundingClientRect().top <= limit) current = index + 1
			})
			setPage(current)
		}
		pick()
		root.addEventListener('scroll', pick, { passive: true })
		return () => root.removeEventListener('scroll', pick)
	}, [state, scale])

	const onStatusRef = useRef(onStatus)
	onStatusRef.current = onStatus
	useEffect(() => {
		if (state !== 'ready') return
		const facts = [`${pages} ${pages === 1 ? 'page' : 'pages'}`]
		if (paper) facts.push(paper)
		if (zoom != null || scale < 1) facts.push(`${Math.round(scale * 100)}%`)
		onStatusRef.current?.({ position: pages > 1 ? `Page ${page} of ${pages}` : undefined, facts })
	}, [state, pages, paper, page, scale, zoom])

	useTextSelectionFeedback({
		root: hostRef,
		feedback,
		highlight: 'open-feedback-docx',
		content: state,
		anchorFor: (_range, quote) => ({ kind: 'text', quote }),
	})

	return (
		<div
			ref={scrollRef}
			className="open-view open-docx"
			data-feedback={feedback ? 'on' : undefined}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll owner is keyboard-scrollable.
			tabIndex={0}
			aria-label={`${file.name}, Word document`}
			aria-busy={state === 'loading'}
			style={{ ['--open-docx-scale' as string]: String(scale) }}
		>
			<div ref={hostRef} className="open-docx-host" hidden={state === 'error'} data-state={state} />
			{state === 'loading' ? <div className="open-note open-docx-note">Opening {file.name}…</div> : null}
			{state === 'error' ? (
				<div className="open-note" role="alert">
					<b>Can't show this document</b>
					{error}
				</div>
			) : null}
		</div>
	)
}
