// Story-only `helm open` image renderer (docs/plans/helm-open/spec.md). Plain <img> decoding of
// the file's own bytes through a blob: URL. SVG is only ever an <img> source, never inline DOM,
// so its scripts and external references never run or load.
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { loadBytes } from './fixtures'
import './image.css'
import type { PixelRect, RendererProps } from './types'

/** Breathing room around a fitted image, on --well. */
const INSET = 24
const MIN_SCALE = 0.05
const MAX_SCALE = 16
const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]
/** Arrow-key pan distance in CSS px (Shift multiplies). */
const PAN_STEP = 48
/** Smallest region (CSS px on screen) a drag must cover to count as pointing. */
const MIN_REGION_PX = 4

const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
}

type ZoomMode = { mode: 'fit' } | { mode: 'scale'; value: number }

interface Natural {
	width: number
	height: number
	transparent: boolean
}

interface Geometry {
	width: number
	height: number
	canvasWidth: number
	canvasHeight: number
	offsetX: number
	offsetY: number
}

function extension(name: string): string {
	return name.split('.').pop()?.toLowerCase() ?? ''
}

function clampScale(scale: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

function fitScale(natural: Natural, client: { width: number; height: number }): number {
	const sx = (client.width - INSET * 2) / natural.width
	const sy = (client.height - INSET * 2) / natural.height
	return clampScale(Math.min(sx, sy, 1))
}

function geometry(natural: Natural, client: { width: number; height: number }, scale: number): Geometry {
	const width = natural.width * scale
	const height = natural.height * scale
	const canvasWidth = Math.max(client.width, Math.ceil(width + INSET * 2))
	const canvasHeight = Math.max(client.height, Math.ceil(height + INSET * 2))
	return {
		width,
		height,
		canvasWidth,
		canvasHeight,
		offsetX: (canvasWidth - width) / 2,
		offsetY: (canvasHeight - height) / 2,
	}
}

/** True when any pixel is not fully opaque. Samples a small copy; same-origin blob, no taint. */
function hasTransparency(image: HTMLImageElement): boolean {
	const side = 256
	const ratio = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight))
	const width = Math.max(1, Math.round(image.naturalWidth * ratio))
	const height = Math.max(1, Math.round(image.naturalHeight * ratio))
	const canvas = document.createElement('canvas')
	canvas.width = width
	canvas.height = height
	const context = canvas.getContext('2d', { willReadFrequently: true })
	if (!context) return false
	try {
		context.drawImage(image, 0, 0, width, height)
		const data = context.getImageData(0, 0, width, height).data
		for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 255) < 255) return true
	} catch {
		return false
	}
	return false
}

function percent(scale: number): string {
	return `${Math.round(scale * 100)}%`
}

export function ImageView({ file, zoom, onStatus, feedback = null }: RendererProps) {
	const rootRef = useRef<HTMLDivElement>(null)
	const canvasRef = useRef<HTMLDivElement>(null)
	const [src, setSrc] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [natural, setNatural] = useState<Natural | null>(null)
	const [client, setClient] = useState({ width: 0, height: 0 })
	const [zoomMode, setZoomMode] = useState<ZoomMode>(
		zoom ? { mode: 'scale', value: clampScale(zoom) } : { mode: 'fit' },
	)
	const [draft, setDraft] = useState<PixelRect | null>(null)
	const [panning, setPanning] = useState(false)
	const [spaceHeld, setSpaceHeld] = useState(false)
	/** Image point that should stay under a view point after the next scale change. */
	const pendingAnchor = useRef<{ ix: number; iy: number; cx: number; cy: number } | null>(null)
	const gesture = useRef<
		| { kind: 'pan'; pointerId: number; x: number; y: number; left: number; top: number }
		| { kind: 'region'; pointerId: number; ix: number; iy: number }
		| null
	>(null)

	// Bytes → blob: URL with a type taken from the extension (never from content sniffing).
	useEffect(() => {
		const controller = new AbortController()
		let url: string | null = null
		setSrc(null)
		setError(null)
		setNatural(null)
		loadBytes(file, controller.signal)
			.then(bytes => {
				const type = MIME[extension(file.name)] ?? 'application/octet-stream'
				url = URL.createObjectURL(new Blob([bytes], { type }))
				setSrc(url)
			})
			.catch((reason: unknown) => {
				if (controller.signal.aborted) return
				setError(reason instanceof Error ? reason.message : String(reason))
			})
		return () => {
			controller.abort()
			if (url) URL.revokeObjectURL(url)
		}
	}, [file])

	useEffect(() => {
		if (zoom) setZoomMode({ mode: 'scale', value: clampScale(zoom) })
		else setZoomMode({ mode: 'fit' })
	}, [zoom])

	useLayoutEffect(() => {
		const root = rootRef.current
		if (!root) return
		const measure = () => setClient({ width: root.clientWidth, height: root.clientHeight })
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(root)
		return () => observer.disconnect()
	}, [])

	const fit = natural && client.width > 0 ? fitScale(natural, client) : 1
	const scale = zoomMode.mode === 'fit' ? fit : zoomMode.value
	const geo = useMemo(
		() => (natural && client.width > 0 ? geometry(natural, client, scale) : null),
		[natural, client, scale],
	)
	const overflows = geo ? geo.canvasWidth > client.width || geo.canvasHeight > client.height : false

	// Keep the anchored image point under the cursor / view centre after a zoom.
	useLayoutEffect(() => {
		const root = rootRef.current
		const anchor = pendingAnchor.current
		if (!root || !geo || !anchor) return
		pendingAnchor.current = null
		root.scrollLeft = geo.offsetX + anchor.ix * scale - anchor.cx
		root.scrollTop = geo.offsetY + anchor.iy * scale - anchor.cy
	}, [geo, scale])

	useEffect(() => {
		if (!natural) return
		// The format word is the chrome's (formatWord); the renderer adds what only decoding knows.
		const facts = [`${natural.width} × ${natural.height}`]
		const density = /@(\d)x\./.exec(file.name)
		if (density) facts.push(`@${density[1]}x`)
		onStatus?.({ position: zoomMode.mode === 'fit' ? `Fit · ${percent(scale)}` : percent(scale), facts })
	}, [natural, scale, zoomMode.mode, file.name, onStatus])

	const zoomTo = useCallback(
		(next: ZoomMode, around?: { cx: number; cy: number }) => {
			const root = rootRef.current
			if (!root || !natural || !geo) {
				setZoomMode(next)
				return
			}
			const cx = around?.cx ?? root.clientWidth / 2
			const cy = around?.cy ?? root.clientHeight / 2
			pendingAnchor.current = {
				ix: (root.scrollLeft + cx - geo.offsetX) / scale,
				iy: (root.scrollTop + cy - geo.offsetY) / scale,
				cx,
				cy,
			}
			setZoomMode(next)
		},
		[natural, geo, scale],
	)

	const stepZoom = useCallback(
		(direction: 1 | -1) => {
			const next =
				direction > 0
					? (STEPS.find(step => step > scale + 0.001) ?? MAX_SCALE)
					: ([...STEPS].reverse().find(step => step < scale - 0.001) ?? MIN_SCALE)
			zoomTo({ mode: 'scale', value: next })
		},
		[scale, zoomTo],
	)

	// ⌘/Ctrl + wheel and trackpad pinch (Chromium reports pinch as ctrl+wheel) zoom at the cursor.
	// Needs a non-passive listener to keep the browser from zooming the page.
	useEffect(() => {
		const root = rootRef.current
		if (!root) return
		const onWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return
			event.preventDefault()
			const rect = root.getBoundingClientRect()
			const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025))
			zoomTo(
				{ mode: 'scale', value: clampScale(scale * factor) },
				{ cx: event.clientX - rect.left, cy: event.clientY - rect.top },
			)
		}
		root.addEventListener('wheel', onWheel, { passive: false })
		return () => root.removeEventListener('wheel', onWheel)
	}, [scale, zoomTo])

	const toImage = useCallback(
		(clientX: number, clientY: number) => {
			const canvas = canvasRef.current
			if (!canvas || !geo || !natural) return { ix: 0, iy: 0 }
			const rect = canvas.getBoundingClientRect()
			const ix = (clientX - rect.left - geo.offsetX) / scale
			const iy = (clientY - rect.top - geo.offsetY) / scale
			return {
				ix: Math.min(natural.width, Math.max(0, ix)),
				iy: Math.min(natural.height, Math.max(0, iy)),
			}
		},
		[geo, natural, scale],
	)

	/** Viewport box (for the chrome's bubble) of a region in image pixels. */
	const screenBox = useCallback(
		(rect: PixelRect) => {
			const canvas = canvasRef.current
			if (!canvas || !geo) return new DOMRect()
			const origin = canvas.getBoundingClientRect()
			return new DOMRect(
				origin.left + geo.offsetX + rect.x * scale,
				origin.top + geo.offsetY + rect.y * scale,
				rect.width * scale,
				rect.height * scale,
			)
		},
		[geo, scale],
	)

	const regionMode = feedback !== null && !spaceHeld

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || !geo) return
		const root = rootRef.current
		if (!root) return
		if (regionMode) {
			const { ix, iy } = toImage(event.clientX, event.clientY)
			gesture.current = { kind: 'region', pointerId: event.pointerId, ix, iy }
			setDraft({ x: ix, y: iy, width: 0, height: 0 })
		} else if (overflows) {
			gesture.current = {
				kind: 'pan',
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				left: root.scrollLeft,
				top: root.scrollTop,
			}
			setPanning(true)
		} else return
		// No preventDefault: the native mousedown still focuses the view without a focus ring.
		event.currentTarget.setPointerCapture(event.pointerId)
	}

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = gesture.current
		if (!current || current.pointerId !== event.pointerId) return
		if (current.kind === 'pan') {
			const root = rootRef.current
			if (!root) return
			root.scrollLeft = current.left - (event.clientX - current.x)
			root.scrollTop = current.top - (event.clientY - current.y)
			return
		}
		const { ix, iy } = toImage(event.clientX, event.clientY)
		setDraft({
			x: Math.min(ix, current.ix),
			y: Math.min(iy, current.iy),
			width: Math.abs(ix - current.ix),
			height: Math.abs(iy - current.iy),
		})
	}

	const endGesture = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
		const current = gesture.current
		if (!current || current.pointerId !== event.pointerId) return
		gesture.current = null
		setPanning(false)
		if (current.kind !== 'region') return
		const { ix, iy } = toImage(event.clientX, event.clientY)
		const rect = {
			x: Math.round(Math.min(ix, current.ix)),
			y: Math.round(Math.min(iy, current.iy)),
			width: Math.round(Math.abs(ix - current.ix)),
			height: Math.round(Math.abs(iy - current.iy)),
		}
		setDraft(null)
		if (!commit || !feedback) return
		if (rect.width * scale < MIN_REGION_PX || rect.height * scale < MIN_REGION_PX) return
		feedback.onAnchor({ kind: 'image-region', rect }, screenBox(rect))
	}

	/** Keyboard path to a region: the part of the image currently in view. */
	const anchorVisible = () => {
		const root = rootRef.current
		if (!root || !geo || !natural || !feedback) return
		const left = Math.max(0, (root.scrollLeft - geo.offsetX) / scale)
		const top = Math.max(0, (root.scrollTop - geo.offsetY) / scale)
		const right = Math.min(natural.width, (root.scrollLeft + root.clientWidth - geo.offsetX) / scale)
		const bottom = Math.min(natural.height, (root.scrollTop + root.clientHeight - geo.offsetY) / scale)
		if (right <= left || bottom <= top) return
		const rect = {
			x: Math.round(left),
			y: Math.round(top),
			width: Math.round(right - left),
			height: Math.round(bottom - top),
		}
		feedback.onAnchor({ kind: 'image-region', rect }, screenBox(rect))
	}

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return
		const root = rootRef.current
		if (!root) return
		const pan = PAN_STEP * (event.shiftKey ? 4 : 1)
		switch (event.key) {
			case '0':
				zoomTo({ mode: 'fit' })
				break
			case '1':
				zoomTo({ mode: 'scale', value: 1 })
				break
			case '+':
			case '=':
				stepZoom(1)
				break
			case '-':
			case '_':
				stepZoom(-1)
				break
			case 'ArrowLeft':
				root.scrollBy({ left: -pan })
				break
			case 'ArrowRight':
				root.scrollBy({ left: pan })
				break
			case 'ArrowUp':
				root.scrollBy({ top: -pan })
				break
			case 'ArrowDown':
				root.scrollBy({ top: pan })
				break
			case ' ':
				if (!feedback) return
				setSpaceHeld(true)
				break
			case 'Enter':
				if (!feedback) return
				anchorVisible()
				break
			case 'Escape':
				if (!gesture.current || gesture.current.kind !== 'region') return
				gesture.current = null
				setDraft(null)
				break
			default:
				return
		}
		event.preventDefault()
	}

	const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key === ' ') setSpaceHeld(false)
	}

	const active = feedback?.active?.kind === 'image-region' ? feedback.active.rect : null
	const paint = draft ?? active

	const cursor = regionMode ? 'region' : panning ? 'grabbing' : overflows ? 'grab' : 'default'

	return (
		<div
			ref={rootRef}
			className="open-view open-image"
			data-cursor={cursor}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the view is a keyboard-operated pan/zoom surface
			tabIndex={0}
			role="img"
			aria-label={`${file.name}, ${natural ? `${natural.width} by ${natural.height} pixels, ` : ''}${percent(scale)}`}
			aria-keyshortcuts="0 1 + - ArrowLeft ArrowRight ArrowUp ArrowDown"
			onKeyDown={onKeyDown}
			onKeyUp={onKeyUp}
			onBlur={() => setSpaceHeld(false)}
		>
			{error ? (
				<p className="open-note">
					<b>This image can't be shown</b>
					{error}
				</p>
			) : null}
			{!error && !natural ? <p className="open-note">Loading image…</p> : null}
			{src && !error ? (
				<div
					ref={canvasRef}
					className="open-image-canvas"
					style={
						geo
							? { width: geo.canvasWidth, height: geo.canvasHeight }
							: { position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }
					}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={event => endGesture(event, true)}
					onPointerCancel={event => endGesture(event, false)}
				>
					<img
						className="open-image-picture"
						data-transparent={natural?.transparent ? '' : undefined}
						data-pixelated={scale > 2 ? '' : undefined}
						src={src}
						alt=""
						draggable={false}
						decoding="async"
						onLoad={event => {
							const image = event.currentTarget
							// An SVG with no intrinsic size reports 0; use the CSS default replaced-element box.
							setNatural({
								width: image.naturalWidth || 300,
								height: image.naturalHeight || 150,
								transparent: hasTransparency(image),
							})
						}}
						onError={() => setError('The file could not be decoded as an image.')}
						style={geo ? { left: geo.offsetX, top: geo.offsetY, width: geo.width, height: geo.height } : undefined}
					/>
					{geo && paint ? (
						<div
							className="open-anchor-box"
							data-draft={draft ? '' : undefined}
							style={{
								left: geo.offsetX + paint.x * scale,
								top: geo.offsetY + paint.y * scale,
								width: paint.width * scale,
								height: paint.height * scale,
							}}
						/>
					) : null}
				</div>
			) : null}
		</div>
	)
}
